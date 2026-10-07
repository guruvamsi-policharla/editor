/**
 * Line-sized hunks between the accepted baseline and the disk content.
 *
 * A hunk is a maximal run of changed lines; no context lines are merged in, so
 * two changes separated by a single unchanged line are two hunks that can be
 * accepted or rejected independently.
 */
import { createHash } from 'node:crypto';
import { applyRegions, diffRegions, revertRegions, type Region } from './myers.js';
import { wordDiff, type WordDiff } from './words.js';

export interface Hunk {
  /** Stable while neither side changes; pass it back to accept/reject. */
  id: string;
  /** 0-based first line in the baseline. For pure insertions, the line the insertion sits before. */
  oldStart: number;
  /** Removed baseline lines, with line terminators. */
  oldLines: string[];
  /** 0-based first line on disk. For pure deletions, the line the deletion sits before. */
  newStart: number;
  /** Added disk lines, with line terminators. */
  newLines: string[];
  /** Word-level highlight ranges inside the hunk. */
  words: WordDiff;
}

export function hunkId(region: Region, oldLines: readonly string[], newLines: readonly string[]): string {
  const h = createHash('sha1');
  h.update(`${region.aStart}:${region.bStart}:`);
  for (let i = region.aStart; i < region.aEnd; i++) h.update(oldLines[i]!);
  h.update('\0');
  for (let j = region.bStart; j < region.bEnd; j++) h.update(newLines[j]!);
  return h.digest('hex').slice(0, 16);
}

export interface HunkOptions {
  /** Skip word-level highlighting (cheaper when only ids/ranges are needed). */
  words?: boolean;
}

export function computeHunks(oldLines: readonly string[], newLines: readonly string[], options: HunkOptions = {}): Hunk[] {
  return regionsToHunks(diffRegions(oldLines, newLines), oldLines, newLines, options);
}

export function regionsToHunks(
  regions: readonly Region[],
  oldLines: readonly string[],
  newLines: readonly string[],
  options: HunkOptions = {},
): Hunk[] {
  return regions.map((r) => {
    const o = oldLines.slice(r.aStart, r.aEnd);
    const n = newLines.slice(r.bStart, r.bEnd);
    return {
      id: hunkId(r, oldLines, newLines),
      oldStart: r.aStart,
      oldLines: o,
      newStart: r.bStart,
      newLines: n,
      words: options.words === false ? { old: [], new: [] } : wordDiff(o, r.aStart, n, r.bStart),
    };
  });
}

export function hunkRegion(h: Pick<Hunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>): Region {
  return { aStart: h.oldStart, aEnd: h.oldStart + h.oldLines.length, bStart: h.newStart, bEnd: h.newStart + h.newLines.length };
}

/** New baseline after accepting the given hunks (fold disk's side into the baseline). */
export function acceptHunks(oldLines: readonly string[], newLines: readonly string[], hunks: readonly Region[]): string[] {
  return applyRegions(oldLines, newLines, sortRegions(hunks));
}

/** New disk content after rejecting the given hunks (write the baseline's side back). */
export function rejectHunks(oldLines: readonly string[], newLines: readonly string[], hunks: readonly Region[]): string[] {
  return revertRegions(oldLines, newLines, sortRegions(hunks));
}

function sortRegions(regions: readonly Region[]): Region[] {
  return [...regions].sort((x, y) => x.aStart - y.aStart || x.bStart - y.bStart);
}
