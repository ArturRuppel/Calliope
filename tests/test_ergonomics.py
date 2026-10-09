"""Touch ergonomics: axis-locked moves, a visible align reference, text editing entry."""
import pytest
from test_editor import page, server, drag, to_screen, add_rects, align


def boxes(page):
    return page.evaluate("""svgdeckEditor.editor.selection.map(s => { const b = s.getBBox(); return [b.x, b.y]; })""")


def test_axis_toggle_moves_along_one_axis(page, server):
    add_rects(page, [[300, 300, 100, 100]])
    page.evaluate("svgdeckEditor.editor.selectAll()")
    page.click("#smart-guides")  # no snapping to the slide's edges or centre
    page.click("#axis-lock")
    assert page.locator("#axis-lock").get_attribute("aria-pressed") == "true"
    drag(page, (350, 350), (550, 390))
    assert boxes(page)[0] == pytest.approx([500, 300], abs=3)
    drag(page, (550, 350), (580, 550))
    assert boxes(page)[0] == pytest.approx([500, 500], abs=3)
    page.click("#axis-lock")
    drag(page, (550, 550), (600, 620))
    assert boxes(page)[0] == pytest.approx([550, 570], abs=3)


def test_align_shows_and_uses_its_reference(page, server):
    add_rects(page, [[400, 400, 200, 100], [100, 100, 100, 100], [700, 200, 50, 50]])
    page.evaluate("(() => { const e = svgdeckEditor.editor; e.selectAll(); })()")
    ref = lambda: page.evaluate("""(() => { const r = document.querySelector('.ov-align-ref');
      return r && ['x', 'y', 'width', 'height'].map(k => +r.getAttribute(k)); })()""")
    assert ref() is None
    page.locator("#sel-bar").get_by_role("button", name="Align", exact=True).click()
    assert ref() == pytest.approx([100, 100, 650, 400], abs=1)
    page.locator("#align-row").get_by_role("button", name="First picked", exact=True).click()
    assert ref() == pytest.approx([400, 400, 200, 100], abs=1)
    align(page, "Align left edges")
    assert [b[0] for b in boxes(page)] == pytest.approx([400, 400, 400], abs=.1)
    assert ref() == pytest.approx([400, 400, 200, 100], abs=1)
    page.locator("#align-row").get_by_role("button", name="Slide", exact=True).click()
    assert ref() == pytest.approx([0, 0, 1920, 1080], abs=1)
    page.keyboard.press("Escape")
    assert ref() is None


def test_text_edit_button_and_caret_where_tapped(page, server):
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, 300, 400))
    page.keyboard.type("alpha beta gamma")
    page.keyboard.press("Control+Enter")
    page.locator("#edit-text").click()
    assert page.evaluate("!!svgdeckEditor.editor.textEdit")
    page.keyboard.press("Control+Enter")
    # Double-click the start of the text: the caret lands there, not at the end.
    r = page.evaluate("""(() => { const b = svgdeckEditor.editor.selection[0].getBoundingClientRect();
      return [b.left + 2, b.top + b.height / 2]; })()""")
    page.mouse.dblclick(*r)
    assert page.evaluate("!!svgdeckEditor.editor.textEdit")
    page.keyboard.press("Escape")
    page.mouse.click(*r); page.mouse.click(*r)
    page.wait_for_function("!!svgdeckEditor.editor.textEdit")
    page.keyboard.type("X")
    page.keyboard.press("Control+Enter")
    text = page.evaluate("svgdeckEditor.editor.selection[0].textContent")
    assert text.index("X") < 3 and text.replace("X", "") == "alpha beta gamma"
