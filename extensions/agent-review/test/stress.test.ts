/**
 * Randomized stress through the extension (the engine's stress/sim.ts driving the real ReviewController and EditLogs,
 * with a fake core and VS Code's event order): agent writes, typing (the first keystroke of a clean buffer sometimes
 * reported clean, its dirty state just after), saves with format on save (the log from EditLogs, the user text from
 * core), Keep/Undo as the core UI does them, editor undo, restarts (hot exit: no edit log for unsaved buffers) and git.
 * After every step: no agent text in the baseline without a Keep, staging that file, or a HEAD move whose diff includes it.
 *
 * Replay: STRESS_SEED=<seed> [STRESS_GIT=1] npx vitest run test/stress.test.ts. More: STRESS_SEEDS=<n>. Without the user
 * text from core (edit log only): STRESS_NO_USER_TEXT=1.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'vitest';
import { acceptHunks, hunkRegion, joinLines, MultiRootReview, rejectHunks, splitLines, type TrackedEdit } from '@editor/engine';
import { ReviewController, type CoreBridge } from '../src/controller';
import { EditLogs } from '../src/editLog';
import { Rng, Stress, type Backend } from '../../../packages/engine/test/stress/sim';

const SEEDS = Number(process.env.STRESS_SEEDS ?? 25);
const STEPS = Number(process.env.STRESS_STEPS ?? 70);
const ONLY = process.env.STRESS_SEED !== undefined ? Number(process.env.STRESS_SEED) : undefined;

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

const quiet = { info() {}, warn() {}, error(m: string, e?: unknown) { throw new Error(`${m}: ${String(e)}`); } };
const core: CoreBridge = { setBaseline: async () => {}, remove: async () => {} };

async function runSeed(seed: number, withGit: boolean): Promise<void> {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-review-stress-')));
  const root = path.join(tmp, 'ws');
  const storageBase = path.join(tmp, 'store');
  fs.mkdirSync(root);
  const files = Stress.initialFiles();
  for (const [rel, text] of Object.entries(files)) { fs.writeFileSync(path.join(root, rel), text); }
  if (withGit) {
    git(root, 'init', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');
  }
  const abs = (rel: string) => path.join(root, rel);
  const key = (rel: string) => `file://${abs(rel)}`;
  const dirty = new Set<string>();
  let review = await MultiRootReview.open({ roots: [root], storageBase, git: withGit });
  let ctl = new ReviewController(review, core, { isDirty: (p) => dirty.has(p) }, quiet);
  await ctl.syncAll();
  let logs = new EditLogs();
  for (const rel of Object.keys(files)) { logs.markClean(key(rel), files[rel]); }
  let version = 1;
  const userVersions = new Map<string, number>();
  const engine = () => review.engines.get(root)!;
  const hunkAt = async (rel: string, pick: number) => {
    const change = await engine().getFileChange(rel);
    if (!change || change.reviewMode !== 'hunk' || change.hunks.length === 0) { return undefined; }
    return change.hunks[pick % change.hunks.length]!;
  };
  const events = async (rel: string) => {
    await ctl.handleFsEvents([abs(rel)]);
    await ctl.idle();
  };
  const backend: Backend = {
    agentWrote: (rel) => events(rel),
    bufferChanged(rel, edit: TrackedEdit, reportedClean, textAfter, dirtyAfter) {
      version++;
      logs.onChange(key(rel), [{ rangeOffset: edit.offset, rangeLength: edit.length, text: edit.text }], !reportedClean, version, reportedClean ? textAfter : undefined);
      if (dirtyAfter) { logs.onDirtyStateChange(key(rel), true, version); }
      if (reportedClean && !dirtyAfter) { dirty.delete(abs(rel)); }
      else { dirty.add(abs(rel)); }
    },
    saveStarted: (rel) => { userVersions.set(rel, version); },
    editLog: (rel) => logs.get(key(rel), userVersions.get(rel)) as TrackedEdit[] | undefined,
    async save(rel, saved, edits, userContent) {
      // STRESS_NO_USER_TEXT=1: a core that doesn't send the user text (polish-2): only the edit log tells the formatter apart.
      await ctl.onWillSave(abs(rel), saved, edits, process.env.STRESS_NO_USER_TEXT ? undefined : userContent);
      fs.writeFileSync(abs(rel), saved);
      logs.markClean(key(rel), saved);
      dirty.delete(abs(rel));
      await ctl.onBufferSettled(abs(rel));
      await events(rel);
    },
    async keepHunk(rel, pick) {
      // As the core UI does it: the baseline with that hunk kept, sent in full.
      const h = await hunkAt(rel, pick);
      if (!h) { return undefined; }
      const base = (await ctl.baselineText(abs(rel))) ?? '';
      const next = joinLines(acceptHunks(splitLines(base), splitLines(fs.readFileSync(abs(rel), 'utf8')), [hunkRegion(h)]));
      await ctl.onReviewAction({ kind: 'accepted', path: abs(rel), baseline: next });
      await ctl.idle();
      return { oldLines: h.oldLines, newLines: h.newLines };
    },
    async keepFile(rel) {
      if (!ctl.pendingFiles.some((f) => f.absPath === abs(rel))) { return false; }
      await ctl.acceptFile(abs(rel));
      await ctl.idle();
      return true;
    },
    async undoHunk(rel, pick) {
      // As the core UI does it: the hunk restored in the clean buffer, saved without save participants (not reported).
      const h = await hunkAt(rel, pick);
      if (!h) { return false; }
      const base = (await ctl.baselineText(abs(rel))) ?? '';
      fs.writeFileSync(abs(rel), joinLines(rejectHunks(splitLines(base), splitLines(fs.readFileSync(abs(rel), 'utf8')), [hunkRegion(h)])));
      await ctl.onReviewAction({ kind: 'rejected', path: abs(rel) });
      await events(rel);
      return true;
    },
    baseline: (rel) => ctl.baselineText(abs(rel)),
    hunks: async (rel) => (await engine().getFileChange(rel))?.hunks ?? [],
    pending: () => ctl.pendingFiles.map((f) => path.relative(root, f.absPath)),
    async restart() {
      ctl.dispose();
      await review.close();
      review = await MultiRootReview.open({ roots: [root], storageBase, git: withGit });
      ctl = new ReviewController(review, core, { isDirty: (p) => dirty.has(p) }, quiet);
      await ctl.syncAll();
      // Activation: logs only for documents that are clean (hot exit restores unsaved ones without a log).
      logs = new EditLogs();
      for (const rel of Object.keys(files)) { if (!dirty.has(abs(rel))) { logs.markClean(key(rel), fs.readFileSync(abs(rel), 'utf8')); } }
    },
    settled: (rel) => ctl.onBufferSettled(abs(rel)),
    ...(withGit ? {
      async git(...args: string[]) {
        if (args[0] === 'stash' && args[1] === 'pop' && git(root, 'stash', 'list').trim() === '') { return; }
        git(root, ...args);
        await ctl.handleFsEvents([...Object.keys(files).map(abs), path.join(root, '.git', 'index')]);
        await ctl.idle();
      },
    } : {}),
  };
  const stress = new Stress(new Rng(seed), { read: (rel) => fs.readFileSync(abs(rel), 'utf8'), write: (rel, t) => fs.writeFileSync(abs(rel), t) }, backend, Object.keys(files), { steps: STEPS, git: withGit, backendLog: true });
  try {
    await stress.run();
  } catch (err) {
    throw new Error(`seed ${seed}${withGit ? ' (git)' : ''}: ${(err as Error).message}`);
  } finally {
    ctl.dispose();
    await review.close().catch(() => undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('stress through the controller: agent text is never folded into the baseline without a Keep, staging, or a HEAD move that changed the file', () => {
  if (ONLY !== undefined) {
    it(`seed ${ONLY}`, () => runSeed(ONLY, process.env.STRESS_GIT === '1'), 120_000);
    return;
  }
  it(`${SEEDS} seeds x ${STEPS} steps`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) { await runSeed(seed, false); }
  }, 300_000);
  it(`${Math.ceil(SEEDS / 4)} seeds x ${STEPS} steps with git`, async () => {
    for (let seed = 2001; seed <= 2000 + Math.ceil(SEEDS / 4); seed++) { await runSeed(seed, true); }
  }, 300_000);
});
