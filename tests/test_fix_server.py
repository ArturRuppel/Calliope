"""Server and store hardening: media tool failures, listing, limits, export."""
import json
import os
import shutil
import subprocess

import pytest

from conftest import SLIDE, write_deck
from svgdeck.store import Store
import svgdeck.store as store_module


def make_store(tmp_path, slides=None):
    data = tmp_path / "data"
    root = write_deck(data / "decks" / "talk", slides or [
        ("one", SLIDE.format(color="#111111", body="<text>one</text>")),
        ("two", SLIDE.format(color="#222222", body="<text>two</text>")),
    ])
    return data, root, Store(data)


# --- ffmpeg / ffprobe failures become ValueError (HTTP 400) -----------------------

def failing_run(error):
    def run(command, *args, **kwargs):
        raise error
    return run


def test_missing_ffmpeg_is_reported_as_a_value_error(tmp_path, monkeypatch):
    _, root, store = make_store(tmp_path)
    monkeypatch.setattr(store_module.subprocess, "run", failing_run(FileNotFoundError("ffmpeg")))
    with pytest.raises(ValueError, match="ffmpeg is not installed"):
        store.add_media("talk", "clip.mov", b"not really a movie")
    assert not [p for p in (root / "media").iterdir() if p.name.startswith(("clip", ".upload"))]


def test_failed_conversion_is_reported_with_ffmpegs_message_and_leaves_no_files(tmp_path, monkeypatch):
    _, root, store = make_store(tmp_path)
    real_run = subprocess.run

    def run(command, *args, **kwargs):
        if command[0] == "ffprobe":
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")
        raise subprocess.CalledProcessError(1, command, stderr="warning\nInvalid data found when processing input\n")

    monkeypatch.setattr(store_module.subprocess, "run", run)
    with pytest.raises(ValueError, match="could not convert movie: Invalid data found"):
        store.add_media("talk", "clip.mov", b"garbage")
    monkeypatch.setattr(store_module.subprocess, "run", real_run)
    assert list((root / "media").iterdir()) == []


def test_missing_ffprobe_for_an_mp4_is_reported(tmp_path, monkeypatch):
    _, _, store = make_store(tmp_path)
    monkeypatch.setattr(store_module.subprocess, "run", failing_run(FileNotFoundError("ffprobe")))
    with pytest.raises(ValueError, match="ffprobe is not installed"):
        store.add_media("talk", "clip.mp4", b"garbage")


def test_real_ffmpeg_rejects_a_garbage_movie_cleanly(tmp_path):
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not available")
    _, root, store = make_store(tmp_path)
    with pytest.raises(ValueError, match="could not convert movie"):
        store.add_media("talk", "clip.mov", b"garbage")
    assert list((root / "media").iterdir()) == []


def test_corrupt_image_whose_size_cannot_be_probed_is_rejected_and_removed(tmp_path, monkeypatch):
    _, root, store = make_store(tmp_path)

    def run(command, *args, **kwargs):
        # ffprobe exits cleanly but finds no picture.
        return subprocess.CompletedProcess(command, 0, stdout="\n", stderr="")

    monkeypatch.setattr(store_module.subprocess, "run", run)
    with pytest.raises(ValueError, match="could not read the size"):
        store.add_media("talk", "broken.png", b"not a png")
    assert list((root / "media").iterdir()) == []


def test_real_ffprobe_rejects_a_corrupt_png(tmp_path):
    if not shutil.which("ffprobe"):
        pytest.skip("ffprobe not available")
    _, root, store = make_store(tmp_path)
    with pytest.raises(ValueError, match="could not read the size"):
        store.add_media("talk", "broken.png", b"not a png")
    assert list((root / "media").iterdir()) == []


# --- list_decks "modified" ----------------------------------------------------------

def test_list_decks_modified_ignores_revisions_trash_and_commits(tmp_path):
    _, root, store = make_store(tmp_path)
    for path in (root / "slides").glob("*.svg"):
        os.utime(path, (1_000_000, 1_000_000))
    os.utime(root / "deck.json", (500_000, 500_000))
    for stray in (root / "revisions" / "one" / "x.svg", root / "trash" / "gone.1.svg",
                  root / "commits" / "objects" / "y.svg"):
        stray.parent.mkdir(parents=True, exist_ok=True)
        stray.write_text("<svg/>")
        os.utime(stray, (9_000_000, 9_000_000))
    assert store.list_decks()[0]["modified"] == 1_000_000


