/**
 * Starting tact for one ACP session. tact has no headless mode: its web API is served only while its terminal
 * UI runs, and the UI refuses to start without a terminal. So tact runs under `script(1)`, which gives it a pty
 * nobody looks at, and the instance is found through the registry file it writes
 * (`$TACT_HOME/web/instances/<pid>.json`: pid, port, workspace) plus the machine token (`$TACT_HOME/web/token`).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, constants, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PTY_SIZE, stripAnsi, TerminalResponder } from './terminal.js';

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
 * `script` with a pty for the command and no transcript file (util-linux on Linux, BSD on macOS). Inside, `/bin/sh`
 * sets the pty's size (a pty `script` creates without a terminal of its own is 0×0) and execs tact.
 *
 * `script`'s own stdin is a FIFO the adapter holds open (`stdin: 'fifo'`); what's written to it reaches tact as
 * typed input, which is how the adapter answers tact's terminal queries (terminal.ts). Not a Node pipe: that's a
 * socket, and BSD `script` calls tcgetattr on its stdin and only tolerates ENOTTY ("tcgetattr/ioctl: Operation not
 * supported on socket"). Not /dev/null: BSD `script` then sends the pty an EOF (`^D`) and nobody can answer tact.
 * util-linux `script` runs the command with `$SHELL -c`, so it gets SHELL=/bin/sh (`env`) and the command puts the
 * user's SHELL back for tact. `fallback` is for when no FIFO can be made: a pipe on Linux, /dev/null on macOS.
 */
export function ptyCommand(argv: readonly string[], platform = process.platform, shell?: string): { command: string; args: string[]; env: Record<string, string | undefined>; stdin: 'fifo'; fallback: 'pipe' | 'ignore' } {
	const size = `stty rows ${PTY_SIZE.rows} columns ${PTY_SIZE.cols} 2>/dev/null; `;
	if (platform === 'darwin') {
		return { command: 'script', args: ['-q', '/dev/null', '/bin/sh', '-c', `${size}exec "$@"`, 'sh', ...argv], env: {}, stdin: 'fifo', fallback: 'ignore' };
	}
	const restore = shell ? `SHELL=${quote(shell)} ` : 'unset SHELL; ';
	return { command: 'script', args: ['-qfec', `${size}${restore}exec ${argv.map(quote).join(' ')}`, '/dev/null'], env: { SHELL: '/bin/sh' }, stdin: 'fifo', fallback: 'pipe' };
}

/**
 * A FIFO opened read-write (so opening never blocks and `script` never sees an EOF), for `script`'s stdin. Its path
 * is unlinked at once: the open descriptors keep it. Undefined where `mkfifo` isn't available.
 */
export function openFifo(): number | undefined {
	let dir: string | undefined;
	try {
		dir = mkdtempSync(join(tmpdir(), 'tact-acp-'));
		const path = join(dir, 'stdin');
		if (spawnSync('mkfifo', ['-m', '600', path]).status !== 0) {
			return undefined;
		}
		return openSync(path, constants.O_RDWR);
	} catch {
		return undefined;
	} finally {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

export { stripAnsi };

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
	const env: Record<string, string | undefined> = { ...process.env, ...o.env, TACT_WEB: 'true', TERM: process.env.TERM && process.env.TERM !== 'dumb' ? process.env.TERM : 'xterm-256color' };
	const home = tactHome(env);
	const workspace = real(o.cwd);
	const before = new Set(registrations(home).map(r => r.pid));
	const pty = ptyCommand([o.tact, '--workspace', o.cwd, ...(o.args ?? [])], process.platform, env.SHELL);
	const fifo = openFifo();
	let child: ChildProcess;
	try {
		// In the adapter's process group: when the editor ends the adapter's group, `script` goes too, and tact exits
		// on the pty's hangup.
		child = spawn(pty.command, pty.args, { cwd: o.cwd, env: { ...env, ...pty.env }, stdio: [fifo ?? pty.fallback, 'pipe', 'pipe'] });
	} catch (e) {
		if (fifo !== undefined) {
			closeSync(fifo);
		}
		throw new TactStartError(`couldn't start tact: ${e instanceof Error ? e.message : String(e)}`, 'spawn');
	}
	// tact's input: the FIFO (the child has its own copy of the descriptor), else the stdin pipe on Linux.
	let input: ((data: string) => void) | undefined = fifo !== undefined
		? data => writeSync(fifo, data)
		: child.stdin ? data => child.stdin!.write(data) : undefined;
	const responder = new TerminalResponder(data => {
		try {
			input?.(data);
		} catch {
			// tact is gone
		}
	});
	let output = '';
	child.stdout?.setEncoding('utf8');
	child.stderr?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => {
		responder.feed(chunk);
		output = (output + chunk).slice(-16_000);
	});
	child.stderr?.on('data', (chunk: string) => {
		output = (output + chunk).slice(-16_000);
	});
	let exitCode: number | null | undefined;
	const exited = new Promise<number | null>(resolve => {
		const done = (code: number | null) => {
			if (exitCode !== undefined) {
				return;
			}
			exitCode = code;
			input = undefined;
			if (fifo !== undefined) {
				closeSync(fifo);
			}
			resolve(code);
		};
		// `close`, not `exit`: by then all of tact's output is in (the sign-in check reads it).
		child.on('close', code => done(code));
		child.on('error', err => { output += `\n${err.message}`; done(null); });
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
