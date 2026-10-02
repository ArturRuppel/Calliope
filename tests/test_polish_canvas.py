"""Canvas polish: guides to the slide, resizing from the centre, Shift angles in
the Bézier tool, the text tool on existing text, the numeric geometry, nudge
and corner radius API, and stroke styles."""
import math

import pytest
from test_editor import page, server, to_screen, drag, add_rects, saved_slide

NS = "http://www.w3.org/2000/svg"


def js(page, body, arg=None):
    """Run a function body with e = the editor (and arg)."""
    return page.evaluate(f"(arg) => {{ const e = svgdeckEditor.editor; {body} }}", arg)


def last_rect(page):
    return "[...svgdeckEditor.editor.svg.querySelectorAll('rect:not([data-locked])')].at(-1)"


def rect_xywh(page):
    return page.evaluate(f"(() => {{ const r = {last_rect(page)}; return ['x','y','width','height'].map(a => +r.getAttribute(a)); }})()")


def undo_depth(page):
    return page.evaluate("svgdeckEditor.state.slides.get(svgdeckEditor.state.current).undo.length")


def guides(page):
    return page.evaluate("""[...document.querySelectorAll('.overlay .ov-smart-guide')].map(l =>
      ({x1: +l.getAttribute('x1'), y1: +l.getAttribute('y1'), x2: +l.getAttribute('x2'), y2: +l.getAttribute('y2')}))""")


def select_last_rect(page):
    page.evaluate(f"svgdeckEditor.editor.select([{last_rect(page)}])")


# --- 1. guides to the slide ----------------------------------------------------------------------

def test_move_snaps_to_the_slide_centre_and_edge_with_a_guide(page, server):
    add_rects(page, [[100, 100, 100, 100]])
    select_last_rect(page)
    # The centre lands 5 px short of the slide's vertical centre line.
    page.mouse.move(*to_screen(page, 150, 150))
    page.mouse.down()
    page.mouse.move(*to_screen(page, 955, 150), steps=8)
    shown = guides(page)
    assert any(g["x1"] == pytest.approx(960) and g["x2"] == pytest.approx(960) for g in shown)
    # The slide's guide runs from its top to its bottom.
    centre = next(g for g in shown if g["x1"] == pytest.approx(960))
    assert sorted([centre["y1"], centre["y2"]]) == pytest.approx([0, 1080])
    page.mouse.up()
    assert rect_xywh(page)[0] == pytest.approx(910, abs=0.01)
    assert guides(page) == []

    # The left edge lands 5 px from the slide's left edge, the top 4 px below its top.
    page.mouse.move(*to_screen(page, 960, 150))
    page.mouse.down()
    page.mouse.move(*to_screen(page, 55, 54), steps=8)
    assert {(round(g["x1"]), round(g["x2"])) for g in guides(page)} >= {(0, 0)}
    page.mouse.up()
    assert rect_xywh(page)[:2] == pytest.approx([0, 0], abs=0.01)

    # Alt bypasses the slide's guides too.
    page.keyboard.down("Alt")
    drag(page, (50, 50), (957, 55))
    page.keyboard.up("Alt")
    assert rect_xywh(page)[:2] == pytest.approx([907, 5], abs=1.2)


def test_frames_in_smart_snap_delta(page):
    result = page.evaluate("""async () => {
      const {smartSnapDelta} = await import('/editor/geom.js');
      const slide = {x: 0, y: 0, width: 1920, height: 1080};
      return [smartSnapDelta({x: 900, y: 300, width: 100, height: 100}, 5, 0, [], 8, [slide]),
              smartSnapDelta({x: 900, y: 300, width: 100, height: 100}, 5, 0, [], 8, [])];
    }""")
    snapped, plain = result
    assert snapped["dx"] == pytest.approx(10)  # centre 950+5 -> 960
    assert snapped["guides"][0]["frame"] is True and snapped["guides"][0]["kind"] == "align"
    assert plain["dx"] == 5 and plain["guides"] == []


