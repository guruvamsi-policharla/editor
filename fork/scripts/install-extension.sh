#!/usr/bin/env bash
# Build our built-in extensions (extensions/agent-review, bundled with the engine; optionally the
# agent-chat spike) and copy them into a prepared VS Code tree under extensions/. VS Code's build packages
# every extensions/*/package.json, so no gulp changes are needed. Re-run after changing an extension.
#
# Usage: [EXTENSIONS="agent-review agent-chat"] fork/scripts/install-extension.sh [VSCODE_DIR]
# EXTENSIONS defaults to agent-review only: agent-chat (phase A0 spike) isn't shipped yet.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VSCODE_DIR="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/editor-fork-build/vscodium/vscode}"

cd "${REPO_ROOT}"
[[ -d node_modules ]] || npm ci

for NAME in ${EXTENSIONS:-agent-review}; do
  EXT_SRC="${REPO_ROOT}/extensions/${NAME}"
  npm run build -w "${NAME}"

  DEST="${VSCODE_DIR}/extensions/${NAME}"
  rm -rf "${DEST}"
  mkdir -p "${DEST}"
  # Ship only the bundle and a manifest without npm fields (dependencies are bundled in; VS Code's packaging
  # runs `npm list` on extensions that declare dependencies).
  jq 'del(.dependencies, .devDependencies, .scripts)' "${EXT_SRC}/package.json" > "${DEST}/package.json"
  if [[ -f "${EXT_SRC}/package.nls.json" ]]; then cp "${EXT_SRC}/package.nls.json" "${DEST}/"; fi
  mkdir -p "${DEST}/dist"
  cp "${EXT_SRC}/dist/extension.js" "${DEST}/dist/"
  if [[ -d "${EXT_SRC}/media" ]] && [[ -n "$(ls -A "${EXT_SRC}/media")" ]]; then cp -r "${EXT_SRC}/media" "${DEST}/"; fi
  echo "Installed built-in extension: ${DEST}"
done
