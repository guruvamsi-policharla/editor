import { describe, expect, it } from 'vitest';
import { NotPendingError, StaleChangeError, type ChangeEvent } from '../src/index.js';
import { baselineFiles, memWorkspace } from './helpers.js';

describe('ReviewEngine basics', () => {
  it('starts with baseline = disk and nothing pending', async () => {
    const ws = memWorkspace({ 'a.txt': 'one\n', 'src/b.ts': 'export {}\n' });
    const engine = await ws.open();
    expect(engine.listChanges()).toEqual([]);
    expect(await baselineFiles(engine)).toEqual({ 'a.txt': 'one\n', 'src/b.ts': 'export {}\n' });
  });

  it('turns an external write into a pending modification with hunks', async () => {
    const ws = memWorkspace({ 'a.txt': 'one\ntwo\nthree\n' });
    const engine = await ws.open();
    const events: ChangeEvent[] = [];
    engine.onDidChange((e) => events.push(e));
    await engine.handleFsEvents([ws.write('a.txt', 'one\nTWO\nthree\nfour\n')]);
    expect(engine.listChanges()).toEqual([{ path: 'a.txt', kind: 'modified', binary: false, large: false, reviewMode: 'hunk' }]);
    expect(events).toEqual([{ reason: 'external', paths: ['a.txt'] }]);
    const change = (await engine.getFileChange('a.txt'))!;
    expect(change.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, ['two\n'], 1, ['TWO\n']],
      [3, [], 3, ['four\n']],
    ]);
    expect(change.hunks[0]!.words.new).toEqual([{ line: 1, start: 0, end: 3 }]);
  });

  it('accepts and rejects individual hunks', async () => {
    const ws = memWorkspace({ 'a.txt': 'one\ntwo\nthree\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.txt', 'one\nTWO\nthree\nfour\n')]);
    let [h1, h2] = (await engine.getFileChange('a.txt'))!.hunks;
    await engine.acceptHunk('a.txt', h1!.id);
    expect(await baselineFiles(engine)).toEqual({ 'a.txt': 'one\nTWO\nthree\n' });
    [h2] = (await engine.getFileChange('a.txt'))!.hunks;
    await engine.rejectHunk('a.txt', h2!.id);
    expect(ws.read('a.txt')).toBe('one\nTWO\nthree\n');
    expect(engine.listChanges()).toEqual([]);
  });

  it('refuses a stale hunk id', async () => {
    const ws = memWorkspace({ 'a.txt': 'one\ntwo\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.txt', 'one\nTWO\n')]);
    const [h] = (await engine.getFileChange('a.txt'))!.hunks;
    ws.write('a.txt', 'zero\none\nTWO\n'); // agent writes again; the watcher hasn't told us yet
    await expect(engine.acceptHunk('a.txt', h!.id)).rejects.toBeInstanceOf(StaleChangeError);
    expect(await baselineFiles(engine)).toEqual({ 'a.txt': 'one\ntwo\n' });
    // The engine refreshed itself, so a fresh read works.
    const hunks = (await engine.getFileChange('a.txt'))!.hunks;
    expect(hunks).toHaveLength(2);
  });

  it('accepts or rejects whole files', async () => {
    const ws = memWorkspace({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.txt', 'A\n'), ws.write('b.txt', 'B\n')]);
    await engine.acceptFile('a.txt');
    await engine.rejectFile('b.txt');
    expect(await baselineFiles(engine)).toEqual({ 'a.txt': 'A\n', 'b.txt': 'b\n' });
    expect(ws.read('b.txt')).toBe('b\n');
    expect(engine.listChanges()).toEqual([]);
  });

  it('refuses whole-file operations when the disk changed since last observed', async () => {
    const ws = memWorkspace({ 'a.txt': 'a\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.txt', 'A\n')]);
    ws.write('a.txt', 'AA\n');
    await expect(engine.acceptFile('a.txt')).rejects.toBeInstanceOf(StaleChangeError);
    await engine.acceptFile('a.txt'); // now the engine has seen AA
    expect(await baselineFiles(engine)).toEqual({ 'a.txt': 'AA\n' });
  });

  it('accept-all skips files that changed since last observed', async () => {
    const ws = memWorkspace({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.txt', 'A\n'), ws.write('b.txt', 'B\n')]);
    ws.write('b.txt', 'BB\n');
    const r = await engine.acceptAll();
    expect(r).toEqual({ done: ['a.txt'], skipped: ['b.txt'] });
    expect(engine.listChanges().map((c) => c.path)).toEqual(['b.txt']);
  });

  it('throws NotPendingError for files without changes', async () => {
    const ws = memWorkspace({ 'a.txt': 'a\n' });
    const engine = await ws.open();
    await expect(engine.acceptFile('a.txt')).rejects.toBeInstanceOf(NotPendingError);
    await expect(engine.rejectHunk('a.txt', 'nope')).rejects.toBeInstanceOf(NotPendingError);
    expect(await engine.getFileChange('a.txt')).toBeUndefined();
  });

  it('labels its own writes as self and external writes as external', async () => {
    const ws = memWorkspace({ 'a.txt': 'a\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.txt', 'A\n')]);
    const events: ChangeEvent[] = [];
    engine.onDidChange((e) => events.push(e));
    await engine.rejectFile('a.txt');
    await engine.handleFsEvents([ws.abs('a.txt')]); // watcher echo of our own write
    expect(events.map((e) => e.reason)).toEqual(['reject']);
    await engine.handleFsEvents([ws.write('a.txt', 'again\n')]);
    expect(events.map((e) => e.reason)).toEqual(['reject', 'external']);
  });

  it('accepts events as relative paths, absolute paths, and directories', async () => {
    const ws = memWorkspace({ 'docs/a.md': 'a\n', 'docs/b.md': 'b\n' });
    const engine = await ws.open();
    ws.write('docs/a.md', 'A\n');
    ws.write('docs/new/c.md', 'c\n');
    await engine.handleFsEvents(['docs']);
    expect(engine.listChanges().map((c) => [c.path, c.kind])).toEqual([
      ['docs/a.md', 'modified'],
      ['docs/new/c.md', 'created'],
    ]);
    ws.remove('docs');
    await engine.handleFsEvents([{ path: ws.abs('docs'), type: 'delete' }]);
    expect(engine.listChanges().map((c) => [c.path, c.kind])).toEqual([
      ['docs/a.md', 'deleted'],
      ['docs/b.md', 'deleted'],
    ]);
  });

  it('a root event triggers a full rescan', async () => {
    const ws = memWorkspace({ 'a.txt': 'a\n' });
    const engine = await ws.open();
    ws.write('a.txt', 'A\n');
    ws.write('x/y.txt', 'y\n');
    await engine.handleFsEvents(['/ws']);
    expect(engine.listChanges().map((c) => c.path)).toEqual(['a.txt', 'x/y.txt']);
    await engine.rescan();
    expect(engine.listChanges().map((c) => c.path)).toEqual(['a.txt', 'x/y.txt']);
  });

  it('serializes concurrent operations', async () => {
    const ws = memWorkspace({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const engine = await ws.open();
    const writes = [ws.write('a.txt', 'A\n'), ws.write('b.txt', 'B\n')];
    await Promise.all([engine.handleFsEvents(writes), engine.acceptAll(), engine.handleFsEvents(writes)]);
    expect(engine.listChanges()).toEqual([]);
    expect(await baselineFiles(engine)).toEqual({ 'a.txt': 'A\n', 'b.txt': 'B\n' });
  });

  it('rejects calls after close', async () => {
    const ws = memWorkspace({ 'a.txt': 'a\n' });
    const engine = await ws.open();
    await engine.close();
    await expect(engine.rescan()).rejects.toThrow(/closed/);
  });
});

describe('ReviewEngine user saves', () => {
  it('folds a plain save without edits into the baseline', async () => {
    const ws = memWorkspace({ 'a.txt': 'a\n' });
    const engine = await ws.open();
    const r = await engine.reportUserSave('a.txt', 'a\nmine\n');
    ws.write('a.txt', 'a\nmine\n');
    await engine.handleFsEvents([ws.abs('a.txt')]);
    expect(r.attribution).toBe('diff');
    expect(engine.listChanges()).toEqual([]);
  });

  it('works when the host reports after writing, by passing base', async () => {
    const ws = memWorkspace({ 'a.txt': 'a\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.txt', 'a\nagent\n')]);
    ws.write('a.txt', 'A\nagent\n');
    await engine.handleFsEvents([ws.abs('a.txt')]); // looks external for now
    await engine.reportUserSave('a.txt', 'A\nagent\n', { base: 'a\nagent\n' });
    expect(await baselineFiles(engine)).toEqual({ 'a.txt': 'A\n' });
    expect((await engine.getFileChange('a.txt'))!.hunks.map((h) => h.newLines)).toEqual([['agent\n']]);
  });

  it('falls back to diff attribution when the edit log does not reproduce the content', async () => {
    const ws = memWorkspace({ 'a.txt': 'a\n' });
    const engine = await ws.open();
    const r = await engine.reportUserSave('a.txt', 'b\n', { edits: [{ offset: 0, length: 0, text: 'zzz', origin: 'user' }] });
    expect(r.attribution).toBe('fallback');
    expect(await baselineFiles(engine)).toEqual({ 'a.txt': 'b\n' });
  });

  it('a brand-new file saved by the user is not pending', async () => {
    const ws = memWorkspace({});
    const engine = await ws.open();
    await engine.reportUserSave('notes/new.md', '# hi\n');
    ws.write('notes/new.md', '# hi\n');
    await engine.handleFsEvents([ws.abs('notes/new.md')]);
    expect(engine.listChanges()).toEqual([]);
  });

  it('user deletes and renames in the editor are not pending', async () => {
    const ws = memWorkspace({ 'a.txt': 'a\n', 'dir/b.txt': 'b\n' });
    const engine = await ws.open();
    await engine.reportUserDelete('a.txt');
    ws.remove('a.txt');
    await engine.reportUserRename('dir', 'renamed');
    const moved = ws.rename('dir', 'renamed');
    await engine.handleFsEvents([ws.abs('a.txt'), ...moved]);
    expect(engine.listChanges()).toEqual([]);
    expect(await baselineFiles(engine)).toEqual({ 'renamed/b.txt': 'b\n' });
  });

  it('editing an agent-created file keeps it a pending creation, with the user\'s edit in it', async () => {
    const ws = memWorkspace({});
    const engine = await ws.open();
    const agent = 'a1\na2\na3\n';
    await engine.handleFsEvents([ws.write('new.txt', agent)]);
    expect(engine.listChanges()[0]).toMatchObject({ kind: 'created', reviewMode: 'file' });
    const saved = 'a1\nmine\na3\n';
    await engine.reportUserSave('new.txt', saved, { edits: [{ offset: 3, length: 2, text: 'mine', origin: 'user' }] });
    ws.write('new.txt', saved);
    await engine.handleFsEvents([ws.abs('new.txt')]);
    expect(await baselineFiles(engine)).toEqual({});
    expect(engine.listChanges()[0]).toMatchObject({ kind: 'created', reviewMode: 'file' });
  });

  it('a formatter-only save of an agent-created file keeps it a pending creation', async () => {
    const ws = memWorkspace({});
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('new.ts', 'x=1\n')]);
    await engine.reportUserSave('new.ts', 'x = 1;\n', { edits: [{ offset: 0, length: 3, text: 'x = 1;', origin: 'formatter' }] });
    ws.write('new.ts', 'x = 1;\n');
    await engine.handleFsEvents([ws.abs('new.ts')]);
    expect(engine.listChanges()[0]).toMatchObject({ kind: 'created' });
  });

  it('preserves CRLF line endings and missing final newlines byte-for-byte', async () => {
    const ws = memWorkspace({ 'win.txt': 'one\r\ntwo\r\nthree\r\nfour' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('win.txt', 'one\r\nTWO\r\nthree\r\nfour!')]);
    const hunks = (await engine.getFileChange('win.txt'))!.hunks;
    expect(hunks).toHaveLength(2);
    await engine.rejectHunk('win.txt', hunks[0]!.id);
    expect(ws.read('win.txt')).toBe('one\r\ntwo\r\nthree\r\nfour!');
    await engine.rejectAll();
    expect(ws.read('win.txt')).toBe('one\r\ntwo\r\nthree\r\nfour');
  });

  it('saves of ignored files are ignored', async () => {
    const ws = memWorkspace({});
    const engine = await ws.open();
    await engine.reportUserSave('main.log', 'x');
    expect(engine.baselineEntries().size).toBe(0);
  });
});

