# branding/

The app's logo and everything generated from it.

| Path | What |
|---|---|
| `icon.svg` | Source of every icon: a faded grey line (deleted text) above a bright white line (inserted text), with a short grey cursor at the edit point |
| `wordmark.svg` | Icon plus the lowercase name, set in Inter. Not used by the build |
| `gen-icons.py` | Regenerates `generated/` from `icon.svg` |
| `static/` | Hand-written files copied into `generated/`: Linux appdata, Windows tile manifest |
| `generated/` | Committed output, laid out like VSCodium's `src/stable/`. `fork/scripts/prepare-vscodium.sh` copies it over that folder, so the build needs no image tools |

```sh
pip install --user -r branding/requirements.txt
python3 branding/gen-icons.py          # fetches VSCodium at the pin for the document icons
python3 branding/gen-icons.py --vscodium ~/.cache/editor-fork-build/vscodium   # or reuses a checkout
```

Re-run it after changing `icon.svg`, then prepare a fresh tree. The name lives in `fork/branding.env`.

## What it generates

| Files | Used for |
|---|---|
| `resources/darwin/code.icns` | macOS app and dock icon, 16 to 1024 px, on Apple's 824/1024 grid |
| `resources/darwin/<language>.icns` | macOS document icons: VSCodium's language art with our icon over its corner mark |
| `resources/win32/code.ico`, `<language>.ico` | Windows app and document icons, 16 to 256 px |
| `resources/win32/code_70x70.png`, `code_150x150.png`, `inno-*.bmp` | Windows Start tiles and installer wizard images |
| `resources/linux/code.png`, `code.svg`, `rpm/code.xpm` | Linux app icon |
| `resources/server/favicon.ico`, `code-192.png`, `code-512.png` | Web server favicon and PWA icons |
| `src/vs/workbench/browser/media/code-icon.svg` | Title bar icon |
| `src/vs/workbench/browser/parts/editor/media/letterpress-*.svg` | Empty-editor watermark, one per theme: the mark alone in upstream's flat tones |
