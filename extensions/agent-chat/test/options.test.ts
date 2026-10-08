import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { acp } from '@editor/acp-client';
import { modelChoices, pickersFromConfig, toGroups } from '../src/options.js';

// Recorded from claude-agent-acp 0.87.0 (session/new with Bypass disabled).
const fixture = JSON.parse(readFileSync(new URL('../../../packages/acp-client/test/fixtures/claude-0.87.0.json', import.meta.url), 'utf8'));
const claude: acp.SessionConfigOption[] = fixture.sessionNew.configOptions;

describe('ACP config options → pickers', () => {
	it('maps every select option except the model, in the agent order', () => {
		const pickers = pickersFromConfig(claude);
		expect(pickers.map(p => p.id)).toEqual(['mode', 'effort', 'fast']);
		expect(pickers[0]!.items.map(i => i.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto']);
		expect(pickers[0]!.selected).toBe('default');
	});

	it('gives the model option to the native model picker', () => {
		const models = modelChoices(claude)!;
		expect(models.current).toBe('default');
		expect(models.items.map(i => i.id)).toContain('haiku');
	});

	it('ignores options it cannot render', () => {
		const odd = [{ id: 'x', name: 'X', type: 'boolean', currentValue: true }] as unknown as acp.SessionConfigOption[];
		expect(pickersFromConfig(odd)).toEqual([]);
		expect(modelChoices(odd)).toBeUndefined();
	});

	it('carries the untitled chat\'s selections over when the session is committed', () => {
		const pickers = pickersFromConfig(claude);
		const previous = { groups: [{ id: 'effort', name: 'Effort', items: [], selected: { id: 'max', name: 'Max' } }] };
		const groups = toGroups(pickers, previous);
		expect(groups.find(g => g.id === 'effort')!.selected!.id).toBe('max');
		expect(groups.find(g => g.id === 'mode')!.selected!.id).toBe('default');
		// A carried-over value the agent no longer offers falls back to the first item.
		const stale = { groups: [{ id: 'mode', name: 'Mode', items: [], selected: { id: 'bypassPermissions', name: 'Bypass' } }] };
		expect(toGroups(pickers, stale).find(g => g.id === 'mode')!.selected!.id).toBe('default');
	});
});
