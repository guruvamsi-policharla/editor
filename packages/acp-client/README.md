# @editor/acp-client

The editor-independent ACP client ([PLAN.md](../../PLAN.md) Phase 4, design in [docs/acp-design.md](../../docs/acp-design.md)), on the official [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk), protocol v1. No `vscode` import: `extensions/agent-chat` is the only UI on top of it.

| Module | What |
|---|---|
| `connection.ts` | `AgentConnection`: one adapter process (own process group) and its ACP connection. **No `fs`, no `terminal`**: `CLIENT_CAPABILITIES` is `{}`, so the harness edits files and runs commands with its own tools and the review engine sees the edits on disk. Every message is recorded from the raw byte stream, so `forbiddenInbound()` reports any `fs/*` or `terminal/*` request however the SDK routes it (the client answers "method not found"). A closed stream or exit rejects pending requests |
| `supervisor.ts` | `AgentSupervisor`: starts the adapter on first use (not at load), detects a crash, restarts on the next use with backoff (1 s, 5 s, 30 s), gives up after 5 crashes in a row until `restart()` |
| `harness.ts` | `HarnessClient` / `AcpSession`: `session/new` with the profile's `_meta` and defaults, prompt (text plus `resource_link`s), config options, Stop (`session/cancel`, open prompts answered `cancelled`), recovery after a crash (`session/resume`, else `session/load`, else a new session). History: `list()` (`session/list`, all pages), `load()` (`session/load`, the conversation replayed into the view, flagged `replaying`), `restore()` (a session from an earlier run; nothing starts until its first prompt resumes or loads it). `isAuthRequired()` recognizes "not logged in" |
| `reducer.ts` | `SessionView`: the protocol-neutral view model (messages, thoughts, tool calls merged by id, plan, commands, mode, config options, title, usage). Handles all 11 v1 `session/update` kinds; unknown kinds are counted and ignored. `apply` says what changed, for append-only UIs |
| `permissions.ts` | `PermissionBroker`: routes `session/request_permission` to the UI attached to the session; never selects an option itself (no UI, dismiss or Stop → `cancelled`); only offered option ids are accepted; every decision is audited. `describePermission` gives the exact command/paths and orders the buttons once / no / always, marking "always" answers that write a standing rule |
| `profiles.ts` | Harness profiles (`CLAUDE`, `CODEX`, `TACT`): pinned npm adapter (or one bundled with the editor: tact's, `packages/tact-acp`), the harness CLI to share from PATH, env, launch-time options, `session/new` meta, defaults, hidden and dangerous values, whether option changes apply live / next turn / at launch, plan option, read-only values (plan/read-only modes, which don't wait for other chats), login command. `launchFor` builds the argv (no shell) |
| `config.ts` | Config options → UI controls: `model` → the model picker, other selects → pickers in the agent's order, hidden values dropped, dangerous ones flagged, timing attached |
| `installer.ts` | `AdapterInstaller`: pinned adapters installed on first use with `npm ci` against the lockfiles in `adapters/<id>/` (integrity-checked, `--ignore-scripts`), staged and renamed into place. `--omit=optional` (no bundled harness binary, 66 MB instead of 299 MB for Claude) when the user's CLI is on PATH |

Approved defaults (docs/acp-design.md, Decisions): Claude starts in Accept edits (commands still prompt) with Bypass removed from the session (`allowDangerouslySkipPermissions: false`) and hidden; Codex starts in Workspace access (`INITIAL_AGENT_MODE`), with Full access flagged dangerous.

## Tests

```sh
npm test                  # unit tests: a scriptable fake agent (test/fixtures/fake-agent.mjs; FAKE_STORE keeps its sessions for list/load), fixture replays, reducer property tests; contract tests skipped
RUN_ACP_CONTRACT=1 npm test   # also the contract tests against the real adapters
```

Contract tests (`test/contract/`) use real model usage (tiny prompts, haiku). Knobs:

| Env | Meaning |
|---|---|
| `RUN_ACP_CONTRACT=1` | run them |
| `ACP_CLAUDE_ADAPTER`, `ACP_CODEX_ADAPTER` | path to an installed adapter bin; default `npx --yes <pinned version>` |
| `ACP_CODEX_LOGGED_IN=1` | Codex is logged in: check session config options instead of the auth error |
| `ACP_CONTRACT_TRACE=<file>` | write the Claude run's wire methods, updates and permission requests as JSON |

The user's `claude` / `codex` on PATH is passed to the adapter (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`). `test/fixtures/*-<version>.json` are recorded `initialize` / `session/new` results.

`test/fixtures/claude-0.87.0-turns.json` is the `session/update` stream of a recorded contract run (paths scrubbed), replayed by `reducer.test.ts`.
