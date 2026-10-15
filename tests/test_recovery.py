import asyncio
import json
import socket
import threading

import pytest
import uvicorn
from playwright.sync_api import sync_playwright
from conftest import SLIDE, write_deck
from svgdeck.server import create_app
from svgdeck.store import Conflict, REVISION_LIMIT, Store
import svgdeck.store as store_module


@pytest.fixture
def recovery_browser(tmp_path):
    data = tmp_path / "browser-data"
    Store(data).create_deck("talk", "Recovery test")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_app(data), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(f"http://127.0.0.1:{port}/edit/talk")
        page.wait_for_function("window.svgdeckEditor?.state.current")
        yield page, data
        browser.close()
    server.should_exit = True
    thread.join(timeout=5)


async def request(app, method, path, body=b"", headers=()):
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
               "query_string": b"", "headers": list(headers), "client": ("127.0.0.1", 1),
               "server": ("127.0.0.1", 8490)}, receive, send)
    status = next(m["status"] for m in messages if m["type"] == "http.response.start")
    payload = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
    return status, payload


def setup(tmp_path):
    data = tmp_path / "data"
    root = write_deck(data / "decks" / "talk", [("one", SLIDE.format(color="#111", body="")),
                                                   ("two", SLIDE.format(color="#222", body=""))])
    return data, root, Store(data)


def test_slide_saves_checkpoint_and_bound_history(tmp_path):
    _, root, store = setup(tmp_path)
    _, base = store.get_slide("talk", "one")
    for index in range(REVISION_LIMIT + 4):
        data = SLIDE.format(color=f"#{index:03x}", body="").encode()
        base = store.put_slide("talk", "one", data, base)

    revisions = store.list_revisions("talk", "one")
    assert len(revisions) == REVISION_LIMIT
    newest, _ = store.get_revision("talk", "one", revisions[0]["token"])
    assert b"#020" in newest
    assert len(list((root / "revisions" / "one").glob("*.svg"))) == REVISION_LIMIT


def test_revision_prune_failure_does_not_fail_slide_save(tmp_path, monkeypatch):
    _, root, store = setup(tmp_path)
    _, base = store.get_slide("talk", "one")
    for index in range(REVISION_LIMIT + 1):
        base = store.put_slide("talk", "one", SLIDE.format(color=f"#{index:03x}", body="").encode(), base)
    victim = min((root / "revisions" / "one").glob("*.svg"), key=lambda p: p.stat().st_mtime_ns)
    real_unlink = store_module.Path.unlink

    def fail_one(path, *args, **kwargs):
        if path == victim:
            raise OSError("busy")
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(store_module.Path, "unlink", fail_one)
    saved = store.put_slide("talk", "one", SLIDE.format(color="#fff", body="").encode(), base)
    assert store.get_slide("talk", "one")[1] == saved


def test_restore_revision_is_cas_and_checkpoints_replaced_content(tmp_path):
    _, _, store = setup(tmp_path)
    original, base = store.get_slide("talk", "one")
    changed = SLIDE.format(color="#abc", body="").encode()
    latest = store.put_slide("talk", "one", changed, base)
    token = store.list_revisions("talk", "one")[0]["token"]

    with pytest.raises(Conflict):
        store.restore_revision("talk", "one", token, "stale")
    restored = store.restore_revision("talk", "one", token, latest)
    assert store.get_slide("talk", "one") == (original, restored)
    assert any(store.get_revision("talk", "one", r["token"])[0] == changed
               for r in store.list_revisions("talk", "one"))


def test_restore_trash_rolls_back_slide_if_metadata_write_fails(tmp_path, monkeypatch):
    _, root, store = setup(tmp_path)
    record = store.get_deck("talk")
    store.put_deck("talk", dict(record["deck"], slides=[{"id": "one"}]), record["version"])
    token = store.list_trash("talk")[0]["token"]
    real_write = store_module.write_atomic

    def fail_metadata(path, data):
        if path.name == "deck.json":
            raise OSError("disk full")
        return real_write(path, data)

    monkeypatch.setattr(store_module, "write_atomic", fail_metadata)
    with pytest.raises(OSError, match="disk full"):
        store.restore_trash("talk", token)
    assert (root / "trash" / token).is_file()
    assert not (root / "slides" / "two.svg").exists()
    assert [s["id"] for s in json.loads((root / "deck.json").read_text())["slides"]] == ["one"]


def test_trash_cleanup_failure_still_reports_committed_restore(tmp_path, monkeypatch):
    _, _, store = setup(tmp_path)
    record = store.get_deck("talk")
    store.put_deck("talk", dict(record["deck"], slides=[{"id": "one"}]), record["version"])
    token = store.list_trash("talk")[0]["token"]
    real_unlink = store_module.Path.unlink

    def fail_trash(path, *args, **kwargs):
        if path.name == token:
            raise OSError("busy")
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(store_module.Path, "unlink", fail_trash)
    result = store.restore_trash("talk", token)
    assert result["deck"]["slides"][-1]["id"] == "two"
    assert store.get_slide("talk", "two")[0]


