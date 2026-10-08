/**
 * One fixture per PLAN.md §7 edge case that applies to the engine.
 * Git operations are covered in git.test.ts (they need a real repository).
 * "Dirty buffer -> merge view" is the extension's job; the engine part is that it never writes in
 * response to an external change and attributes a save against the content the buffer started from.
 */
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MultiRootReview, ReviewEngine, type TrackedEdit } from '../src/index.js';
import { baselineFiles, DiskWorkspace, memWorkspace, rmrf, tmpDir } from './helpers.js';

function editOf(text: string, find: string, replace: string, origin: TrackedEdit['origin'] = 'user'): TrackedEdit {
  const offset = text.indexOf(find);
  if (offset < 0) { throw new Error(`${find} not in text`); }
  return { offset, length: find.length, text: replace, origin };
}

describe('§7 dirty buffer: the engine never overwrites either side', () => {
  it('does not touch the disk on external changes, and a merged save keeps agent lines pending', async () => {
    const ws = memWorkspace({ 'paper.tex': 'Intro.\nMethods.\n' });
    const engine = await ws.open();
    // The user has unsaved edits in "Intro."; meanwhile the agent rewrites "Methods.".
    await engine.handleFsEvents([ws.write('paper.tex', 'Intro.\nBetter methods.\n')]);
    expect(ws.read('paper.tex')).toBe('Intro.\nBetter methods.\n');
    // The extension's merge view produces the merged buffer; the user's edit is relative to the agent's version.
    const base = 'Intro.\nBetter methods.\n';
    const merged = 'Introduction.\nBetter methods.\n';
    await engine.reportUserSave('paper.tex', merged, { base, edits: [editOf(base, 'Intro.', 'Introduction.')] });
    ws.write('paper.tex', merged);
    await engine.handleFsEvents([ws.abs('paper.tex')]);
    expect(await baselineFiles(engine)).toEqual({ 'paper.tex': 'Introduction.\nMethods.\n' });
    const hunks = (await engine.getFileChange('paper.tex'))!.hunks;
    expect(hunks.map((h) => [h.oldLines, h.newLines])).toEqual([[['Methods.\n'], ['Better methods.\n']]]);
  });
});

describe('§7 agent edits the same region several times before review', () => {
  it('shows one combined hunk against the baseline', async () => {
    const ws = memWorkspace({ 'a.md': 'title\nbody\nend\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.md', 'title\nbody v1\nend\n')]);
    await engine.handleFsEvents([ws.write('a.md', 'title\nbody v2\nextra\nend\n')]);
    await engine.handleFsEvents([ws.write('a.md', 'title\nbody v3\nextra\nend\n')]);
    const hunks = (await engine.getFileChange('a.md'))!.hunks;
    expect(hunks.map((h) => [h.oldLines, h.newLines])).toEqual([[['body\n'], ['body v3\n', 'extra\n']]]);
  });

  it('an agent reverting its own edit leaves nothing pending', async () => {
    const ws = memWorkspace({ 'a.md': 'x\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.md', 'y\n')]);
    await engine.handleFsEvents([ws.write('a.md', 'x\n')]);
    expect(engine.listChanges()).toEqual([]);
  });
});

