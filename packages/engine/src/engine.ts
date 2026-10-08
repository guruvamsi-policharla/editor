/**
 * The review engine for one workspace root.
 *
 * Model: `pending = disk - baseline`. The baseline (last-accepted content of
 * every non-ignored file) lives in a private shadow git object store; disk is
 * whatever is on disk. Accepting folds disk content into the baseline;
 * rejecting writes baseline content back to disk. Everything else (hunks,
 * created/deleted/renamed files) is derived from comparing the two.
 *
 * The engine never watches the filesystem itself: the host feeds it events
 * (`handleFsEvents`) and reports its own writes (`reportUserSave`, ...).
 * All public operations are serialized.
 */
import * as path from 'node:path';
import { addFormatterPass, foldUserSave, provenanceFromDiff, trackEdits, type Provenance, type TrackedEdit } from './attribution.js';
import { acceptHunks, computeHunks, hunkRegion, rejectHunks, type Hunk } from './diff/hunks.js';
import { diffRegions } from './diff/myers.js';
import { nodeFileSystem, type FileStat, type FileSystem } from './fs.js';
import {
  findGitRepo,
  gitCliObjectReader,
  headStatesEqual,
  isGitBusy,
  readHeadState,
  readIndex,
  statIndex,
  type GitObjectReader,
  type GitRepoInfo,
  type HeadState,
  type IndexStat,
} from './git/repo.js';
import { convertEol, restoreLineEndings, uniformEol } from './eol.js';
import { IgnoreRules, type IgnoreOptions } from './ignore.js';
import { stagedRegions } from './staging.js';
import { gitBlobId, ObjectStore } from './store/objectStore.js';
import { loadState, saveState, type BlobEntry, type DiskEntry, type PersistedState } from './store/state.js';
import { decodeText, encodeText, isBinary, joinLines, splitLines, toBytes } from './text.js';

export type { TrackedEdit, EditOrigin } from './attribution.js';

export const DEFAULT_LARGE_FILE_THRESHOLD = 1024 * 1024;
/** Stat-cache entries recorded less than this long after the file's mtime are not trusted (racy-git rule). */
const RACY_MS = 2000;
const GIT_RETRY_MS = 200;
/**
 * How long a reported save may take to reach the disk. Until then (or until the disk changes to anything else),
 * the old content on disk is the save not having landed yet, not an external change. A save that never lands
 * (the write failed) stops counting after this.
 */
const SAVE_IN_FLIGHT_MS = 10_000;

export interface ReviewEngineOptions {
  /** Workspace root. Symlinks are resolved; all paths are reported relative to the real root. */
  root: string;
  /** Directory the engine owns (extension storage, or a git-ignored workspace folder). One per root. */
  storageDir: string;
  /** Filesystem implementation. Default: node:fs. */
  fs?: FileSystem;
  ignore?: IgnoreOptions;
  /** Files larger than this (bytes, either side) get file-level review only. Default 1 MiB. */
  largeFileThreshold?: number;
  /** Detect git operations in the enclosing repository. Default true. */
  git?: boolean;
  /** How to read blobs from the user's repository (partial staging). Default: `git cat-file`. */
  gitObjectReader?: GitObjectReader;
  /** Absolute directories inside the root that this engine must not track (e.g. nested workspace roots). */
  excludeDirs?: readonly string[];
  /** Wall clock, for tests. */
  now?: () => number;
  /**
   * Detailed log of what the engine decides and why: baseline moves, pending changes, save attribution, watcher
   * events, git operations. For hunting attribution bugs; off (undefined) by default.
   */
  trace?: (message: string) => void;
}

/** A filesystem event from the host's watcher. Only the path matters; the engine re-examines it. */
export interface FsEvent {
  path: string;
  type?: 'create' | 'change' | 'delete';
}

export type ChangeKind = 'modified' | 'created' | 'deleted' | 'renamed';

export interface ChangeSummary {
  /** Workspace-relative posix path (the new path for renames). */
  path: string;
  kind: ChangeKind;
  /** Previous path, for renames. */
  oldPath?: string;
  binary: boolean;
  large: boolean;
  /** 'hunk' = per-hunk accept/reject; 'file' = whole-file only (created, deleted, renamed, binary, large). */
  reviewMode: 'hunk' | 'file';
}

export interface FileChange extends ChangeSummary {
  /** Line-sized hunks. For created/deleted text files this is one display-only hunk covering the file. */
  hunks: Hunk[];
}

export type ChangeReason =
  | 'external' // a disk change the engine didn't expect (agent, tool, anything)
  | 'self' // a disk change matching a reported/engine write
  | 'user-save'
  | 'user-delete'
  | 'user-rename'
  | 'accept'
  | 'reject'
  | 'git-head'
  | 'git-index'
  | 'rescan';

export interface ChangeEvent {
  reason: ChangeReason;
  paths: string[];
}

export type GitOperationResult =
  | { kind: 'none' }
  | { kind: 'busy' }
  | { kind: 'head'; accepted: string[] }
  | { kind: 'index'; staged: string[]; accepted: string[] };

export interface BulkResult {
  /** Paths that were processed. */
  done: string[];
  /** Paths skipped because the disk changed since the engine last observed it. */
  skipped: string[];
}

export interface UserSaveOptions {
  /** Buffer edits since the last disk sync, in order. Without them every changed line counts as a user edit. */
  edits?: readonly TrackedEdit[];
  /**
   * The disk content the edits started from. Defaults to the file's current disk content, so either call
   * `reportUserSave` before writing, or pass `base`.
   */
  base?: string | Uint8Array;
  /**
   * The buffer as the user left it, before format on save and other save participants changed it (the saved
   * content if none did). With it, the user's part (disk -> userContent: the 'user' edits, else a diff) and the
   * formatter's part (userContent -> saved, by diff) are told apart without trusting the edit log, so a formatter
   * rewriting agent lines can never pass for the user rewriting them. Without it, edits tagged 'formatter' are the
   * only way to know, and a log that doesn't replay counts every change as the user's.
   */
  userContent?: string;
}

export interface UserSaveResult {
  /** 'edits' = tagged edits were used; 'diff' = no edits given; 'fallback' = edits didn't reproduce the content. */
  attribution: 'edits' | 'diff' | 'fallback' | 'file';
}

export class StaleChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleChangeError';
  }
}

export class NotPendingError extends Error {
  constructor(rel: string) {
    super(`No pending change for ${rel}`);
    this.name = 'NotPendingError';
  }
}

interface Disposable {
  dispose(): void;
}

interface ReadResult {
  entry: DiskEntry;
  data: Uint8Array;
}

/** A save reported with `reportUserSave` that may not be on disk yet. */
interface InFlightSave {
  data: Uint8Array;
  oid: string;
  /** The file when the save was reported (null: no file). Same content and stat = the write hasn't landed. */
  before: Pick<DiskEntry, 'oid' | 'size' | 'mtimeMs' | 'ctimeMs'> | null;
  until: number;
}

