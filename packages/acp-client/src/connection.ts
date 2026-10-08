import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

/**
 * The client capabilities we advertise. Deliberately no `fs` and no `terminal`: the harness reads, writes
 * and runs commands with its own tools, and the review engine sees its edits on disk like any other agent's.
 */
export const CLIENT_CAPABILITIES: acp.ClientCapabilities = Object.freeze({});

/** Agent → client methods we never serve. Receiving one is a contract violation. */
export function isForbiddenClientMethod(method: string): boolean {
	return method.startsWith('fs/') || method.startsWith('terminal/');
}

export interface AgentLaunch {
	command: string;
	args?: readonly string[];
	/** Merged over the parent environment. */
	env?: Record<string, string | undefined>;
	cwd?: string;
}

export type PermissionHandler = (request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;

/** One message seen on the wire, recorded for tests and traces. Params aren't kept (they can hold secrets). */
export interface WireRecord {
	direction: 'in' | 'out';
	method?: string;
	id?: string | number | null;
}

/**
 * One adapter process and its ACP connection. Every agent → client message is recorded from the raw byte
 * stream, so "the agent never called fs/terminal" doesn't depend on how the SDK routes unknown methods.
 */
export class AgentConnection {
	readonly wire: WireRecord[] = [];
	readonly updates: acp.SessionNotification[] = [];
	readonly permissionRequests: acp.RequestPermissionRequest[] = [];
	stderr = '';

	private readonly child: ChildProcess;
	private readonly connection: acp.ClientConnection;
	private readonly updateListeners = new Set<(n: acp.SessionNotification) => void>();
	private permissionHandler: PermissionHandler = async () => ({ outcome: { outcome: 'cancelled' } });
	private exited = false;

	constructor(launch: AgentLaunch) {
		this.child = spawn(launch.command, [...(launch.args ?? [])], {
			cwd: launch.cwd,
			env: { ...process.env, ...launch.env },
			stdio: ['pipe', 'pipe', 'pipe'],
			// Own process group, so dispose() also ends the harness the adapter starts (Claude Code, codex app-server).
			detached: process.platform !== 'win32',
		});
		this.child.on('exit', () => { this.exited = true; });
		this.child.stderr!.setEncoding('utf8');
		this.child.stderr!.on('data', (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-64_000);
		});

		const input = Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>;
		const output = Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>;
		const stream = acp.ndJsonStream(tap(output, 'out', this.wire), input.pipeThrough(tapTransform('in', this.wire)));

		this.connection = acp.client({ name: 'editor' })
			.onRequest(acp.methods.client.session.requestPermission, async ctx => {
				this.permissionRequests.push(ctx.params);
				return this.permissionHandler(ctx.params);
			})
			.onNotification(acp.methods.client.session.update, async ctx => {
				this.updates.push(ctx.params);
				for (const listener of this.updateListeners) {
					listener(ctx.params);
				}
			})
			.connect(stream);
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	/** Methods the agent sent us that we must never receive. */
	forbiddenInbound(): string[] {
		return this.wire.filter(r => r.direction === 'in' && r.method && isForbiddenClientMethod(r.method)).map(r => r.method!);
	}

	setPermissionHandler(handler: PermissionHandler): void {
		this.permissionHandler = handler;
	}

	onUpdate(listener: (n: acp.SessionNotification) => void): () => void {
		this.updateListeners.add(listener);
		return () => this.updateListeners.delete(listener);
	}

	initialize(): Promise<acp.InitializeResponse> {
		return this.connection.agent.request(acp.methods.agent.initialize, {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientInfo: { name: 'editor', title: 'Editor', version: '0.0.1' },
			clientCapabilities: CLIENT_CAPABILITIES,
		});
	}

	newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		return this.connection.agent.request(acp.methods.agent.session.new, params);
	}

	prompt(sessionId: string, text: string): Promise<acp.PromptResponse> {
		return this.connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
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
		const pid = this.child.pid;
		if (pid === undefined || this.exited) {
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

function record(wire: WireRecord[], direction: 'in' | 'out', line: string): void {
	if (!line.trim()) {
		return;
	}
	try {
		const msg = JSON.parse(line) as { method?: string; id?: string | number | null };
		wire.push({ direction, method: msg.method, id: msg.id });
	} catch {
		wire.push({ direction, method: '<unparsable>' });
	}
}

function tapTransform(direction: 'in' | 'out', wire: WireRecord[]): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	let buffer = '';
	return new TransformStream({
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				record(wire, direction, buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
			}
			controller.enqueue(chunk);
		},
	});
}

function tap(output: WritableStream<Uint8Array>, direction: 'in' | 'out', wire: WireRecord[]): WritableStream<Uint8Array> {
	const t = tapTransform(direction, wire);
	void t.readable.pipeTo(output).catch(() => undefined);
	return t.writable;
}
