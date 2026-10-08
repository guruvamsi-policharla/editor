/**
 * The ACP agent: one tact process (in a hidden pty) per ACP session, driven through its web API.
 *
 * - `session/new` starts tact; its first session becomes the ACP session (same id). `session/load` and
 *   `session/resume` start tact with `--resume <id>`; load replays the snapshot's entries.
 * - `session/prompt`: `set_draft`, then `submit` with the draft's revision; entry upserts stream back as updates
 *   until the turn's `turn_completed` / `interrupted` / `error` entry.
 * - `session/cancel` → `interrupt`. Config options → `set_model` / `set_effort` / `set_reasoning_mode` /
 *   `set_speed`; tact's `settings` events → `config_option_update`.
 * - tact not signed in (it exits at start) → `authRequired`. tact never asks for permission, and the client's
 *   fs/terminal methods are never called: tact edits files and runs commands itself.
 */
import * as acp from '@agentclientprotocol/sdk';
import { configOptions, EntryMapper, promptText, SET_COMMAND, settingsOf, toolDetail, type TactSettings, type TurnEnd } from './mapping.js';
import { hasWebApi, launchTact, TactStartError, type TactInstance, type TactLaunch } from './process.js';
import { TactWeb, type ModelCatalog, type SessionSnapshot, type StreamEvent, type WireEntry } from './web.js';

export interface TactAgentOptions {
	/** The tact binary (`TACT_BIN`, else `tact` on PATH). */
	tact: string;
	env?: Record<string, string | undefined>;
	launch?: (o: TactLaunch) => Promise<TactInstance>;
	/** Skip the `--web` capability check (tests). */
	skipCheck?: boolean;
}

type Notify = (update: acp.SessionUpdate) => Promise<void>;

class TactSession {
	readonly mapper = new EntryMapper();
	settings!: TactSettings;
	catalog: ModelCatalog | undefined;
	private turn: { resolve: (end: TurnEnd) => void } | undefined;
	private drafts: { text: string; resolve: (rev: number) => void }[] = [];
	private snapshot!: (s: SessionSnapshot) => void;
	readonly ready: Promise<SessionSnapshot> = new Promise(resolve => { this.snapshot = resolve; });
	alive = true;
	/** Set once the first snapshot is in: updates before it belong to the replay. */
	private live = false;

	constructor(readonly instance: TactInstance, readonly web: TactWeb, private readonly notify: Notify) { }

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

	/** The session this tact process runs (its active one). */
	sessionId: string | undefined;

	private onEvent(e: StreamEvent): void {
		const data = e.data as Record<string, unknown>;
		if (e.event === 'snapshot') {
			const s = data as unknown as SessionSnapshot;
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

	async prompt(text: string): Promise<TurnEnd> {
		if (!this.alive) {
			throw failure('tact is no longer running for this chat');
		}
		this.mapper.baseline = this.mapper.lastId;
		const rev = new Promise<number>(resolve => this.drafts.push({ text, resolve }));
		await this.web.command('set_draft', { session: this.sessionId, text });
		const end = new Promise<TurnEnd>(resolve => { this.turn = { resolve }; });
		await this.web.command('submit', { session: this.sessionId, rev: await withTimeout(rev, 10_000, 'tact did not acknowledge the message') });
		try {
			return await end;
		} finally {
			this.turn = undefined;
		}
	}

	async cancel(): Promise<void> {
		await this.web.command('interrupt', { session: this.sessionId }).catch(() => undefined);
	}

	close(): void {
		this.alive = false;
		this.web.close();
		this.instance.kill();
	}
}

export class TactAgent {
	private readonly sessions = new Map<string, TactSession>();
	/** session id → its workspace (to restart a tact that exited) */
	private readonly cwds = new Map<string, string>();
	private checked = false;

	constructor(private readonly options: TactAgentOptions, private readonly notify: (sessionId: string, update: acp.SessionUpdate) => Promise<void>) { }

	initialize(): acp.InitializeResponse {
		return {
			protocolVersion: acp.PROTOCOL_VERSION,
			agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
			authMethods: [],
			agentInfo: { name: 'tact-acp', title: 'tact', version: '0.0.1' },
		};
	}

	private async start(cwd: string, resume: string | undefined, replay: boolean): Promise<TactSession> {
		if (!this.checked && !this.options.skipCheck) {
			if (!hasWebApi(this.options.tact)) {
				throw failure(`This tact (${this.options.tact}) has no web API, which the editor talks to. It's on tact's main branch after v0.8.3: install it with \`cargo install --locked --git https://github.com/clabby/tact tact\`, or \`tact update\` once a release has it.`);
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
		const web = new TactWeb(instance.port, instance.token);
		let sessionId = resume;
		const pending: acp.SessionUpdate[] = [];
		const session: TactSession = new TactSession(instance, web, async u => {
			if (sessionId) {
				await this.notify(sessionId, u);
			} else {
				pending.push(u);
			}
		});
		session.start();
		const snapshot = await withTimeout(session.ready, 20_000, 'tact did not send its session');
		sessionId = snapshot.session;
		session.catalog = await web.query<ModelCatalog>('models').catch(() => undefined);
		for (const entry of snapshot.entries) {
			const updates = session.mapper.map(entry, true);
			if (replay) {
				for (const u of updates) {
					await this.notify(sessionId, u);
				}
			}
		}
		this.sessions.set(sessionId, session);
		this.cwds.set(sessionId, cwd);
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
			throw failure(end.message);
		}
		return { stopReason: end.kind === 'interrupted' ? 'cancelled' : 'end_turn' };
	}

	async cancel(p: acp.CancelNotification): Promise<void> {
		await this.sessions.get(p.sessionId)?.cancel();
	}

	async setConfigOption(p: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
		const s = this.session(p.sessionId);
		const set = SET_COMMAND[p.configId];
		if (set) {
			await s.web.command(set.cmd, { session: s.sessionId, [set.arg]: p.value });
			s.settings = { ...s.settings, [p.configId]: p.value };
		}
		return { configOptions: s.options() };
	}

	closeSession(p: acp.CloseSessionRequest): acp.CloseSessionResponse {
		this.sessions.get(p.sessionId)?.close();
		this.sessions.delete(p.sessionId);
		return {};
	}

	dispose(): void {
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

/** An error whose message is just tact's (no "Internal error:" prefix). */
function failure(message: string): acp.RequestError {
	return new acp.RequestError(-32603, message);
}
