/** The agent terminal (configurable command, default `tact`, docked right). Ctrl/Cmd+L goes to the agent chat (sendSelection.ts). */
import * as vscode from 'vscode';
import { AgentSession, type AgentTerminalIO } from './agentSession';

export class AgentTerminal implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  /** Gates typing into the agent until its command has started (see agentSession.ts). */
  private session: AgentSession | undefined;
  private readonly subs: vscode.Disposable[];

  constructor() {
    this.subs = [
      vscode.window.onDidCloseTerminal((t) => {
        if (t === this.terminal) {
          this.terminal = undefined;
          this.session = undefined;
        }
      }),
    ];
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

  dispose(): void {
    this.subs.forEach((d) => d.dispose());
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
        if (e.terminal === terminal) { listener(); }
      }),
    onDidStartExecution: (listener) =>
      vscode.window.onDidStartTerminalShellExecution((e) => {
        if (e.terminal === terminal) { listener(); }
      }),
    sendText: (text, addNewLine) => terminal.sendText(text, addNewLine),
    get isClosed() {
      return terminal.exitStatus !== undefined;
    },
  };
}
