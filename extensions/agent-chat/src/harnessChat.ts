// One chat session type per harness (`agent-claude`, `agent-codex`), driven by @editor/acp-client.
//
// - Lazy: nothing starts at window load. The pickers show the options remembered from the last session (or the
//   profile's placeholder model); the adapter starts on the first message, or in the background when the user
//   opens a new chat of this type after startup.
// - ACP config options → the native model picker (model) and option pickers (everything else), re-rendered
//   from every response and `config_option_update`. Dangerous values (Codex Full access, Claude's Bypass
//   permissions) need a modal confirm each time they're chosen; while a chat is in one, the status bar says so.
//   Bypass is never saved with a chat or restored: after a reload, restart or adapter recovery the chat is back in
//   the mode it had before (`transientValues`, AcpSession.keptValues).
// - Permission requests → core's confirmation tool, which can't be auto-approved; Stop → `session/cancel`.
// - Not logged in → a "Sign in" picker and a warning with a button that runs the harness's login in a terminal.
// - An adapter crash ends the turn with an error; the next message restarts it and resumes the session.
// - History: every chat's transcript is saved (history.ts) and listed through the session item controller, with
//   sessions the agent lists (`session/list`) that we don't have. Reopening shows the saved transcript (or a
//   `session/load` replay) without starting anything; the next message resumes the session.
// - Several chats run at once (one adapter per harness, one ACP session per chat); a turn waits while another
//   chat's turn is running (scheduler.ts).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
	AdapterInstaller, AgentSupervisor, claudePersistence, codexPersistence, configControls, errorMessage, HarnessClient,
	isAuthRequired, isDangerous, isTransient, optionValues, PermissionBroker, withOverride, withValues,
	type AcpSession, type acp, type AgentStatus, type ConfigControl, type HarnessProfile, type PermissionPrompt, type ProfileOverride, type SettingsResult,
} from '@editor/acp-client';
import { changedSelections, groupsFromControls, modelChoices, signInGroup, SIGN_IN_GROUP } from './groups.js';
import type { ChatEntry, ChatHistory } from './history.js';
import { HarnessMissingError, loginCommand, resolveLaunch } from './launch.js';
import { HarnessModels } from './models.js';
import { promptBlocks, type PromptReference } from './prompt.js';
import { footer, isServerToolHiccup, permissionButtons, retryText, runningCommands, stoppedCommandsNote, turnFailureText, TurnRenderer } from './render.js';
import type { Lease, TurnScheduler } from './scheduler.js';
import { attributeChanges, dangerousConfirmation, ECHO_MS, modelIdentifier, shownSettings, startValues, type PickerEvent, type PickerPush } from './settings.js';
import { historyTurns, StreamWriter } from './stream.js';
import { ReplayBuilder, TranscriptBuilder } from './transcript.js';

const CONFIRM_TOOL = 'vscode_get_confirmation_with_options';
/** How long after Stop a turn's result may take before a "Stopped" one goes ahead (core waits a second). */
const STOP_RESULT_MS = 600;
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
	history: ChatHistory;
	scheduler: TurnScheduler;
}

/** Sessions the agent lists that aren't our chats get resources under this path. */
const LISTED = '/session/';

const icon = (id: string) => new vscode.ThemeIcon(id);

/** The selected values of option groups, by group id. */
function selections(groups: readonly vscode.ChatSessionProviderOptionGroup[]): Record<string, string> {
	return Object.fromEntries(groups.flatMap(g => (g.selected ? [[g.id, g.selected.id] as const] : [])));
}

export class HarnessChat implements vscode.Disposable {
	readonly type: string;
	private client: HarnessClient | undefined;
	/** chat session resource → ACP session */
	private readonly sessions = new Map<string, AcpSession>();
	private warm: Promise<AcpSession> | undefined;
	private warmSession: AcpSession | undefined;
	private auth: 'unknown' | 'required' = 'unknown';
	private readonly inputStates = new Set<vscode.ChatSessionInputState>();
	/** What we last set in each input state's pickers (set again only when it changes). */
	private readonly lastSet = new WeakMap<vscode.ChatSessionInputState, string>();
	/**
	 * Each input state's own values: what we set, and the user's changes attributed to it. Core also reports other
	 * chats' changes to it (settings.ts), so its `groups` can hold another chat's values.
	 */
	private readonly own = new WeakMap<vscode.ChatSessionInputState, Map<string, string>>();
	/** Each input state's values when we last looked: core's reports are changes against these. */
	private readonly seen = new WeakMap<vscode.ChatSessionInputState, Map<string, string>>();
	/** Values set in some chat's pickers lately (core echoes them to the other chats). */
	private pushes: PickerPush<vscode.ChatSessionInputState>[] = [];
	private readonly changedStates = new Set<vscode.ChatSessionInputState>();
	private pickerTimer: ReturnType<typeof setTimeout> | undefined;
	/** Chats whose turn is running. */
	private readonly running = new Set<string>();
	/** Chats whose last turn was stopped with approved commands running → what to tell the agent next time. */
	private readonly stopNotes = new Map<string, string>();
	/** Chats whose message is waiting for another chat's turn → the editor tab it was sent from. */
	private readonly waitingTabs = new Map<string, vscode.Tab>();
	/** Chats whose session is getting its settings back (resumed with the agent's defaults): not shown or saved. */
	private readonly reconciling = new Set<string>();
	private readonly items = new Map<string, vscode.ChatSessionItem>();
	/** chat session resource → the model picker's selection at its last message */
	private readonly pickedModels = new Map<string, string>();
	private controller!: vscode.ChatSessionItemController;
	/** chat session resource → its transcript (live chats and chats reopened in this window) */
	private readonly transcripts = new Map<string, TranscriptBuilder>();
	/** The agent's own sessions (`session/list`), fetched once the adapter runs. */
	private listed: acp.SessionInfo[] = [];
	private turns = 0;
	/** When a turn last showed a crash in the chat (no second notification for the same crash). */
	private crashShownAt = 0;
	private readonly disposables: vscode.Disposable[] = [];
	/** Dangerous values confirmed in a chat's picker before it had a session: its next message doesn't ask again. */
	private readonly confirmedPicks = new WeakMap<vscode.ChatSessionInputState, Map<string, string>>();
	/** The same, by chat (moved there from a new chat's input state when it gets its resource). */
	private readonly confirmedChats = new Map<string, Map<string, string>>();
	/** Shown while a chat of this harness is in a dangerous mode (Bypass permissions). */
	private statusItem: vscode.StatusBarItem | undefined;

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
		const controller = this.controller = vscode.chat.createChatSessionItemController(this.type, async () => this.refreshItems());
		controller.newChatSessionItemHandler = async ctx => {
			const resource = vscode.Uri.from({ scheme: this.type, path: `/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` });
			const item = controller.createChatSessionItem(resource, titleOf(ctx.request.prompt) || this.label);
			item.iconPath = this.icon();
			item.timing = { created: Date.now(), lastRequestStarted: Date.now() };
			controller.items.add(item);
			this.items.set(resource.toString(), item);
			// Core copies the new chat's picker values to it next, and reports them to every chat (settings.ts).
			this.pushed(undefined, resource.toString(), selections(ctx.inputState.groups));
			const confirmed = this.confirmedPicks.get(ctx.inputState);
			if (confirmed?.size) {
				this.confirmedChats.set(resource.toString(), new Map(confirmed));
				this.confirmedPicks.delete(ctx.inputState);
			}
			return item;
		};
		controller.getChatSessionInputState = (resource, ctx) => this.inputState(resource, ctx);

