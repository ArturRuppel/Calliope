"""Canvas fixes: mirrored images, rotated resizing, text undo, long press,
Pencil double-tap, transactions and editor-owned defs."""
import math

import pytest
from conftest import pick_tool
from test_editor import BROWSER, page, server, to_screen, drag, add_rects, saved_slide
from test_pen_and_points import pen, pen_click, pen_stroke, paths
from test_touch_tools import touch

chromium_only = pytest.mark.skipif(BROWSER != 'chromium', reason='pen and touch input is injected through Chromium CDP')

RED = ('data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="300" height="200"%3E'
       '%3Crect width="150" height="200" fill="red"/%3E%3Crect x="150" width="150" height="200" fill="blue"/%3E%3C/svg%3E')


def add_image(page, crop=None):
    page.evaluate("""([href, crop]) => {
      const e=svgdeckEditor.editor, ns=e.svg.namespaceURI;
      e.change(() => {
        const i=document.createElementNS(ns,'image');
        for (const [k,v] of Object.entries({id:'pic',x:100,y:100,width:300,height:200,href})) i.setAttribute(k,v);
        if (crop) {
          const defs=document.createElementNS(ns,'defs');
          defs.innerHTML='<clipPath id="svgdeck-clip-7" clipPathUnits="objectBoundingBox"><rect x=".2" y=".1" width=".5" height=".7"/></clipPath>';
          e.svg.append(defs);
          for (const [k,v] of Object.entries({'data-crop':crop,'data-mask':'rect','data-svgdeck-clip':'svgdeck-clip-7',
            'clip-path':'url(#svgdeck-clip-7)'})) i.setAttribute(k,v);
        }
        e.svg.append(i); e.select([i]);
      });
    }""", [RED, crop])


def matrix(page, selector):
    return page.evaluate(f"""(() => {{ const e=svgdeckEditor.editor, el=e.svg.querySelector({selector!r});
      const m=e.svg.getCTM().inverse().multiply(el.getCTM()); return [m.a,m.b,m.c,m.d,m.e,m.f]; }})()""")


# --- 1. flipping an image mirrors it ----------------------------------------------------

@pytest.mark.parametrize('crop', [None, '20 10 30 20'])
def test_flipping_an_image_keeps_the_mirror(page, server, crop):
    add_image(page, crop)
    box = page.evaluate('svgdeckEditor.editor.selectionBox()')
    page.evaluate('svgdeckEditor.editor.flip("x")')
    a, b, c, d, *_ = matrix(page, '#pic')
    assert a == pytest.approx(-1) and d == pytest.approx(1) and b == pytest.approx(0) and c == pytest.approx(0)
    # The visible part stays where it was: it is mirrored in place.
    assert page.evaluate('svgdeckEditor.editor.selectionBox()') == pytest.approx(box, abs=0.01)
    assert 'transform="matrix(-1' in saved_slide(page, server)
    # Flipping back removes the mirror again.
    page.evaluate('svgdeckEditor.editor.flip("x")')
    assert matrix(page, '#pic')[0] == pytest.approx(1)
    assert page.evaluate('svgdeckEditor.editor.selectionBox()') == pytest.approx(box, abs=0.01)
    page.evaluate('svgdeckEditor.undo()')
    assert matrix(page, '#pic')[0] == pytest.approx(-1)


# --- 2. resizing a rotated object keeps it rectangular ---------------------------------------

