/**
 * Restricted Mode hint for the agent chat (#36).
 *
 * agent-chat doesn't run in an untrusted folder (its agents run commands and edit files), so in Restricted Mode
 * none of its commands or views exist. This extension does run there, so it stands in: the chat's "New … Chat"
 * commands and a "Chat" view in the secondary side bar (package.json, shown only while `!isWorkspaceTrusted`)
 * say why there's no chat and offer to trust the folder.
 */
import * as vscode from 'vscode';

/** Stand-in command ids (package.json) → the chat each one stands for. */
export const TRUST_COMMANDS: Record<string, string> = {
  'agentReview.chatNeedsTrust.newChat': 'An agent chat',
  'agentReview.chatNeedsTrust.newClaude': 'A Claude Code chat',
  'agentReview.chatNeedsTrust.newCodex': 'A Codex chat',
  'agentReview.chatNeedsTrust.newTact': 'A tact chat',
};

export const MANAGE_TRUST = 'Manage Workspace Trust';

export function trustMessage(chat: string): { message: string; detail: string } {
  return {
    message: `${chat} needs a trusted folder`,
    detail: 'The agents run commands and edit files in this folder, so the chat is off in Restricted Mode. Trust the folder to start a chat.',
  };
}

export async function explainChatNeedsTrust(chat: string): Promise<void> {
  const { message, detail } = trustMessage(chat);
  const pick = await vscode.window.showInformationMessage(message, { modal: true, detail }, MANAGE_TRUST);
  if (pick === MANAGE_TRUST) {
    await vscode.commands.executeCommand('workbench.trust.manage');
  }
}

export function registerChatTrustHint(): vscode.Disposable[] {
  return Object.entries(TRUST_COMMANDS).map(([id, chat]) => vscode.commands.registerCommand(id, () => explainChatNeedsTrust(chat)));
}
