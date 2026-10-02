from test_editor import page, server, saved_slide


def paste_image(page, target='document.body'):
    return page.evaluate('''async (target) => {
      const canvas = document.createElement('canvas'); canvas.width=12; canvas.height=8;
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      const data = new DataTransfer(); data.items.add(new File([blob], 'clipboard.png', {type:'image/png'}));
      const event = new ClipboardEvent('paste', {clipboardData:data, bubbles:true, cancelable:true});
      return eval(target).dispatchEvent(event);
    }''', target)


def test_native_image_paste_beats_internal_clipboard_and_undo(page, server):
    page.evaluate("localStorage.setItem('svgdeck-clipboard', 'stale internal objects')")
    assert paste_image(page) is False
    page.wait_for_function("svgdeckEditor.editor.svg.querySelectorAll('image').length === 1")
    assert '../media/' in saved_slide(page, server)
    page.evaluate('svgdeckEditor.undo()')
    assert page.locator('.page > svg:first-child image').count() == 0
    page.evaluate('svgdeckEditor.redo()')
    page.wait_for_function("svgdeckEditor.editor.svg.querySelectorAll('image').length === 1")


def test_http_touch_paste_area(page, server):
    page.evaluate("Object.defineProperty(navigator, 'clipboard', {value:undefined, configurable:true})")
    page.click('#media-tool')
    assert page.get_by_role('button', name='Paste image', exact=True).count() == 1
    assert paste_image(page, "document.getElementById('image-paste-target')") is False
    page.wait_for_function("svgdeckEditor.editor.svg.querySelectorAll('image').length === 1")
    assert page.locator('#image-paste-dialog').count() == 0
    assert '../media/' in saved_slide(page, server)


def test_text_field_keeps_native_paste(page):
    page.evaluate("document.body.append(Object.assign(document.createElement('textarea'), {id:'paste-text'}))")
    assert paste_image(page, "document.getElementById('paste-text')") is True
    assert page.evaluate("svgdeckEditor.editor.svg.querySelectorAll('image').length") == 0


def test_direct_clipboard_read(page, server):
    page.evaluate('''() => {
      Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{read:async () => {
        const canvas=document.createElement('canvas');canvas.width=12;canvas.height=8;
        const blob=await new Promise(resolve=>canvas.toBlob(resolve));
        return [{types:['text/plain', 'image/png'], getType:async () => blob}];
      }}});
    }''')
    page.click('#media-tool')
    page.get_by_role('button', name='Paste image', exact=True).click()
    page.wait_for_function("svgdeckEditor.editor.svg.querySelectorAll('image').length === 1")
    assert '../media/' in saved_slide(page, server)


def test_denied_clipboard_keeps_paste_area(page):
    page.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{read:async()=>{throw new Error('denied')}}})")
    page.click('#media-tool')
    page.get_by_role('button', name='Paste image', exact=True).click()
    page.wait_for_function("document.querySelector('#image-paste-dialog').textContent.includes('Clipboard access was not available')")
    assert page.locator('#image-paste-target').is_visible()


def test_http_button_requests_native_paste(page, server):
    page.evaluate("""() => {
      Object.defineProperty(navigator, 'clipboard', {value:undefined, configurable:true});
      document.execCommand = command => {
        window.pasteCommand = command;
        window.pasteFocused = document.activeElement.id;
        const canvas = document.createElement('canvas'); canvas.width=12; canvas.height=8;
        canvas.toBlob(blob => {
          const box = document.getElementById('image-paste-target');
          box.innerHTML = '<img src="' + URL.createObjectURL(blob) + '">';
          box.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertFromPaste'}));
        });
        return true;
      };
    }""")
    page.click('#media-tool')
    page.get_by_role('button', name='Paste image', exact=True).click()
    assert page.evaluate('window.pasteCommand') == 'paste'
    assert page.evaluate('window.pasteFocused') == 'image-paste-target'
    page.wait_for_function("svgdeckEditor.editor.svg.querySelectorAll('image').length === 1")
    assert '../media/' in saved_slide(page, server)
    page.evaluate('svgdeckEditor.undo()')
    assert page.locator('.page > svg:first-child image').count() == 0


