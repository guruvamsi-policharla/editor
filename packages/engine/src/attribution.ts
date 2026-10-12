/**
 * Change attribution for user saves.
 *
 * The host reports a save as the content it is about to write plus, ideally,
 * the ordered list of buffer edits since the last disk sync, each tagged with
 * its origin:
 *
 *  - 'user': the user's own buffer edits (typing, paste, undo/redo, rename-symbol...)
 *  - 'formatter': editor-triggered formatting (format-on-save, format document, code actions on save)
 *
 * From that we derive, for every line of the saved content, whether it is an
 * untouched disk line or a new line (and who wrote it), then fold only the
 * right lines into the baseline (`foldUserSave`). Saving never accepts any
 * part of an agent's change (Guru, Oct 12 2026: "I will make multiple
 * iterations when I save"):
 *
 *  - edits outside pending agent hunks fold into the baseline
 *  - edits inside or touching a pending agent hunk (the user's or a
 *    formatter's) keep the whole hunk pending: the baseline keeps the hunk's
 *    accepted lines, so the hunk shows them against the agent's text with the
 *    user's edits in it, until Keep or Undo
 */
import { diffRegions } from './diff/myers.js';
import { joinLines, splitLines } from './text.js';

export type EditOrigin = 'user' | 'formatter';

/** One buffer edit. Offsets are UTF-16 code units into the text *after* all previous edits. */
export interface TrackedEdit {
  offset: number;
  length: number;
  text: string;
  origin: EditOrigin;
}

export interface SavedLine {
  text: string;
  /** Index of the disk line this is an unchanged copy of, or -1 for a new line. */
  src: number;
  /** Who wrote a new line. Undefined for unchanged disk lines. */
  origin?: EditOrigin;
  /** A formatter's line that contains words from an agent-added line: never folded into the baseline on its own. */
  agentText?: boolean;
  /**
   * A formatter's line with words from other lines than the one it replaces (a reflow moved words across lines), so
   * it can't stand in for that line alone.
   */
  moved?: boolean;
  /**
   * Not in the saved content: a line the user typed outside the agent's hunks, before format on save mixed it into
   * agent text, that goes into the baseline in its place (see addFormatterPass).
   */
  ghost?: boolean;
  /**
   * For a line the user wrote: whether they wrote it inside or touching an agent hunk (then it stays pending with the
   * hunk) or outside every hunk (then it folds in, even where format on save moved it next to agent lines). Unset:
   * decided by where the line is in the saved content.
   */
  insideAgent?: boolean;
}

export interface Provenance {
  lines: SavedLine[];
  /** Disk lines that were removed, and by whom. */
  removedBy: Map<number, EditOrigin>;
  /**
   * Disk lines the user removed inside or touching an agent hunk (they stay in the baseline, pending with it), when
   * decided before format on save (see `markInsideAgent`). Unset: decided by where the removal is.
   */
  removedInsideAgent?: Set<number>;
}

/** Attribute every changed line of `saved` to a single origin by diffing it against `disk`. */
export function provenanceFromDiff(disk: string, saved: string, origin: EditOrigin = 'user'): Provenance {
  const d = splitLines(disk);
  const s = splitLines(saved);
  const lines: SavedLine[] = [];
  const removedBy = new Map<number, EditOrigin>();
  let di = 0;
  let si = 0;
  const pushEqualUntil = (dEnd: number) => {
    while (di < dEnd) { lines.push({ text: s[si++]!, src: di++ }); }
  };
  for (const r of diffRegions(d, s)) {
    pushEqualUntil(r.aStart);
    for (let i = r.aStart; i < r.aEnd; i++) { removedBy.set(i, origin); }
    for (let j = r.bStart; j < r.bEnd; j++) { lines.push({ text: s[j]!, src: -1, origin }); }
    di = r.aEnd;
    si = r.bEnd;
  }
  pushEqualUntil(d.length);
  return { lines, removedBy };
}

/**
 * Replay tagged edits over `disk`, tracking per-line provenance. Returns
 * undefined if an edit is out of range (the host's edit log doesn't match).
 */
