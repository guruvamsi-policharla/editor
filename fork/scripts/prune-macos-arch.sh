#!/usr/bin/env bash
# Drop other-platform prebuilt binaries from a macOS .app so every Mach-O in it matches the target arch.
# "Universal" npm packages such as @vscode/ripgrep-universal ship bin/<os>-<arch>/ for every platform and pick
# one at runtime (ripgrep-universal: bin/${process.platform}-${process.arch}/rg, i.e. darwin-arm64 here).
# For any directory in the unpacked node_modules that has a darwin-<arch> child, remove its other <os>-<arch>
# children. Packages without a darwin-<arch> dir are left alone.
#
# Usage: fork/scripts/prune-macos-arch.sh /path/to/editor.app arm64|x64
# bash 3.2 / BSD userland compatible.
set -euo pipefail

APP="${1:?usage: prune-macos-arch.sh /path/to/App.app arm64|x64}"
ARCH="${2:?usage: prune-macos-arch.sh /path/to/App.app arm64|x64}"
ROOT="${APP}/Contents/Resources/app"
[[ -d "${ROOT}" ]] || { echo "not an app bundle: ${APP}" >&2; exit 1; }

find "${ROOT}" -type d -name "darwin-${ARCH}" -path '*node_modules*' | while IFS= read -r keep; do
  parent="$(dirname "${keep}")"
  for d in "${parent}"/*; do
    [[ -d "${d}" ]] || continue
    name="$(basename "${d}")"
    [[ "${name}" == "darwin-${ARCH}" ]] && continue
    if [[ "${name}" =~ ^(darwin|linux|win32|freebsd|openbsd|sunos|aix|android)-(x64|arm64|arm|ia32|ppc64|riscv64|s390x|loong64|universal)$ ]]; then
      echo "prune: ${d#"${ROOT}/"}"
      rm -rf "${d}"
    fi
  done
done
