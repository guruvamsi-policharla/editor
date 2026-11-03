import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import { SessionView, textOf } from '../src/index.js';

const turns = JSON.parse(readFileSync(new URL('./fixtures/acp-v1-turns.json', import.meta.url), 'utf8')) as { updates: acp.SessionUpdate[] };

describe('SessionView (ACP v1 reducer)', () => {
	it('replays a recorded ACP v1 update stream (every kind tact sends and more): tool calls merged by id, text, usage, title', () => {
		const view = new SessionView();
		for (const u of turns.updates) {
			view.apply(u);
		}
		const s = view.state;
		expect(s.ignored).toBe(0);
		const calls = [...s.toolCalls.values()];
		expect(calls.map(c => c.name)).toEqual(['Read', 'Edit', 'Bash', 'Bash']);
		const edit = calls[1]!;
		expect(edit.kind).toBe('edit');
		expect(edit.status).toBe('completed');
		expect(edit.title).toBe('Edit notes.txt');
		// The diff came in an earlier update than "completed"; a later update without content keeps it.
		expect(edit.content[0]).toMatchObject({ type: 'diff', oldText: 'hello world', newText: 'hello there' });
		expect(calls[2]!.rawInput).toMatchObject({ command: expect.stringContaining('ran.txt') });
		expect(calls[3]!.status).toBe('pending'); // the cancelled one never completed
		expect(textOf(s, 'agent')).toBe('donedone1');
		expect(s.title).toBe('Replace word in notes.txt');
		expect(s.usage?.cost?.currency).toBe('USD');
		expect(s.modeId).toBe('acceptEdits');
		expect(s.commands.map(c => c.name)).toContain('compact');
	});

	it('ignores unknown update kinds without throwing', () => {
		const view = new SessionView();
		const change = view.apply({ sessionUpdate: 'from_the_future', x: 1 } as unknown as acp.SessionUpdate);
		expect(change).toEqual({ kind: 'ignored', sessionUpdate: 'from_the_future' });
		expect(view.state.ignored).toBe(1);
	});

	it('keeps one entry per message and splits on role or message id changes', () => {
		const view = new SessionView();
		const chunk = (kind: 'agent_message_chunk' | 'agent_thought_chunk', text: string, messageId?: string) =>
			view.apply({ sessionUpdate: kind, content: { type: 'text', text }, ...(messageId ? { messageId } : {}) } as acp.SessionUpdate);
		expect(chunk('agent_thought_chunk', 'a')).toMatchObject({ newEntry: true });
		expect(chunk('agent_thought_chunk', 'b')).toMatchObject({ newEntry: false });
		expect(chunk('agent_message_chunk', 'c', 'm1')).toMatchObject({ newEntry: true });
		expect(chunk('agent_message_chunk', 'd', 'm1')).toMatchObject({ newEntry: false });
		expect(chunk('agent_message_chunk', 'e', 'm2')).toMatchObject({ newEntry: true });
		expect(view.state.entries.map(e => (e.type === 'text' ? e.text : e.id))).toEqual(['ab', 'cd', 'e']);
	});

	it('creates a tool call from an update it never saw, and current_mode_update moves the mode option', () => {
		const view = new SessionView();
		view.setConfigOptions([{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Manual' }, { value: 'plan', name: 'Plan' }] }]);
		expect(view.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'in_progress' })).toMatchObject({ kind: 'tool', isNew: true });
		expect(view.state.toolCalls.get('x')!.status).toBe('in_progress');
		view.apply({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
		expect(view.state.configOptions[0]!.currentValue).toBe('plan');
	});

	it('property: random update streams never throw and keep the invariants', () => {
		for (let seed = 1; seed <= 300; seed++) {
			const rnd = prng(seed);
			const view = new SessionView();
			const ids = new Set<string>();
			const agentText: string[] = [];
			let lastConfig: acp.SessionConfigOption[] | undefined;
			for (let i = 0; i < 60; i++) {
				const u = randomUpdate(rnd);
				if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
					ids.add(u.toolCallId);
				}
				if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
					agentText.push(u.content.text);
				}
				if (u.sessionUpdate === 'config_option_update') {
					lastConfig = u.configOptions;
				}
				expect(() => view.apply(u)).not.toThrow();
			}
			const s = view.state;
			// every tool call id appears once, as one entry
			expect(s.toolCalls.size).toBe(ids.size);
			expect(s.entries.filter(e => e.type === 'tool').length).toBe(ids.size);
			// no agent text is lost or reordered
			expect(textOf(s, 'agent')).toBe(agentText.join(''));
			// a config update replaces the options wholesale
			if (lastConfig) {
				expect(s.configOptions.map(o => o.id)).toEqual(lastConfig.map(o => o.id));
			}
			// no two adjacent text entries of one role without a message id boundary
			for (let i = 1; i < s.entries.length; i++) {
				const a = s.entries[i - 1]!;
				const b = s.entries[i]!;
				if (a.type === 'text' && b.type === 'text' && a.role === b.role) {
					expect(a.messageId && b.messageId && a.messageId !== b.messageId).toBeTruthy();
				}
			}
		}
	});
});

function prng(seed: number): () => number {
	let x = seed;
	return () => {
		x = (x * 1103515245 + 12345) & 0x7fffffff;
		return x / 0x7fffffff;
	};
}

function randomUpdate(rnd: () => number): acp.SessionUpdate {
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
	const id = pick(['a', 'b', 'c', 'd']);
	const text = pick(['x', 'yy', '', 'zzz ']);
	const messageId = pick([undefined, 'm1', 'm2']);
	switch (Math.floor(rnd() * 12)) {
		case 0: return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(messageId ? { messageId } : {}) };
		case 1: return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } };
		case 2: return { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } };
		case 3: return { sessionUpdate: 'tool_call', toolCallId: id, title: 'T', kind: pick(['read', 'edit', 'execute', 'other'] as const), status: 'pending' };
		case 4: return { sessionUpdate: 'tool_call_update', toolCallId: id, ...(rnd() < 0.5 ? { status: pick(['in_progress', 'completed', 'failed'] as const) } : {}), ...(rnd() < 0.3 ? { content: [] } : {}) };
		case 5: return { sessionUpdate: 'plan', entries: [{ content: text, priority: 'low', status: 'pending' }] };
		case 6: return { sessionUpdate: 'available_commands_update', availableCommands: [{ name: id, description: '' }] };
		case 7: return { sessionUpdate: 'current_mode_update', currentModeId: id };
		case 8: return { sessionUpdate: 'config_option_update', configOptions: [{ id, name: id, type: 'select', currentValue: 'v', options: [{ value: 'v', name: 'V' }] }] };
		case 9: return { sessionUpdate: 'session_info_update', title: text };
		case 10: return { sessionUpdate: 'usage_update', used: 1, size: 2 };
		default: return { sessionUpdate: `_custom_${id}` } as unknown as acp.SessionUpdate;
	}
}
