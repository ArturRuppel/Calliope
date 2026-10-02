"""Geometry, editing transactions, and discoverable formatting controls."""
import pytest
from conftest import pick_tool
from test_editor import page, server, screen_tol, drag, to_screen, add_rects, saved_slide


def draw_curve(page, a, b):
    drag(page, a, (a[0]+100,a[1]-100))
    drag(page, b, (b[0]+100,b[1]+100))
    page.keyboard.press('Enter')


def selected(page, expression):
    return page.evaluate(f'(() => {{const e=svgdeckEditor.editor, s=e.selection[0]; return {expression};}})()')


def test_circle_and_polygon_creation_and_vertex_edit(page, server):
    page.keyboard.press('c')
    drag(page, (200,200), (400,350))
    assert selected(page, 's.localName') == 'circle'
    assert selected(page, '+s.getAttribute("r")') == pytest.approx(100, abs=2)
    page.keyboard.press('g')
    sides = page.locator('#panel section').filter(has=page.get_by_role('heading',name='Polygon tool')).locator('input')
    sides.fill('6')
    sides.press('Tab')
    drag(page, (500,200), (850,500))
    assert selected(page, 's.points.numberOfItems') == 6
    p = selected(page, '[s.points[0].x,s.points[0].y]')
    page.keyboard.press('n')
    drag(page, p, (p[0]+50,p[1]+50))
    assert selected(page, 's.points[0].x') == pytest.approx(p[0]+50,abs=2)
    assert 'polygon' in saved_slide(page,server)
    page.keyboard.press('Control+z')
    assert page.evaluate('svgdeckEditor.editor.svg.querySelector("polygon").points[0].x') == pytest.approx(p[0],abs=2)


def test_bezier_handles_subdivision_extension_and_undo(page, server):
    page.keyboard.press('b')
    draw_curve(page, (250,300), (750,500))
    assert selected(page,'e.curvePoints(s).length') == 4
    original = selected(page,'s.getAttribute("d")')
    page.keyboard.press('n')
    control = selected(page,'e.curvePoints(s)[1]')
    drag(page,(control['x'],control['y']),(control['x'],control['y']+100))
    assert selected(page,'e.curvePoints(s)[1].y') == pytest.approx(control['y']+100,abs=2)
    assert selected(page,'e.curvePoints(s)[0].y') == pytest.approx(300,abs=2)
    length = selected(page,'s.getTotalLength()')
    page.get_by_role('button',name='Subdivide',exact=True).click()
    assert selected(page,'e.curvePoints(s).length') == 7
    assert selected(page,'s.getTotalLength()') == pytest.approx(length,abs=.1)
    page.get_by_role('button',name='Continue path',exact=True).click()
    click_node(page,1000,600)
    page.keyboard.press('Enter')
    assert selected(page,'e.curvePoints(s).length') == 10
    svg = saved_slide(page,server)
    assert ' C' in svg
    for _ in range(3): page.keyboard.press('Control+z')
    assert page.evaluate('svgdeckEditor.editor.svg.querySelector("path").getAttribute("d")') == original


def test_nodes_respect_transformed_groups_and_cancel(page):
    page.keyboard.press('b')
    draw_curve(page,(200,300),(600,500))
    page.evaluate('''() => {const e=svgdeckEditor.editor,p=e.selection[0];
      const g=document.createElementNS(p.namespaceURI,'g');e.svg.append(g);g.append(p);
      g.setAttribute('transform','translate(100 50) scale(.8)');e.enterGroup(g);e.select([p]);}''')
    page.keyboard.press('n')
    p = selected(page,'e.curvePoints(s)[0]')
    drag(page,(100+p['x']*.8,50+p['y']*.8),(100+p['x']*.8+80,50+p['y']*.8+40))
    assert selected(page,'e.curvePoints(s)[0].x') == pytest.approx(p['x']+100,abs=2)
    before = selected(page,'s.getAttribute("d")')
    q = selected(page,'e.curvePoints(s)[0]')
    page.mouse.move(*to_screen(page,100+q['x']*.8,50+q['y']*.8));page.mouse.down()
    page.mouse.move(*to_screen(page,200+q['x']*.8,100+q['y']*.8))
    page.evaluate('svgdeckEditor.editor.cancelGesture()');page.mouse.up()
    assert selected(page,'s.getAttribute("d")') == before


