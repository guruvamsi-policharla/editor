/**
 * PLAN.md §8 engine properties on random edit sequences:
 *   - after accept-all: baseline == disk, and disk unchanged
 *   - after reject-all: disk == baseline, and baseline unchanged
 * plus a consistency invariant checked after every step: the engine's pending list is exactly the set
 * of paths where disk and baseline differ.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { StaleChangeError, type ReviewEngine, type TrackedEdit } from '../src/index.js';
import { baselineFiles, memWorkspace, sorted, type MemWorkspace } from './helpers.js';

/** Set FC_RUNS to run more cases locally (e.g. FC_RUNS=5000). */
const RUNS = (n: number) => Number(process.env.FC_RUNS ?? n);

const PATHS = ['a.txt', 'b.txt', 'dir/c.txt', 'dir/sub/d.md'];
const lineArb = fc.constantFrom('x\n', 'y\n', 'z\n', 'w\n', 'longer line here\n', 'x');
const contentArb = fc.array(lineArb, { maxLength: 7 }).map((ls) => ls.join(''));
const pathArb = fc.constantFrom(...PATHS);

type Op =
  | { op: 'agentWrite'; path: string; content: string }
  | { op: 'agentDelete'; path: string }
  | { op: 'agentRename'; from: string; to: string }
  | { op: 'ignoredWrite'; content: string }
  | { op: 'userSave'; path: string; edits: { at: number; len: number; text: string; formatter: boolean }[] }
  | { op: 'acceptHunk' | 'rejectHunk'; path: string; pick: number }
  | { op: 'acceptFile' | 'rejectFile'; path: string }
  | { op: 'deliverEvents' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ op: fc.constant('agentWrite' as const), path: pathArb, content: contentArb }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('agentDelete' as const), path: pathArb }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('agentRename' as const), from: pathArb, to: pathArb }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('ignoredWrite' as const), content: contentArb }) },
  {
    weight: 3,
    arbitrary: fc.record({
      op: fc.constant('userSave' as const),
      path: pathArb,
      edits: fc.array(
        fc.record({ at: fc.nat(), len: fc.nat({ max: 5 }), text: fc.constantFrom('', 'q', 'q\n', '\n', 'user\n'), formatter: fc.boolean() }),
        { minLength: 1, maxLength: 4 },
      ),
    }),
  },
  { weight: 3, arbitrary: fc.record({ op: fc.constantFrom('acceptHunk' as const, 'rejectHunk' as const), path: pathArb, pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constantFrom('acceptFile' as const, 'rejectFile' as const), path: pathArb }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('deliverEvents' as const) }) },
);

const initialArb = fc.record(Object.fromEntries(PATHS.map((p) => [p, fc.option(contentArb, { nil: undefined })])) as Record<
  string,
  fc.Arbitrary<string | undefined>
>);

async function expectConsistent(ws: MemWorkspace, engine: ReviewEngine) {
  const disk = reviewable(ws);
  const base = await baselineFiles(engine);
  const differing = new Set<string>();
  for (const p of new Set([...Object.keys(disk), ...Object.keys(base)])) if (disk[p] !== base[p]) differing.add(p);
  const reported = new Set<string>();
  for (const c of engine.listChanges()) {
    reported.add(c.path);
    if (c.oldPath) reported.add(c.oldPath);
  }
  expect([...reported].sort()).toEqual([...differing].sort());
}

function reviewable(ws: MemWorkspace): Record<string, string> {
  const files = ws.files();
  delete files['out.log'];
  return sorted(files);
}

