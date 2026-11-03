# ACP connector: research and design

*Prepared Oct 8, 2026 (PT) for `guruvamsi-policharla/editor`. **Since Nov 2, 2026 tact is the chat's only harness** ([tact only](#tact-only)): what this doc says about Claude Code and Codex is history. Status: approved; A0 (spike) done, A and B built as an MVP (`packages/acp-client`, `extensions/agent-chat`); history, several chats, waiting between agents, inline Cmd/Ctrl+L and tact (parts of D and E) built in the chat-polish round, §11. PLAN.md §5.4 and Phase 4 summarize it. Where the build differs from this doc: the spike report (`kind: 'permissions'` unused, mode is a normal picker; models are the native model picker; no core patch) and `extensions/agent-chat/README.md`.*

**Decisions (Oct 8, 2026), answering §10:** Claude starts in Accept edits with prompts for commands; Codex starts in Workspace access (not Auto review); Claude's Bypass is hidden and Codex's Full access is behind a confirmation (changed Oct 12, 2026 by Guru: Bypass permissions is offered behind a confirmation each time, never a default and never restored; see the extension's README); the chat lives in the secondary side bar (right), with sessions also openable as editor tabs; Cmd/Ctrl+L goes to whichever of chat/terminal was used last (configurable); the user's installed `claude`/`codex` are used when found on PATH, else pinned adapters are downloaded on first use; a webview fallback is acceptable if the native chat needs invasive patches; the PLAN.md wording changes are approved.

**TL;DR**

- **ACP fits the requirements.** The editor starts an adapter process (`claude-agent-acp`, `codex-acp`, `gemini --acp`) and exchanges JSON-RPC with it over stdio. If the editor doesn't advertise `fs` or `terminal` client capabilities, the harness reads, writes and runs commands with its own tools. Our file watcher then turns those edits into Keep/Undo, exactly as it does today. ACP v2 (draft) goes further and deletes the client fs/terminal API entirely ([migration guide](https://agentclientprotocol.com/protocol/v2/migration#client-file-system-and-terminal-execution-removed)), so our design is where the protocol is heading.
- **Most of "all the buttons" work live over ACP today**, through the stable **Session Config Options** API (`session/set_config_option`). Both adapters expose:
  - permission mode;
  - model;
  - reasoning effort;
  - fast mode;
  - plan mode (Codex: a separate `collaboration_mode` option).
  
  Answering permission prompts (`session/request_permission`), cancel, and listing/resuming sessions also work live for both. `session/set_model` is gone: it was never stabilized and was [removed on June 1, 2026](https://github.com/agentclientprotocol/agent-client-protocol/blob/1c2b84c785c923ed283a4e7ea3badb2422596418/docs/rfds/updates.mdx).
- **The gap: standing allow/deny rules.** ACP has no API to list or edit a harness's persistent permission rules. The fix is a per-harness **rules editor** that edits the harness's own files:
  - Claude: `permissions.allow/deny/ask` in `~/.claude/settings.json`, `.claude/settings.json` and `.claude/settings.local.json`;
  - Codex: `prefix_rule(...)` in `~/.codex/rules/default.rules`.
  
  After an edit, restart or resume the session if the harness only reads these files at startup. Smaller gaps:
  - Codex's permission mode is 4 fixed approval-plus-sandbox presets, and changes apply from the next turn;
  - effort and fast mode only appear for models that support them;
  - Claude's "always allow" can write `.claude/settings.local.json` inside the workspace, which our review would flag unless we ignore it.
- **Recommendation: VS Code's native chat UI, driven from a new built-in extension.** The extension uses the `chatSessionsProvider`, `chatParticipantAdditions` and `chatParticipantPrivate` proposed APIs, with ACP config options shown as the chat input's option pickers and permission prompts shown with the core `vscode_get_confirmation_with_options` tool. The ACP client logic goes in an editor-independent `packages/acp-client`, so we can fall back to a webview panel without rewriting it. Start with a **2–3 day spike** that answers the two unknowns: whether the hidden chat UI can be shown for our provider only, and how many option pickers it allows.

Source snapshots read for this doc (all cloned on Oct 8, 2026):

| Repo | Commit / version |
|---|---|
| Spec: [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) | `1c2b84c` (Oct 8, 2026) |
| TS SDK: [agentclientprotocol/typescript-sdk](https://github.com/agentclientprotocol/typescript-sdk), npm `@agentclientprotocol/sdk` | 1.7.0 (Apache-2.0) |
| Claude adapter: [agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) (was `zed-industries/claude-code-acp`; the old npm `@zed-industries/claude-code-acp` is deprecated), npm `@agentclientprotocol/claude-agent-acp` | 0.87.0, commit `b2dbc8f` (Apache-2.0) |
| Codex adapter: [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp) (the old `zed-industries/codex-acp` README says development moved here; it's built on the Codex App Server), npm `@agentclientprotocol/codex-acp` | 2.1.1, commit `4583cb3` (Apache-2.0; bundles `@openai/codex` ^0.159.1) |
| VS Code (our pin) | 1.135.0 @ `08d4889f`, local copy `/workspace/phase0/vscode-1135` |

Throughout: **[verified: source]** means I read it in the code at the commits above, **[verified: docs]** means it's in official docs, and **[unverified]** means it still needs a test.

---

## 1. The ACP spec today (Q1)

ACP is JSON-RPC 2.0, newline-delimited over the agent's stdio ([transports](https://agentclientprotocol.com/protocol/v1/transports)). **v1 is the stable version** (`protocolVersion: 1`). **v2 has been a Draft since July 20, 2026** ([announcement](https://agentclientprotocol.com/announcements/acp-v2-draft)): implementers are told to gate it behind version negotiation plus feature flags and to keep supporting v1. **Build on v1**, and design so that moving to v2 is a mapping change, not a redesign (see §1.10).

### 1.1 Stable v1 methods (from `schema/v1/schema.json` / [schema docs](https://agentclientprotocol.com/protocol/v1/schema))

| Direction | Method | Notes |
|---|---|---|
| Client → Agent | `initialize` | Version and capability negotiation. `clientInfo`/`agentInfo` |
| | `authenticate`, `logout` | Auth. `logout` is gated by `agentCapabilities.auth.logout` (stabilized May 21, 2026) |
| | `session/new` | `cwd` (absolute), `mcpServers`, optional `additionalDirectories` (stabilized June 1, 2026) |
| | `session/load` | Gated by `agentCapabilities.loadSession`. **Replays** history as `session/update`s before it responds |
| | `session/resume` | Gated by `sessionCapabilities.resume`. Reconnects **without** replay (stabilized Apr 22, 2026) |
| | `session/list`, `session/close`, `session/delete` | Gated by `sessionCapabilities.list` / `close` / `delete` (stabilized Mar–Jun 2026) |
| | `session/prompt` | Content blocks. Every agent MUST accept `text` and `resource_link`; `image`/`audio`/`resource` depend on `promptCapabilities`. The response carries `stopReason`: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled` |
| | `session/cancel` (notification) | Baseline. The client MUST answer pending permission requests with `cancelled`; the agent ends the turn with `stopReason: cancelled` ([prompt turn § Cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation)) |
| | `session/set_config_option` | **Preferred** way to set mode, model, effort and similar. The response is the full option list (stabilized Feb 4, 2026) |
| | `session/set_mode` | Legacy. The [docs](https://agentclientprotocol.com/protocol/v1/session-modes) say it will be removed. Use config options |
| Agent → Client | `session/update` (notification) | Kinds: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update` |
| | `session/request_permission` | `toolCall` plus `options[]`, each with an `optionId`, a `name` and a `kind` (`allow_once` / `allow_always` / `reject_once` / `reject_always`). The outcome is `selected{optionId}` or `cancelled` ([tool calls § Requesting permission](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission)) |
| | `fs/read_text_file`, `fs/write_text_file` | **Only if the client advertises `fs.readTextFile` / `fs.writeTextFile`.** We won't |
| | `terminal/create`, `/output`, `/wait_for_exit`, `/kill`, `/release` | **Only if the client advertises `terminal: true`.** We won't |
| | `elicitation/create`, `elicitation/complete` | Structured forms and URL flows (stabilized July 22, 2026). Gated by `clientCapabilities.elicitation.{form,url}` |
| Both | `$/cancel_request` | Cancels any request by id (stabilized June 29, 2026) |

Tool call fields: `kind` is one of `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`. `status` is one of `pending`, `in_progress`, `completed`, `failed`. `content` is a list of `content`, `diff` or `terminal` items. `locations[]` gives paths and lines. The optional programmatic `name` was stabilized Sept 17, 2026.

### 1.2 Session config options (the "buttons" API) [verified: docs]

Source: [session-config-options](https://agentclientprotocol.com/protocol/v1/session-config-options).

- **Where options come from:**
  - The agent returns `configOptions[]` from `session/new`, `load` or `resume`.
  - Each option is `{id, name, description?, category?, type, currentValue, options[]}`.
  - `type` is `select`, or `boolean` if the client advertised `clientCapabilities.session.configOptions.boolean: {}` (stabilized July 6, 2026).
  - Select options may be grouped.
- **Categories:**
  - `mode`, `model`, `model_config` (for example a speed/quality trade-off; stabilized June 24, 2026), and `thought_level`.
  - Names starting with `_` are free for custom use; all others are reserved. Clients must tolerate unknown categories.
- **Changing an option:**
  - The client calls `session/set_config_option {sessionId, configId, value}`, at any time, **including mid-turn**.
  - The agent answers with the **complete** list, because one change can change others (for example, switching the model changes the available effort levels).
- **Agent-side changes:** the agent pushes `config_option_update` (complete list), for example when it leaves plan mode or falls back to another model.
- **Order matters:** clients should keep the agent's order.

### 1.3 Model selection

There is **no separate model API in stable v1**. The unstable `session/set_model` and the related response fields were **removed on June 1, 2026** ("Agents should continue to expose model selection through Session Config Options"; [RFD updates](https://github.com/agentclientprotocol/agent-client-protocol/blob/1c2b84c785c923ed283a4e7ea3badb2422596418/docs/rfds/updates.mdx)). Model choice is the config option with `category: "model"`.

### 1.4 Authentication [verified: docs]

Source: [authentication](https://agentclientprotocol.com/protocol/v1/authentication).

`authMethods[]` in the `initialize` response:
- **`type: "agent"` (the default):** the client calls `authenticate {methodId}` and the agent runs its own login flow.
- **`type: "terminal"`:** only offered if the client advertises `clientCapabilities.auth.terminal`. The client re-runs the agent command with the method's `args`/`env` in an interactive terminal, then reconnects.

### 1.5 Terminals and file system (we will NOT advertise them)

[file-system](https://agentclientprotocol.com/protocol/v1/file-system) and [terminals](https://agentclientprotocol.com/protocol/v1/terminals) are optional client capabilities. The agent MUST NOT call them unless they're advertised. v2 removes both (see §1.10).

### 1.6 Unstable / draft surfaces we can ignore for now

`schema/v1/schema.unstable.json` / [draft schema](https://agentclientprotocol.com/protocol/v1/draft/schema) contains:
- `session/fork`;
- `providers/*` (client-managed LLM routing);
- `document/*` and `nes/*` (next-edit suggestions);
- `mcp/message` (MCP over ACP);
- subagent sessions;
- session notices and session compaction.

Adapters advertise some of them, such as `fork` and `providers`, but our MVP shouldn't depend on any.

### 1.7 Cancellation

There are two levels:
- **Prompt turn:** `session/cancel`. The agent may keep sending updates until it answers the prompt with `cancelled`, and the client must accept them.
- **Any request:** `$/cancel_request`.

### 1.8 Load vs. resume

- **`session/load`** replays the whole conversation as `session/update`s, which is what we need to repopulate the chat UI after a restart.
- **`session/resume`** restores the context without replay. Use it to reconnect a session whose transcript is already on screen, for example after an adapter crash.
- **`session/list`** returns session metadata for a history picker.

### 1.9 Extensibility

Every type has a `_meta` field, and custom capabilities are advertised in `_meta` ([extensibility](https://agentclientprotocol.com/protocol/v1/extensibility)). Both adapters lean on this heavily, for example the JetBrains "AIR" extensions, `_meta.claudeCode.options` and `_meta.terminal_output`.

### 1.10 What v2 (draft) changes, and why it doesn't hurt us

Source: [v2 migration guide](https://agentclientprotocol.com/protocol/v2/migration).

- **Prompt lifecycle:** the `session/prompt` response only acknowledges that the message was inserted. Turn state comes through a new `state_update` (`running` / `idle` / `requires_action`).
- **Upserts:** messages, tool calls and plans are upserted by id, and `messageId` is required.
- **Diffs:** structured file changes plus an optional `git_patch`.
- **Permission requests:** carry a required `title` and an extensible `subject`.
- **Modes become config options:** `session/set_mode`, `modes` and `current_mode_update` are gone.
- **`session/load` merges into `session/resume`** (with `replayFrom`).
- **The client `fs/*` and `terminal/*` APIs are removed entirely.** "Clients that want to expose file access … should do so by providing an MCP server."

Design consequence: keep a **protocol-neutral session view model** (messages by id, tool calls by id, plan, config options, turn state) and write a v1 reducer now. A v2 reducer can be added later behind a flag. `@agentclientprotocol/sdk` 1.7.0 already ships `./experimental/v2`.

---

*§2–4 (the Claude Code, Codex and Gemini adapters) and §6 (their capability table) were removed with those harnesses on Nov 2, 2026; see [tact only](#tact-only).*

## 5. Existing ACP clients for VS Code, and the SDK (Q4)

| Project | License | What it is | Reusable? |
|---|---|---|---|
| [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk) 1.7.0 (1.0 on June 25, 2026) | Apache-2.0 | Official TS SDK: `ClientSideConnection`, `ndJsonStream`, generated types for the v1 schema, plus `./experimental/v2` | **Yes, use it.** The Claude adapter pins 1.7.0 and Codex depends on ^1.5.0 |
| [formulahendry/vscode-acp](https://github.com/formulahendry/vscode-acp) "ACP Client" 0.2.0 | MIT | Webview chat (`ChatWebviewProvider`), session tree, agent registry client | As a reference only. It advertises `fs.readTextFile/writeTextFile: true` (`src/core/ConnectionManager.ts`), the opposite of what we want, and it's on SDK ^0.21 |
| [solutionsunity/acp-patchbay](https://github.com/solutionsunity/acp-patchbay) | Apache-2.0 | VS Code ACP extension | Not reviewed in depth |
| Exo, ACP Pro, Multicoder, Poolside Assistant | Marketplace extensions; licenses not checked | Listed on [ACP clients](https://agentclientprotocol.com/get-started/clients) | No |
| **VS Code 1.135's built-in "Agent Host"** (`src/vs/platform/agentHost`, with Claude / Codex / Copilot harnesses and its own "AHP" protocol) | MIT (part of VS Code) | Microsoft's in-core equivalent of ACP. Claude goes through the Claude Agent SDK, Codex through its App Server | **No.** It's tied to Copilot and GitHub (`claudeAgent.ts` imports `@vscode/copilot-api`, `ICopilotApiService`, GitHub endpoints), downloads SDKs through `product.json` config, and isn't ACP. Whether it runs at all in VSCodium is [unverified] |

---

## 7. Chat UI: native VS Code chat vs. webview (Q6)

### 7.1 What VS Code 1.135 offers (read in `/workspace/phase0/vscode-1135`)

- **Session provider API** (`vscode.proposed.chatSessionsProvider.d.ts`), the API Copilot uses for its Claude, Codex and Copilot CLI "agent sessions":
  - `chat.registerChatSessionItemProvider` / `createChatSessionItemController` for the session list;
  - `chat.registerChatSessionContentProvider(scheme, provider, participant)`, returning a `ChatSession` with `history`, `activeResponseCallback` (stream a turn that's already running, e.g. during `session/load` replay) and `requestHandler`;
  - **option groups** (`ChatSessionProviderOptionGroup`: id, name, items, `when`, icon, commands), exposed through `ChatSessionInputState.groups`. ACP select config options map onto these one-to-one.
  - **`kind: 'permissions'`** puts a group's items **into the chat's built-in permission picker**, which is exactly where the ACP `mode` option belongs.
  - The `contributes.chatSessions` manifest point has `inputPlaceholder`, `welcomeMessage` and attachment capabilities.
- **Response stream parts** (`chatParticipantAdditions`):
  - markdown;
  - `thinkingProgress` (← `agent_thought_chunk`);
  - `ChatToolInvocationPart` / `beginToolInvocation` / `updateToolInvocation` (← `tool_call` / `tool_call_update`), including terminal and todo tool data (← `plan`);
  - `warning`/`info`, references, and usage reporting.
- **Blocking permission prompts:** a provider calls the core tool **`vscode_get_confirmation_with_options`** (title, message, custom `buttons`) through the request's `toolInvocationToken`. That's how Copilot's Claude integration answers `canUseTool` (`copilot-chat/src/extension/chatSessions/claude/common/claudeToolPermissionService.ts`). VS Code puts that tool in `toolIdsThatCannotBeAutoApproved` (`languageModelToolsService.ts` L85–90), **so no auto-approve setting can click it for the user.** That's the security property we want.
- **Why chat is hidden today:** `chat.disableAIFeatures: true`, which mainly disables the Copilot extension, and the `chatIsEnabled` context key, which is set "when a default chat participant is activated" (`chatAgents.ts` L317). VSCodium has no default participant, so the chat view stays hidden.

### 7.2 Options

| | **A. Native chat (recommended)** | **B. Webview panel** | C. Core contribution in the renderer |
|---|---|---|---|
| Rendering | VS Code's own chat: markdown, code blocks, tool cards, thinking, todo list, history, accessibility, themes | Ours to build (markdown, tool cards, diffs, pickers, history), as in vscode-acp | Native, but process spawning has to move into a node-side service |
| "Buttons" | ACP config options → option groups; mode → the permission picker | Custom pickers (simple) | Native |
| Permission prompt | `vscode_get_confirmation_with_options`, can't be auto-approved | Custom buttons | Native |
| Maintenance | **Proposed APIs change monthly**; our monthly upstream merge has to absorb it. Small core patches to show chat for our provider only [to confirm in the spike] | Stable public API, no upstream churn | Highest: we'd own the IPC plumbing as well |
| Fit with "UI first" and "reuse VS Code's chat" | Best | Weaker look and feel | Same as A, more work |

**Recommendation: A**, with B as the fallback behind the same `packages/acp-client`. UI quality is the top priority and Guru asked to reuse the hidden chat. Copilot already drives these exact APIs for Claude Code and Codex, so the shapes fit agent harnesses. The proposed-API risk is what we already accept for the fork, and keeping the protocol logic out of the UI layer caps the cost of switching to B.

**Spike questions** (time-box 2–3 days, packaged Linux build):
1. Can a built-in extension register a session type plus a default participant and show the chat view **with Copilot still disabled** and no "Sign in to Copilot" or setup UI? If not, what's the smallest core patch (e.g. drive `chatIsEnabled` off our provider, hide `chatSetup` contributions)?
2. Do the built-in language-model picker and other Copilot-centric input-bar items stay hidden for our session type?
3. How many option groups does the input bar render through `ChatSessionInputState.groups`? The deprecated `ChatSessionProviderOptions` says "0-2 groups supported", but we need up to 5 (mode → permission picker, model, effort, fast, plan). [unverified]
4. Does an ACP session's chat model ever create a **chat editing session** (its own Keep/Undo) that would duplicate or fight our `agentReview` UI? We push no `textEdit`/`externalEdit` parts, so it shouldn't. Test it.
5. Can Cmd/Ctrl+L insert `@path:L42-58` into the focused chat input? `workbench.action.chat.open {query, isPartialQuery}` exists for the quick chat; otherwise add a small `_agentReview.insertIntoChatInput` command in our core contribution.

---

## 8. Architecture

```
                    ┌──────────────── extension host (Node) ────────────────┐
 harness process ◀─stdio JSON-RPC─▶ packages/acp-client                       │
 (claude-agent-acp,                 ├ AgentProcess  (spawn, env, kill tree,  │
  codex-acp, gemini --acp)          │                restart w/ backoff)     │
        │                           ├ AcpConnection (@agentclientprotocol/sdk ClientSideConnection;
        │ writes files itself       │                v1 now, v2 later)       │
        ▼                           ├ SessionStore  (reducer: session/update → view model)
      disk ◀── watch ── agent-review├ Profiles      (built-in + user JSON)   │
        (unchanged)     extension   └ PermissionBroker (pending requests, audit log)
                        + engine          ▲
                        (Keep/Undo)       │ view model / user actions
                                   extensions/agent-chat (built-in, proposed APIs)
                                     chat session provider + participant, option groups,
                                     tool cards, permission prompts, history, Cmd+L target
                    └────────────────────────────────────────────────────────┘
```

**Where the code lives.**
- **`packages/acp-client` (new, editor-independent TypeScript, like `packages/engine`):**
  - process management, the ACP connection, the session reducer, profile resolution, capability gating and the permission broker;
  - no `vscode` import;
  - unit-tested with vitest against a **fake ACP agent** built on the SDK's `AgentSideConnection`.
- **`extensions/agent-chat` (new built-in extension):**
  - only the VS Code UI adapter: chat session provider, option groups, rendering, commands and settings;
  - its own `enabledApiProposals`, so a proposed-API break in an upstream merge can't break `agent-review`.
  - It talks to `agent-review` through commands (Cmd+L routing, "show pending changes for this turn"). Shipped prebuilt with esbuild, the same way as `agent-review` (decision 6 in docs/phase2.md).
- **Core patches:** only what the spike shows we need to un-hide chat for our provider without Copilot (expected: a few lines in `chatSetup`/context keys) and possibly a chat-input insert command. These live in a new numbered patch, e.g. `94-agent-chat.patch`, kept separate from the review patches.
- **Why not in the renderer as a core contribution?** Spawning processes needs Node. The extension host already gives us that, plus the SDK, for free.

**Initialize as the client:**

```jsonc
{ "protocolVersion": 1,
  "clientInfo": { "name": "editor", "title": "editor", "version": "<app version>" },
  "clientCapabilities": {
    // NO "fs", NO "terminal": the harness reads/writes/executes itself.
    "auth": { "terminal": true },            // we can run login commands in the integrated terminal
    "elicitation": { "form": {} },           // AskUserQuestion etc. as a form (phase C+)
    "_meta": { "terminal_output": true }     // display-only command output (Claude adapter)
    // "session.configOptions.boolean": leave OFF initially → fast mode arrives as an on/off select,
    //  which maps 1:1 to an option group; turn on if we add a native toggle.
  } }
```

**Process management.**
- **One adapter process per (harness, workspace window)**, carrying any number of sessions (ACP multiplexes sessions on one connection).
- **Spawn:** `child_process.spawn` with an explicit argv (no shell) and the profile's `env` merged over the window's resolved shell environment. On macOS, apps launched from Finder need the login-shell PATH; VS Code's ext host normally has it [verify on Guru's Mac].
- **Logging:** stderr → an output channel per harness. An optional protocol trace (`agentChat.trace`) redacts env values and auth payloads.
- **Teardown:** the adapter starts its own children (Claude Code, the Codex app-server). On POSIX, spawn it `detached` and kill its **process group** on window close or "Restart agent"; send `session/close` first if supported.
- **Crash:** mark open sessions disconnected, restart with backoff (1 s, 5 s, 30 s), then `session/resume` (or `session/load` if the UI lost the transcript). Pending permission prompts are cancelled.
- **Adapter installs:** by default, run a **pinned** adapter version installed with a lockfile in the extension's global storage (`npm ci`, so integrity is checked), not `npx -y latest`. Users can point a profile at their own binary. "Check for adapter updates" is a command, not automatic.

**Per-harness profile format.** Built-ins ship with the extension; users override or add profiles in `settings.json` under `agentChat.harnesses`:

```jsonc
{
  "id": "claude",
  "label": "Claude Code",
  "command": "${adapterDir}/claude-agent-acp/node_modules/.bin/claude-agent-acp",
  "args": [],
  "env": { "CLAUDE_CODE_EXECUTABLE": "${which:claude}" },      // share the user's claude install + login
  "adapter": { "npm": "@agentclientprotocol/claude-agent-acp", "version": "0.87.0" },
  "sessionMeta": { "claudeCode": { "options": { "allowDangerouslySkipPermissions": false } } },
  "defaults": { "mode": "default", "effort": "high" },          // applied via set_config_option after session/new, only if offered
  "dangerousValues": { "mode": ["bypassPermissions"] },         // extra confirm, red badge
  "rules": { "format": "claude-settings",
             "files": ["~/.claude/settings.json", "${workspace}/.claude/settings.json", "${workspace}/.claude/settings.local.json"],
             "reload": "resume" },                               // hot reload [unverified] → restart+resume to be safe
  "planOption": { "configId": "mode", "value": "plan" },
  "auth": "terminal"                                            // use advertised terminal methods if not logged in
}
{
  "id": "codex",
  "label": "Codex",
  "command": "${adapterDir}/codex-acp/node_modules/.bin/codex-acp",
  "env": { "CODEX_PATH": "${which:codex}", "INITIAL_AGENT_MODE": "workspace-write" },
  "adapter": { "npm": "@agentclientprotocol/codex-acp", "version": "2.1.1" },
  "dangerousValues": { "mode": ["agent-full-access"] },
  "rules": { "format": "codex-execpolicy", "files": ["~/.codex/rules/default.rules"], "reload": "restart+resume" },
  "planOption": { "configId": "collaboration_mode", "value": "plan" },
  "applyTiming": "next-turn"                                    // UI hint for mode/model/effort/fast
}
```

Profiles only hold **tailoring data**: launch, env, defaults, danger list, rules adapter, labels. All UI comes from what the adapter advertises. A profile can also map an unknown category (e.g. Codex's `collaboration_mode`) to a placement.

**@-references and the review engine.**
- **Cmd/Ctrl+L:** when the active agent target is a chat session, the existing command inserts `@paper/main.tex:L42-58` (same `agentReview.agent.referenceFormat`) into the chat input instead of the terminal. Optionally also the selected text, as with the terminal. A new setting `agentReview.agent.target: "auto" | "terminal" | "chat"` (`auto` = the most recently focused one).
- **Sending:** the prompt is sent as a `text` block with the reference literally in it, which works for every harness. Optionally add a `resource_link` (`file:///abs/path`) per reference; ACP requires every agent to accept that, and the Claude adapter turns it into a link in the text [verified: source].
- **Review truth stays with the watcher (design principle 1).** ACP `diff` content and `locations` are **display only**. An `edit` tool card shows "N pending changes in main.tex" by asking the engine (through an `agent-review` command), and clicking it jumps to the first hunk. Nothing in ACP can accept, reject or bypass review. Undo while the agent is running writes the baseline to disk as today, so the agent sees the reverted text on its next read.
- **Turns, optional and later:** the client knows when a turn starts and ends, so it could tag "changes during this turn" for a "Keep all from this turn" command. That's a UI convenience on top of the engine, not a change to its model.
- **Ignore list:** add `.claude/settings.local.json` (written by Claude "always allow") to the engine's built-in ignores, so permission clicks don't show up as pending agent edits. Codex writes under `~` (outside the workspace).

**Security of permission handling.**
1. **No editor-mediated capabilities.** We advertise no `fs`/`terminal`, so a compromised or confused agent gets nothing from the editor beyond what the user's own harness already has.
2. **Only an explicit click answers a prompt.** `vscode_get_confirmation_with_options` can't be auto-approved. Our broker never selects an option on its own, except answering `cancelled` on cancel or close, as the spec requires.
3. **Show the facts, not just the agent's title.** The prompt displays the tool `kind`, the exact command or paths from `rawInput`/`locations`, and the option's `kind` (once vs. always), with "always" options visibly marked as persistent where the profile knows they write a file (Claude Skill/WebFetch → `.claude/settings.local.json`; Codex prefix rules → global `~/.codex/rules`).
4. **Dangerous modes** (`bypassPermissions`, `agent-full-access`, or anything in `dangerousValues`) need a modal confirmation and get a persistent red badge in the input bar. Claude's bypass mode is removed by default through `allowDangerouslySkipPermissions:false`. Codex full access stays available but confirmed. *(Built differently, Oct 12, 2026: every Claude session is started with `allowDangerouslySkipPermissions: true`, so Bypass permissions is in the mode picker, marked ⚠ and confirmed every time it's chosen; it's never a default and never saved or restored with a chat. See `extensions/agent-chat/README.md`, Bypass permissions.)*
5. **Workspace trust:** don't start agents in Restricted Mode. Don't pass any MCP servers by default.
6. **Secrets:** API keys come only from the environment or VS Code SecretStorage, are passed through `env` (never argv), and are redacted from traces. Logins happen in the harness's own flow.
7. **Audit:** every permission decision (time, session, tool, option) is logged to the output channel.
8. **Supply chain:** pinned adapter versions with lockfiles. Updates are explicit.

---

## 9. Phased build plan

Each phase is a PR, and the full Linux build runs before merge, as today.

**A0. Spike (2–3 days).**
- **Protocol:** a headless script on `@agentclientprotocol/sdk` launches both adapters without fs/terminal, records `initialize`/`session/new`/`configOptions` as fixtures, and runs a prompt that edits a file in a temp git repo. Confirm the edit lands on disk through the harness's own tool and that the engine reports it as pending. Then a permission round trip (Manual / Read-only mode) and `set_config_option` for each option.
- **UI:** a throwaway built-in extension registers a session provider with 5 option groups and calls `vscode_get_confirmation_with_options` in the packaged build, with `chat.disableAIFeatures` on.
- **Exit:**
  - native vs. webview decided;
  - list of required core patches;
  - fixtures checked in;
  - the "harness writes the file itself" assertion passes for Claude and Codex.

**A. `packages/acp-client`.**
- Process manager, connection, v1 reducer (all 11 `session/update` kinds), config options, permission broker, profiles, adapter installer.
- **Tests:**
  - reducer property tests on random update streams;
  - fake-agent tests (cancel with a pending permission → `cancelled`; crash → resume; `config_option_update` replaces state; unknown categories and types are ignored);
  - fixture replays;
  - opt-in contract tests against the real adapters (`RUN_ACP_CONTRACT=1`), including "no `fs/*` or `terminal/*` request is ever received" (the fake transport fails the test on any such call).
- **Exit:** green in CI on Node 22 and 24. The contract test passes locally for Claude and Codex.

**B. Native chat panel MVP.**
- Session type per harness:
  - new chat, send, streaming text and thoughts, tool cards with status and terminal output, plan → todo list, `available_commands_update` → slash commands, `usage_update`, cancel (the Stop button → `session/cancel`).
- Permission prompts. Option groups from `configOptions` (mode → the permission picker; model; effort; fast; plan). Cmd/Ctrl+L → chat input.
- **Tests:** extension integration tests with the fake agent (as `agent-review` does with a fake core); core tests for any patch; packaged-app smoke:
  1. open the chat;
  2. ask the fake agent for an edit;
  3. the hunk appears inline;
  4. Keep;
  5. permission prompt → reject → the agent gets a reject.
- **Exit:** Guru can run Claude Code and Codex from the panel on a LaTeX paper, change mode, model and effort, answer prompts, and review edits inline. No Copilot UI appears.

**C. Permissions UX.**
- Rules editor for `claude-settings` and `codex-execpolicy` (structured list, add/remove, raw-file fallback), with "Apply: restart and resume".
- Dangerous-mode confirmation and badge. Persistent-option labelling. Audit log. Ignore `.claude/settings.local.json`.
- **Tests:** round-trip tests for the rules file parsers and writers (comments preserved); fake-agent restart+resume; contract test showing a new Codex `prefix_rule` takes effect after restart.
- **Exit:** every row of the §6 table is reachable from the panel.

**D. Sessions and robustness.**
- History list (`session/list`), reopen with replay (`session/load` → `activeResponseCallback` / history), close/delete.
- Multiple concurrent sessions. Crash recovery. Auth flows (Claude terminal login in the integrated terminal, Codex `authenticate`). Adapter update command.
- **Exit:** after quitting and reopening the app, a session comes back with its transcript and continues. Killing the adapter mid-turn recovers without losing the transcript.

**E. More harnesses.**
- Gemini CLI profile plus its contract test. tact via a future `tact acp` (separate upstream work). Behind a flag: v2 reducer/negotiation once v2 is stable.
- **Exit:** a third harness passes the same contract and UI tests with only a profile (no UI code).

---

## 10. Open questions for Guru

1. **Default permission mode per harness?**
   - Claude: start in Manual (asks before edits and commands) or Accept edits? Our review already gates edits, so I lean to **Accept edits plus prompts for commands**.
   - Codex: its adapter defaults to **Auto review** (a model decides which actions are unsafe). I lean to **Workspace access** instead.
2. **Should Claude's Bypass and Codex's Full access be offered at all?** The proposal hides Claude Bypass by default and keeps Codex Full access behind a confirmation.
3. **Where should the chat live?** Proposal: the secondary side bar on the right, where the Agent Terminal is docked today, with chat sessions also openable as editor tabs.
4. **Terminal or chat?** Keep both. Cmd+L goes to whichever was used last (`auto`), configurable.
5. **Adapter installation:** we download pinned adapter versions on first use (needs network once). Bundling them into the app would add roughly 100+ MB for the bundled Codex binary [unverified size]. Proposal: download on first use.
6. **Use the user's installed `claude`/`codex` binaries** (shared logins and versions) or the adapters' bundled ones? Proposal: the user's binaries when found on PATH.
7. Is a **webview fallback** acceptable if the spike shows that un-hiding the native chat without Copilot needs invasive core patches?
8. **PLAN.md wording:** §1 ("doesn't … speak an agent protocol") and §3's non-goal ("No … model selection") need to change. The editor would forward model, effort and mode choices to the harness, but still contains no agent and calls no models itself. OK?

---

## 11. Chat polish (Oct 8, 2026): history, several chats, one agent at a time, tact, inline references

Built on branch `chat-polish`. User-facing details are in `extensions/agent-chat/README.md`; this section records the decisions.

### 11.1 tact: what it is and how it's integrated

[tact](https://github.com/clabby/tact) (clabby/tact, "A terminal interface for Nanocodex", Rust) is the team's daily driver over [nanocodex](https://github.com/gakonst/nanocodex). Findings at tact `main` @ `89e9d02` (Oct 8, 2026) and release v0.8.3 (Oct 2):

- **No ACP**, in tact or nanocodex: no `agent-client-protocol` dependency, no `acp` subcommand or flag, no branch or open work for it.
- **No headless session mode.** `tact run <PROMPT>` runs one turn and prints Nanocodex event JSONL (true deltas), but can't resume or continue a session. The interactive UI refuses to start without a terminal on stdin and stdout.
- **A local web API on `main` only** (merged after v0.8.3, so in no release yet; protocol version 9, documented in tact's `docs/web.md`). Every running tact serves HTTP + SSE while its UI is open: commands (`set_draft`, `submit`, `interrupt`, `set_model` before the first turn, `set_effort`, `set_reasoning_mode`, `set_speed`, `open_session {new|resume|fork}`, `close_session`, `compact`…), queries (`models`, `history`, `files`…), one SSE stream that follows the UI's active session (`snapshot`, `entry` upserts, `draft`, `settings`, `context`, `live`…). Auth: the machine token `$TACT_HOME/web/token` as the `tact` cookie, `X-Tact: 1` on POSTs. Discovery: `$TACT_HOME/web/instances/<pid>.json` (pid, port, workspace); port from `[web] port` (7878, scanning 21 ports).
- **Launch / install:** `curl -fsSL https://tact.clab.by/install.sh | sh` (to `~/.local/bin`), `cargo install tact --locked`, release tarballs for Linux and macOS (x86_64, aarch64; checksum and minisign signature), `tact update`. The web API needs a build from `main` today (`cargo install --locked --git https://github.com/clabby/tact tact`; it needs Rust ≥ 1.97).
- **Config:** `$TACT_HOME/config.toml` (default `~/.tact`), or `--config` / `TACT_CONFIG`. `[agent]` `model` (luna / sol / astra, default sol), `thinking` (low…max), `reasoning_mode` (standard / pro), `speed` (standard / fast / ultrafast), `max_subagents`, instructions…; `[web]` `enabled`, `bind`, `port`, `max_live_sessions`. Unknown keys are rejected. Every setting has a flag and a `TACT_*` env var.
- **No approvals, no sandbox:** Nanocodex hard-codes approval "never" and full access. tact edits files (`apply_patch`) and runs commands (`exec_command`) without asking. So ACP permission prompts never happen for tact; edits in the workspace still show up for review with Keep/Undo.
- **Auth:** the Codex ChatGPT login in `$CODEX_HOME/auth.json` (written by `tact auth login`), else `OPENAI_API_KEY` / `openai.api_key`. Without credentials tact exits at start ("no ChatGPT credentials found … run `tact auth login`"); a wrong key fails at the first turn (HTTP 401 from the Responses WebSocket).

**Integration chosen: a thin ACP adapter on our side** (`packages/tact-acp`, bundled into agent-chat as `dist/adapters/tact-acp.js`, run with the editor's Node). It runs tact's UI in a pty nobody sees (`script(1)`: util-linux on Linux, BSD on macOS, both preinstalled), one tact process per ACP session (the SSE stream follows the UI's active session, so one process per chat keeps chats independent), and maps ACP to the web API (table in its README). Why not the alternatives: `tact run` can't continue a conversation; driving the TUI's keystrokes would be fragile; and a native `tact acp` doesn't exist. tact's pickers come through the same profile system: the model (fixed after the first message, as tact enforces), thinking, Pro reasoning, speed, plus a fixed "Approvals: Never asks" row so the missing approval mode is visible. Verified with the real tact (main build): install, launch in the hidden pty, handshake, model catalog and pickers, the not-signed-in state, and a turn failing with tact's own 401 (no credentials on the build machine); everything else is tested against a fake tact speaking the same API.

**Hardening (Oct 12, 2026, branch `tact-harness`).** Re-checked at tact `main` @ `fd47ff6`: still no ACP; `tact run` is still one prompt, one turn (no resume), so the pty bridge stays. Fixed: on macOS every start failed with "tact started, but its web server didn't come up within 30 s", and raw escape sequences (`^D[>7u`, a kitty graphics query) leaked into the log. tact's UI asks its terminal what it supports at start (kitty keyboard, kitty graphics, cell size, device status, DA1) and waits for the answers; in the hidden pty nobody answered (2 s of timeouts per start on Linux; on macOS BSD `script` had /dev/null as stdin, sent the pty an EOF and could forward nothing). The adapter now answers the queries as a VT220-class terminal through `script`'s stdin (on Linux a FIFO it alone writes to; on macOS a real pipe from a bash process substitution, since BSD `script` refuses sockets and macOS FIFOs are sockets), sizes the pty, and strips every escape sequence (CSI with private parameters, OSC, DCS, APC) from what it keeps; the real tact comes up in ~0.1 s instead of ~2 s on Linux. A watcher in the pty's shell ends tact when the adapter is gone (before, a killed adapter left tact running). The fixed "Approvals: Never asks" row is gone (pickers only where tact has them); a 401 at the first request is a sign-in state; a missing tact gets an install card that runs tact's installer (pre-release channel, which has the web API) in a terminal; a Code Mode `exec` cell that turns into `apply_patch` becomes an edit tool call. Verified in the dev build with the real tact (pre-release `fd47ff6`) and a local mock of the Responses API (no account on the build machine): install, sign-in state, a real 401, the pickers from tact's catalog, a streamed turn whose edit is reviewed inline (Keep and Undo), Stop, waiting for another tact chat, reopening from history (`--resume`), and a Cmd/Ctrl+L reference reaching the model. A turn against the real model needs a signed-in tact (`tact auth login`, a ChatGPT account).

**Claude models (Oct 15, 2026, branch `tact-fix-2`).** Picking a Claude model on a new tact chat and sending at once failed with a bare "Internal error" ~4 ms after the prompt (Guru's Mac, pre-release `cb7e799`, a ChatGPT login plus an Anthropic key in `config.toml`). Reproduced with the real tact (`fd47ff6`) and a local mock of the Anthropic Messages API. Cause: tact's `set_model` doesn't change the session's model, it starts a new session (`claude-<uuid>`) and closes the old one; the adapter kept sending to the old id, so `set_draft` got HTTP 404 `unknown_session`, and the ACP SDK turned that plain error into "Internal error" (the detail in `data.details`, which the chat didn't read). Now the adapter waits for the new session and follows it under the chat's id (remembered for `--resume`), a failed start reports tact's reason (it shows it only in its terminal: "Claude API-key authentication requires an Anthropic API key…"), every refused request carries tact's message, status and code, and the chat also reads `data.details`. The Claude models appeared only after a restart because the catalog was read once per tact start (and the warm session for new chats started before the key was added): the adapter now watches `config.toml`, runs `reload_config` and reads the catalog again, and the warm session's option changes reach the pickers. Checked in the dev build with the real tact and the mock: `docs/img/tact-fix-2/` (picker without and with the key, no restart; Opus on a new chat's first message; the refused-key card and its log line; the Opus chat resumed on Claude after an editor restart).

**What upstream would need** for a cleaner integration (either one): a `tact acp` subcommand (stdio ACP, headless, many sessions in one process; it could reuse the web API's protocol types), or a headless `tact serve` running the web API without the UI. A release with the web API (after v0.8.3) is needed either way for users on release builds.

### 11.2 History and reopening

- The extension keeps each chat's transcript (what the chat showed, compacted) and an index, in global storage per workspace folder; the session item controller lists them in core's sessions list, plus the agent's own `session/list`. Core's cache of items doesn't outlive a refresh, so the extension must own this.
- Reopening shows the saved transcript without starting anything (lazy, as before). The first message then resumes the ACP session (`session/resume`; Claude resumes from its own transcript on disk), else loads it (`session/load`, replay discarded), else starts a new one with a note. Sessions the agent lists but we never showed are opened with `session/load`, and the replay becomes the transcript (user message chunks start turns).
- Search: core's list filter only matches titles, so **Search Chats** (a quick pick) searches titles and text. The quick pick, not a webview, keeps the native look.
- Core needed one change: with `chat.disableAIFeatures` on, core resolved no session items at all; now only Copilot's own types are skipped.

### 11.3 Several chats, and one agent at a time

- Several chats run at once (tabs and the side bar, mixed harnesses): ACP multiplexes sessions on one adapter connection; tact gets one process per chat.
- **Edits from two agents to the same file:** agents write files themselves, so the panel can't hold or merge a write. What it controls is when a turn starts. Decision: **serialize turns per workspace**. A turn waits while another chat's turn runs, says for whom ("Waiting for Claude Code ("Fix the intro") to finish…"), offers **Run now**, gives up on Stop, and starts by itself when the other turn ends (first come, first served). Plan and read-only modes don't wait (profile `readOnlyValues`).
- **Why not per file:** before a turn runs, the panel only knows the files the prompt mentions; the agent decides what to edit as it goes (tool-call locations arrive mid-turn). A per-file lock would let two turns start and then collide in a file neither prompt named. The review engine's pending files say what was edited, not by whom.
- **Future ideas:** attribution (record which chat's turn was running when each change arrived, from turn start/end times and tool-call locations, and show it on hunks: "Claude Code, chat 'Fix the intro'"); per-hunk ownership (Keep/Undo all of one agent's changes); per-file waiting once harnesses can declare intent (a plan's file list, or an ACP extension); pausing a running agent at its next tool call when another chat's edit lands in the same file (Claude's `canUseTool` could hold an Edit until the user decides).

### 11.4 Inline Cmd/Ctrl+L references

The reference goes in at the cursor as core's own dynamic-variable pill (the mechanism behind `#file` and `#selection`), so a message can hold several references in place. No extension API inserts at the chat input's cursor (`workbench.action.chat.open` replaces the whole input, and the chat input isn't a `TextEditor` for extensions), so patch 94 adds `_agentChat.insertReference`, modelled on core's own insert-and-decorate code. The request then carries the text with the references in place plus `Location` references with their offsets, sent as `resource_link`s in text order. Core shows prompt references as attachment chips too; ours are excluded, since the pill is already in the text.

<a id="tact-only"></a>
## 12. tact only (Nov 2, 2026)

Claude Code and Codex were removed from the chat (Guru's call): their profiles, the pinned-adapter installer and lockfiles, the contract tests, the Bypass permissions mode (confirmation, status bar item, `allowDangerouslySkipPermissions`, transient values), the permission-mode fallback, the Claude-side hiccup card with Retry, and their sign-in and install cards. tact is the default and only harness (`BUILTIN_PROFILES = [TACT]`). Their saved chats are still listed and open read-only under `agent-tact:/archived/…`; `agentChat.harnesses.claude/codex` settings are ignored. The ACP layer stays generic: permission requests, load/resume recovery, option timing and read-only values are protocol or profile data, not harness branches.

Controls come only from tact's `models` catalog, per model: speed tiers from `effective_speeds`, thinking locked after the first turn where `effort_fixed_after_start`, Pro reasoning only where listed; a model change re-sets effort and speed on tact's new session and the chat says what it reset.

What tact would need to match the removed harnesses, most important first: an approval policy with per-command approval events (Claude's modes, Codex's presets, Yes/No/always), a plan / read-only mode, effort changeable after the first message, per-model effort levels in the catalog (`effective_efforts`), a command list for slash commands, `session/list` from tact's `history` (adapter work), cost and plan usage, and a headless `tact acp` / `tact serve`.

