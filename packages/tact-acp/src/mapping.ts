/**
 * tact transcript entries → ACP session updates, and tact settings → ACP config options. Pure.
 *
 * tact re-sends an entry whole on every revision (no token deltas), so text entries are diffed against what was
 * already sent. Tool entries become tool calls; tact never asks for permission (Nanocodex runs with approval
 * "never" and full access), so there is no permission mapping.
 */
import { isAbsolute, join } from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import type { Effort, ModelCatalog, SessionSnapshot, WireEntry } from './web.js';

const TOOL_KIND: Record<string, acp.ToolKind> = {
	apply_patch: 'edit',
	exec_command: 'execute',
	write_stdin: 'execute',
	shell: 'execute',
	read_file: 'read',
	view_image: 'read',
	grep: 'search',
	search: 'search',
	web_search: 'fetch',
	web__run: 'fetch',
	fetch: 'fetch',
};

const TOOL_STATUS: Record<string, acp.ToolCallStatus> = { running: 'in_progress', succeeded: 'completed', failed: 'failed' };

export type TurnEnd = { kind: 'completed' } | { kind: 'interrupted' } | { kind: 'error'; message: string };

export class EntryMapper {
	/** entry id → what was sent: text so far, or the tool's last state/title */
	private readonly sent = new Map<number, { text?: string; state?: string; title?: string }>();

	/** Entries before this id belong to earlier turns (set at each prompt). */
	baseline = -1;

	/** `cwd`: the workspace, to make the paths of edits absolute (ACP locations are absolute paths). */
	constructor(private readonly cwd?: string) { }

	/** The highest entry id seen. */
	get lastId(): number {
		return Math.max(-1, ...this.sent.keys());
	}

	/**
	 * The updates for one entry upsert. `replay` (session/load) also sends the user's messages, which a live turn
	 * doesn't echo.
	 */
	map(entry: WireEntry, replay = false): acp.SessionUpdate[] {
		const prev = this.sent.get(entry.id);
		switch (entry.kind) {
			case 'user': {
				this.sent.set(entry.id, { text: String(entry.text) });
				return replay && !prev ? [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: String(entry.text) }, messageId: `u${entry.id}` }] : [];
			}
			case 'assistant':
			case 'reasoning': {
				const text = String(entry.text ?? '');
				const before = prev?.text ?? '';
				const delta = text.startsWith(before) ? text.slice(before.length) : text;
				this.sent.set(entry.id, { text });
				if (!delta) {
					return [];
				}
				const content: acp.ContentBlock = { type: 'text', text: delta };
				return [entry.kind === 'assistant'
					? { sessionUpdate: 'agent_message_chunk', content, messageId: `a${entry.id}` }
					: { sessionUpdate: 'agent_thought_chunk', content, messageId: `r${entry.id}` }];
			}
			case 'tool': {
				const name = String(entry.name);
				const kind = TOOL_KIND[name] ?? 'other';
				const summary = String(entry.summary || name);
				const stats = (entry as { stats?: { additions: number; deletions: number } | null }).stats;
				const title = kind === 'edit' ? `Edit ${summary}${stats ? ` (+${stats.additions} −${stats.deletions})` : ''}` : summary;
				const state = String(entry.state);
				if (prev && prev.state === state && prev.title === title) {
					return [];
				}
				this.sent.set(entry.id, { state, title });
				const status = TOOL_STATUS[state] ?? 'in_progress';
				const rawInput = kind === 'execute' ? { command: summary } : {};
				const paths = kind === 'edit' ? pathsIn(summary) : [];
				const locations = paths.length ? paths.map(path => ({ path: this.absolute(path) })) : undefined;
				// A finished command's last lines, until (or instead of) its detail.
				const tail = (entry as { outcome?: { tail?: string[] } | null }).outcome?.tail;
				const content: acp.ToolCallContent[] | undefined = tail?.length ? [{ type: 'content', content: { type: 'text', text: tail.join('\n') } }] : undefined;
				return [prev
					? { sessionUpdate: 'tool_call_update', toolCallId: `t${entry.id}`, title, status, ...(locations ? { locations } : {}), ...(content ? { content } : {}) }
					: { sessionUpdate: 'tool_call', toolCallId: `t${entry.id}`, title, kind, status, name, rawInput, ...(locations ? { locations } : {}), ...(content ? { content } : {}) }];
			}
			default:
				this.sent.set(entry.id, {});
				return [];
		}
	}

	absolute(path: string): string {
		return this.cwd && !isAbsolute(path) ? join(this.cwd, path) : path;
	}

	/** Whether this entry ends the current turn. */
	turnEnd(entry: WireEntry): TurnEnd | undefined {
		if (entry.id <= this.baseline) {
			return undefined;
		}
		switch (entry.kind) {
			case 'turn_completed':
				return { kind: 'completed' };
			case 'interrupted':
				return { kind: 'interrupted' };
			case 'error':
				return { kind: 'error', message: errorText(String(entry.message ?? 'tact reported an error')) };
			default:
				return undefined;
		}
	}
}

/**
 * Paths in a patch (`*** Update File: a.tex`, `*** Move to: b.tex`) or in tact's summary of an `apply_patch` call
 * (its files, comma-separated: `src/a.rs, b.rs`).
 */
