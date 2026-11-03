// What a turn looks like in the chat: reducer changes → render ops (markdown, thinking, tool cards, todos).
// Pure (no vscode import) so it's unit-tested against recorded adapter output; stream.ts turns ops into
// VS Code chat stream parts.
//
// Review truth stays with the file watcher: an edit card shows the file and the size of the change as
// information only, never an edit part (agent-review owns Keep/Undo).
import type { acp, Change, PermissionPrompt, ToolCallView } from '@editor/acp-client';

export interface TerminalData {
	command: string;
	output?: string;
	exitCode?: number;
}

export interface ToolCard {
	id: string;
	toolName: string;
	/** Markdown. `[](file:///…)` renders as a file pill. */
	invocation: string;
	past: string;
	complete: boolean;
	error: boolean;
	terminal?: TerminalData;
	/** Input/output shown in collapsible sections. */
	simple?: { input: string; output: string };
	/** Its permission prompt is open: it hasn't started (core can tell Skipped from stopped; see stream.ts). */
	awaitingApproval?: boolean;
}

export type TodoStatus = 'not-started' | 'in-progress' | 'completed';

export type RenderOp =
	| { op: 'markdown'; text: string }
	| { op: 'thinking'; id: string; text: string }
	| { op: 'thinkingDone'; id: string }
	| { op: 'tool'; card: ToolCard }
	| { op: 'todo'; items: { id: number; title: string; status: TodoStatus }[] }
	/** A notice about the turn (an error, a restart): shown as a warning, and kept with the turn. */
	| { op: 'warning'; text: string };

export function fileLink(path: string, line?: number | null): string {
	const uri = `file://${path.split('/').map(encodeURIComponent).join('/')}`;
	return `[](${uri}${line ? `#${line}` : ''})`;
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.trim() ? v : undefined;
}

function code(text: string): string {
	const fence = text.includes('`') ? '``' : '`';
	return `${fence}${text.replace(/\n/g, ' ')}${fence}`;
}

function contentTexts(call: ToolCallView): string[] {
	return call.content.flatMap(c => (c.type === 'content' && c.content.type === 'text' ? [c.content.text] : []));
}

