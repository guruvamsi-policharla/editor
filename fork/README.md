# fork/

Fork-side sources. Core changes ship as patches in [`../patches/`](../patches/), applied by VSCodium's build on top of its own patches. This folder keeps readable copies of new files, plus the scripts that build and test them.

## Phase 0 spike: agent-review rendering

`src/vs/workbench/contrib/agentReview/` is a readable copy of the new files in `patches/90-agent-review-spike.patch`, which targets VS Code `1.135.0` @ `08d4889f`, the commit VSCodium stable pins.

| File | What it does |
|---|---|
| `browser/agentReviewEntry.ts` | `AgentReviewEntry implements IModifiedFileEntry`. Original = engine baseline, held in an in-memory model. Modified = the live file model. It uses `ChatEditingTextModelChangeService` for diff and hunk operations, and `ChatEditingCodeEditorIntegration` for rendering. Disk reloads (`EditSources.reloadFromDisk()`) are treated as agent edits, so they stay pending |
| `browser/agentReviewService.ts` | `AgentReviewService`. Keeps the entries and registers an `IChatEditReviewSession` through `IChatEditingService.registerEditReviewSession`. That registration is what makes the existing review UI (overlay, hunk widgets, keybindings, explorer badges) pick them up |
| `browser/agentReview.contribution.ts` | The bridge for the built-in extension: `_agentReview.setBaseline(uri, text)` and `_agentReview.remove(uri)` in, `agentReview.ext.onDidHunkAction` out. Also the demo command **Agent Review: Show Sample Pending Change (spike)**, which shows a hardcoded deleted block as red rows with Accept/Reject |
| `test/browser/agentReview.test.ts` | Electron unit test: a view zone with the deleted rows, a per-hunk widget, accept, reject, and disk reload vs. user typing. 6/6 pass |

The patch also adds one import line to `src/vs/workbench/workbench.common.main.ts`.

### Reproduce

```bash
# needs: node 24, python3, gcc/g++/make, pkg-config, libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev, jq, xvfb
fork/scripts/prepare-vscodium.sh          # ~5 min on 8 cores (clone + VSCodium patches + ours + npm ci)
fork/scripts/test-spike.sh                # ~15 s
fork/scripts/build-linux.sh               # ~8 min, ~7.3 GB peak RSS: packaged VSCode-linux-x64/codium
```

To try the demo by hand, open a file in the packaged `VSCode-linux-x64/codium` and run the command. Or, in a dev build: after `prepare-vscodium.sh`, run `npm run transpile-client && ./scripts/code.sh` in `~/.cache/editor-fork-build/vscodium/vscode`. Then open any text file and run **Agent Review: Show Sample Pending Change (spike)** from the Command Palette.

See [`../docs/phase0-rendering.md`](../docs/phase0-rendering.md) for the decision and [`../docs/fork-build.md`](../docs/fork-build.md) for the build.