describe('§7 user edits a pending hunk by hand', () => {
  it("the user's edit wins; untouched agent lines stay pending as a smaller hunk", async () => {
    const ws = memWorkspace({ 'a.py': 'def f():\n    pass\n' });
    const engine = await ws.open();
    const agent = 'def f():\n    a = 1\n    b = 2\n    c = 3\n';
    await engine.handleFsEvents([ws.write('a.py', agent)]);
    const saved = 'def f():\n    a = 1\n    b = 20\n    c = 3\n';
    await engine.reportUserSave('a.py', saved, { edits: [editOf(agent, 'b = 2', 'b = 20')] });
    ws.write('a.py', saved);
    await engine.handleFsEvents([ws.abs('a.py')]);
    expect(await baselineFiles(engine)).toEqual({ 'a.py': 'def f():\n    pass\n    b = 20\n' });
    const hunks = (await engine.getFileChange('a.py'))!.hunks;
    expect(hunks.map((h) => [h.oldLines, h.newLines])).toEqual([
      [['    pass\n'], ['    a = 1\n']],
      [[], ['    c = 3\n']],
    ]);
    // Rejecting what's left restores the original line and keeps the user's line.
    await engine.rejectAll();
    expect(ws.read('a.py')).toBe('def f():\n    pass\n    b = 20\n');
  });

  it('user edits elsewhere in the file leave agent hunks untouched', async () => {
    const ws = memWorkspace({ 'a.txt': 'one\ntwo\nthree\nfour\n' });
    const engine = await ws.open();
    const agent = 'one\ntwo\nTHREE\nfour\n';
    await engine.handleFsEvents([ws.write('a.txt', agent)]);
    const before = (await engine.getFileChange('a.txt'))!.hunks.map((h) => [h.oldLines, h.newLines]);
    const saved = 'ONE\ntwo\nTHREE\nfour\n';
    await engine.reportUserSave('a.txt', saved, { edits: [editOf(agent, 'one', 'ONE')] });
    ws.write('a.txt', saved);
    await engine.handleFsEvents([ws.abs('a.txt')]);
    expect((await engine.getFileChange('a.txt'))!.hunks.map((h) => [h.oldLines, h.newLines])).toEqual(before);
  });
});

