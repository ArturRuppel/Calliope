"""Smart guides and reversible, SVG-native media clipping."""
import pytest

from test_editor import page, server, drag, to_screen


def add_objects(page):
    page.evaluate("""() => { const e=svgdeckEditor.editor, ns='http://www.w3.org/2000/svg';
      e.change(() => {
        for (const [id,x,y,w,h] of [['moving',100,100,100,100],['target',400,100,100,100],
                                    ['locked',700,100,100,100],['hidden',900,100,100,100]]) {
          const r=document.createElementNS(ns,'rect'); r.id=id;
          for (const [k,v] of Object.entries({x,y,width:w,height:h})) r.setAttribute(k,v);
          if(id==='locked') r.setAttribute('data-locked','true');
          if(id==='hidden') r.style.display='none'; e.svg.append(r);
        }
      }); e.select([e.svg.querySelector('#moving')]); }""")


def test_smart_alignment_guides_alt_bypass_and_toggle(page, server):
    add_objects(page)
    # Seven slide pixels short of edge alignment: smart snapping closes the gap.
    a, b = to_screen(page, 150, 150), to_screen(page, 343, 150)
    page.mouse.move(*a); page.mouse.down(); page.mouse.move(*b, steps=5)
    assert page.locator('.ov-smart-guide').count() >= 1
    page.mouse.up()
    assert page.evaluate("+svgdeckEditor.editor.svg.querySelector('#moving').getAttribute('x')") == pytest.approx(300, abs=1)

    # Alt bypasses smart snapping without changing the independent property.
    a, b = to_screen(page, 350, 150), to_screen(page, 543, 150)
    page.keyboard.down('Alt'); drag(page, (350, 150), (543, 150)); page.keyboard.up('Alt')
    assert page.evaluate("+svgdeckEditor.editor.svg.querySelector('#moving').getAttribute('x')") == pytest.approx(493, abs=2)
    assert page.evaluate("svgdeckEditor.editor.smartSnap") is True
    page.evaluate("svgdeckEditor.editor.smartSnap=false")
    drag(page, (543, 150), (736, 150))
    assert page.evaluate("+svgdeckEditor.editor.svg.querySelector('#moving').getAttribute('x')") == pytest.approx(686, abs=3)


def test_equal_gap_solver_and_ancestor_exclusions(page, server):
    result = page.evaluate("""async () => {
      const {smartSnapDelta}=await import('/editor/geom.js');
      return smartSnapDelta({x:390,y:0,width:100,height:100},3,0,
        [{x:0,y:0,width:100,height:100},{x:200,y:0,width:100,height:100}],8);
    }""")
    assert result["dx"] == pytest.approx(10)  # repeats the existing 100 px gap
    assert any(g["kind"] == "gap" for g in result["guides"])
    off_row = page.evaluate("""async () => {
      const {smartSnapDelta}=await import('/editor/geom.js');
      return smartSnapDelta({x:390,y:0,width:100,height:100},3,0,
        [{x:0,y:500,width:100,height:100},{x:200,y:500,width:100,height:100}],8);
    }""")
    assert off_row["dx"] == 3
    assert not any(g["kind"] == "gap" and g["axis"] == "x" for g in off_row["guides"])

    excluded = page.evaluate("""() => { const e=svgdeckEditor.editor,ns='http://www.w3.org/2000/svg',out=[];
      for (const [prop,value] of [['display','none'],['visibility','hidden'],['visibility','collapse']]) {
        const g=document.createElementNS(ns,'g'),r=document.createElementNS(ns,'rect');
        g.style.setProperty(prop,value);r.setAttribute('width',100);r.setAttribute('height',100);g.append(r);e.svg.append(g);
        e.context=g;out.push(e.children().length);g.remove();
      }
      e.context=e.svg;return out; }""")
    assert excluded == [0, 0, 0]


def test_alt_bypasses_grid_and_shift_keeps_axis_constraint(page, server):
    page.evaluate("""() => {const e=svgdeckEditor.editor,ns='http://www.w3.org/2000/svg',r=document.createElementNS(ns,'rect');
      for(const [k,v] of Object.entries({x:100,y:100,width:100,height:100}))r.setAttribute(k,v);e.svg.append(r);e.select([r]);e.grid={show:false,snap:true,size:50};}""")
    page.keyboard.down('Alt'); drag(page, (150, 150), (173, 167)); page.keyboard.up('Alt')
    assert page.evaluate("""() => {const r=svgdeckEditor.editor.selection[0];return [+r.getAttribute('x'),+r.getAttribute('y')]}""") == pytest.approx([123,117], abs=2)
    page.evaluate("svgdeckEditor.editor.grid.snap=false")
    page.keyboard.down('Shift'); drag(page, (173,167), (280,210)); page.keyboard.up('Shift')
    assert page.evaluate("+svgdeckEditor.editor.selection[0].getAttribute('y')") == pytest.approx(117, abs=2)


