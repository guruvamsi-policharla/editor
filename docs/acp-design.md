# ACP connector: research and design

*Prepared Oct 8, 2026 (PT) for `guruvamsi-policharla/editor`. Status: approved; phase A0 (spike) in progress. PLAN.md §5.4 and Phase 4 summarize it.*

**Decisions (Oct 8, 2026), answering §10:** Claude starts in Accept edits with prompts for commands; Codex starts in Workspace access (not Auto review); Claude's Bypass is hidden and Codex's Full access is behind a confirmation; the chat lives in the secondary side bar (right), with sessions also openable as editor tabs; Cmd/Ctrl+L goes to whichever of chat/terminal was used last (configurable); the user's installed `claude`/`codex` are used when found on PATH, else pinned adapters are downloaded on first use; a webview fallback is acceptable if the native chat needs invasive patches; the PLAN.md wording changes are approved.

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

## 2. Claude adapter: `@agentclientprotocol/claude-agent-acp` 0.87.0 (Q2)

**What it is.** An ACP agent built on the official Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.287), so it runs real Claude Code. The README lists:
- @-mentions and images;
- tool calls with permission requests;
- edit review, TODO lists (plans), subagents and background terminals;
- custom slash commands, client MCP servers, `/mcp`;
- many JetBrains "AIR" `_meta` extensions.

