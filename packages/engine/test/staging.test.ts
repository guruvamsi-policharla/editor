import { describe, expect, it } from 'vitest';
import { stagedRegions } from '../src/staging.js';
import { splitLines } from '../src/text.js';

const L = splitLines;

describe('stagedRegions (git add -p)', () => {
  const B = L('a\nb\nc\nd\ne\nf\ng\n');
  const D = L('a\nB\nc\nd\ne\nF\ng\n');

  it('everything staged', () => {
    expect(stagedRegions(B, D, D)).toHaveLength(2);
  });

  it('nothing staged', () => {
    expect(stagedRegions(B, D, B)).toEqual([]);
  });

  it('only the first hunk staged', () => {
    const I = L('a\nB\nc\nd\ne\nf\ng\n');
    expect(stagedRegions(B, D, I)).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
  });

  it('a hunk staged with different content is not staged', () => {
    const I = L('a\nX\nc\nd\ne\nF\ng\n');
    expect(stagedRegions(B, D, I)).toEqual([{ aStart: 5, aEnd: 6, bStart: 5, bEnd: 6 }]);
  });

  it('pure deletions are staged only when the index also lacks the lines', () => {
    const B2 = L('a\nx\nb\n');
    const D2 = L('a\nb\n');
    expect(stagedRegions(B2, D2, D2)).toHaveLength(1);
    expect(stagedRegions(B2, D2, B2)).toHaveLength(0);
  });
});
