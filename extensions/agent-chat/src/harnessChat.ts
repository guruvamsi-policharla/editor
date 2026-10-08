// One chat session type per harness (`agent-claude`, `agent-codex`), driven by @editor/acp-client.
//
// - Lazy: nothing starts at window load. The pickers show the options remembered from the last session (or the
//   profile's placeholder model); the adapter starts on the first message, or in the background when the user
//   opens a new chat of this type after startup.
// - ACP config options → the native model picker (model) and option pickers (everything else), re-rendered
//   from every response and `config_option_update`. Dangerous values (Codex Full access) need a modal confirm.
// - Permission requests → core's confirmation tool, which can't be auto-approved; Stop → `session/cancel`.
// - Not logged in → a "Sign in" picker and a warning with a button that runs the harness's login in a terminal.
// - An adapter crash ends the turn with an error; the next message restarts it and resumes the session.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import {
	AdapterInstaller, AgentSupervisor, claudePersistence, codexPersistence, configControls, errorMessage, HarnessClient,
	isAuthRequired, isDangerous, PermissionBroker,
	type AcpSession, type acp, type AgentStatus, type ConfigControl, type HarnessProfile, type PermissionPrompt, type ProfileOverride,
} from '@editor/acp-client';
import { changedSelections, groupsFromControls, signInGroup, SIGN_IN_GROUP } from './groups.js';
import { loginCommand, resolveLaunch } from './launch.js';
import { HarnessModels } from './models.js';
import { promptBlocks, type PromptReference } from './prompt.js';
import { TurnRenderer } from './render.js';
import { StreamWriter } from './stream.js';

const CONFIRM_TOOL = 'vscode_get_confirmation_with_options';
/** Opening a chat this long after activation counts as the user's doing (not a window restore): warm up. */
const WARM_AFTER_MS = 5000;

export interface ChatEnv {
	context: vscode.ExtensionContext;
	log: vscode.LogOutputChannel;
	models: HarnessModels;
	installer: AdapterInstaller;
	activatedAt: number;
	/** Called whenever the user works with a chat (for Cmd/Ctrl+L's "last used" target). */
	markUsed: () => void;
	version: string;
}

const icon = (id: string) => new vscode.ThemeIcon(id);

export class HarnessChat implements vscode.Disposable {
	readonly type: string;
	private client: HarnessClient | undefined;
	/** chat session resource → ACP session */
	private readonly sessions = new Map<string, AcpSession>();
	private warm: Promise<AcpSession> | undefined;
	private warmSession: AcpSession | undefined;
	private auth: 'unknown' | 'required' = 'unknown';
	private readonly inputStates = new Set<vscode.ChatSessionInputState>();
	/**
	 * What we last put in each input state's pickers. Core reports our own `groups` assignments back through
	 * onDidChange, asynchronously; only selections that differ from these are the user's.
	 */
	private readonly lastSet = new WeakMap<vscode.ChatSessionInputState, Map<string, string>>();
	private readonly pickerTimers = new WeakMap<vscode.ChatSessionInputState, ReturnType<typeof setTimeout>>();
	private readonly items = new Map<string, vscode.ChatSessionItem>();
	/** chat session resource → the model picker's selection at its last message */
	private readonly pickedModels = new Map<string, string>();
	private controller!: vscode.ChatSessionItemController;
	private turns = 0;
	/** When a turn last showed a crash in the chat (no second notification for the same crash). */
	private crashShownAt = 0;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(readonly profile: HarnessProfile, private readonly env: ChatEnv) {
		this.type = `agent-${profile.id}`;
	}

	private get label(): string {
		return this.profile.label;
	}

	private override(): ProfileOverride | undefined {
		return vscode.workspace.getConfiguration('agentChat').get<Record<string, ProfileOverride>>('harnesses')?.[this.profile.id];
	}

	private cwd(): string {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
	}

	// ---------------------------------------------------------------------------------------------------------
	// Registration

