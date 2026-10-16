import { chmodSync, closeSync, mkdtempSync, readSync, writeSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import { TactAgent } from '../src/agent.js';
import { configOptions, EntryMapper, isAuthError, pathsIn, promptText, sessionStartFailure, toolDetail } from '../src/mapping.js';
import { hasWebApi, launchTact, openFifo, ptyCommand, startFailure, stripAnsi } from '../src/process.js';
import { reply, TerminalResponder } from '../src/terminal.js';
import { parseEvent, TactApiError } from '../src/web.js';

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
			.toMatchObject([{ kind: 'edit', status: 'completed', title: 'Edit main.tex', locations: [{ path: 'main.tex' }] }]);
		// With the workspace: absolute paths; tact's patch stats in the title; a command's output tail as content.
		const w = new EntryMapper('/w');
		expect(w.map({ id: 1, revision: 1, parent: null, kind: 'tool', name: 'apply_patch', summary: 'src/a.rs, b.rs', state: 'succeeded', stats: { files: 2, additions: 3, deletions: 1 } }))
			.toMatchObject([{ title: 'Edit src/a.rs, b.rs (+3 −1)', locations: [{ path: '/w/src/a.rs' }, { path: '/w/b.rs' }] }]);
		// A Code Mode cell that turns out to be an apply_patch: the update carries the new kind and name.
		expect(w.map({ id: 9, revision: 1, parent: null, kind: 'tool', name: 'exec', summary: '0 emitted items', state: 'running' })).toMatchObject([{ sessionUpdate: 'tool_call', kind: 'other', name: 'exec' }]);
		expect(w.map({ id: 9, revision: 2, parent: null, kind: 'tool', name: 'apply_patch', summary: 'notes.txt', state: 'succeeded', stats: { files: 1, additions: 1, deletions: 0 } }))
			.toEqual([{ sessionUpdate: 'tool_call_update', toolCallId: 't9', title: 'Edit notes.txt (+1 −0)', status: 'completed', kind: 'edit', name: 'apply_patch', locations: [{ path: '/w/notes.txt' }] }]);
		expect(w.map({ id: 2, revision: 1, parent: null, kind: 'tool', name: 'exec_command', summary: 'make', state: 'failed', outcome: { exit_code: 2, tail: ['error: x'], summary: null } }))
			.toMatchObject([{ title: 'make', content: [{ type: 'content', content: { type: 'text', text: 'error: x' } }] }]);
		expect(new EntryMapper().map({ id: 0, revision: 1, parent: null, kind: 'user', text: 'hi' }, true)).toMatchObject([{ sessionUpdate: 'user_message_chunk', content: { text: 'hi' } }]);
	});

	it('a turn ends with its own turn_completed / interrupted / error entry, not an earlier turn\'s', () => {
		const m = new EntryMapper();
		m.map({ id: 5, revision: 1, parent: null, kind: 'turn_completed', duration_ns: 1 });
		m.baseline = m.lastId;
		expect(m.turnEnd({ id: 5, revision: 1, parent: null, kind: 'turn_completed', duration_ns: 1 })).toBeUndefined();
		expect(m.turnEnd({ id: 6, revision: 1, parent: null, kind: 'interrupted', count: 1 })).toEqual({ kind: 'interrupted' });
		expect(m.turnEnd({ id: 7, revision: 1, parent: null, kind: 'error', message: 'HTTP 401' })).toEqual({ kind: 'error', message: 'HTTP 401' });
		expect(m.turnEnd({ id: 8, revision: 1, parent: null, kind: 'error', message: 'handshake was rejected with HTTP 401: {\n  "error": {' })).toEqual({ kind: 'error', message: 'handshake was rejected with HTTP 401' });
	});

	it('tool details: patch paths, command output', () => {
		expect(pathsIn('*** Begin Patch\n*** Update File: a.tex\n*** Add File: b.tex\n*** End Patch')).toEqual(['a.tex', 'b.tex']);
		expect(pathsIn('src/a.rs, b.rs')).toEqual(['src/a.rs', 'b.rs']);
		expect(pathsIn('3 arguments')).toEqual([]);
		expect(toolDetail({ arguments: { input: '*** Begin Patch\n*** Update File: a.tex\n' }, result: 'ok' })).toMatchObject({ locations: [{ path: 'a.tex' }] });
		expect(toolDetail({ arguments: { cmd: 'ls' }, result: { output: 'x' } }).content).toEqual([{ type: 'content', content: { type: 'text', text: 'x' } }]);
	});

	it('settings → pickers: model only before the first turn, effort, Pro where offered, speed; no approvals (tact has none)', () => {
		const catalog = { models: [{ id: 'sol', label: 'Sol', provider: 'openai', reasoning_modes: ['standard', 'pro'], effective_speeds: [], effort_fixed_after_start: false }], efforts: ['low' as const, 'high' as const], speeds: ['standard', 'fast'] };
		const fresh = configOptions({ model: 'gpt-6.1-sol', effort: 'high', reasoning_mode: 'standard', speed: 'standard', started: false }, catalog);
		expect(fresh.map(o => o.id)).toEqual(['model', 'effort', 'reasoning_mode', 'speed']);
		expect(fresh[0]).toMatchObject({ category: 'model', currentValue: 'sol' });
		const started = configOptions({ model: 'gpt-6.1-sol', effort: 'high', reasoning_mode: 'standard', speed: 'standard', started: true }, catalog);
		expect(started.map(o => o.id)).toEqual(['model', 'effort', 'speed']);
		expect(fresh.some(o => o.category === 'mode')).toBe(false);
		expect((started[0] as { options: unknown[] }).options).toHaveLength(1);
	});

	it('prompt text keeps references in place and adds links not mentioned', () => {
		expect(promptText([{ type: 'text', text: 'fix @main.tex:L3' }, { type: 'resource_link', uri: 'file:///w/main.tex', name: 'main.tex:L3' }, { type: 'resource_link', uri: 'file:///w/b.tex', name: 'b.tex' }]))
			.toBe('fix @main.tex:L3\n\n@b.tex');
	});
});

