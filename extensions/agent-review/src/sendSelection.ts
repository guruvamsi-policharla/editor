/**
 * Ctrl/Cmd+L (bound in core, patch 94): insert `@path:L42-58` for the selection, or `@path` with nothing selected, into the
 * agent chat's input, at its cursor. Never the agent terminal.
 */
import * as vscode from 'vscode';
import { formatReference, selectionLines } from './reference';

export async function sendSelectionToChat(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }
  // Only the built-in chat takes references; with it off the command is hidden and Cmd/Ctrl+L isn't bound to it.
  if (vscode.workspace.getConfiguration().get<boolean>('agentChat.tact.enabled', false) !== true) {
    void vscode.window.showInformationMessage('Send Selection to Agent needs the built-in chat: turn on the "agentChat.tact.enabled" setting.');
    return;
  }
  const config = vscode.workspace.getConfiguration('agentReview.agent');
  const sel = editor.selection;
  const [startLine, endLine] = sel.isEmpty ? [undefined, undefined] : selectionLines(sel.start, sel.end);
  const doc = editor.document;
  const format = startLine === undefined
    ? config.get<string>('fileReferenceFormat', '@${relativePath}')
    : config.get<string>('referenceFormat', '@${relativePath}:${range}');
  const ref = formatReference(format, {
    relativePath: vscode.workspace.asRelativePath(doc.uri, false),
    absolutePath: doc.uri.fsPath,
    startLine,
    endLine,
  });
  try {
    // agent-chat inserts it at the chat input's cursor as an inline reference to these lines (or the file).
    await vscode.commands.executeCommand('agentChat.insertReference', ref, doc.uri, startLine, endLine);
  } catch {
    void vscode.window.showWarningMessage('Send Selection to Agent needs the Agent Chat extension, which isn\'t available.');
  }
}
