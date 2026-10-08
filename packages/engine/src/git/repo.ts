/**
 * Read-only access to the *user's* git repository. Nothing here writes to it:
 * HEAD, refs, packed-refs and the index are parsed directly from disk, and
 * blob contents (only needed for partial staging) are read with
 * `git cat-file` under GIT_OPTIONAL_LOCKS=0.
 */
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import type { FileSystem } from '../fs.js';
import type { HashAlgorithm } from '../store/objectStore.js';

export interface GitRepoInfo {
  /** Per-worktree git dir (holds HEAD and index). */
  gitDir: string;
  /** Shared git dir (holds refs, packed-refs, objects, config). Same as gitDir outside linked worktrees. */
  commonDir: string;
  /** Top of the working tree. */
  workTree: string;
  /** Workspace root relative to workTree (posix, '' if they're the same). */
  prefix: string;
  objectFormat: HashAlgorithm;
}

const dec = new TextDecoder();

async function readText(fs: FileSystem, p: string): Promise<string | undefined> {
  const st = await fs.stat(p);
  if (st?.type !== 'file') { return undefined; }
  return dec.decode(await fs.readFile(p));
}

/** Find the repository enclosing `root` (a real path), walking up. */
export async function findGitRepo(fs: FileSystem, root: string): Promise<GitRepoInfo | undefined> {
  let dir = root;
  for (;;) {
    const dotGit = path.join(dir, '.git');
    const st = await fs.stat(dotGit);
    let gitDir: string | undefined;
    if (st?.type === 'directory') { gitDir = dotGit; }
    else if (st?.type === 'file') {
      const text = (await readText(fs, dotGit)) ?? '';
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (m) { gitDir = path.resolve(dir, m[1]!); }
    }
    if (gitDir && (await fs.stat(path.join(gitDir, 'HEAD')))) {
      const commonRel = (await readText(fs, path.join(gitDir, 'commondir')))?.trim();
      const commonDir = commonRel ? path.resolve(gitDir, commonRel) : gitDir;
      const config = (await readText(fs, path.join(commonDir, 'config'))) ?? '';
      const objectFormat: HashAlgorithm = /^\s*objectformat\s*=\s*sha256\s*$/im.test(config) ? 'sha256' : 'sha1';
      const prefix = path.relative(dir, root).split(path.sep).join('/');
      return { gitDir, commonDir, workTree: dir, prefix, objectFormat };
    }
    const parent = path.dirname(dir);
    if (parent === dir) { return undefined; }
    dir = parent;
  }
}

export interface HeadState {
  /** Raw HEAD: `ref: refs/heads/main` or a detached oid. */
  head: string;
  /** Commit HEAD resolves to, or null on an unborn branch. */
  oid: string | null;
  /** refs/stash, which `git stash` / `git stash pop` move without moving HEAD. */
  stash: string | null;
}

async function resolveRef(fs: FileSystem, repo: GitRepoInfo, ref: string, depth = 0): Promise<string | null> {
  if (depth > 10) { return null; }
  // Per-worktree refs live in gitDir; shared refs in commonDir.
  for (const base of [repo.gitDir, repo.commonDir]) {
    const text = (await readText(fs, path.join(base, ...ref.split('/'))))?.trim();
    if (text === undefined) { continue; }
    if (text.startsWith('ref:')) { return resolveRef(fs, repo, text.slice(4).trim(), depth + 1); }
    return text || null;
  }
  const packed = await readText(fs, path.join(repo.commonDir, 'packed-refs'));
  if (packed) {
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) { continue; }
      const sp = line.indexOf(' ');
      if (sp > 0 && line.slice(sp + 1).trim() === ref) { return line.slice(0, sp); }
    }
  }
  return null;
}

export async function readHeadState(fs: FileSystem, repo: GitRepoInfo): Promise<HeadState> {
  const head = ((await readText(fs, path.join(repo.gitDir, 'HEAD'))) ?? '').trim();
  const oid = head.startsWith('ref:') ? await resolveRef(fs, repo, head.slice(4).trim()) : head || null;
  const stash = await resolveRef(fs, repo, 'refs/stash');
  return { head, oid, stash };
}

export function headStatesEqual(a: HeadState, b: HeadState): boolean {
  return a.head === b.head && a.oid === b.oid && a.stash === b.stash;
}

/** True while git holds the index lock (an operation is mid-flight). */
export async function isGitBusy(fs: FileSystem, repo: GitRepoInfo): Promise<boolean> {
  return (await fs.stat(path.join(repo.gitDir, 'index.lock'))) !== undefined;
}

