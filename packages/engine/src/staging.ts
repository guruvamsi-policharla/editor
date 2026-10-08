/**
 * Partial staging (`git add -p`): which pending hunks did the user stage?
 *
 * A pending hunk (baseline B -> disk D) counts as staged when the index
 * content I agrees with D over the hunk's whole range, i.e. no change between
 * I and D overlaps or touches it. Anything ambiguous counts as *not* staged,
 * so a staged-file check can only ever accept less than was staged, never more.
 */
import { diffRegions, type Region } from './diff/myers.js';

export function stagedRegions(baseline: readonly string[], disk: readonly string[], index: readonly string[]): Region[] {
  const pending = diffRegions(baseline, disk);
  if (pending.length === 0) { return []; }
  const unstaged = diffRegions(index, disk); // a = index, b = disk
  return pending.filter((h) => {
    const d0 = h.bStart;
    const d1 = h.bEnd;
    for (const r of unstaged) {
      const hasDiskLines = r.bEnd > r.bStart;
      const hasIndexLines = r.aEnd > r.aStart;
      if (hasDiskLines && r.bStart < d1 && d0 < r.bEnd) { return false; } // overlaps hunk lines
      if (hasIndexLines && r.bStart <= d1 && d0 <= r.bEnd) { return false; } // index-only lines inside/at the edge
      if (d0 === d1 && r.bStart <= d0 && d0 <= r.bEnd) { return false; } // pure deletion touched by any change
    }
    return true;
  });
}
