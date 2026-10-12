// Agent Chat: VS Code's native chat, driven by ACP harnesses (Claude Code, Codex, tact) through @editor/acp-client.
//
// - A default participant (`isDefault`, defaultChatParticipant proposal) is what makes core show the chat view
//   and accept requests while Copilot is absent; it only points at the session types.
// - One chat session type per harness profile (harnessChat.ts), in the secondary side bar or as editor tabs.
// - Nothing here emits edit parts: the harness writes files itself and agent-review shows them with Keep/Undo.
// - Cmd/Ctrl+L: agent-review's "Send Selection to Agent" always calls `agentChat.insertReference` (never the agent
//   terminal). The reference goes in at the cursor, as an inline pill (core's `_agentChat.insertReference`, patch 94).
// - History (history.ts) for this workspace, searched by title and content (Search Chats); one agent edits at a
//   time across chats (scheduler.ts).
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { AdapterInstaller, BUILTIN_PROFILES } from '@editor/acp-client';
import { HarnessChat } from './harnessChat.js';
import { ChatHistory, menuTarget } from './history.js';
import { HarnessModels, MODEL_VENDOR } from './models.js';
import { TurnScheduler } from './scheduler.js';

let lastUsed: number | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const activatedAt = Date.now();
	const log = vscode.window.createOutputChannel('Agent Chat', { log: true });
	context.subscriptions.push(log);

	const models = new HarnessModels();
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(MODEL_VENDOR, models));
	const installer = new AdapterInstaller(join(context.globalStorageUri.fsPath, 'adapters'), join(context.extensionPath, 'dist', 'adapters'));
	const markUsed = () => { lastUsed = Date.now(); };
	// Chats belong to the workspace folder they ran in. Kept in global storage under a hash of the folder's path:
	// VS Code's workspace storage id can change for the same folder, which would lose the history.
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? '';
	const history = new ChatHistory(join(context.globalStorageUri.fsPath, 'chats', createHash('sha256').update(folder).digest('hex').slice(0, 16)));
	const scheduler = new TurnScheduler(() => vscode.workspace.getConfiguration('agentChat').get<boolean>('turns.waitForOtherChats', true));
	const env = { context, log, models, installer, activatedAt, markUsed, version: String(context.extension.packageJSON.version ?? '0.0.0'), history, scheduler };

	const chats = new Map<string, HarnessChat>();
	for (const profile of BUILTIN_PROFILES) {
		const chat = new HarnessChat(profile, env);
		chats.set(profile.id, chat);
		context.subscriptions.push(
			chat.register(),
			vscode.commands.registerCommand(`agentChat.login.${profile.id}`, () => chat.login()),
			vscode.commands.registerCommand(`agentChat.restart.${profile.id}`, () => chat.restart()),
		);
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
		vscode.commands.registerCommand('agentChat.newTact', () => open('tact', 'sidebar')),
		vscode.commands.registerCommand('agentChat.login', async (id?: string) => chatFor(id ?? await pickHarness())?.login()),
		vscode.commands.registerCommand('agentChat.restart', async (id?: string) => chatFor(id ?? await pickHarness())?.restart()),
		vscode.commands.registerCommand('agentChat.showLog', () => log.show()),
		// The status bar's Bypass permissions item: shows the chat that's in it.
		vscode.commands.registerCommand('agentChat.openChat', async (resource: string) => {
			const uri = vscode.Uri.parse(resource);
			if (!await Promise.resolve(vscode.commands.executeCommand<boolean>('_agentChat.openChat', uri, 'sidebar')).catch(() => false)) {
				await vscode.commands.executeCommand('vscode.open', uri);
			}
		}),
		// Retry on a Claude-side hiccup's card: sends the failed message again in its chat.
		vscode.commands.registerCommand('agentChat.retry', async (resource?: string, text?: string) => {
			if (typeof text !== 'string' || !text) {
				return;
			}
			const uri = resource ? vscode.Uri.parse(resource) : undefined;
			if (!await Promise.resolve(vscode.commands.executeCommand<boolean>('_agentChat.resend', uri, text)).catch(() => false)) {
				void vscode.window.showWarningMessage('Couldn\'t send the message again. Send it from the chat input.');
			}
		}),
		vscode.commands.registerCommand('agentChat.lastUsed', () => lastUsed),
		// Cmd/Ctrl+L to chat: insert the reference at the cursor of the last focused chat input, as an inline pill,
		// without sending it. Without the core command (an older core), the reference replaces the input.
		vscode.commands.registerCommand('agentChat.insertReference', async (text?: string, uri?: vscode.Uri, startLine?: number, endLine?: number) => {
			const ref = typeof text === 'string' ? { text: text.trim(), uri, startLine, endLine } : selectionReference();
			if (!ref?.text) {
				return;
			}
			markUsed();
			const range = ref.startLine ? new vscode.Range(ref.startLine - 1, 0, (ref.endLine ?? ref.startLine) - 1, 0) : undefined;
			const inserted = ref.uri && await Promise.resolve(vscode.commands.executeCommand<boolean>('_agentChat.insertReference', ref.text, ref.uri, range)).catch(() => false);
			if (!inserted) {
				await vscode.commands.executeCommand('workbench.action.chat.open', { query: `${ref.text} `, isPartialQuery: true });
			}
		}),
		vscode.commands.registerCommand('agentChat.searchChats', () => searchChats(history)),
		vscode.commands.registerCommand('agentChat.runNow', (id?: string) => {
			if (typeof id !== 'string' || !scheduler.runNow(id)) {
				void vscode.window.showInformationMessage('That message isn\'t waiting anymore.');
			}
		}),
		vscode.commands.registerCommand('agentChat.removeChat', async (arg?: unknown) => {
			const target = menuTarget(arg);
			const resource = target instanceof vscode.Uri ? target : target && vscode.Uri.from(target);
			const chat = resource && [...chats.values()].find(c => c.owns(resource));
			if (resource && chat) {
				await chat.removeChat(resource);
			}
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('agentChat.harnesses')) {
				void vscode.window.showInformationMessage('Agent Chat: harness settings changed. Restart the agent to apply them.', ...BUILTIN_PROFILES.map(p => `Restart ${p.label}`))
					.then(a => BUILTIN_PROFILES.find(p => a === `Restart ${p.label}`))
					.then(p => (p ? chats.get(p.id)?.restart() : undefined));
			}
		}),
	);
}

