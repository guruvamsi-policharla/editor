#!/usr/bin/env bash
# Run the agent-review spike's Electron unit test on a tree prepared by prepare-vscodium.sh.
# Linux needs Xvfb (xvfb-run). Usage: fork/scripts/test-spike.sh [WORKDIR]
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKDIR="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/editor-fork-build}"
cd "${WORKDIR}/vscodium/vscode"
npm run transpile-client          # esbuild transpile of src/ -> out/ (seconds, no type check)
npm run electron                  # fetch the dev Electron into .build/electron
RUN=(./scripts/test.sh --run src/vs/workbench/contrib/agentReview/test/browser/agentReview.test.ts)
if [[ "$(uname)" == "Linux" && -z "${DISPLAY:-}" ]]; then
  VSCODE_SKIP_PRELAUNCH=1 xvfb-run -a "${RUN[@]}"
else
  VSCODE_SKIP_PRELAUNCH=1 "${RUN[@]}"
fi
