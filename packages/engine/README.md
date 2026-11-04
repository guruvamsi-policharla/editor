# @editor/engine

The review engine: a standalone TypeScript library (no VS Code dependency) that tracks an **accepted baseline** for a workspace and reports everything else on disk as pending, as line-sized hunks with word-level highlights.

```
pending = disk − baseline
accept  → fold disk content into the baseline
reject  → write baseline content back to disk
```

## Usage

```ts
import { ReviewEngine } from '@editor/engine';

const engine = await ReviewEngine.open({
  root: '/path/to/workspace',
  storageDir: '/path/to/extension-storage/<root-id>', // engine-owned; one per root
});

// The host owns the file watcher and forwards events (absolute or root-relative paths).
watcher.onDidChange((uri) => engine.handleFsEvents([uri.fsPath]));

// Before writing a user save, report it (or pass `base` if you report after writing).
await engine.reportUserSave('paper.tex', text, { edits }); // edits: [{ offset, length, text, origin: 'user' | 'formatter' }]

engine.onDidChange(({ reason, paths }) => rerender(paths));

for (const change of engine.listChanges()) {
  // { path, kind: 'modified' | 'created' | 'deleted' | 'renamed', oldPath?, binary, large, reviewMode: 'hunk' | 'file' }
}
const { hunks } = (await engine.getFileChange('paper.tex'))!;
await engine.acceptHunk('paper.tex', hunks[0].id);
await engine.rejectFile('figs/old.pdf');
await engine.acceptAll();
```

Multi-root workspaces: `MultiRootReview.open({ roots, storageBase })` makes one engine and one baseline store per root and routes events to them.

## Host contract

- **Events.** The engine never watches the disk. Forward watcher events with `handleFsEvents`; only paths matter (each is re-examined). An event for the root (or `rescan()`) re-walks everything. Git state is checked after every event batch, so forwarding `.git/` events is optional (call `checkGit()` if you want to poll).
- **User saves.** Call `reportUserSave(path, content, { edits })` before the bytes hit disk, or pass `base` (the disk content the buffer's edits started from). `edits` is the ordered buffer edit log since the last disk sync (VS Code `contentChanges`, flattened). Tag the user's own edits `'user'` (typing, paste, undo/redo, rename-symbol) and editor-triggered formatting `'formatter'` (format on save, format document, code actions on save). Without `edits`, every changed line counts as the user's. A host whose review UI keeps its own baseline live (the fork's editor) passes it as `reviewBaseline`; the engine then takes it as is, so both agree on what is pending.
- **User deletes/renames** in the editor: `reportUserDelete`, `reportUserRename`.
- **Staleness.** Accept/reject re-read the disk. If a hunk id no longer matches, or a file changed since the engine last observed it, they throw `StaleChangeError` after refreshing, so the host re-renders and retries. `acceptAll`/`rejectAll` skip such files and report them in `skipped`.

## Behavior

| Situation | Result |
| --- | --- |
| First open | baseline = disk, nothing pending |
| Agent edits a region several times | one combined hunk against the baseline |
| User save | never accepts: edits outside pending agent hunks fold into the baseline; a hunk the user edited (on its lines, or new lines at its edge) stays pending as a whole, with the edits in it, until accept/reject |
| Formatter on save | inside a pending agent hunk: stays pending; elsewhere: folds in |
| Created / deleted file | file-level unit; reject deletes / restores it |
| Delete + create, identical content | one rename unit; reject moves it back |
| Binary (NUL byte or invalid UTF-8) or larger than 1 MiB | file-level accept/reject only |
| `git add` (index-only change) | accepts pending changes in the staged files only (with `git add -p`, only the hunks the index agrees with) |
| HEAD moves (commit, checkout, pull, merge, rebase, reset, cherry-pick) | accepts, whole and as on disk, only the files that differ between the old and the new HEAD tree (`git diff-tree -M`; both sides of a rename, deletions too). Whole includes a committed file's hunks that were not staged or committed. Other pending changes stay pending. If git can't diff the two commits, everything pending is accepted |
| `git stash` / `git stash pop` (only `refs/stash` moves) | accepts nothing: plain disk changes, so pending changes come back with pop |
| Editor closed while the agent edits | changes are pending on the next open |
| Ignored | `.gitignore` (nested), `.git/info/exclude`, defaults (`node_modules/`, `dist/`, `build/`, `out/`, `target/`, `.next/`, `__pycache__/`, `coverage/`, LaTeX aux files, and `X.pdf` only when `X.tex` sits next to it), plus user patterns (highest precedence, `!` re-includes) |

The baseline lives in a private bare git repository under `storageDir` (`baseline.git`, standard loose objects, readable with `git --git-dir=... cat-file -p <oid>`), plus `state.json` with the manifest, a stat cache, and the last observed git state. The user's repository is only ever read.

## Layout

```
src/
  engine.ts        ReviewEngine: state, events, operations, git-op handling
  attribution.ts   edit-log replay and the user-save fold (which lines join the baseline)
  staging.ts       which pending hunks the git index agrees with (partial staging)
  diff/myers.ts    Myers diff → change regions
  diff/hunks.ts    line-sized hunks, accept/reject regions
  diff/words.ts    word-level ranges inside a hunk
  ignore.ts        ignore rules
  git/repo.ts      read-only git: repo discovery, HEAD/refs, index parser (v2–v4), blob reader
  store/           shadow object store and persisted state
  fs.ts            FileSystem interface, Node implementation, in-memory implementation
  multiRoot.ts     one engine per workspace root
```

## Development

```sh
npm install          # from the repo root
npm run build        # tsc → dist/
npm test             # vitest + fast-check
FC_RUNS=5000 npm test -w @editor/engine   # run the property tests harder
```
