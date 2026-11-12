# svgdeck

Draw slide decks in the browser (iPad and Pencil friendly), present them with
embedded movies, and export them as standalone offline HTML.

Plan: [ROADMAP.md](ROADMAP.md). Deck format: [docs/format.md](docs/format.md).

Try it at https://arturruppel.github.io/Calliope/, nothing to install.
Licensed under the GNU AGPL-3.0: see [LICENSE](LICENSE).

## Setup

```
uv venv .venv && uv pip install -p .venv -e ".[dev]"
.venv/bin/python -m playwright install chromium   # for the tests and PDF export
```

PDF export needs Playwright with a Chromium: `pip install 'svgdeck[pdf]'` and
`playwright install chromium` on a plain install (the `dev` extra already has
it), or `SVGDECK_CHROMIUM=/path/to/chromium` to use another Chromium. Without
it, `svgdeck pdf`, `export --pdf` and the editor's PDF download stop with a
message saying so.

The service needs `ffmpeg` and `ffprobe` on the path: movies are converted on
upload and image sizes are probed with them. Slide, font and recovery request
bodies are capped at 64 MiB; media uploads at 2 GiB.

## Use

Decks live in the data directory (`~/Data/svgdeck/decks/<name>/`, or
`$SVGDECK_DATA`), never in this repo. Fonts are licensed and stay out of it too.

