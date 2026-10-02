"""Focused browser tests for the standalone rich colour control."""
from playwright.sync_api import expect
from test_editor import drag, page, saved_slide, server, to_screen


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
    page.get_by_title("Finish editing (Esc)", exact=True).click()

    runs = page.evaluate("""() => svgdeckEditor.editor.textRuns(
      svgdeckEditor.editor.svg.querySelector('text'))[0].map(run => [run.text, run.look.fill])""")
    assert "".join(text for text, _ in runs) == "plain tinted plain"
    tinted = [fill for text, fill in runs if text == "tinted"]
    assert tinted == ["rgba(12, 34, 56, 0.25)"]
    assert all(fill != "rgba(12, 34, 56, 0.25)" for text, fill in runs if text != "tinted")
    assert "rgba(12, 34, 56, 0.25)" in saved_slide(page, server)


def paste_text(field, text):
    return field.evaluate("""(node, text) => {
      const data = new DataTransfer(); data.setData('text/plain', text);
      return node.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
    }""", text)


def test_pasting_any_notation_fills_every_field(page):
    mount(page, "#33669980")
    dialog = open_editor(page)
    hex_field, rgb, hsl = (dialog.get_by_label(name, exact=True) for name in ("HEX", "RGB", "HSL"))
    assert paste_text(hex_field, "rgb(255, 0, 0)") is False
    assert hex_field.input_value() == "#FF0000"
    assert dialog.get_by_label("Opacity percent").input_value() == "50", "a colour without alpha keeps the opacity"
    paste_text(rgb, " hsl(120, 100%, 50%) ")
    assert rgb.input_value() == "0, 255, 0"
    paste_text(hsl, "rebeccapurple")
    assert hex_field.input_value() == "#663399"
    paste_text(hsl, "0, 100%, 25%")
    assert hex_field.input_value() == "#800000"
    paste_text(hex_field, "0000ff40")
    assert rgb.input_value() == "0, 0, 255"
    assert dialog.get_by_label("Opacity percent").input_value() == "25"
    # Anything else is pasted as text, for the field to judge.
    assert paste_text(hex_field, "not a colour") is True


def test_copy_puts_the_value_on_the_clipboard(page):
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    mount(page, "#336699")
    dialog = open_editor(page)
    dialog.get_by_role("button", name="Copy colour", exact=True).click()
    assert page.evaluate("navigator.clipboard.readText()") == "#336699"
    dialog.get_by_label("Opacity percent").fill("50")
    dialog.get_by_role("button", name="Copied").click()
    assert page.evaluate("navigator.clipboard.readText()") == "rgba(51, 102, 153, 0.5)"
    page.evaluate("navigator.clipboard.writeText('hsl(0, 100%, 50%)')")
    dialog.get_by_role("button", name="Paste colour", exact=True).click()
    expect(dialog.get_by_label("HEX")).to_have_value("#FF0000")


def test_transparent_states_its_own_opacity(page):
    mount(page, "#33669980")
    dialog = open_editor(page)
    assert paste_text(dialog.get_by_label("HEX"), "transparent") is False
    assert dialog.get_by_label("Opacity percent").input_value() == "0"


def test_colour_fields_are_selectable_in_the_editor(page):
    page.keyboard.press("r")
    drag(page, (200, 200), (600, 400))
    page.locator("#panel").get_by_role("button", name="Custom…").first.click()
    field = page.locator("#panel").get_by_role("dialog", name="Custom colour").get_by_label("HEX")
    assert field.evaluate("node => getComputedStyle(node).userSelect") == "text"


def test_dropper_picks_line_fill_and_image_pixel(page):
    page.keyboard.press("r")
    drag(page, (200, 200), (600, 400))
    page.evaluate("""() => {
      const rect = svgdeckEditor.editor.selection[0];
      rect.style.fill = 'rgb(10, 200, 30)'; rect.style.stroke = '#123456'; rect.style.strokeWidth = '40';
      const canvas = Object.assign(document.createElement('canvas'), {width: 2, height: 1});
      const context = canvas.getContext('2d');
      context.fillStyle = '#ff0000'; context.fillRect(0, 0, 1, 1);
      context.fillStyle = '#0000ff'; context.fillRect(1, 0, 1, 1);
      const image = document.createElementNS('http://www.w3.org/2000/svg', 'image');
      for (const [name, value] of Object.entries({x: 900, y: 200, width: 400, height: 400, href: canvas.toDataURL()}))
        image.setAttribute(name, value);
      svgdeckEditor.editor.svg.append(image);
    }""")
    panel = page.locator("#panel")
    panel.get_by_role("button", name="Custom…").first.click()
    dialog = panel.get_by_role("dialog", name="Custom colour")
    dialog.get_by_label("Opacity percent").fill("40")
    hex_field = dialog.get_by_label("HEX")

    def pick(x, y):
        dialog.get_by_role("button", name="Pick from slide").click()
        assert not dialog.is_visible()
        page.mouse.click(*to_screen(page, x, y))
        dialog.wait_for(state="visible")
        return hex_field.input_value()

    assert pick(400, 300) == "#0AC81E"
    assert pick(400, 205) == "#123456"
    # meet: a 2:1 image fits a square box with bands above and below.
    assert pick(1000, 400) == "#FF0000"
    assert pick(1200, 400) == "#0000FF"
    assert dialog.get_by_label("Opacity percent").input_value() == "40"

    # Escape leaves picking without changing the colour or the selection.
    dialog.get_by_role("button", name="Pick from slide").click()
    page.keyboard.press("Escape")
    dialog.wait_for(state="visible")
    assert hex_field.input_value() == "#0000FF"
    assert page.evaluate("svgdeckEditor.editor.selection.length") == 1
