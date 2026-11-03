#!/usr/bin/env node
// A fake `tact` for the adapter tests: it must run in a terminal (like tact's TUI), registers in
// $TACT_HOME/web/instances/<pid>.json, writes the machine token, and serves the web API subset the adapter uses
// (protocol 10: /api/stream SSE, /api/cmd, /api/query, entry details). Prompts:
//   "edit <path>"  a tool entry (apply_patch) that writes "edited\n" to <path>, then an answer
//   "wait"         a running turn that only ends on interrupt
//   "fail"         an error entry (like a rejected API key)
//   "crash"        an error entry that isn't about credentials
//   "slow start"   the turn starts 300 ms after submit (interrupt says nothing_running until then)
//   anything else  reasoning, a streamed answer ("echo: <text>") in two revisions, an exec_command tool
// Env: FAKE_TACT_NOCREDS=1 → exits like tact without credentials. Sessions persist in $TACT_HOME/fake-sessions.
// Like tact, a model (or reasoning mode) change before the first turn replaces the session: 150 ms later the old one
// is `closed` and a new one (`claude-<uuid>` for Claude) is active; commands meanwhile are refused ("still
// starting"). The model `claude-broken` fails to start: tact keeps the old session and draws the reason in a box.
// The catalog has the Claude models when $TACT_HOME/config.toml has a [claude] section (read at start and at
// `reload_config`).
// At start it asks its terminal what it supports, as tact does (kitty keyboard, kitty graphics, cell size, device
// status, then DA1), and like tact on macOS it waits for the DA1 reply with no timeout before serving anything.
// The registration also records the pty's size and SHELL as tact saw them.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
if (argv[0] === '--help') {
	console.log('Usage: tact [OPTIONS]\n      --web <WEB>  Serve the web interface');
	process.exit(0);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.error('interactive mode requires terminal stdin and stdout');
	process.exit(2);
}
if (process.env.FAKE_TACT_NOCREDS === '1') {
	console.error('Error:   × no ChatGPT credentials found at /x/auth.json and\n  │ OPENAI_API_KEY is not set; run `tact auth login` or set OPENAI_API_KEY');
	process.exit(1);
}
const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const home = process.env.TACT_HOME;
const workspace = arg('--workspace') ?? process.cwd();
const store = join(home, 'fake-sessions');
mkdirSync(join(home, 'web', 'instances'), { recursive: true });
mkdirSync(store, { recursive: true });
const tokenFile = join(home, 'web', 'token');
if (!existsSync(tokenFile)) {
	writeFileSync(tokenFile, 'fake-token\n');
}
const token = readFileSync(tokenFile, 'utf8').trim();