def test_edge_handle_resizes_a_rotated_object_along_its_own_axis(page, server):
    add_rects(page, [[400, 400, 300, 100]])
    page.evaluate("""(() => { const e=svgdeckEditor.editor, r=e.svg.querySelector('rect:not([data-locked]):last-of-type');
      r.id='turned'; e.smartSnap=false; e.select([r]); e.setAngle(30); })()""")
    cx, cy, t = 550, 450, math.radians(30)
    ux, uy = math.cos(t), math.sin(t)
    # The east handle sits on the rotated edge, not on the bounding box.
    east = (cx + 150 * ux, cy + 150 * uy)
    drag(page, east, (east[0] + 100 * ux, east[1] + 100 * uy), steps=10)
    a, b, c, d, *_ = matrix(page, '#turned')
    assert a * c + b * d == pytest.approx(0, abs=1e-3)          # still a rectangle
    w = page.evaluate("svgdeckEditor.editor.svg.querySelector('#turned').getBBox().width")
    h = page.evaluate("svgdeckEditor.editor.svg.querySelector('#turned').getBBox().height")
    assert w * math.hypot(a, b) == pytest.approx(400, abs=4)
    assert h * math.hypot(c, d) == pytest.approx(100, abs=0.5)
    assert page.evaluate("Math.round(svgdeckEditor.editor.angleOf(svgdeckEditor.editor.svg.querySelector('#turned')))") == 30
    # The west edge stayed put.
    west = page.evaluate("""(() => { const e=svgdeckEditor.editor, r=e.svg.querySelector('#turned'), b=r.getBBox();
      const m=e.svg.getCTM().inverse().multiply(r.getCTM()), p=new DOMPoint(b.x, b.y+b.height/2).matrixTransform(m); return [p.x,p.y]; })()""")
    assert west == pytest.approx([cx - 150 * ux, cy - 150 * uy], abs=3)


def test_edge_handle_does_not_jump_to_the_pointer(page, server):
    add_rects(page, [[400, 400, 300, 100]])
    page.evaluate("svgdeckEditor.editor.smartSnap=false; svgdeckEditor.editor.selectAll()")
    # Grab the east handle a little inside its centre and pull it 100 to the right.
    drag(page, (695, 450), (795, 450), steps=10)
    rect = page.evaluate("[...svgdeckEditor.editor.svg.querySelectorAll('rect:not([data-locked])')].at(-1).getBBox().width")
    assert rect == pytest.approx(400, abs=2)


# --- 3. undoing a new text leaves nothing behind ---------------------------------------------

def test_undo_of_a_new_text_removes_it(page, server):
    texts = 'svgdeckEditor.editor.svg.querySelectorAll("text").length'
    before = page.evaluate(texts)
    page.keyboard.press('t')
    page.mouse.click(*to_screen(page, 300, 300))
    page.keyboard.type('Hello')
    page.keyboard.press('Escape')
    assert page.evaluate(texts) == before + 1
    page.evaluate('svgdeckEditor.undo()')
    assert page.evaluate(texts) == before
    assert saved_slide(page, server).count('<text') == before


# --- 4. a slow erase is not reverted by the long press -----------------------------------------

@chromium_only
def test_slow_erase_is_not_undone_by_long_press(page, server):
    page.keyboard.press('p')
    drag(page, (900, 600), (1100, 600))
    assert paths(page) == 1
    pick_tool(page, 'erase')
    session = page.context.new_cdp_session(page)
    x, y = to_screen(page, 1000, 600)
    # Less than a tap's distance in all, so only the erasing can tell it from a hold.
    touch(session, 'touchStart', [(1, x, y - 12)])
    for dy in (9, 6, 3, 0):
        touch(session, 'touchMove', [(1, x, y - dy)])
        page.wait_for_timeout(40)
    assert paths(page) == 0
    page.wait_for_timeout(700)
    touch(session, 'touchEnd', [])
    assert page.locator('#context-menu').count() == 0
    assert paths(page) == 0
    assert '<path' not in saved_slide(page, server)
    page.evaluate('svgdeckEditor.undo()')
    assert paths(page) == 1


# --- 5. a Pencil double-tap finishes a Bézier path, even if the tap slid -------------------------

@chromium_only
def test_pencil_double_tap_after_a_slid_tap_finishes_the_path(page):
    session = page.context.new_cdp_session(page)
    pen_stroke(page, session, [(100, 100), (120, 120)])
    page.evaluate('svgdeckEditor.runAction("pen:bezier", "down")')
    pen_click(session, *to_screen(page, 300, 300))
    page.wait_for_timeout(500)
    # A tap that slid a little (past the tap distance, so it is drawn as a
    # stroke too short to fit) places the next point...
    x, y = to_screen(page, 600, 300)
    pen(session, 'mouseMoved', x, y, buttons=0)
    pen(session, 'mousePressed', x, y)
    pen(session, 'mouseMoved', x + 5, y + 1)
    pen(session, 'mouseMoved', x + 10, y + 2)
    pen(session, 'mouseReleased', x + 10, y + 2, buttons=0)
    assert page.evaluate('svgdeckEditor.editor.pathDraft.nodes.length') == 2
    # ...and a second tap on it finishes the path.
    pen_click(session, x + 4, y + 1)
    assert page.evaluate('svgdeckEditor.editor.pathDraft') is None
    assert paths(page) == 2


