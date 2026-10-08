/**
 * Pinned adapter installs. Each harness's adapter is installed once, on first use, into
 * `<root>/<id>/<version>/` with `npm ci` against a shipped lockfile (integrity-checked), install scripts off.
 * When the user's own harness CLI is on PATH, optional dependencies (the adapter's bundled harness binary,
 * 230–425 MB) are left out. Installs go to a staging directory and are renamed into place when complete,
 * so an interrupted install is never mistaken for a good one. Updates are explicit: a new pinned version
 * installs next to the old one.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessProfile } from './profiles.js';

export type CommandRunner = (command: string, args: readonly string[], options: { cwd: string; env?: Record<string, string> }) => Promise<void>;

export interface InstallOptions {
	/** Leave out optional dependencies (the bundled harness binary). */
	omitOptional: boolean;
	onProgress?: (message: string) => void;
}

export interface InstalledAdapter {
	/** The adapter's JS entry point (run with node). */
	entry: string;
	/** The install's node_modules (for the bundled harness CLI). */
	nodeModules: string;
	/** Whether optional dependencies were installed. */
	full: boolean;
}

const MARKER = '.editor-install.json';

export class AdapterInstaller {
	private readonly inflight = new Map<string, Promise<InstalledAdapter>>();

	/**
	 * @param root where installs live (the extension's global storage)
	 * @param lockfiles directory with `<id>/package.json` and `<id>/package-lock.json` for each pinned adapter
	 * @param run runs npm (injected for tests)
	 */
	constructor(private readonly root: string, private readonly lockfiles: string | undefined, private readonly run: CommandRunner = runCommand, private readonly npm = 'npm') { }

	dirFor(profile: HarnessProfile): string {
		return join(this.root, profile.id, profile.adapter.version);
	}

	/** The installed adapter, if a complete install exists (and has optional deps when they're needed). */
	installed(profile: HarnessProfile, needFull = false): InstalledAdapter | undefined {
		const dir = this.dirFor(profile);
		if (!existsSync(join(dir, MARKER))) {
			return undefined;
		}
		try {
			const marker = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as { full?: boolean };
			if (needFull && !marker.full) {
				return undefined;
			}
			return { entry: resolveBin(join(dir, 'node_modules'), profile.adapter.npm, profile.adapter.bin), nodeModules: join(dir, 'node_modules'), full: !!marker.full };
		} catch {
			return undefined;
		}
	}

	ensure(profile: HarnessProfile, options: InstallOptions): Promise<InstalledAdapter> {
		const have = this.installed(profile, !options.omitOptional);
		if (have) {
			return Promise.resolve(have);
		}
		const key = `${profile.id}@${profile.adapter.version}`;
		let p = this.inflight.get(key);
		if (!p) {
			p = this.install(profile, options).finally(() => this.inflight.delete(key));
			this.inflight.set(key, p);
		}
		return p;
	}

	private async install(profile: HarnessProfile, options: InstallOptions): Promise<InstalledAdapter> {
		const dir = this.dirFor(profile);
		const staging = `${dir}.staging-${process.pid}-${Date.now()}`;
		mkdirSync(staging, { recursive: true });
		try {
			const shipped = this.lockfiles ? join(this.lockfiles, profile.id) : undefined;
			const pinnedLock = shipped && existsSync(join(shipped, 'package-lock.json'));
			const manifest = shipped && existsSync(join(shipped, 'package.json'))
				? JSON.parse(readFileSync(join(shipped, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
				: undefined;
			if (pinnedLock && manifest?.dependencies?.[profile.adapter.npm] === profile.adapter.version) {
				cpSync(join(shipped, 'package.json'), join(staging, 'package.json'));
				cpSync(join(shipped, 'package-lock.json'), join(staging, 'package-lock.json'));
			} else {
				writeFileSync(join(staging, 'package.json'), JSON.stringify({ private: true, dependencies: { [profile.adapter.npm]: profile.adapter.version } }, null, 2));
			}
			const args = [
				pinnedLock ? 'ci' : 'install',
				...(options.omitOptional ? ['--omit=optional'] : []),
				'--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error',
			];
			options.onProgress?.(`Installing ${profile.adapter.npm}@${profile.adapter.version}…`);
			await this.run(this.npm, args, { cwd: staging, env: { npm_config_update_notifier: 'false' } });
			const entry = resolveBin(join(staging, 'node_modules'), profile.adapter.npm, profile.adapter.bin);
			if (!existsSync(entry)) {
				throw new Error(`the install has no ${profile.adapter.bin} entry point`);
			}
			writeFileSync(join(staging, MARKER), JSON.stringify({ package: profile.adapter.npm, version: profile.adapter.version, full: !options.omitOptional, at: new Date().toISOString() }));
			rmSync(dir, { recursive: true, force: true });
			renameSync(staging, dir);
			return this.installed(profile)!;
		} catch (e) {
			rmSync(staging, { recursive: true, force: true });
			throw e;
		}
	}
}

/** The JS file behind a package's `bin` entry. */
export function resolveBin(nodeModules: string, pkg: string, bin: string): string {
	const dir = join(nodeModules, ...pkg.split('/'));
	const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
	const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[bin];
	if (!rel) {
		throw new Error(`${pkg} has no bin "${bin}"`);
	}
	return join(dir, rel);
}

export const runCommand: CommandRunner = (command, args, options) => new Promise((resolve, reject) => {
	const child = spawn(command, [...args], { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
	let output = '';
	child.stdout!.on('data', (d: Buffer) => { output = (output + d.toString()).slice(-8000); });
	child.stderr!.on('data', (d: Buffer) => { output = (output + d.toString()).slice(-8000); });
	child.on('error', e => reject(new Error(`${command}: ${e.message}`)));
	child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${output.trim()}`))));
});
