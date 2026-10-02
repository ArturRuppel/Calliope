"""Independent user-flow checks for colors and explicit working-copy commits."""
from conftest import open_doc_menu
from test_editor import page, server


def test_custom_fill_alpha_undo_and_zero_object_opacity(page, server):
    page.evaluate("""() => {
      const e=svgdeckEditor.editor,r=document.createElementNS('http://www.w3.org/2000/svg','rect');
      e.change(()=>{for(const [k,v] of Object.entries({id:'paint',x:200,y:200,width:300,height:200,fill:'#123456'}))r.setAttribute(k,v);e.svg.append(r)});e.select([r]);
    }""")
    before=page.evaluate('svgdeckEditor.state.slides.get(svgdeckEditor.state.current).undo.length')
    page.locator('#panel .row').filter(has_text='Fill').get_by_role('button',name='Custom…').click()
    dialog=page.get_by_role('dialog',name='Custom colour')
    dialog.get_by_label('RGB',exact=True).fill('0, 200, 100')
    dialog.get_by_label('Opacity percent').fill('25')
    dialog.get_by_role('button',name='Apply').click()
    assert page.evaluate("getComputedStyle(svgdeckEditor.editor.svg.querySelector('#paint')).fill")=='rgba(0, 200, 100, 0.25)'
    assert page.evaluate('svgdeckEditor.state.slides.get(svgdeckEditor.state.current).undo.length')==before+1
    page.evaluate('svgdeckEditor.undo()')
    assert page.evaluate("getComputedStyle(svgdeckEditor.editor.svg.querySelector('#paint')).fill")=='rgb(18, 52, 86)'
    page.evaluate("""() => {const e=svgdeckEditor.editor;e.select([e.svg.querySelector('#paint')]);e.setStyle('opacity','0');}""")
    assert page.locator('#panel .row:has(> label:text-is("Opacity")) input').input_value()=='0'


def test_transparent_text_survives_editing_roundtrip(page, server):
    page.evaluate("""() => {const e=svgdeckEditor.editor,t=document.createElementNS('http://www.w3.org/2000/svg','text');
      e.change(()=>{t.id='alpha-text';t.setAttribute('x',100);t.setAttribute('y',200);t.setAttribute('font-size',48);t.style.fill='rgba(255, 0, 0, 0.25)';t.textContent='Transparent words';e.svg.append(t)});
      e.select([t]);e.editText(t,false);e.textEdit.box.firstElementChild.append(' edited');e.textEdit.changed=true;e.endTextEdit(true);
    }""")
    assert page.evaluate("getComputedStyle(svgdeckEditor.editor.svg.querySelector('#alpha-text')).fill")=='rgba(255, 0, 0, 0.25)'
    page.evaluate('svgdeckEditor.flush()')
    page.reload();page.wait_for_function('svgdeckEditor.state.current')
    assert page.evaluate("getComputedStyle(svgdeckEditor.editor.svg.querySelector('#alpha-text')).fill")=='rgba(255, 0, 0, 0.25)'


def test_contextual_crop_and_build_explanation(page):
    assert page.locator('#crop-selection').is_hidden()
    page.evaluate("""() => {const e=svgdeckEditor.editor,i=document.createElementNS('http://www.w3.org/2000/svg','image');
      i.setAttribute('x',100);i.setAttribute('y',100);i.setAttribute('width',300);i.setAttribute('height',200);e.change(()=>e.svg.append(i));e.select([i]);}""")
    assert page.locator('#crop-selection').is_visible()
    assert page.get_by_role('button',name='Crop image',exact=True).is_visible()
    page.get_by_role('tab',name='Builds',exact=True).click()
    assert 'next click' in page.locator('.objects-panel .objects-hint').inner_text()


def test_commit_ui_flushes_diffs_and_restores_working_copy(page, server):
    page.evaluate("""() => {const e=svgdeckEditor.editor,r=document.createElementNS('http://www.w3.org/2000/svg','rect');
      e.change(()=>{r.id='committed-shape';r.setAttribute('width',200);r.setAttribute('height',100);r.setAttribute('fill','#123456');e.svg.append(r)});}""")
    open_doc_menu(page); page.locator('#commit-deck').click()
    dialog=page.get_by_role('dialog',name='Deck commits')
    dialog.get_by_label('Commit message').fill('First milestone')
    dialog.get_by_role('button',name='Commit working copy').click()
    row=dialog.locator('.commit-row').filter(has_text='First milestone')
    row.wait_for()
    dialog.get_by_role('button',name='Close',exact=True).click()
    page.evaluate("""() => {const e=svgdeckEditor.editor;e.change(()=>e.svg.querySelector('#committed-shape').setAttribute('fill','#abcdef'));}""")
    open_doc_menu(page); page.locator('#commit-deck').click()
    row=dialog.locator('.commit-row').filter(has_text='First milestone')
    row.get_by_role('button',name='Working diff').click()
    page.wait_for_function("document.querySelector('.commit-diff pre')?.textContent.includes('#abcdef')")
    assert '#123456' in dialog.locator('.commit-diff pre').inner_text()
    row.get_by_role('button',name='Restore',exact=True).click()
    row.get_by_role('button',name='Confirm restore').click()
    page.wait_for_function("!document.querySelector('.commits-dialog').open")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#committed-shape').getAttribute('fill')")=='#123456'
    open_doc_menu(page); page.locator('#commit-deck').click()
    dialog.locator('.commit-row').filter(has_text='Working copy before restor').wait_for()
    assert dialog.locator('.commit-row').filter(has_text='Working copy before restor').count()==1
