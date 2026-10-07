#!/usr/bin/env bash
# Run the core unit tests for our patches on a tree prepared by prepare-vscodium.sh:
#   - agentReview Electron tests (src/vs/workbench/contrib/agentReview/test/browser)
#   - upstream chat-editing tests (regression check for the review hooks patch)
#   - upstream diff tests incl. fixtures (regression check for the diff option patch)
# Linux needs Xvfb (xvfb-run). Usage: fork/scripts/test-core.sh [WORKDIR]
set -euo pipefail
WORKDIR="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/editor-fork-build}"
cd "${WORKDIR}/vscodium/vscode"
npm run transpile-client          # esbuild transpile of src/ -> out/ (seconds, no type check)
npm run electron                  # fetch the dev Electron into .build/electron

RUN=(./scripts/test.sh)
for f in src/vs/workbench/contrib/agentReview/test/browser/*.test.ts \
         src/vs/workbench/contrib/chat/test/browser/chatEditing/chatEditingService.test.ts \
         src/vs/workbench/contrib/chat/test/browser/chatEditing/chatEditingActions.test.ts \
         src/vs/workbench/contrib/chat/test/browser/chatEditing/chatEditingModifiedNotebookEntry.test.ts; do
  RUN+=(--run "$f")
done
if [[ "$(uname)" == "Linux" && -z "${DISPLAY:-}" ]]; then
  VSCODE_SKIP_PRELAUNCH=1 xvfb-run -a "${RUN[@]}"
else
  VSCODE_SKIP_PRELAUNCH=1 "${RUN[@]}"
fi

npx mocha test/unit/node/index.js --delay --ui=tdd --timeout=5000 --exit \
  --run src/vs/editor/test/node/diffing/defaultLinesDiffComputer.test.ts \
  --run src/vs/editor/test/node/diffing/fixtures.test.ts
