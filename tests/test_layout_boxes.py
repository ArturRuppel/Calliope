"""Layout boxes: editor-only rectangles to lay a slide out on."""
import pytest
from test_editor import page, server, drag, to_screen, add_rects, saved_slide

LAYOUT = "svgdeckEditor.editor.svg.querySelectorAll('[data-layout]')"


def layout_boxes(page):
    return page.evaluate(f"""Array.from({LAYOUT}).map(r => ['x', 'y', 'width', 'height'].map(k => +r.getAttribute(k)))""")


def draw_box(page, a, b):
    page.keyboard.press("f")
    drag(page, a, b)


def test_box_shows_in_the_editor_only_and_sits_behind(page, server):
    add_rects(page, [[900, 500, 100, 100]])
    page.click("#smart-guides")
    draw_box(page, (200, 200), (1000, 800))
    assert layout_boxes(page) == [pytest.approx([200, 200, 800, 600], abs=3)]
    # Drawn dashed on the canvas, and below the rectangle that was there first.
    assert page.evaluate(f"getComputedStyle({LAYOUT}[0]).visibility") == "visible"
    assert page.evaluate(f"{LAYOUT}[0].nextElementSibling.getAttribute('fill')") == "#888"
    assert page.locator("#sel-bar .sel-kind").text_content() == "Layout box"
    # Stored hidden, so the player, the PDF and other viewers leave it out.
    svg = saved_slide(page, server)
    assert 'data-layout="true"' in svg and 'visibility="hidden"' in svg


def test_box_is_picked_by_its_outline_only(page, server):
    page.click("#smart-guides")
    draw_box(page, (200, 200), (1000, 800))
    page.keyboard.press("Escape")
    page.keyboard.press("v")
    page.mouse.click(*to_screen(page, 600, 500))
    assert page.evaluate("svgdeckEditor.editor.selection.length") == 0
    page.mouse.click(*to_screen(page, 600, 200))
    assert page.evaluate("svgdeckEditor.editor.selection.length") == 1


def test_split_into_a_grid_and_fit(page, server):
    page.click("#smart-guides")
    draw_box(page, (200, 200), (1040, 840))
    page.evaluate(f"""(() => {{ const r = {LAYOUT}[0];
      for (const [k, v] of Object.entries({{x: 200, y: 200, width: 840, height: 640}})) r.setAttribute(k, v); }})()""")
    assert page.locator("#layout-rows").inner_text() == "2"
    page.click('#sel-bar [title="More: columns"]')
    assert page.locator("#layout-cols").inner_text() == "3"
    page.click("#split-layout")
    cells = layout_boxes(page)
    assert len(cells) == 6
    assert cells[0] == pytest.approx([200, 200, 253.33, 300], abs=.01)
    assert cells[5] == pytest.approx([786.67, 540, 253.33, 300], abs=.01)
    page.keyboard.press("Control+z")
    assert layout_boxes(page) == [[200, 200, 840, 640]]
    page.keyboard.press("Control+Shift+z")
    # A wide rectangle lying in the first cell fills its width and is centred.
    add_rects(page, [[220, 220, 100, 50]])
    page.evaluate("""(() => { const e = svgdeckEditor.editor; e.select([e.svg.querySelector('rect[fill="#888"]')]); })()""")
    page.click("#fit-layout")
    b = page.evaluate("""(() => { const b = svgdeckEditor.editor.selectionBox(); return [b.x, b.y, b.width, b.height]; })()""")
    assert b == pytest.approx([200, 286.67, 253.33, 126.67], abs=.5)
