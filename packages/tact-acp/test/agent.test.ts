import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import { TactAgent } from '../src/agent.js';
import { configOptions, EntryMapper, pathsIn, promptText, toolDetail } from '../src/mapping.js';
import { hasWebApi, ptyCommand, startFailure, stripAnsi } from '../src/process.js';
import { parseEvent } from '../src/web.js';

const FAKE_TACT = fileURLToPath(new URL('./fixtures/fake-tact.mjs', import.meta.url));
chmodSync(FAKE_TACT, 0o755);

describe('entries → updates', () => {
	it('diffs re-sent text, maps tools by name, and skips the user\'s own message unless replaying', () => {
		const m = new EntryMapper();
		expect(m.map({ id: 0, revision: 1, parent: null, kind: 'user', text: 'hi' })).toEqual([]);
		expect(m.map({ id: 1, revision: 1, parent: null, kind: 'assistant', text: 'Hel', complete: false })).toMatchObject([{ sessionUpdate: 'agent_message_chunk', content: { text: 'Hel' } }]);
		expect(m.map({ id: 1, revision: 2, parent: null, kind: 'assistant', text: 'Hello', complete: true })).toMatchObject([{ content: { text: 'lo' } }]);
		expect(m.map({ id: 1, revision: 3, parent: null, kind: 'assistant', text: 'Hello', complete: true })).toEqual([]);
		expect(m.map({ id: 2, revision: 1, parent: null, kind: 'reasoning', text: 'Hm' })).toMatchObject([{ sessionUpdate: 'agent_thought_chunk' }]);
		expect(m.map({ id: 3, revision: 1, parent: null, kind: 'tool', name: 'exec_command', summary: 'make', state: 'running' }))
			.toMatchObject([{ sessionUpdate: 'tool_call', toolCallId: 't3', kind: 'execute', status: 'in_progress', rawInput: { command: 'make' } }]);
		expect(m.map({ id: 3, revision: 2, parent: null, kind: 'tool', name: 'exec_command', summary: 'make', state: 'failed' }))
			.toMatchObject([{ sessionUpdate: 'tool_call_update', toolCallId: 't3', status: 'failed' }]);
		expect(m.map({ id: 4, revision: 1, parent: null, kind: 'tool', name: 'apply_patch', summary: 'main.tex', state: 'succeeded' }))
			.toMatchObject([{ kind: 'edit', status: 'completed', locations: [{ path: 'main.tex' }] }]);
		expect(new EntryMapper().map({ id: 0, revision: 1, parent: null, kind: 'user', text: 'hi' }, true)).toMatchObject([{ sessionUpdate: 'user_message_chunk', content: { text: 'hi' } }]);
	});

	it('a turn ends with its own turn_completed / interrupted / error entry, not an earlier turn\'s', () => {
		const m = new EntryMapper();
		m.map({ id: 5, revision: 1, parent: null, kind: 'turn_completed', duration_ns: 1 });
		m.baseline = m.lastId;
		expect(m.turnEnd({ id: 5, revision: 1, parent: null, kind: 'turn_completed', duration_ns: 1 })).toBeUndefined();
		expect(m.turnEnd({ id: 6, revision: 1, parent: null, kind: 'interrupted', count: 1 })).toEqual({ kind: 'interrupted' });
		expect(m.turnEnd({ id: 7, revision: 1, parent: null, kind: 'error', message: 'HTTP 401' })).toEqual({ kind: 'error', message: 'HTTP 401' });
	});

	it('tool details: patch paths, command output', () => {
		expect(pathsIn('*** Begin Patch\n*** Update File: a.tex\n*** Add File: b.tex\n*** End Patch')).toEqual(['a.tex', 'b.tex']);
		expect(toolDetail({ arguments: { input: '*** Begin Patch\n*** Update File: a.tex\n' }, result: 'ok' })).toMatchObject({ locations: [{ path: 'a.tex' }] });
		expect(toolDetail({ arguments: { cmd: 'ls' }, result: { output: 'x' } }).content).toEqual([{ type: 'content', content: { type: 'text', text: 'x' } }]);
	});

	it('settings → pickers: model only before the first turn, effort, Pro where offered, speed, and a "never asks" approvals row', () => {
		const catalog = { models: [{ id: 'sol', label: 'Sol', provider: 'openai', reasoning_modes: ['standard', 'pro'], effective_speeds: [], effort_fixed_after_start: false }], efforts: ['low' as const, 'high' as const], speeds: ['standard', 'fast'] };
		const fresh = configOptions({ model: 'gpt-6.1-sol', effort: 'high', reasoning_mode: 'standard', speed: 'standard', started: false }, catalog);
		expect(fresh.map(o => o.id)).toEqual(['model', 'effort', 'reasoning_mode', 'speed', 'approvals']);
		expect(fresh[0]).toMatchObject({ category: 'model', currentValue: 'sol' });
		const started = configOptions({ model: 'gpt-6.1-sol', effort: 'high', reasoning_mode: 'standard', speed: 'standard', started: true }, catalog);
		expect(started.map(o => o.id)).toEqual(['model', 'effort', 'speed', 'approvals']);
		expect((started[0] as { options: unknown[] }).options).toHaveLength(1);
	});

	it('prompt text keeps references in place and adds links not mentioned', () => {
		expect(promptText([{ type: 'text', text: 'fix @main.tex:L3' }, { type: 'resource_link', uri: 'file:///w/main.tex', name: 'main.tex:L3' }, { type: 'resource_link', uri: 'file:///w/b.tex', name: 'b.tex' }]))
			.toBe('fix @main.tex:L3\n\n@b.tex');
	});
});

