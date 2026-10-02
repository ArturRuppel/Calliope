"""PDF export: the player's print mode, printed by headless Chromium.

Needs Playwright and its Chromium (`pip install 'svgdeck[pdf]'`, then
`playwright install chromium`), or a Chromium named by $SVGDECK_CHROMIUM.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from urllib.parse import quote

from .deck import Deck

MISSING_PLAYWRIGHT = "PDF export needs Playwright: pip install 'svgdeck[pdf]'"
CSS_PX_PER_INCH = 96
TIMEOUT_MS = 120_000


def require_playwright():
    """The sync_playwright entry point, or a RuntimeError saying how to get it."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise RuntimeError(MISSING_PLAYWRIGHT) from None
    return sync_playwright


def render_pdf(deck: Path, out: Path, *, notes: bool = False, steps: bool = False) -> Path:
    """Write the deck as a PDF to `out`: one page per slide, fully built, each
    page the deck size at 96 px per inch (1920x1080 is 20 x 11.25 in).

    `steps` prints one page per build step instead (the initial state, then the
    state after each step). `notes` prints handout pages: the slide scaled
    down with its speaker notes under it, on the same page size. Returns the
    absolute path of the PDF."""
    sync_playwright = require_playwright()
    source = deck if isinstance(deck, Deck) else Deck.load(Path(deck))
    out = Path(out).absolute()
    with tempfile.TemporaryDirectory(prefix="svgdeck-pdf-") as tmp:
        from .export import export
        site = export(source, Path(tmp) / "site", include_notes=notes)
        print_export(site, out, size=source.meta.get("size") or [1920, 1080], notes=notes, steps=steps,
                     sync_playwright=sync_playwright)
    return out


def print_export(site: Path, out: Path, *, size, notes: bool = False, steps: bool = False,
                 sync_playwright=None) -> Path:
    """Print an existing standalone export (`site`/index.html) to `out`."""
    sync_playwright = sync_playwright or require_playwright()
    width, height = (int(round(float(v))) for v in size)
    flags = ",".join(name for name, on in (("notes", notes), ("steps", steps)) if on) or "1"
    url = (Path(site) / "index.html").absolute().as_uri() + "?print=" + quote(flags, safe=",")
    out = Path(out).absolute()
    out.parent.mkdir(parents=True, exist_ok=True)
    executable = os.environ.get("SVGDECK_CHROMIUM") or None

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(executable_path=executable)
        except Exception as error:  # playwright.sync_api.Error: no browser where expected
            where = f"SVGDECK_CHROMIUM={executable}" if executable else "Playwright's Chromium"
            raise RuntimeError(f"PDF export could not start Chromium ({where}). Run `playwright install "
                               f"chromium` or set SVGDECK_CHROMIUM to a Chromium executable.\n{error}") from None
        try:
            page = browser.new_page(viewport={"width": width, "height": height})
            page.set_default_timeout(TIMEOUT_MS)
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(url, wait_until="load")
            page.wait_for_function("document.getElementById('svgdeck')?.svgdeck?.ready")
            page.evaluate("""async () => {
                await document.fonts.ready;
                await document.getElementById('svgdeck').svgdeck.ready;
            }""")
            if errors:
                raise RuntimeError("PDF export: the player failed: " + "; ".join(errors))
            data = page.pdf(width=f"{width / CSS_PX_PER_INCH}in", height=f"{height / CSS_PX_PER_INCH}in",
                            margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
                            print_background=True, prefer_css_page_size=True)
        finally:
            browser.close()

    handle, name = tempfile.mkstemp(prefix=f".{out.name}.tmp-", dir=out.parent)
    staged = Path(name)
    try:
        with os.fdopen(handle, "wb") as f:
            f.write(data)
        umask = os.umask(0)
        os.umask(umask)
        staged.chmod(0o666 & ~umask)
        staged.replace(out)
    except BaseException:
        staged.unlink(missing_ok=True)
        raise
    return out
