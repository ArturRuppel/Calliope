"""The editor, end to end: a real server, headless Chromium, mouse gestures."""
import os
import re
import socket
import threading
import time

import pytest
from conftest import select_several
import uvicorn

from svgdeck.server import create_app
from svgdeck.store import Store

playwright = pytest.importorskip("playwright.sync_api")
BROWSER = os.environ.get("SVGDECK_BROWSER", "chromium")  # webkit = the iPad's engine


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
        browser = getattr(p, BROWSER).launch()
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


def screen_tol(page):
    """Slide pixels two rounded pointer positions can be off by (WebKit rounds
    mouse events to whole screen pixels)."""
    return max(2, 2 / page.evaluate("svgdeckEditor.editor.zoom"))


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


def attrs(tag):
    return {k: float(v) for k, v in re.findall(r'\b(x|y|width|height)="([-\d.]+)"', tag)}


def main_rect(svg):
    return re.search(r"<rect [^>]*style=\"fill[^>]*>", svg).group(0)


def test_draw_move_resize_undo(page, server):
    page.keyboard.press("r")
    drag(page, (200, 200), (600, 400))
    a = attrs(main_rect(saved_slide(page, server)))
    assert a == pytest.approx({"x": 200, "y": 200, "width": 400, "height": 200}, abs=2)

    # Move it: geometry changes, no transform (baked).
    drag(page, (400, 300), (500, 350))
    rect = main_rect(saved_slide(page, server))
    assert attrs(rect) == pytest.approx({"x": 300, "y": 250, "width": 400, "height": 200}, abs=screen_tol(page))
    assert "transform" not in rect

    # Resize from the bottom-right handle (corner keeps aspect ratio).
    right, bottom = a["x"] + 100 + a["width"], a["y"] + 50 + a["height"]
    drag(page, (right, bottom), (right + 200, bottom + 100))
    assert attrs(main_rect(saved_slide(page, server))) == pytest.approx({"x": 300, "y": 250, "width": 600, "height": 300}, abs=5)

    page.keyboard.press("Control+z")
    assert attrs(main_rect(saved_slide(page, server)))["width"] == pytest.approx(400, abs=2)
    page.keyboard.press("Control+Shift+z")
    assert attrs(main_rect(saved_slide(page, server)))["width"] == pytest.approx(600, abs=5)


def test_background_is_not_selectable(page):
    page.mouse.click(*to_screen(page, 960, 540))
    assert page.evaluate("svgdeckEditor.editor.selection.length") == 0


def test_text_create_and_edit(page, server):
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, 300, 300))
    page.keyboard.type("Hello")
    page.keyboard.press("Enter")
    page.keyboard.type("world")
    page.keyboard.press("Control+Enter")
    svg = saved_slide(page, server)
    assert "Hello</tspan>" in svg and "world</tspan>" in svg
    # Double-click edits it again.
    x, y = to_screen(page, 320, 290)
    page.mouse.click(x, y)
    page.mouse.click(x, y)
    page.wait_for_selector(".text-edit")
    page.keyboard.press("Control+a")
    page.keyboard.type("Changed")
    page.keyboard.press("Control+Enter")
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
    page.click("#slide-menu-btn"); page.click("#slide-dup")
    page.wait_for_function("svgdeckEditor.state.deck.slides.length === 3")
    assert "<rect " in saved_slide(page, server).split("background", 1)[1]
    page.once("dialog", lambda d: d.accept())
    page.click("#slide-menu-btn"); page.click("#slide-del")
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
    assert attrs(re.search(r"<image [^>]*>", svg).group(0))["width"] == 400


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


# --- bugs reported from the iPad (2026-09-26) ------------------------------------------
def dark_pixels(page, x, y, r=40):
    """Dark pixels in a square around a slide point (what is actually drawn)."""
    from io import BytesIO
    from PIL import Image
    sx, sy = to_screen(page, x, y)
    zoom = page.evaluate("svgdeckEditor.editor.zoom")
    half = max(4, r * zoom)
    png = page.screenshot(clip={"x": sx - half, "y": sy - half, "width": 2 * half, "height": 2 * half})
    im = Image.open(BytesIO(png)).convert("L")
    return sum(1 for v in im.getdata() if v < 100)


