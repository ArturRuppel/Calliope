"""Figure mode in the editor (?mode=figures): two lists, no presenting, copy
to figure, panel letters, figure sizes, copying between decks. And the
editor without it, unchanged."""
import json
import os
import socket
import threading
import time

import pytest
import uvicorn

from svgdeck.server import create_app
from svgdeck.store import Store

playwright = pytest.importorskip("playwright.sync_api")
BROWSER = os.environ.get("SVGDECK_BROWSER", "chromium")
STYLE = {"width": 480, "unit": "pt", "textSize": 9, "letterSize": 10.5}

BOARD = """<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 1500" width="2000" height="1500">
<rect id="background" data-label="background" data-locked="true" width="2000" height="1500" fill="#ffffff"/>
<rect id="plot" x="200" y="200" width="800" height="400" fill="#1f77b4"/>
<text id="note" x="200" y="700" style="font-size:60px">Note</text>
</svg>"""


@pytest.fixture
def server(tmp_path):
    store = Store(tmp_path)
    store.create_deck("figs", "Figures", (1920, 1080), STYLE)
    board = store.add_slide("figs", svg=BOARD.encode(), kind="material", slide_name="Snapshots")
    one = store.add_slide("figs", kind="figure", slide_name="streams", size=[480, 300])
    two = store.add_slide("figs", kind="figure", slide_name="matrix", size=[480, 300])
    store.create_deck("other", "Other deck")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(tmp_path), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    while not srv.started:
        time.sleep(0.02)
    yield f"http://127.0.0.1:{port}", tmp_path, {"board": board["id"], "one": one["id"], "two": two["id"]}
    srv.should_exit = True
    thread.join(5)


@pytest.fixture
def browser():
    with playwright.sync_playwright() as p:
        b = getattr(p, BROWSER).launch()
        yield b
        b.close()


def open_editor(browser, url, query=""):
    page = browser.new_page(viewport={"width": 1376, "height": 1032})
    errors = []
    page.on("pageerror", lambda e: errors.append(e))
    page.goto(f"{url}/edit/figs{query}")
    page.wait_for_function("document.getElementById('status').textContent.includes('Saved')")
    return page, errors


def saved(page):
    page.evaluate("svgdeckEditor.flush()")
    page.wait_for_function("document.getElementById('status').textContent.includes('Saved')")


def slide_file(data, deck, sid):
    return (data / "decks" / deck / "slides" / f"{sid}.svg").read_text()


def test_figure_mode_lists_figures_in_document_order_and_hides_presenting(server, browser):
    url, data, ids = server
    page, errors = open_editor(browser, url, f"?mode=figures&slide={ids['two']}&figs={ids['two']}~1~matrix,{ids['one']}~2~streams")
    heads = page.locator("#thumbs .strip-head").all_inner_texts()
    assert [h.split("\n")[0].upper() for h in heads] == ["FIGURES", "MATERIAL"]
    names = page.locator("#thumbs .thumb-name").all_inner_texts()
    assert names[:2] == ["Figure 1 · matrix", "Figure 2 · streams"]
    assert "Snapshots" in names[2:]
    # It opened the slide it was asked for, and says which figure it is.
    assert page.evaluate("svgdeckEditor.state.current") == ids["two"]
    assert "Figure 1 · matrix" in page.inner_text("#slide-pos")
    assert page.locator("#present").is_hidden()
    assert page.locator('#inspector-tabs [data-tab="builds"]').is_hidden()
    page.click("#doc-menu-btn")
    menu = page.inner_text("#doc-menu")
    assert "Speaker view" not in menu and "Export offline copy" not in menu and "Commit snapshot" in menu
    page.keyboard.press("Escape")
    # The figure's own panel: its width is the text width, its height its own.
    panel = page.inner_text("#panel")
    assert "480 pt" in panel and "Panel letters" in panel
    page.click(f'#thumbs li[data-id="{ids["board"]}"]')
    page.wait_for_function(f"svgdeckEditor.state.current === {json.dumps(ids['board'])}")
    page.locator("#panel").get_by_text("Board", exact=True).wait_for()
    # Selected objects have no build step in figure mode.
    page.evaluate("svgdeckEditor.editor.select([svgdeckEditor.editor.svg.querySelector('#plot')])")
    assert "Build step" not in page.inner_text("#panel")
    assert page.locator("#copy-to-figure").is_visible()
    assert not errors


