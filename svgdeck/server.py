"""The svgdeck service. Milestone 1: list decks and present them."""
from __future__ import annotations

import html
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse

from .deck import Deck, render_page


def create_app(data: Path) -> FastAPI:
    decks_dir = Path(data) / "decks"
    app = FastAPI(title="svgdeck", docs_url=None, redoc_url=None)

    def deck_or_404(name: str) -> Deck:
        path = decks_dir / name
        if "/" in name or name.startswith(".") or not (path / "deck.json").is_file():
            raise HTTPException(404, "no such deck")
        return Deck.load(path)

    @app.get("/", response_class=HTMLResponse)
    def index():
        decks = sorted(p for p in decks_dir.glob("*/deck.json")) if decks_dir.is_dir() else []
        items = "\n".join(
            f'<li><a href="/d/{html.escape(p.parent.name)}/">{html.escape(Deck.load(p.parent).title)}</a>'
            f' <small>{html.escape(p.parent.name)}</small></li>' for p in decks)
        return f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>svgdeck</title>
<style>body{{font:16px system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}}
li{{margin:.4rem 0}} small{{color:#777}}</style></head>
<body><h1>svgdeck</h1><ul>{items or "<li>No decks yet.</li>"}</ul></body></html>"""

    @app.get("/d/{name}")
    def deck_redirect(name: str):
        return RedirectResponse(f"/d/{name}/")

    @app.get("/d/{name}/", response_class=HTMLResponse)
    def present(name: str):
        return render_page(deck_or_404(name))

    @app.get("/d/{name}/{path:path}")
    def deck_file(name: str, path: str):
        deck = deck_or_404(name)
        root = deck.path.resolve()
        target = (root / path).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            raise HTTPException(404)
        return FileResponse(target)

    return app