def panel_button(page, label):
    page.locator("#panel button", has_text=label).first.click()


def test_single_arrowhead_appears(page, server):
    page.keyboard.press("l")
    drag(page, (300, 500), (1300, 500))
    # Zoomed in, so the counts do not depend on how much room the editor's chrome leaves.
    page.evaluate("svgdeckEditor.editor.zoomAt(...%s, 1.6)" % to_screen(page, 800, 500))
    # With the selection showing, as on the iPad: the end handles sit on the line ends.
    end, start = dark_pixels(page, 1300, 500), dark_pixels(page, 300, 500)
    panel_button(page, "End")
    page.wait_for_timeout(100)
    assert dark_pixels(page, 1300, 500) - end > 25, "end arrowhead not drawn"
    assert dark_pixels(page, 300, 500) - start < 5, "start got an arrowhead too"


def test_arrowhead_follows_line_colour(page, server):
    page.keyboard.press("a")
    drag(page, (300, 500), (1300, 500))
    page.locator("#panel .swatch[title='#d62728']").nth(1).click()  # second colour row: the line
    svg = saved_slide(page, server)
    marker = re.search(r'marker-end: url\(&quot;#([^&]+)&quot;\)|marker-end: ?url\(#([^)]+)\)', svg)
    mid = marker.group(1) or marker.group(2)
    tip = re.search(rf'<marker id="{mid}"[^>]*>.*?</marker>', svg, re.S).group(0)
    assert re.search(r'fill="(#d62728|rgb\(214, 39, 40\))"', tip)


def test_fill_colour_changes(page, server):
    page.keyboard.press("r")
    drag(page, (200, 200), (600, 400))
    page.locator("#panel .swatch[title='#d62728']").first.click()
    assert page.evaluate("getComputedStyle(svgdeckEditor.editor.selection[0]).fill") == "rgb(214, 39, 40)"
    # The panel shows the new colour as chosen.
    assert page.locator("#panel .swatch.on").first.get_attribute("title") == "#d62728"


def test_imported_text_colour_changes(page, server):
    # Like the Inkscape import: the text element says white, the spans say black.
    page.evaluate("""(() => { const e = svgdeckEditor.editor;
      e.change(() => {
        const ns = 'http://www.w3.org/2000/svg', t = document.createElementNS(ns, 'text');
        t.setAttribute('style', 'font-size:40px;fill:#ffffff');
        const line = document.createElementNS(ns, 'tspan'); line.setAttribute('x', '200'); line.setAttribute('y', '300');
        const a = document.createElementNS(ns, 'tspan'); a.setAttribute('style', 'fill:#000000'); a.textContent = 'Mostly ';
        const b = document.createElementNS(ns, 'tspan'); b.setAttribute('style', 'fill:#000000;font-weight:700'); b.textContent = 'bold';
        line.append(a, b); t.append(line); e.svg.append(t); e.selection = [t];
      }); })()""")
    page.evaluate("svgdeckEditor.editor.select(svgdeckEditor.editor.selection)")
    assert page.locator("#panel .swatch.on").first.get_attribute("title") == "#000000"
    page.locator("#panel .swatch[title='#d62728']").first.click()
    fills = page.evaluate("Array.from(svgdeckEditor.editor.svg.querySelectorAll('text tspan tspan')).map(s => getComputedStyle(s).fill)")
    assert fills == ["rgb(214, 39, 40)", "rgb(214, 39, 40)"]


def test_alignment_keeps_the_text_box_in_place(page, server):
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, 400, 300))
    page.keyboard.type("A much longer first line")
    page.keyboard.press("Enter")
    page.keyboard.type("short")
    page.keyboard.press("Control+Enter")
    box = lambda: page.evaluate("(() => { const b = svgdeckEditor.editor.selection[0].getBBox(); return [b.x, b.width]; })()")
    # Screen position (WebKit has no getBBox for tspans).
    short_left = lambda: page.evaluate("svgdeckEditor.editor.selection[0].querySelectorAll('tspan')[1].getBoundingClientRect().left / svgdeckEditor.editor.zoom")
    x0, w0 = box()
    left0 = short_left()
    for label, expect in (("Centre", x0 + w0 / 2), ("Right", x0 + w0), ("Left", x0)):
        panel_button(page, label)
        x, w = box()
        assert x == pytest.approx(x0, abs=2) and w == pytest.approx(w0, abs=2), f"{label} moved the text box"
    panel_button(page, "Centre")
    assert short_left() > left0 + 50, "short line not centred under the long one"


