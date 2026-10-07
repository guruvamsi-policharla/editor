/** The agent terminal (configurable command, default `tact`, docked right) and Ctrl/Cmd+L. */
import * as vscode from 'vscode';
import { AgentSession, type AgentTerminalIO } from './agentSession';
import { bracketedPaste, formatReference, selectionLines } from './reference';

export class AgentTerminal implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  /** Gates typing into the agent until its command has started (see agentSession.ts). */
  private session: AgentSession | undefined;
  private readonly sub: vscode.Disposable;

  constructor() {
    this.sub = vscode.window.onDidCloseTerminal((t) => {
      if (t === this.terminal) {
        this.terminal = undefined;
        this.session = undefined;
      }
    });
  }

  /** Show the agent terminal, starting the agent command in a new one if needed. */
  show(preserveFocus = false): vscode.Terminal {
    return this.open(preserveFocus).terminal;
  }

  private open(preserveFocus: boolean): { terminal: vscode.Terminal; session: AgentSession } {
    if (this.terminal && this.session && this.terminal.exitStatus === undefined) {
      this.terminal.show(preserveFocus);
      return { terminal: this.terminal, session: this.session };
    }
    const config = vscode.workspace.getConfiguration('agentReview.agent');
    const command = config.get<string>('command', 'tact').trim();
    const location = config.get<string>('location', 'right');
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri;
    const terminal = vscode.window.createTerminal({
      name: `Agent${command ? `: ${command.split(/\s+/)[0]}` : ''}`,
      iconPath: new vscode.ThemeIcon('hubot'),
      ...(cwd ? { cwd } : {}),
      location: location === 'panel' ? vscode.TerminalLocation.Panel : { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
    });
    // Start the agent inside the user's shell, so the terminal survives the agent exiting.
    const session = new AgentSession(terminalIO(terminal), command);
    this.terminal = terminal;
    this.session = session;
    terminal.show(preserveFocus);
    return { terminal, session };
  }

  /** Ctrl/Cmd+L: send `@path:L42-58` (and optionally the selected text) to the agent terminal. */
  async sendSelection(): Promise<void> {
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
    // In a terminal created just now, this waits until the agent command has started.
    await this.open(false).session.send(text);
  }

  dispose(): void {
    this.sub.dispose();
  }
}

function terminalIO(terminal: vscode.Terminal): AgentTerminalIO {
  return {
    get executeCommand() {
      const si = terminal.shellIntegration;
      return si ? (commandLine: string) => void si.executeCommand(commandLine) : undefined;
    },
    onDidActivateShellIntegration: (listener) =>
      vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal) listener();
      }),
    onDidStartExecution: (listener) =>
      vscode.window.onDidStartTerminalShellExecution((e) => {
        if (e.terminal === terminal) listener();
      }),
    sendText: (text, addNewLine) => terminal.sendText(text, addNewLine),
    get isClosed() {
      return terminal.exitStatus !== undefined;
    },
  };
}
