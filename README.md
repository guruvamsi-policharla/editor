# Editor

## Try it: Keep/Undo in two minutes, no agent needed

`scripts/demo-agent.sh` is a fake agent. It edits a small LaTeX paper (a copy of [`examples/paper/`](examples/paper/)) the way a CLI agent would, writing straight to disk.

```bash
scripts/demo-agent.sh setup            # copies examples/paper to /tmp/editor-demo/paper
editor /tmp/editor-demo/paper          # or: open -a Editor /tmp/editor-demo/paper  (File > Open Folder... works too)
scripts/demo-agent.sh run              # press Enter once the folder is open
```

Over about 6 seconds the fake agent rewords a sentence in `sections/intro.tex`, deletes a line from the abstract, adds a paragraph, changes a number in the results, and creates `sections/related.tex` (plus its `\input` line in `main.tex`). Each change shows up inline with **Keep** / **Undo**:

- **Ctrl/Cmd+Y** keeps the change at the cursor; **Ctrl/Cmd+N** undoes it.
- The ↑/↓ arrows in the overlay jump between changes.
- **Agent Changes** in the Explorer lists every file, including the new one.

To start over, run `scripts/demo-agent.sh setup` again.
