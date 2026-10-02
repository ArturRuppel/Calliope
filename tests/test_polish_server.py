"""Deck rename, duplicate, restore-under-a-new-name, PDF download, deck metadata checks."""
import json
import sys
import types

import pytest
from starlette.testclient import TestClient

import svgdeck
from conftest import SLIDE, write_deck
from svgdeck.server import create_app
from svgdeck.store import Store

SUMMARY_KEYS = {"name", "title", "slides", "modified"}


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
    store = Store(data)
    # Edit once so the deck has a commit baseline, a revision and a deleted-slide trash.
    version = store.get_slide("talk", "one")[1]
    store.put_slide("talk", "one", SLIDE.format(color="#333333", body="").encode(), version)
    record = store.get_deck("talk")
    store.put_deck("talk", dict(record["deck"], slides=[{"id": "one"}, {"id": "two"}]), record["version"])
    return TestClient(create_app(data)), data, root, store


def has_history(root):
    return {sub: (root / sub).is_dir() and any((root / sub).iterdir()) for sub in ("commits", "revisions", "trash")}


# --- rename ---------------------------------------------------------------------

def test_rename_moves_the_whole_deck_and_returns_a_summary(api):
    client, data, root, store = api
    commits = store.list_commits("talk")
    assert commits and has_history(root)["revisions"]
    response = client.post("/api/decks/talk/rename", json={"name": "renamed"})
    assert response.status_code == 200, response.text
    summary = response.json()
    assert set(summary) == SUMMARY_KEYS and summary["name"] == "renamed" and summary["slides"] == 2
    assert summary == next(d for d in client.get("/api/decks").json() if d["name"] == "renamed")
    assert not root.exists()
    new_root = data / "decks" / "renamed"
    assert (new_root / "media" / "clip.txt").read_text() == "media"
    assert (new_root / "fonts" / "f.ttf").read_text() == "font"
    assert has_history(new_root)["revisions"] and has_history(new_root)["commits"]
    assert store.list_commits("renamed") == commits
    assert client.get("/api/decks/talk").status_code == 404
    assert client.get("/api/decks/renamed").status_code == 200
    # The renamed deck keeps working: edits and a restore of its first commit.
    slide, version = store.get_slide("renamed", "one")
    assert store.list_revisions("renamed", "one")
    store.put_slide("renamed", "one", slide.replace(b"#333333", b"#444444"), version)


@pytest.mark.parametrize("name", ["", "../x", ".hidden", "a b", "x" * 101, "a/b"])
def test_rename_rejects_invalid_names(api, name):
    client, data, _, _ = api
    assert client.post("/api/decks/talk/rename", json={"name": name}).status_code == 400
    assert (data / "decks" / "talk").is_dir()


@pytest.mark.parametrize("body", [{}, {"name": 5}, {"name": None}, [], "nope"])
def test_rename_rejects_bad_bodies(api, body):
    client, _, _, _ = api
    assert client.post("/api/decks/talk/rename", json=body).status_code == 400
    assert client.post("/api/decks/talk/rename", content=b"{oops").status_code == 400
    assert client.post("/api/decks/talk/rename").status_code == 400


def test_rename_missing_deck_is_404(api):
    client, _, _, _ = api
    assert client.post("/api/decks/nothing/rename", json={"name": "other"}).status_code == 404
    assert client.post("/api/decks/nothing/rename", json={"name": "bad name"}).status_code == 404


def test_rename_onto_an_existing_deck_or_itself_is_409(api):
    client, data, _, store = api
    store.create_deck("other", "Other")
    assert client.post("/api/decks/talk/rename", json={"name": "other"}).status_code == 409
    assert client.post("/api/decks/talk/rename", json={"name": "talk"}).status_code == 409
    assert store.get_deck("other")["deck"]["title"] == "Other"
    assert (data / "decks" / "talk" / "deck.json").is_file()


def test_rename_to_a_name_that_only_exists_in_the_trash_is_allowed(api):
    client, _, _, store = api
    store.create_deck("old", "Old")
    token = store.delete_deck("old")["token"]
    assert client.post("/api/decks/talk/rename", json={"name": "old"}).status_code == 200
    # The trashed deck can still be restored, under another name.
    assert client.post(f"/api/trash/{token}/restore").status_code == 409
    assert client.post(f"/api/trash/{token}/restore", json={"name": "old2"}).status_code == 200


