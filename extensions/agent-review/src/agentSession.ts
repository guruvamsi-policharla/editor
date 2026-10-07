/**
 * Starting the agent in a fresh terminal without racing it. Text typed into the terminal before the agent
 * command has started lands at the shell prompt (or in the command line being typed), not in the agent.
 * So the command is run through shell integration when the shell offers it, and anything sent to the agent
 * waits until the shell reports that the command started. Without shell integration (or if it never
 * reports), timeouts fall back to plain typing.
 *
 * No `vscode` dependency: the terminal is reached through `AgentTerminalIO` (see agentTerminal.ts).
 */

export interface Disposable {
  dispose(): void;
}

export interface AgentTerminalIO {
  /** Run a command through shell integration, if the shell has reported it (undefined otherwise). */
  readonly executeCommand: ((commandLine: string) => void) | undefined;
  /** Fires once when shell integration becomes available. */
  onDidActivateShellIntegration(listener: () => void): Disposable;
  /** Fires when a command starts executing in this terminal (shell integration). */
  onDidStartExecution(listener: () => void): Disposable;
  sendText(text: string, addNewLine: boolean): void;
  /** The terminal was closed (or its process exited). */
  readonly isClosed: boolean;
}

export interface AgentLaunchTimeouts {
  /** How long to wait for the shell to report shell integration before typing the command instead. */
  shellIntegrationMs: number;
  /** How long to wait for the command to start after running it through shell integration. */
  startMs: number;
  /** Without shell integration: how long to give the typed command to start before typing more. */
  fallbackStartMs: number;
}

export const DEFAULT_TIMEOUTS: AgentLaunchTimeouts = { shellIntegrationMs: 3000, startMs: 5000, fallbackStartMs: 1000 };

/** How the agent was started: through shell integration, typed after a timeout, or nothing to start. */
export type LaunchResult = 'started' | 'start-timeout' | 'typed' | 'none';

export class AgentSession {
  /** Settles when it is safe to type into the agent. */
  readonly ready: Promise<LaunchResult>;
  private queue: Promise<unknown>;

  constructor(
    private readonly io: AgentTerminalIO,
    command: string,
    timeouts: AgentLaunchTimeouts = DEFAULT_TIMEOUTS,
  ) {
    this.ready = command ? launch(io, command, timeouts) : Promise.resolve('none');
    this.queue = this.ready;
  }

  /** Type `text` into the agent once it has started. Sends keep their order. False if the terminal closed. */
  send(text: string): Promise<boolean> {
    const sent = this.queue.then(() => {
      if (this.io.isClosed) return false;
      this.io.sendText(text, false);
      return true;
    });
    this.queue = sent;
    return sent;
  }
}

async function launch(io: AgentTerminalIO, command: string, t: AgentLaunchTimeouts): Promise<LaunchResult> {
  if (!io.executeCommand) await waitFor((fire) => io.onDidActivateShellIntegration(fire), t.shellIntegrationMs);
  const execute = io.executeCommand;
  if (io.isClosed) return 'none';
  if (!execute) {
    // No shell integration (or it's off): type the command into the shell and give it a moment to start.
    io.sendText(command, true);
    await delay(t.fallbackStartMs);
    return 'typed';
  }
  // Listen before running it, so a quick start isn't missed.
  const started = waitFor((fire) => io.onDidStartExecution(fire), t.startMs);
  execute(command);
  return (await started) ? 'started' : 'start-timeout';
}

/** Resolves true when the event fires, false after `ms`. */
function waitFor(subscribe: (fire: () => void) => Disposable, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let sub: Disposable | undefined;
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sub?.dispose();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), ms);
    sub = subscribe(() => finish(true));
    if (done) sub.dispose();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
