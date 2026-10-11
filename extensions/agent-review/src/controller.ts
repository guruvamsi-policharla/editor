/**
 * Editor-agnostic glue between the review engine and the editor's inline review UI.
 *
 * The engine is authoritative (pending = disk - baseline). The controller pushes each pending text file's
 * full baseline to the core review UI (CoreBridge) and turns the UI's Keep/Undo actions back into engine
 * operations. It has no `vscode` dependency so it can be tested against a real engine with a fake bridge.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { equalIgnoringEol, NotPendingError, StaleChangeError, type ChangeEvent, type ChangeKind, type MultiRootReview, type ReviewEngine, type TrackedEdit } from '@editor/engine';

export type InlineKind = 'modified' | 'created';

/**
 * The core side of the inline review UI (internal commands `_agentReview.*` in the fork). Paths are as VS Code knows
 * them (see UiPaths); everything else in the controller uses real paths.
 */
export interface CoreBridge {
  /** Show `absPath` inline as pending against `baseline` (creates or updates the review entry). */
  setBaseline(absPath: string, baseline: string, kind: InlineKind): Promise<void>;
  /** Stop showing `absPath` inline. */
  remove(absPath: string): Promise<void>;
  /**
   * Undo every pending change of a shown file in its editor buffer, as the editor's own file Undo does: text the
   * user typed outside the changes stays, and the buffer is saved only if it had no other unsaved edits.
   * Returns where the undo ended up, or undefined if the file isn't shown. Optional: only the fork has it.
   */
  rejectInEditor?(absPath: string): Promise<'saved' | 'unsaved' | 'deleted' | 'cancelled' | undefined>;
}

export interface DocumentState {
  /** True if the editor has unsaved changes for this file. */
  isDirty(absPath: string): boolean;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
  /** Detailed trace (the `agentReview.trace` setting); optional. */
  trace?(message: string): void;
}

export interface PendingFile {
  absPath: string;
  root: string;
  /** Root-relative posix path. */
  rel: string;
  kind: ChangeKind;
  /** Absolute old path, for renames. */
  oldAbsPath?: string;
  binary: boolean;
  large: boolean;
  /** Shown inline in the editor (text files that exist on disk); the rest are review-list only. */
  inline: boolean;
}

/** An action taken in the core review UI, forwarded by the fork as `agentReview.ext.onDidHunkAction`. */
export type ReviewAction =
  | { kind: 'accepted'; path: string; baseline: string } // a hunk was kept: the full new baseline
  | { kind: 'rejected'; path: string } // a hunk was undone in the buffer; the save that follows reaches the engine
  | { kind: 'acceptFile'; path: string }
  | { kind: 'rejectFile'; path: string }
  | { kind: 'restore'; path: string; baseline: string | null }; // Ctrl+Z after a Keep: the baseline goes back (null: pending creation)

export interface BulkOutcome {
  done: string[];
  skipped: string[];
  /** Undone in the editor only: these files have unsaved edits, so the undo reaches the disk with their next save. */
  unsaved?: string[];
}

/**
 * Where a file Undo ended up: written to disk, only in the editor buffer (the user's unsaved edits keep it dirty), or
 * not done (`cancelled`: the user kept the changes rather than lose what they typed inside them).
 */
export type UndoOutcome = 'saved' | 'unsaved' | 'cancelled';

export class ReviewController {
  /** absPath -> baseline text last pushed to the core UI. */
  private readonly pushed = new Map<string, string>();
  /** Files whose push waits for the buffer to be saved or reverted (dirty buffer). */
  private readonly deferred = new Set<string>();
  /** Files with unsaved edits that changed on disk underneath them, until the buffer is clean again. */
  private readonly conflicted = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly subscriptions: { dispose(): void }[] = [];
  private files: PendingFile[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    readonly review: MultiRootReview,
    private readonly bridge: CoreBridge,
    private readonly docs: DocumentState,
    private readonly log: Logger,
    /** Called when any unreported disk change hits a file with unsaved edits (never overwritten; the user resolves it). */
    private readonly onConflict?: (absPath: string) => void,
    /** Paths as VS Code knows them (workspace folders opened through symlinks); used for the bridge and onConflict. */
    readonly ui: UiPaths = new UiPaths([]),
  ) {
    for (const engine of review.engines.values()) {
      this.subscriptions.push(engine.onDidChange((e) => void this.enqueue(() => this.onEngineChange(engine, e))));
    }
    this.refreshList();
  }

  get pendingFiles(): readonly PendingFile[] {
    return this.files;
  }

