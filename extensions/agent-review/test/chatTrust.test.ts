import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeCommand = vi.fn(async (..._args: unknown[]) => undefined as unknown);
const showInformationMessage = vi.fn(async (..._args: unknown[]) => undefined as unknown);
const registerCommand = vi.fn((id: string, fn: () => unknown) => ({ id, fn, dispose() {} }));

vi.mock('vscode', () => ({
  window: { showInformationMessage },
  commands: { executeCommand, registerCommand },
}));

const { explainChatNeedsTrust, MANAGE_TRUST, registerChatTrustHint, TRUST_COMMANDS } = await import('../src/chatTrust');

const review = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const chat = JSON.parse(readFileSync(new URL('../../agent-chat/package.json', import.meta.url), 'utf8'));
const titleOf = (pkg: typeof review, id: string) => pkg.contributes.commands.find((c: { command: string }) => c.command === id)?.title;

describe('Restricted Mode: the agent chat says it needs a trusted folder (#36)', () => {
  beforeEach(() => {
    executeCommand.mockClear();
    showInformationMessage.mockReset();
  });

  it('agent-chat stays off in an untrusted folder (its agents run commands), so agent-review stands in', () => {
    expect(chat.capabilities.untrustedWorkspaces.supported).toBe(false);
    expect(review.capabilities.untrustedWorkspaces.supported).toBe(true);
  });

  it('the palette has the chat\'s "New … Chat" commands, by the same titles, only while the folder is untrusted', () => {
    const palette = review.contributes.menus.commandPalette;
    const real: Record<string, string> = {
      'agentReview.chatNeedsTrust.newChat': 'agentChat.newChat',
      'agentReview.chatNeedsTrust.newClaude': 'agentChat.newClaude',
      'agentReview.chatNeedsTrust.newCodex': 'agentChat.newCodex',
      'agentReview.chatNeedsTrust.newTact': 'agentChat.newTact',
    };
    expect(Object.keys(TRUST_COMMANDS).sort()).toEqual(Object.keys(real).sort());
    for (const [id, chatId] of Object.entries(real)) {
      expect(titleOf(review, id)).toBe(titleOf(chat, chatId));
      expect(palette.find((m: { command: string }) => m.command === id)?.when).toBe('!isWorkspaceTrusted');
    }
  });

  it('the secondary side bar has a Chat view with a Manage Workspace Trust link, only while the folder is untrusted', () => {
    expect(review.contributes.viewsContainers.secondarySidebar.map((c: { id: string }) => c.id)).toContain('agentChatTrust');
    expect(review.contributes.views.agentChatTrust).toEqual([expect.objectContaining({ id: 'agentReview.chatNeedsTrust', when: '!isWorkspaceTrusted' })]);
    const welcome = review.contributes.viewsWelcome.find((w: { view: string }) => w.view === 'agentReview.chatNeedsTrust');
    expect(welcome.contents).toContain('Restricted Mode');
    expect(welcome.contents).toContain('(command:workbench.trust.manage)');
  });

  it('every stand-in command is registered', () => {
    const ds = registerChatTrustHint();
    expect(ds.map((d) => (d as unknown as { id: string }).id).sort()).toEqual(Object.keys(TRUST_COMMANDS).sort());
  });

  it('a stand-in command explains why and opens Manage Workspace Trust when asked', async () => {
    showInformationMessage.mockResolvedValueOnce(MANAGE_TRUST);
    await explainChatNeedsTrust('A Claude Code chat');
    expect(showInformationMessage).toHaveBeenCalledWith('A Claude Code chat needs a trusted folder', expect.objectContaining({ modal: true, detail: expect.stringContaining('Restricted Mode') }), MANAGE_TRUST);
    expect(executeCommand).toHaveBeenCalledWith('workbench.trust.manage');
  });

  it('dismissing it does nothing', async () => {
    await explainChatNeedsTrust('A Codex chat');
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
