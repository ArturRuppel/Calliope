"""deck.json font entries: validated on save and import, escaped in the presenter."""
import io
import json
import zipfile

import pytest

from svgdeck.browser import BrowserStore, import_deck
from svgdeck.deck import Deck, font_faces, font_problem, render_page
from svgdeck.export import export
from svgdeck.store import Store

GOOD = {"family": "Archivo Narrow", "weight": 700, "style": "italic", "file": "fonts/Archivo-Bold-0a1b2c.otf"}
SLIDE = ('<?xml version="1.0" encoding="utf-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
         '<text>x</text></svg>\n')


@pytest.mark.parametrize("bad", [
    {**GOOD, "family": "x</style><script>alert(1)</script>"},
    {**GOOD, "family": "x; } body { color: red"},
    {**GOOD, "family": "a{b"}, {**GOOD, "family": "a\nb"}, {**GOOD, "family": ""}, {**GOOD, "family": 3},
    {**GOOD, "file": "../../etc/passwd"}, {**GOOD, "file": "fonts/../deck.json"}, {**GOOD, "file": "fonts/.."},
    {**GOOD, "file": "/abs/x.otf"}, {**GOOD, "file": "fonts/sub/x.otf"}, {**GOOD, "file": "fonts/a b.otf"},
    {**GOOD, "weight": "400; } x {"}, {**GOOD, "weight": 0}, {**GOOD, "weight": 1001}, {**GOOD, "weight": True},
    {**GOOD, "style": "italic; }"}, {**GOOD, "style": "oblique 10deg"}, "Archivo",
])
def test_bad_font_entries_are_named(bad):
    assert font_problem(bad)


def test_real_shaped_entries_pass():
    for weight in (100, 200, 300, 400, 500, 700, 800, 900, "bold"):
        for style in ("normal", "italic"):
            assert font_problem({**GOOD, "weight": weight, "style": style}) is None
    assert font_problem({"family": "Inter", "file": "fonts/Inter.otf"}) is None   # weight, style default


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path)
    s.create_deck("talk", "Talk")
    return s


def test_put_deck_refuses_a_bad_font(store):
    got = store.get_deck("talk")
    meta = dict(got["deck"], fonts=[{**GOOD, "family": "x</style><script>alert(1)</script>"}])
    with pytest.raises(ValueError, match="font family"):
        store.put_deck("talk", meta, got["version"])
    meta = dict(got["deck"], fonts=[GOOD])
    store.put_deck("talk", meta, got["version"])


def test_font_css_and_payload_cannot_close_their_elements(store):
    root = store.deck_dir("talk")
    meta = json.loads((root / "deck.json").read_text())
    # Written behind the service's back: the page still cannot be broken out of.
    meta["fonts"] = [GOOD, {**GOOD, "family": "x</style><script>alert(1)</script>"},
                     {**GOOD, "weight": "1; } body { x: y"}]
    meta["title"] = "a</script><script>alert(2)</script>"
    (root / "deck.json").write_text(json.dumps(meta))
    page = render_page(Deck.load(root))
    # The bad entries are in the data as text, never as markup or CSS.
    assert "<script>alert" not in page and "</style><script>" not in page and "} body { x" not in page.split("<style>")[1].split("</style>")[0]
    assert font_faces(meta["fonts"]).count("@font-face") == 1 and 'font-family: "Archivo Narrow"' in page
    data = page.split('id="svgdeck-data">', 1)[1].split("</script>", 1)[0]
    assert "<" not in data and json.loads(data)["title"] == meta["title"]
    assert font_faces([{**GOOD, "file": 'fonts/a"b'}]) == ""
    assert "\\3c " in font_faces([GOOD], {GOOD["file"]: "fonts/x<y.woff2"})


def test_export_refuses_a_font_outside_the_deck(store, tmp_path):
    root = store.deck_dir("talk")
    meta = json.loads((root / "deck.json").read_text())
    meta["fonts"] = [{**GOOD, "file": "../../secret.otf"}]
    (root / "deck.json").write_text(json.dumps(meta))
    with pytest.raises(ValueError, match="font file"):
        export(Deck.load(root), tmp_path / "out")


def deck_zip(meta, slides):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("talk/deck.json", json.dumps(meta))
        for sid in slides:
            z.writestr(f"talk/slides/{sid}.svg", SLIDE)
    return buf.getvalue()


def test_import_refuses_bad_fonts_and_duplicate_ids(tmp_path):
    store = BrowserStore(tmp_path)
    base = {"format": 1, "title": "T", "size": [100, 100]}
    with pytest.raises(ValueError, match="font file"):
        import_deck(store, deck_zip({**base, "slides": [{"id": "a"}], "fonts": [{**GOOD, "file": "../x"}]}, ["a"]))
    with pytest.raises(ValueError, match="more than once"):
        import_deck(store, deck_zip({**base, "slides": [{"id": "a"}, {"id": "a"}], "fonts": []}, ["a"]))
    page = ('<script type="application/json" id="svgdeck-data">' + json.dumps(
        {**base, "slides": [{"id": "a", "svg": SLIDE}], "fonts": [{**GOOD, "family": "a{b"}]}) + "</script>")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("talk/index.html", page)
    with pytest.raises(ValueError, match="font family"):
        import_deck(store, buf.getvalue())
    assert not list(store.decks.glob("*/deck.json")) if store.decks.is_dir() else True
    import_deck(store, deck_zip({**base, "slides": [{"id": "a"}], "fonts": [GOOD]}, ["a"]))
