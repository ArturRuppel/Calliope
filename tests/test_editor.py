"""The editor, end to end: a real server, headless Chromium, mouse gestures."""
import re
import socket
import threading
import time

import pytest
import uvicorn

from svgdeck.server import create_app
from svgdeck.store import Store

playwright = pytest.importorskip("playwright.sync_api")


@pytest.fixture
def server(tmp_path):
    Store(tmp_path).create_deck("talk", "A talk")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(tmp_path), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    while not srv.started:
        time.sleep(0.02)
    yield f"http://127.0.0.1:{port}", tmp_path
    srv.should_exit = True
    thread.join(5)


@pytest.fixture
def page(server):
    url, _ = server
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(e))
        page.goto(f"{url}/edit/talk")
        page.wait_for_function("document.getElementById('status').textContent.includes('Saved')")
        yield page
        browser.close()
        assert not errors


def to_screen(page, x, y):
    """Slide coordinates -> page coordinates."""
    return page.evaluate(f"""(() => {{ const e = svgdeckEditor.editor, r = e.page.getBoundingClientRect();
        return [r.left + {x} * e.zoom, r.top + {y} * e.zoom]; }})()""")


def drag(page, a, b, steps=8):
    page.mouse.move(*to_screen(page, *a))
    page.mouse.down()
    page.mouse.move(*to_screen(page, *b), steps=steps)
    page.mouse.up()


def saved_slide(page, server):
    page.wait_for_function("document.getElementById('status').textContent.includes('Saved')")
    page.evaluate("svgdeckEditor.flush()")
    page.wait_for_function("document.getElementById('status').textContent.includes('Saved')")
    _, data = server
    sid = page.evaluate("svgdeckEditor.state.current")
    return (data / "decks" / "talk" / "slides" / f"{sid}.svg").read_text()


def test_draw_move_resize_undo(page, server):
    page.keyboard.press("r")
    drag(page, (200, 200), (600, 400))
    svg = saved_slide(page, server)
    rect = re.search(r"<rect [^>]*style=\"fill[^>]*>", svg).group(0)
    assert 'x="200"' in rect and 'width="400"' in rect

    # Move it: geometry changes, no transform (baked).
    drag(page, (400, 300), (500, 350))
    svg = saved_slide(page, server)
    rect = re.search(r"<rect [^>]*style=\"fill[^>]*>", svg).group(0)
    assert 'x="300"' in rect and 'y="250"' in rect and "transform" not in rect

    # Resize from the bottom-right handle (corner keeps aspect ratio).
    drag(page, (700, 450), (900, 550))
    svg = saved_slide(page, server)
    rect = re.search(r"<rect [^>]*style=\"fill[^>]*>", svg).group(0)
    assert 'width="600"' in rect and 'height="300"' in rect

    page.keyboard.press("Control+z")
    svg = saved_slide(page, server)
    assert 'width="400"' in re.search(r"<rect [^>]*style=\"fill[^>]*>", svg).group(0)
    page.keyboard.press("Control+Shift+z")
    svg = saved_slide(page, server)
    assert 'width="600"' in re.search(r"<rect [^>]*style=\"fill[^>]*>", svg).group(0)


def test_background_is_not_selectable(page):
    page.mouse.click(*to_screen(page, 960, 540))
    assert page.evaluate("svgdeckEditor.editor.selection.length") == 0


def test_text_create_and_edit(page, server):
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, 300, 300))
    page.keyboard.type("Hello")
    page.keyboard.press("Enter")
    page.keyboard.type("world")
    page.keyboard.press("Escape")
    svg = saved_slide(page, server)
    assert "Hello</tspan>" in svg and "world</tspan>" in svg
    # Double-click edits it again.
    x, y = to_screen(page, 320, 290)
    page.mouse.click(x, y)
    page.mouse.click(x, y)
    page.wait_for_selector(".text-edit")
    page.keyboard.press("Control+a")
    page.keyboard.type("Changed")
    page.keyboard.press("Escape")
    svg = saved_slide(page, server)
    assert "Changed</tspan>" in svg and "Hello" not in svg


def test_pen_draws_a_smooth_path(page, server):
    page.keyboard.press("p")
    page.mouse.move(*to_screen(page, 100, 700))
    page.mouse.down()
    for i in range(1, 30):
        page.mouse.move(*to_screen(page, 100 + i * 20, 700 + 80 * ((i % 6) / 6)))
    page.mouse.up()
    svg = saved_slide(page, server)
    d = re.search(r'<path [^>]*d="([^"]+)"', svg).group(1)
    assert d.startswith("M") and "C" in d


def test_arrow_gets_a_marker(page, server):
    page.keyboard.press("a")
    drag(page, (100, 100), (500, 100))
    svg = saved_slide(page, server)
    assert re.search(r'<line [^>]*marker-end: url\(&quot;#arrow-|<line [^>]*marker-end: ?url\(#arrow-', svg)
    assert '<marker id="arrow-' in svg


def test_slides_add_duplicate_delete(page, server):
    _, data = server
    page.click("#slide-add")
    page.wait_for_function("svgdeckEditor.state.deck.slides.length === 2")
    page.keyboard.press("r")
    drag(page, (100, 100), (300, 300))
    saved_slide(page, server)
    page.click("#slide-dup")
    page.wait_for_function("svgdeckEditor.state.deck.slides.length === 3")
    assert "<rect " in saved_slide(page, server).split("background", 1)[1]
    page.once("dialog", lambda d: d.accept())
    page.click("#slide-del")
    page.wait_for_function("svgdeckEditor.state.deck.slides.length === 2")
    assert len(list((data / "decks" / "talk" / "trash").glob("*.svg"))) == 1


def test_upload_image(page, server, tmp_path):
    from PIL import Image
    png = tmp_path / "photo.png"
    Image.new("RGB", (400, 200), (200, 30, 30)).save(png)
    page.set_input_files("#media-file", str(png))
    page.wait_for_function("svgdeckEditor.editor.selection.length === 1")
    svg = saved_slide(page, server)
    href = re.search(r'<image [^>]*href="([^"]+)"', svg).group(1)
    assert href.startswith("../media/photo-") and href.endswith(".png")
    assert 'width="400"' in re.search(r"<image [^>]*>", svg).group(0)


def test_copy_paste(page, server):
    page.keyboard.press("e")
    drag(page, (100, 100), (300, 200))
    page.keyboard.press("Control+c")
    page.keyboard.press("Control+v")
    svg = saved_slide(page, server)
    assert svg.count("<ellipse") == 2


def test_edits_survive_reload(page, server):
    page.keyboard.press("r")
    drag(page, (100, 100), (300, 300))
    saved_slide(page, server)
    page.reload()
    page.wait_for_function("document.getElementById('status').textContent.includes('Saved')")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelectorAll('rect').length") == 2


def test_conflicting_save_is_refused(page, server):
    _, data = server
    sid = page.evaluate("svgdeckEditor.state.current")
    path = data / "decks" / "talk" / "slides" / f"{sid}.svg"
    path.write_text(path.read_text().replace("#ffffff", "#fefefe"))  # someone else edits
    page.keyboard.press("r")
    drag(page, (100, 100), (300, 300))
    page.wait_for_function("document.getElementById('status').textContent.includes('Conflict')")
    assert "#fefefe" in path.read_text() and "<rect x" not in path.read_text()
