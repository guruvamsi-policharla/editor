import { describe, expect, it } from 'vitest';
import { optionValues, withValues, type acp } from '@editor/acp-client';
import { attributeChanges, ECHO_MS, modelIdentifier, shownSettings, startValues, type PickerEvent, type PickerPush } from '../src/settings.js';

const options: acp.SessionConfigOption[] = [
	{ id: 'speed', name: 'Speed', category: 'model_config', type: 'select', currentValue: 'standard', options: [{ value: 'standard', name: 'Standard speed' }, { value: 'fast', name: 'Fast' }, { value: 'ultrafast', name: 'Ultrafast' }] },
	{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-6.1-sol', options: [{ value: 'gpt-6.1-sol', name: 'Sol' }, { value: 'claude-haiku-5-5', name: 'Haiku 5.5' }] },
];

function event(target: string, changes: Record<string, string>): PickerEvent<string> {
	return { target, chat: `agent-tact:/${target}`, changes: Object.entries(changes).map(([id, value]) => ({ id, value })) };
}

describe('per-chat settings (#33, #25)', () => {
	it('a chat\'s saved values select its options; values not offered leave them as they are', () => {
		const chat = withValues(options, { speed: 'fast', model: 'claude-haiku-5-5', effort: 'max' });
		expect(optionValues(chat)).toEqual({ speed: 'fast', model: 'claude-haiku-5-5' });
		expect(optionValues(withValues(options, { speed: 'nope' }))).toEqual({ speed: 'standard', model: 'gpt-6.1-sol' });
		expect(optionValues(options)).toEqual({ speed: 'standard', model: 'gpt-6.1-sol' });
	});

	it('a reopened chat starts from its own values; a new chat from the defaults, never another chat\'s', () => {
		expect(startValues(undefined, { speed: 'fast' })).toEqual({ speed: 'fast' });
		expect(startValues(undefined, undefined)).toEqual({});
		expect(startValues({ settings: { speed: 'ultrafast', model: 'claude-haiku-5-5' } }, { speed: 'fast' })).toEqual({ speed: 'ultrafast', model: 'claude-haiku-5-5' });
		expect(startValues({}, { speed: 'fast' })).toEqual({});
	});

	it('a turn\'s model as the identifier core gives the model picker (vendor/id; request.model.id is the id) (#25)', () => {
		expect(modelIdentifier('agent-tact', 'claude-haiku-5-5')).toBe('agent-chat/agent-tact:claude-haiku-5-5');
	});

	it('core\'s per-chat picker values', () => {
		expect(shownSettings([{ optionId: 'speed', value: 'fast' }, { optionId: 'effort', value: { id: 'high' } }])).toEqual({ speed: 'fast', effort: 'high' });
		expect(shownSettings(undefined)).toEqual({});
	});
});

describe('which chat a picker change belongs to (core reports it to every chat)', () => {
	const now = 100_000;

	it('one chat with a change: it\'s the user\'s, in that chat', () => {
		expect(attributeChanges([event('a', { speed: 'fast' })], [], now)).toEqual([{ target: 'a', changes: [{ id: 'speed', value: 'fast' }] }]);
	});

	it('a value just set in another chat (a new chat\'s default, a reopened chat\'s own) is an echo, not a change (#33)', () => {
		const pushes: PickerPush<string>[] = [{ target: 'b', chat: 'agent-tact:/b', values: { speed: 'fast' }, at: now - 50 }];
		expect(attributeChanges([event('a', { speed: 'fast' })], pushes, now)).toEqual([]);
		// Core copies a new chat's picks to it on its first message: no input state of ours set them.
		const copied: PickerPush<string>[] = [{ target: undefined, chat: 'agent-tact:/new', values: { speed: 'fast' }, at: now - 50 }];
		expect(attributeChanges([event('a', { speed: 'fast' })], copied, now)).toEqual([]);
		// The chat's own value set again isn't an echo for it; an old one doesn't count.
		const own: PickerPush<string>[] = [{ target: undefined, chat: 'agent-tact:/a', values: { speed: 'standard' }, at: now - 50 }, { target: 'b', chat: 'agent-tact:/b', values: { speed: 'standard' }, at: now - ECHO_MS - 1 }];
		expect(attributeChanges([event('a', { speed: 'standard' })], own, now)).toHaveLength(1);
	});

	it('the same change in several chats: none is applied on a guess (each chat\'s next message runs with its own pickers)', () => {
		expect(attributeChanges([event('a', { speed: 'fast' }), event('b', { speed: 'fast' })], [], now)).toEqual([]);
	});
});