def add_scaled_group(page):
    """A group scaled 2x and moved, like much of the imported talk."""
    page.evaluate("""(() => { const e = svgdeckEditor.editor, ns = 'http://www.w3.org/2000/svg';
      e.change(() => {
        const g = document.createElementNS(ns, 'g'); g.setAttribute('transform', 'matrix(2,0,0,2,100,50)');
        const r = document.createElementNS(ns, 'rect');
        for (const [k, v] of Object.entries({x: 50, y: 50, width: 100, height: 50, fill: '#888', stroke: '#000', 'stroke-width': 1}))
          r.setAttribute(k, v);
        g.append(r); e.svg.append(g); e.selection = [g];
      }); })()""")


def test_drawing_inside_a_scaled_group_lands_where_drawn(page, server):
    add_scaled_group(page)
    page.evaluate("svgdeckEditor.editor.enterGroup(svgdeckEditor.editor.selection[0])")
    page.keyboard.press("r")
    drag(page, (800, 600), (1000, 700))
    box = page.evaluate("""(() => { const e = svgdeckEditor.editor, el = e.selection[0];
      const r = el.getBoundingClientRect(), p = e.page.getBoundingClientRect();
      return [(r.left - p.left) / e.zoom, (r.top - p.top) / e.zoom, r.width / e.zoom, r.height / e.zoom,
              el.parentNode.localName]; })()""")
    assert box[4] == "g"
    assert box[:4] == pytest.approx([800, 600, 200, 100], abs=6)  # includes the stroke


def test_stroke_width_is_in_slide_pixels(page, server):
    add_scaled_group(page)
    page.evaluate("svgdeckEditor.editor.enterGroup(svgdeckEditor.editor.selection[0])")
    page.evaluate("svgdeckEditor.editor.select([svgdeckEditor.editor.context.querySelector('rect')])")
    width = page.locator("#panel .row", has_text="Width").locator("input")
    assert float(width.input_value()) == pytest.approx(2)  # 1 unit, drawn 2x
    width.fill("8")
    width.press("Enter")
    assert page.evaluate("svgdeckEditor.editor.strokeWidthOf(svgdeckEditor.editor.selection[0])") == pytest.approx(8)


def test_dragging_a_line_end(page, server):
    page.keyboard.press("l")
    drag(page, (300, 500), (900, 500))
    drag(page, (900, 500), (900, 800))
    svg = saved_slide(page, server)
    line = re.search(r"<line [^>]*>", svg).group(0)
    ends = {k: float(v) for k, v in re.findall(r'\b(x1|y1|x2|y2)="([-\d.]+)"', line)}
    assert ends == pytest.approx({"x1": 300, "y1": 500, "x2": 900, "y2": 800}, abs=3)


def test_copy_paste_buttons_across_slides(page, server):
    page.keyboard.press("e")
    drag(page, (100, 100), (300, 200))
    page.click("#object-actions")
    page.locator("#context-menu").get_by_role("menuitem", name="Copy").click()
    page.click("#slide-add")
    page.wait_for_function("svgdeckEditor.state.deck.slides.length === 2")
    page.locator("#panel").get_by_role("button", name="Paste", exact=True).click()
    assert "<ellipse" in saved_slide(page, server)


def test_paste_on_another_slide_keeps_the_place_and_beside_the_original_steps_aside(page, server):
    page.keyboard.press("e")
    drag(page, (100, 100), (300, 200))
    box = "(() => { const e = svgdeckEditor.editor, b = e.selectionGeometry(); return [b.x, b.y, b.width, b.height]; })()"
    original = page.evaluate(box)
    page.keyboard.press("Control+c")
    page.keyboard.press("Control+v")  # the original is under it: steps aside
    first = page.evaluate(box)
    assert first[0] == pytest.approx(original[0] + 24) and first[1] == pytest.approx(original[1] + 24)
    page.keyboard.press("Control+v")  # both are under it: steps again
    assert page.evaluate(box)[0] == pytest.approx(original[0] + 48)
    page.click("#slide-add")
    page.wait_for_function("svgdeckEditor.state.deck.slides.length === 2")
    page.keyboard.press("Control+v")
    assert page.evaluate(box) == pytest.approx(original)


