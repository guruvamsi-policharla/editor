#!/usr/bin/env bash
# Developer ID sign a .dmg (not an .app). Imports MACOS_CERTIFICATE_P12 into a temp keychain.
#
# Required env: MACOS_CERTIFICATE_P12 (base64), MACOS_CERTIFICATE_PASSWORD
# Optional: APPLE_TEAM_ID, CODESIGN_IDENTITY
#
# Usage: fork/scripts/sign-macos-dmg.sh /path/to/Something.dmg
set -euo pipefail

DMG="${1:?usage: sign-macos-dmg.sh /path/to/Something.dmg}"
[[ "$(uname -s)" == "Darwin" ]] || { echo "requires macOS" >&2; exit 1; }
[[ -f "${DMG}" && "${DMG}" == *.dmg ]] || { echo "not a .dmg: ${DMG}" >&2; exit 1; }
: "${MACOS_CERTIFICATE_P12:?}"
: "${MACOS_CERTIFICATE_PASSWORD:?}"

TMPDIR_SIGN="$(mktemp -d "${TMPDIR:-/tmp}/editor-dmg-sign.XXXXXX")"
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

ORIGINAL_KEYCHAINS=()
while IFS= read -r kc_line; do
  kc_line="$(printf '%s' "${kc_line}" | sed -E 's/^[[:space:]]*"?//; s/"?[[:space:]]*$//')"
  [[ -n "${kc_line}" ]] && ORIGINAL_KEYCHAINS+=("${kc_line}")
done < <(security list-keychains -d user)
security create-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN}"
security set-keychain-settings -lut 21600 "${KEYCHAIN}"
security unlock-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN}"
security list-keychains -d user -s "${KEYCHAIN}" ${ORIGINAL_KEYCHAINS[@]+"${ORIGINAL_KEYCHAINS[@]}"}

printf '%s' "${MACOS_CERTIFICATE_P12}" | base64 --decode > "${P12_FILE}"
security import "${P12_FILE}" -k "${KEYCHAIN}" -P "${MACOS_CERTIFICATE_PASSWORD}" \
  -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "${KEYCHAIN_PASSWORD}" "${KEYCHAIN}" >/dev/null
rm -f "${P12_FILE}"

if [[ -z "${CODESIGN_IDENTITY:-}" ]]; then
  id_lines="$(security find-identity -v -p codesigning "${KEYCHAIN}" || true)"
  if [[ -n "${APPLE_TEAM_ID:-}" ]]; then
    CODESIGN_IDENTITY="$(printf '%s\n' "${id_lines}" | grep 'Developer ID Application' | grep "${APPLE_TEAM_ID}" | head -n 1 | sed -E 's/^[[:space:]]*[0-9]+\)[[:space:]]+([0-9A-F]+)[[:space:]].*/\1/')"
  fi
  if [[ -z "${CODESIGN_IDENTITY:-}" ]]; then
    CODESIGN_IDENTITY="$(printf '%s\n' "${id_lines}" | grep 'Developer ID Application' | head -n 1 | sed -E 's/^[[:space:]]*[0-9]+\)[[:space:]]+([0-9A-F]+)[[:space:]].*/\1/')"
  fi
fi
[[ -n "${CODESIGN_IDENTITY:-}" ]] || { echo "no Developer ID Application identity" >&2; exit 1; }

codesign --force --timestamp --sign "${CODESIGN_IDENTITY}" "${DMG}"
codesign --verify --verbose=2 "${DMG}"
echo "Developer ID signed dmg: ${DMG}"