export interface IndexStat {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export async function statIndex(fs: FileSystem, repo: GitRepoInfo): Promise<IndexStat | null> {
  const st = await fs.stat(path.join(repo.gitDir, 'index'));
  return st?.type === 'file' ? { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs } : null;
}

/**
 * Parse a git index file (versions 2, 3 and 4) into path -> blob id for
 * stage-0 entries. Conflicted paths (stages 1-3) map to "conflict:<stage-2 or
 * first oid>" so they compare unequal to any blob id.
 */
export function parseIndex(data: Uint8Array, objectFormat: HashAlgorithm = 'sha1'): Map<string, string> {
  const entries = new Map<string, string>();
  if (data.length < 12) { return entries; }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sig = dec.decode(data.subarray(0, 4));
  if (sig !== 'DIRC') { throw new Error('Not a git index file'); }
  const version = view.getUint32(4);
  if (version < 2 || version > 4) { throw new Error(`Unsupported git index version ${version}`); }
  const count = view.getUint32(8);
  const oidLen = objectFormat === 'sha256' ? 32 : 20;
  let pos = 12;
  let prevPath: Uint8Array = new Uint8Array(0);
  const conflicts = new Map<string, string>();

  for (let n = 0; n < count; n++) {
    const entryStart = pos;
    pos += 40; // ctime, mtime, dev, ino, mode, uid, gid, size
    const oidBytes = data.subarray(pos, pos + oidLen);
    pos += oidLen;
    const flags = view.getUint16(pos);
    pos += 2;
    const stage = (flags >> 12) & 0x3;
    const extended = (flags & 0x4000) !== 0;
    if (version >= 3 && extended) { pos += 2; }

    let pathBytes: Uint8Array;
    if (version === 4) {
      // Varint: number of bytes to strip from the previous path.
      let byte = data[pos++]!;
      let strip = byte & 0x7f;
      while (byte & 0x80) {
        byte = data[pos++]!;
        strip = ((strip + 1) << 7) | (byte & 0x7f);
      }
      const end = data.indexOf(0, pos);
      const suffix = data.subarray(pos, end);
      const keep = prevPath.subarray(0, prevPath.length - strip);
      pathBytes = new Uint8Array(keep.length + suffix.length);
      pathBytes.set(keep, 0);
      pathBytes.set(suffix, keep.length);
      pos = end + 1;
    } else {
      const end = data.indexOf(0, pos);
      pathBytes = data.subarray(pos, end);
      // Entries are NUL-padded to a multiple of 8 bytes.
      const len = end - entryStart + 1;
      pos = entryStart + Math.ceil(len / 8) * 8;
    }
    prevPath = pathBytes;
    const p = dec.decode(pathBytes);
    const oid = Buffer.from(oidBytes).toString('hex');
    if (stage === 0) { entries.set(p, oid); }
    else if (stage === 2 || !conflicts.has(p)) { conflicts.set(p, oid); }
  }
  for (const [p, oid] of conflicts) { if (!entries.has(p)) { entries.set(p, `conflict:${oid}`); } }
  return entries;
}

export async function readIndex(fs: FileSystem, repo: GitRepoInfo): Promise<Map<string, string>> {
  const file = path.join(repo.gitDir, 'index');
  const st = await fs.stat(file);
  if (st?.type !== 'file') { return new Map(); }
  return parseIndex(await fs.readFile(file), repo.objectFormat);
}

/** Reads objects from the user's repository. Injectable for tests and non-Node hosts. */
export interface GitObjectReader {
  readBlob(repo: GitRepoInfo, oid: string): Promise<Uint8Array | undefined>;
  /**
   * Repo-relative paths that differ between two commits' trees (both sides of a rename; null: no commit, i.e. an
   * unborn branch). Undefined if git could not tell.
   */
  changedPaths(repo: GitRepoInfo, from: string | null, to: string | null): Promise<string[] | undefined>;
}

const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function runGit(repo: GitRepoInfo, args: string[]): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--git-dir', repo.gitDir, ...args],
      {
        encoding: 'buffer',
        maxBuffer: 512 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        windowsHide: true,
      },
      (err, stdout) => resolve(err ? undefined : stdout),
    );
  });
}

/** Paths in `git diff-tree -z --name-status` output: one per entry, two for renames and copies. */
export function parseNameStatus(out: string): string[] {
  const fields = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]!;
    if (!status) { continue; }
    const n = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    for (let k = 0; k < n && i < fields.length; k++) { paths.push(fields[i++]!); }
  }
  return paths;
}

/** Default reader: `git cat-file` / `git diff-tree` / `git ls-tree`, read-only, no optional locks. */
export const gitCliObjectReader: GitObjectReader = {
  async readBlob(repo, oid) {
    if (!OID_RE.test(oid)) { return undefined; }
    const out = await runGit(repo, ['cat-file', 'blob', oid]);
    return out ? new Uint8Array(out) : undefined;
  },
  async changedPaths(repo, from, to) {
    if (from === to) { return []; }
    if ((from && !OID_RE.test(from)) || (to && !OID_RE.test(to))) { return undefined; }
    if (from && to) {
      const out = await runGit(repo, ['diff-tree', '-r', '-M', '--name-status', '-z', from, to]);
      return out ? parseNameStatus(out.toString('utf8')) : undefined;
    }
    // One side is an unborn branch: every file of the other commit.
    const out = await runGit(repo, ['ls-tree', '-r', '--name-only', '-z', (from ?? to)!]);
    return out ? out.toString('utf8').split('\0').filter(Boolean) : undefined;
  },
};