def test_resize_snaps_the_dragged_edge_to_the_slide_and_to_siblings(page, server):
    add_rects(page, [[400, 400, 300, 100], [1200, 700, 100, 100]])
    page.evaluate("svgdeckEditor.editor.select([svgdeckEditor.editor.svg.querySelectorAll('rect:not([data-locked])')[0]])")
    first = "svgdeckEditor.editor.svg.querySelectorAll('rect:not([data-locked])')[0]"
    # The east edge goes to 955: it snaps to the slide's centre line.
    page.mouse.move(*to_screen(page, 700, 450))
    page.mouse.down()
    page.mouse.move(*to_screen(page, 955, 450), steps=8)
    assert any(g["x1"] == pytest.approx(960) for g in guides(page))
    page.mouse.up()
    assert page.evaluate(f"+{first}.getAttribute('width')") == pytest.approx(560, abs=0.01)
    # The south edge goes 4 px past the other rect's top, and snaps to it.
    page.mouse.move(*to_screen(page, 680, 500))
    page.mouse.down()
    page.mouse.move(*to_screen(page, 680, 704), steps=8)
    assert any(g["y1"] == pytest.approx(700) and g["y2"] == pytest.approx(700) for g in guides(page))
    page.mouse.up()
    assert page.evaluate(f"+{first}.getAttribute('height')") == pytest.approx(300, abs=0.01)
    # With the grid snapping, the grid wins.
    page.evaluate("svgdeckEditor.editor.grid = {show: false, snap: true, size: 50}")
    page.mouse.move(*to_screen(page, 960, 550))
    page.mouse.down()
    page.mouse.move(*to_screen(page, 1012, 550), steps=8)
    assert guides(page) == []
    page.mouse.up()
    assert page.evaluate(f"+{first}.getAttribute('width')") == pytest.approx(600, abs=0.01)


def test_new_shapes_snap_to_the_slide(page, server):
    page.keyboard.press("r")
    drag(page, (200, 200), (956, 537))
    assert rect_xywh(page) == pytest.approx([200, 200, 760, 340], abs=0.01)
    # Alt draws freely.
    page.keyboard.press("r")
    page.keyboard.down("Alt")
    drag(page, (100, 700), (957, 803))
    page.keyboard.up("Alt")
    w = rect_xywh(page)[2]
    assert w == pytest.approx(857, abs=2) and w != pytest.approx(860, abs=0.5)


# --- 2. Alt resizes from the centre ----------------------------------------------------------------

def test_alt_resizes_from_the_centre(page, server):
    add_rects(page, [[400, 400, 300, 100]])
    select_last_rect(page)
    page.evaluate("svgdeckEditor.editor.smartSnap = false")
    page.keyboard.down("Alt")
    drag(page, (700, 450), (750, 450))
    assert rect_xywh(page) == pytest.approx([350, 400, 400, 100], abs=1)
    # A corner keeps the proportions and the centre.
    drag(page, (750, 500), (790, 500))
    page.keyboard.up("Alt")
    x, y, w, h = rect_xywh(page)
    assert w / h == pytest.approx(4, abs=0.02)
    assert [x + w / 2, y + h / 2] == pytest.approx([550, 450], abs=1)
    assert w == pytest.approx(480, abs=2)
    # Alt and Shift: a corner moves freely, the centre stays.
    page.keyboard.down("Alt"); page.keyboard.down("Shift")
    drag(page, (x + w, y + h), (x + w + 20, y + h + 30))
    page.keyboard.up("Shift"); page.keyboard.up("Alt")
    x2, y2, w2, h2 = rect_xywh(page)
    assert [w2, h2] == pytest.approx([w + 40, h + 60], abs=2)
    assert [x2 + w2 / 2, y2 + h2 / 2] == pytest.approx([550, 450], abs=1)


