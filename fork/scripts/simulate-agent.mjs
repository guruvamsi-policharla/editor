#!/usr/bin/env node
// Simulate an external coding agent editing files while the editor is running.
//
//   node fork/scripts/simulate-agent.mjs setup <dir>      create a sample project (git repo, one commit)
//   node fork/scripts/simulate-agent.mjs edit <dir> [N]   run agent wave N (default 1); waves: 1, 2
//   node fork/scripts/simulate-agent.mjs all <dir>        setup is not included; waves 1 and 2, 3 s apart
//
// The agent writes straight to disk like a CLI agent would: in-place writes, one write-to-temp + rename,
// a new file, and a deleted file. Nothing talks to the editor; it sees the changes through file watching.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const [cmd, dirArg, waveArg] = process.argv.slice(2);
if (!cmd || !dirArg) {
  console.error('usage: simulate-agent.mjs setup|edit|all <dir> [wave]');
  process.exit(2);
}
const dir = path.resolve(dirArg);
const file = (rel) => path.join(dir, rel);
const read = (rel) => fs.readFileSync(file(rel), 'utf8');
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), text);
  console.log(`agent: wrote ${rel}`);
};
const writeViaRename = (rel, text) => {
  const tmp = `${file(rel)}.agent-tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file(rel));
  console.log(`agent: wrote ${rel} (temp file + rename)`);
};
const replace = (rel, from, to, viaRename = false) => {
  const before = read(rel);
  if (!before.includes(from)) { throw new Error(`${rel}: text to replace not found: ${from.slice(0, 40)}`); }
  (viaRename ? writeViaRename : write)(rel, before.replace(from, to));
};

const MAIN_TEX = String.raw`\documentclass{article}
\usepackage{amsmath}
\title{Inline Review for Agent Edits}
\author{A. Author}

\begin{document}
\maketitle

\section{Introduction}
Coding agents now write a large share of the code in many projects.
Reviewing what they changed is still done after the fact, in a separate tool.
We propose reviewing agent edits inline, where the code lives.

\section{Method}
The editor keeps a baseline of every file the agent may touch.
Whatever differs between the baseline and the disk is pending.
Pending changes are shown inline, with a Keep and an Undo button per change.
Keeping a change moves it into the baseline.
Undoing a change restores the baseline text on disk.

\section{Evaluation}
We measured review time on twelve tasks.
Participants were faster with inline review on ten of them.
The remaining two tasks involved generated files.

\section{Conclusion}
Inline review makes agent edits easier to trust.
\end{document}
`;

const ANALYSIS_PY = `import statistics


def summarize(times):
    """Return the mean and the median review time."""
    mean = sum(times) / len(times)
    median = statistics.median(times)
    return mean, median


def speedup(before, after):
    return before / after


if __name__ == "__main__":
    print(summarize([12.0, 9.5, 14.2, 8.1]))
`;

function setup() {
  fs.rmSync(dir, { recursive: true, force: true });
  write('paper/main.tex', MAIN_TEX);
  write('paper/refs.bib', '@article{baseline2025,\n  title = {Baselines for Review},\n  year = {2025}\n}\n');
  write('src/analysis.py', ANALYSIS_PY);
  write('notes/old-todo.md', '# TODO\n\n- outline the paper\n- collect timing data\n');
  write('README.md', '# Sample project\n\nA paper and its analysis scripts.\n');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=Sample', '-c', 'user.email=sample@example.com', 'commit', '-qm', 'Initial version');
  console.log(`sample project ready: ${dir}`);
}

function wave1() {
  // A word-level rewrite, a deleted line, and an inserted paragraph in one file.
  replace('paper/main.tex',
    'Coding agents now write a large share of the code in many projects.',
    'Coding agents now write most of the code in many projects.');
  replace('paper/main.tex',
    'Reviewing what they changed is still done after the fact, in a separate tool.\n', '');
  replace('paper/main.tex',
    'Undoing a change restores the baseline text on disk.\n',
    'Undoing a change restores the baseline text on disk.\nEdits the user makes by hand are folded into the baseline when the file is saved,\nso only the agent\'s changes stay pending.\n');
  replace('paper/main.tex',
    'Participants were faster with inline review on ten of them.',
    'Participants were faster with inline review on eleven of them (p < 0.01).');
  // Written the way some tools do it: to a temp file, then renamed over the original.
  replace('src/analysis.py',
    '    mean = sum(times) / len(times)\n',
    '    if not times:\n        raise ValueError("no review times")\n    mean = statistics.fmean(times)\n', true);
  replace('src/analysis.py',
    'def speedup(before, after):\n    return before / after\n',
    'def speedup(before, after):\n    """How many times faster the second review was."""\n    return before / after if after else float("inf")\n', true);
  write('paper/appendix.tex', String.raw`\section{Appendix: Task List}
\begin{enumerate}
  \item Rename a function across three files.
  \item Fix an off-by-one error in a parser.
  \item Add input validation to a CLI.
\end{enumerate}
`);
  fs.rmSync(file('notes/old-todo.md'));
  console.log('agent: deleted notes/old-todo.md');
}

function wave2() {
  replace('paper/main.tex',
    'Inline review makes agent edits easier to trust.\n',
    'Inline review makes agent edits easier to trust.\nFuture work: review edits from several agents at once.\n');
}

const waves = { 1: wave1, 2: wave2 };
if (cmd === 'setup') {
  setup();
} else if (cmd === 'edit') {
  const fn = waves[waveArg ?? '1'];
  if (!fn) { throw new Error(`unknown wave ${waveArg}`); }
  fn();
} else if (cmd === 'all') {
  wave1();
  await new Promise((r) => setTimeout(r, 3000));
  wave2();
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
