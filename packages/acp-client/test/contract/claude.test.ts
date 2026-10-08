// Contract test against the real Claude adapter (claude-agent-acp) and the user's Claude Code login.
// Run with RUN_ACP_CONTRACT=1. Prompts are tiny and use haiku, but they do spend real usage.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReviewEngine } from '@editor/engine';
import { AgentConnection, type acp } from '../../src/index.js';
import { RUN_CONTRACT, adapterLaunch, tempWorkspace } from './harness.js';

const TURN_TIMEOUT = 180_000;

function option(options: acp.SessionConfigOption[] | undefined, id: string) {
	return options?.find(o => o.id === id);
}

function values(o: acp.SessionConfigOption | undefined): string[] {
	if (!o || o.type !== 'select') {
		return [];
	}
	return o.options.flatMap(x => ('options' in x ? x.options : [x])).map(x => x.value);
}

describe.skipIf(!RUN_CONTRACT)('claude-agent-acp contract', () => {
	let cwd: string;
	let agent: AgentConnection;
	let engine: ReviewEngine;
	let sessionId: string;
	let configOptions: acp.SessionConfigOption[] | undefined;

	beforeAll(async () => {
		cwd = tempWorkspace({ 'notes.txt': 'hello world\n' });
		engine = await ReviewEngine.open({ root: cwd, storageDir: mkdtempSync(join(tmpdir(), 'acp-engine-')) });
		agent = new AgentConnection({ ...adapterLaunch('claude'), cwd });
		const init = await agent.initialize();
		expect(init.protocolVersion).toBe(1);
		const session = await agent.newSession({
			cwd,
			mcpServers: [],
			_meta: { claudeCode: { options: { allowDangerouslySkipPermissions: false } } },
		});
		sessionId = session.sessionId;
		configOptions = session.configOptions ?? undefined;
	}, 120_000);

	const trace: Record<string, unknown> = {};

	afterAll(async () => {
		await agent?.dispose();
		// ACP_CONTRACT_TRACE=<file>: what happened on the wire (methods, updates, prompts; no env, no params of requests we sent).
		if (process.env.ACP_CONTRACT_TRACE && agent) {
			trace.wire = agent.wire.map(r => `${r.direction} ${r.method ?? `response ${String(r.id)}`}`);
			trace.updates = agent.updates.map(n => n.update);
			trace.permissionRequests = agent.permissionRequests;
			writeFileSync(process.env.ACP_CONTRACT_TRACE, JSON.stringify(trace, null, 2));
		}
	});

	it('(c) lists mode, model and effort; Bypass is hidden; setting options works', async () => {
		expect(configOptions?.map(o => o.id)).toEqual(expect.arrayContaining(['mode', 'model', 'effort']));
		expect(option(configOptions, 'mode')?.category).toBe('mode');
		expect(option(configOptions, 'model')?.category).toBe('model');
		expect(option(configOptions, 'effort')?.category).toBe('thought_level');
		expect(values(option(configOptions, 'mode'))).not.toContain('bypassPermissions');

		trace.initialOptions = configOptions;
		const effort = await agent.setConfigOption(sessionId, 'effort', 'low');
		expect(option(effort.configOptions, 'effort')?.currentValue).toBe('low');

		// The cheapest model for the turns below. The response is the complete list (effort may change with the model).
		const model = await agent.setConfigOption(sessionId, 'model', 'haiku');
		expect(option(model.configOptions, 'model')?.currentValue).toBe('haiku');
		trace.optionsAfterHaiku = model.configOptions;

		// The approved default: Accept edits, with prompts for commands.
		const mode = await agent.setConfigOption(sessionId, 'mode', 'acceptEdits');
		expect(option(mode.configOptions, 'mode')?.currentValue).toBe('acceptEdits');
	});

	it('(a, b) the harness edits the file on disk itself; no fs/terminal request reaches the client', async () => {
		const result = await agent.prompt(sessionId, 'In notes.txt, replace the word "world" with "there" using your Edit tool. Do nothing else and reply with just "done".');
		expect(result.stopReason).toBe('end_turn');
		trace.editTurn = result;
		expect(readFileSync(join(cwd, 'notes.txt'), 'utf8')).toBe('hello there\n');

		// The adapter reported an edit tool call (display only), but it never asked us to write.
		const edit = agent.updates.find(n => n.update.sessionUpdate === 'tool_call' && n.update.kind === 'edit');
		expect(edit).toBeDefined();
		expect(agent.forbiddenInbound()).toEqual([]);
		expect(agent.permissionRequests).toEqual([]); // Accept edits: no prompt for the edit

		// What the editor sees: the watcher event makes it a pending change in the review engine.
		await engine.handleFsEvents([join(cwd, 'notes.txt')]);
		expect(engine.listChanges().map(c => [c.path, c.kind])).toEqual([['notes.txt', 'modified']]);
	}, TURN_TIMEOUT);

	it('(d) a shell command asks for permission, and the answer is applied', async () => {
		let asked: acp.RequestPermissionRequest | undefined;
		agent.setPermissionHandler(async request => {
			asked = request;
			const allow = request.options.find(o => o.kind === 'allow_once');
			return { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } };
		});
		const result = await agent.prompt(sessionId, 'Run exactly this shell command with your Bash tool: python3 -c "open(\'ran.txt\',\'w\').write(\'x\')" . Do nothing else and reply with just "done".');
		expect(result.stopReason).toBe('end_turn');
		expect(asked).toBeDefined();
		expect(asked!.toolCall.toolCallId).toBeTruthy();
		expect(asked!.options.map(o => o.kind)).toEqual(expect.arrayContaining(['allow_once', 'reject_once']));
		expect(existsSync(join(cwd, 'ran.txt'))).toBe(true);
		expect(agent.forbiddenInbound()).toEqual([]);
	}, TURN_TIMEOUT);

	it('(e) cancel while a permission prompt is pending ends the turn as cancelled', async () => {
		agent.setPermissionHandler(async () => {
			// The user presses Stop with the prompt open: send session/cancel and answer the prompt `cancelled`, as the spec requires.
			await agent.cancel(sessionId);
			return { outcome: { outcome: 'cancelled' } };
		});
		const result = await agent.prompt(sessionId, 'Run exactly this shell command with your Bash tool: python3 -c "open(\'late.txt\',\'w\').write(\'x\')" . Do nothing else.');
		expect(result.stopReason).toBe('cancelled');
		expect(existsSync(join(cwd, 'late.txt'))).toBe(false);
	}, TURN_TIMEOUT);

	it('(e) cancel while the agent is streaming ends the turn as cancelled', async () => {
		agent.setPermissionHandler(async () => ({ outcome: { outcome: 'cancelled' } }));
		const turn = agent.prompt(sessionId, 'Write the numbers from 1 to 300, one per line, and nothing else.');
		const before = agent.updates.length;
		await agent.waitForUpdate(n => agent.updates.indexOf(n) >= before && n.update.sessionUpdate === 'agent_message_chunk', 60_000);
		await agent.cancel(sessionId);
		const result = await turn;
		expect(result.stopReason).toBe('cancelled');
		expect(agent.forbiddenInbound()).toEqual([]);
	}, TURN_TIMEOUT);
});
