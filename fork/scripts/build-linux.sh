#!/usr/bin/env bash
# Build a Linux x64 desktop package from a tree prepared by prepare-vscodium.sh.
# Mirrors VSCodium's build.sh for linux minus REH/REH-web and the Rust CLI.
# Output: ${WORKDIR}/vscodium/VSCode-linux-x64/ (~1 GB). Needs ~8 GB free RAM for gulp.
#
# Usage: fork/scripts/build-linux.sh [WORKDIR]
set -euo pipefail
WORKDIR="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/editor-fork-build}"
cd "${WORKDIR}/vscodium/vscode"
export NODE_OPTIONS="--max-old-space-size=${MAX_OLD_SPACE_SIZE:-7168}"
export VSCODE_PUBLISH_COUNTER=1

t0=$(date +%s)
npm run gulp vscode-min-prepack
t1=$(date +%s); echo "STAGE vscode-min-prepack: $((t1-t0))s"
# same cleanup VSCodium's build.sh does before packaging
rm -f .build/extensions/ms-vscode.js-debug/src/win32-app-container-tokens.*.node
npm run gulp vscode-linux-x64-min-packing
t2=$(date +%s); echo "STAGE vscode-linux-x64-min-packing: $((t2-t1))s"
du -sh ../VSCode-linux-x64
../VSCode-linux-x64/bin/codium --version
