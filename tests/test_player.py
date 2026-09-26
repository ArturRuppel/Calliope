"""The player, driven in headless Chromium from a file:// export."""
import os

import pytest

from conftest import MOVIES
from svgdeck.deck import Deck
from svgdeck.export import export

playwright = pytest.importorskip("playwright.sync_api")
BROWSER = os.environ.get("SVGDECK_BROWSER", "chromium")  # webkit = the iPad's engine


@pytest.fixture
def page(deck, tmp_path):
    out = export(Deck.load(deck), tmp_path / "out")
    with playwright.sync_playwright() as p:
        browser = getattr(p, BROWSER).launch()
        page = browser.new_page(viewport={"width": 960, "height": 540})
        errors = []
        page.on("pageerror", lambda e: errors.append(e))
        page.goto((out / "index.html").as_uri())
        page.wait_for_function("document.querySelector('.svgdeck-ready')")
        yield page
        browser.close()
        assert not errors


def state(page):
    return page.evaluate("[svgdeck.svgdeck.state.index, svgdeck.svgdeck.state.step, location.hash]")


def visible(page, element_id):
    return page.evaluate(f"""(() => {{ const el = document.getElementById({element_id!r});
        return !!el && el.closest('.svgdeck-slide').classList.contains('svgdeck-current')
               && getComputedStyle(el).visibility !== 'hidden'; }})()""")


def test_steps_and_navigation(page):
    assert state(page) == [0, 0, "#1"]
    page.keyboard.press("ArrowRight")
    assert state(page) == [1, 0, "#2"]
    assert not visible(page, "s1-one") and not visible(page, "s1-two")
    page.keyboard.press("Space")
    assert state(page) == [1, 1, "#2.1"]
    assert visible(page, "s1-one") and not visible(page, "s1-two")
    page.keyboard.press("PageDown")
    assert visible(page, "s1-two")
    page.keyboard.press("ArrowRight")
    assert state(page)[:2] == [2, 0]
    # Going back lands on the fully built slide.
    page.keyboard.press("ArrowLeft")
    assert state(page)[:2] == [1, 2]
    page.keyboard.press("Home")
    assert state(page)[:2] == [0, 0]
    page.keyboard.type("3")
    page.keyboard.press("Enter")
    assert state(page)[:2] == [2, 0]


def test_ids_are_unique_per_slide(page):
    ids = page.evaluate("Array.from(document.querySelectorAll('[id]')).map(e => e.id)")
    assert "s0-bg" in ids and "s1-bg" in ids and "s0-back" in ids
    assert len(ids) == len(set(ids))
    fill = page.evaluate("document.getElementById('s2-back').getAttribute('fill')")
    assert fill == "url(#s2-bg)"


@pytest.mark.skipif(not MOVIES, reason="no movies in headless WebKit; checked in Chromium")
def test_movie_is_positioned_and_layered(page):
    page.keyboard.press("End")
    order = page.evaluate("""Array.from(document.querySelector('.svgdeck-current').children)
                             .map(c => c.tagName.toLowerCase())""")
    assert order == ["svg", "video", "svg"]  # the rect drawn after the movie is above it
    box = page.evaluate("""(() => { const r = document.querySelector('.svgdeck-current video').getBoundingClientRect();
                           return [r.x, r.y, r.width, r.height]; })()""")
    assert box == pytest.approx([50, 50, 320, 240], abs=1)  # slide units at half scale


@pytest.mark.skipif(not MOVIES, reason="no movies in headless WebKit; checked in Chromium and Brave")
def test_sync_group_continues_across_slides(page):
    page.keyboard.press("ArrowRight")
    page.wait_for_function("document.querySelector('.svgdeck-current video').currentTime > 1.5")
    before = page.evaluate("document.querySelector('.svgdeck-current video').currentTime")
    page.keyboard.press("ArrowRight")
    page.keyboard.press("ArrowRight")
    page.keyboard.press("ArrowRight")
    assert state(page)[0] == 2
    after = page.evaluate("document.querySelector('.svgdeck-current video').currentTime")
    assert after >= before - 0.1
    assert page.evaluate("!document.querySelector('.svgdeck-current video').paused")


def test_blank_screen(page):
    page.keyboard.press("b")
    assert page.evaluate("getComputedStyle(document.querySelector('.svgdeck-stage')).visibility") == "hidden"
    page.keyboard.press("ArrowRight")
    assert state(page)[0] == 0  # the first key only unblanks
    assert page.evaluate("getComputedStyle(document.querySelector('.svgdeck-stage')).visibility") == "visible"
