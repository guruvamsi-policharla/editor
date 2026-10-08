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
 * right lines into the baseline (`foldUserSave`):
 *
 *  - lines the user edited fold into the baseline ("the user's edit wins")
 *  - untouched agent lines stay pending, so a partly edited hunk shrinks
 *  - formatter changes inside a pending agent hunk stay pending as part of it
 *  - formatter changes elsewhere fold into the baseline
 *  - an agent hunk's deleted baseline lines stay pending unless the user
 *    rewrote every line the agent added in that hunk (then the hunk is resolved)
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
   * Not in the saved content: a line of the user's, before format on save mixed it into agent text, that goes into
   * the baseline in its place (see addFormatterPass).
   */
  ghost?: boolean;
}

export interface Provenance {
  lines: SavedLine[];
  /** Disk lines that were removed, and by whom. */
  removedBy: Map<number, EditOrigin>;
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
    // in it would be lost from the baseline (and Undo would delete it). Keep the user's lines of this region as they
    // were before formatting in the baseline instead (ghosts), and fold none of the region's new lines.
    let mixed = false;
    for (let j = r.bStart; j < r.bEnd; j++) { if (found.get(j)?.has('agent') && userWords.has(j)) { mixed = true; } }
    if (mixed) {
      for (let i = r.aStart; i < r.aEnd; i++) {
        if (kindOf(i) === 'user') { lines.push({ text: u[i]!.endsWith('\n') ? u[i]! : `${u[i]!}\n`, src: -1, origin: 'user', ghost: true, moved: true }); }
      }
    }
    for (let j = r.bStart; j < r.bEnd; j++) {
      const kinds = found.get(j);
      const line: SavedLine = kinds?.has('agent') ? { text: s[j]!, src: -1, origin: 'formatter', agentText: true }
        : { text: s[j]!, src: -1, origin: kinds?.has('user') && !mixed ? 'user' : 'formatter' };
      if (moved.has(j) || mixed) { line.moved = true; }
      lines.push(line);
    }
    ui = r.aEnd;
    si = r.bEnd;
  }
  pushEqualUntil(u.length);
  return { lines, removedBy };
}

/**
 * Compute the new baseline after a user save.
 *
 * @param baseline current baseline lines (B)
 * @param disk disk lines the save started from (D)
 * @param saved provenance of the saved content (S) relative to D
 */
export function foldUserSave(baseline: readonly string[], disk: readonly string[], saved: Provenance): string[] {
  const nD = disk.length;
  // Alignment of B -> D: which D lines are common (and which agent-added), where agent deletions sit.
  const dCommon = new Int32Array(nD).fill(-2); // -2 = common (filled below as B index), -1 = agent-added
  const delAt: number[][] = Array.from({ length: nD + 1 }, () => []);
  const hunkOfD = new Int32Array(nD).fill(-1);
  const hunkOfB = new Int32Array(baseline.length).fill(-1);
  const regions = diffRegions(baseline, disk);
  let bi = 0;
  let di = 0;
  regions.forEach((r, h) => {
    while (di < r.bStart) { dCommon[di++] = bi++; }
    for (let b = r.aStart; b < r.aEnd; b++) {
      delAt[r.bStart]!.push(b);
      hunkOfB[b] = h;
    }
    for (let d = r.bStart; d < r.bEnd; d++) {
      dCommon[d] = -1;
      hunkOfD[d] = h;
    }
    bi = r.aEnd;
    di = r.bEnd;
  });
  while (di < nD) { dCommon[di++] = bi++; }

  // An agent hunk is resolved when the user rewrote every line the agent added in it.
  const resolved = regions.map((r) => {
    if (r.bEnd === r.bStart) { return false; }
    for (let d = r.bStart; d < r.bEnd; d++) { if (saved.removedBy.get(d) !== 'user') { return false; } }
    return true;
  });
  const isAgent = (d: number) => d >= 0 && d < nD && dCommon[d] === -1;

  const out: string[] = [];
  const emitDeletions = (q: number) => {
    for (const b of delAt[q]!) { if (!resolved[hunkOfB[b]!]) { out.push(baseline[b]!); } }
  };

  const handleGap = (r0: number, r1: number, newLines: readonly SavedLine[]) => {
    if (r0 === r1 && newLines.length === 0) { return; }
    let insideAgent = false;
    if (r0 === r1) {
      // Pure insertion: inside if it touches agent-added lines or sits on an agent deletion.
      insideAgent = isAgent(r0 - 1) || isAgent(r0) || delAt[r0]!.length > 0;
    } else {
      for (let d = r0; d < r1 && !insideAgent; d++) { if (dCommon[d] === -1) { insideAgent = true; } }
      for (let q = r0 + 1; q < r1 && !insideAgent; q++) { if (delAt[q]!.length > 0) { insideAgent = true; } }
    }
    // Removed common lines: drop (fold the removal) unless a formatter removed them inside an agent hunk.
    for (let d = r0; d < r1; d++) {
      if (dCommon[d] === -1) { continue; }
      if (insideAgent && saved.removedBy.get(d) === 'formatter') { out.push(disk[d]!); }
    }
    for (const l of newLines) {
      if (l.origin === 'user' || (!insideAgent && !l.agentText)) { out.push(l.text); }
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
    if (gap.length > 0 && gap.length === nextD - p && gap.some((l) => l.origin === 'formatter') && !gap.some((l) => l.moved)) {
      // A line-for-line rewrite that a formatter took part in (format on save touches runs of adjacent lines,
      // often next to or across agent hunks): pair each new line with the disk line it replaced and decide per
      // line. A rewritten agent line stays pending unless the user wrote it; any other line folds in. Not when the
      // formatter moved words across lines (a reflow): then a new line isn't its old line reformatted, and folding
      // it would drop the words it lost from the baseline (and Undo would delete them).
      for (let k = 0; k < gap.length; k++) {
        emitDeletions(p + k);
        if ((dCommon[p + k] !== -1 && !gap[k]!.agentText) || gap[k]!.origin === 'user') { out.push(gap[k]!.text); }
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