	register(): vscode.Disposable {
		const controller = this.controller = vscode.chat.createChatSessionItemController(this.type, async () => { /* history: phase D */ });
		controller.newChatSessionItemHandler = async ctx => {
			const resource = vscode.Uri.from({ scheme: this.type, path: `/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` });
			const item = controller.createChatSessionItem(resource, ctx.request.prompt.slice(0, 50) || this.label);
			item.timing = { created: Date.now(), lastRequestStarted: Date.now() };
			controller.items.add(item);
			this.items.set(resource.toString(), item);
			return item;
		};
		controller.getChatSessionInputState = (resource, ctx) => this.inputState(resource, ctx);

		const participant = vscode.chat.createChatParticipant(this.type, (request, context, stream, token) => this.handle(request, context, stream, token));
		participant.iconPath = new vscode.ThemeIcon(this.profile.id === 'claude' ? 'sparkle' : 'terminal');
		// No provideHandleOptionsChange: with it, core takes a legacy path that leaves the controller's input state stale.
		const provider: vscode.ChatSessionContentProvider = {
			provideChatSessionContent: () => ({ history: [], requestHandler: undefined }),
		};
		this.publishModels();
		return vscode.Disposable.from(controller, participant, vscode.chat.registerChatSessionContentProvider(this.type, provider, participant), this);
	}

	// ---------------------------------------------------------------------------------------------------------
	// The adapter

	private harness(): HarnessClient {
		if (!this.client) {
			const supervisor = new AgentSupervisor({
				launch: progress => resolveLaunch(this.profile, this.override(), this.env.installer, this.cwd(), progress),
				clientInfo: { name: 'editor', title: vscode.env.appName, version: this.env.version },
			});
			const broker = new PermissionBroker(this.profile.id === 'codex' ? codexPersistence : claudePersistence);
			broker.onAudit(a => this.env.log.info(`[${this.profile.id}] permission ${a.toolCallId}: ${a.outcome}${a.optionId ? ` ${a.optionKind} (${a.optionId})` : ''}${a.reason ? ` [${a.reason}]` : ''} — ${a.command ?? a.title}`));
			supervisor.onStatus(s => this.onStatus(s));
			this.client = new HarnessClient(this.profile, supervisor, this.cwd(), broker);
		}
		return this.client;
	}

	private onStatus(s: AgentStatus): void {
		const log = this.env.log;
		switch (s.state) {
			case 'starting':
				log.info(`[${this.profile.id}] starting${s.message ? `: ${s.message}` : ''}`);
				break;
			case 'ready':
				log.info(`[${this.profile.id}] ready: ${s.agentInfo?.name ?? '?'} ${s.agentInfo?.version ?? ''}`);
				break;
			case 'exited':
				log.error(`[${this.profile.id}] adapter exited (${s.signal ?? `code ${s.code}`}), crash ${s.crashes}\n${s.stderr.slice(-2000)}`);
				if (!this.turns && Date.now() - this.crashShownAt > 5000) {
					void vscode.window.showWarningMessage(`${this.label} stopped unexpectedly. It restarts with your next message.`, 'Show Log').then(a => { if (a) { log.show(); } });
				}
				break;
			case 'failed':
				log.error(`[${this.profile.id}] could not start: ${s.message}\n${s.stderr.slice(-2000)}`);
				break;
		}
	}

	/** Start the adapter and a session ahead of the first message (a new chat opened by the user). */
	private warmUp(): void {
		if (this.warm || this.auth === 'required' || !vscode.workspace.isTrusted) {
			return;
		}
		const warm = this.warm = this.harness().newSession();
		warm.then(session => {
			this.warmSession = session;
			this.remember(session);
			this.refresh();
		}, e => {
			if (this.warm === warm) {
				this.warm = undefined;
			}
			if (isAuthRequired(e)) {
				this.needsLogin();
			} else {
				this.env.log.warn(`[${this.profile.id}] warm-up: ${errorMessage(e)}`);
			}
		});
	}

	private async takeSession(): Promise<AcpSession> {
		const warm = this.warm;
		this.warm = undefined;
		this.warmSession = undefined;
		if (warm) {
			try {
				return await warm;
			} catch {
				// start a fresh one below (and report its error)
			}
		}
		return this.harness().newSession();
	}

	private needsLogin(): void {
		if (this.auth !== 'required') {
			this.auth = 'required';
			this.env.log.warn(`[${this.profile.id}] not signed in`);
			this.refresh();
		}
	}

	/** Restart the adapter (after a login, a settings change, or to recover). Chats continue (resumed). */
	async restart(): Promise<void> {
		this.auth = 'unknown';
		this.warm = undefined;
		this.warmSession = undefined;
		await this.client?.supervisor.restart();
		this.refresh();
		this.warmUp();
	}

