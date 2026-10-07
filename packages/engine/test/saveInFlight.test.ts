import { describe, expect, it } from 'vitest';
import type { ChangeEvent } from '../src/index.js';
import { baselineFiles, memWorkspace } from './helpers.js';

/**
 * Between `reportUserSave` and the editor's actual write, the disk still has the old content. That is the save
 * not having landed yet, not an external change: queries in that window must see the saved content.
 */
describe('a reported save that is not on disk yet', () => {
  async function setup(now = () => 0) {
    const ws = memWorkspace({ 'a.txt': 'Intro.\nMethods.\nResults.\n' });
    const engine = await ws.open({ now });
    await engine.handleFsEvents([ws.write('a.txt', 'Intro.\nNew methods.\nResults.\n')]); // agent
    const events: ChangeEvent[] = [];
    engine.onDidChange((e) => events.push(e));
    // The user edits line 1 and saves; the editor hasn't written yet.
    await engine.reportUserSave('a.txt', 'Intro!\nNew methods.\nResults.\n', { edits: [{ offset: 5, length: 1, text: '!', origin: 'user' }] });
    return { ws, engine, events };
  }

  it('queries see the saved content with no external change; the landed write changes nothing', async () => {
    const { ws, engine, events } = await setup();
    const change = (await engine.getFileChange('a.txt'))!; // reads the disk: still the old content
    expect(change.hunks.map((h) => [h.oldLines, h.newLines])).toEqual([[['Methods.\n'], ['New methods.\n']]]);
    expect(engine.listChanges().map((c) => c.path)).toEqual(['a.txt']);
    expect(events.map((e) => e.reason)).toEqual(['user-save']);
    await engine.handleFsEvents([ws.write('a.txt', 'Intro!\nNew methods.\nResults.\n')]); // the editor writes
    expect(events.map((e) => e.reason)).toEqual(['user-save']); // already known: not a change
    expect(await baselineFiles(engine)).toEqual({ 'a.txt': 'Intro!\nMethods.\nResults.\n' });
    expect((await engine.getFileChange('a.txt'))!.hunks.length).toBe(1);
  });

  it('a write that landed and was put back is not mistaken for a save in flight', async () => {
    const { ws, engine, events } = await setup();
    ws.write('a.txt', 'Intro!\nNew methods.\nResults.\n'); // the editor writes...
    await new Promise((r) => setTimeout(r, 5));
    ws.write('a.txt', 'Intro.\nNew methods.\nResults.\n'); // ...and something restores the old content (new mtime)
    await engine.getFileChange('a.txt');
    expect(events.map((e) => e.reason)).toEqual(['user-save', 'external']);
  });

  it('Keep File in the window accepts what is being saved, not the old disk', async () => {
    const { ws, engine, events } = await setup();
    await engine.acceptFile('a.txt');
    expect(await baselineFiles(engine)).toEqual({ 'a.txt': 'Intro!\nNew methods.\nResults.\n' });
    expect(events.map((e) => e.reason)).toEqual(['user-save', 'accept']);
    await engine.handleFsEvents([ws.write('a.txt', 'Intro!\nNew methods.\nResults.\n')]);
    expect(engine.listChanges()).toEqual([]);
  });

  it('an agent write before the editor\'s write is still an external change', async () => {
    const { ws, engine, events } = await setup();
    await engine.handleFsEvents([ws.write('a.txt', 'Intro.\nNew methods.\nResults.\nMore.\n')]);
    expect(events.map((e) => e.reason)).toEqual(['user-save', 'external']);
  });

  it('a save that never lands stops counting after a while', async () => {
    let t = 0;
    const { engine, events } = await setup(() => t);
    t = 9_000;
    await engine.getFileChange('a.txt');
    expect(events.map((e) => e.reason)).toEqual(['user-save']);
    t = 11_000; // the write failed: the disk is what it is
    const change = (await engine.getFileChange('a.txt'))!;
    expect(events.map((e) => e.reason)).toEqual(['user-save', 'external']);
    expect(change.hunks.length).toBeGreaterThan(0);
  });

  it('a save that creates the file', async () => {
    const ws = memWorkspace({});
    const engine = await ws.open();
    const events: ChangeEvent[] = [];
    engine.onDidChange((e) => events.push(e));
    await engine.reportUserSave('new.txt', 'hello\n');
    expect(await engine.getFileChange('new.txt')).toBeUndefined(); // nothing on disk yet, but nothing pending either
    await engine.acceptFile('new.txt').catch(() => undefined);
    expect(events.map((e) => e.reason)).toEqual(['user-save']);
    await engine.handleFsEvents([ws.write('new.txt', 'hello\n')]);
    expect(engine.listChanges()).toEqual([]);
  });
});