# --- duplicate --------------------------------------------------------------------

def test_duplicate_copies_content_but_not_history(api):
    client, data, root, store = api
    response = client.post("/api/decks/talk/duplicate")
    assert response.status_code == 201, response.text
    summary = response.json()
    assert set(summary) == SUMMARY_KEYS and summary["name"] == "talk-copy"
    assert summary["title"] == "Test deck (copy)" and summary["slides"] == 2
    copy = data / "decks" / "talk-copy"
    assert json.loads((copy / "deck.json").read_text())["title"] == "Test deck (copy)"
    for sid in ("one", "two"):
        assert (copy / "slides" / f"{sid}.svg").read_bytes() == (root / "slides" / f"{sid}.svg").read_bytes()
    assert (copy / "media" / "clip.txt").read_text() == "media"
    assert (copy / "fonts" / "f.ttf").read_text() == "font"
    assert not any(has_history(copy).values())
    assert not (copy / "revisions").exists() and not (copy / "trash").exists() and not (copy / "commits").exists()
    assert store.list_commits("talk-copy") == []
    # The original is untouched, and the copy starts a fresh baseline on its first edit.
    assert has_history(root)["commits"]
    slide, version = store.get_slide("talk-copy", "one")
    store.put_slide("talk-copy", "one", slide.replace(b"#333333", b"#555555"), version)
    assert [c["message"] for c in store.list_commits("talk-copy")] == ["Baseline before editing"]
    assert [d["name"] for d in client.get("/api/decks").json()].count("talk-copy") == 1


def test_duplicate_picks_the_first_free_name(api):
    client, _, _, _ = api
    names = [client.post("/api/decks/talk/duplicate").json()["name"] for _ in range(3)]
    assert names == ["talk-copy", "talk-copy2", "talk-copy3"]
    assert client.post("/api/decks/talk-copy/duplicate").json()["name"] == "talk-copy-copy"
    # The title of a copy of a copy stacks.
    assert client.get("/api/decks/talk-copy-copy").json()["deck"]["title"] == "Test deck (copy) (copy)"


def test_duplicate_default_name_fits_the_name_limit(api):
    client, _, _, store = api
    long = "d" * 100
    store.create_deck(long, "Long")
    response = client.post(f"/api/decks/{long}/duplicate")
    assert response.status_code == 201 and len(response.json()["name"]) <= 100


def test_duplicate_with_a_given_name(api):
    client, _, _, _ = api
    response = client.post("/api/decks/talk/duplicate", json={"name": "draft"})
    assert response.status_code == 201 and response.json()["name"] == "draft"
    assert client.post("/api/decks/talk/duplicate", json={"name": "draft"}).status_code == 409
    assert client.post("/api/decks/talk/duplicate", json={"name": "talk"}).status_code == 409
    assert client.post("/api/decks/talk/duplicate", json={"name": "no good"}).status_code == 400
    assert client.post("/api/decks/talk/duplicate", json={"name": 3}).status_code == 400
    assert client.post("/api/decks/talk/duplicate", content=b"{oops").status_code == 400
    assert client.post("/api/decks/nothing/duplicate").status_code == 404


def test_duplicate_leaves_no_staging_directories(api):
    client, data, _, _ = api
    client.post("/api/decks/talk/duplicate")
    client.post("/api/decks/talk/duplicate", json={"name": "bad name"})
    client.post("/api/decks/talk/duplicate", json={"name": "talk"})
    assert [p.name for p in data.iterdir() if p.name.startswith(".")] == []


# --- restore under a new name ---------------------------------------------------------

def test_restore_under_a_new_name_when_the_original_is_taken(api):
    client, data, _, store = api
    token = client.delete("/api/decks/talk").json()["token"]
    store.create_deck("talk", "New talk")
    assert client.post(f"/api/trash/{token}/restore").status_code == 409
    assert client.post(f"/api/trash/{token}/restore", json={"name": "talk"}).status_code == 409
    assert client.post(f"/api/trash/{token}/restore", json={"name": "not ok"}).status_code == 400
    assert client.post(f"/api/trash/{token}/restore", json={"name": 4}).status_code == 400
    assert client.post(f"/api/trash/{token}/restore", content=b"[1]").status_code == 400
    response = client.post(f"/api/trash/{token}/restore", json={"name": "talk-old"})
    assert response.status_code == 200
    assert response.json()["name"] == "talk-old" and response.json()["deck"]["title"] == "Test deck"
    assert (data / "decks" / "talk-old" / "media" / "clip.txt").read_text() == "media"
    assert store.get_deck("talk")["deck"]["title"] == "New talk"
    assert store.list_deleted_decks() == []
    assert client.post(f"/api/trash/{token}/restore", json={"name": "again"}).status_code == 404


