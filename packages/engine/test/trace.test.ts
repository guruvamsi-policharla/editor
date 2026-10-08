import { describe, expect, it } from 'vitest';
import { memWorkspace } from './helpers.js';

/** The `trace` option: every baseline change with its reason, pending transitions, and how a save was attributed. */
describe('trace', () => {
  it('logs baseline moves with their reason, pending transitions and save attribution', async () => {
    const ws = memWorkspace({ 'a.txt': 'Intro.\nMethods.\n' });
    const lines: string[] = [];
    const engine = await ws.open({ trace: (m) => lines.push(m) });
    await engine.handleFsEvents([ws.write('a.txt', 'Intro.\nNew methods.\n')]);
    await engine.reportUserSave('a.txt', 'Intro!\nNew methods.\n', { edits: [{ offset: 5, length: 1, text: '!', origin: 'user' }] });
    await engine.acceptFile('a.txt');
    const text = lines.join('\n');
    expect(text).toMatch(/\[\] a\.txt: baseline none -> \w{8} \(first scan\)/);
    expect(text).toMatch(/\[handleFsEvents\] a\.txt: pending \(disk \w{8}, baseline \w{8}\)/);
    expect(text).toContain('[handleFsEvents] watcher: a.txt (external)');
    expect(text).toMatch(/\[reportUserSave\] a\.txt: save attributed by edits \(1 edits: 1 user, 0 formatter; formatter: by edit tags; base from disk\); changes against the baseline: 1 before the save .*, 1 after/);
    expect(text).toMatch(/\[reportUserSave\] a\.txt: baseline \w{8} -> \w{8} \(user save, attribution: edits\)/);
    expect(text).toMatch(/\[acceptFile\] a\.txt: baseline \w{8} -> \w{8} \(Keep file, the save in flight\)/);
    expect(text).toMatch(/\[acceptFile\] a\.txt: no longer pending/);
  });

  it('a throwing trace function does not break the engine', async () => {
    const ws = memWorkspace({ 'a.txt': 'x\n' });
    const engine = await ws.open({ trace: () => { throw new Error('boom'); } });
    await engine.handleFsEvents([ws.write('a.txt', 'y\n')]);
    expect(engine.listChanges().map((c) => c.path)).toEqual(['a.txt']);
  });
});