def test_editing_imported_rich_text_keeps_its_font_and_size(page, server):
    page.evaluate("""(() => { const e = svgdeckEditor.editor, ns = 'http://www.w3.org/2000/svg';
      e.change(() => {
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('style', 'font-size:10px;font-family:serif;fill:#ffffff');
        t.setAttribute('transform', 'matrix(4,0,0,4,0,0)');
        const lines = [['Mostly ', 'imaging'], ['Second ', 'line']].map(([a, b], i) => {
          const line = document.createElementNS(ns, 'tspan'); line.setAttribute('x', '50'); line.setAttribute('y', String(80 + i * 15));
          const s1 = document.createElementNS(ns, 'tspan'); s1.setAttribute('style', 'font-family:monospace;font-size:12px;fill:#123456'); s1.textContent = a;
          const s2 = document.createElementNS(ns, 'tspan'); s2.setAttribute('style', 'font-family:monospace;font-size:12px;font-weight:700;fill:#123456'); s2.textContent = b;
          line.append(s1, s2); return line;
        });
        t.append(...lines); e.svg.append(t); e.selection = [t];
      }); })()""")
    page.on("dialog", lambda d: pytest.fail(f"unexpected dialog: {d.message}"))
    page.keyboard.press("Enter")  # edit the selected text
    page.wait_for_selector(".text-edit")
    page.keyboard.press("End")
    page.keyboard.type(" data")
    page.keyboard.press("Control+Enter")
    t = page.evaluate("""(() => { const t = svgdeckEditor.editor.svg.querySelector('text'), s = t.querySelector('tspan');
      const cs = getComputedStyle(s);
      return [cs.fontFamily, cs.fontSize, cs.fill, Array.from(t.querySelectorAll('tspan')).map(x => [x.textContent, x.getAttribute('y')])]; })()""")
    assert t[0] == "monospace" and t[1] == "12px" and t[2] == "rgb(18, 52, 86)"
    assert t[3][0::2] == [["Mostly imaging", "80"], ["Second line data", "95"]]  # line spacing kept
    # The bold words stay bold, the others don't.
    bold = page.evaluate("""Array.from(svgdeckEditor.editor.svg.querySelectorAll('text tspan tspan'))
      .map(s => [s.textContent, getComputedStyle(s).fontWeight])""")
    assert bold == [["imaging", "700"], ["line data", "700"]]  # typing continues the bold
    plain = page.evaluate("getComputedStyle(svgdeckEditor.editor.svg.querySelector('text tspan')).fontWeight")
    assert plain == "400"


def exact(label):
    return re.compile(rf"^{re.escape(label)}$")


def button(page, label):
    page.locator("#panel button").filter(has_text=exact(label)).first.click()


def bar(page, label):
    """A button in the bar over the selection."""
    page.locator("#sel-bar button").filter(has_text=exact(label)).first.click()


def align(page, title):
    """Align from the selection bar: its Align button opens the alignment row."""
    if page.locator("#align-row").is_hidden():
        bar(page, "Align")
    page.get_by_title(title, exact=True).click()


def add_rects(page, boxes):
    page.evaluate(f"""(() => {{ const e = svgdeckEditor.editor, ns = 'http://www.w3.org/2000/svg';
      e.change(() => {{ for (const [x, y, w, h] of {boxes}) {{
        const r = document.createElementNS(ns, 'rect');
        for (const [k, v] of Object.entries({{x, y, width: w, height: h, fill: '#888'}})) r.setAttribute(k, v);
        e.svg.append(r); }} }}); }})()""")


def rect_boxes(page):
    return page.evaluate("""Array.from(svgdeckEditor.editor.svg.querySelectorAll('rect:not([data-locked])'))
      .map(r => { const b = r.getBBox(), m = r.getCTM(), s = svgdeckEditor.editor.svg.getCTM().inverse().multiply(m);
                  return [Math.round(b.x + s.e), Math.round(b.y + s.f), Math.round(b.width), Math.round(b.height)]; })""")