export function trackEdits(disk: string, edits: readonly TrackedEdit[]): Provenance | undefined {
  let lines: SavedLine[] = splitLines(disk).map((text, i) => ({ text, src: i }));
  const removedBy = new Map<number, EditOrigin>();

  for (const edit of edits) {
    const { offset, length, text, origin } = edit;
    if (offset < 0 || length < 0 || !Number.isInteger(offset) || !Number.isInteger(length)) { return undefined; }
    const end = offset + length;

    // Locate the window of lines [i, k) touched by [offset, end].
    let total = 0;
    let i = -1;
    let k = -1;
    let windowStart = 0;
    for (let li = 0; li < lines.length; li++) {
      const len = lines[li]!.text.length;
      if (i < 0 && offset < total + len) {
        i = li;
        windowStart = total;
      }
      if (i >= 0 && end < total + len) {
        k = li + 1;
        break;
      }
      total += len;
    }
    if (i < 0) {
      // Edit starts at end of document.
      for (let li = 0; li < lines.length; li++) { windowStart += lines[li]!.text.length; }
      if (offset !== windowStart) { return undefined; }
      if (end !== offset) { return undefined; }
      i = lines.length;
      k = lines.length;
      // Appending after a last line with no terminator extends that line.
      const last = lines[lines.length - 1];
      if (last && !last.text.endsWith('\n')) {
        i--;
        windowStart -= last.text.length;
      }
    } else if (k < 0) {
      // Edit runs to end of document.
      if (end !== total) { return undefined; }
      k = lines.length;
    }

    const oldWindow = lines.slice(i, k);
    const windowText = joinLines(oldWindow.map((l) => l.text));
    const ls = offset - windowStart;
    const le = end - windowStart;
    const newTexts = splitLines(windowText.slice(0, ls) + text + windowText.slice(le));

    // Keep lines whose text didn't change at either edge of the window.
    let pre = 0;
    while (pre < oldWindow.length && pre < newTexts.length && oldWindow[pre]!.text === newTexts[pre]) { pre++; }
    let suf = 0;
    while (
      suf < oldWindow.length - pre &&
      suf < newTexts.length - pre &&
      oldWindow[oldWindow.length - 1 - suf]!.text === newTexts[newTexts.length - 1 - suf]
    ) {
      suf++;
    }
    const oldMid = oldWindow.slice(pre, oldWindow.length - suf);
    const newMid = newTexts.slice(pre, newTexts.length - suf);

    for (const l of oldMid) { if (l.src >= 0) { removedBy.set(l.src, origin); } }
    const paired = oldMid.length === newMid.length;
    const replacement: SavedLine[] = newMid.map((t, idx) => {
      // A line the user already rewrote stays the user's even if a formatter touches it again.
      const prev = paired ? oldMid[idx] : undefined;
      const lineOrigin: EditOrigin = origin === 'user' || prev?.origin === 'user' ? 'user' : 'formatter';
      return { text: t, src: -1, origin: lineOrigin };
    });

    lines = [
      ...lines.slice(0, i),
      ...oldWindow.slice(0, pre),
      ...replacement,
      ...oldWindow.slice(oldWindow.length - suf),
      ...lines.slice(k),
    ];
  }
  return { lines, removedBy };
}

/** Non-whitespace tokens of a line: runs of letters/digits/underscore, and single other characters. */
const WORD_RE = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu;
/** Above this many tokens in one changed region, new lines aren't traced to their words (they count as the formatter's). */
const MAX_REGION_TOKENS = 20_000;

/**
 * Add a formatter pass to the provenance of the user's text: `saved` is `userText` after format on save (or any
 * edits the editor made while saving). The formatter's changes are found by diffing, so this doesn't depend on an
 * edit log: unchanged lines keep their provenance, and removed disk lines count as removed by the formatter (unless
 * the user removed them first).
 *
 * Lines the user wrote keep `insideAgent` (set by the host of the user pass, see `linesInsideAgent`): a formatted line
 * made of words the user typed inside an agent hunk stays pending with it, one made only of words typed outside folds
 * in, and only lines typed outside get ghosts.
 *
 * Each new line is traced to the words it is made of (a word-level diff of the changed region): a formatter only
 * moves words around. A line with any word from an agent-added disk line (`isAgentLine`) is the formatter's and
 * carries agent text, so it stays pending as part of the agent's change. A line made of the user's words (and
 * maybe unchanged lines' words) is the user's: format on save reflowing a line the user typed next to an agent
 * hunk folds in, instead of becoming part of the agent's change, which Undo would remove. Any other line (only
 * unchanged lines' words, or only the formatter's punctuation) is the formatter's. A word the trace can't find in
 * the changed region's old lines (moved across an unchanged line) counts as possibly the agent's.
 */
