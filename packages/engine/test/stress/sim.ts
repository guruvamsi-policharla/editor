/**
 * Randomized review stress: an editor simulation (buffers, edit logs, save participants with formatters) driving a
 * review backend (the engine directly, or the extension's controller) through interleaved agent writes, user typing,
 * saves with and without a formatter (JSON and LaTeX), Keep/Undo, editor undo, restarts and git operations.
 *
 * The invariant checked after every step: an agent-written line is never folded into the baseline except by an
 * explicit Keep, staging that file, or a HEAD move whose diff (old HEAD tree -> new HEAD tree) includes that file.
 * Agent text is made of unique words (`ag7`); base text has unique words too (`b12`), so:
 *  - an agent word on disk is not in the baseline, unless it was kept, staged or committed with a change to its file,
 *    or the user typed on its line (the user's edit of a line wins, by design);
 *  - a base word the agent deleted is still in the baseline while it is absent from disk, with the same exceptions
 *    (for a replaced word: the user typed on the line that replaced it).
 *
 * Everything is driven by a seeded generator, so a failing seed replays exactly (`STRESS_SEED=<n>`).
 */
import type { TrackedEdit } from '../../src/index.js';

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    // mulberry32
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** What the simulated editor needs from the review side. Paths are workspace-relative. */
export interface Backend {
  /** The agent wrote `rel` on disk (already written); deliver the watcher event. */
  agentWrote(rel: string): Promise<void>;
  /**
   * The user saves: `edits` is the edit log as the extension would report it (undefined: none), `userContent` the
   * text before save participants. The backend reports the save, writes `saved` and delivers the watcher event.
   */
  save(rel: string, saved: string, edits: TrackedEdit[] | undefined, userContent: string | undefined): Promise<void>;
  /** Keep one hunk (the `pick`-th of the file's hunks). Returns its old and new lines, or undefined if none. */
  keepHunk(rel: string, pick: number): Promise<{ oldLines: string[]; newLines: string[] } | undefined>;
  keepFile(rel: string): Promise<boolean>;
  /** Undo one hunk on a clean buffer: the file on disk goes back to the baseline there. Returns false if nothing to undo. */
  undoHunk(rel: string, pick: number): Promise<boolean>;
  baseline(rel: string): Promise<string | undefined>;
  /** The file's hunks (baseline -> disk). */
  hunks(rel: string): Promise<{ oldLines: string[]; newLines: string[] }[]>;
  pending(): string[];
  /** Restart (close and reopen the review state). */
  restart(): Promise<void>;
  /** A buffer was saved, reverted or reloaded: clean again. */
  settled(rel: string): Promise<void>;
  /**
   * Raw buffer changes, for backends that keep the edit log themselves (the extension). `reportedClean`: VS Code
   * reports the change with the buffer clean; `dirtyAfter`: a dirty-state event follows (the first keystroke of a
   * clean buffer can arrive reported clean, its dirty state just after).
   */
  bufferChanged?(rel: string, edit: TrackedEdit, reportedClean: boolean, textAfter: string, dirtyAfter?: boolean): void;
  /** Save participants start (core records the user version). */
  saveStarted?(rel: string): void;
  /** The backend's own edit log for the save in progress (the extension's), if it keeps one. */
  editLog?(rel: string): TrackedEdit[] | undefined;
  /** Run git and deliver events afterwards (only when the workspace is a repository). */
  git?(...args: string[]): Promise<void>;
}

export interface Files {
  read(rel: string): string;
  write(rel: string, text: string): void;
}

/** How the edit log reaches the engine at a save: the harness injects the glitches seen in the field. */
type LogMode = 'ok' | 'drop-first' | 'all-user' | 'none';

interface Buffer {
  text: string;
  dirty: boolean;
  /** Edits since the buffer last matched the disk (undefined: unknown start, e.g. after a restart). */
  log: TrackedEdit[] | undefined;
  /** Last user edit, for editor undo. */
  undo: { inverse: TrackedEdit } | undefined;
}

