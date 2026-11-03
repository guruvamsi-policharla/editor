#!/usr/bin/env bash
# One command from a fresh clone to a runnable, ad-hoc signed editor.app on macOS (Apple Silicon or Intel).
#
#   fork/scripts/build-macos.sh              check prerequisites, prepare VSCodium + our patches + the built-in
#                                            extension, compile, package, sign; prints where the .app is
#   fork/scripts/build-macos.sh --install    same, then copy the app to /Applications (quit editor first)
#   fork/scripts/build-macos.sh --check      only check prerequisites
#   fork/scripts/build-macos.sh --dry-run    check, then print the steps it would run
#   fork/scripts/build-macos.sh --clean      re-clone and re-prepare even if nothing changed
#   [WORKDIR]                                build directory (default ~/.cache/editor-fork-build, ~15 GB)
#
# Re-running after `git pull` is the rebuild: the slow prepare step (clone + patches + npm ci, ~5 min) is
# skipped when the pin, branding and patches are unchanged; the extension is reinstalled and the app rebuilt.
#
# Env: MAX_OLD_SPACE_SIZE (gulp heap MB, default 8192), VSCODE_ARCH (arm64|x64, default: this Mac),
#      MIN_FREE_GB (free-disk check, default 15).
# Written for macOS's stock bash 3.2 and BSD userland: no bash 4 features, no GNU-only flags.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=../upstream.env
. "${REPO_ROOT}/fork/upstream.env"
# shellcheck source=../branding.env
. "${REPO_ROOT}/fork/branding.env"

MODE=build
INSTALL=no
CLEAN=no
WORKDIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE=check ;;
    --dry-run) MODE=dry-run ;;
    --install) INSTALL=yes ;;
    --clean) CLEAN=yes ;;
    -h | --help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
    *) WORKDIR="$1" ;;
  esac
  shift
done
WORKDIR="${WORKDIR:-${XDG_CACHE_HOME:-$HOME/.cache}/editor-fork-build}"
MIN_FREE_GB="${MIN_FREE_GB:-15}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ERRORS=0
WARNINGS=0
BREW_PKGS=""
fail() { ERRORS=$((ERRORS + 1)); printf '  \033[31m✗\033[0m %s\n' "$1"; shift; for l in "$@"; do printf '      %s\n' "$l"; done; }
warn() { WARNINGS=$((WARNINGS + 1)); printf '  \033[33m!\033[0m %s\n' "$1"; shift; for l in "$@"; do printf '      %s\n' "$l"; done; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
need_brew() { case " ${BREW_PKGS} " in *" $1 "*) ;; *) BREW_PKGS="${BREW_PKGS:+${BREW_PKGS} }$1" ;; esac; }

# "a.b.c" >= "x.y.z" (numeric, missing parts are 0). Pure bash 3.2.
version_ge() {
  local IFS=.
  # shellcheck disable=SC2206
  local a=($1) b=($2) i
  for i in 0 1 2; do
    if (( ${a[i]:-0} > ${b[i]:-0} )); then return 0; fi
    if (( ${a[i]:-0} < ${b[i]:-0} )); then return 1; fi
  done
  return 0
}

