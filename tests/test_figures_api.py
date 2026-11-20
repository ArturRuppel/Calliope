"""Slide kinds and sizes, figures decks, copying between decks and the
single-slide SVG export (docs/format.md, "Kinds and sizes of slides")."""
import base64
import io
import json
import re
from pathlib import Path
from xml.etree import ElementTree

import pytest
from fastapi.testclient import TestClient

from conftest import SLIDE, write_deck
from svgdeck.deck import Deck, font_problem
from svgdeck.server import create_app
from svgdeck.store import Store, face_info

SVGNS = "{http://www.w3.org/2000/svg}"
STYLE = {"width": 481.89, "unit": "pt", "textSize": 9.2, "letterSize": 10.5}
FONT = Path("/usr/share/fonts/inter/InterVariable.ttf")


def png(width=40, height=20, color=(200, 30, 30)) -> bytes:
    Image = pytest.importorskip("PIL.Image")
    out = io.BytesIO()
    Image.new("RGB", (width, height), color).save(out, "PNG")
    return out.getvalue()


@pytest.fixture
def api(tmp_path):
    write_deck(tmp_path / "decks" / "talk", [("one", SLIDE.format(color="#111", body="<text>one</text>"))])
    return TestClient(create_app(tmp_path)), tmp_path


def test_a_figures_deck_starts_with_a_material_board_and_keeps_its_style(api):
    client, data = api
    r = client.post("/api/decks", json={"name": "figs", "title": "Figures", "size": [3000, 2000], "figureStyle": STYLE})
    assert r.status_code == 200, r.text
    deck = r.json()["deck"]
    assert deck["figureStyle"] == STYLE and deck["size"] == [3000, 2000]
    assert deck["slides"][0]["kind"] == "material" and deck["slides"][0]["name"] == "Board 1"
    first = (data / "decks" / "figs" / "slides" / f"{deck['slides'][0]['id']}.svg").read_text()
    assert 'viewBox="0 0 3000 2000"' in first


def test_a_plain_new_deck_is_unchanged(api):
    client, data = api
    deck = client.post("/api/decks", json={"name": "plain", "title": "Plain"}).json()["deck"]
    assert set(deck) == {"format", "title", "size", "background", "slides", "fonts"}
    assert deck["slides"] == [{"id": deck["slides"][0]["id"]}] and deck["size"] == [1920, 1080]


@pytest.mark.parametrize("style", [{"width": 5}, {"unit": "mm"}, {"textSize": 0}, {"font": "x<y"}, {"other": 1}, []])
def test_bad_figure_styles_are_refused(api, style):
    client, _ = api
    assert client.post("/api/decks", json={"name": "bad", "title": "b", "figureStyle": style}).status_code == 400


def test_new_slides_have_their_own_kind_name_and_size(api):
    client, data = api
    r = client.post("/api/decks/talk/slides", json={"kind": "figure", "name": "Figure 1", "size": [481.89, 300]})
    assert r.status_code == 201, r.text
    body = r.json()
    entry = body["deck"]["slides"][-1]
    assert entry == {"id": body["id"], "kind": "figure", "name": "Figure 1"}
    svg = (data / "decks" / "talk" / "slides" / f"{body['id']}.svg").read_text()
    assert 'viewBox="0 0 481.89 300"' in svg and 'width="481.89"' in svg
    # The deck keeps its size: it is the default for new slides and for presenting.
    deck = client.get("/api/decks/talk").json()
    assert deck["deck"]["size"] == [1920, 1080] and deck["version"] == body["deckVersion"]
    # A slide without a size is the deck's size; "after" puts it in place.
    second = client.post("/api/decks/talk/slides", json={"kind": "material", "after": "one"}).json()
    assert [s["id"] for s in second["deck"]["slides"]] == ["one", second["id"], body["id"]]
    assert 'viewBox="0 0 1920 1080"' in (data / "decks" / "talk" / "slides" / f"{second['id']}.svg").read_text()


@pytest.mark.parametrize("body", [{"kind": "poster"}, {"size": [0, 10]}, {"size": [10, 200000]}, {"size": "big"},
                                  {"after": "nope"}, {"name": "x" * 201}, {"svg": "<svg><script/></svg>"}])
def test_bad_new_slides_are_refused(api, body):
    client, _ = api
    assert client.post("/api/decks/talk/slides", json=body).status_code == 400


def test_kind_and_name_are_checked_when_the_deck_is_saved(api):
    client, _ = api
    deck = client.get("/api/decks/talk").json()
    meta = deck["deck"]
    meta["slides"][0]["kind"] = "material"
    ok = client.put("/api/decks/talk", json={"deck": meta, "base": deck["version"]})
    assert ok.status_code == 200
    meta["slides"][0]["kind"] = "poster"
    assert client.put("/api/decks/talk", json={"deck": meta, "base": ok.json()["version"]}).status_code == 400


