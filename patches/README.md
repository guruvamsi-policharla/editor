# patches/

Core patches against VS Code, applied by VSCodium's `prepare_vscode.sh` from its `patches/user/` directory, after all VSCodium patches. `fork/scripts/prepare-vscodium.sh` copies them there.

| Patch | Base | Purpose |
|---|---|---|
| `90-agent-review-spike.patch` | VS Code 1.135.0 @ `08d4889f` (+ VSCodium patches) | Phase 0 spike: `contrib/agentReview` (renders engine baselines through the chat-editing review UI) + 1 registration line |

Conventions for Phase 2:
- One patch per concern, numbered `9x-agent-review-*.patch`.
- New files go under `src/vs/workbench/contrib/agentReview/`. Keep changes to upstream files minimal, and list each one in `docs/phase0-rendering.md` ("Required core changes").
- Regenerate a patch with `git diff` in the prepared tree, then check it with `git apply --check` against a fresh `prepare-vscodium.sh` run (CI does this; see `docs/fork-build.md`).
