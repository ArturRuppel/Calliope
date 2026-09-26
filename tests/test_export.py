import json
import re

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


def test_reference_outside_deck_is_rejected(tmp_path):
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body='<image href="../../secret.png"/>'))])
    with pytest.raises(ValueError):
        export(Deck.load(root), tmp_path / "out")


def test_refuses_to_replace_unrelated_directory(deck, tmp_path):
    target = tmp_path / "precious"
    target.mkdir()
    (target / "notes.txt").write_text("keep me")
    with pytest.raises(FileExistsError):
        export(Deck.load(deck), target)
