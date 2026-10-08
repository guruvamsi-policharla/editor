/** Ctrl/Cmd+L: insert `@path:L42-58` for the selection into the agent chat's input, at its cursor. Never the agent terminal. */
import * as vscode from 'vscode';
import { formatReference, selectionLines } from './reference';

export async function sendSelectionToChat(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }
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
  try {
    // agent-chat inserts it at the chat input's cursor as an inline reference to these lines.
    await vscode.commands.executeCommand('agentChat.insertReference', ref, doc.uri, startLine, endLine);
  } catch {
    void vscode.window.showWarningMessage('Send Selection to Agent needs the Agent Chat extension, which isn\'t available.');
  }
}
