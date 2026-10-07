#!/usr/bin/env bash
# Free disk on GitHub-hosted runners by removing preinstalled toolchains we never use.
# A full build needs ~9 GB for the tree + output on top of the image; the free private-repo runner has ~14 GB.
set -uo pipefail
echo "Before:"; df -h / /mnt 2>/dev/null || df -h /
case "$(uname -s)" in
  Linux)
    sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /usr/local/.ghcup /usr/share/swift \
      /opt/hostedtoolcache/CodeQL /opt/hostedtoolcache/go /opt/hostedtoolcache/Ruby /opt/hostedtoolcache/PyPy \
      /usr/local/share/boost /usr/local/share/powershell /usr/local/share/chromium /opt/microsoft /opt/google \
      /usr/lib/jvm /usr/local/julia* /opt/az /usr/share/miniconda 2>/dev/null
    docker system prune -af >/dev/null 2>&1 || true
    sudo apt-get clean
    ;;
  Darwin)
    sudo rm -rf ~/Library/Android /usr/local/share/dotnet ~/.dotnet /Users/runner/hostedtoolcache/CodeQL \
      /Users/runner/hostedtoolcache/go /Users/runner/hostedtoolcache/Ruby /Users/runner/hostedtoolcache/PyPy 2>/dev/null
    # Keep only the selected Xcode.
    active="$(xcode-select -p 2>/dev/null | sed 's#/Contents/Developer##')"
    for x in /Applications/Xcode*.app; do [[ "$x" != "$active" ]] && sudo rm -rf "$x"; done
    ;;
esac
echo "After:"; df -h / /mnt 2>/dev/null || df -h /
