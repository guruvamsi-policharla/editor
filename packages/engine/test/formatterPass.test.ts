import { describe, expect, it } from 'vitest';
import type { TrackedEdit } from '../src/index.js';
import { baselineFiles, memWorkspace } from './helpers.js';

/**
 * Format on save with `userContent` (the buffer before save participants): the formatter's part of the save is found
 * by diffing, so no edit-log problem can make a formatter's rewrite of agent lines pass for the user's (polish-2 P2-6:
 * a log that missed one keystroke fell back to "every change is the user's" and accepted the agent's JSON edit).
 */
describe('format on save with the user text', () => {
  const base = '{\n  "runs": 50,\n  "batch": [32, 128, 512]\n}\n';
  const agent = '{\n  "runs": 50, "warmup":5,"cores" :[1,2,4],\n  "batch": [32, 128, 512]\n}\n';
  const user = '{\n  "runs": 50, "warmup":5,"cores" :[1,2,4],\n  "batch": [32, 128, 512], 2048\n}\n';
  const saved = '{\n  "runs": 50,\n  "warmup": 5,\n  "cores": [\n    1,\n    2,\n    4\n  ],\n  "batch": [\n    32,\n    128,\n    512\n  ],\n  2048\n}\n';
  const at = agent.indexOf(']\n}') + 1;
  const typing: TrackedEdit[] = [...', 2048'].map((ch, i) => ({ offset: at + i, length: 0, text: ch, origin: 'user' }));
  const formatter: TrackedEdit = { offset: 0, length: user.length, text: saved, origin: 'formatter' };

  async function save(opts: { edits?: TrackedEdit[]; userContent?: string }) {
    const ws = memWorkspace({ 'data.json': base });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('data.json', agent)]);
    const r = await engine.reportUserSave('data.json', saved, opts);
    await engine.handleFsEvents([ws.write('data.json', saved)]);
    return { engine, r, baseline: (await baselineFiles(engine))['data.json']! };
  }

  for (const [name, edits] of [
    ['no edit log', undefined],
    ['a log that missed the first keystroke', [...typing.slice(1), formatter]],
    ['a log with every edit tagged as the user\'s (versions out of sync)', [...typing, { ...formatter, origin: 'user' as const }]],
    ['a correct log', [...typing, formatter]],
  ] as const) {
    it(`${name}: the agent's lines stay pending`, async () => {
      const { engine, baseline } = await save({ ...(edits ? { edits: [...edits] } : {}), userContent: user });
      expect(engine.listChanges().map((c) => c.path)).toEqual(['data.json']);
      expect(baseline).not.toContain('warmup');
      expect(baseline).not.toContain('cores');
    });
  }

  it('without the user text, a log that does not replay counts everything as the user\'s (stock VS Code): still pending', async () => {
    const { engine, r, baseline } = await save({ edits: [...typing.slice(1), formatter] });
    expect(r.attribution).toBe('fallback');
    // Saving never accepts: the "user's" rewrite of the agent's line keeps the hunk pending.
    expect(engine.listChanges().map((c) => c.path)).toEqual(['data.json']);
    expect(baseline).not.toContain('warmup');
  });

  it('a user edit saved with no formatter changes folds in as before', async () => {
    const ws = memWorkspace({ 'a.txt': 'one\ntwo\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.txt', 'one\nTWO\n')]);
    const r = await engine.reportUserSave('a.txt', 'one!\nTWO\n', { userContent: 'one!\nTWO\n' });
    expect(r.attribution).toBe('diff');
    expect(await baselineFiles(engine)).toEqual({ 'a.txt': 'one!\ntwo\n' });
  });

  it('P2-7: the user\'s line reflowed next to the agent hunk folds in; only the agent\'s lines stay pending', async () => {
    const { engine, baseline } = await save({ edits: [...typing, formatter], userContent: user });
    expect(baseline).toBe('{\n  "runs": 50,\n  "batch": [\n    32,\n    128,\n    512\n  ],\n  2048\n}\n');
    const [change] = (await engine.getFileChange('data.json'))!.hunks;
    expect(change!.oldLines).toEqual([]);
    expect(change!.newLines).toEqual(['  "warmup": 5,\n', '  "cores": [\n', '    1,\n', '    2,\n', '    4\n', '  ],\n']);
  });

  it('a formatter line mixing agent and user words stays pending, even in a line-for-line rewrite', async () => {
    const ws = memWorkspace({ 'a.tex': 'Intro.\nOld words here.\nEnd.\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.tex', 'Intro.\nAgent words\nhere.\nEnd.\n')]); // agent: line 2 -> 2 lines
    // The user types on "Intro."; the formatter joins the agent's two lines and moves "here." up into the user's line.
    const userText = 'Intro. Mine.\nAgent words\nhere.\nEnd.\n';
    const saved = 'Intro. Mine. here.\nAgent words\nEnd.\n';
    await engine.reportUserSave('a.tex', saved, { userContent: userText });
    const b = (await baselineFiles(engine))['a.tex']!;
    expect(b).not.toContain('Agent');
    expect(b).not.toMatch(/Mine\. here/); // the agent's "here." is not folded in with the user's line
    expect(engine.listChanges().map((c) => c.path)).toEqual(['a.tex']);
  });

  // Found by the stress harness (seed 22): a reflow moved base words into the agent's new sentence's line.
  it('a reflow that moves base words into the agent\'s line keeps them in the baseline (Undo must not delete them)', async () => {
    const base = 'The b17 scheme b18 a b19 b20 of b21 and b22~\\cite{b23}.\nWe b24 it b25 the b26 in b27.\n';
    const ws = memWorkspace({ 'p.tex': base });
    const engine = await ws.open();
    const agent = 'The b17 scheme b18 a b19 b20 of b21 and b22~\\cite{b23}.\nThe ag9 result ag10 holds.\nWe b24 it b25 the b26 in b27.\n';
    await engine.handleFsEvents([ws.write('p.tex', agent)]);
    const saved = 'The b17 scheme b18 a b19 b20 of b21 and\nb22~\\cite{b23}. The ag9 result ag10 holds. We b24\nit b25 the b26 in b27.\n';
    await engine.reportUserSave('p.tex', saved, { userContent: agent });
    await engine.handleFsEvents([ws.write('p.tex', saved)]);
    const b = (await baselineFiles(engine))['p.tex']!;
    for (const w of ['b22', 'b23', 'b24', 'b21', 'b25']) { expect(b).toContain(w); }
    expect(b).not.toContain('ag9');
    await engine.rejectFile('p.tex');
    expect(ws.read('p.tex')).toBe(b); // Undo brings back every base word
  });

  // Found by the stress harness (seed 18): the user's joined line reflowed together with the agent's sentence.
  it('the user\'s words reflowed into a line with agent words stay in the baseline as the user wrote them', async () => {
    const base = 'The b6 scheme b7 a b8 b9 of b10 and\nb11~\\cite{b12}. We b13 it b14 the b15 in b16.\n';
    const ws = memWorkspace({ 'p.tex': base });
    const engine = await ws.open();
    const agent = `The ag4 result ag5 holds.\n${base}`;
    await engine.handleFsEvents([ws.write('p.tex', agent)]);
    const user = 'The ag4 result ag5 holds.\nThe b6 scheme b7 a b8 b9 of b10 and b11~\\cite{b12}. We b13 it b14 the b15 in b16.\n'; // joined
    const saved = 'The ag4 result ag5 holds. The b6 scheme b7 a b8 b9\nof b10 and b11~\\cite{b12}. We b13 it b14 the b15\nin b16.\n';
    await engine.reportUserSave('p.tex', saved, { userContent: user, edits: [{ offset: agent.indexOf('and\n') + 3, length: 1, text: ' ', origin: 'user' }] });
    await engine.handleFsEvents([ws.write('p.tex', saved)]);
    const b = (await baselineFiles(engine))['p.tex']!;
    expect(b).toBe('The b6 scheme b7 a b8 b9 of b10 and b11~\\cite{b12}. We b13 it b14 the b15 in b16.\n');
    expect(engine.listChanges().map((c) => c.path)).toEqual(['p.tex']);
  });
});

