/**
 * Content-addressed blob store laid out as a bare git repository.
 *
 * Blobs are written as standard git loose objects (`objects/ab/cdef...`,
 * zlib-deflated `blob <len>\0<bytes>`, SHA-1 named), so the shadow store can
 * be inspected with ordinary git tooling (`git --git-dir=... cat-file -p <oid>`)
 * but is never connected to the user's repository.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import type { FileSystem } from '../fs.js';

export type HashAlgorithm = 'sha1' | 'sha256';

/** Git blob id of `data` (what `git hash-object` prints). */
export function gitBlobId(data: Uint8Array, algorithm: HashAlgorithm = 'sha1'): string {
  const h = createHash(algorithm);
  h.update(`blob ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

export class ObjectStore {
  private known = new Set<string>();
  private tmpCounter = 0;

  constructor(
    private readonly fs: FileSystem,
    /** The shadow repository's GIT_DIR. */
    readonly gitDir: string,
  ) {}

  async init(): Promise<void> {
    const { fs, gitDir } = this;
    await fs.mkdir(path.join(gitDir, 'objects'));
    await fs.mkdir(path.join(gitDir, 'refs', 'heads'));
    await fs.mkdir(path.join(gitDir, 'refs', 'tags'));
    if (!(await fs.stat(path.join(gitDir, 'HEAD')))) {
      const enc = new TextEncoder();
      await fs.writeFile(path.join(gitDir, 'HEAD'), enc.encode('ref: refs/heads/baseline\n'));
      await fs.writeFile(
        path.join(gitDir, 'config'),
        enc.encode('[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n'),
      );
      await fs.writeFile(
        path.join(gitDir, 'description'),
        enc.encode('Accepted-baseline store for the review engine. Not a user repository.\n'),
      );
    }
  }

  private objectPath(oid: string): string {
    return path.join(this.gitDir, 'objects', oid.slice(0, 2), oid.slice(2));
  }

  async has(oid: string): Promise<boolean> {
    if (this.known.has(oid)) { return true; }
    const exists = (await this.fs.stat(this.objectPath(oid)))?.type === 'file';
    if (exists) { this.known.add(oid); }
    return exists;
  }

  /** Store `data` and return its blob id. Idempotent. */
  async write(data: Uint8Array, oid = gitBlobId(data)): Promise<string> {
    if (await this.has(oid)) { return oid; }
    const header = new TextEncoder().encode(`blob ${data.length}\0`);
    const raw = new Uint8Array(header.length + data.length);
    raw.set(header, 0);
    raw.set(data, header.length);
    const compressed = deflateSync(raw, { level: 1 });
    const file = this.objectPath(oid);
    const dir = path.dirname(file);
    await this.fs.mkdir(dir);
    // Write to a temp name, then rename, so a crash never leaves a truncated object.
    const tmp = path.join(dir, `.tmp-${process.pid}-${++this.tmpCounter}`);
    await this.fs.writeFile(tmp, compressed);
    await this.fs.rename(tmp, file);
    this.known.add(oid);
    return oid;
  }

  async read(oid: string): Promise<Uint8Array> {
    const compressed = await this.fs.readFile(this.objectPath(oid));
    const raw = inflateSync(compressed);
    const nul = raw.indexOf(0);
    const header = new TextDecoder().decode(raw.subarray(0, nul));
    const match = /^blob (\d+)$/.exec(header);
    if (!match || Number(match[1]) !== raw.length - nul - 1) {
      throw new Error(`Corrupt object ${oid} in ${this.gitDir}`);
    }
    return new Uint8Array(raw.buffer, raw.byteOffset + nul + 1, raw.length - nul - 1);
  }
}