export interface StressOptions {
  steps: number;
  git: boolean;
  /** Use the backend's own edit log (the extension's EditLogs) instead of the simulated one. */
  backendLog?: boolean;
  log?: (line: string) => void;
}

const WORD_RE = /\b(?:ag|b|us)\d+\b/g;

export class Stress {
  private readonly buffers = new Map<string, Buffer>();
  /** Agent words that may legitimately be in the baseline (kept, committed, staged, or the user typed on their line). */
  private readonly exempt = new Set<string>();
  /** Base words the agent deleted -> the agent words of the same write (their touch exempts the deletion). */
  private readonly agentDeleted = new Map<string, string[]>();
  /** Each file's content in HEAD, to tell which files a commit changed. */
  private readonly committed = new Map<string, string>();
  private nextAgent = 1;
  private nextUser = 1;
  readonly trail: string[] = [];

  constructor(
    private readonly rng: Rng,
    private readonly files: Files,
    private readonly backend: Backend,
    private readonly rels: readonly string[],
    private readonly opts: StressOptions,
  ) {
    for (const rel of rels) {
      this.buffers.set(rel, { text: files.read(rel), dirty: false, log: [], undo: undefined });
      this.committed.set(rel, files.read(rel));
    }
  }

  /** Initial files: a JSON config and a LaTeX section, every word unique. */
  static initialFiles(): Record<string, string> {
    let n = 1;
    const w = () => `b${n++}`;
    const json = `{\n  "${w()}": 50,\n  "${w()}": [32, 128, 512],\n  "${w()}": "${w()} ${w()}"\n}\n`;
    const tex: string[] = ['\\section{Intro}', ''];
    for (let p = 0; p < 3; p++) {
      tex.push(`The ${w()} scheme ${w()} a ${w()} ${w()} of ${w()} and ${w()}~\\cite{${w()}}.`, `We ${w()} it ${w()} the ${w()} in ${w()}.`, '');
    }
    tex.push('\\begin{equation}', `  ${w()} = ${w()} + ${w()}`, '\\end{equation}', '');
    return { 'data.json': json, 'paper.tex': tex.join('\n') };
  }

  async run(): Promise<void> {
    for (let step = 0; step < this.opts.steps; step++) {
      const action = this.pickAction();
      this.trail.push(action);
      await this.perform(action);
      if (process.env.STRESS_VERBOSE) { for (const r of this.rels) { this.trail.push(`  baseline ${r}: ${JSON.stringify(await this.backend.baseline(r))}`); } }
      await this.check(`step ${step} (${action})`);
    }
  }

  private pickAction(): string {
    const r = this.rng.next();
    const git = this.opts.git;
    if (r < 0.22) { return 'agent'; }
    if (r < 0.50) { return 'type'; }
    if (r < 0.62) { return 'save-format'; }
    if (r < 0.68) { return 'save-plain'; }
    if (r < 0.74) { return 'keep-hunk'; }
    if (r < 0.77) { return 'keep-file'; }
    if (r < 0.83) { return 'undo-hunk'; }
    if (r < 0.87) { return 'editor-undo'; }
    if (r < 0.90) { return 'restart'; }
    if (git && r < 0.93) { return 'git-stage'; }
    if (git && r < 0.95) { return 'git-commit'; }
    if (git && r < 0.98) { return 'git-stash'; }
    return 'type';
  }

