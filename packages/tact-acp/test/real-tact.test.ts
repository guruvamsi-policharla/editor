// Opt-in: the adapter on the real tact binary (one with the web API), the model side a local mock of the Anthropic
// and OpenAI APIs (fixtures/model-mock.mjs).   TACT_REAL_BIN=/path/to/tact npx vitest run test/real-tact.test.ts
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import { TactAgent } from '../src/agent.js';
// @ts-expect-error a plain JS fixture
import { startModelMock } from './fixtures/model-mock.mjs';

const BIN = process.env.TACT_REAL_BIN;

describe.skipIf(!BIN)('the real tact', () => {
	let mock: { url: string; requests: { path: string; model: string }[]; close(): void };
	let MOCK = '';
	beforeAll(async () => {
		mock = await startModelMock();
		MOCK = mock.url;
	});
	afterAll(() => mock.close());
	let home: string;
	let ws: string;
	let agents: TactAgent[] = [];
	let updates: acp.SessionUpdate[] = [];
	const config = (claude: string) => {
		writeFileSync(join(home, 'config.toml'), `[openai]\napi_key = "sk-mock"\n[agent]\napi_base_url = "${MOCK}/v1"\nweb_search = false\nimage_generation = false\n${claude}`);
		chmodSync(join(home, 'config.toml'), 0o600);
	};
	const claude = (key: string) => `[claude]\nenabled = true\napi_key = "${key}"\napi_base_url = "${MOCK}/v1"\n`;
	const agent = () => {
		const a = new TactAgent({ tact: BIN!, env: { TACT_HOME: home } }, async (_s, u) => { updates.push(u); });
		agents.push(a);
		return a;
	};
	const models = (options: acp.SessionConfigOption[] | null | undefined) => ((options?.find(o => o.id === 'model') as { options: { value: string }[] } | undefined)?.options ?? []).map(o => o.value);
	const answer = () => updates.filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => (u as { content: { text: string } }).content.text).join('');

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'tact-real-home-'));
		ws = mkdtempSync(join(tmpdir(), 'tact-real-ws-'));
		updates = [];
	});
	afterEach(async () => {
		agents.forEach(a => a.dispose());
		agents = [];
		await new Promise(r => setTimeout(r, 300));
		rmSync(home, { recursive: true, force: true });
		rmSync(ws, { recursive: true, force: true });
	});

	it('a Claude model picked on a new chat and sent at once runs on Claude; a reload resumes that session', async () => {
		config(claude('sk-ant-api03-mock'));
		const a = agent();
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		const set = await a.setConfigOption({ sessionId, configId: 'model', value: 'claude-opus-5-5' } as acp.SetSessionConfigOptionRequest);
		expect(set.configOptions?.find(o => o.id === 'model')?.currentValue).toBe('claude-opus-5-5');
		const res = await a.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] });
		expect(res.stopReason).toBe('end_turn');
		expect(answer()).toBe('Hello from mock claude-opus-5-5.');
		expect(mock.requests.at(-1)).toEqual({ path: '/v1/messages', model: 'claude-opus-5-5' });
		const tactId = JSON.parse(readFileSync(join(home, 'editor-sessions.json'), 'utf8'))[sessionId];
		// tact started a new session for the model (its id no longer says which model: `claude-…` before 98ffe05).
		expect(tactId).toBeTruthy();
		expect(tactId).not.toBe(sessionId);

		a.dispose();
		await new Promise(r => setTimeout(r, 300));
		updates = [];
		const b = agent();
		const loaded = await b.loadSession({ sessionId, cwd: ws, mcpServers: [] });
		expect(loaded.configOptions?.find(o => o.id === 'model')?.currentValue).toBe('claude-opus-5-5');
		expect(updates.some(u => u.sessionUpdate === 'user_message_chunk')).toBe(true);
	});

	it('a Claude key tact refuses: the model change fails with tact\'s reason', async () => {
		config(claude('sk-ant-oauth-mock'));
		const a = agent();
		const { sessionId } = await a.newSession({ cwd: ws, mcpServers: [] });
		await expect(a.setConfigOption({ sessionId, configId: 'model', value: 'claude-opus-5-5' } as acp.SetSessionConfigOptionRequest))
			.rejects.toThrow(/couldn't start the Opus 5\.5 session: .*requires an Anthropic API key/);
	});

	it('a Claude key added to config.toml while tact runs: the Claude models appear, no restart', async () => {
		config('');
		const a = agent();
		const { configOptions } = await a.newSession({ cwd: ws, mcpServers: [] });
		expect(models(configOptions).some(m => m.startsWith('claude-'))).toBe(false);
		config(claude('sk-ant-api03-mock'));
		for (let i = 0; i < 50 && !updates.some(u => u.sessionUpdate === 'config_option_update' && models(u.configOptions).includes('claude-opus-5-5')); i++) {
			await new Promise(r => setTimeout(r, 100));
		}
		expect(updates.some(u => u.sessionUpdate === 'config_option_update' && models(u.configOptions).includes('claude-opus-5-5'))).toBe(true);
	});

	it('each model\'s pickers are the catalog\'s: speeds it runs, Pro only where offered, a Claude effort fixed after the first turn', async () => {
		config(claude('sk-ant-api03-mock'));
		const a = agent();
		const { sessionId, configOptions } = await a.newSession({ cwd: ws, mcpServers: [] });
		const pick = (options: acp.SessionConfigOption[] | null | undefined, id: string) => ((options?.find(o => o.id === id) as { options: { value: string }[] } | undefined)?.options ?? []).map(o => o.value);
		expect(models(configOptions).length).toBeGreaterThanOrEqual(7);
		await a.setConfigOption({ sessionId, configId: 'speed', value: 'ultrafast' } as acp.SetSessionConfigOptionRequest);
		const opus = await a.setConfigOption({ sessionId, configId: 'model', value: 'claude-opus-5-5' } as acp.SetSessionConfigOptionRequest);
		expect(pick(opus.configOptions, 'speed')).toEqual(['standard', 'fast']);
		expect(opus.configOptions?.find(o => o.id === 'speed')?.currentValue).toBe('fast');
		expect(pick(opus.configOptions, 'reasoning_mode')).toEqual([]);
		await a.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] });
		const last = updates.filter(u => u.sessionUpdate === 'config_option_update').at(-1) as { configOptions: acp.SessionConfigOption[] };
		expect(pick(last.configOptions, 'effort')).toHaveLength(1);
		await expect(a.setConfigOption({ sessionId, configId: 'effort', value: 'low' } as acp.SetSessionConfigOptionRequest)).rejects.toThrow(/doesn't offer low/);
	}, 60_000);
});
