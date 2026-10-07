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
  private readonly logs = new Map<string, LoggedEdit[]>();

  /** The buffer is known to match the disk (opened clean, saved, reloaded, reverted). */
  markClean(key: string): void {
    this.logs.set(key, []);
  }

  forget(key: string): void {
    this.logs.delete(key);
  }

  /**
   * A buffer change. `isDirtyAfter` false means the buffer now matches the disk (a reload from disk after an
   * external write, a revert, or undo back to the saved state): the log restarts.
   */
  onChange(key: string, changes: readonly ContentChange[], isDirtyAfter: boolean, version = 0): void {
    if (!isDirtyAfter) {
      this.markClean(key);
      return;
    }
    const log = this.logs.get(key);
    if (!log) return; // no clean starting point seen: leave invalid
    // VS Code reports multi-range changes in descending offset order, so applying them in order is valid.
    for (const c of changes) log.push({ edit: { offset: c.rangeOffset, length: c.rangeLength, text: c.text, origin: 'user' }, version });
  }

  /**
   * The log to report with a save, or undefined if it isn't trustworthy. Edits that produced a version after
   * `userVersion` (the version when save participants started) are attributed to the formatter.
   */
  get(key: string, userVersion?: number): readonly TrackedEdit[] | undefined {
    const log = this.logs.get(key);
    if (!log) return undefined;
    return log.map(({ edit, version }) => (userVersion !== undefined && version > userVersion ? { ...edit, origin: 'formatter' } : edit));
  }
}