  private async perform(action: string): Promise<void> {
    const rel = this.rng.pick(this.rels);
    const buf = this.buffers.get(rel)!;
    switch (action) {
      case 'agent': return this.agentWrite(rel);
      case 'type': return await this.type(rel);
      case 'save-format': return this.save(rel, true);
      case 'save-plain': return this.save(rel, false);
      case 'keep-hunk': {
        const h = await this.backend.keepHunk(rel, this.rng.int(4));
        if (h) { for (const l of [...h.newLines, ...h.oldLines]) { for (const w of words(l)) { this.exempt.add(w); } } }
        this.trail.push(h ? `  kept ${JSON.stringify(h)}` : '  nothing to keep');
        return;
      }
      case 'keep-file':
        if (await this.backend.keepFile(rel)) { this.exemptAll(rel, this.files.read(rel)); }
        return;
      case 'undo-hunk':
        if (buf.dirty) { return; }
        if (await this.backend.undoHunk(rel, this.rng.int(4))) {
          buf.text = this.files.read(rel);
          buf.log = [];
          buf.undo = undefined;
          this.backend.bufferChanged?.(rel, { offset: 0, length: 0, text: '', origin: 'user' }, false, buf.text);
          await this.backend.settled(rel);
        }
        return;
      case 'editor-undo': {
        if (!buf.undo) { return; }
        const inv = buf.undo.inverse;
        buf.undo = undefined;
        this.applyUserEdit(rel, inv);
        return;
      }
      case 'restart': {
        await this.backend.restart();
        // Hot exit: unsaved buffers come back without an edit log.
        for (const b of this.buffers.values()) { if (b.dirty) { b.log = undefined; } }
        return;
      }
      case 'git-stage':
        if (this.backend.git) {
          await this.backend.git('add', rel);
          this.exemptAll(rel, this.files.read(rel));
        }
        return;
      case 'git-commit':
        if (this.backend.git) {
          // Everything (`-a`), or only this file: a commit accepts only the files whose content it changed (#12).
          const all = this.rng.chance(0.5);
          if (all) { await this.backend.git('commit', '-qam', 'wip', '--allow-empty'); }
          else { await this.backend.git('commit', '-qm', 'wip', '--allow-empty', '--', rel); }
          const inCommit = all ? this.rels : [rel];
          const changed = inCommit.filter((r) => this.files.read(r) !== this.committed.get(r));
          this.trail.push(`  committed ${inCommit.join(', ')}; changed: ${changed.join(', ') || 'nothing'}`);
          for (const r of changed) {
            this.committed.set(r, this.files.read(r));
            this.exemptAll(r, this.files.read(r));
          }
        }
        return;
      case 'git-stash':
        if (this.backend.git && ![...this.buffers.values()].some((b) => b.dirty)) {
          await this.backend.git('stash', '-q');
          await this.backend.git('stash', 'pop', '-q');
          for (const r of this.rels) { await this.reloadIfClean(r); }
        }
        return;
    }
  }

  /** `rel` was accepted whole as `text`: its agent words, and base words the agent deleted from it, may be in the baseline. */
  private exemptAll(rel: string, text: string): void {
    for (const w of words(text)) { this.exempt.add(w); }
    for (const [w, by] of this.agentDeleted) {
      if ((this.wasIn(rel, w) && !text.includes(w)) || by.some((a) => this.exempt.has(a))) { this.exempt.add(w); }
    }
  }

  // ------------------------------------------------------------- agent

  private async agentWrite(rel: string): Promise<void> {
    const buf = this.buffers.get(rel)!;
    if (buf.dirty) {
      // The agent writes under unsaved edits: the user reverts the buffer to the disk (the merge flow is not simulated).
      buf.text = this.files.read(rel);
      buf.dirty = false;
      buf.log = [];
      buf.undo = undefined;
      this.backend.bufferChanged?.(rel, { offset: 0, length: 0, text: '', origin: 'user' }, false, buf.text);
      await this.backend.settled(rel);
    }
    const before = this.files.read(rel);
    const lines = before.split('\n');
    const json = rel.endsWith('.json');
    const ag = () => `ag${this.nextAgent++}`;
    const kind = this.rng.int(4);
    const at = this.rng.int(Math.max(1, lines.length - 1));
    const added: string[] = [];
    if (kind === 0) { // insert a line (JSON: a compact entry, as agents write it)
      const a = ag();
      const b = ag();
      added.push(a, b);
      lines.splice(at + (json ? 1 : 0), 0, json ? `  "${a}":${this.rng.int(9)},"${b}" :[1,2]${at + 1 < lines.length - 2 ? ',' : ''}` : `The ${a} result ${b} holds.`);
    } else if (kind === 1) { // append words to a line
      const a = ag();
      added.push(a);
      lines[at] = lines[at] + (json ? '' : ` ${a}`);
      if (json) { lines[at] = lines[at]!.replace(/(\d+)(,?)$/, `$1, "${a}": 1$2`); }
    } else if (kind === 2) { // replace a base word
      const ws = words(lines[at]!).filter((w) => w.startsWith('b'));
      if (ws.length) {
        const a = ag();
        added.push(a);
        lines[at] = lines[at]!.replace(new RegExp(`\\b${this.rng.pick(ws)}\\b`), a);
      }
    } else if (lines.length > 4) { // delete a line
      lines.splice(at, 1);
    }
    const after = lines.join('\n');
    if (after === before) { return; }
    for (const w of words(before)) { if (!after.includes(w) && w.startsWith('b')) { this.agentDeleted.set(w, added); } }
    this.files.write(rel, after);
    this.trail.push(`  agent ${rel}: ${JSON.stringify(after)}`);
    // The open, clean buffer reloads from disk.
    buf.text = after;
    buf.log = [];
    buf.undo = undefined;
    this.backend.bufferChanged?.(rel, { offset: 0, length: before.length, text: after, origin: 'user' }, false, after);
    await this.backend.agentWrote(rel);
  }

