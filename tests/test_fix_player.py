"""Regression tests for player, speaker and export fixes."""
import json
import os
import re
import stat
import zipfile

import pytest

from conftest import SLIDE, write_deck
from svgdeck.cli import main
from svgdeck.deck import Deck
from svgdeck.export import export


# --- export ---------------------------------------------------------------
def test_export_modes_follow_the_umask(tmp_path):
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body=""))])
    old = os.umask(0o022)
    try:
        out = export(Deck.load(root), tmp_path / "out", tmp_path / "out.zip")
    finally:
        os.umask(old)
    assert stat.S_IMODE(out.stat().st_mode) == 0o755
    assert stat.S_IMODE((out / "index.html").stat().st_mode) == 0o644
    assert stat.S_IMODE((tmp_path / "out.zip").stat().st_mode) == 0o644


def test_export_modes_with_a_private_umask(tmp_path):
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body=""))])
    old = os.umask(0o077)
    try:
        out = export(Deck.load(root), tmp_path / "out", tmp_path / "out.zip")
    finally:
        os.umask(old)
    assert stat.S_IMODE(out.stat().st_mode) == 0o700
    assert stat.S_IMODE((tmp_path / "out.zip").stat().st_mode) == 0o600


def notes_deck(tmp_path):
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body=""))])
    meta = json.loads((root / "deck.json").read_text())
    meta["slides"][0]["notes"] = "SECRET-TALKING-POINT"
    (root / "deck.json").write_text(json.dumps(meta))
    return root


def test_notes_are_included_by_default(tmp_path):
    out = export(Deck.load(notes_deck(tmp_path)), tmp_path / "out")
    assert "SECRET-TALKING-POINT" in (out / "index.html").read_text(encoding="utf-8")


def test_notes_can_be_left_out(tmp_path):
    out = export(Deck.load(notes_deck(tmp_path)), tmp_path / "out", include_notes=False)
    page = (out / "index.html").read_text(encoding="utf-8")
    assert "SECRET-TALKING-POINT" not in page
    data = json.loads(re.search(r'id="svgdeck-data">(.*?)</script>', page, re.S).group(1))
    assert all("notes" not in s for s in data["slides"])


def test_cli_no_notes_flag(tmp_path):
    root = notes_deck(tmp_path)
    main(["export", str(root), str(tmp_path / "a")])
    main(["export", str(root), str(tmp_path / "b"), "--no-notes"])
    assert "SECRET-TALKING-POINT" in (tmp_path / "a" / "index.html").read_text(encoding="utf-8")
    assert "SECRET-TALKING-POINT" not in (tmp_path / "b" / "index.html").read_text(encoding="utf-8")


def test_hyperlinks_are_not_media(tmp_path):
    body = ('<a href="other.html"><rect width="10" height="10"/></a>'
            '<a xlink:href="notes/x.pdf" xmlns:xlink="http://www.w3.org/1999/xlink"/>')
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body=body))])
    assert Deck.load(root).media_files() == set()
    export(Deck.load(root), tmp_path / "out")


def test_media_references_still_found_next_to_links(tmp_path):
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(
        color="#fff", body='<a href="x.html"/><image href="../media/p.png"/>'))])
    assert Deck.load(root).media_files() == {"media/p.png"}


def test_missing_slide_file_names_the_slide(tmp_path):
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body=""))])
    (root / "slides" / "a.svg").unlink()
    with pytest.raises(FileNotFoundError, match="slide 'a'"):
        export(Deck.load(root), tmp_path / "out")


def test_zip_stores_already_compressed_media(tmp_path):
    suffixes = (".webm", ".MOV", ".webp", ".avif", ".gif")
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(
        color="#fff", body="".join(f'<image href="../media/p{s}"/>' for s in suffixes)))])
    for s in suffixes:
        (root / "media" / f"p{s}").write_bytes(b"0" * 5000)
    export(Deck.load(root), tmp_path / "out", tmp_path / "out.zip")
    with zipfile.ZipFile(tmp_path / "out.zip") as z:
        kinds = {i.compress_type for i in z.infolist() if "media/" in i.filename}
        assert kinds == {zipfile.ZIP_STORED}
        assert z.getinfo("out/index.html").compress_type == zipfile.ZIP_DEFLATED


