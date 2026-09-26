import json
import re
import zipfile

import pytest

from svgdeck.deck import Deck
from svgdeck.export import export

from conftest import SLIDE, write_deck


def test_export_is_self_contained(deck, tmp_path):
    out = export(Deck.load(deck), tmp_path / "out", tmp_path / "out.zip")
    page = (out / "index.html").read_text()
    assert (out / "media" / "clock.webm").is_file()
    # Nothing is loaded from the network.
    assert not re.search(r'(src|href)\s*=\s*"https?:', page)
    data = json.loads(re.search(r'id="svgdeck-data">(.*?)</script>', page, re.S).group(1))
    assert [s["id"] for s in data["slides"]] == ["a", "b", "c"]
    assert (tmp_path / "out.zip").stat().st_size > 0


def test_script_end_tag_in_slide_is_escaped(tmp_path):
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body="<text>&lt;/script&gt;</text>")),
                                       ("b", SLIDE.format(color="#fff", body="<!-- </script> -->"))])
    page = (export(Deck.load(root), tmp_path / "out") / "index.html").read_text()
    payload = re.search(r'id="svgdeck-data">(.*?)</script>', page, re.S).group(1)
    assert json.loads(payload)["slides"][1]["svg"].count("</script>") == 1


def test_missing_media_is_an_error(tmp_path):
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body='<image href="../media/nope.png"/>'))])
    with pytest.raises(FileNotFoundError):
        export(Deck.load(root), tmp_path / "out")


def test_failed_reexport_preserves_previous_export(tmp_path):
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body=""))])
    out = export(Deck.load(root), tmp_path / "out")
    previous = (out / "index.html").read_text()
    (root / "slides" / "a.svg").write_text(
        SLIDE.format(color="#fff", body='<image href="../media/nope.png"/>')
    )
    with pytest.raises(FileNotFoundError):
        export(Deck.load(root), out)
    assert (out / "index.html").read_text() == previous


def test_reference_outside_deck_is_rejected(tmp_path):
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body='<image href="../../secret.png"/>'))])
    with pytest.raises(ValueError):
        export(Deck.load(root), tmp_path / "out")


def test_percent_encoded_absolute_reference_is_rejected(tmp_path):
    root = write_deck(tmp_path / "d", [
        ("a", SLIDE.format(color="#fff", body='<image href="%2Ftmp%2Fsecret.png"/>')),
    ])
    with pytest.raises(ValueError, match="not relative"):
        export(Deck.load(root), tmp_path / "out")


def test_refuses_to_replace_unrelated_directory(deck, tmp_path):
    target = tmp_path / "precious"
    target.mkdir()
    (target / "notes.txt").write_text("keep me")
    with pytest.raises(FileExistsError):
        export(Deck.load(deck), target)


def test_refuses_unrelated_directory_with_index(deck, tmp_path):
    target = tmp_path / "precious"
    target.mkdir()
    (target / "index.html").write_text("<h1>Not an SVGDeck export</h1>")
    with pytest.raises(FileExistsError):
        export(Deck.load(deck), target)
    assert (target / "index.html").read_text() == "<h1>Not an SVGDeck export</h1>"


def test_refuses_symlink_output_without_touching_target(deck, tmp_path):
    real = export(Deck.load(deck), tmp_path / "real")
    previous = (real / "index.html").read_bytes()
    alias = tmp_path / "alias"
    alias.symlink_to(real, target_is_directory=True)
    with pytest.raises(FileExistsError):
        export(Deck.load(deck), alias)
    assert alias.is_symlink()
    assert (real / "index.html").read_bytes() == previous


def test_single_quoted_and_xlink_media_are_exported(tmp_path):
    body = ("<image href='../media/one.svg'/>"
            "<image xmlns:xlink='http://www.w3.org/1999/xlink' xlink:href='../media/two.svg'/>")
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body=body))])
    for name in ("one.svg", "two.svg"):
        (root / "media" / name).write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
    out = export(Deck.load(root), tmp_path / "out")
    assert (out / "media" / "one.svg").is_file()
    assert (out / "media" / "two.svg").is_file()


def test_zip_failure_preserves_previous_outputs(deck, tmp_path, monkeypatch):
    out = export(Deck.load(deck), tmp_path / "out", tmp_path / "out.zip")
    previous_page = (out / "index.html").read_bytes()
    previous_zip = (tmp_path / "out.zip").read_bytes()

    def fail_write(*args, **kwargs):
        raise OSError("zip failed")

    monkeypatch.setattr(zipfile.ZipFile, "write", fail_write)
    with pytest.raises(OSError, match="zip failed"):
        export(Deck.load(deck), out, tmp_path / "out.zip")
    assert (out / "index.html").read_bytes() == previous_page
    assert (tmp_path / "out.zip").read_bytes() == previous_zip
    assert not list(tmp_path.glob(".*.tmp-*"))


@pytest.mark.parametrize("target", [lambda deck: deck / "export", lambda deck: deck.parent])
def test_refuses_export_that_overlaps_source(deck, target):
    with pytest.raises(ValueError, match="overlap"):
        export(Deck.load(deck), target(deck))


def test_refuses_symlink_alias_of_source(deck, tmp_path):
    alias = tmp_path / "deck-alias"
    alias.symlink_to(deck, target_is_directory=True)
    with pytest.raises(ValueError, match="overlap"):
        export(Deck.load(deck), alias)
    assert alias.is_symlink()