def test_restore_without_a_body_or_with_a_null_name_keeps_the_old_name(api):
    client, _, _, _ = api
    token = client.delete("/api/decks/talk").json()["token"]
    assert client.post(f"/api/trash/{token}/restore", json={"name": None}).json()["name"] == "talk"
    token = client.delete("/api/decks/talk").json()["token"]
    assert client.post(f"/api/trash/{token}/restore", json={}).json()["name"] == "talk"
    token = client.delete("/api/decks/talk").json()["token"]
    assert client.post(f"/api/trash/{token}/restore").json()["name"] == "talk"


# --- PDF ----------------------------------------------------------------------------------

@pytest.fixture
def stub_pdf(monkeypatch):
    calls = []
    stub = types.ModuleType("svgdeck.pdf")

    def render_pdf(deck_dir, out_path, notes=False, steps=False):
        calls.append({"dir": deck_dir, "out": out_path, "notes": notes, "steps": steps,
                      "slides": sorted(p.name for p in (deck_dir / "slides").glob("*.svg")),
                      "media": (deck_dir / "media" / "clip.txt").read_text()})
        out_path.write_bytes(b"%PDF-1.4 stub")

    stub.render_pdf = render_pdf
    monkeypatch.setitem(sys.modules, "svgdeck.pdf", stub)
    monkeypatch.setattr(svgdeck, "pdf", stub, raising=False)
    return calls


def test_pdf_download(api, stub_pdf):
    client, data, _, _ = api
    response = client.get("/api/decks/talk/pdf")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"] == 'attachment; filename="talk.pdf"'
    assert response.content == b"%PDF-1.4 stub"
    [call] = stub_pdf
    assert call["notes"] is False and call["steps"] is False
    assert call["slides"] == ["one.svg", "two.svg"] and call["media"] == "media"
    assert call["dir"] != data / "decks" / "talk"  # a snapshot, not the live deck
    assert [p.name for p in data.iterdir() if p.name.startswith("svgdeck-pdf-")] == []


@pytest.mark.parametrize("query,notes,steps", [
    ("notes=1", True, False), ("steps=true", False, True), ("notes=true&steps=1", True, True),
    ("notes=0&steps=false", False, False), ("notes=", False, False)])
def test_pdf_options(api, stub_pdf, query, notes, steps):
    client, _, _, _ = api
    assert client.get(f"/api/decks/talk/pdf?{query}").status_code == 200
    assert (stub_pdf[0]["notes"], stub_pdf[0]["steps"]) == (notes, steps)


def test_pdf_missing_deck_and_broken_deck(api, stub_pdf):
    client, _, root, _ = api
    assert client.get("/api/decks/nothing/pdf").status_code == 404
    (root / "slides" / "two.svg").unlink()
    response = client.get("/api/decks/talk/pdf")
    assert response.status_code == 404 and "two" in response.json()["detail"]
    assert stub_pdf == []


def test_pdf_without_playwright_is_501_and_cleans_up(api, monkeypatch):
    client, data, _, _ = api
    stub = types.ModuleType("svgdeck.pdf")

    def render_pdf(*args, **kwargs):
        raise RuntimeError("PDF export needs Playwright: pip install playwright")

    stub.render_pdf = render_pdf
    monkeypatch.setitem(sys.modules, "svgdeck.pdf", stub)
    monkeypatch.setattr(svgdeck, "pdf", stub, raising=False)
    response = client.get("/api/decks/talk/pdf")
    assert response.status_code == 501
    assert response.json() == {"detail": "PDF export needs Playwright: pip install playwright"}
    assert [p.name for p in data.iterdir() if p.name.startswith("svgdeck-pdf-")] == []


def test_pdf_module_missing_is_501(api, monkeypatch):
    client, _, _, _ = api
    monkeypatch.setitem(sys.modules, "svgdeck.pdf", None)  # makes the import fail
    monkeypatch.delattr(svgdeck, "pdf", raising=False)
    response = client.get("/api/decks/talk/pdf")
    assert response.status_code == 501 and response.json()["detail"]


