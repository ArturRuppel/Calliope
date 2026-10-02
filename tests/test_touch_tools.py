"""Pan, independent grid controls and context menus for mouse and touch."""
import pytest
from conftest import pick_tool, select_several, tool_button, tool_pressed
from test_editor import BROWSER, page, server, to_screen, drag, add_rects


def test_pan_select_and_draw_can_be_switched_repeatedly(page):
    add_rects(page, [[200, 200, 300, 150]])
    page.evaluate('svgdeckEditor.editor.selectAll()')
    source = page.evaluate('svgdeckEditor.editor.serialize()')
    before = page.evaluate('({...svgdeckEditor.editor.pan})')
    pick_tool(page, 'pan')
    drag(page, (400, 300), (650, 400))
    assert page.evaluate('svgdeckEditor.editor.pan.x') > before['x']
    assert page.evaluate('svgdeckEditor.editor.serialize()') == source
    for tool in ['select', 'pen', 'pan', 'rect', 'select', 'pan']:
        pick_tool(page, tool)
        assert page.evaluate('svgdeckEditor.editor.tool') == tool
        assert tool_pressed(page, tool)
    page.keyboard.press('v')
    assert page.evaluate('svgdeckEditor.editor.tool') == 'select'
    page.keyboard.press('h')
    assert page.evaluate('svgdeckEditor.editor.tool') == 'pan'


def test_grid_visibility_and_snapping_are_independent_and_persist(page):
    page.click('#grid')
    assert page.evaluate('svgdeckEditor.editor.grid.show') is True
    page.click('#snap')
    page.click('#grid')
    assert page.evaluate('svgdeckEditor.editor.grid') == {'show': False, 'snap': True, 'size': 20}
    assert page.locator('#grid').get_attribute('aria-pressed') == 'false'
    assert page.locator('#snap').get_attribute('aria-pressed') == 'true'
    assert page.locator('.overlay #ov-grid').count() == 0
    page.reload()
    page.wait_for_function('window.svgdeckEditor?.editor.svg')
    assert page.evaluate('svgdeckEditor.editor.grid') == {'show': False, 'snap': True, 'size': 20}
    page.click('#snap')
    assert page.evaluate('svgdeckEditor.editor.grid.snap') is False


def test_multiselect_group_button_and_right_click_ungroup(page):
    add_rects(page, [[100, 100, 150, 150], [400, 100, 150, 150]])
    assert page.locator('#group-selection').count() == 0  # the bar offers Group only for several objects
    pick_tool(page, 'pan')
    select_several(page)
    assert page.evaluate('svgdeckEditor.editor.tool') == 'select'
    page.mouse.click(*to_screen(page, 175, 175))
    page.mouse.click(*to_screen(page, 475, 175))
    assert page.locator('#group-selection').is_enabled()
    page.click('#group-selection')
    assert page.evaluate('svgdeckEditor.editor.selection[0].localName') == 'g'
    page.mouse.click(*to_screen(page, 175, 175), button='right')
    page.locator('#context-menu').get_by_role('menuitem', name='Ungroup', exact=True).click()
    assert page.evaluate('svgdeckEditor.editor.selection.length') == 2
    assert page.locator('#context-menu').count() == 0


def test_right_click_preserves_multiple_selection_and_escape_dismisses(page):
    add_rects(page, [[100, 100, 150, 150], [400, 100, 150, 150]])
    page.evaluate('svgdeckEditor.editor.selectAll()')
    page.mouse.click(*to_screen(page, 175, 175), button='right')
    assert page.evaluate('svgdeckEditor.editor.selection.length') == 2
    assert page.locator('#context-menu').get_by_role('menuitem', name='Group', exact=True).is_enabled()
    page.keyboard.press('Escape')
    assert page.locator('#context-menu').count() == 0
    assert page.evaluate('svgdeckEditor.editor.selection.length') == 2


def touch(session, kind, points):
    session.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [
        {'id': i, 'x': x, 'y': y, 'radiusX': 4, 'radiusY': 4, 'force': 1}
        for i, x, y in points]})


