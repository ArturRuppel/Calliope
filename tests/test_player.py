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


def test_overview_and_buttons_do_not_advance_accidentally(page,tmp_path):
    page.get_by_role('button',name='Slide overview',exact=True).click()
    assert state(page)[:2]==[0,0]
    assert page.get_by_role('dialog',name='Slide overview').is_visible()
    page.keyboard.press('ArrowRight')
    assert state(page)[:2]==[0,0]
    page.get_by_role('button',name='Go to slide 3',exact=True).click()
    assert state(page)[:2]==[2,0]
    assert page.get_by_role('dialog').is_hidden()
    page.get_by_role('button',name='Previous',exact=True).click()
    assert state(page)[:2]==[1,2]
    page.keyboard.press('o')
    page.screenshot(path=str(tmp_path/'presenter-overview.png'))
    page.keyboard.press('Escape')
    assert page.get_by_role('dialog').is_hidden()
    assert state(page)[:2]==[1,2]
    assert page.get_by_role('link',name='Back to editor').count()==0 # portable offline export


def test_presenter_controls_fit_phone_and_overview_returns_keyboard_focus(page):
    page.set_viewport_size({'width':390,'height':500})
    for control in page.locator('.svgdeck-controls button').all():
        b=control.bounding_box()
        assert b['x'] >= 0 and b['x']+b['width'] <= 390
        assert b['y'] >= 0 and b['y']+b['height'] <= 500
    page.get_by_role('button',name='Slide overview',exact=True).click()
    assert page.evaluate('getComputedStyle(document.getElementById("svgdeck")).touchAction') == 'pan-y'
    page.get_by_role('button',name='Go to slide 2',exact=True).click()
    page.keyboard.press('Space')
    assert state(page)[:2] == [1,1]
    assert page.get_by_role('dialog').is_hidden()


def tap(page, x, y, kind='touch'):
    page.evaluate(f"""(() => {{ const root = document.getElementById('svgdeck');
        for (const type of ['pointerdown', 'pointerup']) root.dispatchEvent(new PointerEvent(type,
          {{bubbles: true, clientX: {x}, clientY: {y}, pointerType: '{kind}', button: 0, isPrimary: true}})); }})()""")


def test_controls_hide_while_presenting_and_return_on_demand(page):
    shown = "document.getElementById('svgdeck').classList.contains('svgdeck-show-controls')"
    assert page.evaluate(shown)  # shown briefly at the start
    page.wait_for_function(f"!{shown}", timeout=6000)
    page.wait_for_function("getComputedStyle(document.querySelector('.svgdeck-controls')).opacity === '0'")
    # A tap along the bottom edge brings them back instead of advancing.
    tap(page, 480, 520)
    assert page.evaluate(shown)
    assert state(page)[:2] == [0, 0]
    tap(page, 480, 520)
    assert not page.evaluate(shown)
    tap(page, 480, 270)  # anywhere else still advances
    assert state(page)[:2] == [1, 0]
    # The controls stay small: one row, well under the old 44 px buttons.
    tap(page, 480, 520)
    box = page.locator('.svgdeck-controls').bounding_box()
    assert box['height'] <= 42 and box['width'] <= 300
