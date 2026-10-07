#!/usr/bin/env bash
# Package the app from a tree prepared by prepare-vscodium.sh (VSCodium's build steps, minus its
# release/asset plumbing). Output: ${WORKDIR}/vscodium/VSCode-${OS}-${ARCH} (Linux) or the .app in it (macOS).
#
# Usage: fork/scripts/build.sh [WORKDIR]   (default WORKDIR: ~/.cache/editor-fork-build)
# Env: MAX_OLD_SPACE_SIZE (Node heap in MB for gulp, default 7168), VSCODE_ARCH (default: host arch).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKDIR="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/editor-fork-build}"
# shellcheck source=../branding.env
. "${REPO_ROOT}/fork/branding.env"

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
if [[ -z "${VSCODE_ARCH:-}" ]]; then
  case "$(uname -m)" in
    x86_64 | amd64) VSCODE_ARCH=x64 ;;
    arm64 | aarch64) VSCODE_ARCH=arm64 ;;
    *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
  esac
fi

export NODE_OPTIONS="--max-old-space-size=${MAX_OLD_SPACE_SIZE:-7168}"
cd "${WORKDIR}/vscodium/vscode"

echo "== compile + minify (gulp vscode-min-prepack)"
npm run gulp vscode-min-prepack

# As VSCodium's build.sh: drop js-debug's win32-only native module. (Skipped vs. VSCodium: policy
# definitions, the Rust CLI and the remote server; not needed for the desktop MVP.)
rm -f .build/extensions/ms-vscode.js-debug/src/win32-app-container-tokens.*.node

echo "== package (gulp vscode-${OS}-${VSCODE_ARCH}-min-packing)"
npm run gulp "vscode-${OS}-${VSCODE_ARCH}-min-packing"

OUT="${WORKDIR}/vscodium/VSCode-${OS}-${VSCODE_ARCH}"
du -sh "${OUT}"

echo "== smoke test"
if [[ "${OS}" == "linux" ]]; then
  "${OUT}/bin/${BINARY_NAME}" --version
else
  "${OUT}/${APP_NAME}.app/Contents/Resources/app/bin/${BINARY_NAME}" --version
fi
echo "Built: ${OUT}"
