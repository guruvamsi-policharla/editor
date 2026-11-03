// Where a harness comes from: the user's CLI on PATH (shared install and login), driven by the adapter that ships
// with the editor (or a user-configured adapter command), run under the editor's own Node (Electron as node), so
// no system Node is needed at run time.
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { launchFor, type AgentLaunch, type HarnessProfile, type ProfileOverride } from '@editor/acp-client';

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

/** The harness's CLI isn't installed: the chat says how to install it (and offers the profile's install command). */
export class HarnessMissingError extends Error {
	constructor(readonly profile: HarnessProfile) {
		super(`${profile.harness.binary} isn't installed (not on PATH). ${profile.install ?? ''}`.trim());
	}
}

/** The editor's node: Electron run as node (the extension host's own binary). */
export const EDITOR_NODE = { path: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };

/**
 * The adapter's launch. `bundledDir` holds the adapters that ship with the extension (tact's); the adapter drives
 * the user's CLI, so a missing CLI is an error that says how to install it.
 */
export function resolveLaunch(profile: HarnessProfile, override: ProfileOverride | undefined, cwd: string, bundledDir: string): AgentLaunch {
	const harnessPath = findHarness(profile, override);
	if (override?.adapterPath) {
		return launchFor(profile, { adapter: { kind: 'command', command: expandHome(override.adapterPath) }, node: EDITOR_NODE, harnessPath, cwd });
	}
	if (!harnessPath) {
		throw new HarnessMissingError(profile);
	}
	return launchFor(profile, { adapter: { kind: 'script', path: join(bundledDir, profile.adapter.bundled) }, node: EDITOR_NODE, harnessPath, cwd });
}

/** The login command line: the user's CLI. */
export function loginCommand(profile: HarnessProfile, override: ProfileOverride | undefined): { shellPath: string; shellArgs: string[] } {
	const cli = findHarness(profile, override);
	if (!cli) {
		throw new Error(`${profile.harness.binary} isn't on PATH. ${profile.install ?? `Install ${profile.label}`}, or set agentChat.harnesses.${profile.id}.harnessPath.`);
	}
	return { shellPath: cli, shellArgs: [...profile.login.args] };
}
