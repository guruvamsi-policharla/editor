# Phase 2: fork + built-in inline review (MVP)

**TL;DR:** The packaged fork ("Editor", binary `editor`, built from VSCodium stable) shows changes that an external agent writes to disk inline in the editor. You get word-level highlights, deleted lines as real rows, and always-visible per-hunk **Keep / Undo** buttons. It also has the file overlay with ↑/↓ navigation, an **Agent Changes** list for all files (including created and deleted ones), and Ctrl/Cmd+Y / Ctrl/Cmd+N. Pending changes persist across restarts. The user's own edits fold into the baseline on save, and git commits and checkouts accept what they move.

The UI is VS Code's chat-editing review UI, fed by our review engine (`packages/engine`) from a built-in extension. VS Code's built-in AI chat stays hidden.

PR dependencies: this branch is `phase-0` (#2) plus a merge of `phase-1-engine` (#1).

## What works end to end (packaged Linux build)

All screenshots come from the packaged `VSCode-linux-x64/editor` built by `fork/scripts/build.sh`. The sample project and the agent edits come from `fork/scripts/simulate-agent.mjs`, which writes to disk while the app runs. The first four are from the final smoke run on this branch (`scripts/demo-agent.sh`); the others are from the earlier phase-2 run, so they still show the old floating hunk toolbar.

| Screenshot | What it shows |
|---|---|
| [`pending.png`](img/phase2/pending.png) | The try-it demo (`scripts/demo-agent.sh` on `examples/paper`, opened through a symlinked folder): a deleted sentence as a red row, an added `\input` line, and a changed result with word-level highlights (`0.6`→`0.4`, "most of"). Each hunk has Keep/Undo in its own row below it; the overlay reads "3 of 6" across the files |
| [`after-keep.png`](img/phase2/after-keep.png) | After **Ctrl+Y** on the `\input{sections/related}` line: that change is gone and the file on disk is unchanged (the engine's baseline moved). Packaged-app smoke check |
| [`after-undo.png`](img/phase2/after-undo.png) | After **Ctrl+N** on the changed result: the original sentence is back in the buffer **and on disk** right away (no unsaved marker; the smoke script checks the file). The deleted abstract sentence is still pending |
| [`narrow-agent-terminal.png`](img/phase2/narrow-agent-terminal.png) | A narrow editor with the Agent Terminal docked right (after **Ctrl+L** sent `@sections/intro.tex:L2` to it): the Keep/Undo rows never cover the text |
| [`multi-file.png`](img/phase2/multi-file.png) | **Open All Changes**: a multi-file diff of every pending file against its baseline (deleted, created, modified), from the Agent Changes title bar |
| [`created-file.png`](img/phase2/created-file.png) | A file the agent created is reviewed inline as all-green against an empty baseline. Undoing it deletes the file |
| [`after-restart.png`](img/phase2/after-restart.png) | The app is quit and restarted, and the same pending hunk and file list come back (the baselines persist in workspace storage). Changes made while the app was closed are picked up too (integration test) |
| [`agent-terminal.png`](img/phase2/agent-terminal.png) | **Ctrl+L** with lines selected opens the agent terminal, docked to the right of the editor, and types `@paper/main.tex:L20-21` into it. For the screenshot the agent command is `cat`; the default is `tact` |

### polish-1 (packaged build, the generated 739-line paper in `/workspace/cc/polish-1-smoke`)

| Screenshot | What it shows |
|---|---|
| [`before-prose.png`](img/polish-1/before-prose.png) | **Before** (phase-2-finish build, word wrap on): a two-phrase edit shows the whole paragraph in red and again in green, the red rows are cut off at the edge (no wrap), and every hunk has a Keep/Undo row |
| [`after-prose.png`](img/polish-1/after-prose.png) | **After**, same edits: the reword and the equation change are track changes in the line, the deleted paragraph wraps, Keep/Undo sit at the end of each hunk's last row |
| [`after-rename-light.png`](img/polish-1/after-rename-light.png) | A rename `x`→`y` across the paper in the light theme: one struck red `x` and a green `y` per occurrence, no extra rows; the long equation line gets its own Keep/Undo row |
| [`after-narrow-agent-terminal.png`](img/polish-1/after-narrow-agent-terminal.png) | Narrow editor next to the Agent Terminal after **Ctrl+L** (`@sections/prelims.tex:L20`) |
| [`after-ctrlz-undo.png`](img/polish-1/after-ctrlz-undo.png) | **Ctrl+Z** after Undo on the equation: the agent's text is back, pending, and on disk (clean tab) |

Also checked by hand in the packaged app:

- The ↑/↓ overlay arrows move between hunks and files with chat disabled.
- Ctrl+Y on a hunk keeps it. (Fixed in phase-2-finish: this only worked reliably with a single reviewed file per editor group; see the context-key commit.)
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
| Undo a file from the list, or **Undo All**, with unsaved edits | `_agentReview.reject` undoes it in the buffer like the overlay's file Undo: text the user typed outside the changes stays, nothing is saved | Never writes the file behind the editor. Says the undo is in the editor only until the user saves. Created/deleted files with unsaved edits, and files whose disk changed under the unsaved edits (merge first), are refused/skipped |
| Typing + save | Typing outside hunks folds into the baseline model immediately (upstream behavior). Two save participants bracket all others (format on save, code actions, other extensions): the first records the buffer version, the last calls `agentReview.ext.onWillWrite({ uri, userVersion, version })` right before the write | `reportUserSave(content, edits)`, with edits after `userVersion` tagged `formatter`. User lines fold into the baseline; agent lines stay pending; formatter edits stay pending inside agent hunks and fold in elsewhere (line by line) |
| Agent writes while the buffer is dirty | The buffer is never overwritten. **Merge…** (notification, or *Agent Review: Merge Agent's Version with Unsaved Edits*) runs `_agentReview.openMerge`: both versions are snapshotted, the buffer reloads from disk, and VS Code's 3-way merge editor opens on its own auto-merge (base = the text both sides started from, Agent = disk, Yours = the buffer, result = the file). Nothing is written until **Complete Merge** | Pushes for that file are deferred until save or revert. A save of the stale buffer isn't attributed. The merge result is attributed by diffing against the disk (agent lines stay pending, the user's fold in). Both versions are also copied to `conflicts/` in workspace storage (kept 7 days), and closing the merge without saving points to the user's copy |
| Git commit / checkout / stage | Nothing | The engine's `checkGit` moves baselines (HEAD move = accept). Entries update or disappear |
| Restart | `_agentReview.clear` at activation | The engine reopens its persisted state, rescans (stat cache), and re-pushes everything pending |

Created files are reviewed inline (baseline `''`). Deleted and renamed files, and binary or large files, are list-only: the side-by-side diff from the baseline, plus Keep/Undo through the engine.

## What is on disk after Keep and Undo

The rule: after Undo, the file on disk matches what the user sees (as in Cursor), so an agent that reads the file never reads undone text as still there. The one exception is a file the user also has unsaved edits in: it is never saved for them.

| Action | Buffer had no other unsaved edits | Buffer had unsaved user edits |
|---|---|---|
| **Keep** (hunk, file, all) | Disk unchanged: the agent's text is already there. Only the baseline moves | Same; the user's edits stay unsaved |
| **Undo** a hunk, or a file in the editor | The baseline text goes back into the buffer, which is **saved right away** (without save participants, so formatters can't touch other pending lines). Disk = what you see | The undo stays **in the buffer**, which stays dirty; it reaches the disk with the user's next save (and is attributed correctly then). Until then the agent still sees its own text on disk |
| **Undo** from the list / **Undo All** | The engine writes the baseline (or deletes a created file, restores a deleted one) | Undone in the buffer as above, not saved. Created/deleted files and files in conflict are skipped, with a message |

**Ctrl/Cmd+Z** takes a Keep or an Undo back. After a Keep (a hunk, or a file from the overlay), the change is up for review again: the engine's baseline goes back to what it was, and the disk isn't touched. After an Undo, the agent's text comes back as a pending change, and it's saved if the Undo was saved. Redo repeats the Keep or Undo. Before this, Ctrl+Z after Keep undid the agent's last write in the buffer instead, and Ctrl+Z after Undo brought the agent's text back as if the user had typed it, so it was accepted on the next save.

If the save after an Undo fails or is cancelled (disk full, permissions, a newer version on disk), a warning says the undo isn't on disk yet and offers **Save**. Two Undos in quick succession both get saved, even while the first save is still running.

## Scope status

| Item | Status |
|---|---|
| **C1** agentReview contribution wired to the real engine | Done. File watching, folding user edits on save, persistence, and git ops all go through the engine |
| **C3** disk reload vs. user edit | Done. `ChatEditingTextModelChangeService`'s external-edit predicate now gets the content-change event, and the entry tests `detailedReasons` for `reloadFromDisk`. This replaces the spike's listener-order trick |
| **C4** word-level highlights | Done. `extendToSubwords` is passed to the diff, so inner changes are word/subword ranges. A hunk that changes only a few words within its lines (at most 30% of their text, every change within one line) is shown as track changes: the deleted words struck through in red right before the new ones, in the line itself, instead of the whole lines again in red above. Larger rewrites keep the red rows. Opt-in per entry (`trackChanges`) |
| **C5** nav without chat, `agentReview.isActive` | Done. The ↑/↓ navigate actions are enabled when `chatIsEnabled` **or** `agentReview.isActive` is set; the latter tracks the active editor having pending changes. Keep/Undo labels and keybindings are unchanged; the chat wording around them is agent-review wording: "Go to Next/Previous Agent Change", "Keep/Undo Agent Changes (in this File)", "Keep All Agent Changes", "Toggle Diff Editor / Show Accessible Diff View for Agent Changes", the diff title "file (agent changes)" and the explorer tooltip "Pending agent changes". All of them are in the **Agent Review** palette category (upstream: "Chat"), next to the extension's commands |
| **C6** always-visible hunk buttons | Done. Each hunk's Keep/Undo toolbar is always visible and never covers text. It sits at the right end of the hunk's last row when that row leaves room for it (the short last row of a wrapped paragraph, an equation, the last red row of a deletion), and otherwise gets its own row (a view zone) directly below the hunk, aligned with the start of the text. Upstream floats it over the hunk's first line, at the right edge, on hover only, which covered text in narrow editors. The room is estimated from the editor's own line breaks and the font's character width (exact for monospace fonts). Plain buttons (Keep primary, Undo secondary), opacity 0.85, and 1 on hover or with the cursor in the hunk. Opt-in per entry (`hunkToolbarRows`), so chat sessions keep the upstream placement |
| Hunk merging | Done. New diff option `preserveShortMatchingLines` skips the heuristic that joins hunks separated by short unchanged lines (≤4 non-whitespace chars, e.g. a lone `}`), so each hunk can be kept or undone on its own. The default diff behavior is unchanged (all upstream diff fixtures pass) |
| **C8** created / deleted files | Done. Created files inline; deleted (and renamed/binary) in the list with a diff and Keep/Undo |
| **C7** multi-file review | Done, extension-side. The **Agent Changes** view (explorer) lists every file with kind and +/− and has Keep/Undo per file plus Keep All / Undo All. **Open All Changes** opens a multi-file diff (`vscode.changes`). An activity badge shows the file count |
| Agent terminal | Done. **Agent: Open Agent Terminal** starts `agentReview.agent.command` (default `tact`) in a terminal docked right (editor area, beside), or in the panel (`agentReview.agent.location`) |
| Ctrl/Cmd+L | Done. Sends `@relative/path:L42-58` (format: `agentReview.agent.referenceFormat`) to the agent terminal; optionally also the selected text as a bracketed paste (`agentReview.agent.includeSelectedText`). In a new terminal the agent command runs through shell integration, and the text waits until the shell reports the command started (timeouts: 3 s for shell integration, then the command is typed and the text follows 1 s later; 5 s for the start report) |
| Hide built-in AI chat | Done. `chat.disableAIFeatures` is already true in VSCodium (we also set it as a configuration default), and patch 93 hides the empty secondary side bar by default |
| Symlinked folders and files (task e) | Done. The engine tracks each file once, under its real path; watcher events, saves and Keep/Undo arrive by either path and are normalized. Everything handed to VS Code (inline review, the list, diffs, the merge) uses the path under the workspace folder as it was opened, so a folder opened through a link (e.g. `/tmp/…` on macOS, which is `/private/tmp/…`) reviews inline in the editor the user has open. Dirty checks compare real paths. Limits: a file opened by the path of a symlink *inside* the workspace isn't shown inline (it's in the list, and opening it from there shows it inline); link targets outside every workspace folder aren't tracked |
| Dirty-buffer merge view | Done. VS Code's 3-way merge editor (see the table above); no side is ever written over without the user completing the merge |

## Core patches (`patches/`)

They're applied after VSCodium's patches, in this order. Readable copies of the new files live in `fork/src/`, and CI checks that they match.

| Patch | Lines | Upstream files touched |
|---|---|---|
| `90-diff-preserve-short-matching-lines.patch` | +32 −1 (diff option + 2 unit tests) | `linesDiffComputer.ts`, `documentDiffProvider.ts`, `defaultLinesDiffComputer.ts`, the diff test file |
| `91-chat-editing-review-hooks.patch` | +310 −36 | `chatEditingTextModelChangeService.ts` (C3 predicate gets the event; public `extendToSubwords` / `preserveShortMatchingLines`), `chatEditingEditorActions.ts` (C5 precondition; agent-review titles and the "Agent Review" category; 3 classes exported for tests), `chatEditingCodeEditorIntegration.ts` (hunk toolbar at the end of the last row or in its own row, opt-in via `hunkToolbarRows`; track changes, opt-in via `trackChanges`; deleted lines wrap), `chatEditingCodeEditorIntegration.ts` / `chatEditingNotebookEditorIntegration.ts` (diff title; the cursor-in-change context key per editor), `chatEditingServiceImpl.ts` (explorer tooltip) |
| `92-agent-review.patch` | +1812 (incl. blank lines): new `contrib/agentReview/` (entry, service, contribution, save-attribution participants, 3-way merge, CSS, 28 tests in 3 files) + 1 import line in `workbench.common.main.ts` | `workbench.common.main.ts` (1 line) |
| `93-default-layout.patch` | +2 −2 | Secondary side bar hidden by default (`workbench.contribution.ts`, `themeMainServiceImpl.ts`) |

## Engine additions

- **E1 `setBaselineContent(file, content, { expectedBaseline? })`.** It sets the accepted baseline to exact content, as the editor computed it when one hunk was kept. It never touches the disk, `null` makes the file a pending creation, and it persists. There are 5 tests. Because the protocol passes the full baseline, hunk boundaries never have to match between core's diff and the engine's diff.
- **`setBaselineContent(..., { restoreLineEndings: true })`.** VS Code's models keep one EOL per file, so the baseline a Keep sends back has lost a mixed CRLF/LF file's per-line endings. With this option each line takes its ending from the matching line on disk, else in the old baseline. Likewise `reportUserSave` attributes a save that VS Code wrote back with one EOL against the EOL-converted disk and baseline: the conversion folds in, and agent lines aren't mistaken for user rewrites (before, the edit log failed to replay and the agent's hunks were folded in).
- **E2 was not needed.** A hunk Undo is a normal buffer edit that core saves. The engine then sees disk == baseline in that region; with unsaved edits, the edit log attributes the restore as user edits overlapping an agent hunk, which leaves the baseline alone. Both paths have tests.
- **Saves in flight.** Between `reportUserSave` and the editor's write, the disk still has the old content. The engine now remembers the reported save: while the file is exactly as it was when the save was reported (same content and stat, within 10 s), freshness checks, `getFileChange` and `acceptFile` use the saved content instead of calling the old disk an external change. A watcher event for the path, any other disk content, or the timeout ends it. The extension's workaround (not querying the engine about a file while its save was in flight) is gone.

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
10. **Hunk buttons float at the end of the hunk when there's room, else get their own row.** The phase-2-finish build always gave them a row below the hunk. With track changes most prose hunks are a single paragraph line, and that row was a large part of each hunk's height (a rename across a paper added dozens of rows). At the end of the last row they cost nothing and sit where Cursor puts them. When the last row runs to the edge (a long unwrapped line, a narrow editor next to the docked agent terminal) they still get their own row, so they never hide text. They are dimmed slightly (0.85) except for the hunk with the cursor or the pointer.
11. **Nothing is relabeled.** Keep/Undo labels and the Ctrl/Cmd+Y / Ctrl/Cmd+N keybindings are VS Code's own. Ctrl+N (New File) is shadowed only while the cursor is in a hunk, as upstream.

## Remaining work (not in this PR)

- **The macOS build hasn't run on a Mac yet.** `fork/scripts/build-macos.sh` ([build-macos.md](build-macos.md)) was checked under bash 3.2 with stubbed macOS tools only. The release-only workflow, which now runs that script with the heap fix, hasn't been triggered (macOS minutes bill at 10x on private repos).
- **Not in the MVP:** a proposed API instead of commands, icons, signing, installers, and auto-update.

## Tests

| Suite | Count | Command |
|---|---|---|
| Engine (vitest) | 162 (14 files) | `npm test -w @editor/engine` |
| Extension integration (vitest, real engine on temp dirs, fake core / fake terminal) | 36 | `npm test -w agent-review` |
| Core `contrib/agentReview` (Electron) | 28 | `fork/scripts/test-core.sh` |
| Upstream chat-editing regression (Electron) | 49 | `fork/scripts/test-core.sh` |
| Upstream diff + fixtures (node, incl. 2 new) | 125 | `fork/scripts/test-core.sh` |
| Core typecheck of the patched tree (tsgo) | 0 errors | `npm run typecheck-client` (CI `patches` job) |
| Packaged build + smoke (`editor --version`) | ok | `fork/scripts/build.sh` |
| Lint: repo TypeScript (VS Code's generic rules) / core files (VS Code's own config) | 0 problems / 0 warnings | `npm run lint` / `fork/scripts/lint-core.sh` |
| Shell scripts (shellcheck; bash 3.2 syntax on macOS) | clean | CI `shellcheck` job, macOS `test` job |

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

On macOS: `fork/scripts/build-macos.sh --install` ([build-macos.md](build-macos.md)). For a two-minute demo without an agent, see the README ("Try it": `scripts/demo-agent.sh`). On Linux:

```bash
fork/scripts/prepare-vscodium.sh            # VSCodium@pin + our patches + npm ci + built-in extension (~4–5 min on 8 cores)
fork/scripts/build.sh                       # packaged app (~8 min on 8 cores)
node fork/scripts/simulate-agent.mjs setup /tmp/agent-demo
~/.cache/editor-fork-build/vscodium/VSCode-linux-x64/bin/editor /tmp/agent-demo
node fork/scripts/simulate-agent.mjs edit /tmp/agent-demo 1   # watch the changes appear; wave 2 adds one more
```
