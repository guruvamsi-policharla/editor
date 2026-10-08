import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLAUDE, CODEX, configControls, type acp } from '@editor/acp-client';
import { changedSelections, groupsFromControls, signInGroup, SIGN_IN_GROUP } from '../src/groups.js';

// Recorded from claude-agent-acp 0.87.0 (session/new with Bypass disabled).
const fixture = JSON.parse(readFileSync(new URL('../../../packages/acp-client/test/fixtures/claude-0.87.0.json', import.meta.url), 'utf8'));
const claude: acp.SessionConfigOption[] = fixture.sessionNew.configOptions;

const codexOptions: acp.SessionConfigOption[] = [
	{ id: 'mode', name: 'Approval Preset', category: 'mode', type: 'select', currentValue: 'workspace-write', options: [{ value: 'read-only', name: 'Read-only' }, { value: 'workspace-write', name: 'Workspace access' }, { value: 'agent', name: 'Auto review' }, { value: 'agent-full-access', name: 'Full access' }] },
	{ id: 'collaboration_mode', name: 'Collaboration', category: 'collaboration_mode' as acp.SessionConfigOptionCategory, type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
	{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt', options: [{ value: 'gpt', name: 'GPT' }] },
];

describe('pickers from config controls', () => {
	it('Claude: mode, effort, fast pickers (model goes to the model picker); plan has the /plan alias', () => {
		const groups = groupsFromControls(configControls(claude, CLAUDE));
		expect(groups.map(g => g.id)).toEqual(['mode', 'effort', 'fast']);
		expect(groups[0]!.items.map(i => i.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto']);
		expect(groups[0]!.items.find(i => i.id === 'plan')!.slashCommand).toBe('plan');
		expect(groups[0]!.description ?? '').not.toMatch(/next message/);
	});

	it('Codex: next-turn options say so; Full access is marked; plan is its own picker', () => {
		const groups = groupsFromControls(configControls(codexOptions, CODEX));
		const mode = groups.find(g => g.id === 'mode')!;
		expect(mode.description).toMatch(/Applies from your next message/);
		expect(mode.items.find(i => i.id === 'agent-full-access')!.name).toBe('Full access ⚠');
		const collab = groups.find(g => g.id === 'collaboration_mode')!;
		expect(collab.description).toBeUndefined(); // live
		expect(collab.items.find(i => i.id === 'plan')!.slashCommand).toBe('plan');
	});

	it('carries the untitled chat\'s selections over; a value no longer offered falls back to the current one', () => {
		const controls = configControls(claude, CLAUDE);
		const previous = { groups: [{ id: 'effort', name: 'Effort', items: [], selected: { id: 'max', name: 'Max' } }, { id: 'mode', name: 'Mode', items: [], selected: { id: 'bypassPermissions', name: 'Bypass' } }] };
		const groups = groupsFromControls(controls, undefined, previous);
		expect(groups.find(g => g.id === 'effort')!.selected!.id).toBe('max');
		expect(groups.find(g => g.id === 'mode')!.selected!.id).toBe('default');
	});

	it('reports which selections differ from the session', () => {
		const controls = configControls(claude, CLAUDE);
		const groups = groupsFromControls(controls);
		expect(changedSelections(groups, controls)).toEqual([]);
		const changed = groups.map(g => (g.id === 'mode' ? { ...g, selected: g.items.find(i => i.id === 'plan') } : g));
		expect(changedSelections(changed, controls)).toEqual([{ id: 'mode', value: 'plan', previous: 'default' }]);
	});

	it('the sign-in picker runs the login and offers a retry', () => {
		const g = signInGroup(CODEX);
		expect(g.id).toBe(SIGN_IN_GROUP);
		expect(g.selected!.name).toBe('Not signed in to Codex');
		expect(g.commands!.map(c => c.command)).toEqual(['agentChat.login.codex', 'agentChat.restart.codex']);
	});
});
