# tact-acp

An ACP agent for [tact](https://github.com/clabby/tact) ("A terminal interface for Nanocodex"), so the editor's chat panel can drive it like Claude Code and Codex. tact has no ACP mode and no headless session mode (checked again at tact `main` @ `fd47ff6`, Oct 12, 2026: `tact run <PROMPT>` is headless but runs one prompt as one turn and prints JSONL, with no way to continue or resume a session, and no approvals), so this adapter:

- runs tact's terminal UI in a pty nobody sees (`script(1)`), one tact process per ACP session, because the web API only runs while the UI does and its event stream follows the UI's active session;
- is that pty's terminal: tact asks its terminal what it supports when it starts (kitty keyboard `CSI ? u`, kitty graphics `APC G … a=q`, cell size `CSI 16t`, device status `CSI 5n`, then DA1 `CSI c`) and waits for the answers. Unanswered, that cost 2 s per start on Linux and hung past the 30 s start timeout on macOS ("tact started, but its web server didn't come up within 30 s"). The adapter answers like a plain VT220-class terminal (DA1 without sixel, so tact uses no kitty protocol), through `script`'s stdin, a FIFO only the adapter writes to (`src/terminal.ts`, `src/process.ts`). The pty is 160×48 (`stty`), and tact's output, kept for error messages, has every escape sequence removed;
- ends tact when the adapter goes: `script` reads EOF on the FIFO, and a watcher in the pty's shell ends tact once the adapter's pid is gone (macOS `script` ignores EOF), so a killed adapter never leaves a tact behind;
- finds the instance through tact's registry (`$TACT_HOME/web/instances/<pid>.json`) and machine token (`$TACT_HOME/web/token`);
- bridges ACP to tact's local web API (protocol 9, tact `docs/web.md`, on tact's main branch after v0.8.3).

| ACP | tact web API |
|---|---|
| `session/new` | start tact; its first session is the ACP session (same id) |
| `session/load` / `session/resume` | start tact with `--resume <id>`; load replays the snapshot's entries |
| `session/prompt` | `set_draft`, then `submit` with the draft's revision; entry upserts stream back until the turn's `turn_completed` / `interrupted` / `error` |
| `session/cancel` | `interrupt`; a Stop that comes before tact started the turn (`nothing_running`) interrupts it as soon as it starts, or the message isn't sent at all |
| `session/set_config_option` | `set_model` (before the first message), `set_effort`, `set_reasoning_mode`, `set_speed`; `settings` events → `config_option_update` |
| message / thought chunks | `assistant` / `reasoning` entries, diffed (tact re-sends an entry whole on every revision) |
| tool calls | `tool` entries (`apply_patch` → edit, titled with tact's `+/−` stats, its files as absolute locations; `exec_command` → execute, with its output tail), plus the entry detail for output. A Code Mode `exec` cell that becomes the tool it ran (a later revision of the same entry) updates the call's kind and name |
| usage, title | `context` events, the session summary's title |
| auth required | tact exits at start with "no ChatGPT credentials …"; or the first request is refused (HTTP 401, an expired login): the chat then offers Sign in (`tact auth login`) |

tact never asks for permission (Nanocodex runs with approval "never" and full access), so there are no permission requests and no approvals picker: the pickers are only the ones tact has (model before the first message, thinking, Pro reasoning where the model has it, speed). The adapter never calls the client's `fs/*` or `terminal/*`, and the editor advertises neither: tact edits files and runs commands itself, and the editor's review shows its edits with Keep/Undo.

What upstream would make this simpler: a `tact acp` subcommand (stdio ACP, headless, one process for many sessions), or a headless `tact serve` that runs the web API without the terminal UI.

Install: the web API is on tact's main branch after v0.8.3, so a pre-release build: `curl -fsSL https://tact.clab.by/install.sh | TACT_CHANNEL=pre-release sh` (or `tact update <commit>`), then `tact auth login`. The chat offers both when tact is missing or signed out.

Env: `TACT_BIN` (the tact binary; default `tact`), plus tact's own (`TACT_HOME`, `TACT_CONFIG`, `CODEX_HOME`, `OPENAI_API_KEY`, `TACT_API_BASE_URL`, `TACT_TRANSPORT`; set them for the chat with `agentChat.harnesses.tact.env`). Bundled into agent-chat as `dist/adapters/tact-acp.js` and run with the editor's Node.

Tests (`npm test`): the entry mapping, the terminal (escape sequences stripped, queries answered across chunks), and the agent end to end against a fake tact (`test/fixtures/fake-tact.mjs`, a small server speaking the same API) in a real pty. The fake asks the start-up queries and, like tact on macOS, waits for the DA1 answer with no timeout, so an adapter that doesn't answer fails the start test (CI runs it on Linux and macOS). `packages/acp-client/test/tact.test.ts` runs the bundled adapter over ACP stdio, as the editor does.

Checking with the real tact but no account: point it at a local mock of the Responses API (`agentChat.harnesses.tact.env`: `OPENAI_API_KEY` any value, `TACT_API_BASE_URL=http://127.0.0.1:<port>/v1`, `TACT_TRANSPORT=https`). tact runs in Code Mode: the model gets one custom tool, `exec` (JavaScript calling `tools.apply_patch(…)`, `tools.exec_command(…)`), and `wait`.