def test_safari_paste_without_files_allows_native_image_insertion(page, server):
    page.click('#media-tool')
    assert page.evaluate("""() => {
      const box = document.getElementById('image-paste-target');
      const event = new ClipboardEvent('paste', {clipboardData:new DataTransfer(), bubbles:true, cancelable:true});
      const allowed = box.dispatchEvent(event);
      if (allowed) {
        const canvas = document.createElement('canvas'); canvas.width=12; canvas.height=8;
        box.innerHTML = '<img src="' + canvas.toDataURL() + '">';
        box.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertFromPaste'}));
      }
      return allowed;
    }""") is True
    page.wait_for_function("svgdeckEditor.editor.svg.querySelectorAll('image').length === 1")
    assert '../media/' in saved_slide(page, server)



def test_main_menu_http_paste_uses_canvas_without_dialog(page, server):
    page.evaluate("""() => {
      Object.defineProperty(navigator, 'clipboard', {value:undefined, configurable:true});
      document.execCommand = command => {
        window.pasteCommand = command;
        window.pasteFocused = document.activeElement.id;
        const canvas = document.createElement('canvas'); canvas.width=12; canvas.height=8;
        canvas.toBlob(blob => {
          const box = document.getElementById('canvas-paste-target');
          box.innerHTML = '<img src="' + URL.createObjectURL(blob) + '">';
          box.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertFromPaste'}));
        });
        return true;
      };
    }""")
    page.locator('#stage').click(button='right')
    page.locator('#context-menu').get_by_role('menuitem', name='Paste', exact=True).click()
    assert page.evaluate('window.pasteCommand') == 'paste'
    assert page.evaluate('window.pasteFocused') == 'canvas-paste-target'
    page.wait_for_function("svgdeckEditor.editor.svg.querySelectorAll('image').length === 1")
    assert page.locator('dialog[open]').count() == 0
    assert page.locator('#canvas-paste-target').count() == 0
    assert '../media/' in saved_slide(page, server)


def test_canvas_paste_target_dismisses_on_outside_tap(page):
    page.evaluate("Object.defineProperty(navigator, 'clipboard', {value:undefined, configurable:true})")
    page.locator('#stage').click(button='right')
    page.locator('#context-menu').get_by_role('menuitem', name='Paste', exact=True).click()
    assert page.locator('#canvas-paste-target').is_visible()
    page.click('#zoom-fit')
    assert page.locator('#canvas-paste-target').count() == 0



def test_canvas_native_image_beats_stale_internal_clipboard(page, server):
    page.evaluate("""() => {
      Object.defineProperty(navigator, 'clipboard', {value:undefined, configurable:true});
      document.execCommand = () => false;
      localStorage.setItem('svgdeck-clipboard', 'stale objects');
    }""")
    page.locator('#stage').click(button='right')
    page.locator('#context-menu').get_by_role('menuitem', name='Paste', exact=True).click()
    assert page.evaluate("""() => {
      const box = document.getElementById('canvas-paste-target');
      const allowed = box.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData:new DataTransfer(), bubbles:true, cancelable:true
      }));
      if (allowed) {
        const canvas = document.createElement('canvas'); canvas.width=12; canvas.height=8;
        box.innerHTML = '<img src="' + canvas.toDataURL() + '">';
        box.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertFromPaste'}));
      }
      return allowed;
    }""") is True
    page.wait_for_function("svgdeckEditor.editor.svg.querySelectorAll('image').length === 1")
    assert '../media/' in saved_slide(page, server)
    assert page.locator('#canvas-paste-target').count() == 0



def test_canvas_paste_target_keeps_text_keys_out_of_editor(page):
    page.evaluate("""() => {
      Object.defineProperty(navigator, 'clipboard', {value:undefined, configurable:true});
      document.execCommand = () => false;
    }""")
    page.locator('#stage').click(button='right')
    page.locator('#context-menu').get_by_role('menuitem', name='Paste', exact=True).click()
    source = page.evaluate('svgdeckEditor.editor.serialize()')
    tool = page.evaluate('svgdeckEditor.editor.tool')
    page.keyboard.press('r')
    page.keyboard.press('Backspace')
    assert page.evaluate('svgdeckEditor.editor.tool') == tool
    assert page.evaluate('svgdeckEditor.editor.serialize()') == source
