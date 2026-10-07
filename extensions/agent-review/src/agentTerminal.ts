/** The agent terminal (configurable command, default `tact`, docked right) and Ctrl/Cmd+L. */
import * as vscode from 'vscode';
import { bracketedPaste, formatReference, selectionLines } from './reference';

export class AgentTerminal implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private readonly sub: vscode.Disposable;

  constructor() {
    this.sub = vscode.window.onDidCloseTerminal((t) => {
      if (t === this.terminal) this.terminal = undefined;
    });
  }

  /** Show the agent terminal, starting the agent command in a new one if needed. */
  show(preserveFocus = false): vscode.Terminal {
    if (this.terminal && this.terminal.exitStatus === undefined) {
      this.terminal.show(preserveFocus);
      return this.terminal;
    }
    const config = vscode.workspace.getConfiguration('agentReview.agent');
    const command = config.get<string>('command', 'tact').trim();
    const location = config.get<string>('location', 'right');
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri;
    this.terminal = vscode.window.createTerminal({
      name: `Agent${command ? `: ${command.split(/\s+/)[0]}` : ''}`,
      iconPath: new vscode.ThemeIcon('hubot'),
      ...(cwd ? { cwd } : {}),
      location: location === 'panel' ? vscode.TerminalLocation.Panel : { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
    });
    // Start the agent inside the user's shell, so the terminal survives the agent exiting.
    if (command) this.terminal.sendText(command, true);
    this.terminal.show(preserveFocus);
    return this.terminal;
  }

  /** Ctrl/Cmd+L: send `@path:L42-58` (and optionally the selected text) to the agent terminal. */
  sendSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const config = vscode.workspace.getConfiguration('agentReview.agent');
    const sel = editor.selection;
    const [startLine, endLine] = selectionLines(sel.start, sel.end, sel.isEmpty);
    const doc = editor.document;
    const ref = formatReference(config.get<string>('referenceFormat', '@${relativePath}:${range}'), {
      relativePath: vscode.workspace.asRelativePath(doc.uri, false),
      absolutePath: doc.uri.fsPath,
      startLine,
      endLine,
    });
    let text = `${ref} `;
    if (config.get<boolean>('includeSelectedText', false) && !sel.isEmpty) text += bracketedPaste(doc.getText(sel));
    const terminal = this.show(false);
    terminal.sendText(text, false);
  }

  dispose(): void {
    this.sub.dispose();
  }
}
