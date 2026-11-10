/**
 * Typing while a save runs. The editor writes the buffer as it is once the save participants are done, so keystrokes
 * typed while the save was being reported reach the disk too. They used to be taken for an outside write: shown as the
 * agent's text in the middle of the user's sentence, with a false "changed on disk while you have unsaved edits".
 * Core reports the save again (`again`) when the buffer changed during the report, and says after the write what was
 * written when it may differ (`onDidWrite`), before the watcher sees it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MultiRootReview } from '@editor/engine';
import { ReviewController, type CoreBridge, type InlineKind } from '../src/controller';

class FakeCore implements CoreBridge {
  readonly shown = new Map<string, { baseline: string; kind: InlineKind }>();
  async setBaseline(abs: string, baseline: string, kind: InlineKind): Promise<void> { this.shown.set(abs, { baseline, kind }); }
  async remove(abs: string): Promise<void> { this.shown.delete(abs); }
}

const quiet = { info() {}, warn() {}, error(m: string, e?: unknown) { throw new Error(`${m}: ${String(e)}`); } };

let tmp: string;
let root: string;
let abs: string;
let review: MultiRootReview;
let core: FakeCore;
let dirty: Set<string>;
let conflicts: string[];
let ctl: ReviewController;

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-review-typing-')));
  root = path.join(tmp, 'ws');
  fs.mkdirSync(root);
  abs = path.join(root, 'paper.tex');
  fs.writeFileSync(abs, 'Intro.\nMethods.\n');
  dirty = new Set();
  conflicts = [];
  review = await MultiRootReview.open({ roots: [root], storageBase: path.join(tmp, 'storage'), git: false });
  core = new FakeCore();
  ctl = new ReviewController(review, core, { isDirty: (p) => dirty.has(p) }, quiet, (p) => conflicts.push(p));
  await ctl.syncAll();
});

afterEach(async () => {
  ctl.dispose();
  await review.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The editor writes `content` (more than it reported) and the user is still typing when the watcher reports it. */
async function writeAndWatch(content: string): Promise<void> {
  fs.writeFileSync(abs, content);
  dirty.add(abs);
  await ctl.handleFsEvents([abs]);
  await ctl.idle();
}

describe('typing during a save', () => {
  it('a write the editor never reported is still an outside write (a conflict); its first push waits for a clean buffer', async () => {
    dirty.add(abs);
    await ctl.onWillSave(abs, 'Intro. The quick\nMethods.\n', undefined, 'Intro. The quick\nMethods.\n');
    await writeAndWatch('Intro. The quick brown\nMethods.\n');
    expect(ctl.pendingFiles.map((f) => f.rel)).toEqual(['paper.tex']);
    expect(conflicts).toEqual([abs]);
    // The first push of a disk change under unsaved edits waits for a clean buffer (a conflict to merge first).
    expect(core.shown.has(abs)).toBe(false);
  });

  it('reported again during the save: the typing is the user\'s; nothing pending, no conflict', async () => {
    dirty.add(abs);
    await ctl.onWillSave(abs, 'Intro. The quick\nMethods.\n', undefined, 'Intro. The quick\nMethods.\n');
    // The user typed " brown" while the report was delivered: core reports the same save again.
    await ctl.onWillSave(abs, 'Intro. The quick brown\nMethods.\n', undefined, undefined, undefined, true);
    await writeAndWatch('Intro. The quick brown\nMethods.\n');
    await ctl.onDidWrite(abs);
    expect(ctl.pendingFiles).toEqual([]);
    expect(conflicts).toEqual([]);
    expect(await ctl.baselineText(abs)).toBe('Intro. The quick brown\nMethods.\n');
    expect(core.shown.has(abs)).toBe(false);
  });

  it('the written text after the write (the report timed out): reported before the watcher sees the write', async () => {
    dirty.add(abs);
    await ctl.onWillSave(abs, 'Intro. The quick\nMethods.\n', undefined, 'Intro. The quick\nMethods.\n');
    fs.writeFileSync(abs, 'Intro. The quick brown fox\nMethods.\n');
    await ctl.onDidWrite(abs, 'Intro. The quick brown fox\nMethods.\n');
    await writeAndWatch('Intro. The quick brown fox\nMethods.\n');
    expect(ctl.pendingFiles).toEqual([]);
    expect(conflicts).toEqual([]);
    expect(await ctl.baselineText(abs)).toBe('Intro. The quick brown fox\nMethods.\n');

    // The next save is attributed as usual (no conflict left behind).
    await ctl.onWillSave(abs, 'Intro. The quick brown fox jumps\nMethods.\n', undefined, 'Intro. The quick brown fox jumps\nMethods.\n');
    await writeAndWatch('Intro. The quick brown fox jumps\nMethods.\n');
    await ctl.onDidWrite(abs);
    expect(ctl.pendingFiles).toEqual([]);
    expect(await ctl.baselineText(abs)).toBe('Intro. The quick brown fox jumps\nMethods.\n');
  });

  it('with an agent change pending: typing during the save folds in elsewhere, the agent\'s line stays pending', async () => {
    fs.writeFileSync(abs, 'Intro.\nNew methods.\n');
    await ctl.handleFsEvents([abs]);
    await ctl.idle();
    expect(core.shown.get(abs)?.baseline).toBe('Intro.\nMethods.\n');
    dirty.add(abs);
    // The editor's review baseline followed the typing on line 1 (no change there).
    await ctl.onWillSave(abs, 'Intro. Mine\nNew methods.\n', undefined, 'Intro. Mine\nNew methods.\n', 'Intro. Mine\nMethods.\n');
    await ctl.onWillSave(abs, 'Intro. Mine too\nNew methods.\n', undefined, undefined, 'Intro. Mine too\nMethods.\n', true);
    await writeAndWatch('Intro. Mine too\nNew methods.\n');
    await ctl.onDidWrite(abs);
    expect(conflicts).toEqual([]);
    expect(await ctl.baselineText(abs)).toBe('Intro. Mine too\nMethods.\n');
    expect(await ctl.lineCounts(ctl.pendingFiles[0]!)).toEqual({ added: 1, removed: 1 });
  });

  it('a written text equal to the report changes nothing', async () => {
    await ctl.onWillSave(abs, 'Intro. A\nMethods.\n', undefined, 'Intro. A\nMethods.\n');
    fs.writeFileSync(abs, 'Intro. A\nMethods.\n');
    await ctl.onDidWrite(abs, 'Intro. A\nMethods.\n');
    await ctl.handleFsEvents([abs]);
    await ctl.idle();
    expect(ctl.pendingFiles).toEqual([]);
    expect(await ctl.baselineText(abs)).toBe('Intro. A\nMethods.\n');
  });
});
