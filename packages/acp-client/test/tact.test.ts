// The tact adapter as the editor runs it: packages/tact-acp bundled (as agent-chat's build does) and driven over ACP
// stdio by AgentConnection, against the fake tact (a terminal UI in a real pty, serving tact's web API).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentConnection, CLIENT_CAPABILITIES, TACT } from '../src/index.js';

const TACT_ACP = fileURLToPath(new URL('../../tact-acp/src/main.ts', import.meta.url));
const FAKE_TACT = fileURLToPath(new URL('../../tact-acp/test/fixtures/fake-tact.mjs', import.meta.url));

describe('tact-acp over ACP stdio (fake tact)', () => {
	let dir: string;
	let ws: string;
	let agent: AgentConnection;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'tact-acp-bundle-'));
		ws = mkdtempSync(join(tmpdir(), 'tact-acp-ws-'));
		await build({ entryPoints: [TACT_ACP], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'tact-acp.mjs'), logLevel: 'silent' });
		agent = new AgentConnection({ command: process.execPath, args: [join(dir, 'tact-acp.mjs')], env: { [TACT.harness.env!]: FAKE_TACT, TACT_HOME: join(dir, 'home') }, cwd: ws });
	}, 60_000);

	afterAll(async () => {
		await agent?.dispose();
		rmSync(dir, { recursive: true, force: true });
		rmSync(ws, { recursive: true, force: true });
	});

	it('a turn edits a file itself: streamed, the edit\'s absolute path, no fs/terminal capability and no fs/terminal call', async () => {
		expect(CLIENT_CAPABILITIES).toEqual({});
		const init = await agent.initialize();
		expect(init.agentInfo?.name).toBe('tact-acp');
		const session = await agent.newSession({ cwd: ws, mcpServers: [] });
		expect(session.configOptions?.map(o => o.id)).toEqual(['model', 'effort', 'reasoning_mode', 'speed']);

		writeFileSync(join(ws, 'main.tex'), 'old\n');
		const res = await agent.prompt(session.sessionId, [{ type: 'text', text: 'edit main.tex' }]);
		expect(res.stopReason).toBe('end_turn');
		expect(readFileSync(join(ws, 'main.tex'), 'utf8')).toBe('edited\n');
		const updates = agent.updates.filter(n => n.sessionId === session.sessionId).map(n => n.update);
		expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'tool_call', kind: 'edit', locations: [{ path: join(ws, 'main.tex') }] }));
		expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'edited main.tex' } }));
		expect(agent.forbiddenInbound()).toEqual([]);
		expect(agent.permissionRequests).toEqual([]);
	}, 60_000);
});
