/**
 * Harness profiles: the tailoring data for one ACP harness. Everything the UI shows comes from what the adapter
 * advertises; a profile only says how to launch it, which defaults to apply, and when a changed option takes effect.
 */

/**
 * When a config option change takes effect.
 * - `live`: the harness applies it immediately, mid-turn included.
 * - `next-turn`: accepted at once, applied from the next prompt.
 * - `launch`: only at adapter start (env/flags); shown read-only until a restart.
 */
export type OptionTiming = 'live' | 'next-turn' | 'launch';

export interface HarnessProfile {
	/** Stable id (`tact`). The chat session type is `agent-<id>`. */
	readonly id: string;
	readonly label: string;
	/** The ACP adapter: a script that ships with the editor, in the extension's `dist/adapters` (tact's). `adapterPath` overrides it. */
	readonly adapter: { readonly bundled: string };
	/**
	 * The harness's own CLI, which the adapter drives. Found on PATH (else at `fallbackPaths`) and passed to the adapter
	 * through `env`, so the user's install, version and login are used.
	 */
	readonly harness: { readonly binary: string; readonly env?: string; readonly fallbackPaths?: readonly string[] };
	/** Extra adapter environment. */
	readonly env?: Readonly<Record<string, string>>;
	/** `session/new` `_meta`. */
	readonly sessionMeta?: Readonly<Record<string, unknown>>;
	/** Applied with `session/set_config_option` after `session/new`, only if the agent offers the value. */
	readonly defaults?: Readonly<Record<string, string>>;
	/** When option changes apply: per config id, else `default`. */
	readonly timing: { readonly default: OptionTiming; readonly byId?: Readonly<Record<string, OptionTiming>> };
	/**
	 * Option values in which the harness doesn't edit files (a plan mode). A chat in one of them doesn't wait for another
	 * chat's turn to end. Keyed by config id.
	 */
	readonly readOnlyValues?: Readonly<Record<string, readonly string[]>>;
	/** A codicon id for the harness's chats. */
	readonly icon?: string;
	/** The harness's login command, run in a terminal: `<binary> ...args`. */
	readonly login: { readonly args: readonly string[] };
	/** Shown in the model picker before the adapter has started for the first time (the harness's own default). */
	readonly placeholderModel: { readonly id: string; readonly name: string };
	/** How to install the harness, shown when its CLI isn't found. */
	readonly install?: string;
	/** A shell command line that installs it, offered to run in a terminal when its CLI isn't found. */
	readonly installCommand?: string;
}

/**
 * tact (https://github.com/clabby/tact), Nanocodex in a terminal UI. tact has no ACP mode; our adapter
 * (packages/tact-acp, bundled) runs its terminal UI in a hidden pty and talks to the web API every running tact
 * serves (tact's main branch after v0.8.3). tact never asks for permission: Nanocodex runs with full access.
 */
export const TACT: HarnessProfile = {
	id: 'tact',
	label: 'tact',
	adapter: { bundled: 'tact-acp.js' },
	harness: { binary: 'tact', env: 'TACT_BIN', fallbackPaths: ['~/.local/bin/tact', '~/.cargo/bin/tact'] },
	// The model and reasoning mode are fixed after the first message (the adapter then offers only the current one).
	timing: { default: 'live' },
	icon: 'rocket',
	login: { args: ['auth', 'login'] },
	// The models themselves come from tact's catalog once it has run; until then, whatever tact's config picks.
	placeholderModel: { id: 'default', name: 'Default model' },
	installCommand: 'curl -fsSL https://tact.clab.by/install.sh | TACT_CHANNEL=pre-release sh',
	install: 'Install tact with `curl -fsSL https://tact.clab.by/install.sh | TACT_CHANNEL=pre-release sh` (the editor needs tact\'s web API, which is on its main branch after v0.8.3: the pre-release channel has it), then sign in with `tact auth login`.',
};

/** The harnesses the chat offers. tact is the only one, and the default. */
export const BUILTIN_PROFILES: readonly HarnessProfile[] = [TACT];

export const DEFAULT_PROFILE: HarnessProfile = TACT;

/** User overrides from settings (`agentChat.harnesses.<id>`). */
export interface ProfileOverride {
	/** An adapter command to run instead of the bundled one. */
	adapterPath?: string;
	/** The harness CLI to use instead of the one found on PATH. */
	harnessPath?: string;
	env?: Record<string, string>;
	defaults?: Record<string, string>;
}

export function withOverride(profile: HarnessProfile, override: ProfileOverride | undefined): HarnessProfile {
	if (!override) {
		return profile;
	}
	return {
		...profile,
		env: { ...profile.env, ...override.env },
		defaults: { ...profile.defaults, ...override.defaults },
	};
}

export function optionTiming(profile: HarnessProfile, configId: string): OptionTiming {
	return profile.timing.byId?.[configId] ?? profile.timing.default;
}

export interface AgentLaunch {
	command: string;
	args?: readonly string[];
	/** Merged over the parent environment. */
	env?: Record<string, string | undefined>;
	cwd?: string;
}

export interface LaunchInputs {
	/** The adapter: a JS entry run with `node`, or a user-provided command. */
	adapter: { kind: 'script'; path: string } | { kind: 'command'; command: string };
	/** The node to run JS entries with. In the editor that's the extension host's Electron (`ELECTRON_RUN_AS_NODE`). */
	node: { path: string; env?: Record<string, string> };
	/** The harness CLI to hand to the adapter, if found. */
	harnessPath?: string;
	cwd: string;
}

/** The adapter's command line and environment. No shell is involved: argv is explicit. */
export function launchFor(profile: HarnessProfile, inputs: LaunchInputs): AgentLaunch {
	const env: Record<string, string> = { ...profile.env };
	if (inputs.harnessPath && profile.harness.env) {
		env[profile.harness.env] = inputs.harnessPath;
	}
	if (inputs.adapter.kind === 'script') {
		return { command: inputs.node.path, args: [inputs.adapter.path], env: { ...inputs.node.env, ...env }, cwd: inputs.cwd };
	}
	return { command: inputs.adapter.command, args: [], env, cwd: inputs.cwd };
}
