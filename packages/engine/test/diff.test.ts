import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyRegions, diffRegions, revertRegions } from '../src/diff/myers.js';
import { acceptHunks, computeHunks, hunkRegion, rejectHunks } from '../src/diff/hunks.js';
import { tokenize, wordDiff } from '../src/diff/words.js';
import { joinLines, splitLines } from '../src/text.js';

const smallAlphabet = fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { maxLength: 40 });

describe('myers diffRegions', () => {
  it('returns nothing for equal inputs', () => {
    expect(diffRegions(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('finds a single replacement', () => {
    expect(diffRegions(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
  });

  it('finds pure insertions and deletions', () => {
    expect(diffRegions(['a', 'c'], ['a', 'b', 'c'])).toEqual([{ aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 }]);
    expect(diffRegions(['a', 'b', 'c'], ['a', 'c'])).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 }]);
    expect(diffRegions([], ['x'])).toEqual([{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 1 }]);
  });

  it('separates changes split by an equal line', () => {
    const r = diffRegions(['a', 'b', 'c'], ['x', 'b', 'y']);
    expect(r).toHaveLength(2);
  });

  it('falls back to one region when the edit distance cap is exceeded', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    expect(diffRegions(a, b, { maxEditDistance: 5 })).toEqual([{ aStart: 0, aEnd: 50, bStart: 0, bEnd: 50 }]);
  });

  it('property: applying all regions to a yields b, reverting all in b yields a', () => {
    fc.assert(
      fc.property(smallAlphabet, smallAlphabet, (a, b) => {
        const regions = diffRegions(a, b);
        expect(applyRegions(a, b, regions)).toEqual(b);
        expect(revertRegions(a, b, regions)).toEqual(a);
      }),
      { numRuns: 500 },
    );
  });

  it('property: regions are sorted, non-adjacent, and everything between them is equal', () => {
    fc.assert(
      fc.property(smallAlphabet, smallAlphabet, (a, b) => {
        const regions = diffRegions(a, b);
        let ai = 0;
        let bi = 0;
        for (const r of regions) {
          expect(r.aStart - ai).toBe(r.bStart - bi);
          for (let k = 0; k < r.aStart - ai; k++) { expect(a[ai + k]).toBe(b[bi + k]); }
          expect(r.aEnd > r.aStart || r.bEnd > r.bStart).toBe(true);
          if (ai > 0 || bi > 0) { expect(r.aStart > ai || ai === 0).toBe(true); }
          ai = r.aEnd;
          bi = r.bEnd;
        }
        expect(a.length - ai).toBe(b.length - bi);
        for (let i = 1; i < regions.length; i++) {
          expect(regions[i]!.aStart).toBeGreaterThan(regions[i - 1]!.aEnd);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('is minimal on simple cases (LCS-length check)', () => {
    fc.assert(
      fc.property(smallAlphabet, smallAlphabet, (a, b) => {
        const regions = diffRegions(a, b);
        const changed = regions.reduce((n, r) => n + (r.aEnd - r.aStart) + (r.bEnd - r.bStart), 0);
        expect(changed).toBe(a.length + b.length - 2 * lcs(a, b));
      }),
      { numRuns: 300 },
    );
  });
});

function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    { for (let j = 1; j <= b.length; j++)
      { dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!); } }
  return dp[a.length]![b.length]!;
}

describe('splitLines', () => {
  it('keeps terminators and round-trips', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\n')).toEqual(['a\n']);
    expect(splitLines('a\r\nb\nc')).toEqual(['a\r\n', 'b\n', 'c']);
    fc.assert(fc.property(fc.string(), (s) => joinLines(splitLines(s)) === s));
  });
});

describe('hunks', () => {
  const B = splitLines('one\ntwo\nthree\nfour\nfive\n');
  const D = splitLines('one\nTWO\nthree\nfour\nfive\nsix\n');

  it('are line-sized with no context merging', () => {
    const hunks = computeHunks(B, D);
    expect(hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, ['two\n'], 1, ['TWO\n']],
      [5, [], 5, ['six\n']],
    ]);
  });

  it('have stable, distinct ids', () => {
    const a = computeHunks(B, D);
    const b = computeHunks(B, D);
    expect(a.map((h) => h.id)).toEqual(b.map((h) => h.id));
    expect(new Set(a.map((h) => h.id)).size).toBe(a.length);
  });

  it('accept/reject a single hunk', () => {
    const [h1] = computeHunks(B, D);
    expect(joinLines(acceptHunks(B, D, [hunkRegion(h1!)]))).toBe('one\nTWO\nthree\nfour\nfive\n');
    expect(joinLines(rejectHunks(B, D, [hunkRegion(h1!)]))).toBe('one\ntwo\nthree\nfour\nfive\nsix\n');
  });

  it('property: accepting every hunk yields disk; rejecting every hunk yields baseline', () => {
    const lines = fc.array(fc.constantFrom('a\n', 'b\n', 'c\n', 'd\n', 'e'), { maxLength: 30 });
    fc.assert(
      fc.property(lines, lines, fc.array(fc.boolean(), { maxLength: 30 }), (b, d, picks) => {
        const hunks = computeHunks(b, d, { words: false });
        expect(acceptHunks(b, d, hunks.map(hunkRegion))).toEqual(d);
        expect(rejectHunks(b, d, hunks.map(hunkRegion))).toEqual(b);
        // Accepting a subset then rejecting the rest also converges.
        const chosen = hunks.filter((_, i) => picks[i]);
        const b2 = acceptHunks(b, d, chosen.map(hunkRegion));
        const rest = computeHunks(b2, d, { words: false });
        expect(rejectHunks(b2, d, rest.map(hunkRegion))).toEqual(b2);
      }),
      { numRuns: 400 },
    );
  });
});

describe('word-level highlighting', () => {
  it('tokenizes words, spaces, punctuation and breaks', () => {
    expect(tokenize('Hello, world!\n')).toEqual(['Hello', ',', ' ', 'world', '!', '\n']);
    expect(tokenize('naïve café 42')).toEqual(['naïve', ' ', 'café', ' ', '42']);
  });

  it('highlights only the changed words inside a line', () => {
    const w = wordDiff(['The quick brown fox.\n'], 3, ['The slow brown fox.\n'], 7);
    expect(w.old).toEqual([{ line: 3, start: 4, end: 9 }]);
    expect(w.new).toEqual([{ line: 7, start: 4, end: 8 }]);
  });

  it('reports ranges per line across multi-line hunks', () => {
    const w = wordDiff(['a b\n', 'c d\n'], 0, ['a X\n', 'Y d\n'], 0);
    expect(w.new).toEqual([
      { line: 0, start: 2, end: 3 },
      { line: 1, start: 0, end: 1 },
    ]);
  });

  it('highlights whole lines for pure insertions', () => {
    const w = wordDiff([], 0, ['new line\n'], 4);
    expect(w.old).toEqual([]);
    expect(w.new).toEqual([{ line: 4, start: 0, end: 8 }]);
  });
});
