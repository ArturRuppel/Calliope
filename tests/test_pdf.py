"""PDF export: the player's print mode, printed by headless Chromium."""
import sys
import zipfile

import pytest

from svgdeck import cli
from svgdeck.deck import Deck
from svgdeck.export import export
from svgdeck.pdf import MISSING_PLAYWRIGHT, render_pdf

playwright = pytest.importorskip("playwright.sync_api")
pypdf = pytest.importorskip("pypdf")

def pages(path):
    return pypdf.PdfReader(path).pages


def text(page):
    return " ".join(page.extract_text().split())


def test_one_deck_sized_page_per_slide(deck, tmp_path):
    out = render_pdf(deck, tmp_path / "talk.pdf")
    assert out == (tmp_path / "talk.pdf").absolute()
    result = pages(out)
    assert len(result) == 3
    for page in result:  # 1920x1080 px at 96 px per inch: 20 x 11.25 in, in points
        assert [float(v) for v in page.mediabox[2:]] == pytest.approx([1440, 810], abs=0.5)
    assert "first" in text(result[0])
    assert not list(tmp_path.glob(".*.tmp-*"))


def test_steps_print_one_page_per_build_step(deck, tmp_path):
    # Slide b has steps 1 and 2: its initial state, after step 1, after step 2.
    assert len(pages(render_pdf(deck, tmp_path / "steps.pdf", steps=True))) == 1 + 3 + 1


def test_cli_pdf(deck, tmp_path, capsys):
    cli.main(["pdf", str(deck), str(tmp_path / "out.pdf"), "--steps"])
    assert "out.pdf" in capsys.readouterr().out
    assert len(pages(tmp_path / "out.pdf")) == 5
    cli.main(["pdf", str(deck), str(tmp_path / "plain.pdf")])
    assert len(pages(tmp_path / "plain.pdf")) == 3


def test_export_pdf_flag_writes_deck_pdf_into_folder_and_zip(deck, tmp_path):
    cli.main(["export", str(deck), str(tmp_path / "out"), "--zip", str(tmp_path / "out.zip"), "--pdf"])
    assert len(pages(tmp_path / "out" / "deck.pdf")) == 3
    with zipfile.ZipFile(tmp_path / "out.zip") as archive:
        assert archive.read("out/deck.pdf") == (tmp_path / "out" / "deck.pdf").read_bytes()
    # Without the flag there is none.
    export(Deck.load(deck), tmp_path / "out")
    assert not (tmp_path / "out" / "deck.pdf").exists()


def test_missing_playwright_is_a_clear_error(deck, tmp_path, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "playwright.sync_api", None)  # import fails
    with pytest.raises(RuntimeError) as error:
        render_pdf(deck, tmp_path / "x.pdf")
    assert str(error.value) == "PDF export needs Playwright: pip install 'svgdeck[pdf]'" == MISSING_PLAYWRIGHT
    for argv in (["pdf", str(deck), str(tmp_path / "x.pdf")], ["export", str(deck), str(tmp_path / "out"), "--pdf"]):
        with pytest.raises(SystemExit) as exit:
            cli.main(argv)
        assert MISSING_PLAYWRIGHT in str(exit.value.code)
    assert not (tmp_path / "x.pdf").exists() and not (tmp_path / "out").exists()


def test_chromium_override(deck, tmp_path, monkeypatch):
    monkeypatch.setenv("SVGDECK_CHROMIUM", str(tmp_path / "no-chromium"))
    with pytest.raises(RuntimeError, match="SVGDECK_CHROMIUM"):
        render_pdf(deck, tmp_path / "x.pdf")
    assert not (tmp_path / "x.pdf").exists()
    with playwright.sync_playwright() as p:
        real = p.chromium.executable_path
    monkeypatch.setenv("SVGDECK_CHROMIUM", real)
    assert len(pages(render_pdf(deck, tmp_path / "y.pdf"))) == 3


@pytest.fixture
def browser():
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch()
        yield browser
        browser.close()


