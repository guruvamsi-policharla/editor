#!/usr/bin/env bash
# Notarize a macOS .app or .dmg with notarytool (App Store Connect API key) and staple the ticket.
#
# Required env:
#   APPLE_API_KEY_ID
#   APPLE_API_ISSUER_ID
#   APPLE_API_KEY_P8          raw contents of the .p8 (or path if it starts with / or ./)
#
# Usage: fork/scripts/notarize-macos.sh /path/to/editor.app|/path/to/editor.dmg
# For a .app, submits a zip (Apple requires a flat archive for app bundles).
# bash 3.2 / BSD userland compatible. Must run on macOS.
set -euo pipefail

TARGET="${1:?usage: notarize-macos.sh /path/to/App.app|Something.dmg}"
[[ "$(uname -s)" == "Darwin" ]] || { echo "notarization requires macOS" >&2; exit 1; }
: "${APPLE_API_KEY_ID:?APPLE_API_KEY_ID is required}"
: "${APPLE_API_ISSUER_ID:?APPLE_API_ISSUER_ID is required}"
: "${APPLE_API_KEY_P8:?APPLE_API_KEY_P8 is required}"

TMPDIR_NOTARY="$(mktemp -d "${TMPDIR:-/tmp}/editor-notary.XXXXXX")"
KEY_FILE="${TMPDIR_NOTARY}/AuthKey_${APPLE_API_KEY_ID}.p8"
SUBMIT_FILE=""
cleanup() {
  rm -rf "${TMPDIR_NOTARY}"
}
trap cleanup EXIT

if [[ "${APPLE_API_KEY_P8}" == /* || "${APPLE_API_KEY_P8}" == ./* ]]; then
  cp "${APPLE_API_KEY_P8}" "${KEY_FILE}"
else
  printf '%s\n' "${APPLE_API_KEY_P8}" > "${KEY_FILE}"
fi
chmod 600 "${KEY_FILE}"

if [[ -d "${TARGET}" && "${TARGET}" == *.app ]]; then
  SUBMIT_FILE="${TMPDIR_NOTARY}/submit.zip"
  echo "+ zip app for notarization"
  # ditto preserves macOS metadata better than zip for app bundles.
  ditto -c -k --keepParent "${TARGET}" "${SUBMIT_FILE}"
elif [[ -f "${TARGET}" && "${TARGET}" == *.dmg ]]; then
  SUBMIT_FILE="${TARGET}"
else
  echo "notarize-macos.sh expects a .app bundle or a .dmg file" >&2
  exit 1
fi

echo "+ submit to Apple notary service (this can take several minutes)"
# Do not print key material. notarytool --wait exits non-zero on rejection.
xcrun notarytool submit "${SUBMIT_FILE}" \
  --key "${KEY_FILE}" \
  --key-id "${APPLE_API_KEY_ID}" \
  --issuer "${APPLE_API_ISSUER_ID}" \
  --wait

echo "+ staple"
xcrun stapler staple "${TARGET}"
xcrun stapler validate "${TARGET}"
echo "Notarized and stapled: ${TARGET}"