/** Command output, without a ```console fence an adapter may wrap it in. */
function unfence(text: string): string {
	const m = /^```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(text.trim());
	return m ? m[1]! : text;
}

function diffStats(call: ToolCallView): { added: number; removed: number } | undefined {
	const diffs = call.content.filter((c): c is acp.ToolCallContent & { type: 'diff' } => c.type === 'diff');
	if (!diffs.length) {
		return undefined;
	}
	let added = 0;
	let removed = 0;
	for (const d of diffs) {
		const oldLines = d.oldText ? d.oldText.split('\n') : [];
		const newLines = d.newText.split('\n');
		// Lines common to both ends don't count (a cheap stand-in for a real diff; display only).
		let start = 0;
		while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
			start++;
		}
		let end = 0;
		while (end < oldLines.length - start && end < newLines.length - start && oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]) {
			end++;
		}
		removed += oldLines.length - start - end;
		added += newLines.length - start - end;
	}
	return { added, removed };
}

function paths(call: ToolCallView): string[] {
	const input = (call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}) as Record<string, unknown>;
	const fromDiffs = call.content.flatMap(c => (c.type === 'diff' ? [c.path] : []));
	return [...new Set([...call.locations.map(l => l.path), ...fromDiffs, ...['file_path', 'path', 'notebook_path'].map(k => str(input[k])).filter((p): p is string => !!p)])];
}

/** The card for a tool call in its current state. */
export function toolCard(call: ToolCallView): ToolCard {
	const input = (call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}) as Record<string, unknown>;
	const complete = call.status === 'completed' || call.status === 'failed';
	const error = call.status === 'failed';
	const base = { id: call.id, toolName: call.name ?? call.kind, complete, error };
	const files = paths(call);
	const line = call.locations[0]?.line;
	const output = [...contentTexts(call), ...(typeof call.rawOutput === 'string' && !contentTexts(call).length ? [call.rawOutput] : [])].join('\n');

	switch (call.kind) {
		case 'execute': {
			const command = str(input.command) ?? (Array.isArray(input.command) ? input.command.join(' ') : undefined)
				?? (call.title && call.title !== 'Terminal' ? call.title : undefined);
			const description = str(input.description);
			// The adapter puts the command's description in the content before the output arrives.
			const out = complete ? unfence(contentTexts(call).filter(t => t !== description).join('\n') || (typeof call.rawOutput === 'string' ? call.rawOutput : '')) : undefined;
			const exit = /exit code[:\s]+(\d+)/i.exec(out ?? '');
			return {
				...base,
				// Core's terminal card already says "Run(ning) `cmd`"; only the agent's description adds anything.
				invocation: description ?? (command ? '' : 'Running a command'),
				past: description ?? (command ? '' : 'Ran a command'),
				...(command ? {
					terminal: {
						command,
						...(out && !/^\(Bash completed with no output\)$/.test(out.trim()) ? { output: out } : {}),
						...(exit ? { exitCode: Number(exit[1]) } : error ? { exitCode: 1 } : complete ? { exitCode: 0 } : {}),
					},
				} : {}),
			};
		}
		case 'read': {
			const target = files[0] ? fileLink(files[0], line) : code(call.title);
			return { ...base, invocation: `Reading ${target}`, past: `Read ${target}` };
		}
		case 'edit':
		case 'delete':
		case 'move': {
			const target = files.length ? files.map(f => fileLink(f)).join(', ') : code(call.title);
			const stats = diffStats(call);
			const counts = stats ? ` (+${stats.added} −${stats.removed})` : '';
			const verb = call.kind === 'delete' ? ['Deleting', 'Deleted'] : call.kind === 'move' ? ['Moving', 'Moved'] : ['Editing', 'Edited'];
			return {
				...base,
				invocation: `${verb[0]} ${target}`,
				past: error ? `${verb[0]} ${target} failed` : `${verb[1]} ${target}${counts}`,
			};
		}
		case 'search': {
			const pattern = str(input.pattern) ?? str(input.query);
			const what = pattern ? code(pattern) : call.title;
			return { ...base, invocation: `Searching ${what}`, past: `Searched ${what}`, ...(complete && output ? { simple: { input: pattern ?? call.title, output: unfence(output) } } : {}) };
		}
		case 'fetch': {
			const url = str(input.url) ?? str(input.query);
			return { ...base, invocation: `Fetching ${url ?? call.title}`, past: `Fetched ${url ?? call.title}`, ...(complete && output ? { simple: { input: url ?? call.title, output } } : {}) };
		}
		case 'switch_mode':
		case 'think':
			return { ...base, invocation: call.title, past: call.title };
		default: {
			const shownInput = call.rawInput !== undefined && Object.keys(input).length ? JSON.stringify(call.rawInput, null, 2) : '';
			return { ...base, invocation: call.title, past: call.title, ...(complete && (shownInput || output) ? { simple: { input: shownInput, output } } : {}) };
		}
	}
}

/** A tool call announced with a placeholder title before its input streams in. */
function isPlaceholder(call: ToolCallView): boolean {
	return call.status === 'pending' && call.content.length === 0 && (!call.rawInput || (typeof call.rawInput === 'object' && !Object.keys(call.rawInput).length));
}

const TODO: Record<string, TodoStatus> = { pending: 'not-started', in_progress: 'in-progress', completed: 'completed' };

/** Turns the changes of one turn into render ops. One instance per turn. */
export class TurnRenderer {
	private thought = 0;
	private thinking: string | undefined;
	private readonly shown = new Map<string, string>();
	private readonly cards = new Map<string, ToolCard>();

	constructor(private readonly turnId: string) { }

	render(change: Change): RenderOp[] {
		const ops: RenderOp[] = [];
		const endThinking = () => {
			if (this.thinking) {
				ops.push({ op: 'thinkingDone', id: this.thinking });
				this.thinking = undefined;
			}
		};
		switch (change.kind) {
			case 'text':
				if (change.role === 'thought') {
					if (!this.thinking) {
						this.thinking = `${this.turnId}-thought-${++this.thought}`;
					}
					if (change.delta) {
						ops.push({ op: 'thinking', id: this.thinking, text: change.delta });
					}
				} else if (change.role === 'agent' && change.delta) {
					endThinking();
					ops.push({ op: 'markdown', text: change.delta });
				}
				break;
			case 'tool': {
				if (isPlaceholder(change.call)) {
					break;
				}
				const fresh = toolCard(change.call);
				const card = this.cards.get(fresh.id)?.awaitingApproval && !fresh.complete ? { ...fresh, awaitingApproval: true } : fresh;
				const key = JSON.stringify(card);
				if (this.shown.get(card.id) !== key) {
					endThinking();
					this.shown.set(card.id, key);
					this.cards.set(card.id, card);
					ops.push({ op: 'tool', card });
				}
				break;
			}
			case 'plan':
				endThinking();
				ops.push({ op: 'todo', items: change.plan.map((p, i) => ({ id: i + 1, title: p.content, status: TODO[p.status] ?? 'not-started' })) });
				break;
		}
		return ops;
	}

	/** A card's permission prompt opened (true) or was answered (false): the card again, if it's shown. */
	awaitApproval(id: string, awaiting: boolean): RenderOp[] {
		const card = this.cards.get(id);
		if (!card || card.complete || !!card.awaitingApproval === awaiting) {
			return [];
		}
		const { awaitingApproval: _a, ...rest } = card;
		const next: ToolCard = awaiting ? { ...rest, awaitingApproval: true } : rest;
		this.cards.set(id, next);
		this.shown.set(id, JSON.stringify(next));
		return [{ op: 'tool', card: next }];
	}

	/**
	 * Ops to close the turn: an open thinking block, and tool cards that never completed, so none keeps spinning.
	 * This works when the turn ends with calls still open or the adapter crashes. After Stop, core has already
	 * cancelled the response and drops these updates (patch 94 closes the live cards), so these are what a reopened
	 * chat shows. A card in `notApproved` (its permission prompt was open, refused or dismissed) never ran: it says
	 * so. Any other open card had started (a command the user approved was running): it was stopped, not skipped.
	 */
	finish(how: 'ended' | 'stopped' | 'interrupted' = 'ended', notApproved: ReadonlySet<string> = new Set()): RenderOp[] {
		const ops: RenderOp[] = this.thinking ? [{ op: 'thinkingDone', id: this.thinking }] : [];
		this.thinking = undefined;
		const note = how === 'stopped' ? 'Stopped' : how === 'interrupted' ? 'Interrupted' : '';
		for (const card of this.cards.values()) {
			if (!card.complete) {
				let closed: ToolCard;
				if (note && notApproved.has(card.id)) {
					const what = card.terminal ? code(card.terminal.command) : card.invocation || card.toolName;
					const { terminal: _terminal, awaitingApproval: _awaiting, ...rest } = card;
					closed = { ...rest, complete: true, invocation: `Didn't run ${what}`, past: `Didn't run ${what}: ${note.toLowerCase()} before it was approved` };
				} else {
					const { awaitingApproval: _awaiting, ...rest } = card;
					closed = { ...rest, complete: true, past: note ? (card.past ? `${card.past} (${note.toLowerCase()})` : note) : card.past };
				}
				this.cards.set(card.id, closed);
				ops.push({ op: 'tool', card: closed });
			}
		}
		return ops;
	}
}

/**
 * Button labels for a permission prompt, short enough for the confirmation's dropdown (an "always" label can repeat
 * the whole command, which the prompt already shows) and unique, since the answer is matched by label.
 */
export function permissionButtons(p: Pick<PermissionPrompt, 'choices'>): string[] {
	const seen = new Set<string>();
	return p.choices.map((c, i) => {
		const label = c.label.length > 60 ? `${c.label.slice(0, 57).trimEnd()}…` : c.label;
		let text = c.persistent ? `${label} (${c.persistent})` : label;
		if (seen.has(text)) {
			text = `${text} [${i + 1}]`;
		}
		seen.add(text);
		return text;
	});
}

/** The marker a stopped turn ends with: in the live footer (`footer`), and in a reopened chat's transcript. */
export const STOPPED = 'Stopped';

/**
 * A response's footer details: "Stopped" for a turn ended by Stop (core drops a response's updates after Stop,
 * but takes its result's details, so that's where the live transcript can say so), then the model and context use.
 */
export function footer(info: { stopped?: boolean; model?: string; usage?: { used: number; size: number } }): string {
	return [
		info.stopped ? STOPPED : undefined,
		info.model,
		info.usage?.size ? `${Math.round(100 * info.usage.used / info.usage.size)}% of context` : undefined,
	].filter(Boolean).join(' · ');
}

/** The warning of a failed turn: the agent's own words, first line. */
export function turnFailureText(label: string, message: string): string {
	return `${label}: ${message.split('\n')[0]!.slice(0, 300)}`;
}