def open_print(browser, deck, tmp_path, query):
    out = export(Deck.load(deck), tmp_path / "site")
    page = browser.new_page(viewport={"width": 960, "height": 540})
    errors = []
    page.on("pageerror", lambda e: errors.append(e))
    page.goto((out / "index.html").as_uri() + query)
    page.wait_for_function("document.querySelector('#svgdeck.svgdeck-ready')")
    assert not errors
    return page


@pytest.mark.parametrize("query", ["?print=1", "#print"])
def test_print_mode_shows_every_slide_fully_built_without_movies(browser, deck, tmp_path, query):
    page = open_print(browser, deck, tmp_path, query)
    assert page.evaluate("document.getElementById('svgdeck').classList.contains('svgdeck-print')")
    assert page.locator(".svgdeck-page").count() == 3
    boxes = [page.locator(".svgdeck-page").nth(i).bounding_box() for i in range(3)]
    for box in boxes:  # stacked, each exactly the deck's aspect
        assert box["width"] == pytest.approx(960, abs=1)
        assert box["height"] == pytest.approx(540, abs=1)
    assert boxes[0]["y"] < boxes[1]["y"] < boxes[2]["y"]
    # Every build step is visible.
    for element in ("s1-one", "s1-two"):
        assert page.evaluate(f"getComputedStyle(document.getElementById('{element}')).visibility") == "visible"
    # Movies are their poster <image>; no <video>, controls or overview.
    assert page.locator("video").count() == 0
    assert page.locator(".svgdeck-page image[data-video]").count() == 2
    assert page.locator(".svgdeck-controls, .svgdeck-overview").count() == 0
    # No keyboard handling: keys do not move anything.
    page.keyboard.press("ArrowRight")
    assert page.evaluate("location.hash") == ("#print" if query == "#print" else "")
    assert page.evaluate("getComputedStyle(document.querySelector('.svgdeck-page')).breakAfter") == "page"


def test_print_mode_steps(browser, deck, tmp_path):
    page = open_print(browser, deck, tmp_path, "?print=steps")
    assert page.locator(".svgdeck-page").count() == 5
    assert page.evaluate("[...document.querySelectorAll('.svgdeck-page')].map(p => p.dataset.buildStep ?? null)") \
        == ["0", "0", "1", "2", "0"]
    visibility = page.evaluate("""[...document.querySelectorAll('.svgdeck-page[data-slide="2"]')].map(p =>
        [...p.querySelectorAll('[data-step]')].map(e => getComputedStyle(e).visibility))""")
    assert visibility == [["hidden", "hidden"], ["visible", "hidden"], ["visible", "visible"]]


def test_start_option_enables_print_mode(browser, deck, tmp_path):
    page = open_print(browser, deck, tmp_path, "")
    assert page.locator(".svgdeck-page").count() == 0  # the presenter, as usual
    count = page.evaluate("""async () => {
        const root = document.createElement('div'); document.body.append(root);
        const deck = JSON.parse(document.getElementById('svgdeck-data').textContent);
        const api = SvgDeck.start(root, deck, {slideBase: 'slides/', print: {steps: true}});
        await api.ready;
        return [root.classList.contains('svgdeck-print'), api.pages.length];
    }""")
    assert count == [True, 5]


def test_printing_the_presenter_prints_every_slide_fully_built(browser, deck, tmp_path):
    out = export(Deck.load(deck), tmp_path / "site")
    page = browser.new_page(viewport={"width": 960, "height": 540})
    page.goto((out / "index.html").as_uri())
    page.wait_for_function("document.querySelector('.svgdeck-ready')")
    page.keyboard.press("ArrowRight")  # slide b, before its builds
    page.emulate_media(media="print")
    assert page.evaluate("[...document.querySelectorAll('.svgdeck-slide')].map(s => getComputedStyle(s).display)") \
        == ["block"] * 3
    assert page.evaluate("getComputedStyle(document.getElementById('s1-two')).visibility") == "visible"
    assert page.evaluate("getComputedStyle(document.querySelector('.svgdeck-controls')).display") == "none"
    path = tmp_path / "printed.pdf"
    path.write_bytes(page.pdf(format="A4", print_background=True, prefer_css_page_size=True))
    result = pages(path)
    assert len(result) == 3
    assert float(result[0].mediabox[2]) > float(result[0].mediabox[3])  # landscape
