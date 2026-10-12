import { describe, expect, it } from 'vitest';
import { CLAUDE, CODEX, isLooser, optionValues, strictestOffered, withValues, type acp } from '@editor/acp-client';
import { attributeChanges, dangerousConfirmation, ECHO_MS, modelIdentifier, shownSettings, startValues, type PickerEvent, type PickerPush } from '../src/settings.js';

const options: acp.SessionConfigOption[] = [
	{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'acceptEdits', options: [{ value: 'default', name: 'Manual' }, { value: 'acceptEdits', name: 'Accept edits' }, { value: 'plan', name: 'Plan' }, { value: 'auto', name: 'Auto' }] },
	{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default (recommended)' }, { value: 'haiku', name: 'Haiku 5.5' }] },
];

function event(target: string, changes: Record<string, string>, opts: { running?: boolean; current?: Record<string, string> } = {}): PickerEvent<string> {
	return { target, chat: `agent-claude:/${target}`, running: opts.running ?? false, changes: Object.entries(changes).map(([id, value]) => ({ id, value })), current: opts.current ?? { mode: 'acceptEdits' } };
}

describe('per-chat settings (#33, #25)', () => {
	it('the permission order: Manual is the strictest, Auto and unknown modes the loosest', () => {
		expect(isLooser(CLAUDE, 'acceptEdits', 'default')).toBe(true);
		expect(isLooser(CLAUDE, 'default', 'acceptEdits')).toBe(false);
		expect(isLooser(CLAUDE, 'auto', 'acceptEdits')).toBe(true);
		expect(isLooser(CLAUDE, 'somethingNew', 'auto')).toBe(true);
		expect(isLooser(CODEX, 'workspace-write', 'read-only')).toBe(true);
		expect(strictestOffered(options, CLAUDE)).toBe('default');
	});

	it('a chat\'s saved values select its options; values not offered leave them as they are', () => {
		const chat = withValues(options, { mode: 'default', model: 'haiku', effort: 'max' });
		expect(optionValues(chat)).toEqual({ mode: 'default', model: 'haiku' });
		expect(optionValues(withValues(options, { mode: 'nope' }))).toEqual({ mode: 'acceptEdits', model: 'default' });
		expect(optionValues(options)).toEqual({ mode: 'acceptEdits', model: 'default' });
	});

	it('a reopened chat starts from its own values; a new chat from the defaults, not another chat\'s Manual; an old chat in the strictest mode', () => {
		const lastSeen = withValues(options, { mode: 'default' }); // the cache after chat A was set to Manual
		expect(startValues(undefined, CLAUDE.defaults, lastSeen, CLAUDE)).toEqual({ mode: 'acceptEdits' });
		expect(startValues({ settings: { mode: 'default', model: 'haiku' } }, CLAUDE.defaults, options, CLAUDE)).toEqual({ mode: 'default', model: 'haiku' });
		expect(startValues({}, CLAUDE.defaults, options, CLAUDE)).toEqual({ mode: 'default' });
	});

	it('a chat never opens in Bypass permissions: not new, not reopened, not from a user default', () => {
		const withBypass = structuredClone(options);
		(withBypass[0] as acp.SessionConfigOption & { options: acp.SessionConfigSelectOption[] }).options.push({ value: 'bypassPermissions', name: 'Bypass permissions' });
		const lastSeen = withValues(withBypass, { mode: 'bypassPermissions' });
		expect(startValues(undefined, CLAUDE.defaults, lastSeen, CLAUDE)).toEqual({ mode: 'acceptEdits' });
		expect(startValues(undefined, { mode: 'bypassPermissions' }, lastSeen, CLAUDE)).toEqual({ mode: 'acceptEdits' });
		// Chats are saved without it (AcpSession.keptValues); one that has it anyway gets the default.
		expect(startValues({ settings: { mode: 'bypassPermissions', model: 'haiku' } }, CLAUDE.defaults, lastSeen, CLAUDE)).toEqual({ mode: 'acceptEdits', model: 'haiku' });
		// A user's Manual stays Manual.
		expect(startValues({ settings: { mode: 'default' } }, CLAUDE.defaults, lastSeen, CLAUDE)).toEqual({ mode: 'default' });
	});

	it('choosing a dangerous mode asks in a modal, which says what it does and that a restart leaves Bypass', () => {
		const bypass = dangerousConfirmation('Claude Code', 'Bypass permissions', true);
		expect(bypass.message).toBe('Claude Code: switch to Bypass permissions?');
		expect(bypass.yes).toBe('Use Bypass permissions');
		expect(bypass.detail).toMatch(/without asking/);
		expect(bypass.detail).toMatch(/Keep\/Undo/);
		expect(bypass.detail).toMatch(/after a reload or restart it's back in the mode it had before/);
		expect(dangerousConfirmation('Codex', 'Full access', false).detail).not.toMatch(/restart/);
	});

	it('a turn\'s model as the identifier core gives the model picker (vendor/id; request.model.id is the id) (#25)', () => {
		expect(modelIdentifier('agent-claude', 'haiku')).toBe('agent-chat/agent-claude:haiku');
	});

	it('core\'s per-chat picker values', () => {
		expect(shownSettings([{ optionId: 'mode', value: 'default' }, { optionId: 'effort', value: { id: 'high' } }])).toEqual({ mode: 'default', effort: 'high' });
		expect(shownSettings(undefined)).toEqual({});
	});
});

describe('which chat a picker change belongs to (core reports it to every chat)', () => {
	const now = 100_000;

	it('one chat with a change: it\'s the user\'s, in that chat', () => {
		expect(attributeChanges([event('a', { mode: 'default' })], [], now, CLAUDE)).toEqual([{ target: 'a', changes: [{ id: 'mode', value: 'default' }] }]);
	});

	it('a value just set in another chat (a new chat\'s default, a reopened chat\'s own) is an echo, not a change (#33)', () => {
		const pushes: PickerPush<string>[] = [{ target: 'b', chat: 'agent-claude:/b', values: { mode: 'acceptEdits' }, at: now - 50 }];
		expect(attributeChanges([event('a', { mode: 'acceptEdits' }, { current: { mode: 'default' } })], pushes, now, CLAUDE)).toEqual([]);
		// Core copies a new chat's picks to it on its first message: no input state of ours set them.
		const copied: PickerPush<string>[] = [{ target: undefined, chat: 'agent-claude:/new', values: { mode: 'acceptEdits' }, at: now - 50 }];
		expect(attributeChanges([event('a', { mode: 'acceptEdits' }, { current: { mode: 'default' } })], copied, now, CLAUDE)).toEqual([]);
		// The chat's own value set again isn't an echo for it; an old one doesn't count.
		const own: PickerPush<string>[] = [{ target: undefined, chat: 'agent-claude:/a', values: { mode: 'default' }, at: now - 50 }, { target: 'b', chat: 'agent-claude:/b', values: { mode: 'default' }, at: now - ECHO_MS - 1 }];
		expect(attributeChanges([event('a', { mode: 'default' })], own, now, CLAUDE)).toHaveLength(1);
	});

	it('the same change in several chats: nothing is loosened on a guess; a stricter mode reaches running turns only (#33)', () => {
		const looser = [event('a', { mode: 'acceptEdits' }, { current: { mode: 'default' }, running: true }), event('b', { mode: 'acceptEdits' }, { current: { mode: 'default' } })];
		expect(attributeChanges(looser, [], now, CLAUDE)).toEqual([]);
		const stricter = [
			event('a', { mode: 'default', effort: 'max' }, { running: true }),
			event('b', { mode: 'default' }),
			event('c', { mode: 'default' }, { running: true, current: { mode: 'default' } }),
		];
		expect(attributeChanges(stricter, [], now, CLAUDE)).toEqual([{ target: 'a', changes: [{ id: 'mode', value: 'default' }] }]);
	});
});
