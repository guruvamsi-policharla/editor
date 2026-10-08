/**
 * Persisted engine state: the baseline manifest (path -> blob id), a stat
 * cache of the last observed disk state (so reopening doesn't rehash every
 * file), and the last observed git state (so git operations performed while
 * the editor was closed are still detected).
 *
 * Pending changes are not stored: pending = disk - baseline is recomputed on
 * open, which is how edits made while the editor was closed show up.
 */
import * as path from 'node:path';
import type { FileSystem } from '../fs.js';
import type { HeadState, IndexStat } from '../git/repo.js';

export const STATE_VERSION = 1;

export interface BlobEntry {
  oid: string;
  size: number;
  binary: boolean;
}

export interface DiskEntry extends BlobEntry {
  mtimeMs: number;
  ctimeMs: number;
  /** Wall-clock time the entry was recorded; used for racy-stat protection. */
  recordedAt: number;
}

export interface GitSnapshot {
  head: HeadState;
  indexStat: IndexStat | null;
  /** Repo-relative path -> blob id, as of the last observation. */
  index: Record<string, string>;
}

export interface PersistedState {
  version: number;
  root: string;
  baseline: Record<string, BlobEntry>;
  disk: Record<string, DiskEntry>;
  git?: GitSnapshot;
}

export async function loadState(fs: FileSystem, file: string): Promise<PersistedState | undefined> {
  const st = await fs.stat(file);
  if (st?.type !== 'file') { return undefined; }
  const parsed = JSON.parse(new TextDecoder().decode(await fs.readFile(file))) as PersistedState;
  if (parsed.version !== STATE_VERSION) {
    throw new Error(`Unsupported review state version ${parsed.version} in ${file}`);
  }
  return parsed;
}

let tmpCounter = 0;

/** Atomic write: temp file + rename. */
export async function saveState(fs: FileSystem, file: string, state: PersistedState): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${++tmpCounter}.tmp`);
  await fs.writeFile(tmp, new TextEncoder().encode(JSON.stringify(state)));
  await fs.rename(tmp, file);
}