def test_export_is_utf8_whatever_the_locale(tmp_path, monkeypatch):
    import locale
    body = "<text>café →</text>"
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body=body))])
    (root / "slides" / "a.svg").write_text(SLIDE.format(color="#fff", body=body), encoding="utf-8")
    monkeypatch.setattr(locale, "getpreferredencoding", lambda *a, **k: "ascii")
    out = export(Deck.load(root), tmp_path / "out")
    assert "café →" in (out / "index.html").read_text(encoding="utf-8")


# --- player and speaker, in Chromium ----------------------------------------
playwright = pytest.importorskip("playwright.sync_api")
VIDEO = ('<image href="../media/clock.webm" data-video="../media/clock.webm" x="100" y="100" '
         'width="320" height="240"%s/>')


def svg(body, attrs=""):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" {attrs}>{body}</svg>'


@pytest.fixture
def open_deck(tmp_path, movie):
    """open_deck(slides, hash="", query="", raw=False, touch=False) -> page showing an export of the deck."""
    count = 0
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch()
        errors = []

        def make(slides, hash="", query="", raw=False, touch=False):
            nonlocal count
            count += 1
            root = write_deck(tmp_path / f"deck{count}", slides, {"clock.webm": movie})
            if raw:  # the page the server renders: slides are not parsed at all
                from svgdeck.deck import render_page
                (root / "index.html").write_text(render_page(Deck.load(root)), encoding="utf-8")
                out = root
            else:
                out = export(Deck.load(root), tmp_path / f"out{count}")
            page = browser.new_page(viewport={"width": 960, "height": 540}, has_touch=touch)
            page.on("pageerror", lambda e: errors.append(e))
            page.goto((out / "index.html").as_uri() + query + hash)
            page.wait_for_function("document.querySelector('.svgdeck-ready')")
            return page

        yield make
        browser.close()
        assert not errors


def pos(page):
    return page.evaluate("[svgdeck.svgdeck.state.index, svgdeck.svgdeck.state.step]")


def computed(page, element_id, prop):
    return page.evaluate("([id, prop]) => getComputedStyle(document.getElementById(id))[prop]", [element_id, prop])


FULLSCREEN_SPY = ("window.fs = 0; document.getElementById('svgdeck').requestFullscreen = "
                  "() => { window.fs++; return Promise.resolve(); }; 0")


# bug 1: slide CSS is prefixed and scoped
def test_slide_styles_do_not_leak_between_slides(open_deck):
    page = open_deck([
        ("a", svg('<style>.cls-1{fill:rgb(255,0,0)} #mark{opacity:.5} .x,.y{stroke:rgb(0,128,0)} '
                  '@media screen{.cls-1{stroke-width:7}}</style>'
                  '<defs><linearGradient id="g"/></defs>'
                  '<rect id="r" class="cls-1" width="10" height="10"/><rect id="mark" class="y" width="5" height="5"/>')),
        ("b", svg('<defs><style>.cls-1{fill:rgb(0,0,255)}</style></defs>'
                  '<rect id="r" class="cls-1" width="10" height="10"/><rect id="mark" width="5" height="5"/>')),
        ("c", svg('<rect id="r" class="cls-1" width="10" height="10"/><rect id="mark" class="y" width="5" height="5"/>')),
    ])
    assert computed(page, "s0-r", "fill") == "rgb(255, 0, 0)"
    assert computed(page, "s1-r", "fill") == "rgb(0, 0, 255)"
    assert computed(page, "s2-r", "fill") == "rgb(0, 0, 0)"  # no style of its own: untouched by the others
    assert computed(page, "s0-r", "strokeWidth") == "7px"
    assert computed(page, "s1-r", "strokeWidth") == "1px"
    assert computed(page, "s0-mark", "opacity") == "0.5"  # #mark became #s0-mark
    assert computed(page, "s1-mark", "opacity") == "1"
    assert computed(page, "s0-mark", "stroke") == "rgb(0, 128, 0)"
    assert computed(page, "s2-mark", "stroke") == "none"
    # The overview thumbnails are rewritten the same way.
    thumbs = page.evaluate("""Array.from(document.querySelectorAll('.svgdeck-overview-grid button svg')).map(
        s => getComputedStyle(s.querySelector('.cls-1')).fill)""")
    assert thumbs == ["rgb(255, 0, 0)", "rgb(0, 0, 255)", "rgb(0, 0, 0)"]


def test_url_references_in_style_text_are_prefixed(open_deck):
    page = open_deck([
        ("a", svg('<style>.f{fill:url(#g)}</style><defs><linearGradient id="g"/></defs><rect id="r" class="f" width="9" height="9"/>')),
        ("b", svg('<style>.f{fill:url("#g")}</style><defs><linearGradient id="g"/></defs><rect id="r" class="f" width="9" height="9"/>')),
    ])
    assert computed(page, "s0-r", "fill").endswith('#s0-g")')
    assert computed(page, "s1-r", "fill").endswith('#s1-g")')


