// Render ops → VS Code chat stream parts. Never pushes edit parts (textEdit/workspaceEdit/externalEdit): the
// harness writes files itself and agent-review shows Keep/Undo, so the chat's own editing session stays empty.
import * as vscode from 'vscode';
import { STOPPED, type RenderOp, type ToolCard } from './render.js';
import type { TranscriptTurn } from './transcript.js';

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
	// Not confirmed while its permission prompt is open. Core doesn't pass this on for live updates yet; with the
	// core change asked for in #32, Stop shows an approved, running command as stopped instead of Skipped.
	part.isConfirmed = !card.awaitingApproval;
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

/**
 * A saved transcript as core's chat history: one request and one response per turn. A request carries the model
 * it ran on (`modelId`, the language model identifier): core selects the last one in a reopened chat's model
 * picker, instead of the session type's default.
 */
export function historyTurns(turns: readonly TranscriptTurn[], participant: string, chatId: string, modelId: (value: string) => string = v => v): (vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[] {
	const out: (vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[] = [];
	turns.forEach((turn, i) => {
		// Request ids must be unique across chats.
		out.push(new vscode.ChatRequestTurn2(turn.prompt, undefined, [], participant, [], undefined, `${chatId}#${i}`, turn.model ? modelId(turn.model) : undefined, undefined));
		const parts: (vscode.ChatResponseMarkdownPart | vscode.ChatResponseThinkingProgressPart | vscode.ChatToolInvocationPart)[] = [];
		for (const op of turn.ops) {
			switch (op.op) {
				case 'markdown':
					parts.push(new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(op.text)));
					break;
				case 'thinking':
					parts.push(new vscode.ChatResponseThinkingProgressPart(op.text, op.id, { vscodeReasoningDone: true }));
					break;
				case 'tool':
					parts.push(toolPart({ ...op.card, complete: true }));
					break;
				case 'todo':
					parts.push(new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(op.items.map(t => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.title}`).join('\n'))));
					break;
			}
		}
		if (turn.stopped) {
			parts.push(new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(`\n\n*${STOPPED}.*`)));
		}
		out.push(new vscode.ChatResponseTurn2(parts, {}, participant));
	});
	return out;
}
