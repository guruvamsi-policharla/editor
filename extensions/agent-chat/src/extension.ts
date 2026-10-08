// Spike (phase A0): VS Code's native chat driven from a built-in extension, without Copilot.
//
// - A default participant (`isDefault`, defaultChatParticipant proposal) is what makes core show the chat view
//   and accept requests; it only points at the session types.
// - Two chat session types (chatSessionsProvider proposal): `agent-claude` relays to claude-agent-acp through
//   @editor/acp-client; `agent-echo` echoes, with five pickers and a native permission prompt, for UI checks.
// - ACP config options become option groups (pickers); permission requests use the core confirmation tool.
// - Nothing here emits edit parts (textEdit/workspaceEdit/externalEdit): the harness writes files itself and
//   agent-review shows them, so the chat's own editing session stays empty.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { AgentConnection, type acp } from '@editor/acp-client';
import { modelChoices, pickersFromConfig, toGroups, type Picker } from './options.js';

const CLAUDE = 'agent-claude';
const ECHO = 'agent-echo';
const CONFIRM_TOOL = 'vscode_get_confirmation_with_options';

let log: vscode.LogOutputChannel;

export function activate(context: vscode.ExtensionContext): void {
	log = vscode.window.createOutputChannel('Agent Chat', { log: true });
	context.subscriptions.push(log);

	// The default participant: required for core to show chat (chatPanelParticipantRegistered) and enable it (chatIsEnabled).
	const def = vscode.chat.createChatParticipant('agent-chat.default', async (_request, _context, stream) => {
		stream.markdown('Start a harness session:\n\n');
		stream.button({ command: 'agentChat.newClaude', title: 'Claude Code' });
		stream.button({ command: 'agentChat.newEcho', title: 'Echo (spike)' });
		return {};
	});
	context.subscriptions.push(def);

	const models = new HarnessModels();
	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('agent-chat', models));
	models.set(ECHO, [{ id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }, { id: 'haiku', name: 'Haiku' }], 'sonnet');
	context.subscriptions.push(new EchoSessions().register());
	context.subscriptions.push(new ClaudeSessions(models).register());

	context.subscriptions.push(
		vscode.commands.registerCommand('agentChat.newClaude', (where: 'sidebar' | 'editor' = 'sidebar') =>
			vscode.commands.executeCommand(`workbench.action.chat.openNewChatSessionInPlace.${CLAUDE}`, where)),
		vscode.commands.registerCommand('agentChat.newEcho', (where: 'sidebar' | 'editor' = 'sidebar') =>
			vscode.commands.executeCommand(`workbench.action.chat.openNewChatSessionInPlace.${ECHO}`, where)),
		// Cmd/Ctrl+L to chat: insert `@path:Lx-y` into the last focused chat input without sending it.
		vscode.commands.registerCommand('agentChat.insertReference', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}
			const s = editor.selection;
			const last = !s.isEmpty && s.end.character === 0 && s.end.line > s.start.line ? s.end.line : s.end.line + 1;
			const first = s.start.line + 1;
			const range = first === last ? `L${first}` : `L${first}-${last}`;
			const ref = `@${vscode.workspace.asRelativePath(editor.document.uri, false)}:${range} `;
			await vscode.commands.executeCommand('workbench.action.chat.open', { query: ref, isPartialQuery: true });
		}),
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Models: the harness's model choices, shown in core's native model picker.
//
// Core resolves `request.model` for every chat request and throws "Language model unavailable" when no model
// exists, and a contributed session type's Send is disabled without one. So each session type declares
// `requiresCustomModels` and we register its harness's models, targeted at that type. They are labels only:
// the choice is forwarded to the harness (ACP `model` option); the editor never calls a model.

class HarnessModels implements vscode.LanguageModelChatProvider {
	private readonly byType = new Map<string, { items: { id: string; name: string }[]; current: string }>();
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changed.event;

	set(sessionType: string, items: { id: string; name: string }[], current: string): void {
		this.byType.set(sessionType, { items, current });
		this.changed.fire();
	}

	/** `request.model.id` → the harness's model value. */
	static valueOf(model: vscode.LanguageModelChat): string {
		return model.id.slice(model.id.indexOf(':') + 1);
	}

