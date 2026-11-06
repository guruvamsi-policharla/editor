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
ORIGINAL_KEYCHAINS=""
CLEANED=0

cleanup() {
  if [[ "${CLEANED}" -eq 1 ]]; then return; fi
  CLEANED=1
  if [[ -f "${KEYCHAIN}" ]]; then
    security delete-keychain "${KEYCHAIN}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${ORIGINAL_KEYCHAINS}" ]]; then
    # shellcheck disable=SC2086
    security list-keychains -s ${ORIGINAL_KEYCHAINS} >/dev/null 2>&1 || true
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
ORIGINAL_KEYCHAINS="$(security list-keychains -d user | sed -E 's/^[[:space:]]*"?(.*?)"?$/\1/' | tr '\n' ' ')"
security create-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN}"
security set-keychain-settings -lut 21600 "${KEYCHAIN}"
security unlock-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN}"
# shellcheck disable=SC2086
security list-keychains -d user -s "${KEYCHAIN}" ${ORIGINAL_KEYCHAINS}

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

# Inside-out: nested .app bundles deepest first, then frameworks, then loose Mach-Os, then outer .app.
# Avoid codesign --deep so each helper gets the right entitlements (VS Code / Electron practice).
while IFS= read -r nested; do
  [[ "${nested}" == "${APP}" ]] && continue
  ents="$(entitlements_for "${nested}")"
  echo "  sign nested app: ${nested#"${APP}/"}"
  sign_one "${nested}" "${ents}"
done < <(find "${APP}" -name '*.app' -print | awk '{ print gsub(/\//,"/"), $0 }' | sort -nr | awk '{ $1=""; sub(/^ /,""); print }')

while IFS= read -r fw; do
  echo "  sign framework: ${fw#"${APP}/"}"
  sign_one "${fw}" "${ENT_DIR}/entitlements.helper.plist"
done < <(find "${APP}/Contents/Frameworks" -name '*.framework' -maxdepth 1 -print 2>/dev/null | awk '{ print gsub(/\//,"/"), $0 }' | sort -nr | awk '{ $1=""; sub(/^ /,""); print }')

# Loose Mach-O binaries (extension helpers, .node, dylibs) that are not already covered as
# the main executable of a nested .app / framework. Skip things already signed with our identity.
while IFS= read -r bin; do
  [[ -z "${bin}" ]] && continue
  # Skip if this path is inside a nested .app's Contents/MacOS main binary we already signed as the app
  case "${bin}" in
    */Contents/MacOS/*) continue ;;
  esac
  if file -b "${bin}" 2>/dev/null | grep -q 'Mach-O'; then
    echo "  sign binary: ${bin#"${APP}/"}"
    sign_one "${bin}" "${ENT_DIR}/entitlements.helper.plist"
  fi
done < <(find "${APP}" \( -type f -perm -u+x -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \) ! -path '*/Contents/MacOS/*' -print 2>/dev/null)

echo "  sign app: $(basename "${APP}")"
sign_one "${APP}" "${ENT_DIR}/entitlements.app.plist"

echo "+ verify"
codesign --verify --deep --strict --verbose=2 "${APP}"
codesign --display --verbose=2 "${APP}" 2>&1 | grep -E 'Authority=|Identifier=|Format=|Signature=' || true
echo "Developer ID signed: ${APP}"
