/**
 * The notice for a disk change under unsaved edits, and its Merge… button (VS Code mocked).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class Uri {
  private constructor(readonly fsPath: string) {}
  static file(p: string): Uri { return new Uri(p); }
  toString(): string { return `file://${this.fsPath}`; }
}

const executeCommand = vi.fn(async (..._args: unknown[]): Promise<unknown> => true);
const showWarningMessage = vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined);
const showInformationMessage = vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined);
const showErrorMessage = vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined);
const textDocuments: { uri: Uri; isDirty: boolean; getText(): string }[] = [];
const none = () => ({ dispose() {} });

vi.mock('vscode', () => ({
  Uri,
  window: { showWarningMessage, showInformationMessage, showErrorMessage, tabGroups: { onDidChangeTabs: none } },
  workspace: { onDidSaveTextDocument: none, textDocuments },
  commands: { executeCommand },
}));

const { ConflictMerger } = await import('../src/conflicts');
const { EditLogs } = await import('../src/editLog');

let tmp: string;
let file: string;
let merger: InstanceType<typeof ConflictMerger>;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-review-conflicts-')));
  file = path.join(tmp, 'method.tex');
  fs.writeFileSync(file, 'agent version\n');
  textDocuments.length = 0;
  textDocuments.push({ uri: Uri.file(file), isDirty: true, getText: () => 'your version\n' });
  for (const f of [executeCommand, showWarningMessage, showInformationMessage, showErrorMessage]) { f.mockClear(); }
  executeCommand.mockImplementation(async () => true);
  const ctl = { baselineText: async () => 'base\n' };
  merger = new ConflictMerger(ctl as never, new EditLogs(), path.join(tmp, 'conflicts'), true, log as never);
});

afterEach(() => {
  merger.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mergeCalls(): unknown[][] {
  return executeCommand.mock.calls.filter((c) => c[0] === '_agentReview.openMerge');
}

describe('conflict notice', () => {
  it('Merge… in the notice opens the same 3-way merge as the palette command, for that file (#35)', async () => {
    showWarningMessage.mockResolvedValueOnce('Merge…');
    await merger.onConflict(file);
    expect(showWarningMessage).toHaveBeenCalledOnce();
    expect(showWarningMessage.mock.calls[0]).toContain('Merge…');
    expect(mergeCalls()).toHaveLength(1);
    const [, uri, base] = mergeCalls()[0]!;
    expect((uri as Uri).fsPath).toBe(file);
    expect(base).toBe('base\n');

    // The palette command (agentReview.mergeWithDisk) calls merge() with the active editor's path: the same call.
    await merger.merge(file);
    expect(mergeCalls()[1]).toEqual(mergeCalls()[0]);
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it('a failure behind Merge… is reported, not swallowed', async () => {
    showWarningMessage.mockResolvedValueOnce('Merge…');
    fs.writeFileSync(path.join(tmp, 'conflicts'), ''); // the backup folder can't be created
    await merger.onConflict(file);
    expect(mergeCalls()).toHaveLength(0);
    expect(showErrorMessage).toHaveBeenCalledOnce();
    expect(String(showErrorMessage.mock.calls[0]![0])).toContain('method.tex');
  });

  it('says so when core finds nothing to merge, instead of doing nothing', async () => {
    showWarningMessage.mockResolvedValueOnce('Merge…');
    executeCommand.mockImplementation(async () => false);
    await merger.onConflict(file);
    expect(mergeCalls()).toHaveLength(1);
    expect(showInformationMessage).toHaveBeenCalledOnce();
  });

  it('dismissing the notice opens nothing and writes nothing', async () => {
    await merger.onConflict(file);
    expect(mergeCalls()).toHaveLength(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('agent version\n');
  });

  it('every later change shows the notice again, even while an earlier one is unanswered in the notification center (#34)', async () => {
    // The first notice hid itself after a few seconds: its promise stays pending until the user acts on it.
    let answerFirst!: (v: string | undefined) => void;
    showWarningMessage.mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }));
    const first = merger.onConflict(file);
    await vi.waitFor(() => expect(showWarningMessage).toHaveBeenCalledTimes(1));

    fs.writeFileSync(file, 'shell version\n'); // e.g. sed -i from a terminal
    showWarningMessage.mockResolvedValueOnce('Merge…');
    await merger.onConflict(file);
    expect(showWarningMessage).toHaveBeenCalledTimes(2);
    expect(mergeCalls()).toHaveLength(1);

    // The old notice, closed when VS Code replaced it, changes nothing.
    answerFirst(undefined);
    await first;
    expect(mergeCalls()).toHaveLength(1);
    // Both versions on disk were kept.
    const kept = fs.readdirSync(path.join(tmp, 'conflicts')).filter((n) => n.includes('-agent-')).map((n) => fs.readFileSync(path.join(tmp, 'conflicts', n), 'utf8'));
    expect(kept.sort()).toEqual(['agent version\n', 'shell version\n']);
  });
});
