# Phase 2: fork + built-in inline review (MVP)

**TL;DR:** The packaged fork ("Editor", binary `editor`, built from VSCodium stable) shows changes that an external agent writes to disk inline in the editor. You get word-level highlights, deleted lines as real rows, and always-visible per-hunk **Keep / Undo** buttons. It also has the file overlay with ↑/↓ navigation, an **Agent Changes** list for all files (including created and deleted ones), and Ctrl/Cmd+Y / Ctrl/Cmd+N. Pending changes persist across restarts. The user's own edits fold into the baseline on save, and git commits and checkouts accept what they move.

The UI is VS Code's chat-editing review UI, fed by our review engine (`packages/engine`) from a built-in extension. VS Code's built-in AI chat stays hidden.

PR dependencies: this branch is `phase-0` (#2) plus a merge of `phase-1-engine` (#1).

## What works end to end (packaged Linux build)

All screenshots come from the packaged `VSCode-linux-x64/editor` built by `fork/scripts/build.sh`. The sample project and the agent edits come from `fork/scripts/simulate-agent.mjs`, which writes to disk while the app runs.

| Screenshot | What it shows |
|---|---|
| [`pending.png`](img/phase2/pending.png) | A live agent write, shown inline. The rewritten words are highlighted within the line (word level), the deleted sentence is a red row, and the inserted paragraph is green. Every hunk has Keep/Undo, and the overlay reads "change 2 of 6" with arrows. The **Agent Changes** list shows four files: deleted, created, and two modified, each with +/− counts |
| [`after-keep.png`](img/phase2/after-keep.png) | After **Keep** on the "eleven of them" hunk: the hunk is gone, the file on disk is unchanged, and the list count drops (+4 −2). The engine's baseline moved (E1) |
| [`after-undo.png`](img/phase2/after-undo.png) | After **Undo** on the intro hunk: the original sentence and the deleted line are back, both in the buffer and **on disk** (saved, no dirty marker). The remaining hunk is untouched and the list reads +2 −0 |
| [`multi-file.png`](img/phase2/multi-file.png) | **Open All Changes**: a multi-file diff of every pending file against its baseline (deleted, created, modified), from the Agent Changes title bar |
| [`created-file.png`](img/phase2/created-file.png) | A file the agent created is reviewed inline as all-green against an empty baseline. Undoing it deletes the file |
| [`after-restart.png`](img/phase2/after-restart.png) | The app is quit and restarted, and the same pending hunk and file list come back (the baselines persist in workspace storage). Changes made while the app was closed are picked up too (integration test) |
| [`agent-terminal.png`](img/phase2/agent-terminal.png) | **Ctrl+L** with lines selected opens the agent terminal, docked to the right of the editor, and types `@paper/main.tex:L20-21` into it. For the screenshot the agent command is `cat`; the default is `tact` |

Also checked by hand in the packaged app:

- The ↑/↓ overlay arrows move between hunks and files with chat disabled.
- Ctrl+Y on a hunk keeps it.
- Typing a sentence on an unchanged line and saving does not create a pending change. The edit folds into the baseline, and the agent's hunks stay as they were.
- No chat view, chat title-bar button or Copilot UI appears. The secondary side bar is hidden.

## How it fits together

```
 external agent ──writes──▶ disk ◀──watch── built-in extension `agent-review` (ext host)
                                            │  ReviewEngine (packages/engine): baseline store, pending = disk − baseline,
                                            │  user-save folding, git HEAD/index handling, persistence
                                            │
                     _agentReview.setBaseline(uri, baselineText, 'modified'|'created')
                     _agentReview.remove(uri) · _agentReview.clear()
                                            ▼
                         core contrib/agentReview (workbench)
                           AgentReviewService ─ registers an IChatEditReviewSession
                           AgentReviewEntry   ─ original = baseline model, modified = the live file model
                           → VS Code's chat-editing review UI renders it (hunk widgets, overlay, nav, view zones)
                                            │
                     agentReview.ext.onDidHunkAction({ uri, kind, baseline? })
                                            ▼
                                     extension → engine
```

The engine is authoritative. Core only renders what the extension pushes and reports what the user clicked.

| User action | Core | Extension / engine |
|---|---|---|
| Agent writes a file | The file model reloads from disk. The entry treats `reloadFromDisk` edits as pending (C3) | The watcher feeds `handleFsEvents`. When the baseline changes, it pushes the new baseline |
| **Keep** a hunk | Edits the baseline model and emits `accepted` with the full new baseline | `engine.setBaselineContent(file, baseline)` (E1). Disk untouched |
| **Undo** a hunk | Restores the hunk in the buffer, then **saves** if the buffer was clean (save participants skipped, so formatters can't rewrite other agent lines). Emits `rejected` | Nothing to do: the engine sees disk == baseline in that region |
| Undo a hunk with unsaved edits | Restores in the buffer, no save | Folded with the user's next save through the edit log (attributed as user edits that touch an agent hunk, so the baseline doesn't move) |
| **Keep** / **Undo** a file (overlay or list) | Keep emits `acceptFile`; Undo restores and saves (modified files) or emits `rejectFile` (created files) | `engine.acceptFile` / `engine.rejectFile` (reject deletes a created file, restores a deleted one) |
| Typing + save | Typing outside hunks folds into the baseline model immediately (upstream behavior). Two save participants bracket all others (format on save, code actions, other extensions): the first records the buffer version, the last calls `agentReview.ext.onWillWrite({ uri, userVersion, version })` right before the write | `reportUserSave(content, edits)`, with edits after `userVersion` tagged `formatter`. User lines fold into the baseline; agent lines stay pending; formatter edits stay pending inside agent hunks and fold in elsewhere (line by line) |
| Agent writes while the buffer is dirty | The buffer is never overwritten | Pushes for that file are deferred until save or revert. A notification offers **Compare** / **Revert to Disk** |
| Git commit / checkout / stage | Nothing | The engine's `checkGit` moves baselines (HEAD move = accept). Entries update or disappear |
| Restart | `_agentReview.clear` at activation | The engine reopens its persisted state, rescans (stat cache), and re-pushes everything pending |

Created files are reviewed inline (baseline `''`). Deleted and renamed files, and binary or large files, are list-only: the side-by-side diff from the baseline, plus Keep/Undo through the engine.

## Scope status

| Item | Status |
|---|---|
| **C1** agentReview contribution wired to the real engine | Done. File watching, folding user edits on save, persistence, and git ops all go through the engine |
| **C3** disk reload vs. user edit | Done. `ChatEditingTextModelChangeService`'s external-edit predicate now gets the content-change event, and the entry tests `detailedReasons` for `reloadFromDisk`. This replaces the spike's listener-order trick |
| **C4** word-level highlights | Done. `extendToSubwords` is passed to the diff, so inner changes are word/subword ranges |
| **C5** nav without chat, `agentReview.isActive` | Done. The ↑/↓ navigate actions are enabled when `chatIsEnabled` **or** `agentReview.isActive` is set; the latter tracks the active editor having pending changes. Keep/Undo labels are unchanged |
| **C6** always-visible hunk buttons | Done. Editors showing a file under review get an `agent-review-editor` class; the hunk toolbar is opacity 0.8, and 1 on hover or with the cursor in the hunk (upstream: hidden until hover) |
| Hunk merging | Done. New diff option `preserveShortMatchingLines` skips the heuristic that joins hunks separated by short unchanged lines (≤4 non-whitespace chars, e.g. a lone `}`), so each hunk can be kept or undone on its own. The default diff behavior is unchanged (all upstream diff fixtures pass) |
| **C8** created / deleted files | Done. Created files inline; deleted (and renamed/binary) in the list with a diff and Keep/Undo |
| **C7** multi-file review | Done, extension-side. The **Agent Changes** view (explorer) lists every file with kind and +/− and has Keep/Undo per file plus Keep All / Undo All. **Open All Changes** opens a multi-file diff (`vscode.changes`). An activity badge shows the file count |
| Agent terminal | Done. **Agent: Open Agent Terminal** starts `agentReview.agent.command` (default `tact`) in a terminal docked right (editor area, beside), or in the panel (`agentReview.agent.location`) |
| Ctrl/Cmd+L | Done. Sends `@relative/path:L42-58` (format: `agentReview.agent.referenceFormat`) to the agent terminal; optionally also the selected text as a bracketed paste (`agentReview.agent.includeSelectedText`) |
| Hide built-in AI chat | Done. `chat.disableAIFeatures` is already true in VSCodium (we also set it as a configuration default), and patch 93 hides the empty secondary side bar by default |
| Dirty-buffer merge view | Not done. A notification with Compare (buffer vs. disk diff) / Revert to Disk replaces it for now |

## Core patches (`patches/`)

They're applied after VSCodium's patches, in this order. Readable copies of the new files live in `fork/src/`, and CI checks that they match.

| Patch | Lines | Upstream files touched |
|---|---|---|
| `90-diff-preserve-short-matching-lines.patch` | +27 −1 (diff option + 2 unit tests) | `linesDiffComputer.ts`, `documentDiffProvider.ts`, `defaultLinesDiffComputer.ts`, the diff test file |
| `91-chat-editing-review-hooks.patch` | +14 −5 | `chatEditingTextModelChangeService.ts` (C3 predicate gets the event; public `extendToSubwords` / `preserveShortMatchingLines`), `chatEditingEditorActions.ts` (C5 precondition) |
| `92-agent-review.patch` | +701: new `contrib/agentReview/` (entry, service, contribution, CSS, 10 tests) + 1 import line in `workbench.common.main.ts` | `workbench.common.main.ts` (1 line) |
| `93-default-layout.patch` | +2 −2 | Secondary side bar hidden by default (`workbench.contribution.ts`, `themeMainServiceImpl.ts`) |

## Engine additions

- **E1 `setBaselineContent(file, content, { expectedBaseline? })`.** It sets the accepted baseline to exact content, as the editor computed it when one hunk was kept. It never touches the disk, `null` makes the file a pending creation, and it persists. There are 5 tests. Because the protocol passes the full baseline, hunk boundaries never have to match between core's diff and the engine's diff.
- **E2 was not needed.** A hunk Undo is a normal buffer edit that core saves. The engine then sees disk == baseline in that region; with unsaved edits, the edit log attributes the restore as user edits overlapping an agent hunk, which leaves the baseline alone. Both paths have tests.
- No other engine changes. The engine's `isFresh` reads the disk between `reportUserSave` and the actual write, which made the save look external. The extension works around this by not querying the engine about a file while its save is in flight (test included). See *Remaining work*.

## Decisions I made

1. **The protocol carries full baseline text, not hunk ids.** Core and engine diffs can disagree on hunk boundaries, but a full-text baseline is always exact. The cost is one string per Keep; fine at this scale.
2. **Undo saves the file (without save participants) when the buffer was clean.** Undo means the agent's text is gone from disk, which is what the reviewer expects. Formatters are skipped so they can't touch other pending agent lines. With unsaved edits we never save for the user.
3. **Created files are inline; deleted, renamed, binary and large files are list-only.** There's nothing to show inline for a deleted file, and VS Code's text model can't host binaries.
4. **File Keep accepts the disk version** (`acceptFile`), so unsaved user edits are never baked into the baseline. They fold in on save like any user edit.
5. **The core bridge is internal commands, not a proposed API.** That means zero extension-host protocol changes. A typed proposal can come later.
6. **The extension ships prebuilt.** `dist/extension.js` is an esbuild bundle that includes the engine, copied into `vscode/extensions/agent-review` by `install-extension.sh` with npm fields stripped from its manifest. No gulp changes.
7. **Branding lives in one place,** `fork/branding.env` (name "Editor", binary `editor`, data folder `.editor`, bundle id `dev.editor.Editor`). Rename there; no icons yet.
8. **The pin lives in `fork/upstream.env`:** VSCodium `5b01560` (VS Code 1.135.0) and Node 24.18.0.
9. **The Agent Changes view goes in the explorer,** below the file tree, rather than in a new activity-bar container. That's one less icon, and the activity badge still shows the count.
10. **Hunk buttons are dimmed to 0.8, not full opacity,** when the pointer isn't in the hunk, so a file with many hunks stays readable.
11. **Nothing is relabeled.** Keep/Undo labels and the Ctrl/Cmd+Y / Ctrl/Cmd+N keybindings are VS Code's own. Ctrl+N (New File) is shadowed only while the cursor is in a hunk, as upstream.

## Remaining work (not in this PR)

- **Engine (Phase 1 follow-up):** make `isFresh` aware of an in-flight `reportUserSave`, so hosts don't need the workaround.
- **Merge view for dirty-buffer conflicts:** a notification with Compare / Revert to Disk stands in for it today.
- **Symlinked workspace roots:** the engine normalizes real paths, but editor URIs can use the link path, so an entry might not match the open editor.
- **Mixed line endings:** the baseline model normalizes EOLs, so a file with mixed CRLF/LF can show a spurious change on Keep.
- **The macOS packaged build hasn't been run.** The workflow exists but wasn't triggered, because macOS minutes bill at 10x on private repos (see CI).
- **Agent terminal race:** Ctrl+L right after the terminal is created can type the reference before the agent command has started, so it lands at the shell prompt. Wait for the command to start, or send only to an existing terminal.
- **Not in the MVP:** a proposed API instead of commands, icons, signing, installers, and auto-update.

## Tests

| Suite | Count | Command |
|---|---|---|
| Engine (vitest) | 144 (11 files, incl. 5 for E1) | `npm test -w @editor/engine` |
| Extension integration (vitest, real engine on temp dirs, fake core) | 16 | `npm test -w agent-review` |
| Core `contrib/agentReview` (Electron) | 10 | `fork/scripts/test-core.sh` |
| Upstream chat-editing regression (Electron) | 49 | `fork/scripts/test-core.sh` |
| Upstream diff + fixtures (node, incl. 2 new) | 125 | `fork/scripts/test-core.sh` |
| Core typecheck of the patched tree (tsgo) | 0 errors | `npm run typecheck-client` (CI `patches` job) |
| Packaged build + smoke (`editor --version`) | ok | `fork/scripts/build.sh` |

## CI

- **`ci.yml` (every push and PR, free runners).** Engine + extension typecheck/build/tests on ubuntu (Node 22 and 24) and macOS (Node 24). The `patches` job runs `prepare-vscodium.sh --patches-only` (our patches apply on top of VSCodium's), checks that `fork/src` matches what the patches create, and typechecks the whole patched `src/` with tsgo after `npm ci --ignore-scripts`. All green on this PR.
- **`build-linux.yml` (full packaged build, pre-merge).** It runs on `workflow_dispatch` (runner label input), when a PR is marked ready for review or labeled `ready-to-merge`, `full-build` or `full-build-linux`, in `merge_group`, and on `v*` tags (which also create a draft GitHub Release with the tarball).
- **`build-macos.yml` (full packaged build, release-only).** It runs only on `v*` tags (creating a draft GitHub Release with the zip) and on `workflow_dispatch`, never on PRs or in the merge queue, because macOS minutes bill at 10x on private repos. Default runners are `ubuntu-latest` / `macos-latest`, overridable via input or `vars.BUILD_RUNNER_LINUX|MACOS`.
- **`upstream-bump.yml` (monthly + manual).** Moves `fork/upstream.env` to the latest VSCodium release, runs the patch check, and opens a PR saying whether the patches apply.

### Does the full build fit the free private-repo runner? Yes, with mitigations

First real run (ubuntu-latest, run 37686371458; job summary numbers):

| | |
|---|---|
| Runner | 2 vCPU, 7 GB RAM; root disk 72 GB with only **14 GB free** before cleanup |
| Free disk (remove preinstalled toolchains) | 4 min 15 s; 14 GB → 50 GB free. **Required:** the tree + output need ~16 GB, plus the 10 GB swap file |
| Swap | 10 GB added; **5.4 GB used at peak**. Required: peak RAM used 7.5 GB, minimum available 270 MB |
| Node heap cap | 7168 MB |
| Prepare (VSCodium + patches + `npm ci` + extension) | 8 min 26 s (cold npm cache) |
| Build (compile + minify + package) | 16 min 37 s |
| Disk at end | 39 GB used, 33 GB free |
| Total wall time | ~30 min |

That run built the app, then failed in the core unit-test step: Electron aborts on Ubuntu 24.04 because AppArmor restricts unprivileged user namespaces (`setuid_sandbox_host.cc: The SUID sandbox helper binary was found, but is not configured correctly`). Fix: `sysctl kernel.apparmor_restrict_unprivileged_userns=0` before the tests. The re-run with that fix and with the split gulp steps **passed end to end** (run 37690533548, label `full-build-linux`):

| Step | Time |
|---|---|
| Free disk | 1 min 44 s |
| Prepare | 8 min 11 s |
| Build (split gulp steps) | 15 min 15 s |
| Core unit tests (Electron, sandbox fix) | 30 s ✅ |
| Smoke test + package + upload | 38 s |
| **Total job** | **27 min 17 s** |

Peak RAM 7.67 GB of 7.9 GB, minimum available 271 MB, peak swap 4.6 GB of 10 GB, disk peak 39 GB used. The artifact `linux-x64` is a 229 MB tarball. So the free 2-vCPU runner is enough, but memory is the tight part: keep the swap file and the heap cap.

Locally (8 vCPU / 16 GB, no swap): prepare 258 s, build 468 s. A single `gulp vscode-min-prepack` process was OOM-killed twice in `bundle-vscode` on that box, so `build.sh` now runs the same steps as separate gulp processes (compile, extensions, media, minify, package). That build succeeded.

macOS is release-only. The first macOS run (triggered by marking PR #3 ready, before this change) failed after about 10 min in the build job; it is unfixed, and the next tag or manual run will show whether it builds. To run it on demand, use `workflow_dispatch`.

## Try it

```bash
fork/scripts/prepare-vscodium.sh            # VSCodium@pin + our patches + npm ci + built-in extension (~4–5 min on 8 cores)
fork/scripts/build.sh                       # packaged app (~8 min on 8 cores)
node fork/scripts/simulate-agent.mjs setup /tmp/agent-demo
~/.cache/editor-fork-build/vscodium/VSCode-linux-x64/bin/editor /tmp/agent-demo
node fork/scripts/simulate-agent.mjs edit /tmp/agent-demo 1   # watch the changes appear; wave 2 adds one more
```