def test_alignment_reference_and_text_controls(page, server):
    add_rects(page,[[100,100,100,100],[400,400,200,100]])
    page.evaluate('svgdeckEditor.editor.selectAll()')
    page.locator('#sel-bar').get_by_role('button',name='Align',exact=True).click()
    page.get_by_role('button',name='to selection',exact=True).click()  # several objects: align to the slide instead
    page.get_by_title('Align left edges',exact=True).click()
    assert page.evaluate('[...svgdeckEditor.editor.selection].map(s=>s.getBBox().x)') == pytest.approx([0,0],abs=.1)
    page.keyboard.press('t'); page.mouse.click(*to_screen(page,400,400))
    page.keyboard.type('Formatted text');page.keyboard.press('Control+Enter')
    page.click('#inspector-tabs [data-tab="design"]')
    page.get_by_title('Toggle bold',exact=True).click()
    page.get_by_title('Toggle italic',exact=True).click()
    page.get_by_title('Toggle underline',exact=True).click()
    assert selected(page,'getComputedStyle(s).fontWeight') == '700'
    assert selected(page,'getComputedStyle(s).fontStyle') == 'italic'
    assert 'underline' in selected(page,'getComputedStyle(s).textDecorationLine')
    assert 'underline' in saved_slide(page,server)
    page.get_by_title('Toggle underline',exact=True).click()
    assert selected(page,'e.textRuns(s)[0][0].look.decoration') == 'none'
    page.get_by_title('Toggle underline',exact=True).click()
    assert selected(page,'e.textRuns(s)[0][0].look.decoration') == 'underline' 


@pytest.mark.parametrize('width,height',[(1400,900),(1194,834),(1024,768),(768,1024),(390,844)])
def test_tool_rail_and_canvas_remain_usable(page,width,height,tmp_path):
    page.set_viewport_size({'width':width,'height':height})
    page.evaluate('document.body.classList.add("no-panel","no-strip")')
    for name in ['select','pen','erase','text']:
        box=page.locator(f'#tools [data-tool="{name}"]').bounding_box()
        assert box['y']+box['height'] <= height
    for family in ['shapes','paths']:
        assert page.locator(f'#tools [data-family="{family}"]').count() == 1
    pick_tool(page,'bezier')
    assert page.evaluate('svgdeckEditor.editor.tool') == 'bezier'
    page.evaluate('document.body.classList.add("no-panel")')
    stage=page.locator('#stage').bounding_box()
    assert stage['height'] > height*.5
    assert stage['width'] > width-80  # only the tool rail beside it
    page.screenshot(path=str(tmp_path/'organized-tools.png'))


def test_selected_word_underline_survives_edit_and_reload(page,server):
    page.keyboard.press('t');page.mouse.click(*to_screen(page,300,300))
    page.keyboard.type('one two')
    page.evaluate('''() => {const box=document.querySelector('.text-edit');
      const w=document.createTreeWalker(box,NodeFilter.SHOW_TEXT), n=w.nextNode();
      const r=document.createRange();r.setStart(n,0);r.setEnd(n,3);
      getSelection().removeAllRanges();getSelection().addRange(r);box.dispatchEvent(new Event('keyup'));}''')
    page.get_by_title('Underline (Ctrl+U)',exact=True).click()
    page.get_by_title('Finish editing (Esc)',exact=True).click()
    runs=selected(page,'e.textRuns(s)[0].map(r=>[r.text,r.look.decoration])')
    assert runs == [['one','underline'],[' two','none']]
    page.get_by_title('Or double-tap the text',exact=True).click()
    page.get_by_title('Finish editing (Esc)',exact=True).click()
    assert selected(page,'e.textRuns(s)[0].map(r=>[r.text,r.look.decoration])') == runs
    saved_slide(page,server)
    page.reload();page.wait_for_function('svgdeckEditor.editor.svg')
    assert page.evaluate('svgdeckEditor.editor.textRuns(svgdeckEditor.editor.svg.querySelector("text"))[0].map(r=>[r.text,r.look.decoration])') == runs


def test_curve_handle_touch_drag_and_two_finger_cancel(page):
    from test_touch_tools import touch
    from test_editor import BROWSER
    if BROWSER != 'chromium': pytest.skip('CDP touch injection requires Chromium')
    page.keyboard.press('b');draw_curve(page,(250,300),(750,500));page.keyboard.press('n')
    session=page.context.new_cdp_session(page)
    point=selected(page,'e.curvePoints(s)[1]')
    x,y=to_screen(page,point['x'],point['y'])
    zoom=page.evaluate('svgdeckEditor.editor.zoom')
    touch(session,'touchStart',[(1,x,y)])
    touch(session,'touchMove',[(1,x+60,y+30)])
    touch(session,'touchEnd',[])
    assert selected(page,'e.curvePoints(s)[1].x') == pytest.approx(point['x']+60/zoom,abs=2)
    original=selected(page,'s.getAttribute("d")')
    point=selected(page,'e.curvePoints(s)[1]')
    x,y=to_screen(page,point['x'],point['y'])
    touch(session,'touchStart',[(1,x,y)])
    touch(session,'touchMove',[(1,x+30,y+30)])
    touch(session,'touchStart',[(1,x+30,y+30),(2,x+100,y+30)])
    touch(session,'touchMove',[(1,x+60,y+60),(2,x+130,y+60)])
    touch(session,'touchEnd',[])
    assert selected(page,'s.getAttribute("d")') == original
    assert page.locator('#context-menu').count() == 0


