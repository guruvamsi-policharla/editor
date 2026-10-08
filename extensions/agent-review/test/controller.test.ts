/**
 * Integration tests: the real engine on a temp directory, driven the way the extension drives it, with a
 * fake core bridge that records what the inline UI would show.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MultiRootReview, type TrackedEdit } from '@editor/engine';
import { ReviewController, UiPaths, type CoreBridge, type InlineKind } from '../src/controller';
import { EditLogs } from '../src/editLog';

class FakeCore implements CoreBridge {
  readonly shown = new Map<string, { baseline: string; kind: InlineKind }>();
  readonly calls: string[] = [];
  async setBaseline(abs: string, baseline: string, kind: InlineKind): Promise<void> {
    this.shown.set(abs, { baseline, kind });
    this.calls.push(`set ${path.basename(abs)}`);
  }
  async remove(abs: string): Promise<void> {
    this.shown.delete(abs);
    this.calls.push(`remove ${path.basename(abs)}`);
  }
}

/** The fork's core, which can also undo a file in its editor buffer (`_agentReview.reject`). */
class FakeCoreWithEditorUndo extends FakeCore {
  readonly undoneInEditor: string[] = [];
  async rejectInEditor(abs: string): Promise<'saved' | 'unsaved' | 'deleted' | undefined> {
    if (!this.shown.has(abs)) { return undefined; }
    this.undoneInEditor.push(abs);
    return 'unsaved'; // the buffer has the user's unsaved edits, so the undo stays in it
  }
}

const quiet = { info() {}, warn() {}, error(m: string, e?: unknown) { throw new Error(`${m}: ${String(e)}`); } };

let tmp: string;
let root: string;
let storage: string;
let review: MultiRootReview;
let core: FakeCore;
let dirty: Set<string>;
let conflicts: string[];
let ctl: ReviewController;

async function open(git = false, editorUndo = false): Promise<void> {
  review = await MultiRootReview.open({ roots: [root], storageBase: storage, git });
  core = editorUndo ? new FakeCoreWithEditorUndo() : new FakeCore();
  ctl = new ReviewController(review, core, { isDirty: (p) => dirty.has(p) }, quiet, (p) => conflicts.push(p));
  await ctl.syncAll();
}

/** An agent (or any outside process) writes a file; the watcher reports it. */
async function agentWrite(rel: string, content: string): Promise<string> {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  await ctl.handleFsEvents([abs]);
  await ctl.idle();
  return abs;
}

/** The editor saves a buffer: report (with the edit log), write, watcher event, buffer clean again. */
async function userSave(abs: string, content: string, edits?: TrackedEdit[]): Promise<void> {
  await ctl.onWillSave(abs, content, edits);
  fs.writeFileSync(abs, content);
  dirty.delete(abs);
  await ctl.onBufferSettled(abs);
  await ctl.handleFsEvents([abs]);
  await ctl.idle();
}

function read(abs: string): string {
  return fs.readFileSync(abs, 'utf8');
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-review-')));
  root = path.join(tmp, 'ws');
  storage = path.join(tmp, 'storage');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'paper.tex'), 'Intro.\nMethods.\nResults.\n');
  dirty = new Set();
  conflicts = [];
});

