"""Direct, transformed canvas cropping."""
from test_editor import page, server


def add_image(page, transform=""):
    page.evaluate("""(transform) => { const e=svgdeckEditor.editor,ns='http://www.w3.org/2000/svg';
      const g=document.createElementNS(ns,'g');g.setAttribute('transform','translate(80 40) scale(1.2)');
      const i=document.createElementNS(ns,'image');i.id='cropme';
      for(const [k,v] of Object.entries({x:200,y:150,width:500,height:300,href:'photo.png'}))i.setAttribute(k,v);
      if(transform)i.setAttribute('transform',transform);g.append(i);e.svg.append(g);e.context=g;e.select([i]);svgdeckEditor.mediaTools.open(); }""", transform)


def handle(page, name):
    return page.locator(f'[data-crop-handle="{name}"]')


def test_direct_handle_drag_done_and_single_undo(page, server):
    add_image(page, "rotate(12 450 300)")
    box = handle(page, "w").bounding_box()
    page.mouse.move(box["x"] + box["width"]/2, box["y"] + box["height"]/2)
    page.mouse.down(); page.mouse.move(box["x"] + 85, box["y"] + box["height"]/2, steps=6); page.mouse.up()
    crop = page.evaluate("svgdeckEditor.editor.svg.querySelector('#cropme').getAttribute('data-crop').split(' ').map(Number)")
    assert crop[0] > 8 and crop[1:] == [0, 0, 0]
    assert page.evaluate("""() => {const i=svgdeckEditor.editor.svg.querySelector('#cropme');return [i.getAttribute('x'),i.getAttribute('y'),i.getAttribute('width'),i.getAttribute('height'),i.getAttribute('transform'),i.getAttribute('href')]}""") == ["200","150","500","300","rotate(12 450 300)","photo.png"]
    page.keyboard.press("Enter")
    page.keyboard.press("Control+z")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#cropme').hasAttribute('data-crop')") is False


def test_escape_restores_and_wide_crop_range(page, server):
    add_image(page)
    page.locator(".direct-crop-tools summary").click()
    field = page.locator('[data-crop-side="left"]')
    field.fill("80"); field.dispatch_event("change")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#cropme').getAttribute('data-crop')") == "80 0 0 0"
    page.keyboard.press("Escape")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#cropme').hasAttribute('data-crop')") is False


def test_advanced_enter_and_single_done_click_commit_current_value(page, server):
    add_image(page)
    page.locator(".direct-crop-tools summary").click()
    field = page.locator('[data-crop-side="left"]')
    field.fill("40")
    page.keyboard.press("Enter")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#cropme').getAttribute('data-crop')") == "40 0 0 0"
    assert page.evaluate("svgdeckEditor.mediaTools.active()") is False

    page.evaluate("svgdeckEditor.mediaTools.open()")
    page.locator(".direct-crop-tools summary").click()
    field = page.locator('[data-crop-side="left"]')
    field.fill("120"); field.dispatch_event("change")
    assert field.input_value() == "99.9"
    field.fill("30")
    page.get_by_role("button", name="Done").click()
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#cropme').getAttribute('data-crop')") == "30 0 0 0"
    assert page.evaluate("svgdeckEditor.mediaTools.active()") is False


def test_corner_drag_and_reset_preview(page, server):
    add_image(page)
    box = handle(page, "se").bounding_box()
    page.mouse.move(box["x"]+box["width"]/2,box["y"]+box["height"]/2);page.mouse.down()
    page.mouse.move(box["x"]-100,box["y"]-60,steps=5);page.mouse.up()
    crop = page.evaluate("svgdeckEditor.editor.svg.querySelector('#cropme').getAttribute('data-crop').split(' ').map(Number)")
    assert crop[2] > 10 and crop[3] > 10
    page.get_by_role("button", name="Reset", exact=True).click()
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#cropme').hasAttribute('data-crop')") is False


def test_corner_crossing_clamps_both_dragged_edges(page, server):
    add_image(page)
    box = handle(page, "nw").bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + 1000, box["y"] + 700, steps=5)
    page.mouse.up()
    crop = page.evaluate("svgdeckEditor.editor.svg.querySelector('#cropme').getAttribute('data-crop').split(' ').map(Number)")
    assert crop == [99.9, 99.9, 0, 0]


def test_foreign_clip_refuses_without_mutation(page, server):
    page.evaluate("""() => {const e=svgdeckEditor.editor,ns='http://www.w3.org/2000/svg',i=document.createElementNS(ns,'image');i.id='foreign';i.setAttribute('width',100);i.setAttribute('height',100);i.setAttribute('clip-path','url(#foreign-clip)');e.svg.append(i);e.select([i]);}""")
    assert page.evaluate("svgdeckEditor.mediaTools.open()") is False
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#foreign').getAttribute('clip-path')") == "url(#foreign-clip)"


def test_clip_without_our_marker_is_never_rewritten(page, server):
    # data-crop alone does not make a clip ours; only data-svgdeck-clip naming it does.
    page.evaluate("""() => { const e=svgdeckEditor.editor, ns='http://www.w3.org/2000/svg';
      const defs=document.createElementNS(ns,'defs');
      defs.innerHTML='<clipPath id="imported"><circle cx="50" cy="50" r="40"/></clipPath>';
      e.svg.prepend(defs);
      const i=document.createElementNS(ns,'image');i.id='cropme';
      for(const [k,v] of Object.entries({x:0,y:0,width:100,height:100,href:'photo.png','data-crop':'10 0 0 0',
        'clip-path':'url(#imported)'}))i.setAttribute(k,v);
      e.svg.append(i);e.select([i]);svgdeckEditor.mediaTools.open(); }""")
    assert page.evaluate("svgdeckEditor.mediaTools.active()") is False
    assert 'imported clip path' in page.locator('#toast').text_content()
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#imported').outerHTML") == \
        '<clipPath id="imported"><circle cx="50" cy="50" r="40"></circle></clipPath>'


def test_crop_keeps_one_ghost_picture_and_never_rewrites_href(page, server):
    """WebKit downloads a freshly added picture again for every new <image>
    and for every write to href, so the crop must do neither."""
    add_image(page)
    page.evaluate("""() => { const i=svgdeckEditor.editor.svg.querySelector('#cropme'); window.hrefWrites=0;
      new MutationObserver((records) => { window.hrefWrites += records.length; }).observe(i, {attributes:true, attributeFilter:['href']});
      window.ghost=svgdeckEditor.editor.overlay.querySelector('image'); }""")
    box = handle(page, "w").bounding_box()
    page.mouse.move(box["x"] + box["width"]/2, box["y"] + box["height"]/2)
    page.mouse.down(); page.mouse.move(box["x"] + 85, box["y"] + box["height"]/2, steps=6); page.mouse.up()
    assert page.evaluate("svgdeckEditor.editor.overlay.querySelector('image') === window.ghost") is True
    assert page.evaluate("svgdeckEditor.editor.overlay.querySelectorAll('image').length") == 1
    page.keyboard.press("Escape")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#cropme').hasAttribute('data-crop')") is False
    assert page.evaluate("svgdeckEditor.editor.overlay.querySelectorAll('image').length") == 0
    assert page.evaluate("new Promise((done) => setTimeout(() => done(window.hrefWrites)))") == 0
