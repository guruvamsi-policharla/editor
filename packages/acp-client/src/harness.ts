/**
 * Sessions on one harness: `session/new` with the profile's meta and defaults, prompt/cancel/config, updates
 * routed through the reducer, permission requests through the broker, and recovery after an adapter crash
 * (`session/resume` when the agent supports it, else a fresh session).
 */
import * as acp from '@agentclientprotocol/sdk';
import { isLooser, optionValues, pendingDefaults, strictestOffered } from './config.js';
import { PermissionBroker } from './permissions.js';
import type { HarnessProfile } from './profiles.js';
import { SessionView, type Change } from './reducer.js';
import type { AgentSupervisor, Ready } from './supervisor.js';

/** ACP's `authRequired` JSON-RPC error code. */
export const AUTH_REQUIRED_CODE = acp.RequestError.authRequired().code;

export function isAuthRequired(e: unknown): boolean {
	if (!e || typeof e !== 'object') {
		return false;
	}
	const { code, message } = e as { code?: unknown; message?: unknown };
	return code === AUTH_REQUIRED_CODE || (typeof message === 'string' && /auth(entication)? required|not (logged|signed) in|please run \/?login/i.test(message));
}

export function errorMessage(e: unknown): string {
	if (e && typeof e === 'object') {
		const { message, data } = e as { message?: unknown; data?: unknown };
		const detail = data && typeof data === 'object' && 'message' in data ? String((data as { message: unknown }).message) : typeof data === 'string' ? data : undefined;
		if (typeof message === 'string') {
			return detail && !message.includes(detail) ? `${message}: ${detail}` : message;
		}
	}
	return String(e);
}

/**
 * How `ensureLive` got the session onto the running adapter: it was there (`live`), it was reconnected without
 * replay (`resumed`), it was reloaded with a replay (`loaded`), or it had to start over (`new`).
 */
export type Recovery = 'live' | 'resumed' | 'loaded' | 'new';

/** What `applySettings` did. */
export interface SettingsResult {
	applied: { id: string; value: string }[];
	failed: { id: string; value: string; error: string }[];
	/** The permission option's value after falling back to the strictest one (set when the wanted one didn't hold). */
	fellBackTo?: string;
	/** False when the session's permission option is still looser than wanted. */
	permissionHeld: boolean;
}

/** A recovered session is looser than it was, and couldn't be set back: nothing was sent. */
export class PermissionNotRestoredError extends Error {
	constructor(readonly current: string | undefined) {
		super(`the session came back in a mode that asks less often (${current ?? 'unknown'}) and couldn't be switched back, so nothing was sent`);
	}
}

function offers(options: readonly acp.SessionConfigOption[], id: string, value: string): boolean {
	const o = options.find(x => x.id === id);
	return o?.type === 'select' && o.options.flatMap(x => ('options' in x ? x.options : [x])).some(c => c.value === value);
}

export class AcpSession {
	readonly view = new SessionView();
	/** True while `session/load` replays the conversation (listeners that render live turns ignore those). */
	replaying = false;
	private readonly listeners = new Set<(c: Change) => void>();

	constructor(private readonly harness: HarnessClient, public id: string, public generation: number, configOptions: readonly acp.SessionConfigOption[] | null | undefined) {
		this.view.setConfigOptions(configOptions);
	}

