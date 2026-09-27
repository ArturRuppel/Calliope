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
- **Paths:** line (L), arrow (A), freehand Draw (P), Erase (X), Bézier (B),
  Edit points (N). Erase removes the strokes and lines it passes over (not
  shapes, text or media), as one undo step.
  Bézier follows Inkscape's pen workflow: click for connected straight segments,
  or drag at each node to pull symmetric handles for curved segments. Enter,
  right-click, double-click the last node, or **Finish path** completes it.
  Click the first node or **Close path** to close it; Escape cancels and
  Backspace removes the last node. **Continue path**, or clicking an endpoint
  of a selected open curve with Bézier, resumes drawing from that endpoint.
  Pending paths finish when switching tools, presenting/exporting, or leaving
  the app. They remain a single undo operation.
- **Edit points** works on every path (imported ones too: lines, arcs and
  quadratic curves become cubic segments when edited), polygon and polyline.
  Tap a point to choose it, then drag it or its two handles. Each point is a
  **Corner** (handles move independently), **Smooth** (handles stay in line)
  or **Symmetric** (in line and equally long); Smooth and Symmetric pull out
  missing handles along the outline. Double-tap the outline to add a point
  there; **Add point** adds one halfway to the next, Delete removes the chosen
  point. **Straight** and **Curved** change the segment after it; **Open
  path** opens a closed outline at the chosen point, **Close path** joins the
  ends, **Subdivide** doubles the points without changing the shape.
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
- Objects that reach past the slide edge stay visible and selectable in the
  editor. The part outside the slide is faded, because presenting, exports
  and thumbnails show only what is on the slide.
- **Grid** shows or hides the grid. **Snap** separately snaps moves, resizes,
  line ends and new shapes to it. Both buttons toggle on and off; spacing is
  set in the panel with nothing selected.
- **Guides** snaps moved objects to other objects' edges, centres and equal
  gaps. Purple guides show the match. Grid Snap takes precedence when enabled;
  hold Alt while moving to bypass both, or Shift to constrain an axis.
- **View → Panels** keeps the extra editing panels together:
  **Objects** lists the stacking order and nested groups, with names, visibility,
  locking, drag reordering within a group, and raise/lower buttons for touch.
  **Build steps** assigns when selected objects appear, lists their sequence,
  and previews the slide from its initial state. Objects sharing a step appear
  together. Preview visibility is never saved into the SVG.
  **Crop and mask** offers percentage insets and rectangle/ellipse masks for
  a selected image or movie. Cropping is reversible, supports Undo and Reset,
  and leaves the source media untouched. Existing imported clip paths are
  preserved; the crop panel refuses to replace them.
- **Speaker notes**, also in Panels, saves plain-text notes with each slide.
  **Speaker view** shows the current slide, next slide, notes and a timer.
  Choose **Open audience window** and move that window to the presentation
  screen; navigation, build steps and blanking stay synchronized between them.
- Double-tap text to edit it, or a group to work inside it; tap outside,
  Done or Escape to leave. Editing keeps the text's formatting; while
  editing, the panel makes selected words bold, italic, underlined, sub/superscript or
  another colour.
- Choose **Pan** to drag the page without changing objects; choose **Select**
  to move objects, or a drawing tool to draw. Two fingers drag to pan or pinch
  to zoom in any tool; a brief two-finger tap opens Actions. Touches while the
  Pencil is down are ignored as palm contact.
- **The Apple Pencil has its own tool.** Tap a tool with the Pencil to give it
  to the Pencil (its button gets a pencil badge); tap with a finger to give it
  to the finger and the mouse. The Pencil starts with Draw, so it draws while
  a finger selects and moves. With the Pencil, letter keys change the Pencil's
  tool. The Pencil's pressure sets the line width of Draw strokes (they are
  saved as filled outlines, `data-ink="pressure"`; their colour is the fill).
  Both can be turned off under **Pencil and controller** in the panel (nothing
  selected), which the **Input** group of the toolbar opens.
- **Controllers and key devices switch tools.** A gamepad works out of the
  box (press a button to connect it): A Draw, B Erase, X Select, Y Edit points,
  D-pad up Bézier, D-pad down finger Select, LB/RB undo/redo, LT pans with the
  Pencil while held, RT returns to the previous Pencil tool, D-pad left/right
  change slide. Anything that types keys (macro pad, foot pedal, presentation
  clicker) can be bound too: choose an action under **Pencil and controller**,
  press **Assign a key or button**, then press it. Actions set the Pencil's
  or the finger's tool, set a Pencil tool only while held, or run undo, redo,
  delete, fit and slide changes. Bindings are kept per browser.
- Everything saves automatically (the status shows Saved). Undo/redo per
  slide. If the same slide was changed elsewhere, saving stops and says so
  rather than overwriting.
- Keyboard: Ctrl+Z / Ctrl+Shift+Z, Ctrl+C / Ctrl+V (also across slides),
  Ctrl+D duplicate, Ctrl+G / Ctrl+Shift+G group, Delete, arrow keys nudge
  (Shift ×10), Page Up/Down change slide.
- Deleted slides go to the deck's `trash/` folder.
- **Panels → History and recovery** lists the last 30 saved slide revisions
  and deleted slides, with restore controls. Restoring a revision checkpoints
  the current artwork first. If saving detects a conflict, **Keep both versions**
  preserves local edits as a recovered slide and retains the server's version.
  If recovery cannot reach the server, it downloads the local SVG as a fallback.
  Revisions cover slide artwork; speaker notes are retained when deleting and
  restoring slides, but are not part of artwork revision history.

## Presenting

The controls are a small bar of icons (previous, slide number, next,
overview, back to editor, full screen). They show for three seconds at the
start and then hide; a mouse move, the Tab key, or on a touch screen a tap
along the bottom edge brings them back. The idle mouse cursor hides too.
Press **O** or **Escape** to toggle the overview; tap a thumbnail to jump to
that slide. Overview pauses active movies until returning to the presentation.
The live service also has **Back to editor**, returning to the current slide.
Offline exports retain the overview and navigation without an editor dependency.
Speaker view is also available from the presentation controls in offline exports.
Its audience window displays only the presentation, with no speaker controls or notes.


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
