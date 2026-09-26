# svgdeck roadmap

A web app to draw and present slide decks: a small SVG editor usable on an
iPad (touch and Pencil), a presenter that plays decks with embedded movies,
and an export to a standalone offline HTML folder. It replaces the current
workflow of drawing slides in Inkscape, exporting each one to PNG, and laying
movies over the PNGs in a hand-written reveal.js page.

## Why

The current workflow flattens every slide to a PNG and then patches things
back on top:

- Movies are `<video>` elements positioned with hand-tuned CSS percentages
  over the PNG background. Anything that must sit above a movie needs a
  second exported PNG layered on top (`slide40b.png`).
- Step-by-step builds are duplicated copies of a whole slide
  (`slide10a/b/c`).
- Movies that continue across slides need custom sync JavaScript.
- Decks load reveal.js from a CDN, so none of them works offline.
- One Inkscape file per talk grows large (76 MB for a 62-slide talk) and can
  only be edited on the desktop.

Reference decks: `presentations/` in the lab-book database repo.

## Requirements

- **Edit from the iPad.** Browser-based, touch-first, Apple Pencil for
  freehand drawing. Desktop browsers work too.
- **Basic SVG editing is enough**, matched to the slides actually made:
  rectangles, ellipses, lines and arrows (markers), freehand paths with
  Bézier editing, text, placed images and movies, groups, clipping to a
  rectangle or ellipse, align, stacking order, duplicate, undo.
- **Movies are slide objects** with position, size and stacking order, so
  shapes can sit above them. Settings per movie: autoplay, loop, muted,
  sync group (continuous playback across slides).
- **Builds within one slide**: objects appear at step *n*.
- **Custom fonts.** Helvetica Neue (Thin to Black) and any uploaded OTF/TTF.
  The same font files are used for editing and presenting, so text lays out
  identically on every device.
- **No Inkscape.** The app is the only editor. Old talks stay archived as
  they are; only the latest one is imported (as a development test ground).
- **Offline presenting.** Export a self-contained folder (and zip) that runs
  from `index.html` with no network access.
- **Editing is online.** A service on rocinante, reached over Tailscale.

Secondary, later: PDF export, speaker view.

## Architecture

**Service on rocinante.** A `systemd --user` unit like the lab book. Stores
decks, the font library and media; serves the editor; runs exports.

**Deck on disk.** Plain files, git-friendly, inspectable:

```
my-talk/
  deck.json        slide order, builds, movie settings, deck defaults
  slides/03.svg    one plain SVG per slide, 1920x1080
  media/           images and mp4s referenced by the slides
  fonts/           the fonts this deck uses
```

Movies and build steps are marked with `data-*` attributes in the slide SVG,
so a slide file stays viewable in any browser.

**Presenter.** A small player of our own instead of reveal.js: fit to
screen, keyboard/click/touch navigation, build steps, movies, sync groups.
No external dependencies, so it can be embedded in an export as-is.

**Standalone export.** One folder: `index.html` with the player and the slide
SVGs inlined (avoids `file://` fetch restrictions), `media/`, and `fonts/`
converted to woff2.

**Standalone app; the lab book is only the archive.** svgdeck owns its working
decks in its own data directory on rocinante, outside this repo (set in the
service config; decks and the font library are content, not code). When a
talk is final, its standalone export is copied into the lab-book database
repo (`presentations/<date>_<name>/`) as the archived record. Because the
export plays itself, the lab book needs no svgdeck code: it just links the
exported `index.html`. Font files are licensed and never go into this repo.

## Milestones

### 1. Deck format, player, standalone export
- Define `deck.json` and the slide SVG conventions (movies, builds, fonts).
- Player with builds, movies and sync groups.
- Standalone export with fonts converted to woff2.
- One-off importer for the latest talk only, the 2026-05-19 Paris postdoc
  seminar (62 slides, video overlays, sync group across slides 51–53,
  Helvetica Neue). It is a development test ground, not a general Inkscape
  converter: split `slides.svg` by its `slideN` groups into editable shapes
  (clip paths, markers and filters kept), turn the hand-positioned video
  overlays and the `*b.png` layers into real slide objects, collect fonts.
  The imported deck then exercises the player, the export and, in later
  milestones, the editor on real content.

### 2. Editor MVP (iPad)
- Deck overview: slide list, reorder, add, duplicate, delete.
- Select, move, resize, rotate; multi-select.
- Text with the font library.
- Rectangle, ellipse, line, arrow.
- Place images and movies (upload from the iPad).
- Pencil freehand drawing with smoothing.
- Stacking order, undo/redo, autosave to the service.

### 3. Editor, second pass
- Build steps.
- Align and distribute, snapping, guides.
- Clip to a rectangle or ellipse.
- Bézier path editing.
- Reusable pieces: title bar, scale bar, citation line, slide number.
- Copy objects between slides and decks.

### 4. Later
- PDF export (headless Chromium printing the player).
- Speaker view: notes, next slide, timer.
- Movie helpers: crop and timestamp overlays (now done by hand with ffmpeg).

## Open questions

- Backups of the working data directory (decks in progress exist only
  there until archived).

Decided 2026-09-26: svgdeck is standalone; the lab book only archives the
final static exports (see Architecture). Only the latest talk is imported,
as editable shapes, for development; older talks are not converted.
