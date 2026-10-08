// A chat's transcript: what the chat showed, turn by turn, kept to show the chat again after a restart (core's
// history), to search old chats, and built the same way from a `session/load` replay. Pure (no vscode import).
//
// A turn is the user's prompt and the render ops of the answer, compacted: markdown and thinking merged, each
// tool card in its final state (long output cut), the latest todo list.
import type { Change } from '@editor/acp-client';
import { TurnRenderer, type RenderOp, type ToolCard } from './render.js';

export interface TranscriptTurn {
	prompt: string;
	ops: RenderOp[];
	/** The turn ended by Stop. */
	stopped?: boolean;
}

/** Tool output kept per card. */
const OUTPUT_LIMIT = 4000;

function cut(text: string): string {
	return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n…` : text;
}

function compactCard(card: ToolCard): ToolCard {
	return {
		...card,
		...(card.terminal?.output ? { terminal: { ...card.terminal, output: cut(card.terminal.output) } } : {}),
		...(card.simple ? { simple: { input: cut(card.simple.input), output: cut(card.simple.output) } } : {}),
	};
}

export class TranscriptBuilder {
	readonly turns: TranscriptTurn[];

	constructor(turns: readonly TranscriptTurn[] = []) {
		this.turns = turns.map(t => ({ ...t, ops: [...t.ops] }));
	}

	startTurn(prompt: string): void {
		this.turns.push({ prompt, ops: [] });
	}

	/** Adds a live turn's render ops to the current turn. */
	add(ops: readonly RenderOp[]): void {
		let turn = this.turns.at(-1);
		if (!turn) {
			turn = { prompt: '', ops: [] };
			this.turns.push(turn);
		}
		for (const op of ops) {
			const last = turn.ops.at(-1);
			switch (op.op) {
				case 'markdown':
					if (last?.op === 'markdown') {
						turn.ops[turn.ops.length - 1] = { op: 'markdown', text: last.text + op.text };
					} else {
						turn.ops.push(op);
					}
					break;
				case 'thinking': {
					const i = turn.ops.findIndex(o => o.op === 'thinking' && o.id === op.id);
					const prev = turn.ops[i];
					if (prev?.op === 'thinking') {
						turn.ops[i] = { ...prev, text: prev.text + op.text };
					} else {
						turn.ops.push(op);
					}
					break;
				}
				case 'thinkingDone':
					break;
				case 'tool': {
					const card = compactCard(op.card);
					const i = turn.ops.findIndex(o => o.op === 'tool' && o.card.id === card.id);
					if (i >= 0) {
						turn.ops[i] = { op: 'tool', card };
					} else {
						turn.ops.push({ op: 'tool', card });
					}
					break;
				}
				case 'todo': {
					const i = turn.ops.findIndex(o => o.op === 'todo');
					if (i >= 0) {
						turn.ops.splice(i, 1);
					}
					turn.ops.push(op);
					break;
				}
			}
		}
	}

	endTurn(stopped: boolean): void {
		const turn = this.turns.at(-1);
		if (turn && stopped) {
			turn.stopped = true;
		}
	}

	/** Searchable text: prompts and answers (no tool output). */
	text(): string {
		return this.turns.map(t => [t.prompt, ...t.ops.flatMap(o => (o.op === 'markdown' ? [o.text] : []))].join('\n')).join('\n');
	}
}

/**
 * A transcript from a `session/load` replay: user message chunks start turns, everything else renders as in a
 * live turn. Feed it every change of the replay, then call `finish()`.
 */
export class ReplayBuilder {
	readonly transcript = new TranscriptBuilder();
	private renderer: TurnRenderer | undefined;
	private turn = 0;
	private lastWasUser = false;

	apply(change: Change): void {
		if (change.kind === 'text' && change.role === 'user') {
			if (!this.lastWasUser || !this.renderer) {
				this.close();
				this.renderer = new TurnRenderer(`replay-${++this.turn}`);
				this.transcript.startTurn(change.delta);
			} else {
				const turn = this.transcript.turns.at(-1)!;
				turn.prompt += change.delta;
			}
			this.lastWasUser = true;
			return;
		}
		this.lastWasUser = false;
		this.renderer ??= new TurnRenderer(`replay-${++this.turn}`);
		this.transcript.add(this.renderer.render(change));
	}

	private close(): void {
		if (this.renderer) {
			this.transcript.add(this.renderer.finish('ended'));
		}
	}

	finish(): TranscriptTurn[] {
		this.close();
		this.renderer = undefined;
		return this.transcript.turns;
	}
}

/**
 * Where `query` matches: every word must occur in the title or the text (case-insensitive). Returns a one-line
 * snippet around the first word's first match in the text ('' when only the title matched), or undefined.
 */
export function matchChat(query: string, title: string, text: string): string | undefined {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const lowTitle = title.toLowerCase();
	const lowText = text.toLowerCase();
	if (!words.every(w => lowTitle.includes(w) || lowText.includes(w))) {
		return undefined;
	}
	const hit = words.map(w => lowText.indexOf(w)).filter(i => i >= 0).sort((a, b) => a - b)[0];
	if (hit === undefined) {
		return '';
	}
	const start = Math.max(0, hit - 40);
	const end = Math.min(text.length, hit + 80);
	return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/`{3}[\w-]*/g, ' ').replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}
