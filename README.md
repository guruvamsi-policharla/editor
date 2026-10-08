# Editor

*Placeholder name.*

Editor is a VSCodium-based editor that lets you review what a coding agent changed, inline, the way Cursor does, but with **any** CLI agent: Claude Code, Codex, tact, or anything else that writes files. It contains no AI and calls no models: you run your own agent, in a terminal or (for Claude Code and Codex) from a chat panel. It watches your files, and whatever changed on disk since you last accepted it shows up in the editor as a pending change. Deleted text is shown as real red lines, rewritten words are highlighted, and every change has its own **Keep** / **Undo**. It's built mainly for writing LaTeX papers with an agent, and works for code too.

![Agent edits to a LaTeX paper, shown inline with Keep/Undo](docs/img/polish-1/after-prose.png)

## Quickstart

### macOS (Apple Silicon or Intel)

```bash
xcode-select --install                    # once: Xcode command line tools
brew install node@24 jq                   # once: Node 24 and jq
export PATH="$(brew --prefix node@24)/bin:$PATH"
git clone <this repo> editor && cd editor
fork/scripts/build-macos.sh --install     # ~20-40 min the first time; ~15 GB of disk
open /Applications/Editor.app
```

The script checks the prerequisites first and tells you exactly what's missing. It builds an ad-hoc signed `Editor.app`; no Apple developer account is needed. To rebuild after `git pull`, run the same command. The details and fixes for the usual problems (Node version, out of memory, "Editor is damaged") are in **[docs/build-macos.md](docs/build-macos.md)**.

To get the `editor` shell command, open the command palette in Editor (**Cmd+Shift+P**) and run **Shell Command: Install 'editor' command in PATH**.

### Linux (x64)

```bash
sudo apt-get install -y build-essential pkg-config libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev jq python3
# Node 24.18 or newer within 24.x (e.g. nvm install 24)
fork/scripts/prepare-vscodium.sh          # clone VSCodium + VS Code, apply patches, npm ci (~5 min)
fork/scripts/build.sh                     # compile and package (~8 min on 8 cores; 16 GB RAM)
~/.cache/editor-fork-build/vscodium/VSCode-linux-x64/bin/editor
```

## Try it: Keep/Undo in two minutes, no agent needed

`scripts/demo-agent.sh` is a fake agent. It edits a small LaTeX paper (a copy of [`examples/paper/`](examples/paper/)) the way a CLI agent would, writing straight to disk.

```bash
scripts/demo-agent.sh setup            # copies examples/paper to /tmp/editor-demo/paper
editor /tmp/editor-demo/paper          # or: open -a Editor /tmp/editor-demo/paper  (File > Open Folder... works too)
scripts/demo-agent.sh run              # press Enter once the folder is open
```

Over about 6 seconds the fake agent rewords a sentence in `sections/intro.tex`, deletes a line from the abstract, adds a paragraph, changes a number in the results, and creates `sections/related.tex` (plus its `\input` line in `main.tex`). Each change shows up inline with **Keep** / **Undo**:

- **Ctrl/Cmd+Y** keeps the change at the cursor; **Ctrl/Cmd+N** undoes it.
- The ↑/↓ arrows in the overlay jump between changes.
- **Agent Changes** in the Explorer lists every file, including the new one.

To start over, run `scripts/demo-agent.sh setup` again.

## Use it with Claude Code, Codex, or any CLI agent

