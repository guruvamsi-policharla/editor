/**
 * Ctrl/Cmd+L right after the agent terminal is created: the reference must reach the agent, not the shell
 * prompt. A fake terminal plays the shell: it reports shell integration and command starts when told to, and
 * records where typed text lands (the shell's command line before the agent started, the agent after).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSession, type AgentTerminalIO } from '../src/agentSession';

class FakeTerminal implements AgentTerminalIO {
  integrated = false;
  agentRunning = false;
  isClosed = false;
  readonly toShell: string[] = [];
  readonly toAgent: string[] = [];
  readonly executed: string[] = [];
  private readonly integrationListeners = new Set<() => void>();
  private readonly startListeners = new Set<() => void>();

  get executeCommand() {
    return this.integrated ? (cmd: string) => void this.executed.push(cmd) : undefined;
  }
  onDidActivateShellIntegration(l: () => void) {
    this.integrationListeners.add(l);
    return { dispose: () => this.integrationListeners.delete(l) };
  }
  onDidStartExecution(l: () => void) {
    this.startListeners.add(l);
    return { dispose: () => this.startListeners.delete(l) };
  }
  sendText(text: string, addNewLine: boolean) {
    (this.agentRunning ? this.toAgent : this.toShell).push(text + (addNewLine ? '\n' : ''));
  }

  /** The shell finished starting and reported shell integration. */
  activateIntegration() {
    this.integrated = true;
    for (const l of [...this.integrationListeners]) l();
  }
  /** The shell started the agent command. */
  startAgent() {
    this.agentRunning = true;
    for (const l of [...this.startListeners]) l();
  }
  get listenerCount() {
    return this.integrationListeners.size + this.startListeners.size;
  }
}

const timeouts = { shellIntegrationMs: 3000, startMs: 5000, fallbackStartMs: 1000 };

describe('AgentSession (agent terminal startup)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('Ctrl+L right after creation waits for shell integration and the command to start', async () => {
    const term = new FakeTerminal();
    const session = new AgentSession(term, 'tact', timeouts);
    const sent = session.send('@paper/main.tex:L20-21 '); // immediately, while the shell is still starting

    await vi.advanceTimersByTimeAsync(200);
    expect(term.toShell).toEqual([]); // nothing typed at the (not yet ready) shell
    term.activateIntegration();
    await vi.advanceTimersByTimeAsync(0);
    expect(term.executed).toEqual(['tact']); // run through shell integration, not typed
    await vi.advanceTimersByTimeAsync(300);
    expect(term.toAgent).toEqual([]); // the command hasn't started yet: still waiting

    term.startAgent();
    expect(await sent).toBe(true);
    expect(await session.ready).toBe('started');
    expect(term.toShell).toEqual([]);
    expect(term.toAgent).toEqual(['@paper/main.tex:L20-21 ']);
    expect(term.listenerCount).toBe(0);
  });

  it('several sends keep their order; later sends go straight through', async () => {
    const term = new FakeTerminal();
    term.activateIntegration(); // integration already there (e.g. a fast shell)
    const session = new AgentSession(term, 'tact', timeouts);
    const a = session.send('@a.tex:L1 ');
    const b = session.send('@b.tex:L2 ');
    await vi.advanceTimersByTimeAsync(10);
    term.startAgent();
    await Promise.all([a, b]);
    await session.send('@c.tex:L3 ');
    expect(term.toAgent).toEqual(['@a.tex:L1 ', '@b.tex:L2 ', '@c.tex:L3 ']);
  });

  it('without shell integration: types the command after a timeout, then the reference after the fallback delay', async () => {
    const term = new FakeTerminal();
    const session = new AgentSession(term, 'tact', timeouts);
    const sent = session.send('@x.tex:L1 ');
    await vi.advanceTimersByTimeAsync(2999);
    expect(term.toShell).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(term.toShell).toEqual(['tact\n']); // typed into the shell
    term.agentRunning = true; // the shell runs it (no integration to tell us)
    await vi.advanceTimersByTimeAsync(999);
    expect(term.toAgent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await sent).toBe(true);
    expect(await session.ready).toBe('typed');
    expect(term.toAgent).toEqual(['@x.tex:L1 ']);
  });

  it('shell integration but no start report: sends after the start timeout', async () => {
    const term = new FakeTerminal();
    term.activateIntegration();
    const session = new AgentSession(term, 'tact', timeouts);
    const sent = session.send('@y.tex:L1 ');
    term.agentRunning = true; // started, but the shell never says so
    await vi.advanceTimersByTimeAsync(4999);
    expect(term.toAgent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await sent).toBe(true);
    expect(await session.ready).toBe('start-timeout');
    expect(term.toAgent).toEqual(['@y.tex:L1 ']);
  });

  it('no agent command: sends right away; a closed terminal gets nothing', async () => {
    const term = new FakeTerminal();
    term.agentRunning = true;
    const session = new AgentSession(term, '', timeouts);
    expect(await session.send('@z.tex:L1 ')).toBe(true);
    expect(term.toAgent).toEqual(['@z.tex:L1 ']);
    term.isClosed = true;
    expect(await session.send('@z.tex:L2 ')).toBe(false);
    expect(term.toAgent).toEqual(['@z.tex:L1 ']);
  });
});