  /** Fired when the pending list changes. */
  onDidChangeFiles(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Wait for queued pushes (tests, shutdown). */
  idle(): Promise<void> {
    return this.enqueue(async () => undefined);
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.subscriptions) { s.dispose(); }
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ engine -> UI

  /** Push every pending file (startup, after an extension-host restart). */
  syncAll(): Promise<void> {
    return this.enqueue(async () => {
      this.refreshList();
      this.fire();
      const live = new Set<string>();
      for (const f of this.files) {
        live.add(f.absPath);
        await this.syncFile(f, undefined);
      }
      for (const abs of [...this.pushed.keys()]) { if (!live.has(abs)) { await this.unpush(abs); } }
    });
  }

  private async onEngineChange(engine: ReviewEngine, e: ChangeEvent): Promise<void> {
    this.refreshList();
    this.fire();
    for (const rel of e.paths) {
      const abs = toAbs(engine.root, rel);
      const f = this.files.find((x) => x.absPath === abs);
      this.checkConflict(abs, f, e.reason);
      if (f) { await this.syncFile(f, e.reason); }
      else if (this.pushed.has(abs)) { await this.unpush(abs); }
    }
  }

  /**
   * A disk change nobody reported (an agent through the chat or a terminal, a shell command, any other tool: seen by the
   * watcher or a rescan) under unsaved edits is a conflict, whether or not the file is still pending afterwards. The
   * buffer and the disk are left alone; the user merges (#34).
   */
  private checkConflict(abs: string, f: PendingFile | undefined, reason: ChangeEvent['reason']): void {
    if (reason !== 'external' && reason !== 'rescan') { return; }
    // Deleted, binary or large files have nothing to merge.
    if (f ? !f.inline : !fs.existsSync(abs)) { return; }
    if (!this.docs.isDirty(abs)) { return; }
    this.log.trace?.(`${abs}: changed on disk under unsaved edits (conflict, ${reason})`);
    this.conflicted.add(abs);
    this.onConflict?.(this.ui.toUi(abs));
  }

  private async syncFile(f: PendingFile, reason: ChangeEvent['reason'] | undefined): Promise<void> {
    if (!f.inline) {
      if (this.pushed.has(f.absPath)) { await this.unpush(f.absPath); }
      return;
    }
    if (this.docs.isDirty(f.absPath) && this.pushed.has(f.absPath)) {
      // The UI shows baseline vs. buffer; moving the baseline under unsaved typing would mislabel it.
      this.log.trace?.(`${f.absPath}: baseline push deferred (unsaved edits)`);
      this.deferred.add(f.absPath);
      return;
    }
    const engine = this.engineForRoot(f.root);
    const baseline = f.kind === 'created' ? '' : decode(await engine.getBaselineContent(f.rel));
    // Core's models keep one EOL per file, so a baseline that differs only in line endings looks the same there.
    // An external change is pushed anyway: the editor's review is a view, and the push makes sure it shows the file
    // (it compares the baseline itself, so this costs nothing when it already does).
    const pushed = this.pushed.get(f.absPath);
    if (pushed !== undefined && equalIgnoringEol(pushed, baseline) && reason !== 'external') { return; }
    this.pushed.set(f.absPath, baseline);
    this.deferred.delete(f.absPath);
    this.log.trace?.(`${f.absPath}: baseline pushed to the editor (${reason ?? 'sync'})`);
    try {
      await this.bridge.setBaseline(this.ui.toUi(f.absPath), baseline, f.kind as InlineKind);
    } catch (err) {
      this.pushed.delete(f.absPath);
      this.log.error(`could not show ${f.absPath} inline`, err);
    }
  }

  private async unpush(abs: string): Promise<void> {
    this.log.trace?.(`${abs}: removed from the editor's review`);
    this.pushed.delete(abs);
    this.deferred.delete(abs);
    try {
      await this.bridge.remove(this.ui.toUi(abs));
    } catch (err) {
      this.log.error(`could not remove ${abs} from inline review`, err);
    }
  }

  // ------------------------------------------------------------------ UI -> engine

  /** True while `absPath` has unsaved edits and changed on disk underneath them. */
  hasConflict(absPath: string): boolean {
    return this.conflicted.has(normalizePath(absPath));
  }

  /** A Keep/Undo action from the core review UI. */
  async onReviewAction(action: ReviewAction): Promise<void> {
    const abs = normalizePath(action.path);
    const engine = await this.review.engineFor(abs);
    if (!engine) { return; }
    this.log.trace?.(`${abs}: review action ${action.kind}`);
    try {
      switch (action.kind) {
        case 'accepted':
          // Record first so the engine's 'accept' event doesn't bounce the same text back to the UI.
          this.pushed.set(abs, action.baseline);
          // The UI's text models normalize line endings; give each line back its own (mixed CRLF/LF files).
          await engine.setBaselineContent(abs, action.baseline, { restoreLineEndings: true });
          break;
        case 'rejected':
          // The core UI already restored the hunk in the buffer and saved it (if it was clean, without save
          // participants). The engine then sees disk == baseline in that region; nothing to do here. With unsaved
          // edits the undo is saved with the user's next save and attributed through the edit log.
          break;
        case 'acceptFile':
          await engine.acceptFile(abs);
          break;
        case 'rejectFile':
          await engine.rejectFile(abs);
          break;
        case 'restore':
          // Not recorded in `pushed`: the change has to be pushed back to the UI (its entry may be gone).
          await engine.setBaselineContent(abs, action.baseline, { restoreLineEndings: true });
          break;
      }
    } catch (err) {
      if (err instanceof NotPendingError) { return; }
      if (err instanceof StaleChangeError) {
        this.log.warn(`${abs} changed on disk before ${action.kind}; showing the current state`);
        this.pushed.delete(abs);
        await this.syncAll();
        return;
      }
      throw err;
    }
  }

  /**
   * Before the editor writes a user save to disk. `userContent`: the buffer before save participants (format on
   * save) changed it, if known; the engine then tells the formatter's changes apart by diffing, not by the log.
   */
  async onWillSave(absPath: string, content: string, edits: readonly TrackedEdit[] | undefined, userContent?: string): Promise<void> {
    const abs = normalizePath(absPath);
    const engine = await this.review.engineFor(abs);
    if (!engine) { return; }
    if (this.conflicted.has(abs)) {
      // The buffer is based on an older disk version. The editor refuses this save ("file is newer") unless the
      // user overwrites; then the write is an external change, reviewed against the baseline like any other.
      this.log.warn(`${abs} changed on disk since it was loaded; not attributing this save (merge it instead)`);
      return;
    }
    try {
      await engine.reportUserSave(abs, content, { ...(edits ? { edits } : {}), ...(userContent !== undefined ? { userContent } : {}) });
    } catch (err) {
      this.log.error(`reportUserSave failed for ${abs}`, err);
    }
  }

  /** The buffer is clean again (saved, reverted, or closed): run any deferred push. */
  onBufferSettled(absPath: string): Promise<void> {
    const abs = normalizePath(absPath);
    this.conflicted.delete(abs);
    if (!this.deferred.has(abs)) { return Promise.resolve(); }
    return this.enqueue(async () => {
      this.deferred.delete(abs);
      const f = this.files.find((x) => x.absPath === abs);
      if (f) { await this.syncFile(f, undefined); }
      else if (this.pushed.has(abs)) { await this.unpush(abs); }
    });
  }

  /** Watcher events (absolute paths). */
  handleFsEvents(paths: readonly string[]): Promise<void> {
    return this.review.handleFsEvents([...paths]);
  }

  async acceptFile(absPath: string): Promise<void> {
    await this.onReviewAction({ kind: 'acceptFile', path: absPath });
  }

  /**
   * Undo a whole file. Normally the engine writes the baseline back to disk. A file with unsaved edits is never
   * written behind the editor's back: it is undone in its buffer instead (the user's edits outside the agent's
   * changes stay), which stays dirty until the user saves.
   */
  async rejectFile(absPath: string): Promise<UndoOutcome> {
    const abs = normalizePath(absPath);
    if (this.docs.isDirty(abs)) {
      const inEditor = await this.rejectInEditor(abs);
      if (!inEditor) { throw new Error('The file has unsaved changes; save or revert it first.'); }
      return inEditor;
    }
    await this.onReviewAction({ kind: 'rejectFile', path: abs });
    return 'saved';
  }

  /** Undo a dirty file in its editor buffer, if the editor shows its current pending state. */
  private async rejectInEditor(abs: string): Promise<UndoOutcome | undefined> {
    const f = this.files.find((x) => x.absPath === abs);
    // Not for created/deleted/renamed files (that undo deletes or restores the file), nor when the disk changed under
    // the unsaved edits (a conflict: the editor shows an older state; merge first).
    if (!this.bridge.rejectInEditor || !f || f.kind !== 'modified' || !f.inline || !this.pushed.has(abs) || this.conflicted.has(abs)) {
      return undefined;
    }
    const r = await this.bridge.rejectInEditor(this.ui.toUi(abs));
    return r === 'saved' || r === 'unsaved' || r === 'cancelled' ? r : undefined;
  }

  async acceptAll(): Promise<BulkOutcome> {
    const out: BulkOutcome = { done: [], skipped: [] };
    for (const engine of this.review.engines.values()) {
      const r = await engine.acceptAll();
      out.done.push(...r.done.map((p) => toAbs(engine.root, p)));
      out.skipped.push(...r.skipped.map((p) => toAbs(engine.root, p)));
    }
    return out;
  }

  /**
   * Undo everything. Files with unsaved edits are undone in their editor buffers (see `rejectFile`), never written
   * behind the editor; those that can't be (created/deleted files, conflicts) are skipped.
   */
  async rejectAll(): Promise<BulkOutcome> {
    const out: BulkOutcome = { done: [], skipped: [], unsaved: [] };
    for (const f of [...this.files]) {
      if (f.kind === 'renamed' || !this.docs.isDirty(f.absPath)) {
        try {
          await this.engineForRoot(f.root).rejectFile(f.rel);
          out.done.push(f.absPath);
        } catch (err) {
          if (!(err instanceof NotPendingError)) { out.skipped.push(f.absPath); }
        }
      } else {
        const r = await this.rejectInEditor(f.absPath);
        if (r === 'cancelled') { continue; } // the user chose to keep it
        if (r) { out.done.push(f.absPath); }
        else { out.skipped.push(f.absPath); }
        if (r === 'unsaved') { out.unsaved!.push(f.absPath); }
      }
    }
    return out;
  }

  /** Baseline (accepted) text of a file, or undefined if it has none. */
  async baselineText(absPath: string): Promise<string | undefined> {
    const abs = normalizePath(absPath);
    const engine = await this.review.engineFor(abs);
    const data = engine ? await engine.getBaselineContent(abs).catch(() => undefined) : undefined;
    return data ? decode(data) : undefined;
  }

  /** Added/removed line counts for the review list (text files only). */
  async lineCounts(f: PendingFile): Promise<{ added: number; removed: number } | undefined> {
    if (f.binary || f.large || f.kind === 'renamed') { return undefined; }
    const change = await this.engineForRoot(f.root).getFileChange(f.rel).catch(() => undefined);
    if (!change) { return undefined; }
    let added = 0;
    let removed = 0;
    for (const h of change.hunks) {
      added += h.newLines.length;
      removed += h.oldLines.length;
    }
    return { added, removed };
  }

  // ------------------------------------------------------------------ internals

  private refreshList(): void {
    const out: PendingFile[] = [];
    for (const engine of this.review.engines.values()) {
      for (const c of engine.listChanges()) {
        const f: PendingFile = {
          absPath: toAbs(engine.root, c.path),
          root: engine.root,
          rel: c.path,
          kind: c.kind,
          binary: c.binary,
          large: c.large,
          inline: (c.kind === 'modified' || c.kind === 'created') && !c.binary && !c.large,
        };
        if (c.oldPath) { f.oldAbsPath = toAbs(engine.root, c.oldPath); }
        out.push(f);
      }
    }
    this.files = out;
  }

  private engineForRoot(root: string): ReviewEngine {
    const e = this.review.engines.get(root);
    if (!e) { throw new Error(`no engine for ${root}`); }
    return e;
  }

  private fire(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        this.log.error('listener failed', err);
      }
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => (this.disposed ? (undefined as T) : fn());
    const result = this.queue.then(run, run);
    this.queue = result.catch((err) => this.log.error('agent review sync failed', err));
    return result;
  }
}

