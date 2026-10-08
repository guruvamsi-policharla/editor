import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConnection, CLIENT_CAPABILITIES, isForbiddenClientMethod } from '../src/index.js';

const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

describe('AgentConnection (fake agent)', () => {
	let agent: AgentConnection | undefined;
	afterEach(async () => {
		await agent?.dispose();
		agent = undefined;
	});

	it('never advertises fs or terminal', () => {
		expect(CLIENT_CAPABILITIES).not.toHaveProperty('fs');
		expect(CLIENT_CAPABILITIES).not.toHaveProperty('terminal');
		expect(['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/kill'].every(isForbiddenClientMethod)).toBe(true);
		expect(['session/update', 'session/request_permission'].some(isForbiddenClientMethod)).toBe(false);
	});

	it('records a forbidden fs call from the wire, refuses it, and relays permission answers', async () => {
		agent = new AgentConnection({ command: process.execPath, args: [FAKE_AGENT] });
		await agent.initialize();
		const session = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
		expect(session.configOptions?.[0]?.id).toBe('mode');
		agent.setPermissionHandler(async () => ({ outcome: { outcome: 'selected', optionId: 'no' } }));

		const result = await agent.prompt(session.sessionId, 'hi');
		expect(result.stopReason).toBe('end_turn');
		expect(agent.forbiddenInbound()).toEqual(['fs/read_text_file']);

		const chunk = agent.updates.at(-1)!.update;
		expect(chunk.sessionUpdate).toBe('agent_message_chunk');
		const seen = JSON.parse(chunk.sessionUpdate === 'agent_message_chunk' && chunk.content.type === 'text' ? chunk.content.text : '{}');
		expect(seen.fsError).toBe(-32601); // method not found: the client doesn't serve fs
		// We send `{}`; an SDK-based agent parses that to explicit "no fs, no terminal".
		expect(seen.clientCapabilities).toMatchObject({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
		expect(seen.permission).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
		expect(agent.permissionRequests).toHaveLength(1);
	});

	it('dispose ends the adapter process', async () => {
		agent = new AgentConnection({ command: process.execPath, args: [FAKE_AGENT] });
		await agent.initialize();
		const pid = agent.pid!;
		await agent.dispose();
		expect(() => process.kill(pid, 0)).toThrow();
	});
});