check_prerequisites() {
  bold "Checking prerequisites"

  # --- macOS and architecture ---
  if [[ "$(uname -s)" != "Darwin" ]]; then
    fail "This script builds the macOS app and must run on macOS (this is $(uname -s))." \
      "On Linux use: fork/scripts/prepare-vscodium.sh && fork/scripts/build.sh"
  else
    local macos
    macos="$(sw_vers -productVersion 2>/dev/null || echo 0)"
    if version_ge "${macos}" 12.0; then ok "macOS ${macos}"; else fail "macOS ${macos}: Electron needs macOS 12 (Monterey) or newer."; fi
  fi

  local hw_arm64 translated
  hw_arm64="$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)"
  translated="$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)"
  if [[ "${translated}" == "1" ]]; then
    fail "This terminal runs under Rosetta (x86_64 emulation), so Node and the native modules would be Intel builds." \
      "Open a native Terminal (Get Info on Terminal.app: untick \"Open using Rosetta\"), or run: arch -arm64 /bin/bash $0"
  fi
  if [[ -z "${VSCODE_ARCH:-}" ]]; then
    if [[ "${hw_arm64}" == "1" || "$(uname -m)" == "arm64" ]]; then VSCODE_ARCH=arm64; else VSCODE_ARCH=x64; fi
  fi
  case "${VSCODE_ARCH}" in
    arm64 | x64) ok "target architecture: ${VSCODE_ARCH}" ;;
    *) fail "VSCODE_ARCH=${VSCODE_ARCH}: must be arm64 or x64" ;;
  esac

  if [[ "$(id -u)" == "0" ]]; then fail "Don't run this as root (sudo): npm and the app would end up owned by root."; fi

  # --- Xcode command line tools (clang, make, git, python3) ---
  if xcode-select -p >/dev/null 2>&1; then
    local clang_out clang_major
    if clang_out="$(clang++ --version 2>&1)"; then
      clang_major="$(printf '%s\n' "${clang_out}" | sed -n 's/.*clang version \([0-9][0-9]*\).*/\1/p' | head -n 1)"
      ok "Xcode command line tools: $(xcode-select -p) (clang ${clang_major:-?})"
      if [[ -n "${clang_major}" ]] && (( clang_major < 15 )); then
        warn "clang ${clang_major} is old; the native modules need C++20. If npm ci fails to compile, update the" \
          "command line tools: softwareupdate --list, or reinstall with: sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install"
      fi
    else
      case "${clang_out}" in
        *license*) fail "clang refuses to run until the Xcode license is accepted." "Run: sudo xcodebuild -license accept" ;;
        *) fail "clang++ does not work: ${clang_out}" "Run: xcode-select --install   (or: sudo xcode-select --reset)" ;;
      esac
    fi
  else
    fail "Xcode command line tools are not installed (needed for clang, make, git)." "Run: xcode-select --install"
  fi

  # --- git, jq, python3 ---
  if command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1; then ok "$(git --version)"; else fail "git is missing." "It comes with the Xcode command line tools: xcode-select --install"; fi

  if command -v jq >/dev/null 2>&1; then ok "jq $(jq --version 2>/dev/null)"; else fail "jq is missing (VSCodium's scripts edit product.json with it)."; need_brew jq; fi

  local py
  if py="$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null)"; then
    if version_ge "${py}" 3.8; then ok "Python ${py} (node-gyp)"; else fail "Python ${py} is too old for node-gyp (needs 3.8+)."; need_brew python; fi
  else
    fail "python3 is missing or not working (node-gyp needs it to build the native modules)." \
      "It comes with the Xcode command line tools (xcode-select --install), or: brew install python"
  fi

  # --- Node + npm (exact major as VS Code's .nvmrc; preinstall rejects anything else) ---
  local node_major="${NODE_VERSION%%.*}"
  if command -v node >/dev/null 2>&1; then
    local node_ver node_arch npm_ver
    node_ver="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
    node_arch="$(node -p 'process.arch' 2>/dev/null || echo unknown)"
    if [[ "${node_ver%%.*}" == "${node_major}" ]] && version_ge "${node_ver}" "${NODE_VERSION}"; then
      ok "Node ${node_ver} (${node_arch}) at $(command -v node)"
    else
      fail "Node ${node_ver} at $(command -v node): the pinned VS Code needs Node ${node_major}.x, ${NODE_VERSION} or newer within ${node_major}.x." \
        "brew install node@${node_major} && export PATH=\"\$(brew --prefix node@${node_major})/bin:\$PATH\"" \
        "(add that export line to ~/.zprofile to keep it), or with nvm: nvm install ${node_major} && nvm use ${node_major}"
    fi
    if [[ "${node_arch}" != "unknown" && -n "${VSCODE_ARCH:-}" && "${node_arch}" != "${VSCODE_ARCH}" ]]; then
      fail "Node is an ${node_arch} build but the target is ${VSCODE_ARCH}: native modules would be built for the wrong CPU." \
        "On Apple Silicon use the arm64 Homebrew in /opt/homebrew (not /usr/local), or an arm64 Node from nodejs.org / nvm."
    fi
    if npm_ver="$(npm --version 2>/dev/null)"; then
      if version_ge "${npm_ver}" 13.0.0; then fail "npm ${npm_ver}: VS Code's install script needs npm < 13 (the npm that ships with Node ${node_major} is fine)."; else ok "npm ${npm_ver}"; fi
    else
      fail "npm is missing (it normally ships with Node)."
    fi
  else
    fail "Node.js is missing: the pinned VS Code needs Node ${node_major}.x (${NODE_VERSION} or newer within ${node_major}.x)." \
      "brew install node@${node_major} && export PATH=\"\$(brew --prefix node@${node_major})/bin:\$PATH\"" \
      "(add that export line to ~/.zprofile to keep it), or with nvm: nvm install ${node_major}"
  fi

  # --- build directory: no spaces (node-gyp), enough disk, enough memory ---
  case "${WORKDIR}" in
    *" "*) fail "The build directory has a space in its path, which breaks node-gyp: ${WORKDIR}" "Pass another one: $0 /path/without/spaces" ;;
  esac
  local probe="${WORKDIR}"
  while [[ ! -d "${probe}" ]]; do probe="$(dirname "${probe}")"; done
  local free_gb
  free_gb="$(df -Pk "${probe}" | awk 'NR==2 {print int($4 / 1048576)}')"
  if (( free_gb >= MIN_FREE_GB )); then ok "${free_gb} GB free for ${WORKDIR}"; else
    fail "Only ${free_gb} GB free on the disk holding ${WORKDIR}; the build needs about ${MIN_FREE_GB} GB." \
      "Free some space, or pass a build directory on another disk: $0 /Volumes/Other/editor-build"
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    local mem_gb
    mem_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))
    if (( mem_gb >= 16 )); then ok "${mem_gb} GB RAM"; else
      warn "${mem_gb} GB RAM: the TypeScript compile alone uses ~7 GB, so macOS will swap and the build will be slow." \
        "Close other apps while it runs."
    fi
  fi

  if [[ -n "${BREW_PKGS}" ]]; then
    echo
    if command -v brew >/dev/null 2>&1; then
      echo "  Install the missing tools with:  brew install ${BREW_PKGS}"
    else
      echo "  Install Homebrew (https://brew.sh), then:  brew install ${BREW_PKGS}"
    fi
  fi
  echo
  if (( ERRORS > 0 )); then
    echo "${ERRORS} problem(s) found; fix them and run this again." >&2
    return 1
  fi
  if (( WARNINGS > 0 )); then echo "Prerequisites OK, with ${WARNINGS} warning(s) above."; else echo "All prerequisites OK."; fi
}

