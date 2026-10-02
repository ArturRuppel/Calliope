# svgdeck

Draw slide decks in the browser (iPad and Pencil friendly), present them with
embedded movies, and export them as standalone offline HTML.

Plan: [ROADMAP.md](ROADMAP.md). Deck format: [docs/format.md](docs/format.md).

## Setup

```
uv venv .venv && uv pip install -p .venv -e ".[dev]"
.venv/bin/python -m playwright install chromium   # for the tests
```

The service needs `ffmpeg` and `ffprobe` on the path: movies are converted on
upload and image sizes are probed with them. Slide, font and recovery request
bodies are capped at 64 MiB; media uploads at 2 GiB.

## Use

Decks live in the data directory (`~/Data/svgdeck/decks/<name>/`, or
`$SVGDECK_DATA`), never in this repo. Fonts are licensed and stay out of it too.

```
svgdeck serve                       # http://127.0.0.1:8490: deck list, editor, presenter
svgdeck export DECK_DIR OUT_DIR     # standalone copy: open OUT_DIR/index.html, no network needed
svgdeck export DECK_DIR OUT_DIR --zip talk.zip
svgdeck export DECK_DIR OUT_DIR --no-notes   # leave the speaker notes out of the copy
```

## The service on sancho

`systemd/svgdeck.service` runs `svgdeck serve` on sancho's Tailscale address,
port 8490 (install: copy it to `~/.config/systemd/user/`, then
`systemctl --user enable --now svgdeck`). Open `http://<sancho tailnet ip>:8490/`
on the iPad; "Add to Home Screen" gives it a full-screen window.

## Editing

The editor is laid out for an iPad in landscape:

