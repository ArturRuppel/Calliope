"""The offline copy: the manifest the deck list syncs from, and the service
worker that answers from the copy when the server cannot be reached."""
import os
import socket
import threading
import time

import pytest
import uvicorn
from starlette.testclient import TestClient

from conftest import MOVIES, SLIDE, write_deck
from svgdeck.server import create_app
from svgdeck.store import Store

BROWSER = os.environ.get("SVGDECK_BROWSER", "chromium")  # webkit = the iPad's engine


@pytest.fixture
def api(tmp_path):
    data = tmp_path / "data"
    root = write_deck(data / "decks" / "talk", [
        ("one", SLIDE.format(color="#111111", body="<text>one</text>")),
        ("two", SLIDE.format(color="#222222", body="<text>two</text>")),
    ])
    (root / "media" / "clip.txt").write_text("media")
    (root / "fonts").mkdir()
    (root / "fonts" / "f.ttf").write_text("font")
    return TestClient(create_app(data)), Store(data), root


def manifest(client):
    response = client.get("/api/offline")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def test_manifest_lists_the_shell_and_every_decks_page_media_and_fonts(api):
    client, _, root = api
    data = manifest(client)
    shell = {item["url"] for item in data["shell"]}
    assert {"/", "/editor/offline.js", "/editor/decks.html", "/editor/icon.svg"} <= shell
    assert "/editor/sw.js" not in shell  # the worker is served from /sw.js and never cached
    assert all(item["v"] for item in data["shell"])
    [deck] = data["decks"]
    assert deck["name"] == "talk" and deck["title"] == "Test deck"
    assert deck["page"]["url"] == "/d/talk/" and deck["page"]["v"]
    files = {item["url"]: item for item in deck["files"]}
    assert set(files) == {"/d/talk/media/clip.txt", "/d/talk/fonts/f.ttf"}
    assert files["/d/talk/media/clip.txt"]["size"] == len("media")
    # Every URL in the manifest is one the server answers.
    for url in shell | {deck["page"]["url"]} | set(files):
        assert client.get(url).status_code == 200, url


def test_versions_change_with_the_content_behind_them(api):
    client, store, root = api
    before = manifest(client)["decks"][0]
    slide, version = store.get_slide("talk", "one")
    store.put_slide("talk", "one", SLIDE.format(color="#333333", body="").encode(), version)
    after = manifest(client)["decks"][0]
    assert after["page"]["v"] != before["page"]["v"]
    assert after["files"] == before["files"]  # media untouched, nothing to download again

    (root / "media" / "clip.txt").write_text("other media")
    again = manifest(client)["decks"][0]
    assert again["page"]["v"] == after["page"]["v"]
    versions = {item["url"]: item["v"] for item in again["files"]}
    old = {item["url"]: item["v"] for item in after["files"]}
    assert versions["/d/talk/media/clip.txt"] != old["/d/talk/media/clip.txt"]
    assert versions["/d/talk/fonts/f.ttf"] == old["/d/talk/fonts/f.ttf"]


def test_a_deck_with_a_missing_slide_is_still_listed(api):
    """Its page cannot be copied (the presenter 404s); the sync counts that as
    one failed file, and the manifest must not fail for the other decks."""
    client, _, root = api
    (root / "slides" / "two.svg").unlink()
    [deck] = manifest(client)["decks"]
    assert deck["page"]["url"] == "/d/talk/"
    assert client.get("/d/talk/").status_code == 404


def test_service_worker_is_served_from_the_root(api):
    client, _, _ = api
    response = client.get("/sw.js")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/javascript")
    assert response.headers["cache-control"] == "no-cache"
    assert "calliope-offline-v1" in response.text


# --- in a browser -------------------------------------------------------------------

