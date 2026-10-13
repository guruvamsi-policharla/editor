import { describe, expect, it } from 'vitest';
import { TACT, type AdapterInstaller } from '@editor/acp-client';
import { HarnessMissingError, resolveLaunch } from '../src/launch.js';

const installer = {} as AdapterInstaller;

describe('launch', () => {
	it('a bundled adapter whose CLI isn\'t installed: HarnessMissingError, with how to install it', async () => {
		const missing = { ...TACT, harness: { ...TACT.harness, binary: 'no-such-tact-cli', fallbackPaths: [] } };
		const err = await resolveLaunch(missing, undefined, installer, '/tmp', () => undefined, '/dist/adapters').catch(e => e);
		expect(err).toBeInstanceOf(HarnessMissingError);
		expect(err.message).toContain('no-such-tact-cli isn\'t installed');
		expect(err.message).toContain('TACT_CHANNEL=pre-release');
		expect(TACT.installCommand).toBe('curl -fsSL https://tact.clab.by/install.sh | TACT_CHANNEL=pre-release sh');
	});

	it('the configured CLI goes to the bundled adapter through its env, run with the editor\'s node', async () => {
		const launch = await resolveLaunch(TACT, { harnessPath: '/opt/tact' }, installer, '/w', () => undefined, '/dist/adapters');
		expect(launch).toMatchObject({ args: ['/dist/adapters/tact-acp.js'], env: { TACT_BIN: '/opt/tact', ELECTRON_RUN_AS_NODE: '1' }, cwd: '/w' });
	});
});