describe('§7 agent creates, deletes, or renames files', () => {
  it('created files are file-level units: accept keeps, reject deletes', async () => {
    const ws = memWorkspace({});
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('new/a.txt', 'a\n'), ws.write('b.txt', 'b\n')]);
    const changes = engine.listChanges();
    expect(changes.map((c) => [c.path, c.kind, c.reviewMode])).toEqual([
      ['b.txt', 'created', 'file'],
      ['new/a.txt', 'created', 'file'],
    ]);
    expect((await engine.getFileChange('b.txt'))!.hunks.map((h) => h.newLines)).toEqual([['b\n']]);
    await engine.acceptFile('new/a.txt');
    await engine.rejectFile('b.txt');
    expect(ws.exists('b.txt')).toBe(false);
    expect(await baselineFiles(engine)).toEqual({ 'new/a.txt': 'a\n' });
  });

  it('deleted files: accept drops them, reject restores them (including parent dirs)', async () => {
    const ws = memWorkspace({ 'deep/dir/a.txt': 'a\n', 'b.txt': 'b\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.remove('deep'), ws.remove('b.txt')]);
    expect(engine.listChanges().map((c) => [c.path, c.kind])).toEqual([
      ['b.txt', 'deleted'],
      ['deep/dir/a.txt', 'deleted'],
    ]);
    await engine.acceptFile('b.txt');
    await engine.rejectFile('deep/dir/a.txt');
    expect(ws.read('deep/dir/a.txt')).toBe('a\n');
    expect(await baselineFiles(engine)).toEqual({ 'deep/dir/a.txt': 'a\n' });
  });

  it('delete + create with identical content is one rename', async () => {
    const ws = memWorkspace({ 'old/name.txt': 'same content\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.remove('old/name.txt')]);
    await engine.handleFsEvents([ws.write('new/name.txt', 'same content\n')]);
    expect(engine.listChanges()).toEqual([
      { path: 'new/name.txt', kind: 'renamed', oldPath: 'old/name.txt', binary: false, large: false, reviewMode: 'file' },
    ]);
    expect((await engine.getFileChange('old/name.txt'))!.kind).toBe('renamed');
    await engine.rejectFile('new/name.txt');
    expect(ws.read('old/name.txt')).toBe('same content\n');
    expect(ws.exists('new/name.txt')).toBe(false);
    expect(engine.listChanges()).toEqual([]);
  });

  it('accepting a rename moves the baseline entry', async () => {
    const ws = memWorkspace({ 'a.txt': 'x\n' });
    const engine = await ws.open();
    await engine.handleFsEvents(ws.rename('a.txt', 'b.txt'));
    await engine.acceptFile('a.txt'); // either side of the pair works
    expect(await baselineFiles(engine)).toEqual({ 'b.txt': 'x\n' });
  });

  it('delete + create with different content are separate units', async () => {
    const ws = memWorkspace({ 'a.txt': 'x\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.remove('a.txt'), ws.write('b.txt', 'y\n')]);
    expect(engine.listChanges().map((c) => [c.path, c.kind])).toEqual([
      ['a.txt', 'deleted'],
      ['b.txt', 'created'],
    ]);
  });

  it('pairs renames deterministically, preferring same file names', async () => {
    const ws = memWorkspace({ 'a/x.txt': 'dup\n', 'a/y.txt': 'dup\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([...ws.rename('a/x.txt', 'b/x.txt'), ...ws.rename('a/y.txt', 'b/y.txt')]);
    expect(engine.listChanges().map((c) => [c.oldPath, c.path])).toEqual([
      ['a/x.txt', 'b/x.txt'],
      ['a/y.txt', 'b/y.txt'],
    ]);
  });
});

describe('§7 formatter or linter on save', () => {
  it('editor formatter changes inside agent hunks stay pending; elsewhere they fold in', async () => {
    const ws = memWorkspace({ 'a.ts': 'const x=1\nfunction f(){}\n' });
    const engine = await ws.open();
    const agent = 'const x=1\nfunction f(){}\nfunction g(){return 2}\n';
    await engine.handleFsEvents([ws.write('a.ts', agent)]);
    // Format on save touches the user's untouched line 1 and the agent's line 3.
    const e1 = editOf(agent, 'const x=1', 'const x = 1;', 'formatter');
    const t1 = agent.replace('const x=1', 'const x = 1;');
    const e2 = editOf(t1, 'function g(){return 2}', 'function g() {\n  return 2;\n}', 'formatter');
    const saved = t1.replace('function g(){return 2}', 'function g() {\n  return 2;\n}');
    await engine.reportUserSave('a.ts', saved, { edits: [e1, e2] });
    ws.write('a.ts', saved);
    await engine.handleFsEvents([ws.abs('a.ts')]);
    expect(await baselineFiles(engine)).toEqual({ 'a.ts': 'const x = 1;\nfunction f(){}\n' });
    expect((await engine.getFileChange('a.ts'))!.hunks.map((h) => h.newLines)).toEqual([
      ['function g() {\n', '  return 2;\n', '}\n'],
    ]);
  });

  it('rejecting a formatter-touched agent hunk also reverts the formatting (documented behavior)', async () => {
    const ws = memWorkspace({ 'a.ts': 'keep\n' });
    const engine = await ws.open();
    const agent = 'keep\nagent(  )\n';
    await engine.handleFsEvents([ws.write('a.ts', agent)]);
    const saved = 'keep\nagent()\n';
    await engine.reportUserSave('a.ts', saved, { edits: [editOf(agent, 'agent(  )', 'agent()', 'formatter')] });
    ws.write('a.ts', saved);
    await engine.handleFsEvents([ws.abs('a.ts')]);
    await engine.rejectAll();
    expect(ws.read('a.ts')).toBe('keep\n');
  });

  it('a formatter run by the agent is just an external change', async () => {
    const ws = memWorkspace({ 'a.ts': 'const x=1\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.ts', 'const x = 1;\n')]);
    expect(engine.listChanges().map((c) => c.path)).toEqual(['a.ts']);
  });
});

describe('§7 build artifacts are ignored', () => {
  it('ignores LaTeX aux files, the output PDF, node_modules and dist, but not figure PDFs', async () => {
    const ws = memWorkspace({ 'paper/main.tex': '\\documentclass{article}\n', 'paper/figs/plot.pdf': '%PDF fig' });
    const engine = await ws.open();
    await engine.handleFsEvents([
      ws.write('paper/main.aux', 'aux'),
      ws.write('paper/main.log', 'log'),
      ws.write('paper/main.synctex.gz', 'gz'),
      ws.write('paper/main.fdb_latexmk', 'fdb'),
      ws.write('paper/main.pdf', '%PDF out'),
      ws.write('node_modules/x/index.js', 'x'),
      ws.write('dist/bundle.js', 'b'),
      ws.write('paper/figs/plot.pdf', '%PDF fig v2'),
    ]);
    expect(engine.listChanges().map((c) => c.path)).toEqual(['paper/figs/plot.pdf']);
  });

  it('the output PDF becomes reviewable (with nothing pending) if its .tex goes away', async () => {
    const ws = memWorkspace({ 'main.tex': 'x\n', 'main.pdf': '%PDF' });
    const engine = await ws.open();
    expect(engine.baselineEntries().has('main.pdf')).toBe(false);
    await engine.handleFsEvents([ws.remove('main.tex')]);
    expect(engine.baselineEntries().has('main.pdf')).toBe(true);
    expect(engine.listChanges().map((c) => c.path)).toEqual(['main.tex']);
    await engine.handleFsEvents([ws.write('main.tex', 'x\n')]);
    expect(engine.baselineEntries().has('main.pdf')).toBe(false);
  });
});

describe('§7 large and binary files get file-level review only', () => {
  it('binary files', async () => {
    const ws = memWorkspace({ 'img.png': new Uint8Array([137, 80, 78, 71, 0, 1, 2]) });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('img.png', new Uint8Array([137, 80, 78, 71, 0, 9, 9]))]);
    const change = (await engine.getFileChange('img.png'))!;
    expect(change).toMatchObject({ kind: 'modified', binary: true, reviewMode: 'file', hunks: [] });
    await engine.rejectFile('img.png');
    expect(Array.from(await ws.fs.readFile(ws.abs('img.png')))).toEqual([137, 80, 78, 71, 0, 1, 2]);
  });

  it('invalid UTF-8 counts as binary', async () => {
    const ws = memWorkspace({ 'latin1.txt': new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]) });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('latin1.txt', new Uint8Array([0x63, 0xe9, 0x0a]))]);
    expect(engine.listChanges()[0]).toMatchObject({ binary: true, reviewMode: 'file' });
  });

  it('large files', async () => {
    const ws = memWorkspace({ 'big.txt': 'x\n'.repeat(100) });
    const engine = await ws.open({ largeFileThreshold: 100 });
    await engine.handleFsEvents([ws.write('big.txt', 'y\n'.repeat(100))]);
    const change = (await engine.getFileChange('big.txt'))!;
    expect(change).toMatchObject({ large: true, reviewMode: 'file', hunks: [] });
    await engine.acceptFile('big.txt');
    expect(engine.listChanges()).toEqual([]);
  });
});

