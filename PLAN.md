# Plan: Agent-Agnostic Inline Review (VSCodium Fork)

*Working name: TBD*

## 1. Summary

Build Cursor-style inline diff review (red/green hunks with Accept/Reject, plus Cmd+L to send a selection to the agent) that works with **any** coding agent: tact/nanocodex, Claude Code, Codex, or anything else that edits files.

The editor contains **no AI**. It contains no agent and calls no models. It can launch your agent in a terminal or, for agents that speak ACP, talk to it from a chat panel. It watches the workspace, treats any file change it didn't make itself as pending, and shows it inline for review against an accepted baseline.

It ships as a **VSCodium-based fork** with a **built-in extension** that holds all the logic. The fork adds true inline rendering (deleted lines as real rows), which the public extension API can't provide. There is no standalone release for stock VS Code or Cursor.

## 2. Motivation

- Cursor's diff review and point-at-text workflow are excellent for writing papers, but its chat is locked to Cursor's own agent.
- Our team's daily drivers are terminal harnesses ([tact](https://github.com/clabby/tact) over [nanocodex](https://github.com/gakonst/nanocodex)) with shared memory we want to keep using.
- **Zed** supports external agents over ACP, but their edits are final, with no Accept/Reject. Zed maintainers say the old mechanism relied on ACP filesystem APIs that were inaccurate and rarely adopted; those APIs are removed in ACP v2, and there's no timeline for a replacement. See [zed#56048](https://github.com/zed-industries/zed/discussions/56048).
- **VS Code** offers inline Keep/Undo only for edits made through its own agent tooling. Edits by a CLI agent in the terminal are invisible to the review UI.
- **Existing extensions** ([Inline Diff](https://marketplace.visualstudio.com/items?itemName=freeslur.inlinediff), [CC Diff Review](https://marketplace.visualstudio.com/items?itemName=LucianStoian.cc-diff-review), AgentCheck) prove the accepted-baseline model but are limited by the extension API: removed lines can't be rendered as real rows in the editor, because that requires core-only view zones. That's why Cursor and Void are forks, and why this project is one: for prose, seeing the deleted text inline is essential.

## 3. Goals and non-goals

**Goals**

- **Top priority:** Cursor-quality inline review UI, with clear before/after rendering and deleted text shown as real rows. This is a hard requirement.
- Inline, per-hunk Accept/Reject for edits from any agent or tool, with no agent integration required.
- Cmd+L (Ctrl+L on Windows/Linux): send the current selection's path and line range to the agent, optionally with the selected text.
- First-class prose/LaTeX support: word-level highlighting within line-sized hunks, and no noise from build artifacts.
- Organized, isolated fork patches, so monthly upstream merges stay manageable. Maintainability matters, but it comes second to UI quality.

**Non-goals**

- No built-in agent, prompting, or autocomplete. The chat panel only forwards the harness's own options (model, effort, mode) to it. (This scope is what sank Void: it tried to compete on agent quality instead of focusing on the editor.)
- No dependency on ACP or any other agent protocol for review. ACP is optional and is only for a nicer chat panel.

## 4. Design principles

1. **Agent-oblivious.** Edits are detected from the filesystem, never from agent messages.
2. **UI first, extension-first code.** Review logic lives in the engine and the built-in extension. The core is patched wherever that improves the review UI, starting with inline rendering, which the extension API can't reach.
3. **Organized patches, reusable engine.** Keep core patches organized and isolated so upstream merges stay easy, and keep the engine editor-independent so it stays reusable. There is no stock VS Code fallback: the team commits to maintaining the fork.
4. **Never touch the user's git state.** The baseline lives in a private store, not in the user's index, HEAD, stash, or branches.
5. **Never silently lose text.** Conflicts between agent edits and unsaved user edits are always surfaced.

## 5. Architecture

### 5.1 Review engine (standalone TypeScript library, no VS Code dependency)

The core. Keep it editor-independent so it can be reused (Zed, Neovim, etc.).

- **Accepted baseline store.** One shadow git repository per workspace root (separate `GIT_DIR`, stored in extension storage or a git-ignored workspace folder) holding the last-accepted content of every non-ignored file. Content-addressed, so cheap even in large repos.
- **Model.** `pending = disk − baseline`. Accepting a hunk folds it into the baseline; rejecting a hunk writes the baseline content for that hunk back to disk.
- **Change attribution.** The host editor reports its own writes (user saves, accepted/rejected hunks). Only the user's own keystrokes count as user edits. On a user save, the lines the user edited fold into the baseline; untouched agent lines stay pending, so a partly edited hunk shrinks to its untouched lines. Editor-triggered formatter changes inside a pending agent hunk stay pending as part of that hunk; formatter changes elsewhere fold into the baseline. Any disk change that doesn't match a self-write is external and becomes pending. No notion of agent turns is needed.
- **Hunk computation.**
  - Line-level diff (Myers or histogram); hunks are line-sized.
  - Word-level intra-hunk highlighting.
  - For prose, break long lines with a formatter (e.g. one sentence per line) so hunks stay small.
- **Operations.** Accept/reject hunk, accept/reject file, accept/reject all.
- **File lifecycle.** Created, deleted, and renamed files are reviewable units (accept = keep the change; reject = delete the created file or restore the deleted/renamed one). A delete followed by a create with identical content is treated as a rename; otherwise they're shown as a separate delete and create. Large and binary files get file-level accept/reject only.
- **Ignore rules.** Respect `.gitignore`, plus built-in defaults (`node_modules`, build dirs, LaTeX artifacts: `.aux`, `.log`, `.out`, `.toc`, `.bbl`, `.blg`, `.fls`, `.fdb_latexmk`, `.synctex.gz`, and the build-output PDF next to a `.tex` file, e.g. `main.pdf` for `main.tex`), plus a user config list. Other PDFs, such as figures, stay reviewable.
- **Git operations auto-accept.** Detect git operations and move the baseline to the new state instead of flooding review:
  - Index-only change (e.g. `git add`): accept pending hunks only in the staged files.
  - Any HEAD move (commit, checkout, pull, merge, rebase, reset, stash affecting HEAD): accept all pending hunks workspace-wide as part of the new baseline.
  - If an agent runs `git add`/`git commit` itself, it is bypassing the review model: we make no review guarantees, and pending hunks are accepted (and committed) under the rules above.
- **Persistence.** Pending state survives editor restarts.
- **Initialization.** On first open, baseline = current disk state (nothing pending).

### 5.2 Built-in extension (runs inside the fork)

- Hosts the engine and feeds it file-watcher events plus self-write events (save hooks, the extension's own accept/reject writes).
- **Review list view.** Pending changes grouped by file, with accept/reject all.
- **Inline rendering.** Through the core hook (§5.3): added/changed text highlighted inline, deleted lines as real red rows, and per-hunk Accept/Reject controls.
- **Side-by-side diff.** An "open side-by-side diff" command, as a convenience.
- **Keybindings.** Accept hunk at cursor, reject hunk at cursor, next/previous hunk, accept/reject file.
- **Dirty-buffer conflicts.** If an external change hits a file with unsaved edits, show a merge view and never overwrite either side.
- **Agent terminal.**
  - Configurable agent command (default `tact`) launched in a terminal docked to the right.
  - **Cmd+L** (Ctrl+L on Windows/Linux) sends `@path:L42-58` into that terminal's input by default. The format is configurable, and including the selected text is optional. This overrides VS Code's default Cmd+L binding.
  - Works with any TUI agent, with no adapter.

### 5.3 Fork (VSCodium-based, primary deliverable)

- Base on [VSCodium](https://github.com/VSCodium/vscodium) for the build pipeline, telemetry removal, branding, and Open VSX. Reuse [Void](https://github.com/voideditor/void)'s published GitHub Actions for packaging, signing, notarization, and auto-update.
- Ship the extension as built-in, and enable proposed APIs for it in `product.json`.
- **Core patches for the review UI**, starting with inline rendering, kept organized and isolated for easy upstream merges. Choose the rendering approach in Phase 0 by which gives the best UI, not the smallest diff:
  - **(a)** Expose view zones (deleted lines rendered as real rows) to the built-in extension.
  - **(b)** Feed engine hunks into VS Code's existing chat-editing session UI (the Keep/Undo machinery used by Copilot agent mode, now in the open-source core). This also provides the multi-file review list and checkpoint UI for free.
- Try to upstream the rendering hook as a proposed API. If it's accepted, that part of the fork goes away. (The aim is less to maintain, not restoring stock VS Code support.)

### 5.4 ACP chat panel (connector)

For agents that speak [ACP](https://agentclientprotocol.com) (Claude Code via [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp), Codex via [codex-acp](https://github.com/agentclientprotocol/codex-acp), and Gemini CLI via `gemini --acp`), offer a native chat panel next to the agent terminal. Review still comes only from the engine, never from ACP. Design and citations: [docs/acp-design.md](docs/acp-design.md).

- **The harness makes its own edits.** The editor advertises no `fs` or `terminal` client capabilities, so the agent reads, writes and runs commands with its own tools, exactly as in a terminal. The file watcher shows those edits as Keep/Undo. ACP v2 (draft) removes those client APIs anyway.
- **One client, small profiles.** ACP lives in an editor-independent `packages/acp-client`: process management, the connection (`@agentclientprotocol/sdk`, protocol v1), a session reducer, a permission broker and profiles. Per-harness profiles hold only tailoring data: launch command and pinned adapter version, env, defaults, dangerous values, and the rules-file format. All UI comes from what the adapter advertises.
- **Native chat UI.** A built-in extension `extensions/agent-chat` drives VS Code's hidden chat through the chat-session-provider proposed APIs. ACP config options become the input-bar pickers (mode → the permission picker; model; effort; fast; plan), tool calls become tool cards, plans become the todo list, and permission requests use the core confirmation tool, which can't be auto-approved. Copilot stays disabled. If the spike shows the native chat can't be un-hidden cleanly, fall back to a webview over the same client.
- **The buttons.** These work live over ACP for Claude and Codex:
  - permission prompts;
  - permission mode;
  - model;
  - reasoning effort;
  - fast mode;
  - plan mode;
  - cancel;
  - list/resume sessions.

  Codex applies mode, model, effort and fast changes from the next turn. Effort and fast appear only for models that support them.
- **Defaults.** Claude starts in Accept edits (commands still prompt); Codex starts in Workspace access. Claude's Bypass is hidden; Codex's Full access needs a confirmation. The chat lives in the secondary side bar (right), and sessions can also open as editor tabs. The user's installed `claude`/`codex` are used when found on PATH; otherwise pinned adapters are downloaded on first use.
- **Standing permission rules aren't in ACP.** A rules editor edits the harness's own files: `permissions.allow/deny/ask` in Claude's `settings.json` files, and `prefix_rule` in `~/.codex/rules/default.rules`. Then it restarts the agent and resumes the chat.
- **Cmd+L** inserts `@path:L42-58` into the chat input when the chat is the active agent target (`agentReview.agent.target`: auto / terminal / chat; auto = whichever was used last). The reference goes to the agent as plain text.
- **Permission safety:**
  - only an explicit click answers a prompt;
  - prompts show the exact command or paths and whether "always" writes a persistent rule;
  - dangerous modes (Claude Bypass, Codex Full access) need confirmation and show a badge; Claude Bypass is hidden by default;
  - adapter versions are pinned, and agents don't start in Restricted Mode.
- `.claude/settings.local.json` joins the built-in ignores, so "always allow" clicks don't show up as agent edits. A `tact acp` subcommand remains a separate upstream contribution.

## 6. Phases

### Phase 0: Validate (about 1 week)

- Take a quick look at **Inline Diff** and CC Diff Review to note the limits of extension-only rendering.
- Run a CLI agent in VSCodium's terminal and confirm that no Keep/Undo appears (confirming the gap).
- Read VS Code's `chatEditing` code and how the Copilot Chat extension's Claude/Codex targets surface edits ([microsoft/vscode-copilot-chat](https://github.com/microsoft/vscode-copilot-chat)). Choose between rendering options (a) and (b) by which gives the best UI.
- Read Void's codebase guide for inline diff rendering and the fork build setup.
- **Exit criteria:** rendering approach chosen, fork build setup chosen, list of required core changes.

### Phase 1: Review engine (done, PR #1)

- Baseline store, attribution, line + word diff, accept/reject, file lifecycle, ignore rules, git-op detection, persistence.
- **Exit criteria (met):** comprehensive unit/integration tests (see §8) passing headlessly.

### Phase 2: Fork + built-in extension MVP (done)

- VSCodium-based build with branding, the built-in extension, and the core rendering patches.
- Inline rendering, Accept/Reject, review list, keybindings, dirty-buffer merge view, agent terminal, Cmd+L.
- CI: VSCodium-based packaging and an automated monthly upstream merge with patch-conflict alerts.
- **Exit criteria (met on the packaged Linux build):** Cursor-quality inline review, usable daily. Details: [docs/phase2.md](docs/phase2.md).
- **Left over:**
  - The macOS build (`fork/scripts/build-macos.sh`, ad-hoc signed) is untested on real hardware. Only its logic was checked, under bash 3.2 with stubbed macOS tools; the release-only macOS CI workflow hasn't run since its out-of-memory fix.
  - Signing and notarization (Apple Developer ID), installers and auto-update.
  - Windows builds.
  - The typed proposed API for the review hook moves to Phase 5; Phase 2 uses internal commands.

### Phase 3: Dogfood (about 2 weeks)

- Write a real paper with it, and get a few teammates using it with tact.
- Track what the rendering and review workflow get wrong.
- **Exit criteria:** a full paper written with it, and a few teammates using it daily.

### Phase 4: ACP connector (about 3–4 weeks)

- **A0. Spike (2–3 days).** Run both adapters headless without fs/terminal: record their capabilities and config options, and confirm an edit lands on disk through the harness's own tools and shows as pending. In the packaged build, show a chat-session provider with 5 option groups and a confirmation prompt while Copilot stays disabled. **Exit criteria:** native chat or webview decided, list of required core patches, fixtures checked in.
- **A. `packages/acp-client`.** Process manager (process-group kill, restart with backoff), connection, v1 reducer for every `session/update` kind, config options, permission broker, profiles, pinned adapter installer. **Exit criteria:** reducer property tests and fake-agent tests pass in CI; an opt-in contract test against the real Claude and Codex adapters passes, including "the agent never calls `fs/*` or `terminal/*`".
- **B. Chat panel MVP.** Sessions per harness, streaming text and thinking, tool cards, plan, slash commands, Stop, permission prompts, config-option pickers, Cmd+L to chat. **Exit criteria:** Claude Code and Codex run from the panel on a LaTeX paper; mode, model and effort can be changed; prompts can be answered; edits review inline; no Copilot UI appears; packaged-app smoke test passes.
- **C. Permissions UX.** Rules editor (Claude settings, Codex exec-policy rules) with restart-and-resume, dangerous-mode confirmation, persistent-option labels, audit log. **Exit criteria:** every button in the capability table is reachable from the panel.
- **D. Sessions and robustness.** History, reopening with replay, multiple sessions, crash recovery, login flows, an adapter update command. **Exit criteria:** a chat survives a restart and an adapter crash with its transcript.
- **E. More harnesses.** Gemini CLI by profile only; `tact acp` when available; ACP v2 behind a flag once it's stable. **Exit criteria:** a third harness passes the same contract and UI tests without UI code.

### Phase 5: Polish and extend

- "Restore to before" checkpoints.
- Upstream the rendering hook as a VS Code proposed API (replacing Phase 2's internal `_agentReview.*` commands).

## 7. Edge cases checklist

- Agent edits a file the user is editing (dirty buffer) → merge view; never overwrite.
- Agent edits the same region several times before review → one combined hunk against the baseline.
- User edits a pending hunk by hand → the user's edit wins; on save, the edited lines fold into the baseline and the untouched agent lines stay pending as a smaller hunk.
- Agent creates, deletes, or renames files → reviewable units (delete + create with identical content = rename).
- Formatter or linter on save → if triggered by the editor, changes inside pending agent hunks stay pending and changes elsewhere fold into the baseline; external if run by the agent.
- `git add` (index-only change) → accept pending hunks in the staged files only.
- Any HEAD move (commit, checkout, pull, merge, rebase, reset, stash affecting HEAD) → accept all pending hunks workspace-wide as the new baseline. An agent running `git add`/`git commit` bypasses review.
- Build artifacts (LaTeX auxiliary files and output PDFs, `node_modules`, `dist`) → ignored.
- Large and binary files → file-level accept/reject only.
- Editor closed while the agent keeps editing → changes appear as pending on next open.
- Multi-root workspaces → separate baseline per root.
- Symlinked paths → normalize to real paths.

## 8. Testing

- **Engine:** property tests on random edit sequences (after accept-all, baseline == disk with disk unchanged; after reject-all, disk == baseline with baseline unchanged), plus fixtures for each edge case in §7.
- **Built-in extension:** integration tests inside the fork build, with simulated external writes (scripts modifying files while documents are open or dirty).
- **End-to-end:** scripted runs with real CLI agents (tact, Claude Code, Codex) on a sample LaTeX repo and a sample code repo.
- **Fork:** smoke tests on every upstream merge (build, launch, render one hunk, accept, reject).

## 9. Maintenance plan

- **Patch hygiene:** keep core patches organized and isolated. Track their size in CI for awareness, not as a cap.
- **Upstream merges:** monthly, automated in CI, with a human resolving conflicts. Track merge time, aiming for under an hour per month, as a goal rather than a cap.
- **Risk controls:** patch hygiene and the editor-independent engine. There is no stock VS Code fallback; the team commits to maintaining the fork, and the engine can be reused in another host if needed.

## 10. Lessons from Void

Void (a YC-backed, open-source Cursor alternative built as a VS Code fork) built its own agent, model integrations, prompting, chat, and Cmd+K on top of a large fork. The repo is now deprecated. Reuse its fork infrastructure and rendering ideas, but avoid its scope: our patches serve the review UI only, and we don't build an agent, so agent improvements from Anthropic, OpenAI, and our own tact team reach our users for free.

## 11. References

- tact: https://github.com/clabby/tact
- nanocodex: https://github.com/gakonst/nanocodex
- Zed discussion on external-agent accept/reject: https://github.com/zed-industries/zed/discussions/56048
- Void: https://github.com/voideditor/void
- VSCodium: https://github.com/VSCodium/vscodium
- VS Code Copilot Chat (open source): https://github.com/microsoft/vscode-copilot-chat
- Inline Diff extension: https://marketplace.visualstudio.com/items?itemName=freeslur.inlinediff
- CC Diff Review extension: https://marketplace.visualstudio.com/items?itemName=LucianStoian.cc-diff-review
- Agent Client Protocol: https://agentclientprotocol.com