	async login(): Promise<void> {
		try {
			const cmd = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Preparing ${this.label} sign-in…` },
				() => loginCommand(this.profile, this.override(), this.env.installer));
			const terminal = vscode.window.createTerminal({ name: `Sign in to ${this.label}`, iconPath: new vscode.ThemeIcon('account'), ...cmd, cwd: this.cwd() });
			terminal.show();
			const sub = vscode.window.onDidCloseTerminal(t => {
				if (t === terminal) {
					sub.dispose();
					void this.restart();
				}
			});
			this.disposables.push(sub);
		} catch (e) {
			void vscode.window.showErrorMessage(`Couldn't start the ${this.label} sign-in: ${errorMessage(e)}`);
		}
	}

	// ---------------------------------------------------------------------------------------------------------
	// Options and pickers

	private cacheKey(): string {
		return `agentChat.config.${this.profile.id}`;
	}

	private remember(session: AcpSession): void {
		void this.env.context.globalState.update(this.cacheKey(), session.view.state.configOptions);
	}

	private controlsFor(session: AcpSession | undefined): ConfigControl[] {
		const options = session?.view.state.configOptions ?? this.warmSession?.view.state.configOptions ?? this.env.context.globalState.get<acp.SessionConfigOption[]>(this.cacheKey());
		return configControls(options, this.profile);
	}

	private sessionFor(resource: vscode.Uri | undefined): AcpSession | undefined {
		return resource ? this.sessions.get(resource.toString()) : undefined;
	}

	private groupsFor(session: AcpSession | undefined, previous?: Pick<vscode.ChatSessionInputState, 'groups'>): vscode.ChatSessionProviderOptionGroup[] {
		if (this.auth === 'required' && !session) {
			return [signInGroup(this.profile, icon)];
		}
		return groupsFromControls(this.controlsFor(session), icon, previous);
	}

	private publishModels(session?: AcpSession): void {
		const model = this.controlsFor(session).find(c => c.placement === 'model');
		if (model) {
			this.env.models.set(this.type, model.choices.map(c => ({ id: c.id, name: c.name, ...(c.description ? { description: c.description } : {}) })), model.current);
		} else {
			this.env.models.set(this.type, [{ ...this.profile.placeholderModel }], this.profile.placeholderModel.id);
		}
	}

	/** Re-render pickers (and models) from the sessions' current options. */
	private refresh(only?: AcpSession): void {
		for (const state of this.inputStates) {
			const session = this.sessionFor(state.sessionResource);
			if (only && session !== only) {
				continue;
			}
			this.setGroups(state, this.groupsFor(session));
		}
		this.publishModels(only);
	}

	private setGroups(state: vscode.ChatSessionInputState, groups: vscode.ChatSessionProviderOptionGroup[]): void {
		this.record(state, groups);
		state.groups = groups;
	}

	private record(state: vscode.ChatSessionInputState, groups: readonly vscode.ChatSessionProviderOptionGroup[]): void {
		this.lastSet.set(state, new Map(groups.flatMap(g => (g.selected ? [[g.id, g.selected.id] as const] : []))));
	}

	private inputState(resource: vscode.Uri | undefined, ctx: { previousInputState: vscode.ChatSessionInputState | undefined }): vscode.ChatSessionInputState {
		const session = this.sessionFor(resource);
		// Selections carry over from the untitled chat only before there's a session; after that the session's win.
		const groups = this.groupsFor(session, session ? undefined : ctx.previousInputState);
		const state = this.controller.createChatSessionInputState(groups);
		// Carried-over selections that differ from the session aren't recorded, so they count as the user's.
		this.record(state, this.groupsFor(session));
		this.inputStates.add(state);
		state.onDidDispose(() => this.inputStates.delete(state));
		state.onDidChange(() => {
			// Debounced, and read when it fires: core can report several (and stale) changes in a row.
			clearTimeout(this.pickerTimers.get(state));
			this.pickerTimers.set(state, setTimeout(() => { void this.onPickerChange(state); }, 50));
		});
		if (!session && Date.now() - this.env.activatedAt > WARM_AFTER_MS) {
			this.env.markUsed();
			this.warmUp();
		}
		return state;
	}

	/** The pickers the user changed since we last set them. */
	private userChanges(state: vscode.ChatSessionInputState): vscode.ChatSessionProviderOptionGroup[] {
		const last = this.lastSet.get(state);
		return state.groups.filter(g => g.selected && last?.get(g.id) !== g.selected.id);
	}