export function addFormatterPass(user: Provenance, userText: string, saved: string, isAgentLine: (diskLine: number) => boolean = () => false): Provenance {
  if (userText === saved) { return user; }
  const u = splitLines(userText);
  const s = splitLines(saved);
  const lines: SavedLine[] = [];
  const removedBy = new Map(user.removedBy);
  let ui = 0;
  let si = 0;
  const pushEqualUntil = (uEnd: number) => {
    while (ui < uEnd) {
      lines.push({ ...user.lines[ui++]!, text: s[si++]! });
    }
  };
  for (const r of diffRegions(u, s)) {
    pushEqualUntil(r.aStart);
    for (let i = r.aStart; i < r.aEnd; i++) {
      const src = user.lines[i]!.src;
      if (src >= 0 && !removedBy.has(src)) { removedBy.set(src, 'formatter'); }
    }
    // Where each word of the new lines came from: 'agent', 'user' or 'common' (an unchanged disk line).
    const kindOf = (i: number): 'agent' | 'user' | 'common' => {
      const l = user.lines[i]!;
      if (l.src < 0) { return l.origin === 'user' ? 'user' : 'common'; }
      return isAgentLine(l.src) ? 'agent' : 'common';
    };
    const oldWords: { word: string; kind: 'agent' | 'user' | 'common'; line: number }[] = [];
    for (let i = r.aStart; i < r.aEnd; i++) { for (const w of u[i]!.match(WORD_RE) ?? []) { oldWords.push({ word: w, kind: kindOf(i), line: i }); } }
    const paired = r.aEnd - r.aStart === r.bEnd - r.bStart;
    const moved = new Set<number>();
    /** New lines with a (letter/digit) word of the user's. */
    const userWords = new Set<number>();
    /** New lines with a word the user typed inside an agent hunk. */
    const userWordsInside = new Set<number>();
    const newWords: { word: string; line: number }[] = [];
    for (let j = r.bStart; j < r.bEnd; j++) { for (const w of s[j]!.match(WORD_RE) ?? []) { newWords.push({ word: w, line: j }); } }
    const found = new Map<number, Set<string>>();
    if (oldWords.length + newWords.length <= MAX_REGION_TOKENS) {
      let oi = 0;
      let ni = 0;
      const matchUntil = (oEnd: number) => {
        while (oi < oEnd) {
          const line = newWords[ni++]!.line;
          const kinds = found.get(line) ?? new Set<string>();
          if (!paired || oldWords[oi]!.line - r.aStart !== line - r.bStart) { moved.add(line); }
          if (oldWords[oi]!.kind === 'user' && /[\p{L}\p{N}]/u.test(oldWords[oi]!.word)) { userWords.add(line); }
          if (oldWords[oi]!.kind === 'user' && user.lines[oldWords[oi]!.line]!.insideAgent === true) { userWordsInside.add(line); }
          kinds.add(oldWords[oi++]!.kind);
          if (!found.has(line)) { found.set(line, kinds); }
        }
      };
      for (const w of diffRegions(oldWords.map((x) => x.word), newWords.map((x) => x.word))) {
        matchUntil(w.aStart);
        // A word that isn't in the region's old lines was moved here from elsewhere (formatters add whitespace and
        // punctuation, not words): it may be the agent's.
        for (let k = w.bStart; k < w.bEnd; k++) {
          if (/[\p{L}\p{N}]/u.test(newWords[k]!.word)) {
            found.set(newWords[k]!.line, new Set(['agent']));
            moved.add(newWords[k]!.line);
          }
        }
        oi = w.aEnd;
        ni = w.bEnd;
      }
      matchUntil(oldWords.length);
    } else {
      // Too big to trace: assume any line may carry agent text, from anywhere.
      for (let j = r.bStart; j < r.bEnd; j++) {
        found.set(j, new Set(['agent']));
        moved.add(j);
      }
    }
    // The formatter mixed the user's words into a line with agent words: that line stays pending, so the user's text
    // in it would be lost from the baseline (and Undo would delete it). Keep the user's lines of this region that
    // were typed outside the agent's hunks as they were before formatting in the baseline instead (ghosts), and fold
    // none of the region's new lines.
    let mixed = false;
    for (let j = r.bStart; j < r.bEnd; j++) { if (found.get(j)?.has('agent') && userWords.has(j)) { mixed = true; } }
    if (mixed) {
      for (let i = r.aStart; i < r.aEnd; i++) {
        if (kindOf(i) === 'user' && user.lines[i]!.insideAgent !== true) { lines.push({ text: u[i]!.endsWith('\n') ? u[i]! : `${u[i]!}\n`, src: -1, origin: 'user', ghost: true, moved: true }); }
      }
    }
    for (let j = r.bStart; j < r.bEnd; j++) {
      const kinds = found.get(j);
      const line: SavedLine = kinds?.has('agent') ? { text: s[j]!, src: -1, origin: 'formatter', agentText: true }
        : kinds?.has('user') && !mixed ? { text: s[j]!, src: -1, origin: 'user', insideAgent: userWordsInside.has(j) }
          : { text: s[j]!, src: -1, origin: 'formatter' };
      if (moved.has(j) || mixed) { line.moved = true; }
      lines.push(line);
    }
    ui = r.aEnd;
    si = r.bEnd;
  }
  pushEqualUntil(u.length);
  return user.removedInsideAgent ? { lines, removedBy, removedInsideAgent: user.removedInsideAgent } : { lines, removedBy };
}