export class ReviewEngine {
  readonly root: string;
  readonly storageDir: string;
  private readonly fs: FileSystem;
  private readonly store: ObjectStore;
  private readonly stateFile: string;
  private readonly largeFileThreshold: number;
  private readonly gitEnabled: boolean;
  private readonly gitReader: GitObjectReader;
  private readonly now: () => number;
  private readonly traceFn: ((message: string) => void) | undefined;
  /** The public operation running now (for the trace). */
  private op = '';
  private readonly excludeDirs: string[];
  private ignoreOptions: IgnoreOptions;
  private rules!: IgnoreRules;

  private baseline = new Map<string, BlobEntry>();
  private disk = new Map<string, DiskEntry>();
  private pending = new Set<string>();
  private expectedWrites = new Map<string, string | null>();
  private inFlightSaves = new Map<string, InFlightSave>();

  private repo: GitRepoInfo | undefined;
  private gitHead: HeadState | undefined;
  private gitIndex = new Map<string, string>();
  private gitIndexStat: IndexStat | null = null;
  private gitRetryTimer: ReturnType<typeof setTimeout> | undefined;

  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(e: ChangeEvent) => void>();
  private dirty = false;
  private closed = false;

  private constructor(opts: ReviewEngineOptions, fs: FileSystem, root: string, storageDir: string, excludeDirs: string[]) {
    this.fs = fs;
    this.root = root;
    this.storageDir = storageDir;
    this.store = new ObjectStore(fs, path.join(storageDir, 'baseline.git'));
    this.stateFile = path.join(storageDir, 'state.json');
    this.largeFileThreshold = opts.largeFileThreshold ?? DEFAULT_LARGE_FILE_THRESHOLD;
    this.gitEnabled = opts.git ?? true;
    this.gitReader = opts.gitObjectReader ?? gitCliObjectReader;
    this.now = opts.now ?? Date.now;
    this.traceFn = opts.trace;
    this.excludeDirs = excludeDirs;
    this.ignoreOptions = opts.ignore ?? {};
  }

  /** Open (or create) the engine for a workspace root. On first open the baseline is the current disk. */
  static async open(opts: ReviewEngineOptions): Promise<ReviewEngine> {
    const fs = opts.fs ?? nodeFileSystem;
    const root = await fs.realpath(path.resolve(opts.root));
    const storage = path.resolve(opts.storageDir);
    await fs.mkdir(storage);
    const storageDir = await fs.realpath(storage);
    const excludeDirs = [storageDir];
    for (const d of opts.excludeDirs ?? []) { excludeDirs.push(await realpathLoose(fs, path.resolve(d))); }
    const engine = new ReviewEngine(opts, fs, root, storageDir, excludeDirs);
    await engine.init();
    return engine;
  }

  // ---------------------------------------------------------------- lifecycle

  private async init(): Promise<void> {
    await this.store.init();
    this.repo = this.gitEnabled ? await findGitRepo(this.fs, this.root) : undefined;
    this.rules = this.makeRules();
    const state = await loadState(this.fs, this.stateFile);
    if (state) {
      this.baseline = new Map(Object.entries(state.baseline));
      this.disk = new Map(Object.entries(state.disk));
      await this.fullScan({ trustStatCache: true });
      if (this.repo) {
        if (state.git) {
          this.gitHead = state.git.head;
          this.gitIndexStat = state.git.indexStat;
          this.gitIndex = new Map(Object.entries(state.git.index));
          await this.pollGit();
        } else { await this.snapshotGit(); }
      }
    } else {
      await this.fullScan({ trustStatCache: false, initAll: true });
      if (this.repo) { await this.snapshotGit(); }
    }
    this.dirty = true;
    await this.persist();
  }

  /** Persist and stop. Further calls fail. */
  async close(): Promise<void> {
    await this.run('close', async () => {
      if (this.gitRetryTimer) { clearTimeout(this.gitRetryTimer); }
      this.gitRetryTimer = undefined;
      this.dirty = true;
      await this.persist();
      this.closed = true;
      this.listeners.clear();
    });
  }

  /** Wait for queued operations and persist state. */
  async flush(): Promise<void> {
    await this.run('flush', async () => {
      this.dirty = true;
      await this.persist();
    });
  }