	private async onPickerChange(state: vscode.ChatSessionInputState): Promise<void> {
		if (state.groups.some(g => g.id === SIGN_IN_GROUP)) {
			return;
		}
		const changed = this.userChanges(state);
		if (!changed.length) {
			return;
		}
		this.record(state, state.groups);
		const session = this.sessionFor(state.sessionResource) ?? this.warmSession;
		if (session) {
			await this.applySelections(session, { groups: changed }, state);
		} else {
			// No session yet: confirm a dangerous choice now; it's applied with the first message.
			for (const change of changedSelections(changed, this.controlsFor(undefined))) {
				if (isDangerous(this.profile, change.id, change.value) && !await this.confirmDangerous(change.id, change.value)) {
					this.revert(state, change.id, change.previous);
				}
			}
		}
	}

	private async confirmDangerous(configId: string, value: string): Promise<boolean> {
		const control = this.controlsFor(undefined).find(c => c.id === configId);
		const name = control?.choices.find(c => c.id === value)?.name.replace(' ⚠', '') ?? value;
		const yes = `Use ${name}`;
		const answer = await vscode.window.showWarningMessage(
			`${this.label}: switch to ${name}?`,
			{ modal: true, detail: `${name} lets ${this.label} run commands and edit anything without asking first, outside this workspace too. Edits in the workspace still show up for review.` },
			yes,
		);
		return answer === yes;
	}

	private revert(state: vscode.ChatSessionInputState, configId: string, value: string): void {
		this.setGroups(state, state.groups.map(g => (g.id === configId ? { ...g, selected: g.items.find(i => i.id === value) ?? g.selected } : g)));
	}

	/** Picker selections → `set_config_option` (dangerous values confirmed first). */
	private async applySelections(session: AcpSession, state: Pick<vscode.ChatSessionInputState, 'groups'>, live?: vscode.ChatSessionInputState): Promise<void> {
		for (const change of changedSelections(state.groups, this.controlsFor(session))) {
			if (isDangerous(this.profile, change.id, change.value) && !await this.confirmDangerous(change.id, change.value)) {
				if (live) {
					this.revert(live, change.id, change.previous);
				}
				continue;
			}
			try {
				await session.setOption(change.id, change.value);
				this.env.log.info(`[${this.profile.id}] set ${change.id}=${change.value}`);
			} catch (e) {
				this.env.log.error(`[${this.profile.id}] set ${change.id}=${change.value} failed: ${errorMessage(e)}`);
				void vscode.window.showWarningMessage(`${this.label} didn't accept ${change.id} = ${change.value}: ${errorMessage(e)}`);
			}
		}
		this.remember(session);
		this.refresh(session);
	}

	// ---------------------------------------------------------------------------------------------------------
	// A turn

