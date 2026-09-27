import json

from test_editor import add_rects, page, server, to_screen


def two_slides(page):
    first = page.evaluate("svgdeckEditor.state.current")
    page.click("#slide-add")
    page.wait_for_function("svgdeckEditor.state.deck.slides.length === 2 && svgdeckEditor.state.current !== " + json.dumps(first))
    return first, page.evaluate("svgdeckEditor.state.current")


def test_navigation_cancels_origin_gesture_without_destination_undo(page):
    add_rects(page, [[100, 100, 200, 200]])
    first, second = two_slides(page)
    page.keyboard.press("p")
    page.mouse.move(*to_screen(page, 200, 300))
    page.mouse.down()
    page.mouse.move(*to_screen(page, 500, 400), steps=5)
    page.evaluate('svgdeckEditor.runAction("prev-slide", "down")')
    page.wait_for_function("svgdeckEditor.state.current === " + json.dumps(first))
    page.mouse.up()

    assert page.evaluate("svgdeckEditor.editor.gesture") is None
    assert page.evaluate("svgdeckEditor.state.slides.get(svgdeckEditor.state.current).undo.length") == 1
    page.evaluate("svgdeckEditor.undo()")
    assert page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("rect:not([data-locked])").length') == 0
    assert "<path" not in page.evaluate("svgdeckEditor.state.slides.get(" + json.dumps(second) + ").text")


def test_navigation_finishes_bezier_on_origin(page):
    first, second = two_slides(page)
    page.keyboard.press("b")
    for point in [(200, 300), (500, 300), (700, 500)]:
        page.mouse.click(*to_screen(page, *point))
    page.click(f'#thumbs li[data-id="{first}"]')
    page.wait_for_function("svgdeckEditor.state.current === " + json.dumps(first))
    page.click(f'#thumbs li[data-id="{second}"]')
    page.wait_for_function("svgdeckEditor.state.current === " + json.dumps(second))

    assert page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("path").length') == 1
    assert page.evaluate("svgdeckEditor.state.slides.get(svgdeckEditor.state.current).undo.length") == 1


def test_current_thumbnail_keeps_bezier_draft(page):
    page.keyboard.press("b")
    for point in [(200, 300), (500, 300), (700, 500)]:
        page.mouse.click(*to_screen(page, *point))
    current = page.evaluate("svgdeckEditor.state.current")
    page.click(f'#thumbs li[data-id="{current}"]')
    assert page.evaluate("svgdeckEditor.editor.pathDraft.nodes.length") == 3


def test_current_slide_click_cancels_pending_navigation(page):
    first, second = two_slides(page)
    page.evaluate("svgdeckEditor.state.slides.delete(" + json.dumps(first) + ")")
    page.evaluate('''(first) => {
      const original = window.fetch;
      window.fetch = (url, opts) => String(url).endsWith(`/slides/${first}`) ? new Promise(resolve => {
        window.finishSlideLoad = () => original(url, opts).then(resolve);
      }) : original(url, opts);
      svgdeckEditor.openSlide(first);
    }''', first)
    page.wait_for_function("typeof window.finishSlideLoad === 'function'")
    page.evaluate("svgdeckEditor.openSlide(" + json.dumps(second) + ")")
    page.evaluate("finishSlideLoad()")
    page.wait_for_timeout(100)
    assert page.evaluate("svgdeckEditor.state.current") == second


def test_upload_batch_stays_with_origin_after_navigation(page):
    first, second = two_slides(page)
    page.evaluate('''() => {
      const original = window.fetch;
      const pending = [];
      window.fetch = (url, opts) => String(url).includes('/media?') ? new Promise(resolve => pending.push(resolve)) : original(url, opts);
      window.completeUpload = (name) => pending.shift()(new Response(JSON.stringify({kind:'image', href:`../media/${name}`, width:100, height:100}), {status:200}));
      window.pendingUploads = () => pending.length;
    }''')
    page.locator("#media-file").set_input_files([
        {"name": "one.png", "mimeType": "image/png", "buffer": b"one"},
        {"name": "two.png", "mimeType": "image/png", "buffer": b"two"},
    ])
    page.wait_for_function("typeof window.completeUpload === 'function'")
    page.click(f'#thumbs li[data-id="{first}"]')
    page.wait_for_function("svgdeckEditor.state.current === " + json.dumps(first))
    page.evaluate('completeUpload("one.png")')
    page.wait_for_function("svgdeckEditor.state.slides.get(" + json.dumps(second) + ").undo.length === 1")
    page.wait_for_function("pendingUploads() === 1")
    page.evaluate('completeUpload("two.png")')
    page.wait_for_function("svgdeckEditor.state.slides.get(" + json.dumps(second) + ").undo.length === 2")

    assert page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("image").length') == 0
    page.click(f'#thumbs li[data-id="{second}"]')
    page.wait_for_function("svgdeckEditor.state.current === " + json.dumps(second))
    assert page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("image").length') == 2
    page.evaluate("svgdeckEditor.undo()")
    assert page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("image").length') == 1


def test_upload_waits_for_active_stroke_and_keeps_separate_undo(page):
    page.evaluate('''() => {
      const original = window.fetch;
      window.fetch = (url, opts) => String(url).includes('/media?') ? new Promise(resolve => {
        window.completeUpload = () => resolve(new Response(JSON.stringify({kind:'image', href:'../media/ink.png', width:100, height:100}), {status:200}));
      }) : original(url, opts);
    }''')
    page.locator("#media-file").set_input_files({"name": "ink.png", "mimeType": "image/png", "buffer": b"ink"})
    page.wait_for_function("typeof window.completeUpload === 'function'")
    page.keyboard.press("p")
    page.mouse.move(*to_screen(page, 200, 300))
    page.mouse.down()
    page.mouse.move(*to_screen(page, 500, 400), steps=5)
    page.evaluate("completeUpload()")
    page.wait_for_timeout(50)
    assert page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("image").length') == 0
    page.mouse.up()
    page.wait_for_function('svgdeckEditor.editor.svg.querySelectorAll("image").length === 1')
    assert page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("path").length') == 1
    page.evaluate("svgdeckEditor.undo()")
    assert page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("image").length') == 0
    assert page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("path").length') == 1
    page.evaluate("svgdeckEditor.undo()")
    assert page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("path").length') == 0


def test_upload_to_deleted_origin_is_not_inserted_elsewhere(page):
    first, second = two_slides(page)
    page.evaluate('''() => {
      const original = window.fetch;
      window.fetch = (url, opts) => String(url).includes('/media?') ? new Promise(resolve => {
        window.completeUpload = () => resolve(new Response(JSON.stringify({kind:'image', href:'../media/gone.png', width:100, height:100}), {status:200}));
      }) : original(url, opts);
    }''')
    page.locator("#media-file").set_input_files({"name": "gone.png", "mimeType": "image/png", "buffer": b"gone"})
    page.wait_for_function("typeof window.completeUpload === 'function'")
    page.once("dialog", lambda dialog: dialog.accept())
    page.click("#slide-menu-btn"); page.click("#slide-del")
    page.wait_for_function("svgdeckEditor.state.deck.slides.length === 1")
    page.evaluate("completeUpload()")
    page.wait_for_function("document.getElementById('toast').textContent.includes('slide was deleted')")
    assert page.evaluate('svgdeckEditor.editor.svg.querySelectorAll("image").length') == 0
    assert page.evaluate("svgdeckEditor.state.current") == first
