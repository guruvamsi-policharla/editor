import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionView, type acp } from '@editor/acp-client';
import { ChatHistory, menuTarget, type ChatEntry } from '../src/history.js';
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
		expect(matchChat('KZG', 't', 'It reads:\n```latex\nKZG needs setup\n```')).toBe('It reads: KZG needs setup');
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

	it('each turn keeps the model it ran on, so a reopened chat\'s model picker can show it after a restart (#25)', () => {
		const t = new TranscriptBuilder();
		t.startTurn('one');
		t.setModel('default');
		t.startTurn('two');
		t.setModel('haiku');
		t.setModel(undefined);
		const a = new ChatHistory(dir);
		a.save(entry(1), t.turns, t.text());
		expect(new ChatHistory(dir).transcript('agent-claude:/c1')!.map(turn => turn.model)).toEqual(['default', 'haiku']);
	});

	it('each chat keeps its own settings across a restart; setting one chat\'s leaves the other\'s alone (#33)', () => {
		const a = new ChatHistory(dir);
		a.save(entry(1, { settings: { mode: 'acceptEdits', model: 'haiku' } }));
		a.save(entry(2));
		a.saveSettings('agent-claude:/c2', { mode: 'default', model: 'haiku' });
		a.saveSettings('agent-claude:/nope', { mode: 'default' });
		const b = new ChatHistory(dir);
		expect(b.get('agent-claude:/c2')!.settings).toEqual({ mode: 'default', model: 'haiku' });
		expect(b.get('agent-claude:/c1')!.settings).toEqual({ mode: 'acceptEdits', model: 'haiku' });
		expect(b.get('agent-claude:/nope')).toBeUndefined();
	});

	it('Remove from Chat History sticks: the agent\'s own list doesn\'t bring the chat back, also after a restart (#22)', () => {
		const a = new ChatHistory(dir);
		a.save(entry(1), [{ prompt: 'say alpha', ops: [] }], 'say alpha');
		a.save(entry(2));
		a.remove('agent-claude:/c1');
		a.forgetSession('claude', 'listed-only');
		const b = new ChatHistory(dir);
		expect(b.list().map(e => e.resource)).toEqual(['agent-claude:/c2']);
		expect(b.search('alpha')).toEqual([]);
		expect(b.isRemoved('claude', 's1')).toBe(true);
		expect(b.isRemoved('claude', 'listed-only')).toBe(true);
		expect(b.isRemoved('codex', 's1')).toBe(false);
		expect(b.isRemoved('claude', 's2')).toBe(false);
	});

	it('the agent\'s title for a chat (it comes after the turn is saved) is saved, so the list, search and a restart show it', () => {
		const a = new ChatHistory(dir);
		a.save(entry(1, { title: 'first chat about apples' }), [{ prompt: 'first chat about apples', ops: [] }], 'first chat about apples');
		a.rename('agent-claude:/c1', 'Apple varieties');
		a.rename('agent-claude:/nope', 'Not a saved chat');
		const b = new ChatHistory(dir);
		expect(b.get('agent-claude:/c1')!.title).toBe('Apple varieties');
		expect(b.search('varieties').map(h => h.entry.resource)).toEqual(['agent-claude:/c1']);
		expect(b.get('agent-claude:/nope')).toBeUndefined();
	});

	it('a removed chat stays removed when its running turn ends and saves it again', () => {
		const a = new ChatHistory(dir);
		a.save(entry(1), [{ prompt: 'p', ops: [] }], 'p');
		a.remove('agent-claude:/c1');
		a.save(entry(1, { title: 'Claude Code', updated: 9 }), [{ prompt: 'p', ops: [] }], 'p');
		expect(a.list()).toEqual([]);
		expect(new ChatHistory(dir).list()).toEqual([]);
		expect(a.transcript('agent-claude:/c1')).toBeUndefined();
	});

	it('two windows on the same folder keep each other\'s chats (each writes the index it read before)', () => {
		const one = new ChatHistory(dir);
		const two = new ChatHistory(dir);
		one.save(entry(1), [{ prompt: 'p1', ops: [] }], 'p1');
		expect(two.list().map(e => e.resource)).toEqual(['agent-claude:/c1']);
		two.save(entry(2), [{ prompt: 'p2', ops: [] }], 'p2');
		one.save(entry(3));
		one.saveSettings('agent-claude:/c2', { mode: 'plan' });
		const later = new ChatHistory(dir);
		expect(later.list().map(e => e.resource)).toEqual(['agent-claude:/c3', 'agent-claude:/c2', 'agent-claude:/c1']);
		expect(later.get('agent-claude:/c2')!.settings).toEqual({ mode: 'plan' });
		two.remove('agent-claude:/c1');
		expect(one.list().map(e => e.resource)).toEqual(['agent-claude:/c3', 'agent-claude:/c2']);
		expect(one.isRemoved('claude', 's1')).toBe(true);
	});

	it('a turn\'s warnings (an error, a restart notice) are part of its transcript, so a reopened chat shows them', () => {
		const t = new TranscriptBuilder();
		t.startTurn('hello');
		t.add([{ op: 'markdown', text: 'partial answer' }]);
		t.add([{ op: 'warning', text: 'Claude Code stopped unexpectedly (exit code 1).' }]);
		const a = new ChatHistory(dir);
		a.save(entry(1), t.turns, t.text());
		expect(new ChatHistory(dir).transcript('agent-claude:/c1')![0]!.ops).toEqual([
			{ op: 'markdown', text: 'partial answer' },
			{ op: 'warning', text: 'Claude Code stopped unexpectedly (exit code 1).' },
		]);
	});

	it('the sessions list\'s context menu argument, in each shape it arrives in (#22)', () => {
		const resource = { scheme: 'agent-claude', path: '/c1' };
		expect(menuTarget({ resource, label: 'Chat 1' })).toBe(resource); // our item, found by the extension host
		expect(menuTarget({ session: { resource }, $mid: 1 })).toBe(resource); // passed on as is
		expect(menuTarget(resource)).toBe(resource);
		expect(menuTarget(undefined)).toBeUndefined();
		expect(menuTarget({ session: {} })).toBeUndefined();
	});
});
