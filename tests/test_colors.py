"""Focused browser tests for the standalone rich colour control."""
from test_editor import page, saved_slide, server, to_screen


def mount(page, value="#336699", allow_none=True, recent=None):
    page.add_style_tag(url="/editor/colors.css")
    page.evaluate("""async ({value, allowNone, recent}) => {
      const {createColorControl} = await import('/editor/colors.js');
      window.colorPicks = [];
      window.recentPicks = [];
      const host = document.createElement('div');
      host.id = 'color-test';
      host.append(createColorControl(value, color => colorPicks.push(color), {
        allowNone, recent, palette: ['#ff0000', '#00ff00'],
        onRecent: color => recentPicks.push(color),
      }));
      document.body.append(host);
    }""", {"value": value, "allowNone": allow_none, "recent": recent or []})


def open_editor(page):
    host = page.locator("#color-test")
    host.get_by_role("button", name="Custom…").click()
    return host.get_by_role("dialog", name="Custom colour")


def test_hex_rgb_hsl_are_synchronised_and_alpha_is_preserved(page):
    mount(page, "#33669980")
    dialog = open_editor(page)
    assert dialog.get_by_label("Opacity percent").input_value() == "50"

    rgb = dialog.get_by_label("RGB", exact=True)
    rgb.fill("255, 128, 0")
    assert dialog.get_by_label("HEX").input_value() == "#FF8000"
    assert dialog.get_by_label("HSL").input_value() == "30.12, 100%, 50%"

    dialog.get_by_label("Opacity percent").fill("0")
    dialog.get_by_role("button", name="Apply").click()
    assert page.evaluate("colorPicks") == ["rgba(255, 128, 0, 0)"]
    assert page.evaluate("recentPicks") == ["rgba(255, 128, 0, 0)"]


def test_invalid_edit_does_not_apply_and_cancel_is_transactional(page):
    mount(page, "rgba(1, 2, 3, .4)")
    dialog = open_editor(page)
    dialog.get_by_label("HEX").fill("#nope")
    dialog.get_by_role("button", name="Apply").click()
    assert dialog.is_visible()
    assert page.evaluate("colorPicks") == []

    # A valid edit in another representation replaces the invalid draft.
    dialog.get_by_label("RGB", exact=True).fill("rgba(10, 20, 30, 0)")
    assert dialog.get_by_label("Opacity percent").input_value() == "0"
    dialog.get_by_role("button", name="Apply").click()
    assert page.evaluate("colorPicks") == ["rgba(10, 20, 30, 0)"]

    # Re-mount so the cancellation checks remain independent of Apply.
    page.locator("#color-test").evaluate("node => node.remove()")
    mount(page, "rgba(1, 2, 3, .4)")
    dialog = open_editor(page)
    dialog.get_by_role("button", name="Cancel").click()
    assert page.evaluate("colorPicks") == []
    open_editor(page).get_by_label("HEX").fill("#ffffff")
    page.keyboard.press("Escape")
    assert page.evaluate("colorPicks") == []


def test_rejects_malformed_and_out_of_range_channels(page):
    mount(page)
    dialog = open_editor(page)
    rgb = dialog.get_by_label("RGB", exact=True)
    for value in ("1.2.3, 0, 0", "256, 0, 0", "0, -1, 0"):
        rgb.fill(value)
        assert rgb.get_attribute("aria-invalid") == "true"
    dialog.get_by_role("button", name="Apply").click()
    assert dialog.is_visible()
    assert page.evaluate("colorPicks") == []


def test_palette_recent_none_and_keyboard_isolation(page):
    mount(page, "#123456", recent=["#123456"])
    host = page.locator("#color-test")
    host.get_by_role("button", name="#123456").click()
    host.get_by_role("button", name="No colour").click()
    assert page.evaluate("colorPicks") == ["#123456", "none"]
    assert page.evaluate("recentPicks") == ["#123456"]

    page.evaluate("""() => {
      window.outsideKeys = 0;
      document.addEventListener('keydown', () => outsideKeys++);
    }""")
    dialog = open_editor(page)
    dialog.get_by_label("RGB", exact=True).press("a")
    assert page.evaluate("outsideKeys") == 0


def test_custom_colour_targets_selected_rich_text_and_keeps_alpha(page, server):
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, 300, 300))
    page.keyboard.type("plain tinted plain")
    page.evaluate("""() => {
      const box = document.querySelector('.text-edit');
      const node = document.createTreeWalker(box, NodeFilter.SHOW_TEXT).nextNode();
      const range = document.createRange();
      range.setStart(node, 6); range.setEnd(node, 12);
      const selection = getSelection();
      selection.removeAllRanges(); selection.addRange(range);
    }""")
    page.wait_for_function("svgdeckEditor.editor.textEdit?.range?.toString() === 'tinted'")

    panel = page.locator("#panel")
    panel.get_by_role("button", name="Custom…").click()
    dialog = panel.get_by_role("dialog", name="Custom colour")
    dialog.get_by_label("RGB", exact=True).fill("12, 34, 56")
    dialog.get_by_label("Opacity percent").fill("25")
    dialog.get_by_role("button", name="Apply").click()
    assert page.locator(".text-edit").count() == 1, "colour dialog ended rich-text editing"
    panel.get_by_title("Finish editing (Esc)", exact=True).click()

    runs = page.evaluate("""() => svgdeckEditor.editor.textRuns(
      svgdeckEditor.editor.svg.querySelector('text'))[0].map(run => [run.text, run.look.fill])""")
    assert "".join(text for text, _ in runs) == "plain tinted plain"
    tinted = [fill for text, fill in runs if text == "tinted"]
    assert tinted == ["rgba(12, 34, 56, 0.25)"]
    assert all(fill != "rgba(12, 34, 56, 0.25)" for text, fill in runs if text != "tinted")
    assert "rgba(12, 34, 56, 0.25)" in saved_slide(page, server)
