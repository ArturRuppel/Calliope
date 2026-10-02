import json
import socket
import threading
import time
import urllib.error
import urllib.request

import pytest
import uvicorn

from conftest import SLIDE, write_deck
from svgdeck.server import create_app
from svgdeck.store import Conflict, Store
import svgdeck.store as store_module


def setup(tmp_path):
    data = tmp_path / "data"
    root = write_deck(data / "decks" / "talk", [
        ("one", SLIDE.format(color="#111111", body="<text>one</text>")),
        ("two", SLIDE.format(color="#222222", body="<text>two</text>")),
    ])
    (root / "media" / "large.mp4").write_bytes(b"media stays in place")
    return data, root, Store(data)


def versions(store):
    record = store.get_deck("talk")
    return record["version"], {s["id"]: store.get_slide("talk", s["id"])[1]
                               for s in record["deck"]["slides"]}


def test_explicit_commit_deduplicates_objects_and_never_copies_media(tmp_path):
    _, root, store = setup(tmp_path)
    deck_ver, slide_vers = versions(store)
    first = store.create_commit("talk", "Initial", deck_ver, slide_vers)
    second = store.create_commit("talk", "Same content, new milestone", deck_ver, slide_vers)

    assert second["parent"] == first["id"]
    assert len(list((root / "commits" / "objects").iterdir())) == 3
    assert not list((root / "commits").rglob("*.mp4"))
    assert (root / "media" / "large.mp4").read_bytes() == b"media stays in place"
    assert [item["message"] for item in store.list_commits("talk")] == ["Same content, new milestone", "Initial"]


def test_first_working_change_preserves_preexisting_baseline_including_metadata_delete(tmp_path):
    _, _, store = setup(tmp_path)
    original = store.get_deck("talk")
    changed = dict(original["deck"], title="Changed", slides=[original["deck"]["slides"][0]])
    store.put_deck("talk", changed, original["version"])

    commits = store.list_commits("talk")
    assert len(commits) == 1 and commits[0]["parent"] is None
    manifest = store._read_manifest("talk", commits[0]["id"])
    saved_meta = json.loads(store._object("talk", manifest["deck"]))
    assert saved_meta["title"] == "Test deck"
    assert [slide["id"] for slide in saved_meta["slides"]] == ["one", "two"]
    assert b"#222222" in store._object("talk", manifest["slides"]["two"])


def test_commit_requires_complete_exact_cas_and_message(tmp_path):
    _, _, store = setup(tmp_path)
    deck_ver, slide_vers = versions(store)
    with pytest.raises(Conflict):
        store.create_commit("talk", "Partial", deck_ver, {"one": slide_vers["one"]})
    with pytest.raises(Conflict):
        store.create_commit("talk", "Stale", "old", slide_vers)
    with pytest.raises(ValueError, match="message"):
        store.create_commit("talk", " ", deck_ver, slide_vers)
    assert store.list_commits("talk") == []


def test_diff_against_parent_and_working_reports_metadata_svg_add_delete(tmp_path):
    _, _, store = setup(tmp_path)
    deck_ver, slide_vers = versions(store)
    first = store.create_commit("talk", "Initial", deck_ver, slide_vers)
    original = store.get_deck("talk")
    extra = SLIDE.format(color="#abcdef", body="<text>three</text>").encode()
    extra_ver = store.put_slide("talk", "three", extra, None)
    changed = dict(original["deck"], title="New title",
                   slides=[original["deck"]["slides"][1], {"id": "three"}])
    updated = store.put_deck("talk", changed, original["version"])
    second = store.create_commit("talk", "Rework", updated["version"],
                                 {"two": slide_vers["two"], "three": extra_ver})

    diff = store.diff_commit("talk", second["id"], "parent")
    assert "a/deck.json" in diff and "New title" in diff
    assert "--- a/slides/one.svg" in diff and "+++ /dev/null" in diff
    assert "--- /dev/null" in diff and "+++ b/slides/three.svg" in diff
    assert store.diff_commit("talk", second["id"], "working") == ""
    assert first["id"] != second["id"]


