"""Camera frames: hidden rectangles that zoom and pan the slide per step."""
import os

import pytest

from conftest import SLIDE, write_deck
from svgdeck.deck import Deck
from svgdeck.export import export

playwright = pytest.importorskip("playwright.sync_api")
BROWSER = os.environ.get("SVGDECK_BROWSER", "chromium")

FRAME = ('<rect data-layout="true" data-camera="true" visibility="hidden" fill="none" stroke="none" '
         'data-step="{step}" x="{x}" y="{y}" width="{w}" height="{h}"/>')


@pytest.fixture
def page(tmp_path):
    body = ('<rect id="mark" x="960" y="540" width="96" height="54"/>'
            + FRAME.format(step=1, x=960, y=540, w=960, h=540)      # the lower right quarter
            + '<rect id="late" data-step="2" x="10" y="10" width="10" height="10"/>'
            + FRAME.format(step=3, x=0, y=0, w=480, h=540)          # taller than the screen, at the edge
            + '<g transform="translate(100,50)">' + FRAME.format(step=4, x=-100, y=-50, w=1920, h=1080) + '</g>')
    deck = write_deck(tmp_path / "deck", [("a", SLIDE.format(color="#ffffff", body=body)),
                                          ("b", SLIDE.format(color="#ffffff", body=""))], {})
    out = export(Deck.load(deck), tmp_path / "out")
    with playwright.sync_playwright() as p:
        browser = getattr(p, BROWSER).launch()
        page = browser.new_page(viewport={"width": 960, "height": 540})
        errors = []
        page.on("pageerror", lambda e: errors.append(e))
        page.emulate_media(reduced_motion="reduce")  # moves land at once: boxes can be read right away
        page.goto((out / "index.html").as_uri())
        page.wait_for_function("document.querySelector('.svgdeck-ready')")
        yield page
        browser.close()
        assert not errors


def box(page, selector):
    return page.evaluate(f"""(() => {{ const r = document.querySelector({selector!r}).getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map(Math.round); }})()""")


def test_camera_zooms_to_its_frame_and_back(page):
    # The viewport is half the deck size, so the whole slide is 960 x 540.
    assert box(page, ".svgdeck-current") == [0, 0, 960, 540]
    assert box(page, "#s0-mark") == [480, 270, 48, 27]
    page.keyboard.press("ArrowRight")
    assert page.evaluate("svgdeck.svgdeck.state.step") == 1
    assert box(page, "#s0-mark") == [0, 0, 96, 54]            # the quarter fills the screen
    page.keyboard.press("ArrowRight")
    assert box(page, "#s0-mark") == [0, 0, 96, 54]            # a build without a frame keeps the view
    page.keyboard.press("ArrowRight")
    # A 480 x 540 frame fits by its height (2x) and may not show beyond the slide's left edge.
    assert box(page, ".svgdeck-current") == [0, 0, 1920, 1080]
    page.keyboard.press("ArrowRight")
    assert box(page, ".svgdeck-current") == [0, 0, 960, 540]  # a whole-slide frame (inside a moved group) zooms out
    page.keyboard.press("ArrowLeft")
    assert box(page, ".svgdeck-current") == [0, 0, 1920, 1080]
    page.keyboard.press("ArrowRight"); page.keyboard.press("ArrowRight")
    assert page.evaluate("svgdeck.svgdeck.state.index") == 1
    assert box(page, ".svgdeck-current") == [0, 0, 960, 540]
    page.keyboard.press("ArrowLeft")                           # back onto the last step of the first slide
    assert box(page, ".svgdeck-current") == [0, 0, 960, 540]


def test_camera_moves_glide_between_steps_only(tmp_path):
    body = FRAME.format(step=1, x=960, y=540, w=960, h=540)
    deck = write_deck(tmp_path / "deck", [("a", SLIDE.format(color="#ffffff", body=body)),
                                          ("b", SLIDE.format(color="#ffffff", body=FRAME.format(step=0, x=0, y=0, w=960, h=540)))], {})
    out = export(Deck.load(deck), tmp_path / "out")
    with playwright.sync_playwright() as p:
        browser = getattr(p, BROWSER).launch()
        page = browser.new_page(viewport={"width": 960, "height": 540})
        page.goto((out / "index.html").as_uri())
        page.wait_for_function("document.querySelector('.svgdeck-ready')")
        glides = "document.querySelector('.svgdeck-current').classList.contains('svgdeck-camera-glide')"
        page.keyboard.press("ArrowRight")
        assert page.evaluate(glides) is True
        page.wait_for_function("document.querySelector('.svgdeck-current').getBoundingClientRect().width > 1900")
        page.keyboard.press("ArrowRight")                      # a frame at step 0 is in force as the slide opens
        assert page.evaluate(glides) is False
        assert box(page, ".svgdeck-current") == [0, 0, 1920, 1080]
        browser.close()


def test_matte_frame_is_centred_and_covers_the_rest(tmp_path):
    # A square frame in the left half: fitted by height, centred, and the mark right of it is covered.
    body = ('<rect id="in" x="100" y="100" width="50" height="50" fill="#f00"/><rect id="out" x="700" y="300" width="50" height="50" fill="#f00"/>'
            + FRAME.format(step=1, x=0, y=0, w=540, h=540).replace('data-camera="true"', 'data-camera="matte"'))
    deck = write_deck(tmp_path / "deck", [("a", SLIDE.format(color="#ffffff", body=body))], {})
    out = export(Deck.load(deck), tmp_path / "out")
    with playwright.sync_playwright() as p:
        browser = getattr(p, BROWSER).launch()
        page = browser.new_page(viewport={"width": 960, "height": 540})
        page.emulate_media(reduced_motion="reduce")
        page.goto((out / "index.html").as_uri())
        page.wait_for_function("document.querySelector('.svgdeck-ready')")
        assert page.evaluate("getComputedStyle(document.querySelector('.svgdeck-matte')).opacity") == "0"
        page.keyboard.press("ArrowRight")
        # 540 slide units fill the 540 px screen height: the frame is 540 px wide, centred.
        assert box(page, ".svgdeck-matte") == [210, 0, 540, 540]
        assert box(page, "#s0-in") == [310, 100, 50, 50]
        assert box(page, "#s0-out") == [910, 300, 50, 50]
        clip = lambda x, y: page.screenshot(clip={"x": x, "y": y, "width": 40, "height": 40})
        blank = clip(800, 20)
        assert clip(915, 305) == blank       # the mark beside the frame is covered
        assert clip(315, 105) != blank       # the one inside it shows
        browser.close()