def test_alt_resizes_a_turned_object_from_its_centre(page, server):
    add_rects(page, [[400, 400, 300, 100]])
    page.evaluate(f"(() => {{ const e = svgdeckEditor.editor, r = {last_rect(page)}; r.id = 'turned'; e.smartSnap = false; e.select([r]); e.setAngle(30); }})()")
    t = math.radians(30)
    ux, uy = math.cos(t), math.sin(t)
    east = (550 + 150 * ux, 450 + 150 * uy)
    page.keyboard.down("Alt")
    drag(page, east, (east[0] + 50 * ux, east[1] + 50 * uy), steps=10)
    page.keyboard.up("Alt")
    got = page.evaluate("""(() => { const e = svgdeckEditor.editor, r = e.svg.querySelector('#turned'), b = r.getBBox();
      const m = e.svg.getCTM().inverse().multiply(r.getCTM()), c = new DOMPoint(b.x + b.width / 2, b.y + b.height / 2).matrixTransform(m);
      return {c: [c.x, c.y], w: b.width * Math.hypot(m.a, m.b), h: b.height * Math.hypot(m.c, m.d), ortho: m.a * m.c + m.b * m.d,
              angle: e.angleOf(r)}; })()""")
    assert got["c"] == pytest.approx([550, 450], abs=1.5)
    assert got["w"] == pytest.approx(400, abs=3) and got["h"] == pytest.approx(100, abs=0.5)
    assert got["ortho"] == pytest.approx(0, abs=1e-3) and got["angle"] == pytest.approx(30, abs=0.1)


# --- 3. Shift angles in the Bézier tool, and lines --------------------------------------------------

def test_shift_constrains_bezier_points_and_handles_to_45_degrees(page, server):
    page.keyboard.press("b")
    page.mouse.click(*to_screen(page, 200, 600))
    page.keyboard.down("Shift")
    # 8.5° off the horizontal: the point is put on it.
    page.mouse.click(*to_screen(page, 400, 630))
    nodes = page.evaluate("svgdeckEditor.editor.pathDraft.nodes.map(n => [n.x, n.y])")
    assert nodes[1][1] == pytest.approx(600, abs=0.01)
    assert nodes[1][0] == pytest.approx(200 + math.hypot(200, 30), abs=1)
    # The preview follows the constraint too.
    page.mouse.move(*to_screen(page, 600, 790))
    hover = page.evaluate("svgdeckEditor.editor.pathDraft.hover")
    last = nodes[1]
    assert abs(hover["x"] - last[0]) == pytest.approx(abs(hover["y"] - last[1]), abs=0.5)
    # A dragged handle turns in 45° steps about its point.
    start = (last[0] + 200, 600)
    page.mouse.move(*to_screen(page, *start))
    page.mouse.down()
    page.mouse.move(*to_screen(page, start[0] + 80, 690), steps=6)
    page.mouse.up()
    page.keyboard.up("Shift")
    node = page.evaluate("svgdeckEditor.editor.pathDraft.nodes[2]")
    assert node["y"] == pytest.approx(600, abs=0.01)
    dx, dy = node["out"]["x"] - node["x"], node["out"]["y"] - node["y"]
    assert dx == pytest.approx(dy, abs=0.5) and dx > 40
    page.keyboard.press("Enter")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelectorAll('path').length") == 1


def test_shift_constrains_the_line_tool_to_45_degrees(page, server):
    page.keyboard.press("l")
    page.keyboard.down("Shift")
    drag(page, (200, 800), (400, 830))
    page.keyboard.up("Shift")
    line = page.evaluate("(() => { const l = svgdeckEditor.editor.svg.querySelector('line'); return ['x1','y1','x2','y2'].map(a => +l.getAttribute(a)); })()")
    assert line[1] == pytest.approx(800, abs=1) and line[3] == pytest.approx(line[1], abs=0.01)


# --- 4. the text tool on existing text, Escape cancels ------------------------------------------------

def make_text(page, words, at=(300, 300)):
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, *at))
    page.keyboard.type(words)
    page.keyboard.press("Control+Enter")
    assert page.locator(".text-edit").count() == 0


def text_contents(page):
    return page.evaluate("[...svgdeckEditor.editor.svg.querySelectorAll('text')].map(t => t.textContent)")