1. **Open your project folder** in Editor. Whatever is on disk at that point is the accepted state, so nothing is pending yet.
2. **Run your agent.** You can run it in the integrated terminal (`claude`, `codex`, ...) or anywhere else, such as another terminal or tmux. Editor only watches the files. Alternatively, use the **Agent Terminal** docked to the right of the editor: run **Agent Review: Open Agent Terminal** from the command palette. It starts the command in the `agentReview.agent.command` setting (default `tact`; set it to `claude` or `codex`).
   Or **chat with it**: **Agent Chat: New Claude Code Chat** (or **New Codex Chat**) opens a chat in the secondary side bar, or as an editor tab with **New Agent Chat in Editor**. It runs your own `claude`/`codex` (found on PATH; the small ACP adapter is downloaded once, on first use) over [ACP](https://agentclientprotocol.com); the agent edits files itself, so its edits are reviewed below like any other. The input bar has the agent's own pickers: model, mode (Claude starts in Accept edits; commands still ask), effort, fast and plan. Commands it wants to run ask first, with Yes / No / always; **Stop** cancels the turn. Not signed in? The chat says so and **Sign in** runs the harness's login in a terminal. Details: [extensions/agent-chat](extensions/agent-chat).
3. **Review the changes** as they appear:
   - **Each change:** **Keep** / **Undo** at its end (or under it when its last line is full), or **Ctrl/Cmd+Y** / **Ctrl/Cmd+N** with the cursor in it. **Ctrl/Cmd+Z** takes a Keep or an Undo back. A few changed words in a long line show as track changes (deleted words struck through in red, in the line), also when the agent deleted or added a paragraph right next to it.
   - **A whole file:** the bar at the bottom center of the editor, which starts with the file's name (Keep / Undo for the whole file, ↑/↓ to move between changes and files).
   - **Everything:** the **Agent Changes** list in the Explorer, with Keep All / Undo All and **Open All Changes** (a multi-file diff). Created and deleted files are reviewed there too.

   **Undo** writes the file right away, so the agent never reads undone text back. The exception is a file you have unsaved edits in: the undo then stays in the editor until you save.
4. **Point the agent at text** by selecting lines and pressing **Ctrl/Cmd+L**. That types a reference such as `@paper/main.tex:L20-21` into the Agent Terminal (opening it if needed), or into the agent chat's input if you used the chat last (`agentReview.agent.target`: auto / terminal / chat); then tell the agent what to do with it. The format is configurable (`agentReview.agent.referenceFormat`), and `agentReview.agent.includeSelectedText` also sends the selected text to the terminal.

Your own edits are never shown as agent changes. When you save, they're folded into the accepted state, and the agent's changes around them stay pending. That holds with format on save too (JSON, latexindent, ...): a formatter reflowing your line next to an agent change folds your text in and leaves only the agent's lines pending; it never accepts the agent's change. Unsaved edits that come back after a restart are still yours, not the agent's. If an agent writes a file while you have unsaved edits in it, nothing is overwritten: **Merge…** opens a 3-way merge. A `git commit` or checkout accepts what it moved (`git stash` and `git stash pop` don't: the changes come back with the pop). LaTeX build files (`.aux`, `.log`, the output PDF, ...), `node_modules`, Claude Code's `.claude/settings.local.json` (its "always allow" answers) and anything in `.gitignore` are never shown. Pending changes survive a restart. If something looks wrong, turn on `agentReview.trace`: the **Agent Review** output channel then logs every change to the accepted state with its reason and how each save was attributed.

## Status

Phase 2 (the fork with the built-in review) is done and runs as a packaged Linux build. The ACP chat panel (Phase 4 A–B) is an MVP: Claude Code works end to end; Codex is wired up to its sign-in. Rules editing, chat history and more harnesses are Phase 4 C–E. The macOS build script hasn't been run on a real Mac yet. Signing/notarization, Windows and a proposed API are later work; see [PLAN.md](PLAN.md#6-phases).

## Repository

| Path | What |
|---|---|
| [`packages/engine`](packages/engine) | The review engine: accepted baselines, diffs, attribution of user vs. agent edits, git handling. Editor-independent TypeScript |
| [`extensions/agent-review`](extensions/agent-review) | The built-in extension: file watching, the Agent Changes list, the Agent Terminal, Ctrl/Cmd+L |
| [`packages/acp-client`](packages/acp-client) | Editor-independent ACP client: adapter supervision, session reducer, permission broker, harness profiles, pinned adapter installer. No fs/terminal capabilities |
| [`extensions/agent-chat`](extensions/agent-chat) | The built-in chat panel: Claude Code and Codex in VS Code's native chat, over `acp-client` |
| [`patches/`](patches) | Core patches on top of VSCodium (inline rendering hooks, hunk toolbar, the `agentReview` contribution) |
| [`fork/`](fork) | Build scripts, branding (`fork/branding.env`), pins, readable copies of the new core files |
| [`docs/`](docs) | [Phase 2 details](docs/phase2.md), [macOS build](docs/build-macos.md), [fork build notes](docs/fork-build.md), [ACP design](docs/acp-design.md) |
| [`PLAN.md`](PLAN.md) | Design and plan |

Development: `npm ci && npm run lint && npm run typecheck && npm test` (engine, ACP client, both extensions; `RUN_ACP_CONTRACT=1` adds the real-adapter contract tests), and `fork/scripts/test-core.sh` / `fork/scripts/lint-core.sh` for the core patches in a prepared tree.