afterEach(async () => {
  ctl?.dispose();
  await review?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ReviewController', () => {
  it('shows an external write inline against the baseline', async () => {
    await open();
    expect(core.shown.size).toBe(0);
    const abs = await agentWrite('paper.tex', 'Intro.\nNew methods.\nResults.\nDiscussion.\n');
    expect(core.shown.get(abs)).toEqual({ baseline: 'Intro.\nMethods.\nResults.\n', kind: 'modified' });
    expect(ctl.pendingFiles.map((f) => [f.rel, f.kind, f.inline])).toEqual([['paper.tex', 'modified', true]]);
  });

  it('Keep on one hunk moves the baseline (full text from the UI) and keeps the rest pending', async () => {
    await open();
    const abs = await agentWrite('paper.tex', 'Intro.\nNew methods.\nResults.\nDiscussion.\n');
    const calls = core.calls.length;
    await ctl.onReviewAction({ kind: 'accepted', path: abs, baseline: 'Intro.\nNew methods.\nResults.\n' });
    await ctl.idle();
    expect(core.calls.length).toBe(calls); // no echo of the same baseline back to the UI
    expect(await ctl.baselineText(abs)).toBe('Intro.\nNew methods.\nResults.\n');
    expect(await ctl.lineCounts(ctl.pendingFiles[0]!)).toEqual({ added: 1, removed: 0 });
    // Keeping the last hunk clears the file from the inline UI.
    await ctl.onReviewAction({ kind: 'accepted', path: abs, baseline: read(abs) });
    await ctl.idle();
    expect(core.shown.has(abs)).toBe(false);
    expect(ctl.pendingFiles).toEqual([]);
  });

  it('Ctrl+Z after Keep (restore) puts the change back up for review, even after the last Keep cleared the file', async () => {
    await open();
    const abs = await agentWrite('paper.tex', 'Intro.\nNew methods.\nResults.\nDiscussion.\n');
    await ctl.onReviewAction({ kind: 'accepted', path: abs, baseline: 'Intro.\nNew methods.\nResults.\n' });
    await ctl.onReviewAction({ kind: 'accepted', path: abs, baseline: read(abs) });
    await ctl.idle();
    expect(core.shown.has(abs)).toBe(false);

    await ctl.onReviewAction({ kind: 'restore', path: abs, baseline: 'Intro.\nNew methods.\nResults.\n' });
    await ctl.idle();
    expect(core.shown.get(abs)).toEqual({ baseline: 'Intro.\nNew methods.\nResults.\n', kind: 'modified' });
    await ctl.onReviewAction({ kind: 'restore', path: abs, baseline: 'Intro.\nMethods.\nResults.\n' });
    await ctl.idle();
    expect(core.shown.get(abs)).toEqual({ baseline: 'Intro.\nMethods.\nResults.\n', kind: 'modified' });
    expect(read(abs)).toBe('Intro.\nNew methods.\nResults.\nDiscussion.\n'); // the disk is never touched

    // A created file kept as a whole: null puts it back as a pending creation.
    const created = await agentWrite('related.tex', 'Related work.\n');
    await ctl.acceptFile(created);
    await ctl.idle();
    expect(core.shown.has(created)).toBe(false);
    await ctl.onReviewAction({ kind: 'restore', path: created, baseline: null });
    await ctl.idle();
    expect(core.shown.get(created)).toEqual({ baseline: '', kind: 'created' });
  });

  it('Keep on a file with mixed CRLF/LF line endings leaves nothing spurious pending', async () => {
    fs.writeFileSync(path.join(root, 'mixed.txt'), 'one\r\ntwo\nthree\r\nfour\n');
    await open();
    const abs = await agentWrite('mixed.txt', 'one\r\nTWO\nthree\r\nfour\nfive\r\n');
    const calls = core.calls.length;
    // The core UI's models normalize line endings: the baseline it reports after keeping the TWO hunk uses one EOL.
    await ctl.onReviewAction({ kind: 'accepted', path: abs, baseline: 'one\nTWO\nthree\nfour\n' });
    await ctl.idle();
    expect(await ctl.baselineText(abs)).toBe('one\r\nTWO\nthree\r\nfour\n'); // each line keeps its own ending
    expect(await ctl.lineCounts(ctl.pendingFiles[0]!)).toEqual({ added: 1, removed: 0 }); // only "five"
    expect(core.calls.length).toBe(calls); // an EOL-only difference is no reason to push again
    // Keeping the last hunk leaves nothing pending.
    await ctl.onReviewAction({ kind: 'accepted', path: abs, baseline: 'one\nTWO\nthree\nfour\nfive\n' });
    await ctl.idle();
    expect(ctl.pendingFiles).toEqual([]);
    expect(core.shown.has(abs)).toBe(false);
    expect(read(abs)).toBe('one\r\nTWO\nthree\r\nfour\nfive\r\n'); // the file is untouched
  });

  it('Undo on a hunk: the buffer restore is saved like a user save and leaves the baseline alone', async () => {
    await open();
    const abs = await agentWrite('paper.tex', 'Intro.\nNew methods.\nResults.\nDiscussion.\n');
    // The core UI restored "Methods." in the buffer (one edit), then saved the clean buffer.
    const restored = 'Intro.\nMethods.\nResults.\nDiscussion.\n';
    await ctl.onReviewAction({ kind: 'rejected', path: abs });
    await userSave(abs, restored, [{ offset: 7, length: 12, text: 'Methods.\n', origin: 'user' }]);
    expect(await ctl.baselineText(abs)).toBe('Intro.\nMethods.\nResults.\n');
    expect(await ctl.lineCounts(ctl.pendingFiles[0]!)).toEqual({ added: 1, removed: 0 }); // only "Discussion." left
    // Undo the remaining insertion too: nothing pending.
    await userSave(abs, 'Intro.\nMethods.\nResults.\n', [{ offset: 25, length: 12, text: '', origin: 'user' }]);
    expect(ctl.pendingFiles).toEqual([]);
    expect(core.shown.has(abs)).toBe(false);
  });

  it("folds the user's own edits into the baseline on save; agent lines stay pending", async () => {
    await open();
    const abs = await agentWrite('paper.tex', 'Intro.\nNew methods.\nResults.\n');
    dirty.add(abs);
    // The user rewrites line 1 by hand and saves.
    await userSave(abs, 'Introduction.\nNew methods.\nResults.\n', [{ offset: 0, length: 6, text: 'Introduction.', origin: 'user' }]);
    expect(await ctl.baselineText(abs)).toBe('Introduction.\nMethods.\nResults.\n');
    expect(core.shown.get(abs)?.baseline).toBe('Introduction.\nMethods.\nResults.\n');
  });

  it('never pushes under unsaved edits; flags the conflict and catches up once the buffer is clean', async () => {
    await open();
    const abs = await agentWrite('paper.tex', 'Intro.\nNew methods.\nResults.\n');
    dirty.add(abs);
    await agentWrite('paper.tex', 'Intro.\nNewer methods.\nResults.\n');
    expect(conflicts).toEqual([abs]);
    const before = core.calls.length;
    dirty.delete(abs); // user reverted to disk
    await ctl.onBufferSettled(abs);
    await ctl.idle();
    expect(core.calls.length).toBe(before); // baseline unchanged, so nothing to push
    expect(core.shown.get(abs)?.baseline).toBe('Intro.\nMethods.\nResults.\n');
  });

  it('agent write under unsaved edits: the stale save is not attributed; the merged result keeps agent lines pending', async () => {
    await open();
    const abs = await agentWrite('paper.tex', 'Intro.\nNew methods.\nResults.\n');
    dirty.add(abs); // the user types "Intro!" in the buffer...
    const theirs = 'Intro.\nNew methods.\nResults.\nAgent conclusion.\n';
    await agentWrite('paper.tex', theirs); // ...and the agent writes again
    expect(conflicts).toEqual([abs]);
    expect(ctl.hasConflict(abs)).toBe(true);

    // Saving the stale buffer: the editor refuses ("file is newer"); nothing reaches the engine.
    await ctl.onWillSave(abs, 'Intro!\nNew methods.\nResults.\n', [{ offset: 5, length: 1, text: '!', origin: 'user' }]);
    expect(await ctl.baselineText(abs)).toBe('Intro.\nMethods.\nResults.\n');
    expect(read(abs)).toBe(theirs);

    // Merge: core reloads the buffer from disk (clean), then the merge editor writes the auto-merge into it.
    dirty.delete(abs);
    await ctl.onBufferSettled(abs);
    expect(ctl.hasConflict(abs)).toBe(false);
    dirty.add(abs);
    // Completing the merge saves the result; the edit log is held, so attribution diffs against the disk.
    await userSave(abs, 'Intro!\nNew methods.\nResults.\nAgent conclusion.\n', undefined);
    expect(await ctl.baselineText(abs)).toBe('Intro!\nMethods.\nResults.\n'); // only the user's line folded in
    expect(await ctl.lineCounts(ctl.pendingFiles[0]!)).toEqual({ added: 2, removed: 1 }); // the agent's work is still pending
  });

  it('a save in flight is not an external change, even if the list asks for line counts before the write', async () => {
    await open();
    const abs = await agentWrite('paper.tex', 'Intro.\nNew methods.\nResults.\n');
    dirty.add(abs);
    const content = 'Intro!\nNew methods.\nResults.\n';
    await ctl.onWillSave(abs, content, [{ offset: 5, length: 1, text: '!', origin: 'user' }]);
    await ctl.lineCounts(ctl.pendingFiles[0]!); // the tree refreshes on the user-save event, before the write
    await ctl.idle();
    fs.writeFileSync(abs, content);
    await ctl.handleFsEvents([abs]);
    await ctl.idle();
    dirty.delete(abs);
    await ctl.onBufferSettled(abs);
    await ctl.idle();
    expect(conflicts).toEqual([]);
    expect(await ctl.baselineText(abs)).toBe('Intro!\nMethods.\nResults.\n');
    expect(core.shown.get(abs)?.baseline).toBe('Intro!\nMethods.\nResults.\n');
  });

  it('format on save: formatter edits stay pending inside agent hunks and fold in elsewhere', async () => {
    fs.writeFileSync(path.join(root, 'conf.ini'), 'a=1\nb=2\nc=3\n');
    await open();
    const abs = await agentWrite('conf.ini', 'a=1\nb=20\nc=3\nd=4\n');
    // The buffer, its edit log, and the document version, as the extension tracks them.
    const logs = new EditLogs();
    const key = 'file://' + abs;
    logs.markClean(key);
    let text = read(abs);
    let version = 1;
    const change = (from: string, to: string) => {
      const offset = text.indexOf(from);
      text = text.slice(0, offset) + to + text.slice(offset + from.length);
      logs.onChange(key, [{ rangeOffset: offset, rangeLength: from.length, text: to }], true, ++version);
    };
    change('a=1', 'a=10'); // the user types
    const userVersion = version; // core: save participants start here
    for (const [from, to] of [['a=10', 'a = 10'], ['b=20', 'b = 20'], ['c=3', 'c = 3'], ['d=4', 'd = 4']]) { change(from!, to!); } // format on save
    dirty.add(abs);
    await userSave(abs, text, [...logs.get(key, userVersion)!]);
    expect(read(abs)).toBe('a = 10\nb = 20\nc = 3\nd = 4\n');
    expect(await ctl.baselineText(abs)).toBe('a = 10\nb=2\nc = 3\n');
    expect(core.shown.get(abs)?.baseline).toBe('a = 10\nb=2\nc = 3\n');
    expect(await ctl.lineCounts(ctl.pendingFiles[0]!)).toEqual({ added: 2, removed: 1 }); // b = 20 and d = 4: still the agent's
  });

  it('without the save-participant version, the same save counts the formatter as the user (stock VS Code)', async () => {
    fs.writeFileSync(path.join(root, 'conf.ini'), 'a=1\nb=2\n');
    await open();
    const abs = await agentWrite('conf.ini', 'a=1\nb=20\n');
    const logs = new EditLogs();
    logs.markClean('k');
    logs.onChange('k', [{ rangeOffset: 4, rangeLength: 4, text: 'b = 20' }], true, 2);
    dirty.add(abs);
    await userSave(abs, 'a=1\nb = 20\n', [...logs.get('k')!]);
    expect(ctl.pendingFiles).toEqual([]); // the agent line was "rewritten by the user": folded
  });

  it('created files show with an empty baseline; Undo deletes them', async () => {
    await open();
    const abs = await agentWrite('notes/todo.md', '# TODO\n- write\n');
    expect(core.shown.get(abs)).toEqual({ baseline: '', kind: 'created' });
    await ctl.onReviewAction({ kind: 'rejectFile', path: abs });
    await ctl.handleFsEvents([abs]);
    await ctl.idle();
    expect(fs.existsSync(abs)).toBe(false);
    expect(core.shown.has(abs)).toBe(false);
  });

  it('deleted files are listed (not inline); Undo restores them', async () => {
    await open();
    const abs = path.join(root, 'paper.tex');
    fs.rmSync(abs);
    await ctl.handleFsEvents([abs]);
    await ctl.idle();
    expect(ctl.pendingFiles.map((f) => [f.rel, f.kind, f.inline])).toEqual([['paper.tex', 'deleted', false]]);
    expect(core.shown.size).toBe(0);
    await ctl.rejectFile(abs);
    expect(read(abs)).toBe('Intro.\nMethods.\nResults.\n');
  });

  it('pending changes survive a restart (and changes made while closed appear)', async () => {
    await open();
    const abs = await agentWrite('paper.tex', 'Intro.\nNew methods.\nResults.\n');
    ctl.dispose();
    await review.close();
    fs.writeFileSync(path.join(root, 'later.txt'), 'written while the editor was closed\n'); // new file: created
    await open();
    expect(core.shown.get(abs)).toEqual({ baseline: 'Intro.\nMethods.\nResults.\n', kind: 'modified' });
    expect(ctl.pendingFiles.map((f) => [f.rel, f.kind])).toEqual([
      ['later.txt', 'created'],
      ['paper.tex', 'modified'],
    ]);
  });

  it('a git commit accepts everything (HEAD moved)', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    await open(true);
    const abs = await agentWrite('paper.tex', 'Intro.\nNew methods.\nResults.\n');
    expect(core.shown.has(abs)).toBe(true);
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'agent work');
    await ctl.handleFsEvents([path.join(root, '.git', 'HEAD')]);
    await ctl.idle();
    expect(ctl.pendingFiles).toEqual([]);
    expect(core.shown.has(abs)).toBe(false);
  });

  it('file Undo writes the baseline to disk, so the agent reads back what the user sees', async () => {
    await open();
    const abs = await agentWrite('paper.tex', 'Intro.\nNew methods.\nResults.\n');
    expect(await ctl.rejectFile(abs)).toBe('saved');
    expect(read(abs)).toBe('Intro.\nMethods.\nResults.\n');
    await ctl.idle();
    expect(ctl.pendingFiles).toEqual([]);
  });

  it('file Undo with unsaved edits: undone in the editor buffer, never written behind it; the next save writes it', async () => {
    await open(false, true);
    const abs = await agentWrite('paper.tex', 'Intro.\nNew methods.\nResults.\n');
    dirty.add(abs);
    expect(await ctl.rejectFile(abs)).toBe('unsaved');
    expect((core as FakeCoreWithEditorUndo).undoneInEditor).toEqual([abs]);
    expect(read(abs)).toBe('Intro.\nNew methods.\nResults.\n'); // the disk is left to the editor
    // The user saves: the buffer had the undo (restore "Methods.") plus their own edit on line 1.
    await userSave(abs, 'Introduction.\nMethods.\nResults.\n', [
      { offset: 0, length: 6, text: 'Introduction.', origin: 'user' },
      { offset: 14, length: 12, text: 'Methods.', origin: 'user' },
    ]);
    expect(read(abs)).toBe('Introduction.\nMethods.\nResults.\n');
    expect(ctl.pendingFiles).toEqual([]);
    expect(await ctl.baselineText(abs)).toBe('Introduction.\nMethods.\nResults.\n');
  });

  it('file Undo with unsaved edits is refused where the editor cannot do it (stock VS Code, created files)', async () => {
    await open();
    const abs = await agentWrite('paper.tex', 'Intro.\nNew methods.\nResults.\n');
    dirty.add(abs);
    await expect(ctl.rejectFile(abs)).rejects.toThrow(/unsaved changes/);
    expect(read(abs)).toBe('Intro.\nNew methods.\nResults.\n');

    ctl.dispose();
    await review.close();
    await open(false, true);
    const created = await agentWrite('notes.tex', 'New notes.\n');
    dirty.add(created);
    await expect(ctl.rejectFile(created)).rejects.toThrow(/unsaved changes/);
    expect(fs.existsSync(created)).toBe(true); // the user's unsaved text is never deleted
  });

  it('Undo All: clean files on disk, files with unsaved edits in their editor, unsaved created files skipped', async () => {
    await open(false, true);
    const a = await agentWrite('paper.tex', 'changed\n');
    const b = await agentWrite('b.txt', 'new\n');
    const c = await agentWrite('c.txt', 'also new\n');
    dirty.add(a);
    dirty.add(c);
    const r = await ctl.rejectAll();
    expect(r).toEqual({ done: [b, a].sort(), skipped: [c], unsaved: [a] });
    expect(fs.existsSync(b)).toBe(false);
    expect(read(a)).toBe('changed\n'); // left to the editor's next save
  });

  it('Keep All / Undo All', async () => {
    await open();
    const a = await agentWrite('paper.tex', 'changed\n');
    const b = await agentWrite('b.txt', 'new\n');
    dirty.add(a);
    const r = await ctl.rejectAll();
    expect(r).toEqual({ done: [b], skipped: [a], unsaved: [] }); // dirty buffer skipped (no editor undo: stock VS Code)
    expect(fs.existsSync(b)).toBe(false);
    dirty.delete(a);
    await ctl.acceptAll();
    await ctl.idle();
    expect(ctl.pendingFiles).toEqual([]);
    expect(await ctl.baselineText(a)).toBe('changed\n');
  });
});