def test_media_crop_mask_svg_movie_contract_reset_and_undo(page, server):
    page.evaluate("""async () => { const e=svgdeckEditor.editor,ns='http://www.w3.org/2000/svg';
      e.change(() => { const i=document.createElementNS(ns,'image'); i.id='media';
        for(const [k,v] of Object.entries({x:100,y:100,width:400,height:300,href:'poster.png','data-video':'movie.webm'})) i.setAttribute(k,v);
        i.setAttribute('transform','rotate(8 300 250)'); e.svg.append(i); e.selection=[i]; }); e.select(e.selection);
      svgdeckEditor.mediaTools.open(); }""")
    page.locator('.media-tools summary').click()
    page.locator('[data-crop-side="left"]').fill('12.5')
    page.locator('[data-crop-side="left"]').dispatch_event('change')
    page.locator('[data-media-mask]').select_option('ellipse')
    got = page.evaluate("""() => { const e=svgdeckEditor.editor,i=e.svg.querySelector('#media'),id=i.getAttribute('data-svgdeck-clip'),c=e.svg.querySelector('#'+id);
      return {crop:i.getAttribute('data-crop'),mask:i.getAttribute('data-mask'),clip:i.getAttribute('clip-path'),
              units:c.getAttribute('clipPathUnits'),shape:c.firstElementChild.localName,transform:i.getAttribute('transform')}; }""")
    assert got == {'crop': '12.5 0 0 0', 'mask': 'ellipse', 'clip': got['clip'],
                   'units': 'objectBoundingBox', 'shape': 'ellipse', 'transform': 'rotate(8 300 250)'}
    assert got['clip'].startswith('url(#svgdeck-clip-')
    page.get_by_role('button', name='Done').click()
    page.keyboard.press('Control+z')
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#media').getAttribute('data-mask')") is None
    assert not page.locator('.media-tools').get_attribute('open')
    page.evaluate("svgdeckEditor.editor.select([svgdeckEditor.editor.svg.querySelector('#media')]); svgdeckEditor.mediaTools.open()")
    page.locator('.media-tools button', has_text='Reset').click()
    assert page.evaluate("""() => {const i=svgdeckEditor.editor.svg.querySelector('#media');
      return ['data-crop','data-mask','data-svgdeck-clip','clip-path'].every(a=>!i.hasAttribute(a));}""")


def test_imported_clip_is_preserved(page, server):
    page.evaluate("""async () => {const e=svgdeckEditor.editor,ns='http://www.w3.org/2000/svg';
      const i=document.createElementNS(ns,'image');i.id='foreign';i.setAttribute('width',100);i.setAttribute('height',100);i.setAttribute('clip-path','url(#foreign-clip)');e.svg.append(i);e.select([i]);
      svgdeckEditor.mediaTools.open();}""")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#foreign').getAttribute('clip-path')") == 'url(#foreign-clip)'
    assert 'imported clip path' in page.locator('#toast').text_content()


def test_duplicate_gets_private_clip_before_edit_and_reset(page, server):
    page.evaluate("""async () => {const e=svgdeckEditor.editor,ns='http://www.w3.org/2000/svg';
      const i=document.createElementNS(ns,'image');i.id='original';i.setAttribute('width',200);i.setAttribute('height',100);e.svg.append(i);e.select([i]);
      svgdeckEditor.mediaTools.open();}""")
    page.locator('.media-tools summary').click()
    page.locator('[data-crop-side="left"]').fill('10'); page.locator('[data-crop-side="left"]').dispatch_event('change')
    page.get_by_role('button', name='Done').click()
    page.evaluate("svgdeckEditor.editor.duplicate(); svgdeckEditor.mediaTools.open()")
    page.locator('.media-tools summary').click()
    page.locator('[data-media-mask]').select_option('ellipse')
    clips = page.evaluate("""() => [...svgdeckEditor.editor.svg.querySelectorAll('image')].map(i=>i.getAttribute('clip-path'))""")
    assert clips[0] != clips[1]
    shapes = page.evaluate("""() => [...svgdeckEditor.editor.svg.querySelectorAll('image')].map(i=>{
      const id=/#[^)]+/.exec(i.getAttribute('clip-path'))[0].slice(1);return svgdeckEditor.editor.svg.querySelector('#'+id).firstElementChild.localName})""")
    assert shapes == ['rect', 'ellipse']
    page.get_by_role('button', name='Reset', exact=True).click()
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#original').getAttribute('data-crop')") == '10 0 0 0'


def test_copy_paste_clip_is_independent_on_reset(page, server):
    page.evaluate("""() => {const e=svgdeckEditor.editor,ns='http://www.w3.org/2000/svg',i=document.createElementNS(ns,'image');
      i.id='source';i.setAttribute('width',200);i.setAttribute('height',100);e.svg.append(i);e.select([i]);svgdeckEditor.mediaTools.open();}""")
    page.locator('.media-tools summary').click()
    page.locator('[data-crop-side="right"]').fill('15'); page.locator('[data-crop-side="right"]').dispatch_event('change')
    page.get_by_role('button', name='Done').click()
    page.evaluate("""() => {const e=svgdeckEditor.editor,data=e.copy();e.paste(data);svgdeckEditor.mediaTools.open();}""")
    page.locator('.media-tools summary').click()
    refs = page.evaluate("""() => [...svgdeckEditor.editor.svg.querySelectorAll('image')].map(i=>[i.getAttribute('clip-path'),i.getAttribute('data-svgdeck-clip')])""")
    assert refs[0][0] != refs[1][0] and refs[1][0].endswith(refs[1][1] + ')')
    page.get_by_role('button', name='Reset', exact=True).click()
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#source').getAttribute('data-crop')") == '0 0 15 0'


def test_media_dialog_closes_and_cannot_retarget_on_load(page, server):
    page.evaluate("""async () => {const e=svgdeckEditor.editor,ns='http://www.w3.org/2000/svg',i=document.createElementNS(ns,'image');
      i.setAttribute('width',100);i.setAttribute('height',100);e.svg.append(i);e.select([i]);
      svgdeckEditor.mediaTools.open();
      e.load('<svg xmlns="http://www.w3.org/2000/svg"><image id="other" width="100" height="100"/></svg>');}""")
    assert not page.locator('.media-tools').get_attribute('open')
    assert page.evaluate("svgdeckEditor.mediaTools.render().children.length") == 0