@pytest.fixture
def server(tmp_path, movie):
    data = tmp_path / "data"
    video = '<image href="../media/clock.webm" data-video="../media/clock.webm" width="640" height="480"/>'
    if not MOVIES:
        video = video.replace(' data-video="../media/clock.webm"', "")
    write_deck(data / "decks" / "talk", [
        ("a", SLIDE.format(color="#ff0000", body='<text id="t" x="100" y="200">first</text>')),
        ("b", SLIDE.format(color="#00ff00", body=video)),
    ], {"clock.webm": movie})
    # A deck whose deck.json names a slide that is gone: it cannot be copied.
    broken = write_deck(data / "decks" / "broken", [("x", SLIDE.format(color="#000000", body=""))])
    (broken / "slides" / "x.svg").unlink()
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(data), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    while not srv.started:
        time.sleep(0.02)
    yield f"http://127.0.0.1:{port}", data
    srv.should_exit = True
    thread.join(5)


def test_decks_present_without_the_server_after_a_sync(server):
    playwright = pytest.importorskip("playwright.sync_api")
    url, data = server
    synced = "document.getElementById('offline').textContent.match(/up to date|incomplete|not reachable/)"
    with playwright.sync_playwright() as p:
        browser = getattr(p, BROWSER).launch()
        context = browser.new_context()
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(e))
        page.goto(url + "/")
        page.wait_for_function(synced, timeout=30000)
        # 127.0.0.1 is a secure context, so the worker is there.
        assert page.evaluate("navigator.serviceWorker.ready.then(() => !!navigator.serviceWorker.controller)")
        # The broken deck makes the copy incomplete; the good one is all there.
        assert "incomplete: 1 file" in page.inner_text("#offline")
        cached = page.evaluate("caches.open('calliope-offline-v1').then(c => c.keys()).then(k => k.map(r => new URL(r.url).pathname))")
        assert {"/", "/d/talk/", "/d/talk/media/clock.webm", "/api/decks"} <= set(cached)
        assert "/d/broken/" not in cached

        context.set_offline(True)
        page.reload()
        page.wait_for_function("document.querySelectorAll('#decks .deck').length === 2")
        assert page.evaluate("document.body.classList.contains('offline')")
        assert page.locator("header .btn").is_hidden() and page.locator("#new").is_hidden()
        page.wait_for_function("document.getElementById('offline').textContent.includes('not reachable')")
        assert "incomplete (1 file missing)" in page.inner_text("#offline")

        presenter = context.new_page()
        failed = []
        presenter.on("requestfailed", lambda r: failed.append(r.url))
        response = presenter.goto(url + "/d/talk/")
        assert response.status == 200 and response.headers.get("x-calliope-offline") == "1"
        presenter.wait_for_selector(".svgdeck-ready .svgdeck-current svg.svgdeck-layer", state="visible")
        assert presenter.locator(".svgdeck-failed").count() == 0
        assert failed == []
        # A movie asked for in ranges gets a 206 cut from the cached copy.
        size = (data / "decks" / "talk" / "media" / "clock.webm").stat().st_size
        status, content_range, length = presenter.evaluate("""fetch('/d/talk/media/clock.webm', {headers: {Range: 'bytes=10-19'}})
            .then(async (r) => [r.status, r.headers.get('Content-Range'), (await r.arrayBuffer()).byteLength])""")
        assert (status, content_range, length) == (206, f"bytes 10-19/{size}", 10)

        editor = context.new_page()
        response = editor.goto(url + "/edit/talk")
        assert response.status == 503 and "needs the Calliope server" in editor.inner_text("h1")
        missing = context.new_page()
        assert missing.goto(url + "/d/broken/").status == 503

        # Back online, nothing has changed: only the broken deck's page is tried again.
        context.set_offline(False)
        fetched = []
        page.on("request", lambda r: fetched.append(r.url.removeprefix(url)) if r.resource_type == "fetch" else None)
        page.reload()
        page.wait_for_function(synced, timeout=30000)
        assert not page.evaluate("document.body.classList.contains('offline')")
        assert [u for u in fetched if u.startswith("/d/")] == ["/d/broken/"]
        browser.close()
    assert not errors