def test_speaker_preview_styles_are_scoped(open_deck):
    page = open_deck([
        ("a", svg('<rect id="r" class="c" width="9" height="9"/>')),
        ("b", svg('<style>.c{fill:rgb(1,2,3)}</style><rect class="c" width="9" height="9"/>')),
    ], query="?speaker=1")
    assert page.evaluate("getComputedStyle(document.querySelector('.speaker-next .c')).fill") == "rgb(1, 2, 3)"
    assert computed(page, "s0-r", "fill") == "rgb(0, 0, 0)"


# bug 2: root presentation attributes
def test_root_presentation_attributes_reach_the_slide(open_deck):
    page = open_deck([("a", svg('<text id="t" x="10" y="100">hi</text><rect id="r" width="9" height="9"/>',
                                'font-family="Courier" font-size="40" font-weight="700" fill="rgb(9,8,7)" '
                                'xml:space="preserve" class="deck-root" id="rootid" width="1920" height="1080"'))])
    layer = page.locator(".svgdeck-current .svgdeck-layer")
    assert layer.get_attribute("font-family") == "Courier"
    assert layer.get_attribute("xml:space") == "preserve"
    assert "deck-root" in layer.get_attribute("class")
    assert layer.get_attribute("id") is None and layer.get_attribute("width") is None
    assert computed(page, "s0-t", "fontSize") == "40px"
    assert computed(page, "s0-t", "fontWeight") == "700"
    assert computed(page, "s0-r", "fill") == "rgb(9, 8, 7)"


# bug 17 (player half): hyperlinks stay as written
def test_relative_hyperlinks_are_left_alone(open_deck):
    page = open_deck([("a", svg('<a id="l" href="other.html"><rect width="9" height="9"/></a>'
                                '<a id="m" href="#r"><rect id="r" width="9" height="9"/></a>'))])
    assert page.evaluate("document.getElementById('s0-l').getAttribute('href')") == "other.html"
    assert page.evaluate("document.getElementById('s0-m').getAttribute('href')") == "#s0-r"


# bug 3: only the neighbouring slides keep their movies loaded
def test_distant_videos_are_unloaded(open_deck):
    page = open_deck([(f"s{i}", svg(VIDEO % "")) for i in range(6)])
    loaded = "Array.from(document.querySelectorAll('.svgdeck-slide')).map(s => s.querySelector('video').hasAttribute('src'))"
    assert page.evaluate(loaded) == [True, True, False, False, False, False]
    page.keyboard.press("End")
    assert page.evaluate(loaded) == [False, False, False, False, True, True]
    page.keyboard.press("Home")
    assert page.evaluate(loaded) == [True, True, False, False, False, False]
    video = page.locator(".svgdeck-slide >> nth=5 >> video")
    assert video.evaluate("v => [!!v.dataset.src, !!v.poster, v.preload]") == [True, True, "none"]


# bug 4 and 5: sync groups
def test_hidden_followers_are_not_seeked_every_frame(open_deck):
    page = open_deck([("a", svg(VIDEO % ' data-sync="g"')), ("b", svg(VIDEO % ' data-sync="g"'))])
    page.evaluate("""window.seeks = 0;
        document.querySelectorAll('.svgdeck-slide')[1].querySelector('video').addEventListener('seeking', () => window.seeks++)""")
    page.wait_for_function("document.querySelector('.svgdeck-current video').currentTime > 2")
    assert page.evaluate("window.seeks") <= 12  # a seek per frame would be about 50


def test_sync_time_survives_the_overview(open_deck):
    page = open_deck([("a", svg(VIDEO % ' data-sync="g"')), ("b", svg(VIDEO % ' data-sync="g"'))])
    page.wait_for_function("document.querySelector('.svgdeck-current video').currentTime > 1.5")
    page.keyboard.press("o")  # pauses the movie
    before = page.evaluate("document.querySelector('.svgdeck-current video').currentTime")
    page.get_by_role("button", name="Go to slide 2", exact=True).click()
    assert pos(page)[0] == 1
    assert page.evaluate("document.querySelector('.svgdeck-current video').currentTime") >= before - 0.2


