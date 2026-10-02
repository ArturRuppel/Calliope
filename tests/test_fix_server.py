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
