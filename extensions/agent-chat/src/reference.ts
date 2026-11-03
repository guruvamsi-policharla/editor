// Cmd/Ctrl+L into the chat. Core's `_agentChat.insertReference` (patch 94) puts the reference in the chat input at its
// cursor, as an inline pill, also when the chat was closed or hidden, and leaves keyboard focus in that input with the
// caret right after the reference. Without it (an older core), the chat opens with the reference as its input.
import * as vscode from 'vscode';

export interface ChatReference {
	readonly text: string;
	readonly uri?: vscode.Uri;
	/** 1-based lines; none for a whole file. */
	readonly startLine?: number;
	readonly endLine?: number;
}

export async function insertReference(ref: ChatReference): Promise<void> {
	const range = ref.startLine ? new vscode.Range(ref.startLine - 1, 0, (ref.endLine ?? ref.startLine) - 1, 0) : undefined;
	const inserted = ref.uri && await Promise.resolve(vscode.commands.executeCommand<boolean>('_agentChat.insertReference', ref.text, ref.uri, range)).catch(() => false);
	if (!inserted) {
		// The trailing space leaves the caret after the reference (the chat focuses its input with the caret at the end).
		await vscode.commands.executeCommand('workbench.action.chat.open', { query: `${ref.text} `, isPartialQuery: true });
	}
}
