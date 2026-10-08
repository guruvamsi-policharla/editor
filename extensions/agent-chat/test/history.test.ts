import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionView, type acp } from '@editor/acp-client';
import { ChatHistory, type ChatEntry } from '../src/history.js';
import { TurnRenderer } from '../src/render.js';
import { matchChat, ReplayBuilder, TranscriptBuilder } from '../src/transcript.js';

const turns = JSON.parse(readFileSync(new URL('../../../packages/acp-client/test/fixtures/claude-0.87.0-turns.json', import.meta.url), 'utf8')) as { updates: acp.SessionUpdate[] };

describe('transcript', () => {
	it('records a live turn compactly: merged markdown and thinking, each tool card once in its final state', () => {
		const view = new SessionView();
		const renderer = new TurnRenderer('t');
		const t = new TranscriptBuilder();
		t.startTurn('fix the intro');
		for (const u of turns.updates) {
			t.add(renderer.render(view.apply(u)));
		}
		t.add(renderer.finish('stopped'));
		t.endTurn(true);
		const ops = t.turns[0]!.ops;
		expect(t.turns).toHaveLength(1);
		expect(t.turns[0]!.stopped).toBe(true);
		const cards = ops.filter(o => o.op === 'tool');
		expect(cards).toHaveLength(4);
		expect(new Set(cards.map(c => (c.op === 'tool' ? c.card.id : ''))).size).toBe(4);
		expect(cards.every(c => c.op === 'tool' && c.card.complete)).toBe(true);
		// Consecutive markdown chunks are one op.
		expect(ops.some((o, i) => o.op === 'markdown' && ops[i + 1]?.op === 'markdown')).toBe(false);
		expect(t.text()).toContain('fix the intro');
	});

	it('cuts long tool output', () => {
		const t = new TranscriptBuilder();
		t.startTurn('x');
		t.add([{ op: 'tool', card: { id: 'c', toolName: 'Bash', invocation: '', past: '', complete: true, error: false, terminal: { command: 'yes', output: 'y\n'.repeat(10_000) } } }]);
		const op = t.turns[0]!.ops[0]!;
		expect(op.op === 'tool' && op.card.terminal!.output!.length).toBeLessThan(5000);
	});

	it('a session/load replay becomes turns: user messages start them', () => {
		const view = new SessionView();
		const replay = new ReplayBuilder();
		const updates: acp.SessionUpdate[] = [
			{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first ' } },
			{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'question' } },
			{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } },
			{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer one' } },
			{ sessionUpdate: 'tool_call', toolCallId: 'r', title: 'Read a.tex', kind: 'read', status: 'completed', locations: [{ path: '/w/a.tex' }] },
			{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'second' } },
			{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer two' } },
		];
		for (const u of updates) {
			replay.apply(view.apply(u));
		}
		const out = replay.finish();
		expect(out.map(t => t.prompt)).toEqual(['first question', 'second']);
		expect(out[0]!.ops.map(o => o.op)).toEqual(['thinking', 'markdown', 'tool']);
		expect(out[1]!.ops).toEqual([{ op: 'markdown', text: 'answer two' }]);
	});

	it('search matches every word in the title or the text, with a snippet from the text', () => {
		expect(matchChat('fold argument', 'Intro', 'Please fold in the argument from section 3')).toBe('Please fold in the argument from section 3');
		expect(matchChat('intro', 'Fix the intro', 'nothing here')).toBe('');
		expect(matchChat('missing', 'Fix the intro', 'nothing here')).toBeUndefined();
		expect(matchChat('needle', 't', `${'a '.repeat(100)}needle${' b'.repeat(100)}`)).toMatch(/^….*needle.*…$/);
	});
});

describe('chat history store', () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chats-')); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const entry = (n: number, extra: Partial<ChatEntry> = {}): ChatEntry => ({ resource: `agent-claude:/c${n}`, harness: 'claude', sessionId: `s${n}`, title: `Chat ${n}`, created: n, updated: n, turns: 1, ...extra });

	it('survives a restart (a new store on the same directory): index, transcripts, search', () => {
		const a = new ChatHistory(dir);
		a.save(entry(1), [{ prompt: 'tighten the abstract', ops: [{ op: 'markdown', text: 'Done: shorter abstract.' }] }], 'tighten the abstract\nDone: shorter abstract.');
		a.save(entry(2, { harness: 'codex', resource: 'agent-codex:/c2' }), [{ prompt: 'fix proofs', ops: [] }], 'fix proofs');
		const b = new ChatHistory(dir);
		expect(b.list().map(e => e.resource)).toEqual(['agent-codex:/c2', 'agent-claude:/c1']);
		expect(b.list('claude')).toHaveLength(1);
		expect(b.transcript('agent-claude:/c1')![0]!.prompt).toBe('tighten the abstract');
		expect(b.bySession('claude', 's1')!.title).toBe('Chat 1');
		expect(b.search('shorter').map(h => h.entry.resource)).toEqual(['agent-claude:/c1']);
		expect(b.search('shorter')[0]!.snippet).toContain('shorter abstract');
		expect(b.search('chat').length).toBe(2);
		expect(b.search('').length).toBe(2);
	});

	it('saving an entry without a transcript keeps the old one; remove deletes both', () => {
		const a = new ChatHistory(dir);
		a.save(entry(1), [{ prompt: 'p', ops: [] }], 'p');
		a.save({ ...entry(1), title: 'Renamed', updated: 5 });
		expect(a.get('agent-claude:/c1')!.title).toBe('Renamed');
		expect(a.transcript('agent-claude:/c1')).toHaveLength(1);
		a.remove('agent-claude:/c1');
		expect(new ChatHistory(dir).list()).toEqual([]);
		expect(a.transcript('agent-claude:/c1')).toBeUndefined();
	});
});
