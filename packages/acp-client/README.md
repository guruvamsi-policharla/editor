# @editor/acp-client

The editor-independent ACP client ([architecture](../../docs/architecture.md#the-chat)), on the official [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk), protocol v1. No `vscode` import: `extensions/agent-chat` is the only UI on top of it.

| Module | What |
|---|---|
| `connection.ts` | `AgentConnection`: one adapter process (own process group) and its ACP connection. **No `fs`, no `terminal`**: `CLIENT_CAPABILITIES` is `{}`, so the harness edits files and runs commands with its own tools and the review engine sees the edits on disk. Every message is recorded from the raw byte stream, so `forbiddenInbound()` reports any `fs/*` or `terminal/*` request however the SDK routes it (the client answers "method not found"). A closed stream or exit rejects pending requests |
| `supervisor.ts` | `AgentSupervisor`: starts the adapter on first use (not at load), detects a crash, restarts on the next use with backoff (1 s, 5 s, 30 s), gives up after 5 crashes in a row until `restart()` |
| `harness.ts` | `HarnessClient` / `AcpSession`: `session/new` with the profile's `_meta` and defaults, prompt (text plus `resource_link`s), config options, Stop (`session/cancel`, open prompts answered `cancelled`), recovery after a crash (`session/resume`, else `session/load`, else a new session; the chat's option values are set again). History: `list()` (`session/list`, all pages), `load()` (`session/load`, the conversation replayed into the view, flagged `replaying`), `restore()` (a session from an earlier run; nothing starts until its first prompt resumes or loads it). `isAuthRequired()` recognizes "not logged in" |
| `reducer.ts` | `SessionView`: the protocol-neutral view model (messages, thoughts, tool calls merged by id, plan, commands, mode, config options, title, usage). Handles all 11 v1 `session/update` kinds; unknown kinds are counted and ignored. `apply` says what changed, for append-only UIs |
| `permissions.ts` | `PermissionBroker`: routes `session/request_permission` to the UI attached to the session; never selects an option itself (no UI, dismiss or Stop → `cancelled`); only offered option ids are accepted; every decision is audited. `describePermission` gives the exact command/paths and orders the buttons once / no / always. tact never asks, but this is the protocol's, not a harness's |
| `profiles.ts` | The harness profile (`TACT`, the only one and the default): its adapter, which ships with the editor (`packages/tact-acp`), the harness CLI to find on PATH, env, `session/new` meta, defaults, whether option changes apply live / next turn / at launch, read-only values, login and install commands. `launchFor` builds the argv (no shell) |
| `config.ts` | Config options → UI controls: `model` → the model picker, other selects → pickers in the agent's order with exactly the choices the agent offers now (one choice: `locked`), timing attached. `configResets` says which values the agent changed or dropped after another option was set (a model change resetting the speed), so the chat can say so |

## Tests

```sh
npm test    # a scriptable fake agent (test/fixtures/fake-agent.mjs; FAKE_STORE keeps its sessions for list/load), a recorded ACP v1 update stream (test/fixtures/acp-v1-turns.json), reducer property tests, and the tact adapter over stdio (tact.test.ts)
```

The adapter's own tests, including the opt-in ones against the real tact, are in [`packages/tact-acp`](../tact-acp).
