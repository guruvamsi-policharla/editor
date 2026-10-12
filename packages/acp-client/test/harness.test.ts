import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	AgentSupervisor, CLAUDE, HarnessClient, isAuthRequired, optionValues, PermissionBroker, PermissionNotRestoredError, textOf, withValues,
	type AgentStatus, type Change, type HarnessProfile, type PermissionPrompt,
} from '../src/index.js';

const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
const PROFILE: HarnessProfile = { ...CLAUDE, id: 'fake', label: 'Fake' };

let clients: HarnessClient[] = [];
afterEach(async () => {
	await Promise.all(clients.map(c => c.dispose()));
	clients = [];
});

function harness(env: Record<string, string> = {}, opts: { sleeps?: number[]; maxCrashes?: number } = {}) {
	let launches = 0;
	const supervisor = new AgentSupervisor({
		launch: async () => { launches++; return { command: process.execPath, args: [FAKE_AGENT], env }; },
		sleep: async ms => { opts.sleeps?.push(ms); },
		maxCrashes: opts.maxCrashes,
	});
	const client = new HarnessClient(PROFILE, supervisor, process.cwd(), new PermissionBroker());
	clients.push(client);
	return { client, supervisor, launches: () => launches };
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) {
			throw new Error('timed out');
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

function lastText(changes: Change[]): string {
	return changes.filter(c => c.kind === 'text' && c.role === 'agent').map(c => (c.kind === 'text' ? c.delta : '')).join('');
}

describe('HarnessClient on a fake agent', () => {
	it('starts lazily, passes the profile\'s session meta, and applies its defaults', async () => {
		const { client, supervisor, launches } = harness();
		expect(launches()).toBe(0);
		expect(supervisor.status.state).toBe('stopped');
		const session = await client.newSession();
		expect(launches()).toBe(1);
		expect(supervisor.status).toMatchObject({ state: 'ready', agentInfo: { name: 'fake-agent' } });
		expect(session.view.state.modeId).toBe('acceptEdits');
		const changes: Change[] = [];
		session.onChange(c => changes.push(c));
		await session.prompt('meta');
		const seen = JSON.parse(lastText(changes));
		// Bypass is allowed at launch (the adapter's --allow-dangerously-skip-permissions), but the session isn't in it.
		expect(seen.state.meta).toEqual({ claudeCode: { options: { allowDangerouslySkipPermissions: true } } });
		expect(seen.state.mode).toBe('acceptEdits');
	});

	it('routes every update kind through the reducer and tolerates unknown ones', async () => {
		const { client } = harness();
		const session = await client.newSession();
		const kinds: string[] = [];
		session.onChange(c => kinds.push(c.kind));
		const res = await session.prompt([{ type: 'text', text: 'stream' }]);
		expect(res.stopReason).toBe('end_turn');
		const s = session.view.state;
		expect(textOf(s, 'thought')).toBe('Thinking hard.');
		expect(textOf(s, 'agent')).toBe('Hello world');
		expect(s.toolCalls.get('c1')).toMatchObject({ title: 'ls', status: 'completed', rawInput: { command: 'ls' } });
		expect(s.plan.map(p => p.status)).toEqual(['completed', 'in_progress']);
		expect(s.title).toBe('A title');
		// The SDK drops the unknown kind and the `_fake/extension` notification at schema validation (it logs them);
		// the turn carries on. The reducer's own tolerance is covered in reducer.test.ts.
		expect(s.ignored).toBe(0);
		// the agent switched to a model without effort: the effort option is gone
		expect(s.configOptions.map(o => o.id)).toEqual(['mode', 'model', 'flag']);
		expect(new Set(kinds)).toEqual(new Set(['commands', 'text', 'plan', 'tool', 'mode', 'info', 'usage', 'config']));
	});

	it('set_config_option returns the complete list, which replaces the view\'s options', async () => {
		const { client } = harness();
		const session = await client.newSession();
		const options = await session.setOption('model', 'small');
		expect(options.map(o => o.id)).toEqual(['mode', 'model', 'flag']);
		expect(session.view.state.configOptions.find(o => o.id === 'model')!.currentValue).toBe('small');
	});

	it('permission prompts go to the attached UI in once/no/always order; the answer reaches the agent', async () => {
		const { client } = harness();
		const session = await client.newSession();
		const prompts: PermissionPrompt[] = [];
		client.broker.setAsker(session.id, async p => { prompts.push(p); return p.choices[0]!.optionId; });
		const changes: Change[] = [];
		session.onChange(c => changes.push(c));
		await session.prompt('permission');
		expect(prompts[0]!.command).toBe('rm -rf build');
		expect(prompts[0]!.choices.map(c => c.optionId)).toEqual(['yes', 'no', 'always']);
		expect(JSON.parse(lastText(changes))).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
	});

	it('Stop while a permission prompt is open: the prompt is cancelled and the turn ends cancelled', async () => {
		const { client } = harness();
		const session = await client.newSession();
		let asked!: () => void;
		const askedP = new Promise<void>(resolve => { asked = resolve; });
		client.broker.setAsker(session.id, () => { asked(); return new Promise(() => { }); });
		const turn = session.prompt('permission');
		await askedP;
		await session.cancel();
		expect((await turn).stopReason).toBe('cancelled');
		expect(client.broker.pendingCount(session.id)).toBe(0);
	});

	it('Stop mid-stream ends the turn with stopReason cancelled', async () => {
		const { client } = harness();
		const session = await client.newSession();
		const working = new Promise<void>(resolve => session.onChange(c => { if (c.kind === 'text') { resolve(); } }));
		const turn = session.prompt('wait');
		await working;
		await session.cancel();
		expect((await turn).stopReason).toBe('cancelled');
	});

	it('an adapter crash fails the turn; the next prompt restarts it (backoff) and resumes the session', async () => {
		const sleeps: number[] = [];
		const { client, supervisor, launches } = harness({}, { sleeps });
		const statuses: AgentStatus['state'][] = [];
		supervisor.onStatus(s => statuses.push(s.state));
		const session = await client.newSession();
		const id = session.id;
		await expect(session.prompt('crash')).rejects.toThrow();
		await waitFor(() => supervisor.status.state === 'exited');
		expect(supervisor.status).toMatchObject({ state: 'exited', code: 3, crashes: 1 });

		const changes: Change[] = [];
		session.onChange(c => changes.push(c));
		const { recovery } = await session.ensureLive();
		expect(recovery).toBe('resumed');
		expect(session.id).toBe(id);
		expect(launches()).toBe(2);
		expect(sleeps.length).toBe(1);
		expect(sleeps[0]).toBeGreaterThan(0);
		expect(sleeps[0]).toBeLessThanOrEqual(1000);
		await session.prompt('hello');
		expect(lastText(changes)).toBe('echo: hello');
		expect(statuses).toEqual(expect.arrayContaining(['starting', 'ready', 'exited']));
	});

	it('without resume or load support, recovery starts a new session (re-keyed)', async () => {
		const { client } = harness({ FAKE_NO_RESUME: '1', FAKE_NO_LOAD: '1' });
		const session = await client.newSession();
		const old = session.id;
		await expect(session.prompt('crash')).rejects.toThrow();
		const { recovery } = await session.ensureLive();
		expect(recovery).toBe('new');
		expect(session.id).not.toBe(old);
		expect(client.get(session.id)).toBe(session);
		expect(client.get(old)).toBeUndefined();
	});

	describe('Bypass permissions: allowed, never a default, never restored', () => {
		it('a chat in Bypass is saved with the mode it had before; switching modes moves that along', async () => {
			const { client } = harness();
			const session = await client.newSession();
			expect(session.keptValues()).toMatchObject({ mode: 'acceptEdits' });
			await session.setOption('mode', 'bypassPermissions');
			expect(session.inTransient()).toBe(true);
			expect(session.view.state.modeId).toBe('bypassPermissions');
			expect(session.keptValues()).toMatchObject({ mode: 'acceptEdits' });
			await session.setOption('mode', 'default');
			await session.setOption('mode', 'bypassPermissions');
			expect(session.keptValues()).toMatchObject({ mode: 'default' });
		});

		it('after an adapter restart, a chat that was in Bypass is back in its previous mode, and says so', async () => {
			const { client, supervisor } = harness({ FAKE_RESUME_MODE: 'bypassPermissions' });
			const session = await client.newSession();
			await session.setOption('mode', 'default');
			await session.setOption('mode', 'bypassPermissions');
			await supervisor.restart();
			const live = await session.ensureLive();
			expect(live.recovery).toBe('resumed');
			expect(live.left).toEqual([{ id: 'mode', value: 'bypassPermissions', to: 'default' }]);
			expect(live.settings?.permissionHeld).toBe(true);
			expect(session.view.state.modeId).toBe('default');
		});

		it('a new session never starts in Bypass, also when the agent starts it there (settings.json defaultMode)', async () => {
			const noDefaults: HarnessProfile = { ...PROFILE, defaults: {} };
			const supervisor = new AgentSupervisor({ launch: async () => ({ command: process.execPath, args: [FAKE_AGENT], env: { FAKE_NEW_MODE: 'bypassPermissions' } }), sleep: async () => { } });
			const client = new HarnessClient(noDefaults, supervisor, process.cwd(), new PermissionBroker());
			clients.push(client);
			const session = await client.newSession();
			expect(session.view.state.modeId).toBe('default');
		});

		it('a session that comes back in Bypass and can\'t leave it sends nothing', async () => {
			const { client, supervisor } = harness({ FAKE_RESUME_MODE: 'bypassPermissions', FAKE_REJECT: 'mode=acceptEdits,mode=default' });
			const session = await client.newSession();
			await supervisor.restart();
			await expect(session.prompt('meta')).rejects.toBeInstanceOf(PermissionNotRestoredError);
		});
	});

	describe('history (session/list, session/load, restore) across adapter restarts', () => {
		let store: string;
		beforeEach(() => { store = mkdtempSync(join(tmpdir(), 'fake-store-')); });
		afterEach(() => rmSync(store, { recursive: true, force: true }));

		async function earlier(): Promise<string> {
			const first = harness({ FAKE_STORE: store });
			const s = await first.client.newSession();
			await s.prompt('hello there');
			await first.client.dispose();
			return s.id;
		}

		it('session/list returns this workspace\'s sessions; session/load replays the conversation', async () => {
			const id = await earlier();
			const { client } = harness({ FAKE_STORE: store });
			const listed = await client.list();
			expect(listed.map(s => s.sessionId)).toEqual([id]);
			expect(listed[0]!.title).toBe('hello there');
			const session = await client.load(id);
			expect(textOf(session.view.state, 'user')).toBe('hello there');
			expect(textOf(session.view.state, 'agent')).toBe('echo: hello there');
			expect(session.view.state.configOptions.length).toBeGreaterThan(0);
		});

		it('a restored session starts nothing; its first prompt resumes it and continues', async () => {
			const id = await earlier();
			const { client, launches } = harness({ FAKE_STORE: store });
			const session = client.restore(id);
			expect(launches()).toBe(0);
			const changes: Change[] = [];
			session.onChange(c => changes.push(c));
			await session.prompt('again');
			expect(launches()).toBe(1);
			expect(session.id).toBe(id);
			expect(lastText(changes)).toBe('echo: again');
		});

		it('without resume, a restored session is loaded on its first prompt', async () => {
			const id = await earlier();
			const { client } = harness({ FAKE_STORE: store, FAKE_NO_RESUME: '1' });
			const session = client.restore(id);
			expect((await session.ensureLive()).recovery).toBe('loaded');
			expect(textOf(session.view.state, 'agent')).toBe('echo: hello there');
		});

		it('without resume but with load support, recovery reloads the session (replayed, flagged as replaying)', async () => {
			const { client } = harness({ FAKE_STORE: store, FAKE_NO_RESUME: '1' });
			const session = await client.newSession();
			const id = session.id;
			await expect(session.prompt('crash')).rejects.toThrow();
			const replayed: boolean[] = [];
			session.onChange(c => { if (c.kind === 'text') { replayed.push(session.replaying); } });
			const { recovery } = await session.ensureLive();
			expect(recovery).toBe('loaded');
			expect(session.id).toBe(id);
			expect(replayed.length).toBeGreaterThan(0);
			expect(replayed.every(Boolean)).toBe(true);
			expect(session.replaying).toBe(false);
		});

		it('a chat reopened after a restart gets its own mode and model back, although the agent resumes it in a looser mode (#33, #25)', async () => {
			const id = await earlier();
			const { client } = harness({ FAKE_STORE: store, FAKE_RESUME_MODE: 'acceptEdits' });
			const session = client.restore(id);
			const result = await session.applySettings({ mode: 'default', model: 'small' });
			expect(result).toMatchObject({ permissionHeld: true, failed: [] });
			expect(result.fellBackTo).toBeUndefined();
			expect(optionValues(session.view.state.configOptions)).toMatchObject({ mode: 'default', model: 'small' });
			const changes: Change[] = [];
			session.onChange(c => changes.push(c));
			await session.prompt('meta');
			expect(JSON.parse(lastText(changes)).state).toMatchObject({ mode: 'default', model: 'small', resumed: true });
		});

		it('a mode the agent refuses falls back to the strictest one offered, never to the looser one it resumed in (#33)', async () => {
			const id = await earlier();
			const { client } = harness({ FAKE_STORE: store, FAKE_RESUME_MODE: 'bypassPermissions', FAKE_REJECT: 'mode=acceptEdits' });
			const session = client.restore(id);
			const result = await session.applySettings({ mode: 'acceptEdits' });
			expect(result.failed.map(f => f.value)).toEqual(['acceptEdits']);
			// Out of Bypass already when the session came back (leaveTransient), so this is no looser than wanted.
			expect(result).toMatchObject({ permissionHeld: true });
			expect(session.view.state.modeId).toBe('default');
		});

		it('a saved mode the agent doesn\'t offer falls back to the strictest one (#33)', async () => {
			const id = await earlier();
			const { client } = harness({ FAKE_STORE: store, FAKE_RESUME_MODE: 'acceptEdits' });
			const session = client.restore(id);
			expect(await session.applySettings({ mode: 'dontAsk' })).toMatchObject({ fellBackTo: 'default', permissionHeld: true });
			expect(session.view.state.modeId).toBe('default');
		});

		it('when not even the strictest mode can be set, it says so: the permission didn\'t hold (#33)', async () => {
			const id = await earlier();
			const { client } = harness({ FAKE_STORE: store, FAKE_RESUME_MODE: 'acceptEdits', FAKE_REJECT: 'mode=default,mode=plan' });
			const session = client.restore(id);
			const result = await session.applySettings({ mode: 'default' });
			expect(result.permissionHeld).toBe(false);
			expect(result.fellBackTo).toBe('acceptEdits');
		});

		it('a restored session given the chat\'s settings gets them back when it resumes; so does a crashed one (#33)', async () => {
			const id = await earlier();
			const { client } = harness({ FAKE_STORE: store, FAKE_RESUME_MODE: 'acceptEdits' });
			const options = (await client.newSession()).view.state.configOptions;
			const session = client.restore(id, withValues(options, { mode: 'default', model: 'small' }));
			const changes: Change[] = [];
			session.onChange(c => changes.push(c));
			await session.prompt('meta');
			expect(JSON.parse(lastText(changes)).state).toMatchObject({ mode: 'default', model: 'small', resumed: true });
			await expect(session.prompt('crash')).rejects.toThrow();
			changes.length = 0;
			await session.prompt('meta');
			expect(JSON.parse(lastText(changes)).state).toMatchObject({ mode: 'default', model: 'small', resumed: true });
		});

		it('a session that comes back looser and can\'t be switched back sends nothing (#33)', async () => {
			const id = await earlier();
			const { client } = harness({ FAKE_STORE: store, FAKE_RESUME_MODE: 'acceptEdits', FAKE_REJECT: 'mode=default,mode=plan' });
			const options = (await client.newSession()).view.state.configOptions;
			const session = client.restore(id, withValues(options, { mode: 'default' }));
			const changes: Change[] = [];
			session.onChange(c => changes.push(c));
			await expect(session.prompt('meta')).rejects.toBeInstanceOf(PermissionNotRestoredError);
			expect(lastText(changes)).toBe('');
		});

		it('an agent without list support lists nothing; load says why', async () => {
			const { client } = harness({ FAKE_NO_LOAD: '1' });
			expect(await client.list()).toEqual([]);
			await expect(client.load('x')).rejects.toThrow(/loadSession/);
		});
	});

	it('gives up after repeated crashes until restart()', async () => {
		const { client, supervisor } = harness({}, { maxCrashes: 1, sleeps: [] });
		const session = await client.newSession();
		await expect(session.prompt('crash')).rejects.toThrow();
		await waitFor(() => supervisor.status.state === 'exited');
		await expect(supervisor.get()).rejects.toThrow(/restart it/);
		await supervisor.restart();
		await expect(supervisor.get()).resolves.toBeTruthy();
	});

	it('session/new without a login is reported as auth required', async () => {
		const { client } = harness({ FAKE_AUTH: '1' });
		const err = await client.newSession().catch(e => e);
		expect(isAuthRequired(err)).toBe(true);
	});

	it('a launch that can\'t start is a failed status with the reason', async () => {
		const supervisor = new AgentSupervisor({ launch: async () => ({ command: '/nonexistent/adapter' }), sleep: async () => { } });
		clients.push(new HarnessClient(PROFILE, supervisor, process.cwd()));
		await expect(supervisor.get()).rejects.toThrow(/ENOENT|closed|exited/);
		expect(supervisor.status.state).toBe('failed');
	});
});
