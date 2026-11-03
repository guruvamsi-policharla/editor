import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeCommand = vi.fn(async (..._args: unknown[]) => undefined as unknown);
const createTerminal = vi.fn();
const showWarningMessage = vi.fn(async () => undefined);
const LINES = { start: { line: 41, character: 0 }, end: { line: 58, character: 0 }, isEmpty: false };
const editor = {
  selection: LINES as { start: { line: number; character: number }; end: { line: number; character: number }; isEmpty: boolean },
  document: { uri: { fsPath: '/w/paper/main.tex' } },
};

vi.mock('vscode', () => ({
  window: { activeTextEditor: editor, createTerminal, showWarningMessage },
  workspace: {
    getConfiguration: () => ({ get: <T>(_k: string, d: T) => d }),
    asRelativePath: () => 'paper/main.tex',
  },
  commands: { executeCommand },
}));

const { sendSelectionToChat } = await import('../src/sendSelection');

describe('Ctrl/Cmd+L', () => {
  beforeEach(() => { executeCommand.mockClear(); createTerminal.mockClear(); showWarningMessage.mockClear(); editor.selection = LINES; });

  it('inserts the reference into the agent chat', async () => {
    await sendSelectionToChat();
    expect(executeCommand).toHaveBeenCalledWith('agentChat.insertReference', '@paper/main.tex:L42-58', editor.document.uri, 42, 58);
    expect(createTerminal).not.toHaveBeenCalled();
  });

  it('with nothing selected, inserts a reference to the whole file (no lines)', async () => {
    editor.selection = { start: { line: 29, character: 7 }, end: { line: 29, character: 7 }, isEmpty: true };
    await sendSelectionToChat();
    expect(executeCommand).toHaveBeenCalledWith('agentChat.insertReference', '@paper/main.tex', editor.document.uri, undefined, undefined);
  });

  it('never falls back to a terminal without the agent chat', async () => {
    executeCommand.mockRejectedValueOnce(new Error('command not found'));
    await sendSelectionToChat();
    expect(createTerminal).not.toHaveBeenCalled();
    expect(showWarningMessage).toHaveBeenCalledOnce();
  });
});