def test_list_decks_modified_falls_back_to_deck_json_without_slide_files(tmp_path):
    _, root, store = make_store(tmp_path)
    for path in (root / "slides").glob("*.svg"):
        path.unlink()
    os.utime(root / "deck.json", (777_000, 777_000))
    assert store.list_decks()[0]["modified"] == 777_000


# --- utf-8 ----------------------------------------------------------------------------

def test_store_text_reads_name_utf_8_explicitly(tmp_path, monkeypatch):
    from pathlib import Path
    _, root, store = make_store(tmp_path)
    original = store.get_deck("talk")
    store.put_deck("talk", dict(original["deck"], title="Über"), original["version"])
    seen = []

    def check_read_text(self, *args, **kwargs):
        seen.append(kwargs.get("encoding"))
        return real_read_text(self, *args, **kwargs)

    real_read_text = Path.read_text
    monkeypatch.setattr(Path, "read_text", check_read_text)
    store.list_commits("talk")
    store._head_commit("talk")
    store._trash_metadata(root / "trash" / "x.svg")
    assert seen and all(encoding == "utf-8" for encoding in seen)


# --- HTTP ------------------------------------------------------------------------------

import asyncio
import io
import threading
import time
import zipfile

from starlette.testclient import TestClient

import svgdeck.server as server_module
from svgdeck.server import create_app


@pytest.fixture
def api(tmp_path):
    data, root, store = make_store(tmp_path)
    return TestClient(create_app(data)), data, root, store


def test_healthz_is_cheap(api, monkeypatch):
    client, _, _, _ = api

    def explode(self):
        raise AssertionError("healthz must not read the decks")

    monkeypatch.setattr(Store, "list_decks", explode)
    response = client.get("/healthz")
    assert response.status_code == 200 and response.json() == {"ok": True}


ENDPOINTS = [
    ("create_deck", "POST", "/api/decks", {"json": {"name": "fresh", "title": "Fresh"}}),
    ("put_deck", "PUT", "/api/decks/talk", {"json": {"deck": {}, "base": "x"}}),
    ("create_commit", "POST", "/api/decks/talk/commits", {"json": {"message": "m"}}),
    ("restore_commit", "POST", "/api/decks/talk/commits/" + "a" * 20 + "/restore", {"json": {}}),
    ("put_slide", "PUT", "/api/decks/talk/slides/one", {"content": b"<svg/>"}),
    ("list_revisions", "GET", "/api/decks/talk/slides/one/revisions", {}),
    ("get_revision", "GET", "/api/decks/talk/slides/one/revisions/nothing.svg", {}),
    ("list_trash", "GET", "/api/decks/talk/trash", {}),
    ("add_font", "POST", "/api/fonts?filename=f.ttf", {"content": b"x"}),
    ("use_family", "POST", "/api/decks/talk/fonts", {"json": {"family": "Nope"}}),
]


@pytest.mark.parametrize("method_name,verb,path,kwargs", ENDPOINTS, ids=[e[0] for e in ENDPOINTS])
def test_blocking_store_calls_run_off_the_event_loop(api, monkeypatch, method_name, verb, path, kwargs):
    client, _, _, _ = api
    on_loop = []
    real = getattr(Store, method_name)

    def recording(self, *args, **kw):
        try:
            asyncio.get_running_loop()
            on_loop.append(True)
        except RuntimeError:
            on_loop.append(False)
        return real(self, *args, **kw)

    monkeypatch.setattr(Store, method_name, recording)
    client.request(verb, path, **kwargs)
    assert on_loop == [False]


def test_slide_and_font_bodies_have_a_smaller_limit_than_media(api, monkeypatch):
    client, _, root, store = api
    monkeypatch.setattr(server_module, "MAX_BODY", 200)
    svg = SLIDE.format(color="#123456", body="x" * 400).encode()
    version = store.get_slide("talk", "one")[1]

    response = client.put("/api/decks/talk/slides/one", content=svg, headers={"If-Match": version})
    assert response.status_code == 413
    assert client.post("/api/decks/talk/slides/one/preserve-conflict", content=svg).status_code == 413
    assert client.post("/api/fonts?filename=big.ttf", content=b"f" * 400).status_code == 413
    assert store.get_slide("talk", "one")[1] == version
    # Chunked uploads without a Content-Length are limited too.
    chunks = (svg[i:i + 50] for i in range(0, len(svg), 50))
    assert client.put("/api/decks/talk/slides/one", content=chunks,
                      headers={"If-Match": version}).status_code == 413
    # Media is streamed to disk and keeps the large limit.
    big_svg = SLIDE.format(color="#abcdef", body="y" * 400).encode()
    response = client.post("/api/decks/talk/media?filename=big.svg", content=big_svg)
    assert response.status_code == 200, response.text
    # Slides under the limit still save.
    monkeypatch.setattr(server_module, "MAX_BODY", 5000)
    small = SLIDE.format(color="#654321", body="").encode()
    assert client.put("/api/decks/talk/slides/one", content=small,
                      headers={"If-Match": version}).status_code == 200


