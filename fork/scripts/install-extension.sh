#!/usr/bin/env bash
# Build our built-in extension (extensions/agent-review, bundled with the engine) and copy it into a
# prepared VS Code tree as extensions/agent-review. VS Code's build packages every extensions/*/package.json,
# so no gulp changes are needed. Re-run after changing the extension.
#
# Usage: fork/scripts/install-extension.sh [VSCODE_DIR]
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VSCODE_DIR="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/editor-fork-build/vscodium/vscode}"
EXT_SRC="${REPO_ROOT}/extensions/agent-review"

cd "${REPO_ROOT}"
[[ -d node_modules ]] || npm ci
npm run build -w agent-review

DEST="${VSCODE_DIR}/extensions/agent-review"
rm -rf "${DEST}"
mkdir -p "${DEST}"
# Ship only the bundle and a manifest without npm fields (the engine is bundled in; VS Code's packaging
# runs `npm list` on extensions that declare dependencies).
jq 'del(.dependencies, .devDependencies, .scripts)' "${EXT_SRC}/package.json" > "${DEST}/package.json"
cp "${EXT_SRC}/package.nls.json" "${DEST}/"
mkdir -p "${DEST}/dist"
cp "${EXT_SRC}/dist/extension.js" "${DEST}/dist/"
if [[ -d "${EXT_SRC}/media" ]] && [[ -n "$(ls -A "${EXT_SRC}/media")" ]]; then cp -r "${EXT_SRC}/media" "${DEST}/"; fi
echo "Installed built-in extension: ${DEST}"