def test_without_figure_mode_the_editor_is_as_before(server, browser):
    url, _, _ = server
    page, errors = open_editor(browser, url)
    assert page.locator("#present").is_visible()
    assert page.locator('#inspector-tabs [data-tab="builds"]').is_visible()
    assert page.locator("#thumbs .strip-head").count() == 0
    assert page.locator("#thumbs .num").first.inner_text() == "1"
    assert "Slide 1 of 4" in page.inner_text("#slide-pos")
    page.click("#doc-menu-btn")
    assert "Speaker view" in page.inner_text("#doc-menu")
    page.keyboard.press("Escape")
    page.evaluate("svgdeckEditor.editor.select([svgdeckEditor.editor.svg.querySelector('rect:not([data-locked])') || svgdeckEditor.editor.svg.lastElementChild])")
    assert page.locator("#copy-to-figure").count() == 0
    assert not errors


def test_copy_to_figure_copies_scales_and_offers_document_sizes(server, browser):
    url, data, ids = server
    page, errors = open_editor(browser, url, f"?mode=figures&slide={ids['board']}")
    board_before = slide_file(data, "figs", ids["board"])
    page.evaluate("""svgdeckEditor.editor.select([...svgdeckEditor.editor.svg.querySelectorAll('#plot, #note')])""")
    page.click("#copy-to-figure")
    page.locator(".figure-choose .choose-item", has_text="matrix").click()
    page.wait_for_function(f"svgdeckEditor.state.current === {json.dumps(ids['two'])}")
    page.locator(".figure-offer").wait_for()
    box = page.evaluate("""(() => { const e = svgdeckEditor.editor, g = e.svg.querySelector('g[data-label="Panel"]');
        const b = g.getBBox(), m = g.getCTM(), r = e.svg.getCTM().inverse().multiply(m);
        return { w: b.width * r.a, h: b.height * r.d, x: r.e + b.x * r.a, y: r.f + b.y * r.d }; })()""")
    # The copy fits the 480 x 300 pt figure and starts at its corner.
    assert abs(box["x"]) < 0.5 and abs(box["y"]) < 0.5
    assert box["w"] <= 480.5 and box["h"] <= 300.5 and (abs(box["w"] - 480) < 0.5 or abs(box["h"] - 300) < 0.5)
    page.click("#figure-offer-set")
    size = page.evaluate("""(() => { const e = svgdeckEditor.editor, t = e.svg.querySelector('g[data-label="Panel"] text');
        const m = e.svg.getCTM().inverse().multiply(t.getCTM());
        return parseFloat(getComputedStyle(t).fontSize) * Math.sqrt(m.a * m.d - m.b * m.c); })()""")
    assert abs(size - 9) < 0.01
    saved(page)
    figure = slide_file(data, "figs", ids["two"])
    assert 'data-label="Panel"' in figure and "Note" in figure
    # The board keeps what was copied (it was not even rewritten).
    assert slide_file(data, "figs", ids["board"]) == board_before
    # Copying and sizing are undo steps of the figure.
    page.click("#undo")
    page.click("#undo")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('g[data-label=\"Panel\"]')") is None
    assert not errors


