"""Run the svgdeck service inside Pyodide, in a browser Web Worker, with no server.

The browser has no sockets, so each request calls the real FastAPI app from
`svgdeck.server` directly over ASGI (`dispatch`). Going through the app keeps
validation, status codes and error messages identical to the server-side service.

Pyodide cannot start threads, and the app runs sync endpoints and
`anyio.to_thread.run_sync` work in a thread pool. `install()` makes those
inline calls. Nothing then suspends for real, so `drive` steps the ASGI
coroutine by hand without an event loop (the Iris pattern).

Media: the bytes of movies and pictures never enter Pyodide's filesystem. The
JavaScript side keeps them in the browser's Origin Private File System, named by
their SHA-1, and the deck's media/ folder holds a small *stub* per file (MAGIC +
JSON: sha1, type, size). Everything that moves deck folders around (rename,
duplicate, trash, restore, commits) therefore works unchanged, and the worker
swaps a stub for the real bytes when it leaves Python (`x-calliope-blob`).
Design: docs/browser-runtime.md
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

from fastapi import HTTPException, Request

from . import server
from .deck import FORMAT, Deck
from .store import (IMAGE_TYPES, SLIDE_ID, VIDEO_TYPES, Store, check_deck_fields, check_name, check_svg,
                    safe_filename, write_atomic)

MAGIC = b"calliope-blob\n"
# What a browser can play as is (there is no ffmpeg to convert the rest).
PLAYABLE_VIDEO = {".mp4", ".m4v", ".webm", ".mov"}
SAMPLE_MARK = ".sample-created"
_MAX_STEPS = 1_000_000


# --- running the app without threads or an event loop --------------------------
async def _run_inline(func, *args, **kwargs):
    # anyio.to_thread.run_sync takes limiter=, abandon_on_cancel= and friends.
    for key in ("limiter", "abandon_on_cancel", "cancellable"):
        kwargs.pop(key, None)
    return func(*args, **kwargs)


def install() -> None:
    """Replace the thread pools with inline calls. Process-wide, so only the
    browser runtime and its tests call it."""
    import anyio.to_thread
    import fastapi.concurrency
    import fastapi.dependencies.utils
    import fastapi.routing
    import starlette.concurrency
    import starlette.routing
    anyio.to_thread.run_sync = _run_inline
    for module in (starlette.concurrency, starlette.routing, fastapi.routing,
                   fastapi.concurrency, fastapi.dependencies.utils):
        if hasattr(module, "run_in_threadpool"):
            module.run_in_threadpool = _run_inline


def drive(coro):
    """Run a coroutine that never waits on anything external to completion."""
    try:
        for _ in range(_MAX_STEPS):
            coro.send(None)
    except StopIteration as stop:
        return stop.value
    coro.close()
    raise RuntimeError("ASGI app suspended on something that will never complete")


# The browser runs requests with `drive`. Under CPython (tests) a newer Starlette
# may open a task group per file response, which needs a real loop: tests set
# this to asyncio.run.
run = drive


# --- media as stubs ----------------------------------------------------------------
def stub(sha1: str, mime: str, size: int) -> bytes:
    return MAGIC + json.dumps({"sha1": sha1, "type": mime, "size": size}).encode() + b"\n"


def read_stub(data: bytes) -> dict | None:
    if not data.startswith(MAGIC):
        return None
    try:
        info = json.loads(data[len(MAGIC):])
    except ValueError:
        return None
    return info if isinstance(info, dict) and re.fullmatch(r"[0-9a-f]{40}", str(info.get("sha1", ""))) else None


class BrowserStore(Store):
    """The service's store, with media that live outside Python (see the module
    docstring). Only `add_media` differs: the upload it receives is the JSON
    record the page wrote after storing the file, not the file."""

    def add_media(self, name: str, filename: str, upload: Path | bytes) -> dict:
        media = self.deck_dir(name) / "media"
        media.mkdir(exist_ok=True)
        raw = upload if isinstance(upload, (bytes, bytearray)) else Path(upload).read_bytes()
        try:
            rec = json.loads(raw)
            sha1, mime, size = str(rec["sha1"]), str(rec.get("type", "")), int(rec["size"])
        except (ValueError, KeyError, TypeError):
            raise ValueError("the browser build stores media from the page; this upload carries no media record")
        if not re.fullmatch(r"[0-9a-f]{40}", sha1):
            raise ValueError("bad media record")
        filename = safe_filename(filename)
        stem, ext = os.path.splitext(filename)
        digest = sha1[:8]   # the server's name: sha1 of the content, first 8 hex digits
        if ext in IMAGE_TYPES:
            if ext == ".svg":
                text = str(rec.get("svg", "")).encode()
                check_svg(text)
                w, h = _svg_size(text)
            else:
                w, h = int(rec.get("width") or 0), int(rec.get("height") or 0)
                if w <= 0 or h <= 0:
                    raise ValueError("could not read the size of the file: no picture found")
            target = media / f"{stem}-{digest}{ext}"
            write_atomic(target, stub(sha1, mime, size))
            return {"kind": "image", "href": f"../media/{target.name}", "width": w, "height": h}
        if ext in PLAYABLE_VIDEO:
            poster = rec.get("poster") or {}
            w, h = int(rec.get("width") or 0), int(rec.get("height") or 0)
            if w <= 0 or h <= 0 or not re.fullmatch(r"[0-9a-f]{40}", str(poster.get("sha1", ""))):
                raise ValueError("this browser cannot play the movie, so it has no picture to show")
            target = media / f"{stem}-{digest}{ext}"
            poster_file = media / f"{stem}-{digest}.poster.jpg"
            write_atomic(target, stub(sha1, mime or "video/mp4", size))
            write_atomic(poster_file, stub(poster["sha1"], "image/jpeg", int(poster.get("size", 0))))
            return {"kind": "video", "href": f"../media/{poster_file.name}", "video": f"../media/{target.name}",
                    "width": w, "height": h}
        if ext in VIDEO_TYPES:
            raise ValueError(f"{ext} movies need converting, and the browser build has no converter: "
                             "use an H.264 .mp4 (or a .webm), or upload it on the Calliope service")
        raise ValueError(f"unsupported file type {ext or '(none)'}")


def _svg_size(data: bytes) -> tuple[int, int]:
    from xml.etree import ElementTree
    root = ElementTree.fromstring(data)
    vb = (root.get("viewBox") or "").replace(",", " ").split()
    if len(vb) == 4:
        return round(float(vb[2])), round(float(vb[3]))
    return 400, 300


# --- the app -------------------------------------------------------------------------
_app = None
_store: BrowserStore | None = None


def boot(data: str) -> None:
    """Create the app over the data directory (an IDBFS mount in the browser)."""
    global _app, _store
    original = server.Store
    server.Store = BrowserStore   # create_app builds its store from this name
    try:
        _app = server.create_app(Path(data))
    finally:
        server.Store = original
    # The store create_app made is reachable from any route's closure; keep our own
    # handle to the same data directory for the browser-only routes below.
    _store = BrowserStore(Path(data))
    _add_browser_routes(_app, _store)


def _add_browser_routes(app, store: BrowserStore) -> None:
    @app.get("/api/browser/media")
    def media_index():
        """Every media stub and font file a page may need a URL for."""
        return media_index_of(store)

    @app.post("/api/browser/import")
    async def import_zip(request: Request, filename: str = ""):
        try:
            return import_deck(store, await request.body(), filename)
        except (ValueError, KeyError, zipfile.BadZipFile) as e:
            raise HTTPException(400, f"could not import {filename or 'the file'}: {e}")


def media_index_of(store: Store) -> dict:
    media, fonts = {}, []
    for meta in sorted(store.decks.glob("*/deck.json")) if store.decks.is_dir() else []:
        root = meta.parent
        for path in sorted((root / "media").glob("*")) if (root / "media").is_dir() else []:
            if path.is_file() and path.stat().st_size < 4096:
                info = read_stub(path.read_bytes())
                if info:
                    media[f"/d/{root.name}/media/{path.name}"] = info
        for path in sorted((root / "fonts").rglob("*")) if (root / "fonts").is_dir() else []:
            if path.is_file():
                st = path.stat()
                fonts.append({"url": f"/d/{root.name}/{path.relative_to(root).as_posix()}",
                              "v": f"{st.st_size}-{st.st_mtime_ns}"})
    for path in sorted(store.fonts.rglob("*")) if store.fonts.is_dir() else []:
        if path.is_file():
            st = path.stat()
            fonts.append({"url": "/api/fonts/file/" + path.relative_to(store.fonts).as_posix(),
                          "v": f"{st.st_size}-{st.st_mtime_ns}"})
    return {"media": media, "fonts": fonts}


def dispatch(method: str, url: str, headers_json: str = "{}", body: bytes = b""):
    """One HTTP request through the app, as `(status, headers_json, body_bytes)`."""
    parts = urlsplit(url)
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": method.upper(), "scheme": "http", "root_path": "",
        "path": parts.path, "raw_path": parts.path.encode(),
        "query_string": parts.query.encode(),
        "headers": [(k.lower().encode("latin-1"), str(v).encode("latin-1"))
                    for k, v in json.loads(headers_json).items()],
        "client": ("browser", 0), "server": ("browser", 80),
    }
    pending = [{"type": "http.request", "body": bytes(body), "more_body": False}]
    status, headers, chunks = None, [], []

    async def receive():
        return pending.pop() if pending else {"type": "http.disconnect"}

    async def send(message):
        nonlocal status, headers
        if message["type"] == "http.response.start":
            status = message["status"]
            headers = message.get("headers", [])
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))

    try:
        run(_app(scope, receive, send))
    except Exception:
        # ServerErrorMiddleware sends its 500 and then re-raises for a server to
        # log: print the traceback for the console, re-raise only if nothing went out.
        import traceback
        traceback.print_exc()
        if status is None:
            raise
    out = {k.decode("latin-1"): v.decode("latin-1") for k, v in headers}
    data = b"".join(chunks)
    if parts.path.startswith("/d/") and data.startswith(MAGIC):
        info = read_stub(data)
        if info:
            out["x-calliope-blob"] = info["sha1"]
            out["content-type"] = info.get("type") or out.get("content-type", "application/octet-stream")
    if parts.path.endswith("/export.zip") and status == 200:
        out["x-calliope-zip-stubs"] = "1"   # the worker puts the media back in
    return status, json.dumps(out), data


# --- moving decks in -------------------------------------------------------------------
_DATA_SCRIPT = re.compile(rb'<script type="application/json" id="svgdeck-data">(.*?)</script>', re.S)


def import_deck(store: Store, data: bytes, filename: str = "") -> dict:
    """Make a new deck from a zip: either an offline export (`svgdeck export
    --zip`, the editor's "Export offline copy") or a deck folder zipped as is.
    Media entries are expected as stubs already (the worker stores the bytes
    first); history (commits/, revisions/, trash/) is not carried over."""
    z = zipfile.ZipFile(io.BytesIO(data))
    names = [n for n in z.namelist() if not n.endswith("/") and "__MACOSX" not in n]
    found = sorted((n for n in names if PurePosixPath(n).name == "deck.json"), key=lambda n: n.count("/"))
    if found:
        root = found[0][: -len("deck.json")]
        meta = json.loads(z.read(found[0]))
        slides = {}
        for entry in meta.get("slides", []):
            sid = entry.get("id") if isinstance(entry, dict) else None
            if not isinstance(sid, str) or not SLIDE_ID.match(sid):
                raise ValueError("deck.json lists a bad slide id")
            try:
                slides[sid] = z.read(f"{root}slides/{sid}.svg")
            except KeyError:
                raise ValueError(f"slide {sid} has no file in the zip") from None
        fonts = {f"fonts/{n[len(root) + 6:]}": z.read(n) for n in names if n.startswith(f"{root}fonts/")}
    else:
        pages = sorted((n for n in names if PurePosixPath(n).name == "index.html"), key=lambda n: n.count("/"))
        if not pages:
            raise ValueError("neither a deck folder (deck.json) nor an offline export (index.html)")
        root = pages[0][: -len("index.html")]
        match = _DATA_SCRIPT.search(z.read(pages[0]))
        if not match:
            raise ValueError("index.html is not an svgdeck export")
        meta = json.loads(match.group(1))
        slides = {}
        for entry in meta.get("slides", []):
            sid = entry.get("id")
            if not isinstance(sid, str) or not SLIDE_ID.match(sid):
                raise ValueError("the export lists a bad slide id")
            slides[sid] = str(entry.pop("svg", "")).encode("utf-8")
        # The export converts fonts to woff2 next to the page; point the deck at those.
        fonts = {}
        for font in meta.get("fonts", []):
            woff2 = f"fonts/{PurePosixPath(font['file']).with_suffix('.woff2').name}"
            if f"{root}{woff2}" in names:
                fonts[woff2] = z.read(f"{root}{woff2}")
                font["file"] = woff2
    if meta.get("format") != FORMAT:
        raise ValueError(f"unsupported deck format {meta.get('format')!r}")
    check_deck_fields(meta)
    if not slides:
        raise ValueError("the deck has no slides")
    for sid, svg in slides.items():
        try:
            check_svg(svg)
        except ValueError as e:
            raise ValueError(f"slide {sid}: {e}") from None
    media = {}
    for n in names:
        if n.startswith(f"{root}media/"):
            body = z.read(n)
            if not read_stub(body):
                raise ValueError(f"{n} was not stored by the page")
            media[n[len(root) + 6:]] = body

    base = PurePosixPath(root.rstrip("/")).name if root else PurePosixPath(filename).stem
    base = re.sub(r"[^A-Za-z0-9_.-]+", "-", base).strip("-.")[:90] or "imported"
    if not base[0].isalnum():
        base = "d" + base
    name, n = base, 1
    while (store.decks / name).exists():
        n += 1
        name = f"{base}-{n}"
    check_name(name)
    path = store.decks / name
    staging = store.decks / f".import-{os.urandom(4).hex()}"
    try:
        for sub in ("slides", "media", "fonts"):
            (staging / sub).mkdir(parents=True)
        for sid, svg in slides.items():
            write_atomic(staging / "slides" / f"{sid}.svg", svg)
        for rel, body in media.items():
            _safe_child(staging / "media", rel)
            write_atomic(staging / "media" / rel, body)
        for rel, body in fonts.items():
            _safe_child(staging, rel)
            write_atomic(staging / rel, body)
        meta = dict(meta, slides=[{k: v for k, v in s.items() if k != "svg"} for s in meta["slides"]])
        write_atomic(staging / "deck.json", (json.dumps(meta, indent=2, ensure_ascii=False) + "\n").encode())
        Deck.load(staging).slide_sources()   # proves every slide is readable
        staging.rename(path)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return store._summary(name)


def _safe_child(root: Path, rel: str) -> None:
    parts = PurePosixPath(rel).parts
    if not parts or any(p in ("", ".", "..") for p in parts) or rel.startswith("/"):
        raise ValueError(f"bad path in the zip: {rel}")


# --- the sample deck -------------------------------------------------------------------
def needs_sample(data: str) -> bool:
    root = Path(data)
    return not (root / SAMPLE_MARK).exists() and not any((root / "decks").glob("*/deck.json"))


def create_sample(data: str, sample_dir: str, picture_json: str) -> dict | None:
    """The deck a first visit finds: slides from `sample_dir` (deck.json +
    slides/), with the picture (already stored by the page) as its media."""
    root = Path(data)
    if not needs_sample(data):
        return None
    store = BrowserStore(root)
    src = Path(sample_dir)
    meta = json.loads((src / "deck.json").read_text(encoding="utf-8"))
    name = meta.pop("name")
    path = store.decks / name
    for sub in ("slides", "media", "fonts"):
        (path / sub).mkdir(parents=True, exist_ok=True)
    for svg in (src / "slides").glob("*.svg"):
        shutil.copyfile(svg, path / "slides" / svg.name)
    picture = json.loads(picture_json)
    write_atomic(path / "media" / picture["file"], stub(picture["sha1"], picture["type"], picture["size"]))
    write_atomic(path / "deck.json", (json.dumps(meta, indent=2) + "\n").encode())
    (root / SAMPLE_MARK).write_text("the sample deck was made once; deleting it keeps it gone\n")
    return store._summary(name)
