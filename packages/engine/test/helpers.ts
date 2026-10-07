import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryFileSystem, ReviewEngine, type ReviewEngineOptions } from '../src/index.js';

export const ROOT = '/ws';
export const STORE = '/store';

/** In-memory workspace at /ws with the given files. */
export function memWorkspace(files: Record<string, string | Uint8Array> = {}): MemWorkspace {
  const fs = new MemoryFileSystem();
  fs.mkdirSync(ROOT);
  const ws = new MemWorkspace(fs);
  for (const [rel, content] of Object.entries(files)) ws.write(rel, content);
  return ws;
}

export class MemWorkspace {
  constructor(readonly fs: MemoryFileSystem) {}

  abs(rel: string): string {
    return path.posix.join(ROOT, rel);
  }
  write(rel: string, content: string | Uint8Array): string {
    const abs = this.abs(rel);
    this.fs.mkdirSync(path.posix.dirname(abs));
    this.fs.writeFileSync(abs, content);
    return abs;
  }
  read(rel: string): string | undefined {
    return this.fs.readTextSync(this.abs(rel));
  }
  remove(rel: string): string {
    const abs = this.abs(rel);
    this.fs.removeTree(abs);
    return abs;
  }
  rename(from: string, to: string): string[] {
    const a = this.abs(from);
    const b = this.abs(to);
    this.fs.mkdirSync(path.posix.dirname(b));
    void this.fs.rename(a, b);
    return [a, b];
  }
  exists(rel: string): boolean {
    return this.fs.existsSync(this.abs(rel));
  }
  /** rel -> content for every file under the root (no ignore filtering). */
  files(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const abs of this.fs.listFilesSync(ROOT)) out[path.posix.relative(ROOT, abs)] = this.fs.readTextSync(abs)!;
    return out;
  }
  open(opts: Partial<ReviewEngineOptions> = {}): Promise<ReviewEngine> {
    return ReviewEngine.open({ root: ROOT, storageDir: STORE, fs: this.fs, git: false, ...opts });
  }
}

/** rel -> content of the engine's baseline. */
export async function baselineFiles(engine: ReviewEngine): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of [...engine.baselineEntries().keys()].sort()) {
    out[rel] = new TextDecoder().decode((await engine.getBaselineContent(rel))!);
  }
  return out;
}

export function sorted<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as T;
}

// ------------------------------------------------------------- real disk + git

export function tmpDir(prefix = 'engine-test-'): string {
  return nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function rmrf(p: string): void {
  nodeFs.rmSync(p, { recursive: true, force: true });
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function gitWithInput(cwd: string, input: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}

export function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export class DiskWorkspace {
  constructor(
    readonly root: string,
    readonly storage: string,
  ) {}

  static create(files: Record<string, string> = {}): DiskWorkspace {
    const base = tmpDir();
    const root = path.join(base, 'ws');
    nodeFs.mkdirSync(root);
    const ws = new DiskWorkspace(root, path.join(base, 'storage'));
    for (const [rel, content] of Object.entries(files)) ws.write(rel, content);
    return ws;
  }
  abs(rel: string): string {
    return path.join(this.root, rel);
  }
  write(rel: string, content: string | Uint8Array): string {
    const abs = this.abs(rel);
    nodeFs.mkdirSync(path.dirname(abs), { recursive: true });
    nodeFs.writeFileSync(abs, content);
    return abs;
  }
  read(rel: string): string | undefined {
    try {
      return nodeFs.readFileSync(this.abs(rel), 'utf8');
    } catch {
      return undefined;
    }
  }
  remove(rel: string): string {
    const abs = this.abs(rel);
    nodeFs.rmSync(abs, { recursive: true, force: true });
    return abs;
  }
  git(...args: string[]): string {
    return git(this.root, ...args);
  }
  open(opts: Partial<ReviewEngineOptions> = {}): Promise<ReviewEngine> {
    return ReviewEngine.open({ root: this.root, storageDir: this.storage, ...opts });
  }
  dispose(): void {
    rmrf(path.dirname(this.root));
  }
}
