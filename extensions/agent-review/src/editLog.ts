/**
 * Per-document buffer edit logs for `reportUserSave` attribution: the edits since the last time the buffer
 * matched the disk. A log is only valid if it started from a clean buffer; otherwise the engine falls back
 * to diffing (every changed line counts as the user's).
 *
 * Each edit remembers the document version it produced, so that edits made during a save (by save
 * participants: format on save, code actions on save) can be told apart from the user's own typing.
 */
import type { TrackedEdit } from '@editor/engine';

export interface ContentChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

interface LoggedEdit {
  edit: TrackedEdit;
  /** Document version after the change event that contained this edit. */
  version: number;
}

export class EditLogs {
  /** Optional trace (the `agentReview.trace` setting). */
  trace: ((message: string) => void) | undefined;
  private readonly logs = new Map<string, LoggedEdit[]>();
  /** The text the buffer last had while it matched the disk: the common ancestor in a merge. */
  private readonly cleanTexts = new Map<string, string>();
  /** Logs that stay invalid until the next save or open, even across reloads (see `hold`). */
  private readonly held = new Set<string>();
  /**
   * A change reported with the buffer clean, not acted on yet (see `onChange`): the log restarts from `text` unless a
   * dirty-state event for the same `version` says the buffer was dirty after all.
   */
  private readonly cleanCandidates = new Map<string, { text: string | undefined; version: number }>();

  /** The buffer is known to match the disk (opened clean, saved, reloaded, reverted). */
  markClean(key: string, text?: string, why = 'clean'): void {
    this.trace?.(`edit log of ${key} restarts (${why})`);
    this.cleanCandidates.delete(key);
    this.held.delete(key);
    this.logs.set(key, []);
    if (text === undefined) { this.cleanTexts.delete(key); }
    else { this.cleanTexts.set(key, text); }
  }

  forget(key: string): void {
    this.cleanCandidates.delete(key);
    this.held.delete(key);
    this.logs.delete(key);
    this.cleanTexts.delete(key);
  }

  /**
   * Stop logging until the buffer is saved (or reopened). For edits that aren't keystrokes on top of the disk
   * version, e.g. a merge result written into the buffer: the next save falls back to diffing against the disk,
   * so lines that match the disk stay what they are (agent lines stay pending) and only the rest is the user's.
   */
  hold(key: string): void {
    this.trace?.(`edit log of ${key} held until the next save`);
    this.cleanCandidates.delete(key);
    this.held.add(key);
    this.logs.delete(key);
  }

  /** The last text the buffer had while it matched the disk, if known. */
  cleanText(key: string): string | undefined {
    this.settleCleanCandidate(key);
    return this.cleanTexts.get(key);
  }

  /**
   * A buffer change. `isDirtyAfter` false means the buffer now matches the disk (a reload from disk after an
   * external write, a revert, or undo back to the saved state): the log restarts.
   *
   * Except that VS Code can report a keystroke as clean: the first edit of a clean buffer arrives with isDirty
   * false when the editor marks the file dirty only after the extension host was told about the change, and the
   * dirty state follows as its own event. Restarting there dropped that keystroke from the log, so the save's log
   * didn't replay, and the save was attributed by diff: every changed line as the user's, including the
   * formatter's reflow of agent lines, which accepted them. So a clean report is only a candidate: the edit is
   * logged as usual, and the restart happens at the next change or save, unless `onDirtyStateChange` for the same
   * version says the buffer was dirty.
   */
  onChange(key: string, changes: readonly ContentChange[], isDirtyAfter: boolean, version = 0, textAfter?: string): void {
    this.settleCleanCandidate(key);
    if (this.held.has(key)) {
      if (!isDirtyAfter && textAfter !== undefined) { this.cleanTexts.set(key, textAfter); }
      return;
    }
    if (!isDirtyAfter) { this.cleanCandidates.set(key, { text: textAfter, version }); }
    const log = this.logs.get(key);
    if (!log) { // no clean starting point seen: leave invalid
      this.trace?.(`edit log of ${key} is invalid (no clean starting point); edit at version ${version} not logged`);
      return;
    }
    // VS Code reports multi-range changes in descending offset order, so applying them in order is valid.
    for (const c of changes) { log.push({ edit: { offset: c.rangeOffset, length: c.rangeLength, text: c.text, origin: 'user' }, version }); }
  }

  /** A dirty-state change without a content change (VS Code fires these as change events with no changes). */
  onDirtyStateChange(key: string, isDirty: boolean, version: number): void {
    const candidate = this.cleanCandidates.get(key);
    if (isDirty && candidate?.version === version) {
      this.trace?.(`edit log of ${key}: the change to version ${version} was reported clean, but the buffer is dirty; the log goes on`);
      this.cleanCandidates.delete(key);
    }
  }

  private settleCleanCandidate(key: string): void {
    const candidate = this.cleanCandidates.get(key);
    if (candidate) { this.markClean(key, candidate.text, `the buffer matched the disk at version ${candidate.version}`); }
  }

  /**
   * The log to report with a save, or undefined if it isn't trustworthy. Edits that produced a version after
   * `userVersion` (the version when save participants started) are attributed to the formatter.
   */
  get(key: string, userVersion?: number): readonly TrackedEdit[] | undefined {
    this.settleCleanCandidate(key);
    const log = this.logs.get(key);
    if (!log) { return undefined; }
    return log.map(({ edit, version }) => (userVersion !== undefined && version > userVersion ? { ...edit, origin: 'formatter' } : edit));
  }
}