**Launch.** `claude-agent-acp`, the npm `bin`, run through `npx -y @agentclientprotocol/claude-agent-acp@<ver>` or a global install. [verified: source `package.json`]
- **Env knobs:**
  - `CLAUDE_CODE_EXECUTABLE` picks the Claude Code binary (otherwise the SDK's);
  - `CLAUDE_MODEL_CONFIG` (JSON `{modelOverrides, availableModels}`) restricts or maps models ([docs/model-configuration.md](https://github.com/agentclientprotocol/claude-agent-acp/blob/b2dbc8f5a1b84f48cc1512d06f50a9d85d6e757b/docs/model-configuration.md));
  - `MAX_THINKING_TOKENS`;
  - `IS_SANDBOX`, which allows bypass mode under root. [verified: source `acp-agent.ts`, `permissions/modes.ts`]
- **Per-session pass-through:** `session/new` `_meta.claudeCode.options` is forwarded as Claude Agent SDK `Options`, including `allowedTools`, `disallowedTools`, `settings`, `env`, `tools`, `additionalDirectories`, and `allowDangerouslySkipPermissions: false` (which removes bypass mode from the session). `cwd`, `permissionMode`, `canUseTool` and `executable` are controlled by ACP and ignored. [verified: source `acp-agent.ts` `NewSessionMeta`]

**Capabilities advertised in `initialize`:** [verified: source `acp-agent.ts` ~L2675–2740]
- `protocolVersion: 1`, `loadSession: true`;
- `sessionCapabilities`: `additionalDirectories`, `close`, `delete`, `fork`, `list`, `resume`, `subagents`;
- `promptCapabilities`: `image`, `embeddedContext`;
- `mcpCapabilities`: `http`, `sse`;
- `auth.logout`, plus `providers`, `_meta.claudeCode.promptQueueing` and `_meta.steering`;
- auth methods: terminal login methods (`--cli auth login --claudeai` / `--console`), **only if** the client advertises `auth.terminal`, plus gateway auth if negotiated.

An existing `~/.claude` login is used as-is [unverified, but it's the Claude Code SDK's normal behavior].

**Settings sources.** The adapter starts Claude Code with `settingSources: ["user","project","local"]`, so `~/.claude/settings.json`, `.claude/settings.json` and `.claude/settings.local.json` apply, permission rules and `permissions.defaultMode` included. [verified: source `acp-agent.ts` ~L9516, ~L9389]

**Config options** (`buildConfigOptions`, in this order). All are live through `session/set_config_option`: [verified: source]

| id | category | values | applied |
|---|---|---|---|
| `mode` | `mode` | `default` (shown as "Manual"), `acceptEdits`, `plan`, `auto` ("Claude handles permission decisions"; falls back to acceptEdits if the model doesn't support it), and `bypassPermissions` (only when allowed: not root unless `IS_SANDBOX`, not disabled by `permissions.disableBypassPermissionsMode`, and not `_meta…allowDangerouslySkipPermissions:false`) | Live (SDK `setPermissionMode`). The initial value is the explicit mode, else the mode of the resumed transcript, else settings `permissions.defaultMode` (`session-mode.ts`) |
| `model` | `model` | From the SDK's model list (restricted by `CLAUDE_MODEL_CONFIG`) | Live (`query.setModel`) |
| `effort` | `thought_level` | `default` plus the model's `supportedEffortLevels`. **Omitted if the model doesn't support effort** (`session-effort.ts`) | Live (`applyFlagSettings`) |
| `fast` | `model_config` | Boolean if the client opted into boolean options, else a select with `on`/`off`. **Only when the current model supports Fast mode.** The description explains why it's unavailable when off | Live |
| `agent` | (none) | Custom agent personas. Only when the user has configured some | Live |

The legacy `session/set_mode` is still served. [verified: source L7661, L11600]

**Permissions.** Claude Code's `canUseTool` → `session/request_permission`. Options are built per tool (Bash, Read, Edit, Write, WebFetch, Skill, ExitPlanMode, …) and labelled like the Claude Code TUI. [verified: source `permissions/options*.ts`, `effects.ts`]
- **`allow_always`** applies the permission updates Claude Code itself suggests. For Skill and WebFetch, the adapter writes an allow rule to **`localSettings`, i.e. the project's `.claude/settings.local.json`**. File-edit "always" suggestions are **session-scoped**.
- **`ExitPlanMode`** prompts offer "exit to bypass / auto / acceptEdits / default", optionally with a fresh context. Choosing one switches the mode. "Reject" keeps planning.
- **`AskUserQuestion`** is disabled unless the client supports form elicitation; with support it becomes an `elicitation/create` form.

**Who writes files?** **The harness does, with Claude Code's own Edit/Write/Bash tools** (the default `tools` preset is `claude_code`). The adapter still has `readTextFile`/`writeTextFile` pass-through methods, but **nothing in `src/` calls them**: a grep at `b2dbc8f` finds only their definitions. [verified: source; **confirm with a contract test**, Phase A exit criterion] Tool calls still report edits as ACP `diff` content, which is fine to show as information.

**Terminal output.** Without the `terminal` capability, Bash runs in Claude Code's own process. The client can opt into display-only output through `clientCapabilities._meta.terminal_output: true` (or `terminal_output_delta: true`), and tool calls then carry `_meta.terminal_info/terminal_output/terminal_exit`. [verified: source `tool-calls/client-capabilities.ts`]

---

## 3. Codex adapter: `@agentclientprotocol/codex-acp` 2.1.1 (Q3)

**What it is.** A stdio ACP server that "starts the Codex App Server, translates ACP requests into Codex operations, and maps Codex events back" ([README](https://github.com/agentclientprotocol/codex-acp/blob/4583cb3978276c2b7ea87fcfa5ae66e1e9817f13/README.md)). The old Rust `zed-industries/codex-acp` is superseded.

**Launch.** `npx -y @agentclientprotocol/codex-acp` or `codex-acp` from a global install. It bundles a compatible `@openai/codex`.
- **Env knobs:**
  - `CODEX_PATH` (use your own `codex` binary);
  - `CODEX_CONFIG` (a JSON object merged into the Codex session config);
  - `INITIAL_AGENT_MODE` (`read-only` | `workspace-write` | `agent` | `agent-full-access`);
  - `MODEL_PROVIDER`;
  - `CODEX_API_KEY` / `OPENAI_API_KEY`;
  - `NO_BROWSER`;
  - `DEFAULT_AUTH_REQUEST`;
  - `APP_SERVER_LOGS`.
  
  [verified: README + `src/index.ts`, `src/AgentMode.ts`]

**Capabilities.** `loadSession: true` and `sessionCapabilities` `resume`, `list`, `close`, `fork`. [verified: source `CodexAcpServer.ts` ~L428–466]
- **Auth methods:** API key, ChatGPT login (hidden when `NO_BROWSER` is set), ChatGPT device code (only if the client supports URL elicitation), and gateway (opt-in). [verified: source `CodexAuthMethod.ts`]
- Whether an existing `~/.codex/auth.json` login is reused without calling `authenticate` is [unverified].

**Config options** (`createSessionConfigOptions`): [verified: source]

| id | category | values | applied |
|---|---|---|---|
| `mode` | `mode` | `read-only` ("Read-only": approval on-request, read-only sandbox, no network), `workspace-write` ("Workspace access"), `agent` ("Auto review": on-request with **`approvalsReviewer: auto_review`**, which only asks for actions it detects as potentially unsafe; **default**), `agent-full-access` ("Full access": approval never, `dangerFullAccess`) | Approval policy and sandbox are sent **with each turn** (`CodexAcpClient.sendPrompt`), so a change applies **from the next turn**. The initial value comes only from `INITIAL_AGENT_MODE`, else `agent` |
| `collaboration_mode` | `collaboration_mode` (non-standard, and not `_`-prefixed) | `default`, `plan` | Live (`threadSettingsUpdate`) |
| `model` | `model` | From the App Server's model list | Next turn |
| `reasoning_effort` | `thought_level` | The model's supported efforts. Omitted if there are none | Next turn |
| `fast-mode` | `model_config` | Boolean or `on`/`off`. **Only if the model has a `fast` speed tier** ("1.5x speed, increased usage") | Next turn (`serviceTier: "fast"`) |

**Permissions.** Codex approval requests → `session/request_permission`. [verified: source `permissions/options.ts`, `option-ids.ts`]
- **Command options:** "Yes, proceed" (`allow_once`), "Yes, and don't ask again for this command in this session" (`allow_always`, session-scoped), "Yes, and don't ask again for commands that start with `…`" (`allow_always`; an exec-policy amendment), network-host allow/block amendments, "No, continue without running it", "No, and tell Codex what to do differently".
- **File changes:** "Yes", "Yes, and don't ask again for these files" (session-scoped), "No…".
- **Exec-policy amendments are persistent and global.** Codex writes `prefix_rule(..., decision="allow")` to `~/.codex/rules/default.rules`. Trusted projects can also have `<repo>/.codex/rules/default.rules`, and Codex scans `rules/` **at startup** ([Codex rules docs](https://learn.chatgpt.com/docs/agent-configuration/rules), [openai/codex#27157](https://github.com/openai/codex/issues/27157)). [verified: docs]

**Who writes files?** **The harness does.** Codex applies its own patches in the App Server, and there are **no** `fs/*` or `terminal/*` client calls anywhere in `src/` (grep). [verified: source; confirm with a contract test]

---

## 4. Gemini CLI (later)

`gemini --acp` starts ACP mode; `--experimental-acp` is deprecated ([docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md), [PR #21171](https://github.com/google-gemini/gemini-cli/pull/21171)). In ACP mode it excludes its `ask_user` tool. Its config options, permission options, and whether it falls back to its own fs tools without the client `fs` capability are all **[unverified]**: check them in Phase E with the same contract test.

---

## 5. Existing ACP clients for VS Code, and the SDK (Q4)

| Project | License | What it is | Reusable? |
|---|---|---|---|
| [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk) 1.7.0 (1.0 on June 25, 2026) | Apache-2.0 | Official TS SDK: `ClientSideConnection`, `ndJsonStream`, generated types for the v1 schema, plus `./experimental/v2` | **Yes, use it.** The Claude adapter pins 1.7.0 and Codex depends on ^1.5.0 |
| [formulahendry/vscode-acp](https://github.com/formulahendry/vscode-acp) "ACP Client" 0.2.0 | MIT | Webview chat (`ChatWebviewProvider`), session tree, agent registry client | As a reference only. It advertises `fs.readTextFile/writeTextFile: true` (`src/core/ConnectionManager.ts`), the opposite of what we want, and it's on SDK ^0.21 |
| [solutionsunity/acp-patchbay](https://github.com/solutionsunity/acp-patchbay) | Apache-2.0 | VS Code ACP extension | Not reviewed in depth |
| Exo, ACP Pro, Multicoder, Poolside Assistant | Marketplace extensions; licenses not checked | Listed on [ACP clients](https://agentclientprotocol.com/get-started/clients) | No |
| **VS Code 1.135's built-in "Agent Host"** (`src/vs/platform/agentHost`, with Claude / Codex / Copilot harnesses and its own "AHP" protocol) | MIT (part of VS Code) | Microsoft's in-core equivalent of ACP. Claude goes through the Claude Agent SDK, Codex through its App Server | **No.** It's tied to Copilot and GitHub (`claudeAgent.ts` imports `@vscode/copilot-api`, `ICopilotApiService`, GitHub endpoints), downloads SDKs through `product.json` config, and isn't ACP. Whether it runs at all in VSCodium is [unverified] |

---

## 6. Capability table: "all the buttons" × harness (Q5)

**Live** = changeable mid-session over ACP. **Next turn** = accepted live, takes effect on the next turn. **Launch** = only through CLI flags, env or config files when the adapter or session starts. **File** = the harness's own config file, which our editor can edit.

| Button | Claude (`claude-agent-acp` 0.87.0) | Codex (`codex-acp` 2.1.1) | Gemini CLI |
|---|---|---|---|
| **Answer a permission prompt** (once / always / reject) | **Live**, `session/request_permission`. "Always" = Claude's suggested rule update (Skill/WebFetch → project `.claude/settings.local.json`; file edits → session) | **Live**. Once, for session, persistent `prefix_rule` (global `~/.codex/rules/default.rules`), network amendments, decline, cancel | Live via ACP [unverified details] |
| **Permission mode** | **Live**, option `mode`: Manual / Accept edits / Plan / Auto / Bypass (Bypass can be hidden at launch with `_meta.claudeCode.options.allowDangerouslySkipPermissions:false` or the settings key `permissions.disableBypassPermissionsMode`). Initial: **File** `permissions.defaultMode` | **Next turn**, option `mode`: Read-only / Workspace / Auto review / Full access (fixed presets). Initial: **Launch** `INITIAL_AGENT_MODE` | [unverified] |
| **Standing allow/deny rules** | **Not over ACP.** **File**: `permissions.allow/deny/ask` in `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`; or **Launch** via `_meta.claudeCode.options.allowedTools/disallowedTools/settings` on `session/new`. Whether settings edits hot-reload mid-session is [unverified]; restart/resume to be safe | **Not over ACP.** **File**: `~/.codex/rules/*.rules` (and trusted `<repo>/.codex/rules`), read **at startup** → restart the adapter, then `session/resume`. Other config through **Launch** `CODEX_CONFIG` | [unverified] |
| **Model** | **Live**, option `model`. List restricted with **Launch** `CLAUDE_MODEL_CONFIG` | **Next turn**, option `model` | [unverified] |
| **Reasoning effort** | **Live**, option `effort` (`thought_level`), only for models with effort levels | **Next turn**, option `reasoning_effort` (`thought_level`) | [unverified] |
| **Fast mode** | **Live**, option `fast` (`model_config`), only if the model and account support it | **Next turn**, option `fast-mode` (`model_config`), only for models with a fast tier | [unverified] |
| **Plan mode** | **Live**: `mode = plan`. Leaving it goes through the ExitPlanMode prompt (choose the next mode) | **Live**: option `collaboration_mode = plan` (separate from the permission `mode`) | [unverified] |
| **Cancel** | **Live**, `session/cancel` (baseline) | **Live**, `session/cancel` | Live (baseline) |
| **Resume a previous session** | **Live**: `session/list`, `session/load` (replay), `session/resume`, `session/close`, `session/delete` | **Live**: `session/list`, `session/load`, `session/resume`, `session/close` | [unverified] (`loadSession` capability) |
| Steer a running turn | `_meta.steering` / `promptQueueing` extension (not standard) | Steering queue (not standard) | n/a |

What this means for Guru's requirements:
1. **Permission prompts, mode, model, effort, fast mode, plan, cancel and resume** all go through ACP for both harnesses. The panel renders them generically from `configOptions`, so there's no per-harness UI code.
2. **Standing rules are the one thing ACP can't do.** Workaround: a per-harness **rules editor** in the panel's permission menu. It opens or edits the harness's own files with a small structured UI (allow/deny/ask lists for Claude, `prefix_rule` lines for Codex), then offers "Apply: restart agent and resume this chat" (`session/resume` keeps the conversation). The profile declares the file format and paths.
3. **Codex mode granularity.** Codex modes are 4 presets that combine approval policy and sandbox. Arbitrary combinations (such as "untrusted approvals + workspace-write") aren't reachable over ACP. They might be reachable through `CODEX_CONFIG` at launch, but the adapter sends the preset's policy with every turn, so that would probably be overridden [unverified]. Accept the presets.
4. **Changes during a Codex turn apply from the next turn.** The UI should say so ("applies to the next message").
5. **Option availability depends on the model.** Effort and fast appear and disappear with the model. The panel must re-render from every `config_option_update` and `set_config_option` response.

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
  "clientInfo": { "name": "editor", "title": "Editor", "version": "<app version>" },
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
4. **Dangerous modes** (`bypassPermissions`, `agent-full-access`, or anything in `dangerousValues`) need a modal confirmation and get a persistent red badge in the input bar. Claude's bypass mode is removed by default through `allowDangerouslySkipPermissions:false`. Codex full access stays available but confirmed.
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
