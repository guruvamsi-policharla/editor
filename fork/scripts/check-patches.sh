#!/usr/bin/env bash
# Apply the whole patch series the way a build does, for every OS: VSCodium's own patches, then its
# OS-specific ones, then ours, with the !!APP_NAME!!-style placeholders filled in, on the pinned VS Code
# commit. VSCodium's patch lists differ per OS, so a patch can apply on Linux and fail on macOS.
# No macOS runner needed: this only runs `git apply`. A series can't be tested with `git apply --check`
# alone (each patch needs the ones before it), so the patches are applied for real in a scratch tree.
#
# Usage: fork/scripts/check-patches.sh [--os osx|linux] [WORKDIR]   (default: both OSes, a temp dir)
#   With a WORKDIR the last tree is left there (linux when checking both), for checks that need a patched tree.
# Env: VSCODIUM_REF_OVERRIDE (see prepare-vscodium.sh). Needs git, jq and node.
# bash 3.2 / BSD userland compatible.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OSES="osx linux"
if [[ "${1:-}" == "--os" ]]; then OSES="$2"; shift 2; fi

if [[ -n "${1:-}" ]]; then
  WORKDIR="$1"
  mkdir -p "${WORKDIR}"
else
  WORKDIR="$(mktemp -d)"
  trap 'rm -rf "${WORKDIR}"' EXIT
fi
LOG="${WORKDIR}/check-patches.log"

for os in ${OSES}; do
  echo "== patch series, OS_NAME=${os}"
  # VSCODE_ARCH is fixed so the result doesn't depend on the machine.
  if OS_NAME="${os}" VSCODE_ARCH=x64 "${REPO_ROOT}/fork/scripts/prepare-vscodium.sh" --patches-only "${WORKDIR}" > "${LOG}" 2>&1; then
    grep '^Patches applied' "${LOG}"
  else
    grep -E '^(error:|failed to apply)' "${LOG}" >&2 || tail -n 20 "${LOG}" >&2
    echo "Patch series does not apply for OS_NAME=${os}." >&2
    exit 1
  fi
done
echo "Patch series applies: ${OSES}"
