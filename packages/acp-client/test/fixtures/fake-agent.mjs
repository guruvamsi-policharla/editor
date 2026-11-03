// A scriptable ACP agent over stdio for unit tests. The prompt text picks the behavior:
//   "hi"          misbehaves on purpose: calls fs/read_text_file (never advertised), asks permission, reports both
//   "stream"      one of every session/update kind, plus an unknown kind and an `_`-prefixed extension notification
//   "permission"  asks permission for a shell command and replies with the outcome
//   "wait"        streams a chunk, then waits for session/cancel and ends with stopReason "cancelled"
//   "crash"       exits the process mid-turn
//   "slow"        streams a chunk, waits 1.5 s (or for session/cancel), then ends
//   "edit <path>" reports an edit tool call for <path> (locations), writes "edited\n" to it, and ends
// Env: FAKE_AUTH=1 → session/new fails with authRequired. FAKE_NO_RESUME=1 → no resume capability.
// FAKE_NO_LOAD=1 → no loadSession/list capability. FAKE_STORE=<dir> → sessions (with their history, replayed by
// session/load) are kept in <dir>/sessions.json, so they survive a restart. FAKE_RESUME_MODE=<mode> → session/resume
// and session/load come back in that mode (default: default). FAKE_NEW_MODE=<mode> → session/new starts in it. FAKE_REJECT=<id>=<value>[,…] → set_config_option
// refuses those values.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
let clientCapabilities;
let nextSession = 1;
const sessions = new Map();
const cancels = new Map();
/** sessionId → { cwd, title, updatedAt, history: SessionUpdate[] } */
const stored = new Map();
const storeFile = process.env.FAKE_STORE ? join(process.env.FAKE_STORE, 'sessions.json') : undefined;
if (storeFile && existsSync(storeFile)) {
	for (const [id, v] of Object.entries(JSON.parse(readFileSync(storeFile, 'utf8')))) {
		stored.set(id, v);
	}
}
function save() {
	if (storeFile) {
		mkdirSync(process.env.FAKE_STORE, { recursive: true });
		writeFileSync(storeFile, JSON.stringify(Object.fromEntries(stored)));
	}
}

function options(state) {
	const list = [
		{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: state.mode, options: [{ value: 'default', name: 'Manual' }, { value: 'acceptEdits', name: 'Accept edits' }, { value: 'plan', name: 'Plan' }] },
		{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: state.model, options: [{ value: 'big', name: 'Big' }, { value: 'small', name: 'Small' }] },
	];
	// Effort exists only for models that support it (an option that comes and goes with the model).
	if (state.model === 'big') {
		list.push({ id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: state.effort, options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] });
	}
	list.push({ id: 'flag', name: 'Flag', type: 'boolean', currentValue: true });
	return list;
}

