# Calliope with nothing to install: the browser build

Calliope's editor, presenter and the whole svgdeck service run in the
browser, with no server: the service is the same FastAPI app, run by Pyodide
in a Web Worker, the way Iris runs its engine. The live server-side service is
untouched by any of this.

**Published** 2026-11-05 at https://arturruppel.github.io/Calliope/: GitHub
Pages, built by `.github/workflows/pages.yml` on every push to `main`, which
runs the e2e against the build from a sub-path before deploying. The open
questions below still stand.

```sh
npm install                 # pyodide, fflate, playwright (dev only)
npm run build:web           # -> dist-web/ (about 27 MB, 26 MB of it Python)
npm run test:e2e            # headless Chromium, about 20 s
node tools/boot-timing.mjs  # boot, stage by stage (`file` or a URL as argument)
```

`dist-web/` is static files. Serve it from any path of any host, or open
`dist-web/index.html` straight from disk.

## What runs where

| Where | What |
|---|---|
| Page (main thread) | The editor and deck list, unchanged plain JavaScript modules; `web/runtime.js` in front of them: the fetch shim, blob URLs for media and fonts, page links, movie and picture checks, import, the export download, the presenter page. |
| Web Worker | Pyodide 314.0.7 (Python 3.14) with fastapi, starlette, pydantic, anyio, fonttools and brotli, and the `svgdeck` package; `svgdeck/browser.py` drives `svgdeck.server.create_app` over ASGI, one request at a time. `web/worker.js` boots it, fills the filesystem, stores media, syncs storage. |
| Service worker (`sw.js`, http(s) only) | Keeps the app's own files cached, so Calliope opens with no network. It holds no decks. |

### Pages

| Service | Browser build |
|---|---|
| `/` | `index.html` (from `decks.html`) |
| `/edit/<deck>` | `edit.html?deck=<deck>` (from `editor.html`) |
| `/d/<deck>/` | `present.html?deck=<deck>` |

`tools/build-web.mjs` makes `index.html` and `edit.html` from the service's
own pages with a few mechanical changes: `runtime.js` first, `/editor/...`
paths made relative, the deck name from the query, the module tag replaced by
`CalliopeRuntime.loadModule` (which, over `file://` only, runs the editor's
modules from blob URLs, because Chromium will not load a module from a file).
Links written for the service (`<a href="/edit/x">`) are rewritten when
clicked. The presenter asks the service for the page it renders
(`deck.render_page`), points its file references at blob URLs and replaces
itself with it (`document.write`), so the player is exactly the served one.

### The fetch shim

`window.fetch` sends `/api/...`, `/d/...`, `/healthz` and `/sw.js` to the
worker and everything else to the network. The editor never learns the
difference: its 16 `fetch` sites are unchanged. The few seams in the editor
are behind `globalThis.CalliopeRuntime` and do nothing on the service:

- `hrefIn` / `hrefOut` in `main.js`: `../media/x` becomes a blob URL for the
  DOM and back again when a slide is saved, so slide files never hold a blob
  URL;
- page addresses (leave, present) through `CalliopeRuntime.link`;
- the offline export downloads through the shim instead of navigating to it;
- **Download PDF** becomes **Print or save as PDF**;
- the three CSS files loaded on demand, and the library fonts' `@font-face`;
- the deck list: an **Import a deck** form, and the status line says how
  much the browser stores instead of syncing an offline copy.

`server.py` and `store.py` are unchanged. The browser store is a subclass,
put in place by swapping the `Store` name that `create_app` reads.

## Media: the seam

The bytes of pictures and movies never enter Python's in-memory filesystem.

1. The page checks the file before anything is stored: a picture through
   `createImageBitmap` (its size), an SVG as text, a movie through a muted
   `<video>` (its size, and the poster frame drawn on a canvas as JPEG). A
   file the browser cannot play is refused with a message; `.mkv` and `.avi`
   are refused outright (they need converting, and there is no ffmpeg).
2. The worker hashes the file (SHA-1, as the service names media) and writes
   it to the Origin Private File System, `calliope-media/<sha1>`, with a sync
   access handle (the one OPFS write Safari offers, worker only). Where there
   is no OPFS (Chromium over `file://`) it goes to IndexedDB instead
   (`web/media-store.js`).
3. The store's `add_media` gets a JSON record (sha1, type, size, width,
   height, poster) as the body of the usual `POST /api/decks/<deck>/media`.
   `BrowserStore.add_media` names the file as the service does
   (`stem-<sha1[:8]>.ext`, poster `.poster.jpg`) and writes a **stub** there:
   `calliope-blob\n{"sha1","type","size"}`. Movies keep their container (a
   `.webm` stays `.webm`); the service always made `.mp4`.
4. Because the deck's `media/` folder holds stubs, everything that moves deck
   folders (rename, duplicate, trash, restore, commits) works unchanged.
5. `dispatch` marks a response whose body is a stub (`x-calliope-blob`); the
   page answers it with the stored file. For the DOM, the page keeps one blob
   URL per media path, made from the index at `GET /api/browser/media`,
   refreshed after every request that changes something.