async function run(initial: Record<string, string | undefined>, ops: Op[]): Promise<{ ws: MemWorkspace; engine: ReviewEngine }> {
  const ws = memWorkspace(Object.fromEntries(Object.entries(initial).filter((e): e is [string, string] => e[1] !== undefined)));
  const engine = await ws.open();
  let undelivered: string[] = [];
  const tolerate = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      if (!(err instanceof StaleChangeError) && (err as Error).name !== 'NotPendingError') throw err;
    }
  };

  for (const o of ops) {
    switch (o.op) {
      case 'agentWrite':
        undelivered.push(ws.write(o.path, o.content));
        break;
      case 'agentDelete':
        if (ws.exists(o.path)) undelivered.push(ws.remove(o.path));
        break;
      case 'agentRename':
        if (o.from !== o.to && ws.exists(o.from) && !ws.exists(o.to)) undelivered.push(...ws.rename(o.from, o.to));
        break;
      case 'ignoredWrite':
        undelivered.push(ws.write('out.log', o.content));
        break;
      case 'userSave': {
        if (undelivered.length) break; // a real editor saves a buffer synced with disk; dirty conflicts are the extension's job
        let text = ws.read(o.path) ?? '';
        const base = text;
        const edits: TrackedEdit[] = [];
        for (const e of o.edits) {
          const offset = text.length ? e.at % (text.length + 1) : 0;
          const length = Math.min(e.len, text.length - offset);
          edits.push({ offset, length, text: e.text, origin: e.formatter ? 'formatter' : 'user' });
          text = text.slice(0, offset) + e.text + text.slice(offset + length);
        }
        await engine.reportUserSave(o.path, text, { edits, base });
        undelivered.push(ws.write(o.path, text));
        break;
      }
      case 'acceptHunk':
      case 'rejectHunk': {
        const change = await engine.getFileChange(o.path);
        if (!change || change.hunks.length === 0) break;
        const hunk = change.hunks[o.pick % change.hunks.length]!;
        await tolerate(o.op === 'acceptHunk' ? engine.acceptHunk(o.path, hunk.id) : engine.rejectHunk(o.path, hunk.id));
        break;
      }
      case 'acceptFile':
        await tolerate(engine.acceptFile(o.path));
        break;
      case 'rejectFile':
        await tolerate(engine.rejectFile(o.path));
        break;
      case 'deliverEvents':
        await engine.handleFsEvents(undelivered);
        undelivered = [];
        await expectConsistent(ws, engine);
        break;
    }
  }
  await engine.handleFsEvents(undelivered);
  await expectConsistent(ws, engine);
  return { ws, engine };
}

describe('engine properties (§8)', () => {
  it('after accept-all, baseline == disk and disk is unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(initialArb, fc.array(opArb, { maxLength: 30 }), async (initial, ops) => {
        const { ws, engine } = await run(initial, ops);
        const diskBefore = reviewable(ws);
        const r = await engine.acceptAll();
        expect(r.skipped).toEqual([]);
        expect(reviewable(ws)).toEqual(diskBefore);
        expect(await baselineFiles(engine)).toEqual(diskBefore);
        expect(engine.listChanges()).toEqual([]);
      }),
      { numRuns: RUNS(150) },
    );
  });

  it('after reject-all, disk == baseline and the baseline is unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(initialArb, fc.array(opArb, { maxLength: 30 }), async (initial, ops) => {
        const { ws, engine } = await run(initial, ops);
        const baselineBefore = await baselineFiles(engine);
        const r = await engine.rejectAll();
        expect(r.skipped).toEqual([]);
        expect(await baselineFiles(engine)).toEqual(baselineBefore);
        expect(reviewable(ws)).toEqual(baselineBefore);
        expect(engine.listChanges()).toEqual([]);
      }),
      { numRuns: RUNS(150) },
    );
  });

  it('resolving hunks one at a time always converges to nothing pending', async () => {
    await fc.assert(
      fc.asyncProperty(initialArb, fc.array(opArb, { maxLength: 20 }), fc.array(fc.boolean(), { minLength: 50, maxLength: 50 }), async (initial, ops, coin) => {
        const { ws, engine } = await run(initial, ops);
        let steps = 0;
        while (engine.listChanges().length && steps < 200) {
          const c = engine.listChanges()[0]!;
          const accept = coin[steps % coin.length]!;
          if (c.reviewMode === 'file') await (accept ? engine.acceptFile(c.path) : engine.rejectFile(c.path));
          else {
            const h = (await engine.getFileChange(c.path))!.hunks[0]!;
            await (accept ? engine.acceptHunk(c.path, h.id) : engine.rejectHunk(c.path, h.id));
          }
          steps++;
        }
        expect(engine.listChanges()).toEqual([]);
        expect(await baselineFiles(engine)).toEqual(reviewable(ws));
      }),
      { numRuns: RUNS(100) },
    );
  });

  it('pending state survives a restart unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(initialArb, fc.array(opArb, { maxLength: 20 }), async (initial, ops) => {
        const { ws, engine } = await run(initial, ops);
        const before = engine.listChanges();
        const baseBefore = await baselineFiles(engine);
        await engine.close();
        const reopened = await ws.open();
        expect(reopened.listChanges()).toEqual(before);
        expect(await baselineFiles(reopened)).toEqual(baseBefore);
      }),
      { numRuns: RUNS(75) },
    );
  });
});