def test_pdf_render_failure_is_a_500_and_cleans_up(api, monkeypatch):
    client, data, _, _ = api
    stub = types.ModuleType("svgdeck.pdf")

    def render_pdf(*args, **kwargs):
        raise ValueError("boom")

    stub.render_pdf = render_pdf
    monkeypatch.setitem(sys.modules, "svgdeck.pdf", stub)
    response = client.get("/api/decks/talk/pdf")
    assert response.status_code == 500 and "boom" in response.json()["detail"]
    assert [p.name for p in data.iterdir() if p.name.startswith("svgdeck-pdf-")] == []


# --- PUT /api/decks/{name}: title, size, background ---------------------------------------------

def put(client, store, **fields):
    record = store.get_deck("talk")
    return client.put("/api/decks/talk", json={"deck": dict(record["deck"], **fields), "base": record["version"]})


def test_put_deck_changes_title_size_and_background(api):
    client, _, _, store = api
    response = put(client, store, title="Renamed title", size=[1280, 720], background="rgb(10, 20, 30)")
    assert response.status_code == 200, response.text
    saved = store.get_deck("talk")["deck"]
    assert (saved["title"], saved["size"], saved["background"]) == ("Renamed title", [1280, 720], "rgb(10, 20, 30)")
    assert put(client, store, title="x" * 200, size=[16, 16384], background="#abc").status_code == 200
    assert client.get("/api/decks").json()[0]["title"] == "x" * 200


@pytest.mark.parametrize("fields", [
    {"title": "x" * 201}, {"title": 5}, {"title": None}, {"title": ["a"]},
    {"size": [1920]}, {"size": [1920, 1080, 3]}, {"size": [15, 1080]}, {"size": [1920, 16385]},
    {"size": [1920.5, 1080]}, {"size": ["1920", "1080"]}, {"size": [True, 1080]}, {"size": "1920x1080"},
    {"size": {"w": 1920, "h": 1080}}, {"size": None},
    {"background": "x" * 65}, {"background": "red<script>"}, {"background": "red\nblue"},
    {"background": 0}, {"background": ""}, {"background": None},
])
def test_put_deck_rejects_bad_fields(api, fields):
    client, _, _, store = api
    before = store.get_deck("talk")
    response = put(client, store, **fields)
    assert response.status_code == 400, response.text
    assert store.get_deck("talk") == before


def test_put_deck_keeps_its_existing_checks(api):
    client, _, _, store = api
    record = store.get_deck("talk")
    assert put(client, store, format=2).status_code == 400
    assert put(client, store, slides=[]).status_code == 400
    assert put(client, store, slides=[{"id": "nope"}]).status_code == 400
    assert client.put("/api/decks/talk", json={"deck": record["deck"], "base": "stale"}).status_code == 409
    assert client.put("/api/decks/nothing", json={"deck": record["deck"], "base": "x"}).status_code == 404


# --- concurrency and the event loop ---------------------------------------------------------

def test_concurrent_renames_to_one_name_have_one_winner(tmp_path):
    import threading
    store = Store(tmp_path)
    for name in ("a", "b", "c", "d"):
        store.create_deck(name, name)
    results = []

    def rename(name):
        try:
            store.rename_deck(name, "target")
            results.append("ok")
        except FileExistsError:
            results.append("exists")

    threads = [threading.Thread(target=rename, args=(n,)) for n in ("a", "b", "c", "d")]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == ["exists", "exists", "exists", "ok"]
    assert len(store.list_decks()) == 4  # nothing was lost or overwritten


def test_concurrent_duplicates_get_distinct_names(tmp_path):
    import threading
    store = Store(tmp_path)
    store.create_deck("talk", "Talk")
    names = []
    threads = [threading.Thread(target=lambda: names.append(store.duplicate_deck("talk")["name"])) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(names) == sorted({"talk-copy", *(f"talk-copy{i}" for i in range(2, 7))})


@pytest.mark.parametrize("method_name,verb,path,kwargs", [
    ("rename_deck", "POST", "/api/decks/talk/rename", {"json": {"name": "moved"}}),
    ("duplicate_deck", "POST", "/api/decks/talk/duplicate", {}),
])
def test_rename_and_duplicate_run_off_the_event_loop(api, monkeypatch, method_name, verb, path, kwargs):
    import asyncio
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
    assert client.request(verb, path, **kwargs).status_code in (200, 201)
    assert on_loop == [False]
