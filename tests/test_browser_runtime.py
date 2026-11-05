"""svgdeck.browser, the service as the browser build runs it, under CPython.

The worker (web/worker.js) stores media bytes itself and hands the store a
record; these tests play that part. Driving the app through `dispatch` patches
the thread pools process-wide, so that runs in a subprocess."""
import io
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from svgdeck import browser
from svgdeck.browser import BrowserStore, import_deck, read_stub, stub

SHA = "0123456789abcdef0123456789abcdef01234567"
POSTER = "fedcba9876543210fedcba9876543210fedcba98"


@pytest.fixture
def store(tmp_path):
    s = BrowserStore(tmp_path)
    s.create_deck("talk", "Talk")
    return s


def record(**fields):
    return json.dumps({"sha1": SHA, "type": "image/png", "size": 1234, **fields}).encode()


def test_image_record_becomes_a_stub_named_like_the_server(store):
    info = store.add_media("talk", "My photo.png", record(width=400, height=200))
    assert info == {"kind": "image", "href": "../media/My-photo-01234567.png", "width": 400, "height": 200}
    data = (store.deck_dir("talk") / "media" / "My-photo-01234567.png").read_bytes()
    assert read_stub(data) == {"sha1": SHA, "type": "image/png", "size": 1234}


def test_svg_is_checked_and_sized_from_its_viewbox(store):
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20"/>'
    assert store.add_media("talk", "d.svg", record(type="image/svg+xml", svg=svg))["width"] == 30
    with pytest.raises(ValueError, match="DTD"):
        store.add_media("talk", "e.svg", record(svg='<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>'))


def test_movie_keeps_its_container_and_gets_a_poster(store):
    rec = record(type="video/webm", width=320, height=240, poster={"sha1": POSTER, "size": 99})
    info = store.add_media("talk", "clock.webm", rec)
    assert info["video"] == "../media/clock-01234567.webm"
    assert info["href"] == "../media/clock-01234567.poster.jpg"
    poster = read_stub((store.deck_dir("talk") / "media" / "clock-01234567.poster.jpg").read_bytes())
    assert poster["sha1"] == POSTER and poster["type"] == "image/jpeg"


def test_formats_that_need_ffmpeg_are_refused_with_a_reason(store):
    with pytest.raises(ValueError, match="no converter"):
        store.add_media("talk", "clip.mkv", record(width=1, height=1))
    with pytest.raises(ValueError, match="cannot play"):
        store.add_media("talk", "clip.mp4", record(width=0, height=0))
    with pytest.raises(ValueError, match="no media record"):
        store.add_media("talk", "x.png", b"\x89PNG not a record")


def test_stubs_move_with_the_deck(store):
    store.add_media("talk", "a.png", record(width=1, height=1))
    store.duplicate_deck("talk", "copy")
    index = browser.media_index_of(store)
    assert set(index["media"]) == {"/d/talk/media/a-01234567.png", "/d/copy/media/a-01234567.png"}


def export_zip(store, name="talk") -> bytes:
    from svgdeck.deck import Deck
    from svgdeck.export import export
    root = store.deck_dir(name)
    slide = next((root / "slides").glob("*.svg"))
    slide.write_text(slide.read_text().replace("</svg>", '<image href="../media/a-01234567.png" width="5" height="5"/></svg>'))
    out = store.data / "out"
    export(Deck.load(root), out / name, out / f"{name}.zip")
    return (out / f"{name}.zip").read_bytes()


def test_import_an_offline_export(store):
    store.add_media("talk", "a.png", record(width=1, height=1))
    summary = import_deck(store, export_zip(store), "talk.zip")
    assert summary["name"] == "talk-2" and summary["slides"] == 1
    root = store.deck_dir("talk-2")
    assert read_stub((root / "media" / "a-01234567.png").read_bytes())["sha1"] == SHA
    meta = json.loads((root / "deck.json").read_text())
    assert all(set(s) == {"id"} for s in meta["slides"])
    assert "../media/a-01234567.png" in next((root / "slides").glob("*.svg")).read_text()


def test_import_a_deck_folder_leaves_history_behind(store, tmp_path):
    store.add_media("talk", "a.png", record(width=1, height=1))
    root = store.deck_dir("talk")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for path in root.rglob("*"):
            if path.is_file():
                z.write(path, Path("my-talk") / path.relative_to(root))
        z.writestr("my-talk/commits/x/manifest.json", "{}")
    summary = import_deck(store, buf.getvalue())
    assert summary["name"] == "my-talk"
    assert not (store.decks / "my-talk" / "commits").exists()


def test_import_refuses_what_is_not_a_deck(store):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("notes.txt", "hello")
    with pytest.raises(ValueError, match="neither"):
        import_deck(store, buf.getvalue())
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("d/deck.json", json.dumps({"format": 1, "slides": [{"id": "a"}]}))
        z.writestr("d/slides/a.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>')
        z.writestr("d/media/big.png", b"\x89PNG raw bytes, not stored by the page")
    with pytest.raises(ValueError, match="not stored by the page"):
        import_deck(store, buf.getvalue())
    assert not any(p.name.startswith(".import-") for p in store.decks.iterdir())


def test_dispatch_runs_the_real_app_inline(tmp_path):
    """The worker's path: install(), boot(), dispatch(), no threads, no loop."""
    script = f"""
import asyncio, json
from svgdeck import browser
browser.install()
# CPython's Starlette may need a loop for file responses; the Pyodide one is
# driven by hand (proved at build time by tools/build-web.mjs).
browser.run = asyncio.run
browser.boot({str(tmp_path)!r})
def ask(method, url, body=b"", headers=None):
    return browser.dispatch(method, url, json.dumps(headers or {{}}), body)
status, _, _ = ask("POST", "/api/decks", json.dumps({{"name": "t", "title": "T"}}).encode(),
                   {{"content-type": "application/json"}})
assert status == 200, status
rec = json.dumps({{"sha1": {SHA!r}, "type": "image/png", "size": 3, "width": 2, "height": 2}}).encode()
status, _, body = ask("POST", "/api/decks/t/media?filename=p.png", rec)
assert status == 200, body
status, headers, body = ask("GET", "/d/t/media/p-01234567.png")
headers = json.loads(headers)
assert status == 200 and headers["x-calliope-blob"] == {SHA!r} and headers["content-type"] == "image/png"
status, headers, body = ask("GET", "/api/decks/t/export.zip")
assert status == 200 and json.loads(headers)["x-calliope-zip-stubs"] == "1"
status, _, body = ask("POST", "/api/decks/t/media?filename=m.mkv", rec)
assert status == 400 and b"no converter" in body, body
print("ok")
"""
    out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=60)
    assert out.stdout.strip() == "ok", out.stderr[-2000:]


def test_sample_deck_once(tmp_path):
    sample = Path(__file__).parent.parent / "web" / "sample"
    picture = json.dumps({"file": "pattern-01234567.png", "sha1": SHA, "type": "image/png", "size": 5})
    assert browser.create_sample(str(tmp_path), str(sample), picture)["name"] == "Welcome-to-Calliope"
    store = BrowserStore(tmp_path)
    store.delete_deck("Welcome-to-Calliope")
    assert browser.create_sample(str(tmp_path), str(sample), picture) is None
