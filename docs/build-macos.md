# Build editor on macOS

One script builds a runnable, ad-hoc signed `editor.app` from a fresh clone, on Apple Silicon or Intel.

> **Status:** the script has been checked under bash 3.2 and with stubbed macOS tools on Linux. It has **not** been run on a real Mac yet. If it fails, the log path is printed at the end; see [Troubleshooting](#troubleshooting).

## 1. Prerequisites (once)

```bash
xcode-select --install                 # Xcode command line tools: clang, make, git, python3
brew install node@24 jq                # Node 24 (24.18.0 or newer within 24.x) and jq
echo 'export PATH="$(brew --prefix node@24)/bin:$PATH"' >> ~/.zprofile && exec zsh -l
```

- **Node must be 24.x.** Plain `brew install node` installs a newer major version, which VS Code's install script rejects. `nvm install 24` works too.
- On Apple Silicon, use the arm64 Homebrew in `/opt/homebrew` and a native (non-Rosetta) terminal.
- jq ships with macOS 15 and later, so `brew install jq` is only needed on older systems.
- You don't need a full Xcode, rustup or an Apple developer account.

The script checks all of this first and prints the exact command for anything that's missing. To run only the checks:

```bash
fork/scripts/build-macos.sh --check
```

## 2. Build

```bash
git clone <this repo> editor && cd editor
fork/scripts/build-macos.sh --install
```

This does the following:

1. Checks the prerequisites.
2. Clones VSCodium at the pinned commit, plus VS Code 1.135.0.
3. Applies VSCodium's patches and then ours.
4. Runs `npm ci`, which builds the native modules.
5. Builds and adds the built-in `agent-review` extension.
6. Compiles and packages the app.
7. Ad-hoc signs it (`codesign --force --deep --sign -`) and clears extended attributes, including quarantine.
8. Runs a `--version` smoke test.
9. With `--install`, copies the app to `/Applications/editor.app`.

Leave out `--install` to keep the app in the build directory only.

| | |
|---|---|
| **Time** | Expect about **20–40 min** the first time on an M-series Mac (estimate, not measured on a Mac; an 8-core Linux box takes 4 min to prepare and 8 min to build). Most of it is `npm ci` and the TypeScript compile. Rebuilds take about 10–20 min |
| **Disk** | **~15 GB free** in the build directory (the tree is about 10 GB), plus ~2 GB of npm and Electron caches in `~/.npm` and `~/Library/Caches/electron`. The app itself is about 0.5–1 GB |
| **Memory** | 16 GB is comfortable. With 8 GB it works but swaps, so close other apps |
| **Build directory** | `~/.cache/editor-fork-build`. To use another one, pass it as the last argument; the path must not contain spaces |
| **The app** | `~/.cache/editor-fork-build/vscodium/VSCode-darwin-arm64/editor.app` (`-x64` on Intel), plus `/Applications/editor.app` with `--install` |
| **Log** | `~/.cache/editor-fork-build/build-macos.log` |

When the build finishes, the script prints where the app is and how to launch it:

```bash
open /Applications/editor.app
```

To install the `editor` shell command, which works like `code` (`editor .`, `editor paper/main.tex`), open the command palette in editor (**Cmd+Shift+P**) and run **Shell Command: Install 'editor' command in PATH**. Or link it by hand into any directory on your `PATH`:

```bash
ln -sf "/Applications/editor.app/Contents/Resources/app/bin/editor" /opt/homebrew/bin/editor
```

editor keeps its settings in `~/Library/Application Support/Editor` and its extensions in `~/.editor`, so it runs side by side with VS Code and VSCodium.

## 3. Rebuild after pulling

```bash
git pull
fork/scripts/build-macos.sh --install      # quit editor first
```

The slow prepare step (clone, patches, `npm ci`) only runs again when the upstream pin, the branding or `patches/` changed. Otherwise the script reinstalls the extension and rebuilds the app. To force a full re-prepare, use `--clean`. To start over from nothing, `rm -rf ~/.cache/editor-fork-build`.

## Troubleshooting

**`Node 26.x ...` / `Please use Node.js v24.18.0 or newer with the same major version`.** The wrong Node is first on your `PATH`. Run `brew install node@24` and `export PATH="$(brew --prefix node@24)/bin:$PATH"`, then `hash -r` and `node -v`. With nvm: `nvm install 24 && nvm use 24`.

**`Node is an x64 build but the target is arm64`.** On an Apple Silicon Mac, Node comes from the Intel Homebrew in `/usr/local` or runs under Rosetta. Install the arm64 Node from `/opt/homebrew`, nvm or nodejs.org, and use a terminal that isn't set to "Open using Rosetta".

**`JavaScript heap out of memory` / `Ineffective mark-compacts near heap limit`.** The gulp heap cap (8192 MB by default) was too small. Raise it and run the script again. Prepare is skipped, so only the build repeats:

```bash
MAX_OLD_SPACE_SIZE=10240 fork/scripts/build-macos.sh --install
```

If instead the whole Mac crawls or the process gets `Killed: 9`, it ran out of real memory. Close other apps (browsers, Docker) and run it again.

**"editor is damaged and can't be opened" / "cannot be opened because Apple cannot check it".** Gatekeeper blocks quarantined apps that aren't notarized. A local build isn't quarantined, but a copy that was downloaded, AirDropped or unzipped from a release is. Run:

```bash
xattr -dr com.apple.quarantine /Applications/editor.app
fork/scripts/sign-macos-adhoc.sh /Applications/editor.app     # re-sign if it still won't open
```

Alternatively, right-click the app, choose **Open**, and confirm. You can also use System Settings › Privacy & Security › **Open Anyway**.

**`xcrun: error: invalid active developer path` / `xcode-select: error` / `gyp: No Xcode or CLT version detected!`.** The command line tools are missing or broken, which often happens after a macOS upgrade. Run `xcode-select --install`. If that says they're installed:

```bash
sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install
```

**`You have not agreed to the Xcode license agreements`.** Run `sudo xcodebuild -license accept`. If a broken full Xcode is selected, `sudo xcode-select --switch /Library/Developer/CommandLineTools`.

**`npm ci` fails while downloading.** VSCodium's prepare retries 5 times. For a network blip, run the script again.

**`error: patch failed` during prepare.** Our patches no longer match the pinned VSCodium. This shouldn't happen on `main`. Run `fork/scripts/build-macos.sh --clean`, and if it still fails, report the log.

**Anything else.** Send `~/.cache/editor-fork-build/build-macos.log`.

## What the script assumes

- macOS 12 or newer (Electron's minimum), bash 3.2 (the stock `/bin/bash`) and the BSD tools that ship with macOS (`sed`, `df`, `shasum`, `ditto`, `codesign`, `xattr`, `pgrep`).
- Network access to GitHub (VSCodium, VS Code, Electron), the npm registry and Electron's headers server.
- What it skips compared with VSCodium's release build: the Rust CLI (`code tunnel`), the remote server, enterprise policy files, notarization and the DMG. None of these are needed to run the app locally.
