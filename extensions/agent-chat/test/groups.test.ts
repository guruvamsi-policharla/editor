import { describe, expect, it } from 'vitest';
import { configControls, TACT, type acp } from '@editor/acp-client';
import { configOptions } from '../../../packages/tact-acp/src/mapping.js';
import type { ModelCatalog } from '../../../packages/tact-acp/src/web.js';
import realCatalog from '../../../packages/tact-acp/test/fixtures/models-98ffe05.json' with { type: 'json' };
import { changedSelections, groupsFromControls, signInGroup, SIGN_IN_GROUP } from '../src/groups.js';

// What the pickers show is what the tact adapter offers for tact dev-98ffe05's catalog: nothing here lists models.
const catalog = realCatalog as ModelCatalog;
const tact = (model: string, more: { speed?: string; started?: boolean; effort?: 'high' | 'max'; reasoning_mode?: string } = {}): acp.SessionConfigOption[] =>
	configOptions({ model, effort: more.effort ?? 'high', reasoning_mode: more.reasoning_mode ?? 'standard', speed: more.speed ?? 'standard', started: more.started ?? false }, catalog);
const groups = (options: acp.SessionConfigOption[]) => groupsFromControls(configControls(options, TACT), id => ({ id }) as never);
const items = (options: acp.SessionConfigOption[], id: string) => groups(options).find(g => g.id === id)?.items.map(i => i.id);

describe('pickers from config controls', () => {
	it('every model in the catalog gets exactly its own pickers: speed tiers it runs, Pro only where offered', () => {
		for (const m of catalog.models) {
			const speeds = catalog.speeds.filter((s, i) => m.effective_speeds[i] === s);
			expect(items(tact(m.id), 'speed'), m.id).toEqual(speeds.length > 1 ? speeds : undefined);
			expect(items(tact(m.id), 'reasoning_mode'), m.id).toEqual(m.reasoning_modes.length > 1 ? m.reasoning_modes : undefined);
			expect(items(tact(m.id), 'effort'), m.id).toEqual(catalog.efforts);
		}
		// The reported bug: Ultrafast on a Claude model. Opus 5.5 runs Ultrafast as Fast, so it isn't offered.
		expect(items(tact('claude-opus-5-5'), 'speed')).toEqual(['standard', 'fast']);
		expect(items(tact('claude-sonnet-5-5'), 'speed')).toBeUndefined();
	});

	it('a setting fixed once the chat has started is shown locked, with why; the others stay open', () => {
		const opus = groups(tact('claude-opus-5-5', { started: true, effort: 'max' }));
		const effort = opus.find(g => g.id === 'effort')!;
		expect(effort.items).toEqual([expect.objectContaining({ id: 'max', name: 'Max', locked: true, description: 'Fixed once the chat has started on Opus 5.5' })]);
		expect(opus.find(g => g.id === 'speed')!.items.every(i => !i.locked)).toBe(true);
		const sol = groups(tact('gpt-6.1-sol', { started: true, reasoning_mode: 'pro' }));
		expect(sol.find(g => g.id === 'reasoning_mode')!.items).toEqual([expect.objectContaining({ id: 'pro', locked: true })]);
		expect(sol.find(g => g.id === 'effort')!.items).toHaveLength(5);
	});

	it('the footer pickers show which setting they are: each choice has its group\'s icon', () => {
		const g = groups(tact('gpt-6.1-sol', { speed: 'ultrafast' }));
		expect(g.map(x => x.selected!.name)).toEqual(['High', 'Standard reasoning', 'Ultrafast']);
		expect(g.map(x => (x.selected!.icon as { id?: string } | undefined)?.id)).toEqual(['lightbulb', undefined, 'zap']);
	});

	it('carries a new chat\'s selections over; a value the model doesn\'t offer falls back to the current one', () => {
		const controls = configControls(tact('claude-opus-5-5'), TACT);
		const previous = { groups: [{ id: 'effort', name: 'Thinking', items: [], selected: { id: 'max', name: 'Max' } }, { id: 'speed', name: 'Speed', items: [], selected: { id: 'ultrafast', name: 'Ultrafast' } }] };
		const g = groupsFromControls(controls, undefined, previous);
		expect(g.find(x => x.id === 'effort')!.selected!.id).toBe('max');
		expect(g.find(x => x.id === 'speed')!.selected!.id).toBe('standard');
	});

	it('reports which selections differ from the session, never one it doesn\'t offer', () => {
		const controls = configControls(tact('claude-opus-5-5'), TACT);
		const g = groupsFromControls(controls);
		expect(changedSelections(g, controls)).toEqual([]);
		const changed = g.map(x => (x.id === 'speed' ? { ...x, selected: { id: 'fast', name: 'Fast' } } : x));
		expect(changedSelections(changed, controls)).toEqual([{ id: 'speed', value: 'fast', previous: 'standard' }]);
		const bogus = g.map(x => (x.id === 'speed' ? { ...x, selected: { id: 'ultrafast', name: 'Ultrafast' } } : x));
		expect(changedSelections(bogus, controls)).toEqual([]);
	});

	it('the model picker\'s choices are the catalog\'s, each with its provider', () => {
		const model = configControls(tact('gpt-6.1-sol'), TACT).find(c => c.placement === 'model')!;
		expect(model.choices.map(c => [c.name, c.description])).toEqual(catalog.models.map(m => [m.label, m.provider === 'openai' ? 'OpenAI' : 'Anthropic']));
	});

	it('the sign-in picker runs the login and offers a retry', () => {
		const g = signInGroup(TACT);
		expect(g.id).toBe(SIGN_IN_GROUP);
		expect(g.selected!.name).toBe('Not signed in to tact');
		expect(g.commands!.map(c => c.command)).toEqual(['agentChat.login.tact', 'agentChat.restart.tact']);
	});
});
