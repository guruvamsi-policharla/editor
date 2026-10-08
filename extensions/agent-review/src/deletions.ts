/**
 * Files the agent deleted, in the editor. A deletion is a pending change like any other (Keep = it stays deleted,
 * Undo = the file comes back), but there is nothing to show inline: the editor would keep the old buffer open as an
 * orphan, with no Keep/Undo, and saving it brought the file back behind the review's back (#17).
 *
 * So an editor tab that shows a file the agent deleted turns into the deletion's review: the file's accepted text
 * against nothing (all red), titled "name (deleted by the agent)", with **Keep Deletion** and **Restore File** in its
 * title bar (see package.json). A tab with unsaved edits is left alone (they are the user's), with a note: saving
 * brings the file back with those edits (the engine then counts the deletion as undone), closing it without saving
 * leaves the deletion up for review.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizePath, type ReviewController } from './controller';
import { baselineUri, DELETED_SCHEME, deletedUri } from './reviewTree';

/** How long a deletion must last before its tabs change (an agent that deletes and rewrites a file isn't one). */
const SETTLE_MS = 800;

export class DeletionReview implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private readonly notified = new Set<string>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly ctl: ReviewController,
    private readonly toUi: (realPath: string) => string,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.subs.push(ctl.onDidChangeFiles(() => this.schedule()));
  }

  /** Check the open tabs soon (pending list changed, or at startup). */
  schedule(): void {
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.update().catch((err) => this.log.error('reviewing deleted files in their tabs failed', err instanceof Error ? err : String(err)));
    }, SETTLE_MS);
  }

  private async update(): Promise<void> {
    const deleted = new Set(this.ctl.pendingFiles.filter((f) => f.kind === 'deleted').map((f) => f.absPath));
    for (const abs of [...this.notified]) { if (!deleted.has(abs)) { this.notified.delete(abs); } }
    if (deleted.size === 0) { return; }
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = tab.input instanceof vscode.TabInputText ? tab.input.uri : undefined;
        if (uri?.scheme !== 'file') { continue; }
        const abs = normalizePath(uri.fsPath);
        if (!deleted.has(abs)) { continue; }
        if (tab.isDirty) {
          this.noteUnsaved(abs);
          continue;
        }
        this.log.info(`${abs} was deleted: its tab shows the deletion for review`);
        await showDeletion(this.toUi(abs), { viewColumn: group.viewColumn, preserveFocus: !tab.isActive || !group.isActive, preview: false });
        await vscode.window.tabGroups.close(tab, true);
      }
    }
  }

  private noteUnsaved(abs: string): void {
    if (this.notified.has(abs)) { return; }
    this.notified.add(abs);
    const name = path.basename(abs);
    void vscode.window.showWarningMessage(
      `${name} was deleted on disk while you have unsaved edits in it. Nothing was lost: save to keep the file with your edits, or close it without saving to review the deletion.`,
    );
  }

  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); }
    for (const s of this.subs) { s.dispose(); }
  }
}

/** Open a deleted file's review: its accepted text against nothing. */
export async function showDeletion(uiPath: string, options: vscode.TextDocumentShowOptions = {}): Promise<void> {
  await vscode.commands.executeCommand('vscode.diff', baselineUri(uiPath), deletedUri(uiPath), `${path.basename(uiPath)} (deleted by the agent)`, options);
}

/** Close the deletion reviews of `uiPath` (after Keep Deletion or Restore File); true if one was active. */
export async function closeDeletion(uiPath: string): Promise<boolean> {
  const target = deletedUri(uiPath).toString();
  let wasActive = false;
  const tabs: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === DELETED_SCHEME && tab.input.modified.toString() === target) {
        tabs.push(tab);
        wasActive ||= tab.isActive && group.isActive;
      }
    }
  }
  if (tabs.length) { await vscode.window.tabGroups.close(tabs, true); }
  return wasActive;
}
