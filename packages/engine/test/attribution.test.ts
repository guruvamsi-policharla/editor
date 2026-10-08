import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { foldUserSave, provenanceFromDiff, trackEdits, type EditOrigin, type TrackedEdit } from '../src/attribution.js';
import { computeHunks } from '../src/diff/hunks.js';
import { joinLines, splitLines } from '../src/text.js';

const L = (s: string) => splitLines(s);
const J = (lines: string[]) => joinLines(lines);

function edit(text: string, find: string, replace: string, origin: EditOrigin = 'user'): TrackedEdit {
  const offset = text.indexOf(find);
  if (offset < 0) { throw new Error(`"${find}" not found`); }
  return { offset, length: find.length, text: replace, origin };
}

/** Apply edits sequentially and return the final text. */
function applyEdits(text: string, edits: TrackedEdit[]): string {
  for (const e of edits) { text = text.slice(0, e.offset) + e.text + text.slice(e.offset + e.length); }
  return text;
}

describe('trackEdits', () => {
  it('marks only the touched line as new', () => {
    const d = 'a\nb\nc\n';
    const p = trackEdits(d, [edit(d, 'b', 'B')])!;
    expect(p.lines).toEqual([
      { text: 'a\n', src: 0 },
      { text: 'B\n', src: -1, origin: 'user' },
      { text: 'c\n', src: 2 },
    ]);
    expect([...p.removedBy]).toEqual([[1, 'user']]);
  });

  it('does not mark the following line when inserting a whole line', () => {
    const d = 'a\nb\n';
    const p = trackEdits(d, [{ offset: 2, length: 0, text: 'new\n', origin: 'user' }])!;
    expect(p.lines.map((l) => [l.text, l.src])).toEqual([
      ['a\n', 0],
      ['new\n', -1],
      ['b\n', 1],
    ]);
    expect(p.removedBy.size).toBe(0);
  });

  it('handles appending after a final line without a newline', () => {
    const d = 'a\nb';
    const p = trackEdits(d, [{ offset: 3, length: 0, text: '\nc', origin: 'user' }])!;
    expect(J(p.lines.map((l) => l.text))).toBe('a\nb\nc');
    expect(p.lines.map((l) => l.text)).toEqual(['a\n', 'b\n', 'c']);
  });

  it('keeps user origin when a formatter later touches the same line', () => {
    const d = 'a\nb\n';
    const e1 = edit(d, 'b', 'bb', 'user');
    const t1 = applyEdits(d, [e1]);
    const e2 = edit(t1, 'bb', ' bb', 'formatter');
    const p = trackEdits(d, [e1, e2])!;
    expect(p.lines[1]).toEqual({ text: ' bb\n', src: -1, origin: 'user' });
  });

  it('rejects out-of-range edits', () => {
    expect(trackEdits('abc', [{ offset: 5, length: 0, text: 'x', origin: 'user' }])).toBeUndefined();
    expect(trackEdits('abc', [{ offset: 1, length: 9, text: 'x', origin: 'user' }])).toBeUndefined();
  });

  it('property: replaying random edits reproduces the final text', () => {
    const editArb = fc.record({
      at: fc.nat(),
      len: fc.nat({ max: 6 }),
      text: fc.stringMatching(/^[ab\n]{0,6}$/),
      origin: fc.constantFrom<EditOrigin>('user', 'formatter'),
    });
    fc.assert(
      fc.property(fc.stringMatching(/^[abc\n]{0,30}$/), fc.array(editArb, { maxLength: 10 }), (start, raw) => {
        let text = start;
        const edits: TrackedEdit[] = [];
        for (const r of raw) {
          const offset = text.length === 0 ? 0 : r.at % (text.length + 1);
          const length = Math.min(r.len, text.length - offset);
          const e = { offset, length, text: r.text, origin: r.origin };
          edits.push(e);
          text = applyEdits(text, [e]);
        }
        const p = trackEdits(start, edits)!;
        expect(J(p.lines.map((l) => l.text))).toBe(text);
        expect(p.lines.map((l) => l.text)).toEqual(splitLines(text));
        // Unchanged lines really are copies of the disk lines they claim to be, in order.
        const d = splitLines(start);
        let last = -1;
        for (const l of p.lines) {
          if (l.src < 0) { continue; }
          expect(l.text).toBe(d[l.src]);
          expect(l.src).toBeGreaterThan(last);
          expect(p.removedBy.has(l.src)).toBe(false);
          last = l.src;
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('foldUserSave', () => {
  it('folds the user edit and keeps an untouched agent addition pending', () => {
    const B = L('c1\nc2\n');
    const D = L('c1\nagent\nc2\n');
    const S = 'c1 edited\nagent\nc2\n';
    const next = foldUserSave(B, D, trackEdits(J(D), [edit(J(D), 'c1', 'c1 edited')])!);
    expect(J(next)).toBe('c1 edited\nc2\n');
    expect(computeHunks(next, L(S)).map((h) => h.newLines)).toEqual([['agent\n']]);
  });

  it("the user's edit wins when they rewrite the agent's whole hunk", () => {
    const B = L('x\n');
    const D = L('agent\n');
    const next = foldUserSave(B, D, trackEdits(J(D), [edit(J(D), 'agent', 'mine')])!);
    expect(J(next)).toBe('mine\n');
  });

  it('a partly edited hunk shrinks to its untouched lines', () => {
    const B = L('x\n');
    const D = L('a1\na2\na3\n');
    const S = 'a1\nmine\na3\n';
    const next = foldUserSave(B, D, trackEdits(J(D), [edit(J(D), 'a2', 'mine')])!);
    expect(J(next)).toBe('x\nmine\n');
    const pending = computeHunks(next, L(S));
    expect(pending.map((h) => [h.oldLines, h.newLines])).toEqual([
      [['x\n'], ['a1\n']],
      [[], ['a3\n']],
    ]);
  });

  it('formatter changes inside an agent hunk stay pending', () => {
    const B = L('c1\nc2\n');
    const D = L('c1\nagent(  )\nc2\n');
    const next = foldUserSave(B, D, trackEdits(J(D), [edit(J(D), 'agent(  )', 'agent()', 'formatter')])!);
    expect(J(next)).toBe('c1\nc2\n');
  });

  it('formatter changes outside agent hunks fold into the baseline', () => {
    const B = L('c1  \nc2\nc3\n');
    const D = L('c1  \nc2\nagent\nc3\n');
    const next = foldUserSave(B, D, trackEdits(J(D), [edit(J(D), 'c1  ', 'c1', 'formatter')])!);
    expect(J(next)).toBe('c1\nc2\nc3\n');
  });

  it('a formatter rewriting a contiguous run of lines folds each line on its own (whole-file format on save)', () => {
    // Agent changed b; the user edited a; format on save then normalizes every line, all adjacent.
    const B = L('a=1\nb=2\nc=3\n');
    const D = L('a=1\nb=20\nc=3\nd=4\n');
    let text = J(D);
    const edits: TrackedEdit[] = [];
    const apply = (from: string, to: string, origin: EditOrigin) => {
      const e = edit(text, from, to, origin);
      edits.push(e);
      text = applyEdits(text, [e]);
    };
    apply('a=1', 'a=10', 'user');
    for (const [from, to] of [['a=10', 'a = 10'], ['b=20', 'b = 20'], ['c=3', 'c = 3'], ['d=4', 'd = 4']] as const) { apply(from, to, 'formatter'); }
    expect(text).toBe('a = 10\nb = 20\nc = 3\nd = 4\n');
    const next = foldUserSave(B, D, trackEdits(J(D), edits)!);
    // User line (formatted) and the formatted common line fold in; the agent's lines stay pending, formatted.
    expect(J(next)).toBe('a = 10\nb=2\nc = 3\n');
    expect(computeHunks(next, L(text)).map((h) => [h.oldLines, h.newLines])).toEqual([
      [['b=2\n'], ['b = 20\n']],
      [[], ['d = 4\n']],
    ]);
  });

  it('a formatter removing common lines inside an agent hunk keeps them in the baseline', () => {
    const B = L('c1\nold\nc2\n');
    const D = L('c1\na1\nold\na2\nc2\n');
    const d = J(D);
    const e = { offset: d.indexOf('a1'), length: 'a1\nold\na2\n'.length, text: 'formatted\n', origin: 'formatter' as const };
    const next = foldUserSave(B, D, trackEdits(d, [e])!);
    expect(J(next)).toBe('c1\nold\nc2\n');
  });

  it('agent deletions stay pending unless the hunk is resolved', () => {
    const B = L('keep\ndel1\ndel2\nkeep2\n');
    const D = L('keep\nkeep2 edited by user?\n'.replace(' edited by user?', ''));
    // D deleted del1, del2. The user edits "keep".
    const next = foldUserSave(B, D, trackEdits(J(D), [edit(J(D), 'keep\n', 'KEEP\n')])!);
    expect(J(next)).toBe('KEEP\ndel1\ndel2\nkeep2\n');
  });

  it('with no agent changes, a user save makes the baseline equal the saved content', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[abc\n]{0,40}$/), fc.stringMatching(/^[abc\n]{0,40}$/), (d, s) => {
        const next = foldUserSave(L(d), L(d), provenanceFromDiff(d, s));
        expect(J(next)).toBe(s);
      }),
      { numRuns: 300 },
    );
  });

  it('an empty save provenance (nothing edited) leaves the baseline unchanged', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[abc\n]{0,40}$/), fc.stringMatching(/^[abc\n]{0,40}$/), (b, d) => {
        const next = foldUserSave(L(b), L(d), provenanceFromDiff(d, d));
        expect(J(next)).toBe(b);
      }),
      { numRuns: 300 },
    );
  });

  /**
   * Property: format on save over adjacent lines (no anchors in between). The user edits some lines, then a
   * formatter rewrites lines one for one, in any mix with agent lines. Each line folds on its own.
   */
  type Line = 'same' | 'fmtOutside' | 'agent' | 'fmtInside' | 'user' | 'userFmt';
  it('property: line-for-line formatter passes over adjacent agent and common lines fold per line', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom<Line>('same', 'fmtOutside', 'agent', 'fmtInside', 'user', 'userFmt'), { minLength: 1, maxLength: 12 }), (lines) => {
        const B: string[] = [];
        const D: string[] = [];
        const expected: string[] = [];
        const userEdits: [string, string][] = [];
        const fmtEdits: [string, string][] = [];
        lines.forEach((kind, i) => {
          const c = `common${i}\n`;
          if (kind === 'agent' || kind === 'fmtInside') {
            B.push(`old${i}\n`); D.push(`agent${i}\n`); expected.push(`old${i}\n`);
            if (kind === 'fmtInside') { fmtEdits.push([`agent${i}\n`, `agentfmt${i}\n`]); }
            return;
          }
          B.push(c); D.push(c);
          if (kind === 'same') { expected.push(c); }
          if (kind === 'fmtOutside') { expected.push(`fmt${i}\n`); fmtEdits.push([c, `fmt${i}\n`]); }
          if (kind === 'user') { expected.push(`user${i}\n`); userEdits.push([c, `user${i}\n`]); }
          if (kind === 'userFmt') { expected.push(`userfmt${i}\n`); userEdits.push([c, `user${i}\n`]); fmtEdits.push([`user${i}\n`, `userfmt${i}\n`]); }
        });
        let text = J(D);
        const tracked: TrackedEdit[] = [];
        const run = (pairs: [string, string][], origin: EditOrigin) => {
          for (const [from, to] of pairs) {
            const e = edit(text, from, to, origin);
            tracked.push(e);
            text = applyEdits(text, [e]);
          }
        };
        run(userEdits, 'user'); // typing first, then format on save
        run(fmtEdits, 'formatter');
        expect(J(foldUserSave(B, D, trackEdits(J(D), tracked)!))).toBe(J(expected));
      }),
      { numRuns: 500 },
    );
  });

  /**
   * Structured property: a file made of independent blocks separated by unique anchor lines.
   * Each block is untouched, agent-only, user-only (outside agent hunks), formatter-only outside,
   * formatter inside an agent hunk, or a partial user edit of an agent addition. The fold must
   * produce exactly the expected baseline, and what remains pending must be exactly the agent's work.
   */
  type Block = 'same' | 'agent' | 'user' | 'fmtOutside' | 'fmtInside' | 'partial' | 'agentDelete' | 'userThenDelete';
  it('property: block-structured saves fold exactly the right lines', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<Block>('same', 'agent', 'user', 'fmtOutside', 'fmtInside', 'partial', 'agentDelete', 'userThenDelete'), { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        (blocks, useDiffAttribution) => {
          const B: string[] = [];
          const D: string[] = [];
          const expected: string[] = [];
          const saved: string[] = [];
          const edits: { block: number; from: string; to: string; origin: EditOrigin }[] = [];
          blocks.forEach((kind, i) => {
            const anchor = `anchor${i}\n`;
            B.push(anchor);
            D.push(anchor);
            expected.push(anchor);
            saved.push(anchor);
            const c = `common${i}\n`;
            switch (kind) {
              case 'same':
                B.push(c); D.push(c); expected.push(c); saved.push(c);
                break;
              case 'agent':
                B.push(`old${i}\n`); D.push(`agent${i}\n`); expected.push(`old${i}\n`); saved.push(`agent${i}\n`);
                break;
              case 'user':
                B.push(c); D.push(c); expected.push(`user${i}\n`); saved.push(`user${i}\n`);
                edits.push({ block: i, from: c, to: `user${i}\n`, origin: 'user' });
                break;
              case 'fmtOutside':
                B.push(c); D.push(c); expected.push(`fmt${i}\n`); saved.push(`fmt${i}\n`);
                edits.push({ block: i, from: c, to: `fmt${i}\n`, origin: 'formatter' });
                break;
              case 'fmtInside':
                B.push(`old${i}\n`); D.push(`agent${i}\n`); expected.push(`old${i}\n`); saved.push(`agentfmt${i}\n`);
                edits.push({ block: i, from: `agent${i}\n`, to: `agentfmt${i}\n`, origin: 'formatter' });
                break;
              case 'partial':
                // Pure agent addition of three lines; the user rewrites the middle one.
                D.push(`add${i}a\n`, `add${i}b\n`, `add${i}c\n`);
                expected.push(`mine${i}\n`);
                saved.push(`add${i}a\n`, `mine${i}\n`, `add${i}c\n`);
                edits.push({ block: i, from: `add${i}b\n`, to: `mine${i}\n`, origin: 'user' });
                break;
              case 'agentDelete':
                B.push(`gone${i}\n`); expected.push(`gone${i}\n`);
                break;
              case 'userThenDelete':
                // The user edits a common line that sits right before an agent deletion.
                B.push(c, `gone${i}\n`); D.push(c); expected.push(`user${i}\n`, `gone${i}\n`); saved.push(`user${i}\n`);
                edits.push({ block: i, from: c, to: `user${i}\n`, origin: 'user' });
                break;
            }
          });
          const d = J(D);
          let text = d;
          const tracked: TrackedEdit[] = [];
          for (const e of edits) {
            const offset = text.indexOf(e.from);
            const t = { offset, length: e.from.length, text: e.to, origin: e.origin };
            tracked.push(t);
            text = applyEdits(text, [t]);
          }
          expect(text).toBe(J(saved));
          const hasFormatter = blocks.some((b) => b === 'fmtInside' || b === 'fmtOutside');
          if (useDiffAttribution && hasFormatter) { return; } // diff attribution can't tell formatter from user
          const prov = useDiffAttribution ? provenanceFromDiff(d, text) : trackEdits(d, tracked)!;
          const next = foldUserSave(B, D, prov);
          expect(J(next)).toBe(J(expected));
        },
      ),
      { numRuns: 400 },
    );
  });
});
