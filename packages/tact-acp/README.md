# tact-acp

An ACP agent for [tact](https://github.com/clabby/tact) ("A terminal interface for Nanocodex"), so the editor's chat panel can drive it like Claude Code and Codex. tact has no ACP mode and no headless session mode, so this adapter:

- runs tact's terminal UI in a pty nobody sees (`script(1)`), one tact process per ACP session, because the web API only runs while the UI does and its event stream follows the UI's active session;
- finds the instance through tact's registry (`$TACT_HOME/web/instances/<pid>.json`) and machine token (`$TACT_HOME/web/token`);
- bridges ACP to tact's local web API (protocol 9, tact `docs/web.md`, on tact's main branch after v0.8.3).

| ACP | tact web API |
|---|---|
| `session/new` | start tact; its first session is the ACP session (same id) |
| `session/load` / `session/resume` | start tact with `--resume <id>`; load replays the snapshot's entries |
| `session/prompt` | `set_draft`, then `submit` with the draft's revision; entry upserts stream back until the turn's `turn_completed` / `interrupted` / `error` |
| `session/cancel` | `interrupt` |
| `session/set_config_option` | `set_model` (before the first message), `set_effort`, `set_reasoning_mode`, `set_speed`; `settings` events → `config_option_update` |
| message / thought chunks | `assistant` / `reasoning` entries, diffed (tact re-sends an entry whole on every revision) |
| tool calls | `tool` entries (`apply_patch` → edit with the patched paths, `exec_command` → execute), plus the entry detail for output |
| usage, title | `context` events, the session summary's title |
| auth required | tact exits at start with "no ChatGPT credentials …" |

tact never asks for permission (Nanocodex runs with approval "never" and full access), so there are no permission requests; the adapter shows that as a fixed "Approvals: Never asks" picker. It never calls the client's `fs/*` or `terminal/*`: tact edits files and runs commands itself, and the editor's review shows its edits with Keep/Undo.

What upstream would make this simpler: a `tact acp` subcommand (stdio ACP, headless, one process for many sessions), or a headless `tact serve` that runs the web API without the terminal UI.

Env: `TACT_BIN` (the tact binary; default `tact`), plus tact's own (`TACT_HOME`, `TACT_CONFIG`, `CODEX_HOME`, `OPENAI_API_KEY`). Bundled into agent-chat as `dist/adapters/tact-acp.js` and run with the editor's Node.

Tests (`npm test`): the entry mapping, and the agent end to end against a fake tact (`test/fixtures/fake-tact.mjs`, a small server speaking the same API) in a real pty.
