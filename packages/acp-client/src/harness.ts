/**
 * Sessions on one harness: `session/new` with the profile's meta and defaults, prompt/cancel/config, updates
 * routed through the reducer, permission requests through the broker, and recovery after an adapter crash
 * (`session/resume` when the agent supports it, else a fresh session).
 */
import * as acp from '@agentclientprotocol/sdk';
import { pendingDefaults } from './config.js';
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

export type Recovery = 'live' | 'resumed' | 'new';

export class AcpSession {
	readonly view = new SessionView();
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

	/** Make sure the session lives on the running adapter. After a crash: resume it, or start a new one. */
	async ensureLive(): Promise<{ ready: Ready; recovery: Recovery }> {
		const ready = await this.harness.supervisor.get();
		if (ready.generation === this.generation) {
			return { ready, recovery: 'live' };
		}
		const oldId = this.id;
		if (ready.init.agentCapabilities?.sessionCapabilities?.resume) {
			try {
				const res = await ready.connection.resumeSession({ sessionId: oldId, cwd: this.harness.cwd, mcpServers: [], ...this.harness.meta() });
				this.generation = ready.generation;
				this.emit(this.view.setConfigOptions(res.configOptions ?? this.view.state.configOptions));
				return { ready, recovery: 'resumed' };
			} catch {
				// fall through to a new session
			}
		}
		const res = await this.harness.createRaw(ready);
		this.harness.rekey(this, oldId, res.sessionId);
		this.id = res.sessionId;
		this.generation = ready.generation;
		this.emit(this.view.setConfigOptions(res.configOptions));
		return { ready, recovery: 'new' };
	}

	async prompt(prompt: string | acp.ContentBlock[]): Promise<acp.PromptResponse> {
		const { ready } = await this.ensureLive();
		return ready.connection.prompt(this.id, prompt);
	}

	/** Set a config option; the response (the complete list) replaces the view's options. */
	async setOption(configId: string, value: string): Promise<acp.SessionConfigOption[]> {
		const { ready } = await this.ensureLive();
		const res = await ready.connection.setConfigOption(this.id, configId, value);
		this.emit(this.view.setConfigOptions(res.configOptions));
		return this.view.state.configOptions;
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