def test_preserve_conflict_keeps_both(tmp_path):
    _, root, store = setup(tmp_path)
    local = SLIDE.format(color="#f00", body="<text>local</text>").encode()
    remote = SLIDE.format(color="#0f0", body="<text>remote</text>").encode()
    _, base = store.get_slide("talk", "one")
    store.put_slide("talk", "one", remote, base)
    result = store.preserve_conflict("talk", "one", local)

    assert store.get_slide("talk", "one")[0] == remote
    assert store.get_slide("talk", result["recovered"])[0] == local
    assert result["original"].encode() == remote
    assert result["deck"]["slides"][-1]["id"] == result["recovered"]
    assert json.loads((root / "deck.json").read_text()) == result["deck"]


def test_preserve_conflict_when_original_was_deleted(tmp_path):
    _, _, store = setup(tmp_path)
    local = SLIDE.format(color="#f00", body="<text>local</text>").encode()
    record = store.get_deck("talk")
    store.put_deck("talk", dict(record["deck"], slides=[{"id": "two"}]), record["version"])

    result = store.preserve_conflict("talk", "one", local)
    assert result["original"] is None and result["originalVersion"] is None
    assert store.get_slide("talk", result["recovered"])[0] == local
    with pytest.raises(KeyError):
        store.preserve_conflict("talk", "../outside", local)


def test_recovery_api_and_path_validation(tmp_path):
    data, _, store = setup(tmp_path)
    original, base = store.get_slide("talk", "one")
    changed = SLIDE.format(color="#abc", body="").encode()
    store.put_slide("talk", "one", changed, base)
    app = create_app(data)

    async def scenario():
        call = lambda *args: request(app, *args)
        status, payload = await call("GET", "/api/decks/talk/slides/one/revisions")
        assert status == 200
        revisions = json.loads(payload)
        status, payload = await call("GET", f"/api/decks/talk/slides/one/revisions/{revisions[0]['token']}")
        assert status == 200 and payload == original
        status, _ = await call("GET", "/api/decks/talk/slides/one/revisions/../deck.json")
        assert status == 404
    asyncio.run(scenario())


def test_invalid_svg_cannot_enter_recovery(tmp_path):
    _, _, store = setup(tmp_path)
    with pytest.raises(ValueError):
        store.preserve_conflict("talk", "one", b"not svg")


def test_recovery_ui_keeps_both_conflicting_versions(recovery_browser):
    page, data = recovery_browser
    sid = page.evaluate("svgdeckEditor.state.current")
    path = data / "decks" / "talk" / "slides" / f"{sid}.svg"
    path.write_text(path.read_text().replace("#ffffff", "#fefefe"))
    page.evaluate("""() => svgdeckEditor.editor.change(() => {
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x','10'); r.setAttribute('width','20'); r.setAttribute('height','20');
      svgdeckEditor.editor.svg.append(r);
    })""")
    page.wait_for_function("svgdeckEditor.state.slides.get(svgdeckEditor.state.current).conflict === true")
    page.evaluate("svgdeckEditor.recovery.open()")
    page.locator(".recovery-dialog button", has_text="Keep both versions").click()
    page.wait_for_function("svgdeckEditor.state.deck.slides.length === 2")

    store = Store(data)
    deck = store.get_deck("talk")["deck"]
    recovered = deck["slides"][-1]["id"]
    assert "#fefefe" in store.get_slide("talk", sid)[0].decode()
    assert "<rect" in store.get_slide("talk", recovered)[0].decode()
    assert page.evaluate("svgdeckEditor.state.current") == sid


def test_recovery_ui_restores_deleted_slide(recovery_browser):
    page, data = recovery_browser
    store = Store(data)
    record = store.get_deck("talk")
    original = record["deck"]["slides"][0]["id"]
    svg, _ = store.get_slide("talk", original)
    store.put_slide("talk", "deleted", svg.replace(b"#ffffff", b"#abcdef"), None)
    deck = dict(record["deck"], slides=record["deck"]["slides"] + [{"id": "deleted"}])
    added = store.put_deck("talk", deck, record["version"])
    store.put_deck("talk", dict(deck, slides=deck["slides"][:1]), added["version"])
    page.reload()
    page.wait_for_function("window.svgdeckEditor?.recovery")
    page.evaluate("svgdeckEditor.recovery.open()")
    page.locator(".recovery-dialog button", has_text="Restore").last.click()
    page.wait_for_function("svgdeckEditor.state.deck.slides.some(s => s.id === 'deleted')")

    restored = store.get_deck("talk")["deck"]["slides"][-1]
    assert restored == {"id": "deleted"}
    assert b"#abcdef" in store.get_slide("talk", "deleted")[0]