- **Top bar:** back to all decks, the slide strip toggle, the **deck menu**
  (the deck's title; it shows the slide number and save state), undo/redo,
  the inspector toggle and **Present**.
- **Tool rail** on the left: Select (V), Draw (P), Erase (X), **Shapes** and
  **Path**, Text (T) and Media. Shapes and Path open a flyout with their
  members and keys; the rail shows the one used last.
- **View bar** floating over the stage: zoom out, Fit, zoom in, Grid, Snap,
  Guides, Several (select several) and Pan (H).
- **Selection bar**: a dark bar above whatever is selected (below it near the
  top of the slide) with that object's quick edits, **Align** and **More**
  (the actions menu).
- **Inspector** on the right with four tabs: **Design** (the selection's
  properties, or the slide's with nothing selected), **Objects**, **Builds**
  and **Notes**.

- **Shapes:** rectangle (R), ellipse (E), circle (C), polygon (G), line (L),
  arrow (A). Drag to size them, or tap for a default size. Circles stay
  circular; choose 3–32 polygon sides in the Design tab before drawing.
- **Draw and Erase:** while Draw belongs to the finger or the Pencil, an ink
  palette floats at the bottom of the stage (five colours, three widths); it
  sets the line colour and width of new strokes and shapes. Erase removes the
  strokes and lines it passes over (not shapes, text or media), as one undo
  step.
- **Path → Bézier (B)** follows Inkscape's pen workflow: click for connected
  straight segments, or drag at each node to pull symmetric handles for curved
  segments. Enter, right-click, double-click the last node, or **Finish path**
  (Design tab) completes it. Click the first node or **Close path** to close
  it; Escape cancels and Backspace removes the last node. **Continue path**, or
  clicking an endpoint of a selected open curve with Bézier, resumes drawing
  from that endpoint. Pending paths finish when switching tools,
  presenting/exporting, or leaving the editor; switching to another app only
  saves and keeps the draft (text edits too). They remain a single undo
  operation.
- **Path → Edit points (N)** works on every path (imported ones too: lines,
  arcs and quadratic curves become cubic segments when edited), polygon and
  polyline; **Edit points** in the selection bar starts it too. Tap a point to
  choose it, then drag it or its two handles. The selection bar then holds the
  point tools: **Corner** (handles move independently), **Smooth** (handles
  stay in line) or **Symmetric** (in line and equally long); Smooth and
  Symmetric pull out missing handles along the outline. Double-tap the outline
  to add a point there; **Add point** adds one halfway to the next, **Delete
  point** removes the chosen one. **Straight** and **Curved** change the
  segment after it; **Open path** opens a closed outline at the chosen point,
  **Close path** joins the ends, **Subdivide** doubles the points without
  changing the shape. **Done** returns to Select.
- **Clipboard images:** touch and hold on the slide, then choose **Paste** to
  insert at that spot. Approve iPad’s native **Paste** prompt if shown. Over
  HTTP, a small **Paste here** target stays on the canvas if the prompt is not
  available; touch and hold it and choose **Paste**. **Paste copied objects**
  in the actions menu inserts objects copied inside Calliope.
  You can also choose **Media**, then **Paste image**, or touch and hold
  in the paste box and choose iOS **Paste**. Over HTTP, **Paste image** focuses
  the box and requests iPad’s native Paste prompt; approve **Paste** there.
  If no prompt appears, touch and hold in the box and choose **Paste**.
  Images inserted directly into the box by Safari are imported too.
  Keyboard paste inserts copied
  images on the slide; text fields keep their usual paste behavior. Images use
  the same saved media and undo path as file uploads.
- **Text (T)** and **Media** (pictures and movies; movies are converted to
  H.264 mp4 on upload so every browser can play them).

- Tap to select, drag to move, drag the handles to resize (rotated objects
  show their handles turned with them and resize along their own axes; corners keep the
  proportions; Shift frees them) or rotate. Drag on empty space to select
  several, or turn on **Several** in the view bar so taps add to (or take out
  of) the selection; the selection bar then offers **Group**. Right-click,
  **touch and hold on the slide**, **tap with two fingers** or **More** opens
  the actions menu: copy, cut, paste, duplicate, group, ungroup, stacking order, lock and delete. Movies
  must stay outside groups; grouping them or pasting them into a group is
  refused so they remain playable.
- The selection bar depends on what is selected: text gets font, size, bold,
  italic, underline and colour; images and movies get **Crop** (movies also
  Autoplay, Loop and their sync group); groups get Edit inside and Ungroup;
  shapes get fill and line colour. Colour buttons open the Design tab, which
  holds the full palettes and every other property, plus the object's
  **Build step**.
- **Align** in the selection bar aligns edges and centres. A single object
  aligns to the slide; several align to their selection bounds or, switched,
  to the slide; three or more can be spaced evenly across or down.
- Objects that reach past the slide edge stay visible and selectable in the
  editor. The part outside the slide is faded, because presenting, exports
  and thumbnails show only what is on the slide.
- **Grid** shows or hides the grid. **Snap** separately snaps moves, resizes,
  line ends and new shapes to it. Spacing is set in the Design tab with
  nothing selected.
- **Guides** snaps moved objects to other objects' edges, centres and equal
  gaps. Purple guides show the match. Grid Snap takes precedence when enabled;
  hold Alt while moving to bypass both, or Shift to constrain an axis.
- **Objects** lists the stacking order and nested groups, with names,
  visibility, locking, drag reordering within a group, and raise/lower buttons
  for touch. **Builds** assigns when selected objects appear, lists their
  sequence, and previews the slide from its initial state. Objects sharing a
  step appear together. Preview visibility is never saved into the SVG.
- Cropped images and movies use their visible crop for selection bounds, resize handles, alignment and snapping. Crop mode retains access to the full source.
- **Crop** (selection bar or Design tab) on an image or movie: drag its edge or
  corner handles; the faded original stays visible. Done/Enter accepts the
  crop as one undo step; Cancel/Escape discards it. Two fingers still pan and
  zoom while cropping, and tapping another object cancels the crop. Advanced offers numeric
  insets and rectangle/ellipse masks; Reset restores the full image. Deleting
  a cropped or adjusted image also removes its clip path and filter. Source
  media and imported clip paths remain untouched.
- **Image adjustments** in the Design tab: saturation (0% for grayscale), hue shift, brightness and contrast, with sliders and numeric values. **Reset adjustments** restores the original colours; **Opacity** controls transparency. Edits keep source images intact and carry into presentations and offline exports. Select several images to adjust them together.
- **Custom…** beside any colour palette opens synchronized HEX, RGB and HSL
  fields, a visual picker, and an opacity slider. Colour transparency is
  independent of whole-object opacity. Paste a colour in any notation (HEX
  with or without `#`, `rgb()`, `hsl()`, a CSS name) into any field and all
  of them follow; **Copy colour** copies the value. **Pick from slide** hides
  the dialog: tap or click a shape's fill or line, a text or an image pixel to
  take its colour (the opacity stays as set; image adjustments are not
  applied to the picked pixel). Escape or **Cancel** leaves picking.
- **Notes** (inspector tab) saves plain-text notes with each slide as you type.
  **Speaker view** (deck menu) shows the current slide, next slide, notes and
  a timer. Choose **Open audience window** and move that window to the
  presentation screen; navigation, build steps and blanking stay synchronized
  between them.
- Double-tap text to edit it, or a group to work inside it; tap outside,
  **Done** or Escape to leave. Editing keeps the text's formatting; while
  editing, the selection bar makes selected words bold, italic, underlined or
  sub/superscript, and the Design tab gives them another colour.
- Choose **Pan** to drag the page without changing objects; choose **Select**
  to move objects, or a drawing tool to draw. Two fingers drag to pan or pinch
  to zoom in any tool; a brief two-finger tap opens the actions menu. Touches
  while the Pencil is down are ignored as palm contact.
- **The Apple Pencil has its own tool.** Tap a tool with the Pencil to give it
  to the Pencil (its button gets a red pencil badge); tap with a finger to give
  it to the finger and the mouse. In a Shapes or Path flyout, the tap on the
  member counts. The Pencil starts with Draw, so it draws while a finger
  selects and moves. With the Pencil, letter keys change the Pencil's tool.
  The Pencil's pressure sets the line width of Draw strokes (they are saved as
  filled outlines, `data-ink="pressure"`; their colour is the fill). Both can
  be turned off under **deck menu → Pencil and controller**.
- **Controllers and key devices switch tools.** A gamepad works out of the
  box (press a button to connect it): A Draw, B Erase, X Select, Y Edit points,
  D-pad up Bézier, D-pad down finger Select, LB/RB undo/redo, LT pans with the
  Pencil while held, RT returns to the previous Pencil tool, D-pad left/right
  change slide. Anything that types keys (macro pad, foot pedal, presentation
  clicker) can be bound too: choose an action under **Pencil and controller**,
  press **Assign a key or button**, then press it. Actions set the Pencil's
  or the finger's tool, set a Pencil tool only while held, or run undo, redo,
  delete, fit and slide changes. Bindings are kept per browser.
- Edits autosave to the **working copy**. While the service cannot be reached
  the status reads "Not saved · retrying" and saving is retried with backoff;
  leaving the editor waits for the save first. **Deck menu → Commit snapshot…**
  saves a named, immutable snapshot of the whole deck, including slide order
  and notes. Its history offers text diffs against the previous commit or
  working copy and full-deck restore (restore asks for a second confirmation).
  The first edit protects the original as
  a baseline; restoring also saves the working copy as a safety commit.
  Unchanged content is shared and media is never copied into commits.
  Undo/redo remains per slide. Concurrent edits stop saving or restoring
  instead of silently overwriting changes.
- **Deck menu → Export offline copy** downloads a .zip that plays without a
  network; **Deck settings** holds the font library (upload .otf/.ttf).
- The slide strip's **+ Slide** adds a slide after the current one; **…**
  duplicates, moves or deletes it.
- Keyboard: Ctrl+Z / Ctrl+Shift+Z, Ctrl+C / Ctrl+V (also across slides),
  Ctrl+D duplicate, Ctrl+G / Ctrl+Shift+G group, Delete, arrow keys nudge
  (Shift ×10), Page Up/Down change slide.
- Deleted slides go to the deck's `trash/` folder.
- **Delete** on the decks page (tap twice) moves the whole deck to
  `<data>/trash/<name>.<timestamp>/`; **Recently deleted** below the list
  restores it. Nothing is purged automatically: remove the folder by hand.
- **Deck menu → History and recovery** lists the last 30 saved slide revisions
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
Press **O** to toggle the overview (Escape only closes it, so a clicker's
Escape cannot open it mid-talk); tap a thumbnail to jump to that slide.
Overview pauses active movies until returning to the presentation. Only the
current and neighbouring slides' movies stay loaded. Speaker notes are included
in offline exports by default so speaker view works there; `--no-notes` omits
them.
The live service also has **Back to editor**, returning to the current slide.
Offline exports retain the overview and navigation without an editor dependency.
Speaker view is also available from the presentation controls in offline exports.
Its audience window displays only the presentation, with no speaker controls or notes.


Arrows / space / page keys / click or swipe to move (`n`/`p` work too), a
number then Enter to jump, `b` or `.` for a blank screen, `f` or a mouse
double-click for full screen. A single mouse click advances after a short
pause so a double-click never changes the slide; taps advance at once. The
speaker window keeps its session in the address bar, so reloading it
reconnects the audience window. The address bar shows `#slide.step`.

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
keeps it running across logouts and starts the user manager at boot. The unit
refuses to start until Tailscale has an IPv4 address (an empty address would
bind every interface) and retries every few seconds. Switchboard registers the
unit with `GET /healthz` as the health URL (it answers without touching the data
directory) and `client_url` for its **Open** button.
These machine-local settings stay outside the repository; decks and licensed
fonts remain in the separate data directory.
