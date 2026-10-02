"""The svgdeck service: deck list, editor, presenter, and the editing API."""
from __future__ import annotations

import html
import shutil
import tempfile
from importlib import resources
from pathlib import Path

from anyio import CapacityLimiter, to_thread
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from starlette.background import BackgroundTask

from .deck import Deck, render_page
from .export import export
from .store import Conflict, Store

MAX_UPLOAD = 2 * 1024**3


def create_app(data: Path) -> FastAPI:
    store = Store(data)
    app = FastAPI(title="svgdeck", docs_url=None, redoc_url=None)
    editor_dir = Path(str(resources.files("svgdeck") / "editor"))
    # Serialize CPU-heavy conversions without blocking saves or consuming the
    # thread-pool capacity used by the read endpoints. Waiting stays async.
    media_limiter = CapacityLimiter(1)

    def deck_dir(name: str) -> Path:
        try:
            return store.deck_dir(name)
        except KeyError:
            raise HTTPException(404, "no such deck")

    async def body(request: Request) -> bytes:
        data = await request.body()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, "file too large")
        return data

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
        return (editor_dir / "decks.html").read_text()

    @app.get("/edit/{name}", response_class=HTMLResponse)
    def edit(name: str):
        deck_dir(name)
        return (editor_dir / "editor.html").read_text().replace("{{DECK}}", html.escape(name))

    @app.get("/editor/{path:path}")
    def editor_file(path: str):
        target = (editor_dir / path).resolve()
        if not target.is_relative_to(editor_dir.resolve()) or not target.is_file():
            raise HTTPException(404)
        return FileResponse(target, headers={"Cache-Control": "no-cache"})

    @app.get("/d/{name}")
    def deck_redirect(name: str):
        return RedirectResponse(f"/d/{name}/")

    @app.get("/d/{name}/", response_class=HTMLResponse)
    def present(name: str):
        deck_dir(name)
        with store._lock(name):
            return render_page(Deck.load(store.deck_dir(name)), editor_url=f"/edit/{name}")

    @app.get("/d/{name}/{path:path}")
    def deck_file(name: str, path: str):
        root = deck_dir(name).resolve()
        target = (root / path).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            raise HTTPException(404)
        return FileResponse(target)

    # --- API: decks -------------------------------------------------------------
    @app.get("/api/decks")
    def list_decks():
        return store.list_decks()

    @app.post("/api/decks")
    async def create_deck(request: Request):
        req = await request.json()
        try:
            return store.create_deck(str(req.get("name", "")), str(req.get("title", "")))
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
    def restore_deck(token: str):
        try:
            return store.restore_deck(token)
        except KeyError:
            raise HTTPException(404, "no such deleted deck")
        except FileExistsError:
            raise HTTPException(409, "a deck with that name exists; rename it first")

    @app.get("/api/decks/{name}")
    def get_deck(name: str):
        deck_dir(name)
        return store.get_deck(name)

    @app.put("/api/decks/{name}")
    async def put_deck(name: str, request: Request):
        deck_dir(name)
        req = await request.json()
        try:
            return store.put_deck(name, req.get("deck", {}), req.get("base"))
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
            return store.create_commit(name, str(req.get("message", "")),
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
            return store.restore_commit(name, commit, req.get("expectedDeck"), req.get("expectedSlides"))
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
        return Response(data, media_type="image/svg+xml", headers={"ETag": f'"{ver}"', "Cache-Control": "no-cache"})

    @app.put("/api/decks/{name}/slides/{slide}")
    async def put_slide(name: str, slide: str, request: Request):
        deck_dir(name)
        base = request.headers.get("If-Match", "").strip('"') or None
        try:
            ver = store.put_slide(name, slide, await body(request), base)
        except KeyError:
            raise HTTPException(404, "no such slide")
        except Conflict:
            raise HTTPException(409, "the slide changed elsewhere; reload")
        except Exception as e:
            raise HTTPException(400, f"not a valid slide: {e}")
        return {"version": ver}

    @app.get("/api/decks/{name}/slides/{slide}/revisions")
    async def slide_revisions(name: str, slide: str):
        deck_dir(name)
        try:
            return store.list_revisions(name, slide)
        except KeyError:
            raise HTTPException(404, "no such slide")

    @app.get("/api/decks/{name}/slides/{slide}/revisions/{token}")
    async def slide_revision(name: str, slide: str, token: str):
        deck_dir(name)
        try:
            data, ver = store.get_revision(name, slide, token)
        except (KeyError, ValueError):
            raise HTTPException(404, "no such revision")
        return Response(data, media_type="image/svg+xml", headers={"ETag": f'"{ver}"', "Cache-Control": "no-cache"})

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
        return store.list_trash(name)

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
            return store.add_font(filename, await body(request))
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/decks/{name}/fonts")
    async def use_family(name: str, request: Request):
        deck_dir(name)
        try:
            return store.use_family(name, str((await request.json()).get("family", "")))
        except KeyError:
            raise HTTPException(404, "no such font family in the library")

    # --- API: export ------------------------------------------------------------------
    @app.get("/api/decks/{name}/export.zip")
    def export_zip(name: str):
        deck_dir(name)
        tmp = Path(tempfile.mkdtemp(prefix="svgdeck-export-", dir=store.data))
        try:
            with store._lock(name):
                export(Deck.load(store.deck_dir(name)), tmp / name, tmp / f"{name}.zip")
        except Exception as e:
            shutil.rmtree(tmp, ignore_errors=True)
            raise HTTPException(400, f"export failed: {e}")
        return FileResponse(tmp / f"{name}.zip", filename=f"{name}.zip", media_type="application/zip",
                            background=BackgroundTask(shutil.rmtree, tmp, ignore_errors=True))

    return app