	onChange(listener: (c: Change) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** @internal */
	emit(change: Change): void {
		for (const listener of [...this.listeners]) {
			listener(change);
		}
	}

	/**
	 * Make sure the session lives on the running adapter. After a crash, or for a chat reopened from history:
	 * resume it (no replay), else load it (replayed into the view), else start a new one. Each of those starts from
	 * the agent's (or the profile's) defaults, so the options the view had before (the chat's: the last ones seen, or
	 * the ones a restored session was given) are set again: `settings` says how that went.
	 */
	async ensureLive(): Promise<{ ready: Ready; recovery: Recovery; settings?: SettingsResult }> {
		const ready = await this.harness.supervisor.get();
		if (ready.generation === this.generation) {
			return { ready, recovery: 'live' };
		}
		const before = optionValues(this.view.state.configOptions);
		const recovery = await this.recover(ready);
		return { ready, recovery, settings: await this.applySettings(before) };
	}

	private async recover(ready: Ready): Promise<Recovery> {
		const oldId = this.id;
		if (ready.init.agentCapabilities?.sessionCapabilities?.resume) {
			try {
				const res = await ready.connection.resumeSession({ sessionId: oldId, cwd: this.harness.cwd, mcpServers: [], ...this.harness.meta() });
				this.generation = ready.generation;
				this.emit(this.view.setConfigOptions(res.configOptions ?? this.view.state.configOptions));
				return 'resumed';
			} catch {
				// fall through
			}
		}
		if (ready.init.agentCapabilities?.loadSession) {
			try {
				await this.harness.loadInto(this, ready);
				return 'loaded';
			} catch {
				// fall through to a new session
			}
		}
		const res = await this.harness.createRaw(ready);
		this.harness.rekey(this, oldId, res.sessionId);
		this.id = res.sessionId;
		this.generation = ready.generation;
		this.emit(this.view.setConfigOptions(res.configOptions));
		return 'new';
	}

	/** Throws, without prompting, when a recovered session couldn't get its permission option back (see ensureLive). */
	async prompt(prompt: string | acp.ContentBlock[]): Promise<acp.PromptResponse> {
		const { ready, settings } = await this.ensureLive();
		if (settings && !settings.permissionHeld) {
			throw new PermissionNotRestoredError(settings.fellBackTo);
		}
		return ready.connection.prompt(this.id, prompt);
	}

	/** Set a config option; the response (the complete list) replaces the view's options. */
	async setOption(configId: string, value: string): Promise<acp.SessionConfigOption[]> {
		const { ready } = await this.ensureLive();
		const res = await ready.connection.setConfigOption(this.id, configId, value);
		this.emit(this.view.setConfigOptions(res.configOptions));
		return this.view.state.configOptions;
	}

	/**
	 * Bring the session's options to a chat's own values (a resume or load starts from the agent's defaults, and a
	 * new session from the profile's). Values the agent doesn't offer are skipped. The permission option is never
	 * left looser than wanted: when its value can't be set, the strictest value offered is set instead.
	 * `permissionHeld` says whether that worked (when false, the session may do more without asking than wanted).
	 */
	async applySettings(wanted: Readonly<Record<string, string>>): Promise<SettingsResult> {
		const profile = this.harness.profile;
		const result: SettingsResult = { applied: [], failed: [], permissionHeld: true };
		const set = async (id: string, value: string): Promise<boolean> => {
			try {
				await this.setOption(id, value);
				result.applied.push({ id, value });
				return true;
			} catch (e) {
				result.failed.push({ id, value, error: errorMessage(e) });
				return false;
			}
		};
		await this.ensureLive();
		for (const [id, value] of Object.entries(wanted)) {
			const current = optionValues(this.view.state.configOptions);
			// Earlier changes can add or remove options (a model without effort): read them again each time.
			if (current[id] !== undefined && current[id] !== value && offers(this.view.state.configOptions, id, value)) {
				await set(id, value);
			}
		}
		const permission = profile.permissionOption?.configId;
		const want = permission ? wanted[permission] : undefined;
		const now = () => (permission ? optionValues(this.view.state.configOptions)[permission] : undefined);
		if (permission && want !== undefined && now() !== undefined && now() !== want) {
			// A value the agent doesn't offer (anymore) can't be compared: only the strictest one is safe.
			const unknown = !offers(this.view.state.configOptions, permission, want);
			if (unknown || isLooser(profile, now()!, want)) {
				const strictest = strictestOffered(this.view.state.configOptions, profile);
				if (strictest && strictest !== now()) {
					await set(permission, strictest);
				}
				result.fellBackTo = now();
				result.permissionHeld = unknown ? now() === strictest : !isLooser(profile, now()!, want);
			}
		}
		return result;
	}

	/** Stop the running turn: open permission prompts are answered `cancelled`, then `session/cancel`. */
	async cancel(): Promise<void> {
		this.harness.broker.cancelSession(this.id);
		const running = this.harness.supervisor.running;
		if (running && running.generation === this.generation) {
			await running.connection.cancel(this.id);
		}
	}

	async close(): Promise<void> {
		this.harness.forget(this);
		const running = this.harness.supervisor.running;
		if (running && running.generation === this.generation && running.init.agentCapabilities?.sessionCapabilities?.close) {
			await running.connection.closeSession(this.id).catch(() => undefined);
		}
	}
}

export class HarnessClient {
	private readonly sessions = new Map<string, AcpSession>();
	private readonly disposers: (() => void)[] = [];

