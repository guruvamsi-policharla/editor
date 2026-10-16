/**
 * The ACP agent: one tact process (in a hidden pty) per ACP session, driven through its web API.
 *
 * - `session/new` starts tact; its first session becomes the ACP session (same id). `session/load` and
 *   `session/resume` start tact with `--resume <id>`; load replays the snapshot's entries.
 * - `session/prompt`: `set_draft`, then `submit` with the draft's revision; entry upserts stream back as updates
 *   until the turn's `turn_completed` / `interrupted` / `error` entry.
 * - `session/cancel` → `interrupt`. Config options → `set_model` / `set_effort` / `set_reasoning_mode` /
 *   `set_speed`; tact's `settings` events → `config_option_update`. A model (or reasoning mode) change before the
 *   first turn makes tact replace the session with a new one (a new id, `claude-…` for Claude): the ACP session
 *   keeps its id and follows tact's (remembered in `$TACT_HOME/editor-sessions.json`, for `--resume`).
 * - `$TACT_HOME/config.toml` changes (a Claude key added) → `reload_config` and the `models` catalog again.
 * - tact's refusals (HTTP status, code, message) are the ACP errors' messages, never a bare "Internal error".
 * - tact not signed in (it exits at start) → `authRequired`. tact never asks for permission, and the client's
 *   fs/terminal methods are never called: tact edits files and runs commands itself.
 */
import { mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { configOptions, EntryMapper, isAuthError, promptText, sessionStartFailure, SET_COMMAND, settingsOf, toolDetail, type TactSettings, type TurnEnd } from './mapping.js';
import { hasWebApi, launchTact, tactHome, TactStartError, type TactInstance, type TactLaunch } from './process.js';
import { TactApiError, TactWeb, type ModelCatalog, type SessionSnapshot, type StreamEvent, type WireEntry } from './web.js';

export interface TactAgentOptions {
	/** The tact binary (`TACT_BIN`, else `tact` on PATH). */
	tact: string;
	env?: Record<string, string | undefined>;
	launch?: (o: TactLaunch) => Promise<TactInstance>;
	/** Skip the `--web` capability check (tests). */
	skipCheck?: boolean;
	/** Watch tact's config.toml for changes (default true). */
	watchConfig?: boolean;
}

type Notify = (update: acp.SessionUpdate) => Promise<void>;

class TactSession {
	readonly mapper: EntryMapper;
	settings!: TactSettings;
	catalog: ModelCatalog | undefined;
	private turn: { resolve: (end: TurnEnd) => void } | undefined;
	private drafts: { text: string; resolve: (rev: number) => void }[] = [];
	private snapshot!: (s: SessionSnapshot) => void;
	readonly ready: Promise<SessionSnapshot> = new Promise(resolve => { this.snapshot = resolve; });
	alive = true;
	/** Set once the first snapshot is in: updates before it belong to the replay. */
	private live = false;
	/** While tact replaces the session (a model change): called with the new session's snapshot. */
	private replacing: (() => void) | undefined;
	/** A model change in flight: a prompt waits for tact's new session. */
	private switching: Promise<void> | undefined;
	/** After tact replaced the session: its new id. */
	onReplaced: ((tactId: string) => void) | undefined;

	constructor(readonly instance: TactInstance, readonly web: TactWeb, private readonly notify: Notify, cwd: string) {
		this.mapper = new EntryMapper(cwd);
	}

	start(): void {
		void this.web.stream(e => this.onEvent(e), () => this.onEnd());
		void this.instance.exited.then(() => this.onEnd());
	}

	private onEnd(): void {
		if (!this.alive) {
			return;
		}
		this.alive = false;
		this.web.close();
		this.turn?.resolve({ kind: 'error', message: `tact exited.\n${this.instance.output().trim().split('\n').slice(-5).join('\n')}` });
	}

	/** tact's session this process runs (its active one); after a model change, not the ACP session's id. */
	sessionId: string | undefined;

	private onEvent(e: StreamEvent): void {
		const data = e.data as Record<string, unknown>;
		if (e.event === 'snapshot') {
			const s = data as unknown as SessionSnapshot;
			if (this.replacing && s.session !== this.sessionId) {
				// tact closed the old session and made this one active: follow it.
				this.sessionId = s.session;
				this.settings = settingsOf(s);
				this.onReplaced?.(s.session);
				this.replacing();
				return;
			}
			if (!this.sessionId || this.sessionId === s.session) {
				this.sessionId = s.session;
				this.settings = settingsOf(s);
				if (!this.live) {
					this.live = true;
					this.snapshot(s);
				}
			}
			return;
		}
		if (data.session !== undefined && data.session !== this.sessionId) {
			return;
		}
		switch (e.event) {
			case 'entry':
				this.onEntry(data.entry as WireEntry);
				break;
			case 'draft': {
				const i = this.drafts.findIndex(d => d.text === data.text);
				if (i >= 0) {
					this.drafts.splice(i, 1)[0]!.resolve(Number(data.rev));
				}
				break;
			}
			case 'settings':
				this.settings = { ...this.settings, model: String(data.model), effort: data.effort as TactSettings['effort'], reasoning_mode: String(data.reasoning_mode), speed: String(data.speed) };
				void this.notify({ sessionUpdate: 'config_option_update', configOptions: this.options() });
				break;
			case 'context':
				void this.notify({ sessionUpdate: 'usage_update', used: Number(data.active_tokens) || 0, size: Number(data.window_tokens) || 0 });
				break;
			case 'live': {
				const summary = (data.sessions as { id: string; title: string }[] | undefined)?.find(x => x.id === this.sessionId);
				if (summary?.title && summary.title !== 'New chat') {
					void this.notify({ sessionUpdate: 'session_info_update', title: summary.title });
				}
				break;
			}
		}
	}

	private onEntry(entry: WireEntry): void {
		if (this.stopping && this.turn && entry.id > this.mapper.baseline && entry.kind !== 'user') {
			// Stop came before tact started the turn (`nothing_running`): now there's something to interrupt.
			this.stopping = false;
			void this.web.command('interrupt', { session: this.sessionId }).catch(() => undefined);
		}
		if (entry.kind === 'user' && !this.settings.started) {
			this.settings = { ...this.settings, started: true };
			void this.notify({ sessionUpdate: 'config_option_update', configOptions: this.options() });
		}
		for (const u of this.mapper.map(entry)) {
			void this.notify(u);
		}
		if (entry.kind === 'tool' && entry.state !== 'running' && entry.has_detail && this.sessionId) {
			void this.detail(entry.id);
		}
		const end = this.mapper.turnEnd(entry);
		if (end) {
			this.turn?.resolve(end);
		}
	}

	private async detail(id: number): Promise<void> {
		try {
			const res = await fetch(`${this.web.url}/api/sessions/${encodeURIComponent(this.sessionId!)}/entries/${id}`, { headers: { cookie: `tact=${this.instance.token}` } });
			if (res.ok) {
				const extra = toolDetail(await res.json() as { arguments?: unknown; result?: unknown });
				extra.locations = extra.locations?.map(l => ({ ...l, path: this.mapper.absolute(l.path) }));
				if (extra.content || extra.locations || extra.rawInput) {
					await this.notify({ sessionUpdate: 'tool_call_update', toolCallId: `t${id}`, ...extra });
				}
			}
		} catch {
			// details are a bonus
		}
	}

	options(): acp.SessionConfigOption[] {
		return configOptions(this.settings, this.catalog);
	}

	/** A web API command; tact's refusal is an ACP error with its message, status and code. */
	private async command(cmd: string, args?: Record<string, unknown>): Promise<void> {
		try {
			await this.web.command(cmd, args);
		} catch (e) {
			throw apiFailure(e);
		}
	}

	/** Sets a picker: tact's `set_*` command. A model change waits for the session tact starts for it. */
	async set(configId: string, value: string): Promise<void> {
		const set = SET_COMMAND[configId];
		if (!set) {
			return;
		}
		await this.switching?.catch(() => undefined);
		if (configId === 'model' && !this.catalog?.models.some(m => m.id === value)) {
			// A model the catalog didn't have when tact started (a key added since): tact's config, again.
			await this.refreshCatalog(true);
		}
		const args = { session: this.sessionId, [set.arg]: value };
		const current = this.options().find(o => o.id === configId)?.currentValue;
		if ((configId === 'model' || configId === 'reasoning_mode') && !this.settings.started && current !== value) {
			const label = configId === 'model' ? this.catalog?.models.find(m => m.id === value)?.label ?? value : `${value} reasoning`;
			const switching = this.switching = this.replace(set.cmd, args, `the ${label} session`);
			try {
				await switching;
			} finally {
				if (this.switching === switching) {
					this.switching = undefined;
				}
			}
			return;
		}
		await this.command(set.cmd, args);
		this.settings = { ...this.settings, [configId]: value };
	}

	/**
	 * Sends a command after which tact replaces the session (`set_model`, `set_reasoning_mode`) and waits for the new
	 * one. If tact can't start it (a bad Claude key), it says why only in its terminal, and keeps the old session.
	 */
	private async replace(cmd: string, args: Record<string, unknown>, what: string): Promise<void> {
		const old = this.sessionId;
		let raw = '';
		const off = this.instance.onOutput(chunk => { raw = (raw + chunk).slice(-32_000); });
		const replaced = new Promise<boolean>(resolve => { this.replacing = () => resolve(true); });
		const within = (ms: number) => Promise.race([replaced, new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms))]);
		try {
			await this.command(cmd, args);
			const deadline = Date.now() + 60_000;
			while (!await within(400)) {
				if (!this.alive) {
					throw failure(`exited while starting ${what}.`);
				}
				if (Date.now() > deadline) {
					throw failure(`didn't start ${what} within 60 s.`);
				}
				// While tact starts the new session the old one refuses commands ("the session is still starting"); if it
				// takes one again and tact hasn't switched, the start failed.
				const back = await this.web.command('set_draft', { session: old, text: '' }).then(() => true, () => false);
				if (back && !await within(300)) {
					const why = sessionStartFailure(raw);
					throw failure(`couldn't start ${what}${why ? `: ${why}` : ' (it didn\'t say why)'}`);
				}
			}
		} finally {
			off();
			this.replacing = undefined;
		}
	}

	/** The `models` catalog again (after `reload_config`, for a key added to tact's config); the pickers if it changed. */
	async refreshCatalog(reload: boolean): Promise<void> {
		if (reload) {
			await this.web.command('reload_config').catch(() => undefined);
		}
		const catalog = await this.web.query<ModelCatalog>('models').catch(() => undefined);
		if (catalog && JSON.stringify(catalog) !== JSON.stringify(this.catalog)) {
			this.catalog = catalog;
			await this.notify({ sessionUpdate: 'config_option_update', configOptions: this.options() });
		}
	}

	async prompt(text: string): Promise<TurnEnd> {
		if (!this.alive) {
			throw failure('tact is no longer running for this chat');
		}
		// A model change still starting tact's new session: the message goes to that one.
		await this.switching;
		this.mapper.baseline = this.mapper.lastId;
		const rev = new Promise<number>(resolve => this.drafts.push({ text, resolve }));
		const end = new Promise<TurnEnd>(resolve => { this.turn = { resolve }; });
		this.stopping = false;
		try {
			await this.command('set_draft', { session: this.sessionId, text });
			const draft = await withTimeout(rev, 10_000, 'tact did not acknowledge the message');
			if (this.stopping) {
				// Stopped before it was sent: don't send it, and leave tact's composer empty.
				await this.web.command('set_draft', { session: this.sessionId, text: '' }).catch(() => undefined);
				return { kind: 'interrupted' };
			}
			await this.command('submit', { session: this.sessionId, rev: draft });
			return await end;
		} finally {
			this.turn = undefined;
			this.stopping = false;
		}
	}

	/** Stop was asked for a turn tact hadn't started yet: interrupt it as soon as it has. */
	private stopping = false;

	async cancel(): Promise<void> {
		try {
			await this.web.command('interrupt', { session: this.sessionId });
		} catch (e) {
			if (e instanceof TactApiError && e.code === 'nothing_running' && this.turn) {
				this.stopping = true;
			}
		}
	}

	close(): void {
		this.alive = false;
		this.web.close();
		this.instance.kill();
	}
}

