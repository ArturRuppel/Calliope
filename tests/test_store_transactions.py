import pytest

from conftest import SLIDE, write_deck
from svgdeck.store import Store
import svgdeck.store as store_module


def two_slide_store(tmp_path):
    data = tmp_path / "data"
    root = write_deck(
        data / "decks" / "talk",
        [
            ("first", SLIDE.format(color="#fff", body="")),
            ("second", SLIDE.format(color="#000", body="")),
        ],
    )
    store = Store(data)
    record = store.get_deck("talk")
    updated = dict(record["deck"], slides=[{"id": "first"}])
    return store, root, record, updated


def test_metadata_write_failure_preserves_referenced_slides(tmp_path, monkeypatch):
    store, root, record, updated = two_slide_store(tmp_path)

    def fail_write(*args):
        raise OSError("simulated disk full")

    monkeypatch.setattr(store_module, "write_atomic", fail_write)
    with pytest.raises(OSError, match="simulated disk full"):
        store.put_deck("talk", updated, record["version"])

    assert store.get_deck("talk")["deck"] == record["deck"]
    assert (root / "slides" / "second.svg").is_file()
    assert not (root / "trash").exists()


def test_trash_move_failure_keeps_committed_deck_usable(tmp_path, monkeypatch):
    store, root, record, updated = two_slide_store(tmp_path)

    def fail_move(*args):
        raise OSError("simulated trash failure")

    monkeypatch.setattr(store_module.shutil, "move", fail_move)
    result = store.put_deck("talk", updated, record["version"])

    saved = store.get_deck("talk")
    assert saved["deck"] == updated
    assert saved["version"] == result["version"]
    assert store.get_slide("talk", "first")[0]
    assert (root / "slides" / "second.svg").is_file()


def test_success_commits_metadata_and_moves_removed_slide_to_trash(tmp_path):
    store, root, record, updated = two_slide_store(tmp_path)

    result = store.put_deck("talk", updated, record["version"])

    saved = store.get_deck("talk")
    assert saved["deck"] == updated
    assert saved["version"] == result["version"]
    assert not (root / "slides" / "second.svg").exists()
    trashed = list((root / "trash").glob("second.*.svg"))
    assert len(trashed) == 1
    assert trashed[0].read_text() == SLIDE.format(color="#000", body="")