// tact's start-up queries (crossterm, ratatui-image), and no web server until the terminal answered DA1.
await new Promise(resolve => {
	process.stdin.setRawMode(true);
	let answer = '';
	const onData = chunk => {
		answer += chunk.toString('latin1');
		if (/\x1b\[\?[\d;]*c/.test(answer)) {
			process.stdin.off('data', onData);
			process.stdin.pause();
			resolve();
		}
	};
	process.stdin.on('data', onData);
	process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[>7u\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[c\x1b[16t\x1b[5n\x1b]7;file://localhost/w\x1b\\');
});

const resume = arg('--resume');
let id = resume ?? randomUUID();
const saved = resume && existsSync(join(store, `${id}.json`)) ? JSON.parse(readFileSync(join(store, `${id}.json`), 'utf8')) : undefined;
const session = { id, title: saved?.title ?? 'New chat', model: saved?.model ?? 'gpt-6.1-sol', effort: 'high', reasoning_mode: 'standard', speed: 'standard', entries: saved?.entries ?? [], draft: { rev: 0, text: '' }, running: false };
const save = () => writeFileSync(join(store, `${id}.json`), JSON.stringify({ title: session.title, model: session.model, entries: session.entries }));
const configFile = join(home, 'config.toml');
const readClaude = () => existsSync(configFile) && /^\[claude\]/m.test(readFileSync(configFile, 'utf8'));
let claude = readClaude();
let starting = false;

const clients = new Set();
const send = (event, data) => { for (const res of clients) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } };
let nextId = session.entries.length;
let wake;
function upsert(entry) {
	const i = session.entries.findIndex(e => e.id === entry.id);
	if (i >= 0) { session.entries[i] = entry; } else { session.entries.push(entry); }
	save();
	send('entry', { session: id, entry });
}
const snapshot = () => ({ session: id, title: session.title, model: session.model, workspace, effort: session.effort, reasoning_mode: session.reasoning_mode, speed: session.speed, entries: session.entries, status: null, queue: [], draft: { ...session.draft, images: [] }, running: session.running, context: { active_tokens: 1000, window_tokens: 272000 }, subagents: { max_subagents: 32, agents: [] } });
const settings = () => send('settings', { session: id, model: session.model, effort: session.effort, reasoning_mode: session.reasoning_mode, speed: session.speed });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// tact's set_model: a new session on the model (or the old one kept, and why in the terminal).
async function replaceSession(model, mode) {
	starting = true;
	await sleep(150);
	starting = false;
	if (model === 'claude-broken') {
		process.stdout.write('\x1b[1;1H╭────╮\x1b[2;1H│\x1b[2;4H\x1b[1mCould not start a new session: invalid task request: Claude API-key authentication requires an\x1b[2;160H\x1b[22m│\x1b[3;1H│\x1b[3;58H\x1b[1mAnthropic API key\x1b[3;160H\x1b[22m│\x1b[4;1H╰────╯');
		return;
	}
	send('closed', { session: id });
	id = model.startsWith('claude-') ? `claude-${randomUUID()}` : randomUUID();
	session.model = model;
	session.reasoning_mode = mode;
	session.draft = { rev: 0, text: session.draft.text };
	save();
	send('live', { active: id, sessions: [{ id, title: session.title, model, workspace, state: 'idle' }] });
	send('active', { session: id });
	send('snapshot', snapshot());
}

async function turn(text) {
	session.running = true;
	upsert({ id: nextId++, revision: 1, parent: null, kind: 'user', text, images: 0 });
	if (session.title === 'New chat') {
		session.title = text.slice(0, 30);
		send('live', { active: id, sessions: [{ id, title: session.title, model: session.model, workspace, state: 'running' }] });
	}
	if (text === 'crash') {
		upsert({ id: nextId++, revision: 1, parent: null, kind: 'error', message: 'stream disconnected before completion' });
	} else if (text === 'slow start') {
		upsert({ id: nextId++, revision: 1, parent: null, kind: 'assistant', text: 'starting', complete: false, commentary: false });
		await new Promise(r => { wake = r; });
		upsert({ id: nextId++, revision: 1, parent: null, kind: 'interrupted', count: 1 });
	} else if (text === 'fail') {
		upsert({ id: nextId++, revision: 1, parent: null, kind: 'error', message: 'Responses WebSocket handshake was rejected with HTTP 401' });
	} else if (text === 'wait') {
		upsert({ id: nextId++, revision: 1, parent: null, kind: 'assistant', text: 'working', complete: false, commentary: false });
		await new Promise(r => { wake = r; });
		upsert({ id: nextId++, revision: 1, parent: null, kind: 'interrupted', count: 1 });
	} else if (text.startsWith('edit ')) {
		const path = text.slice(5).trim();
		const t = nextId++;
		upsert({ id: t, revision: 1, parent: null, kind: 'tool', name: 'apply_patch', summary: path, state: 'running', has_detail: true });
		writeFileSync(join(workspace, path), 'edited\n');
		upsert({ id: t, revision: 2, parent: null, kind: 'tool', name: 'apply_patch', summary: path, state: 'succeeded', has_detail: true });
		upsert({ id: nextId++, revision: 1, parent: null, kind: 'assistant', text: `edited ${path}`, complete: true, commentary: false });
		upsert({ id: nextId++, revision: 1, parent: null, kind: 'turn_completed', duration_ns: 1 });
	} else {
		upsert({ id: nextId++, revision: 1, parent: null, kind: 'reasoning', text: 'Thinking.' });
		const tool = nextId++;
		upsert({ id: tool, revision: 1, parent: null, kind: 'tool', name: 'exec_command', summary: 'ls', state: 'running', has_detail: true });
		upsert({ id: tool, revision: 2, parent: null, kind: 'tool', name: 'exec_command', summary: 'ls', state: 'succeeded', has_detail: true });
		const a = nextId++;
		upsert({ id: a, revision: 1, parent: null, kind: 'assistant', text: 'echo: ', complete: false, commentary: false });
		await sleep(20);
		upsert({ id: a, revision: 2, parent: null, kind: 'assistant', text: `echo: ${text}`, complete: true, commentary: false });
		upsert({ id: nextId++, revision: 1, parent: null, kind: 'turn_completed', duration_ns: 1 });
	}
	session.running = false;
	send('context', { session: id, active_tokens: 2000, window_tokens: 272000 });
}

const body = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => r(b ? JSON.parse(b) : {})); });
const reply = (res, status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };

const server = createServer(async (req, res) => {
	if (req.headers.cookie !== `tact=${token}`) {
		return reply(res, 401, { code: 'unauthorized', message: 'unauthorized' });
	}
	if (req.method === 'POST' && req.headers['x-tact'] !== '1') {
		return reply(res, 400, { code: 'invalid_request', message: 'missing X-Tact' });
	}
	if (req.url === '/api/stream') {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		clients.add(res);
		req.on('close', () => clients.delete(res));
		res.write(`event: hello\ndata: ${JSON.stringify({ protocol_version: 10, client_hint: 1 })}\n\n`);
		res.write(`event: active\ndata: ${JSON.stringify({ session: id })}\n\n`);
		res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
		return;
	}
	if (req.url === '/api/instance') {
		return reply(res, 200, { protocol_version: 10, workspace });
	}
	const detail = /^\/api\/sessions\/[^/]+\/entries\/(\d+)$/.exec(req.url ?? '');
	if (detail) {
		const e = session.entries.find(x => x.id === Number(detail[1]));
		return reply(res, 200, e?.name === 'apply_patch'
			? { arguments: { input: `*** Begin Patch\n*** Update File: ${e.summary}\n*** End Patch` }, result: 'Success', metadata: null }
			: { arguments: { cmd: 'ls' }, result: { output: 'a.txt\nb.txt' }, metadata: null });
	}
	if (req.url === '/api/query') {
		const q = await body(req);
		// The shape of tact 98ffe05's catalog: `effective_speeds` is indexed like `speeds` (Opus 5.5 runs Ultrafast as Fast).
		const claudeModels = [{ id: 'claude-opus-5-5', label: 'Opus 5.5', provider: 'anthropic', reasoning_modes: ['standard'], effective_speeds: ['standard', 'fast', 'fast'], effort_fixed_after_start: true }, { id: 'claude-haiku-5-5', label: 'Haiku 5.5', provider: 'anthropic', reasoning_modes: ['standard'], effective_speeds: ['standard', 'standard', 'standard'], effort_fixed_after_start: true }, { id: 'claude-broken', label: 'Broken', provider: 'anthropic', reasoning_modes: ['standard'], effective_speeds: ['standard', 'standard', 'standard'], effort_fixed_after_start: true }];
		if (q.query === 'models' && q.args !== undefined) {
			return reply(res, 400, { code: 'invalid_request', message: 'args: invalid type: map, expected unit variant Query::Models' });
		}
		if (q.query === 'models') {
			return reply(res, 200, {
				models: [{ id: 'gpt-6.1-sol', label: 'Sol', provider: 'openai', reasoning_modes: ['standard', 'pro'], effective_speeds: ['standard', 'fast', 'ultrafast'], effort_fixed_after_start: false }, { id: 'gpt-6-luna', label: 'Luna', provider: 'openai', reasoning_modes: ['standard'], effective_speeds: ['standard', 'fast', 'fast'], effort_fixed_after_start: false }, ...(claude ? claudeModels : [])],
				efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
				speeds: ['standard', 'fast', 'ultrafast'],
			});
		}
		return reply(res, 400, { code: 'invalid_request', message: 'unknown query' });
	}
	if (req.url === '/api/cmd') {
		const { cmd, args } = await body(req);
		if (cmd === 'reload_config') {
			claude = readClaude();
			return reply(res, 200, {});
		}
		if (args?.session !== undefined && args.session !== id) {
			return reply(res, 404, { code: 'unknown_session', message: 'unknown session' });
		}
		if (starting) {
			return reply(res, 400, { code: 'failed', message: 'the session is still starting' });
		}
		if (process.env.FAKE_TACT_REFUSE === cmd) {
			return reply(res, 400, { code: 'invalid_request', message: `${cmd} refused` });
		}
		switch (cmd) {
			case 'set_draft':
				session.draft = { rev: session.draft.rev + 1, text: args.text };
				send('draft', { session: id, rev: session.draft.rev, text: args.text, origin: 'web:1' });
				return reply(res, 200, {});
			case 'submit':
				if (args.rev !== session.draft.rev) {
					return reply(res, 409, { code: 'draft_changed', message: 'draft changed' });
				}
				reply(res, 200, {});
				if (session.draft.text === 'slow start') {
					setTimeout(() => void turn(session.draft.text), 300);
				} else {
					void turn(session.draft.text);
				}
				return;
			case 'interrupt':
				if (!session.running) {
					return reply(res, 409, { code: 'nothing_running', message: 'nothing running' });
				}
				wake?.();
				return reply(res, 200, {});
			case 'set_effort':
				if (session.entries.length && session.model.startsWith('claude-')) {
					return reply(res, 400, { code: 'invalid_request', message: 'effort is fixed once the session has started' });
				}
				session.effort = args.effort; settings(); return reply(res, 200, {});
			case 'set_speed': session.speed = args.speed; settings(); return reply(res, 200, {});
			case 'set_model':
				if (session.entries.length) {
					return reply(res, 400, { code: 'invalid_request', message: 'model is fixed' });
				}
				if (!args.model.startsWith('gpt-') && !(claude && args.model.startsWith('claude-'))) {
					return reply(res, 400, { code: 'invalid_request', message: `${args.model} is not available` });
				}
				if (args.model !== session.model) {
					void replaceSession(args.model, session.reasoning_mode);
				}
				return reply(res, 200, {});
			case 'set_reasoning_mode':
				if (session.entries.length) {
					return reply(res, 400, { code: 'invalid_request', message: 'the reasoning mode can only change before the first prompt' });
				}
				if (args.mode !== session.reasoning_mode) {
					void replaceSession(session.model, args.mode);
				}
				return reply(res, 200, {});
		}
		return reply(res, 400, { code: 'invalid_request', message: `unknown command ${cmd}` });
	}
	reply(res, 404, { code: 'failed', message: 'not found' });
});

server.listen(0, '127.0.0.1', () => {
	const registration = join(home, 'web', 'instances', `${process.pid}.json`);
	writeFileSync(registration, JSON.stringify({ pid: process.pid, port: server.address().port, workspace, started_at: Math.floor(Date.now() / 1000), fake: { rows: process.stdout.rows, cols: process.stdout.columns, shell: process.env.SHELL ?? null } }));
	const bye = () => { rmSync(registration, { force: true }); process.exit(0); };
	process.on('SIGTERM', bye);
	process.on('SIGHUP', bye);
	process.stdout.write('\x1b[2J\x1b[Hfake tact TUI\n');
});