	private async handle(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		this.env.markUsed();
		if (!vscode.workspace.isTrusted) {
			stream.warning(`${this.label} doesn't run in Restricted Mode. Trust this workspace to use it.`);
			stream.button({ command: 'workbench.trust.manage', title: 'Manage Workspace Trust' });
			return {};
		}
		const resource = context.chatSessionContext?.chatSessionItem.resource;
		const key = resource?.toString() ?? `untitled:${this.type}`;
		const item = this.items.get(key);
		if (item) {
			item.timing = { ...item.timing, created: item.timing?.created ?? Date.now(), lastRequestStarted: Date.now() };
		}

		// The ACP session behind this chat.
		let session = this.sessions.get(key);
		const firstMessage = !session;
		if (!session) {
			try {
				stream.progress(this.client?.supervisor.running ? `Starting a ${this.label} session…` : `Starting ${this.label}…`);
				session = await this.takeSession();
			} catch (e) {
				return this.startError(e, stream);
			}
			this.auth = 'unknown';
			this.sessions.set(key, session);
			this.remember(session);
			session.onChange(c => {
				if (c.kind === 'info' && c.title && item) {
					item.label = c.title;
				}
				if (c.kind === 'config' || c.kind === 'mode') {
					this.remember(session!);
					this.refresh(session);
				}
			});
			this.refresh(session);
		}

		this.turns++;
		const turnId = `${Date.now().toString(36)}`;
		const writer = new StreamWriter(stream, request, token, this.env.log);
		const renderer = new TurnRenderer(turnId);
		let offChange: (() => void) | undefined;
		let offAsker: (() => void) | undefined;
		const cancelSub = token.onCancellationRequested(() => { void session!.cancel(); });
		try {
			const { recovery } = await session.ensureLive();
			if (recovery === 'resumed') {
				stream.progress(`Reconnected to ${this.label}.`);
			} else if (recovery === 'new') {
				stream.warning(`${this.label} restarted, and this chat continues in a new session: earlier messages aren't in its context.`);
			}

			// Pickers chosen before the first message (carried over from the untitled chat), then the model picker.
			// Later picker changes go through onPickerChange; re-applying the input state here could undo a change
			// the agent made itself (leaving plan mode).
			if (firstMessage && context.chatSessionContext) {
				await this.applySelections(session, context.chatSessionContext.inputState, context.chatSessionContext.inputState);
			}
			// The model picker keeps its selection when the agent switches models itself, so only a selection the user
			// changed since the last message (or made before the first) is applied.
			const model = this.controlsFor(session).find(c => c.placement === 'model');
			const wanted = HarnessModels.valueOf(request.model, this.type);
			const picked = this.pickedModels.get(key);
			if (wanted) {
				this.pickedModels.set(key, wanted);
			}
			if (model && wanted && (firstMessage || wanted !== picked) && wanted !== model.current && model.choices.some(c => c.id === wanted)) {
				await session.setOption(model.id, wanted);
				this.env.log.info(`[${this.profile.id}] set ${model.id}=${wanted}`);
				this.remember(session);
				this.refresh(session);
			}

			offChange = session.onChange(c => writer.write(renderer.render(c)));
			offAsker = this.harness().broker.setAsker(session.id, (p, signal) => this.askPermission(p, signal, request, token));

			const blocks = promptBlocks({
				prompt: request.prompt,
				...(request.command ? { command: request.command } : {}),
				references: references(request),
				root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
				exists: existsSync,
			});
			const links = blocks.filter(b => b.type === 'resource_link').map(b => (b.type === 'resource_link' ? b.name : ''));
			this.env.log.info(`[${this.profile.id}] prompt: text${links.length ? ` + resource_link ${links.join(', ')}` : ''}`);
			const result = await session.prompt(blocks);
			writer.write(renderer.finish());
			// The contract guard, in the app too: the agent must never call fs/* or terminal/* (we don't serve them).
			const forbidden = this.client?.supervisor.running?.connection.forbiddenInbound() ?? [];
			this.env.log[forbidden.length ? 'error' : 'info'](`[${this.profile.id}] turn ended: ${result.stopReason}; fs/terminal requests from the agent: ${forbidden.length ? forbidden.join(', ') : 'none'}`);
			return this.result(result, stream, session);
		} catch (e) {
			writer.write(renderer.finish());
			if (token.isCancellationRequested) {
				return {};
			}
			return await this.turnError(e, stream);
		} finally {
			offChange?.();
			offAsker?.();
			cancelSub.dispose();
			this.turns--;
			if (item) {
				item.timing = { ...item.timing, created: item.timing?.created ?? Date.now(), lastRequestEnded: Date.now() };
			}
		}
	}

	private result(result: acp.PromptResponse, stream: vscode.ChatResponseStream, session: AcpSession): vscode.ChatResult {
		switch (result.stopReason) {
			case 'max_tokens':
				stream.warning(`${this.label} stopped: it reached its output limit.`);
				break;
			case 'max_turn_requests':
				stream.warning(`${this.label} stopped: it reached its limit of steps for one message. Send "continue" to go on.`);
				break;
			case 'refusal':
				stream.warning(`${this.label} declined to continue.`);
				break;
		}
		const usage = session.view.state.usage;
		const model = this.controlsFor(session).find(c => c.placement === 'model');
		const modelName = model?.choices.find(c => c.id === model.current)?.name;
		const details = [
			modelName,
			usage?.size ? `${Math.round(100 * usage.used / usage.size)}% of context` : undefined,
		].filter(Boolean).join(' · ');
		return { metadata: { stopReason: result.stopReason }, ...(details ? { details } : {}) };
	}

