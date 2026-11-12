"""The svgdeck service: deck list, editor, presenter, and the editing API."""
from __future__ import annotations

import html
import importlib
import json
import re
import shutil
import tempfile
from importlib import resources
from pathlib import Path
from urllib.parse import quote

from anyio import CapacityLimiter, to_thread
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.background import BackgroundTask

from .deck import Deck, render_page
from .export import export
from .guard import RequestGuard, hosts_from_env
from .store import Conflict, Store, check_name

# An SVG opened on its own runs its scripts with the site's rights; served
# with these headers it is a picture in an opaque origin, and never sniffed.
SVG_HEADERS = {"Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff"}

MAX_UPLOAD = 2 * 1024**3   # movies and images, streamed to disk
MAX_BODY = 64 * 1024**2    # slides and fonts, held in memory


def truthy(value: str) -> bool:
    return value.strip().lower() in ("1", "true", "yes", "on")


def create_app(data: Path, *, hosts: list[str] | None = None, guard: bool = True) -> FastAPI:
    """The service over a data directory. `hosts` are the Host names served
    besides loopback (default: $SVGDECK_HOSTS); `guard=False` leaves out the
    Host and Origin checks, for the browser build, whose requests never
    leave the page (svgdeck.guard)."""
    store = Store(data)
    app = FastAPI(title="svgdeck", docs_url=None, redoc_url=None)
    if guard:
        app.add_middleware(RequestGuard, hosts=hosts_from_env() if hosts is None else hosts)
    editor_dir = Path(str(resources.files("svgdeck") / "editor"))
    # Serialize CPU-heavy conversions without blocking saves or consuming the
    # thread-pool capacity used by the read endpoints. Waiting stays async.
    media_limiter = CapacityLimiter(1)
    pdf_limiter = CapacityLimiter(1)  # a headless browser per PDF: one at a time

    def deck_dir(name: str) -> Path:
        try:
            return store.deck_dir(name)
        except KeyError:
            raise HTTPException(404, "no such deck")

    def deck_problem(error: Exception) -> HTTPException:
        """A deck that cannot be loaded or rendered: a dangling slide entry, a
        broken or unsupported deck.json."""
        if isinstance(error, FileNotFoundError):
            return HTTPException(404, f"the deck is incomplete: {error}")
        if isinstance(error, KeyError):
            return HTTPException(400, f"deck.json is missing {error}")
        return HTTPException(400, f"the deck cannot be read: {error}")

    async def json_object(request: Request, optional: bool = False) -> dict:
        """The JSON object in a request body; with `optional`, an empty body is {}."""
        raw = await request.body()
        if optional and not raw.strip():
            return {}
        try:
            value = json.loads(raw)
        except ValueError:
            raise HTTPException(400, "the request body must be a JSON object")
        if not isinstance(value, dict):
            raise HTTPException(400, "the request body must be a JSON object")
        return value

    def new_name(req: dict):
        """The "name" of a rename, duplicate or restore body; None when absent."""
        name = req.get("name")
        if name is not None and not isinstance(name, str):
            raise HTTPException(400, "deck names use letters, digits, - _ and .")
        return name

    async def body(request: Request) -> bytes:
        """A request body that is held in memory, so it is limited to MAX_BODY."""
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > MAX_BODY:
            raise HTTPException(413, "file too large")
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_BODY:
                raise HTTPException(413, "file too large")
            chunks.append(chunk)
        return b"".join(chunks)

    async def spooled(request: Request) -> Path:
        """Stream an upload to a file in the data dir (movies can be large)."""
        tmp_dir = store.data / "uploads"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=tmp_dir)
        size = 0
        try:
            with open(fd, "wb") as f:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_UPLOAD:
                        raise HTTPException(413, "file too large")
                    f.write(chunk)
        except BaseException:
            Path(name).unlink(missing_ok=True)
            raise
        return Path(name)

    # --- pages ---------------------------------------------------------------
    @app.get("/", response_class=HTMLResponse)
    def index():
        return (editor_dir / "decks.html").read_text(encoding="utf-8")

    @app.get("/edit/{name}", response_class=HTMLResponse)
    def edit(name: str):
        deck_dir(name)
        return (editor_dir / "editor.html").read_text(encoding="utf-8").replace("{{DECK}}", html.escape(name))

    @app.get("/editor/{path:path}")
    def editor_file(path: str):
        target = (editor_dir / path).resolve()
        if not target.is_relative_to(editor_dir.resolve()) or not target.is_file():
            raise HTTPException(404)
        return FileResponse(target, headers={"Cache-Control": "no-cache"})

    @app.get("/healthz")
    async def healthz():
        """Cheap liveness check: does not touch the data directory."""
        return {"ok": True}

    # --- offline copy --------------------------------------------------------
    @app.get("/sw.js")
    def service_worker():
        """Served from the root so its scope covers the presenter as well as the editor."""
        return FileResponse(editor_dir / "sw.js", media_type="text/javascript",
                            headers={"Cache-Control": "no-cache"})

    @app.get("/api/offline")
    def offline_manifest():
        """What a client needs to present every deck without the server: the
        app's own files, and per deck its presenter page, media and fonts.
        A version changes whenever the content behind the URL does."""
        def version(path: Path) -> str:
            stat = path.stat()
            return f"{stat.st_size}-{stat.st_mtime_ns}"

        shell = [{"url": "/", "v": version(editor_dir / "decks.html")}]
        shell += [{"url": "/editor/" + quote(path.relative_to(editor_dir).as_posix()), "v": version(path)}
                  for path in sorted(editor_dir.rglob("*")) if path.is_file() and path.name != "sw.js"]
        # The presenter page inlines the player, so new player code is a new page.
        player = [*Path(str(resources.files("svgdeck") / "player")).iterdir(), editor_dir / "movie-range.js",
                  editor_dir / "sanitize-svg.js"]
        code = max(path.stat().st_mtime_ns for path in player)
        decks = []
        for summary in store.list_decks():
            name = summary["name"]
            root = store.deck_dir(name)
            with store._lock(name):
                sources = [root / "deck.json", *sorted((root / "slides").glob("*.svg"))]
                page = f"{len(sources)}-{max(p.stat().st_mtime_ns for p in sources)}-{code}"
                files = [{"url": f"/d/{name}/" + quote(path.relative_to(root).as_posix()),
                          "v": version(path), "size": path.stat().st_size}
                         for sub in ("media", "fonts") for path in sorted((root / sub).rglob("*")) if path.is_file()]
            decks.append({"name": name, "title": summary["title"],
                          "page": {"url": f"/d/{name}/", "v": page}, "files": files})
        return JSONResponse({"shell": shell, "decks": decks}, headers={"Cache-Control": "no-store"})

    @app.get("/d/{name}")
    def deck_redirect(name: str):
        return RedirectResponse(f"/d/{name}/")

    @app.get("/d/{name}/", response_class=HTMLResponse)
    def present(name: str):
        deck_dir(name)
        try:
            with store._lock(name):
                return render_page(Deck.load(store.deck_dir(name)), editor_url=f"/edit/{name}")
        except (FileNotFoundError, ValueError, KeyError) as e:
            raise deck_problem(e)

    @app.get("/d/{name}/{path:path}")
    def deck_file(name: str, path: str):
        root = deck_dir(name).resolve()
        target = (root / path).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            raise HTTPException(404)
        # Uploaded media carry a hash of their content in the name and never
        # change. Without this a file added a moment ago counts as stale, and
        # WebKit downloads it again for every element that shows it.
        hashed = path.startswith(("media/", "fonts/")) and re.search(r"-[0-9a-f]{8,16}(\.poster)?\.[^./]+$", path)
        cache = "public, max-age=31536000, immutable" if hashed else "max-age=300"
        headers = {"Cache-Control": cache, "X-Content-Type-Options": "nosniff"}
        if target.suffix.lower() == ".svg":
            headers.update(SVG_HEADERS)
        return FileResponse(target, headers=headers)

    # --- API: decks -------------------------------------------------------------
    @app.get("/api/decks")
    def list_decks():
        return store.list_decks()

    @app.post("/api/decks")
    async def create_deck(request: Request):
        req = await request.json()
        try:
            return await to_thread.run_sync(store.create_deck, str(req.get("name", "")), str(req.get("title", "")))
        except FileExistsError:
            raise HTTPException(409, "a deck with that name exists")
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.delete("/api/decks/{name}")
    def delete_deck(name: str):
        deck_dir(name)
        return store.delete_deck(name)

    @app.get("/api/trash")
    def deleted_decks():
        return store.list_deleted_decks()

    @app.post("/api/trash/{token}/restore")
    async def restore_deck(token: str, request: Request):
        name = new_name(await json_object(request, optional=True))
        try:
            return await to_thread.run_sync(store.restore_deck, token, name)
        except KeyError:
            raise HTTPException(404, "no such deleted deck")
        except FileExistsError:
            raise HTTPException(409, "a deck with that name exists; restore it under another name")
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/decks/{name}/rename")
    async def rename_deck(name: str, request: Request):
        deck_dir(name)
        target = new_name(await json_object(request))
        try:
            return await to_thread.run_sync(store.rename_deck, name, "" if target is None else target)
        except KeyError:
            raise HTTPException(404, "no such deck")
        except FileExistsError:
            raise HTTPException(409, "a deck with that name exists")
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/decks/{name}/duplicate")
    async def duplicate_deck(name: str, request: Request):
        deck_dir(name)
        target = new_name(await json_object(request, optional=True))
        if target is not None:
            try:
                check_name(target)
            except ValueError as e:
                raise HTTPException(400, str(e))
        try:
            summary = await to_thread.run_sync(store.duplicate_deck, name, target)
        except KeyError as e:
            if e.args == (name,):
                raise HTTPException(404, "no such deck")
            raise deck_problem(e)
        except FileExistsError:
            raise HTTPException(409, "a deck with that name exists")
        except (FileNotFoundError, ValueError) as e:
            raise deck_problem(e)
        return JSONResponse(summary, status_code=201)

    @app.get("/api/decks/{name}")
    def get_deck(name: str):
        deck_dir(name)
        return store.get_deck(name)

    @app.put("/api/decks/{name}")
    async def put_deck(name: str, request: Request):
        deck_dir(name)
        req = await request.json()
        try:
            return await to_thread.run_sync(store.put_deck, name, req.get("deck", {}), req.get("base"))
        except Conflict:
            raise HTTPException(409, "the deck changed elsewhere; reload")
        except ValueError as e:
            raise HTTPException(400, str(e))

    # --- API: immutable deck commits -----------------------------------------
    @app.get("/api/decks/{name}/commits")
    def list_commits(name: str):
        deck_dir(name)
        return store.list_commits(name)

    @app.post("/api/decks/{name}/commits")
    async def create_commit(name: str, request: Request):
        deck_dir(name)
        req = await request.json()
        try:
            return await to_thread.run_sync(store.create_commit, name, str(req.get("message", "")),
                                            req.get("expectedDeck"), req.get("expectedSlides"))
        except Conflict:
            raise HTTPException(409, "the working copy changed while committing; try again")
        except ValueError as error:
            raise HTTPException(400, str(error))

    @app.get("/api/decks/{name}/commits/{commit}/diff")
    def commit_diff(name: str, commit: str, target: str = "parent"):
        deck_dir(name)
        try:
            data = store.diff_commit(name, commit, target)
        except KeyError:
            raise HTTPException(404, "no such commit")
        except ValueError as error:
            raise HTTPException(400, str(error))
        return Response(data, media_type="text/plain; charset=utf-8", headers={"Cache-Control": "no-cache"})

    @app.post("/api/decks/{name}/commits/{commit}/restore")
    async def restore_commit(name: str, commit: str, request: Request):
        deck_dir(name)
        req = await request.json()
        try:
            return await to_thread.run_sync(store.restore_commit, name, commit,
                                            req.get("expectedDeck"), req.get("expectedSlides"))
        except KeyError:
            raise HTTPException(404, "no such commit")
        except Conflict:
            raise HTTPException(409, "the working copy changed while restoring; try again")
        except ValueError as error:
            raise HTTPException(400, str(error))

    # --- API: slides ------------------------------------------------------------
    @app.get("/api/decks/{name}/slides/{slide}")
    def get_slide(name: str, slide: str):
        deck_dir(name)
        try:
            data, ver = store.get_slide(name, slide)
        except KeyError:
            raise HTTPException(404, "no such slide")
        return Response(data, media_type="image/svg+xml",
                        headers={"ETag": f'"{ver}"', "Cache-Control": "no-cache", **SVG_HEADERS})

    @app.put("/api/decks/{name}/slides/{slide}")
    async def put_slide(name: str, slide: str, request: Request):
        deck_dir(name)
        base = request.headers.get("If-Match", "").strip('"') or None
        data = await body(request)
        try:
            ver = await to_thread.run_sync(store.put_slide, name, slide, data, base)
        except KeyError:
            raise HTTPException(404, "no such slide")
        except Conflict:
            raise HTTPException(409, "the slide changed elsewhere; reload")
        except ValueError as e:
            raise HTTPException(400, f"not a valid slide: {e}")
        return {"version": ver}

    @app.get("/api/decks/{name}/slides/{slide}/revisions")
    async def slide_revisions(name: str, slide: str):
        deck_dir(name)
        try:
            return await to_thread.run_sync(store.list_revisions, name, slide)
        except KeyError:
            raise HTTPException(404, "no such slide")

    @app.get("/api/decks/{name}/slides/{slide}/revisions/{token}")
    async def slide_revision(name: str, slide: str, token: str):
        deck_dir(name)
        try:
            data, ver = await to_thread.run_sync(store.get_revision, name, slide, token)
        except (KeyError, ValueError):
            raise HTTPException(404, "no such revision")
        return Response(data, media_type="image/svg+xml",
                        headers={"ETag": f'"{ver}"', "Cache-Control": "no-cache", **SVG_HEADERS})

    @app.post("/api/decks/{name}/slides/{slide}/revisions/{token}/restore")
    async def restore_slide_revision(name: str, slide: str, token: str, request: Request):
        deck_dir(name)
        base = request.headers.get("If-Match", "").strip('"') or None
        try:
            return {"version": await to_thread.run_sync(store.restore_revision, name, slide, token, base)}
        except KeyError:
            raise HTTPException(404, "no such revision")
        except Conflict:
            raise HTTPException(409, "the slide changed elsewhere; reload")
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/decks/{name}/slides/{slide}/preserve-conflict")
    async def preserve_slide_conflict(name: str, slide: str, request: Request):
        deck_dir(name)
        try:
            data = await body(request)
            return await to_thread.run_sync(store.preserve_conflict, name, slide, data)
        except KeyError:
            raise HTTPException(404, "no such slide")
        except (ValueError, UnicodeDecodeError) as e:
            raise HTTPException(400, f"not a valid slide: {e}")

    @app.get("/api/decks/{name}/trash")
    async def trash(name: str):
        deck_dir(name)
        return await to_thread.run_sync(store.list_trash, name)

    @app.post("/api/decks/{name}/trash/{token}/restore")
    async def restore_trash(name: str, token: str):
        deck_dir(name)
        try:
            return await to_thread.run_sync(store.restore_trash, name, token)
        except KeyError:
            raise HTTPException(404, "no such deleted slide")
        except ValueError as e:
            raise HTTPException(400, str(e))

    # --- API: media and fonts -------------------------------------------------------
    @app.post("/api/decks/{name}/media")
    async def add_media(name: str, filename: str, request: Request):
        deck_dir(name)
        upload = await spooled(request)
        try:
            # run_sync waits for its worker even when the request is cancelled,
            # so the upload remains available until processing has finished.
            return await to_thread.run_sync(store.add_media, name, filename, upload,
                                           limiter=media_limiter)
        except ValueError as e:
            raise HTTPException(400, str(e))
        finally:
            upload.unlink(missing_ok=True)

    @app.get("/api/fonts")
    def fonts():
        return store.font_faces()

    @app.get("/api/fonts/file/{path:path}")
    def font_file(path: str):
        root = store.fonts.resolve()
        target = (root / path).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            raise HTTPException(404)
        return FileResponse(target)

    @app.post("/api/fonts")
    async def add_font(filename: str, request: Request):
        try:
            data = await body(request)
            return await to_thread.run_sync(store.add_font, filename, data)
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/decks/{name}/fonts")
    async def use_family(name: str, request: Request):
        deck_dir(name)
        try:
            family = str((await request.json()).get("family", ""))
            return await to_thread.run_sync(store.use_family, name, family)
        except KeyError:
            raise HTTPException(404, "no such font family in the library")
        except ValueError as e:
            raise HTTPException(400, str(e))

    # --- API: export ------------------------------------------------------------------
    def snapshot_deck(name: str, dest: Path) -> Deck:
        """Copy deck.json and the slides into `dest` under the deck's write lock.
        media/ and fonts/ are linked, not copied: files there are only ever added,
        so the (slow) export can run without holding the lock."""
        with store._lock(name):
            origin = store.deck_dir(name)
            deck = Deck.load(origin)
            (dest / "slides").mkdir(parents=True)
            shutil.copyfile(origin / "deck.json", dest / "deck.json")
            for entry in deck.meta["slides"]:
                try:
                    shutil.copyfile(deck.slide_file(entry["id"]), dest / "slides" / f"{entry['id']}.svg")
                except FileNotFoundError:
                    raise FileNotFoundError(f"slide {entry['id']} has no file") from None
            for sub in ("media", "fonts"):
                if (origin / sub).is_dir():
                    (dest / sub).symlink_to((origin / sub).resolve(), target_is_directory=True)
        return Deck.load(dest)

    def snapshot_or_http(name: str, dest: Path) -> Deck:
        try:
            return snapshot_deck(name, dest)
        except KeyError as e:
            raise HTTPException(404, "no such deck") if e.args == (name,) else deck_problem(e)
        except (FileNotFoundError, ValueError) as e:
            raise deck_problem(e)

    @app.get("/api/decks/{name}/export.zip")
    def export_zip(name: str):
        deck_dir(name)
        tmp = Path(tempfile.mkdtemp(prefix="svgdeck-export-", dir=store.data))
        try:
            snapshot = snapshot_or_http(name, tmp / ".snapshot" / name)
            export(snapshot, tmp / name, tmp / f"{name}.zip")
        except HTTPException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        except Exception as e:
            shutil.rmtree(tmp, ignore_errors=True)
            raise HTTPException(400, f"export failed: {e}")
        return FileResponse(tmp / f"{name}.zip", filename=f"{name}.zip", media_type="application/zip",
                            background=BackgroundTask(shutil.rmtree, tmp, ignore_errors=True))

    @app.get("/api/decks/{name}/pdf")
    async def export_pdf(name: str, steps: str = ""):
        """The deck as a PDF, rendered by svgdeck.pdf (needs Playwright)."""
        deck_dir(name)
        try:
            pdf = importlib.import_module(f"{__package__}.pdf")
        except ImportError:
            raise HTTPException(501, "PDF export is not available on this server")
        tmp = Path(tempfile.mkdtemp(prefix="svgdeck-pdf-", dir=store.data))
        out = tmp / f"{name}.pdf"
        try:
            snapshot = await to_thread.run_sync(snapshot_or_http, name, tmp / ".snapshot" / name)
            await to_thread.run_sync(
                lambda: pdf.render_pdf(snapshot.path, out, steps=truthy(steps)),
                limiter=pdf_limiter)
        except HTTPException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        except RuntimeError as e:
            shutil.rmtree(tmp, ignore_errors=True)
            raise HTTPException(501, str(e))
        except Exception as e:
            shutil.rmtree(tmp, ignore_errors=True)
            raise HTTPException(500, f"PDF export failed: {e}")
        return FileResponse(out, filename=f"{name}.pdf", media_type="application/pdf",
                            background=BackgroundTask(shutil.rmtree, tmp, ignore_errors=True))

    return app