# The slow prepare step depends only on these inputs; skip it when they are unchanged.
prepare_stamp() {
  { cat "${REPO_ROOT}/fork/upstream.env" "${REPO_ROOT}/fork/branding.env" "${REPO_ROOT}"/patches/*.patch "${REPO_ROOT}"/patches/*/*.patch \
      "${REPO_ROOT}/fork/scripts/prepare-vscodium.sh"
    find "${REPO_ROOT}/branding/generated" -type f -print0 | LC_ALL=C sort -z | xargs -0 cat; } | git hash-object --stdin
  echo "${VSCODE_ARCH}"
}

app_path() { echo "${WORKDIR}/vscodium/VSCode-darwin-${VSCODE_ARCH}/${APP_NAME}.app"; }

print_result() {
  local app="$1" bin_rel="Contents/Resources/app/bin/${BINARY_NAME}"
  echo
  bold "${APP_NAME}.app is ready"
  echo "  ${app}"
  echo
  echo "Launch it:"
  echo "  open \"${app}\""
  if [[ "${INSTALL}" != "yes" ]]; then
    echo "Or copy it to /Applications (re-run with --install to do this on every rebuild):"
    echo "  ditto \"$(app_path)\" \"/Applications/${APP_NAME}.app\""
  fi
  echo
  echo "Install the '${BINARY_NAME}' shell command (opens folders/files from a terminal: ${BINARY_NAME} .):"
  echo "  in ${APP_NAME}: Cmd+Shift+P > \"Shell Command: Install '${BINARY_NAME}' command in PATH\""
  echo "  or by hand:    ln -sf \"${app}/${bin_rel}\" /usr/local/bin/${BINARY_NAME}"
  echo "                 (any directory on your PATH works, e.g. /opt/homebrew/bin or ~/.local/bin)"
  echo
  echo "Try Keep/Undo without an agent (README.md, \"Try it\"):"
  echo "  ${REPO_ROOT}/scripts/demo-agent.sh setup && open -a \"${app}\" ${TMPDIR:-/tmp}/editor-demo/paper"
  echo "  ${REPO_ROOT}/scripts/demo-agent.sh run"
}

