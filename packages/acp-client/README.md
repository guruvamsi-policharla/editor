# @editor/acp-client (spike)

Phase A0 of the ACP connector ([PLAN.md](../../PLAN.md) Phase 4, design in [docs/acp-design.md](../../docs/acp-design.md)). A minimal, editor-independent ACP client on the official [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk): it launches an adapter process and talks ACP v1 over stdio. Phase A grows it into the full client (reducer, permission broker, profiles, installer).

- **No `fs`, no `terminal`.** `CLIENT_CAPABILITIES` is `{}`. The harness edits files and runs commands with its own tools; the review engine sees the edits on disk.
- **Wire record.** Every message is recorded from the raw byte stream (method and id only), so `forbiddenInbound()` reports any `fs/*` or `terminal/*` request regardless of how the SDK routes unknown methods. The client answers them "method not found".
- **Process group.** The adapter runs in its own process group; `dispose()` kills the group (the adapter's harness children included).

## Tests

```sh
npm test                  # unit tests against a fake agent (test/fixtures/fake-agent.mjs); contract tests are skipped
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
