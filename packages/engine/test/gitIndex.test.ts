import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeFileSystem } from '../src/fs.js';
import { findGitRepo, gitCliObjectReader, parseIndex, parseNameStatus, readHeadState } from '../src/git/repo.js';
import { git, hasGit, rmrf, tmpDir } from './helpers.js';

function lsFiles(cwd: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of git(cwd, 'ls-files', '-s').split('\n')) {
    if (!line) { continue; }
    const [meta, p] = line.split('\t') as [string, string];
    const [, oid, stage] = meta.split(' ');
    if (stage === '0') { out.set(p, oid!); }
  }
  return out;
}

describe.runIf(hasGit())('git index parser', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
    git(dir, 'init', '-q');
    for (const p of ['a.txt', 'dir/b.txt', 'dir/sub/c.tex', 'dir/sub/deeper/very-long-file-name-to-test-padding.md', 'z.txt']) {
      nodeFs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      nodeFs.writeFileSync(path.join(dir, p), `content of ${p}\n`);
    }
    git(dir, 'add', '.');
  });
  afterEach(() => rmrf(dir));

  const read = () => parseIndex(nodeFs.readFileSync(path.join(dir, '.git', 'index')));

  it('parses version 2', () => {
    git(dir, 'update-index', '--index-version', '2');
    expect(read()).toEqual(lsFiles(dir));
  });

  it('parses version 3 (extended flags from intent-to-add)', () => {
    nodeFs.writeFileSync(path.join(dir, 'new.txt'), 'x\n');
    git(dir, 'add', '-N', 'new.txt');
    git(dir, 'update-index', '--index-version', '3');
    const parsed = read();
    expect(parsed.get('a.txt')).toBe(lsFiles(dir).get('a.txt'));
    expect(parsed.has('new.txt')).toBe(true);
    expect(parsed.size).toBe(6);
  });

  it('parses version 4 (prefix-compressed paths)', () => {
    git(dir, 'update-index', '--index-version', '4');
    expect(read()).toEqual(lsFiles(dir));
  });

  it('marks conflicted paths', () => {
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'other');
    nodeFs.writeFileSync(path.join(dir, 'a.txt'), 'other\n');
    git(dir, 'commit', '-qam', 'other');
    git(dir, 'checkout', '-q', 'main');
    nodeFs.writeFileSync(path.join(dir, 'a.txt'), 'main\n');
    git(dir, 'commit', '-qam', 'main');
    try {
      git(dir, 'merge', 'other');
    } catch {
      // expected conflict
    }
    expect(read().get('a.txt')).toMatch(/^conflict:/);
  });

  it('finds the repository and resolves HEAD (loose and packed refs)', async () => {
    const sub = path.join(dir, 'dir');
    const repo = (await findGitRepo(nodeFileSystem, sub))!;
    expect(repo.workTree).toBe(dir);
    expect(repo.prefix).toBe('dir');
    expect((await readHeadState(nodeFileSystem, repo)).oid).toBeNull(); // unborn
    git(dir, 'commit', '-qm', 'c1');
    const oid = git(dir, 'rev-parse', 'HEAD').trim();
    expect((await readHeadState(nodeFileSystem, repo)).oid).toBe(oid);
    git(dir, 'pack-refs', '--all');
    expect((await readHeadState(nodeFileSystem, repo)).oid).toBe(oid);
    git(dir, 'checkout', '-q', '--detach');
    expect((await readHeadState(nodeFileSystem, repo)).head).toBe(oid);
  });

  it('follows .git files to linked worktrees', async () => {
    git(dir, 'commit', '-qm', 'c1');
    const wt = path.join(dir, '..', `${path.basename(dir)}-wt`);
    git(dir, 'worktree', 'add', '-q', wt);
    try {
      const repo = (await findGitRepo(nodeFileSystem, wt))!;
      expect(repo.workTree).toBe(wt);
      expect(repo.commonDir).toBe(path.join(dir, '.git'));
      expect((await readHeadState(nodeFileSystem, repo)).oid).toBe(git(wt, 'rev-parse', 'HEAD').trim());
    } finally {
      rmrf(wt);
    }
  });
});

describe('git diff-tree name-status parser', () => {
  it('lists one path per entry and both paths of renames and copies', () => {
    expect(parseNameStatus('M\0a.txt\0R100\0old.txt\0new.txt\0D\0gone.txt\0C075\0src.txt\0copy.txt\0A\0dir/new file.txt\0'))
      .toEqual(['a.txt', 'old.txt', 'new.txt', 'gone.txt', 'src.txt', 'copy.txt', 'dir/new file.txt']);
    expect(parseNameStatus('')).toEqual([]);
  });
});

describe.runIf(hasGit())('changed paths between HEADs (the HEAD-move rule)', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
    git(dir, 'init', '-q');
  });
  afterEach(() => rmrf(dir));

  const write = (p: string, t: string) => {
    nodeFs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    nodeFs.writeFileSync(path.join(dir, p), t);
  };
  const head = () => git(dir, 'rev-parse', 'HEAD').trim();
  const changed = async (from: string | null, to: string | null) =>
    (await gitCliObjectReader.changedPaths((await findGitRepo(nodeFileSystem, dir))!, from, to))?.sort();

  it('modifications, renames, deletions; the first commit; same commit; unknown commit', async () => {
    write('a.txt', 'a\n');
    write('b.txt', 'b\nb\nb\nb\n');
    write('dir/c.txt', 'c\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'c1');
    const c1 = head();
    expect(await changed(null, c1)).toEqual(['a.txt', 'b.txt', 'dir/c.txt']);
    git(dir, 'mv', 'b.txt', 'moved.txt');
    git(dir, 'rm', '-q', 'dir/c.txt');
    write('a.txt', 'A\n');
    git(dir, 'commit', '-qam', 'c2');
    const c2 = head();
    expect(await changed(c1, c2)).toEqual(['a.txt', 'b.txt', 'dir/c.txt', 'moved.txt']);
    expect(await changed(c2, c1)).toEqual(['a.txt', 'b.txt', 'dir/c.txt', 'moved.txt']);
    expect(await changed(c2, c2)).toEqual([]);
    expect(await changed(c2, '0'.repeat(40))).toBeUndefined();
    expect(await changed(c2, '--output=x')).toBeUndefined();
  });
});