def rect_boxes_rotated(page):
    """Slide-space bounding boxes, which stay right for rotated rects."""
    return page.evaluate("""Array.from(svgdeckEditor.editor.svg.querySelectorAll('rect:not([data-locked])'))
      .map(r => { const b = r.getBBox(), m = svgdeckEditor.editor.svg.getCTM().inverse().multiply(r.getCTM());
                  const p = [[b.x, b.y], [b.x + b.width, b.y + b.height], [b.x, b.y + b.height], [b.x + b.width, b.y]]
                    .map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
                  const xs = p.map(q => q.x), ys = p.map(q => q.y);
                  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)].map(Math.round); })""")


def test_bold_on_selected_words_while_editing(page, server):
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, 300, 300))
    page.keyboard.type("plain strong")
    for _ in "strong":
        page.keyboard.press("Shift+ArrowLeft")
    page.get_by_title("Bold (Ctrl+B)", exact=True).click()
    assert page.locator(".text-edit").count() == 1, "the bar ended the edit"
    page.keyboard.press("End")
    page.keyboard.type("!")
    page.get_by_role("button", name="Done", exact=True).click()
    words = page.evaluate("""Array.from(svgdeckEditor.editor.svg.querySelectorAll('text tspan tspan'))
      .map(s => [s.textContent, getComputedStyle(s).fontWeight])""")
    assert words and words[0][0].startswith("strong") and int(words[0][1]) >= 700
    line = page.evaluate("svgdeckEditor.editor.svg.querySelector('text tspan').textContent")
    assert line == "plain strong!"
    assert "font-weight: 700" in saved_slide(page, server) or "font-weight:700" in saved_slide(page, server)


def test_whole_text_weight_keeps_bold_words(page, server):
    page.evaluate("""(() => { const e = svgdeckEditor.editor, ns = 'http://www.w3.org/2000/svg';
      e.change(() => {
        const t = document.createElementNS(ns, 'text'); t.setAttribute('style', 'font-size:40px;font-weight:400');
        const line = document.createElementNS(ns, 'tspan'); line.setAttribute('x', '200'); line.setAttribute('y', '300');
        const b = document.createElementNS(ns, 'tspan'); b.setAttribute('style', 'font-weight:700'); b.textContent = 'bold';
        line.append('plain ', b); t.append(line); e.svg.append(t); e.selection = [t];
      }); e.select(e.selection); })()""")
    page.evaluate("svgdeckEditor.editor.setStyle('font-weight', '300')")
    got = page.evaluate("""(() => { const t = svgdeckEditor.editor.svg.querySelector('text');
      return [getComputedStyle(t.querySelector('tspan')).fontWeight, getComputedStyle(t.querySelector('tspan tspan')).fontWeight]; })()""")
    assert got == ["300", "700"]


def test_grid_snaps_new_and_moved_shapes(page, server):
    page.evaluate("localStorage.clear()")
    page.locator("#panel label", has_text="Snap to grid").click()
    page.locator("#panel .row", has_text="Spacing").locator("input").fill("50")
    page.locator("#panel .row", has_text="Spacing").locator("input").dispatch_event("change")
    assert page.evaluate("svgdeckEditor.editor.grid") == {"show": False, "snap": True, "size": 50}
    page.keyboard.press("r")
    drag(page, (103, 97), (251, 212))
    assert rect_boxes(page) == [[100, 100, 150, 100]]
    drag(page, (170, 150), (237, 181))  # by (67, 31): snaps to (50, 50)... or the nearer edge
    x, y, w, h = rect_boxes(page)[0]
    assert x % 50 == 0 and y % 50 == 0 and (w, h) == (150, 100)
    # The toolbar toggle turns it off; then moves are free again.
    page.click("#snap")
    drag(page, (x + 20, y + 20), (x + 33, y + 27))
    nx, ny = rect_boxes(page)[0][:2]
    assert abs(nx - (x + 13)) <= 3 and abs(ny - (y + 7)) <= 3 and (nx % 50, ny % 50) != (0, 0)


