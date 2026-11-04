import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The tact chat is off unless `agentChat.tact.enabled` is set: everything it contributes is gated on it.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const review = JSON.parse(readFileSync(new URL('../../agent-review/package.json', import.meta.url), 'utf8'));
const GATE = 'config.agentChat.tact.enabled';

describe('agentChat.tact.enabled', () => {
	it('defaults to off', () => {
		expect(pkg.contributes.configuration.properties['agentChat.tact.enabled'].default).toBe(false);
	});

	it('gates the participant and the session types', () => {
		for (const c of [...pkg.contributes.chatParticipants, ...pkg.contributes.chatSessions]) {
			expect(c.when).toContain(GATE);
		}
	});

	it('hides every command and menu item while off', () => {
		const palette = new Map<string, string>(pkg.contributes.menus.commandPalette.map((m: { command: string; when: string }) => [m.command, m.when]));
		for (const { command } of pkg.contributes.commands) {
			const when = palette.get(command);
			expect(when === 'false' || when?.includes(GATE), command).toBe(true);
		}
		for (const [menu, items] of Object.entries<{ when?: string }[]>(pkg.contributes.menus)) {
			for (const item of items) {
				expect(item.when === 'false' || item.when?.includes(GATE), menu).toBe(true);
			}
		}
	});

	it("agent-review's chat entry points are gated too", () => {
		const r = review.contributes;
		const gated = (id: string, items: { command?: string; id?: string; when?: string }[]) => items.filter(i => (i.command ?? i.id) === id).every(i => i.when?.includes(GATE));
		expect(gated('agentReview.addToChat', r.menus['editor/context'])).toBe(true);
		expect(gated('agentReview.addToChat', r.menus.commandPalette)).toBe(true);
		expect(gated('agentReview.sendSelectionToAgent', r.menus.commandPalette)).toBe(true);
		expect(gated('agentReview.chatNeedsTrust', r.views.agentChatTrust)).toBe(true);
	});
});
