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
	/** tact is ended when this process is gone (default: the adapter's). */
	watch?: number;
	/** Which `script` to drive (default: this platform's; tests run the macOS one through a shim). */
	platform?: NodeJS.Platform;
}

export interface TactInstance {
	pid: number;
	port: number;
	token: string;
	/** What tact printed to its terminal (ANSI stripped), the last few KB. */
	output(): string;
	/** Calls `listener` with each chunk tact writes to its terminal (raw, with escapes), until the returned function. */
	onOutput(listener: (chunk: string) => void): () => void;
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

/**
 * Whether this tact serves the web API (`--web`; tact's main branch after v0.8.3). A `--help` that didn't answer in
 * time (a busy machine, a first run being scanned) says nothing about tact's version: starting it will tell.
 */
export function hasWebApi(tact: string, timeoutMs = 10_000): boolean {
	const help = spawnSync(tact, ['--help'], { encoding: 'utf8', timeout: timeoutMs });
	if ((help.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
		return true;
	}
	return /--web\b/.test(`${help.stdout ?? ''}`);
}

function quote(arg: string): string {
	return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * `script` with a pty for the command and no transcript file (util-linux on Linux, BSD on macOS). Inside, `/bin/sh`
 * sets the pty's size (a pty `script` creates without a terminal of its own is 0×0), starts a watcher that ends
 * tact once the adapter (`watch`, a pid) is gone, so a killed adapter never leaves a tact behind, and execs tact.
 *
 * What's written to `script`'s stdin reaches tact as typed input: that's how the adapter answers tact's terminal
 * queries (terminal.ts). So it must be something the adapter writes to and `script` accepts:
 * - Linux (`stdin: 'fifo'`): the read end of a FIFO whose only writer is the adapter (when the adapter goes,
 *   `script` reads EOF). util-linux `script` runs the command with `$SHELL -c`, so it gets SHELL=/bin/sh (`env`) and
 *   the command puts the user's SHELL back for tact.
 * - macOS (`stdin: 'pipe'`): BSD `script` calls tcgetattr on its stdin and only tolerates ENOTTY. A Node pipe is a
 *   socket and a macOS FIFO is socket-backed ("tcgetattr/ioctl: Operation not supported on socket"); /dev/null makes
 *   it send the pty an EOF (`^D`) and forward nothing. So bash gives it a real pipe, a process substitution fed by
 *   `cat` from the adapter's stdin pipe, and execs it (`script` stays the adapter's child).
 */
export function ptyCommand(argv: readonly string[], platform = process.platform, shell?: string, watch?: number): { command: string; args: string[]; env: Record<string, string | undefined>; stdin: 'fifo' | 'pipe' } {
	const size = `stty rows ${PTY_SIZE.rows} columns ${PTY_SIZE.cols} 2>/dev/null; `;
	// In the subshell `$$` is still the shell that becomes tact.
	const watcher = watch ? `(while kill -0 ${watch} 2>/dev/null && kill -0 $$ 2>/dev/null; do sleep 2; done; kill -TERM $$ 2>/dev/null) </dev/null >/dev/null 2>&1 & ` : '';
	if (platform === 'darwin') {
		return {
			command: '/bin/bash',
			args: ['-c', 'exec script -q /dev/null /bin/sh -c "$0" sh "$@" < <(exec cat 2>/dev/null)', `${size}${watcher}exec "$@"`, ...argv],
			env: {},
			stdin: 'pipe',
		};
	}
	const restore = shell ? `SHELL=${quote(shell)} ` : 'unset SHELL; ';
	return { command: 'script', args: ['-qfec', `${size}${watcher}${restore}exec ${argv.map(quote).join(' ')}`, '/dev/null'], env: { SHELL: '/bin/sh' }, stdin: 'fifo' };
}

/**
 * A FIFO for `script`'s stdin: its read end (for the child) and its write end (the adapter's, the only writer: when
 * the adapter goes, `script` reads EOF). Opening read-write first means neither open blocks. The path is unlinked
 * at once: the open descriptors keep the FIFO. Undefined where `mkfifo` isn't available.
 */
export function openFifo(): { read: number; write: number } | undefined {
	let dir: string | undefined;
	try {
		dir = mkdtempSync(join(tmpdir(), 'tact-acp-'));
		const path = join(dir, 'stdin');
		if (spawnSync('mkfifo', ['-m', '600', path]).status !== 0) {
			return undefined;
		}
		const both = openSync(path, constants.O_RDWR);
		try {
			return { read: openSync(path, constants.O_RDONLY), write: openSync(path, constants.O_WRONLY) };
		} finally {
			closeSync(both);
		}
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
	const pty = ptyCommand([o.tact, '--workspace', o.cwd, ...(o.args ?? [])], o.platform ?? process.platform, env.SHELL, o.watch ?? process.pid);
	// Without a FIFO (no mkfifo), a pipe: util-linux `script` accepts a socket.
	const fifo = pty.stdin === 'fifo' ? openFifo() : undefined;
	let child: ChildProcess;
	try {
		// In the adapter's process group: when the editor ends the adapter's group, `script` goes too, and tact exits
		// on the pty's hangup.
		child = spawn(pty.command, pty.args, { cwd: o.cwd, env: { ...env, ...pty.env }, stdio: [fifo?.read ?? 'pipe', 'pipe', 'pipe'] });
	} catch (e) {
		if (fifo) {
			closeSync(fifo.write);
		}
		throw new TactStartError(`couldn't start tact: ${e instanceof Error ? e.message : String(e)}`, 'spawn');
	} finally {
		// The child has its own copy of the read end.
		if (fifo) {
			closeSync(fifo.read);
		}
	}
	// tact's input: the FIFO, else the stdin pipe.
	let input: ((data: string) => void) | undefined = fifo
		? data => writeSync(fifo.write, data)
		: child.stdin ? data => child.stdin!.write(data) : undefined;
	const responder = new TerminalResponder(data => {
		try {
			input?.(data);
		} catch {
			// tact is gone
		}
	});
	let output = '';
	const listeners = new Set<(chunk: string) => void>();
	child.stdout?.setEncoding('utf8');
	child.stderr?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => {
		responder.feed(chunk);
		output = (output + chunk).slice(-16_000);
		listeners.forEach(l => l(chunk));
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
			if (fifo) {
				closeSync(fifo.write);
			}
			resolve(code);
		};
		// `close`, not `exit`: by then all of tact's output is in (the sign-in check reads it).
		child.on('close', code => done(code));
		// On macOS `cat` feeds `script` from the stdin pipe: it ends when the pipe does.
		child.on('exit', () => child.stdin?.end());
		child.on('error', err => { output += `\n${err.message}`; done(null); });
	});
	const kill = () => {
		if (exitCode === undefined) {
			child.kill('SIGTERM');
		}
	};
	const text = () => stripAnsi(output);
	const onOutput = (listener: (chunk: string) => void) => {
		listeners.add(listener);
		return () => { listeners.delete(listener); };
	};

	// Counted in polls, not by the clock: a machine that sleeps or is paused meanwhile uses up one poll, not the wait.
	for (let polls = Math.ceil((o.timeoutMs ?? 30_000) / 100); polls > 0; polls--) {
		if (exitCode !== undefined) {
			throw startFailure(text(), exitCode);
		}
		const found = registrations(home).find(r => !before.has(r.pid) && !claimed.has(r.pid) && real(r.workspace) === workspace);
		const tokenFile = join(home, 'web', 'token');
		if (found && existsSync(tokenFile)) {
			claimed.add(found.pid);
			void exited.then(() => claimed.delete(found.pid));
			return { pid: found.pid, port: found.port, token: readFileSync(tokenFile, 'utf8').trim(), output: text, onOutput, exited, kill };
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
