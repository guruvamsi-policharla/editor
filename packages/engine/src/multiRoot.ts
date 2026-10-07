/**
 * Multi-root workspaces: one engine (and one shadow baseline store) per root.
 * Nested roots are excluded from their parent's engine so no file is tracked twice.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { nodeFileSystem, type FileSystem } from './fs.js';
import { realpathLoose, ReviewEngine, type FsEvent, type ReviewEngineOptions } from './engine.js';

/** Stable per-root storage directory under a host-provided base (e.g. extension global storage). */
export function storageDirForRoot(storageBase: string, realRoot: string): string {
  const id = createHash('sha256').update(realRoot).digest('hex').slice(0, 16);
  return path.join(storageBase, id);
}

export interface MultiRootOptions extends Omit<ReviewEngineOptions, 'root' | 'storageDir' | 'excludeDirs'> {
  roots: readonly string[];
  /** Base directory; each root gets `storageDirForRoot(storageBase, root)`. */
  storageBase: string;
}

export class MultiRootReview {
  private constructor(
    readonly engines: ReadonlyMap<string, ReviewEngine>,
    private readonly fs: FileSystem,
  ) {}

  static async open(opts: MultiRootOptions): Promise<MultiRootReview> {
    const fs = opts.fs ?? nodeFileSystem;
    const { roots: inputRoots, storageBase, ...shared } = opts;
    const roots = [...new Set(await Promise.all(inputRoots.map((r) => fs.realpath(path.resolve(r)))))];
    const engines = new Map<string, ReviewEngine>();
    for (const root of roots) {
      const nested = roots.filter((r) => r !== root && r.startsWith(root + path.sep));
      const engine = await ReviewEngine.open({
        ...shared,
        fs,
        root,
        storageDir: storageDirForRoot(storageBase, root),
        excludeDirs: nested,
      });
      engines.set(root, engine);
    }
    return new MultiRootReview(engines, fs);
  }

  /** The engine owning an absolute path (deepest root wins), if any. */
  async engineFor(absPath: string): Promise<ReviewEngine | undefined> {
    const real = await realpathLoose(this.fs, path.resolve(absPath));
    let best: ReviewEngine | undefined;
    for (const [root, engine] of this.engines) {
      if ((real === root || real.startsWith(root + path.sep)) && (!best || root.length > best.root.length)) best = engine;
    }
    return best;
  }

  /** Route watcher events to the owning engines. */
  async handleFsEvents(events: readonly (FsEvent | string)[]): Promise<void> {
    const byEngine = new Map<ReviewEngine, (FsEvent | string)[]>();
    for (const ev of events) {
      const p = typeof ev === 'string' ? ev : ev.path;
      const engine = await this.engineFor(p);
      if (!engine) continue;
      const list = byEngine.get(engine) ?? [];
      list.push(ev);
      byEngine.set(engine, list);
    }
    await Promise.all([...byEngine].map(([engine, evs]) => engine.handleFsEvents(evs)));
  }

  async close(): Promise<void> {
    await Promise.all([...this.engines.values()].map((e) => e.close()));
  }
}