const connection = acp.agent({ name: 'fake-agent' })
	.onRequest(acp.methods.agent.initialize, async ctx => {
		clientCapabilities = ctx.params.clientCapabilities;
		return {
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: !process.env.FAKE_NO_LOAD,
				sessionCapabilities: { ...(process.env.FAKE_NO_RESUME ? {} : { resume: {}, close: {} }), ...(process.env.FAKE_NO_LOAD ? {} : { list: {} }) },
			},
			authMethods: [],
			agentInfo: { name: 'fake-agent', version: '1.0.0' },
		};
	})
	.onRequest(acp.methods.agent.session.new, async ctx => {
		if (process.env.FAKE_AUTH === '1') {
			throw acp.RequestError.authRequired();
		}
		const sessionId = `s${process.pid}-${nextSession++}`;
		const state = { mode: process.env.FAKE_NEW_MODE ?? 'default', model: 'big', effort: 'high', meta: ctx.params._meta };
		sessions.set(sessionId, state);
		stored.set(sessionId, { cwd: ctx.params.cwd, title: null, updatedAt: new Date().toISOString(), history: [] });
		save();
		return { sessionId, configOptions: options(state) };
	})
	.onRequest(acp.methods.agent.session.list, async ctx => ({
		sessions: [...stored].filter(([, v]) => !ctx.params.cwd || v.cwd === ctx.params.cwd)
			.map(([sessionId, v]) => ({ sessionId, cwd: v.cwd, title: v.title, updatedAt: v.updatedAt })),
	}))
	.onRequest(acp.methods.agent.session.load, async ctx => {
		const entry = stored.get(ctx.params.sessionId);
		if (!entry) {
			throw acp.RequestError.resourceNotFound(ctx.params.sessionId);
		}
		for (const update of entry.history) {
			await connection.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update });
		}
		const state = { mode: process.env.FAKE_RESUME_MODE ?? 'default', model: 'big', effort: 'high', loaded: true };
		sessions.set(ctx.params.sessionId, state);
		return { configOptions: options(state) };
	})
	.onRequest(acp.methods.agent.session.resume, async ctx => {
		const state = { mode: process.env.FAKE_RESUME_MODE ?? 'default', model: 'big', effort: 'high', resumed: true };
		sessions.set(ctx.params.sessionId, state);
		return { configOptions: options(state) };
	})
	.onRequest(acp.methods.agent.session.close, async () => ({}))
	.onRequest(acp.methods.agent.session.setConfigOption, async ctx => {
		const state = sessions.get(ctx.params.sessionId);
		if ((process.env.FAKE_REJECT ?? '').split(',').includes(`${ctx.params.configId}=${ctx.params.value}`)) {
			throw acp.RequestError.invalidParams(undefined, `${ctx.params.configId}=${ctx.params.value} isn't available`);
		}
		state[ctx.params.configId] = ctx.params.value;
		return { configOptions: options(state) };
	})
	.onNotification(acp.methods.agent.session.cancel, async ctx => {
		cancels.get(ctx.params.sessionId)?.();
	})
	.onRequest(acp.methods.agent.session.prompt, async ctx => {
		const client = connection.client;
		const sessionId = ctx.params.sessionId;
		const text = ctx.params.prompt.map(b => (b.type === 'text' ? b.text : '')).join('');
		const entry = stored.get(sessionId);
		const update = u => {
			if (entry) {
				entry.history.push(u);
				if (u.sessionUpdate === 'session_info_update' && u.title) {
					entry.title = u.title;
				}
				entry.updatedAt = new Date().toISOString();
				save();
			}
			return client.notify(acp.methods.client.session.update, { sessionId, update: u });
		};
		if (entry) {
			for (const block of ctx.params.prompt) {
				entry.history.push({ sessionUpdate: 'user_message_chunk', content: block.type === 'text' ? block : { type: 'text', text: `@${block.name ?? block.uri}` } });
			}
			entry.title ??= text.slice(0, 40);
			save();
		}

		if (text === 'hi') {
			let fsError;
			try {
				await client.request('fs/read_text_file', { sessionId, path: '/etc/hostname' });
			} catch (e) {
				fsError = e.code;
			}
			const permission = await client.request(acp.methods.client.session.requestPermission, {
				sessionId,
				toolCall: { toolCallId: 't1', title: 'Run `true`', kind: 'execute' },
				options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }, { optionId: 'no', name: 'No', kind: 'reject_once' }],
			});
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ fsError, clientCapabilities, permission }) } });
			return { stopReason: 'end_turn' };
		}
		if (text === 'stream') {
			await update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact' }] });
			await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking ' } });
			await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hard.' } });
			await update({ sessionUpdate: 'plan', entries: [{ content: 'Read', priority: 'high', status: 'completed' }, { content: 'Edit', priority: 'medium', status: 'in_progress' }] });
			await update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Terminal', kind: 'execute', status: 'pending', rawInput: {} });
			await update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: 'ls', rawInput: { command: 'ls' } });
			await update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '```console\na.txt\n```' } }] });
			await client.notify('_fake/extension', { anything: true });
			await update({ sessionUpdate: 'some_future_kind', payload: 1 });
			await update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hello ' } });
			await update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'world' } });
			sessions.get(sessionId).mode = 'plan';
			await update({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
			await update({ sessionUpdate: 'session_info_update', title: 'A title' });
			await update({ sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0.01, currency: 'USD' } });
			sessions.get(sessionId).model = 'small';
			await update({ sessionUpdate: 'config_option_update', configOptions: options(sessions.get(sessionId)) });
			return { stopReason: 'end_turn' };
		}
		if (text === 'permission') {
			await update({ sessionUpdate: 'tool_call', toolCallId: 'p1', title: 'rm -rf build', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf build', description: 'Clean' } });
			const permission = await client.request(acp.methods.client.session.requestPermission, {
				sessionId,
				toolCall: { toolCallId: 'p1', title: 'rm -rf build', kind: 'execute', rawInput: { command: 'rm -rf build', description: 'Clean' } },
				options: [
					{ optionId: 'always', name: 'Yes, always', kind: 'allow_always' },
					{ optionId: 'no', name: 'No', kind: 'reject_once' },
					{ optionId: 'yes', name: 'Yes', kind: 'allow_once' },
				],
			});
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(permission) } });
			return { stopReason: permission.outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn' };
		}
		if (text === 'wait') {
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
			await new Promise(resolve => cancels.set(sessionId, resolve));
			return { stopReason: 'cancelled' };
		}
		if (text === 'slow') {
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working slowly' } });
			const cancelled = await new Promise(resolve => {
				cancels.set(sessionId, () => resolve(true));
				setTimeout(() => resolve(false), 1500);
			});
			return { stopReason: cancelled ? 'cancelled' : 'end_turn' };
		}
		if (text.startsWith('edit ')) {
			const path = text.slice(5).trim();
			await update({ sessionUpdate: 'tool_call', toolCallId: `e${Date.now()}`, title: `Edit ${path}`, kind: 'edit', status: 'completed', locations: [{ path }] });
			writeFileSync(path, 'edited\n');
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `edited ${path}` } });
			return { stopReason: 'end_turn' };
		}
		if (text === 'crash') {
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'bye' } });
			setTimeout(() => process.exit(3), 20);
			return new Promise(() => { });
		}
		if (text === 'meta') {
			await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ state: sessions.get(sessionId), prompt: ctx.params.prompt }) } });
			return { stopReason: 'end_turn' };
		}
		await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${text}` } });
		return { stopReason: 'end_turn' };
	})
	.connect(stream);