describe('§7 editor closed while the agent keeps editing', () => {
  it('changes made while closed are pending on next open; accepted state persists', async () => {
    const ws = memWorkspace({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    let engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.txt', 'A\n')]);
    await engine.acceptFile('a.txt');
    await engine.handleFsEvents([ws.write('b.txt', 'B\n')]); // pending, not reviewed
    await engine.close();

    ws.write('c.txt', 'C\n');
    ws.write('d.txt', 'd\n');
    ws.remove('a.txt');

    engine = await ws.open();
    expect(engine.listChanges().map((c) => [c.path, c.kind])).toEqual([
      ['a.txt', 'deleted'],
      ['b.txt', 'modified'],
      ['c.txt', 'modified'],
      ['d.txt', 'created'],
    ]);
    expect((await engine.getBaselineContent('a.txt')) && new TextDecoder().decode((await engine.getBaselineContent('a.txt'))!)).toBe('A\n');
  });

  it('persists across restarts on the real filesystem (stat cache path)', async () => {
    const ws = DiskWorkspace.create({ 'a.txt': 'a\n' });
    try {
      let engine = await ws.open({ git: false });
      await engine.close();
      ws.write('a.txt', 'agent\n');
      engine = await ws.open({ git: false });
      expect(engine.listChanges().map((c) => c.path)).toEqual(['a.txt']);
      await engine.close();
      engine = await ws.open({ git: false });
      expect(engine.listChanges().map((c) => c.path)).toEqual(['a.txt']);
      await engine.close();
    } finally {
      ws.dispose();
    }
  });
});

describe('§7 multi-root workspaces', () => {
  let base: string;
  afterEach(() => rmrf(base));

  it('keeps a separate baseline per root, and nested roots are not tracked twice', async () => {
    base = tmpDir();
    const r1 = path.join(base, 'one');
    const r2 = path.join(base, 'two');
    const nested = path.join(r1, 'packages', 'inner');
    for (const d of [r1, r2, nested]) { nodeFs.mkdirSync(d, { recursive: true }); }
    nodeFs.writeFileSync(path.join(r1, 'a.txt'), 'one\n');
    nodeFs.writeFileSync(path.join(r2, 'a.txt'), 'two\n');
    nodeFs.writeFileSync(path.join(nested, 'n.txt'), 'n\n');
    const review = await MultiRootReview.open({ roots: [r1, r2, nested], storageBase: path.join(base, 'storage'), git: false });
    try {
      const e1 = review.engines.get(r1)!;
      const e2 = review.engines.get(r2)!;
      const en = review.engines.get(nested)!;
      expect(e1.storageDir).not.toBe(e2.storageDir);
      expect([...e1.baselineEntries().keys()]).toEqual(['a.txt']);
      expect([...en.baselineEntries().keys()]).toEqual(['n.txt']);
      nodeFs.writeFileSync(path.join(r2, 'a.txt'), 'TWO\n');
      nodeFs.writeFileSync(path.join(nested, 'n.txt'), 'N\n');
      await review.handleFsEvents([path.join(r2, 'a.txt'), path.join(nested, 'n.txt')]);
      expect(e1.listChanges()).toEqual([]);
      expect(e2.listChanges().map((c) => c.path)).toEqual(['a.txt']);
      expect(en.listChanges().map((c) => c.path)).toEqual(['n.txt']);
      expect(await review.engineFor(path.join(nested, 'n.txt'))).toBe(en);
    } finally {
      await review.close();
    }
  });
});

describe('§7 symlinked paths normalize to real paths', () => {
  it('a workspace opened through a symlink reports real-root-relative paths and accepts symlinked event paths', async () => {
    const ws = DiskWorkspace.create({ 'a.txt': 'a\n' });
    const link = path.join(path.dirname(ws.root), 'link');
    nodeFs.symlinkSync(ws.root, link);
    try {
      const engine = await ReviewEngine.open({ root: link, storageDir: ws.storage, git: false });
      expect(engine.root).toBe(ws.root);
      ws.write('a.txt', 'A\n');
      await engine.handleFsEvents([path.join(link, 'a.txt')]);
      expect(engine.listChanges().map((c) => c.path)).toEqual(['a.txt']);
      await engine.acceptFile(path.join(link, 'a.txt'));
      // Deleted files through the symlink still resolve.
      nodeFs.rmSync(ws.abs('a.txt'));
      await engine.handleFsEvents([path.join(link, 'a.txt')]);
      expect(engine.listChanges().map((c) => [c.path, c.kind])).toEqual([['a.txt', 'deleted']]);
      await engine.close();
    } finally {
      ws.dispose();
    }
  });

  it('a write through a file symlink inside the workspace is one change, under the real file', async () => {
    const ws = DiskWorkspace.create({ 'sections/intro.tex': 'Intro.\n' });
    nodeFs.symlinkSync(ws.abs('sections/intro.tex'), ws.abs('intro-link.tex'));
    try {
      const engine = await ReviewEngine.open({ root: ws.root, storageDir: ws.storage, git: false });
      expect([...engine.baselineEntries().keys()]).toEqual(['sections/intro.tex']); // tracked once
      nodeFs.writeFileSync(ws.abs('intro-link.tex'), 'Intro, by the agent.\n');
      await engine.handleFsEvents([ws.abs('intro-link.tex')]); // reported under the link path
      await engine.handleFsEvents([ws.abs('sections/intro.tex')]); // and under the real one
      expect(engine.listChanges().map((c) => [c.path, c.kind])).toEqual([['sections/intro.tex', 'modified']]);
      await engine.rejectFile(ws.abs('intro-link.tex')); // Undo through the link path restores the real file
      expect(nodeFs.readFileSync(ws.abs('sections/intro.tex'), 'utf8')).toBe('Intro.\n');
      expect(nodeFs.lstatSync(ws.abs('intro-link.tex')).isSymbolicLink()).toBe(true); // the link itself is untouched
      await engine.close();
    } finally {
      ws.dispose();
    }
  });

  it('symlinks inside the workspace are not followed or tracked', async () => {
    const ws = memWorkspace({ 'real/a.txt': 'a\n' });
    ws.fs.symlinkSync('/ws/real', '/ws/alias');
    ws.fs.symlinkSync('/ws/real/a.txt', '/ws/alias-file.txt');
    const engine = await ws.open();
    expect([...engine.baselineEntries().keys()]).toEqual(['real/a.txt']);
  });
});
