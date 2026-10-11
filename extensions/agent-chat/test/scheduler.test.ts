import { describe, expect, it } from 'vitest';
import { TurnScheduler, type TurnHolder } from '../src/scheduler.js';

const A: TurnHolder = { chat: 'a', label: 'Claude Code ("A")' };
const B: TurnHolder = { chat: 'b', label: 'Codex ("B")' };
const C: TurnHolder = { chat: 'c', label: 'tact ("C")' };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('turn scheduler: one agent edits at a time', () => {
	it('a second chat waits, is told for whom, and starts by itself when the first ends', async () => {
		const s = new TurnScheduler();
		const a = (await s.acquire(A))!;
		const waits: string[] = [];
		let started = false;
		const b = s.acquire(B, { onWait: (_id, blockers) => waits.push(...blockers.map(x => x.label)) }).then(l => { started = true; return l; });
		await tick();
		expect(waits).toEqual(['Claude Code ("A")']);
		expect(started).toBe(false);
		expect(s.waiting.map(w => w.holder.chat)).toEqual(['b']);
		a.release();
		const lease = await b;
		expect(started).toBe(true);
		expect(s.blockers('c').map(h => h.chat)).toEqual(['b']);
		lease!.release();
		expect(s.blockers('c')).toEqual([]);
	});

	it('waiters start in order, one at a time', async () => {
		const s = new TurnScheduler();
		const a = (await s.acquire(A))!;
		const order: string[] = [];
		const b = s.acquire(B).then(l => { order.push('b'); return l!; });
		const c = s.acquire(C).then(l => { order.push('c'); return l!; });
		a.release();
		const lb = await b;
		await tick();
		expect(order).toEqual(['b']);
		lb.release();
		(await c).release();
		expect(order).toEqual(['b', 'c']);
	});

	it('closing a waiting chat gives up its place: its message never runs, the next one in line starts (#21)', async () => {
		const s = new TurnScheduler();
		const a = (await s.acquire(A))!;
		let bRan = false;
		const b = s.acquire(B).then(l => { bRan = !!l; return l; });
		const c = s.acquire(C);
		await tick();
		expect(s.isWaiting('b')).toBe(true);
		expect(s.cancelChat('b')).toBe(1);
		expect(await b).toBeUndefined();
		expect(s.isWaiting('b')).toBe(false);
		expect(s.waiting.map(w => w.holder.chat)).toEqual(['c']);
		expect(s.cancelChat('b')).toBe(0);
		a.release();
		(await c)!.release();
		expect(bRan).toBe(false);
		expect(s.blockers('x')).toEqual([]);
	});

	it('Stop while waiting gives up the place (no lease); Run now starts alongside', async () => {
		const s = new TurnScheduler();
		const a = (await s.acquire(A))!;
		const stop = new AbortController();
		const b = s.acquire(B, { signal: stop.signal });
		stop.abort();
		expect(await b).toBeUndefined();
		expect(s.waiting).toEqual([]);

		let id = '';
		const c = s.acquire(C, { onWait: w => { id = w; } });
		await tick();
		expect(s.runNow(id)).toBe(true);
		const lc = (await c)!;
		expect(s.blockers('x').map(h => h.chat).sort()).toEqual(['a', 'c']);
		expect(s.runNow(id)).toBe(false);
		a.release();
		lc.release();
	});

	it('the same chat, read-only turns (plan mode), and the setting turned off never wait', async () => {
		const s = new TurnScheduler();
		const a = (await s.acquire(A))!;
		expect(await s.acquire({ chat: 'a', label: 'again' })).toBeDefined();
		expect(await s.acquire(B, { readOnly: true })).toBeDefined();
		const off = new TurnScheduler(() => false);
		await off.acquire(A);
		expect(await off.acquire(B)).toBeDefined();
		a.release();
	});
});