/** `@path:L42-58` for the active editor's selection (when agent-review isn't the caller). */
function selectionReference(): { text: string; uri: vscode.Uri; startLine: number; endLine: number } | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return undefined;
	}
	const s = editor.selection;
	const first = s.start.line + 1;
	const last = !s.isEmpty && s.end.character === 0 && s.end.line > s.start.line ? s.end.line : s.end.line + 1;
	const range = first === last ? `L${first}` : `L${first}-${last}`;
	return { text: `@${vscode.workspace.asRelativePath(editor.document.uri, false)}:${range}`, uri: editor.document.uri, startLine: first, endLine: last };
}

const HARNESS_LABEL = new Map(BUILTIN_PROFILES.map(p => [p.id, p.label]));

/** Search Chats: this workspace's chats, by title and content, newest first; opens the pick in the side bar. */
async function searchChats(history: ChatHistory): Promise<void> {
	const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { resource: string }>();
	pick.placeholder = 'Search chats by title or content';
	pick.matchOnDescription = false;
	const openInEditor = { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: 'Open in an editor tab' };
	const show = () => {
		const hits = history.search(pick.value);
		pick.items = hits.map(({ entry, snippet }) => ({
			label: entry.title,
			description: `${HARNESS_LABEL.get(entry.harness) ?? entry.harness} · ${ago(entry.updated)}`,
			...(snippet ? { detail: snippet } : {}),
			// Our own filter (content too): core's would only match the label.
			alwaysShow: true,
			buttons: [openInEditor],
			resource: entry.resource,
		}));
	};
	const open = async (resource: string, where: 'sidebar' | 'editor') => {
		pick.hide();
		const uri = vscode.Uri.parse(resource);
		const opened = await Promise.resolve(vscode.commands.executeCommand<boolean>('_agentChat.openChat', uri, where)).catch(() => false);
		if (!opened) {
			await vscode.commands.executeCommand('vscode.open', uri);
		}
	};
	pick.onDidChangeValue(show);
	pick.onDidAccept(() => { const item = pick.selectedItems[0]; if (item) { void open(item.resource, 'sidebar'); } });
	pick.onDidTriggerItemButton(e => void open(e.item.resource, 'editor'));
	pick.onDidHide(() => pick.dispose());
	show();
	pick.show();
}

function ago(time: number): string {
	const minutes = Math.round((Date.now() - time) / 60_000);
	if (minutes < 1) {
		return 'just now';
	}
	if (minutes < 60) {
		return `${minutes} min ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours} h ago`;
	}
	return new Date(time).toLocaleDateString();
}

export function deactivate(): void { /* sessions are disposed with the extension's subscriptions */ }
