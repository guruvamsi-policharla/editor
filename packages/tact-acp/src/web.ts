/**
 * tact's local web API (tact `docs/web.md`, protocol 9): commands and queries over POST, state over one SSE
 * stream that follows the instance's active session. Authenticated with the machine token as the `tact` cookie;
 * every POST carries `X-Tact: 1`.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type WireEntry = { id: number; revision: number; parent: number | null } & (
	| { kind: 'user'; text: string }
	| { kind: 'assistant'; text: string; complete: boolean; commentary?: boolean }
	| { kind: 'reasoning'; text: string }
	| { kind: 'tool'; name: string; summary: string; state: 'running' | 'succeeded' | 'failed'; has_detail?: boolean }
	| { kind: 'interrupted'; count: number }
	| { kind: 'turn_completed'; duration_ns: number }
	| { kind: 'error'; message: string }
	| { kind: string; [key: string]: unknown });

export interface SessionSnapshot {
	session: string;
	title: string;
	model: string;
	workspace: string;
	effort: Effort;
	reasoning_mode: 'standard' | 'pro';
	speed: string;
	entries: WireEntry[];
	running: boolean;
	draft: { rev: number; text: string };
	context: { active_tokens: number; window_tokens: number } | null;
}

export interface ModelCatalog {
	models: { id: string; label: string; provider: string; reasoning_modes: string[]; effective_speeds: string[]; effort_fixed_after_start: boolean }[];
	efforts: Effort[];
	speeds: string[];
}

export interface StreamEvent {
	event: string;
	data: unknown;
}

export class TactApiError extends Error {
	constructor(readonly status: number, readonly code: string, message: string, readonly request?: string) {
		super(message);
	}

	/** tact's message with what was asked and how it answered: `unknown session (set_draft: HTTP 404 unknown_session)`. */
	describe(): string {
		return `${this.message} (${this.request ? `${this.request}: ` : ''}HTTP ${this.status}${this.code && this.code !== 'failed' ? ` ${this.code}` : ''})`;
	}
}

export class TactWeb {
	private readonly base: string;
	private readonly client = Math.floor(Math.random() * 1e9);
	private readonly abort = new AbortController();

	constructor(port: number, private readonly token: string, host = '127.0.0.1') {
		this.base = `http://${host}:${port}`;
	}

	get url(): string {
		return this.base;
	}

	private headers(post: boolean): Record<string, string> {
		return { cookie: `tact=${this.token}`, ...(post ? { 'x-tact': '1', 'content-type': 'application/json' } : {}) };
	}

	/** `request`: the command or query, for errors. A refusal is a `TactApiError` with tact's code and message. */
	private async post<T>(path: string, body: unknown, request: string): Promise<T> {
		const res = await fetch(`${this.base}${path}`, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body), signal: this.abort.signal });
		const text = await res.text();
		let json: unknown = {};
		try {
			json = text ? JSON.parse(text) : {};
		} catch {
			// not JSON (a proxy's page, a crash): its text is the message
			json = { message: text.trim().slice(0, 500) || undefined };
			if (res.ok) {
				throw new TactApiError(res.status, 'invalid_response', `tact's answer isn't JSON: ${text.trim().slice(0, 200)}`, request);
			}
		}
		if (!res.ok) {
			const err = json as { code?: string; message?: string; error?: string };
			throw new TactApiError(res.status, err.code ?? 'failed', err.message ?? err.error ?? `HTTP ${res.status}`, request);
		}
		return json as T;
	}

	command<T = Record<string, never>>(cmd: string, args?: Record<string, unknown>): Promise<T> {
		return this.post<T>('/api/cmd', { client: this.client, cmd, ...(args ? { args } : {}) }, cmd);
	}

	/** Queries without arguments (`models`) are unit variants: no `args` at all. */
	query<T>(query: string, args?: Record<string, unknown>): Promise<T> {
		return this.post<T>('/api/query', { query, ...(args ? { args } : {}) }, query);
	}

	async instance(): Promise<{ protocol_version: number; workspace: string }> {
		const res = await fetch(`${this.base}/api/instance`, { headers: this.headers(false), signal: this.abort.signal });
		if (!res.ok) {
			throw new TactApiError(res.status, 'failed', `HTTP ${res.status}`);
		}
		return await res.json() as { protocol_version: number; workspace: string };
	}

	/** The SSE stream: calls `onEvent` for each event until `close()` (or the server goes away: `onEnd`). */
	async stream(onEvent: (e: StreamEvent) => void, onEnd: (error?: unknown) => void): Promise<void> {
		try {
			const res = await fetch(`${this.base}/api/stream`, { headers: { ...this.headers(false), accept: 'text/event-stream' }, signal: this.abort.signal });
			if (!res.ok || !res.body) {
				throw new TactApiError(res.status, 'failed', `stream: HTTP ${res.status}`);
			}
			const decoder = new TextDecoder();
			let buffer = '';
			for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
				buffer += decoder.decode(chunk, { stream: true });
				let end: number;
				while ((end = buffer.indexOf('\n\n')) >= 0) {
					const block = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const parsed = parseEvent(block);
					if (parsed) {
						onEvent(parsed);
					}
				}
			}
			onEnd();
		} catch (e) {
			onEnd(this.abort.signal.aborted ? undefined : e);
		}
	}

	close(): void {
		this.abort.abort();
	}
}

export function parseEvent(block: string): StreamEvent | undefined {
	let event = 'message';
	const data: string[] = [];
	for (const line of block.split('\n')) {
		if (line.startsWith(':')) {
			continue;
		}
		if (line.startsWith('event:')) {
			event = line.slice(6).trim();
		} else if (line.startsWith('data:')) {
			data.push(line.slice(5).replace(/^ /, ''));
		}
	}
	if (!data.length) {
		return undefined;
	}
	try {
		return { event, data: JSON.parse(data.join('\n')) };
	} catch {
		return undefined;
	}
}
