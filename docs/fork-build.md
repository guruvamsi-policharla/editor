# Fork build setup (Phase 0)

> **Phase 2 update:** the scripts are now `fork/scripts/prepare-vscodium.sh`, `build.sh`, `test-core.sh` and `install-extension.sh`; branding is in `fork/branding.env`. CI is implemented (`.github/workflows/ci.yml`, `build-linux.yml`, `build-macos.yml`, `upstream-bump.yml`). A full Linux build was measured on the free private-repo runner (it fits with disk cleanup + 10 GB swap, ~30 min). See [phase2.md](phase2.md#ci) and [`../fork/README.md`](../fork/README.md). The sections below are the Phase 0 analysis.

**TL;DR:** Build the fork **the VSCodium way: patches, not a source fork**. Our repo keeps only our patches (`patches/*.patch`), readable copies of new core files and scripts (`fork/`), product overrides, and the built-in extension. CI clones VSCodium at a pinned ref and drops our patches into its official downstream hook, `patches/user/`. VSCodium's `prepare_vscode.sh` applies them last, after its own ~60 patches. I ran a real Linux x64 build of VS Code 1.135.0 + VSCodium patches + the Phase 0 spike on an 8-vCPU / 16 GB box:

- **~14 min** from a clean checkout to a packaged `codium` (~8 min once dependencies are installed).
- **~7.3 GB peak gulp RSS.**
- **~8 GB of disk** for the tree plus output.

The spike type-checked with 0 errors, and the packaged app renders the review UI ([phase0-rendering.md](phase0-rendering.md#end-to-end-check-in-the-real-packaged-build)). For CI and release automation, reuse **VSCodium's** current workflows, not Void's.

## 1. How a VSCodium build works (what we plug into)

VSCodium (`github.com/VSCodium/vscodium`, checked at `master` 5b01560, 2026-10-06 16:21 PT) is a set of shell scripts plus patches over a pinned upstream commit:

| Step | Script | What it does |
|---|---|---|
| 1 | `get_repo.sh` | Reads `upstream/stable.json` (today: tag `1.135.0`, commit `08d4889f9ec4…`) and shallow-fetches `microsoft/vscode` at that commit into `./vscode` |
| 2 | `version.sh` | Computes `RELEASE_VERSION` (e.g. `1.135.06733`) |
| 3 | `prepare_vscode.sh` | **product.json:** `setpath` calls write the VSCodium branding (nameShort, applicationName, dataFolderName, Win32 AppIds, Open VSX gallery, update URL…). Then it deep-merges the repo-root `product.json` with `jq -s '.[0] * .[1]' product.json ../product.json`. **Patches:** applies `patches/*.patch` (43 core patches today), then `patches/insider/` (insider only), then `patches/${OS_NAME}/*.patch` (per-OS), and **last `patches/user/*.patch`**. `apply_patch` (in `utils.sh`) replaces the `!!APP_NAME!!`, `!!BINARY_NAME!!`, `!!ORG_NAME!!` etc. placeholders, then runs `git apply --ignore-whitespace` and aborts on failure. **Deps:** `npm ci` with VSCodium's `npmrc`; this also builds native modules |
| 4 | `build.sh` | `npm run gulp vscode-min-prepack` (compile, bundle, minify), then `vscode-${OS}-${ARCH}-min-packing`, then REH/REH-web servers and the Rust CLI (`build_cli.sh`, needs rustup). `MAX_OLD_SPACE_SIZE` defaults to 8192 |
| 5 | `prepare_assets.sh` / `release.sh` | Installers (deb, rpm, AppImage, tar.gz, dmg, msi/exe), checksums, GitHub release, then bumps the versions repo used by the updater |

`dev/build.sh` wraps steps 1–4 for local builds and sets the same env vars our scripts set.

### Where our pieces go

| Our piece | Mechanism | Notes |
|---|---|---|
| Core patches (`patches/9x-agent-review-*.patch`) | Copied into `vscodium/patches/user/` before `prepare_vscode.sh` (`fork/scripts/prepare-vscodium.sh`) | Officially supported hook, applied last, so our patches sit on top of VSCodium's. Placeholders such as `!!APP_NAME!!` work in our patches too. The spike patch (611 lines) applies cleanly with `git apply --check` on the fully patched tree |
| Branding (name, binary, data folder, URLs, Win32 AppIds, bundle id) | Phase 2 (not in this PR): a `fork/product.json` of overrides, deep-merged into `vscodium/product.json` before step 3. Because that file is merged **after** the `setpath` calls, our values win. Plus env vars `APP_NAME`, `BINARY_NAME`, `ORG_NAME`, `ASSETS_REPOSITORY`, `GH_REPO_PATH` for the scripts and patch placeholders | Need **new** Win32 AppId GUIDs, `darwinBundleIdentifier`, `urlProtocol`, `dataFolderName` so we can run side by side with VS Code and VSCodium. Icons: replace `src/stable/resources/**` and `icons/stable/**` (VSCodium's `icons/build_icons.sh` generates all sizes from SVGs) |
| Settings defaults (e.g. `chat.disableAIFeatures`, our keybindings) | `configurationDefaults` in the built-in extension's `package.json`, or a small core patch for anything that has to be a core default | Extension-contributed defaults are zero-patch |
| Update channel | product.json `updateUrl` + `downloadUrl`, pointing at our own versions repo (VSCodium's `update_version.sh` format) | Optional for the MVP; the GitHub Releases download is enough to start |
| Built-in extension (agent-review UI, terminal, sidebar) | See §2 | |

## 2. Built-in extension packaging and proposed APIs

- **How VS Code finds built-ins:** `build/lib/extensions.ts` packages every `extensions/*/package.json` into the product. TypeScript compile/bundle tasks are listed in `build/gulpfile.extensions.ts`; an extension that ships prebuilt JS (a `dist/` folder) needs no gulp entry.
- **Recommended (MVP):** build the extension in our repo (`npm run build` → `dist/` + `package.json`), and have `prepare-vscodium.sh` copy it to `vscode/extensions/agent-review/` after `prepare_vscode.sh`. That touches no gulp files and needs no patches. The extension is just another folder, so `vscode-min-prepack` picks it up.
- **Alternative (later):** publish a VSIX in our GitHub releases and list it in product.json `builtInExtensions` with a `repo`/`vsix` entry. Note that VSCodium's `00-build-download-extensions-from-gh` patch removes the marketplace fallback, so the download must come from GitHub. This decouples extension releases from editor releases, but it adds a network dependency to the build.
- **Proposed APIs:**
  - Built-in extensions (`isBuiltin`) are allowed to use every proposal listed in their own `package.json` `enabledApiProposals`. No product.json entry is needed.
  - For a non-built-in build of the same extension (dev or side-loaded), add `"extensionEnabledApiProposals": { "<publisher>.<name>": ["…"] }` to our product.json override.
  - Our own future proposal (C9, `agentReview`) is a new `src/vscode-dts/vscode.proposed.agentReview.d.ts` plus the generated `extensionsApiProposals.ts` (`compile-api-proposal-names` gulp task), carried in a patch.
- **Phase 2 doesn't need a new proposal:** the extension talks to core through internal commands (`_agentReview.setBaseline`, `_agentReview.remove`, and the callback `agentReview.ext.onDidHunkAction`). These commands are reachable from any extension via `vscode.commands.executeCommand`, so there's nothing to enable.

## 3. Reuse from Void and VSCodium

**Void (`voideditor/void`, `voideditor/void-builder`) is a reference, not a base:**

- The Void README says the project is paused/deprecated. Its last commit was June 2026.
- `void-builder` is a September 2025 copy of VSCodium's scripts. It builds from the full source fork (`voideditor/void`), not from patches, so it inherits all of VSCodium's machinery, just older.
- Its workflows (`stable-linux.yml`, `stable-macos.yml`, `stable-windows.yml`) are VSCodium's from that era. They use secrets such as `CERTIFICATE_OSX_*`, `STRONGER_GITHUB_TOKEN`, and the versions-repo update flow.
- `voideditor/void/.github` only contains `triage.yml`.
- Worth taking as notes: how Void rebranded (product.json fields, icons, Windows AppIds) and its use of `IUpdateService` with a versions repo. Neither needs Void code.
- **PLAN.md says "reuse Void's GitHub Actions". That's out of date.** VSCodium's current workflows are the maintained source of the same files.

**VSCodium workflows to copy and adapt (all under `.github/workflows/`):**

| Workflow | Use for us |
|---|---|
| `ci-build-linux.yml` / `ci-build-macos.yml` / `ci-build-windows.yml` | PR and nightly builds without publishing. They show the exact apt/brew/choco deps, Node setup, caching, and `build.sh` env |
| `publish-stable-linux.yml` / `-macos.yml` / `-windows.yml` | Release: matrix over arch, signing (`CERTIFICATE_OSX_*`, Apple notarization; Windows signing), `prepare_assets.sh`, upload to GitHub Releases, versions-repo bump. Linux uses `ubuntu-22.04` hosts, plus an archlinux container for AppImage |
| `publish-*-spearhead.yml` | Manual "take the latest VS Code (`VSCODE_LATEST=yes`), build macOS arm64 first, then dispatch the other platforms" job. Template for our upstream-bump job |
| `lint-zizmor.yml` | Workflow security lint. VSCodium pins every action by SHA; keep doing that |

**Reuse strategy:** keep VSCodium as a build-time dependency pinned to a commit (`VSCODIUM_REF`), rather than forking the vscodium repo. We only own:

- `fork/scripts/*`
- `fork/product.json`
- icons
- `patches/`
- three or four workflow files adapted from VSCodium's

Bumping upstream means changing `VSCODIUM_REF`. VSCodium does the hard part (its patches against the new VS Code); we re-check only our patches.

## 4. Measured build (real run, 2026-10-07)

**Machine:** Debian 13 (trixie) container, 8 vCPU, 16 GB RAM, **no swap**, Node 24.

**Target:** VSCodium `master` 5b01560 → VS Code `1.135.0` @ `08d4889f` + all VSCodium patches + `patches/90-agent-review-spike.patch`, `linux-x64`. I skipped REH servers and the Rust CLI (no rustup on the box; that's VSCodium's `build_cli.sh` step, not needed for the desktop app).

| Stage | Wall time | Notes |
|---|---|---|
| System deps (apt) | 73 s | `build-essential g++ make pkg-config libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev fakeroot rpm imagemagick` (+ `jq git python3 xvfb` already present) |
| `get_repo.sh` + `version.sh` | 6 s | Shallow fetch of one VS Code commit |
| `prepare_vscode.sh` (product.json + all patches + `npm ci`) | 274 s | `npm ci` dominates (native modules) |
| Apply spike patch (`patches/user` step) | <1 s | Clean apply |
| `gulp vscode-min-prepack` | 458 s | `compile-src` 410 s (full type check of `src/`: **0 errors**, spike included); extension bundling 14 s; `bundle-vscode` 15 s; `minify-vscode` 13 s |
| `gulp vscode-linux-x64-min-packing` | 29 s | Assemble Electron + app (Electron already cached by the test step) |
| **Total, clean box → `VSCode-linux-x64/codium`** | **~14 min** (~8 min with deps installed) | `codium --version` → `1.135.06733 / 08d4889f… / x64` |
| Spike unit tests (`fork/scripts/test-spike.sh`) | ~20 s | `transpile-client` 5 s + Electron fetch 3 s + test ~9 s (6/6 pass) |

**Memory (sampled every 15 s):**

- The gulp process peaked at **~7.3 GB RSS**, with `--max-old-space-size=7168`.
- System `MemAvailable` dropped to **383 MB** during `npm ci` native compiles and **557 MB** during `compile-src`.
- 16 GB without swap is the practical minimum. Recommended: 16 GB **plus swap**, or 32 GB.
- `prepare_vscode.sh` writes `MAX_OLD_SPACE_SIZE` into `package.json` scripts. I prepared with 2600 (to survive `npm ci`) and raised it to 7168 for the build. With the default 8192 on a 16 GB box, swap is required.

**Disk:**

- Patched tree after `npm ci`: 5.2 GB.
- After the build: **7.1 GB** (`node_modules` 2.0 GB, `.build` 0.5 GB).
- Packaged app `VSCode-linux-x64/`: **1.0 GB** unpacked.
- Total for one platform: **~8.2 GB**, plus ~1–2 GB for installers if you run `prepare_assets.sh`.

**Blockers hit and how they were handled:**

- **Memory:** OOM risk without swap; handled with the heap caps above.
- **Rust CLI:** no rustup, so I skipped the CLI. CI must install rustup, as VSCodium's workflows do.
- **`rg` on the source tree:** it hung, so I used `git grep`. This is a tooling note, not a build issue.

Nothing in the spike or our patch flow needed workarounds.

**Implication for CI runners:**

- GitHub's standard **private-repo** Linux runner is 2 vCPU / 8 GB / 14 GB SSD. That's too small for a full build (heap ~7 GB plus OS, tree ~8 GB on a 14 GB disk), and slow (expect 30–45 min if it fits at all).
- The **public-repo** runner is 4 vCPU / 16 GB, which is what VSCodium relies on.
- Options:
  - (1) a larger runner (paid, 4–8 vCPU / 16–32 GB);
  - (2) a self-hosted runner (any 8-core / 32 GB box);
  - (3) make the build repo public. Only patches live there; the engine/extension could stay private and ship as a prebuilt artifact.
- The cheap PR checks (patch apply + spike unit tests) need `npm ci` (~5 min, ~5 GB). They fit on a standard runner if `MAX_OLD_SPACE_SIZE` is kept low.

## 5. Local workflow

```bash
fork/scripts/prepare-vscodium.sh            # clone VSCodium@VSCODIUM_REF, add our patches to patches/user, get_repo + prepare_vscode (~5 min)
fork/scripts/test-spike.sh                  # transpile + Electron unit tests for contrib/agentReview (~20 s)
fork/scripts/build-linux.sh                 # gulp vscode-min-prepack + linux-x64 packing (~8 min, ~7.3 GB RSS)
~/.cache/editor-fork-build/vscodium/VSCode-linux-x64/codium   # run it
```

Fast inner loop for core work: in the prepared tree, `npm run watch-client` plus `./scripts/code.sh` (dev build, no packaging). Edit files there, then `git diff > patches/9x-….patch` and copy the new files back into `fork/src/…`.

## 6. CI plan

| Job | Trigger | Runner | Steps | Time |
|---|---|---|---|---|
| **patch-check** | every PR touching `patches/`, `fork/` | standard | `prepare-vscodium.sh` (fails if any patch doesn't apply) → `test-spike.sh` / all `contrib/agentReview` tests under xvfb → type check of the patched tree (`npx tsc -p src --noEmit`, or `gulp compile-src`; ~7 min on 8 cores) | ~10–15 min |
| **engine/extension tests** | every PR | standard | existing `packages/*` tests (unchanged by this PR) | minutes |
| **linux-nightly** | nightly + manual | large / self-hosted (≥16 GB + swap) | full `build-linux.sh` + a smoke test: launch `codium` under xvfb, run the sample command, screenshot (as in phase0-rendering.md) → upload tar.gz artifact | ~20 min |
| **release** | tag `v*` | per-OS (adapted `publish-stable-*.yml`) | build + `prepare_assets.sh` + sign (Apple Developer ID + notarization: `CERTIFICATE_OSX_*` and Apple ID secrets; Windows code signing cert or Azure Trusted Signing) → GitHub Release → versions-repo bump | ~30–60 min per OS |
| **upstream-bump** | monthly (and on VSCodium stable releases) | standard | bump `VSCODIUM_REF` to the latest VSCodium stable tag → patch-check → open a PR. On conflict, the PR carries the failing hunk for a human | ~15 min |

Merge-risk numbers backing the monthly cadence (1.135 → 1.142, ~6 months of upstream):

- `chatEditingCodeEditorIntegration.ts`: 0 changes.
- `chatEditingTextModelChangeService.ts`: 2 commits.
- `chatEditingService.ts`: 5 commits, 11 lines.

Details are in phase0-rendering.md.

## 7. Open questions (build side)

1. **Base channel:** VSCodium **stable** (1.135 today, ~6 weeks behind VS Code) or **insider** (`upstream/insider.json`, newer chat-editing code but more churn)? Recommendation: stable.
2. **Branding:** product name, binary name, data folder, URL protocol, icons. Needed before the first public build.
3. **Signing:** do we have (or will we buy) an Apple Developer ID ($99/yr) and a Windows signing option? Unsigned macOS builds hit Gatekeeper.
4. **CI capacity:** larger GitHub runners, a self-hosted box, or a public build repo (§4)?
5. **Platforms for the MVP:** Linux + macOS (arm64) first, Windows later?
6. **Updates:** ship auto-update via a versions repo from day one, or GitHub Releases only for the MVP?
