"""Selection and resizing follow the visible media crop."""
import pytest
from test_editor import page, server, drag, saved_slide


def add_cropped_image(page, transform=""):
    page.evaluate("""transform => {
      const e=svgdeckEditor.editor, ns=e.svg.namespaceURI;
      e.change(() => {
        const defs=document.createElementNS(ns,'defs');
        defs.innerHTML='<clipPath id="selection-crop" clipPathUnits="objectBoundingBox"><rect x=".2" y=".1" width=".5" height=".7"/></clipPath>';
        e.svg.append(defs);
        const i=document.createElementNS(ns,'image');
        for(const [k,v] of Object.entries({id:'cropped',x:200,y:150,width:500,height:300,
          href:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="500" height="300"%3E%3Crect width="500" height="300" fill="red"/%3E%3C/svg%3E',
          'data-crop':'20 10 30 20','data-mask':'rect','data-svgdeck-clip':'selection-crop',
          'clip-path':'url(#selection-crop)'})) i.setAttribute(k,v);
        if(transform)i.setAttribute('transform',transform);
        e.svg.append(i);e.select([i]);e.smartSnap=false;
      });
    }""", transform)


def selection_box(page):
    return page.evaluate("svgdeckEditor.editor.selectionBox()")


@pytest.mark.parametrize('transform, expected', [
    ('', {'x':300,'y':180,'width':250,'height':210}),
    ('translate(80 40) scale(1.2)', {'x':440,'y':256,'width':300,'height':252}),
    ('translate(800 100) rotate(90)', {'x':410,'y':400,'width':210,'height':250}),
])
def test_selection_box_uses_transformed_crop(page, transform, expected):
    add_cropped_image(page, transform)
    assert selection_box(page) == pytest.approx(expected)
    box=page.locator('.overlay rect.ov-box').last
    assert {k:float(box.get_attribute(k)) for k in expected} == pytest.approx(expected)


def test_resize_anchors_visible_corner_and_preserves_crop(page, server):
    add_cropped_image(page)
    drag(page, (550,390), (800,600))
    assert selection_box(page) == pytest.approx({'x':300,'y':180,'width':500,'height':420}, abs=4)
    assert page.locator('#cropped').get_attribute('data-crop') == '20 10 30 20'
    source=page.locator('#cropped').get_attribute('href')
    assert source in saved_slide(page,server).replace('&quot;','"')
    page.locator('#undo').click()
    page.evaluate("svgdeckEditor.editor.select([document.getElementById('cropped')])")
    assert selection_box(page) == pytest.approx({'x':300,'y':180,'width':250,'height':210})


def test_crop_mode_can_restore_full_image_bounds(page):
    add_cropped_image(page)
    page.evaluate('svgdeckEditor.mediaTools.open()')
    assert page.locator('[data-crop-handle]').count() == 8
    page.get_by_role('button',name='Reset',exact=True).click()
    page.get_by_role('button',name='Done',exact=True).click()
    assert selection_box(page) == pytest.approx({'x':200,'y':150,'width':500,'height':300})
