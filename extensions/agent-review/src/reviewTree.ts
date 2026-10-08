/** Explorer > Agent Changes: the multi-file review list, and the read-only baseline documents. */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PendingFile, ReviewController } from './controller';

export const BASELINE_SCHEME = 'agent-review-accepted';

export function baselineUri(absPath: string): vscode.Uri {
  return vscode.Uri.file(absPath).with({ scheme: BASELINE_SCHEME });
}

/**
 * An empty document standing for a file that no longer exists (the right side of a deleted file's diff). A scheme of
 * its own, so that the diff's title bar can offer Keep Deletion / Restore File (`resourceScheme`).
 */
export const DELETED_SCHEME = 'agent-review-deleted';

export function deletedUri(absPath: string): vscode.Uri {
  return vscode.Uri.file(absPath).with({ scheme: DELETED_SCHEME });
}

export class BaselineContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly sub: { dispose(): void };

  constructor(private readonly ctl: ReviewController) {
    // Baselines move on accept/save/git ops: refresh any open baseline document of a pending file.
    this.sub = ctl.onDidChangeFiles(() => {
      for (const d of vscode.workspace.textDocuments) { if (d.uri.scheme === BASELINE_SCHEME) { this.emitter.fire(d.uri); } }
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.scheme === DELETED_SCHEME) { return ''; }
    return (await this.ctl.baselineText(uri.fsPath)) ?? '';
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}

export class FileItem extends vscode.TreeItem {
  /** `uiPath`: the file's path as VS Code knows it (under the workspace folder as opened; see UiPaths). */
  constructor(readonly file: PendingFile, counts: { added: number; removed: number } | undefined, uiPath = file.absPath) {
    super(vscode.Uri.file(uiPath), vscode.TreeItemCollapsibleState.None);
    const dir = path.dirname(file.rel);
    const parts: string[] = [];
    if (dir !== '.') { parts.push(dir); }
    if (file.kind === 'renamed' && file.oldAbsPath) { parts.push(`renamed from ${path.basename(file.oldAbsPath)}`); }
    else if (file.kind !== 'modified') { parts.push(file.kind); }
    if (counts) { parts.push(`+${counts.added} −${counts.removed}`); }
    if (file.binary) { parts.push('binary'); }
    else if (file.large) { parts.push('large'); }
    this.description = parts.join(' · ');
    this.contextValue = `agentReview.file.${file.kind}`;
    this.tooltip = `${file.rel} (${file.kind})`;
    this.command =
      file.kind === 'deleted' || !file.inline
        ? { command: 'agentReview.openFileDiff', title: 'Open Diff', arguments: [this] }
        : { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(uiPath)] };
  }
}

export class ReviewTree implements vscode.TreeDataProvider<FileItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: { dispose(): void };

  constructor(private readonly ctl: ReviewController, private readonly toUi: (realPath: string) => string = (p) => p) {
    this.sub = ctl.onDidChangeFiles(() => this.emitter.fire());
  }

  getTreeItem(item: FileItem): vscode.TreeItem {
    return item;
  }

  async getChildren(item?: FileItem): Promise<FileItem[]> {
    if (item) { return []; }
    const files = this.ctl.pendingFiles;
    const withCounts = files.length <= 200;
    return Promise.all(files.map(async (f) => new FileItem(f, withCounts ? await this.ctl.lineCounts(f) : undefined, this.toUi(f.absPath))));
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}
