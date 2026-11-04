# Architecture

editor is VS Code with VSCodium's build, plus a small set of core patches and two built-in extensions. The review logic lives in a standalone TypeScript library, and core only renders it.

```
 any agent ──writes──▶ disk ◀──watch── built-in extension `agent-review`
                                       │  ReviewEngine (packages/engine):
                                       │  baseline store, pending = disk − baseline,
                                       │  user-save folding, git handling, persistence
                                       │
                _agentReview.setBaseline / remove / clear
                                       ▼
                    core contrib/agentReview (workbench)
                      registers a review session with VS Code's
                      chat-editing UI, which draws hunks, overlay and navigation
                                       │
                agentReview.ext.onDidHunkAction
                                       ▼
                               extension → engine
```

**The engine is authoritative.** Core renders what the extension pushes and reports what the user clicked. The engine has no VS Code dependency.

## Actions

| User action | Core | Extension and engine |
|---|---|---|
| Agent writes a file | The file model reloads from disk | The watcher feeds the engine, which pushes the new baseline when it changes |
| **Keep** a hunk | Edits the baseline model | The engine takes the new baseline. Disk is untouched |
| **Undo** a hunk | Restores the hunk and saves if the buffer was clean, skipping save participants so formatters can't rewrite other agent lines | Nothing to do: disk matches the baseline in that region |
| Typing and saving | Text outside pending changes folds into the baseline. Text on or at the edge of a pending change stays part of it | Save participants record what the user saved, so the save isn't mistaken for an agent edit |
| Another process writes while the buffer has unsaved edits | The buffer is never overwritten. **Merge…** runs a 3-way merge | Listed in Agent Changes |
| Git commit, checkout or stage | Nothing | The engine moves baselines for the affected files |
| Restart | Clears its state at activation | The engine reopens its persisted state, rescans and pushes everything pending |

Created files are reviewed inline. Deleted, renamed, binary and large files are reviewed from the list, with a side-by-side diff.

## What is on disk after Keep and Undo

After Undo, the file on disk matches what you see, so an agent never reads undone text as still there. The one exception is a file with unsaved edits, which is never saved for you.

| Action | No other unsaved edits | Unsaved edits in the buffer |
|---|---|---|
| **Keep** | Disk unchanged; only the baseline moves | The same; your edits stay unsaved |
| **Undo** in the editor | Saved right away | Stays in the buffer until you save |
| **Undo** from the list, or **Undo All** | The engine writes the baseline | Undone in the buffer, not saved. Created files, deleted files and conflicts are skipped, with a message |

## The chat

`extensions/agent-chat` drives VS Code's native chat UI through `packages/acp-client`, which speaks [ACP](https://agentclientprotocol.com). The client advertises no `fs` or `terminal` capability, so the harness edits files with its own tools. Those edits reach review the same way as any other agent's: through the disk.

tact has no ACP mode, so `packages/tact-acp` runs its terminal UI in a hidden pty and bridges ACP to tact's local web API, with one tact process per chat. A new harness would need a profile in `packages/acp-client/src/profiles.ts` and an ACP adapter.

## The build

The fork follows VSCodium's approach: patches, not a source fork.

1. `fork/scripts/prepare-vscodium.sh` fetches VSCodium at the pin in `fork/upstream.env`, and VSCodium's scripts fetch the matching VS Code.
2. Our branding from `fork/branding.env` and `branding/generated` goes over VSCodium's.
3. VSCodium's patches apply, then ours from `patches/`, with `patches/<os>/` for those that differ per OS.
4. `npm ci` runs and the built-in extensions are installed.
5. `fork/scripts/build.sh` compiles and packages the app. `fork/scripts/build-macos.sh` wraps all of this on macOS.

The build leaves out VSCodium's Rust CLI (`code tunnel`), the remote server and enterprise policy files.