def test_restore_full_deck_and_keeps_commits_and_safety_snapshot(tmp_path):
    _, root, store = setup(tmp_path)
    deck_ver, slide_vers = versions(store)
    original = store.create_commit("talk", "Original", deck_ver, slide_vers)
    changed_svg = SLIDE.format(color="#fefefe", body="changed").encode()
    changed_one = store.put_slide("talk", "one", changed_svg, slide_vers["one"])
    record = store.get_deck("talk")
    changed_meta = dict(record["deck"], title="Working")
    changed_deck = store.put_deck("talk", changed_meta, record["version"])

    result = store.restore_commit("talk", original["id"], changed_deck["version"],
                                  {"one": changed_one, "two": slide_vers["two"]})
    assert result["deck"]["title"] == "Test deck"
    assert b"#111111" in store.get_slide("talk", "one")[0]
    assert len(store.list_commits("talk")) == 2
    safety = store._read_manifest("talk", result["safetyCommit"])
    assert json.loads(store._object("talk", safety["deck"]))["title"] == "Working"
    assert b"#fefefe" in store._object("talk", safety["slides"]["one"])
    assert (root / "media" / "large.mp4").exists()


def test_restore_failure_rolls_back_every_working_file(tmp_path, monkeypatch):
    _, root, store = setup(tmp_path)
    deck_ver, slide_vers = versions(store)
    original = store.create_commit("talk", "Original", deck_ver, slide_vers)
    changed = store.put_slide("talk", "one", SLIDE.format(color="#999999", body="").encode(), slide_vers["one"])
    before_meta = (root / "deck.json").read_bytes()
    before_slides = {path.name: path.read_bytes() for path in (root / "slides").glob("*.svg")}
    real_write = store_module.write_atomic
    failed = False

    def fail_second_slide(path, data):
        nonlocal failed
        if path.name == "two.svg" and path.parent.name == "slides" and not failed:
            failed = True
            raise OSError("disk full")
        return real_write(path, data)

    monkeypatch.setattr(store_module, "write_atomic", fail_second_slide)
    with pytest.raises(OSError, match="disk full"):
        store.restore_commit("talk", original["id"], deck_ver,
                             {"one": changed, "two": slide_vers["two"]})
    assert (root / "deck.json").read_bytes() == before_meta
    assert {path.name: path.read_bytes() for path in (root / "slides").glob("*.svg")} == before_slides


def test_commit_api_list_diff_restore_and_errors(tmp_path):
    data, _, store = setup(tmp_path)
    deck_ver, slide_vers = versions(store)
    app = create_app(data)

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 5
    while not server.started and time.monotonic() < deadline:
        time.sleep(.01)
    assert server.started

    def call(method, path, body=None):
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=body, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    try:
        body = json.dumps({"message": "API commit", "expectedDeck": deck_ver,
                           "expectedSlides": slide_vers}).encode()
        status, payload = call("POST", "/api/decks/talk/commits", body)
        assert status == 200
        commit = json.loads(payload)["id"]
        status, payload = call("GET", "/api/decks/talk/commits")
        assert status == 200 and json.loads(payload)[0]["id"] == commit
        status, payload = call("GET", f"/api/decks/talk/commits/{commit}/diff?target=parent")
        assert status == 200 and b"deck.json" in payload
        stale = json.dumps({"expectedDeck": "stale", "expectedSlides": slide_vers}).encode()
        status, _ = call("POST", f"/api/decks/talk/commits/{commit}/restore", stale)
        assert status == 409
        status, _ = call("GET", "/api/decks/talk/commits/not-valid/diff")
        assert status == 404
    finally:
        server.should_exit = True
        thread.join(timeout=5)


def test_font_library_filename_collision_never_overwrites_committed_asset(tmp_path, monkeypatch):
    data, root, store = setup(tmp_path)
    library = data / "fonts" / "uploaded" / "family.ttf"
    library.parent.mkdir(parents=True)
    library.write_bytes(b"old font bytes")
    monkeypatch.setattr(store, "font_faces", lambda: [{
        "family": "Family", "weight": 400, "style": "normal", "path": "uploaded/family.ttf",
    }])

    first = store.use_family("talk", "Family")
    original_path = root / first["deck"]["fonts"][0]["file"]
    assert original_path.read_bytes() == b"old font bytes"
    deck_ver, slide_vers = versions(store)
    commit = store.create_commit("talk", "Old font", deck_ver, slide_vers)

    library.write_bytes(b"new font bytes")
    # Simulate metadata restored to before the family was added while the old
    # committed asset remains in the deck's fonts directory.
    record = store.get_deck("talk")
    without_font = dict(record["deck"], fonts=[])
    store.put_deck("talk", without_font, record["version"])
    second = store.use_family("talk", "Family")

    new_rel = second["deck"]["fonts"][0]["file"]
    assert new_rel != "fonts/family.ttf"
    assert (root / new_rel).read_bytes() == b"new font bytes"
    assert original_path.read_bytes() == b"old font bytes"
    manifest = store._read_manifest("talk", commit["id"])
    committed = json.loads(store._object("talk", manifest["deck"]))
    assert committed["fonts"][0]["file"] == "fonts/family.ttf"


