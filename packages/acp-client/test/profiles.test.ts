import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import { BUILTIN_PROFILES, CLAUDE, CODEX, configControls, isDangerous, launchFor, npmAdapter, optionTiming, pendingDefaults, TACT, withOverride } from '../src/index.js';

const claudeFixture = JSON.parse(readFileSync(new URL('./fixtures/claude-0.87.0.json', import.meta.url), 'utf8'));
const claudeOptions: acp.SessionConfigOption[] = claudeFixture.sessionNew.configOptions;

const node = { path: '/app/editor', env: { ELECTRON_RUN_AS_NODE: '1' } };

describe('profiles', () => {
	it('Claude: the adapter runs under the editor\'s node with the user\'s claude', () => {
		const launch = launchFor(CLAUDE, { adapter: { kind: 'script', path: '/s/claude/dist/index.js' }, node, harnessPath: '/home/u/.local/bin/claude', cwd: '/w' });
		expect(launch).toEqual({
			command: '/app/editor',
			args: ['/s/claude/dist/index.js'],
			env: { ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_EXECUTABLE: '/home/u/.local/bin/claude' },
			cwd: '/w',
		});
	});

	it('Codex: the start mode is a launch-time env var; a user adapter command runs as is', () => {
		const launch = launchFor(CODEX, { adapter: { kind: 'command', command: '/opt/codex-acp' }, node, cwd: '/w' });
		expect(launch.command).toBe('/opt/codex-acp');
		expect(launch.env).toEqual({ NO_BROWSER: '1', INITIAL_AGENT_MODE: 'workspace-write' });
		const custom = withOverride(CODEX, { defaults: { mode: 'read-only' }, env: { X: '1' } });
		expect(launchFor(custom, { adapter: { kind: 'command', command: 'c' }, node, cwd: '/w' }).env).toMatchObject({ INITIAL_AGENT_MODE: 'read-only', X: '1', NO_BROWSER: '1' });
	});

	it('tact: its adapter ships with the editor (nothing to install); the user\'s tact and env reach it', () => {
		expect(BUILTIN_PROFILES.map(p => p.id)).toEqual(['claude', 'codex', 'tact']);
		expect(TACT.adapter).toEqual({ bundled: 'tact-acp.js' });
		expect(() => npmAdapter(TACT)).toThrow(/ships with the editor/);
		expect(npmAdapter(CLAUDE).npm).toBe('@agentclientprotocol/claude-agent-acp');
		const launch = launchFor(withOverride(TACT, { env: { TACT_HOME: '/t' } }), { adapter: { kind: 'script', path: '/ext/dist/adapters/tact-acp.js' }, node, harnessPath: '/home/u/.cargo/bin/tact', cwd: '/w' });
		expect(launch).toEqual({ command: '/app/editor', args: ['/ext/dist/adapters/tact-acp.js'], env: { ELECTRON_RUN_AS_NODE: '1', TACT_HOME: '/t', TACT_BIN: '/home/u/.cargo/bin/tact' }, cwd: '/w' });
	});

	it('timing: Claude is live; Codex applies from the next turn except plan', () => {
		expect(optionTiming(CLAUDE, 'model')).toBe('live');
		expect(optionTiming(CODEX, 'mode')).toBe('next-turn');
		expect(optionTiming(CODEX, 'collaboration_mode')).toBe('live');
	});
});

describe('config controls', () => {
	it('Claude: model → model picker; mode/effort/fast → pickers, in the agent\'s order', () => {
		const controls = configControls(claudeOptions, CLAUDE);
		expect(controls.map(c => [c.id, c.placement])).toEqual([['mode', 'picker'], ['model', 'model'], ['effort', 'picker'], ['fast', 'picker']]);
		expect(controls[0]!.plan).toBe('plan');
	});

	it('hides Bypass, but keeps a hidden value that is currently selected', () => {
		const withBypass = structuredClone(claudeOptions);
		const mode = withBypass[0] as acp.SessionConfigOption & { type: 'select'; options: acp.SessionConfigSelectOption[] };
		mode.options.push({ value: 'bypassPermissions', name: 'Bypass' });
		expect(configControls(withBypass, CLAUDE)[0]!.choices.map(c => c.id)).not.toContain('bypassPermissions');
		mode.currentValue = 'bypassPermissions';
		expect(configControls(withBypass, CLAUDE)[0]!.choices.find(c => c.id === 'bypassPermissions')).toMatchObject({ dangerous: true });
	});

	it('Codex Full access is dangerous; boolean options are skipped', () => {
		expect(isDangerous(CODEX, 'mode', 'agent-full-access')).toBe(true);
		expect(isDangerous(CODEX, 'mode', 'workspace-write')).toBe(false);
		const odd = [{ id: 'x', name: 'X', type: 'boolean', currentValue: true }] as unknown as acp.SessionConfigOption[];
		expect(configControls(odd, CODEX)).toEqual([]);
	});

	it('defaults are applied only when offered and different', () => {
		expect(pendingDefaults(claudeOptions, CLAUDE)).toEqual([{ id: 'mode', value: 'acceptEdits' }]);
		const already = structuredClone(claudeOptions);
		already[0]!.currentValue = 'acceptEdits';
		expect(pendingDefaults(already, CLAUDE)).toEqual([]);
		expect(pendingDefaults(claudeOptions, CODEX)).toEqual([]); // workspace-write isn't offered
	});
});
