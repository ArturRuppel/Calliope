"""Pencil and finger tools, the eraser, other input devices, and point editing."""
import pytest
from test_editor import BROWSER, page, server, to_screen, drag, add_rects, saved_slide

chromium_only = pytest.mark.skipif(BROWSER != 'chromium', reason='pen input is injected through Chromium CDP')


def js(page, expression):
    return page.evaluate(f'(() => {{const e=svgdeckEditor.editor, s=e.selection[0]; return {expression};}})()')


def pen(session, kind, x, y, buttons=1, force=0.5):
    button = 'none' if kind == 'mouseMoved' and not buttons else 'left'
    session.send('Input.dispatchMouseEvent', {'type': kind, 'x': x, 'y': y, 'button': button, 'force': force if buttons else 0,
                                              'buttons': buttons, 'clickCount': 1, 'pointerType': 'pen'})


def pen_stroke(page, session, points):
    xy = [to_screen(page, *p) for p in points]
    pen(session, 'mouseMoved', *xy[0], buttons=0)
    pen(session, 'mousePressed', *xy[0])
    for x, y in xy[1:]:
        pen(session, 'mouseMoved', x, y)
    pen(session, 'mouseReleased', *xy[-1], buttons=0)


def pen_click(session, x, y):
    pen(session, 'mouseMoved', x, y, buttons=0)
    pen(session, 'mousePressed', x, y)
    pen(session, 'mouseReleased', x, y, buttons=0)


def paths(page):
    return page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("path").length')


# --- Pencil and finger -----------------------------------------------------------------

