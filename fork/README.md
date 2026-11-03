# fork/

Fork-side sources and scripts. Core changes ship as patches in [`../patches/`](../patches/), which VSCodium's build applies on top of its own. See [`../docs/phase2.md`](../docs/phase2.md) for what the fork does, and [`../docs/fork-build.md`](../docs/fork-build.md) for the build.

| Path | What |
|---|---|
| `branding.env` | **The one place to rename the product:** app name, binary, data folders, URL protocol, macOS bundle id, repo. Icons: [`../branding/`](../branding/) |
| `upstream.env` | Pins: VSCodium ref (VS Code 1.135.0) and Node version |
| `src/vs/workbench/contrib/agentReview/` | Readable copies of the new core files from `patches/92-agent-review.patch` (`check-patches.sh` checks they match) |
| `src/vs/workbench/contrib/agentChat/` | The same for `patches/94-agent-chat.patch` (the agent chat's Cmd/Ctrl+L pill and open-chat commands) |
| `scripts/prepare-vscodium.sh [--patches-only] [WORKDIR]` | Clone VSCodium at the pin, add our patches and branding, then `get_repo` + `prepare_vscode` (patches + `npm ci`) and install the built-in extension. `--patches-only` stops before `npm ci` |
| `scripts/check-patches.sh [--os osx\|linux] [WORKDIR]` | Apply the whole series as a build does, for macOS and Linux (~15 s each, no macOS needed), and check that `src/` matches the patched tree |
| `scripts/check-local.sh` | **Before merging:** repo lint, typecheck, build and unit tests, shellcheck, and the patch series. GitHub CI only runs the patch series and lint on PRs |
| `scripts/install-extension.sh VSCODE_DIR` | Build `extensions/agent-review` (esbuild bundle that includes the engine) and copy it to `VSCODE_DIR/extensions/agent-review` |
| `scripts/build-macos.sh [--install\|--check\|--dry-run\|--clean] [WORKDIR]` | **macOS, one command:** prerequisite check, prepare (skipped when pin/branding/patches are unchanged), build, ad-hoc sign, optionally copy to `/Applications`. See [`../docs/build-macos.md`](../docs/build-macos.md) |
| `scripts/build.sh [WORKDIR]` | Packaged app for the host OS/arch (`VSCode-linux-x64/` or `VSCode-darwin-arm64/editor.app`, ad-hoc signed) plus a `--version` smoke test. Heap cap: `MAX_OLD_SPACE_SIZE` (7168 Linux, 8192 macOS) |
| `scripts/sign-macos-adhoc.sh APP` | Clear extended attributes and ad-hoc sign an `.app` (no Developer ID needed) |
| `scripts/lint-core.sh [WORKDIR]` | VS Code's own ESLint config on every core file our patches add or change (0 warnings). The repo's own TypeScript is linted with `npm run lint` (VS Code's generic rules, `eslint.config.mjs`) |
| `scripts/test-core.sh [WORKDIR]` | Core tests: `contrib/agentReview` and `contrib/agentChat`, the upstream chat-editing and chat model tests (Electron), plus the diff tests and fixtures (node) |
| `scripts/simulate-agent.mjs setup\|edit\|all DIR [wave]` | Sample project + an "agent" that writes, renames over, creates and deletes files while the editor runs |
| `ci/*.sh` | CI helpers: free disk, add swap, pick a build dir, resource monitor |

All scripts run under macOS's stock bash 3.2 and BSD tools (`full-checks.yml` checks this on macOS and runs shellcheck).

```bash
fork/scripts/build-macos.sh --install   # macOS: everything, ~20-40 min the first time
fork/scripts/prepare-vscodium.sh   # ~4–5 min on 8 cores (WORKDIR defaults to ~/.cache/editor-fork-build)
fork/scripts/build.sh              # ~8 min on 8 cores
fork/scripts/test-core.sh          # ~30 s
```
