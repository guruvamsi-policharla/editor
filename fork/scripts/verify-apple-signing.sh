#!/usr/bin/env bash
# Dry-run check that GitHub Actions secrets for Developer ID + notarization are usable.
# Imports the .p12 into a temporary keychain, asserts a Developer ID Application identity
# exists (and matches APPLE_TEAM_ID when set), and checks notarytool can authenticate with
# the App Store Connect API key. Does NOT build the app or cut a release.
#
# Required env: MACOS_CERTIFICATE_P12, MACOS_CERTIFICATE_PASSWORD,
#               APPLE_API_KEY_ID, APPLE_API_ISSUER_ID, APPLE_API_KEY_P8
# Optional:     APPLE_TEAM_ID (default 648H7CRP9Q)
#
# Usage: fork/scripts/verify-apple-signing.sh
# bash 3.2 / BSD. Must run on macOS.
set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || { echo "verify-apple-signing requires macOS" >&2; exit 1; }
: "${MACOS_CERTIFICATE_P12:?}"
: "${MACOS_CERTIFICATE_PASSWORD:?}"
: "${APPLE_API_KEY_ID:?}"
: "${APPLE_API_ISSUER_ID:?}"
: "${APPLE_API_KEY_P8:?}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-648H7CRP9Q}"
EXPECTED_SUBSTRING="Developer ID Application"
EXPECTED_TEAM="${APPLE_TEAM_ID}"

TMPDIR_V="$(mktemp -d "${TMPDIR:-/tmp}/editor-verify-signing.XXXXXX")"
KEYCHAIN="${TMPDIR_V}/verify.keychain"
P12_FILE="${TMPDIR_V}/certificate.p12"
KEY_FILE="${TMPDIR_V}/AuthKey_${APPLE_API_KEY_ID}.p8"
KEYCHAIN_PASSWORD="$(openssl rand -base64 24)"
ORIGINAL_KEYCHAINS=""
CLEANED=0
FAILS=0

cleanup() {
  if [[ "${CLEANED}" -eq 1 ]]; then return; fi
  CLEANED=1
  if [[ -f "${KEYCHAIN}" ]]; then
    security delete-keychain "${KEYCHAIN}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${ORIGINAL_KEYCHAINS}" ]]; then
    # shellcheck disable=SC2086
    security list-keychains -d user -s ${ORIGINAL_KEYCHAINS} >/dev/null 2>&1 || true
  fi
  rm -rf "${TMPDIR_V}"
}
trap cleanup EXIT

ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { FAILS=$((FAILS + 1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }

echo "== import Developer ID certificate"
ORIGINAL_KEYCHAINS="$(security list-keychains -d user | sed -E 's/^[[:space:]]*"?(.*?)"?$/\1/' | tr '\n' ' ')"
security create-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN}"
security set-keychain-settings -lut 21600 "${KEYCHAIN}"
security unlock-keychain -p "${KEYCHAIN_PASSWORD}" "${KEYCHAIN}"
# shellcheck disable=SC2086
security list-keychains -d user -s "${KEYCHAIN}" ${ORIGINAL_KEYCHAINS}

printf '%s' "${MACOS_CERTIFICATE_P12}" | base64 --decode > "${P12_FILE}"
if ! security import "${P12_FILE}" -k "${KEYCHAIN}" -P "${MACOS_CERTIFICATE_PASSWORD}" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null; then
  bad "security import failed (bad base64 .p12 or wrong MACOS_CERTIFICATE_PASSWORD)"
else
  ok "imported .p12 into temporary keychain"
fi
rm -f "${P12_FILE}"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "${KEYCHAIN_PASSWORD}" "${KEYCHAIN}" >/dev/null 2>&1 || true

id_out="$(security find-identity -v -p codesigning "${KEYCHAIN}" 2>&1 || true)"
# Print identity lines without trying to hide Team ID (public); never print the password/p12.
echo "${id_out}" | sed -n 's/^/  /p'

if printf '%s\n' "${id_out}" | grep -q "${EXPECTED_SUBSTRING}"; then
  ok "found ${EXPECTED_SUBSTRING} identity"
else
  bad "no ${EXPECTED_SUBSTRING} identity in the keychain"
fi
if printf '%s\n' "${id_out}" | grep -q "${EXPECTED_TEAM}"; then
  ok "identity includes Team ID ${EXPECTED_TEAM}"
else
  bad "no identity matching Team ID ${EXPECTED_TEAM}"
fi
if printf '%s\n' "${id_out}" | grep -q "Guru Vamsi Policharla"; then
  ok "identity names Guru Vamsi Policharla"
else
  # Soft check: name string can vary; Team ID is the hard requirement.
  echo "  ! identity display name did not include 'Guru Vamsi Policharla' (Team ID check is authoritative)"
fi

echo "== notarytool API key auth"
if [[ "${APPLE_API_KEY_P8}" == /* || "${APPLE_API_KEY_P8}" == ./* ]]; then
  cp "${APPLE_API_KEY_P8}" "${KEY_FILE}"
else
  printf '%s\n' "${APPLE_API_KEY_P8}" > "${KEY_FILE}"
fi
chmod 600 "${KEY_FILE}"

# `notarytool history` authenticates without submitting a binary. A credentials /
# auth failure exits non-zero; an empty history is fine.
if xcrun notarytool history \
  --key "${KEY_FILE}" \
  --key-id "${APPLE_API_KEY_ID}" \
  --issuer "${APPLE_API_ISSUER_ID}" \
  >/dev/null; then
  ok "notarytool authenticated with App Store Connect API key"
else
  bad "notarytool auth failed (check APPLE_API_KEY_ID / APPLE_API_ISSUER_ID / APPLE_API_KEY_P8)"
fi

echo "== cleanup temporary keychain"
cleanup
ok "deleted temporary keychain"

if [[ "${FAILS}" -ne 0 ]]; then
  echo "verify-apple-signing: ${FAILS} check(s) failed" >&2
  exit 1
fi
echo "All Apple signing secret checks passed."