  onDidChange(listener: (e: ChangeEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** The enclosing git repository, if any (read-only information). */
  get gitRepository(): GitRepoInfo | undefined {
    return this.repo;
  }

  // ---------------------------------------------------------------- host input

  /** Feed watcher events. Paths may be absolute or root-relative; symlinked paths are normalized. */
  handleFsEvents(events: readonly (FsEvent | string)[]): Promise<void> {
    return this.run('handleFsEvents', async () => {
      const rels = new Set<string>();
      let fullRescan = false;
      for (const ev of events) {
        const raw = typeof ev === 'string' ? ev : ev.path;
        const abs = await realpathLoose(this.fs, path.resolve(this.root, raw));
        if (this.isInGitDir(abs) || this.isInStorage(abs)) { continue; }
        const rel = this.toRel(abs);
        if (rel === undefined) { continue; }
        if (rel === '') { fullRescan = true; }
        else { rels.add(rel); }
      }
      if (fullRescan) {
        await this.rescanInternal();
      } else {
        const self: string[] = [];
        const external: string[] = [];
        let ignoreChanged = false;
        for (const rel of rels) {
          if (path.posix.basename(rel) === '.gitignore') { ignoreChanged = true; }
          const changed = await this.refreshPath(rel);
          if (/\.tex$/i.test(rel)) { changed.push(...(await this.refreshTexSibling(rel))); }
          for (const p of changed) { (this.consumeExpectedWrite(p) ? self : external).push(p); }
        }
        if (self.length || external.length) { this.trace(`watcher: ${[...self.map((p) => `${p} (self)`), ...external.map((p) => `${p} (external)`)].join(', ')}`); }
        this.emit('self', self);
        this.emit('external', external);
        if (ignoreChanged) { await this.reloadIgnoreRules(); }
      }
      if (this.repo) { await this.pollGit(); }
      await this.persist();
    });
  }

  /** Re-walk the whole workspace (e.g. after the host's watcher overflowed). */
  rescan(): Promise<void> {
    return this.run('rescan', async () => {
      await this.rescanInternal();
      if (this.repo) { await this.pollGit(); }
      await this.persist();
    });
  }

  /** Replace the user's extra ignore patterns and rescan. Newly visible files start with nothing pending. */
  setIgnorePatterns(patterns: readonly string[]): Promise<void> {
    return this.run('setIgnorePatterns', async () => {
      this.ignoreOptions = { ...this.ignoreOptions, patterns: [...patterns] };
      await this.reloadIgnoreRules();
      await this.persist();
    });
  }

  /**
   * Report a save from the editor. Lines the user edited fold into the baseline; untouched agent lines
   * stay pending; formatter edits inside pending agent hunks stay pending, elsewhere they fold in.
   */
  reportUserSave(file: string, content: string | Uint8Array, options: UserSaveOptions = {}): Promise<UserSaveResult> {
    return this.run('reportUserSave', async () => {
      const rel = await this.relOrThrow(file);
      const saved = toBytes(content);
      const savedOid = gitBlobId(saved);
      this.expectedWrites.set(rel, savedOid);
      if (await this.rules.isIgnored(rel)) { return { attribution: 'file' as const }; }

      const diskNow = await this.readDisk(rel);
      if (diskNow?.entry.oid !== savedOid) { this.inFlightSaves.set(rel, { data: saved, oid: savedOid, before: diskNow?.entry ?? null, until: this.now() + SAVE_IN_FLIGHT_MS }); }
      else { this.inFlightSaves.delete(rel); }
      const baseEntry = this.baseline.get(rel);
      const baseBytes = baseEntry ? await this.store.read(baseEntry.oid) : undefined;
      // A save of a file that is a pending deletion (the editor still had it open) brings it back: the user chose to
      // keep the file, with their edits. Attribute against its accepted content, as if the deletion had been undone
      // first, so the deletion stops being pending and what the user typed folds in. Against the missing file every
      // saved line counted as typed, while the deletion of the old lines stayed pending: the old lines showed red above
      // the same lines as plain text (#17).
      const restoresDeletion = options.base === undefined && !diskNow && baseBytes !== undefined;
      if (restoresDeletion) { this.trace(`${rel}: saved while its deletion is pending: the save restores it`); }
      const diskBytes = options.base !== undefined ? toBytes(options.base) : restoresDeletion ? baseBytes : diskNow?.data;

      let newBaseline: Uint8Array | undefined;
      let attribution: UserSaveResult['attribution'];
      const sides = [saved, diskBytes, baseBytes].filter((b): b is Uint8Array => b !== undefined);
      if (sides.some((b) => isBinary(b) || b.length > this.largeFileThreshold)) {
        newBaseline = saved;
        attribution = 'file';
      } else {
        let diskText = diskBytes ? decodeText(diskBytes)! : '';
        const savedText = decodeText(saved)!;
        let baseText = baseBytes ? decodeText(baseBytes)! : '';
        // Editors that keep one EOL per buffer (VS Code) write a file with mixed or other line endings back with
        // that EOL, and report edits in its coordinates. That conversion is the editor's, not a change to any
        // line: attribute against the converted disk and baseline, so it folds in everywhere and agent lines
        // aren't mistaken for user rewrites.
        const savedEol = uniformEol(savedText);
        if (savedEol && convertEol(diskText, savedEol) !== diskText) {
          diskText = convertEol(diskText, savedEol);
          baseText = convertEol(baseText, savedEol);
        }
        let prov: Provenance | undefined;
        if (options.userContent !== undefined) {
          // Two passes: the user's edits (disk -> userContent), then the formatter's (userContent -> saved).
          const userText = savedEol ? convertEol(options.userContent, savedEol) : options.userContent;
          prov = options.edits ? trackEdits(diskText, options.edits.filter((e) => e.origin === 'user')) : undefined;
          attribution = 'edits';
          if (!prov || joinLines(prov.lines.map((l) => l.text)) !== userText) {
            prov = provenanceFromDiff(diskText, userText, 'user');
            attribution = options.edits ? 'fallback' : 'diff';
          }
          const agentLines = new Set<number>();
          for (const r of diffRegions(splitLines(baseText), splitLines(diskText))) { for (let d = r.bStart; d < r.bEnd; d++) { agentLines.add(d); } }
          prov = addFormatterPass(prov, userText, savedText, (d) => agentLines.has(d));
        } else {
          prov = options.edits ? trackEdits(diskText, options.edits) : undefined;
          attribution = 'edits';
          if (!prov || joinLines(prov.lines.map((l) => l.text)) !== savedText) {
            prov = provenanceFromDiff(diskText, savedText, 'user');
            attribution = options.edits ? 'fallback' : 'diff';
          }
        }
        const baseLines = splitLines(baseText);
        const folded = foldUserSave(baseLines, splitLines(diskText), prov);
        if (this.traceFn) {
          const n = (o: string) => options.edits?.filter((e) => e.origin === o).length ?? 0;
          const before = diffRegions(baseLines, splitLines(diskText)).length;
          const after = diffRegions(folded, splitLines(savedText)).length;
          const fmt = options.userContent === undefined ? 'formatter: by edit tags' : options.userContent === savedText ? 'no formatter changes' : 'formatter: by diff from the user text';
          this.trace(`${rel}: save attributed by ${attribution} (${options.edits ? `${options.edits.length} edits: ${n('user')} user, ${n('formatter')} formatter` : 'no edit log'}; ${fmt}; base ${options.base !== undefined ? 'given' : 'from disk'}); changes against the baseline: ${before} before the save (baseline -> disk), ${after} after (new baseline -> saved)`);
        }
        // An agent-created file the user saved without folding anything stays a pending creation.
        if (!baseEntry && folded.length === 0 && saved.length > 0) { newBaseline = undefined; }
        else { newBaseline = encodeText(joinLines(folded)); }
      }

      if (newBaseline) { await this.setBaseline(rel, newBaseline, `user save, attribution: ${attribution}`); }
      // The host is about to write `saved`; record it so pending is right before the watcher catches up.
      this.disk.set(rel, { oid: savedOid, size: saved.length, binary: isBinary(saved), mtimeMs: 0, ctimeMs: 0, recordedAt: 0 });
      this.updatePending(rel);
      this.emit('user-save', [rel]);
      await this.persist();
      return { attribution };
    });
  }

  /** Report that the user deleted a file or folder in the editor: its baseline goes too (nothing pending). */
  reportUserDelete(file: string): Promise<void> {
    return this.run('reportUserDelete', async () => {
      const rel = await this.relOrThrow(file);
      const touched: string[] = [];
      for (const p of this.trackedUnder(rel)) {
        this.dropBaseline(p, 'user deleted it');
        this.disk.delete(p);
        this.expectedWrites.set(p, null);
        this.updatePending(p);
        touched.push(p);
      }
      this.dirty ||= touched.length > 0;
      this.emit('user-delete', touched);
      await this.persist();
    });
  }

  /** Report that the user renamed a file or folder in the editor: baseline entries move with it. */
  reportUserRename(from: string, to: string): Promise<void> {
    return this.run('reportUserRename', async () => {
      const a = await this.relOrThrow(from);
      const b = await this.relOrThrow(to);
      const touched: string[] = [];
      for (const p of this.trackedUnder(a)) {
        const q = b + p.slice(a.length);
        const be = this.baseline.get(p);
        const de = this.disk.get(p);
        this.baseline.delete(p);
        this.disk.delete(p);
        if (be) { this.baseline.set(q, be); }
        if (de) { this.disk.set(q, de); }
        this.updatePending(p);
        this.updatePending(q);
        touched.push(p, q);
      }
      this.dirty ||= touched.length > 0;
      this.emit('user-rename', touched);
      await this.persist();
    });
  }

  // ---------------------------------------------------------------- queries

  /** Pending changes, sorted by path. Renames are reported once, under the new path. */
  listChanges(): ChangeSummary[] {
    const { newToOld, oldToNew } = this.computeRenames();
    const out: ChangeSummary[] = [];
    for (const rel of [...this.pending].sort()) {
      if (oldToNew.has(rel)) { continue; }
      out.push(this.summarize(rel, newToOld.get(rel)));
    }
    return out;
  }

  /** True if anything is pending. */
  get hasPendingChanges(): boolean {
    return this.pending.size > 0;
  }

  /** Full change for one file, including hunks with word-level ranges. Reads the disk fresh. */
  getFileChange(file: string): Promise<FileChange | undefined> {
    return this.run('getFileChange', async () => {
      const rel = await this.relOrThrow(file);
      return (await this.loadChange(rel))?.change;
    });
  }

  /** Accepted (baseline) content of a file, or undefined if it isn't in the baseline. */
  getBaselineContent(file: string): Promise<Uint8Array | undefined> {
    return this.run('getBaselineContent', async () => {
      const rel = await this.relOrThrow(file);
      const e = this.baseline.get(rel);
      return e ? this.store.read(e.oid) : undefined;
    });
  }

  /** Baseline manifest: path -> blob id. */
  baselineEntries(): Map<string, string> {
    return new Map([...this.baseline].map(([p, e]) => [p, e.oid]));
  }

  // ---------------------------------------------------------------- operations

  acceptHunk(file: string, hunkId: string): Promise<void> {
    return this.run('acceptHunk', async () => {
      const rel = await this.relOrThrow(file);
      const loaded = await this.loadChange(rel);
      if (!loaded) { throw new NotPendingError(rel); }
      const hunk = loaded.change.hunks.find((h) => h.id === hunkId);
      if (!hunk) { throw new StaleChangeError(`Hunk ${hunkId} no longer matches ${rel}; re-read the file's changes`); }
      if (loaded.change.reviewMode === 'file') {
        await this.acceptPath(rel, true, 'Keep (whole-file change)');
      } else {
        const next = acceptHunks(loaded.baseLines!, loaded.diskLines!, [hunkRegion(hunk)]);
        await this.setBaseline(rel, encodeText(joinLines(next)), `Keep hunk ${hunkId}`);
        this.updatePending(rel);
      }
      this.emit('accept', [rel]);
      await this.persist();
    });
  }

  rejectHunk(file: string, hunkId: string): Promise<void> {
    return this.run('rejectHunk', async () => {
      const rel = await this.relOrThrow(file);
      const loaded = await this.loadChange(rel);
      if (!loaded) { throw new NotPendingError(rel); }
      const hunk = loaded.change.hunks.find((h) => h.id === hunkId);
      if (!hunk) { throw new StaleChangeError(`Hunk ${hunkId} no longer matches ${rel}; re-read the file's changes`); }
      if (loaded.change.reviewMode === 'file') {
        await this.rejectPath(rel, true);
      } else {
        const next = rejectHunks(loaded.baseLines!, loaded.diskLines!, [hunkRegion(hunk)]);
        await this.writeDisk(rel, encodeText(joinLines(next)));
      }
      this.emit('reject', [rel]);
      await this.persist();
    });
  }

  /**
   * Replace a file's accepted baseline with `content`, leaving the disk alone (E1). For hosts that compute
   * a partial accept themselves, against their own hunking (e.g. VS Code's review UI keeping one hunk of its
   * diff): the host sends the full new baseline text instead of an engine hunk id. `null` drops the file from
   * the baseline (it then shows as created if it exists on disk). If `expectedBaseline` is given and the
   * current baseline differs, throws `StaleChangeError` so the host re-reads and retries.
   *
   * `restoreLineEndings`: the content comes from an editor buffer that normalized line endings (VS Code keeps
   * one EOL per model). Each line gets the ending of the matching line on disk, else in the current baseline,
   * so a file with mixed CRLF/LF endings doesn't turn into a change on every line.
   */
  setBaselineContent(
    file: string,
    content: string | Uint8Array | null,
    options: { expectedBaseline?: string | Uint8Array | null; restoreLineEndings?: boolean } = {},
  ): Promise<void> {
    return this.run('setBaselineContent', async () => {
      const rel = await this.relOrThrow(file);
      if (await this.rules.isIgnored(rel)) { throw new Error(`${rel} is ignored; it has no baseline`); }
      if (options.expectedBaseline !== undefined) {
        const current = this.baseline.get(rel)?.oid ?? null;
        const expected = options.expectedBaseline === null ? null : gitBlobId(toBytes(options.expectedBaseline));
        if (current !== expected) { throw new StaleChangeError(`The baseline of ${rel} changed; re-read it`); }
      }
      if (content === null) {
        this.dropBaseline(rel, 'set to null by the host');
      } else {
        let bytes = toBytes(content);
        const text = options.restoreLineEndings ? decodeText(bytes) : undefined;
        if (text !== undefined) {
          const sources: string[] = [];
          const disk = await this.readDisk(rel);
          const diskText = disk ? decodeText(disk.data) : undefined;
          if (diskText !== undefined) { sources.push(diskText); }
          const base = this.baseline.get(rel);
          const baseText = base ? decodeText(await this.store.read(base.oid)) : undefined;
          if (baseText !== undefined) { sources.push(baseText); }
          bytes = encodeText(restoreLineEndings(text, sources));
        }
        await this.setBaseline(rel, bytes, 'set by the host (Keep in the editor, or Ctrl+Z of one)');
      }
      this.updatePending(rel);
      this.emit('accept', [rel]);
      await this.persist();
    });
  }

  /** Accept a whole file (for renames, either path accepts the rename). */
  acceptFile(file: string): Promise<void> {
    return this.run('acceptFile', async () => {
      const rel = await this.relOrThrow(file);
      const paths = this.reviewUnit(rel);
      if (!paths.some((p) => this.pending.has(p))) { throw new NotPendingError(rel); }
      for (const p of paths) { if (!(await this.isFresh(p))) { throw new StaleChangeError(`${p} changed on disk; re-read its changes`); } }
      for (const p of paths) { await this.acceptPath(p, false, 'Keep file'); }
      this.emit('accept', paths);
      await this.persist();
    });
  }

  /** Reject a whole file: restore modified/deleted content, delete created files, undo renames. */
  rejectFile(file: string): Promise<void> {
    return this.run('rejectFile', async () => {
      const rel = await this.relOrThrow(file);
      const paths = this.reviewUnit(rel);
      if (!paths.some((p) => this.pending.has(p))) { throw new NotPendingError(rel); }
      for (const p of paths) { if (!(await this.isFresh(p))) { throw new StaleChangeError(`${p} changed on disk; re-read its changes`); } }
      await this.rejectUnit(paths);
      this.emit('reject', paths);
      await this.persist();
    });
  }

  /** Accept every pending change. Files that changed since last observed are refreshed and skipped. */
  acceptAll(): Promise<BulkResult> {
    return this.run('acceptAll', async () => {
      const result: BulkResult = { done: [], skipped: [] };
      for (const s of this.listChanges()) {
        const paths = s.oldPath ? [s.oldPath, s.path] : [s.path];
        if (!(await this.allFresh(paths))) {
          result.skipped.push(...paths);
          continue;
        }
        for (const p of paths) { await this.acceptPath(p, false, 'Keep All'); }
        result.done.push(...paths);
      }
      this.emit('accept', result.done);
      await this.persist();
      return result;
    });
  }

  /** Reject every pending change. Files that changed since last observed are refreshed and skipped. */
  rejectAll(): Promise<BulkResult> {
    return this.run('rejectAll', async () => {
      const result: BulkResult = { done: [], skipped: [] };
      for (const s of this.listChanges()) {
        const paths = s.oldPath ? [s.oldPath, s.path] : [s.path];
        if (!(await this.allFresh(paths))) {
          result.skipped.push(...paths);
          continue;
        }
        await this.rejectUnit(paths);
        result.done.push(...paths);
      }
      this.emit('reject', result.done);
      await this.persist();
      return result;
    });
  }

  /** Check the enclosing repository for git operations now (also done after every event batch). */
  checkGit(): Promise<GitOperationResult> {
    return this.run('checkGit', async () => {
      const r = await this.pollGit();
      await this.persist();
      return r;
    });
  }

  // ---------------------------------------------------------------- internals: serialization & events

  private run<T>(op: string, fn: () => Promise<T>): Promise<T> {
    if (this.closed) { return Promise.reject(new Error('ReviewEngine is closed')); }
    const result = this.queue.then(() => {
      this.op = op;
      return fn();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private emit(reason: ChangeReason, paths: readonly string[]): void {
    if (paths.length === 0) { return; }
    const event: ChangeEvent = { reason, paths: [...new Set(paths)].sort() };
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // Listener errors must not break the engine.
      }
    }
  }

  private async persist(): Promise<void> {
    if (!this.dirty) { return; }
    const state: PersistedState = {
      version: 1,
      root: this.root,
      baseline: Object.fromEntries(this.baseline),
      disk: Object.fromEntries(this.disk),
    };
    if (this.repo && this.gitHead) {
      state.git = { head: this.gitHead, indexStat: this.gitIndexStat, index: Object.fromEntries(this.gitIndex) };
    }
    await saveState(this.fs, this.stateFile, state);
    this.dirty = false;
  }

  // ---------------------------------------------------------------- internals: paths

  private abs(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  private toRel(abs: string): string | undefined {
    const rel = path.relative(this.root, abs);
    if (rel === '') { return ''; }
    if (rel.startsWith('..') || path.isAbsolute(rel)) { return undefined; }
    return rel.split(path.sep).join('/');
  }

  private async relOrThrow(file: string): Promise<string> {
    const abs = await realpathLoose(this.fs, path.resolve(this.root, file));
    const rel = this.toRel(abs);
    if (!rel) { throw new Error(`${file} is not inside workspace root ${this.root}`); }
    return rel;
  }

  private isInGitDir(abs: string): boolean {
    if (!this.repo) { return path.basename(abs) === '.git' || abs.includes(`${path.sep}.git${path.sep}`); }
    return [this.repo.gitDir, this.repo.commonDir].some((d) => abs === d || abs.startsWith(d + path.sep));
  }

  private isInStorage(abs: string): boolean {
    return abs === this.storageDir || abs.startsWith(this.storageDir + path.sep);
  }

  private trackedUnder(rel: string): string[] {
    const out = new Set<string>();
    for (const m of [this.baseline, this.disk]) {
      for (const p of m.keys()) { if (p === rel || p.startsWith(`${rel}/`)) { out.add(p); } }
    }
    return [...out];
  }

  private makeRules(): IgnoreRules {
    const infoExclude = this.repo && this.repo.prefix === '' ? path.join(this.repo.commonDir, 'info', 'exclude') : undefined;
    return new IgnoreRules(this.fs, this.root, this.ignoreOptions, this.excludeDirs, infoExclude);
  }

  // ---------------------------------------------------------------- internals: disk & baseline state

  private trace(message: string): void {
    if (!this.traceFn) { return; }
    try {
      this.traceFn(`[${this.op}] ${message}`);
    } catch {
      // A failing logger must not break the engine.
    }
  }

  private updatePending(rel: string): void {
    const d = this.disk.get(rel);
    const b = this.baseline.get(rel);
    const was = this.pending.has(rel);
    if (d?.oid === b?.oid) { this.pending.delete(rel); }
    else { this.pending.add(rel); }
    if (was !== this.pending.has(rel)) { this.trace(`${rel}: ${was ? 'no longer pending' : 'pending'} (disk ${short(d?.oid)}, baseline ${short(b?.oid)})`); }
  }

  private dropBaseline(rel: string, why: string): boolean {
    if (!this.baseline.delete(rel)) { return false; }
    this.dirty = true;
    this.trace(`${rel}: baseline dropped (${why})`);
    return true;
  }

  private async readDisk(rel: string, st?: FileStat): Promise<ReadResult | undefined> {
    const abs = this.abs(rel);
    const stat = st ?? (await this.fs.stat(abs));
    if (stat?.type !== 'file') { return undefined; }
    let data: Uint8Array;
    try {
      data = await this.fs.readFile(abs);
    } catch {
      return undefined; // deleted between stat and read
    }
    const entry: DiskEntry = {
      oid: gitBlobId(data),
      size: data.length,
      binary: isBinary(data),
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      recordedAt: this.now(),
    };
    return { entry, data };
  }

  private async setBaseline(rel: string, data: Uint8Array, why: string): Promise<void> {
    const oid = await this.store.write(data);
    const old = this.baseline.get(rel)?.oid;
    this.baseline.set(rel, { oid, size: data.length, binary: isBinary(data) });
    this.dirty = true;
    if (old !== oid) { this.trace(`${rel}: baseline ${short(old)} -> ${short(oid)} (${why})`); }
  }

  private async writeDisk(rel: string, data: Uint8Array): Promise<void> {
    const abs = this.abs(rel);
    await this.fs.mkdir(path.dirname(abs));
    const oid = gitBlobId(data);
    this.expectedWrites.set(rel, oid);
    await this.fs.writeFile(abs, data);
    const st = await this.fs.stat(abs);
    this.disk.set(rel, {
      oid,
      size: data.length,
      binary: isBinary(data),
      mtimeMs: st?.mtimeMs ?? 0,
      ctimeMs: st?.ctimeMs ?? 0,
      recordedAt: this.now(),
    });
    this.updatePending(rel);
    this.dirty = true;
  }

  private async removeDisk(rel: string): Promise<void> {
    this.expectedWrites.set(rel, null);
    await this.fs.remove(this.abs(rel));
    this.disk.delete(rel);
    this.updatePending(rel);
    this.dirty = true;
  }

  private consumeExpectedWrite(rel: string): boolean {
    if (!this.expectedWrites.has(rel)) { return false; }
    const expected = this.expectedWrites.get(rel);
    this.expectedWrites.delete(rel);
    return (this.disk.get(rel)?.oid ?? null) === expected;
  }

  /**
   * Does the disk still match what the engine last observed for `rel`? If not, the engine's view is
   * refreshed (and an 'external' event emitted) so the host can re-render before retrying.
   */
  private async isFresh(rel: string): Promise<boolean> {
    const known = this.disk.get(rel);
    const now = await this.readDisk(rel);
    if (this.saveInFlight(rel, now)) { return true; } // the reported save just hasn't landed yet
    if ((now?.entry.oid ?? null) === (known?.oid ?? null)) {
      if (now) { this.disk.set(rel, now.entry); }
      return true;
    }
    const changed = await this.refreshPath(rel);
    this.emit('external', changed);
    return false;
  }

  /**
   * The save reported for `rel`, if it hasn't reached the disk yet: the file (`now`, as just read) is exactly
   * as it was when the save was reported, same content and same stat. Forgotten once the disk shows anything
   * else, when a watcher event for the path is handled, or after SAVE_IN_FLIGHT_MS.
   */
  private saveInFlight(rel: string, now: ReadResult | undefined): InFlightSave | undefined {
    const f = this.inFlightSaves.get(rel);
    if (!f) { return undefined; }
    const b = f.before;
    const e = now?.entry;
    const unchanged = b && e ? b.oid === e.oid && b.size === e.size && b.mtimeMs === e.mtimeMs && b.ctimeMs === e.ctimeMs : !b && !e;
    if (unchanged && this.now() <= f.until) { return f; }
    this.inFlightSaves.delete(rel);
    return undefined;
  }

  private async allFresh(paths: readonly string[]): Promise<boolean> {
    let ok = true;
    for (const p of paths) { if (!(await this.isFresh(p))) { ok = false; } }
    return ok;
  }

  /** Re-examine one path (file, directory, or missing). Returns the paths whose disk state changed. */
  private async refreshPath(rel: string): Promise<string[]> {
    const changed: string[] = [];
    const st = await this.fs.stat(this.abs(rel));
    const untrack = (p: string) => {
      if (this.disk.has(p) || this.baseline.has(p)) { changed.push(p); }
      this.dropBaseline(p, 'now ignored');
      this.disk.delete(p);
      this.updatePending(p);
    };
    const drop = (p: string) => {
      if (this.disk.delete(p)) {
        changed.push(p);
        this.dirty = true;
      }
      this.updatePending(p);
    };

    // Watcher events are what actually happened on disk: they end any in-flight save of these paths.
    for (const p of [...this.inFlightSaves.keys()]) { if (p === rel || p.startsWith(`${rel}/`)) { this.inFlightSaves.delete(p); } }
    if (!st || (st.type !== 'file' && st.type !== 'directory')) {
      for (const p of this.trackedUnder(rel)) { drop(p); }
      return changed;
    }
    if (await this.rules.isIgnored(rel, st.type === 'directory')) {
      for (const p of this.trackedUnder(rel)) { untrack(p); }
      return changed;
    }
    if (st.type === 'file') {
      for (const p of this.trackedUnder(rel)) { if (p !== rel) { drop(p); } } // was a directory
      const before = this.disk.get(rel)?.oid;
      const r = await this.readDisk(rel, st);
      if (!r) {
        drop(rel);
        return changed;
      }
      this.disk.set(rel, r.entry);
      this.dirty = true;
      this.updatePending(rel);
      if (before !== r.entry.oid) { changed.push(rel); }
      return changed;
    }
    // Directory: walk it.
    if (this.disk.has(rel)) { drop(rel); } // was a file
    const seen = new Set<string>();
    await this.walk(rel, async (p, fst) => {
      seen.add(p);
      const before = this.disk.get(p)?.oid;
      const r = await this.readDisk(p, fst);
      if (!r) { return; }
      this.disk.set(p, r.entry);
      this.dirty = true;
      this.updatePending(p);
      if (before !== r.entry.oid) { changed.push(p); }
    });
    for (const p of this.trackedUnder(rel)) { if (!seen.has(p) && this.disk.has(p)) { drop(p); } }
    return changed;
  }

  /** `X.tex` appearing/disappearing changes whether `X.pdf` is a build artifact. */
  private async refreshTexSibling(texRel: string): Promise<string[]> {
    const pdf = texRel.replace(/\.tex$/i, '.pdf');
    const wasTracked = this.disk.has(pdf) || this.baseline.has(pdf);
    const ignored = await this.rules.isIgnored(pdf);
    if (ignored && wasTracked) { return this.refreshPath(pdf); }
    if (!ignored && !wasTracked) {
      // Previously an ignored build artifact: start tracking it with nothing pending.
      const r = await this.readDisk(pdf);
      if (!r) { return []; }
      this.disk.set(pdf, r.entry);
      await this.setBaseline(pdf, r.data, 'no longer a LaTeX build artifact');
      this.updatePending(pdf);
    }
    return [];
  }

  /** Walk non-ignored regular files under `dirRel` ('' = root). Symlinks are not followed. */
  private async walk(dirRel: string, onFile: (rel: string, st: FileStat) => Promise<void>): Promise<void> {
    const stack = [dirRel];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = await this.fs.readdir(dir ? this.abs(dir) : this.root);
      } catch {
        continue;
      }
      for (const e of entries) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.type === 'directory') {
          if (!(await this.rules.isIgnoredSelf(rel, true))) { stack.push(rel); }
        } else if (e.type === 'file') {
          if (await this.rules.isIgnoredSelf(rel, false)) { continue; }
          const st = await this.fs.stat(this.abs(rel));
          if (st?.type === 'file') { await onFile(rel, st); }
        }
      }
    }
  }