@pytest.mark.skipif(BROWSER != 'chromium', reason='real multi-touch injection uses Chromium CDP')
def test_two_finger_tap_preserves_selection_and_groups(page):
    add_rects(page, [[100, 100, 150, 150], [400, 100, 150, 150]])
    page.evaluate('svgdeckEditor.editor.selectAll()')
    session = page.context.new_cdp_session(page)
    x,y = to_screen(page, 1000, 600) # empty space must not discard the selection
    source = page.evaluate('svgdeckEditor.editor.serialize()')
    touch(session, 'touchStart', [(1,x,y), (2,x+40,y)])
    touch(session, 'touchEnd', [(2,x+40,y)])
    assert page.locator('#context-menu').count() == 0 # wait for both fingers
    touch(session, 'touchEnd', [])
    assert page.locator('#context-menu').is_visible()
    assert page.evaluate('svgdeckEditor.editor.selection.length') == 2
    assert page.evaluate('svgdeckEditor.editor.serialize()') == source
    group = page.locator('#context-menu').get_by_role('menuitem', name='Group', exact=True)
    box = group.bounding_box()
    touch(session, 'touchStart', [(1,box['x']+30,box['y']+20)])
    touch(session, 'touchEnd', [])
    page.wait_for_function('svgdeckEditor.editor.selection[0]?.localName === "g"')
    assert page.locator('#context-menu').count() == 0


@pytest.mark.skipif(BROWSER != 'chromium', reason='real multi-touch injection uses Chromium CDP')
@pytest.mark.parametrize('tool', ['select', 'pan', 'pen', 'rect'])
def test_two_finger_drag_pans_and_zooms_without_editing_or_menu(page, tool):
    add_rects(page, [[100, 100, 150, 150], [400, 100, 150, 150]])
    page.evaluate('svgdeckEditor.editor.selectAll()')
    pick_tool(page, tool)
    session = page.context.new_cdp_session(page)
    x,y = to_screen(page, 1000, 600)
    source = page.evaluate('svgdeckEditor.editor.serialize()')
    zoom = page.evaluate('svgdeckEditor.editor.zoom')
    touch(session, 'touchStart', [(1,x,y), (2,x+60,y)])
    touch(session, 'touchMove', [(1,x-30,y+20), (2,x+110,y+20)])
    touch(session, 'touchEnd', [(2,x+110,y+20)])
    touch(session, 'touchEnd', [])
    assert page.locator('#context-menu').count() == 0
    assert page.evaluate('svgdeckEditor.editor.zoom') > zoom
    assert page.evaluate('svgdeckEditor.editor.serialize()') == source
    assert page.evaluate('svgdeckEditor.editor.selection.length') == 2


@pytest.mark.skipif(BROWSER != 'chromium', reason='real multi-touch injection uses Chromium CDP')
def test_cancelled_two_finger_tap_does_not_open_menu(page):
    session = page.context.new_cdp_session(page)
    x,y = to_screen(page, 800, 500)
    touch(session, 'touchStart', [(1,x,y), (2,x+40,y)])
    touch(session, 'touchCancel', [])
    assert page.locator('#context-menu').count() == 0
    assert page.evaluate('svgdeckEditor.editor.gesture') is None


@pytest.mark.skipif(BROWSER != 'chromium', reason='real multi-touch injection uses Chromium CDP')
def test_finger_can_pan_then_select_then_draw_after_pencil_use(page):
    # Reproduce the old implicit mode left behind by a Pencil stroke.
    page.evaluate('svgdeckEditor.editor.penSeen = true')
    session = page.context.new_cdp_session(page)
    pick_tool(page, 'pan')
    before = page.evaluate('({...svgdeckEditor.editor.pan})')
    x,y = to_screen(page, 700, 400)
    touch(session, 'touchStart', [(1,x,y)])
    touch(session, 'touchMove', [(1,x+70,y+30)])
    touch(session, 'touchEnd', [])
    assert page.evaluate('svgdeckEditor.editor.pan.x') == pytest.approx(before['x']+70,abs=1)
    pick_tool(page, 'select')
    pick_tool(page, 'rect')
    x,y = to_screen(page, 300, 300)
    touch(session, 'touchStart', [(1,x,y)])
    touch(session, 'touchMove', [(1,x+100,y+60)])
    touch(session, 'touchEnd', [])
    assert page.locator('.page > svg:first-child rect:not([data-locked])').count() == 1
    assert page.evaluate('svgdeckEditor.editor.tool') == 'select'


