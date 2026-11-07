<p align="center">
  <img src="branding/icon.svg" width="120" alt="editor logo">
</p>

<h1 align="center">editor</h1>

<p align="center">An agent-agnostic editor for reviewing what a coding agent changed, inline.</p>

editor is a code editor built on [VSCodium](https://vscodium.com). It shows an agent's edits inline, in the file, with **Keep** and **Undo** on every change. It works by watching your files, so it doesn't matter which CLI agent made the edit or where it ran. It's built mainly for writing LaTeX papers with an agent, and it works for code too.

editor contains no AI and calls no models: you bring your own agent. Review works with anything that writes files, including the official [Codex](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt) and [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) VS Code extensions. An experimental built-in chat panel for [tact](https://github.com/clabby/tact) is off by default.

![Agent edits to a LaTeX paper, shown inline with Keep/Undo](docs/img/review-inline.png)

## Features

- **Inline diffs:** deleted lines show in red rows, and deleted words are struck through right in the line.
- **Keep / Undo:** for one change, a whole file, or everything at once. **Ctrl/Cmd+Y** keeps the change at the cursor and **Ctrl/Cmd+N** undoes it.
- **Agent Changes list:** every changed, created and deleted file in the Explorer, with Keep All, Undo All and a multi-file diff.
- **Any agent:** the Codex or Claude Code extension, a CLI agent in a terminal, or your own harness. If it writes files, its edits show up for review.
- **Chat panel (experimental, off by default):** chat with tact in the secondary side bar or an editor tab, and press **Ctrl/Cmd+L** to put a reference like `@main.tex:L20-21` into the chat.
- **Your edits stay yours:** saving never accepts an agent's change, and your own edits are never shown as agent changes.

## Install

### macOS (Apple Silicon)

```bash
curl -fsSL https://guruvamsi-policharla.github.io/editor/install.sh | sh
```

Or download the Apple Silicon `.dmg` from the [website](https://guruvamsi-policharla.github.io/editor/) or [Releases](https://github.com/guruvamsi-policharla/editor/releases). Intel: [build from source](#build-from-source-on-macos).


### Build from source on macOS

macOS (Apple Silicon or Intel) and Linux (x64) can also be built from source.

You need:

- macOS 12 or newer
- Xcode command line tools
- Node 24 (24.18.0 or newer within 24.x, with npm below 13)
- jq and Python 3.8 or newer
- About 15 GB of free disk. 16 GB of RAM is comfortable

```bash
xcode-select --install                    # once: command line tools, including git and python3
brew install node@24 jq                   # once
export PATH="$(brew --prefix node@24)/bin:$PATH"
git clone https://github.com/guruvamsi-policharla/editor.git && cd editor
fork/scripts/build-macos.sh --install     # ~20-40 min the first time
open /Applications/editor.app
```

The script checks the prerequisites first and prints the exact command for anything that's missing. To rebuild after `git pull`, quit editor and run the same command.

For the `editor` shell command, press **Cmd+Shift+P** in editor and run **Shell Command: Install 'editor' command in PATH**.

More detail and fixes for common problems: [docs/build-macos.md](docs/build-macos.md).

### Linux (x64)

```bash
sudo apt-get install -y build-essential pkg-config libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev jq python3
# Node 24.18 or newer within 24.x (e.g. nvm install 24)
git clone https://github.com/guruvamsi-policharla/editor.git && cd editor
fork/scripts/prepare-vscodium.sh          # clone VSCodium + VS Code, apply patches, npm ci (~5 min)
fork/scripts/build.sh                     # compile and package (~8 min on 8 cores; 16 GB RAM)
~/.cache/editor-fork-build/vscodium/VSCode-linux-x64/bin/editor
```

## Try it without an agent

`scripts/demo-agent.sh` is a fake agent. It edits a copy of a small LaTeX paper ([`examples/paper/`](examples/paper/)) by writing straight to disk, the way a CLI agent would.

```bash
scripts/demo-agent.sh setup            # copies examples/paper to /tmp/editor-demo/paper
editor /tmp/editor-demo/paper          # or: open -a editor /tmp/editor-demo/paper
scripts/demo-agent.sh run              # press Enter once the folder is open
```

Over about 6 seconds it rewords a sentence, deletes a line, adds a paragraph, changes a number and creates a new file. Each change appears inline, ready to Keep or Undo. Run `setup` again to start over.

## Using it

1. **Open your project folder.** What's on disk at that point is the accepted state, so nothing is pending yet.
2. **Run your agent**, any way you like:
   - **The Codex or Claude Code extension:** install OpenAI's or Anthropic's VS Code extension in editor and use it as usual. Its edits are reviewed inline with Keep/Undo like any other.
   - **Your own harness or CLI agent,** anywhere: the integrated terminal, another terminal, or tmux. editor only watches the files. **Agent Review: Open Agent Terminal** starts the command in `agentReview.agent.command` in a terminal beside the editor.
   - **The built-in tact chat** (experimental), once you've turned it on: see [The chat panel](#the-chat-panel-experimental).
3. **Review the changes as they appear:**
   - **Each change:** **Keep** / **Undo** at its end, or **Ctrl/Cmd+Y** / **Ctrl/Cmd+N** with the cursor in it. **Ctrl/Cmd+Z** takes a Keep or an Undo back.
   - **A whole file:** the bar at the bottom center of the editor has Keep / Undo for the file, and ↑/↓ to move between changes.
   - **Everything:** the **Agent Changes** list in the Explorer has Keep All, Undo All and **Open All Changes**.

**Undo** writes the file right away, so the agent never reads undone text back. The exception is a file with unsaved edits, where the undo stays in the editor until you save.

### The chat panel (experimental)

The chat panel is off by default. To turn it on, set this in your settings (**Cmd/Ctrl+,**, search for `tact`) and reload the window:

```json
"agentChat.tact.enabled": true
```

While it's off there's no chat panel, no chat commands, Ctrl/Cmd+L keeps its usual meaning, and nothing is started. Review works the same either way.

Start a chat with **Agent Chat: New tact Chat**, or the **+** menu in the chat's title. The chat runs your own `tact`, found on your PATH, over [ACP](https://agentclientprotocol.com). The adapter ships with editor. If tact isn't installed or signed in, the chat tells you and offers to fix it.

- tact edits files itself, so its edits are reviewed like any other agent's.
- tact runs commands and edits without asking for permission. **Stop** cancels the turn.
- The input bar has tact's pickers for the chosen model: model, thinking, Pro reasoning and speed, where the model offers them.
- Each chat keeps its own model and settings, also after a restart.
- While one agent is working, a message in another chat waits for it. **Run now** skips the wait.
- **Search Chats** (the magnifier in the chat's title) searches old chats, including what was said.

**Ctrl/Cmd+L** opens the chat if needed and inserts a reference at the cursor, so one message can point at several places. With nothing selected it references the whole file. To give the key to something else, bind it in your `keybindings.json`.

### What counts as a change

- **Your own edits:** when you save, edits outside the agent's changes fold into the accepted state. This also holds with format on save.
- **Typing inside an agent's change:** your typing becomes part of that change. Saving doesn't accept it; only Keep or Undo resolves it.
- **Unsaved edits:** if anything else changes a file you have unsaved edits in, nothing is overwritten. A notice offers **Merge…**, a 3-way merge of the disk version with yours.
- **`git add`:** accepts what it stages, including only the staged hunks with `git add -p`.
- **Commits and other HEAD moves** (checkout, pull, merge, rebase, reset): accept the files that differ between the old and new commit, whole and as they are on disk. That includes hunks you didn't stage. Pending changes in other files stay pending.
- **`git stash` and `git stash pop`:** accept nothing.
- **Never shown:** LaTeX build files (`.aux`, `.log`, the output PDF), `node_modules`, anything in `.gitignore`, and agent state such as `.claude/settings.local.json`.

Pending changes survive a restart.

## Settings

| Setting | What it does |
|---|---|
| `agentReview.enabled` | Turns review on or off |
| `agentReview.ignore` | Extra patterns to leave out of review |
| `agentReview.agent.command` | The command the Agent Terminal starts (default `tact`) |
| `agentReview.agent.location` | Where the Agent Terminal opens: `right` or `panel` |
| `agentReview.agent.referenceFormat`, `agentReview.agent.fileReferenceFormat` | The text Ctrl/Cmd+L inserts for a selection, or for a whole file |
| `agentReview.trace` | Logs every change to the accepted state in the **Agent Review** output channel |
| `agentChat.tact.enabled` | Turns on the experimental tact chat panel and Ctrl/Cmd+L (default off) |
| `agentChat.turns.waitForOtherChats` | Whether a chat waits while another chat's turn runs |
| `chat.fontSize` | The chat transcript's text size (default 14) |

## Status

Apple Silicon releases are Developer ID signed and notarized; there's no Windows build, and the experimental chat panel runs only tact.

## Repository

| Path | What |
|---|---|
| [`packages/engine`](packages/engine) | The review engine: accepted baselines, diffs, attribution of user and agent edits, git handling |
| [`packages/acp-client`](packages/acp-client) | Editor-independent ACP client |
| [`packages/tact-acp`](packages/tact-acp) | ACP adapter for tact |
| [`extensions/agent-review`](extensions/agent-review) | Built-in extension: file watching, Agent Changes, Agent Terminal, Ctrl/Cmd+L |
| [`extensions/agent-chat`](extensions/agent-chat) | Built-in chat panel |
| [`patches/`](patches) | Core patches on top of VSCodium |
| [`fork/`](fork) | Build scripts, branding and upstream pins |
| [`branding/`](branding) | The logo and every icon generated from it |
| [`docs/`](docs) | [Architecture](docs/architecture.md) and the [macOS build](docs/build-macos.md) |

To work on editor, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgements

editor is built on [VSCodium](https://github.com/VSCodium/vscodium) and Microsoft's [VS Code](https://github.com/microsoft/vscode) source, both MIT licensed. This repository holds only patches on top of them. Their code and license files are fetched at build time, at the commits pinned in [`fork/upstream.env`](fork/upstream.env).
