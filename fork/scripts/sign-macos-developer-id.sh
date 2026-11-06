#!/usr/bin/env bash
# Developer ID Application sign an .app for distribution (hardened runtime + entitlements).
# Imports MACOS_CERTIFICATE_P12 (base64) into a temporary keychain, signs nested helpers
# inside-out (not blind --deep), then the outer .app. Cleans the keychain on exit.
#
# Required env:
#   MACOS_CERTIFICATE_P12       base64-encoded .p12
#   MACOS_CERTIFICATE_PASSWORD  .p12 password
# Optional env:
#   APPLE_TEAM_ID               preferred team id when multiple identities exist (e.g. 648H7CRP9Q)
#   CODESIGN_IDENTITY           override (SHA-1 or "Developer ID Application: …")
#
# Usage: fork/scripts/sign-macos-developer-id.sh /path/to/editor.app
# bash 3.2 / BSD userland compatible. Must run on macOS.
set -euo pipefail

APP="${1:?usage: sign-macos-developer-id.sh /path/to/App.app}"
[[ "$(uname -s)" == "Darwin" ]] || { echo "Developer ID signing requires macOS" >&2; exit 1; }
[[ -d "${APP}/Contents/MacOS" ]] || { echo "not an app bundle: ${APP}" >&2; exit 1; }
: "${MACOS_CERTIFICATE_P12:?MACOS_CERTIFICATE_P12 (base64) is required}"
: "${MACOS_CERTIFICATE_PASSWORD:?MACOS_CERTIFICATE_PASSWORD is required}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENT_DIR="${REPO_ROOT}/fork/macos"
[[ -f "${ENT_DIR}/entitlements.app.plist" ]] || { echo "missing entitlements under fork/macos/" >&2; exit 1; }

TMPDIR_SIGN="$(mktemp -d "${TMPDIR:-/tmp}/editor-codesign.XXXXXX")"
KEYCHAIN="${TMPDIR_SIGN}/buildagent.keychain"
P12_FILE="${TMPDIR_SIGN}/certificate.p12"
KEYCHAIN_PASSWORD="$(openssl rand -base64 24)"
ORIGINAL_KEYCHAINS=()
CLEANED=0

cleanup() {
  if [[ "${CLEANED}" -eq 1 ]]; then return; fi
  CLEANED=1
  # create-keychain may store "foo.keychain" as "foo.keychain-db"; delete whichever exists.
  local kc
  for kc in "${KEYCHAIN}" "${KEYCHAIN}-db"; do
    if [[ -e "${kc}" ]]; then
      security delete-keychain "${kc}" >/dev/null 2>&1 || true
    fi
  done
  if [[ ${#ORIGINAL_KEYCHAINS[@]} -gt 0 ]]; then
    security list-keychains -d user -s "${ORIGINAL_KEYCHAINS[@]}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TMPDIR_SIGN}"
}
trap cleanup EXIT

entitlements_for() {
  # $1 = path of nested .app or binary; pick a VS Code-style entitlements plist.
  case "$1" in
    *" Helper (Plugin).app"*) echo "${ENT_DIR}/entitlements.helper-plugin.plist" ;;
    *" Helper (GPU).app"*) echo "${ENT_DIR}/entitlements.helper-gpu.plist" ;;
    *" Helper (Renderer).app"*) echo "${ENT_DIR}/entitlements.helper-renderer.plist" ;;
    *" Helper.app"*) echo "${ENT_DIR}/entitlements.helper.plist" ;;
    *) echo "${ENT_DIR}/entitlements.app.plist" ;;
  esac
}

sign_one() {
  # $1 = path, $2 = entitlements plist
  local target="$1" ents="$2"
  codesign --force --options runtime --timestamp \
    --entitlements "${ents}" \
    --sign "${CODESIGN_IDENTITY}" \
    "${target}"
}

echo "+ create temporary keychain"
ORIGINAL_KEYCHAINS=()
while IFS= read -r kc_line; do
  kc_line="$(printf '%s' "${kc_line}" | sed -E 's/^[[:space:]]*"?//; s/"?[[:space:]]*$//')"
  [[ -n "${kc_line}" ]] && ORIGINAL_KEYCHAINS+=("${kc_line}")
done < <(security list-keychains -d user)
security create-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN}"
security set-keychain-settings -lut 21600 "${KEYCHAIN}"
security unlock-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN}"
security list-keychains -d user -s "${KEYCHAIN}" ${ORIGINAL_KEYCHAINS[@]+"${ORIGINAL_KEYCHAINS[@]}"}