@pytest.mark.parametrize('width,height', [(1024,768),(768,1024),(390,844)])
def test_tools_and_menu_fit_tablet_and_phone_viewports(page, width, height, tmp_path):
    page.set_viewport_size({'width':width,'height':height})
    for name in ['select','pan']:
        box = tool_button(page, name).bounding_box()
        assert 0 <= box['x'] and box['x']+box['width'] <= width
    add_rects(page, [[100, 100, 150, 150]])
    page.evaluate('svgdeckEditor.editor.selectAll()')
    box = page.locator('#sel-bar').bounding_box()
    assert box['x'] >= 0 and box['x']+box['width'] <= width
    page.click('#object-actions')
    menu = page.locator('#context-menu')
    box = menu.bounding_box()
    assert box['x'] >= 0 and box['x']+box['width'] <= width
    assert box['y'] >= 0 and box['y']+box['height'] <= height
    assert menu.get_by_role('menuitem',name='Group',exact=True).is_disabled()
    page.screenshot(path=str(tmp_path/'tools-and-menu.png'))


@pytest.mark.skipif(BROWSER != 'chromium', reason='real touch injection uses Chromium CDP')
@pytest.mark.parametrize('tool', ['select', 'pan', 'pen', 'rect', 'erase'])
def test_long_press_opens_paste_without_editing(page, tool):
    pick_tool(page, tool)
    source = page.evaluate('svgdeckEditor.editor.serialize()')
    session = page.context.new_cdp_session(page)
    x, y = to_screen(page, 1000, 600)
    touch(session, 'touchStart', [(1, x, y)])
    page.locator('#context-menu').wait_for(state='visible')
    touch(session, 'touchEnd', [])
    assert page.locator('#context-menu').get_by_role('menuitem', name='Paste', exact=True).is_enabled()
    assert page.evaluate('svgdeckEditor.editor.serialize()') == source
    assert page.evaluate('svgdeckEditor.editor.gesture') is None


@pytest.mark.skipif(BROWSER != 'chromium', reason='real touch injection uses Chromium CDP')
@pytest.mark.parametrize('cancel', ['move', 'cancel', 'second-finger'])
def test_interrupted_hold_does_not_open_menu(page, cancel):
    session = page.context.new_cdp_session(page)
    x, y = to_screen(page, 1000, 600)
    touch(session, 'touchStart', [(1, x, y)])
    if cancel == 'move':
        touch(session, 'touchMove', [(1, x+40, y)])
    elif cancel == 'cancel':
        touch(session, 'touchCancel', [])
    else:
        touch(session, 'touchStart', [(1, x, y), (2, x+40, y)])
    page.wait_for_timeout(650)
    assert page.locator('#context-menu').count() == 0
    if cancel != 'cancel':
        touch(session, 'touchEnd', [])


@pytest.mark.skipif(BROWSER != 'chromium', reason='real touch injection uses Chromium CDP')
def test_long_press_paste_inserts_system_image_on_slide(page):
    page.evaluate("""() => {
      localStorage.setItem('svgdeck-clipboard', 'stale objects');
      Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{read:async () => {
        const canvas=document.createElement('canvas');canvas.width=12;canvas.height=8;
        const blob=await new Promise(resolve=>canvas.toBlob(resolve));
        return [{types:['image/png'], getType:async () => blob}];
      }}});
    }""")
    session = page.context.new_cdp_session(page)
    x, y = to_screen(page, 1000, 600)
    touch(session, 'touchStart', [(1, x, y)])
    page.locator('#context-menu').wait_for(state='visible')
    touch(session, 'touchEnd', [])
    button = page.locator('#context-menu').get_by_role('menuitem', name='Paste', exact=True).bounding_box()
    touch(session, 'touchStart', [(1, button['x']+30, button['y']+20)])
    touch(session, 'touchEnd', [])
    page.wait_for_function("svgdeckEditor.editor.svg.querySelectorAll('image').length === 1")
    assert page.locator('dialog[open]').count() == 0
    assert page.locator('#context-menu').count() == 0
    image = page.locator('.page > svg:first-child image')
    assert float(image.get_attribute('x')) + float(image.get_attribute('width')) / 2 == pytest.approx(1000, abs=3)
    assert float(image.get_attribute('y')) + float(image.get_attribute('height')) / 2 == pytest.approx(600, abs=3)
    page.evaluate('svgdeckEditor.undo()')
    assert page.locator('.page > svg:first-child image').count() == 0



