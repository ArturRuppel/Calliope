# Deck format

A deck is a directory of plain files:

```
my-talk/
  deck.json
  slides/<id>.svg
  media/
  fonts/
```

## deck.json

```json
{
  "format": 1,
  "title": "Example talk",
  "size": [1920, 1080],
  "background": "#000000",
  "slides": [{"id": "s00"}, {"id": "s01"}],
  "fonts": [
    {"family": "Inter", "weight": 300, "style": "normal",
     "file": "fonts/Inter-Light.otf"}
  ]
}
```

- `slides` is the presentation order. Slide `id` names the file
  `slides/<id>.svg`; ids are stable when slides are reordered.
- `background` fills the screen around the slide when the window is not 16:9.
- The service accepts a `title` of up to 200 characters, a `size` of two
  integers from 16 to 16384, and a `background` of up to 64 characters
  (a CSS colour; no `<` or line breaks).
- `fonts` lists every font face the deck ships. Text in the slides refers to
  them with `font-family`, `font-weight` and `font-style`, exactly as CSS
  font matching does. The service and the import accept an entry only when
  `file` is `fonts/<name>` (letters, digits, `- _ .`; no subfolders),
  `weight` is a number from 1 to 1000 (or `normal`/`bold`, or a range such
  as `"100 900"` for a variable font, which the font library gives one entry
  for its whole weight axis), `style` is
  `normal` or `italic`, and `family` is a name of at most 200 characters
  without `< > { } ; \` or control characters. The presenter leaves out any
  entry that does not, and an export refuses it. A deck may not list a slide
  id twice.

## Kinds and sizes of slides

A slide entry may carry two more fields; a deck without them is read exactly
as before, by every version of the code, the presenter and the exports.

```json
"slides": [
  {"id": "s00"},
  {"id": "s-1a2b3c4d", "kind": "material", "name": "Board 1"},
  {"id": "s-5e6f7a8b", "kind": "figure", "name": "streams"}
]
```

- `kind`: `slide` (the same as leaving it out), `material` (a board for
  collecting snapshots, drawings, plots and notes, at any size) or `figure`
  (a figure for a document). Only the editor's figure mode tells them apart;
  the presenter and the exports show every slide, in deck order.
- `name`: what figure mode calls the slide (at most 200 characters, no `<`).
- A slide's size is its own `viewBox` (and `width`/`height`): numbers from 1
  to 100000, fractions allowed. The deck `size` is the size of new slides
  and of the presentation; a slide of another shape is shown whole inside
  it. **Deck settings → Slide size** resizes only slides of kind `slide`.

A **figures deck** belongs to one document of a writing app. It carries a
`figureStyle`, set when the deck is made:

```json
"figureStyle": {"width": 481.89, "unit": "pt", "textSize": 9.24, "letterSize": 10.5, "font": "Inter Variable"}
```

`width` is the document's text width; a figure slide is that wide and as
tall as it needs. Its unit is the point (`unit` is always `pt`), so a text of
`font-size` 9 on a figure prints at 9 pt when the figure is printed at the
text width. `textSize` is the document's size for text in figures (its
caption size), `letterSize` that of panel letters (bold), `font` the family
new text on a figure uses when the font library has it. All are optional.

Panel letters are texts with `data-panel-letter="a"` (`b`, …).

### The API for slides of their own

| Request | What it does |
|---|---|
| `POST /api/decks` with `{"name", "title", "size"?, "figureStyle"?}` | A new deck; with `figureStyle` a figures deck whose first slide is the material board "Board 1" |
| `POST /api/decks/<deck>/slides` with `{"kind"?, "name"?, "size"?, "after"?}` | A blank slide of `size` (default the deck's), after slide `after` (default at the end). Answers `{id, version, deck, deckVersion}` (201) |
| … with `{"svg": "<svg …>", …}` | The given SVG as the new slide (refused with 400 if it could run script, as `PUT …/slides/<id>` is) |
| … with `{"from": {"deck": "<other>", "slide": "<id>"}, …}` | A copy of a slide of another deck (or of this one), with its kind and name unless given. The media files it uses and the font faces it names are copied too; the source deck is not changed |
| … with `{"svg": …, "from": {"deck": "<other>"}}` | A selection copied from another deck: the media it refers to come from that deck |
| `PUT /api/decks/<deck>` | As before; `kind` and `name` of slide entries and `figureStyle` are checked |
| `PUT /api/decks/<deck>/slides/<id>` | As before. A slide changes size by changing its `viewBox`, `width` and `height` |
| `GET /api/decks/<deck>/slides/<id>/export.svg?dpi=300` | The slide as a standalone SVG (below), with `X-Slide-Version` and `ETag`: the version of the slide it was made from, the same as `GET …/slides/<id>` gives |

### Standalone export of one slide

`export.svg` is the slide as one file another program can show as it is
(`svgdeck/slide_export.py`):

- Pictures and movies' posters are embedded as `data:` URLs. A raster stays a
  raster and an SVG picture stays vector. A raster much wider than it is
  shown is scaled down to `dpi` pixels per inch at its size on the slide
  (JPEG when that is less than 60 % of the PNG and nothing is transparent;
  this needs Pillow, which the service has and the browser build has not:
  there pictures go in as they are).
- The deck's font faces whose family the slide names are embedded as
  `@font-face` rules with woff2 `data:` URLs, cut down to the characters the
  slide uses. A browser shows the text in the same font in an `<img>`, in a
  page and in a printed PDF, whatever fonts the machine has.
- Layout boxes, camera frames and objects hidden in the Objects panel are
  left out, as in a presentation.
- A `figure` slide gets `width="<w>pt" height="<h>pt"`; other slides keep
  their size in pixels.

## Slides

Each slide is a standalone SVG with `viewBox="0 0 W H"`, equal to the deck
`size` for a slide of kind `slide`. Paths to media are relative to the slide file (`../media/x.png`), so a
slide opens correctly on its own in a browser.

A slide's `<style>` element applies to that slide only: the player scopes its
rules and prefixes the ids and `url(#id)` references inside them. Presentation
attributes on the root `<svg>` (font, fill, class and so on) apply to the whole
slide. Relative `<a href>` links are left as written and are not treated as
media.

Ids only need to be unique within one slide; the player prefixes them per
slide when it puts all slides in one page.

The top-level children of the `<svg>` are the slide's objects, in stacking
order (first is at the back).

### What a slide may not contain

Slides are put into the editor's and the presenter's own page, so nothing in
them may run script. Slides are UTF-8 and have no DTD. Not allowed:
`<script>`, `<foreignObject>`, `<iframe>`, `<embed>`, `<object>` (and a few
more of their kind, plus any XHTML or MathML element), any `on…` event
attribute, `xml:base`, a link or reference (`href`, `xlink:href`, `src`,
`data-video`) with a scheme other than `http:`, `https:`, `mailto:`, `blob:` or
`data:image/`, a `<set>`/`<animate…>` that animates an `href` or an `on…`
attribute, and CSS (in `<style>` or `style=`) with `@import` or a `url()` to
anything but `#id` or a `data:image/`. The full rules are in
`svgdeck/sanitize.py` and, for the browser, `svgdeck/editor/sanitize-svg.js`.

- Saving a slide through the API (`PUT …/slides/<id>`) that breaks them is
  refused with 400 and a list of what was found; the slide is left as it was.
- Importing a deck, uploading an `.svg` picture and keeping a conflict copy
  remove those parts and keep the rest; a slide without them is stored byte
  for byte.
- The editor and the player remove them from every slide before it enters the
  page, so a slide already on disk that has them shows without them. Opening
  such a slide does not rewrite it; the next edit saves it without them.

### Movies

A movie is a top-level `<image>` whose `href` is a poster frame and whose
`data-video` names the movie file:

```xml
<image href="../media/pos08.poster.jpg" data-video="../media/pos08.mp4"
       x="288" y="108" width="1344" height="757"
       data-autoplay="true" data-loop="true" data-sync="sync1"/>
```

| Attribute | Default | Meaning |
|---|---|---|
| `data-video` | required | movie file, relative to the slide |
| `data-autoplay` | `true` | start playing when the slide is shown |
| `data-loop` | `true` | loop |
| `data-video-start` | `0` | first playback time in seconds |
| `data-video-end` | movie duration | last playback time in seconds |
| `data-sync` | none | sync group: moving between slides whose movies share a group keeps the playback time, so a movie continues across slides |

Objects above the movie in stacking order are drawn on top of it.
Movies are always muted. The player keeps only the current and the neighbouring
slides' movies loaded.
Temporal trims leave the source file and poster unchanged.
Playback starts at the trim start; Loop repeats only the excerpt, otherwise it
pauses at the end. Sync groups use source-file seconds and continue when that
time lies within the next movie's excerpt; otherwise the next excerpt starts
at its beginning. Invalid ranges fall back to the available movie duration.
Offline exports include the original movie and retain the playback range.

### Editor attributes

| Attribute | Meaning |
|---|---|
| `data-locked="true"` | the editor does not select it (slide backgrounds) |
| `data-label` | a name for the object (from Inkscape labels; `background` marks the slide background) |
| `data-nodetypes` | on a path: the type of each point, in order, for point editing: `c` corner, `s` smooth, `z` symmetric. Written only when the handles alone would not tell (like Inkscape's `sodipodi:nodetypes`) |
| `data-ink="pressure"` | a Pencil stroke drawn with pressure: a filled outline, so its colour is the fill |
| `data-hidden="true"` | hidden through the Objects panel; paired with inline `display:none` so it remains hidden outside the editor |
| `data-crop="L T R B"` | image/movie crop insets in percent, each between 0 and 99.9; opposing insets must leave at least 0.1% visible |
| `data-mask="rect"` or `"ellipse"` | crop mask shape; the editor also writes a native SVG `clipPath` in object-bounding-box units |
| `data-svgdeck-clip` | the ID of the editor-owned clip definition; `clip-path` is the actual SVG reference. The editor edits a clip in place only when this names the clip that `clip-path` references; any other `clip-path` is imported and left alone (`data-crop` alone does not make it editable) |

### Image adjustments

Still images may carry `data-image-saturation`, `data-image-hue`,
`data-image-brightness` and `data-image-contrast`. Percent values range from
0 to 1000 (default 100); hue is degrees from -180 to 180 (default 0).
The editor writes native SVG filter definitions referenced by the image's inline style,
so standalone SVGs, the presenter and exports render the same adjustments.
The order is saturation, hue, contrast, then brightness. Zero contrast gives
uniform gray, which brightness can darken to black or brighten to white.
`data-image-original-filter` retains the previous inline filter for reset;
`data-svgdeck-image-filter` identifies the editor-owned filter definition; imported
filter attributes remain intact. Whole-object opacity controls
transparency separately. Source media files are never changed.

### Builds

Any element with `data-step="n"` (n ≥ 1) is hidden until the n-th step of the
slide. Elements without `data-step` are visible from the start.

The editor offers steps 0–999 (0 removes the attribute). Objects sharing a step
appear together. Build previews use editor-only CSS outside the saved SVG.

### Camera frames

A hidden `<rect data-camera="true">` is a camera frame. From its `data-step`
on (0 or absent: from the start of the slide) the presentation zooms and pans
so that the frame fills the screen, and stays there until a frame with a later
step takes over. A frame covering the whole slide zooms back out.

```xml
<rect data-layout="true" data-camera="true" data-label="Camera" data-step="1"
      visibility="hidden" fill="none" stroke="none" x="90" y="120" width="820" height="440"/>
```

The frame keeps its own shape: the slide is scaled until the frame just fits,
and the view never leaves the slide, so a frame of another shape than the
screen shows some of what lies beside it. `data-camera="matte"` centres the
frame instead and covers everything outside it in the deck's background;
`data-camera="dim"` does the same with a translucent cover (75 %), so what
lies beside the frame stays faintly visible. Moves between steps of one slide glide
(0.6 s, or at once with reduced motion); a new slide starts in place. Camera
frames count as build steps. Stored as layout boxes they can be moved and
resized in the editor. The PDF and the slide overview show the whole slide.

### Recovery files

The service keeps up to 30 preceding artwork versions per slide in
`revisions/<id>/<timestamp>-<hash>.svg`. Deleted slides live in `trash/`,
with a JSON sidecar retaining their slide metadata.
These recovery files remain in the working deck and are not included in the
standalone presentation export.

A deleted deck is moved whole, recovery files included, to
`<data>/trash/<name>.<YYYYMMDDTHHMMSS>-<hex>/` and can be restored from the
decks page as long as no other deck has taken its name.

### Deck commits

`deck.json` and `slides/` remain the autosaved working copy. Explicit commits
are immutable JSON manifests in `commits/manifests/<id>.json`, containing a
parent ID, message, timestamp, and SHA-256 object references for the exact
metadata and each referenced SVG. Content lives in `commits/objects/<sha256>`;
unchanged files are shared across snapshots. Commit history is not pruned.
`commits/HEAD` caches the id of the latest commit; it may be deleted and is
rebuilt from the manifests.
Media and fonts remain in their existing directories and are referenced rather
than copied. Keep those assets with the deck when backing it up.
Renaming a deck moves the whole directory, history included; duplicating a
deck copies `deck.json`, `slides/`, `media/` and `fonts/` only, so the copy
starts its own history.

The first working mutation preserves a baseline. Full-deck restore checks the
metadata version and every current slide version, saves a safety snapshot,
then replaces working metadata and slides while retaining media, fonts,
recovery files, and all commits. Commit diffs are unified text diffs of JSON
and SVG. Commits are local deck history, not Git commits, and are not included
in standalone presentation exports.