  private async fullScan(opts: { trustStatCache: boolean; initAll?: boolean; previousRules?: IgnoreRules }): Promise<string[]> {
    const changed: string[] = [];
    const seen = new Set<string>();
    const previouslyKnown = new Set(this.disk.keys());
    await this.walk('', async (rel, st) => {
      seen.add(rel);
      const cached = this.disk.get(rel);
      const trusted =
        opts.trustStatCache &&
        cached !== undefined &&
        cached.size === st.size &&
        cached.mtimeMs === st.mtimeMs &&
        cached.ctimeMs === st.ctimeMs &&
        cached.recordedAt - st.mtimeMs > RACY_MS;
      const wasIgnored =
        opts.previousRules !== undefined && !previouslyKnown.has(rel) && !this.baseline.has(rel) && (await opts.previousRules.isIgnored(rel));
      if (trusted && !opts.initAll) { return; }
      const r = await this.readDisk(rel, st);
      if (!r) { return; }
      if (cached?.oid !== r.entry.oid) { changed.push(rel); }
      this.disk.set(rel, r.entry);
      if (opts.initAll || wasIgnored) { await this.setBaseline(rel, r.data, opts.initAll ? 'first scan' : 'no longer ignored'); }
    });
    for (const rel of [...this.disk.keys()]) {
      if (!seen.has(rel)) {
        this.disk.delete(rel);
        changed.push(rel);
      }
    }
    // Baseline entries for paths that are now ignored stop being tracked.
    for (const rel of [...this.baseline.keys()]) {
      if (!seen.has(rel) && (await this.rules.isIgnored(rel))) {
        this.dropBaseline(rel, 'now ignored');
        changed.push(rel);
      }
    }
    this.pending.clear();
    for (const rel of new Set([...this.disk.keys(), ...this.baseline.keys()])) { this.updatePending(rel); }
    this.dirty = true;
    return changed;
  }