/** How the baseline (B) lines up with the disk (D): which D lines the agent added, and where its deletions sit. */
interface AgentAlignment {
  /** Per D line: the B line it is an unchanged copy of, or -1 for a line the agent added. */
  dCommon: Int32Array;
  /** Per D position (0..nD): the B lines the agent deleted right before D line q. */
  delAt: number[][];
}

function alignAgent(baseline: readonly string[], disk: readonly string[]): AgentAlignment {
  const nD = disk.length;
  const dCommon = new Int32Array(nD).fill(-2);
  const delAt: number[][] = Array.from({ length: nD + 1 }, () => []);
  let bi = 0;
  let di = 0;
  for (const r of diffRegions(baseline, disk)) {
    while (di < r.bStart) { dCommon[di++] = bi++; }
    for (let b = r.aStart; b < r.aEnd; b++) { delAt[r.bStart]!.push(b); }
    for (let d = r.bStart; d < r.bEnd; d++) { dCommon[d] = -1; }
    bi = r.aEnd;
    di = r.bEnd;
  }
  while (di < nD) { dCommon[di++] = bi++; }
  return { dCommon, delAt };
}

/**
 * Whether an edit of D lines [r0, r1) (r0 === r1: lines inserted before D line r0) is inside or touches an agent
 * hunk: it rewrites or removes a line the agent added, spans one of its deletions, or inserts lines right next to
 * them.
 */
function touchesAgent(al: AgentAlignment, r0: number, r1: number): boolean {
  const isAgent = (d: number) => d >= 0 && d < al.dCommon.length && al.dCommon[d] === -1;
  if (r0 === r1) { return isAgent(r0 - 1) || isAgent(r0) || al.delAt[r0]!.length > 0; }
  for (let d = r0; d < r1; d++) { if (isAgent(d)) { return true; } }
  for (let q = r0 + 1; q < r1; q++) { if (al.delAt[q]!.length > 0) { return true; } }
  return false;
}

/** Saved lines [i, j) replaced disk lines [p, nextD) one for one, each in place (no words moved across lines). */
function lineForLine(lines: readonly SavedLine[], i: number, j: number, p: number, nextD: number): boolean {
  if (j - i === 0 || j - i !== nextD - p) { return false; }
  for (let k = i; k < j; k++) { if (lines[k]!.moved) { return false; } }
  return true;
}

/**
 * Decide, for the user's part of a save (`user`: disk -> the user's text, before format on save), which lines the
 * user wrote and which disk lines they removed inside or touching an agent hunk (see `touchesAgent`). The decision is
 * recorded on `user` (`insideAgent`, `removedInsideAgent`), so that it survives format on save moving lines around.
 */
