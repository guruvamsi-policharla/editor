/**
 * One adapter process per harness, started on demand and restarted after a crash with backoff.
 *
 * The adapter is started by the first `get()` (lazy), not at load. If it exits unexpectedly the status becomes
 * `exited`, and the next `get()` starts a new process, after a delay that grows with consecutive crashes
 * (1 s, 5 s, 30 s by default). After `maxCrashes` in a row it stops trying until `restart()`. A process that
 * stayed up for `stableMs` resets the count.
 */
import type * as acp from '@agentclientprotocol/sdk';
import { AgentConnection, type ClientInfo, type ExitInfo, type PermissionHandler } from './connection.js';
import type { AgentLaunch } from './profiles.js';

export type AgentStatus =
	| { state: 'stopped' }
	| { state: 'starting'; message?: string }
	| { state: 'ready'; agentInfo?: acp.Implementation | null }
	| { state: 'exited'; code: number | null; signal: string | null; stderr: string; crashes: number }
	| { state: 'failed'; message: string; stderr: string; crashes: number };

export interface Ready {
	connection: AgentConnection;
	init: acp.InitializeResponse;
	/** Increments with every process started; sessions from an older generation must be resumed. */
	generation: number;
}

export interface SupervisorOptions {
	/** Resolves the launch command (and may install the adapter first). */
	launch: (progress: (message: string) => void) => Promise<AgentLaunch>;
	clientInfo?: ClientInfo;
	backoffMs?: readonly number[];
	stableMs?: number;
	maxCrashes?: number;
	initializeTimeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export class AgentSupervisor {
	private current: Ready | undefined;
	private starting: Promise<Ready> | undefined;
	private generation = 0;
	private crashes = 0;
	private lastExitAt = 0;
	private startedAt = 0;
	private disposed = false;
	private _status: AgentStatus = { state: 'stopped' };
	private readonly statusListeners = new Set<(s: AgentStatus) => void>();
	private readonly updateListeners = new Set<(n: acp.SessionNotification) => void>();
	private readonly exitListeners = new Set<(e: ExitInfo, generation: number) => void>();
	private permissionHandler: PermissionHandler = async () => ({ outcome: { outcome: 'cancelled' } });

	private readonly backoff: readonly number[];
	private readonly stableMs: number;
	private readonly maxCrashes: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly now: () => number;

	constructor(private readonly options: SupervisorOptions) {
		this.backoff = options.backoffMs ?? [1000, 5000, 30_000];
		this.stableMs = options.stableMs ?? 60_000;
		this.maxCrashes = options.maxCrashes ?? 5;
		this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
		this.now = options.now ?? Date.now;
	}

	get status(): AgentStatus {
		return this._status;
	}

	/** The running process, if any (no start). */
	get running(): Ready | undefined {
		return this.current?.connection.alive ? this.current : undefined;
	}

	onStatus(listener: (s: AgentStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	onUpdate(listener: (n: acp.SessionNotification) => void): () => void {
		this.updateListeners.add(listener);
		return () => this.updateListeners.delete(listener);
	}

	/** Every adapter exit, expected or not, with the generation that ended. */
	onExit(listener: (e: ExitInfo, generation: number) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	setPermissionHandler(handler: PermissionHandler): void {
		this.permissionHandler = handler;
	}

	private setStatus(s: AgentStatus): void {
		this._status = s;
		for (const listener of [...this.statusListeners]) {
			listener(s);
		}
	}

	/** The running adapter, starting it if needed. */
	get(): Promise<Ready> {
		if (this.disposed) {
			return Promise.reject(new Error('disposed'));
		}
		if (this.current?.connection.alive) {
			return Promise.resolve(this.current);
		}
		this.starting ??= this.awaitExit().then(() => this.start()).finally(() => { this.starting = undefined; });
		return this.starting;
	}

	/** A process whose stream closed is dying: wait for its exit (recorded as a crash) before starting another. */
	private async awaitExit(): Promise<void> {
		const dying = this.current?.connection;
		if (dying && !dying.alive) {
			await Promise.race([dying.exited, new Promise(resolve => setTimeout(resolve, 3000))]);
			if (this.current?.connection === dying) {
				await dying.dispose();
			}
		}
	}

	private async start(): Promise<Ready> {
		if (this.crashes >= this.maxCrashes) {
			throw new Error(`the agent stopped ${this.crashes} times in a row; restart it to try again`);
		}
		if (this.crashes > 0) {
			const delay = this.backoff[Math.min(this.crashes - 1, this.backoff.length - 1)]! - (this.now() - this.lastExitAt);
			if (delay > 0) {
				this.setStatus({ state: 'starting', message: `Restarting in ${Math.ceil(delay / 1000)} s…` });
				await this.sleep(delay);
			}
		}
		this.setStatus({ state: 'starting' });
		let launch: Awaited<ReturnType<SupervisorOptions['launch']>>;
		try {
			launch = await this.options.launch(message => this.setStatus({ state: 'starting', message }));
		} catch (e) {
			// Nothing ran (the harness isn't installed, say): not a crash, and the error goes up as it is, so the chat
			// can tell what's missing.
			this.setStatus({ state: 'failed', message: e instanceof Error ? e.message : String(e), stderr: '', crashes: this.crashes });
			throw e;
		}
		let connection: AgentConnection | undefined;
		try {
			if (this.disposed) {
				throw new Error('disposed');
			}
			connection = new AgentConnection(launch, { keepUpdates: false, clientInfo: this.options.clientInfo });
			const generation = ++this.generation;
			const conn = connection;
			conn.setPermissionHandler(req => this.permissionHandler(req));
			conn.onUpdate(n => {
				for (const listener of [...this.updateListeners]) {
					listener(n);
				}
			});
			conn.onExit(info => this.onExited(conn, generation, info));
			this.startedAt = this.now();
			const init = await withTimeout(conn.initialize(), this.options.initializeTimeoutMs ?? 60_000, 'the agent did not answer initialize');
			const ready = { connection: conn, init, generation };
			this.current = ready;
			this.setStatus({ state: 'ready', agentInfo: init.agentInfo });
			return ready;
		} catch (e) {
			const stderr = connection?.stderr ?? '';
			void connection?.dispose();
			this.crashes++;
			this.lastExitAt = this.now();
			const message = e instanceof Error ? e.message : String(e);
			this.setStatus({ state: 'failed', message, stderr: tail(stderr), crashes: this.crashes });
			throw new Error(stderr.trim() ? `${message}\n${tail(stderr, 1500)}` : message);
		}
	}

	private onExited(conn: AgentConnection, generation: number, info: ExitInfo): void {
		for (const listener of [...this.exitListeners]) {
			listener(info, generation);
		}
		if (this.current?.connection !== conn) {
			return; // still starting (start() reports it) or already replaced
		}
		this.current = undefined;
		if (info.expected || this.disposed) {
			this.setStatus({ state: 'stopped' });
			return;
		}
		this.crashes = this.now() - this.startedAt >= this.stableMs ? 1 : this.crashes + 1;
		this.lastExitAt = this.now();
		this.setStatus({ state: 'exited', code: info.code, signal: info.signal, stderr: tail(conn.stderr), crashes: this.crashes });
	}

	/** Stop the adapter and forget past crashes; the next `get()` starts a fresh process. */
	async restart(): Promise<void> {
		const current = this.current;
		this.current = undefined;
		this.crashes = 0;
		await current?.connection.dispose();
		this.setStatus({ state: 'stopped' });
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.current?.connection.dispose();
		this.current = undefined;
	}
}

function tail(text: string, max = 4000): string {
	return text.length > max ? text.slice(-max) : text;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		p.finally(() => clearTimeout(timer)),
		new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
	]);
}