  private async reloadIfClean(rel: string): Promise<void> {
    const buf = this.buffers.get(rel)!;
    if (buf.dirty) { return; }
    const disk = this.files.read(rel);
    if (disk === buf.text) { return; }
    this.backend.bufferChanged?.(rel, { offset: 0, length: buf.text.length, text: disk, origin: 'user' }, false, disk);
    buf.text = disk;
    buf.log = [];
    buf.undo = undefined;
  }

  // ------------------------------------------------------------- user

  private async type(rel: string): Promise<void> {
    const touchedBefore = new Set(this.exempt);
    const buf = this.buffers.get(rel)!;
    const text = buf.text;
    const lines = text.split('\n');
    const li = this.rng.int(lines.length);
    const lineStart = lines.slice(0, li).join('\n').length + (li > 0 ? 1 : 0);
    const line = lines[li]!;
    const us = `us${this.nextUser++}`;
    const kind = this.rng.int(5);
    let edit: TrackedEdit;
    if (kind === 0) { // a word at the end of a line (JSON: often invalid, as in the polish-2 scene)
      edit = { offset: lineStart + line.length, length: 0, text: rel.endsWith('.json') ? `, ${us}` : ` ${us}`, origin: 'user' };
    } else if (kind === 1) { // a word in the middle of a line
      const col = this.rng.int(line.length + 1);
      edit = { offset: lineStart + col, length: 0, text: ` ${us} `, origin: 'user' };
    } else if (kind === 2) { // a new line
      edit = { offset: lineStart, length: 0, text: `User note ${us}.\n`, origin: 'user' };
    } else if (kind === 3 && line.length > 2) { // delete a few characters
      const col = this.rng.int(line.length - 1);
      edit = { offset: lineStart + col, length: 1 + this.rng.int(Math.min(4, line.length - col)), text: '', origin: 'user' };
    } else { // join with the next line
      if (li + 1 >= lines.length) { return; }
      edit = { offset: lineStart + line.length, length: 1, text: ' ', origin: 'user' };
    }
    // Typing on (or joining) a line with agent words: the user's edit of that line wins.
    const end = edit.offset + edit.length;
    let pos = 0;
    const touchedLines: string[] = [];
    for (const l of lines) {
      const lEnd = pos + l.length;
      if (lEnd >= edit.offset && pos <= end) {
        touchedLines.push(l);
        for (const w of words(l)) { if (w.startsWith('ag')) { this.exempt.add(w); } }
      }
      pos = lEnd + 1;
    }
    for (const [w, by] of this.agentDeleted) { if (by.some((a) => this.exempt.has(a))) { this.exempt.add(w); } }
    // The user rewriting an agent-added line resolves its hunk (by design): the hunk's words may leave the baseline.
    void touchedBefore;
    for (const h of await this.backend.hunks(rel)) {
      if (h.newLines.some((l) => touchedLines.includes(l.replace(/\r?\n$/, '')))) {
        for (const l of [...h.oldLines, ...h.newLines]) { for (const w of words(l)) { this.exempt.add(w); } }
      }
    }
    this.applyUserEdit(rel, edit);
  }