@pytest.mark.skipif(BROWSER != 'chromium', reason='real touch injection uses Chromium CDP')
def test_long_press_releases_pointer_before_menu_intercepts_lift(page):
    session = page.context.new_cdp_session(page)
    x, y = to_screen(page, 1000, 600)
    touch(session, 'touchStart', [(1, x, y)])
    page.locator('#context-menu').wait_for(state='visible')
    assert page.evaluate('svgdeckEditor.editor.pointers.size') == 0
    assert page.evaluate('svgdeckEditor.editor.gesture') is None
    touch(session, 'touchEnd', [])
    page.keyboard.press('Escape')
    touch(session, 'touchStart', [(1, x, y)])
    assert page.evaluate('svgdeckEditor.editor.gesture.kind') != 'pinch'
    page.locator('#context-menu').wait_for(state='visible')
    touch(session, 'touchEnd', [])
    assert page.evaluate('svgdeckEditor.editor.pointers.size') == 0


@pytest.mark.skipif(BROWSER != 'chromium', reason='real touch injection uses Chromium CDP')
def test_lost_capture_cancels_touch_and_next_touch_is_not_zoom(page):
    session = page.context.new_cdp_session(page)
    x, y = to_screen(page, 1000, 600)
    touch(session, 'touchStart', [(1, x, y)])
    page.evaluate("""() => {
      const e = svgdeckEditor.editor;
      const id = [...e.pointers.keys()][0];
      e.host.releasePointerCapture(id);
    }""")
    touch(session, 'touchMove', [(1, x+1, y)])
    page.wait_for_function('svgdeckEditor.editor.pointers.size === 0')
    assert page.evaluate('svgdeckEditor.editor.gesture') is None
    touch(session, 'touchEnd', [])
    page.keyboard.press('Escape')  # release can also trigger the browser context menu
    x, y = to_screen(page, 500, 400)
    touch(session, 'touchStart', [(1, x, y)])
    assert page.evaluate('svgdeckEditor.editor.pointers.size') == 1
    assert page.evaluate('svgdeckEditor.editor.gesture.kind') != 'pinch'
    touch(session, 'touchEnd', [])


@pytest.mark.skipif(BROWSER != 'chromium', reason='real touch injection uses Chromium CDP')
def test_new_primary_touch_recovers_stale_zoom_state(page):
    page.evaluate("""() => {
      const e = svgdeckEditor.editor;
      e.pointers.set(999, {type:'touch', x:100, y:100, startX:100, startY:100, started:0});
      e.gesture = {kind:'pinch', tapCandidate:false, dist:40, mid:{x:100,y:100}};
    }""")
    session = page.context.new_cdp_session(page)
    x, y = to_screen(page, 1000, 600)
    zoom = page.evaluate('svgdeckEditor.editor.zoom')
    touch(session, 'touchStart', [(1, x, y)])
    assert page.evaluate('svgdeckEditor.editor.gesture.kind') != 'pinch'
    assert page.evaluate('svgdeckEditor.editor.pointers.size') == 1
    touch(session, 'touchEnd', [])
    assert page.evaluate('svgdeckEditor.editor.pointers.size') == 0
    assert page.evaluate('svgdeckEditor.editor.zoom') == zoom


