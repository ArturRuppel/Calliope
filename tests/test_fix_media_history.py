"""Crop input, filter reuse, legacy upgrade and the commit and recovery dialogs."""
import pytest
from conftest import open_doc_menu
from playwright.sync_api import expect
from test_editor import BROWSER, page, saved_slide, server, to_screen
from test_touch_tools import touch
from svgdeck.store import Store


def add_image_and_rect(page):
    """An image open for cropping, plus a rectangle elsewhere on the slide."""
    page.evaluate("""() => { const e=svgdeckEditor.editor, ns='http://www.w3.org/2000/svg';
      const i=document.createElementNS(ns,'image'), r=document.createElementNS(ns,'rect');
      for(const [k,v] of Object.entries({id:'cropme',x:200,y:150,width:500,height:300,href:'photo.png'}))i.setAttribute(k,v);
      for(const [k,v] of Object.entries({id:'other',x:900,y:600,width:200,height:120,fill:'#cc3333'}))r.setAttribute(k,v);
      e.svg.append(i,r); e.select([i]); svgdeckEditor.mediaTools.open(); }""")


def undo_depth(page):
    return page.evaluate("svgdeckEditor.state.slides.get(svgdeckEditor.state.current).undo.length")


@pytest.mark.skipif(BROWSER != "chromium", reason="real multi-touch injection uses Chromium CDP")
def test_two_finger_pinch_zooms_during_a_crop_and_keeps_it(page):
    add_image_and_rect(page)
    page.locator('[data-crop-side="left"]').evaluate("n => n.closest('details').open = true")
    field = page.locator('[data-crop-side="left"]')
    field.fill("30"); field.dispatch_event("change")
    session = page.context.new_cdp_session(page)
    x, y = to_screen(page, 1500, 800)  # empty stage, away from the crop handles
    zoom = page.evaluate("svgdeckEditor.editor.zoom")
    touch(session, "touchStart", [(1, x, y), (2, x + 60, y)])
    touch(session, "touchMove", [(1, x - 30, y + 20), (2, x + 110, y + 20)])
    touch(session, "touchEnd", [(2, x + 110, y + 20)])
    touch(session, "touchEnd", [])
    assert page.evaluate("svgdeckEditor.editor.zoom") > zoom
    assert page.evaluate("svgdeckEditor.mediaTools.active()") is True
    assert page.evaluate("document.getElementById('cropme').getAttribute('data-crop')") == "30 0 0 0"
    assert undo_depth(page) == 0
    page.get_by_role("button", name="Done").click()
    assert undo_depth(page) == 1
    page.locator("#undo").click()
    assert page.evaluate("document.getElementById('cropme').hasAttribute('data-crop')") is False


def test_tapping_another_object_changes_the_selection_and_cancels_the_crop(page):
    add_image_and_rect(page)
    page.locator('[data-crop-side="left"]').evaluate("n => n.closest('details').open = true")
    field = page.locator('[data-crop-side="left"]')
    field.fill("30"); field.dispatch_event("change")
    assert page.evaluate("document.getElementById('cropme').getAttribute('data-crop')") == "30 0 0 0"
    page.mouse.click(*to_screen(page, 1000, 660))
    assert page.evaluate("svgdeckEditor.editor.selection.map(n => n.id)") == ["other"]
    assert page.evaluate("svgdeckEditor.mediaTools.active()") is False
    assert page.evaluate("document.getElementById('cropme').hasAttribute('data-crop')") is False
    assert undo_depth(page) == 0


def test_crop_handles_still_own_their_pointer(page):
    add_image_and_rect(page)
    box = page.locator('[data-crop-handle="e"]').bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down(); page.mouse.move(box["x"] - 80, box["y"] + box["height"] / 2, steps=5); page.mouse.up()
    assert page.evaluate("svgdeckEditor.mediaTools.active()") is True
    assert page.evaluate("svgdeckEditor.editor.selection.map(n => n.id)") == ["cropme"]
    assert float(page.evaluate("document.getElementById('cropme').getAttribute('data-crop')").split()[2]) > 5


