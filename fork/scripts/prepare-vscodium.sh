#!/usr/bin/env bash
# Prepare a patched VS Code tree the VSCodium way:
#   1. fetch VSCodium at the pinned ref (fork/upstream.env)
#   2. drop our core patches, shared and for this OS, into its official downstream hook (patches/user/*.patch, applied last)
#   3. merge our branding (fork/branding.env) into VSCodium's product.json overlay, our icons (branding/generated) over its src/stable
#   4. get_repo.sh + prepare_vscode.sh (VS Code at VSCodium's pinned commit, all patches, npm ci)
#   5. install our built-in extension (fork/scripts/install-extension.sh)
#
# Usage: fork/scripts/prepare-vscodium.sh [--patches-only] [WORKDIR]   (default WORKDIR: ~/.cache/editor-fork-build)
#   --patches-only  stop after applying patches (no npm ci, no extension): the cheap CI patch check.
# Env: VSCODIUM_REF (overrides fork/upstream.env), MAX_OLD_SPACE_SIZE (default 8192),
#      OS_NAME (linux|osx, default: host), VSCODE_ARCH (x64|arm64, default: host).
# bash 3.2 / BSD userland compatible (it runs on stock macOS; so do VSCodium's scripts it sources).
set -euo pipefail

PATCHES_ONLY=no
if [[ "${1:-}" == "--patches-only" ]]; then PATCHES_ONLY=yes; shift; fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORKDIR="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/editor-fork-build}"
# shellcheck source=../upstream.env
. "${REPO_ROOT}/fork/upstream.env"
# shellcheck source=../branding.env
. "${REPO_ROOT}/fork/branding.env"
VSCODIUM_REF="${VSCODIUM_REF_OVERRIDE:-${VSCODIUM_REF}}"

# Host defaults. (No `case` inside `$(...)`: bash 3.2 can't parse its `)` there.)
if [[ -z "${OS_NAME:-}" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then OS_NAME=osx; else OS_NAME=linux; fi
fi
if [[ -z "${VSCODE_ARCH:-}" ]]; then
  if [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]]; then VSCODE_ARCH=arm64; else VSCODE_ARCH=x64; fi
fi

mkdir -p "${WORKDIR}"
cd "${WORKDIR}"
rm -rf vscodium
git init -q vscodium
# shellcheck disable=SC2153 # VSCODIUM_REPO comes from upstream.env
git -C vscodium fetch -q --depth 1 "${VSCODIUM_REPO}" "${VSCODIUM_REF}"
git -C vscodium checkout -q FETCH_HEAD
cd vscodium

# Our patches go last, on top of VSCodium's. patches/<os>/ holds the ones whose context differs per OS.
mkdir -p patches/user
cp "${REPO_ROOT}"/patches/*.patch "${REPO_ROOT}/patches/${OS_NAME}"/*.patch patches/user/

# Icons: prepare_vscode.sh copies src/stable over the VS Code tree.
cp -R "${REPO_ROOT}/branding/generated/." src/stable/

# Branding: prepare_vscode.sh deep-merges ./product.json over the setpath'd values, so ours win.
jq -n --arg name "${APP_NAME}" --arg bin "${BINARY_NAME}" --arg data "${DATA_FOLDER_NAME}" \
  --arg userdata "${USER_DATA_FOLDER_NAME}" --arg proto "${URL_PROTOCOL}" --arg bundle "${DARWIN_BUNDLE_ID}" \
  --arg repo "${GH_REPO_PATH}" '{
    nameShort: $name, nameLong: $name, applicationName: $bin, dataFolderName: $data,
    userDataFolderName: $userdata, linuxIconName: $bin, urlProtocol: $proto, darwinBundleIdentifier: $bundle,
    win32DirName: $name, win32NameVersion: $name, win32ShellNameShort: $name,
    serverApplicationName: ($bin + "-server"), serverDataFolderName: ($data + "-server"),
    tunnelApplicationName: ($bin + "-tunnel"),
    reportIssueUrl: ("https://github.com/" + $repo + "/issues/new"),
    licenseUrl: ("https://github.com/" + $repo + "/blob/main/LICENSE")
  }' > ../product.overlay.json
jq -s '.[0] * .[1]' product.json ../product.overlay.json > product.json.tmp && mv product.json.tmp product.json

export APP_NAME BINARY_NAME ORG_NAME GH_REPO_PATH
export ASSETS_REPOSITORY="${GH_REPO_PATH}" CI_BUILD="${CI_BUILD:-no}" SHOULD_BUILD="yes" SKIP_ASSETS="yes" \
  VSCODE_LATEST="no" VSCODE_QUALITY="stable" VSCODE_SKIP_NODE_VERSION_CHECK="yes" DISABLE_UPDATE="yes" \
  OS_NAME VSCODE_ARCH
export MAX_OLD_SPACE_SIZE="${MAX_OLD_SPACE_SIZE:-8192}"

# VSCodium's scripts are written for `set -e` only.
set +u
rm -rf vscode
. get_repo.sh
# version.sh hashes RELEASE_VERSION with sha1sum and, where that is missing (stock macOS), falls back
# to `npm install -g checksum`. Compute the same value with shasum instead of installing a global package.
if [[ -z "${BUILD_SOURCEVERSION:-}" ]] && ! command -v sha1sum >/dev/null 2>&1; then
  BUILD_SOURCEVERSION="$(echo "${RELEASE_VERSION/-*/}" | shasum -a 1 | cut -d' ' -f1)"
  export BUILD_SOURCEVERSION
fi
. version.sh

if [[ "${PATCHES_ONLY}" == "yes" ]]; then
  # Everything prepare_vscode.sh does before `npm ci`.
  grep -q '^# {{{ install dependencies' prepare_vscode.sh || { echo "prepare_vscode.sh layout changed: no install marker" >&2; exit 1; }
  sed '/^# {{{ install dependencies/,$d' prepare_vscode.sh > prepare_patches_only.sh
  . prepare_patches_only.sh
  echo "Patches applied: ${WORKDIR}/vscodium/vscode (VS Code ${MS_TAG} @ ${MS_COMMIT})"
  exit 0
fi

. prepare_vscode.sh
# prepare_vscode.sh hardcodes this name after its product.json step.
jq --arg name "${APP_NAME}" '.name = $name | .short_name = $name' vscode/resources/server/manifest.json > manifest.json.tmp
mv manifest.json.tmp vscode/resources/server/manifest.json
"${REPO_ROOT}/fork/scripts/install-extension.sh" "${WORKDIR}/vscodium/vscode"
echo "Prepared: ${WORKDIR}/vscodium/vscode (VS Code ${MS_TAG} @ ${MS_COMMIT} + VSCodium patches + ours)"