  private applyUserEdit(rel: string, edit: TrackedEdit): void {
    const buf = this.buffers.get(rel)!;
    const removed = buf.text.slice(edit.offset, edit.offset + edit.length);
    const before = new Set(words(buf.text));
    buf.text = buf.text.slice(0, edit.offset) + edit.text + buf.text.slice(edit.offset + edit.length);
    // A deletion can make a new word out of two (`"ag6": 0` -> `"ag60`): that word is the user's.
    for (const w of words(buf.text)) { if (!before.has(w)) { this.exempt.add(w); } }
    buf.undo = { inverse: { offset: edit.offset, length: edit.text.length, text: removed, origin: 'user' } };
    const clean = buf.text === this.files.read(rel);
    if (clean) {
      buf.dirty = false;
      buf.log = [];
    } else {
      buf.dirty = true;
      buf.log?.push(edit);
    }
    // VS Code's ordering: the first edit of a clean buffer can arrive reported clean, its dirty state just after.
    const bogus = !clean && buf.log?.length === 1 && this.rng.chance(0.5);
    this.backend.bufferChanged?.(rel, edit, clean || bogus, buf.text, bogus);
  }

  private async save(rel: string, format: boolean): Promise<void> {
    const buf = this.buffers.get(rel)!;
    const userText = buf.text;
    const userEdits = buf.log ? [...buf.log] : undefined;
    let saved = userText;
    const fmtEdits: TrackedEdit[] = [];
    if (format) {
      saved = this.format(rel, userText);
      if (saved !== userText) { fmtEdits.push(...this.formatterEdits(userText, saved)); }
    }
    // Trim trailing whitespace on save (another save participant).
    const trimmed = saved.replace(/[ \t]+$/gm, '');
    if (trimmed !== saved) {
      fmtEdits.push(...this.formatterEdits(saved, trimmed));
      saved = trimmed;
    }
    if (saved === this.files.read(rel) && !buf.dirty) { return; }
    let edits: TrackedEdit[] | undefined;
    const mode: LogMode = this.rng.pick(['ok', 'ok', 'drop-first', 'all-user', 'none'] as const);
    if (this.opts.backendLog && this.backend.editLog) {
      this.backend.saveStarted?.(rel);
      for (const e of fmtEdits) { this.backend.bufferChanged?.(rel, { ...e, origin: 'user' }, false, ''); }
      edits = this.backend.editLog(rel);
    } else if (userEdits) {
      const all = [...userEdits, ...fmtEdits];
      if (mode === 'ok') { edits = all; }
      else if (mode === 'drop-first') { edits = all.slice(1); }
      else if (mode === 'all-user') { edits = all.map((e) => ({ ...e, origin: 'user' as const })); }
    }
    this.trail.push(`  save ${rel} (${format ? 'format' : 'plain'}, log ${this.opts.backendLog ? 'extension' : mode}): ${JSON.stringify(saved)}`);
    await this.backend.save(rel, saved, edits, userText);
    buf.text = saved;
    buf.dirty = false;
    buf.log = [];
    buf.undo = undefined;
    await this.backend.settled(rel);
  }