def test_enter_and_escape_in_other_fields_leave_the_crop_alone(page):
    add_image_and_rect(page)
    open_doc_menu(page)
    page.click("#deck-settings")
    title = page.get_by_label("Deck title")
    title.click()
    page.keyboard.press("End")
    page.keyboard.type(" first")
    page.keyboard.press("Enter")
    page.keyboard.type(" second")
    assert title.input_value().endswith(" first second")
    page.keyboard.press("Escape")  # closes the dialog, not the crop
    assert page.evaluate("svgdeckEditor.mediaTools.active()") is True
    # Away from any field the keys still finish or cancel the crop.
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("Escape")
    assert page.evaluate("svgdeckEditor.mediaTools.active()") is False


def add_adjustable_image(page):
    page.evaluate("""() => { const e=svgdeckEditor.editor, ns='http://www.w3.org/2000/svg';
      e.change(() => { const i=document.createElementNS(ns,'image');
        for(const [k,v] of Object.entries({id:'adjustme',x:200,y:200,width:400,height:400,href:'photo.png'}))i.setAttribute(k,v);
        e.svg.append(i); e.select([i]); }); }""")


def test_dragging_a_slider_reuses_one_filter(page):
    add_adjustable_image(page)
    ids = page.evaluate("""async () => {
      const {setImageAdjustment, IMAGE_ADJUSTMENTS} = await import('/editor/image-adjustments.js');
      const e = svgdeckEditor.editor, brightness = IMAGE_ADJUSTMENTS.find(s => s.key === 'brightness'), seen = [];
      for (const value of [90, 80, 70, 60, 50, 40]) {
        setImageAdjustment(e, brightness, value, [e.svg.querySelector('#adjustme')], true);
        seen.push(e.svg.querySelector('#adjustme').getAttribute('data-svgdeck-image-filter'));
      }
      e.commit();
      return seen;
    }""")
    assert len(set(ids)) == 1
    assert page.locator("filter[data-image-adjustment-filter]").count() == 1
    assert page.evaluate("document.querySelector('filter').querySelector('feFuncR[slope=\"0.4\"]') !== null") is True


def test_a_shared_filter_is_cloned_before_it_changes(page):
    add_adjustable_image(page)
    page.evaluate("""async () => {
      const {setImageAdjustment, IMAGE_ADJUSTMENTS} = await import('/editor/image-adjustments.js');
      const e = svgdeckEditor.editor, spec = key => IMAGE_ADJUSTMENTS.find(s => s.key === key);
      setImageAdjustment(e, spec('brightness'), 50, [e.svg.querySelector('#adjustme')]);
      const copy = e.svg.querySelector('#adjustme').cloneNode(true); copy.id = 'twin';
      e.change(() => e.svg.append(copy));
      setImageAdjustment(e, spec('brightness'), 20, [copy]);
    }""")
    ids = page.evaluate("[...document.querySelectorAll('image')].map(i => i.getAttribute('data-svgdeck-image-filter'))")
    assert len(ids) == 2 and ids[0] != ids[1]
    slopes = page.evaluate("""() => [...document.querySelectorAll('image')].map(i =>
      document.getElementById(i.getAttribute('data-svgdeck-image-filter')).querySelectorAll('feComponentTransfer')[1].querySelector('feFuncR').getAttribute('slope'))""")
    assert slopes == ["0.5", "0.2"]


def test_opening_a_legacy_slide_upgrades_it_without_an_undo_step(page, server):
    add_adjustable_image(page)
    page.evaluate("""() => { const e=svgdeckEditor.editor, i=document.getElementById('adjustme');
      e.change(() => { i.setAttribute('data-image-original-filter',''); i.setAttribute('data-image-brightness','0');
        i.style.filter='brightness(0%)'; }); }""")
    saved_slide(page, server)
    page.reload(); page.wait_for_selector("#adjustme")
    assert page.locator("#adjustme").evaluate("i => i.style.filter.startsWith('url(')")
    assert undo_depth(page) == 0
    page.wait_for_function("document.getElementById('status').textContent.includes('Saved')")
    assert "data-svgdeck-image-filter" in saved_slide(page, server)
    assert undo_depth(page) == 0


