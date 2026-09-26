"""Media processing must leave the ASGI loop free for reads and saves."""
import asyncio
import json
import threading

import pytest

from svgdeck.server import create_app
from svgdeck.store import Store


async def request(app, method, path, body=b"", query=b"", headers=()):
    messages = []
    delivered = False

    async def receive():
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}
        await asyncio.Future()

    async def send(message):
        messages.append(message)

    await app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
               "method": method, "scheme": "http", "path": path, "raw_path": path.encode(),
               "query_string": query, "headers": list(headers),
               "client": ("127.0.0.1", 1234), "server": ("127.0.0.1", 8490)}, receive, send)
    status = next(m["status"] for m in messages if m["type"] == "http.response.start")
    payload = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
    return status, payload


def test_media_worker_does_not_block_reads_or_saves(tmp_path, monkeypatch):
    store = Store(tmp_path)
    deck = store.create_deck("talk", "Test")
    sid = deck["deck"]["slides"][0]["id"]
    slide, version = store.get_slide("talk", sid)
    entered = threading.Event()
    release = threading.Event()
    active = 0
    peak = 0
    lock = threading.Lock()

    def processing(self, name, filename, upload):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        try:
            assert upload.read_bytes() == b"synthetic upload"
            entered.set()
            assert release.wait(5), "test did not release media processing"
            return {"kind": "image", "href": "../media/test.png"}
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(Store, "add_media", processing)
    app = create_app(tmp_path)

    async def scenario():
        first = asyncio.create_task(request(app, "POST", "/api/decks/talk/media",
                                            b"synthetic upload", b"filename=test.png"))
        second = None
        try:
            async def started():
                while not entered.is_set():
                    await asyncio.sleep(0.01)
            await asyncio.wait_for(started(), 2)
            second = asyncio.create_task(request(app, "POST", "/api/decks/talk/media",
                                                 b"synthetic upload", b"filename=second.png"))
            status, payload = await asyncio.wait_for(request(app, "GET", "/api/decks"), 2)
            assert status == 200 and json.loads(payload)[0]["name"] == "talk"
            status, _ = await asyncio.wait_for(request(app, "PUT", f"/api/decks/talk/slides/{sid}",
                slide.replace(b"#ffffff", b"#123456"), headers=[(b"if-match", version.encode())]), 2)
            assert status == 200
            assert not first.done() and not second.done()
        finally:
            release.set()
            results = await asyncio.wait_for(
                asyncio.gather(first, *([second] if second else [])), 5)
        assert all(status == 200 for status, _ in results)

    asyncio.run(scenario())
    assert peak == 1
    assert b"#123456" in store.get_slide("talk", sid)[0]
    assert not list((tmp_path / "uploads").iterdir())


@pytest.mark.parametrize("error", [ValueError("unsupported media"), RuntimeError("worker failed")])
def test_media_worker_failure_cleans_upload(tmp_path, monkeypatch, error):
    Store(tmp_path).create_deck("talk", "Test")

    def processing(self, name, filename, upload):
        assert upload.is_file()
        raise error

    monkeypatch.setattr(Store, "add_media", processing)
    app = create_app(tmp_path)
    if isinstance(error, ValueError):
        status, payload = asyncio.run(request(app, "POST", "/api/decks/talk/media", b"probe", b"filename=test.png"))
        assert status == 400 and json.loads(payload)["detail"] == "unsupported media"
    else:
        with pytest.raises(RuntimeError, match="worker failed"):
            asyncio.run(request(app, "POST", "/api/decks/talk/media", b"probe", b"filename=test.png"))
    assert not list((tmp_path / "uploads").iterdir())
