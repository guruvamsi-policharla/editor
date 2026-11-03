import { describe, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import { BUILTIN_PROFILES, CLIENT_CAPABILITIES, configControls, configResets, DEFAULT_PROFILE, launchFor, optionTiming, pendingDefaults, TACT, withOverride, type HarnessProfile } from '../src/index.js';

const node = { path: '/app/editor', env: { ELECTRON_RUN_AS_NODE: '1' } };

const select = (id: string, current: string, values: string[], more: Partial<acp.SessionConfigOption> = {}): acp.SessionConfigOption =>
	({ id, name: id[0]!.toUpperCase() + id.slice(1), type: 'select', currentValue: current, options: values.map(v => ({ value: v, name: v[0]!.toUpperCase() + v.slice(1) })), ...more }) as acp.SessionConfigOption;

describe('profiles', () => {
	it('tact is the only harness and the default; its adapter ships with the editor, the user\'s tact and env reach it', () => {
		expect(BUILTIN_PROFILES.map(p => p.id)).toEqual(['tact']);
		expect(DEFAULT_PROFILE).toBe(TACT);
		expect(TACT.adapter).toEqual({ bundled: 'tact-acp.js' });
		const launch = launchFor(withOverride(TACT, { env: { TACT_HOME: '/t' } }), { adapter: { kind: 'script', path: '/ext/dist/adapters/tact-acp.js' }, node, harnessPath: '/home/u/.cargo/bin/tact', cwd: '/w' });
		expect(launch).toEqual({ command: '/app/editor', args: ['/ext/dist/adapters/tact-acp.js'], env: { ELECTRON_RUN_AS_NODE: '1', TACT_HOME: '/t', TACT_BIN: '/home/u/.cargo/bin/tact' }, cwd: '/w' });
	});

	it('a user adapter command runs as is, with the profile\'s env and the user\'s', () => {
		const launch = launchFor(withOverride(TACT, { env: { X: '1' } }), { adapter: { kind: 'command', command: '/opt/my-adapter' }, node, cwd: '/w' });
		expect(launch).toEqual({ command: '/opt/my-adapter', args: [], env: { X: '1' }, cwd: '/w' });
	});

	it('the model placeholder is tact\'s own default, not a model list; options apply live', () => {
		expect(TACT.placeholderModel).toEqual({ id: 'default', name: 'Default model' });
		expect(optionTiming(TACT, 'speed')).toBe('live');
		expect(optionTiming({ ...TACT, timing: { default: 'next-turn', byId: { model: 'live' } } }, 'model')).toBe('live');
	});

	it('the client claims no fs or terminal capability', () => {
		expect(CLIENT_CAPABILITIES).toEqual({});
		expect(TACT.sessionMeta).toBeUndefined();
	});
});

describe('config controls', () => {
	const options = [
		select('model', 'sol', ['sol', 'opus'], { category: 'model' }),
		select('effort', 'high', ['high'], { category: 'thought_level', description: 'Fixed once the chat has started' }),
		select('speed', 'fast', ['standard', 'fast'], { category: 'model_config' }),
	];

	it('model → the model picker; the rest → pickers in the agent\'s order; one choice → locked', () => {
		const controls = configControls(options, TACT);
		expect(controls.map(c => [c.id, c.placement, !!c.locked])).toEqual([['model', 'model', false], ['effort', 'picker', true], ['speed', 'picker', false]]);
		expect(controls[1]!.description).toBe('Fixed once the chat has started');
	});

	it('boolean and unknown options are skipped', () => {
		const odd = [{ id: 'x', name: 'X', type: 'boolean', currentValue: true }] as unknown as acp.SessionConfigOption[];
		expect(configControls(odd, TACT)).toEqual([]);
	});

	it('defaults are applied only when offered and different', () => {
		const profile: HarnessProfile = { ...TACT, defaults: { speed: 'standard', effort: 'max' } };
		expect(pendingDefaults(options, profile)).toEqual([{ id: 'speed', value: 'standard' }]);
		expect(pendingDefaults(options, withOverride(TACT, { defaults: { speed: 'fast' } }))).toEqual([]);
	});

	it('resets after a model change: a value the agent changed, an option that went away (not one on its base choice)', () => {
		const opus = [select('model', 'opus', ['sol', 'opus'], { category: 'model' }), select('effort', 'high', ['high']), select('speed', 'fast', ['standard', 'fast'])];
		const sol = [select('model', 'sol', ['sol', 'opus'], { category: 'model' }), select('effort', 'high', ['high']), select('speed', 'ultrafast', ['standard', 'fast', 'ultrafast'])];
		expect(configResets(sol, opus, 'model')).toEqual([{ id: 'speed', name: 'Speed', from: { id: 'ultrafast', name: 'Ultrafast' }, to: { id: 'fast', name: 'Fast' } }]);
		const haiku = [select('model', 'haiku', ['haiku'], { category: 'model' }), select('effort', 'high', ['high'])];
		expect(configResets(opus, haiku, 'model')).toEqual([{ id: 'speed', name: 'Speed', from: { id: 'fast', name: 'Fast' } }]);
		const standard = [opus[0]!, opus[1]!, select('speed', 'standard', ['standard', 'fast'])];
		expect(configResets(standard, haiku, 'model')).toEqual([]);
		// The option the user set isn't a reset.
		expect(configResets(sol, opus, 'speed')).toEqual([]);
	});
});
