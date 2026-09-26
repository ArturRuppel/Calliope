"""Pan, independent grid controls and context menus for mouse and touch."""
import pytest
from test_editor import BROWSER, page, server, to_screen, drag, add_rects


def test_pan_select_and_draw_can_be_switched_repeatedly(page):
    add_rects(page, [[200, 200, 300, 150]])
    page.evaluate('svgdeckEditor.editor.selectAll()')
    source = page.evaluate('svgdeckEditor.editor.serialize()')
    before = page.evaluate('({...svgdeckEditor.editor.pan})')
    page.click('#tools [data-tool="pan"]')
    drag(page, (400, 300), (650, 400))
    assert page.evaluate('svgdeckEditor.editor.pan.x') > before['x']
    assert page.evaluate('svgdeckEditor.editor.serialize()') == source
    for tool in ['select', 'pen', 'pan', 'rect', 'select', 'pan']:
        page.click(f'#tools [data-tool="{tool}"]')
        assert page.evaluate('svgdeckEditor.editor.tool') == tool
        assert page.locator(f'#tools [data-tool="{tool}"]').get_attribute('aria-pressed') == 'true'
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
    assert page.locator('#group-selection').is_disabled()
    page.click('#tools [data-tool="pan"]')
    page.click('#multi')
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
    page.click(f'#tools [data-tool="{tool}"]')
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
    page.click('#tools [data-tool="pan"]')
    before = page.evaluate('({...svgdeckEditor.editor.pan})')
    x,y = to_screen(page, 700, 400)
    touch(session, 'touchStart', [(1,x,y)])
    touch(session, 'touchMove', [(1,x+70,y+30)])
    touch(session, 'touchEnd', [])
    assert page.evaluate('svgdeckEditor.editor.pan.x') == pytest.approx(before['x']+70,abs=1)
    page.click('#tools [data-tool="select"]')
    page.click('#tools [data-tool="rect"]')
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
        box = page.locator(f'#tools [data-tool="{name}"]').bounding_box()
        assert 0 <= box['x'] and box['x']+box['width'] <= width
    page.click('#object-actions')
    menu = page.locator('#context-menu')
    box = menu.bounding_box()
    assert box['x'] >= 0 and box['x']+box['width'] <= width
    assert box['y'] >= 0 and box['y']+box['height'] <= height
    assert menu.get_by_role('menuitem',name='Group',exact=True).is_disabled()
    page.screenshot(path=str(tmp_path/'tools-and-menu.png'))