def test_text_tool_edits_an_existing_text(page, server):
    make_text(page, "Hello")
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, 320, 290))
    page.wait_for_selector(".text-edit")
    page.keyboard.press("End")
    page.keyboard.type(" again")
    page.keyboard.press("Control+Enter")
    assert text_contents(page) == ["Hello again"]
    # Away from any text, the tool still adds a new one.
    make_text(page, "Second", at=(300, 700))
    assert text_contents(page) == ["Hello again", "Second"]


def test_text_tool_edits_a_text_inside_a_group(page, server):
    make_text(page, "Grouped")
    add_rects(page, [[300, 400, 100, 100]])
    page.evaluate("svgdeckEditor.editor.selectAll(); svgdeckEditor.editor.group(); svgdeckEditor.editor.select([])")
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, 320, 290))
    page.wait_for_selector(".text-edit")
    page.keyboard.press("End")
    page.keyboard.type("!")
    page.keyboard.press("Control+Enter")
    assert text_contents(page) == ["Grouped!"]
    assert page.evaluate("svgdeckEditor.editor.svg.querySelectorAll('g > text').length") == 1


def test_escape_cancels_a_text_edit_without_an_undo_step(page, server):
    make_text(page, "Hello")
    depth = undo_depth(page)
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, 320, 290))
    page.wait_for_selector(".text-edit")
    page.keyboard.press("End")
    page.keyboard.type(" world")
    page.keyboard.press("Escape")
    assert page.locator(".text-edit").count() == 0
    assert text_contents(page) == ["Hello"]
    assert undo_depth(page) == depth
    assert "world" not in saved_slide(page, server)
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('text').hasAttribute('data-editing')") is False
    assert page.evaluate("getComputedStyle(svgdeckEditor.editor.svg.querySelector('text')).visibility") == "visible"
    # A new text is removed again.
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, 300, 700))
    page.keyboard.type("Gone")
    page.keyboard.press("Escape")
    assert text_contents(page) == ["Hello"]
    assert undo_depth(page) == depth
    assert "Gone" not in saved_slide(page, server)
    # Ctrl+Enter still keeps the edit as one undo step.
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, 320, 290))
    page.keyboard.press("End")
    page.keyboard.type("!")
    page.keyboard.press("Control+Enter")
    assert text_contents(page) == ["Hello!"]
    assert undo_depth(page) == depth + 1


# --- 5. the numeric geometry, nudge and radius API -----------------------------------------------------

def test_set_selection_geometry_moves_a_lines_ends(page, server):
    js(page, """e.change(() => { const l = document.createElementNS(arg, 'line');
      for (const [k, v] of Object.entries({x1: 100, y1: 100, x2: 300, y2: 200, stroke: '#000', 'stroke-width': 8})) l.setAttribute(k, v);
      e.svg.append(l); e.selection = [l]; }); e.select(e.selection);""", NS)
    assert js(page, "return e.lineMode() !== null")
    depth = undo_depth(page)
    js(page, "e.setSelectionGeometry({x: 500, width: 400});")
    ends = js(page, "const l = e.svg.querySelector('line'); return ['x1','y1','x2','y2'].map(a => +l.getAttribute(a)).concat([l.getAttribute('transform')]);")
    assert ends == [500, 100, 900, 200, None]
    assert undo_depth(page) == depth + 1
    # A turned line keeps its transform (and so its stroke); only its ends move.
    js(page, "e.svg.querySelector('line').setAttribute('transform', 'rotate(30 700 150)'); e.select(e.selection);")
    box = js(page, "return e.selectionGeometry();")
    js(page, "e.setSelectionGeometry({x: 100, y: 100, height: arg});", box["height"] * 1.5)
    got = js(page, "const l = e.svg.querySelector('line'); return [l.getAttribute('transform'), e.selectionGeometry()];")
    assert got[0] == "rotate(30 700 150)"
    assert [got[1]["x"], got[1]["y"], got[1]["width"], got[1]["height"]] == pytest.approx(
        [100, 100, box["width"], box["height"] * 1.5], abs=0.01)


def turned_rect(page, angle):
    add_rects(page, [[400, 400, 300, 100]])
    page.evaluate(f"(() => {{ const e = svgdeckEditor.editor, r = {last_rect(page)}; r.id = 'turned'; e.select([r]); e.setAngle({angle}); }})()")


