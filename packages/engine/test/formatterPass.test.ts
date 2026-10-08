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

  it('without the user text, a log that does not replay still counts everything as the user\'s (stock VS Code)', async () => {
    const { engine, r } = await save({ edits: [...typing.slice(1), formatter] });
    expect(r.attribution).toBe('fallback');
    expect(engine.listChanges()).toEqual([]);
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
});
