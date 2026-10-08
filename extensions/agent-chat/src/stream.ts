// Render ops → VS Code chat stream parts. Never pushes edit parts (textEdit/workspaceEdit/externalEdit): the
// harness writes files itself and agent-review shows Keep/Undo, so the chat's own editing session stays empty.
import * as vscode from 'vscode';
import type { RenderOp, ToolCard } from './render.js';

const TODO_TOOL = 'manage_todo_list';

export class StreamWriter {
	constructor(
		private readonly stream: vscode.ChatResponseStream,
		private readonly request: vscode.ChatRequest,
		private readonly token: vscode.CancellationToken,
		private readonly log: vscode.LogOutputChannel,
	) { }

	write(ops: readonly RenderOp[]): void {
		for (const op of ops) {
			switch (op.op) {
				case 'markdown':
					this.stream.markdown(op.text);
					break;
				case 'thinking':
					this.stream.thinkingProgress({ id: op.id, text: op.text });
					break;
				case 'thinkingDone':
					this.stream.push(new vscode.ChatResponseThinkingProgressPart('', op.id, { vscodeReasoningDone: true }));
					break;
				case 'tool':
					this.stream.push(toolPart(op.card));
					break;
				case 'todo':
					// Core's todo tool renders the list above the chat input (the same widget Copilot's agents use).
					vscode.lm.invokeTool(TODO_TOOL, { input: { operation: 'write', todoList: op.items }, toolInvocationToken: this.request.toolInvocationToken }, this.token)
						.then(undefined, e => this.log.warn(`todo list: ${String(e)}`));
					break;
			}
		}
	}
}

export function toolPart(card: ToolCard): vscode.ChatToolInvocationPart {
	const part = new vscode.ChatToolInvocationPart(card.toolName, card.id);
	part.enablePartialUpdate = true;
	part.isConfirmed = true;
	part.isComplete = card.complete;
	part.isError = card.error;
	part.invocationMessage = new vscode.MarkdownString(card.invocation);
	part.pastTenseMessage = new vscode.MarkdownString(card.past);
	if (card.terminal) {
		part.toolSpecificData = {
			commandLine: { original: card.terminal.command },
			language: 'sh',
			...(card.terminal.output !== undefined ? { output: { text: card.terminal.output.replace(/\r?\n/g, '\r\n') } } : {}),
			...(card.terminal.exitCode !== undefined ? { state: { exitCode: card.terminal.exitCode } } : {}),
		} satisfies vscode.ChatTerminalToolInvocationData;
	} else if (card.simple) {
		part.toolSpecificData = { input: card.simple.input, output: card.simple.output } satisfies vscode.ChatSimpleToolResultData;
	}
	return part;
}