  private async rescanInternal(): Promise<void> {
    this.rules.invalidate();
    const changed = await this.fullScan({ trustStatCache: true });
    this.emit('rescan', changed);
  }

  private async reloadIgnoreRules(): Promise<void> {
    const previous = this.rules;
    this.rules = this.makeRules();
    const changed = await this.fullScan({ trustStatCache: true, previousRules: previous });
    this.emit('rescan', changed);
  }

  // ---------------------------------------------------------------- internals: changes

  private computeRenames(): { newToOld: Map<string, string>; oldToNew: Map<string, string> } {
    const deleted = new Map<string, string[]>();
    const created = new Map<string, string[]>();
    for (const rel of this.pending) {
      const d = this.disk.get(rel);
      const b = this.baseline.get(rel);
      if (b && !d && b.size > 0) { push(deleted, b.oid, rel); }
      else if (d && !b && d.size > 0) { push(created, d.oid, rel); }
    }
    const newToOld = new Map<string, string>();
    const oldToNew = new Map<string, string>();
    for (const [oid, dels] of deleted) {
      const adds = created.get(oid);
      if (!adds) { continue; }
      dels.sort();
      adds.sort();
      const pair = (o: string, n: string) => {
        newToOld.set(n, o);
        oldToNew.set(o, n);
      };
      // Prefer pairs that keep the file name (moves), then pair the rest in path order.
      for (const o of dels) {
        const n = adds.find((a) => !newToOld.has(a) && path.posix.basename(a) === path.posix.basename(o));
        if (n) { pair(o, n); }
      }
      const restDels = dels.filter((o) => !oldToNew.has(o));
      const restAdds = adds.filter((a) => !newToOld.has(a));
      for (let i = 0; i < Math.min(restDels.length, restAdds.length); i++) { pair(restDels[i]!, restAdds[i]!); }
    }
    return { newToOld, oldToNew };
  }