def test_select_several_by_tapping_then_group_and_ungroup(page, server):
    add_rects(page, [[100, 100, 100, 100], [400, 100, 100, 100], [700, 400, 100, 100]])
    select_several(page)
    for x, y in ((150, 150), (450, 150), (750, 450)):
        page.mouse.click(*to_screen(page, x, y))
    assert page.evaluate("svgdeckEditor.editor.selection.length") == 3
    page.mouse.click(*to_screen(page, 750, 450))  # a tap on a selected one takes it out
    assert page.evaluate("svgdeckEditor.editor.selection.length") == 2
    bar(page, "Group")
    assert page.evaluate("svgdeckEditor.editor.selection.map(e => e.localName)") == ["g"]
    assert page.evaluate("svgdeckEditor.editor.svg.querySelectorAll(':scope > g > rect').length") == 2
    bar(page, "Ungroup")
    assert page.evaluate("svgdeckEditor.editor.selection.length") == 2
    assert page.evaluate("svgdeckEditor.editor.svg.querySelectorAll('g').length") == 0


def test_align_and_distribute(page, server):
    add_rects(page, [[100, 100, 100, 100], [300, 250, 50, 50], [900, 500, 100, 200]])
    page.evaluate("svgdeckEditor.editor.selectAll()")
    align(page, "Align left edges")
    assert [b[0] for b in rect_boxes(page)] == [100, 100, 100]
    align(page, "Align bottom edges")
    assert [b[1] + b[3] for b in rect_boxes(page)] == [700, 700, 700]
    page.evaluate("(() => { const e = svgdeckEditor.editor; e.change(() => { const r = e.svg.querySelectorAll('rect:not([data-locked])'); "
                  "r[1].setAttribute('x', 500); r[2].setAttribute('x', 1500); }); })()")
    page.locator("#align-row").get_by_role("button", name="Across", exact=True).click()
    boxes = sorted(rect_boxes(page))
    gaps = [boxes[i + 1][0] - boxes[i][0] - boxes[i][2] for i in range(2)]
    assert abs(gaps[0] - gaps[1]) <= 1 and boxes[0][0] == 100 and boxes[2][0] == 1500
    # One object aligns with the slide.
    page.mouse.click(*to_screen(page, 150, 650))
    align(page, "Align centres")
    b = [b for b in rect_boxes(page) if b[2] == 100 and b[3] == 100][0]
    assert b[0] == 910


def test_rotate_and_flip(page, server):
    add_rects(page, [[100, 100, 200, 100], [500, 100, 100, 100]])
    page.evaluate("svgdeckEditor.editor.selectAll()")

    def menu(name):
        page.click("#object-actions")
        page.locator("#context-menu").get_by_role("menuitem", name=name).click()

    # Flipping mirrors the pair around their shared centre (x 100..600) and keeps plain rects.
    menu("Flip horizontal")
    assert sorted(rect_boxes(page)) == [[100, 100, 100, 100], [400, 100, 200, 100]]
    assert "transform" not in saved_slide(page, server)
    # A quarter turn turns the pair as one piece around its centre (350, 150).
    menu("Rotate 90° right")
    assert page.evaluate("svgdeckEditor.editor.selection.map(e => Math.round(svgdeckEditor.editor.angleOf(e)))") == [90, 90]
    assert sorted(rect_boxes_rotated(page)) == [[300, -100, 100, 100], [300, 200, 100, 200]]
    # The angle field turns each object around its own centre.
    page.get_by_role("tab", name="Design").click()
    field = page.locator("#panel section", has_text="Rotate and flip").locator("input[type=number]")
    assert field.input_value() == "90"
    field.fill("30")
    field.dispatch_event("change")
    assert page.evaluate("svgdeckEditor.editor.selection.map(e => Math.round(svgdeckEditor.editor.angleOf(e)))") == [30, 30]
    # A mirror counts as a left-right flip, so a vertical flip adds half a turn.
    page.locator("#panel").get_by_title("Flip vertical", exact=True).click()
    assert page.evaluate("svgdeckEditor.editor.selection.map(e => Math.round(svgdeckEditor.editor.angleOf(e)))") == [150, 150]
    for _ in range(4):
        page.keyboard.press("Control+z")
    assert sorted(rect_boxes(page)) == [[100, 100, 200, 100], [500, 100, 100, 100]]