  /** Token-preserving formatters: JSON splits at commas, LaTeX reflows paragraphs or normalizes indentation. */
  private format(rel: string, text: string): string {
    if (rel.endsWith('.json')) {
      return text.split('\n').map((l) => {
        const indent = /^\s*/.exec(l)![0] || '  ';
        return l.replace(/,\s*(?=\S)/g, `,\n${indent}`).replace(/"\s*:\s*/g, '": ').replace(/\[\s*/g, '[').replace(/\s+$/, '');
      }).join('\n');
    }
    if (this.rng.chance(0.5)) {
      // Reflow paragraphs (latexindent -m style): join a paragraph's lines and wrap at 50 columns.
      const out: string[] = [];
      let para: string[] = [];
      const flush = () => {
        if (!para.length) { return; }
        const ws = para.join(' ').split(/\s+/).filter(Boolean);
        let line = '';
        for (const w of ws) {
          if (line && line.length + 1 + w.length > 50) { out.push(line); line = w; }
          else { line = line ? `${line} ${w}` : w; }
        }
        if (line) { out.push(line); }
        para = [];
      };
      for (const l of text.split('\n')) {
        if (l.trim() === '' || l.startsWith('\\') || l.startsWith('  ')) { flush(); out.push(l); }
        else { para.push(l); }
      }
      flush();
      return out.join('\n');
    }
    // Indentation: two spaces inside environments, none elsewhere.
    let depth = 0;
    return text.split('\n').map((l) => {
      const t = l.trim();
      if (t.startsWith('\\end{')) { depth = Math.max(0, depth - 1); }
      const r = t === '' ? '' : '  '.repeat(depth) + t;
      if (t.startsWith('\\begin{')) { depth++; }
      return r;
    }).join('\n');
  }

  /** The formatter's edits as an editor reports them: one edit, the changed middle, or one edit per changed line. */
  private formatterEdits(from: string, to: string): TrackedEdit[] {
    const style = this.rng.int(3);
    if (style === 0) { return [{ offset: 0, length: from.length, text: to, origin: 'formatter' }]; }
    const a = from.split('\n');
    const b = to.split('\n');
    if (style === 2 && a.length === b.length) {
      const edits: TrackedEdit[] = [];
      let off = 0;
      const offs = a.map((l) => { const o = off; off += l.length + 1; return o; });
      for (let i = a.length - 1; i >= 0; i--) { if (a[i] !== b[i]) { edits.push({ offset: offs[i]!, length: a[i]!.length, text: b[i]!, origin: 'formatter' }); } }
      return edits;
    }
    let p = 0;
    while (p < from.length && p < to.length && from[p] === to[p]) { p++; }
    let s = 0;
    while (s < from.length - p && s < to.length - p && from[from.length - 1 - s] === to[to.length - 1 - s]) { s++; }
    return [{ offset: p, length: from.length - p - s, text: to.slice(p, to.length - s), origin: 'formatter' }];
  }

  // ------------------------------------------------------------- invariant

  private async check(where: string): Promise<void> {
    for (const rel of this.rels) {
      const disk = this.files.read(rel);
      const base = (await this.backend.baseline(rel)) ?? '';
      const baseWords = new Set(words(base));
      for (const w of words(disk)) {
        if (w.startsWith('ag') && !this.exempt.has(w) && baseWords.has(w)) {
          this.fail(`${where}: agent word ${w} in ${rel} was folded into the baseline without a Keep\nbaseline: ${JSON.stringify(base)}\ndisk: ${JSON.stringify(disk)}`);
        }
      }
      for (const w of words(disk)) {
        if (w.startsWith('b') && !this.exempt.has(w) && this.wasIn(rel, w) && !baseWords.has(w)) {
          this.fail(`${where}: base word ${w} is on disk but gone from the baseline of ${rel}: Undo would delete it\nbaseline: ${JSON.stringify(base)}\ndisk: ${JSON.stringify(disk)}`);
        }
      }
      const diskWords = new Set(words(disk));
      for (const [w] of this.agentDeleted) {
        if (diskWords.has(w)) { this.agentDeleted.delete(w); continue; } // back on disk (Undo)
        if (!this.exempt.has(w) && !baseWords.has(w) && this.wasIn(rel, w)) {
          this.fail(`${where}: base word ${w} that the agent deleted from ${rel} is gone from the baseline without a Keep\nbaseline: ${JSON.stringify(base)}\ndisk: ${JSON.stringify(disk)}`);
        }
      }
    }
  }

  private readonly homes = new Map<string, string>();
  private wasIn(rel: string, w: string): boolean {
    if (!this.homes.size) {
      for (const [r, t] of Object.entries(Stress.initialFiles())) { for (const x of words(t)) { this.homes.set(x, r); } }
    }
    return this.homes.get(w) === rel;
  }

  private fail(message: string): never {
    throw new Error(`${message}\ntrail:\n${this.trail.slice(-(Number(process.env.STRESS_TRAIL) || 40)).join('\n')}`);
  }
}

function words(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}