def commit_dialog(page):
    open_doc_menu(page)
    page.locator("#commit-deck").click()
    return page.get_by_role("dialog", name="Deck commits")


def set_fill(page, color):
    page.evaluate("""color => { const e=svgdeckEditor.editor;
      e.change(() => e.svg.querySelector('[data-label="background"]').setAttribute('fill', color)); }""", color)


def background(page):
    return page.evaluate("svgdeckEditor.editor.svg.querySelector('[data-label=\"background\"]').getAttribute('fill')")


def test_restoring_a_commit_asks_first_and_names_it(page):
    set_fill(page, "#123456")
    dialog = commit_dialog(page)
    dialog.get_by_label("Commit message").fill("Blue milestone")
    dialog.get_by_role("button", name="Commit working copy").click()
    row = dialog.locator(".commit-row").filter(has_text="Blue milestone")
    row.wait_for()
    dialog.get_by_role("button", name="Close", exact=True).click()
    set_fill(page, "#abcdef")

    dialog = commit_dialog(page)
    row = dialog.locator(".commit-row").filter(has_text="Blue milestone")
    row.get_by_role("button", name="Restore", exact=True).click()
    expect(row.locator(".commit-confirm")).to_contain_text("Blue milestone")
    assert background(page) == "#abcdef", "nothing is restored before the confirmation"
    row.get_by_role("button", name="Keep working copy").click()
    assert row.get_by_role("button", name="Restore", exact=True).is_visible()
    assert background(page) == "#abcdef"

    row.get_by_role("button", name="Restore", exact=True).click()
    row.get_by_role("button", name="Confirm restore").click()
    page.wait_for_function("!document.querySelector('.commits-dialog').open")
    assert background(page) == "#123456"


def test_a_conflict_while_committing_refreshes_the_deck(page, server):
    _, data = server
    store = Store(data)
    stale = page.evaluate("svgdeckEditor.state.version")
    record = store.get_deck("talk")
    store.put_deck("talk", dict(record["deck"], title="Renamed elsewhere"), record["version"])
    fresh = store.get_deck("talk")["version"]
    assert fresh != stale
    dialog = commit_dialog(page)
    dialog.get_by_label("Commit message").fill("Too early")
    dialog.get_by_role("button", name="Commit working copy").click()
    expect(page.locator("#toast")).to_contain_text("try again")
    assert page.evaluate("svgdeckEditor.state.version") == fresh
    assert page.evaluate("svgdeckEditor.state.deck.title") == "Renamed elsewhere"
    dialog.get_by_role("button", name="Commit working copy").click()
    dialog.locator(".commit-row").filter(has_text="Too early").wait_for()


def test_recovery_dialog_cannot_be_dismissed_while_loading(page):
    held = []
    page.route("**/trash", lambda route: held.append(route))  # hold the response until released
    try:
        open_doc_menu(page)
        page.get_by_role("menuitem", name="History and recovery").click()
        dialog = page.locator(".recovery-dialog")
        expect(dialog.locator(".recovery-body")).to_have_text("Loading recovery history…")
        page.keyboard.press("Escape")
        page.mouse.click(2, 2)  # the backdrop
        assert dialog.evaluate("d => d.open") is True
        assert dialog.locator("header button").is_disabled()
    finally:
        for _ in range(250):
            if held:
                break
            page.wait_for_timeout(20)
        for route in held:
            route.continue_()
    expect(dialog.get_by_role("heading", name="Deleted slides")).to_be_visible()
    assert dialog.locator("header button").is_enabled()
    page.keyboard.press("Escape")
    assert dialog.evaluate("d => d.open") is False
