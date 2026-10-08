import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdapterInstaller, CLAUDE, type CommandRunner } from '../src/index.js';

/** Stands in for npm: "installs" the adapter package with a bin entry. */
function fakeNpm(calls: { args: readonly string[]; cwd: string }[], fail = false): CommandRunner {
	return async (_cmd, args, { cwd }) => {
		calls.push({ args, cwd });
		await new Promise(resolve => setTimeout(resolve, 10));
		if (fail) {
			throw new Error('npm ERR! network');
		}
		const pkg = join(cwd, 'node_modules', '@agentclientprotocol', 'claude-agent-acp');
		mkdirSync(join(pkg, 'dist'), { recursive: true });
		writeFileSync(join(pkg, 'package.json'), JSON.stringify({ bin: { 'claude-agent-acp': 'dist/index.js' } }));
		writeFileSync(join(pkg, 'dist', 'index.js'), '');
	};
}

describe('AdapterInstaller', () => {
	it('installs the pinned version once, with the shipped lockfile (npm ci), into a versioned dir', async () => {
		const root = mkdtempSync(join(tmpdir(), 'acp-inst-'));
		const locks = mkdtempSync(join(tmpdir(), 'acp-locks-'));
		mkdirSync(join(locks, 'claude'));
		writeFileSync(join(locks, 'claude', 'package.json'), JSON.stringify({ private: true, dependencies: { '@agentclientprotocol/claude-agent-acp': '0.87.0' } }));
		writeFileSync(join(locks, 'claude', 'package-lock.json'), '{}');
		const calls: { args: readonly string[]; cwd: string }[] = [];
		const installer = new AdapterInstaller(root, locks, fakeNpm(calls));

		expect(installer.installed(CLAUDE)).toBeUndefined();
		// Two concurrent first uses share one install.
		const [a, b] = await Promise.all([installer.ensure(CLAUDE, { omitOptional: true }), installer.ensure(CLAUDE, { omitOptional: true })]);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.args).toEqual(['ci', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error']);
		expect(a.entry).toBe(join(root, 'claude', '0.87.0', 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js'));
		expect(b).toEqual(a);
		expect(a.full).toBe(false);
		await installer.ensure(CLAUDE, { omitOptional: true });
		expect(calls).toHaveLength(1);

		// A slim install doesn't satisfy a need for the bundled harness: reinstall with optional deps.
		await installer.ensure(CLAUDE, { omitOptional: false });
		expect(calls).toHaveLength(2);
		expect(calls[1]!.args[0]).toBe('ci');
		expect(calls[1]!.args).not.toContain('--omit=optional');
		expect(installer.installed(CLAUDE, true)?.full).toBe(true);
	});

	it('without a matching lockfile it pins the version with npm install; a failed install leaves nothing behind', async () => {
		const root = mkdtempSync(join(tmpdir(), 'acp-inst-'));
		const calls: { args: readonly string[]; cwd: string }[] = [];
		await expect(new AdapterInstaller(root, undefined, fakeNpm(calls, true)).ensure(CLAUDE, { omitOptional: true })).rejects.toThrow(/network/);
		expect(calls[0]!.args[0]).toBe('install');
		expect(existsSync(join(root, 'claude')) ? readdirSync(join(root, 'claude')) : []).toEqual([]);
	});
});
