import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SessionView, type acp } from '@editor/acp-client';
import { fileLink, footer, permissionButtons, runningCommands, STOPPED, stoppedCommandsNote, toolCard, TurnRenderer, type RenderOp } from '../src/render.js';

const turns = JSON.parse(readFileSync(new URL('../../../packages/acp-client/test/fixtures/claude-0.87.0-turns.json', import.meta.url), 'utf8')) as { updates: acp.SessionUpdate[] };

function replay(updates: acp.SessionUpdate[]): RenderOp[] {
	const view = new SessionView();
	const renderer = new TurnRenderer('t');
	// The recorded run's last turn was cancelled.
	return [...updates.flatMap(u => renderer.render(view.apply(u))), ...renderer.finish('stopped')];
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
		// The cancelled command never completed; closing the stopped turn says so.
		expect(cards.filter(c => c.id === ids[3]).at(-2)!.complete).toBe(false);
		expect(last(ids[3]!)).toMatchObject({ complete: true, past: 'Write x into late.txt via Python (stopped)' });
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

describe('closing a turn', () => {
	it('a stopped turn closes the cards that never completed (no endless spinner)', () => {
		const view = new SessionView();
		const renderer = new TurnRenderer('t');
		renderer.render(view.apply({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'x', kind: 'execute', status: 'pending', rawInput: { command: 'python3 x.py', description: 'Run x' } }));
		renderer.render(view.apply({ sessionUpdate: 'tool_call', toolCallId: 'b', title: 'Read', kind: 'read', status: 'completed', locations: [{ path: '/w/a' }] }));
		const ops = renderer.finish('stopped');
		expect(ops).toEqual([{ op: 'tool', card: expect.objectContaining({ id: 'a', complete: true, past: 'Run x (stopped)' }) }]);
		expect(renderer.finish('stopped')).toEqual([]);
	});

	it('Stop during an approved command: its card says it ran and was stopped, and the agent is told so; one never approved didn\'t run (#32)', () => {
		const view = new SessionView();
		const renderer = new TurnRenderer('t');
		renderer.render(view.apply({ sessionUpdate: 'tool_call', toolCallId: 'rm', title: 'x', kind: 'execute', status: 'pending', rawInput: { command: 'rm notes.tex; sleep 30' } }));
		renderer.render(view.apply({ sessionUpdate: 'tool_call', toolCallId: 'ask', title: 'x', kind: 'execute', status: 'pending', rawInput: { command: 'git push' } }));
		const notApproved = new Set(['ask']);
		const ops = renderer.finish('stopped', notApproved);
		expect(ops).toEqual([
			{ op: 'tool', card: expect.objectContaining({ id: 'rm', complete: true, past: 'Stopped', terminal: { command: 'rm notes.tex; sleep 30' } }) },
			{ op: 'tool', card: expect.objectContaining({ id: 'ask', complete: true, past: 'Didn\'t run `git push`: stopped before it was approved' }) },
		]);
		expect(ops[1]!.op === 'tool' && ops[1]!.card.terminal).toBeUndefined();
		expect(runningCommands(ops, notApproved)).toEqual(['rm notes.tex; sleep 30']);
		const note = stoppedCommandsNote(['rm notes.tex; sleep 30']);
		expect(note).toContain('`rm notes.tex; sleep 30`');
		expect(note).toMatch(/had approved it, and it had started/);
		expect(note).toMatch(/was not rejected/);
	});

	it('a card waits for approval while its prompt is open, through the agent\'s updates; closing it drops the flag (#32)', () => {
		const view = new SessionView();
		const renderer = new TurnRenderer('t');
		renderer.render(view.apply({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'x', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } }));
		expect(renderer.awaitApproval('a', true)).toEqual([{ op: 'tool', card: expect.objectContaining({ id: 'a', awaitingApproval: true }) }]);
		expect(renderer.awaitApproval('a', true)).toEqual([]);
		expect(renderer.awaitApproval('nope', true)).toEqual([]);
		const update = renderer.render(view.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'a', rawInput: { command: 'ls -l' } }));
		expect(update).toEqual([{ op: 'tool', card: expect.objectContaining({ awaitingApproval: true }) }]);
		expect(renderer.awaitApproval('a', false)[0]).toEqual({ op: 'tool', card: expect.not.objectContaining({ awaitingApproval: true }) });
		renderer.awaitApproval('a', true);
		const closed = renderer.finish('stopped', new Set(['a']));
		expect(closed[0]!.op === 'tool' && closed[0]!.card.awaitingApproval).toBeUndefined();
	});

	it('a card without a label says Interrupted after a crash', () => {
		const view = new SessionView();
		const renderer = new TurnRenderer('t');
		renderer.render(view.apply({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'ls', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls' } }));
		expect(renderer.finish('interrupted')[0]).toMatchObject({ card: { complete: true, past: 'Interrupted' } });
	});
});

describe('the footer', () => {
	it('a stopped turn says so live, before the model and context, the same word the reopened transcript shows (#26)', () => {
		expect(footer({ stopped: true, model: 'Haiku 5.5', usage: { used: 12, size: 100 } })).toBe('Stopped · Haiku 5.5 · 12% of context');
		expect(footer({ stopped: true })).toBe(STOPPED);
		expect(footer({ model: 'Haiku 5.5' })).toBe('Haiku 5.5');
		expect(footer({})).toBe('');
	});
});

describe('permission buttons', () => {
	it('shortens a long "always" label, keeps where it is saved, and keeps labels unique', () => {
		const long = `Yes, and don't ask again for python3 -c "open('ran.txt','w').write('x')" commands`;
		const buttons = permissionButtons({ choices: [
			{ optionId: 'y', label: 'Yes', kind: 'allow_once' },
			{ optionId: 'n', label: 'No', kind: 'reject_once' },
			{ optionId: 'a', label: long, kind: 'allow_always', persistent: 'saved to .claude/settings.local.json' },
			{ optionId: 'n2', label: 'No', kind: 'reject_always' },
		] });
		expect(buttons[0]).toBe('Yes');
		expect(buttons[2]).toMatch(/^Yes, and don't ask again for python3 -c .{1,40}… \(saved to \.claude\/settings\.local\.json\)$/);
		expect(buttons[2]!.length).toBeLessThan(100);
		expect(new Set(buttons).size).toBe(4);
	});
});