# --- 6. transactions --------------------------------------------------------------------------------

def test_nested_changes_commit_once_and_abort_discards(page):
    result = page.evaluate("""(() => {
      const e=svgdeckEditor.editor, rec=svgdeckEditor.state.slides.get(svgdeckEditor.state.current);
      const start=rec.undo.length, ns=e.svg.namespaceURI;
      const add = id => { const r=document.createElementNS(ns,'rect'); r.id=id; r.setAttribute('width',10); r.setAttribute('height',10); e.svg.append(r); };
      e.change(() => { add('outer'); e.change(() => add('inner')); e.begin(); add('third'); e.commit(); });
      const nested = rec.undo.length - start;
      e.begin(); add('dropped'); e.abort(); e.svg.querySelector('#dropped').remove();
      const aborted = rec.undo.length - start, open = e.before;
      // The old way of discarding still works.
      e.begin(); e.before = null; e.commit();
      return [nested, aborted, open, rec.undo.length - start];
    })()""")
    assert result == [1, 1, None, 1]
    page.evaluate('svgdeckEditor.undo()')
    assert page.evaluate("['outer','inner','third'].map(id => !!svgdeckEditor.editor.svg.querySelector('#'+id))") == [False] * 3


def test_cancelled_pinch_keeps_an_open_transaction(page):
    add_rects(page, [[400, 400, 300, 100]])
    page.evaluate("""(() => { const e=svgdeckEditor.editor; e.begin();
      e.gesture={kind:'pinch'}; e.cancelGesture(); })()""")
    assert page.evaluate('svgdeckEditor.editor.before') is not None
    page.evaluate('svgdeckEditor.editor.abort()')
    assert page.evaluate('svgdeckEditor.editor.before') is None


# --- 8. editor-owned defs are collected when nothing uses them ----------------------------------------

def test_unused_owned_clip_and_filter_are_removed_on_commit(page, server):
    page.evaluate("""() => {
      const e=svgdeckEditor.editor, ns=e.svg.namespaceURI;
      e.change(() => {
        const defs=document.createElementNS(ns,'defs');
        defs.innerHTML='<clipPath id="svgdeck-clip-1" clipPathUnits="objectBoundingBox"><rect width=".5" height=".5"/></clipPath>'
          + '<clipPath id="svgdeck-clip-2" clipPathUnits="objectBoundingBox"><rect width=".5" height=".5"/></clipPath>'
          + '<filter id="svgdeck-image-filter-1" data-image-adjustment-filter="true" data-image-adjustment-version="2"><feColorMatrix type="saturate" values="0"/></filter>'
          + '<filter id="svgdeck-image-filter-2" data-image-adjustment-filter="true" data-image-adjustment-version="2"><feColorMatrix type="saturate" values="0"/></filter>'
          + '<clipPath id="foreign"><rect width="5" height="5"/></clipPath>';
        e.svg.append(defs);
        const image = (id, n) => { const i=document.createElementNS(ns,'image');
          for (const [k,v] of Object.entries({id, x:100*n, y:100, width:80, height:60, 'data-crop':'0 0 50 50',
            'data-svgdeck-clip':`svgdeck-clip-${n}`, 'clip-path':`url(#svgdeck-clip-${n})`,
            'data-svgdeck-image-filter':`svgdeck-image-filter-${n}`, style:`filter:url(#svgdeck-image-filter-${n})`})) i.setAttribute(k,v);
          e.svg.append(i); return i; };
        image('gone', 1); image('kept', 2);
      });
      e.select([e.svg.querySelector('#gone')]);
      e.deleteSelection();
    }""")
    ids = "['svgdeck-clip-1','svgdeck-image-filter-1','svgdeck-clip-2','svgdeck-image-filter-2','foreign'].map(id => !!svgdeckEditor.editor.svg.querySelector('#'+id))"
    assert page.evaluate(ids) == [False, False, True, True, True]
    svg = saved_slide(page, server)
    assert 'svgdeck-clip-1' not in svg and 'svgdeck-image-filter-1' not in svg and 'id="foreign"' in svg
    page.evaluate('svgdeckEditor.undo()')
    assert page.evaluate(ids) == [True] * 5