def test_invalid_slide_is_a_400(api):
    client, _, _, store = api
    version = store.get_slide("talk", "one")[1]
    response = client.put("/api/decks/talk/slides/one", content=b"<nope", headers={"If-Match": version})
    assert response.status_code == 400 and "not a valid slide" in response.json()["detail"]


def test_media_tool_failure_is_a_400_with_the_message(api, monkeypatch):
    client, _, _, _ = api
    monkeypatch.setattr(store_module.subprocess, "run", failing_run(FileNotFoundError("ffmpeg")))
    response = client.post("/api/decks/talk/media?filename=clip.mov", content=b"movie")
    assert response.status_code == 400
    assert response.json()["detail"] == "ffmpeg is not installed"


def test_presenter_and_export_report_a_dangling_slide_entry(api):
    client, _, root, _ = api
    (root / "slides" / "two.svg").unlink()
    page = client.get("/d/talk/")
    assert page.status_code == 404 and "two" in page.json()["detail"]
    export = client.get("/api/decks/talk/export.zip")
    assert export.status_code == 404 and "two" in export.json()["detail"]


@pytest.mark.parametrize("content,expected", [
    ("{not json", "cannot be read"),
    (json.dumps({"format": 99, "slides": []}), "unsupported deck format"),
    (json.dumps({"format": 1}), "missing"),
])
def test_presenter_and_export_report_an_unreadable_deck(api, content, expected):
    client, _, root, _ = api
    (root / "deck.json").write_text(content)
    for url in ("/d/talk/", "/api/decks/talk/export.zip"):
        response = client.get(url)
        assert response.status_code == 400, (url, response.text)
        assert expected in response.json()["detail"]


def test_export_zip_contains_slides_and_only_the_referenced_media(tmp_path):
    data, root, _ = make_store(tmp_path, [
        ("one", SLIDE.format(color="#111111", body='<image href="../media/pic.png" width="1" height="1"/>'))])
    (root / "media" / "pic.png").write_bytes(b"png bytes")
    (root / "media" / "unused.png").write_bytes(b"unused")
    client = TestClient(create_app(data))
    response = client.get("/api/decks/talk/export.zip")
    assert response.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(response.content)).namelist()
    assert "talk/index.html" in names and "talk/media/pic.png" in names
    assert "talk/media/unused.png" not in names
    assert not list(data.glob("svgdeck-export-*"))  # temp dir cleaned up


def test_slow_export_does_not_block_autosave(api, monkeypatch):
    _, data, _, store = api
    entered, release = threading.Event(), threading.Event()
    real_export = server_module.export

    def slow_export(deck, out, zip_path=None):
        entered.set()
        assert release.wait(10), "test did not release the export"
        return real_export(deck, out, zip_path)

    monkeypatch.setattr(server_module, "export", slow_export)
    # One app, so the export and the save share the same deck locks.
    app = create_app(data)
    result = {}

    def run_export():
        result["response"] = TestClient(app).get("/api/decks/talk/export.zip")

    thread = threading.Thread(target=run_export)
    thread.start()
    try:
        assert entered.wait(10)
        version = store.get_slide("talk", "one")[1]
        started = time.monotonic()
        saved = TestClient(app).put("/api/decks/talk/slides/one",
                                    content=SLIDE.format(color="#abcdef", body="").encode(),
                                    headers={"If-Match": version})
        assert saved.status_code == 200
        assert time.monotonic() - started < 2
    finally:
        release.set()
        thread.join(15)
    response = result["response"]
    assert response.status_code == 200
    html = zipfile.ZipFile(io.BytesIO(response.content)).read("talk/index.html").decode()
    # The export is a snapshot from before the save.
    assert "#111111" in html and "#abcdef" not in html


def test_list_decks_endpoint_still_lists(api):
    client, _, _, _ = api
    decks = client.get("/api/decks").json()
    assert [d["name"] for d in decks] == ["talk"] and decks[0]["slides"] == 2