describe('symlinked workspace folders and files', () => {
  /** Open the controller on a workspace folder given as `folder` (as VS Code would have it). */
  async function openFolder(folder: string): Promise<void> {
    review = await MultiRootReview.open({ roots: [folder], storageBase: storage, git: false });
    core = new FakeCore();
    ctl = new ReviewController(review, core, { isDirty: (p) => dirty.has(p) }, quiet, (p) => conflicts.push(p), new UiPaths([folder]));
    await ctl.syncAll();
  }

  async function write(abs: string, content: string, eventPath = abs): Promise<void> {
    fs.writeFileSync(abs, content);
    await ctl.handleFsEvents([eventPath]);
    await ctl.idle();
  }

  it('a folder opened through a symlink: tracked once under the real path, shown in core under the link path', async () => {
    const link = path.join(tmp, 'link'); // e.g. /tmp/paper on macOS, where /tmp is /private/tmp
    fs.symlinkSync(root, link);
    await openFolder(link);

    // Agent write through the link path (as VS Code's watcher reports it for this folder).
    await write(path.join(link, 'paper.tex'), 'Intro.\nNew methods.\nResults.\n');
    expect(ctl.pendingFiles.map((f) => f.absPath)).toEqual([path.join(root, 'paper.tex')]);
    expect([...core.shown.keys()]).toEqual([path.join(link, 'paper.tex')]); // the editor's URI, not the real path

    // Agent write through the real path, reported either way: the same single file.
    await write(path.join(root, 'paper.tex'), 'Intro.\nNew methods.\nResults.\nMore.\n');
    await write(path.join(root, 'paper.tex'), 'Intro.\nNew methods.\nResults.\nMore!\n', path.join(link, 'paper.tex'));
    expect(ctl.pendingFiles.map((f) => f.rel)).toEqual(['paper.tex']);
    expect([...core.shown.keys()]).toEqual([path.join(link, 'paper.tex')]);
    expect(core.shown.get(path.join(link, 'paper.tex'))?.baseline).toBe('Intro.\nMethods.\nResults.\n');

    // A new file written through the real path shows under the link path too.
    await write(path.join(root, 'notes.tex'), 'Notes.\n');
    expect(core.shown.get(path.join(link, 'notes.tex'))).toEqual({ baseline: '', kind: 'created' });

    // Keep from core (link path) and a user save through the link path reach the same engine file.
    await ctl.onReviewAction({ kind: 'accepted', path: path.join(link, 'paper.tex'), baseline: 'Intro.\nNew methods.\nResults.\nMore!\n' });
    await ctl.idle();
    expect(core.shown.has(path.join(link, 'paper.tex'))).toBe(false);
    expect(await ctl.baselineText(path.join(link, 'paper.tex'))).toBe('Intro.\nNew methods.\nResults.\nMore!\n');
    await write(path.join(link, 'paper.tex'), 'Intro.\nNew methods.\nResults.\nMore!\nAgent line.\n');
    // The user rewrites line 1 in the editor (link path) and saves: folded in; the agent's line stays pending.
    await userSave(path.join(link, 'paper.tex'), 'Introduction.\nNew methods.\nResults.\nMore!\nAgent line.\n', [{ offset: 0, length: 6, text: 'Introduction.', origin: 'user' }]);
    expect(await ctl.baselineText(path.join(root, 'paper.tex'))).toBe('Introduction.\nNew methods.\nResults.\nMore!\n');
    expect(core.shown.get(path.join(link, 'paper.tex'))?.baseline).toBe('Introduction.\nNew methods.\nResults.\nMore!\n');
    expect([...core.shown.keys()].every((p) => p.startsWith(link + path.sep))).toBe(true); // never a copy under the real path
  });

  it('unsaved edits opened through the link are seen; the conflict is reported with the link path', async () => {
    const link = path.join(tmp, 'link');
    fs.symlinkSync(root, link);
    await openFolder(link);
    await write(path.join(link, 'paper.tex'), 'Intro.\nNew methods.\nResults.\n');
    dirty.add(path.join(root, 'paper.tex')); // DocumentState is asked with real paths (the extension compares real paths)
    await write(path.join(link, 'paper.tex'), 'Intro.\nNewer methods.\nResults.\n');
    expect(conflicts).toEqual([path.join(link, 'paper.tex')]);
  });

  it('a file symlink inside the workspace: agent writes through it show up once, under the real file', async () => {
    fs.symlinkSync(path.join(root, 'paper.tex'), path.join(root, 'alias.tex'));
    await openFolder(root);
    await write(path.join(root, 'alias.tex'), 'Intro.\nNew methods.\nResults.\n');
    expect(ctl.pendingFiles.map((f) => [f.rel, f.kind])).toEqual([['paper.tex', 'modified']]);
    expect([...core.shown.keys()]).toEqual([path.join(root, 'paper.tex')]);
  });

  it('UiPaths maps real paths under a linked folder back to the folder path, and leaves others alone', async () => {
    const link = path.join(tmp, 'link');
    fs.symlinkSync(root, link);
    await openFolder(link);
    const ui = new UiPaths([link, path.join(tmp, 'storage')]);
    expect(ui.toUi(root)).toBe(link);
    expect(ui.toUi(path.join(root, 'a', 'b.tex'))).toBe(path.join(link, 'a', 'b.tex'));
    expect(ui.toUi(path.join(tmp, 'elsewhere.tex'))).toBe(path.join(tmp, 'elsewhere.tex'));
    expect(ui.toUi(root + '-sibling')).toBe(root + '-sibling');
  });
});
