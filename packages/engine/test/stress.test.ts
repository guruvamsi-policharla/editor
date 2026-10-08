import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'vitest';
import { NotPendingError, ReviewEngine, type TrackedEdit } from '../src/index.js';
import { git, hasGit, rmrf, tmpDir } from './helpers.js';
import { Rng, Stress, type Backend } from './stress/sim.js';

/**
 * Randomized stress of the engine (see stress/sim.ts): agent writes, typing, saves with formatters, Keep/Undo, editor
 * undo, restarts and git operations, checking after every step that no agent text is folded into the baseline without
 * a Keep, a HEAD move or staging. The edit log reaches the engine intact, without its first edit, with every edit
 * tagged as the user's, or not at all, the way it can in VS Code.
 *
 * Replay a failure: STRESS_SEED=<seed> [STRESS_GIT=1] npx vitest run test/stress.test.ts. More seeds: STRESS_SEEDS=<n>.
 */
const SEEDS = Number(process.env.STRESS_SEEDS ?? 40);
const STEPS = Number(process.env.STRESS_STEPS ?? 80);
const ONLY = process.env.STRESS_SEED !== undefined ? Number(process.env.STRESS_SEED) : undefined;

async function runSeed(seed: number, withGit: boolean): Promise<void> {
  const tmp = tmpDir('engine-stress-');
  const root = path.join(tmp, 'ws');
  const storage = path.join(tmp, 'store');
  fs.mkdirSync(root);
  const files = Stress.initialFiles();
  for (const [rel, text] of Object.entries(files)) { fs.writeFileSync(path.join(root, rel), text); }
  if (withGit) {
    git(root, 'init', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');
  }
  const open = () => ReviewEngine.open({ root, storageDir: storage, git: withGit });
  let engine = await open();
  const abs = (rel: string) => path.join(root, rel);
  const hunkAt = async (rel: string, pick: number) => {
    const change = await engine.getFileChange(rel);
    if (!change || change.reviewMode !== 'hunk' || change.hunks.length === 0) { return undefined; }
    return change.hunks[pick % change.hunks.length]!;
  };
  const backend: Backend = {
    agentWrote: (rel) => engine.handleFsEvents([abs(rel)]),
    async save(rel, saved, edits: TrackedEdit[] | undefined, userContent) {
      await engine.reportUserSave(rel, saved, { ...(edits ? { edits } : {}), ...(userContent !== undefined ? { userContent } : {}) });
      fs.writeFileSync(abs(rel), saved);
      await engine.handleFsEvents([abs(rel)]);
    },
    async keepHunk(rel, pick) {
      const h = await hunkAt(rel, pick);
      if (!h) { return undefined; }
      await engine.acceptHunk(rel, h.id);
      return { oldLines: h.oldLines, newLines: h.newLines };
    },
    async keepFile(rel) {
      try {
        await engine.acceptFile(rel);
        return true;
      } catch (err) {
        if (err instanceof NotPendingError) { return false; }
        throw err;
      }
    },
    async undoHunk(rel, pick) {
      const h = await hunkAt(rel, pick);
      if (!h) { return false; }
      await engine.rejectHunk(rel, h.id);
      return true;
    },
    async baseline(rel) {
      const b = await engine.getBaselineContent(rel);
      return b ? new TextDecoder().decode(b) : undefined;
    },
    hunks: async (rel) => (await engine.getFileChange(rel))?.hunks ?? [],
    pending: () => engine.listChanges().map((c) => c.path),
    async restart() {
      await engine.close();
      engine = await open();
    },
    settled: async () => undefined,
    ...(withGit ? {
      async git(...args: string[]) {
        if (args[0] === 'stash' && args[1] === 'pop' && git(root, 'stash', 'list').trim() === '') { return; } // nothing was stashed
        git(root, ...args);
        await engine.handleFsEvents([...Object.keys(files).map(abs), path.join(root, '.git', 'index')]);
        await engine.checkGit();
      },
    } : {}),
  };
  const stress = new Stress(new Rng(seed), { read: (rel) => fs.readFileSync(abs(rel), 'utf8'), write: (rel, t) => fs.writeFileSync(abs(rel), t) }, backend, Object.keys(files), { steps: STEPS, git: withGit });
  try {
    await stress.run();
  } catch (err) {
    throw new Error(`seed ${seed}${withGit ? ' (git)' : ''}: ${(err as Error).message}`);
  } finally {
    await engine.close().catch(() => undefined);
    rmrf(tmp);
  }
}

describe('stress: agent text is never folded into the baseline without a Keep, a HEAD move or staging', () => {
  if (ONLY !== undefined) {
    it(`seed ${ONLY}`, () => runSeed(ONLY, process.env.STRESS_GIT === '1'), 120_000);
    return;
  }
  it(`${SEEDS} seeds x ${STEPS} steps, no git`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) { await runSeed(seed, false); }
  }, 300_000);
  it.runIf(hasGit())(`${Math.ceil(SEEDS / 4)} seeds x ${STEPS} steps with git (stage, commit, stash + pop)`, async () => {
    for (let seed = 1001; seed <= 1000 + Math.ceil(SEEDS / 4); seed++) { await runSeed(seed, true); }
  }, 300_000);
});