export class TactAgent {
	/** ACP session id → its tact */
	private readonly sessions = new Map<string, TactSession>();
	/** session id → its workspace (to restart a tact that exited) */
	private readonly cwds = new Map<string, string>();
	private checked = false;
	private watcher: FSWatcher | undefined;

	constructor(private readonly options: TactAgentOptions, private readonly notify: (sessionId: string, update: acp.SessionUpdate) => Promise<void>) { }

	initialize(): acp.InitializeResponse {
		return {
			protocolVersion: acp.PROTOCOL_VERSION,
			agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
			authMethods: [],
			agentInfo: { name: 'tact-acp', title: 'tact', version: '0.0.1' },
		};
	}

	private env(): Record<string, string | undefined> {
		return { ...process.env, ...this.options.env };
	}

	/** ACP session id → tact's session, for chats whose session tact replaced (a model change). */
	private aliasFile(): string {
		return join(tactHome(this.env()), 'editor-sessions.json');
	}

	private aliases(): Record<string, string> {
		try {
			return JSON.parse(readFileSync(this.aliasFile(), 'utf8')) as Record<string, string>;
		} catch {
			return {};
		}
	}

	private alias(acpId: string, tactId: string): void {
		try {
			const file = this.aliasFile();
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, JSON.stringify({ ...this.aliases(), [acpId]: tactId }, undefined, '\t'));
		} catch {
			// Then a reload resumes the chat's first (empty) session: the chat still works, on tact's default model.
		}
	}

	/** tact's config changed (a Claude key added): each tact reloads it, and the pickers get its models now. */
	private watchConfig(): void {
		if (this.watcher || this.options.watchConfig === false) {
			return;
		}
		const env = this.env();
		const file = env.TACT_CONFIG?.trim() || join(tactHome(env), 'config.toml');
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			// The directory: editors replace the file (a new inode) when they save.
			this.watcher = watch(dirname(file), (_event, name) => {
				if (name && name.toString() !== basename(file)) {
					return;
				}
				clearTimeout(timer);
				timer = setTimeout(() => {
					for (const s of this.sessions.values()) {
						if (s.alive) {
							void s.refreshCatalog(true);
						}
					}
				}, 300);
			});
			this.watcher.on('error', () => undefined);
			this.watcher.unref();
		} catch {
			// no such directory yet: nothing to watch
		}
	}

	/** `id`: the ACP session to start tact on (`--resume` with tact's session for it). */
	private async start(cwd: string, id: string | undefined, replay: boolean): Promise<TactSession> {
		const resume = id ? this.aliases()[id] ?? id : undefined;
		if (!this.checked && !this.options.skipCheck) {
			if (!hasWebApi(this.options.tact)) {
				throw failure(`This tact (${this.options.tact}) has no web API, which the editor talks to. It's on tact's main branch after v0.8.3: update to a pre-release build with \`curl -fsSL https://tact.clab.by/install.sh | TACT_CHANNEL=pre-release sh\` (or \`tact update <commit>\` with a commit of tact's main branch), then restart tact from the chat.`);
			}
			this.checked = true;
		}
		let instance: TactInstance;
		try {
			instance = await (this.options.launch ?? launchTact)({ tact: this.options.tact, cwd, env: this.options.env, ...(resume ? { args: ['--resume', resume] } : {}) });
		} catch (e) {
			if (e instanceof TactStartError && e.kind === 'auth') {
				throw acp.RequestError.authRequired(undefined, e.message);
			}
			throw failure(e instanceof Error ? e.message : String(e));
		}
		this.watchConfig();
		const web = new TactWeb(instance.port, instance.token);
		let sessionId = id;
		const pending: acp.SessionUpdate[] = [];
		const session: TactSession = new TactSession(instance, web, async u => {
			if (sessionId) {
				await this.notify(sessionId, u);
			} else {
				pending.push(u);
			}
		}, cwd);
		session.start();
		const snapshot = await withTimeout(session.ready, 20_000, 'tact did not send its session');
		const acpId = sessionId = id ?? snapshot.session;
		session.onReplaced = tactId => this.alias(acpId, tactId);
		session.catalog = await web.query<ModelCatalog>('models').catch(() => undefined);
		for (const entry of snapshot.entries) {
			const updates = session.mapper.map(entry, true);
			if (replay) {
				for (const u of updates) {
					await this.notify(sessionId, u);
				}
			}
		}
		this.sessions.set(acpId, session);
		this.cwds.set(acpId, cwd);
		return session;
	}

	private session(id: string): TactSession {
		const s = this.sessions.get(id);
		if (!s) {
			throw acp.RequestError.resourceNotFound(id);
		}
		return s;
	}

	async newSession(p: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		const s = await this.start(p.cwd, undefined, false);
		// tact's first session: the chat's id from now on, whatever tact's session becomes.
		return { sessionId: s.sessionId!, configOptions: s.options() };
	}

	async loadSession(p: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
		this.sessions.get(p.sessionId)?.close();
		const s = await this.start(p.cwd, p.sessionId, true);
		return { configOptions: s.options() };
	}

	async resumeSession(p: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
		const existing = this.sessions.get(p.sessionId);
		const s = existing?.alive ? existing : await this.start(p.cwd, p.sessionId, false);
		return { configOptions: s.options() };
	}

	async prompt(p: acp.PromptRequest): Promise<acp.PromptResponse> {
		let s = this.session(p.sessionId);
		const cwd = this.cwds.get(p.sessionId);
		if (!s.alive && cwd) {
			// tact exited (crashed, or was closed): start it again on the same session.
			s = await this.start(cwd, p.sessionId, false);
		}
		const end = await s.prompt(promptText(p.prompt));
		if (end.kind === 'error') {
			if (isAuthError(end.message)) {
				// The chat then offers "Sign in to tact" (runs `tact auth login` in a terminal) and restarts tact after.
				throw acp.RequestError.authRequired(undefined, `tact's sign-in was refused (${end.message}). Sign in again with \`tact auth login\`, or check OPENAI_API_KEY.`);
			}
			throw failure(end.message);
		}
		return { stopReason: end.kind === 'interrupted' ? 'cancelled' : 'end_turn' };
	}

	async cancel(p: acp.CancelNotification): Promise<void> {
		await this.sessions.get(p.sessionId)?.cancel();
	}

	async setConfigOption(p: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
		const s = this.session(p.sessionId);
		await s.set(p.configId, String(p.value));
		return { configOptions: s.options() };
	}

	closeSession(p: acp.CloseSessionRequest): acp.CloseSessionResponse {
		this.sessions.get(p.sessionId)?.close();
		this.sessions.delete(p.sessionId);
		return {};
	}

	dispose(): void {
		this.watcher?.close();
		this.watcher = undefined;
		for (const s of this.sessions.values()) {
			s.close();
		}
		this.sessions.clear();
	}
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		p.finally(() => clearTimeout(timer)),
		new Promise<never>((_, reject) => { timer = setTimeout(() => reject(failure(message)), ms); }),
	]);
}

/** A refused web API request (or tact unreachable) as an ACP error with tact's own words. */
function apiFailure(e: unknown): acp.RequestError {
	if (e instanceof acp.RequestError) {
		return e;
	}
	if (e instanceof TactApiError) {
		return failure(`refused the request: ${e.describe()}`);
	}
	return failure(`couldn't reach tact's web API: ${e instanceof Error ? e.message : String(e)}`);
}

/** An error whose message is just tact's (no "Internal error:" prefix). */
function failure(message: string): acp.RequestError {
	return new acp.RequestError(-32603, message);
}
