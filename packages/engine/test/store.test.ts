import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryFileSystem, nodeFileSystem } from '../src/fs.js';
import { gitBlobId, ObjectStore } from '../src/store/objectStore.js';
import { git, gitWithInput, hasGit, rmrf, tmpDir } from './helpers.js';

const enc = new TextEncoder();

describe('ObjectStore', () => {
  it('round-trips content and is idempotent', async () => {
    const fs = new MemoryFileSystem();
    const store = new ObjectStore(fs, '/s/baseline.git');
    await store.init();
    const data = enc.encode('hello\nworld\n');
    const oid = await store.write(data);
    expect(await store.write(data)).toBe(oid);
    expect(new TextDecoder().decode(await store.read(oid))).toBe('hello\nworld\n');
    expect(await store.has(oid)).toBe(true);
    expect(await store.has('0'.repeat(40))).toBe(false);
  });

  it('handles empty and binary blobs', async () => {
    const fs = new MemoryFileSystem();
    const store = new ObjectStore(fs, '/s/b.git');
    await store.init();
    const bin = new Uint8Array([0, 1, 2, 255, 0]);
    expect(Array.from(await store.read(await store.write(bin)))).toEqual([0, 1, 2, 255, 0]);
    expect((await store.read(await store.write(new Uint8Array()))).length).toBe(0);
  });

  it('uses the empty-blob id git uses', () => {
    expect(gitBlobId(new Uint8Array())).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });
});

describe.runIf(hasGit())('ObjectStore is a real git object database', () => {
  const dir = tmpDir();
  afterAll(() => rmrf(dir));

  it('produces the same ids as git hash-object and is readable by git cat-file', async () => {
    const store = new ObjectStore(nodeFileSystem, path.join(dir, 'baseline.git'));
    await store.init();
    const text = 'line one\nline two\n';
    const oid = await store.write(enc.encode(text));
    expect(oid).toBe(gitWithInput(dir, text, 'hash-object', '--stdin').trim());
    expect(git(dir, '--git-dir', path.join(dir, 'baseline.git'), 'cat-file', '-p', oid)).toBe(text);
    expect(git(dir, '--git-dir', path.join(dir, 'baseline.git'), 'cat-file', '-t', oid).trim()).toBe('blob');
  });
});
