/**
 * Harness profiles: the tailoring data for one ACP harness. Everything the UI shows comes from what the adapter
 * advertises; a profile only says how to launch it, which defaults to apply, which values to hide or confirm,
 * and when a changed option takes effect.
 */

/**
 * When a config option change takes effect.
 * - `live`: the harness applies it immediately, mid-turn included (Claude: everything).
 * - `next-turn`: accepted at once, applied from the next prompt (Codex: mode, model, effort, fast).
 * - `launch`: only at adapter start (env/flags); shown read-only until a restart.
 */
export type OptionTiming = 'live' | 'next-turn' | 'launch';

export interface HarnessProfile {
	/** Stable id: `claude`, `codex`. The chat session type is `agent-<id>`. */
	readonly id: string;
	readonly label: string;
	/**
	 * The ACP adapter: a pinned npm package installed on first use (`npm`), or one that ships with the editor
	 * (`bundled`: a script in the extension's `dist/adapters`, tact's). `adapterPath` overrides either.
	 */
	readonly adapter: NpmAdapter | { readonly bundled: string };
	/**
	 * The harness's own CLI. When found on PATH it's passed to the adapter through `env`, so the user's install,
	 * version and login are shared (and the adapter's bundled copy isn't needed). `bundled` is the adapter's own
	 * copy (a node script, relative to the install's node_modules), used for login when the CLI isn't on PATH.
	 */
	readonly harness: { readonly binary: string; readonly env?: string; readonly bundled?: string; readonly fallbackPaths?: readonly string[] };
	/** Extra adapter environment. */
	readonly env?: Readonly<Record<string, string>>;
	/** Defaults that can only be set at launch: config id → env var carrying `defaults[id]`. */
	readonly launchEnv?: Readonly<Record<string, string>>;
	/** `session/new` `_meta`. */
	readonly sessionMeta?: Readonly<Record<string, unknown>>;
	/** Applied with `session/set_config_option` after `session/new`, only if the agent offers the value. */
	readonly defaults?: Readonly<Record<string, string>>;
	/** Values never offered in the UI (Claude's Bypass). Keyed by config id. */
	readonly hiddenValues?: Readonly<Record<string, readonly string[]>>;
	/** Values that need an explicit confirmation (Codex Full access, Claude's Bypass). Keyed by config id. */
	readonly dangerousValues?: Readonly<Record<string, readonly string[]>>;
	/**
	 * Values a chat is only in for as long as it runs (Claude's Bypass): never a default, never saved with a chat,
	 * and never set again after a reload, a restart or an adapter recovery. The chat goes back to the value it had
	 * before (else the profile's default, else the strictest one offered). Keyed by config id.
	 */
	readonly transientValues?: Readonly<Record<string, readonly string[]>>;
	/** When option changes apply: per config id, else `default`. */
	readonly timing: { readonly default: OptionTiming; readonly byId?: Readonly<Record<string, OptionTiming>> };
	/**
	 * Option values in which the harness doesn't edit files (plan, read-only). A chat in one of them doesn't wait
	 * for another chat's turn to end. Keyed by config id.
	 */
	readonly readOnlyValues?: Readonly<Record<string, readonly string[]>>;
	/**
	 * The option that decides what the agent may do without asking, its values strictest first. A chat's saved
	 * value that can't be set again (after a restart, say) falls back to the strictest value offered, never to a
	 * looser one. Values not listed count as the loosest.
	 */
	readonly permissionOption?: { readonly configId: string; readonly strictest: readonly string[] };
	/** A codicon id for the harness's chats. */
	readonly icon?: string;
	/** Where plan mode lives (`mode=plan` for Claude, `collaboration_mode=plan` for Codex). */
	readonly planOption?: { readonly configId: string; readonly value: string };
	/** The harness's login command, run in a terminal: `<binary> ...args`. */
	readonly login: { readonly args: readonly string[] };
	/** Shown in the model picker before the adapter has started for the first time. */
	readonly placeholderModel: { readonly id: string; readonly name: string };
	/** How to install the harness, shown when its CLI isn't found. */
	readonly install?: string;
	/** Standing permission rules (phase C rules editor). */
	readonly rules?: { readonly format: 'claude-settings' | 'codex-execpolicy'; readonly files: readonly string[] };
}

export interface NpmAdapter {
	readonly npm: string;
	readonly version: string;
	readonly bin: string;
}

/** The profile's npm adapter (throws for a bundled one, which needs no install). */
export function npmAdapter(profile: HarnessProfile): NpmAdapter {
	if (!('npm' in profile.adapter)) {
		throw new Error(`${profile.label}'s adapter ships with the editor; nothing to install`);
	}
	return profile.adapter;
}

