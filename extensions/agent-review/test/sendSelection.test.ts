import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeCommand = vi.fn(async (..._args: unknown[]) => undefined as unknown);
const createTerminal = vi.fn();
const showWarningMessage = vi.fn(async () => undefined);
const editor = {
  selection: { start: { line: 41, character: 0 }, end: { line: 58, character: 0 }, isEmpty: false },
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
  beforeEach(() => { executeCommand.mockClear(); createTerminal.mockClear(); showWarningMessage.mockClear(); });

  it('inserts the reference into the agent chat', async () => {
    await sendSelectionToChat();
    expect(executeCommand).toHaveBeenCalledWith('agentChat.insertReference', '@paper/main.tex:L42-58', editor.document.uri, 42, 58);
    expect(createTerminal).not.toHaveBeenCalled();
  });

  it('never falls back to a terminal without the agent chat', async () => {
    executeCommand.mockRejectedValueOnce(new Error('command not found'));
    await sendSelectionToChat();
    expect(createTerminal).not.toHaveBeenCalled();
    expect(showWarningMessage).toHaveBeenCalledOnce();
  });
});
