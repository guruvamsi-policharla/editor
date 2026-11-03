#!/usr/bin/env bash
# A fake coding agent for trying Keep/Undo in two minutes, without a real agent.
#
#   scripts/demo-agent.sh setup [DIR]   copy examples/paper to DIR (default: /tmp/editor-demo/paper),
#                                       replacing any earlier copy, and print how to open it
#   scripts/demo-agent.sh run [DIR]     make a few edits to DIR over ~6 s, like an agent would:
#                                       reword a sentence, delete a line, add a paragraph, create a file
#   --no-wait                           (run) don't wait for Enter before editing
#
# Open DIR in editor *before* `run`: the editor records the files as they are when the folder opens,
# and every later change on disk shows up for review.
# Works with macOS's stock bash 3.2 and BSD tools (awk, cp, mktemp); the repo's files are never touched.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMD="${1:-}"
[[ $# -gt 0 ]] && shift
WAIT=yes
DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-wait) WAIT=no ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) DIR="$1" ;;
  esac
  shift
done
DIR="${DIR:-${TMPDIR:-/tmp}/editor-demo/paper}"
DIR="${DIR%/}"
STEP_DELAY="${DEMO_STEP_DELAY:-1.5}"

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

open_hint() {
  if command -v editor >/dev/null 2>&1; then
    echo "  editor \"${DIR}\""
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    echo "  open -a editor \"${DIR}\"        (or File > Open Folder... in editor)"
  else
    echo "  <path to VSCode-linux-x64>/bin/editor \"${DIR}\"   (or File > Open Folder... in editor)"
  fi
}

setup() {
  rm -rf "${DIR}"
  mkdir -p "${DIR}"
  cp -R "${REPO_ROOT}/examples/paper/." "${DIR}/"
  # A git repo makes it look like a real project (and `git diff` works afterwards); not required.
  if command -v git >/dev/null 2>&1; then
    (cd "${DIR}" && git init -q && git add -A &&
      git -c user.name=Demo -c user.email=demo@example.com commit -qm "Draft" >/dev/null) || true
  fi
  echo "Demo paper ready: ${DIR}"
  echo
  echo "1. Open it in editor:"
  open_hint
  echo "2. Then start the fake agent:"
  echo "  ${REPO_ROOT}/scripts/demo-agent.sh run \"${DIR}\""
}

# Line edits with awk. Strings are passed through the environment (ENVIRON), so LaTeX backslashes reach
# awk unchanged. Each edit fails loudly if its line isn't there (e.g. the demo already ran).
edit_file() { # FILE AWK_PROGRAM  (OLD / NEW in the environment)
  local file="${DIR}/$1" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/demo-agent.XXXXXX")"  # outside DIR: no stray file for the watcher
  if ! awk "$2"' END { if (!found) exit 3 }' "${file}" > "${tmp}"; then
    rm -f "${tmp}"
    echo "demo-agent: expected line not found in $1 (already edited? run: $0 setup \"${DIR}\")" >&2
    exit 1
  fi
  # Write in place, like most agents' file-write tools (the file keeps its inode).
  cat "${tmp}" > "${file}"
  rm -f "${tmp}"
}
# shellcheck disable=SC2016 # awk programs: $0 is awk's, not the shell's
replace_line() { OLD="$2" NEW="$3" edit_file "$1" '$0 == ENVIRON["OLD"] { print ENVIRON["NEW"]; found = 1; next } { print }'; }
# shellcheck disable=SC2016
delete_line() { OLD="$2" edit_file "$1" '$0 == ENVIRON["OLD"] { found = 1; next } { print }'; }
# shellcheck disable=SC2016
insert_after() { OLD="$2" NEW="$3" edit_file "$1" '{ print } $0 == ENVIRON["OLD"] { print ENVIRON["NEW"]; found = 1 }'; }

say() { printf '  agent: %s\n' "$*"; }
pause() { sleep "${STEP_DELAY}"; }

run() {
  [[ -f "${DIR}/main.tex" && -f "${DIR}/sections/intro.tex" ]] || {
    echo "No demo paper in ${DIR}. Create it first: $0 setup${DIR:+ \"${DIR}\"}" >&2
    exit 1
  }
  if [[ "${WAIT}" == "yes" && -t 0 ]]; then
    echo "Open ${DIR} in editor (main.tex and sections/intro.tex), then press Enter to start editing."
    open_hint
    read -r _
  fi
  echo "Fake agent editing ${DIR}:"

  replace_line sections/intro.tex \
    'Long documents remain hard for language models.' \
    'Long documents remain a hard case for current language models.'
  say "reworded a sentence in sections/intro.tex"
  pause

  delete_line main.tex 'Our method is the first to solve long-document understanding.'
  say "deleted an overclaiming sentence from the abstract in main.tex"
  pause

  insert_after sections/intro.tex 'so the model can follow references across sections without attending to every token.' \
'
Summaries are computed once per chunk and cached,
so reading a document a second time costs no more than full attention over a single chunk.'
  say "added a paragraph to sections/intro.tex"
  pause

  replace_line main.tex \
    'On the third, retrieval is better by 0.6 points, because its questions target a single paragraph.' \
    'On the third, retrieval is better by 0.4 points, because most of its questions target a single paragraph.'
  say "updated a result in main.tex"
  pause

  cat > "${DIR}/sections/related.tex" <<'TEX'
\section{Related Work}
Sparse attention patterns reduce the cost of long inputs by attending to a fixed subset of tokens.
Retrieval-augmented models instead select a few passages before reading them in full.
Hierarchical encoders summarize sections bottom-up, as we do, but they discard the tokens of other sections entirely.
TEX
  insert_after main.tex '\input{sections/intro}' '\input{sections/related}'
  say "created sections/related.tex and added it to main.tex"

  echo
  echo "Done. In editor, each change has Keep / Undo buttons (Ctrl/Cmd+Y keeps, Ctrl/Cmd+N undoes the change at"
  echo "the cursor). The Agent Changes list in the Explorer has all files, including the new one."
  echo "Start over with: $0 setup \"${DIR}\""
}

case "${CMD}" in
  setup) setup ;;
  run) run ;;
  -h | --help | "") usage ;;
  *) echo "unknown command: ${CMD}" >&2; usage >&2; exit 2 ;;
esac
