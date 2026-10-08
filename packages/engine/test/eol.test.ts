import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { equalIgnoringEol, restoreLineEndings } from '../src/eol.js';
import { memWorkspace } from './helpers.js';

const lf = (s: string) => s.replace(/\r\n/g, '\n');

describe('restoreLineEndings (text from an EOL-normalizing editor buffer)', () => {
  it('takes each line ending from the first source that has the line', () => {
    const disk = 'one\r\nTWO\nthree\r\nfour\nfive\r\n';
    const base = 'one\r\ntwo\nthree\r\nfour\n';
    // Kept "TWO" (from disk); "five" not kept.
    expect(restoreLineEndings('one\nTWO\nthree\nfour\n', [disk, base])).toBe('one\r\nTWO\nthree\r\nfour\n');
    // A line only in the baseline (the agent deleted it, not kept) gets the baseline's ending.
    expect(restoreLineEndings('a\nold\nb\n', ['a\r\nb\r\n', 'a\r\nold\r\nb\r\n'])).toBe('a\r\nold\r\nb\r\n');
  });

  it('leaves unmatched lines and a last line without a terminator alone', () => {
    expect(restoreLineEndings('new\nx', ['x\r\n'])).toBe('new\nx');
    expect(restoreLineEndings('x\n', ['x'])).toBe('x\n');
  });

  it('property: normalizing then restoring from the original is the identity', () => {
    const line = fc.tuple(fc.constantFrom('a', 'b', '', 'c c'), fc.constantFrom('\n', '\r\n'));
    fc.assert(
      fc.property(fc.array(line, { maxLength: 20 }), fc.boolean(), (lines, cutLast) => {
        let original = lines.map(([t, e]) => t + e).join('');
        if (cutLast && original.length) { original = original.replace(/\r?\n$/, ''); }
        expect(restoreLineEndings(lf(original), [original])).toBe(original);
        expect(restoreLineEndings(original.replace(/\r?\n/g, '\r\n'), [original])).toBe(original);
      }),
      { numRuns: 500 },
    );
  });

  it('equalIgnoringEol', () => {
    expect(equalIgnoringEol('a\r\nb\n', 'a\nb\r\n')).toBe(true);
    expect(equalIgnoringEol('a\nb\n', 'a\nc\n')).toBe(false);
  });
});

describe('setBaselineContent with restoreLineEndings', () => {
  it('a Keep from a normalized buffer leaves only the unkept hunk pending on a mixed-EOL file', async () => {
    const ws = memWorkspace({ 'm.txt': 'one\r\ntwo\nthree\r\nfour\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('m.txt', 'one\r\nTWO\nthree\r\nfour\nfive\r\n')]);
    await engine.setBaselineContent('m.txt', 'one\nTWO\nthree\nfour\n', { restoreLineEndings: true });
    const hunks = (await engine.getFileChange('m.txt'))!.hunks;
    expect(hunks.map((h) => [h.oldLines, h.newLines])).toEqual([[[], ['five\r\n']]]);
    await engine.setBaselineContent('m.txt', 'one\nTWO\nthree\nfour\nfive\n', { restoreLineEndings: true });
    expect(engine.listChanges()).toEqual([]);
    expect(ws.read('m.txt')).toBe('one\r\nTWO\nthree\r\nfour\nfive\r\n');
  });

  it('without the option the content is taken as is', async () => {
    const ws = memWorkspace({ 'm.txt': 'a\r\nb\n' });
    const engine = await ws.open();
    await engine.setBaselineContent('m.txt', 'a\nb\n');
    expect(engine.listChanges().map((c) => c.path)).toEqual(['m.txt']);
  });
});

describe('reportUserSave of a mixed-EOL file written back with one EOL (VS Code)', () => {
  it('folds the conversion and the user edit; the agent hunk stays pending', async () => {
    const ws = memWorkspace({ 'm.txt': 'one\r\ntwo\nthree\r\nfour\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('m.txt', 'one\r\nTWO\r\nthree\r\nfour\n')]); // agent: two -> TWO
    // The buffer is LF-normalized; the user edits "four" (offsets in the buffer's text).
    const buffer = 'one\nTWO\nthree\nfour\n';
    const offset = buffer.indexOf('four');
    const saved = 'one\nTWO\nthree\nFOUR\n';
    const r = await engine.reportUserSave('m.txt', saved, { edits: [{ offset, length: 4, text: 'FOUR', origin: 'user' }] });
    expect(r.attribution).toBe('edits'); // the edit log replays: no fallback to "every changed line is the user's"
    await engine.handleFsEvents([ws.write('m.txt', saved)]);
    expect(new TextDecoder().decode(await engine.getBaselineContent('m.txt'))).toBe('one\ntwo\nthree\nFOUR\n');
    expect((await engine.getFileChange('m.txt'))!.hunks.map((h) => [h.oldLines, h.newLines])).toEqual([[['two\n'], ['TWO\n']]]);
  });

  it('a CRLF buffer saving an LF/mixed file works the same way', async () => {
    const ws = memWorkspace({ 'm.txt': 'a\nb\r\nc\n' });
    const engine = await ws.open();
    await engine.handleFsEvents([ws.write('m.txt', 'a\nB\r\nc\n')]);
    await engine.reportUserSave('m.txt', 'a\r\nB\r\nc\r\nd\r\n', { edits: [{ offset: 9, length: 0, text: 'd\r\n', origin: 'user' }] });
    await engine.handleFsEvents([ws.write('m.txt', 'a\r\nB\r\nc\r\nd\r\n')]);
    expect(new TextDecoder().decode(await engine.getBaselineContent('m.txt'))).toBe('a\r\nb\r\nc\r\nd\r\n');
  });
});