describe('process helpers', () => {
	it('runs tact under script(1) with a sized pty; script\'s stdin a FIFO on Linux, a real pipe (bash) on macOS', () => {
		expect(ptyCommand(['tact', '--workspace', '/a b'], 'linux', '/usr/bin/fish')).toEqual({
			command: 'script',
			args: ['-qfec', `stty rows 48 columns 160 2>/dev/null; SHELL=/usr/bin/fish exec tact --workspace '/a b'`, '/dev/null'],
			env: { SHELL: '/bin/sh' },
			stdin: 'fifo',
		});
		expect(ptyCommand(['tact'], 'linux', undefined).args[1]).toBe('stty rows 48 columns 160 2>/dev/null; unset SHELL; exec tact');
		expect(ptyCommand(['tact', '--workspace', '/a b'], 'darwin')).toEqual({
			command: '/bin/bash',
			args: ['-c', 'exec script -q /dev/null /bin/sh -c "$0" sh "$@" < <(exec cat 2>/dev/null)', 'stty rows 48 columns 160 2>/dev/null; exec "$@"', 'tact', '--workspace', '/a b'],
			env: {},
			stdin: 'pipe',
		});
	});

	it('opens a FIFO without blocking; the read end ends when the adapter\'s write end closes', () => {
		const fifo = openFifo()!;
		writeSync(fifo.write, 'x');
		closeSync(fifo.write);
		const buf = Buffer.alloc(4);
		expect(readSync(fifo.read, buf)).toBe(1);
		expect(readSync(fifo.read, buf)).toBe(0); // EOF
		closeSync(fifo.read);
	});

	it('watches the adapter: a watcher in the pty\'s shell ends tact once the adapter is gone', () => {
		expect(ptyCommand(['tact'], 'darwin', undefined, 42).args[2]).toBe('stty rows 48 columns 160 2>/dev/null; (while kill -0 42 2>/dev/null && kill -0 $$ 2>/dev/null; do sleep 2; done; kill -TERM $$ 2>/dev/null) </dev/null >/dev/null 2>&1 & exec "$@"');
	});

	it('recognizes tact\'s "not signed in" exit, from its terminal output', () => {
		const out = stripAnsi('\x1b[31mError:   × no ChatGPT credentials found at /x/auth.json and\n  │ OPENAI_API_KEY is not set; run `tact auth login` or set OPENAI_API_KEY\x1b[0m');
		expect(startFailure(out, 1).kind).toBe('auth');
		expect(startFailure('boom', 2).kind).toBe('exited');
	});

	it('strips every escape sequence from tact\'s output (CSI with private parameters, OSC, APC, DCS), and BSD script\'s ^D', () => {
		// What tact printed on Guru's Mac: kitty keyboard push and kitty graphics query leaked through.
		const mac = '^D\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[>7u\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[c\x1b[16t\x1b[5n\x1b]7;file://localhost/w\x1b\\\x1b[?2026hError: boom\r\n\x1b[?2026l';
		expect(stripAnsi(mac)).toBe('Error: boom\n');
		expect(stripAnsi('a\x1bP>|x\x1b\\b\x1b(Bc\x1b=d\x1b]8;;http://x\x07e\x1b[38;2;1;2;3mf\x1b[<0;1;2M')).toBe('abcdef');
		// A sequence cut off at the end of the kept output.
		expect(stripAnsi('ok\x1b_Gi=31,s=1')).toBe('ok');
		expect(stripAnsi('ok\x1b[>7')).toBe('ok');
	});

	it('answers tact\'s terminal queries as a terminal without kitty support would', () => {
		expect(reply('\x1b[c')).toBe('\x1b[?62;22c');
		expect(reply('\x1b[>c')).toBe('\x1b[>1;10;0c');
		expect(reply('\x1b[5n')).toBe('\x1b[0n');
		expect(reply('\x1b[6n')).toBe('\x1b[1;1R');
		expect(reply('\x1b[16t')).toBe('\x1b[6;16;8t');
		expect(reply('\x1b[18t')).toBe('\x1b[8;48;160t');
		expect(reply('\x1b[14t')).toBe('\x1b[4;768;1280t');
		expect(reply('\x1b[?2026$p')).toBe('\x1b[?2026;0$y');
		expect(reply('\x1b]11;?\x1b\\')).toBe('\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\');
		// Unanswered: the DA1 reply that follows tells tact these aren't supported.
		expect(reply('\x1b[?u')).toBeUndefined();
		expect(reply('\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\')).toBeUndefined();
		// Not queries.
		expect(reply('\x1b[>7u')).toBeUndefined();
		expect(reply('\x1b[?1049h')).toBeUndefined();
		expect(reply('\x1b[2J')).toBeUndefined();
	});

	it('finds queries across output chunks, in order', () => {
		const out: string[] = [];
		const r = new TerminalResponder(d => out.push(d));
		r.feed('\x1b[?1049h\x1b[>7u\x1b_Gi=31,s=1,v=1,a=q');
		r.feed(',t=d,f=24;AAAA\x1b\\\x1b');
		r.feed('[c\x1b[16');
		r.feed('t\x1b[5nhello');
		expect(out.join('')).toBe('\x1b[?62;22c\x1b[6;16;8t\x1b[0n');
	});

	it('the auth errors tact reports at the first request', () => {
		expect(isAuthError('Responses WebSocket handshake was rejected with HTTP 401')).toBe(true);
		expect(isAuthError('access token has expired; refresh token was revoked')).toBe(true);
		expect(isAuthError('HTTP 500 from the Responses API')).toBe(false);
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

describe('starting tact in the hidden pty', () => {
	let home: string;
	let ws: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'tact-home-'));
		ws = mkdtempSync(join(tmpdir(), 'tact-ws-'));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(ws, { recursive: true, force: true });
	});

	it('answers tact\'s start-up queries, so a tact that waits for them comes up at once (the macOS 30 s timeout)', async () => {
		const started = Date.now();
		const tact = await launchTact({ tact: FAKE_TACT, cwd: ws, env: { TACT_HOME: home, SHELL: '/bin/bash' }, timeoutMs: 10_000 });
		try {
			expect(Date.now() - started).toBeLessThan(5_000);
			const registration = JSON.parse(readFileSync(join(home, 'web', 'instances', `${tact.pid}.json`), 'utf8')) as { fake: { rows: number; cols: number; shell: string } };
			// A real terminal size, and the user's SHELL for tact (not the /bin/sh script(1) got).
			expect(registration.fake).toEqual({ rows: 48, cols: 160, shell: '/bin/bash' });
			// The output log has none of the escape sequences tact wrote.
			expect(tact.output()).not.toMatch(/\x1b|\[>7u|_Gi=31|\^D/);
			expect(tact.output()).toContain('fake tact TUI');
		} finally {
			tact.kill();
			await tact.exited;
		}
	});

	it.skipIf(process.platform !== 'linux')('the macOS launch (BSD script refuses a socket stdin), run through a shim: answered, and up at once', async () => {
		const shim = fileURLToPath(new URL('./fixtures/bsd-script', import.meta.url));
		chmodSync(join(shim, 'script'), 0o755);
		const tact = await launchTact({ tact: FAKE_TACT, cwd: ws, env: { TACT_HOME: home, PATH: `${shim}:${process.env.PATH}` }, timeoutMs: 10_000, platform: 'darwin' });
		try {
			const registration = JSON.parse(readFileSync(join(home, 'web', 'instances', `${tact.pid}.json`), 'utf8')) as { fake: { rows: number; cols: number } };
			expect(registration.fake).toMatchObject({ rows: 48, cols: 160 });
		} finally {
			tact.kill();
			expect(await Promise.race([tact.exited.then(() => 'exited'), new Promise(r => setTimeout(() => r('hung'), 8_000))])).toBe('exited');
		}
	}, 15_000);

	it('a tact whose adapter died (kill -9) doesn\'t stay behind', async () => {
		const adapter = spawn('sleep', ['60']);
		const tact = await launchTact({ tact: FAKE_TACT, cwd: ws, env: { TACT_HOME: home }, timeoutMs: 10_000, watch: adapter.pid });
		adapter.kill('SIGKILL');
		const exited = await Promise.race([tact.exited.then(() => true), new Promise(r => setTimeout(() => r(false), 8_000))]);
		if (!exited) {
			tact.kill();
		}
		expect(exited).toBe(true);
		expect(() => process.kill(tact.pid, 0)).toThrow();
	}, 15_000);
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
		expect(options?.map(o => o.id)).toEqual(['model', 'effort', 'reasoning_mode', 'speed']);
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
		expect(updates.find(u => u.update.sessionUpdate === 'tool_call')!.update).toMatchObject({ kind: 'edit', locations: [{ path: join(ws, 'main.tex') }] });
	});

	it('set_config_option → tact\'s set_* command; tact\'s settings event updates the options', async () => {
		const a = agent();
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		const res = await a.setConfigOption({ sessionId, configId: 'effort', value: 'low' });
		expect(res.configOptions.find(o => o.id === 'effort')!.currentValue).toBe('low');
	});

	it('a model picked on a new chat and sent at once: tact\'s new session gets the message; the chat keeps its id, also after a restart', async () => {
		writeFileSync(join(home, 'config.toml'), '[claude]\nenabled = true\n');
		const a = agent();
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		const set = await a.setConfigOption({ sessionId, configId: 'model', value: 'claude-opus-5-5' });
		expect(set.configOptions.find(o => o.id === 'model')!.currentValue).toBe('claude-opus-5-5');
		expect((await a.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] })).stopReason).toBe('end_turn');
		expect(text('agent_message_chunk')).toBe('echo: hello');
		expect(updates.every(u => u.sessionId === sessionId)).toBe(true);
		const tactId = JSON.parse(readFileSync(join(home, 'editor-sessions.json'), 'utf8'))[sessionId];
		expect(tactId).toMatch(/^claude-/);

		a.dispose();
		await new Promise(r => setTimeout(r, 200));
		updates = [];
		const b = agent();
		const loaded = await b.loadSession({ sessionId, cwd: ws, mcpServers: [] });
		expect(loaded.configOptions?.find(o => o.id === 'model')!.currentValue).toBe('claude-opus-5-5');
		expect(text('user_message_chunk')).toBe('hello');
	});

	it('a reasoning mode change also waits for the new session', async () => {
		const a = agent();
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		const set = await a.setConfigOption({ sessionId, configId: 'reasoning_mode', value: 'pro' });
		expect(set.configOptions.find(o => o.id === 'reasoning_mode')!.currentValue).toBe('pro');
		expect((await a.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })).stopReason).toBe('end_turn');
	});

	it('a model tact can\'t start a session on: the change fails with the reason tact shows in its terminal', async () => {
		writeFileSync(join(home, 'config.toml'), '[claude]\nenabled = true\n');
		const a = agent();
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		await expect(a.setConfigOption({ sessionId, configId: 'model', value: 'claude-broken' }))
			.rejects.toMatchObject({ code: -32603, message: 'couldn\'t start the Broken session: invalid task request: Claude API-key authentication requires an Anthropic API key' });
		// The old session is still there.
		expect((await a.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] })).stopReason).toBe('end_turn');
	});

	it('a request tact refuses fails with its message, status and code, not a bare "Internal error"', async () => {
		const a = agent();
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		await expect(a.setConfigOption({ sessionId, configId: 'model', value: 'claude-opus-5-5' }))
			.rejects.toMatchObject({ code: -32603, message: 'refused the request: claude-opus-5-5 is not available (set_model: HTTP 400 invalid_request)' });
	});

	it('a Claude key added to tact\'s config while it runs: reload_config, and the Claude models are offered', async () => {
		const a = agent();
		const { sessionId, configOptions } = await a.newSession({ cwd: ws, mcpServers: [] });
		const models = (o: acp.SessionConfigOption[] | null | undefined) => ((o?.find(x => x.id === 'model') as { options: { value: string }[] }).options).map(x => x.value);
		expect(models(configOptions)).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
		writeFileSync(join(home, 'config.toml'), '[claude]\nenabled = true\n');
		const update = () => updates.find(u => u.sessionId === sessionId && u.update.sessionUpdate === 'config_option_update' && models(u.update.configOptions).includes('claude-opus-5-5'));
		for (let i = 0; i < 50 && !update(); i++) {
			await new Promise(r => setTimeout(r, 50));
		}
		expect(update()).toBeDefined();
	});

	it('a model the catalog didn\'t have at start: the catalog is fetched again before the change', async () => {
		const a = new TactAgent({ tact: FAKE_TACT, env: { TACT_HOME: home }, watchConfig: false }, async (sessionId, update) => { updates.push({ sessionId, update }); });
		agents.push(a);
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		writeFileSync(join(home, 'config.toml'), '[claude]\nenabled = true\n');
		const set = await a.setConfigOption({ sessionId, configId: 'model', value: 'claude-opus-5-5' });
		expect(set.configOptions.find(o => o.id === 'model')!.currentValue).toBe('claude-opus-5-5');
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

	it('a rejected sign-in at the first request (HTTP 401) is auth required, with tact\'s message', async () => {
		const a = agent();
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		await expect(a.prompt({ sessionId, prompt: [{ type: 'text', text: 'fail' }] })).rejects.toMatchObject({ code: -32000, message: expect.stringContaining('HTTP 401') });
	});

	it('another error entry fails the prompt with tact\'s own message', async () => {
		const a = agent();
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		await expect(a.prompt({ sessionId, prompt: [{ type: 'text', text: 'crash' }] })).rejects.toMatchObject({ code: -32603, message: 'stream disconnected before completion' });
	});

	it('Stop before tact started the turn still stops it', async () => {
		const a = agent();
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		// "slow start": tact takes a moment before the turn runs (interrupt answers nothing_running until then).
		const turn = a.prompt({ sessionId, prompt: [{ type: 'text', text: 'slow start' }] });
		await new Promise(r => setTimeout(r, 30));
		await a.cancel({ sessionId });
		expect((await turn).stopReason).toBe('cancelled');
	});

	it('a tact that exited is started again (--resume) on the next prompt', async () => {
		const a = agent();
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		await a.prompt({ sessionId, prompt: [{ type: 'text', text: 'one' }] });
		const pid = Number(readdirSync(join(home, 'web', 'instances'))[0]!.replace('.json', ''));
		process.kill(pid, 'SIGTERM');
		while (readdirSync(join(home, 'web', 'instances')).length) {
			await new Promise(r => setTimeout(r, 20));
		}
		await new Promise(r => setTimeout(r, 100));
		updates = [];
		expect((await a.prompt({ sessionId, prompt: [{ type: 'text', text: 'two' }] })).stopReason).toBe('end_turn');
		expect(text('agent_message_chunk')).toBe('echo: two');
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

describe('tact\'s errors', () => {
	it('reads the reason of a failed session start out of tact\'s terminal output', () => {
		const raw = '\x1b[?2026h\x1b[1;1H\x1b[;m╭──────╮\x1b[2;1H│\x1b[2;4H\x1b[1mCould not start a new session: invalid task request: Claude API-key authentication requires an Anthropic API key (sk-ant-api... or sk-ant-usr-...); Claude\x1b[2;160H\x1b[22m│\x1b[3;1H│\x1b[3;58H\x1b[1msubscription and OAuth tokens are not supported\x1b[3;160H\x1b[22m│\x1b[4;1H╰──────╯\x1b[44;12H';
		expect(sessionStartFailure(raw)).toBe('invalid task request: Claude API-key authentication requires an Anthropic API key (sk-ant-api... or sk-ant-usr-...); Claude subscription and OAuth tokens are not supported');
		expect(sessionStartFailure('Could not start a new session: half')).toBeUndefined();
		expect(sessionStartFailure('nothing')).toBeUndefined();
	});

	it('a web API refusal names the request, HTTP status and code', () => {
		expect(new TactApiError(404, 'unknown_session', 'unknown session', 'set_draft').describe()).toBe('unknown session (set_draft: HTTP 404 unknown_session)');
		expect(new TactApiError(500, 'failed', 'HTTP 500').describe()).toBe('HTTP 500 (HTTP 500)');
	});
});