describe('saving never accepts, with format on save', () => {
  it('the user\'s typing inside an agent hunk stays pending through format on save, save after save', async () => {
    const ws = memWorkspace({ 'a.json': '{\n  "a": 1\n}\n' });
    const engine = await ws.open();
    const agent = '{\n  "a": 1, "b":2\n}\n';
    await engine.handleFsEvents([ws.write('a.json', agent)]);
    const user = '{\n  "a": 1, "b":2, "mine":3\n}\n';
    const saved = '{\n  "a": 1,\n  "b": 2,\n  "mine": 3\n}\n';
    await engine.reportUserSave('a.json', saved, { userContent: user });
    await engine.handleFsEvents([ws.write('a.json', saved)]);
    expect((await baselineFiles(engine))['a.json']).toBe('{\n  "a": 1\n}\n');
    // Again: the user edits their own text inside the (still pending) hunk.
    const saved2 = saved.replace('"mine": 3', '"mine": 4');
    await engine.reportUserSave('a.json', saved2, { userContent: saved2 });
    await engine.handleFsEvents([ws.write('a.json', saved2)]);
    expect((await baselineFiles(engine))['a.json']).toBe('{\n  "a": 1\n}\n');
    expect(engine.listChanges().map((c) => c.path)).toEqual(['a.json']);
  });
});

describe('the review UI\'s baseline (reviewBaseline)', () => {
  it('is used as the new baseline instead of the engine\'s attribution, with the file\'s line endings', async () => {
    const ws = memWorkspace({ 'a.txt': 'one\r\ntwo\r\nthree\r\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('a.txt', 'one\r\nTWO\r\nthree\r\n')]);
    const saved = 'one!\r\nTWO mine\r\nthree\r\n';
    const r = await engine.reportUserSave('a.txt', saved, { reviewBaseline: 'one!\ntwo\nthree\n' });
    expect(r.attribution).toBe('review');
    expect((await baselineFiles(engine))['a.txt']).toBe('one!\r\ntwo\r\nthree\r\n');
    const [hunk] = (await engine.getFileChange('a.txt'))!.hunks;
    expect([hunk!.oldLines, hunk!.newLines]).toEqual([['two\r\n'], ['TWO mine\r\n']]);
  });

  it('an empty one for an agent-created file keeps it a pending creation', async () => {
    const ws = memWorkspace({});
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('new.txt', 'a\n')]);
    await engine.reportUserSave('new.txt', 'a mine\n', { reviewBaseline: '' });
    expect(engine.listChanges()[0]).toMatchObject({ path: 'new.txt', kind: 'created' });
  });
});
