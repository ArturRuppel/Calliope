# svgdeck

Draw slide decks in the browser (iPad and Pencil friendly), present them with
embedded movies, and export them as standalone offline HTML.

Plan: [ROADMAP.md](ROADMAP.md). Deck format: [docs/format.md](docs/format.md).

## Setup

```
uv venv .venv && uv pip install -p .venv -e ".[dev]"
.venv/bin/python -m playwright install chromium   # for the tests
```

## Use

Decks live in the data directory (`~/Data/svgdeck/decks/<name>/`, or
`$SVGDECK_DATA`), never in this repo. Fonts are licensed and stay out of it too.

```
svgdeck serve                       # http://127.0.0.1:8490: deck list, editor, presenter
svgdeck export DECK_DIR OUT_DIR     # standalone copy: open OUT_DIR/index.html, no network needed
svgdeck export DECK_DIR OUT_DIR --zip talk.zip
```

## The service on sancho

`systemd/svgdeck.service` runs `svgdeck serve` on sancho's Tailscale address,
port 8490 (install: copy it to `~/.config/systemd/user/`, then
`systemctl --user enable --now svgdeck`). Open `http://<sancho tailnet ip>:8490/`
on the iPad; "Add to Home Screen" gives it a full-screen window.

## Editing

Tools: select (V), text (T), rectangle (R), ellipse (E), line (L), arrow (A),
draw (P), and the image button for pictures and movies (movies are converted to
H.264 mp4 on upload so every browser can play them).

- Tap to select, drag to move, drag the handles to resize (corners keep the
  proportions; Shift frees them) or rotate. Drag on empty space to select
  several, or turn on *Select several* in the toolbar so taps add to (or take
  out of) the selection. Several objects can be grouped, aligned and spaced
  evenly from the panel; a single object aligns with the slide.
- The grid button snaps moves, resizes, line ends and new shapes to a grid.
  The spacing (and showing the grid) is set in the panel with nothing
  selected.
- Double-tap text to edit it, or a group to work inside it; tap outside,
  Done or Escape to leave. Editing keeps the text's formatting; while
  editing, the panel makes selected words bold, italic, sub/superscript or
  another colour.
- With an Apple Pencil, the Pencil draws and fingers pan; two fingers pinch to
  zoom.
- Everything saves automatically (the status shows Saved). Undo/redo per
  slide. If the same slide was changed elsewhere, saving stops and says so
  rather than overwriting.
- Keyboard: Ctrl+Z / Ctrl+Shift+Z, Ctrl+C / Ctrl+V (also across slides),
  Ctrl+D duplicate, Ctrl+G / Ctrl+Shift+G group, Delete, arrow keys nudge
  (Shift ×10), Page Up/Down change slide.
- Deleted slides go to the deck's `trash/` folder.

## Presenting

Arrows / space / page keys / click or swipe to move, a number then
Enter to jump, `b` or `.` for a blank screen, `f` or double-click for full
screen. The address bar shows `#slide.step`.

## Development tools

- `tools/import_inkscape.py` — one-off import of the 2026-05-19 Inkscape talk,
  the development test deck.
- `tools/compare_render.py` — renders every slide of an export in headless
  Chromium and diffs it against the old Inkscape PNGs.

```
.venv/bin/python -m pytest tests                      # Chromium
SVGDECK_BROWSER=webkit .venv/bin/python -m pytest tests  # WebKit = the iPad's engine
```

Playwright's WebKit does not run on Arch (sancho); it runs on rocinante
(Ubuntu 24.04) after `playwright install webkit`, with `libavif16`,
`libgav1-1` and `libyuv0` unpacked from `apt-get download` into the WebKit
build's `minibrowser-wpe/lib/` (no sudo needed). Headless WebKit there freezes
on video, so movie tests only run in Chromium.
