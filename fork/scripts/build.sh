#!/usr/bin/env bash
# Package the app from a tree prepared by prepare-vscodium.sh (VSCodium's build steps, minus its
# release/asset plumbing). Output: ${WORKDIR}/vscodium/VSCode-${OS}-${ARCH} (Linux) or the .app in it (macOS).
# On macOS the .app is ad-hoc signed (fork/scripts/sign-macos-adhoc.sh) so it launches on Apple Silicon.
#
# Usage: fork/scripts/build.sh [WORKDIR]   (default WORKDIR: ~/.cache/editor-fork-build)
# Env: MAX_OLD_SPACE_SIZE (Node heap in MB for gulp; default 7168 on Linux, 8192 on macOS),
#      VSCODE_ARCH (default: host arch).
# bash 3.2 / BSD userland compatible (it runs on stock macOS).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKDIR="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/editor-fork-build}"
# shellcheck source=../branding.env
. "${REPO_ROOT}/fork/branding.env"

case "$(uname -s)" in
  Linux) OS=linux; DEFAULT_HEAP=7168 ;;
  # macOS swaps dynamically, so the cap can exceed what the 7 GB CI runner has free. 6144 was too low:
  # compile-src died at the V8 heap limit with 4.8 GB of RAM still available (see build-macos.yml).
  Darwin) OS=darwin; DEFAULT_HEAP=8192 ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
if [[ -z "${VSCODE_ARCH:-}" ]]; then
  case "$(uname -m)" in
    x86_64 | amd64) VSCODE_ARCH=x64 ;;
    arm64 | aarch64) VSCODE_ARCH=arm64 ;;
    *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
  esac
fi
HEAP="${MAX_OLD_SPACE_SIZE:-${DEFAULT_HEAP}}"

cd "${WORKDIR}/vscodium/vscode"

# VS Code's `npm run gulp` passes --max-old-space-size on the node command line, and prepare_vscode.sh
# bakes MAX_OLD_SPACE_SIZE from *prepare* time into package.json. A command-line flag beats NODE_OPTIONS,
# so set the cap where it is actually read. (Portable sed: write a temp file, no `sed -i`.)
sed -E "s/--max-old-space-size=[0-9]+/--max-old-space-size=${HEAP}/g" package.json > package.json.tmp
mv package.json.tmp package.json
export NODE_OPTIONS="--max-old-space-size=${HEAP}"
echo "== Node heap cap for gulp: ${HEAP} MB"

# Same steps as `gulp vscode-min-prepack` (what VSCodium runs), but one gulp process per step: the
# TypeScript compile's heap is released before esbuild bundles everything, which lowers the peak enough
# for a 16 GB box without swap (and the 8 GB CI runner with swap). A single prepack process got
# OOM-killed in bundle-vscode on the 16 GB box.
gulp_step() { echo "== gulp $1"; npm run gulp "$1"; }
gulp_step compile-build-without-mangling
rm -rf .build/extensions
gulp_step compile-non-native-extensions-build
gulp_step compile-extension-media-build
gulp_step minify-vscode            # bundle-vscode + minify

# As VSCodium's build.sh: drop js-debug's win32-only native module. (Skipped vs. VSCodium: policy
# definitions, the Rust CLI and the remote server; not needed for the desktop MVP.)
rm -f .build/extensions/ms-vscode.js-debug/src/win32-app-container-tokens.*.node

echo "== package (gulp vscode-${OS}-${VSCODE_ARCH}-min-packing)"
npm run gulp "vscode-${OS}-${VSCODE_ARCH}-min-packing"

OUT="${WORKDIR}/vscodium/VSCode-${OS}-${VSCODE_ARCH}"
# As VSCodium's build.sh: give every packaged file a current mtime.
find "${OUT}" -print0 | xargs -0 touch -c
du -sh "${OUT}"

if [[ "${OS}" == "darwin" ]]; then
  echo "== prune other-arch prebuilt binaries (e.g. @vscode/ripgrep-universal/bin/darwin-x64)"
  "${REPO_ROOT}/fork/scripts/prune-macos-arch.sh" "${OUT}/${APP_NAME}.app" "${VSCODE_ARCH}"
  echo "== ad-hoc code signing"
  "${REPO_ROOT}/fork/scripts/sign-macos-adhoc.sh" "${OUT}/${APP_NAME}.app"
fi

echo "== smoke test"
HOST_ARCH="$(uname -m)"; [[ "${HOST_ARCH}" == "x86_64" ]] && HOST_ARCH=x64; [[ "${HOST_ARCH}" == "aarch64" ]] && HOST_ARCH=arm64
if [[ "${HOST_ARCH}" != "${VSCODE_ARCH}" ]]; then
  # Cross-compiled (arm64 on an Intel runner): can't execute it here, so check the main binary's architecture instead.
  if [[ "${OS}" == "darwin" ]]; then
    archs="$(lipo -archs "${OUT}/${APP_NAME}.app/Contents/MacOS/"* 2>/dev/null | head -1)"
    echo "main executable architectures: ${archs}"
    [[ " ${archs} " == *" ${VSCODE_ARCH} "* ]] || { echo "expected ${VSCODE_ARCH} in the main executable, got: ${archs}" >&2; exit 1; }
  fi
elif [[ "${OS}" == "linux" ]]; then
  "${OUT}/bin/${BINARY_NAME}" --version
else
  "${OUT}/${APP_NAME}.app/Contents/Resources/app/bin/${BINARY_NAME}" --version
fi
echo "Built: ${OUT}"
