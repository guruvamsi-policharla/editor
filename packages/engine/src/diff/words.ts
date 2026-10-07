/**
 * Word-level highlighting inside a line-sized hunk.
 *
 * Tokens are runs of letters/digits/underscore, runs of horizontal whitespace,
 * single line breaks, and single punctuation characters. Changed tokens are
 * reported as per-line column ranges (never spanning a line break) so a host
 * can decorate them directly.
 */
import { diffRegions } from './myers.js';

export interface InlineRange {
  /** 0-based line number in that side's file (baseline for `old`, disk for `new`). */
  line: number;
  /** 0-based UTF-16 column, inclusive. */
  start: number;
  /** 0-based UTF-16 column, exclusive. */
  end: number;
}

export interface WordDiff {
  old: InlineRange[];
  new: InlineRange[];
}

const TOKEN_RE = /\r\n|\n|\r|[\p{L}\p{N}_]+|[^\S\r\n]+|[^\p{L}\p{N}_\s]/gu;
/** Above this many tokens per side, skip token diffing and highlight whole lines. */
const MAX_TOKENS = 20_000;

export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

export function wordDiff(oldLines: readonly string[], oldStart: number, newLines: readonly string[], newStart: number): WordDiff {
  const oldTokens = tokenize(oldLines.join(''));
  const newTokens = tokenize(newLines.join(''));
  if (oldTokens.length > MAX_TOKENS || newTokens.length > MAX_TOKENS) {
    return { old: wholeLines(oldLines, oldStart), new: wholeLines(newLines, newStart) };
  }
  const regions = diffRegions(oldTokens, newTokens);
  const oldChanged = new Uint8Array(oldTokens.length);
  const newChanged = new Uint8Array(newTokens.length);
  for (const r of regions) {
    oldChanged.fill(1, r.aStart, r.aEnd);
    newChanged.fill(1, r.bStart, r.bEnd);
  }
  return { old: toRanges(oldTokens, oldChanged, oldStart), new: toRanges(newTokens, newChanged, newStart) };
}

/** Line breaks as `splitLines` sees them; a lone CR stays inside its line. */
function isBreak(tok: string): boolean {
  return tok === '\n' || tok === '\r\n';
}

function toRanges(tokens: readonly string[], changed: Uint8Array, firstLine: number): InlineRange[] {
  const out: InlineRange[] = [];
  let line = firstLine;
  let col = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (isBreak(tok)) {
      line++;
      col = 0;
      continue;
    }
    const start = col;
    col += tok.length;
    if (!changed[i]) continue;
    const last = out[out.length - 1];
    if (last && last.line === line && last.end === start) last.end = col;
    else out.push({ line, start, end: col });
  }
  return out;
}

function wholeLines(lines: readonly string[], firstLine: number): InlineRange[] {
  return lines.map((l, i) => ({ line: firstLine + i, start: 0, end: l.replace(/\r?\n$/, '').length }));
}
