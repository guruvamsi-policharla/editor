import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewEngine } from '../src/index.js';
import { rmrf, tmpDir } from './helpers.js';

// scripts/demo-agent.sh (the README's "Try it") against the real engine: the demo paper and the script
// stay in sync, and every edit shows up as its own reviewable change.
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const DEMO = path.join(REPO_ROOT, 'scripts/demo-agent.sh');

describe('demo agent (scripts/demo-agent.sh on examples/paper)', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach(rmrf));

  it('makes one reviewable change per edit: 2 hunks in intro.tex, 3 in main.tex, 1 created file', async () => {
    const base = tmpDir('demo-agent-');
    dirs.push(base);
    const paper = path.join(base, 'paper');
    const run = (...args: string[]) =>
      execFileSync('bash', [DEMO, ...args], { env: { ...process.env, DEMO_STEP_DELAY: '0' }, stdio: 'pipe' }).toString();

    run('setup', paper);
    const engine = await ReviewEngine.open({ root: paper, storageDir: path.join(base, 'store') });
    try {
      expect(engine.listChanges()).toEqual([]);
      run('run', paper, '--no-wait');
      await engine.rescan();

      const changes = engine.listChanges().map((c) => [c.path, c.kind]).sort();
      expect(changes).toEqual([
        ['main.tex', 'modified'],
        ['sections/intro.tex', 'modified'],
        ['sections/related.tex', 'created'],
      ]);
      expect((await engine.getFileChange('sections/intro.tex'))!.hunks).toHaveLength(2);
      expect((await engine.getFileChange('main.tex'))!.hunks).toHaveLength(3);

      // A second run refuses to edit an already-edited paper instead of silently doing nothing.
      expect(() => run('run', paper, '--no-wait')).toThrow(/expected line not found/);
    } finally {
      await engine.close();
    }
  });
});
