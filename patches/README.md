# patches/

Core patches against VS Code. They're applied by VSCodium's `prepare_vscode.sh` from its `patches/user/` directory, after all of VSCodium's patches. `fork/scripts/prepare-vscodium.sh` copies them there. Base: VS Code 1.135.0 @ `08d4889f` plus the VSCodium patches at the ref in `fork/upstream.env`.

| Patch | Purpose |
|---|---|
| `90-diff-preserve-short-matching-lines.patch` | New diff option `preserveShortMatchingLines`: don't join hunks separated by short unchanged lines. Off by default, so upstream behavior is unchanged |
| `91-chat-editing-review-hooks.patch` | `ChatEditingTextModelChangeService`: the external-edit predicate gets the content-change event (C3), plus public `extendToSubwords` / `preserveShortMatchingLines` fields (C4). Navigate actions are enabled by `agentReview.isActive` as well as chat (C5) |
| `92-agent-review.patch` | New `src/vs/workbench/contrib/agentReview/` (entry, service, contribution, CSS, tests) plus its import in `workbench.common.main.ts`. Readable copies are in `fork/src/`, and CI checks that they match |
| `93-default-layout.patch` | Secondary side bar hidden by default (it only hosts the hidden chat) |

**Regenerating:** in a prepared tree, reverse-apply our patches (`git apply -R patches/9*.patch`, last one first) and commit that state as a base. Re-apply the patches, make your edits, then run `git add -N src/vs/workbench/contrib/agentReview` and `git diff HEAD -- <paths> > patches/9x-….patch`. Copy the new files back into `fork/src/`. CI's `patches` job checks that the series applies and that the patched tree typechecks.
