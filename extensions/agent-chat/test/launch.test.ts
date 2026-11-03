import { describe, expect, it } from 'vitest';
import { TACT } from '@editor/acp-client';
import { HarnessMissingError, loginCommand, resolveLaunch } from '../src/launch.js';

describe('launch', () => {
	it('tact\'s CLI isn\'t installed: HarnessMissingError, with how to install it', () => {
		const missing = { ...TACT, harness: { ...TACT.harness, binary: 'no-such-tact-cli', fallbackPaths: [] } };
		let err: unknown;
		try {
			resolveLaunch(missing, undefined, '/tmp', '/dist/adapters');
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(HarnessMissingError);
		expect((err as Error).message).toContain('no-such-tact-cli isn\'t installed');
		expect((err as Error).message).toContain('TACT_CHANNEL=pre-release');
		expect(TACT.installCommand).toBe('curl -fsSL https://tact.clab.by/install.sh | TACT_CHANNEL=pre-release sh');
		expect(() => loginCommand(missing, undefined)).toThrow(/isn't on PATH/);
	});

	it('the configured CLI goes to the bundled adapter through its env, run with the editor\'s node', () => {
		const launch = resolveLaunch(TACT, { harnessPath: '/opt/tact' }, '/w', '/dist/adapters');
		expect(launch).toMatchObject({ args: ['/dist/adapters/tact-acp.js'], env: { TACT_BIN: '/opt/tact', ELECTRON_RUN_AS_NODE: '1' }, cwd: '/w' });
		expect(loginCommand(TACT, { harnessPath: '/opt/tact' })).toEqual({ shellPath: '/opt/tact', shellArgs: ['auth', 'login'] });
	});
});
