import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SessionView, type acp } from '@editor/acp-client';
import { fileLink, toolCard, TurnRenderer, type RenderOp } from '../src/render.js';

const turns = JSON.parse(readFileSync(new URL('../../../packages/acp-client/test/fixtures/claude-0.87.0-turns.json', import.meta.url), 'utf8')) as { updates: acp.SessionUpdate[] };

function replay(updates: acp.SessionUpdate[]): RenderOp[] {
	const view = new SessionView();
	const renderer = new TurnRenderer('t');
	return [...updates.flatMap(u => renderer.render(view.apply(u))), ...renderer.finish()];
}

describe('turn rendering (recorded Claude run)', () => {
	const ops = replay(turns.updates);
	const cards = ops.filter((o): o is RenderOp & { op: 'tool' } => o.op === 'tool').map(o => o.card);
	const last = (id: string) => cards.filter(c => c.id === id).at(-1)!;
	const ids = [...new Set(cards.map(c => c.id))];

	it('shows one card per tool call, skipping the placeholder announcement, and updates it in place', () => {
		expect(ids).toHaveLength(4);
		// The first "Read File" announcement with no input is never shown.
		expect(cards.some(c => c.invocation.includes('Read File'))).toBe(false);
	});

	it('read: a file pill with the line', () => {
		const read = last(ids[0]!);
		expect(read).toMatchObject({ toolName: 'Read', complete: true, past: `Read ${fileLink('/work/notes.txt', 1)}` });
	});

	it('edit: the file and the size of the change, display only', () => {
		const edit = last(ids[1]!);
		expect(edit.past).toBe(`Edited ${fileLink('/work/notes.txt')} (+1 −1)`);
		expect(edit.complete).toBe(true);
	});

	it('execute: a terminal card with the exact command; no fake output', () => {
		const bash = last(ids[2]!);
		expect(bash.terminal).toEqual({ command: `python3 -c "open('ran.txt','w').write('x')"`, exitCode: 0 });
		expect(bash.past).toBe('Write x into ran.txt via Python');
		// The cancelled command never completes.
		expect(last(ids[3]!).complete).toBe(false);
	});

	it('agent text is markdown, in order', () => {
		expect(ops.filter(o => o.op === 'markdown').map(o => (o.op === 'markdown' ? o.text : '')).join('')).toBe('donedone1');
	});
});

describe('turn rendering', () => {
	it('thinking: one block per run of thought chunks, closed when something else is shown', () => {
		const ops = replay([
			{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'a' } },
			{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'b' } },
			{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
			{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'c' } },
		]);
		expect(ops).toEqual([
			{ op: 'thinking', id: 't-thought-1', text: 'a' },
			{ op: 'thinking', id: 't-thought-1', text: 'b' },
			{ op: 'thinkingDone', id: 't-thought-1' },
			{ op: 'markdown', text: 'x' },
			{ op: 'thinking', id: 't-thought-2', text: 'c' },
			{ op: 'thinkingDone', id: 't-thought-2' },
		]);
	});

	it('plan → todo list with the native statuses', () => {
		const ops = replay([{ sessionUpdate: 'plan', entries: [{ content: 'Read', priority: 'high', status: 'completed' }, { content: 'Edit', priority: 'low', status: 'in_progress' }, { content: 'Build', priority: 'low', status: 'pending' }] }]);
		expect(ops).toEqual([{ op: 'todo', items: [{ id: 1, title: 'Read', status: 'completed' }, { id: 2, title: 'Edit', status: 'in-progress' }, { id: 3, title: 'Build', status: 'not-started' }] }]);
	});

	it('unchanged tool updates are not re-sent', () => {
		const ops = replay([
			{ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'grep', kind: 'search', status: 'in_progress', rawInput: { pattern: 'x' } },
			{ sessionUpdate: 'tool_call_update', toolCallId: 'a', _meta: { anything: 1 } },
			{ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }] },
		]);
		expect(ops.map(o => (o.op === 'tool' ? o.card.complete : o.op))).toEqual([false, true]);
		expect(ops.at(-1)).toMatchObject({ card: { past: 'Searched `x`', simple: { input: 'x', output: 'a.txt' } } });
	});

	it('Codex-style command output: raw text, exit code, failure', () => {
		const card = toolCard({ id: 'c', title: 'npm test', kind: 'execute', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'boom\nExit code: 2' } }], locations: [], rawInput: { command: ['npm', 'test'] } });
		expect(card.terminal).toEqual({ command: 'npm test', output: 'boom\nExit code: 2', exitCode: 2 });
		expect(card.error).toBe(true);
	});

	it('a fenced console block is unwrapped into terminal output', () => {
		const card = toolCard({ id: 'c', title: 'ls', kind: 'execute', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '```console\na.txt\nb.txt\n```' } }], locations: [], rawInput: { command: 'ls' } });
		expect(card.terminal?.output).toBe('a.txt\nb.txt');
	});
});