`scripts/backup.sh` mirrors the whole data directory with rsync to the
directory named by `CALLIOPE_BACKUP_DIR` (required; never deleting there), for
example a mounted network share. `calliope-backup.timer` (systemd user, hourly)
runs it; set the variable in a local drop-in such as
`~/.config/systemd/user/calliope-backup.service.d/local.conf`
(`[Service]` / `Environment=CALLIOPE_BACKUP_DIR=...`). It skips quietly when
the share is unreachable (the directory in `CALLIOPE_BACKUP_PROBE`, by default
the destination's parent, is missing).

```
svgdeck serve                       # http://127.0.0.1:8490: deck list, editor, presenter
svgdeck export DECK_DIR OUT_DIR     # standalone copy: open OUT_DIR/index.html, no network needed
svgdeck export DECK_DIR OUT_DIR --zip talk.zip
svgdeck export DECK_DIR OUT_DIR --pdf        # also write OUT_DIR/deck.pdf (and put it in the zip)
svgdeck pdf DECK_DIR talk.pdf               # one page per slide, every build step shown
svgdeck pdf DECK_DIR talk.pdf --steps       # one page per build step
```

## The service

`systemd/calliope.service` runs `svgdeck serve` on 127.0.0.1:8490 (install:
copy it to `~/.config/systemd/user/`, then `systemctl --user enable --now
calliope`). Tailscale Serve publishes it to the tailnet over HTTPS; this is set
up once and survives reboots:

```sh
tailscale serve --bg --https=8490 http://127.0.0.1:8490
```

Open `https://<machine>.<tailnet>.ts.net:8490/` on the iPad; "Add to Home
Screen" gives it a full-screen window. HTTPS matters: without it the browser
will not keep the offline copy (below).

The service answers only requests addressed to a name it knows: 127.0.0.1,
localhost and [::1], plus the names in `SVGDECK_HOSTS` (comma separated) or
given with `--allow-host`. Tailscale Serve passes the browser's `Host` on as
it is, so the tailnet name has to be listed, without scheme or port:

```ini
# ~/.config/systemd/user/calliope.service.d/local.conf
[Service]
Environment=SVGDECK_HOSTS=<machine>.<tailnet>.ts.net
```

Requests for any other name get 400 (this stops DNS rebinding). Requests that
change something (anything but GET, HEAD and OPTIONS) are refused with 403 when
the browser marks them cross-site or their `Origin` is not the service's own;
requests without an `Origin`, such as curl or a script on the machine, pass.

### The offline copy

Opening the deck list copies every deck into the browser so it can be
presented when the server cannot be reached. The copy is read-only: decks can
be presented, not edited. The status line under the header says how current
the copy is; tap it to sync again. A sync downloads only what changed since
the last one (`GET /api/offline` lists every file with a version), and drops
decks and files the server no longer has.

- The deck list and presenter pages ask the server first and fall back to the
  copy after 4 s. Deck media and fonts always come from the copy, cut into
  ranges for movies (Safari will not play a movie otherwise).
- Without the server the deck list hides everything but **Present**; the
  editor and anything else that needs the server shows a "needs the server"
  page instead.
- A deck that cannot be copied (for example a slide file gone missing) leaves
  the copy marked incomplete; the other decks are still copied.
- The service worker is `svgdeck/editor/sw.js`, served as `/sw.js` so it covers
  the presenter as well; `svgdeck/editor/offline.js` does the syncing. Opening
  the deck list once while online, after a change, is what brings the copy up
  to date.

## In the browser, with nothing to install

Try it at https://arturruppel.github.io/Calliope/.

The editor, the presenter and the svgdeck service itself run in the
browser, under Pyodide in a Web Worker, so Calliope works from static files with no
server. Decks are kept in the browser (IndexedDB, pictures and movies in the
Origin Private File System); they move in and out as zips (**Export offline
copy**, **Import a deck**). Movies are stored as they are (no ffmpeg) and PDF
is the browser's print. Design, storage layout and open questions:
[docs/browser-runtime.md](docs/browser-runtime.md).

```sh
npm install && npm run build:web     # -> dist-web/: serve it anywhere, or open dist-web/index.html
npm run test:e2e                     # headless Chromium, about 20 s
```

## Editing

The editor is laid out for an iPad in landscape:

- **Top bar:** back to all decks, the slide strip toggle, the **deck menu**
  (the deck's title; it shows the slide number and save state), undo/redo
  (greyed out when there is nothing to undo or redo), the inspector toggle
  and **Present**.
- **Tool rail** on the left: Select (V), Draw (P), Erase (X), **Shapes** and
  **Path**, Text (T) and Media. Shapes and Path open a flyout with their
  members and keys; the rail shows the one used last.
- **View bar** floating over the stage: zoom out, Fit, zoom in, Grid, Snap,
  Guides, Several (select several) and Pan (H).
- **Selection bar**: a dark bar above whatever is selected (below it near the
  top of the slide) with that object's quick edits, **Align** and **More**
  (the actions menu).
- **Inspector** on the right with three tabs: **Design** (the selection's
  properties, or the slide's with nothing selected), **Objects** and
  **Builds**.

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
  it; Escape cancels and Backspace removes the last node. Shift keeps a new
  point at 45° steps from the previous one and turns a dragged handle in 45°
  steps (the line and arrow tools constrain to 45° with Shift too). **Continue path**, or
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
  proportions; Shift frees them; Alt/Option resizes from the centre) or rotate. Drag on empty space to select
  several, or turn on **Several** in the view bar so taps add to (or take out
  of) the selection; the selection bar then offers **Group**. Right-click,
  **touch and hold on the slide**, **tap with two fingers** or **More** opens
  the actions menu: copy, cut, paste, duplicate, group, ungroup, stacking order, lock and delete.
  Copy and Cut also put the objects on the system clipboard as SVG, so they
  paste into other apps; pasting SVG copied elsewhere inserts it as objects at
  the pointer (or the visible centre), and pasting plain text makes a text
  object. Movies
  must stay outside groups; grouping them or pasting them into a group is
  refused so they remain playable.
- The selection bar depends on what is selected: text gets font, size, bold,
  italic, underline and colour; images and movies get **Crop** and
  **Replace…** (movies also
  Autoplay, Loop and their sync group); groups get Edit inside and Ungroup;
  shapes get fill and line colour. Colour buttons open the Design tab, which
  holds the full palettes and every other property, plus the object's
  **Build step**. Its **Position** section gives X, Y, W and H of the
  selection's bounds in slide pixels, with a lock that keeps W and H in
  proportion. **Line style** sets the dash (Solid, Dashed, Dotted, or a
  custom pattern such as `12 6 2 6`; the presets scale with the line width),
  the ends (Flat, Round, Square) and the joins (Mitre, Round, Bevel) of shapes,
  lines and paths; rectangles also get **Corners**, a radius in pixels that
  stays put when the rectangle is resized.
- **Align** in the selection bar aligns edges and centres. A single object
  aligns to the slide; several align with **Each other** (the box around
  them), with the one **First picked** (it stays put) or with the **Slide**.
  The canvas outlines the chosen reference in purple while the row is open.
  Three or more can be spaced evenly across or down.
- Objects that reach past the slide edge stay visible and selectable in the
  editor. The part outside the slide is faded, because presenting, exports
  and thumbnails show only what is on the slide.
- **Grid** shows or hides the grid. **Snap** separately snaps moves, resizes,
  line ends and new shapes to it. Spacing is set in the Design tab with
  nothing selected.
- **Guides** snaps moved objects to other objects' edges, centres and equal
  gaps, and to the slide's edges and centre lines. Purple guides show the
  match. While resizing, the dragged edge snaps to the slide's and other
  objects' edges and centres; the dragged corner of a new shape or end of a
  new line does too (not with Shift held, and not for circles). Grid Snap
  takes precedence when enabled; hold Alt while moving or drawing to bypass
  both, or Shift to constrain an axis. **Axis** in the top bar does the same
  without a keyboard: while it is on, a drag moves objects straight across
  or straight up and down, whichever the drag is closer to.
- **Layout boxes** (Shapes → Layout box, F) are dashed rectangles that exist
  only for laying a slide out: the editor shows them, the presentation, the
  PDF and any other SVG viewer do not (they are stored as
  `<rect data-layout="true" visibility="hidden">`). They sit behind the
  artwork and are picked by their outline, so what lies in a box stays easy
  to select. **Split** in a box's bar replaces it by a grid of equal boxes
  (rows, columns, gap in slide pixels). Objects snap to a box's edges and
  centre like to any other object; **Fit to box** in the bar of an object
  lying in a box scales it to fill the box, keeping its proportions, and
  centres it (text is only centred). Exact sizes go in the Position fields.
- **Objects** lists the stacking order and nested groups, with names,
  visibility, locking, drag reordering within a group, and raise/lower buttons
  for touch. **Builds** assigns when selected objects appear, lists their
  sequence, and previews the slide from its initial state. Objects sharing a
  step appear together. Preview visibility is never saved into the SVG.
- Cropped images and movies use their visible crop for selection bounds, resize handles, alignment and snapping. Crop mode retains access to the full source.
- **Crop** (selection bar or Design tab) on an image or movie: drag its edge or
  corner handles; the faded original stays visible. Done/Enter accepts the
  crop as one undo step; Cancel/Escape discards it. **Aspect**, or Shift
  while dragging, keeps the crop's proportions: corners resize from the
  opposite corner, edges resize the other side symmetrically about the centre
  (the lock starts off with each crop). Two fingers still pan and
  zoom while cropping, and tapping another object cancels the crop. Advanced offers numeric
  insets and rectangle/ellipse masks; Reset restores the full image. Deleting
  a cropped or adjusted image also removes its clip path and filter. Source
  media and imported clip paths remain untouched.
- **Replace…** on a single image or movie swaps only the picture or movie and
  keeps its position, size, rotation, opacity, build step, label, lock, crop
  and adjustments, as one undo step. A different aspect ratio is fitted inside
  the existing box. Replacing a picture with a movie makes it autoplay and
  loop; replacing a movie with a picture drops the playback settings and the
  sync group. A movie's trim does not carry over to its replacement.
- **Trim** on a selected movie (or **Design → Playback → Trim movie…**)
  opens a preview with start/end sliders, times in seconds and buttons to use
  the current frame. **Play excerpt** previews the range; **Apply trim** saves
  it as one undo step. **Reset to full movie**, then Apply, removes the trim.
  Loop repeats the selected excerpt in presentations and offline exports.
  The original movie and poster stay unchanged.
- **Image adjustments** in the Design tab: saturation (0% for grayscale), hue shift, brightness and contrast, with sliders and numeric values. **Reset adjustments** restores the original colours; **Opacity** controls transparency. Edits keep source images intact and carry into presentations and offline exports. Select several images to adjust them together.
- **Custom…** beside any colour palette opens synchronized HEX, RGB and HSL
  fields, a visual picker, and an opacity slider. Colour transparency is
  independent of whole-object opacity. Paste a colour in any notation (HEX
  with or without `#`, `rgb()`, `hsl()`, a CSS name) into any field and all
  of them follow; **Copy colour** copies the value. **Pick from slide** hides
  the dialog: tap or click a shape's fill or line, a text or an image pixel to
  take its colour (the opacity stays as set; image adjustments are not
  applied to the picked pixel). Escape or **Cancel** leaves picking.
- **Speaker view** (deck menu) shows the current slide, the next slide, a
  timer and the controls. Choose **Open audience window** and move that
  window to the presentation screen; navigation, build steps and blanking stay synchronized
  between them.
- Double-tap text to edit it (the caret lands where you tapped) or choose **Edit** in its bar, or a group to work inside it; with the Text
  tool, a tap on an existing text edits it (also inside a group). Tap outside,
  **Done** or Ctrl/Cmd+Enter to keep the edit; Escape cancels it, putting the
  text back as it was (a new text disappears) with nothing added to undo.
  Editing keeps the text's formatting; while
  editing, the selection bar makes selected words bold, italic, underlined or
  sub/superscript, and the Design tab gives them another colour.
- Choose **Pan** to drag the page without changing objects; tap an object to
  select it, or empty space to clear selection. Double-tap another object to add
  it to the selection (or a selected one to take it out); Shift-tap or
  **Several** does the same with single taps. Drags preserve selection, even over objects. Choose **Select**
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
  saves a named, immutable snapshot of the whole deck, including slide order.
  Its history offers text diffs against the previous commit or
  working copy and full-deck restore (restore asks for a second confirmation).
  The first edit protects the original as
  a baseline; restoring also saves the working copy as a safety commit.
  Unchanged content is shared and media is never copied into commits.
  Undo/redo remains per slide. Concurrent edits stop saving or restoring
  instead of silently overwriting changes.
- **Deck menu → Export offline copy** downloads a .zip that plays without a
  network; **Download PDF** fetches a PDF from the service (a message says
  why if the service cannot make one).
- **Deck menu → Deck settings…** sets the deck's title, its background colour
  (the screen around the slide when the window is not 16:9), and the slide
  size (1920×1080, 3840×2160, 1920×1200, 1024×768 or custom). Changing the
  size asks first, then resizes every slide while content keeps its position
  and size (a full-slide background rectangle is resized with the slide);
  each slide can undo it. The dialog also holds the font library (upload
  .otf/.ttf).
- The slide strip's **+ Slide** adds a slide after the current one; **…**
  duplicates, moves or deletes it.
- Keyboard: Ctrl+Z / Ctrl+Shift+Z, Ctrl+C / Ctrl+V (also across slides),
  Ctrl+D duplicate, Ctrl+G / Ctrl+Shift+G group, Delete, arrow keys nudge
  (Shift ×10; nudges move exact pixels, never snap, and presses within half a
  second undo as one step), Page Up/Down change slide.
- Deleted slides go to the deck's `trash/` folder.
- The decks page offers **Rename** (the folder name; history and media move
  with it) and **Duplicate** (a copy named `<name>-copy` with " (copy)" in its
  title; it starts without the original's history) per deck. **Delete**
  (tap twice) moves the whole deck to
  `<data>/trash/<name>.<timestamp>/`; **Recently deleted** below the list
  restores it, asking for another name when the original name is taken.
  Nothing is purged automatically: remove the folder by hand.
- **Deck menu → History and recovery** lists the last 30 saved slide revisions
  and deleted slides, with restore controls. Restoring a revision checkpoints
  the current artwork first. If saving detects a conflict, **Keep both versions**
  preserves local edits as a recovered slide and retains the server's version.
  If recovery cannot reach the server, it downloads the local SVG as a fallback.
  Revisions cover slide artwork.

## Presenting

The controls are a small bar of icons (previous, slide number, next,
overview, back to editor, full screen). They show for three seconds at the
start and then hide; a mouse move, the Tab key, or on a touch screen a tap
along the bottom edge brings them back. The idle mouse cursor hides too.
Press **O** to toggle the overview (Escape only closes it, so a clicker's
Escape cannot open it mid-talk); tap a thumbnail to jump to that slide,
shown fully built.
Overview pauses active movies until returning to the presentation. Only the
current and neighbouring slides' movies stay loaded.
The live service also has **Back to editor**, returning to the current slide.
Offline exports retain the overview and navigation without an editor dependency.
Speaker view is also available from the presentation controls in offline exports.
Its audience window displays only the presentation, with no speaker controls.


Arrows / space / page keys / click or swipe to move (`n`/`p` work too), a
number then Enter to jump, `b` or `.` for a blank screen, `f` or a mouse
double-click for full screen. A single mouse click advances after a short
pause so a double-click never changes the slide; taps turn the slide at once:
back in the left third of the screen, on elsewhere. The
speaker window keeps its session in the address bar, so reloading it
reconnects the audience window. The address bar shows `#slide.step`.

On a touch screen, tap with three fingers to open the slide overview. Pinch to zoom into the slide (two fingers also move it,
and so does one finger while it is zoomed in; pinch back out to the full
slide); zoomed in, taps and swipes turn nothing. The Apple Pencil marks the
slide like a highlighter; a Pencil tap wipes the marks and never turns the slide. A finger held still for a moment becomes a red pointer that
follows it until it lifts. Zoom, marks and pointer show in the audience
window too and are gone with the next slide; `c` clears them at once.

**Board for questions.** `w`, the board button in the controls or **Board** in
speaker view puts an empty page in the deck's background over the slides. The
Pencil writes on it with a thin pen; zoom and the finger pointer work as on a
slide. **Undo** takes the last stroke back and **Wipe** all of them. Slides do
not turn while the board is up; Escape or **Back to slides** returns to the
slide you left, and the drawing is still there when the board comes up again
(until the page is reloaded).

A game controller works as a clicker (a Joy-Con, any gamepad; press a button
to connect it): A, RB, RT, D-pad right or down go on; B, LB, LT, D-pad left or
up go back; Y blanks the screen and any of these buttons brings it back; X
clears zoom, marks and pointer; Start (+) shows or hides the board. Sticks do nothing. With a speaker and an audience window open, the window that has
focus takes the press.

### Printing and PDF

`svgdeck pdf DECK OUT.pdf` prints the deck through headless Chromium: one page
per slide at the deck's size (1920×1080 is 20 × 11.25 in), every build step
shown, movies as their poster frame. `--steps` prints the initial state and
then the state after each step that has objects.
`svgdeck export … --pdf` also writes `deck.pdf` into the export (and the zip).
The editor's Deck menu downloads the same PDFs from the service.

Any export's `index.html?print=1` (or `#print`, `?print=steps`) shows every
slide stacked as pages, ready for the
browser's Print; the service's presenter page accepts the same address.
Printing the normal presenter with Ctrl/Cmd+P prints every slide fully built,
one per landscape page, without controls, overview or speaker panel.

## Development tools

- `tools/import_inkscape.py` — one-off import of one real Inkscape talk,
  the development test deck.
- `tools/compare_render.py` — renders every slide of an export in headless
  Chromium and diffs it against the old Inkscape PNGs.

```
.venv/bin/python -m pytest tests                      # Chromium
SVGDECK_BROWSER=webkit .venv/bin/python -m pytest tests  # WebKit = the iPad's engine
```

Playwright's WebKit does not run on Arch Linux; it runs on Ubuntu 24.04
after `playwright install webkit`, with `libavif16`,
`libgav1-1` and `libyuv0` unpacked from `apt-get download` into the WebKit
build's `minibrowser-wpe/lib/` (no sudo needed). Headless WebKit there freezes
on video, so movie tests only run in Chromium.

## Persistent local service

The installed `calliope.service` user unit starts under `default.target`, restarts
on failure, and binds only 127.0.0.1:8490; Tailscale Serve is what makes it
reachable from the tailnet, over HTTPS. User lingering keeps it running across
logouts and starts the user manager at boot. Switchboard registers the
unit with `GET /healthz` as the health URL (it answers without touching the data
directory) and `client_url` for its **Open** button.
These machine-local settings stay outside the repository; decks and licensed
fonts remain in the separate data directory.
