// Where a harness comes from: the user's CLI on PATH (shared install and login), the pinned adapter installed
// on first use (or a user-configured adapter command), run under the editor's own Node (Electron as node),
// so no system Node is needed at run time.
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { launchFor, type AdapterInstaller, type AgentLaunch, type HarnessProfile, type ProfileOverride } from '@editor/acp-client';

export function expandHome(p: string): string {
	return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function executable(p: string): boolean {
	try {
		accessSync(p, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** `which`, without a shell. */
export function which(binary: string, path = process.env.PATH ?? ''): string | undefined {
	for (const dir of path.split(delimiter)) {
		if (dir && executable(join(dir, binary))) {
			return join(dir, binary);
		}
	}
	return undefined;
}

/** The harness CLI: the configured one, else on PATH, else a well-known install location. */
export function findHarness(profile: HarnessProfile, override: ProfileOverride | undefined): string | undefined {
	if (override?.harnessPath) {
		return expandHome(override.harnessPath);
	}
	return which(profile.harness.binary) ?? profile.harness.fallbackPaths?.map(expandHome).find(executable);
}

/** The editor's node: Electron run as node (the extension host's own binary). */
export const EDITOR_NODE = { path: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };

export async function resolveLaunch(profile: HarnessProfile, override: ProfileOverride | undefined, installer: AdapterInstaller, cwd: string, progress: (m: string) => void): Promise<AgentLaunch> {
	const harnessPath = findHarness(profile, override);
	if (override?.adapterPath) {
		return launchFor(profile, { adapter: { kind: 'command', command: expandHome(override.adapterPath) }, node: EDITOR_NODE, harnessPath, cwd });
	}
	if (!installer.installed(profile, !harnessPath)) {
		progress(`Downloading the ${profile.label} adapter (${profile.adapter.npm}@${profile.adapter.version})…`);
	}
	const installed = await installer.ensure(profile, { omitOptional: !!harnessPath, onProgress: progress });
	return launchFor(profile, { adapter: { kind: 'script', path: installed.entry }, node: EDITOR_NODE, harnessPath, cwd });
}

/** The login command line: the user's CLI, or the adapter's bundled copy run under the editor's node. */
export async function loginCommand(profile: HarnessProfile, override: ProfileOverride | undefined, installer: AdapterInstaller): Promise<{ shellPath: string; shellArgs: string[]; env?: Record<string, string> }> {
	const cli = findHarness(profile, override);
	if (cli) {
		return { shellPath: cli, shellArgs: [...profile.login.args] };
	}
	if (!profile.harness.bundled) {
		throw new Error(`${profile.harness.binary} isn't on PATH. Install ${profile.label}, or set agentChat.harnesses.${profile.id}.harnessPath.`);
	}
	const installed = await installer.ensure(profile, { omitOptional: false });
	return { shellPath: EDITOR_NODE.path, shellArgs: [join(installed.nodeModules, profile.harness.bundled), ...profile.login.args], env: EDITOR_NODE.env };
}
