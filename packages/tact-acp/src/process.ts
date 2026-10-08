/**
 * Starting tact for one ACP session. tact has no headless mode: its web API is served only while its terminal
 * UI runs, and the UI refuses to start without a terminal. So tact runs under `script(1)`, which gives it a pty
 * nobody looks at, and the instance is found through the registry file it writes
 * (`$TACT_HOME/web/instances/<pid>.json`: pid, port, workspace) plus the machine token (`$TACT_HOME/web/token`).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TactLaunch {
	/** The tact binary. */
	tact: string;
	/** The workspace (tact's `--workspace`). */
	cwd: string;
	/** `$TACT_HOME` (default `~/.tact`). */
	tactHome?: string;
	/** Extra tact arguments (`--resume <id>`). */
	args?: readonly string[];
	env?: Record<string, string | undefined>;
	/** How long to wait for the web server (default 30 s). */
	timeoutMs?: number;
}

export interface TactInstance {
	pid: number;
	port: number;
	token: string;
	/** What tact printed to its terminal (ANSI stripped), the last few KB. */
	output(): string;
	readonly exited: Promise<number | null>;
	kill(): void;
}

export class TactStartError extends Error {
	constructor(message: string, readonly kind: 'auth' | 'no-web' | 'exited' | 'timeout' | 'spawn') {
		super(message);
	}
}

export function tactHome(env: Record<string, string | undefined> = process.env): string {
	return env.TACT_HOME?.trim() || join(homedir(), '.tact');
}

/** Whether this tact serves the web API (`--web`; tact's main branch after v0.8.3). */
export function hasWebApi(tact: string): boolean {
	const help = spawnSync(tact, ['--help'], { encoding: 'utf8', timeout: 10_000 });
	return /--web\b/.test(`${help.stdout ?? ''}`);
}

function quote(arg: string): string {
	return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * `script` with a pty for the command and no transcript file (util-linux on Linux, BSD on macOS).
 * `stdin` is what `script` itself gets: BSD `script` calls tcgetattr on its stdin and only tolerates ENOTTY, so a
 * Node pipe (a socket) makes it exit with "tcgetattr/ioctl: Operation not supported on socket"; /dev/null is fine.
 * tact is driven through its web API, so nothing is ever typed into the pty.
 */
export function ptyCommand(argv: readonly string[], platform = process.platform): { command: string; args: string[]; stdin: 'ignore' | 'pipe' } {
	return platform === 'darwin'
		? { command: 'script', args: ['-q', '/dev/null', ...argv], stdin: 'ignore' }
		: { command: 'script', args: ['-qfec', argv.map(quote).join(' '), '/dev/null'], stdin: 'pipe' };
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][\w]|\x1b[=>78]|[\x00-\x08\x0b-\x1f]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, '');
}

interface Registration {
	pid: number;
	port: number;
	workspace: string;
	started_at?: number;
}

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function registrations(home: string): Registration[] {
	const dir = join(home, 'web', 'instances');
	if (!existsSync(dir)) {
		return [];
	}
	const out: Registration[] = [];
	for (const name of readdirSync(dir)) {
		try {
			const r = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Registration;
			if (typeof r.pid === 'number' && typeof r.port === 'number') {
				out.push(r);
			}
		} catch {
			// being written, or stale
		}
	}
	return out;
}

/** Instances already handed out (several sessions of one adapter run in the same workspace). */
const claimed = new Set<number>();
let launching: Promise<unknown> = Promise.resolve();

/** Starts tact and waits for its web server. Launches are serialized, so registrations can't be confused. */
export function launchTact(o: TactLaunch): Promise<TactInstance> {
	const next = launching.then(() => start(o));
	launching = next.catch(() => undefined);
	return next;
}

async function start(o: TactLaunch): Promise<TactInstance> {
	const env = { ...process.env, ...o.env, TACT_WEB: 'true', TERM: process.env.TERM && process.env.TERM !== 'dumb' ? process.env.TERM : 'xterm-256color' };
	const home = tactHome(env);
	const workspace = real(o.cwd);
	const before = new Set(registrations(home).map(r => r.pid));
	const pty = ptyCommand([o.tact, '--workspace', o.cwd, ...(o.args ?? [])]);
	let child: ChildProcess;
	try {
		// In the adapter's process group: when the editor ends the adapter's group, `script` goes too, and tact exits
		// on the pty's hangup.
		child = spawn(pty.command, pty.args, { cwd: o.cwd, env, stdio: [pty.stdin, 'pipe', 'pipe'] });
	} catch (e) {
		throw new TactStartError(`couldn't start tact: ${e instanceof Error ? e.message : String(e)}`, 'spawn');
	}
	let output = '';
	const keep = (chunk: Buffer) => {
		output = (output + chunk.toString('utf8')).slice(-16_000);
	};
	child.stdout?.on('data', keep);
	child.stderr?.on('data', keep);
	let exitCode: number | null | undefined;
	const exited = new Promise<number | null>(resolve => {
		child.on('exit', code => { exitCode = code; resolve(code); });
		child.on('error', err => { output += `\n${err.message}`; exitCode = null; resolve(null); });
	});
	const kill = () => {
		if (exitCode === undefined) {
			child.kill('SIGTERM');
		}
	};
	const text = () => stripAnsi(output);

	const deadline = Date.now() + (o.timeoutMs ?? 30_000);
	while (Date.now() < deadline) {
		if (exitCode !== undefined) {
			throw startFailure(text(), exitCode);
		}
		const found = registrations(home).find(r => !before.has(r.pid) && !claimed.has(r.pid) && real(r.workspace) === workspace);
		const tokenFile = join(home, 'web', 'token');
		if (found && existsSync(tokenFile)) {
			claimed.add(found.pid);
			void exited.then(() => claimed.delete(found.pid));
			return { pid: found.pid, port: found.port, token: readFileSync(tokenFile, 'utf8').trim(), output: text, exited, kill };
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	kill();
	throw new TactStartError(`tact started, but its web server didn't come up within ${Math.round((o.timeoutMs ?? 30_000) / 1000)} s.\n${tail(text())}`, 'timeout');
}

function tail(text: string): string {
	return text.trim().split('\n').slice(-12).join('\n');
}

/** Why tact exited before its web server came up, from what it printed. */
export function startFailure(output: string, code: number | null): TactStartError {
	const text = output.replace(/[│├╰─▶×]/g, ' ').replace(/[ \t]+/g, ' ');
	if (/no ChatGPT credentials|run `?tact auth login`?|OPENAI_API_KEY is not set/i.test(text)) {
		return new TactStartError(`tact isn't signed in: run \`tact auth login\` (or set OPENAI_API_KEY).\n${tail(text)}`, 'auth');
	}
	return new TactStartError(`tact exited (code ${code ?? '?'}) before its web server came up.\n${tail(text)}`, 'exited');
}
