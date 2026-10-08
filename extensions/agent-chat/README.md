# agent-chat (spike)

Phase A0 prototype of the ACP chat panel ([PLAN.md](../../PLAN.md) Phase 4, [docs/acp-design.md](../../docs/acp-design.md)). It drives VS Code's native chat, in the secondary side bar or an editor tab, from a built-in extension, with no core patch. Not shipped yet: `fork/scripts/install-extension.sh` installs it only with `EXTENSIONS="agent-review agent-chat"`.

- **Default participant** (`chatParticipants[].isDefault`, `modes: [ask, agent, edit]`, `defaultChatParticipant` proposal). This is what makes core show the chat view and accept requests while `chat.disableAIFeatures` stays on and Copilot is absent.
- **Session types** `agent-claude` (relays to `claude-agent-acp` through `@editor/acp-client`) and `agent-echo` (UI checks without model usage). Each has `canDelegate: true`, because core registers a session type's participant only then.
- **Models.** Each type sets `requiresCustomModels` and the extension registers the `agent-chat` language-model vendor, whose models are the harness's model choices, targeted at that type. Core needs a model for every request; the editor never calls one, and the choice is forwarded as the ACP `model` option.
- **Pickers.** The other ACP select options become `ChatSessionProviderOptionGroup`s (`src/options.ts`). Changes reach the harness through `inputState.onDidChange`, and selections made in an untitled chat carry over through `previousInputState`.
- **Permission prompts** use the core `vscode_get_confirmation_with_options` tool, which can't be auto-approved.
- **Opens on Claude Code.** `configurationDefaults` sets `chat.editor.localAgent.enabled: false`, so core's Local chat (Copilot's "Build with Agent") isn't offered and new chats default to the first session type by `order`.
- **No edit parts** are emitted, so the chat's own editing session stays empty and agent-review owns Keep/Undo.
- **`agentChat.insertReference`** inserts `@path:Lx-y` into the last focused chat input (`workbench.action.chat.open` with `isPartialQuery`).

`src/typings/` holds copies of the VS Code 1.135 proposal `.d.ts` files (`src/vscode-dts`). Refresh them on upstream merges.