def turned_state(page):
    return page.evaluate("""(() => { const e = svgdeckEditor.editor, r = e.svg.querySelector('#turned'), b = r.getBBox();
      const m = e.svg.getCTM().inverse().multiply(r.getCTM());
      return {box: e.selectionGeometry(), ortho: (m.a * m.c + m.b * m.d) / Math.hypot(m.a, m.b) / Math.hypot(m.c, m.d),
              angle: e.angleOf(r), w: b.width * Math.hypot(m.a, m.b), h: b.height * Math.hypot(m.c, m.d)}; })()""")


def as_list(box):
    return [box["x"], box["y"], box["width"], box["height"]]


def test_set_selection_geometry_on_a_turned_rect(page, server):
    turned_rect(page, 30)
    b = turned_state(page)["box"]
    # In proportion: scaled alike along its own axes.
    page.evaluate("([w, h]) => svgdeckEditor.editor.setSelectionGeometry({x: 200, y: 150, width: w, height: h})", [b["width"] * 2, b["height"] * 2])
    s = turned_state(page)
    assert as_list(s["box"]) == pytest.approx([200, 150, b["width"] * 2, b["height"] * 2], abs=0.05)
    assert s["ortho"] == pytest.approx(0, abs=1e-6) and s["angle"] == pytest.approx(30, abs=0.01)
    assert [s["w"], s["h"]] == pytest.approx([600, 200], abs=0.05)
    # Wider only: still a rectangle at 30°, along its own axes.
    b = s["box"]
    page.evaluate("(w) => svgdeckEditor.editor.setSelectionGeometry({width: w})", b["width"] + 60)
    s = turned_state(page)
    assert as_list(s["box"]) == pytest.approx([b["x"], b["y"], b["width"] + 60, b["height"]], abs=0.05)
    assert s["ortho"] == pytest.approx(0, abs=1e-6) and s["angle"] == pytest.approx(30, abs=0.01)


def test_set_selection_geometry_at_45_degrees_and_on_several(page, server):
    turned_rect(page, 45)
    b = turned_state(page)["box"]
    page.evaluate("(w) => svgdeckEditor.editor.setSelectionGeometry({width: w})", b["width"] + 100)
    s = turned_state(page)
    # No own-axis scale gives this box: it is scaled along the slide's axes.
    assert as_list(s["box"]) == pytest.approx([b["x"], b["y"], b["width"] + 100, b["height"]], abs=0.05)
    page.evaluate("svgdeckEditor.undo()")
    add_rects(page, [[100, 100, 100, 100], [300, 200, 100, 100]])
    page.evaluate("""svgdeckEditor.editor.select([...svgdeckEditor.editor.svg.querySelectorAll('rect:not([data-locked])')].slice(-2))""")
    assert as_list(page.evaluate("svgdeckEditor.editor.selectionGeometry()")) == pytest.approx([100, 100, 300, 200])
    page.evaluate("svgdeckEditor.editor.setSelectionGeometry({x: 0, y: 0, width: 600, height: 100})")
    rects = page.evaluate("""[...svgdeckEditor.editor.svg.querySelectorAll('rect:not([data-locked])')].slice(-2)
      .map(r => ['x','y','width','height'].map(a => +r.getAttribute(a)))""")
    assert rects == [[0, 0, 200, 50], [400, 50, 200, 50]]


