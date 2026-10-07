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

/** The core side of the inline review UI (internal commands `_agentReview.*` in the fork). */
export interface CoreBridge {
  /** Show `absPath` inline as pending against `baseline` (creates or updates the review entry). */
  setBaseline(absPath: string, baseline: string, kind: InlineKind): Promise<void>;
  /** Stop showing `absPath` inline. */
  remove(absPath: string): Promise<void>;
}

export interface DocumentState {
  /** True if the editor has unsaved changes for this file. */
  isDirty(absPath: string): boolean;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
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
  | { kind: 'rejectFile'; path: string };

export interface BulkOutcome {
  done: string[];
  skipped: string[];
}

export class ReviewController {
  /** absPath -> baseline text last pushed to the core UI. */
  private readonly pushed = new Map<string, string>();
  /** Files whose push waits for the buffer to be saved or reverted (dirty buffer). */
  private readonly deferred = new Set<string>();
  /**
   * Saves reported to the engine but not yet on disk. Between the two, the engine's freshness checks would
   * read the old disk and call it an external change, so nothing asks the engine about these files.
   */
  private readonly saving = new Set<string>();
  private readonly countsCache = new Map<string, { added: number; removed: number }>();
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
    /** Called when an external change hits a file with unsaved edits (never overwritten; the user resolves it). */
    private readonly onConflict?: (absPath: string) => void,
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
    for (const s of this.subscriptions) s.dispose();
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
      for (const abs of [...this.pushed.keys()]) if (!live.has(abs)) await this.unpush(abs);
    });
  }

  private async onEngineChange(engine: ReviewEngine, e: ChangeEvent): Promise<void> {
    if (e.reason === 'self') for (const rel of e.paths) this.saving.delete(toAbs(engine.root, rel));
    this.refreshList();
    this.fire();
    for (const rel of e.paths) {
      const abs = toAbs(engine.root, rel);
      const f = this.files.find((x) => x.absPath === abs);
      if (f) await this.syncFile(f, e.reason);
      else if (this.pushed.has(abs)) await this.unpush(abs);
    }
  }

  private async syncFile(f: PendingFile, reason: ChangeEvent['reason'] | undefined): Promise<void> {
    if (!f.inline) {
      if (this.pushed.has(f.absPath)) await this.unpush(f.absPath);
      return;
    }
    const dirty = this.docs.isDirty(f.absPath);
    if (dirty && reason === 'external' && !this.saving.has(f.absPath)) {
      this.conflicted.add(f.absPath);
      this.onConflict?.(f.absPath);
    }
    if (dirty && this.pushed.has(f.absPath)) {
      // The UI shows baseline vs. buffer; moving the baseline under unsaved typing would mislabel it.
      this.deferred.add(f.absPath);
      return;
    }
    const engine = this.engineForRoot(f.root);
    const baseline = f.kind === 'created' ? '' : decode(await engine.getBaselineContent(f.rel));
    // Core's models keep one EOL per file, so a baseline that differs only in line endings looks the same there.
    const pushed = this.pushed.get(f.absPath);
    if (pushed !== undefined && equalIgnoringEol(pushed, baseline)) return;
    this.pushed.set(f.absPath, baseline);
    this.deferred.delete(f.absPath);
    try {
      await this.bridge.setBaseline(f.absPath, baseline, f.kind as InlineKind);
    } catch (err) {
      this.pushed.delete(f.absPath);
      this.log.error(`could not show ${f.absPath} inline`, err);
    }
  }

  private async unpush(abs: string): Promise<void> {
    this.pushed.delete(abs);
    this.deferred.delete(abs);
    try {
      await this.bridge.remove(abs);
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
    if (!engine) return;
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
      }
    } catch (err) {
      if (err instanceof NotPendingError) return;
      if (err instanceof StaleChangeError) {
        this.log.warn(`${abs} changed on disk before ${action.kind}; showing the current state`);
        this.pushed.delete(abs);
        await this.syncAll();
        return;
      }
      throw err;
    }
  }

  /** Before the editor writes a user save to disk. */
  async onWillSave(absPath: string, content: string, edits: readonly TrackedEdit[] | undefined): Promise<void> {
    const abs = normalizePath(absPath);
    const engine = await this.review.engineFor(abs);
    if (!engine) return;
    if (this.conflicted.has(abs)) {
      // The buffer is based on an older disk version. The editor refuses this save ("file is newer") unless the
      // user overwrites; then the write is an external change, reviewed against the baseline like any other.
      this.log.warn(`${abs} changed on disk since it was loaded; not attributing this save (merge it instead)`);
      return;
    }
    this.saving.add(abs);
    try {
      await engine.reportUserSave(abs, content, edits ? { edits } : {});
    } catch (err) {
      this.log.error(`reportUserSave failed for ${abs}`, err);
    }
  }

  /** The buffer is clean again (saved, reverted, or closed): run any deferred push. */
  onBufferSettled(absPath: string): Promise<void> {
    const abs = normalizePath(absPath);
    this.saving.delete(abs);
    this.conflicted.delete(abs);
    if (!this.deferred.has(abs)) return Promise.resolve();
    return this.enqueue(async () => {
      this.deferred.delete(abs);
      const f = this.files.find((x) => x.absPath === abs);
      if (f) await this.syncFile(f, undefined);
      else if (this.pushed.has(abs)) await this.unpush(abs);
    });
  }

  /** Watcher events (absolute paths). */
  handleFsEvents(paths: readonly string[]): Promise<void> {
    return this.review.handleFsEvents([...paths]);
  }

  async acceptFile(absPath: string): Promise<void> {
    await this.onReviewAction({ kind: 'acceptFile', path: absPath });
  }

  async rejectFile(absPath: string): Promise<void> {
    if (this.docs.isDirty(normalizePath(absPath))) throw new Error('The file has unsaved changes; save or revert it first.');
    await this.onReviewAction({ kind: 'rejectFile', path: absPath });
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

  /** Undo everything, except files with unsaved edits (their buffers would conflict with the disk write). */
  async rejectAll(): Promise<BulkOutcome> {
    const out: BulkOutcome = { done: [], skipped: [] };
    for (const f of [...this.files]) {
      if (f.kind === 'renamed' || !this.docs.isDirty(f.absPath)) {
        try {
          await this.engineForRoot(f.root).rejectFile(f.rel);
          out.done.push(f.absPath);
        } catch (err) {
          if (!(err instanceof NotPendingError)) out.skipped.push(f.absPath);
        }
      } else {
        out.skipped.push(f.absPath);
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
    if (f.binary || f.large || f.kind === 'renamed') return undefined;
    if (this.saving.has(f.absPath)) return this.countsCache.get(f.absPath);
    const change = await this.engineForRoot(f.root).getFileChange(f.rel).catch(() => undefined);
    if (!change) return undefined;
    let added = 0;
    let removed = 0;
    for (const h of change.hunks) {
      added += h.newLines.length;
      removed += h.oldLines.length;
    }
    this.countsCache.set(f.absPath, { added, removed });
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
        if (c.oldPath) f.oldAbsPath = toAbs(engine.root, c.oldPath);
        out.push(f);
      }
    }
    this.files = out;
  }

  private engineForRoot(root: string): ReviewEngine {
    const e = this.review.engines.get(root);
    if (!e) throw new Error(`no engine for ${root}`);
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
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

const decoder = new TextDecoder('utf-8');
function decode(data: Uint8Array | undefined): string {
  return data ? decoder.decode(data) : '';
}
