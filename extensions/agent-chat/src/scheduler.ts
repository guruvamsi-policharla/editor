// One agent edits the workspace at a time. Agents write files themselves, so the panel can't intercept or merge
// their writes; what it can do is not start a second chat's turn while another chat's turn is running. A turn
// that has to wait shows "Waiting for <chat> to finish…" and starts by itself when that turn ends (first come,
// first served); the user can run it right away or stop it. Turns that can't edit (plan mode) never wait.
// Pure (no vscode import).

export interface TurnHolder {
	/** The chat (resource) the turn belongs to. */
	chat: string;
	/** Shown to the waiting chat: `Claude Code ("Fix the intro")`. */
	label: string;
}

export interface Lease {
	release(): void;
}

interface Waiter {
	id: string;
	holder: TurnHolder;
	start: () => void;
	/** Gives up the wait (the turn resolves without a lease). */
	cancel: () => void;
}

let nextWaiter = 0;

export class TurnScheduler {
	/** Turns running now (normally one; more after "Run now"). */
	private readonly running = new Map<symbol, TurnHolder>();
	private readonly queue: Waiter[] = [];
	private readonly listeners = new Set<() => void>();

	/** Whether turns wait for each other at all (`agentChat.turns.waitForOtherChats`). */
	constructor(private readonly enabled: () => boolean = () => true) { }

	/** The running turns of other chats. */
	blockers(chat: string): TurnHolder[] {
		return [...this.running.values()].filter(h => h.chat !== chat);
	}

	/** The turns waiting, in order. */
	get waiting(): readonly { id: string; holder: TurnHolder }[] {
		return this.queue.map(w => ({ id: w.id, holder: w.holder }));
	}

	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		for (const l of [...this.listeners]) {
			l();
		}
	}

	/**
	 * Starts a turn now, or once the running turns of other chats have ended. `onWait` is called (with the
	 * waiter's id, for `runNow`, and what it waits for) when the turn has to wait. Resolves with the lease, or
	 * with undefined when `signal` aborts first (Stop while waiting).
	 */
	acquire(holder: TurnHolder, options: { readOnly?: boolean; signal?: AbortSignal; onWait?: (id: string, blockers: TurnHolder[]) => void } = {}): Promise<Lease | undefined> {
		if (options.signal?.aborted) {
			return Promise.resolve(undefined);
		}
		const blockers = this.blockers(holder.chat);
		if (options.readOnly || !this.enabled() || (!blockers.length && !this.queue.length)) {
			return Promise.resolve(this.grant(holder));
		}
		return new Promise(resolve => {
			const waiter: Waiter = {
				id: `w${++nextWaiter}`,
				holder,
				start: () => {
					options.signal?.removeEventListener('abort', abort);
					resolve(this.grant(holder));
				},
				cancel: () => abort(),
			};
			const abort = () => {
				options.signal?.removeEventListener('abort', abort);
				this.dequeue(waiter);
				resolve(undefined);
				this.pump();
			};
			options.signal?.addEventListener('abort', abort, { once: true });
			this.queue.push(waiter);
			this.changed();
			options.onWait?.(waiter.id, blockers.length ? blockers : this.queue.slice(0, -1).map(w => w.holder));
		});
	}

	/** Starts a waiting turn now, alongside the running ones. */
	runNow(id: string): boolean {
		const waiter = this.queue.find(w => w.id === id);
		if (!waiter) {
			return false;
		}
		this.dequeue(waiter);
		waiter.start();
		return true;
	}

	/** Gives up every waiting turn of a chat (the chat was closed): they resolve without a lease and never run. */
	cancelChat(chat: string): number {
		const waiters = this.queue.filter(w => w.holder.chat === chat);
		waiters.forEach(w => w.cancel());
		return waiters.length;
	}

	/** Whether a turn of this chat is waiting. */
	isWaiting(chat: string): boolean {
		return this.queue.some(w => w.holder.chat === chat);
	}

	private dequeue(waiter: Waiter): void {
		const i = this.queue.indexOf(waiter);
		if (i >= 0) {
			this.queue.splice(i, 1);
			this.changed();
		}
	}

	private grant(holder: TurnHolder): Lease {
		const key = Symbol(holder.chat);
		this.running.set(key, holder);
		this.changed();
		let released = false;
		return {
			release: () => {
				if (!released) {
					released = true;
					this.running.delete(key);
					this.changed();
					this.pump();
				}
			},
		};
	}

	/** Starts the next waiting turn once nothing else (from another chat) runs. */
	private pump(): void {
		const next = this.queue[0];
		if (next && !this.blockers(next.holder.chat).length) {
			this.dequeue(next);
			next.start();
		}
	}
}
