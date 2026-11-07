#!/usr/bin/env bash
# Install the latest Apple Silicon build of editor.
# Usage: curl -fsSL https://guruvamsi-policharla.github.io/editor/install.sh | sh
set -euo pipefail

REPO="guruvamsi-policharla/editor"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
SOURCE_URL="https://github.com/${REPO}#build-from-source-on-macos"

die() {
  echo "$*" >&2
  exit 1
}

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "The prebuilt installer is for Apple Silicon Macs." >&2
  echo "Build from source: ${SOURCE_URL}" >&2
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON=python
else
  die "python3 is required to read the latest release. Install Xcode command line tools, or download from https://github.com/${REPO}/releases/latest"
fi

json=$(curl -fsSL "$API_URL") || die "Could not fetch the latest release from GitHub."

parsed=$(printf '%s\n' "$json" | "$PYTHON" -c '
import json, sys
data = json.load(sys.stdin)
tag = data.get("tag_name") or ""
dmg_url = dmg_name = sha_url = ""
for asset in data.get("assets") or []:
    name = asset.get("name") or ""
    url = asset.get("browser_download_url") or ""
    if name.startswith("editor-") and name.endswith("-darwin-arm64.dmg"):
        dmg_name, dmg_url = name, url
    elif name.startswith("editor-") and name.endswith("-darwin-arm64.dmg.sha256"):
        sha_url = url
if not dmg_url:
    sys.exit("no Apple Silicon .dmg in the latest release")
print(tag)
print(dmg_name)
print(dmg_url)
print(sha_url)
') || die "Could not find an Apple Silicon .dmg in the latest release."

tag=$(printf '%s\n' "$parsed" | sed -n '1p')
dmg_name=$(printf '%s\n' "$parsed" | sed -n '2p')
dmg_url=$(printf '%s\n' "$parsed" | sed -n '3p')
sha_url=$(printf '%s\n' "$parsed" | sed -n '4p')

tmpdir=$(mktemp -d)
MOUNT=""
cleanup() {
  if [ -n "${MOUNT}" ]; then
    hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmpdir"
}
trap cleanup EXIT

echo "Downloading ${dmg_name} (${tag})..."
curl -fL --progress-bar -o "${tmpdir}/${dmg_name}" "$dmg_url" || die "Download failed."

if [ -n "$sha_url" ]; then
  curl -fsSL -o "${tmpdir}/${dmg_name}.sha256" "$sha_url" || die "Could not download the checksum file."
  expected=$(awk '{print $1}' "${tmpdir}/${dmg_name}.sha256")
  actual=$(shasum -a 256 "${tmpdir}/${dmg_name}" | awk '{print $1}')
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    die "Checksum mismatch for ${dmg_name}."
  fi
  echo "Checksum verified."
fi

attach_out=$(hdiutil attach -nobrowse -readonly "${tmpdir}/${dmg_name}") || die "Could not mount the disk image."
MOUNT=$(printf '%s\n' "$attach_out" | awk '/\/Volumes\// { print $NF }' | tail -1)
if [ -z "$MOUNT" ] || [ ! -d "$MOUNT" ]; then
  die "Could not mount the disk image."
fi

APP=""
for candidate in "$MOUNT"/editor.app "$MOUNT"/*/editor.app; do
  if [ -d "$candidate" ]; then
    APP=$candidate
    break
  fi
done
if [ -z "$APP" ]; then
  die "Could not find editor.app in the disk image."
fi

dest="/Applications/editor.app"
if ditto "$APP" "$dest" 2>/dev/null; then
  :
else
  mkdir -p "$HOME/Applications"
  dest="$HOME/Applications/editor.app"
  ditto "$APP" "$dest" || die "Could not copy editor.app into /Applications or ~/Applications."
fi

echo "Installed ${tag} to ${dest}"
open "$dest"