def test_nudges_join_one_undo_step(page, server):
    add_rects(page, [[100, 100, 100, 100]])
    select_last_rect(page)
    depth = undo_depth(page)
    assert page.evaluate("[1, 2, 3].map(() => svgdeckEditor.editor.nudge(1, 0))") == [True, True, True]
    assert rect_xywh(page)[0] == 103
    page.wait_for_timeout(700)
    assert page.evaluate("svgdeckEditor.editor.nudging") is None
    assert undo_depth(page) == depth + 1
    page.evaluate("svgdeckEditor.undo()")
    assert rect_xywh(page)[0] == 100
    # Nudges are exact: a guide 3 px away does not pull them.
    page.evaluate("svgdeckEditor.editor.select([" + last_rect(page) + "]); svgdeckEditor.editor.nudge(855, 0)")
    page.evaluate("svgdeckEditor.editor.endNudge()")
    assert rect_xywh(page)[0] == 955
    # Another edit ends the run: the nudge and the edit are two steps.
    depth = undo_depth(page)
    page.evaluate("svgdeckEditor.editor.nudge(0, 5); svgdeckEditor.editor.setStyle('fill', '#ff0000'); svgdeckEditor.editor.nudge(0, 5)")
    page.evaluate("svgdeckEditor.editor.endNudge()")
    assert undo_depth(page) == depth + 3
    assert rect_xywh(page)[1] == 110


def test_nudge_is_refused_mid_gesture_locked_or_empty_and_ends_on_load(page, server):
    add_rects(page, [[100, 100, 100, 100]])
    select_last_rect(page)
    page.evaluate("svgdeckEditor.editor.smartSnap = false")
    page.mouse.move(*to_screen(page, 150, 150))
    page.mouse.down()
    page.mouse.move(*to_screen(page, 250, 150), steps=4)
    assert page.evaluate("svgdeckEditor.editor.nudge(5, 0)") is False
    page.mouse.up()
    assert rect_xywh(page)[0] == pytest.approx(200, abs=2)
    x = rect_xywh(page)[0]
    page.evaluate("svgdeckEditor.editor.select([])")
    assert page.evaluate("svgdeckEditor.editor.nudge(5, 0)") is False
    page.evaluate(f"(() => {{ const e = svgdeckEditor.editor, r = {last_rect(page)}; r.setAttribute('data-locked', 'true'); e.selection = [r]; }})()")
    assert page.evaluate("svgdeckEditor.editor.nudge(5, 0)") is False
    page.evaluate("""(() => { const e = svgdeckEditor.editor, r = e.svg.querySelector('rect[data-locked]:not(#background)');
      r.removeAttribute('data-locked'); e.select([r]); })()""")
    # A load ends the run and leaves no step open.
    assert page.evaluate("svgdeckEditor.editor.nudge(5, 0)") is True
    page.evaluate("svgdeckEditor.editor.load(svgdeckEditor.editor.serialize())")
    assert page.evaluate("[svgdeckEditor.editor.nudging, svgdeckEditor.editor.tx]") == [None, None]
    select_last_rect(page)
    assert rect_xywh(page)[0] == pytest.approx(x + 5, abs=0.01)
    # So does an abort.
    assert page.evaluate("svgdeckEditor.editor.nudge(5, 0)") is True
    page.evaluate("svgdeckEditor.editor.abort()")
    assert page.evaluate("svgdeckEditor.editor.nudging") is None


def test_radius_is_clamped_and_survives_resize_duplicate_and_copy(page, server):
    add_rects(page, [[400, 400, 300, 100]])
    select_last_rect(page)
    page.evaluate("svgdeckEditor.editor.smartSnap = false; svgdeckEditor.editor.setRadius(500)")
    radius = f"(() => {{ const r = {last_rect(page)}; return [r.getAttribute('rx'), r.getAttribute('ry'), svgdeckEditor.editor.radiusOf(r)]; }})()"
    assert page.evaluate(radius) == ["50", "50", 50]
    page.evaluate("svgdeckEditor.editor.setRadius(20)")
    assert page.evaluate(radius) == ["20", "20", 20]
    drag(page, (700, 450), (800, 450))
    assert rect_xywh(page)[2] == pytest.approx(400, abs=2)
    assert page.evaluate(radius) == ["20", "20", 20]
    page.evaluate("svgdeckEditor.editor.duplicate()")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelectorAll('rect[rx=\"20\"][ry=\"20\"]').length") == 2
    page.evaluate("const e = svgdeckEditor.editor; e.paste(e.copy())")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelectorAll('rect[rx=\"20\"][ry=\"20\"]').length") == 3
    page.evaluate("svgdeckEditor.editor.setRadius(0)")
    assert page.evaluate(radius) == [None, None, 0]