6. The offline export is made by `export.py` as on the service, stubs
   included; the worker then swaps every stub in the zip for its file.

## Storage layout

| What | Where |
|---|---|
| Decks (deck.json, slides, stubs, fonts), commits, revisions, trash, the font library, `.sample-created` | Pyodide's `/data`, an IDBFS mount: IndexedDB database `/data`. Loaded at boot, written back after every request that changed something and succeeded. |
| Picture and movie bytes, by SHA-1 | OPFS `calliope-media/`, else IndexedDB `calliope-media` |
| Editor preferences | `localStorage`, as on the service |
| The app itself | The service worker's cache `calliope-web-<build>` |

The page asks for persistent storage (`navigator.storage.persist()`); the
deck list's status line says whether the browser granted it. Every page boots
its own worker over the same storage, so a Web Lock lets one tab write; a
second editor tab is read-only and says so. The presenter only reads.

## Moving decks in and out

- **Out:** the deck menu's **Export offline copy**, the same zip as on the
  service (`index.html` plays it anywhere, offline).
- **In:** **Import a deck** on the deck list takes such a zip, or a deck
  folder zipped as it is (for example from `~/Data/svgdeck/decks/` on
  the server). History (`commits/`, `revisions/`, `trash/`) stays behind; a name
  already taken gets `-2`. From an export the deck gets the woff2 fonts the
  export carries.

## The sample deck

A first visit with empty storage finds **Welcome to Calliope** (four slides:
text, shapes with build steps, a picture, how to move decks). The picture is
drawn by `tools/sample-picture.mjs` at build time. Deleting the deck keeps it
gone.

## Dropped, stubbed, different

- **ffmpeg / ffprobe:** no conversion and no probing. Movies are stored as
  they are, so a `.mov` from an iPhone (HEVC) plays in Safari but not in
  Chromium; the service would have made H.264. Sizes come from the browser.
- **Playwright PDF:** `/api/decks/<deck>/pdf` answers 501 here; the editor
  offers the browser's print of the player's print mode instead (one page per
  slide; Safari's print sizing is not tuned).
- **The server's offline copy** (`offline.js`, the service's `sw.js`,
  `/api/offline`): not used. The decks are already local, so the editor is
  always fully usable; nothing shows the "needs the server" state.
- **Saves while a page closes:** the editor's `keepalive` saves go to a worker
  that dies with the page. Leaving through the editor's own buttons waits for
  the save; closing the tab mid-edit can lose the last edit (the server copy
  has the same window, but `keepalive` usually covers it there).
- **Speaker view** reopens `present.html` with `speaker=1`, and its audience
  window is another `present.html`; not covered by the e2e.

## Measured (an Arch Linux machine, headless Chromium, local files)

Cold boot to the deck list with its decks: **1.9 s** (Python up at 0.9 s,
decks open at 1.7 s). Every later page boots again: **1.5 s** to an editor
with its slide loaded. Over `file://` the same. The download is 26 MB of
base64 under `pyodide/` (the wasm alone is 12.8 MB), once; the service worker
keeps it. On the iPad, the first visit over Tailscale is bounded by that
download.

## Open questions, and what I would do differently in public

- **One boot per page.** The deck list, editor and presenter are separate
  pages, so each starts Python (1.5 s). A single-page shell, or a
  SharedWorker (Safari 16+) holding one Python for all tabs, would remove that
  and the one-writer lock with it.
- **Driving ASGI by hand depends on Starlette.** The Pyodide Starlette (1.0)
  sends files without a task group; Starlette 1.10 opens one per file
  response and then needs a real event loop. The build's smoke test catches
  that; a public build should pin the packages it was proved with, or run the
  app on Pyodide's WebLoop.
- **Media garbage collection.** Stored files are never deleted (a deck in the
  trash, a commit or a duplicate may still need them). A sweep that keeps
  every SHA-1 named by a stub anywhere in `/data` would do it.
- **Large movies** are read into memory once to hash them, and the export zip
  is built in memory. Fine for talk-sized movies; a streaming hash and a
  streamed zip (fflate's `Zip` class) for anything bigger.
- **Eviction.** Safari may clear the storage of a site not added to the Home
  Screen after seven days without a visit. Exports are the backup; a public
  build should say so where the user cannot miss it, and offer to export
  everything at once.
- **Packing.** A single packed HTML (like Iris's `pack:iris --app`) would make
  the build one file to mail. Not done.
- **Presenter by `document.write`.** Works, and keeps the blob URLs alive;
  a public build might render the player into the page directly instead.
- **Licence and fonts:** the build ships Archivo and IBM Plex Mono (OFL) as
  the service does, and no other fonts. A public build needs a licence for
  the app itself and a word on uploaded fonts staying in the browser.
- **Moving decks between the browser and the server** is by zip only. A sync
  (pull a deck from the service over CORS, push back with its version) is the
  natural next step, and needs care with two copies being edited.
