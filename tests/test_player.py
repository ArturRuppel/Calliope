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


POINTERS = """() => {
  window.pe = (type, id, x, y, pointerType, isPrimary = true) => svgdeck.dispatchEvent(new PointerEvent(type,
    {pointerId: id, clientX: x, clientY: y, pointerType, isPrimary, bubbles: true, button: 0}));
}"""


def live(page):
    return page.evaluate("svgdeck.svgdeck.live")


def test_pinch_zooms_and_a_new_slide_resets(page):
    page.evaluate(POINTERS)
    # 960x540 window, 1920x1080 deck: half scale. Fingers 160 px apart spread to 320 px.
    page.evaluate("""() => { pe('pointerdown', 1, 400, 270, 'touch'); pe('pointerdown', 2, 560, 270, 'touch', false);
      pe('pointermove', 2, 720, 270, 'touch', false); }""")
    view = live(page)["view"]
    assert abs(view["k"] - 2) < 1e-6
    # The slide point that was between the fingers (x = 960) is between them still (client x = 560).
    box = page.evaluate("(() => { const r = document.querySelector('.svgdeck-stage').getBoundingClientRect(); return [r.left, r.width]; })()")
    assert abs(box[1] - 1920) < 1 and abs(box[0] + 960 / 1920 * box[1] - 560) < 1
    page.evaluate("pe('pointerup', 2, 720, 270, 'touch', false); pe('pointerup', 1, 400, 270, 'touch')")
    assert state(page)[:2] == [0, 0] and live(page)["view"]["k"] == view["k"]
    # Zoomed in, one finger drags the slide and does not turn it.
    page.evaluate("pe('pointerdown', 3, 500, 270, 'touch'); pe('pointermove', 3, 400, 270, 'touch'); pe('pointerup', 3, 400, 270, 'touch')")
    assert state(page)[:2] == [0, 0] and abs(live(page)["view"]["x"] - (view["x"] - 200)) < 1e-6
    # Nor does a tap while zoomed in.
    page.evaluate("pe('pointerdown', 3, 700, 270, 'touch'); pe('pointerup', 3, 700, 270, 'touch')")
    assert state(page)[:2] == [0, 0] and live(page)["view"]["k"] == view["k"]
    # Pinching back to the full slide lets go of the zoom; so does a new slide.
    page.evaluate("""() => { pe('pointerdown', 1, 300, 270, 'touch'); pe('pointerdown', 2, 700, 270, 'touch', false);
      pe('pointermove', 2, 400, 270, 'touch', false); pe('pointerup', 2, 400, 270, 'touch', false); pe('pointerup', 1, 300, 270, 'touch'); }""")
    assert live(page)["view"] == {"k": 1, "x": 0, "y": 0}
    page.evaluate("svgdeck.svgdeck.setLive({view: {k: 3, x: 10, y: 0}, pointer: null, ink: []})")
    page.keyboard.press("ArrowRight")
    assert state(page)[:2] == [1, 0] and live(page)["view"]["k"] == 1
    # Without a zoom, a swipe still turns the slide.
    page.evaluate("pe('pointerdown', 4, 500, 270, 'touch'); pe('pointermove', 4, 380, 270, 'touch'); pe('pointerup', 4, 380, 270, 'touch')")
    assert state(page)[:2] == [1, 1]


