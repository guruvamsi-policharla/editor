// Contract test against the real Codex adapter (codex-acp). Run with RUN_ACP_CONTRACT=1.
// Without a Codex login (ACP_CODEX_LOGGED_IN unset) it only checks what works before auth.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentConnection, type acp } from '../../src/index.js';
import { RUN_CONTRACT, adapterLaunch, tempWorkspace } from './harness.js';

const LOGGED_IN = process.env.ACP_CODEX_LOGGED_IN === '1';

describe.skipIf(!RUN_CONTRACT)('codex-acp contract', () => {
	let cwd: string;
	let agent: AgentConnection;
	let init: acp.InitializeResponse;

	beforeAll(async () => {
		cwd = tempWorkspace({ 'notes.txt': 'hello world\n' });
		agent = new AgentConnection({ ...adapterLaunch('codex'), cwd });
		init = await agent.initialize();
	}, 120_000);

	afterAll(async () => {
		await agent?.dispose();
	});

	it('starts and advertises its capabilities and auth methods', () => {
		expect(init.protocolVersion).toBe(1);
		expect(init.agentInfo?.name).toBe('@agentclientprotocol/codex-acp');
		expect(init.agentCapabilities?.loadSession).toBe(true);
		// NO_BROWSER hides ChatGPT browser login; device code needs URL elicitation, which we don't advertise.
		expect(init.authMethods?.map(m => m.id)).toContain('api-key');
	});

	it.skipIf(LOGGED_IN)('without a login, session/new reports that authentication is required', async () => {
		await expect(agent.newSession({ cwd, mcpServers: [] })).rejects.toMatchObject({ code: -32000, message: 'Authentication required' });
		expect(agent.forbiddenInbound()).toEqual([]);
	});

	it.skipIf(!LOGGED_IN)('lists mode, model and effort; starts in Workspace access', async () => {
		const session = await agent.newSession({ cwd, mcpServers: [] });
		const ids = session.configOptions?.map(o => o.id);
		expect(ids).toEqual(expect.arrayContaining(['mode', 'collaboration_mode', 'model', 'reasoning_effort']));
		expect(session.configOptions?.find(o => o.id === 'mode')?.currentValue).toBe('workspace-write');
	});

	// Untested here (no Codex login on the spike machine): an edit on disk by the harness, permission
	// round trip, set_config_option and cancel. They mirror claude.test.ts once a login is available.
});
