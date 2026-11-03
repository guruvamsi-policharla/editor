import { describe, expect, it } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import { describePermission, orderChoices, PermissionBroker, type PermissionAudit } from '../src/index.js';

const bash: acp.RequestPermissionRequest = {
	sessionId: 's',
	toolCall: { toolCallId: 't1', title: 'Run a command', kind: 'execute', rawInput: { command: `python3 -c "open('ran.txt','w').write('x')"`, description: 'Write x into ran.txt via Python' } },
	options: [
		{ optionId: 'allow-always', name: 'Yes, and don\'t ask again', kind: 'allow_always' },
		{ optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
		{ optionId: 'reject', name: 'No', kind: 'reject_once' },
	],
};

describe('permission prompts', () => {
	it('orders buttons once / no / always, so No is never hidden in the dropdown', () => {
		expect(orderChoices(bash.options).map(o => o.kind)).toEqual(['allow_once', 'reject_once', 'allow_always']);
	});

	it('shows the exact command, the agent\'s description, and where "always" is saved', () => {
		const p = describePermission(bash, o => (o.kind === 'allow_always' ? 'saved to the rules file' : undefined));
		expect(p.title).toBe('Run this command?');
		expect(p.command).toBe(`python3 -c "open('ran.txt','w').write('x')"`);
		expect(p.description).toBe('Write x into ran.txt via Python');
		expect(p.choices.map(c => c.label)).toEqual(['Yes', 'No', expect.stringContaining("don't ask again")]);
		expect(p.choices[2]!.persistent).toBe('saved to the rules file');
		expect(p.choices[0]!.persistent).toBeUndefined();
	});

	it('lists the paths of a file tool', () => {
		const p = describePermission({ sessionId: 's', toolCall: { toolCallId: 't', title: 'Edit a.tex', kind: 'edit', locations: [{ path: '/w/a.tex' }], rawInput: { file_path: '/w/a.tex' } }, options: [] });
		expect(p.paths).toEqual(['/w/a.tex']);
		expect(p.title).toBe('Edit a.tex?');
		expect(p.command).toBeUndefined();
	});
});

describe('PermissionBroker', () => {
	const request = { ...bash, sessionId: 's1' };

	it('answers cancelled when no UI is attached (never picks an option itself)', async () => {
		const audits: PermissionAudit[] = [];
		const broker = new PermissionBroker();
		broker.onAudit(a => audits.push(a));
		expect(await broker.handle(request)).toEqual({ outcome: { outcome: 'cancelled' } });
		expect(audits[0]).toMatchObject({ outcome: 'cancelled', reason: 'no-ui', command: expect.stringContaining('python3') });
	});

	it('relays the chosen option, and rejects answers that weren\'t offered', async () => {
		const broker = new PermissionBroker();
		let answer = 'allow-once';
		broker.setAsker('s1', async () => answer);
		expect(await broker.handle(request)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
		answer = 'made-up';
		expect(await broker.handle(request)).toEqual({ outcome: { outcome: 'cancelled' } });
	});

	it('a dismissed prompt is cancelled; so is a pending one when the session is cancelled', async () => {
		const broker = new PermissionBroker();
		broker.setAsker('s1', async () => undefined);
		expect((await broker.handle(request)).outcome.outcome).toBe('cancelled');

		let signal: AbortSignal | undefined;
		broker.setAsker('s1', (_p, s) => { signal = s; return new Promise(() => { }); });
		const pending = broker.handle(request);
		await Promise.resolve();
		expect(broker.pendingCount('s1')).toBe(1);
		broker.cancelSession('s1');
		expect(await pending).toEqual({ outcome: { outcome: 'cancelled' } });
		expect(signal!.aborted).toBe(true);
		expect(broker.pendingCount('s1')).toBe(0);
	});

	it('detaching the asker only removes its own registration', async () => {
		const broker = new PermissionBroker();
		const off1 = broker.setAsker('s1', async () => 'allow-once');
		broker.setAsker('s1', async () => 'reject');
		off1();
		expect(await broker.handle(request)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
	});
});