/**
 * Maps the controller's real paths (the engine tracks every file once, under its real path) to the paths VS Code
 * uses: under each workspace folder as it was opened. A folder opened through a symlink (e.g. /tmp/paper on macOS,
 * where /tmp is /private/tmp) keeps its link path in VS Code, so its editors, dirty state and watcher events use
 * that path; pushing the real path to core would review a second, unopened copy of the file.
 */
export class UiPaths {
  private readonly folders: { ui: string; real: string }[];

  constructor(folderPaths: readonly string[]) {
    this.folders = folderPaths.map((ui) => ({ ui: path.resolve(ui), real: normalizePath(ui) }));
  }

  /** The path VS Code uses for a real path (unchanged outside the workspace folders, or if no folder is a link). */
  toUi(realPath: string): string {
    for (const { ui, real } of this.folders) {
      if (realPath === real) { return ui; }
      if (realPath.startsWith(real + path.sep)) { return path.join(ui, path.relative(real, realPath)); }
    }
    return realPath;
  }
}

export function toAbs(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

/** Real path, tolerating missing trailing components (deleted files). */
export function normalizePath(p: string): string {
  const rest: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) { return path.resolve(p); }
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

const decoder = new TextDecoder('utf-8');
function decode(data: Uint8Array | undefined): string {
  return data ? decoder.decode(data) : '';
}