  /** The paths that make up the review unit containing `rel` (two for a rename). */
  private reviewUnit(rel: string): string[] {
    const { newToOld, oldToNew } = this.computeRenames();
    const old = newToOld.get(rel);
    if (old) { return [old, rel]; }
    const nw = oldToNew.get(rel);
    if (nw) { return [rel, nw]; }
    return [rel];
  }

  private summarize(rel: string, oldPath?: string): ChangeSummary {
    const d = this.disk.get(rel);
    const b = this.baseline.get(oldPath ?? rel);
    const binary = Boolean(d?.binary || b?.binary);
    const large = (d?.size ?? 0) > this.largeFileThreshold || (b?.size ?? 0) > this.largeFileThreshold;
    let kind: ChangeKind;
    if (oldPath) { kind = 'renamed'; }
    else if (!b) { kind = 'created'; }
    else if (!d) { kind = 'deleted'; }
    else { kind = 'modified'; }
    const summary: ChangeSummary = { path: rel, kind, binary, large, reviewMode: kind === 'modified' && !binary && !large ? 'hunk' : 'file' };
    if (oldPath) { summary.oldPath = oldPath; }
    return summary;
  }

  /** Read both sides fresh and compute the change for `rel`. */
  private async loadChange(
    rel: string,
  ): Promise<{ change: FileChange; baseLines?: string[]; diskLines?: string[] } | undefined> {
    await this.isFresh(rel); // refreshes the engine's view if the disk moved on; compute from the current disk either way
    if (!this.pending.has(rel)) { return undefined; }
    const { newToOld, oldToNew } = this.computeRenames();
    if (oldToNew.has(rel)) { return { change: { ...this.summarize(oldToNew.get(rel)!, rel), hunks: [] } }; }
    const summary = this.summarize(rel, newToOld.get(rel));
    if (summary.kind === 'renamed' || summary.binary || summary.large) { return { change: { ...summary, hunks: [] } }; }
    const b = this.baseline.get(rel);
    const baseText = b ? decodeText(await this.store.read(b.oid))! : '';
    const diskRead = this.disk.has(rel) ? await this.readDisk(rel) : undefined;
    const diskData = this.saveInFlight(rel, diskRead)?.data ?? diskRead?.data;
    const diskText = diskData ? decodeText(diskData)! : '';
    const baseLines = splitLines(baseText);
    const diskLines = splitLines(diskText);
    return { change: { ...summary, hunks: computeHunks(baseLines, diskLines) }, baseLines, diskLines };
  }