@pytest.mark.parametrize('pointer_type,threshold', [('mouse', 5), ('pen', 8), ('touch', 14)])
def test_pan_taps_select_and_drags_preserve_objects(page, pointer_type, threshold):
    add_rects(page, [[100, 100, 150, 150], [400, 100, 150, 150]])
    pick_tool(page, 'pan')
    page.evaluate("svgdeckEditor.editor.tools.pen = 'pan'")
    source = page.evaluate('svgdeckEditor.editor.serialize()')
    before = page.evaluate('({...svgdeckEditor.editor.pan})')
    x, y = to_screen(page, 175, 175)

    def pointer(kind, px=x, py=y, shift=False, button=0):
        page.evaluate("""([kind, type, x, y, shift, button]) => {
          const e = svgdeckEditor.editor;
          const event = {pointerId:42, pointerType:type, clientX:x, clientY:y,
            target:document.elementFromPoint(x,y), button, buttons:kind === 'onUp' ? 0 : 1,
            shiftKey:shift, preventDefault(){}};
          // Exercise the real handlers without synthetic browser capture.
          const capture = e.host.setPointerCapture;
          e.host.setPointerCapture = () => {};
          try { e[kind](event); } finally { e.host.setPointerCapture = capture; }
        }""", [kind, pointer_type, px, py, shift, button])

    pointer('onDown')
    assert page.evaluate('svgdeckEditor.editor.selection.length') == 0
    pointer('onMove', x + threshold - 1)
    assert page.evaluate('({...svgdeckEditor.editor.pan})') == before
    pointer('onUp', x + threshold - 1)
    assert page.evaluate('svgdeckEditor.editor.selection.length') == 1
    assert page.evaluate('svgdeckEditor.editor.selection[0].getAttribute("x")') == '100'

    x2, y2 = to_screen(page, 475, 175)
    pointer('onDown', x2, y2, shift=True)
    pointer('onUp', x2, y2)
    assert page.evaluate('svgdeckEditor.editor.selection.length') == 2
    page.evaluate('svgdeckEditor.editor.additive = true')
    pointer('onDown')
    pointer('onUp')
    assert page.evaluate('svgdeckEditor.editor.selection[0].getAttribute("x")') == '400'
    page.evaluate('svgdeckEditor.editor.additive = false')

    pointer('onDown')
    pointer('onCancel')
    assert page.evaluate('svgdeckEditor.editor.selection[0].getAttribute("x")') == '400'
    pointer('onDown', button=1)
    pointer('onUp', button=1)
    assert page.evaluate('svgdeckEditor.editor.selection[0].getAttribute("x")') == '400'

    # Cross the threshold, return to the origin: still a pan, never a tap.
    pointer('onDown')
    pointer('onMove', x + threshold + 20)
    assert page.evaluate('svgdeckEditor.editor.pan.x') == pytest.approx(before['x'] + threshold + 20)
    pointer('onMove')
    pointer('onUp')
    assert page.evaluate('svgdeckEditor.editor.selection[0].getAttribute("x")') == '400'
    assert page.evaluate('svgdeckEditor.editor.serialize()') == source

    empty_x, empty_y = to_screen(page, 1000, 600)
    pointer('onDown', empty_x, empty_y)
    pointer('onUp', empty_x, empty_y)
    assert page.evaluate('svgdeckEditor.editor.selection.length') == 0


@pytest.mark.skipif(BROWSER != 'chromium', reason='real touch injection uses Chromium CDP')
def test_pan_real_touch_tap_selects_and_cancel_preserves_selection(page):
    add_rects(page, [[100, 100, 150, 150], [400, 100, 150, 150]])
    pick_tool(page, 'pan')
    session = page.context.new_cdp_session(page)
    x, y = to_screen(page, 175, 175)
    touch(session, 'touchStart', [(1, x, y)])
    touch(session, 'touchEnd', [])
    assert page.evaluate('svgdeckEditor.editor.selection[0].getAttribute("x")') == '100'
    x, y = to_screen(page, 475, 175)
    touch(session, 'touchStart', [(1, x, y)])
    touch(session, 'touchCancel', [])
    assert page.evaluate('svgdeckEditor.editor.selection[0].getAttribute("x")') == '100'
