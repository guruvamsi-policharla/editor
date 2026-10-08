// Agent Chat: VS Code's native chat, driven by ACP harnesses (Claude Code, Codex) through @editor/acp-client.
//
// - A default participant (`isDefault`, defaultChatParticipant proposal) is what makes core show the chat view
//   and accept requests while Copilot is absent; it only points at the session types.
// - One chat session type per harness profile (harnessChat.ts), in the secondary side bar or as editor tabs.
// - Nothing here emits edit parts: the harness writes files itself and agent-review shows them with Keep/Undo.
// - Cmd/Ctrl+L: agent-review's "Send Selection to Agent" calls `agentChat.insertReference` when the chat is the
//   target (`agentReview.agent.target`), using `agentChat.lastUsed` to pick between chat and terminal.
import { join } from 'node:path';
import * as vscode from 'vscode';
import { AdapterInstaller, BUILTIN_PROFILES } from '@editor/acp-client';
import { HarnessChat } from './harnessChat.js';
import { HarnessModels } from './models.js';

let lastUsed: number | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const activatedAt = Date.now();
	const log = vscode.window.createOutputChannel('Agent Chat', { log: true });
	context.subscriptions.push(log);

	const models = new HarnessModels();
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('agent-chat', models));
	const installer = new AdapterInstaller(join(context.globalStorageUri.fsPath, 'adapters'), join(context.extensionPath, 'dist', 'adapters'));
	const markUsed = () => { lastUsed = Date.now(); };
	const env = { context, log, models, installer, activatedAt, markUsed, version: String(context.extension.packageJSON.version ?? '0.0.0') };

	const chats = new Map<string, HarnessChat>();
	for (const profile of BUILTIN_PROFILES) {
		const chat = new HarnessChat(profile, env);
		chats.set(profile.id, chat);
		context.subscriptions.push(chat.register());
	}

	// The default participant: required for core to show chat (chatPanelParticipantRegistered) and enable it (chatIsEnabled).
	const def = vscode.chat.createChatParticipant('agent-chat.default', async (_request, _context, stream) => {
		stream.markdown('Pick an agent to chat with:\n\n');
		for (const profile of BUILTIN_PROFILES) {
			stream.button({ command: 'agentChat.newChat', title: profile.label, arguments: [profile.id] });
		}
		return {};
	});
	context.subscriptions.push(def);

	const chatFor = (id: unknown) => chats.get(typeof id === 'string' ? id : 'claude');
	const pickHarness = async (): Promise<string | undefined> => {
		const pick = await vscode.window.showQuickPick(BUILTIN_PROFILES.map(p => ({ label: p.label, id: p.id })), { placeHolder: 'Agent' });
		return pick?.id;
	};
	const open = async (id: unknown, where: 'sidebar' | 'editor') => {
		const harness = typeof id === 'string' ? id : await pickHarness();
		if (harness) {
			markUsed();
			await vscode.commands.executeCommand(`workbench.action.chat.openNewChatSessionInPlace.agent-${harness}`, where);
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('agentChat.newChat', (id?: string) => open(id, 'sidebar')),
		vscode.commands.registerCommand('agentChat.newChatInEditor', (id?: string) => open(id, 'editor')),
		vscode.commands.registerCommand('agentChat.newClaude', () => open('claude', 'sidebar')),
		vscode.commands.registerCommand('agentChat.newCodex', () => open('codex', 'sidebar')),
		vscode.commands.registerCommand('agentChat.login', async (id?: string) => chatFor(id ?? await pickHarness())?.login()),
		vscode.commands.registerCommand('agentChat.restart', async (id?: string) => chatFor(id ?? await pickHarness())?.restart()),
		vscode.commands.registerCommand('agentChat.showLog', () => log.show()),
		vscode.commands.registerCommand('agentChat.lastUsed', () => lastUsed),
		// Cmd/Ctrl+L to chat: insert the reference into the last focused chat input without sending it.
		vscode.commands.registerCommand('agentChat.insertReference', async (text?: string) => {
			const ref = typeof text === 'string' ? text : selectionReference();
			if (!ref) {
				return;
			}
			markUsed();
			await vscode.commands.executeCommand('workbench.action.chat.open', { query: ref, isPartialQuery: true });
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('agentChat.harnesses')) {
				void vscode.window.showInformationMessage('Agent Chat: harness settings changed. Restart the agent to apply them.', 'Restart Claude Code', 'Restart Codex')
					.then(a => (a ? chats.get(a.includes('Codex') ? 'codex' : 'claude')?.restart() : undefined));
			}
		}),
	);
}

/** `@path:L42-58 ` for the active editor's selection (when agent-review isn't the caller). */
function selectionReference(): string | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return undefined;
	}
	const s = editor.selection;
	const first = s.start.line + 1;
	const last = !s.isEmpty && s.end.character === 0 && s.end.line > s.start.line ? s.end.line : s.end.line + 1;
	const range = first === last ? `L${first}` : `L${first}-${last}`;
	return `@${vscode.workspace.asRelativePath(editor.document.uri, false)}:${range} `;
}

export function deactivate(): void { /* sessions are disposed with the extension's subscriptions */ }