  private async acceptPath(rel: string, checkFresh: boolean, why: string): Promise<void> {
    if (checkFresh && !(await this.isFresh(rel))) { throw new StaleChangeError(`${rel} changed on disk`); }
    const r = this.disk.has(rel) ? await this.readDisk(rel) : undefined;
    const saving = this.saveInFlight(rel, r);
    if (saving) {
      await this.setBaseline(rel, saving.data, `${why}, the save in flight`); // accept what is being saved, not the old disk
    } else if (r) {
      this.disk.set(rel, r.entry);
      await this.setBaseline(rel, r.data, why);
    } else {
      this.dropBaseline(rel, why);
    }
    this.updatePending(rel);
  }

  private async rejectPath(rel: string, checkFresh: boolean): Promise<void> {
    if (checkFresh && !(await this.isFresh(rel))) { throw new StaleChangeError(`${rel} changed on disk`); }
    const b = this.baseline.get(rel);
    if (b) { await this.writeDisk(rel, await this.store.read(b.oid)); }
    else { await this.removeDisk(rel); }
  }

  private async rejectUnit(paths: readonly string[]): Promise<void> {
    if (paths.length === 2) {
      // Undo a rename by moving the file back.
      const [oldRel, newRel] = paths as [string, string];
      const oldAbs = this.abs(oldRel);
      try {
        await this.fs.mkdir(path.dirname(oldAbs));
        this.expectedWrites.set(oldRel, this.baseline.get(oldRel)?.oid ?? null);
        this.expectedWrites.set(newRel, null);
        await this.fs.rename(this.abs(newRel), oldAbs);
        const moved = this.disk.get(newRel)!;
        const st = await this.fs.stat(oldAbs);
        this.disk.delete(newRel);
        this.disk.set(oldRel, { ...moved, mtimeMs: st?.mtimeMs ?? 0, ctimeMs: st?.ctimeMs ?? 0, recordedAt: this.now() });
        this.updatePending(oldRel);
        this.updatePending(newRel);
        this.dirty = true;
        return;
      } catch {
        // Fall through to restoring both sides individually.
      }
    }
    for (const p of paths) { if (this.pending.has(p)) { await this.rejectPath(p, false); } }
  }

  // ---------------------------------------------------------------- internals: git

  private async snapshotGit(): Promise<void> {
    if (!this.repo) { return; }
    this.gitHead = await readHeadState(this.fs, this.repo);
    this.gitIndexStat = await statIndex(this.fs, this.repo);
    this.gitIndex = await readIndex(this.fs, this.repo);
    this.dirty = true;
  }