	private startError(e: unknown, stream: vscode.ChatResponseStream): vscode.ChatResult {
		if (isAuthRequired(e)) {
			this.needsLogin();
			stream.warning(`You're not signed in to ${this.label}. Sign in once, in a terminal; then send your message again.`);
			stream.button({ command: 'agentChat.login', title: `Sign in to ${this.label}`, arguments: [this.profile.id] });
			stream.button({ command: 'agentChat.restart', title: 'I\'ve signed in: try again', arguments: [this.profile.id] });
			return { metadata: { error: 'auth' } };
		}
		const message = errorMessage(e);
		this.env.log.error(`[${this.profile.id}] start failed: ${message}`);
		stream.warning(`${this.label} couldn't start: ${firstLine(message)}`);
		stream.button({ command: 'agentChat.showLog', title: 'Show Log' });
		stream.button({ command: 'agentChat.restart', title: `Restart ${this.label}`, arguments: [this.profile.id] });
		return { metadata: { error: 'start' } };
	}

	private async turnError(e: unknown, stream: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
		if (isAuthRequired(e)) {
			return this.startError(e, stream);
		}
		const supervisor = this.client?.supervisor;
		// The stream closes a moment before the process's exit is reported: wait for it, to show the exit code.
		for (let i = 0; i < 20 && supervisor && !supervisor.running && supervisor.status.state === 'ready'; i++) {
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		const status = supervisor?.status;
		const crashed = status?.state === 'exited' || !supervisor?.running;
		if (crashed) {
			this.crashShownAt = Date.now();
		}
		const message = errorMessage(e);
		this.env.log.error(`[${this.profile.id}] turn failed: ${message}`);
		if (crashed) {
			const how = status?.state === 'exited' ? ` (${status.signal ?? `exit code ${status.code}`})` : '';
			stream.warning(`${this.label} stopped unexpectedly${how}. Your next message restarts it and resumes this chat.`);
		} else {
			stream.warning(`${this.label}: ${firstLine(message)}`);
		}
		stream.button({ command: 'agentChat.showLog', title: 'Show Log' });
		return { metadata: { error: crashed ? 'crashed' : 'failed' } };
	}

	private async askPermission(p: PermissionPrompt, signal: AbortSignal, request: vscode.ChatRequest, token: vscode.CancellationToken): Promise<string | undefined> {
		const buttons = p.choices.map(c => (c.persistent ? `${c.label} (${c.persistent})` : c.label));
		const lines: string[] = [];
		if (p.command) {
			lines.push('```sh', p.command, '```');
		}
		if (p.description) {
			lines.push(p.description);
		}
		if (p.paths.length && !p.command) {
			lines.push(p.paths.map(path => `\`${vscode.workspace.asRelativePath(path, false)}\``).join(', '));
		}
		const title = p.command ? `Allow ${this.label} to run this command?` : `Allow ${this.label}: ${p.title.replace(/\?$/, '')}?`;
		const cts = new vscode.CancellationTokenSource();
		const subs = [token.onCancellationRequested(() => cts.cancel())];
		signal.addEventListener('abort', () => cts.cancel(), { once: true });
		try {
			const result = await vscode.lm.invokeTool(CONFIRM_TOOL, { input: { title, message: lines.join('\n'), buttons }, toolInvocationToken: request.toolInvocationToken }, cts.token);
			const part = result.content[0];
			const label = part instanceof vscode.LanguageModelTextPart ? part.value : undefined;
			const index = label === undefined ? -1 : buttons.indexOf(label);
			return index >= 0 ? p.choices[index]!.optionId : undefined;
		} catch (e) {
			this.env.log.info(`[${this.profile.id}] permission prompt closed: ${String(e)}`);
			return undefined;
		} finally {
			subs.forEach(s => s.dispose());
			cts.dispose();
		}
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		void this.client?.dispose();
	}
}

function firstLine(text: string): string {
	return text.split('\n')[0]!.slice(0, 300);
}

/** The request's references (attached files, the active editor) as prompt references. */
function references(request: vscode.ChatRequest): PromptReference[] {
	const out: PromptReference[] = [];
	for (const ref of request.references) {
		const v = ref.value;
		if (v instanceof vscode.Uri && v.scheme === 'file') {
			out.push({ path: v.fsPath });
		} else if (v instanceof vscode.Location && v.uri.scheme === 'file') {
			out.push({ path: v.uri.fsPath, startLine: v.range.start.line + 1, endLine: v.range.end.line + 1 });
		}
	}
	return out;
}
