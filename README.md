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

The toolbar is organized into **Navigate, Insert, Shapes, Paths, Arrange,
and View**. Select (V) and Pan (H) stay together; document commands remain in
the top bar. Tool groups wrap on tablets and scroll vertically on small screens.

- **Shapes:** rectangle (R), ellipse (E), circle (C), polygon (G). Drag to size
  them, or tap for a default size. Circles stay circular; choose 3–32 polygon
  sides in the properties panel before drawing. Edit points (N) lets you move
  polygon vertices independently to make irregular shapes.
- **Paths:** line (L), arrow (A), freehand Draw (P), Bézier (B), Edit points (N).
  Bézier follows Inkscape's pen workflow: click for connected straight segments,
  or drag at each node to pull symmetric handles for curved segments. Enter,
  right-click, double-click the last node, or **Finish path** completes it.
  Click the first node or **Close path** to close it; Escape cancels and
  Backspace removes the last node. **Continue path**, or clicking an endpoint
  of a selected open curve with Bézier, resumes drawing from that endpoint.
  **Edit points** drags anchors and control handles; **Add anchors** subdivides
  segments without changing their shape. Pending paths finish when switching
  tools, presenting/exporting, or leaving the app. They remain a single undo
  operation. Point editing supports these cubic paths, freehand strokes,
  polygons and polylines; other SVG commands remain selectable and transformable.
- **Insert:** text (T) and Media for pictures and movies (movies are converted
  to H.264 mp4 on upload so every browser can play them).
- **Arrange:** Group, Actions, Align and Format text. Align opens edge/centre
  alignment and equal-spacing controls. Several objects can align relative
  to their selection bounds or the slide; a single object aligns to the slide.
  Format text opens font, size, weight, bold/italic/underline and line alignment
  for selected text objects.

- Tap to select, drag to move, drag the handles to resize (corners keep the
  proportions; Shift frees them) or rotate. Drag on empty space to select
  several, or turn on *Select several* in the toolbar so taps add to (or take
  out of) the selection. Choose **Group** in the toolbar to combine the
  selected objects. Right-click or **tap with two fingers** for the Actions
  menu, including Group, Ungroup, Copy, Duplicate, stacking order and Delete.
  The Actions button opens the same menu. Several objects can be aligned and
  spaced evenly from the panel; a single object aligns with the slide. Movies must
  stay outside groups; grouping them or pasting them into a group is refused
  so they remain playable.
- **Grid** shows or hides the grid. **Snap** separately snaps moves, resizes,
  line ends and new shapes to it. Both buttons toggle on and off; spacing is
  set in the panel with nothing selected.
- Double-tap text to edit it, or a group to work inside it; tap outside,
  Done or Escape to leave. Editing keeps the text's formatting; while
  editing, the panel makes selected words bold, italic, underlined, sub/superscript or
  another colour.
- Choose **Pan** to drag the page without changing objects; choose **Select**
  to move objects, or a drawing tool to draw. The chosen tool works with a
  finger, mouse or Apple Pencil. Two fingers drag to pan or pinch to zoom in
  any tool; a brief two-finger tap opens Actions. Touches while the Pencil is
  down are ignored as palm contact.
- Everything saves automatically (the status shows Saved). Undo/redo per
  slide. If the same slide was changed elsewhere, saving stops and says so
  rather than overwriting.
- Keyboard: Ctrl+Z / Ctrl+Shift+Z, Ctrl+C / Ctrl+V (also across slides),
  Ctrl+D duplicate, Ctrl+G / Ctrl+Shift+G group, Delete, arrow keys nudge
  (Shift ×10), Page Up/Down change slide.
- Deleted slides go to the deck's `trash/` folder.

## Presenting

The bottom controls offer Previous, Next, Fullscreen and **Slide overview**.
Press **O** or **Escape** to toggle the overview; tap a thumbnail to jump to
that slide. Overview pauses active movies until returning to the presentation.
The live service also has **Back to editor**, returning to the current slide.
Offline exports retain the overview and navigation without an editor dependency.


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

## Persistent local service

The installed `svgdeck.service` user unit starts under `default.target`, restarts
on failure, and binds only the Tailscale address on port 8490. User lingering
keeps it running across logouts and starts the user manager at boot. Switchboard
registers the unit with a health URL and `client_url` for its **Open** button.
These machine-local settings stay outside the repository; decks and licensed
fonts remain in the separate data directory.