def test_head_file_is_kept_current_and_a_slide_save_does_not_scan_manifests(tmp_path, monkeypatch):
    _, root, store = setup(tmp_path)
    deck_ver, slide_vers = versions(store)
    head_file = root / "commits" / "HEAD"

    first = store.create_commit("talk", "Initial", deck_ver, slide_vers)
    assert head_file.read_text(encoding="utf-8").strip() == first["id"]
    second = store.create_commit("talk", "Again", deck_ver, slide_vers)
    assert head_file.read_text(encoding="utf-8").strip() == second["id"]

    changed = store.put_slide("talk", "one", SLIDE.format(color="#999999", body="").encode(), slide_vers["one"])
    result = store.restore_commit("talk", first["id"], deck_ver, {"one": changed, "two": slide_vers["two"]})
    # The restore adds a safety snapshot, which is the new head.
    assert head_file.read_text(encoding="utf-8").strip() == result["safetyCommit"]
    assert store._head_commit("talk") == result["safetyCommit"]

    def no_scan(self, name):
        raise AssertionError("manifests were scanned although HEAD is valid")

    monkeypatch.setattr(Store, "_scan_head_commit", no_scan)
    store.put_slide("talk", "two", SLIDE.format(color="#777777", body="").encode(), slide_vers["two"])


def test_deleted_or_stale_head_is_recovered_by_scanning(tmp_path):
    _, root, store = setup(tmp_path)
    deck_ver, slide_vers = versions(store)
    store.create_commit("talk", "Initial", deck_ver, slide_vers)
    newest = store.create_commit("talk", "Newest", deck_ver, slide_vers)
    head_file = root / "commits" / "HEAD"

    head_file.unlink()
    assert store._head_commit("talk") == newest["id"]
    assert head_file.read_text(encoding="utf-8").strip() == newest["id"]

    head_file.write_text("0" * 20 + "\n", encoding="utf-8")  # names a manifest that does not exist
    assert store._head_commit("talk") == newest["id"]
    assert head_file.read_text(encoding="utf-8").strip() == newest["id"]

    head_file.write_text("garbage", encoding="utf-8")
    assert store._head_commit("talk") == newest["id"]
    # The next commit chains onto the real head even when HEAD was lost.
    head_file.unlink()
    third = store.create_commit("talk", "Third", deck_ver, slide_vers)
    assert third["parent"] == newest["id"]


def test_restore_rejects_a_commit_with_an_unsupported_deck_format(tmp_path):
    _, root, store = setup(tmp_path)
    deck_ver, slide_vers = versions(store)
    commit = store.create_commit("talk", "Initial", deck_ver, slide_vers)
    # Build a second, well-formed commit whose deck.json has another format.
    manifest = store._read_manifest("talk", commit["id"])
    meta = json.loads(store._object("talk", manifest["deck"]))
    meta["format"] = 2
    bad_deck = store._put_object(root / "commits", json.dumps(meta).encode())
    body = {"parent": commit["id"], "message": "Future", "createdNs": manifest["createdNs"] + 1,
            "deck": bad_deck, "slides": manifest["slides"]}
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    bad_id = store._sha256(encoded)[:20]
    store_module.write_atomic(root / "commits" / "manifests" / f"{bad_id}.json",
                              json.dumps({"id": bad_id, **body}).encode())

    before = (root / "deck.json").read_bytes()
    with pytest.raises(ValueError, match="format"):
        store.restore_commit("talk", bad_id, deck_ver, slide_vers)
    assert (root / "deck.json").read_bytes() == before
    assert len(store.list_commits("talk")) == 2  # no safety snapshot for a rejected restore