def test_saving_does_not_fetch_media_from_the_wrong_place(page, server):
    urls = []
    page.on("request", lambda r: urls.append(r.url))
    page.evaluate("""(() => { const e = svgdeckEditor.editor, ns = 'http://www.w3.org/2000/svg';
      e.change(() => { const i = document.createElementNS(ns, 'image');
        for (const [k, v] of Object.entries({href: e.hooks.hrefIn('../media/pic.png'), width: 100, height: 100})) i.setAttribute(k, v);
        e.svg.append(i); e.selection = [i]; }); })()""")
    page.evaluate("svgdeckEditor.editor.moveBy(10, 10)")
    saved_slide(page, server)
    page.wait_for_timeout(200)
    assert not [u for u in urls if "/media/" in u and "/d/talk/media/" not in u]


def test_editing_keeps_subscripts_and_stroke_overrides(page, server):
    # Like the import: the text has a stroke that its spans turn off, and a subscript.
    page.evaluate("""(() => { const e = svgdeckEditor.editor, ns = 'http://www.w3.org/2000/svg';
      e.change(() => {
        const t = document.createElementNS(ns, 'text'); t.setAttribute('style', 'font-size:40px;stroke:#000;stroke-width:3');
        const line = document.createElementNS(ns, 'tspan'); line.setAttribute('x', '200'); line.setAttribute('y', '300');
        line.setAttribute('style', 'stroke:none');
        const sub = document.createElementNS(ns, 'tspan'); sub.setAttribute('style', 'font-size:65%;baseline-shift:sub'); sub.textContent = 'l2';
        line.append('T', sub); t.append(line); e.svg.append(t); e.selection = [t];
      }); e.select(e.selection); })()""")
    page.keyboard.press("Enter")
    page.wait_for_selector(".text-edit")
    page.keyboard.press("Home")
    page.keyboard.type("x")
    page.keyboard.press("Control+Enter")
    got = page.evaluate("""(() => { const t = svgdeckEditor.editor.svg.querySelector('text'), s = t.querySelector('tspan tspan');
      return [t.textContent, s && s.textContent, s && getComputedStyle(s).baselineShift, getComputedStyle(t.querySelector('tspan')).stroke]; })()""")
    assert got == ["xTl2", "l2", "sub", "none"]


def test_objects_off_the_slide_stay_visible_and_selectable(page):
    add_rects(page, [[-400, 300, 250, 200]])
    page.evaluate("svgdeckEditor.editor.select([]); svgdeckEditor.editor.zoomBy(0.5)")
    x, y = to_screen(page, -275, 400)
    assert page.evaluate(f"document.elementFromPoint({x}, {y}).localName") == "rect"
    assert page.evaluate("getComputedStyle(svgdeckEditor.editor.svg).overflow") == "visible"
    page.mouse.click(x, y)
    assert page.evaluate("svgdeckEditor.editor.selection[0]?.getAttribute('x')") == "-400"
    # Faded outside the slide; the thumbnail (like the presenter) still clips.
    assert page.locator(".overlay .ov-offpage").count() == 1
    assert page.evaluate("getComputedStyle(document.querySelector('.thumbs .thumb svg')).overflow") != "visible"


def test_editing_a_centred_text_keeps_it_centred(page, server):
    # Typing moves the anchor attribute into the style; ending the edit must
    # not lose it and redraw the text starting at its centre point.
    page.evaluate("""(() => { const e = svgdeckEditor.editor, ns = 'http://www.w3.org/2000/svg';
      e.change(() => {
        const t = document.createElementNS(ns, 'text');
        for (const [k, v] of [['x', '960'], ['y', '500'], ['font-size', '40'], ['text-anchor', 'middle']]) t.setAttribute(k, v);
        t.textContent = 'Centred'; e.svg.append(t); e.selection = [t];
      }); })()""")
    before = page.evaluate("(() => { const b = svgdeckEditor.editor.svg.querySelector('text').getBBox(); return b.x + b.width / 2; })()")
    assert abs(before - 960) < 1
    page.keyboard.press("Enter")
    page.wait_for_selector(".text-edit")
    page.keyboard.press("End")
    page.keyboard.type(" text")
    page.keyboard.press("Control+Enter")
    after = page.evaluate("""(() => { const t = svgdeckEditor.editor.svg.querySelector('text'), b = t.getBBox();
      return [t.textContent, getComputedStyle(t).textAnchor, b.x + b.width / 2]; })()""")
    assert after[0] == "Centred text" and after[1] == "middle"
    assert abs(after[2] - 960) < 1