@chromium_only
def test_pencil_and_finger_keep_their_own_tools(page):
    add_rects(page, [[800, 300, 200, 200]])
    session = page.context.new_cdp_session(page)
    assert page.locator('#pen-status').is_hidden()  # no Pencil seen yet
    pen_stroke(page, session, [(200, 200), (300, 260), (400, 240)])
    # The first Pencil stroke draws (the Pencil's default tool) and announces it.
    assert paths(page) == 1
    assert page.evaluate('svgdeckEditor.editor.penSeen') is True
    assert page.locator('#pen-status').is_visible()
    assert page.locator('#tools [data-tool="pen"]').get_attribute('data-pen') == 'true'
    assert page.locator('#tools [data-tool="select"]').get_attribute('aria-pressed') == 'true'
    # The mouse still selects and moves.
    drag(page, (900, 400), (950, 400))
    assert page.evaluate('+svgdeckEditor.editor.svg.querySelector("rect:not([data-locked])").getAttribute("x")') == pytest.approx(850, abs=1)
    assert paths(page) == 1
    # Tapping a tool with the Pencil gives it to the Pencil only.
    box = page.locator('#tools [data-tool="rect"]').bounding_box()
    pen_click(session, box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    assert page.evaluate('svgdeckEditor.editor.tools') == {'touch': 'select', 'pen': 'rect'}
    assert page.locator('#tools [data-tool="rect"]').get_attribute('data-pen') == 'true'
    pen_stroke(page, session, [(200, 600), (300, 700), (400, 800)])
    assert page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("rect:not([data-locked])").length') == 2
    # ...and a finger or mouse tap gives it to the finger.
    page.click('#tools [data-tool="ellipse"]')
    assert page.evaluate('svgdeckEditor.editor.tools') == {'touch': 'ellipse', 'pen': 'select'}  # rect tool returned the Pencil to Select
    # The Pencil's tool survives a reload.
    page.click('#tools [data-tool="select"]')
    pen_click(session, *[v + 10 for v in page.locator('#tools [data-tool="erase"]').bounding_box().values()][:2])
    page.reload()
    page.wait_for_function('window.svgdeckEditor?.editor.svg')
    assert page.evaluate('svgdeckEditor.editor.tools.pen') == 'erase'
    assert page.evaluate('svgdeckEditor.editor.penSeen') is True


@chromium_only
def test_linked_pencil_follows_the_finger(page):
    session = page.context.new_cdp_session(page)
    pen_stroke(page, session, [(200, 200), (300, 260)])
    page.evaluate('svgdeckEditor.editor.select([])')
    page.locator('#panel').get_by_label('The Pencil has its own tool').uncheck()
    assert page.evaluate('svgdeckEditor.editor.tools') == {'touch': 'select', 'pen': 'select'}
    page.click('#tools [data-tool="rect"]')
    assert page.evaluate('svgdeckEditor.editor.tools') == {'touch': 'rect', 'pen': 'rect'}
    assert page.locator('#tools [data-pen="true"]').count() == 0
    page.evaluate('svgdeckEditor.setTool("select")')
    page.locator('#panel').get_by_label('The Pencil has its own tool').check()
    assert page.evaluate('svgdeckEditor.editor.tools.pen') == 'pen'


@chromium_only
def test_bezier_with_pencil_is_finished_by_a_finger_tool(page):
    session = page.context.new_cdp_session(page)
    pen_stroke(page, session, [(100, 100), (120, 120)])
    page.evaluate('svgdeckEditor.runAction("pen:bezier", "down")')
    for x, y in [(200, 300), (400, 300), (600, 400)]:
        pen_click(session, *to_screen(page, x, y))
    assert page.evaluate('svgdeckEditor.editor.pathDraft.nodes.length') == 3
    add_rects(page, [[900, 600, 100, 100]])
    page.mouse.click(*to_screen(page, 950, 650))  # the finger/mouse selects: the path is done
    assert page.evaluate('svgdeckEditor.editor.pathDraft') is None
    assert paths(page) == 2


@chromium_only
def test_pencil_pressure_sets_the_width(page, server):
    page.evaluate('svgdeckEditor.state.prefs.strokeWidth = 20; svgdeckEditor.state.prefs.stroke = "#d62728"')
    session = page.context.new_cdp_session(page)
    xs = list(range(200, 820, 20))
    pts = [to_screen(page, x, 400) for x in xs]
    pen(session, 'mouseMoved', *pts[0], buttons=0)
    pen(session, 'mousePressed', *pts[0], force=0.05)
    for i, (x, y) in enumerate(pts[1:], 1):
        pen(session, 'mouseMoved', x, y, force=0.05 + 0.95 * i / (len(pts) - 1))
    pen(session, 'mouseReleased', *pts[-1], buttons=0)
    ink = 'svgdeckEditor.editor.svg.querySelector("path[data-ink]")'
    assert page.evaluate(f'{ink}.getAttribute("fill")') == '#d62728'
    inside = lambda x, y: page.evaluate(f'{ink}.isPointInFill(new DOMPoint({x}, {y}))')
    assert inside(760, 400) and inside(760, 412)       # pressed hard: about 30 px wide
    assert inside(260, 400) and not inside(260, 412)   # light touch: thin
    assert 'data-ink="pressure"' in saved_slide(page, server)
    # Its colour is the fill; there is no line width or arrowhead to set.
    page.evaluate(f'svgdeckEditor.editor.select([{ink}])')
    assert page.locator('#panel h3', has_text='Ink stroke').is_visible()
    assert page.locator('#panel h3', has_text='Arrowheads').count() == 0
    # Without pressure, the Pencil draws an ordinary line.
    page.evaluate('svgdeckEditor.state.prefs.pressure = false')
    pen_stroke(page, session, [(200, 700), (500, 720)])
    assert page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("path[data-ink]").length') == 1
    assert page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("path[stroke-width]").length') == 1


# --- eraser ----------------------------------------------------------------------------

def test_eraser_removes_strokes_it_crosses_in_one_undo(page, server):
    add_rects(page, [[100, 700, 300, 200]])
    page.keyboard.press('p')
    drag(page, (200, 200), (600, 220))
    drag(page, (200, 400), (600, 420))
    drag(page, (200, 600), (600, 620))
    page.keyboard.press('x')
    assert page.locator('#tools [data-tool="erase"]').get_attribute('aria-pressed') == 'true'
    # A stroke down through the first two lines (and over the rectangle, which stays).
    drag(page, (400, 150), (400, 450), steps=30)
    page.mouse.move(*to_screen(page, 250, 650)); page.mouse.down(); page.mouse.move(*to_screen(page, 250, 850), steps=20); page.mouse.up()
    assert paths(page) == 1
    assert page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("rect:not([data-locked])").length') == 1
    assert saved_slide(page, server).count('<path') == 1
    page.keyboard.press('Control+z')
    assert paths(page) == 3


# --- other input devices -------------------------------------------------------------------

def test_key_device_binding_press_and_hold(page):
    page.evaluate('svgdeckEditor.editor.select([])')
    panel = page.locator('#panel')
    panel.get_by_label('Action to assign').select_option('pen:bezier')
    panel.get_by_role('button', name='Assign a key or button').click()
    page.keyboard.press('F9')
    assert page.evaluate('svgdeckEditor.state.prefs.bindings["key:F9"]') == 'pen:bezier'
    assert panel.get_by_text('F9', exact=True).is_visible()
    page.keyboard.press('F9')
    assert page.evaluate('svgdeckEditor.editor.tools.pen') == 'bezier'
    assert page.evaluate('svgdeckEditor.editor.tools.touch') == 'select'
    # A hold binding with a modifier: the Pencil erases while the key is down.
    panel.get_by_label('Action to assign').select_option('penhold:erase')
    panel.get_by_role('button', name='Assign a key or button').click()
    page.keyboard.press('Control+Shift+KeyE')
    assert page.evaluate('svgdeckEditor.state.prefs.bindings["key:Ctrl+Shift+KeyE"]') == 'penhold:erase'
    page.keyboard.down('Control'); page.keyboard.down('Shift'); page.keyboard.down('KeyE')
    assert page.evaluate('svgdeckEditor.editor.tools.pen') == 'erase'
    page.keyboard.up('KeyE'); page.keyboard.up('Shift'); page.keyboard.up('Control')
    assert page.evaluate('svgdeckEditor.editor.tools.pen') == 'bezier'
    # Escape cancels learning; removing a binding frees the key.
    panel.get_by_role('button', name='Assign a key or button').click()
    page.keyboard.press('Escape')
    assert page.evaluate('svgdeckEditor.controller.learning') is None
    panel.get_by_role('button', name='Remove F9').click()
    page.keyboard.press('F9')
    assert page.evaluate('svgdeckEditor.editor.tools.pen') == 'bezier'
    assert page.evaluate('"key:F9" in svgdeckEditor.state.prefs.bindings') is False


def test_gamepad_buttons_switch_tools(page):
    # A fake standard gamepad: pressing A then B switches the Pencil's tool.
    page.evaluate('''() => {
      window.fakePad = {id: 'Test pad', index: 0, mapping: 'standard', connected: true,
        buttons: Array.from({length: 17}, () => ({pressed: false, value: 0})), axes: [0, 0, 0, 0]};
      navigator.getGamepads = () => [window.fakePad];
      window.dispatchEvent(new Event('gamepadconnected'));
      window.press = async (i) => {
        const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        fakePad.buttons[i] = {pressed: true, value: 1}; await frame();
        fakePad.buttons[i] = {pressed: false, value: 0}; await frame();
      };
    }''')
    assert page.locator('#pen-status').is_visible()
    page.evaluate('press(1)')
    assert page.evaluate('svgdeckEditor.editor.tools.pen') == 'erase'
    page.evaluate('press(0)')
    assert page.evaluate('svgdeckEditor.editor.tools.pen') == 'pen'
    page.evaluate('press(7)')  # previous Pencil tool
    assert page.evaluate('svgdeckEditor.editor.tools.pen') == 'erase'
    page.evaluate('press(13)')  # D-pad down: the finger selects
    page.evaluate('svgdeckEditor.setTool("rect", {slot: "touch"})')
    page.evaluate('press(13)')
    assert page.evaluate('svgdeckEditor.editor.tools.touch') == 'select'


# --- point editing --------------------------------------------------------------------------

def add_path(page, d, extra=''):
    page.evaluate(f"""(() => {{ const e = svgdeckEditor.editor;
      e.change(() => {{ const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', {d!r}); p.setAttribute('style', 'fill:none;stroke:#000;stroke-width:4');
        {extra} e.svg.append(p); e.selection = [p]; }}); }})()""")


def shape_samples(page):
    """Points along the selected path, to compare shapes before and after."""
    return js(page, 'Array.from({length: 41}, (_, i) => { const q = s.getPointAtLength(s.getTotalLength() * i / 40); return [q.x, q.y]; })')


def assert_same_shape(a, b, tol=0.6):
    for (x0, y0), (x1, y1) in zip(a, b):
        assert x1 == pytest.approx(x0, abs=tol) and y1 == pytest.approx(y0, abs=tol)


@pytest.mark.parametrize('d', [
    'm 100,100 c 50,-80 150,-80 200,0 s 150,80 200,0',     # relative, smooth
    'M 100,300 Q 300,100 500,300 T 900,300',                 # quadratic
    'M100 500 h 300 v 200 H 100 z',                          # lines, closed
    'M 700 600 a 150 100 0 1 0 300 0 A 150 100 0 0 1 700 600 Z',  # arcs
    'M100,800 L300,850 M 500,800 l 200,50 200,-50',          # two parts, implicit lines
])
def test_any_path_becomes_editable_nodes_without_changing_shape(page, d):
    add_path(page, d)
    before = shape_samples(page)
    assert js(page, 'e.nodeModel(s) !== null')
    js(page, '(e.editNodes(() => {}), 0)')  # rewrite through the node model
    assert js(page, 's.getAttribute("d")') != d
    assert_same_shape(before, shape_samples(page))


def test_node_types_and_two_handles(page, server):
    # A corner point with its handles retracted: dragging it moves the point
    # (it used to grab a hidden handle instead).
    add_path(page, 'M200,500 L500,300 L800,500')
    page.keyboard.press('n')
    drag(page, (500, 300), (500, 250))
    assert js(page, 'e.nodeModel(s).subs[0].nodes[1].y') == pytest.approx(250, abs=1)
    assert js(page, 'e.selectedNode().i') == 1
    # Smooth pulls out both handles, in line, along the outline.
    page.get_by_role('button', name='Smooth', exact=True).click()
    n = js(page, 'e.nodeModel(s).subs[0].nodes[1]')
    cx, cy = n['x'], n['y']
    assert n['type'] == 's'
    assert n['in']['y'] == pytest.approx(cy, abs=0.5) and n['out']['y'] == pytest.approx(cy, abs=0.5)
    assert n['in']['x'] < cx < n['out']['x']
    # Symmetric: dragging one handle mirrors the other.
    page.get_by_role('button', name='Symmetric', exact=True).click()
    assert 'data-nodetypes="czc"' in saved_slide(page, server)
    out = js(page, 'e.nodeModel(s).subs[0].nodes[1].out')
    drag(page, (out['x'], out['y']), (out['x'] + 40, out['y'] + 60))
    n = js(page, 'e.nodeModel(s).subs[0].nodes[1]')
    assert n['in']['x'] - cx == pytest.approx(-(n['out']['x'] - cx), abs=0.01)
    assert n['in']['y'] - cy == pytest.approx(-(n['out']['y'] - cy), abs=0.01)
    assert n['out']['y'] == pytest.approx(out['y'] + 60, abs=2)
    # Smooth keeps the other handle's length but turns it opposite.
    page.get_by_role('button', name='Smooth', exact=True).click()
    before_in = js(page, '(n => Math.hypot(n.in.x - n.x, n.in.y - n.y))(e.nodeModel(s).subs[0].nodes[1])')
    out = js(page, 'e.nodeModel(s).subs[0].nodes[1].out')
    drag(page, (out['x'], out['y']), (out['x'] + 100, out['y']))
    n = js(page, 'e.nodeModel(s).subs[0].nodes[1]')
    assert (n['in']['x'] - cx) ** 2 + (n['in']['y'] - cy) ** 2 == pytest.approx(before_in ** 2, rel=0.01)
    ax, ay, bx, by = n['in']['x'] - cx, n['in']['y'] - cy, n['out']['x'] - cx, n['out']['y'] - cy
    assert abs(ax * by - ay * bx) / (ax * ax + ay * ay) ** .5 / (bx * bx + by * by) ** .5 < 1e-3  # still in line
    assert ax * bx + ay * by < 0  # and opposite
    # Corner: handles move independently.
    page.get_by_role('button', name='Corner', exact=True).click()
    before_in = js(page, 'e.nodeModel(s).subs[0].nodes[1].in')
    out = js(page, 'e.nodeModel(s).subs[0].nodes[1].out')
    drag(page, (out['x'], out['y']), (out['x'], out['y'] - 80))
    assert js(page, 'e.nodeModel(s).subs[0].nodes[1].in') == before_in
    assert js(page, 'e.nodeModel(s).subs[0].nodes[1].type') == 'c'  # a corner stays a corner though its handles were in line


def test_add_and_delete_points(page):
    add_path(page, 'M200,500 C300,200 700,200 800,500')
    page.keyboard.press('n')
    before = shape_samples(page)
    # Double-click on the outline adds a point there, keeping the shape.
    mid = js(page, '(q => [q.x, q.y])(s.getPointAtLength(s.getTotalLength() / 2))')
    x, y = to_screen(page, *mid)
    page.mouse.click(x, y); page.mouse.click(x, y)
    assert js(page, 'e.nodeModel(s).subs[0].nodes.length') == 3
    assert js(page, 'e.selectedNode().i') == 1
    assert_same_shape(before, shape_samples(page))
    page.get_by_role('button', name='Add point', exact=True).click()
    assert js(page, 'e.nodeModel(s).subs[0].nodes.length') == 4
    assert_same_shape(before, shape_samples(page), tol=0.8)
    page.keyboard.press('Delete')
    assert js(page, 'e.nodeModel(s).subs[0].nodes.length') == 3
    assert js(page, 'e.selection.length') == 1  # the point went, not the path
    page.get_by_role('button', name='Straight', exact=True).click()
    assert 'L' in js(page, 's.getAttribute("d")')
    page.get_by_role('button', name='Close path', exact=True).click()
    assert js(page, 's.getAttribute("d").trim().endsWith("Z")')
    page.get_by_role('button', name='Open path', exact=True).click()
    assert not js(page, 's.getAttribute("d").trim().endsWith("Z")')
    assert js(page, 'e.nodeModel(s).subs[0].nodes.length') == 4  # opened at a point: it is now both ends
    for _ in range(6):
        page.keyboard.press('Control+z')
    assert js(page, 'e.svg.querySelector("path").getAttribute("d")') == 'M200,500 C300,200 700,200 800,500'


def test_polygon_points_can_be_added_and_removed(page):
    page.evaluate('''() => { const e = svgdeckEditor.editor; e.change(() => {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      p.setAttribute('points', '200,200 600,200 400,500'); e.svg.append(p); e.selection = [p]; }); }''')
    page.keyboard.press('n')
    x, y = to_screen(page, 400, 200)
    page.mouse.click(x, y); page.mouse.click(x, y)
    assert js(page, 's.points.numberOfItems') == 4
    page.keyboard.press('Delete')
    assert js(page, 's.points.numberOfItems') == 3
    page.keyboard.press('Delete')
    assert js(page, 's.points.numberOfItems') == 3  # a polygon keeps three
