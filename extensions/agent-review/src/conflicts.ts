/**
 * Disk changes that hit a buffer with unsaved edits: any write the engine didn't expect (the agent through the
 * chat, a terminal agent, a shell command, another tool). Nothing is ever overwritten: the user resolves the
 * conflict in VS Code's 3-way merge editor (base = the text both sides started from, the agent's version on
 * disk, the user's buffer; the result is the file). Core (`_agentReview.openMerge`) snapshots both sides,
 * reloads the buffer from disk and opens the merge editor on the auto-merge; nothing is written until the
 * user completes the merge.
 *
 * Until then the change isn't drawn inline: the inline review diffs the baseline against the buffer, and the
 * buffer holds the user's version, not the one on disk (VS Code never reloads a dirty buffer). Agent Changes
 * lists the file and the notice offers Merge…; once merged, the agent's lines show inline as pending.
 *
 * Belt and braces: both versions are also copied to the extension's storage (`conflicts/`), and closing the
 * merge editor without saving says where the user's version went.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from './controller';
import type { EditLogs } from './editLog';

const BACKUP_DAYS = 7;
const MERGE = 'Merge…';

interface ActiveMerge {
  backup: string;
  saved: boolean;
}

export class ConflictMerger implements vscode.Disposable {
  /** absPath -> the latest notice shown for it (see `onConflict`). */
  private readonly notices = new Map<string, number>();
  private noticeSeq = 0;
  private backups = 0;
  /** uri string -> merge in progress. */
  private readonly merges = new Map<string, ActiveMerge>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly ctl: ReviewController,
    private readonly logs: EditLogs,
    private readonly backupDir: string,
    private readonly hasCore: boolean,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.subs.push(
      vscode.workspace.onDidSaveTextDocument((d) => {
        const m = this.merges.get(d.uri.toString());
        if (m) { m.saved = true; }
      }),
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        for (const tab of e.closed) {
          const result = mergeResult(tab.input);
          if (result) { void this.onMergeClosed(result); }
        }
      }),
    );
    void this.pruneBackups();
  }

  /**
   * A disk change (the agent's, through the chat or not) hit `absPath` while it has unsaved edits.
   *
   * Every change shows the notice again. A warning with a button hides itself into the notification center after a
   * few seconds, and its promise stays pending until the user acts on it there: waiting for it before showing the
   * next one meant every later change to the file went unannounced (#34). VS Code replaces an identical notice that
   * is still open, so repeated writes don't stack.
   */
  async onConflict(absPath: string): Promise<void> {
    const seq = ++this.noticeSeq;
    this.notices.set(absPath, seq);
    const name = path.basename(absPath);
    try {
      await this.backup(absPath, 'agent', await fs.readFile(absPath, 'utf8'));
    } catch (err) {
      this.log.warn(`could not back up the agent's version of ${absPath}: ${String(err)}`);
    }
    if (this.notices.get(absPath) !== seq) { return; } // a newer change shows its own notice
    const choice = await vscode.window.showWarningMessage(
      `${name} changed on disk while you have unsaved edits. Nothing was overwritten. Merge the agent's version with yours?`,
      MERGE,
    );
    if (this.notices.get(absPath) === seq) { this.notices.delete(absPath); }
    if (choice !== MERGE) { return; }
    // Same path as the palette command. Called from a notification, so nothing else would report a failure (#35).
    try {
      await this.merge(absPath);
    } catch (err) {
      this.log.error(`could not open the merge for ${absPath}`, err instanceof Error ? err : String(err));
      void vscode.window.showErrorMessage(`Agent Review: could not open the merge editor for ${name}: ${err instanceof Error ? err.message : String(err)}. Nothing was overwritten.`);
    }
  }

  /** Open the 3-way merge for `absPath` (also a command, for the editor title and palette). */
  async merge(absPath: string): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    const key = uri.toString();
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (!doc?.isDirty) {
      void vscode.window.showInformationMessage(`${path.basename(absPath)} has no unsaved edits: nothing to merge.`);
      return;
    }
    if (!this.hasCore) {
      // Not in the fork: the best we can do is show the two versions side by side.
      await vscode.commands.executeCommand('workbench.files.action.compareWithSaved', uri);
      return;
    }
    const backup = await this.backup(absPath, 'yours', doc.getText());
    const base = this.logs.cleanText(key) ?? (await this.ctl.baselineText(absPath)) ?? '';
    // The merge rewrites the buffer: from here until the next save, attribute by diffing against the disk.
    this.logs.hold(key);
    let opened: boolean;
    try {
      opened = (await vscode.commands.executeCommand<boolean>('_agentReview.openMerge', uri, base)) === true;
    } catch (err) {
      this.log.error(`could not open the merge editor for ${absPath}`, err instanceof Error ? err : String(err));
      void vscode.window.showErrorMessage(`Agent Review: could not open the merge editor. Your unsaved edits are still in the editor (and in ${backup}).`);
      return;
    }
    if (opened) {
      this.merges.set(key, { backup, saved: false });
    } else {
      // Core found no unsaved edits to merge (the buffer was saved or reverted meanwhile).
      this.log.warn(`merge of ${absPath} not opened: core found no unsaved edits`);
      void vscode.window.showInformationMessage(`${path.basename(absPath)} has no unsaved edits: nothing to merge.`);
    }
  }

  private async onMergeClosed(result: vscode.Uri): Promise<void> {
    const key = result.toString();
    const m = this.merges.get(key);
    if (!m) { return; }
    this.merges.delete(key);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (doc && !doc.isDirty) { this.logs.markClean(key, doc.getText()); }
    if (m.saved || doc?.isDirty) { return; }
    // Closed with "Don't Save": the file is the agent's version again. Say where the user's version is.
    const choice = await vscode.window.showInformationMessage(
      `The merge of ${path.basename(result.fsPath)} was closed without saving. Your unsaved version is kept.`,
      'Open Your Version',
    );
    if (choice === 'Open Your Version') { await vscode.window.showTextDocument(vscode.Uri.file(m.backup), { preview: true }); }
  }

  private async backup(absPath: string, side: 'agent' | 'yours', text: string): Promise<string> {
    await fs.mkdir(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Numbered: two writes within the same millisecond keep both versions.
    const file = path.join(this.backupDir, `${stamp}-${++this.backups}-${side}-${path.basename(absPath)}`);
    await fs.writeFile(file, text, 'utf8');
    this.log.info(`conflict on ${absPath}: ${side === 'agent' ? "agent's" : 'your'} version kept at ${file}`);
    return file;
  }

  private async pruneBackups(): Promise<void> {
    try {
      const cutoff = Date.now() - BACKUP_DAYS * 24 * 3600 * 1000;
      for (const name of await fs.readdir(this.backupDir)) {
        const file = path.join(this.backupDir, name);
        if ((await fs.stat(file)).mtimeMs < cutoff) { await fs.rm(file, { force: true }); }
      }
    } catch {
      // no backups yet
    }
  }

  dispose(): void {
    for (const s of this.subs) { s.dispose(); }
  }
}

/** The result file of a merge editor tab (`TabInputTextMerge` is a proposed API, so check the shape). */
function mergeResult(input: unknown): vscode.Uri | undefined {
  const m = input as { base?: unknown; input1?: unknown; input2?: unknown; result?: unknown } | undefined;
  return m && m.input1 instanceof vscode.Uri && m.input2 instanceof vscode.Uri && m.result instanceof vscode.Uri ? m.result : undefined;
}
