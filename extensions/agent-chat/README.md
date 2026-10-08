# agent-chat

The ACP chat panel ([PLAN.md](../../PLAN.md) §5.4 and Phase 4, design in [docs/acp-design.md](../../docs/acp-design.md)). It drives VS Code's native chat from a built-in extension, with no core patch, on top of [`@editor/acp-client`](../../packages/acp-client). Chats open in the secondary side bar (Agent Chat: New Claude Code Chat / New Codex Chat) or as editor tabs (New Agent Chat in Editor).

**The harness edits files itself.** The client advertises no `fs` or `terminal` capability, and nothing here emits chat edit parts, so the chat's own editing session stays empty and agent-review shows every edit inline with Keep/Undo.

| Piece | How |
|---|---|
| Showing chat without Copilot | A default participant (`chatParticipants[].isDefault`, `modes: [ask, agent, edit]`, `defaultChatParticipant` proposal) makes core show the chat view and accept requests while `chat.disableAIFeatures` stays on. `configurationDefaults` turns off core's Local chat, so new chats open on Claude Code |
| Session types | `agent-claude`, `agent-codex`: one per harness profile (`src/harnessChat.ts`), each with `canDelegate` (core registers a type's participant only then) and `requiresCustomModels` |
| Models | The harness's `model` options are the native model picker, through the `agent-chat` language-model vendor targeted at the session type (`src/models.ts`). Core needs a model per request; the editor never calls one. A picker selection is applied when the user changed it, so the agent's own model switches stick |
| Pickers | Every other ACP select option is an option group (`src/groups.ts`), in the agent's order: Claude's mode (Plan is a mode, also `/plan`), effort and fast; Codex's approval preset, collaboration mode (`/plan`), effort and fast. Codex's next-turn options say "Applies from your next message". Re-rendered from every response and `config_option_update`. Selections made in an untitled chat carry over to its first message. Dangerous values (Codex Full access) need a modal confirm; Claude's Bypass is removed from the session and hidden |
| A turn | Reducer changes → render ops (`src/render.ts`, pure) → stream parts (`src/stream.ts`): markdown, thinking blocks, tool cards (commands as terminal cards with output and exit code; reads and edits as file pills, edits with +/− counts, display only; searches and other tools with input/output), the plan as core's todo list (`manage_todo_list`). The footer shows the model and context use |
| Permissions | `session/request_permission` → core's `vscode_get_confirmation_with_options` (can't be auto-approved): the exact command or paths, the agent's description, buttons Yes / No / "always" (with where it's saved). Stop answers open prompts `cancelled`. Every decision is in the log |
| Stop | The Stop button → `session/cancel` |
| References | The text goes as typed; attached files, the active editor, and `@path:L42-58` mentions also go as ACP `resource_link`s (`src/prompt.ts`). Slash commands: Claude's and Codex's common ones are listed for completion; any other `/command` goes through as text |
| Cmd/Ctrl+L | `agentChat.insertReference(text)` inserts into the last focused chat input. agent-review's Send Selection to Agent calls it when the chat is the target (`agentReview.agent.target`; `auto` = whichever of chat and terminal was used last, from `agentChat.lastUsed`) |
| Lazy start | Nothing starts at window load: the pickers show the options remembered from the last session. The adapter starts on the first message, or in the background when you open a new chat |
| Install | The user's `claude`/`codex` on PATH is passed to the adapter. The pinned adapter is installed on first use into global storage (`npm ci` with the lockfiles in `dist/adapters/`, without the bundled harness binary when the CLI is on PATH) and runs under the editor's own Node. Overrides: `agentChat.harnesses.<id>.adapterPath`, `.harnessPath`, `.env`, `.defaults` |
| Errors | Not signed in → a "Not signed in" picker and an in-chat warning with **Sign in** (runs `claude auth login` / `codex login` in a terminal; the adapter restarts when it closes). Adapter crash → the turn ends with "stopped unexpectedly (exit code …)"; the next message restarts it (backoff) and resumes the session. Start failures say why, with Show Log / Restart |
| Workspace trust | Agents don't start in Restricted Mode |

`src/typings/` holds copies of the VS Code 1.135 proposal `.d.ts` files (`src/vscode-dts`). Refresh them on upstream merges.

Tests (`npm test`): rendering against a recorded Claude run, pickers from recorded config options, prompt blocks. The protocol side is tested in `packages/acp-client` (fake agent, contract tests).
