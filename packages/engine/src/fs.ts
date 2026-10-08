/**
 * Filesystem abstraction. The engine only touches the disk through this
 * interface, so hosts can substitute their own (e.g. VS Code's workspace.fs)
 * and tests can run against `MemoryFileSystem`.
 *
 * Paths are absolute, in the platform's native format.
 */
import * as nodeFs from 'node:fs/promises';
import * as path from 'node:path';

export type FileType = 'file' | 'directory' | 'symlink' | 'other';

export interface FileStat {
  type: FileType;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface DirEntry {
  name: string;
  type: FileType;
}

export interface FileSystem {
  readFile(p: string): Promise<Uint8Array>;
  /** Write a file, replacing it if it exists. Parent directories must exist. */
  writeFile(p: string, data: Uint8Array): Promise<void>;
  /** Recursive mkdir; no error if it already exists. */
  mkdir(p: string): Promise<void>;
  /** Remove a file; no error if it doesn't exist. */
  remove(p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** lstat semantics (symlinks are not followed). Undefined if missing. */
  stat(p: string): Promise<FileStat | undefined>;
  readdir(p: string): Promise<DirEntry[]>;
  realpath(p: string): Promise<string>;
}

function direntType(d: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileType {
  if (d.isFile()) { return 'file'; }
  if (d.isDirectory()) { return 'directory'; }
  if (d.isSymbolicLink()) { return 'symlink'; }
  return 'other';
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The real filesystem, via node:fs/promises. */
export class NodeFileSystem implements FileSystem {
  async readFile(p: string): Promise<Uint8Array> {
    return nodeFs.readFile(p);
  }
  async writeFile(p: string, data: Uint8Array): Promise<void> {
    await nodeFs.writeFile(p, data);
  }
  async mkdir(p: string): Promise<void> {
    await nodeFs.mkdir(p, { recursive: true });
  }
  async remove(p: string): Promise<void> {
    try {
      await nodeFs.unlink(p);
    } catch (err) {
      if (!isMissing(err)) { throw err; }
    }
  }
  async rename(from: string, to: string): Promise<void> {
    await nodeFs.rename(from, to);
  }
  async stat(p: string): Promise<FileStat | undefined> {
    try {
      const s = await nodeFs.lstat(p);
      return { type: direntType(s), size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
    } catch (err) {
      if (isMissing(err)) { return undefined; }
      throw err;
    }
  }
  async readdir(p: string): Promise<DirEntry[]> {
    const entries = await nodeFs.readdir(p, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, type: direntType(e) }));
  }
  async realpath(p: string): Promise<string> {
    return nodeFs.realpath(p);
  }
}

export const nodeFileSystem: FileSystem = new NodeFileSystem();

type MemNode =
  | { type: 'file'; data: Uint8Array; mtimeMs: number; ctimeMs: number }
  | { type: 'directory'; mtimeMs: number }
  | { type: 'symlink'; target: string; mtimeMs: number };

function enoent(p: string): Error {
  const err = new Error(`ENOENT: no such file or directory, '${p}'`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

/**
 * In-memory POSIX filesystem for tests and for hosts that want a sandbox.
 * mtimes come from a monotonically increasing logical clock so every write is
 * observable through `stat`.
 */
export class MemoryFileSystem implements FileSystem {
  private nodes = new Map<string, MemNode>([['/', { type: 'directory', mtimeMs: 0 }]]);
  private clock = 1_000_000;

  private tick(): number {
    return ++this.clock;
  }

  private norm(p: string): string {
    if (!path.posix.isAbsolute(p)) { throw new Error(`MemoryFileSystem needs absolute paths: ${p}`); }
    return path.posix.normalize(p).replace(/(.)\/$/, '$1');
  }

  /** Resolve symlinks in all components of `p` except (optionally) the last. */
  private resolve(p: string, followLast: boolean, depth = 0): string {
    if (depth > 40) { throw new Error(`ELOOP: ${p}`); }
    const parts = this.norm(p).split('/').filter(Boolean);
    let cur = '/';
    for (let i = 0; i < parts.length; i++) {
      const next = cur === '/' ? `/${parts[i]}` : `${cur}/${parts[i]}`;
      const node = this.nodes.get(next);
      const isLast = i === parts.length - 1;
      if (node?.type === 'symlink' && (!isLast || followLast)) {
        const target = path.posix.isAbsolute(node.target) ? node.target : path.posix.join(cur, node.target);
        const rest = parts.slice(i + 1).join('/');
        return this.resolve(rest ? `${target}/${rest}` : target, followLast, depth + 1);
      }
      cur = next;
    }
    return cur;
  }

  private parentDir(p: string): MemNode | undefined {
    return this.nodes.get(path.posix.dirname(p));
  }

  async readFile(p: string): Promise<Uint8Array> {
    const r = this.resolve(p, true);
    const node = this.nodes.get(r);
    if (node?.type !== 'file') { throw enoent(p); }
    return node.data.slice();
  }

  async writeFile(p: string, data: Uint8Array): Promise<void> {
    this.writeFileSync(p, data);
  }

  writeFileSync(p: string, data: Uint8Array | string): void {
    const r = this.resolve(p, true);
    if (this.parentDir(r)?.type !== 'directory') { throw enoent(p); }
    const existing = this.nodes.get(r);
    if (existing && existing.type !== 'file') { throw new Error(`EISDIR: ${p}`); }
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data.slice();
    const t = this.tick();
    this.nodes.set(r, { type: 'file', data: bytes, mtimeMs: t, ctimeMs: t });
  }

  async mkdir(p: string): Promise<void> {
    this.mkdirSync(p);
  }

  mkdirSync(p: string): void {
    const parts = this.norm(p).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur = this.resolve(`${cur}/${part}`, true);
      const node = this.nodes.get(cur);
      if (!node) { this.nodes.set(cur, { type: 'directory', mtimeMs: this.tick() }); }
      else if (node.type !== 'directory') { throw new Error(`EEXIST: ${cur}`); }
    }
  }

  async remove(p: string): Promise<void> {
    const r = this.resolve(p, false);
    const node = this.nodes.get(r);
    if (!node) { return; }
    if (node.type === 'directory') { throw new Error(`EISDIR: ${p}`); }
    this.nodes.delete(r);
  }

  /** Remove a file or a whole directory tree. */
  removeTree(p: string): void {
    const r = this.resolve(p, false);
    for (const key of [...this.nodes.keys()]) { if (key === r || key.startsWith(`${r}/`)) { this.nodes.delete(key); } }
  }

  async rename(from: string, to: string): Promise<void> {
    const a = this.resolve(from, false);
    const b = this.resolve(to, false);
    if (!this.nodes.has(a)) { throw enoent(from); }
    if (this.parentDir(b)?.type !== 'directory') { throw enoent(to); }
    const moved: [string, MemNode][] = [];
    for (const [key, node] of this.nodes) {
      if (key === a || key.startsWith(`${a}/`)) { moved.push([key, node]); }
    }
    for (const [key] of moved) { this.nodes.delete(key); }
    for (const [key, node] of moved) { this.nodes.set(b + key.slice(a.length), node); }
  }

  async stat(p: string): Promise<FileStat | undefined> {
    let r: string;
    try {
      r = this.resolve(p, false);
    } catch {
      return undefined;
    }
    const node = this.nodes.get(r);
    if (!node) { return undefined; }
    if (node.type === 'file') { return { type: 'file', size: node.data.length, mtimeMs: node.mtimeMs, ctimeMs: node.ctimeMs }; }
    return { type: node.type, size: 0, mtimeMs: node.mtimeMs, ctimeMs: node.mtimeMs };
  }

  async readdir(p: string): Promise<DirEntry[]> {
    const r = this.resolve(p, true);
    if (this.nodes.get(r)?.type !== 'directory') { throw enoent(p); }
    const prefix = r === '/' ? '/' : `${r}/`;
    const out: DirEntry[] = [];
    for (const [key, node] of this.nodes) {
      if (key !== r && key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
        out.push({ name: key.slice(prefix.length), type: node.type });
      }
    }
    return out.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  }

  async realpath(p: string): Promise<string> {
    const r = this.resolve(p, true);
    if (!this.nodes.has(r)) { throw enoent(p); }
    return r;
  }

  /** Create a symlink at `p` pointing to `target`. */
  symlinkSync(target: string, p: string): void {
    const r = this.resolve(p, false);
    if (this.parentDir(r)?.type !== 'directory') { throw enoent(p); }
    this.nodes.set(r, { type: 'symlink', target, mtimeMs: this.tick() });
  }

  existsSync(p: string): boolean {
    try {
      return this.nodes.has(this.resolve(p, false));
    } catch {
      return false;
    }
  }

  readTextSync(p: string): string | undefined {
    const node = this.nodes.get(this.resolve(p, true));
    return node?.type === 'file' ? new TextDecoder().decode(node.data) : undefined;
  }

  /** All file paths under `root` (symlinks not followed). */
  listFilesSync(root: string): string[] {
    const r = this.resolve(root, true);
    const prefix = r === '/' ? '/' : `${r}/`;
    return [...this.nodes.entries()]
      .filter(([key, node]) => node.type === 'file' && key.startsWith(prefix))
      .map(([key]) => key)
      .sort();
  }
}