def test_pencil_marks_and_finger_points(page):
    page.evaluate(POINTERS)
    page.evaluate("pe('pointerdown', 7, 100, 100, 'pen'); pe('pointermove', 7, 200, 150, 'pen'); pe('pointerup', 7, 200, 150, 'pen')")
    ink = live(page)["ink"]
    assert len(ink) == 1 and ink[0]["d"] == [200, 200, 400, 300] and state(page)[:2] == [0, 0]
    assert page.locator(".svgdeck-ink path").get_attribute("d") == "M200 200L400 300"
    # A resting palm while the Pencil is down neither turns the slide nor zooms.
    page.evaluate("""() => { pe('pointerdown', 7, 300, 300, 'pen'); pe('pointerdown', 8, 600, 400, 'touch');
      pe('pointerup', 8, 600, 400, 'touch'); pe('pointermove', 7, 350, 300, 'pen'); pe('pointerup', 7, 350, 300, 'pen'); }""")
    assert len(live(page)["ink"]) == 2 and state(page)[:2] == [0, 0]
    # A Pencil tap wipes the marks; it never turns the slide.
    page.evaluate("pe('pointerdown', 7, 300, 300, 'pen'); pe('pointerup', 7, 300, 300, 'pen')")
    assert live(page)["ink"] == [] and page.locator(".svgdeck-ink path").count() == 0 and state(page)[:2] == [0, 0]
    page.evaluate("pe('pointerdown', 7, 600, 300, 'pen'); pe('pointerup', 7, 600, 300, 'pen')")
    assert state(page)[:2] == [0, 0]
    # A finger held still points until it lifts, and its lift turns nothing.
    page.evaluate("pe('pointerdown', 1, 300, 200, 'touch')")
    page.wait_for_function("svgdeck.svgdeck.live.pointer")
    assert live(page)["pointer"] == [600, 400] and page.locator(".svgdeck-pointer").is_visible()
    page.evaluate("pe('pointermove', 1, 350, 220, 'touch')")
    assert live(page)["pointer"] == [700, 440]
    page.evaluate("pe('pointerup', 1, 350, 220, 'touch')")
    assert live(page)["pointer"] is None and not page.locator(".svgdeck-pointer").is_visible() and state(page)[:2] == [0, 0]
    # A quick tap advances as before; marks leave with the slide.
    page.evaluate("pe('pointerdown', 7, 100, 100, 'pen'); pe('pointermove', 7, 200, 150, 'pen'); pe('pointerup', 7, 200, 150, 'pen')")
    page.evaluate("pe('pointerdown', 1, 400, 200, 'touch'); pe('pointerup', 1, 400, 200, 'touch')")
    assert state(page)[:2] == [1, 0] and live(page)["ink"] == []
    # A tap in the left third goes back (960 px wide: up to x = 320).
    page.evaluate("pe('pointerdown', 1, 300, 200, 'touch'); pe('pointerup', 1, 300, 200, 'touch')")
    assert state(page)[:2] == [0, 0]


def test_three_finger_tap_opens_the_overview(page):
    page.evaluate(POINTERS)
    three = """(spread) => { pe('pointerdown', 1, 300, 270, 'touch'); pe('pointerdown', 2, 400, 270, 'touch', false);
      pe('pointermove', 2, 400 + spread, 270, 'touch', false); pe('pointerdown', 3, 500, 270, 'touch', false);
      pe('pointermove', 3, 500 + spread, 270, 'touch', false);
      pe('pointerup', 3, 500, 270, 'touch', false); pe('pointerup', 2, 400, 270, 'touch', false); pe('pointerup', 1, 300, 270, 'touch'); }"""
    # Three fingers that move are no tap.
    page.evaluate(three, 60)
    assert not page.evaluate("document.querySelector('.svgdeck-overview-open')")
    assert live(page)["view"]["k"] == 1 and state(page)[:2] == [0, 0]
    # A little wobble is: the overview opens, nothing zooms, the slide stays.
    page.evaluate(three, 6)
    assert page.locator(".svgdeck-overview").is_visible()
    assert live(page)["view"]["k"] == 1 and state(page)[:2] == [0, 0]