# bug 6 and 11: keys
def test_escape_only_closes_the_overview(open_deck):
    page = open_deck([("a", svg("")), ("b", svg(""))])
    overview = page.get_by_role("dialog", name="Slide overview")
    page.keyboard.press("Escape")
    assert overview.is_hidden()
    page.keyboard.press("o")
    assert overview.is_visible()
    page.keyboard.press("Escape")
    assert overview.is_hidden()
    page.keyboard.press("Shift+O")
    assert overview.is_visible()
    page.keyboard.press("Shift+O")
    assert overview.is_hidden()


def test_capital_letter_keys(open_deck):
    page = open_deck([("a", svg("")), ("b", svg("")), ("c", svg(""))])
    page.keyboard.press("Shift+N")
    assert pos(page) == [1, 0]
    page.keyboard.press("Shift+P")
    assert pos(page) == [0, 0]
    page.evaluate(FULLSCREEN_SPY)
    page.keyboard.press("Shift+F")
    assert page.evaluate("window.fs") == 1


# bug 7: hashes
def test_unparseable_hash_does_not_reset_the_slide(open_deck):
    page = open_deck([("a", svg("")), ("b", svg("")), ("c", svg(""))])
    page.keyboard.press("ArrowRight")
    page.evaluate("location.hash = '#bogus'")
    page.wait_for_timeout(100)
    assert pos(page) == [1, 0]
    page.evaluate("location.hash = '#3'")
    page.wait_for_function("svgdeck.svgdeck.state.index === 2")


def test_unparseable_initial_hash_starts_at_slide_one(open_deck):
    page = open_deck([("a", svg("")), ("b", svg(""))], hash="#bogus")
    assert pos(page) == [0, 0]


# bug 8: a broken slide
@pytest.mark.parametrize("broken", ["<svg xmlns='http://www.w3.org/2000/svg'><rect></svg>",
                                    "<div xmlns='http://www.w3.org/1999/xhtml'>no svg here</div>"])
def test_broken_slide_gets_a_placeholder(open_deck, broken):
    page = open_deck([("a", svg('<rect id="ok" width="9" height="9"/>')), ("b", broken),
                      ("c", svg('<rect id="fine" width="9" height="9"/>'))], raw=True)
    assert page.evaluate("svgdeck.svgdeck.count") == 3
    assert page.locator(".svgdeck-overview-grid button").count() == 3
    page.keyboard.press("ArrowRight")
    assert pos(page) == [1, 0]
    assert page.locator(".svgdeck-current").inner_text() == "Slide 2 could not be loaded"
    assert page.locator(".svgdeck-current .svgdeck-error").is_visible()
    page.keyboard.press("ArrowRight")
    assert pos(page) == [2, 0]
    assert page.evaluate("document.getElementById('s2-fine').closest('.svgdeck-slide').classList.contains('svgdeck-current')")


def test_speaker_preview_of_a_broken_slide(open_deck):
    page = open_deck([("a", svg("")), ("b", "<svg xmlns='http://www.w3.org/2000/svg'><rect></svg>")],
                     query="?speaker=1", raw=True)
    assert page.locator(".speaker-next").inner_text() == "Slide 2 could not be loaded"


# bug 9: double-click goes fullscreen (mouse); touch taps always advance
def test_double_click_goes_fullscreen_without_advancing(open_deck):
    page = open_deck([("a", svg("")), ("b", svg("")), ("c", svg(""))])
    page.evaluate(FULLSCREEN_SPY)
    page.mouse.dblclick(480, 270)
    page.wait_for_timeout(600)
    assert pos(page) == [0, 0]  # never advanced, not even briefly
    assert page.evaluate("window.fs") == 1
    page.mouse.click(480, 270)  # a single click still advances, after the double-click window
    page.wait_for_function("svgdeck.svgdeck.state.index === 1")
    page.wait_for_timeout(500)
    page.mouse.click(480, 270)
    page.wait_for_function("svgdeck.svgdeck.state.index === 2")
    assert page.evaluate("window.fs") == 1


def test_a_double_click_never_shows_the_next_slide(open_deck):
    page = open_deck([("a", svg("")), ("b", svg(""))])
    page.evaluate("window.changes = 0; document.getElementById('svgdeck').addEventListener('svgdeck:change', () => window.changes++)")
    page.mouse.dblclick(480, 270)
    page.wait_for_timeout(600)
    assert page.evaluate("window.changes") == 0


