import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeCommand = vi.fn(async (..._args: unknown[]) => undefined as unknown);

vi.mock('vscode', () => ({
	Range: class { constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) { } },
	commands: { executeCommand },
}));

const { insertReference } = await import('../src/reference');
const uri = { fsPath: '/w/paper/main.tex' };

describe('Cmd/Ctrl+L into the chat', () => {
	beforeEach(() => executeCommand.mockReset());

	it('goes through core, which inserts the pill and leaves focus after it, for the selected lines', async () => {
		executeCommand.mockResolvedValueOnce(true);
		await insertReference({ text: '@paper/main.tex:L13-14', uri: uri as never, startLine: 13, endLine: 14 });
		expect(executeCommand).toHaveBeenCalledTimes(1);
		expect(executeCommand).toHaveBeenCalledWith('_agentChat.insertReference', '@paper/main.tex:L13-14', uri, { startLine: 12, startCharacter: 0, endLine: 13, endCharacter: 0 });
	});

	it('a whole file has no range', async () => {
		executeCommand.mockResolvedValueOnce(true);
		await insertReference({ text: '@paper/main.tex', uri: uri as never });
		expect(executeCommand).toHaveBeenCalledWith('_agentChat.insertReference', '@paper/main.tex', uri, undefined);
	});

	it.each([
		['returns false', () => executeCommand.mockResolvedValueOnce(false)],
		['is missing (an older core)', () => executeCommand.mockRejectedValueOnce(new Error('command not found'))],
	])('when core %s, the chat opens with the reference and a space, so the caret ends after it', async (_case, setUp) => {
		setUp();
		await insertReference({ text: '@paper/main.tex:L13-14', uri: uri as never, startLine: 13, endLine: 14 });
		expect(executeCommand).toHaveBeenLastCalledWith('workbench.action.chat.open', { query: '@paper/main.tex:L13-14 ', isPartialQuery: true });
	});
});