	constructor(
		readonly profile: HarnessProfile,
		readonly supervisor: AgentSupervisor,
		readonly cwd: string,
		readonly broker: PermissionBroker = new PermissionBroker(),
	) {
		supervisor.setPermissionHandler(req => this.broker.handle(req));
		this.disposers.push(supervisor.onUpdate(n => {
			const session = this.sessions.get(n.sessionId);
			if (session) {
				session.emit(session.view.apply(n.update));
			}
		}));
		// A dead adapter can't answer prompts: cancel them so nothing waits on a click that no longer matters.
		this.disposers.push(supervisor.onExit((_info, generation) => {
			for (const s of this.sessions.values()) {
				if (s.generation === generation) {
					this.broker.cancelSession(s.id);
				}
			}
		}));
	}

	/** @internal */
	meta(): { _meta?: Record<string, unknown> } {
		return this.profile.sessionMeta ? { _meta: { ...this.profile.sessionMeta } } : {};
	}

	/** @internal `session/new` plus the profile's defaults. Throws on auth required (see isAuthRequired). */
	async createRaw(ready: Ready): Promise<acp.NewSessionResponse> {
		const res = await ready.connection.newSession({ cwd: this.cwd, mcpServers: [], ...this.meta() });
		let options = res.configOptions;
		for (const { id, value } of pendingDefaults(options, this.profile)) {
			try {
				options = (await ready.connection.setConfigOption(res.sessionId, id, value)).configOptions;
			} catch {
				// a default the agent refuses is not fatal
			}
		}
		return { ...res, configOptions: options };
	}

	/**
	 * A session from an earlier run (a chat reopened from history), not yet on any adapter. Nothing starts here:
	 * the first `ensureLive` (a prompt) resumes or loads it.
	 */
	restore(sessionId: string, configOptions?: readonly acp.SessionConfigOption[] | null): AcpSession {
		const existing = this.sessions.get(sessionId);
		if (existing) {
			return existing;
		}
		const session = new AcpSession(this, sessionId, 0, configOptions);
		this.sessions.set(sessionId, session);
		return session;
	}

	/** `session/load`: the session with its conversation replayed into the view. Needs `loadSession`. */
	async load(sessionId: string): Promise<AcpSession> {
		const ready = await this.supervisor.get();
		if (!ready.init.agentCapabilities?.loadSession) {
			throw new Error(`${this.profile.label} can't reopen earlier sessions (no loadSession capability)`);
		}
		const session = this.restore(sessionId);
		if (session.generation !== ready.generation) {
			await this.loadInto(session, ready);
		}
		return session;
	}

	/** @internal */
	async loadInto(session: AcpSession, ready: Ready): Promise<void> {
		this.sessions.set(session.id, session);
		session.replaying = true;
		try {
			const res = await ready.connection.loadSession({ sessionId: session.id, cwd: this.cwd, mcpServers: [], ...this.meta() });
			session.generation = ready.generation;
			session.emit(session.view.setConfigOptions(res.configOptions ?? session.view.state.configOptions));
		} finally {
			session.replaying = false;
		}
	}

	/** The agent's sessions for this workspace (`session/list`, all pages), newest first; empty if unsupported. */
	async list(maxPages = 10): Promise<acp.SessionInfo[]> {
		const ready = await this.supervisor.get();
		if (!ready.init.agentCapabilities?.sessionCapabilities?.list) {
			return [];
		}
		const out: acp.SessionInfo[] = [];
		let cursor: string | null | undefined;
		for (let page = 0; page < maxPages; page++) {
			const res = await ready.connection.listSessions({ cwd: this.cwd, ...(cursor ? { cursor } : {}) });
			out.push(...res.sessions);
			cursor = res.nextCursor;
			if (!cursor) {
				break;
			}
		}
		return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
	}

	async newSession(): Promise<AcpSession> {
		const ready = await this.supervisor.get();
		const res = await this.createRaw(ready);
		const session = new AcpSession(this, res.sessionId, ready.generation, res.configOptions);
		this.sessions.set(session.id, session);
		return session;
	}

	/** @internal */
	rekey(session: AcpSession, oldId: string, newId: string): void {
		this.sessions.delete(oldId);
		this.sessions.set(newId, session);
	}

	/** @internal */
	forget(session: AcpSession): void {
		this.sessions.delete(session.id);
	}

	get(sessionId: string): AcpSession | undefined {
		return this.sessions.get(sessionId);
	}

	async dispose(): Promise<void> {
		for (const d of this.disposers) {
			d();
		}
		await this.supervisor.dispose();
	}
}