  private scheduleGitRetry(): void {
    if (this.gitRetryTimer || this.closed) { return; }
    this.gitRetryTimer = setTimeout(() => {
      this.gitRetryTimer = undefined;
      if (this.closed) { return; }
      void this.run('gitRetry', async () => {
        await this.pollGit();
        await this.persist();
      }).catch(() => undefined);
    }, GIT_RETRY_MS);
    this.gitRetryTimer.unref?.();
  }

  /** Workspace-relative path for a repo-relative index path, or undefined if outside this root. */
  private repoToRel(repoPath: string): string | undefined {
    const prefix = this.repo!.prefix;
    if (!prefix) { return repoPath; }
    return repoPath.startsWith(`${prefix}/`) ? repoPath.slice(prefix.length + 1) : undefined;
  }

  private relToRepo(rel: string): string {
    const prefix = this.repo!.prefix;
    return prefix ? `${prefix}/${rel}` : rel;
  }

  private async pollGit(): Promise<GitOperationResult> {
    const repo = this.repo;
    if (!repo) { return { kind: 'none' }; }
    if (await isGitBusy(this.fs, repo)) {
      this.scheduleGitRetry();
      return { kind: 'busy' };
    }
    const head = await readHeadState(this.fs, repo);
    const idxStat = await statIndex(this.fs, repo);

    const stashOnly = this.gitHead !== undefined && this.gitHead.head === head.head && this.gitHead.oid === head.oid;
    if (this.gitHead && !headStatesEqual(this.gitHead, head) && !stashOnly) {
      // HEAD moved (commit, checkout, pull, merge, rebase, reset): the files that differ between the old and the new
      // HEAD tree (both sides of a rename, deletions too) are accepted whole, as they are on disk. Pending changes in
      // every other file stay pending: committing one file does not end the review of the rest (Guru, Oct 8 2026).
      // Only refs/stash moving (`git stash`, `git stash pop`) is not a HEAD move: the stash takes the files back to
      // HEAD and pop brings them back, as plain disk changes against the baseline. Agents run `git stash` + `pop` to
      // check something; accepting there would end the review of everything they wrote.
      const from = this.gitHead.oid;
      const changed = await this.gitReader.changedPaths(repo, from, head.oid);
      const inDiff = changed && new Set(changed.map((p) => this.repoToRel(p)).filter((p) => p !== undefined));
      if (!inDiff) { this.trace(`git could not diff ${short(from ?? undefined)}..${short(head.oid ?? undefined)}; accepting every pending change`); }
      await this.fullScan({ trustStatCache: true });
      const accepted: string[] = [];
      for (const rel of [...this.pending]) {
        if (inDiff && !inDiff.has(rel)) { continue; }
        await this.acceptPath(rel, false, `git HEAD moved (${short(from ?? undefined)} -> ${short(head.oid ?? undefined)})`);
        accepted.push(rel);
      }
      this.gitHead = head;
      // Index changes outside the diff (a `git add` in the same batch as the commit) count as staging.
      const staged = (await this.reindex(idxStat)).filter((rel) => !inDiff?.has(rel));
      if (inDiff) { accepted.push(...(await this.acceptStaged(staged))); }
      accepted.sort();
      this.trace(`git HEAD moved; diff: ${inDiff ? [...inDiff].join(', ') || 'nothing' : 'unknown'}; accepted: ${accepted.join(', ') || 'nothing'}`);
      this.emit('git-head', accepted);
      return { kind: 'head', accepted };
    }
    if (!this.gitHead) { this.dirty = true; }
    this.gitHead = head;

    const statSame =
      (idxStat === null && this.gitIndexStat === null) ||
      (idxStat !== null &&
        this.gitIndexStat !== null &&
        idxStat.size === this.gitIndexStat.size &&
        idxStat.mtimeMs === this.gitIndexStat.mtimeMs &&
        idxStat.ctimeMs === this.gitIndexStat.ctimeMs);
    if (statSame) { return { kind: 'none' }; }

    const staged = await this.reindex(idxStat);
    const accepted = await this.acceptStaged(staged);
    if (staged.length) { this.trace(`git index changed for ${staged.join(', ')}; accepted: ${accepted.join(', ') || 'nothing'}`); }
    if (accepted.length) { this.emit('git-index', accepted); }
    return { kind: 'index', staged: staged.sort(), accepted };
  }

  /** Read the index again; returns the workspace paths whose entries changed. */
  private async reindex(idxStat: IndexStat | null): Promise<string[]> {
    const next = await readIndex(this.fs, this.repo!);
    const changed: string[] = [];
    for (const p of new Set([...this.gitIndex.keys(), ...next.keys()])) {
      if (this.gitIndex.get(p) === next.get(p)) { continue; }
      const rel = this.repoToRel(p);
      if (rel !== undefined) { changed.push(rel); }
    }
    this.gitIndex = next;
    this.gitIndexStat = idxStat;
    this.dirty = true;
    return changed;
  }

  /** Index-only change: accept pending changes in the staged files, as far as the index agrees with disk. */
  private async acceptStaged(staged: readonly string[]): Promise<string[]> {
    const repo = this.repo!;
    const accepted: string[] = [];
    for (const rel of staged) {
      if (!this.pending.has(rel)) { continue; }
      const indexOid = this.gitIndex.get(this.relToRepo(rel));
      const d = this.disk.get(rel);
      const b = this.baseline.get(rel);
      const diskRead = d ? await this.readDisk(rel) : undefined;
      if (diskRead) { this.disk.set(rel, diskRead.entry); }
      const diskOid = diskRead ? gitBlobId(diskRead.data, repo.objectFormat) : undefined;

      if (!diskRead) {
        // Pending deletion: staged once the index no longer has the file.
        if (indexOid === undefined) {
          await this.acceptPath(rel, false, 'deletion staged');
          accepted.push(rel);
        }
        continue;
      }
      if (indexOid === undefined) { continue; }
      if (indexOid === diskOid) {
        await this.acceptPath(rel, false, 'staged (index = disk)');
        accepted.push(rel);
        continue;
      }
      // Partial staging (`git add -p`): accept only the hunks the index agrees with.
      if (!b || diskRead.entry.binary || b.binary || diskRead.data.length > this.largeFileThreshold || indexOid.startsWith('conflict:')) { continue; }
      const indexData = await this.gitReader.readBlob(repo, indexOid);
      const indexText = indexData ? decodeText(indexData) : undefined;
      if (indexText === undefined) { continue; }
      const baseLines = splitLines(decodeText(await this.store.read(b.oid))!);
      const diskLines = splitLines(decodeText(diskRead.data)!);
      const regions = stagedRegions(baseLines, diskLines, splitLines(indexText));
      if (regions.length === 0) { continue; }
      await this.setBaseline(rel, encodeText(joinLines(acceptHunks(baseLines, diskLines, regions))), `partly staged (${regions.length} region(s))`);
      this.updatePending(rel);
      accepted.push(rel);
    }
    return accepted;
  }
}

function short(oid: string | undefined): string {
  return oid ? oid.slice(0, 8) : 'none';
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) { arr.push(v); }
  else { m.set(k, [v]); }
}

/** realpath that tolerates missing trailing components (e.g. a just-deleted file). */
export async function realpathLoose(fs: FileSystem, p: string): Promise<string> {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) { return p; }
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}