def click_node(page,x,y):
    page.mouse.click(*to_screen(page,x,y))


def test_connected_straight_and_curved_nodes_finish_as_one_undo(page,server):
    before=page.evaluate('svgdeckEditor.editor.serialize()')
    page.keyboard.press('b')
    click_node(page,200,300);click_node(page,450,300)
    drag(page,(650,500),(750,500))
    click_node(page,950,300)
    assert page.evaluate('svgdeckEditor.editor.pathDraft.nodes.length') == 4
    assert page.evaluate('svgdeckEditor.editor.serialize()') == before
    page.keyboard.press('Enter')
    points=selected(page,'e.curvePoints(s)')
    assert len(points)==10
    assert points[1] == points[0] and points[2] == points[3]
    assert points[5]['x'] == pytest.approx(550,abs=screen_tol(page))
    assert points[7]['x'] == pytest.approx(750,abs=screen_tol(page))
    saved_slide(page,server)
    page.keyboard.press('Control+z')
    assert page.evaluate('svgdeckEditor.editor.serialize()') == before


def test_path_close_edit_remove_cancel_and_right_click(page):
    page.keyboard.press('b');click_node(page,200,200);click_node(page,500,200);click_node(page,500,500)
    page.keyboard.press('Backspace')
    assert page.evaluate('svgdeckEditor.editor.pathDraft.nodes.length') == 2
    click_node(page,500,500);click_node(page,200,200)
    assert selected(page,'s.getAttribute("d").endsWith("Z")')
    page.keyboard.press('n');drag(page,(200,200),(250,250))
    points=selected(page,'e.curvePoints(s)')
    assert points[0] == points[-1]
    original=page.evaluate('svgdeckEditor.editor.serialize()')
    page.keyboard.press('b');click_node(page,700,400);click_node(page,900,400)
    page.keyboard.press('Escape')
    assert page.evaluate('svgdeckEditor.editor.serialize()') == original
    page.keyboard.press('b');click_node(page,700,400);click_node(page,900,400)
    page.mouse.click(*to_screen(page,1000,450),button='right')
    assert page.evaluate('svgdeckEditor.editor.pathDraft') is None
    assert page.locator('#context-menu').count()==0


def test_path_touch_finish_and_flush(page,server):
    from test_touch_tools import touch
    from test_editor import BROWSER
    if BROWSER!='chromium': pytest.skip('CDP requires Chromium')
    pick_tool(page,'bezier');session=page.context.new_cdp_session(page)
    for point in [(200,300),(500,300),(700,600)]:
        x,y=to_screen(page,*point);touch(session,'touchStart',[(1,x,y)]);touch(session,'touchEnd',[])
    page.get_by_role('button',name='Finish path',exact=True).click()
    assert selected(page,'e.curvePoints(s).length') == 7
    click_node(page,300,600);click_node(page,500,600)
    page.evaluate("svgdeckEditor.flush()") # Present/export commits a pending path too.
    saved_slide(page,server)
    assert page.evaluate('svgdeckEditor.editor.pathDraft') is None
    assert page.locator('.page > svg:first-child > path').count()==2


def test_presenter_back_link_returns_to_current_slide(page,server):
    page.click('#slide-add')
    page.wait_for_function('svgdeckEditor.state.deck.slides.length === 2 && svgdeckEditor.state.current === svgdeckEditor.state.deck.slides[1].id')
    page.evaluate('svgdeckEditor.flush()')
    page.goto(server[0]+'/d/talk/#2')
    page.wait_for_selector('.svgdeck-ready')
    page.get_by_role('link',name='Back to editor').click()
    page.wait_for_function('window.svgdeckEditor?.editor.svg')
    assert page.url.endswith('/edit/talk#2')
    assert page.evaluate('svgdeckEditor.state.current === svgdeckEditor.state.deck.slides[1].id')


def test_continue_selected_endpoint_and_cancel_preserves_original(page):
    page.keyboard.press('b');click_node(page,250,300);click_node(page,650,300);page.keyboard.press('Enter')
    original=selected(page,'s.outerHTML')
    click_node(page,650,300)
    assert page.evaluate('!!svgdeckEditor.editor.pathDraft.source')
    page.keyboard.press('Enter')
    assert selected(page,'s.outerHTML') == original
    click_node(page,650,300);click_node(page,850,500);page.keyboard.press('Enter')
    assert page.locator('.page > svg:first-child > path').count() == 1
    assert selected(page,'e.curvePoints(s).length') == 7
    page.keyboard.press('Control+z')
    assert page.locator('.page > svg:first-child > path').get_attribute('d') in original