describe('ReviewEngine ignore rules', () => {
  it('newly visible files start with nothing pending when user patterns change', async () => {
    const ws = memWorkspace({ 'a.txt': 'a\n', 'drafts/d.md': 'd\n' });
    const engine = await ws.open({ ignore: { patterns: ['drafts/'] } });
    expect(engine.baselineEntries().has('drafts/d.md')).toBe(false);
    await engine.setIgnorePatterns([]);
    expect(engine.listChanges()).toEqual([]);
    expect(engine.baselineEntries().has('drafts/d.md')).toBe(true);
    await engine.setIgnorePatterns(['*.txt']);
    expect(engine.baselineEntries().has('a.txt')).toBe(false);
    expect(engine.listChanges()).toEqual([]);
  });

  it('reacts to .gitignore edits', async () => {
    const ws = memWorkspace({ 'a.txt': 'a\n', 'gen/x.js': 'x\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('.gitignore', 'gen/\n')]);
    expect(engine.baselineEntries().has('gen/x.js')).toBe(false);
    expect(engine.listChanges().map((c) => c.path)).toEqual(['.gitignore']);
    await engine.handleFsEvents([ws.write('gen/y.js', 'y\n')]);
    expect(engine.listChanges().map((c) => c.path)).toEqual(['.gitignore']);
  });
});
