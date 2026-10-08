import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { AgentLaunch } from './profiles.js';

/**
 * The client capabilities we advertise. Deliberately no `fs` and no `terminal`: the harness reads, writes
 * and runs commands with its own tools, and the review engine sees its edits on disk like any other agent's.
 * (No `_meta.terminal_output` either: Claude's adapter would then send `terminal` content pointing at a
 * client terminal we don't have. Without it, command output arrives as ordinary text content.)
 */
export const CLIENT_CAPABILITIES: acp.ClientCapabilities = Object.freeze({});

/** Agent → client methods we never serve. Receiving one is a contract violation. */
export function isForbiddenClientMethod(method: string): boolean {
	return method.startsWith('fs/') || method.startsWith('terminal/');
}

export type PermissionHandler = (request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;

/** One message seen on the wire, recorded for tests and traces. Params aren't kept (they can hold secrets). */
export interface WireRecord {
	direction: 'in' | 'out';
	method?: string;
	id?: string | number | null;
}

export interface ExitInfo {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** True when we ended it (dispose). */
	expected: boolean;
}

export interface ClientInfo {
	name: string;
	title?: string;
	version: string;
}

/** The most wire records kept (oldest dropped). The forbidden-method list is kept separately, in full. */
const WIRE_LIMIT = 5000;

/**
 * One adapter process and its ACP connection. Every agent → client message is recorded from the raw byte
 * stream, so "the agent never called fs/terminal" doesn't depend on how the SDK routes unknown methods.
 */
export class AgentConnection {
	readonly wire: WireRecord[] = [];
	readonly updates: acp.SessionNotification[] = [];
	readonly permissionRequests: acp.RequestPermissionRequest[] = [];
	stderr = '';
	exitInfo: ExitInfo | undefined;

	private readonly child: ChildProcess;
	private readonly connection: acp.ClientConnection;
	private readonly forbidden: string[] = [];
	private readonly updateListeners = new Set<(n: acp.SessionNotification) => void>();
	private readonly exitListeners = new Set<(e: ExitInfo) => void>();
	private permissionHandler: PermissionHandler = async () => ({ outcome: { outcome: 'cancelled' } });
	private disposing = false;
	/** Keep every update (tests, contract traces). Off in the editor, where updates are consumed as they come. */
	private readonly keepUpdates: boolean;
	private readonly clientInfo: ClientInfo;

	constructor(launch: AgentLaunch, options: { keepUpdates?: boolean; clientInfo?: ClientInfo } = {}) {
		this.keepUpdates = options.keepUpdates ?? true;
		this.clientInfo = options.clientInfo ?? { name: 'editor', title: 'Editor', version: '0.0.1' };
		this.child = spawn(launch.command, [...(launch.args ?? [])], {
			cwd: launch.cwd,
			env: { ...process.env, ...launch.env },
			stdio: ['pipe', 'pipe', 'pipe'],
			// Own process group, so dispose() also ends the harness the adapter starts (Claude Code, codex app-server).
			detached: process.platform !== 'win32',
		});
		this.child.stderr!.setEncoding('utf8');
		this.child.stderr!.on('data', (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-64_000);
		});
		// A failed spawn (ENOENT, EACCES) reports through 'error' and may never 'exit'.
		this.child.on('error', err => {
			this.stderr += `\n${err.message}`;
			this.onExited({ code: null, signal: null, expected: false });
		});
		this.child.on('exit', (code, signal) => this.onExited({ code, signal, expected: this.disposing }));

		const record = (direction: 'in' | 'out', msg: WireRecord) => {
			if (direction === 'in' && msg.method && isForbiddenClientMethod(msg.method)) {
				this.forbidden.push(msg.method);
			}
			this.wire.push(msg);
			if (this.wire.length > WIRE_LIMIT) {
				this.wire.splice(0, this.wire.length - WIRE_LIMIT);
			}
		};
		const input = Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>;
		const output = Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>;
		const stream = acp.ndJsonStream(tap(output, 'out', record), input.pipeThrough(tapTransform('in', record)));

		// Unknown notifications (the adapters' `_auth/status_update` and the like) are ignored by the SDK.
		this.connection = acp.client({ name: this.clientInfo.name })
			.onRequest(acp.methods.client.session.requestPermission, async ctx => {
				if (this.keepUpdates) {
					this.permissionRequests.push(ctx.params);
				}
				return this.permissionHandler(ctx.params);
			})
			.onNotification(acp.methods.client.session.update, async ctx => {
				if (this.keepUpdates) {
					this.updates.push(ctx.params);
				}
				for (const listener of [...this.updateListeners]) {
					try {
						listener(ctx.params);
					} catch {
						// a listener's bug must not break the connection
					}
				}
			})
			.connect(stream);
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	/** False once the process exited or its stream closed (the 'exit' event can come a little later). */
	get alive(): boolean {
		return this.exitInfo === undefined && !this.connection.signal.aborted;
	}

	/** Resolves when the process has exited. */
	readonly exited: Promise<ExitInfo> = new Promise(resolve => this.exitListeners.add(resolve));

	private onExited(info: ExitInfo): void {
		if (this.exitInfo) {
			return;
		}
		this.exitInfo = info;
		// Pending requests (a running prompt) reject instead of hanging.
		this.connection.close(new Error(`agent exited (${info.signal ?? `code ${info.code}`})`));
		for (const listener of [...this.exitListeners]) {
			listener(info);
		}
	}

	/** Methods the agent sent us that we must never receive. */
	forbiddenInbound(): string[] {
		return [...this.forbidden];
	}

	setPermissionHandler(handler: PermissionHandler): void {
		this.permissionHandler = handler;
	}

	onUpdate(listener: (n: acp.SessionNotification) => void): () => void {
		this.updateListeners.add(listener);
		return () => this.updateListeners.delete(listener);
	}

	onExit(listener: (e: ExitInfo) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	initialize(): Promise<acp.InitializeResponse> {
		return this.connection.agent.request(acp.methods.agent.initialize, {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientInfo: this.clientInfo,
			clientCapabilities: CLIENT_CAPABILITIES,
		});
	}

	newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		return this.connection.agent.request(acp.methods.agent.session.new, params);
	}

	resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
		return this.connection.agent.request(acp.methods.agent.session.resume, params);
	}

	/** `session/load`: the agent replays the conversation as `session/update`s before it answers. */
	loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
		return this.connection.agent.request(acp.methods.agent.session.load, params);
	}

	listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
		return this.connection.agent.request(acp.methods.agent.session.list, params);
	}

	closeSession(sessionId: string): Promise<acp.CloseSessionResponse> {
		return this.connection.agent.request(acp.methods.agent.session.close, { sessionId });
	}

	/** A prompt: plain text, or content blocks (text plus `resource_link`s). */
	prompt(sessionId: string, prompt: string | acp.ContentBlock[]): Promise<acp.PromptResponse> {
		const blocks: acp.ContentBlock[] = typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt;
		return this.connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: blocks });
	}

	setConfigOption(sessionId: string, configId: string, value: string): Promise<acp.SetSessionConfigOptionResponse> {
		return this.connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value });
	}

	cancel(sessionId: string): Promise<void> {
		return this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
	}

	/** Resolves with the first update that matches, or rejects after `timeoutMs`. */
	waitForUpdate(predicate: (n: acp.SessionNotification) => boolean, timeoutMs: number): Promise<acp.SessionNotification> {
		const seen = this.updates.find(predicate);
		if (seen) {
			return Promise.resolve(seen);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { off(); reject(new Error(`no matching session/update within ${timeoutMs} ms`)); }, timeoutMs);
			const off = this.onUpdate(n => {
				if (predicate(n)) {
					clearTimeout(timer);
					off();
					resolve(n);
				}
			});
		});
	}

	/** Kills the adapter's whole process group (SIGTERM, then SIGKILL). */
	async dispose(): Promise<void> {
		this.disposing = true;
		const pid = this.child.pid;
		if (pid === undefined || this.exitInfo) {
			return;
		}
		const signal = (sig: NodeJS.Signals) => {
			try {
				process.kill(process.platform === 'win32' ? pid : -pid, sig);
			} catch {
				// already gone
			}
		};
		signal('SIGTERM');
		const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()));
		const timeout = new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 3000));
		if (await Promise.race([exited, timeout]) === 'timeout') {
			signal('SIGKILL');
		}
	}
}

function parse(line: string): WireRecord | undefined {
	if (!line.trim()) {
		return undefined;
	}
	try {
		const msg = JSON.parse(line) as { method?: string; id?: string | number | null };
		return { direction: 'in', method: msg.method, id: msg.id };
	} catch {
		return { direction: 'in', method: '<unparsable>' };
	}
}

function tapTransform(direction: 'in' | 'out', record: (direction: 'in' | 'out', msg: WireRecord) => void): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	let buffer = '';
	return new TransformStream({
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const msg = parse(buffer.slice(0, nl));
				if (msg) {
					record(direction, { ...msg, direction });
				}
				buffer = buffer.slice(nl + 1);
			}
			controller.enqueue(chunk);
		},
	});
}

function tap(output: WritableStream<Uint8Array>, direction: 'in' | 'out', record: (direction: 'in' | 'out', msg: WireRecord) => void): WritableStream<Uint8Array> {
	const t = tapTransform(direction, record);
	void t.readable.pipeTo(output).catch(() => undefined);
	return t.writable;
}
