#!/usr/bin/env bash
# Lint the core files our patches add or change with VS Code's own ESLint config, in a tree prepared by
# prepare-vscodium.sh (`--patches-only` plus `npm ci --ignore-scripts` is enough). Fails on any warning.
#
# Usage: fork/scripts/lint-core.sh [WORKDIR]   (default WORKDIR: ~/.cache/editor-fork-build)
# - VSCodium deletes extensions/copilot, but VS Code's eslint.config.js imports that extension's lint plugin;
#   an empty stand-in is created for the run (its rules only apply to the deleted copilot sources).
# - `local/code-translation-remind` is off: it asks for new folders to be added to VS Code's translation index
#   (build/lib/i18n.resources.json), which only matters for language packs. Our strings use localize() as usual.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKDIR="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/editor-fork-build}"
cd "${WORKDIR}/vscodium/vscode"

FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(grep -h '^+++ b/' "${REPO_ROOT}"/patches/*.patch "${REPO_ROOT}"/patches/*/*.patch | sed 's|^+++ b/||' | grep '\.ts$' | sort -u)

STUB_DIR=extensions/copilot
if [[ ! -e "${STUB_DIR}" ]]; then
  trap 'rm -rf "${STUB_DIR}"' EXIT
  mkdir -p "${STUB_DIR}/.eslintplugin"
  echo 'export const rules = {};' > "${STUB_DIR}/.eslintplugin/index.ts"
  echo '{ "type": "module" }' > "${STUB_DIR}/.eslintplugin/package.json"
fi

echo "Linting ${#FILES[@]} core files with VS Code's eslint config"
node --max-old-space-size=4096 node_modules/eslint/bin/eslint.js --max-warnings 0 \
  --rule 'local/code-translation-remind: off' "${FILES[@]}"
echo "Core lint: clean"
