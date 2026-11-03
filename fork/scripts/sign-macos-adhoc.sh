#!/usr/bin/env bash
# Ad-hoc code-sign a locally built .app so it launches on Apple Silicon without an Apple Developer ID.
# Apple Silicon refuses to run code without a valid signature; packaging edits Electron's bundle
# (Info.plist, renamed executable, our resources), which breaks the signature Electron shipped with.
# An ad-hoc signature ("-") is enough for an app built on the same Mac. It is not notarized, so a copy
# that was downloaded (quarantined) still needs `xattr -dr com.apple.quarantine` (see docs/build-macos.md).
#
# Usage: fork/scripts/sign-macos-adhoc.sh /path/to/editor.app
# bash 3.2 / BSD userland compatible (macOS stock tools only: xattr, codesign).
set -euo pipefail

APP="${1:?usage: sign-macos-adhoc.sh /path/to/App.app}"
[[ -d "${APP}/Contents/MacOS" ]] || { echo "not an app bundle: ${APP}" >&2; exit 1; }

# Extended attributes (quarantine, Finder info, resource forks) make codesign fail with
# "resource fork, Finder information, or similar detritus not allowed", so clear them first.
xattr -cr "${APP}"

# --deep signs the nested helpers and frameworks (Electron Framework, the Helper apps) inside-out.
# No hardened runtime (--options runtime) and no entitlements: those only matter for notarization.
codesign --force --deep --sign - "${APP}"

if codesign --verify --deep --strict --verbose=2 "${APP}"; then
  echo "Ad-hoc signed: ${APP}"
else
  echo "warning: codesign --verify reported a problem (see above). The app may still launch; if macOS says it is" >&2
  echo "         damaged, run: xattr -cr \"${APP}\" && codesign --force --deep --sign - \"${APP}\"" >&2
fi