check_prerequisites || exit 1
[[ "${MODE}" == "check" ]] && exit 0

STAMP_FILE="${WORKDIR}/.editor-prepare-stamp"
NEED_PREPARE=yes
if [[ "${CLEAN}" == "no" && -f "${STAMP_FILE}" && -d "${WORKDIR}/vscodium/vscode/node_modules" ]] &&
  [[ "$(cat "${STAMP_FILE}")" == "$(prepare_stamp)" ]]; then
  NEED_PREPARE=no
fi

export OS_NAME=osx VSCODE_ARCH
export MAX_OLD_SPACE_SIZE="${MAX_OLD_SPACE_SIZE:-8192}"

if [[ "${MODE}" == "dry-run" ]]; then
  bold "Would run (WORKDIR=${WORKDIR}, VSCODE_ARCH=${VSCODE_ARCH}, heap ${MAX_OLD_SPACE_SIZE} MB):"
  echo "  (cd ${REPO_ROOT} && npm ci)"
  if [[ "${NEED_PREPARE}" == "yes" ]]; then
    echo "  ${REPO_ROOT}/fork/scripts/prepare-vscodium.sh ${WORKDIR}    # clone VSCodium@${VSCODIUM_REF:0:7}, patches, npm ci, extension"
  else
    echo "  (prepare skipped: pin, branding and patches unchanged since the last prepare)"
    echo "  ${REPO_ROOT}/fork/scripts/install-extension.sh ${WORKDIR}/vscodium/vscode"
  fi
  echo "  ${REPO_ROOT}/fork/scripts/build.sh ${WORKDIR}    # compile, package, ad-hoc sign, smoke test"
  [[ "${INSTALL}" == "yes" ]] && echo "  ditto $(app_path) /Applications/${APP_NAME}.app"
  exit 0
fi

if [[ "${INSTALL}" == "yes" ]] && pgrep -if "/Applications/${APP_NAME}.app/Contents/MacOS/" >/dev/null 2>&1; then
  echo "${APP_NAME} is running from /Applications; quit it first (Cmd+Q), then run this again." >&2
  exit 1
fi

# Raise the open-files limit (macOS defaults to 256 per shell; npm and gulp open many files at once).
ulimit -n 10240 2>/dev/null || true

mkdir -p "${WORKDIR}"
LOG="${WORKDIR}/build-macos.log"
START=$(date +%s)
set +e
{
  set -e
  bold "Building ${APP_NAME} for macOS ${VSCODE_ARCH} in ${WORKDIR} (log: ${LOG})"
  bold "== repo dependencies (engine + extension)"
  (cd "${REPO_ROOT}" && npm ci --no-audit --no-fund)

  if [[ "${NEED_PREPARE}" == "yes" ]]; then
    bold "== prepare: VSCodium ${VSCODIUM_REF:0:7} + VS Code + our patches + npm ci (~5-10 min)"
    rm -f "${STAMP_FILE}"
    "${REPO_ROOT}/fork/scripts/prepare-vscodium.sh" "${WORKDIR}"
    prepare_stamp > "${STAMP_FILE}"
  else
    bold "== prepare skipped (pin, branding and patches unchanged); reinstalling the built-in extension"
    "${REPO_ROOT}/fork/scripts/install-extension.sh" "${WORKDIR}/vscodium/vscode"
  fi

  bold "== build: compile, package, ad-hoc sign (~10-25 min)"
  "${REPO_ROOT}/fork/scripts/build.sh" "${WORKDIR}"
} 2>&1 | tee "${LOG}"
STATUS=${PIPESTATUS[0]}
set -e
if [[ "${STATUS}" != "0" ]]; then
  echo >&2
  echo "Build failed (exit ${STATUS}). Full log: ${LOG}" >&2
  echo "Troubleshooting: ${REPO_ROOT}/docs/build-macos.md#troubleshooting" >&2
  exit "${STATUS}"
fi

APP="$(app_path)"
if [[ "${INSTALL}" == "yes" ]]; then
  bold "== installing to /Applications/${APP_NAME}.app"
  rm -rf "/Applications/${APP_NAME}.app"
  ditto "${APP}" "/Applications/${APP_NAME}.app"
  APP="/Applications/${APP_NAME}.app"
fi
echo
echo "Done in $(( ($(date +%s) - START) / 60 )) min."
print_result "${APP}"