def test_panel_letters_and_figure_height(server, browser):
    url, data, ids = server
    page, errors = open_editor(browser, url, f"?mode=figures&slide={ids['one']}")
    fig = "svgdeckEditor.fig"
    for x in (300, 20, 160):
        page.evaluate(f"""(() => {{ const e = svgdeckEditor.editor;
            const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            Object.entries({{x: {x}, y: {40 if x != 160 else 170}, width: 100, height: 80}}).forEach(([k, v]) => r.setAttribute(k, v));
            e.change(() => e.svg.appendChild(r)); e.select([r]); {fig}.addLetter(); }})()""")
    letters = page.evaluate("[...svgdeckEditor.editor.svg.querySelectorAll('text[data-panel-letter]')].map(t => t.textContent)")
    assert letters == ["a", "b", "c"]
    page.evaluate(f"{fig}.renumberLetters()")
    order = page.evaluate("""[...svgdeckEditor.editor.svg.querySelectorAll('text[data-panel-letter]')]
        .map(t => [t.textContent, +t.getAttribute('x'), getComputedStyle(t).fontWeight, getComputedStyle(t).fontSize])""")
    # Reading order: the top row left to right (x 20, then 300), then the row below.
    assert sorted(order, key=lambda o: o[0]) == [["a", 20, "700", "10.5px"], ["b", 300, "700", "10.5px"], ["c", 160, "700", "10.5px"]]
    page.evaluate(f"{fig}.fitToContent(true)")
    page.wait_for_function("svgdeckEditor.editor.size[1] === 250")
    assert page.evaluate("svgdeckEditor.editor.size") == [480, 250]
    saved(page)
    assert 'viewBox="0 0 480 250"' in slide_file(data, "figs", ids["one"])
    page.click("#undo")
    assert page.evaluate("svgdeckEditor.editor.size") == [480, 300]
    assert not errors


def test_copying_a_board_and_a_selection_to_another_deck(server, browser):
    url, data, ids = server
    page, errors = open_editor(browser, url, f"?mode=figures&slide={ids['board']}")
    page.click("#slide-menu-btn")
    page.click("#slide-copy-deck")
    page.locator(".figure-choose .choose-item", has_text="Other deck").click()
    page.wait_for_function("document.getElementById('toast').textContent.includes('Copied to other')")
    page.evaluate("svgdeckEditor.editor.select([svgdeckEditor.editor.svg.querySelector('#plot')])")
    page.evaluate("svgdeckEditor.fig && document.querySelector('#copy-to-figure')")
    page.click("#object-actions")
    page.get_by_role("menuitem", name="Copy to another deck…").click()
    page.locator(".figure-choose .choose-item", has_text="Other deck").click()
    page.wait_for_function("document.getElementById('toast').textContent.includes('Copied to other')")
    other = json.loads((data / "decks" / "other" / "deck.json").read_text())
    assert [s.get("kind") for s in other["slides"]] == [None, "material", "material"]
    part = slide_file(data, "other", other["slides"][2]["id"])
    assert 'viewBox="0 0 840 440"' in part and 'id="plot"' in part
    assert json.loads((data / "decks" / "figs" / "deck.json").read_text())["slides"][1]["id"] == ids["board"]
    assert not errors


def test_changing_the_deck_size_leaves_boards_and_figures_alone(server, browser):
    url, data, ids = server
    plain = Store(data).add_slide("figs")["id"]
    page, errors = open_editor(browser, url)
    page.on("dialog", lambda d: d.accept())
    page.evaluate("svgdeckEditor.flush()")
    page.click("#doc-menu-btn")
    page.click("#deck-settings")
    page.select_option("#deck-size", "3")   # 1024 x 768
    page.click("#deck-size-apply")
    page.wait_for_function("document.getElementById('toast').textContent.includes('1024')")
    saved(page)
    deck = json.loads((data / "decks" / "figs" / "deck.json").read_text())
    assert deck["size"] == [1024, 768]
    assert 'viewBox="0 0 1024 768"' in slide_file(data, "figs", plain)
    assert 'viewBox="0 0 1920 1080"' in slide_file(data, "figs", deck["slides"][0]["id"])   # Board 1, material
    assert 'viewBox="0 0 2000 1500"' in slide_file(data, "figs", ids["board"])
    assert 'viewBox="0 0 480 300"' in slide_file(data, "figs", ids["one"])
    assert not errors