def test_copying_a_slide_to_another_deck_copies_its_media_and_leaves_the_source(api):
    client, data = api
    client.post("/api/decks", json={"name": "other", "title": "Other", "figureStyle": STYLE})
    media = client.post("/api/decks/talk/media?filename=dot.png", content=png()).json()
    svg = SLIDE.format(color="#222", body=f'<image href="{media["href"]}" x="0" y="0" width="400" height="200"/>')
    slide = client.post("/api/decks/talk/slides", json={"svg": svg, "kind": "material", "name": "Board"}).json()
    before = sorted(p.name for p in (data / "decks" / "talk" / "media").iterdir())
    copy = client.post("/api/decks/other/slides", json={"from": {"deck": "talk", "slide": slide["id"]}})
    assert copy.status_code == 201, copy.text
    entry = copy.json()["deck"]["slides"][-1]
    assert entry["kind"] == "material" and entry["name"] == "Board"
    name = media["href"].split("/")[-1]
    assert (data / "decks" / "other" / "media" / name).read_bytes() == (data / "decks" / "talk" / "media" / name).read_bytes()
    assert sorted(p.name for p in (data / "decks" / "talk" / "media").iterdir()) == before
    # A selection travels as SVG with the deck its media comes from.
    part = client.post("/api/decks/other/slides", json={"svg": svg, "from": {"deck": "talk"}, "kind": "material"})
    assert part.status_code == 201
    assert client.post("/api/decks/other/slides", json={"from": {"deck": "talk", "slide": "nope"}}).status_code == 404


def test_the_slide_export_is_standalone(api):
    client, data = api
    media = client.post("/api/decks/talk/media?filename=big.png", content=png(4000, 2000)).json()
    small = client.post("/api/decks/talk/media?filename=small.png", content=png(40, 20, (0, 90, 200))).json()
    body = (f'<image href="{media["href"]}" x="10" y="10" width="240" height="120"/>'
            f'<g transform="scale(2)"><image href="{small["href"]}" x="0" y="200" width="40" height="20"/></g>'
            '<rect data-layout="true" visibility="hidden" x="0" y="0" width="5" height="5"/>'
            '<text x="10" y="300" font-family="Nope">Panel</text>')
    svg = SLIDE.format(color="#333", body=body).replace("1920", "481.89").replace("1080", "320")
    slide = client.post("/api/decks/talk/slides", json={"svg": svg, "kind": "figure"}).json()
    r = client.get(f"/api/decks/talk/slides/{slide['id']}/export.svg")
    assert r.status_code == 200, r.text
    assert r.headers["x-slide-version"] == slide["version"] == r.headers["etag"].strip('"')
    assert r.headers["content-security-policy"] == "sandbox"
    root = ElementTree.fromstring(r.content)
    assert root.get("width") == "481.89pt" and root.get("height") == "320pt"
    images = root.findall(f".//{SVGNS}image")
    assert len(images) == 2 and all(i.get("href").startswith("data:image/") for i in images)
    assert not root.findall(f".//{SVGNS}rect[@data-layout]")
    Image = pytest.importorskip("PIL.Image")
    big = Image.open(io.BytesIO(base64.b64decode(images[0].get("href").split(",", 1)[1])))
    # 240 pt wide at 300 dpi is 1000 px: scaled down from 4000, still a raster.
    assert big.width == 1000
    tiny = Image.open(io.BytesIO(base64.b64decode(images[1].get("href").split(",", 1)[1])))
    assert tiny.size == (40, 20)
    # An ordinary slide stays in pixels.
    plain = ElementTree.fromstring(client.get("/api/decks/talk/slides/one/export.svg").content)
    assert plain.get("width") == "1920" and plain.get("height") == "1080"
    assert client.get("/api/decks/talk/slides/nope/export.svg").status_code == 404
    assert client.get("/api/decks/talk/slides/one/export.svg?dpi=5").status_code == 400


@pytest.mark.skipif(not FONT.is_file(), reason="needs a variable font to embed")
def test_the_export_embeds_the_fonts_it_names_cut_to_its_text(api, tmp_path):
    client, data = api
    info = face_info(FONT)
    assert re.fullmatch(r"\d+ \d+", info["weight"])   # a variable font is one face for its weights
    assert font_problem({"family": info["family"], "file": "fonts/x.ttf", "weight": info["weight"]}) is None
    r = client.post("/api/fonts?filename=InterVariable.ttf", content=FONT.read_bytes())
    assert r.status_code == 200, r.text
    assert client.post("/api/decks/talk/fonts", json={"family": info["family"]}).status_code == 200
    svg = SLIDE.format(color="#333", body=f'<text x="10" y="300" font-family="{info["family"]}" font-weight="700">abc</text>')
    slide = client.post("/api/decks/talk/slides", json={"svg": svg}).json()
    out = client.get(f"/api/decks/talk/slides/{slide['id']}/export.svg").text
    rule = re.search(r"@font-face \{[^}]*\}", out).group()
    assert "data:font/woff2;base64," in rule and f"font-weight: {info['weight']}" in rule
    assert len(rule) < 60_000   # three letters, not the whole font
    # The presenter page serves the range as CSS has it.
    page = client.get("/d/talk/").text
    assert f"font-weight: {info['weight']}" in page


def test_existing_decks_load_and_present_unchanged(api):
    """Old decks carry no kinds or sizes: Deck, the presenter and the export read them as before."""
    client, data = api
    deck = Deck.load(data / "decks" / "talk")
    assert [s["id"] for s in deck.slide_sources()] == ["one"]
    assert client.get("/d/talk/").status_code == 200
    # Kinds are only data for the editor: the presenter still lists every slide.
    client.post("/api/decks/talk/slides", json={"kind": "figure", "size": [400, 300]})
    page = client.get("/d/talk/").text
    payload = json.loads(re.search(r'id="svgdeck-data">(.*?)</script>', page, re.S).group(1))
    assert len(payload["slides"]) == 2 and payload["size"] == [1920, 1080]
