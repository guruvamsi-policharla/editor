import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentLaunch } from '../../src/index.js';

/** Contract tests talk to real adapters (and spend real model usage), so they only run when asked. */
export const RUN_CONTRACT = process.env.RUN_ACP_CONTRACT === '1';

function which(bin: string): string | undefined {
	try {
		return execFileSync('which', [bin], { encoding: 'utf8' }).trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * The adapter command: `ACP_<NAME>_ADAPTER` (path to an installed adapter bin) or the pinned npm version via npx.
 * The user's own harness binary is used when it's on PATH, as the product will.
 */
export function adapterLaunch(name: 'claude' | 'codex'): AgentLaunch {
	const pinned = { claude: '@agentclientprotocol/claude-agent-acp@0.87.0', codex: '@agentclientprotocol/codex-acp@2.1.1' }[name];
	const override = process.env[`ACP_${name.toUpperCase()}_ADAPTER`];
	const base = override ? { command: override, args: [] } : { command: 'npx', args: ['--yes', pinned] };
	if (name === 'claude') {
		const claude = which('claude') ?? join(homedir(), '.local/bin/claude');
		return { ...base, env: { CLAUDE_CODE_EXECUTABLE: claude } };
	}
	const codex = which('codex');
	return { ...base, env: { INITIAL_AGENT_MODE: 'workspace-write', NO_BROWSER: '1', ...(codex ? { CODEX_PATH: codex } : {}) } };
}

export function tempWorkspace(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'acp-contract-'));
	for (const [path, text] of Object.entries(files)) {
		writeFileSync(join(dir, path), text);
	}
	return dir;
}