describe('process helpers', () => {
	it('runs tact under script(1) with a pty', () => {
		expect(ptyCommand(['tact', '--workspace', '/a b'], 'linux')).toEqual({ command: 'script', args: ['-qfec', `tact --workspace '/a b'`, '/dev/null'] });
		expect(ptyCommand(['tact'], 'darwin')).toEqual({ command: 'script', args: ['-q', '/dev/null', 'tact'] });
	});

	it('recognizes tact\'s "not signed in" exit, from its terminal output', () => {
		const out = stripAnsi('\x1b[31mError:   × no ChatGPT credentials found at /x/auth.json and\n  │ OPENAI_API_KEY is not set; run `tact auth login` or set OPENAI_API_KEY\x1b[0m');
		expect(startFailure(out, 1).kind).toBe('auth');
		expect(startFailure('boom', 2).kind).toBe('exited');
	});

	it('parses SSE blocks, ignoring comments', () => {
		expect(parseEvent('event: draft\ndata: {"rev":2}')).toEqual({ event: 'draft', data: { rev: 2 } });
		expect(parseEvent(': keep-alive')).toBeUndefined();
	});

	it('checks for the web API in --help', () => {
		expect(hasWebApi(FAKE_TACT)).toBe(true);
		expect(hasWebApi('/bin/true')).toBe(false);
	});
});