		const participant = vscode.chat.createChatParticipant(this.type, (request, context, stream, token) => this.handle(request, context, stream, token));
		participant.iconPath = this.icon();
		// No provideHandleOptionsChange: with it, core takes a legacy path that leaves the controller's input state stale.
		const provider: vscode.ChatSessionContentProvider = {
			provideChatSessionContent: resource => this.content(resource),
		};
		this.publishModels();
		this.disposables.push(vscode.window.tabGroups.onDidChangeTabs(e => this.onTabsClosed(e.closed)));
		return vscode.Disposable.from(controller, participant, vscode.chat.registerChatSessionContentProvider(this.type, provider, participant), this);
	}

	// ---------------------------------------------------------------------------------------------------------
	// The adapter

	private harness(): HarnessClient {
		if (!this.client) {
			const supervisor = new AgentSupervisor({
				// The user's overrides (env, defaults) are read at every start, so a restart applies changed settings.
				launch: progress => resolveLaunch(withOverride(this.profile, this.override()), this.override(), this.env.installer, this.cwd(), progress, join(this.env.context.extensionPath, 'dist', 'adapters')),
				clientInfo: { name: 'editor', title: vscode.env.appName, version: this.env.version },
			});
			const broker = new PermissionBroker(this.profile.id === 'codex' ? codexPersistence : claudePersistence);
			broker.onAudit(a => this.env.log.info(`[${this.profile.id}] permission ${a.toolCallId}: ${a.outcome}${a.optionId ? ` ${a.optionKind} (${a.optionId})` : ''}${a.reason ? ` [${a.reason}]` : ''} — ${a.command ?? a.title}`));
			supervisor.onStatus(s => this.onStatus(s));
			this.client = new HarnessClient(withOverride(this.profile, this.override()), supervisor, this.cwd(), broker);
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
				void this.fetchListed();
				break;
			case 'stopped':
				// Chats in Bypass leave it with the adapter (AcpSession.ensureLive): pickers and status bar say so now.
				this.refresh();
				break;
			case 'exited':
				this.refresh();
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
			// Its choices can change while it waits (tact: a Claude key added to its config): a new chat's pickers follow.
			const off = session.onChange(c => {
				if (this.warmSession !== session) {
					off();
				} else if (c.kind === 'config') {
					this.remember(session);
					this.refresh();
				}
			});
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

	/** Run the profile's install command in a terminal; when it's closed, start the harness again. */
	install(): void {
		const command = this.profile.installCommand;
		if (!command) {
			return;
		}
		const terminal = vscode.window.createTerminal({
			name: `Install ${this.label}`,
			iconPath: new vscode.ThemeIcon('cloud-download'),
			shellPath: '/bin/sh',
			shellArgs: ['-c', `${command}; echo; echo 'Close this terminal (press Enter) to go back to the chat.'; read _`],
			cwd: this.cwd(),
		});
		terminal.show();
		const sub = vscode.window.onDidCloseTerminal(t => {
			if (t === terminal) {
				sub.dispose();
				void this.restart();
			}
		});
		this.disposables.push(sub);
	}

	// ---------------------------------------------------------------------------------------------------------
	// History

	private icon(): vscode.ThemeIcon {
		return new vscode.ThemeIcon(this.profile.icon ?? 'comment-discussion');
	}

	private itemFor(entry: ChatEntry): vscode.ChatSessionItem {
		const item = this.items.get(entry.resource) ?? this.controller.createChatSessionItem(vscode.Uri.parse(entry.resource), entry.title);
		item.label = entry.title;
		item.iconPath = this.icon();
		// A session the agent listed is one of ours once it's opened here.
		item.description = undefined;
		item.timing = { created: entry.created, lastRequestStarted: entry.updated, lastRequestEnded: entry.updated };
		this.items.set(entry.resource, item);
		return item;
	}

	/** The controller's items: our saved chats, then the agent's own sessions that aren't one of them. */
	private refreshItems(): void {
		const items = this.env.history.list(this.profile.id).map(e => this.itemFor(e));
		const ours = new Set(this.env.history.list(this.profile.id).map(e => e.sessionId));
		for (const info of this.listed) {
			// Untitled ones never had a message (a chat opened and left empty).
			if (ours.has(info.sessionId) || !info.title?.trim() || this.env.history.isRemoved(this.profile.id, info.sessionId)) {
				continue;
			}
			const resource = vscode.Uri.from({ scheme: this.type, path: `${LISTED}${encodeURIComponent(info.sessionId)}` });
			const item = this.items.get(resource.toString()) ?? this.controller.createChatSessionItem(resource, info.title);
			item.iconPath = this.icon();
			// Listed by the agent, not started here (Claude Code lists its terminal sessions too).
			item.description = `${this.label}, not opened here yet`;
			const updated = info.updatedAt ? Date.parse(info.updatedAt) : undefined;
			if (updated) {
				item.timing = { created: updated, lastRequestEnded: updated };
			}
			this.items.set(resource.toString(), item);
			items.push(item);
		}
		// Chats started in this window that have no saved turn yet.
		for (const [key, item] of this.items) {
			if (!items.includes(item) && this.sessions.has(key)) {
				items.push(item);
			}
		}
		this.controller.items.replace(items);
	}

	/** The agent's own sessions (Claude Code also lists the ones started in a terminal), once it runs. */
	private async fetchListed(): Promise<void> {
		try {
			this.listed = await this.harness().list();
			this.refreshItems();
		} catch (e) {
			this.env.log.warn(`[${this.profile.id}] session/list: ${errorMessage(e)}`);
		}
	}

	/** What an opened chat shows: its saved transcript, or the agent's replay of a listed session. */
	private async content(resource: vscode.Uri): Promise<vscode.ChatSession> {
		const key = resource.toString();
		let turns = this.transcripts.get(key)?.turns ?? this.env.history.transcript(key);
		if (!turns && resource.path.startsWith(LISTED)) {
			turns = await this.loadListed(key, decodeURIComponent(resource.path.slice(LISTED.length)));
		}
		const entry = this.env.history.get(key);
		// The chat's own picker values (its session's, or the ones saved with it): core shows these for this chat.
		const options = selections(this.groupsFor(resource));
		this.pushed(undefined, key, options);
		return {
			history: historyTurns(turns ?? [], this.type, key, value => modelIdentifier(this.type, value)),
			requestHandler: undefined,
			options,
			...(entry ? { title: entry.title } : {}),
		};
	}

	/** `session/load` a session the agent listed: its replay becomes the transcript, and the chat one of ours. */
	private async loadListed(key: string, sessionId: string): Promise<TranscriptBuilder['turns']> {
		const replay = new ReplayBuilder();
		try {
			const session = this.harness().restore(sessionId);
			const off = session.onChange(c => { if (session.replaying) { replay.apply(c); } });
			try {
				await this.harness().load(sessionId);
			} finally {
				off();
			}
			const turns = replay.finish();
			const transcript = new TranscriptBuilder(turns);
			this.transcripts.set(key, transcript);
			this.attach(key, session, this.items.get(key));
			const info = this.listed.find(i => i.sessionId === sessionId);
			this.saveChat(key, session, info?.title || titleOf(turns[0]?.prompt ?? '') || `${this.label} session`);
			return turns;
		} catch (e) {
			this.env.log.warn(`[${this.profile.id}] session/load ${sessionId}: ${errorMessage(e)}`);
			return [{ prompt: '', ops: [{ op: 'markdown', text: `*${this.label} couldn't reopen this session: ${firstLine(errorMessage(e))}*` }] }];
		}
	}

	private transcriptFor(key: string): TranscriptBuilder {
		let t = this.transcripts.get(key);
		if (!t) {
			t = new TranscriptBuilder(this.env.history.transcript(key) ?? []);
			this.transcripts.set(key, t);
		}
		return t;
	}

	/**
	 * Saves the chat: its entry and transcript. `withSettings: false` keeps the settings saved before (a turn that is
	 * starting: its session may not have the chat's settings yet).
	 */
	private saveChat(key: string, session: AcpSession | undefined, title?: string, withSettings = true): void {
		if (!this.owns(vscode.Uri.parse(key))) {
			return; // no chat resource (`untitled:`): nothing could open it again
		}
		const transcript = this.transcripts.get(key);
		const prev = this.env.history.get(key);
		const item = this.items.get(key);
		const entry: ChatEntry = {
			resource: key,
			harness: this.profile.id,
			...(session ? { sessionId: session.id } : prev?.sessionId ? { sessionId: prev.sessionId } : {}),
			title: title ?? item?.label ?? prev?.title ?? this.label,
			created: prev?.created ?? item?.timing?.created ?? Date.now(),
			updated: Date.now(),
			turns: transcript?.turns.length ?? prev?.turns ?? 0,
			// Never Bypass: a chat in it is saved with the mode it had before (AcpSession.keptValues).
			...(session && withSettings && !this.reconciling.has(key) ? { settings: session.keptValues() } : prev?.settings ? { settings: prev.settings } : {}),
		};
		try {
			this.env.history.save(entry, transcript?.turns, transcript?.text());
		} catch (e) {
			this.env.log.warn(`[${this.profile.id}] couldn't save the chat: ${errorMessage(e)}`);
		}
	}

	/** Forget a chat (its transcript; the agent's own session is closed, not deleted). */
	async removeChat(resource: vscode.Uri): Promise<void> {
		const key = resource.toString();
		const session = this.sessions.get(key);
		this.sessions.delete(key);
		this.transcripts.delete(key);
		this.items.delete(key);
		this.env.history.remove(key);
		this.updateStatus();
		if (resource.path.startsWith(LISTED)) {
			// Listed by the agent and never opened here: only the agent's list has it.
			this.env.history.forgetSession(this.profile.id, decodeURIComponent(resource.path.slice(LISTED.length)));
		}
		this.refreshItems();
		await session?.close();
	}

	owns(resource: vscode.Uri): boolean {
		return resource.scheme === this.type;
	}

	// ---------------------------------------------------------------------------------------------------------
	// Options and pickers

	private cacheKey(): string {
		return `agentChat.config.${this.profile.id}`;
	}

	/** The options last seen, for the pickers' choices before a session runs (their values are per chat; never Bypass). */
	private remember(session: AcpSession): void {
		void this.env.context.globalState.update(this.cacheKey(), withValues(session.view.state.configOptions, session.keptValues()));
	}

	private cached(): acp.SessionConfigOption[] | undefined {
		return this.warmSession?.view.state.configOptions ?? this.env.context.globalState.get<acp.SessionConfigOption[]>(this.cacheKey());
	}

	private controlsFor(session: AcpSession | undefined): ConfigControl[] {
		return configControls(session?.view.state.configOptions ?? this.cached(), this.profile);
	}

	/**
	 * A chat's options: its session's; else (not running yet) the choices last seen with the values saved with the
	 * chat; a new chat's start from the profile's defaults (Claude: Accept edits), never from another chat's.
	 */
	private optionsFor(resource: vscode.Uri | undefined): acp.SessionConfigOption[] {
		const session = this.sessionFor(resource);
		if (session) {
			// A session the adapter lost (restart, crash) comes back without Bypass (AcpSession.ensureLive): show that.
			return this.live(session) ? session.view.state.configOptions : withValues(session.view.state.configOptions, session.keptValues());
		}
		const entry = resource ? this.env.history.get(resource.toString()) : undefined;
		return withValues(this.cached(), startValues(entry, withOverride(this.profile, this.override()).defaults, this.cached(), this.profile));
	}

	private savedSettings(entry: ChatEntry): Record<string, string> {
		return startValues(entry, undefined, this.cached(), this.profile);
	}

	/** The session is on the running adapter (not one to resume after a restart or crash). */
	private live(session: AcpSession): boolean {
		return this.client?.supervisor.running?.generation === session.generation;
	}

	private sessionFor(resource: vscode.Uri | undefined): AcpSession | undefined {
		return resource ? this.sessions.get(resource.toString()) : undefined;
	}

	/** What a chat's pickers show. A new chat (no resource) keeps the user's own picks (`own`). */
	private groupsFor(resource: vscode.Uri | undefined, state?: vscode.ChatSessionInputState): vscode.ChatSessionProviderOptionGroup[] {
		const session = this.sessionFor(resource);
		if (this.auth === 'required' && !session) {
			return [signInGroup(this.profile, icon)];
		}
		const own = !resource && state ? this.own.get(state) : undefined;
		return groupsFromControls(configControls(this.optionsFor(resource), this.profile), icon, own ? { groups: [...own].map(([id, value]) => ({ id, name: id, items: [], selected: { id: value, name: value } })) } : undefined);
	}

	private publishModels(session?: AcpSession): void {
		const model = this.controlsFor(session).find(c => c.placement === 'model');
		if (model) {
			const { items, current } = modelChoices(model.choices.map(c => ({ id: c.id, name: c.name, ...(c.description ? { description: c.description } : {}) })), model.current);
			this.env.models.set(this.type, items, current ?? model.current);
		} else {
			this.env.models.set(this.type, [{ ...this.profile.placeholderModel }], this.profile.placeholderModel.id);
		}
	}

	/** Re-render pickers (and models) from the chats' current options. */
	private refresh(only?: AcpSession): void {
		for (const state of this.inputStates) {
			const session = this.sessionFor(state.sessionResource);
			if (only && session !== only) {
				continue;
			}
			if (state.sessionResource && this.reconciling.has(state.sessionResource.toString())) {
				continue;
			}
			this.setGroups(state, this.groupsFor(state.sessionResource, state));
		}
		this.publishModels(only);
		this.updateStatus();
	}

	/**
	 * Sets an input state's pickers when they differ from what we set last (`force`: always). Core shows them, and
	 * also reports them to every other chat's input state: recorded, so those aren't taken for the user's changes.
	 */
	private setGroups(state: vscode.ChatSessionInputState, groups: vscode.ChatSessionProviderOptionGroup[], force = false): void {
		const key = JSON.stringify(groups.map(g => [g.id, g.selected?.id, g.items.map(i => `${i.id}:${i.name}`)]));
		if (!force && this.lastSet.get(state) === key) {
			return;
		}
		this.lastSet.set(state, key);
		this.record(state, groups);
		this.pushed(state, state.sessionResource?.toString(), selections(groups));
		state.groups = groups;
	}

	/** The pickers' values as this chat's own (`own`) and as last seen in its input state (`seen`). */
	private record(state: vscode.ChatSessionInputState, groups: readonly vscode.ChatSessionProviderOptionGroup[]): void {
		const values = new Map(Object.entries(selections(groups)));
		this.own.set(state, values);
		this.seen.set(state, new Map(values));
	}

	private pushed(target: vscode.ChatSessionInputState | undefined, chat: string | undefined, values: Record<string, string>): void {
		const now = Date.now();
		this.pushes = [...this.pushes.filter(p => now - p.at < ECHO_MS), { target, chat, values, at: now }];
	}

	private inputState(resource: vscode.Uri | undefined, ctx: { previousInputState: vscode.ChatSessionInputState | undefined }): vscode.ChatSessionInputState {
		// Not ctx.previousInputState: core builds it from the last pickers set in any chat. A message runs with what
		// its chat's pickers show (handle()), which core keeps per chat.
		const groups = this.groupsFor(resource);
		const state = this.controller.createChatSessionInputState(groups);
		this.lastSet.set(state, JSON.stringify(groups.map(g => [g.id, g.selected?.id, g.items.map(i => `${i.id}:${i.name}`)])));
		this.record(state, groups);
		// Core may set these in the chat (a new chat's), and the previous ones in the chat that gets a first message.
		this.pushed(state, resource?.toString(), selections(groups));
		if (ctx.previousInputState) {
			this.pushed(undefined, undefined, selections(ctx.previousInputState.groups));
		}
		this.inputStates.add(state);
		state.onDidDispose(() => this.inputStates.delete(state));
		state.onDidChange(() => {
			// Collected for a moment, and read when it fires: core reports a change to every chat's input state, and
			// several (and stale) changes in a row.
			this.changedStates.add(state);
			clearTimeout(this.pickerTimer);
			this.pickerTimer = setTimeout(() => { void this.onPickerChanges(); }, 100);
		});
		if (!resource && Date.now() - this.env.activatedAt > WARM_AFTER_MS) {
			this.env.markUsed();
			this.warmUp();
		}
		return state;
	}

	/** Picker changes core reported: applied to the chat they belong to, when that's clear (settings.ts). */
	private async onPickerChanges(): Promise<void> {
		const states = [...this.changedStates].filter(s => this.inputStates.has(s) && !s.groups.some(g => g.id === SIGN_IN_GROUP));
		this.changedStates.clear();
		const events: PickerEvent<vscode.ChatSessionInputState>[] = [];
		for (const state of states) {
			const seen = this.seen.get(state);
			const changes = state.groups.filter(g => g.selected && seen?.get(g.id) !== g.selected.id).map(g => ({ id: g.id, value: g.selected!.id }));
			this.seen.set(state, new Map(Object.entries(selections(state.groups))));
			const chat = state.sessionResource?.toString();
			if (changes.length) {
				events.push({ target: state, chat, running: !!chat && this.running.has(chat), changes, current: optionValues(this.optionsFor(state.sessionResource)) });
			}
		}
		for (const { target: state, changes } of attributeChanges(events, this.pushes, Date.now(), this.profile)) {
			const own = this.own.get(state) ?? new Map<string, string>();
			changes.forEach(c => own.set(c.id, c.value));
			this.own.set(state, own);
			const groups = state.groups.filter(g => changes.some(c => c.id === g.id));
			this.env.log.info(`[${this.profile.id}] picker: ${changes.map(c => `${c.id}=${c.value}`).join(', ')}${state.sessionResource ? ` (${state.sessionResource.path})` : ' (new chat)'}`);
			await this.applyPickerChange(state, groups);
		}
	}

	private async applyPickerChange(state: vscode.ChatSessionInputState, groups: vscode.ChatSessionProviderOptionGroup[]): Promise<void> {
		const session = this.sessionFor(state.sessionResource);
		if (session) {
			await this.applySelections(session, { groups }, state);
			return;
		}
		// No session yet (a new chat, or one reopened from history): confirm a dangerous choice now; it's applied with
		// the chat's next message. A saved chat keeps it (for a restart before that message).
		const key = state.sessionResource?.toString();
		const entry = key ? this.env.history.get(key) : undefined;
		for (const change of changedSelections(groups, configControls(this.optionsFor(state.sessionResource), this.profile))) {
			const confirmed = key ? this.confirmedChats.get(key) ?? new Map<string, string>() : this.confirmedPicks.get(state) ?? new Map<string, string>();
			confirmed.delete(change.id);
			if (isDangerous(this.profile, change.id, change.value)) {
				if (!await this.confirmDangerous(change.id, change.value)) {
					this.revert(state, change.id, change.previous);
					continue;
				}
				confirmed.set(change.id, change.value);
			}
			if (key) {
				this.confirmedChats.set(key, confirmed);
			} else {
				this.confirmedPicks.set(state, confirmed);
			}
			// Bypass isn't saved with the chat: a restart before its next message opens it in its earlier mode.
			if (entry && key && !isTransient(this.profile, change.id, change.value)) {
				this.env.history.saveSettings(key, { ...this.savedSettings(entry), [change.id]: change.value });
			}
		}
	}

	/** The modal confirm for a dangerous value: asked every time one is chosen (dangerousConfirmation). */
	private async confirmDangerous(configId: string, value: string): Promise<boolean> {
		const control = this.controlsFor(undefined).find(c => c.id === configId);
		const name = control?.choices.find(c => c.id === value)?.name.replace(' ⚠', '') ?? value;
		const { message, detail, yes } = dangerousConfirmation(this.label, name, isTransient(this.profile, configId, value));
		const answer = await vscode.window.showWarningMessage(message, { modal: true, detail }, yes);
		this.env.log.info(`[${this.profile.id}] confirm ${configId}=${value}: ${answer === yes ? 'yes' : 'no'}`);
		return answer === yes;
	}

	private revert(state: vscode.ChatSessionInputState, configId: string, value: string): void {
		const own = this.own.get(state);
		own?.set(configId, value);
		this.setGroups(state, state.groups.map(g => (g.id === configId ? { ...g, selected: g.items.find(i => i.id === value) ?? g.selected } : g)), true);
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
		if (live) {
			// The picker shows what the session has (also when the change was refused).
			this.setGroups(live, this.groupsFor(live.sessionResource, live), true);
		}
	}

	/**
	 * Before a message: the chat's session gets what its pickers show (core keeps them per chat). A dangerous value
	 * is confirmed first. A permission value that can't be set falls back to the strictest one (AcpSession), and
	 * when even that fails the message isn't sent (returns false). The pickers then show what the session has.
	 */
	private async reconcile(key: string, session: AcpSession, shown: Record<string, string>, warn: (text: string) => void, settings: SettingsResult | undefined): Promise<boolean> {
		const controls = this.controlsFor(session);
		const wanted = { ...shown };
		// A dangerous value confirmed in the picker before the chat had a session isn't asked again (once).
		const confirmed = this.confirmedChats.get(key);
		this.confirmedChats.delete(key);
		for (const [id, value] of Object.entries(wanted)) {
			const control = controls.find(c => c.id === id);
			if (!control || control.placement === 'model' || control.current === value
				|| (isDangerous(this.profile, id, value) && confirmed?.get(id) !== value && !await this.confirmDangerous(id, value))) {
				delete wanted[id];
			}
		}
		const applied = Object.keys(wanted).length ? await session.applySettings(wanted) : undefined;
		for (const f of [...settings?.failed ?? [], ...applied?.failed ?? []]) {
			this.env.log.warn(`[${this.profile.id}] set ${f.id}=${f.value} failed: ${f.error}`);
		}
		this.remember(session);
		this.reconciling.delete(key);
		this.refresh(session);
		// Core's pickers for this chat may show a value the session didn't take: show what it has.
		for (const state of this.inputStates) {
			if (state.sessionResource?.toString() === key) {
				this.setGroups(state, this.groupsFor(state.sessionResource, state), true);
			}
		}
		const permission = controls.find(c => c.id === this.profile.permissionOption?.configId);
		const name = (value: string | undefined) => permission?.choices.find(c => c.id === value)?.name ?? value ?? 'its mode';
		const was = permission ? shown[permission.id] ?? this.env.history.get(key)?.settings?.[permission.id] : undefined;
		this.saveSettings(key, session);
		const held = (settings?.permissionHeld ?? true) && (applied?.permissionHeld ?? true);
		const fellBack = applied?.fellBackTo ?? settings?.fellBackTo;
		if (!held) {
			warn(`${this.label} couldn't put this chat back in ${name(was)}: it's in ${name(fellBack)}, which asks less often. Nothing was sent. Pick a mode and send again, or restart ${this.label}.`);
			return false;
		}
		if (fellBack) {
			warn(`${this.label} couldn't put this chat in ${name(was)}, so it's in ${name(fellBack)}, the strictest mode it offers.`);
		}
		return true;
	}

	/** Keep a saved chat's settings in step with its session. */
	private saveSettings(key: string, session: AcpSession): void {
		if (this.reconciling.has(key) || session.replaying) {
			return;
		}
		try {
			this.env.history.saveSettings(key, session.keptValues());
		} catch (e) {
			this.env.log.warn(`[${this.profile.id}] couldn't save the chat's settings: ${errorMessage(e)}`);
		}
	}

	// ---------------------------------------------------------------------------------------------------------
	// A turn

	/**
	 * A message. After Stop, core takes the result (its footer says "Stopped") only if it comes within a second, and
	 * the agent can take longer to end the turn: then the result goes ahead and the turn finishes behind it.
	 */
	private handle(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		const turn = this.turn(request, context, stream, token);
		let sub: vscode.Disposable | undefined;
		const stopped = new Promise<vscode.ChatResult>(resolve => {
			sub = token.onCancellationRequested(() => setTimeout(() => {
				const key = context.chatSessionContext?.chatSessionItem.resource.toString();
				resolve({ metadata: { stopReason: 'cancelled' }, ...this.details(key ? this.sessions.get(key) : undefined, true) });
			}, STOP_RESULT_MS));
		});
		return Promise.race([turn, stopped]).finally(() => sub?.dispose());
	}

	private async turn(request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
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

		// The ACP session behind this chat: a live one, one reopened from history (resumed by ensureLive), or new.
		// What this chat's pickers show (core keeps them per chat; it reports them to the other chats too).
		const shown = shownSettings(context.chatSessionContext?.initialSessionOptions);
		this.pushed(undefined, key, shown);
		// The message is in the chat's history before anything starts: a reload, a closed window or a failed start
		// mid-turn doesn't lose the chat.
		const transcript = this.transcriptFor(key);
		transcript.startTurn(request.command ? `/${request.command}${request.prompt ? ` ${request.prompt}` : ''}` : request.prompt);
		/** A notice about this turn: shown, and kept with it. */
		const warn = (text: string) => {
			stream.warning(text);
			transcript.add([{ op: 'warning', text }]);
		};
		this.saveChat(key, undefined, undefined, false);
		let session = this.sessions.get(key);
		const firstMessage = !session;
		const entry = session ? undefined : this.env.history.get(key);
		const saved = entry?.sessionId;
		if (!session && entry && saved) {
			// With the chat's own settings: the resume starts from the agent's defaults, and ensureLive sets them again.
			session = this.harness().restore(saved, withValues(this.cached(), this.savedSettings(entry)));
			this.attach(key, session, item);
		} else if (!session) {
			try {
				stream.progress(this.client?.supervisor.running ? `Starting a ${this.label} session…` : `Starting ${this.label}…`);
				session = await this.takeSession();
			} catch (e) {
				const result = this.startError(e, stream, warn);
				this.saveChat(key, undefined);
				return result;
			}
			this.auth = 'unknown';
			this.remember(session);
			this.attach(key, session, item);
			// With its session: reopened after a reload, the chat resumes it.
			this.saveChat(key, session, undefined, false);
		}

		this.turns++;
		const turnId = `${Date.now().toString(36)}`;
		const writer = new StreamWriter(stream, request, token, this.env.log);
		const renderer = new TurnRenderer(turnId);
		const show = (ops: ReturnType<TurnRenderer['render']>) => {
			writer.write(ops);
			transcript.add(ops);
		};
		/** Tool calls whose permission prompt wasn't answered with an allow (open, refused, dismissed): they didn't run. */
		const notApproved = new Set<string>();
		// A slash command goes as is; the note waits for the next message.
		const note = request.command ? undefined : this.stopNotes.get(key);
		const close = (how: 'ended' | 'stopped' | 'interrupted') => {
			const ops = renderer.finish(how, notApproved);
			show(ops);
			const ran = how === 'ended' ? [] : runningCommands(ops, notApproved);
			if (ran.length) {
				this.stopNotes.set(key, stoppedCommandsNote(ran));
			}
		};
		let offChange: (() => void) | undefined;
		let offAsker: (() => void) | undefined;
		let lease: Lease | undefined;
		const stop = new AbortController();
		const cancelSub = token.onCancellationRequested(() => {
			stop.abort();
			void session!.cancel();
		});
		if (item) {
			item.status = vscode.ChatSessionStatus.InProgress;
			this.controller.items.add(item);
		}
		/** A warning shown before the turn starts (repeated if the waiting line is cleared). */
		let notice: string | undefined;
		this.running.add(key);
		try {
			this.reconciling.add(key);
			const { recovery, settings, left } = await session.ensureLive();
			if (recovery === 'resumed' && !firstMessage) {
				stream.progress(`Reconnected to ${this.label}.`);
			} else if (recovery === 'new') {
				notice = saved && firstMessage
					? `${this.label} couldn't reopen the earlier session, so this chat continues in a new one: earlier messages aren't in its context.`
					: `${this.label} restarted, and this chat continues in a new session: earlier messages aren't in its context.`;
				warn(notice);
				if (saved && saved !== session.id) {
					// The chat has the earlier session's messages: the agent's list doesn't show that one again.
					this.env.history.forgetSession(this.profile.id, saved);
				}
			}
			// Bypass ends with the session it was chosen in: the recovered one is back in the mode from before, and
			// this message runs in it (the picker still showing Bypass doesn't put it back without a new choice).
			for (const l of left ?? []) {
				delete shown[l.id];
				const names = this.controlsFor(session).find(c => c.id === l.id)?.choices;
				const name = (v: string | undefined) => names?.find(c => c.id === v)?.name.replace(' ⚠', '') ?? v ?? 'another mode';
				warn(`${this.label} restarted, and this chat left ${name(l.value)}: it's in ${name(l.to)} again. Choose ${name(l.value)} again to go back to it.`);
			}

			// The chat's pickers (a new chat's picks before its first message too; the agent's own switches, leaving
			// plan mode, are shown in them), then the model picker.
			if (!await this.reconcile(key, session, shown, warn, settings)) {
				transcript.endTurn(true);
				return { metadata: { error: 'permission' } };
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
			// Saved with the turn: a reopened chat's model picker shows the model its last message ran on (core takes
			// it from the history's last request).
			transcript.setModel(this.controlsFor(session).find(c => c.placement === 'model')?.current);

			// One agent edits at a time: wait while another chat's turn runs (plan mode never waits).
			let waitedFor: string | undefined;
			lease = await this.env.scheduler.acquire({ chat: key, label: `${this.label} (“${item?.label ?? 'chat'}”)` }, {
				readOnly: this.readOnly(session),
				signal: stop.signal,
				onWait: (id, blockers) => {
					const who = blockers.map(b => b.label).join(', ');
					waitedFor = who;
					this.env.log.info(`[${this.profile.id}] waiting for ${who}`);
					stream.markdown(`Another chat is working in this workspace: **${who}**. This message starts when it's done, so the two agents don't edit the same files at once.\n\n`);
					stream.button({ command: 'agentChat.runNow', title: 'Run now', arguments: [id] });
					stream.progress(`Waiting for ${who} to finish…`);
					const tab = this.chatTab(key);
					if (tab) {
						this.waitingTabs.set(key, tab);
					}
				},
			});
			this.waitingTabs.delete(key);
			if (!lease) {
				transcript.endTurn(true);
				if (!stop.signal.aborted) {
					// The chat was closed while waiting (the response itself goes on: core keeps a chat with a running
					// request): the message is dropped, and the reopened chat says so.
					stream.clearToPreviousToolInvocation(vscode.ChatResponseClearToPreviousToolInvocationReason.NoReason);
					stream.markdown('*Not sent: the chat was closed while this message was waiting.*');
					transcript.add([{ op: 'markdown', text: '*Not sent: the chat was closed while this message was waiting.*' }]);
					return { metadata: { stopReason: 'closed' } };
				}
				// Stop while waiting. Core drops the response's updates after Stop, so the waiting line can't be cleared:
				// the footer says it wasn't sent.
				return { details: 'Stopped while waiting: not sent', metadata: { stopReason: 'cancelled' } };
			}
			if (waitedFor) {
				// The waiting line and its Run now button are done once the turn starts (Run now would only say so):
				// they make way for one line that says what happened.
				stream.clearToPreviousToolInvocation(vscode.ChatResponseClearToPreviousToolInvocationReason.NoReason);
				stream.markdown(`*Waited for ${waitedFor}.*\n\n`);
				if (notice) {
					stream.warning(notice);
				}
			}

			offChange = session.onChange(c => show(renderer.render(c)));
			offAsker = this.harness().broker.setAsker(session.id, async (p, signal) => {
				show(renderer.awaitApproval(p.toolCallId, true));
				try {
					return await this.askPermission(p, signal, request, token, notApproved);
				} finally {
					if (!token.isCancellationRequested) {
						show(renderer.awaitApproval(p.toolCallId, false));
					}
				}
			});

			const blocks = promptBlocks({
				prompt: request.prompt,
				...(request.command ? { command: request.command } : {}),
				references: references(request),
				root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
				exists: existsSync,
				...(note ? { note } : {}),
			});
			if (note) {
				this.stopNotes.delete(key);
				this.env.log.info(`[${this.profile.id}] told the agent which approved commands were running at Stop`);
			}
			const links = blocks.filter(b => b.type === 'resource_link').map(b => (b.type === 'resource_link' ? b.name : ''));
			this.env.log.info(`[${this.profile.id}] prompt: text${links.length ? ` + resource_link ${links.join(', ')}` : ''}`);
			const result = await session.prompt(blocks);
			close(result.stopReason === 'cancelled' ? 'stopped' : 'ended');
			transcript.endTurn(result.stopReason === 'cancelled');
			// The contract guard, in the app too: the agent must never call fs/* or terminal/* (we don't serve them).
			const forbidden = this.client?.supervisor.running?.connection.forbiddenInbound() ?? [];
			this.env.log[forbidden.length ? 'error' : 'info'](`[${this.profile.id}] turn ended: ${result.stopReason}; fs/terminal requests from the agent: ${forbidden.length ? forbidden.join(', ') : 'none'}`);
			return this.result(result, warn, session);
		} catch (e) {
			close(token.isCancellationRequested ? 'stopped' : 'interrupted');
			transcript.endTurn(token.isCancellationRequested);
			if (token.isCancellationRequested) {
				return { metadata: { stopReason: 'cancelled' }, ...this.details(session, true) };
			}
			return await this.turnError(e, stream, warn, { resource, text: retryText(request) });
		} finally {
			this.reconciling.delete(key);
			this.running.delete(key);
			lease?.release();
			offChange?.();
			offAsker?.();
			cancelSub.dispose();
			this.turns--;
			if (item) {
				item.timing = { ...item.timing, created: item.timing?.created ?? Date.now(), lastRequestEnded: Date.now() };
				item.status = vscode.ChatSessionStatus.Completed;
				// Re-adding is what tells core's sessions list that the item changed.
				this.controller.items.add(item);
			}
			this.saveChat(key, session);
		}
	}

	/** Track a chat's session: title and picker updates. */
	private attach(key: string, session: AcpSession, item: vscode.ChatSessionItem | undefined): void {
		this.sessions.set(key, session);
		session.onChange(c => {
			if (c.kind === 'info' && c.title && !session.replaying) {
				if (item && item.label !== c.title) {
					item.label = c.title;
					this.controller.items.add(item);
				}
				// It comes after the turn it names is saved: the list, Search Chats and a restart show it too.
				try {
					this.env.history.rename(key, c.title);
				} catch (e) {
					this.env.log.warn(`[${this.profile.id}] couldn't save the chat's title: ${errorMessage(e)}`);
				}
			}
			if ((c.kind === 'config' || c.kind === 'mode') && !session.replaying && !this.reconciling.has(key)) {
				this.remember(session);
				this.refresh(session);
				this.saveSettings(key, session);
			}
		});
		this.refresh(session);
	}

	/**
	 * The editor tab a chat's message was sent from: the active tab when it's a chat editor and the side bar's chat
	 * isn't this one. Closing it gives up the chat's waiting message (#21).
	 */
	private chatTab(key: string): vscode.Tab | undefined {
		if (vscode.window.activeChatPanelSessionResource?.toString() === key) {
			return undefined;
		}
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		const chatInput = (vscode as unknown as { TabInputChat?: abstract new (...args: never[]) => unknown }).TabInputChat;
		return tab && chatInput && tab.input instanceof chatInput ? tab : undefined;
	}

	/** Closed chat tabs: their chats' waiting messages are given up (they would run with nobody looking). */
	private onTabsClosed(closed: readonly vscode.Tab[]): void {
		for (const [key, tab] of this.waitingTabs) {
			// The same Tab object, or (should the API hand out a new one) the same chat tab in the same group.
			if (closed.some(t => t === tab || (t.label === tab.label && t.group.viewColumn === tab.group.viewColumn && t.input?.constructor === tab.input?.constructor))) {
				this.waitingTabs.delete(key);
				const n = this.env.scheduler.cancelChat(key);
				this.env.log.info(`[${this.profile.id}] chat tab closed: ${n} waiting message(s) dropped`);
			}
		}
	}

	/** The session is in a mode that can't edit (plan, read-only): its turns don't wait for other chats. */
	private readOnly(session: AcpSession): boolean {
		return this.controlsFor(session).some(c => this.profile.readOnlyValues?.[c.id]?.includes(c.current));
	}

	private result(result: acp.PromptResponse, warn: (text: string) => void, session: AcpSession): vscode.ChatResult {
		switch (result.stopReason) {
			case 'max_tokens':
				warn(`${this.label} stopped: it reached its output limit.`);
				break;
			case 'max_turn_requests':
				warn(`${this.label} stopped: it reached its limit of steps for one message. Send "continue" to go on.`);
				break;
			case 'refusal':
				warn(`${this.label} declined to continue.`);
				break;
		}
		return { metadata: { stopReason: result.stopReason }, ...this.details(session, result.stopReason === 'cancelled') };
	}

	/** The footer: "Stopped" for a stopped turn, a dangerous mode (Bypass permissions), the model, the context use. */
	private details(session: AcpSession | undefined, stopped: boolean): { details?: string } {
		const model = session && this.controlsFor(session).find(c => c.placement === 'model');
		const dangerous = session && this.dangerousMode(session);
		const details = footer({ stopped, ...(dangerous ? { dangerous } : {}), model: model?.choices.find(c => c.id === model.current)?.name, ...(session?.view.state.usage ? { usage: session.view.state.usage } : {}) });
		return details ? { details } : {};
	}

	/** The name of the dangerous value the session is in (Bypass permissions), if any. */
	private dangerousMode(session: AcpSession): string | undefined {
		for (const c of this.controlsFor(session)) {
			const choice = c.choices.find(ch => ch.id === c.current);
			if (choice?.dangerous) {
				return choice.name.replace(' ⚠', '');
			}
		}
		return undefined;
	}

	/** The status bar item: shown, with the warning colors, while any chat of this harness is in a dangerous mode. */
	private updateStatus(): void {
		const chats = [...this.sessions].flatMap(([key, session]) => {
			const mode = this.live(session) ? this.dangerousMode(session) : undefined;
			return mode ? [{ key, mode, title: this.items.get(key)?.label ?? this.env.history.get(key)?.title ?? 'chat' }] : [];
		});
		if (!chats.length) {
			this.statusItem?.hide();
			return;
		}
		const item = this.statusItem ??= vscode.window.createStatusBarItem(`agentChat.dangerous.${this.profile.id}`, vscode.StatusBarAlignment.Left, 1000);
		item.name = `${this.label}: dangerous mode`;
		item.text = `$(warning) ${this.label}: ${chats[0]!.mode}${chats.length > 1 ? ` (${chats.length} chats)` : ''}`;
		item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
		item.tooltip = `${chats.map(c => `“${c.title}”: ${c.mode}`).join('\n')}\n\n${this.label} runs commands and edits files there without asking. Its edits in the workspace still show up for review. Pick another mode in the chat to leave it.`;
		item.command = { command: 'agentChat.openChat', title: 'Show the chat', arguments: [chats[0]!.key] };
		item.show();
	}

	private startError(e: unknown, stream: vscode.ChatResponseStream, warn: (text: string) => void): vscode.ChatResult {
		if (isAuthRequired(e)) {
			this.needsLogin();
			// The harness's own reason when it says more than "auth required" (tact: its sign-in was refused).
			const reason = firstLine(errorMessage(e));
			const said = reason && !/^(internal error: )?auth(entication)? required\.?$/i.test(reason) ? `\n\n${reason}` : '';
			warn(`You're not signed in to ${this.label}. Sign in once, in a terminal; then send your message again.${said}`);
			stream.button({ command: 'agentChat.login', title: `Sign in to ${this.label}`, arguments: [this.profile.id] });
			stream.button({ command: 'agentChat.restart', title: 'I\'ve signed in: try again', arguments: [this.profile.id] });
			return { metadata: { error: 'auth' } };
		}
		if (e instanceof HarnessMissingError) {
			const elsewhere = (this.profile.harness.fallbackPaths ?? []).map(p => `\`${p}\``).join(' or ');
			this.env.log.warn(`[${this.profile.id}] not installed`);
			warn(`${this.label} isn't installed: \`${this.profile.harness.binary}\` isn't on PATH${elsewhere ? ` or at ${elsewhere}` : ''}.`);
			if (this.profile.installCommand) {
				stream.markdown(`Install it with\n\n\`\`\`sh\n${this.profile.installCommand}\n\`\`\`\n\nthen sign in with \`${this.profile.harness.binary} ${this.profile.login.args.join(' ')}\`. Or set \`agentChat.harnesses.${this.profile.id}.harnessPath\` to the one you have.`);
			} else if (this.profile.install) {
				stream.markdown(this.profile.install);
			}
			if (this.profile.installCommand) {
				stream.button({ command: 'agentChat.install', title: `Install ${this.label} in a terminal`, arguments: [this.profile.id] });
			}
			stream.button({ command: 'agentChat.restart', title: 'I\'ve installed it: try again', arguments: [this.profile.id] });
			return { metadata: { error: 'missing' } };
		}
		const message = errorMessage(e);
		this.env.log.error(`[${this.profile.id}] start failed: ${message}`);
		warn(`${this.label} couldn't start: ${firstLine(message)}`);
		stream.button({ command: 'agentChat.showLog', title: 'Show Log' });
		stream.button({ command: 'agentChat.restart', title: `Restart ${this.label}`, arguments: [this.profile.id] });
		return { metadata: { error: 'start' } };
	}

	/** A failed turn's card. `retry` is the chat and the text to send again for a Claude-side hiccup's Retry button. */
	private async turnError(e: unknown, stream: vscode.ChatResponseStream, warn: (text: string) => void, retry?: { resource: vscode.Uri | undefined; text: string }): Promise<vscode.ChatResult> {
		if (isAuthRequired(e)) {
			return this.startError(e, stream, warn);
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
			warn(`${this.label} stopped unexpectedly${how}. Your next message restarts it and resumes this chat.`);
		} else {
			warn(turnFailureText(this.label, message));
		}
		if (!crashed && retry && isServerToolHiccup(message)) {
			stream.button({ command: 'agentChat.retry', title: 'Retry', arguments: [retry.resource?.toString(), retry.text] });
		}
		stream.button({ command: 'agentChat.showLog', title: 'Show Log' });
		return { metadata: { error: crashed ? 'crashed' : 'failed' } };
	}

	private async askPermission(p: PermissionPrompt, signal: AbortSignal, request: vscode.ChatRequest, token: vscode.CancellationToken, notApproved: Set<string>): Promise<string | undefined> {
		notApproved.add(p.toolCallId);
		const buttons = permissionButtons(p);
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
			const choice = index >= 0 ? p.choices[index]! : undefined;
			if (choice?.kind.startsWith('allow')) {
				notApproved.delete(p.toolCallId);
			}
			return choice?.optionId;
		} catch (e) {
			this.env.log.info(`[${this.profile.id}] permission prompt closed: ${String(e)}`);
			return undefined;
		} finally {
			subs.forEach(s => s.dispose());
			cts.dispose();
		}
	}

	dispose(): void {
		this.statusItem?.dispose();
		this.disposables.forEach(d => d.dispose());
		void this.client?.dispose();
	}
}

/** A chat's title from its first prompt: one line, at most 50 characters. */
function titleOf(prompt: string): string {
	const line = prompt.trim().split('\n')[0]!.trim();
	return line.length > 50 ? `${line.slice(0, 49).trimEnd()}…` : line;
}

function firstLine(text: string): string {
	return text.split('\n')[0]!.slice(0, 300);
}

/** The request's references (inline pills with their offset in the prompt, attached files, the active editor). */
function references(request: vscode.ChatRequest): PromptReference[] {
	const out: PromptReference[] = [];
	for (const ref of request.references) {
		const v = ref.value;
		const at = ref.range ? { at: ref.range[0] } : {};
		if (v instanceof vscode.Uri && v.scheme === 'file') {
			out.push({ path: v.fsPath, ...at });
		} else if (v instanceof vscode.Location && v.uri.scheme === 'file') {
			out.push({ path: v.uri.fsPath, startLine: v.range.start.line + 1, endLine: v.range.end.line + 1, ...at });
		}
	}
	return out;
}
