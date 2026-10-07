/**
 * Per-document buffer edit logs for `reportUserSave` attribution: the user's own edits since the last time
 * the buffer matched the disk. A log is only valid if it started from a clean buffer; otherwise the engine
 * falls back to diffing (every changed line counts as the user's).
 */
import type { TrackedEdit } from '@editor/engine';

export interface ContentChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

export class EditLogs {
  private readonly logs = new Map<string, TrackedEdit[]>();

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
  onChange(key: string, changes: readonly ContentChange[], isDirtyAfter: boolean): void {
    if (!isDirtyAfter) {
      this.markClean(key);
      return;
    }
    const log = this.logs.get(key);
    if (!log) return; // no clean starting point seen: leave invalid
    // VS Code reports multi-range changes in descending offset order, so applying them in order is valid.
    for (const c of changes) log.push({ offset: c.rangeOffset, length: c.rangeLength, text: c.text, origin: 'user' });
  }

  /** The log to report with a save, or undefined if it isn't trustworthy. */
  get(key: string): readonly TrackedEdit[] | undefined {
    return this.logs.get(key);
  }
}
