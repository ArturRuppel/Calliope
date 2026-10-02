"""Regression tests for player, speaker and export fixes."""
import json
import os
import re
import stat
import zipfile
from pathlib import Path

import pytest

from conftest import SLIDE, write_deck
from svgdeck.cli import main
from svgdeck.deck import Deck
from svgdeck.export import export


# --- export ---------------------------------------------------------------
def test_export_modes_follow_the_umask(tmp_path):
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body=""))])
    old = os.umask(0o022)
    try:
        out = export(Deck.load(root), tmp_path / "out", tmp_path / "out.zip")
    finally:
        os.umask(old)
    assert stat.S_IMODE(out.stat().st_mode) == 0o755
    assert stat.S_IMODE((out / "index.html").stat().st_mode) == 0o644
    assert stat.S_IMODE((tmp_path / "out.zip").stat().st_mode) == 0o644


def test_export_modes_with_a_private_umask(tmp_path):
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body=""))])
    old = os.umask(0o077)
    try:
        out = export(Deck.load(root), tmp_path / "out", tmp_path / "out.zip")
    finally:
        os.umask(old)
    assert stat.S_IMODE(out.stat().st_mode) == 0o700
    assert stat.S_IMODE((tmp_path / "out.zip").stat().st_mode) == 0o600


def notes_deck(tmp_path):
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body=""))])
    meta = json.loads((root / "deck.json").read_text())
    meta["slides"][0]["notes"] = "SECRET-TALKING-POINT"
    (root / "deck.json").write_text(json.dumps(meta))
    return root


def test_notes_are_included_by_default(tmp_path):
    out = export(Deck.load(notes_deck(tmp_path)), tmp_path / "out")
    assert "SECRET-TALKING-POINT" in (out / "index.html").read_text(encoding="utf-8")


def test_notes_can_be_left_out(tmp_path):
    out = export(Deck.load(notes_deck(tmp_path)), tmp_path / "out", include_notes=False)
    page = (out / "index.html").read_text(encoding="utf-8")
    assert "SECRET-TALKING-POINT" not in page
    data = json.loads(re.search(r'id="svgdeck-data">(.*?)</script>', page, re.S).group(1))
    assert all("notes" not in s for s in data["slides"])


def test_cli_no_notes_flag(tmp_path):
    root = notes_deck(tmp_path)
    main(["export", str(root), str(tmp_path / "a")])
    main(["export", str(root), str(tmp_path / "b"), "--no-notes"])
    assert "SECRET-TALKING-POINT" in (tmp_path / "a" / "index.html").read_text(encoding="utf-8")
    assert "SECRET-TALKING-POINT" not in (tmp_path / "b" / "index.html").read_text(encoding="utf-8")


def test_hyperlinks_are_not_media(tmp_path):
    body = ('<a href="other.html"><rect width="10" height="10"/></a>'
            '<a xlink:href="notes/x.pdf" xmlns:xlink="http://www.w3.org/1999/xlink"/>')
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body=body))])
    assert Deck.load(root).media_files() == set()
    export(Deck.load(root), tmp_path / "out")


def test_media_references_still_found_next_to_links(tmp_path):
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(
        color="#fff", body='<a href="x.html"/><image href="../media/p.png"/>'))])
    assert Deck.load(root).media_files() == {"media/p.png"}


def test_missing_slide_file_names_the_slide(tmp_path):
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body=""))])
    (root / "slides" / "a.svg").unlink()
    with pytest.raises(FileNotFoundError, match="slide 'a'"):
        export(Deck.load(root), tmp_path / "out")


def test_zip_stores_already_compressed_media(tmp_path):
    suffixes = (".webm", ".MOV", ".webp", ".avif", ".gif")
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(
        color="#fff", body="".join(f'<image href="../media/p{s}"/>' for s in suffixes)))])
    for s in suffixes:
        (root / "media" / f"p{s}").write_bytes(b"0" * 5000)
    export(Deck.load(root), tmp_path / "out", tmp_path / "out.zip")
    with zipfile.ZipFile(tmp_path / "out.zip") as z:
        kinds = {i.compress_type for i in z.infolist() if "media/" in i.filename}
        assert kinds == {zipfile.ZIP_STORED}
        assert z.getinfo("out/index.html").compress_type == zipfile.ZIP_DEFLATED


def test_export_is_utf8_whatever_the_locale(tmp_path, monkeypatch):
    import locale
    body = "<text>café →</text>"
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body=body))])
    (root / "slides" / "a.svg").write_text(SLIDE.format(color="#fff", body=body), encoding="utf-8")
    monkeypatch.setattr(locale, "getpreferredencoding", lambda *a, **k: "ascii")
    out = export(Deck.load(root), tmp_path / "out")
    assert "café →" in (out / "index.html").read_text(encoding="utf-8")
