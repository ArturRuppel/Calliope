"""Geometry, editing transactions, and discoverable formatting controls."""
import pytest
from test_editor import page, server, drag, to_screen, add_rects, saved_slide


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
    drag(page, (250,300), (750,500))
    assert selected(page,'e.curvePoints(s).length') == 4
    original = selected(page,'s.getAttribute("d")')
    page.keyboard.press('n')
    control = selected(page,'e.curvePoints(s)[1]')
    drag(page,(control['x'],control['y']),(control['x'],control['y']+100))
    assert selected(page,'e.curvePoints(s)[1].y') == pytest.approx(control['y']+100,abs=2)
    assert selected(page,'e.curvePoints(s)[0].y') == pytest.approx(300,abs=2)
    length = selected(page,'s.getTotalLength()')
    page.get_by_role('button',name='Add anchors',exact=True).click()
    assert selected(page,'e.curvePoints(s).length') == 7
    assert selected(page,'s.getTotalLength()') == pytest.approx(length,abs=.1)
    page.get_by_role('button',name='Extend curve',exact=True).click()
    assert selected(page,'e.curvePoints(s).length') == 10
    svg = saved_slide(page,server)
    assert ' C' in svg
    for _ in range(3): page.keyboard.press('Control+z')
    assert page.evaluate('svgdeckEditor.editor.svg.querySelector("path").getAttribute("d")') == original


def test_nodes_respect_transformed_groups_and_cancel(page):
    page.keyboard.press('b')
    drag(page,(200,300),(600,500))
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
    page.click('#align-tools')
    page.locator('[aria-label="Alignment reference"]').select_option('slide')
    page.get_by_title('Align left edges',exact=True).click()
    assert page.evaluate('[...svgdeckEditor.editor.selection].map(s=>s.getBBox().x)') == pytest.approx([0,0],abs=.1)
    page.keyboard.press('t'); page.mouse.click(*to_screen(page,400,400))
    page.keyboard.type('Formatted text');page.keyboard.press('Escape')
    page.click('#text-tools')
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


@pytest.mark.parametrize('width,height',[(1400,900),(1024,768),(768,1024),(390,844)])
def test_grouped_toolbar_and_canvas_remain_usable(page,width,height,tmp_path):
    page.set_viewport_size({'width':width,'height':height})
    page.evaluate('document.body.classList.add("no-panel","no-strip")')
    for name in ['Navigate','Shapes','Paths','Arrange','View']:
        assert page.get_by_role('group',name=name,exact=True).count() == 1
    page.click('[data-tool="bezier"]')
    assert page.evaluate('svgdeckEditor.editor.tool') == 'bezier'
    stage=page.locator('#stage').bounding_box()
    assert stage['height'] > height*.5
    assert stage['width'] > width*.9
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
    page.keyboard.press('b');drag(page,(250,300),(750,500));page.keyboard.press('n')
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
