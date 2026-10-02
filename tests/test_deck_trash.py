"""Deleting a deck moves it to <data>/trash/, from where it can be restored."""
import os
import socket
import threading
import time

import pytest
import uvicorn

from svgdeck.server import create_app
from svgdeck.store import Store


def test_delete_and_restore_keep_everything(tmp_path):
    store = Store(tmp_path)
    store.create_deck("talk", "A talk")
    (tmp_path / "decks" / "talk" / "media" / "clip.txt").write_text("kept")
    gone = store.delete_deck("talk")
    assert gone["title"] == "A talk"
    assert not (tmp_path / "decks" / "talk").exists()
    assert [d["name"] for d in store.list_decks()] == []
    [entry] = store.list_deleted_decks()
    assert entry["token"] == gone["token"] and entry["name"] == "talk" and entry["title"] == "A talk"
    store.restore_deck(gone["token"])
    assert (tmp_path / "decks" / "talk" / "media" / "clip.txt").read_text() == "kept"
    assert store.list_deleted_decks() == []


def test_restore_refuses_to_overwrite_a_deck_of_the_same_name(tmp_path):
    store = Store(tmp_path)
    store.create_deck("talk", "Old")
    token = store.delete_deck("talk")["token"]
    store.create_deck("talk", "New")
    with pytest.raises(FileExistsError):
        store.restore_deck(token)
    assert store.get_deck("talk")["deck"]["title"] == "New"
    assert len(store.list_deleted_decks()) == 1


@pytest.mark.parametrize("token", ["../decks/talk", "talk", "talk.20260927T120000-zzzzzz", "x.20260927T120000-abcdef"])
def test_restore_rejects_unknown_tokens(tmp_path, token):
    with pytest.raises(KeyError):
        Store(tmp_path).restore_deck(token)


def test_decks_page_delete_needs_two_taps_and_restores(tmp_path):
    playwright = pytest.importorskip("playwright.sync_api")
    Store(tmp_path).create_deck("talk", "A talk")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(tmp_path), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    while not srv.started:
        time.sleep(0.02)
    try:
        with playwright.sync_playwright() as p:
            browser = getattr(p, os.environ.get("SVGDECK_BROWSER", "chromium")).launch()
            page = browser.new_page()
            page.goto(f"http://127.0.0.1:{port}/")
            delete = page.locator("#decks [data-delete='talk']")
            delete.click()
            assert delete.text_content() == "Tap again to delete"
            page.locator("header h1").click()  # tapping elsewhere disarms
            assert delete.text_content() == "Delete"
            delete.click()
            delete.click()
            page.wait_for_selector("#deleted [data-restore]")
            assert page.locator("#decks").text_content().strip() == "No decks yet."
            page.locator("#deleted [data-restore]").click()
            page.wait_for_selector("#decks [data-delete='talk']")
            assert page.locator("#deleted").inner_html() == ""
            browser.close()
    finally:
        srv.should_exit = True
        thread.join(5)