describe('TactAgent on a fake tact (hidden pty, web API)', () => {
	let home: string;
	let ws: string;
	let agents: TactAgent[] = [];
	let updates: { sessionId: string; update: acp.SessionUpdate }[] = [];

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'tact-home-'));
		ws = mkdtempSync(join(tmpdir(), 'tact-ws-'));
		updates = [];
	});
	afterEach(async () => {
		agents.forEach(a => a.dispose());
		agents = [];
		await new Promise(r => setTimeout(r, 200));
		rmSync(home, { recursive: true, force: true });
		rmSync(ws, { recursive: true, force: true });
	});

	function agent(env: Record<string, string> = {}): TactAgent {
		const a = new TactAgent({ tact: FAKE_TACT, env: { TACT_HOME: home, ...env } }, async (sessionId, update) => { updates.push({ sessionId, update }); });
		agents.push(a);
		return a;
	}
	const text = (kind: string) => updates.filter(u => u.update.sessionUpdate === kind).map(u => (u.update as { content: { text: string } }).content.text).join('');

	it('session/new starts tact in a pty and returns its session and pickers; a prompt streams back and ends', async () => {
		const a = agent();
		const { sessionId, configOptions: options } = await a.newSession({ cwd: ws, mcpServers: [] });
		expect(sessionId).toMatch(/[0-9a-f-]{36}/);
		expect(options?.map(o => o.id)).toEqual(['model', 'effort', 'reasoning_mode', 'speed', 'approvals']);
		expect(options?.[0]).toMatchObject({ currentValue: 'gpt-6.1-sol', options: [{ value: 'gpt-6.1-sol', name: 'Sol' }, { value: 'gpt-6-luna', name: 'Luna' }] });
		const res = await a.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] });
		expect(res.stopReason).toBe('end_turn');
		expect(text('agent_message_chunk')).toBe('echo: hello');
		expect(text('agent_thought_chunk')).toBe('Thinking.');
		expect(updates.some(u => u.update.sessionUpdate === 'tool_call' && u.update.kind === 'execute')).toBe(true);
		// After the first turn the model is fixed.
		const last = updates.filter(u => u.update.sessionUpdate === 'config_option_update').at(-1)!.update as { configOptions: acp.SessionConfigOption[] };
		expect(last.configOptions.map(o => o.id)).not.toContain('reasoning_mode');
	});

	it('the harness edits files itself; the edit is a tool call with its path', async () => {
		writeFileSync(join(ws, 'main.tex'), 'old\n');
		const a = agent();
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		await a.prompt({ sessionId, prompt: [{ type: 'text', text: 'edit main.tex' }] });
		expect(readFileSync(join(ws, 'main.tex'), 'utf8')).toBe('edited\n');
		expect(updates.find(u => u.update.sessionUpdate === 'tool_call')!.update).toMatchObject({ kind: 'edit', locations: [{ path: 'main.tex' }] });
	});

	it('set_config_option → tact\'s set_* command; tact\'s settings event updates the options', async () => {
		const a = agent();
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		const res = await a.setConfigOption({ sessionId, configId: 'effort', value: 'low' });
		expect(res.configOptions.find(o => o.id === 'effort')!.currentValue).toBe('low');
	});

	it('cancel interrupts the turn: stopReason cancelled', async () => {
		const a = agent();
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		const turn = a.prompt({ sessionId, prompt: [{ type: 'text', text: 'wait' }] });
		while (!text('agent_message_chunk')) {
			await new Promise(r => setTimeout(r, 20));
		}
		await a.cancel({ sessionId });
		expect((await turn).stopReason).toBe('cancelled');
	});

	it('an error entry (rejected API key) fails the prompt with tact\'s message', async () => {
		const a = agent();
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		await expect(a.prompt({ sessionId, prompt: [{ type: 'text', text: 'fail' }] })).rejects.toMatchObject({ message: expect.stringContaining('HTTP 401') });
	});

	it('not signed in: tact exits at start, reported as auth required', async () => {
		const a = agent({ FAKE_TACT_NOCREDS: '1' });
		await expect(a.newSession({ cwd: ws, mcpServers: [] })).rejects.toMatchObject({ code: -32000 });
	});

	it('two sessions are two tact processes; session/load restarts one with --resume and replays it', async () => {
		const a = agent();
		const one = await a.newSession({ cwd: ws, mcpServers: [] });
		const two = await a.newSession({ cwd: ws, mcpServers: [] });
		expect(one.sessionId).not.toBe(two.sessionId);
		expect(readdirSync(join(home, 'web', 'instances'))).toHaveLength(2);
		await a.prompt({ sessionId: one.sessionId, prompt: [{ type: 'text', text: 'remember me' }] });
		a.dispose();
		updates = [];
		const b = agent();
		await b.loadSession({ sessionId: one.sessionId, cwd: ws, mcpServers: [] });
		expect(updates.every(u => u.sessionId === one.sessionId)).toBe(true);
		expect(text('user_message_chunk')).toBe('remember me');
		expect(text('agent_message_chunk')).toBe('echo: remember me');
	});
});