export function markInsideAgent(baseline: readonly string[], disk: readonly string[], user: Provenance): void {
  const al = alignAgent(baseline, disk);
  const removed = new Set<number>();
  let p = 0;
  let i = 0;
  while (i <= user.lines.length) {
    let j = i;
    while (j < user.lines.length && user.lines[j]!.src < 0) { j++; }
    const nextD = j < user.lines.length ? user.lines[j]!.src : disk.length;
    if (lineForLine(user.lines, i, j, p, nextD)) {
      // Each new line replaced one disk line: it is inside if that line was the agent's.
      for (let k = i; k < j; k++) { if (user.lines[k]!.origin === 'user') { user.lines[k]!.insideAgent = al.dCommon[p + k - i] === -1; } }
    } else {
      const inside = touchesAgent(al, p, nextD);
      for (let k = i; k < j; k++) { if (user.lines[k]!.origin === 'user') { user.lines[k]!.insideAgent = inside; } }
      if (inside) { for (let d = p; d < nextD; d++) { if (user.removedBy.get(d) === 'user') { removed.add(d); } } }
    }
    p = nextD + 1;
    i = j + 1;
  }
  user.removedInsideAgent = removed;
}

/**
 * Compute the new baseline after a user save. Edits outside agent hunks fold in; an agent hunk that the user (or a
 * formatter) edited stays pending as a whole: its accepted lines stay in the baseline, and nothing written inside it
 * is folded. Only Keep, Undo or git resolve it.
 *
 * @param baseline current baseline lines (B)
 * @param disk disk lines the save started from (D)
 * @param saved provenance of the saved content (S) relative to D
 */
export function foldUserSave(baseline: readonly string[], disk: readonly string[], saved: Provenance): string[] {
  const nD = disk.length;
  const al = alignAgent(baseline, disk);
  const { dCommon, delAt } = al;
  const out: string[] = [];
  const emitDeletions = (q: number) => {
    for (const b of delAt[q]!) { out.push(baseline[b]!); }
  };

  const handleGap = (r0: number, r1: number, newLines: readonly SavedLine[]) => {
    if (r0 === r1 && newLines.length === 0) { return; }
    const insideAgent = touchesAgent(al, r0, r1);
    // Removed common lines: drop (fold the removal), unless they were part of an agent hunk's edit: then they stay
    // in the baseline, pending with the hunk.
    for (let d = r0; d < r1; d++) {
      if (dCommon[d] === -1) { continue; }
      const keep = saved.removedBy.get(d) === 'user' && saved.removedInsideAgent ? saved.removedInsideAgent.has(d) : insideAgent;
      if (keep) { out.push(disk[d]!); }
    }
    for (const l of newLines) {
      const fold = l.ghost || (l.origin === 'user' && l.insideAgent === false) || (l.insideAgent !== true && !insideAgent && !l.agentText);
      if (fold) { out.push(l.text); }
    }
  };

  const S = saved.lines;
  let p = 0; // next D index to account for
  let i = 0; // next S index
  for (;;) {
    let j = i;
    while (j < S.length && S[j]!.src < 0) { j++; }
    const nextD = j < S.length ? S[j]!.src : nD;
    const gap = S.slice(i, j);
    if (lineForLine(S, i, j, p, nextD)) {
      // A line-for-line rewrite (edits on adjacent lines, or format on save, which touches runs of adjacent lines,
      // often next to or across agent hunks): pair each new line with the disk line it replaced and decide per
      // line. A rewritten agent line stays pending, whoever rewrote it; any other line folds in. Not when a
      // formatter moved words across lines (a reflow): then a new line isn't its old line reformatted, and folding
      // it would drop the words it lost from the baseline (and Undo would delete them).
      for (let k = 0; k < gap.length; k++) {
        emitDeletions(p + k);
        if (dCommon[p + k] !== -1 && !gap[k]!.agentText && gap[k]!.insideAgent !== true) { out.push(gap[k]!.text); }
      }
      emitDeletions(nextD);
    } else {
      // Agent deletions sitting before or inside the gap come first; the one right after it, last.
      emitDeletions(p);
      for (let q = p + 1; q < nextD; q++) { emitDeletions(q); }
      handleGap(p, nextD, gap);
      if (nextD > p) { emitDeletions(nextD); }
    }
    if (j >= S.length) { break; }
    if (dCommon[nextD] !== -1) { out.push(disk[nextD]!); } // common line: stays in the baseline
    // agent-added and untouched: not in the baseline, so it stays pending
    p = nextD + 1;
    i = j + 1;
  }
  return out;
}
