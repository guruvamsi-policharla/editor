#!/usr/bin/env bash
# The checks to run before merging, on your own machine: GitHub CI only runs the patch series and lint on PRs.
#   repo lint, typecheck, build and unit tests; shell syntax and shellcheck; the patch series for macOS and Linux.
# The core typecheck needs a VS Code `npm ci` and more RAM: run full-checks.yml by hand when patches change a lot.
#
# Usage: fork/scripts/check-local.sh
# Needs node, jq and git. Installs the repo's npm dependencies if they're missing. shellcheck is skipped with a
# warning when it isn't installed. bash 3.2 / BSD userland compatible.
set -euo pipefail

cd "$(dirname "$0")/../.."

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

if [[ ! -d node_modules ]]; then
  step "npm ci"
  npm ci --no-audit --no-fund
fi
step "lint"
npm run lint
step "typecheck"
npm run typecheck
step "build"
npm run build
step "unit tests"
npm test
step "shell scripts"
for f in fork/scripts/*.sh fork/ci/*.sh scripts/*.sh; do bash -n "$f"; done
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x fork/scripts/*.sh fork/ci/*.sh scripts/*.sh
else
  echo "shellcheck isn't installed: skipped" >&2
fi
step "patch series"
fork/scripts/check-patches.sh

printf '\n\033[32mAll local checks passed.\033[0m\n'
