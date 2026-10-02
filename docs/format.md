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
  "title": "Paris postdoc seminar",
  "size": [1920, 1080],
  "background": "#000000",
  "slides": [{"id": "s00"}, {"id": "s01"}],
  "fonts": [
    {"family": "Helvetica Neue", "weight": 300, "style": "normal",
     "file": "fonts/HelveticaNeueLight.otf"}
  ]
}
```

- `slides` is the presentation order. Slide `id` names the file
  `slides/<id>.svg`; ids are stable when slides are reordered.
- A slide entry may also contain `notes`, a plain-text string for speaker view.
- `background` fills the screen around the slide when the window is not 16:9.
- The service accepts a `title` of up to 200 characters, a `size` of two
  integers from 16 to 16384, and a `background` of up to 64 characters
  (a CSS colour; no `<` or line breaks).
- `fonts` lists every font face the deck ships. Text in the slides refers to
  them with `font-family`, `font-weight` and `font-style`, exactly as CSS
  font matching does.

## Slides

Each slide is a standalone SVG with `viewBox="0 0 W H"` equal to the deck
`size`. Paths to media are relative to the slide file (`../media/x.png`), so a
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
| `data-sync` | none | sync group: moving between slides whose movies share a group keeps the playback time, so a movie continues across slides |

Objects above the movie in stacking order are drawn on top of it.
Movies are always muted. The player keeps only the current and the neighbouring
slides' movies loaded.

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

### Recovery files

The service keeps up to 30 preceding artwork versions per slide in
`revisions/<id>/<timestamp>-<hash>.svg`. Deleted slides live in `trash/`,
with a JSON sidecar retaining their slide metadata, including speaker notes.
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
