import { describe, expect, it } from 'vitest';
import { StaleChangeError, type ChangeEvent } from '../src/index.js';
import { baselineFiles, memWorkspace } from './helpers.js';

describe('setBaselineContent (host-computed partial accept, E1)', () => {
  it('moves the baseline without touching the disk', async () => {
    const ws = memWorkspace({ 'a.txt': 'one\ntwo\nthree\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.txt', 'one\nTWO\nthree\nfour\n')]);
    const events: ChangeEvent[] = [];
    engine.onDidChange((e) => events.push(e));
    // The host kept its first hunk (two -> TWO) but not the second.
    await engine.setBaselineContent('a.txt', 'one\nTWO\nthree\n');
    expect(ws.read('a.txt')).toBe('one\nTWO\nthree\nfour\n');
    expect(await baselineFiles(engine)).toEqual({ 'a.txt': 'one\nTWO\nthree\n' });
    const hunks = (await engine.getFileChange('a.txt'))!.hunks;
    expect(hunks.map((h) => [h.oldStart, h.oldLines, h.newLines])).toEqual([[3, [], ['four\n']]]);
    expect(events).toEqual([{ reason: 'accept', paths: ['a.txt'] }]);
  });

  it('clears pending when the new baseline equals the disk', async () => {
    const ws = memWorkspace({ 'a.txt': 'x\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.txt', 'y\n')]);
    await engine.setBaselineContent('a.txt', 'y\n');
    expect(engine.listChanges()).toEqual([]);
  });

  it('checks the expected baseline', async () => {
    const ws = memWorkspace({ 'a.txt': 'x\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.txt', 'y\n')]);
    await expect(engine.setBaselineContent('a.txt', 'y\n', { expectedBaseline: 'nope\n' })).rejects.toBeInstanceOf(StaleChangeError);
    await engine.setBaselineContent('a.txt', 'y\n', { expectedBaseline: 'x\n' });
    expect(engine.listChanges()).toEqual([]);
  });

  it('null drops the file from the baseline (it shows as created)', async () => {
    const ws = memWorkspace({ 'a.txt': 'x\n' });
    const engine = await ws.open();
    await engine.setBaselineContent('a.txt', null);
    expect(engine.listChanges().map((c) => [c.path, c.kind])).toEqual([['a.txt', 'created']]);
  });

  it('persists across reopen', async () => {
    const ws = memWorkspace({ 'a.txt': 'one\n' });
    let engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.txt', 'one\ntwo\nthree\n')]);
    await engine.setBaselineContent('a.txt', 'one\ntwo\n');
    await engine.close();
    engine = await ws.open();
    expect((await engine.getFileChange('a.txt'))!.hunks.map((h) => h.newLines)).toEqual([['three\n']]);
  });
});
