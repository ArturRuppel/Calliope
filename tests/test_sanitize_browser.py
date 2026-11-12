"""Slides already on disk that carry script do not run it: in the presenter
(served and exported), in the editor's canvas and thumbnails, and opening such
a slide in the editor does not rewrite it."""
import json
import os
import socket
import threading
import time

import pytest
import uvicorn

from svgdeck.deck import Deck
from svgdeck.export import export
from svgdeck.server import create_app
from svgdeck.store import Store

playwright = pytest.importorskip("playwright.sync_api")
BROWSER = os.environ.get("SVGDECK_BROWSER", "chromium")

HEAD = ('<?xml version="1.0" encoding="utf-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" '
        'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1920 1080" width="1920" height="1080">')
# What ran in the presenter and the editor before slides were sanitised.
HOSTILE = (HEAD + '<rect id="background" width="1920" height="1080" fill="#fff"/>'
           '<script>window.pwned = (window.pwned || []).concat("script")</script>'
           '<g onload="window.pwned = (window.pwned || []).concat(\'onload\')"><rect width="5" height="5"/></g>'
           '<image href="data:image/png;base64,AAAA" onerror="window.pwned = (window.pwned || []).concat(\'image\')" width="5" height="5"/>'
           '<rect width="5" height="5"><animate attributeName="x" dur="0.1s" '
           'onbegin="window.pwned = (window.pwned || []).concat(\'animate\')"/></rect>'
           '<foreignObject width="10" height="10"><img xmlns="http://www.w3.org/1999/xhtml" src="data:image/png;base64,AAAA" '
           'onerror="window.pwned = (window.pwned || []).concat(\'foreignObject\')"/></foreignObject>'
           '<a id="link" href="#"><set attributeName="href" to="javascript:window.pwned=(window.pwned||[]).concat(\'set\')"/>'
           '<rect width="300" height="300" x="600" y="300" fill="red"/></a>'
           '<text id="kept" x="100" y="200">still here</text></svg>\n')
CLEAN = HEAD + '<rect id="background" width="1920" height="1080" fill="#fff"/><text x="1" y="9">plain</text></svg>\n'


@pytest.fixture
def data(tmp_path):
    store = Store(tmp_path)
    store.create_deck("talk", "Talk")
    root = store.deck_dir("talk")
    meta = json.loads((root / "deck.json").read_text())
    (root / "slides" / "bad.svg").write_text(HOSTILE)
    (root / "slides" / "plain.svg").write_text(CLEAN)
    meta["slides"] = [{"id": "bad"}, {"id": "plain"}]
    (root / "deck.json").write_text(json.dumps(meta))
    return tmp_path


@pytest.fixture
def server(data):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(data), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    while not srv.started:
        time.sleep(0.02)
    yield f"http://127.0.0.1:{port}"
    srv.should_exit = True
    thread.join(5)


@pytest.fixture
def browser():
    with playwright.sync_playwright() as p:
        b = getattr(p, BROWSER).launch()
        yield b
        b.close()


def settle(page):
    page.wait_for_timeout(600)   # onload, onerror and the animation's begin have fired by now
    return page.evaluate("window.pwned || null")


def test_presenter_runs_no_slide_script(server, browser):
    page = browser.new_page(viewport={"width": 960, "height": 540})
    page.goto(f"{server}/d/talk/")
    page.wait_for_function("document.querySelector('.svgdeck-ready')")
    assert settle(page) is None
    assert page.locator("#s0-kept").count() == 1
    page.click(".svgdeck-current svg >> nth=0", position={"x": 375, "y": 225})
    assert settle(page) is None
    page.keyboard.press("o")   # the overview draws every slide again
    assert settle(page) is None


def test_exported_presenter_runs_no_slide_script(data, browser, tmp_path):
    out = export(Deck.load(data / "decks" / "talk"), tmp_path / "out")
    page = browser.new_page()
    page.goto((out / "index.html").as_uri())
    page.wait_for_function("document.querySelector('.svgdeck-ready')")
    assert settle(page) is None


def test_editor_runs_no_slide_script_and_leaves_the_file(server, browser, data):
    path = data / "decks" / "talk" / "slides" / "bad.svg"
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(e))
    page.goto(f"{server}/edit/talk")
    page.wait_for_function("document.getElementById('status').textContent.includes('Saved')")
    assert settle(page) is None
    assert page.evaluate("!!svgdeckEditor.editor.svg.querySelector('#kept')")
    assert page.evaluate("!svgdeckEditor.editor.svg.querySelector('script, foreignObject, [onload], [onerror]')")
    page.wait_for_timeout(1500)   # longer than the autosave delay
    assert path.read_text() == HOSTILE   # opened, not rewritten
    assert "Saved" in page.locator("#status").text_content()
    assert not errors