export const CLAUDE: HarnessProfile = {
	id: 'claude',
	label: 'Claude Code',
	adapter: { npm: '@agentclientprotocol/claude-agent-acp', version: '0.87.0', bin: 'claude-agent-acp' },
	harness: { binary: 'claude', env: 'CLAUDE_CODE_EXECUTABLE', fallbackPaths: ['~/.local/bin/claude', '~/.claude/local/claude'] },
	// Bypass is allowed in every session: the adapter's `--allow-dangerously-skip-permissions` (it passes the option to
	// the SDK, which starts Claude Code with that flag), so Bypass permissions is in the mode list. The adapter and
	// Claude Code still refuse it as root outside a sandbox (`IS_SANDBOX`), and when settings disable it
	// (`permissions.disableBypassPermissionsMode`): then it's simply not offered. A chat never starts in it: Accept
	// edits is the approved default (commands still prompt), choosing Bypass is confirmed each time, and it's never
	// restored (`transientValues`).
	sessionMeta: { claudeCode: { options: { allowDangerouslySkipPermissions: true } } },
	defaults: { mode: 'acceptEdits' },
	dangerousValues: { mode: ['bypassPermissions'] },
	transientValues: { mode: ['bypassPermissions'] },
	timing: { default: 'live' },
	readOnlyValues: { mode: ['plan'] },
	// Manual asks before every edit and command; Plan doesn't edit (leaving it asks); Auto approves by itself.
	permissionOption: { configId: 'mode', strictest: ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions'] },
	icon: 'sparkle',
	planOption: { configId: 'mode', value: 'plan' },
	login: { args: ['auth', 'login'] },
	placeholderModel: { id: 'default', name: 'Default (recommended)' },
	rules: { format: 'claude-settings', files: ['~/.claude/settings.json', '${workspace}/.claude/settings.json', '${workspace}/.claude/settings.local.json'] },
};

export const CODEX: HarnessProfile = {
	id: 'codex',
	label: 'Codex',
	adapter: { npm: '@agentclientprotocol/codex-acp', version: '2.1.1', bin: 'codex-acp' },
	harness: { binary: 'codex', env: 'CODEX_PATH', bundled: '@openai/codex/bin/codex.js' },
	// Device-code login needs URL elicitation, which we don't advertise; logins go through `codex login` in a terminal.
	env: { NO_BROWSER: '1' },
	// Codex reads its initial mode only from the environment; Workspace access is the approved default.
	launchEnv: { mode: 'INITIAL_AGENT_MODE' },
	defaults: { mode: 'workspace-write' },
	dangerousValues: { mode: ['agent-full-access'] },
	// The adapter sends approval policy, sandbox, model, effort and speed with each turn.
	timing: { default: 'next-turn', byId: { collaboration_mode: 'live' } },
	readOnlyValues: { mode: ['read-only'], collaboration_mode: ['plan'] },
	permissionOption: { configId: 'mode', strictest: ['read-only', 'workspace-write', 'agent', 'agent-full-access'] },
	icon: 'terminal',
	planOption: { configId: 'collaboration_mode', value: 'plan' },
	login: { args: ['login'] },
	placeholderModel: { id: 'default', name: 'Default' },
	rules: { format: 'codex-execpolicy', files: ['~/.codex/rules/default.rules'] },
};

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
	placeholderModel: { id: 'gpt-6.1-sol', name: 'Sol' },
	install: 'Install tact with `cargo install --locked --git https://github.com/clabby/tact tact` (the web API the editor uses is on tact\'s main branch, after v0.8.3), then sign in with `tact auth login`.',
};

export const BUILTIN_PROFILES: readonly HarnessProfile[] = [CLAUDE, CODEX, TACT];

/** Whether a chat only keeps `value` while it runs (see `transientValues`). */
export function isTransient(profile: HarnessProfile, configId: string, value: string): boolean {
	return profile.transientValues?.[configId]?.includes(value) ?? false;
}

/** User overrides from settings (`agentChat.harnesses.<id>`). */
export interface ProfileOverride {
	/** An installed adapter command to run instead of the pinned npm install. */
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
	// A transient value (Claude's Bypass) is never a default, also not the user's.
	const defaults = Object.fromEntries(Object.entries(override.defaults ?? {}).filter(([id, value]) => !isTransient(profile, id, value)));
	return {
		...profile,
		env: { ...profile.env, ...override.env },
		defaults: { ...profile.defaults, ...defaults },
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
	/** The adapter: an installed JS entry run with `node`, or a user-provided command. */
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
	for (const [configId, variable] of Object.entries(profile.launchEnv ?? {})) {
		const value = profile.defaults?.[configId];
		if (value) {
			env[variable] = value;
		}
	}
	if (inputs.harnessPath && profile.harness.env) {
		env[profile.harness.env] = inputs.harnessPath;
	}
	if (inputs.adapter.kind === 'script') {
		return { command: inputs.node.path, args: [inputs.adapter.path], env: { ...inputs.node.env, ...env }, cwd: inputs.cwd };
	}
	return { command: inputs.adapter.command, args: [], env, cwd: inputs.cwd };
}
