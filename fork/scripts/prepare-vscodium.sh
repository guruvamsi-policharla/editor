#!/usr/bin/env bash
# Fetch VSCodium at a pinned ref, drop our core patches into its official downstream hook
# (patches/user/*.patch, applied last by prepare_vscode.sh), then fetch VS Code at VSCodium's
# pinned commit, apply all patches and run `npm ci`. Result: ./vscodium/vscode is a ready dev tree.
#
# Usage: fork/scripts/prepare-vscodium.sh [WORKDIR]   (default: ~/.cache/editor-fork-build)
# Env:   VSCODIUM_REF (default: master)  MAX_OLD_SPACE_SIZE (default: 8192)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKDIR="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/editor-fork-build}"
VSCODIUM_REF="${VSCODIUM_REF:-master}"

mkdir -p "${WORKDIR}"
cd "${WORKDIR}"
if [[ ! -d vscodium ]]; then
  git clone --depth 1 --branch "${VSCODIUM_REF}" https://github.com/VSCodium/vscodium.git vscodium
fi
cd vscodium

mkdir -p patches/user
cp "${REPO_ROOT}"/patches/*.patch patches/user/

export APP_NAME="VSCodium" ASSETS_REPOSITORY="VSCodium/vscodium" BINARY_NAME="codium" CI_BUILD="no" \
  GH_REPO_PATH="VSCodium/vscodium" ORG_NAME="VSCodium" SHOULD_BUILD="yes" SKIP_ASSETS="yes" \
  VSCODE_LATEST="no" VSCODE_QUALITY="stable" VSCODE_SKIP_NODE_VERSION_CHECK="yes" \
  OS_NAME="${OS_NAME:-linux}" VSCODE_ARCH="${VSCODE_ARCH:-x64}"
export MAX_OLD_SPACE_SIZE="${MAX_OLD_SPACE_SIZE:-8192}"

rm -rf vscode
. get_repo.sh
. version.sh
. prepare_vscode.sh
echo "Prepared: ${WORKDIR}/vscodium/vscode (VS Code ${MS_TAG} @ ${MS_COMMIT} + VSCodium patches + ours)"