def test_quick_touch_taps_advance_each_time(open_deck):
    page = open_deck([("a", svg("")), ("b", svg("")), ("c", svg("")), ("d", svg(""))], touch=True)
    page.evaluate(FULLSCREEN_SPY)
    page.touchscreen.tap(480, 270)
    page.touchscreen.tap(480, 270)
    assert pos(page) == [2, 0]
    page.touchscreen.tap(480, 270)
    assert pos(page) == [3, 0]
    page.wait_for_timeout(500)
    assert page.evaluate("window.fs") == 0  # touch never goes fullscreen by double-tap


# bug 10: touches
def pointer(page, kind, pointer_id, primary, x=480, y=270):
    page.evaluate("""([type, id, primary, x, y]) => document.getElementById('svgdeck').dispatchEvent(new PointerEvent(type,
        {bubbles: true, clientX: x, clientY: y, pointerType: 'touch', button: 0, pointerId: id, isPrimary: primary}))""",
                  [kind, pointer_id, primary, x, y])


def test_only_the_primary_pointer_taps(open_deck):
    page = open_deck([("a", svg("")), ("b", svg("")), ("c", svg(""))])
    pointer(page, "pointerdown", 2, False)
    pointer(page, "pointerup", 2, False)
    assert pos(page) == [0, 0]
    pointer(page, "pointerdown", 1, True)
    pointer(page, "pointerup", 5, True)  # not the finger that went down
    assert pos(page) == [0, 0]
    pointer(page, "pointerdown", 1, True)
    pointer(page, "pointerdown", 2, False)  # a second finger cancels the gesture
    pointer(page, "pointerup", 2, False)
    pointer(page, "pointerup", 1, True)
    assert pos(page) == [0, 0]
    pointer(page, "pointerdown", 1, True)
    pointer(page, "pointerup", 1, True)
    assert pos(page) == [1, 0]


# bug 12 and 13: the speaker window
def test_reloading_the_speaker_keeps_the_audience_attached(open_deck):
    page = open_deck([("a", svg("")), ("b", svg("")), ("c", svg(""))], query="?speaker=1")
    session = page.evaluate("new URL(location.href).searchParams.get('session')")
    assert session and "speaker=1" in page.url
    status = page.locator(".speaker-status")
    assert status.inner_text() == "Audience window: disconnected"
    with page.expect_popup() as popup:
        page.get_by_role("button", name="Open audience window").click()
    audience = popup.value
    audience.wait_for_function("document.querySelector('.svgdeck-ready')")
    page.wait_for_function("document.querySelector('.speaker-status').textContent === 'Audience window: connected'")
    page.reload()
    page.wait_for_function("document.querySelector('.svgdeck-ready')")
    assert page.evaluate("new URL(location.href).searchParams.get('session')") == session
    assert status.inner_text() == "Audience window: disconnected"
    before = len(page.context.pages)
    page.get_by_role("button", name="Open audience window").click()
    page.wait_for_function("document.querySelector('.speaker-status').textContent === 'Audience window: connected'")
    assert len(page.context.pages) == before  # the same window, not a second one
    page.locator(".speaker-actions").get_by_role("button", name="Next", exact=True).click()
    audience.wait_for_function("svgdeck.svgdeck.state.index === 1")


def test_speaker_timer_uses_the_wall_clock(open_deck):
    page = open_deck([("a", svg(""))], query="?speaker=1")
    page.evaluate("window.nowCalls = 0; const n = Date.now; Date.now = () => { window.nowCalls++; return n(); }")
    page.get_by_role("button", name="Pause timer").click()
    page.get_by_role("button", name="Reset timer").click()
    page.wait_for_timeout(700)
    assert page.evaluate("window.nowCalls") > 0


def test_a_quick_second_touch_is_kept_from_the_browser(open_deck):
    # Safari zooms the page on a double tap; the player cancels the second touchend.
    page = open_deck([("a", svg("")), ("b", svg("")), ("c", svg(""))], touch=True)
    cancelled = page.evaluate("""() => {
        const root = document.getElementById('svgdeck'), out = [];
        for (let i = 0; i < 2; i++) {
            const t = new Touch({identifier: i, target: root, clientX: 480, clientY: 270});
            const e = new TouchEvent('touchend', {bubbles: true, cancelable: true, changedTouches: [t]});
            root.dispatchEvent(e); out.push(e.defaultPrevented);
        }
        return out;
    }""")
    assert cancelled == [False, True]


def test_presenter_page_cannot_be_zoomed_by_the_browser(tmp_path):
    from svgdeck.deck import render_page
    root = write_deck(tmp_path / "d", [("a", SLIDE.format(color="#fff", body=""))])
    assert "user-scalable=no" in render_page(Deck.load(root))