export function pathsIn(text: string): string[] {
	const fromPatch = [...text.matchAll(/\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+)/g)].map(m => m[1]!.trim());
	if (fromPatch.length) {
		return [...new Set(fromPatch)];
	}
	const parts = text.split(', ').map(p => p.trim());
	return parts.every(p => /^[^\s,]+$/.test(p) && /[./]/.test(p)) ? parts : [];
}

/** A tool's detail (`GET /api/sessions/{id}/entries/{n}`) → ACP content and locations, best effort. */
export function toolDetail(detail: { arguments?: unknown; result?: unknown } | undefined): { content?: acp.ToolCallContent[]; locations?: acp.ToolCallLocation[]; rawInput?: unknown } {
	if (!detail) {
		return {};
	}
	const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
	const args = detail.arguments;
	const patch = strings(args).find(s => s.includes('*** Begin Patch'));
	const locations = patch ? pathsIn(patch).map(path => ({ path })) : undefined;
	const output = strings(detail.result).join('\n').trim();
	return {
		...(args && typeof args === 'object' ? { rawInput: args } : {}),
		...(output ? { content: [{ type: 'content', content: { type: 'text', text: output.length > 20_000 ? `${output.slice(0, 20_000)}\n…` : output } }] } : {}),
		...(locations?.length ? { locations } : {}),
	};
}

const EFFORT_NAMES: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

export interface TactSettings {
	model: string;
	effort: Effort;
	reasoning_mode: string;
	speed: string;
	/** The session has had a turn: the model and reasoning mode are fixed. */
	started: boolean;
}

export function settingsOf(s: SessionSnapshot): TactSettings {
	return { model: s.model, effort: s.effort, reasoning_mode: s.reasoning_mode, speed: s.speed, started: s.entries.length > 0 };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** tact's pickers as ACP config options, in tact's order: model, effort, reasoning mode (Pro), speed. Only those. */
export function configOptions(s: TactSettings, catalog: ModelCatalog | undefined): acp.SessionConfigOption[] {
	const models = catalog?.models ?? [];
	const model = models.find(m => m.id === s.model || s.model.endsWith(`-${m.id}`));
	const modelChoices = s.started
		? [{ value: s.model, name: model?.label ?? s.model, description: 'The model is fixed once the chat has started' }]
		: (models.length ? models.map(m => ({ value: m.id, name: m.label })) : [{ value: s.model, name: s.model }]);
	const current = s.started ? s.model : (model?.id ?? s.model);
	const options: acp.SessionConfigOption[] = [
		{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current, options: modelChoices.some(c => c.value === current) ? modelChoices : [...modelChoices, { value: current, name: current }] },
		{ id: 'effort', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: s.effort, options: (catalog?.efforts ?? [s.effort]).map(e => ({ value: e, name: EFFORT_NAMES[e] ?? e })) },
	];
	const modes = model?.reasoning_modes ?? [];
	if (modes.length > 1 && !s.started) {
		options.push({ id: 'reasoning_mode', name: 'Reasoning', category: '_reasoning_mode', type: 'select', currentValue: s.reasoning_mode, options: modes.map(m => ({ value: m, name: m === 'pro' ? 'Pro reasoning' : 'Standard reasoning' })) });
	}
	const speeds = catalog?.speeds ?? [];
	if (speeds.length > 1) {
		options.push({ id: 'speed', name: 'Speed', category: 'model_config', type: 'select', currentValue: s.speed, options: speeds.map(v => ({ value: v, name: v === 'standard' ? 'Standard speed' : cap(v) })) });
	}
	// No approvals picker: tact has no approval mode (Nanocodex runs every command and edit without asking).
	return options;
}

/** ACP config id → tact command and argument name. */
export const SET_COMMAND: Record<string, { cmd: string; arg: string }> = {
	model: { cmd: 'set_model', arg: 'model' },
	effort: { cmd: 'set_effort', arg: 'effort' },
	reasoning_mode: { cmd: 'set_reasoning_mode', arg: 'mode' },
	speed: { cmd: 'set_speed', arg: 'speed' },
};

/** The prompt's text for tact: text blocks as typed; resource links not already mentioned are added as `@path`. */
export function promptText(blocks: readonly acp.ContentBlock[]): string {
	const text = blocks.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n');
	const links = blocks.flatMap(b => (b.type === 'resource_link' && !text.includes(b.name) ? [`@${b.name}`] : []));
	return links.length ? `${text}\n\n${links.join(' ')}` : text;
}

/**
 * Whether tact's error says its credentials were refused: an expired or revoked ChatGPT login, or a wrong API key,
 * only show at the first request (tact checks only that some credential exists when it starts).
 */
export function isAuthError(message: string): boolean {
	return /\bHTTP 401\b|\b401 Unauthorized\b|invalid_api_key|Incorrect API key|token (?:has )?expired|refresh token|no ChatGPT credentials|run `?tact auth login`?/i.test(message);
}

/** tact's error without the raw response body it sometimes appends (`…rejected with HTTP 401: { "error": …`). */
export function errorText(message: string): string {
	return message.replace(/:\s*\{[\s\S]*$/, '').trim() || message;
}