echo "+ import Developer ID certificate"
printf '%s' "${MACOS_CERTIFICATE_P12}" | base64 --decode > "${P12_FILE}"
security import "${P12_FILE}" -k "${KEYCHAIN}" -P "${MACOS_CERTIFICATE_PASSWORD}" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "${KEYCHAIN_PASSWORD}" "${KEYCHAIN}" >/dev/null
rm -f "${P12_FILE}"

if [[ -z "${CODESIGN_IDENTITY:-}" ]]; then
  # Prefer a Developer ID Application identity; optionally filter by team id.
  id_lines="$(security find-identity -v -p codesigning "${KEYCHAIN}" || true)"
  if [[ -n "${APPLE_TEAM_ID:-}" ]]; then
    CODESIGN_IDENTITY="$(printf '%s\n' "${id_lines}" | grep 'Developer ID Application' | grep "${APPLE_TEAM_ID}" | head -n 1 | sed -E 's/^[[:space:]]*[0-9]+\)[[:space:]]+([0-9A-F]+)[[:space:]].*/\1/')"
  fi
  if [[ -z "${CODESIGN_IDENTITY:-}" ]]; then
    CODESIGN_IDENTITY="$(printf '%s\n' "${id_lines}" | grep 'Developer ID Application' | head -n 1 | sed -E 's/^[[:space:]]*[0-9]+\)[[:space:]]+([0-9A-F]+)[[:space:]].*/\1/')"
  fi
  if [[ -z "${CODESIGN_IDENTITY:-}" ]]; then
    echo "error: no Developer ID Application identity found in the imported certificate" >&2
    printf '%s\n' "${id_lines}" >&2
    exit 1
  fi
fi
echo "+ signing with identity ${CODESIGN_IDENTITY:0:8}…"

# Extended attributes make codesign fail with "resource fork… not allowed".
xattr -cr "${APP}"

# Inside-out per Apple TN2206: sign every leaf Mach-O first, then containing bundles
# (frameworks / nested .app) deepest-first, then the outer .app. Nothing inside an
# already-sealed bundle is touched after that bundle is signed.
# Avoid codesign --deep so each helper gets the right entitlements (VS Code / Electron practice).
by_depth() { awk '{ print gsub(/\//,"/"), $0 }' | sort -nr | awk '{ $1=""; sub(/^ /,""); print }'; }

# 1) Leaf Mach-O files (dylibs, .node, .so, extension helpers, bundle main executables), deepest first.
while IFS= read -r bin; do
  [[ -z "${bin}" ]] && continue
  [[ -L "${bin}" ]] && continue
  # Bundle main executables are sealed by signing their bundle in step 2.
  case "${bin}" in
    */Contents/MacOS/*) continue ;;
  esac
  if file -b "${bin}" 2>/dev/null | grep -q 'Mach-O'; then
    echo "  sign binary: ${bin#"${APP}/"}"
    sign_one "${bin}" "${ENT_DIR}/entitlements.helper.plist"
  fi
done < <(find "${APP}/Contents" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -print 2>/dev/null | by_depth)

# 2) Bundles (.framework, nested .app), deepest first so inner bundles are sealed before outer ones.
while IFS= read -r bundle; do
  [[ -z "${bundle}" || "${bundle}" == "${APP}" ]] && continue
  [[ -L "${bundle}" ]] && continue
  case "${bundle}" in
    *.app) ents="$(entitlements_for "${bundle}")"; echo "  sign nested app: ${bundle#"${APP}/"}" ;;
    *) ents="${ENT_DIR}/entitlements.helper.plist"; echo "  sign framework: ${bundle#"${APP}/"}" ;;
  esac
  sign_one "${bundle}" "${ents}"
done < <(find "${APP}/Contents" -type d \( -name '*.app' -o -name '*.framework' \) -print 2>/dev/null | by_depth)

echo "  sign app: $(basename "${APP}")"
sign_one "${APP}" "${ENT_DIR}/entitlements.app.plist"

echo "+ verify"
codesign --verify --deep --strict --verbose=2 "${APP}"
codesign --display --verbose=2 "${APP}" 2>&1 | grep -E 'Authority=|Identifier=|Format=|Signature=' || true
echo "Developer ID signed: ${APP}"