def test_board_for_questions(page):
    page.evaluate(POINTERS)
    stroke = "pe('pointerdown', 7, {0}, 100, 'pen'); pe('pointermove', 7, {0}, 200, 'pen'); pe('pointerup', 7, {0}, 200, 'pen')"
    page.evaluate(stroke.format(100))  # a highlighter mark on the slide
    page.keyboard.press("w")
    assert live(page)["board"] and live(page)["ink"] == [] and page.locator(".svgdeck-board").is_visible()
    page.evaluate(stroke.format(200))
    page.evaluate(stroke.format(300))
    ink = live(page)["ink"]
    assert len(ink) == 2 and ink[0]["w"] == 4.5  # the thin pen, not the highlighter
    assert page.evaluate("getComputedStyle(document.querySelector('.svgdeck-ink path')).opacity") == "1"
    # Nothing turns the slides under the board: taps, Pencil taps, keys.
    page.evaluate("pe('pointerdown', 1, 600, 200, 'touch'); pe('pointerup', 1, 600, 200, 'touch')")
    page.evaluate("pe('pointerdown', 7, 600, 300, 'pen'); pe('pointerup', 7, 600, 300, 'pen')")
    page.keyboard.press("ArrowRight")
    assert state(page)[:2] == [0, 0] and len(live(page)["ink"]) == 2
    page.get_by_role("button", name="Undo", exact=True).click()
    assert len(live(page)["ink"]) == 1 and state(page)[:2] == [0, 0]
    # Back on the slide its own mark is there again; the board keeps its drawing.
    page.keyboard.press("Escape")
    assert not live(page)["board"] and live(page)["ink"][0]["d"][0] == 200 and not page.locator(".svgdeck-board").is_visible()
    page.keyboard.press("ArrowRight")
    assert state(page)[:2] == [1, 0] and live(page)["ink"] == []
    page.keyboard.press("w")
    assert len(live(page)["ink"]) == 1 and live(page)["ink"][0]["d"][0] == 400
    page.get_by_role("button", name="Wipe", exact=True).click()
    assert live(page)["ink"] == []
    page.get_by_role("button", name="Back to slides", exact=True).click()
    assert not live(page)["board"] and state(page)[:2] == [1, 0]


def test_gamepad_turns_slides(page):
    # A fake standard gamepad, as in the editor's controller tests.
    page.evaluate("""() => {
      window.fakePad = {id: 'Test pad', index: 0, mapping: 'standard', connected: true,
        buttons: Array.from({length: 17}, () => ({pressed: false, value: 0})), axes: [0, 0, 0, 0]};
      navigator.getGamepads = () => [window.fakePad];
      const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      window.hold = async (i, on) => { fakePad.buttons[i] = {pressed: on, value: +on}; await frame(); };
      window.press = async (i) => { await hold(i, true); await hold(i, false); };
      window.dispatchEvent(new Event('gamepadconnected'));
    }""")
    page.evaluate("press(0)")  # A
    assert state(page)[:2] == [1, 0]
    page.evaluate("hold(15, true)")  # D-pad right, held: one step only
    page.evaluate("hold(15, true)")
    assert state(page)[:2] == [1, 1]
    page.evaluate("hold(15, false)")
    page.evaluate("press(1)")  # B
    assert state(page)[:2] == [1, 0]
    page.evaluate("press(4)")  # LB
    assert state(page)[:2] == [0, 0]
    page.evaluate("press(3)")  # Y blanks; the next press only brings the slide back
    assert page.evaluate("svgdeck.svgdeck.state.blank")
    page.evaluate("press(0)")
    assert not page.evaluate("svgdeck.svgdeck.state.blank") and state(page)[:2] == [0, 0]
    # Of a linked speaker/audience pair, a window without focus leaves the press to the other.
    page.evaluate("svgdeck.svgdeck.paired = () => true; document.hasFocus = () => false")
    page.evaluate("press(0)")
    assert state(page)[:2] == [0, 0]
    page.evaluate("document.hasFocus = () => true")
    page.evaluate("press(0)")
    assert state(page)[:2] == [1, 0]


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
    assert state(page)[:2] == [1,2]  # a picked slide arrives fully built
    page.keyboard.press('Space')
    assert state(page)[:2] == [2,0]
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