	provideLanguageModelChatInformation(): vscode.LanguageModelChatInformation[] {
		return [...this.byType].flatMap(([type, { items, current }]) => items.map(i => ({
			id: `${type}:${i.id}`,
			name: i.name,
			family: type,
			version: '1',
			maxInputTokens: 0,
			maxOutputTokens: 0,
			capabilities: {},
			targetChatSessionType: type,
			isUserSelectable: true,
			isDefault: i.id === current,
		})));
	}

	provideLanguageModelChatResponse(): Thenable<void> {
		throw new Error('Harness models are chosen for the harness; the editor does not call models.');
	}

	provideTokenCount(): Thenable<number> {
		return Promise.resolve(0);
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Permission prompts

/** A native, blocking confirmation in the chat (can't be auto-approved). Returns the clicked label, or undefined if denied/cancelled. */
async function confirm(request: vscode.ChatRequest, title: string, message: string, buttons: string[], token: vscode.CancellationToken): Promise<string | undefined> {
	try {
		const result = await vscode.lm.invokeTool(CONFIRM_TOOL, { input: { title, message, buttons }, toolInvocationToken: request.toolInvocationToken }, token);
		const part = result.content[0];
		return part instanceof vscode.LanguageModelTextPart ? part.value : undefined;
	} catch (e) {
		log.info(`confirmation dismissed: ${String(e)}`);
		return undefined;
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Echo sessions: UI checks without spending model usage.

class EchoSessions {
	private readonly pickers: Picker[] = [
		{ id: 'mode', name: 'Mode', selected: 'acceptEdits', items: [{ id: 'default', name: 'Manual' }, { id: 'acceptEdits', name: 'Accept edits' }, { id: 'auto', name: 'Auto' }] },
		{ id: 'effort', name: 'Effort', selected: 'high', items: ['low', 'medium', 'high', 'xhigh', 'max'].map(v => ({ id: v, name: v[0]!.toUpperCase() + v.slice(1) })) },
		{ id: 'fast', name: 'Fast', selected: 'off', items: [{ id: 'off', name: 'Fast: off' }, { id: 'on', name: 'Fast: on' }] },
		{ id: 'plan', name: 'Plan', selected: 'default', items: [{ id: 'default', name: 'Build' }, { id: 'plan', name: 'Plan' }] },
	];

	register(): vscode.Disposable {
		const controller = vscode.chat.createChatSessionItemController(ECHO, async () => { /* no history in the spike */ });
		controller.newChatSessionItemHandler = async ctx => {
			const item = controller.createChatSessionItem(vscode.Uri.from({ scheme: ECHO, path: `/${Date.now()}` }), ctx.request.prompt.slice(0, 40) || 'Echo');
			controller.items.add(item);
			return item;
		};
		controller.getChatSessionInputState = (_resource, ctx) => controller.createChatSessionInputState(toGroups(this.pickers, ctx.previousInputState));

		const participant = vscode.chat.createChatParticipant(ECHO, (request, context, stream, token) => this.handle(request, context, stream, token));
		// No provideHandleOptionsChange: with it, core takes the legacy path and doesn't update the controller's input state.
		const provider: vscode.ChatSessionContentProvider = {
			provideChatSessionContent: () => ({ history: [], requestHandler: undefined }),
		};
		return vscode.Disposable.from(controller, participant, vscode.chat.registerChatSessionContentProvider(ECHO, provider, participant));
	}

	private async handle(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		const groups = context.chatSessionContext?.inputState.groups ?? [];
		const current = { model: HarnessModels.valueOf(request.model), ...Object.fromEntries(groups.map(g => [g.id, g.selected?.id ?? '?'])) };
		if (/permission/i.test(request.prompt)) {
			const command = `python3 -c "open('ran.txt','w').write('x')"`;
			const answer = await confirm(request, 'Allow this command?', `Claude wants to run:\n\n\`${command}\``, ['Yes', 'Yes, and don\'t ask again for python3 commands', 'No'], token);
			stream.markdown(answer ? `You chose **${answer}**.` : 'Denied (or cancelled).');
			return {};
		}
		const tool = new vscode.ChatToolInvocationPart('Bash', `echo-${Date.now()}`);
		tool.invocationMessage = 'Running `echo`';
		tool.pastTenseMessage = 'Ran `echo`';
		tool.isComplete = true;
		tool.isConfirmed = true;
		stream.push(tool);
		stream.markdown(`**Echo:** ${request.prompt}\n\nPickers: ${Object.entries(current).map(([k, v]) => `${k}=\`${v}\``).join(', ')}`);
		return {};
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Claude sessions: relay to claude-agent-acp. One adapter process; one ACP session per chat session.

class ClaudeSessions {
	private agent: AgentConnection | undefined;
	private ready: Promise<AgentConnection> | undefined;
	/** chat session resource → ACP session id */
	private readonly sessions = new Map<string, string>();
	/** A session created ahead of the first prompt, so the pickers show the agent's options in a new chat. */
	private warm: Promise<acp.NewSessionResponse> | undefined;
	private readonly options = new Map<string, readonly acp.SessionConfigOption[]>();
	private readonly inputStates = new Set<vscode.ChatSessionInputState>();

	constructor(private readonly models: HarnessModels) { }

	register(): vscode.Disposable {
		const controller = vscode.chat.createChatSessionItemController(CLAUDE, async () => { /* history: phase D */ });
		controller.newChatSessionItemHandler = async ctx => {
			const item = controller.createChatSessionItem(vscode.Uri.from({ scheme: CLAUDE, path: `/${Date.now()}` }), ctx.request.prompt.slice(0, 40) || 'Claude Code');
			controller.items.add(item);
			return item;
		};
		controller.getChatSessionInputState = async (resource, ctx) => {
			let config: readonly acp.SessionConfigOption[] | undefined;
			const id = resource && this.sessions.get(resource.toString());
			if (id) {
				config = this.options.get(id);
			} else {
				try {
					config = (await this.warmSession()).configOptions ?? undefined;
				} catch (e) {
					log.error(`claude: could not start a session: ${String(e)}`);
				}
			}
			const state = controller.createChatSessionInputState(toGroups(pickersFromConfig(config), ctx.previousInputState));
			this.inputStates.add(state);
			state.onDidDispose(() => this.inputStates.delete(state));
			// A picker change → set_config_option on the ACP session (Claude applies it live).
			state.onDidChange(() => { void this.applyPickers(state); });
			return state;
		};

		const participant = vscode.chat.createChatParticipant(CLAUDE, (request, context, stream, token) => this.handle(request, context, stream, token));
		const provider: vscode.ChatSessionContentProvider = {
			provideChatSessionContent: () => ({ history: [], requestHandler: undefined }),
		};
		return vscode.Disposable.from(controller, participant, vscode.chat.registerChatSessionContentProvider(CLAUDE, provider, participant), {
			dispose: () => { void this.agent?.dispose(); },
		});
	}

	private async applyPickers(state: vscode.ChatSessionInputState, sessionId?: string): Promise<void> {
		const resource = state.sessionResource?.toString();
		const id = sessionId ?? ((resource && this.sessions.get(resource)) || (await this.warm)?.sessionId);
		if (!id) {
			return;
		}
		for (const group of state.groups) {
			const current = this.options.get(id)?.find(o => o.id === group.id)?.currentValue;
			if (!group.selected || group.selected.id === current) {
				continue;
			}
			try {
				this.setOptions(id, (await (await this.connection()).setConfigOption(id, group.id, group.selected.id)).configOptions);
				log.info(`claude set ${group.id}=${group.selected.id}`);
			} catch (e) {
				log.error(`claude set ${group.id}=${group.selected.id} failed: ${String(e)}`);
			}
		}
	}

	private connection(): Promise<AgentConnection> {
		this.ready ??= (async () => {
			const adapter = vscode.workspace.getConfiguration('agentChat').get<string>('claude.adapterPath', 'claude-agent-acp');
			const agent = new AgentConnection({ command: adapter, env: { CLAUDE_CODE_EXECUTABLE: findClaude() }, cwd: workspaceRoot() });
			this.agent = agent;
			agent.onUpdate(n => {
				if (n.update.sessionUpdate === 'config_option_update') {
					this.setOptions(n.sessionId, n.update.configOptions);
				}
			});
			const init = await agent.initialize();
			log.info(`claude: ${init.agentInfo?.name} ${init.agentInfo?.version}, protocol ${init.protocolVersion}`);
			return agent;
		})();
		return this.ready;
	}

	private warmSession(): Promise<acp.NewSessionResponse> {
		this.warm ??= (async () => {
			const agent = await this.connection();
			const session = await agent.newSession({
				cwd: workspaceRoot(),
				mcpServers: [],
				_meta: { claudeCode: { options: { allowDangerouslySkipPermissions: false } } },
			});
			// The approved default: Accept edits, with prompts for commands.
			if (session.configOptions?.some(o => o.id === 'mode')) {
				const res = await agent.setConfigOption(session.sessionId, 'mode', 'acceptEdits');
				session.configOptions = res.configOptions;
			}
			this.setOptions(session.sessionId, session.configOptions ?? []);
			return session;
		})();
		return this.warm;
	}

	private setOptions(sessionId: string, config: readonly acp.SessionConfigOption[]): void {
		this.options.set(sessionId, config);
		const models = modelChoices(config);
		if (models) {
			this.models.set(CLAUDE, models.items, models.current);
		}
		const groups = toGroups(pickersFromConfig(config));
		for (const state of this.inputStates) {
			const resource = state.sessionResource?.toString();
			if (!resource || this.sessions.get(resource) === sessionId) {
				state.groups = groups;
			}
		}
	}

	private async handle(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		const agent = await this.connection();
		const resource = context.chatSessionContext?.chatSessionItem.resource.toString() ?? 'default';
		let sessionId = this.sessions.get(resource);
		if (!sessionId) {
			sessionId = (await this.warmSession()).sessionId;
			this.sessions.set(resource, sessionId);
			this.warm = undefined; // the next new chat gets its own session
		}
		const sid = sessionId;

		// Pickers chosen before the first prompt (carried over from the untitled chat) reach the ACP session here.
		if (context.chatSessionContext) {
			await this.applyPickers(context.chatSessionContext.inputState, sid);
		}

		// The native model picker's choice → the ACP model option (Claude applies it live).
		const model = this.options.get(sid)?.find(o => o.category === 'model');
		const wanted = HarnessModels.valueOf(request.model);
		if (model && model.currentValue !== wanted) {
			this.setOptions(sid, (await agent.setConfigOption(sid, model.id, wanted)).configOptions);
			log.info(`claude set ${model.id}=${wanted}`);
		}

		const tools = new Map<string, vscode.ChatToolInvocationPart>();
		const off = agent.onUpdate(n => {
			if (n.sessionId !== sid) {
				return;
			}
			const u = n.update;
			switch (u.sessionUpdate) {
				case 'agent_message_chunk':
					if (u.content.type === 'text') {
						stream.markdown(u.content.text);
					}
					break;
				case 'agent_thought_chunk':
					if (u.content.type === 'text') {
						stream.thinkingProgress({ id: `thought-${sid}`, text: u.content.text });
					}
					break;
				case 'tool_call': {
					const part = new vscode.ChatToolInvocationPart(u.kind ?? 'tool', u.toolCallId);
					part.invocationMessage = u.title;
					part.enablePartialUpdate = true;
					tools.set(u.toolCallId, part);
					stream.push(part);
					break;
				}
				case 'tool_call_update': {
					const part = tools.get(u.toolCallId);
					if (part && (u.status === 'completed' || u.status === 'failed')) {
						part.isComplete = true;
						part.isError = u.status === 'failed';
						part.pastTenseMessage = u.title ?? (typeof part.invocationMessage === 'string' ? part.invocationMessage : undefined);
						stream.push(part);
					}
					break;
				}
			}
		});
		agent.setPermissionHandler(async p => {
			if (p.sessionId !== sid) {
				return { outcome: { outcome: 'cancelled' } };
			}
			const command = typeof p.toolCall.rawInput === 'object' && p.toolCall.rawInput && 'command' in p.toolCall.rawInput ? String(p.toolCall.rawInput.command) : undefined;
			const message = `${p.toolCall.title ?? 'Claude wants to use a tool'}${command ? `\n\n\`${command}\`` : ''}`;
			const label = await confirm(request, 'Allow?', message, p.options.map(o => o.name), token);
			const chosen = p.options.find(o => o.name === label);
			log.info(`permission ${p.toolCall.toolCallId}: ${chosen ? `${chosen.kind} (${chosen.optionId})` : 'cancelled'}`);
			return { outcome: chosen ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' } };
		});
		const cancel = token.onCancellationRequested(() => { void agent.cancel(sid); });
		try {
			const result = await agent.prompt(sid, request.prompt);
			return { metadata: { stopReason: result.stopReason } };
		} finally {
			off();
			cancel.dispose();
		}
	}
}

function workspaceRoot(): string {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
}

function findClaude(): string | undefined {
	try {
		return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || undefined;
	} catch {
		const local = join(homedir(), '.local/bin/claude');
		return existsSync(local) ? local : undefined;
	}
}
