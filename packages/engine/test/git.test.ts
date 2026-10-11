/**
 * Git-operation detection against real repositories (PLAN.md §5.1, §7):
 *  - index-only change (git add): accept pending hunks only in the staged files
 *  - a HEAD move (commit, checkout, reset, merge, rebase): accept, whole, only the files that differ between the old and
 *    the new HEAD tree (both sides of a rename, deletions); every other pending change stays pending (#12, Guru's
 *    decision of Oct 8 2026)
 *  - `git stash` / pop accept nothing
 *  - the engine never touches the user's index, HEAD, refs, or stash
 */
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitCliObjectReader, ReviewEngine } from '../src/index.js';
import { baselineFiles, DiskWorkspace, gitWithInput, hasGit } from './helpers.js';

describe.runIf(hasGit())('git operations', () => {
  let ws: DiskWorkspace;
  let engine: ReviewEngine;

  beforeEach(async () => {
    ws = DiskWorkspace.create({
      'a.txt': 'a1\na2\na3\na4\na5\na6\na7\n',
      'b.txt': 'b\n',
      'docs/c.md': 'c\n',
    });
    ws.git('init', '-q');
    ws.git('add', '.');
    ws.git('commit', '-qm', 'init');
    engine = await ws.open();
  });

  afterEach(async () => {
    await engine?.close().catch(() => undefined);
    ws.dispose();
  });

  const agentWrite = async (rel: string, content: string) => engine.handleFsEvents([ws.write(rel, content)]);
  const pendingPaths = () => engine.listChanges().map((c) => c.path);

  it('git add of one file accepts only that file', async () => {
    await agentWrite('a.txt', 'a1\nA2\na3\na4\na5\na6\na7\n');
    await agentWrite('b.txt', 'B\n');
    ws.git('add', 'a.txt');
    const r = await engine.checkGit();
    expect(r).toEqual({ kind: 'index', staged: ['a.txt'], accepted: ['a.txt'] });
    expect(pendingPaths()).toEqual(['b.txt']);
  });

  it('is detected on the next event batch without an explicit check', async () => {
    await agentWrite('a.txt', 'changed\n');
    ws.git('add', 'a.txt');
    await engine.handleFsEvents([path.join(ws.root, '.git', 'index')]);
    expect(pendingPaths()).toEqual([]);
  });

  it('partial staging accepts only the staged hunks (update-index)', async () => {
    await agentWrite('a.txt', 'a1\nA2\na3\na4\na5\nA6\na7\n');
    // Stage only the first hunk.
    const oid = gitWithInput(ws.root, 'a1\nA2\na3\na4\na5\na6\na7\n', 'hash-object', '-w', '--stdin').trim();
    ws.git('update-index', '--cacheinfo', `100644,${oid},a.txt`);
    await engine.checkGit();
    expect(await baselineFiles(engine)).toMatchObject({ 'a.txt': 'a1\nA2\na3\na4\na5\na6\na7\n' });
    const hunks = (await engine.getFileChange('a.txt'))!.hunks;
    expect(hunks.map((h) => [h.oldLines, h.newLines])).toEqual([[['a6\n'], ['A6\n']]]);
  });

  it('partial staging with git add -p', async () => {
    const lines = Array.from({ length: 14 }, (_, i) => `line${i}\n`);
    ws.write('long.txt', lines.join(''));
    ws.git('add', 'long.txt');
    ws.git('commit', '-qm', 'long');
    await engine.checkGit();
    const edited = [...lines];
    edited[1] = 'LINE1\n';
    edited[12] = 'LINE12\n';
    await agentWrite('long.txt', edited.join(''));
    gitWithInput(ws.root, 'n\ny\n', 'add', '-p', 'long.txt'); // skip the first hunk, stage the second
    await engine.checkGit();
    const hunks = (await engine.getFileChange('long.txt'))!.hunks;
    expect(hunks.map((h) => h.newLines)).toEqual([['LINE1\n']]);
  });

  it('staging a different version than disk accepts nothing', async () => {
    await agentWrite('b.txt', 'agent\n');
    const oid = gitWithInput(ws.root, 'something else\n', 'hash-object', '-w', '--stdin').trim();
    ws.git('update-index', '--cacheinfo', `100644,${oid},b.txt`);
    expect(await engine.checkGit()).toMatchObject({ kind: 'index', accepted: [] });
    expect(pendingPaths()).toEqual(['b.txt']);
  });

  it('git add of a created file and git rm of a deleted file accept them', async () => {
    await agentWrite('new.txt', 'new\n');
    await engine.handleFsEvents([ws.remove('docs/c.md')]);
    ws.git('add', 'new.txt');
    ws.git('rm', '-q', '--cached', 'docs/c.md');
    await engine.checkGit();
    expect(pendingPaths()).toEqual([]);
  });

  it('#12: a commit of another file leaves the pending changes in this file pending', async () => {
    await agentWrite('a.txt', 'a1\nagent\na3\na4\na5\na6\na7\n');
    await agentWrite('.gitignore', '*.log\n');
    ws.git('add', '.gitignore');
    ws.git('commit', '-qm', 'ignore logs'); // #12's repro: commit only .gitignore
    expect(await engine.checkGit()).toEqual({ kind: 'head', accepted: ['.gitignore'] });
    expect(pendingPaths()).toEqual(['a.txt']);
    expect(await baselineFiles(engine)).toMatchObject({ 'a.txt': 'a1\na2\na3\na4\na5\na6\na7\n' });
  });

  it('a commit accepts the files it changed, whole, and nothing else', async () => {
    await agentWrite('a.txt', 'a1\nA2\na3\na4\na5\nA6\na7\n');
    await agentWrite('b.txt', 'agent b\n');
    await agentWrite('docs/c.md', 'agent c\n');
    await agentWrite('untracked.txt', 'u\n');
    ws.git('commit', '-qm', 'agent commit', '--', 'a.txt', 'b.txt'); // what an agent running git itself does
    expect(await engine.checkGit()).toEqual({ kind: 'head', accepted: ['a.txt', 'b.txt'] });
    expect(pendingPaths()).toEqual(['docs/c.md', 'untracked.txt']);
    expect(await baselineFiles(engine)).toMatchObject({ 'a.txt': 'a1\nA2\na3\na4\na5\nA6\na7\n', 'b.txt': 'agent b\n', 'docs/c.md': 'c\n' });
    expect(await baselineFiles(engine)).not.toHaveProperty('untracked.txt');
  });

  it('a commit of part of a file accepts the whole file as it is on disk', async () => {
    await agentWrite('a.txt', 'a1\nA2\na3\na4\na5\nA6\na7\n');
    const oid = gitWithInput(ws.root, 'a1\nA2\na3\na4\na5\na6\na7\n', 'hash-object', '-w', '--stdin').trim();
    ws.git('update-index', '--cacheinfo', `100644,${oid},a.txt`);
    ws.git('commit', '-qm', 'first hunk only');
    expect(await engine.checkGit()).toEqual({ kind: 'head', accepted: ['a.txt'] });
    expect(pendingPaths()).toEqual([]);
  });

  it('#31 (by decision): a partial stage accepts the staged hunk; the commit then accepts the unstaged hunk too', async () => {
    await agentWrite('a.txt', 'a1\na2\nA3\na4\nA5\na6\na7\n');
    const oid = gitWithInput(ws.root, 'a1\na2\nA3\na4\na5\na6\na7\n', 'hash-object', '-w', '--stdin').trim();
    ws.git('update-index', '--cacheinfo', `100644,${oid},a.txt`); // stage line 3 only
    await engine.checkGit();
    expect((await engine.getFileChange('a.txt'))!.hunks.map((h) => h.newLines)).toEqual([['A5\n']]); // line 5 still pending
    ws.git('commit', '-qm', 'line 3 only');
    expect(await engine.checkGit()).toEqual({ kind: 'head', accepted: ['a.txt'] });
    expect(pendingPaths()).toEqual([]); // Keep File: the uncommitted line 5 too
    expect(await baselineFiles(engine)).toMatchObject({ 'a.txt': 'a1\na2\nA3\na4\nA5\na6\na7\n' });
    expect(ws.git('diff', '--', 'a.txt')).toContain('+A5'); // while git still shows it as unstaged
  });

  it('a commit with a rename accepts both paths', async () => {
    await engine.handleFsEvents([ws.remove('b.txt'), ws.write('renamed.txt', 'b\n')]);
    await agentWrite('a.txt', 'agent\n');
    expect(pendingPaths()).toEqual(['a.txt', 'renamed.txt']); // the engine's rename (b.txt -> renamed.txt)
    ws.git('add', '-A', 'b.txt', 'renamed.txt');
    ws.git('commit', '-qm', 'rename', '--', 'b.txt', 'renamed.txt');
    expect(ws.git('show', '--name-status', '-M', '--format=', 'HEAD').trim()).toBe('R100\tb.txt\trenamed.txt');
    expect((await engine.checkGit()).kind).toBe('head');
    expect(pendingPaths()).toEqual(['a.txt']);
    expect(await baselineFiles(engine)).toMatchObject({ 'renamed.txt': 'b\n' });
    expect(await baselineFiles(engine)).not.toHaveProperty('b.txt');
  });

  it('a commit with a deletion accepts the deletion', async () => {
    await engine.handleFsEvents([ws.remove('docs/c.md')]);
    await agentWrite('b.txt', 'agent\n');
    ws.git('rm', '-q', '--cached', 'docs/c.md');
    ws.git('commit', '-qm', 'delete c');
    expect(await engine.checkGit()).toEqual({ kind: 'head', accepted: ['docs/c.md'] });
    expect(pendingPaths()).toEqual(['b.txt']);
    expect(await baselineFiles(engine)).not.toHaveProperty('docs/c.md');
  });

  it('a commit plus a git add of another file in the same batch: the staged file is accepted as staging', async () => {
    await agentWrite('a.txt', 'agent a\n');
    await agentWrite('b.txt', 'agent b\n');
    await agentWrite('docs/c.md', 'agent c\n');
    ws.git('commit', '-qm', 'a', '--', 'a.txt');
    ws.git('add', 'b.txt');
    expect(await engine.checkGit()).toEqual({ kind: 'head', accepted: ['a.txt', 'b.txt'] });
    expect(pendingPaths()).toEqual(['docs/c.md']);
  });

  it('if git cannot tell what a HEAD move changed, every pending change is accepted (the rule before #12)', async () => {
    await engine.close();
    engine = await ws.open({ gitObjectReader: { ...gitCliObjectReader, changedPaths: () => Promise.resolve(undefined) } });
    await agentWrite('a.txt', 'agent\n');
    await agentWrite('b.txt', 'agent b\n');
    ws.git('commit', '-qm', 'a', '--', 'a.txt');
    expect(await engine.checkGit()).toEqual({ kind: 'head', accepted: ['a.txt', 'b.txt'] });
  });

  it('checkout of another branch accepts the files that differ between the branches; the rest stays pending', async () => {
    ws.git('checkout', '-qb', 'feature');
    ws.write('a.txt', 'feature version\n');
    ws.write('feature-only.txt', 'f\n');
    ws.git('add', '.');
    ws.git('commit', '-qm', 'feature');
    ws.git('checkout', '-q', 'main');
    await engine.handleFsEvents([ws.abs('a.txt'), ws.abs('feature-only.txt')]);
    expect(pendingPaths()).toEqual([]);
    await agentWrite('b.txt', 'pending across checkout\n');
    ws.git('checkout', '-q', 'feature'); // b.txt is the same on both branches: git carries the change over
    expect(await engine.checkGit()).toEqual({ kind: 'head', accepted: ['a.txt', 'feature-only.txt'] });
    await engine.handleFsEvents([ws.abs('a.txt'), ws.abs('feature-only.txt')]);
    expect(pendingPaths()).toEqual(['b.txt']);
    expect(await baselineFiles(engine)).toMatchObject({ 'a.txt': 'feature version\n', 'feature-only.txt': 'f\n', 'b.txt': 'b\n' });
    ws.git('checkout', '-q', 'main');
    await engine.checkGit();
    expect(pendingPaths()).toEqual(['b.txt']);
    expect(await baselineFiles(engine)).toMatchObject({ 'a.txt': 'a1\na2\na3\na4\na5\na6\na7\n', 'b.txt': 'b\n' });
    expect(await baselineFiles(engine)).not.toHaveProperty('feature-only.txt');
  });

  it('checkout of another branch does not flood review', async () => {
    ws.git('checkout', '-qb', 'feature');
    ws.write('a.txt', 'feature version\n');
    ws.write('feature-only.txt', 'f\n');
    ws.git('add', '.');
    ws.git('commit', '-qm', 'feature');
    ws.git('checkout', '-q', 'main');
    await engine.handleFsEvents([ws.abs('a.txt'), ws.abs('feature-only.txt')]);
    expect(pendingPaths()).toEqual([]);
    await agentWrite('b.txt', 'pending before checkout\n');
    ws.git('stash', '-q'); // keep the tree clean for checkout; the stash and pop accept nothing (the checkout does)
    await engine.checkGit();
    ws.git('stash', 'pop', '-q');
    await engine.checkGit();
    ws.git('checkout', '-q', 'feature');
    await engine.handleFsEvents([ws.abs('a.txt'), ws.abs('feature-only.txt')]);
    expect(pendingPaths()).toEqual(['b.txt']); // not in the checkout's diff
    expect(await baselineFiles(engine)).toMatchObject({ 'a.txt': 'feature version\n', 'b.txt': 'b\n' });
  });

  it('reset --hard is a HEAD-affecting operation', async () => {
    await agentWrite('a.txt', 'agent\n');
    ws.git('commit', '-qam', 'tmp');
    await engine.checkGit();
    ws.git('reset', '-q', '--hard', 'HEAD~1');
    await engine.handleFsEvents([ws.abs('a.txt')]);
    expect(pendingPaths()).toEqual([]);
    expect(await baselineFiles(engine)).toMatchObject({ 'a.txt': 'a1\na2\na3\na4\na5\na6\na7\n' });
  });

  it('reset (mixed) to another commit accepts the files in its diff; an untouched pending file stays pending', async () => {
    await agentWrite('a.txt', 'agent a\n');
    ws.git('commit', '-qam', 'tmp');
    await engine.checkGit();
    await agentWrite('b.txt', 'agent b\n');
    await agentWrite('a.txt', 'agent a, again\n');
    ws.git('reset', '-q', 'HEAD~1'); // the working tree keeps both files
    expect(await engine.checkGit()).toEqual({ kind: 'head', accepted: ['a.txt'] });
    expect(pendingPaths()).toEqual(['b.txt']);
    expect(await baselineFiles(engine)).toMatchObject({ 'a.txt': 'agent a, again\n', 'b.txt': 'b\n' });
  });

  it('git stash + pop (refs/stash moves, HEAD does not) accepts nothing: the pending changes come back with pop', async () => {
    await agentWrite('b.txt', 'agent\n');
    await agentWrite('a.txt', 'a1\nagent\na3\na4\na5\na6\na7\n');
    ws.git('stash', '-q'); // what an agent does to check whether a failure was already there
    expect((await engine.checkGit()).kind).not.toBe('head');
    await engine.handleFsEvents([ws.abs('a.txt'), ws.abs('b.txt')]);
    expect(pendingPaths()).toEqual([]); // the tree is back at HEAD = the baseline
    expect(await baselineFiles(engine)).toMatchObject({ 'b.txt': 'b\n' });

    ws.git('stash', 'pop', '-q');
    expect((await engine.checkGit()).kind).not.toBe('head');
    await engine.handleFsEvents([ws.abs('a.txt'), ws.abs('b.txt')]);
    expect(pendingPaths()).toEqual(['a.txt', 'b.txt']); // still up for review
    expect(await baselineFiles(engine)).toMatchObject({ 'b.txt': 'b\n' });
  });

  it('git operations done while the editor was closed are applied on open', async () => {
    await agentWrite('a.txt', 'agent\n');
    await engine.close();
    ws.git('commit', '-qam', 'while closed');
    ws.write('b.txt', 'after commit\n');
    engine = await ws.open();
    // The commit accepted its file as it was on disk at open time; b.txt, outside the commit, is pending.
    expect(pendingPaths()).toEqual(['b.txt']);
    expect(await baselineFiles(engine)).toMatchObject({ 'a.txt': 'agent\n', 'b.txt': 'b\n' });
  });

  it('waits while git holds index.lock, then applies the operation', async () => {
    await agentWrite('a.txt', 'agent\n');
    ws.git('commit', '-qam', 'x');
    const lock = path.join(ws.root, '.git', 'index.lock');
    nodeFs.writeFileSync(lock, ''); // simulate an operation still in flight
    expect(await engine.checkGit()).toEqual({ kind: 'busy' });
    expect(pendingPaths()).toEqual(['a.txt']);
    nodeFs.rmSync(lock);
    expect((await engine.checkGit()).kind).toBe('head');
    expect(pendingPaths()).toEqual([]);
  });

  it('never modifies the user repository', async () => {
    const snap = () => {
      const g = path.join(ws.root, '.git');
      const files: Record<string, string> = {};
      const walk = (d: string) => {
        for (const e of nodeFs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) { walk(p); }
          else { files[path.relative(g, p)] = nodeFs.readFileSync(p).toString('base64'); }
        }
      };
      walk(g);
      return files;
    };
    ws.git('add', 'a.txt'); // make sure the index is fresh before snapshotting
    const before = snap();
    await agentWrite('a.txt', 'x\n');
    await agentWrite('n.txt', 'n\n');
    await engine.handleFsEvents([ws.remove('b.txt')]);
    await engine.getFileChange('a.txt');
    await engine.acceptFile('a.txt');
    await engine.rejectAll();
    await engine.checkGit();
    await engine.close();
    expect(snap()).toEqual(before);
    expect(ws.storage.startsWith(path.join(ws.root, '.git'))).toBe(false);
  });
});

describe.runIf(hasGit())('git operations with the workspace in a repo subdirectory', () => {
  it('maps staged paths through the prefix', async () => {
    const ws = DiskWorkspace.create({ 'outer.txt': 'o\n', 'pkg/a.txt': 'a\n', 'pkg/b.txt': 'b\n' });
    try {
      ws.git('init', '-q');
      ws.git('add', '.');
      ws.git('commit', '-qm', 'init');
      const engine = await ReviewEngine.open({ root: ws.abs('pkg'), storageDir: ws.storage });
      expect(engine.gitRepository?.prefix).toBe('pkg');
      await engine.handleFsEvents([ws.write('pkg/a.txt', 'A\n'), ws.write('pkg/b.txt', 'B\n')]);
      ws.git('add', 'pkg/a.txt');
      await engine.checkGit();
      expect(engine.listChanges().map((c) => c.path)).toEqual(['b.txt']);
      await engine.close();
    } finally {
      ws.dispose();
    }
  });
});
