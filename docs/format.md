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
- `background` fills the screen around the slide when the window is not 16:9.
- `fonts` lists every font face the deck ships. Text in the slides refers to
  them with `font-family`, `font-weight` and `font-style`, exactly as CSS
  font matching does.

## Slides

Each slide is a standalone SVG with `viewBox="0 0 W H"` equal to the deck
`size`. Paths to media are relative to the slide file (`../media/x.png`), so a
slide opens correctly on its own in a browser.

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
Movies are always muted.

### Editor attributes

| Attribute | Meaning |
|---|---|
| `data-locked="true"` | the editor does not select it (slide backgrounds) |
| `data-label` | a name for the object (from Inkscape labels; `background` marks the slide background) |

### Builds

Any element with `data-step="n"` (n ≥ 1) is hidden until the n-th step of the
slide. Elements without `data-step` are visible from the start.
