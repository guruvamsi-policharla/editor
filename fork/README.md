# fork/

Fork-side sources and scripts. Core changes ship as patches in [`../patches/`](../patches/), which VSCodium's build applies on top of its own. See [`../docs/phase2.md`](../docs/phase2.md) for what the fork does, and [`../docs/fork-build.md`](../docs/fork-build.md) for the build.

| Path | What |
|---|---|
| `branding.env` | **The one place to rename the product:** app name, binary, data folder, URL protocol, macOS bundle id, repo |
| `upstream.env` | Pins: VSCodium ref (VS Code 1.135.0) and Node version |
| `src/vs/workbench/contrib/agentReview/` | Readable copies of the new core files from `patches/92-agent-review.patch` (CI checks they match) |
| `scripts/prepare-vscodium.sh [--patches-only] [WORKDIR]` | Clone VSCodium at the pin, add our patches and branding, then `get_repo` + `prepare_vscode` (patches + `npm ci`) and install the built-in extension. `--patches-only` stops before `npm ci` |
| `scripts/install-extension.sh VSCODE_DIR` | Build `extensions/agent-review` (esbuild bundle that includes the engine) and copy it to `VSCODE_DIR/extensions/agent-review` |
| `scripts/build.sh [WORKDIR]` | Packaged app for the host OS/arch (`VSCode-linux-x64/` or `VSCode-darwin-arm64/Editor.app`) plus a `--version` smoke test |
| `scripts/test-core.sh [WORKDIR]` | Core tests: `contrib/agentReview` and the upstream chat-editing tests (Electron), plus the diff tests and fixtures (node) |
| `scripts/simulate-agent.mjs setup\|edit\|all DIR [wave]` | Sample project + an "agent" that writes, renames over, creates and deletes files while the editor runs |
| `ci/*.sh` | CI helpers: free disk, add swap, pick a build dir, resource monitor |

```bash
fork/scripts/prepare-vscodium.sh   # ~4–5 min on 8 cores (WORKDIR defaults to ~/.cache/editor-fork-build)
fork/scripts/build.sh              # ~8 min on 8 cores
fork/scripts/test-core.sh          # ~30 s
```
