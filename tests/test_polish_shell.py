"""Editor shell polish: position fields, line style, undo state, arrow nudges,
deck settings, the decks page's rename/duplicate/restore-as, PDF downloads,
replacing media and the system clipboard."""
import json
import re
import shutil

import pytest

from conftest import open_doc_menu
from test_editor import BROWSER, add_rects, page, playwright, rect_boxes, saved_slide, server, to_screen  # noqa: F401

SAVED = "document.getElementById('status').textContent.includes('Saved')"


def deck_dir(server):
    _, data = server
    return data / "decks" / "talk"


def geometry(page):
    box = page.evaluate("svgdeckEditor.editor.selectionGeometry()")
    return {k: round(v, 1) for k, v in box.items()}


def select_rect(page, index=0):
    page.evaluate(f"""(() => {{ const e = svgdeckEditor.editor;
      e.select([e.svg.querySelectorAll('rect:not([data-locked])')[{index}]]); }})()""")


def toast_text(page):
    return page.locator("#toast").text_content()


def type_into(page, selector, value):
    page.locator(selector).fill(str(value))
    page.locator(selector).press("Enter")


# --- 1: position and size ------------------------------------------------------------------------
def test_position_fields_show_and_set_the_selection_bounds(page):
    add_rects(page, [[100, 100, 200, 100]])
    select_rect(page)
    assert [page.locator(f"#pos-{k}").input_value() for k in "xywh"] == ["100", "100", "200", "100"]
    type_into(page, "#pos-x", 300)
    assert geometry(page) == {"x": 300, "y": 100, "width": 200, "height": 100}
    # Enter keeps the field focused, so another value can be typed.
    assert page.evaluate("document.activeElement.id") == "pos-x"
    type_into(page, "#pos-w", 400)
    assert geometry(page) == {"x": 300, "y": 100, "width": 400, "height": 100}
    assert page.locator("#pos-h").input_value() == "100"
    # Locked, W and H stay in proportion.
    page.click("#pos-lock")
    assert page.get_attribute("#pos-lock", "aria-pressed") == "true"
    type_into(page, "#pos-h", 200)
    assert geometry(page) == {"x": 300, "y": 100, "width": 800, "height": 200}
    assert page.locator("#pos-w").input_value() == "800"
    assert page.evaluate("svgdeckEditor.state.prefs.lockAspect") is True
    # Each typed value is one undo step.
    page.evaluate("svgdeckEditor.undo()")
    assert rect_boxes(page) == [[300, 100, 400, 100]]


def test_position_fields_round_to_one_decimal_and_ignore_a_changed_selection(page):
    add_rects(page, [[10.04, 20.06, 30.56, 40], [500, 500, 50, 50]])
    select_rect(page)
    assert page.locator("#pos-x").input_value() == "10"
    assert page.locator("#pos-w").input_value() == "30.6"
    page.locator("#pos-y").fill("999")
    select_rect(page, 1)  # the typed value belonged to the other rect
    assert geometry(page)["y"] == 500
    page.evaluate("svgdeckEditor.editor.select([])")
    assert page.locator("#pos-x").count() == 0


def test_position_fields_follow_arrow_nudges(page):
    add_rects(page, [[100, 100, 50, 50]])
    select_rect(page)
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("ArrowRight")
    page.keyboard.press("Shift+ArrowDown")
    assert page.locator("#pos-x").input_value() == "101"
    assert page.locator("#pos-y").input_value() == "110"


# --- 2: line style and corners ---------------------------------------------------------------------
def dash(page):
    return page.evaluate("""getComputedStyle(svgdeckEditor.editor.svg.querySelector('rect:not([data-locked])'))
      .strokeDasharray""")


def numbers(value):
    return [float(n) for n in re.findall(r"[\d.]+", value)]


def stroked_rect(page):
    add_rects(page, [[100, 100, 200, 100]])
    select_rect(page)
    page.evaluate("""(() => { const e = svgdeckEditor.editor; e.change(() => {
      e.applyStyle(e.selection[0], 'stroke', '#000000'); e.applyStyle(e.selection[0], 'stroke-width', '4'); }); })()""")


def test_dash_presets_follow_the_line_width_and_ends(page):
    stroked_rect(page)
    assert page.locator("#stroke-dash").input_value() == "solid"
    page.select_option("#stroke-dash", "dashed")
    assert numbers(dash(page)) == [16, 8]  # flat ends: 4 × width, 2 × width
    assert page.locator("#stroke-dash").input_value() == "dashed"
    # Round ends grow into the gaps, so the pattern leaves room for them.
    page.locator('#panel [data-cap="round"]').click()
    style = page.evaluate("getComputedStyle(svgdeckEditor.editor.selection[0]).strokeLinecap")
    assert style == "round" and numbers(dash(page)) == [12, 12]
    assert page.locator('#panel [data-cap="round"]').get_attribute("aria-pressed") == "true"
    page.select_option("#stroke-dash", "dotted")
    assert numbers(dash(page)) == [0, 8]
    assert page.locator("#stroke-dash").input_value() == "dotted"
    page.select_option("#stroke-dash", "solid")
    assert dash(page) == "none"
    page.locator('#panel [data-join="bevel"]').click()
    assert page.evaluate("getComputedStyle(svgdeckEditor.editor.selection[0]).strokeLinejoin") == "bevel"


def test_custom_dash_pattern(page):
    stroked_rect(page)
    assert page.locator("#stroke-dash-custom").is_hidden()
    page.select_option("#stroke-dash", "custom")
    assert page.locator("#stroke-dash-custom").is_visible()
    type_into(page, "#stroke-dash-custom", "5, 3 1 3")
    assert numbers(dash(page)) == [5, 3, 1, 3]
    assert page.locator("#stroke-dash").input_value() == "custom"
    assert page.locator("#stroke-dash-custom").input_value() == "5 3 1 3"
    type_into(page, "#stroke-dash-custom", "dashes please")
    assert page.locator("#stroke-dash-custom").get_attribute("aria-invalid") == "true"
    assert "dash pattern" in toast_text(page)
    assert numbers(dash(page)) == [5, 3, 1, 3]


def test_corner_radius_of_rects(page, server):
    stroked_rect(page)
    assert page.locator("#corner-radius").input_value() == "0"
    type_into(page, "#corner-radius", 20)
    assert page.evaluate("svgdeckEditor.editor.selection[0].getAttribute('rx')") == "20"
    assert 'rx="20"' in saved_slide(page, server)
    # Lines have line style but no corners.
    page.evaluate("""(() => { const e = svgdeckEditor.editor, l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      e.change(() => { for (const [k, v] of Object.entries({x1: 10, y1: 10, x2: 300, y2: 10, stroke: '#000'})) l.setAttribute(k, v);
        e.svg.append(l); }); e.select([l]); })()""")
    assert page.locator("#stroke-dash").count() == 1 and page.locator("#corner-radius").count() == 0


# --- 3: undo and redo state ------------------------------------------------------------------------
def disabled(page, sel):
    return page.evaluate(f"document.querySelector('{sel}').disabled") and \
        page.get_attribute(sel, "aria-disabled") == "true"


def test_undo_and_redo_are_disabled_with_nothing_to_do(page):
    assert disabled(page, "#undo") and disabled(page, "#redo")
    add_rects(page, [[10, 10, 50, 50]])
    assert not disabled(page, "#undo") and disabled(page, "#redo")
    page.click("#undo")
    assert disabled(page, "#undo") and not disabled(page, "#redo")
    page.click("#redo")
    assert not disabled(page, "#undo") and disabled(page, "#redo")
    # A new slide has its own, empty history.
    page.click("#slide-add")
    page.wait_for_function("svgdeckEditor.state.deck.slides.length === 2")
    assert disabled(page, "#undo") and disabled(page, "#redo")
    page.locator("#thumbs li").first.click()
    page.wait_for_function("svgdeckEditor.state.deck.slides[0].id === svgdeckEditor.state.current")
    assert not disabled(page, "#undo")
    # While editing text both stay available: they end the edit first.
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, 300, 300))
    assert not disabled(page, "#undo") and not disabled(page, "#redo")
    page.keyboard.press("Control+z")  # keys act as before


# --- 4: arrow keys nudge ----------------------------------------------------------------------------
def test_arrow_keys_nudge_as_one_undo_step(page):
    add_rects(page, [[100, 100, 50, 50]])
    select_rect(page)
    page.evaluate("document.activeElement.blur()")
    for key in ["ArrowRight", "ArrowRight", "Shift+ArrowDown", "ArrowLeft", "Shift+ArrowUp", "Shift+ArrowUp"]:
        page.keyboard.press(key)
    assert geometry(page)["x"] == 101 and geometry(page)["y"] == 90
    # Undo right away still takes back the whole run of presses.
    page.click("#undo")
    assert rect_boxes(page) == [[100, 100, 50, 50]]
    select_rect(page)
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(700)
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(700)
    page.click("#undo")
    assert rect_boxes(page) == [[100, 101, 50, 50]]


def test_arrow_keys_leave_fields_text_edits_and_menus_alone(page):
    add_rects(page, [[100, 100, 50, 50]])
    select_rect(page)
    page.locator("#pos-x").focus()
    page.keyboard.press("ArrowLeft")
    assert geometry(page)["x"] == 100
    page.evaluate("svgdeckEditor.commits.open()")
    page.get_by_label("Commit message").focus()
    page.keyboard.press("ArrowRight")
    assert geometry(page)["x"] == 100
    page.keyboard.press("Escape")
    # Arrow keys move between the deck menu's items, not the selection.
    select_rect(page)
    open_doc_menu(page)
    first = page.evaluate("document.activeElement.id")
    page.keyboard.press("ArrowDown")
    assert page.evaluate("document.activeElement.id") != first
    page.keyboard.press("ArrowUp")
    assert page.evaluate("document.activeElement.id") == first
    assert geometry(page)["y"] == 100
    page.keyboard.press("Escape")
    # Not while a text is being edited.
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, 600, 600))
    page.keyboard.type("abc")
    page.keyboard.press("ArrowLeft")
    assert page.evaluate("!!svgdeckEditor.editor.textEdit")
    assert page.evaluate("svgdeckEditor.state.slides.get(svgdeckEditor.state.current).undo.length") == 1


# --- 5: deck settings -------------------------------------------------------------------------------
def open_deck_settings(page):
    open_doc_menu(page)
    page.click("#deck-settings")
    page.wait_for_selector("#settings-dialog[open]")


def deck_json(server):
    return json.loads((deck_dir(server) / "deck.json").read_text())


def test_deck_title_and_background(page, server):
    open_deck_settings(page)
    assert page.locator("#settings-title").text_content() == "Deck settings"
    type_into(page, "#deck-title-field", "Better title")
    page.wait_for_function("svgdeckEditor.state.deck.title === 'Better title'")
    assert deck_json(server)["title"] == "Better title"
    assert page.locator("#deck-title").text_content() == "Better title"
    assert page.title().startswith("Better title")
    page.locator('#settings-dialog button[aria-label="#1f77b4"]').first.click()
    page.wait_for_function("svgdeckEditor.state.deck.background === '#1f77b4'")
    assert deck_json(server)["background"] == "#1f77b4"


def test_slide_size_changes_every_slide(page, server):
    add_rects(page, [[100, 100, 50, 50]])
    page.click("#slide-add")
    page.wait_for_function("svgdeckEditor.state.deck.slides.length === 2")
    page.locator("#thumbs li").first.click()
    page.wait_for_function("svgdeckEditor.state.deck.slides[0].id === svgdeckEditor.state.current")
    open_deck_settings(page)
    assert page.locator("#deck-size").input_value() == "0"
    assert page.locator("#deck-width").is_hidden()
    page.select_option("#deck-size", "custom")
    page.locator("#deck-width").fill("1600")
    page.locator("#deck-height").fill("1200")
    messages = []
    page.once("dialog", lambda d: (messages.append(d.message), d.accept()))
    page.click("#deck-size-apply")
    page.wait_for_function("svgdeckEditor.state.deck.size[0] === 1600")
    assert "all 2 slides" in messages[0]
    assert page.evaluate("svgdeckEditor.editor.size") == [1600, 1200]
    page.evaluate("svgdeckEditor.flush()")
    page.wait_for_function(SAVED)
    assert deck_json(server)["size"] == [1600, 1200]
    for sid in [s["id"] for s in deck_json(server)["slides"]]:
        svg = (deck_dir(server) / "slides" / f"{sid}.svg").read_text()
        assert 'viewBox="0 0 1600 1200"' in svg and 'width="1600"' in svg and 'height="1200"' in svg
        background = re.search(r'<rect [^>]*id="background"[^>]*>', svg).group(0)
        assert 'width="1600"' in background and 'height="1200"' in background
    # The content keeps its coordinates, and the change undoes per slide.
    first = deck_json(server)["slides"][0]["id"]
    assert '<rect x="100" y="100" width="50" height="50"' in (deck_dir(server) / "slides" / f"{first}.svg").read_text()
    page.locator("#settings-close").click()
    page.click("#undo")
    assert page.evaluate("svgdeckEditor.editor.size") == [1920, 1080]


def test_slide_size_preset_can_be_cancelled(page, server):
    open_deck_settings(page)
    page.select_option("#deck-size", "3")
    assert page.locator("#deck-width").input_value() == "1024"
    page.once("dialog", lambda d: d.dismiss())
    page.click("#deck-size-apply")
    page.wait_for_timeout(200)
    assert page.evaluate("svgdeckEditor.state.deck.size") == [1920, 1080]
    assert deck_json(server)["size"] == [1920, 1080]


# --- 6: decks page ----------------------------------------------------------------------------------
@pytest.fixture
def decks_page(server):
    url, _ = server
    with playwright.sync_playwright() as p:
        browser = getattr(p, BROWSER).launch()
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(e))
        page.goto(f"{url}/")
        page.wait_for_selector("#decks [data-delete='talk']")
        yield page
        browser.close()
        assert not errors


def test_decks_page_rename_with_inline_error(decks_page, server):
    _, data = server
    bodies = []

    def rename(route):
        body = json.loads(route.request.post_data)
        bodies.append(body)
        if body["name"] == "taken":
            route.fulfill(status=409, json={"detail": "a deck with that name exists"})
            return
        (data / "decks" / "talk").rename(data / "decks" / body["name"])
        route.fulfill(status=200, json={"name": body["name"], "title": "A talk", "slides": 1, "modified": 0})

    decks_page.route("**/api/decks/talk/rename", rename)
    decks_page.click("[data-rename='talk']")
    field = decks_page.locator("#decks .inline input")
    assert field.input_value() == "talk"
    field.fill("taken")
    field.press("Enter")
    decks_page.wait_for_function("document.querySelector('#decks .row-error').textContent.includes('exists')")
    field.fill("bad name!")
    decks_page.locator("#decks .inline [data-act=ok]").click()
    assert "letters, digits" in decks_page.locator("#decks .row-error").text_content()
    field.fill("talk-2")
    decks_page.locator("#decks .inline [data-act=ok]").click()
    decks_page.wait_for_selector("#decks [data-delete='talk-2']")
    assert bodies == [{"name": "taken"}, {"name": "talk-2"}]
    assert decks_page.locator("#decks a.primary").get_attribute("href") == "/edit/talk-2"


def test_decks_page_duplicate(decks_page, server):
    _, data = server
    requests = []

    def duplicate(route):
        requests.append(route.request.post_data)
        if len(requests) == 1:
            route.fulfill(status=500, json={"detail": "disk full"})
            return
        shutil.copytree(data / "decks" / "talk", data / "decks" / "talk-copy")
        route.fulfill(status=201, json={"name": "talk-copy", "title": "A talk", "slides": 1, "modified": 0})

    decks_page.route("**/api/decks/talk/duplicate", duplicate)
    decks_page.click("[data-duplicate='talk']")
    decks_page.wait_for_function("document.querySelector('#decks .row-error').textContent === 'disk full'")
    decks_page.click("[data-duplicate='talk']")
    decks_page.wait_for_selector("#decks [data-delete='talk-copy']")
    assert decks_page.locator("#decks .row-error").first.text_content() == ""
    assert json.loads(requests[1]) == {}


def test_restore_under_another_name_when_the_name_is_taken(decks_page, server):
    url, data = server
    sent = []

    def restore(route):
        body = route.request.post_data
        sent.append(body)
        if not body:
            route.continue_()  # the real server: 409, the name is taken
            return
        name = json.loads(body)["name"]
        token = route.request.url.split("/api/trash/")[1].split("/")[0]
        (data / "trash" / token).rename(data / "decks" / name)
        route.fulfill(status=200, json={"name": name, "title": "A talk", "slides": 1, "modified": 0})

    decks_page.route("**/api/trash/*/restore", restore)
    delete = decks_page.locator("#decks [data-delete='talk']")
    delete.click()
    delete.click()
    decks_page.wait_for_selector("#deleted [data-restore]")
    decks_page.request.post(f"{url}/api/decks", data={"name": "talk", "title": "New talk"})
    decks_page.reload()
    decks_page.locator("#deleted [data-restore]").click()
    field = decks_page.locator("#deleted .inline input")
    field.wait_for()
    assert "exists" in decks_page.locator("#deleted .inline label").text_content()
    assert field.input_value() == "talk-restored"
    decks_page.locator("#deleted .inline [data-act=ok]").click()
    decks_page.wait_for_selector("#decks [data-delete='talk-restored']")
    assert decks_page.locator("#decks [data-delete='talk']").count() == 1
    assert decks_page.locator("#deleted").inner_html() == ""
    assert sent[0] is None and json.loads(sent[1]) == {"name": "talk-restored"}


# --- 7: PDF downloads ---------------------------------------------------------------------------------
def test_pdf_download(page):
    urls = []

    def pdf(route):
        urls.append(route.request.url)
        route.fulfill(status=200, body=b"%PDF-1.4 test", headers={
            "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="talk.pdf"'})

    page.route("**/api/decks/talk/pdf*", pdf)
    open_doc_menu(page)
    assert page.get_attribute("#download-pdf", "href") == "/api/decks/talk/pdf"
    assert page.locator("#download-handout").count() == 0
    with page.expect_download() as info:
        page.click("#download-pdf")
    assert info.value.suggested_filename == "talk.pdf"
    assert urls == [urls[0]] and urls[0].endswith("/api/decks/talk/pdf")


def test_pdf_not_available_shows_the_reason(page):
    page.route("**/api/decks/talk/pdf*", lambda route: route.fulfill(
        status=501, json={"detail": "PDF export needs Playwright on the server."}))
    downloads = []
    page.on("download", lambda d: downloads.append(d))
    open_doc_menu(page)
    page.click("#download-pdf")
    page.wait_for_function("document.getElementById('toast').textContent.includes('needs Playwright')")
    assert downloads == []


# --- 8: replace media -----------------------------------------------------------------------------------
def insert_image(page, tmp_path, name="photo.png", size=(400, 200)):
    from PIL import Image
    png = tmp_path / name
    Image.new("RGB", size, (200, 30, 30)).save(png)
    page.set_input_files("#media-file", str(png))
    page.wait_for_function("svgdeckEditor.editor.selection.length === 1 && svgdeckEditor.editor.selection[0].localName === 'image'")
    return png


def test_replace_image_uploads_and_calls_the_media_tools(page, tmp_path):
    insert_image(page, tmp_path)
    page.evaluate("""(() => { const e = svgdeckEditor.editor; window.target = e.selection[0];
      e.mediaTools.replace = (el, info) => { window.replaced = { same: el === window.target, info }; }; })()""")
    from PIL import Image
    other = tmp_path / "other.png"
    Image.new("RGB", (300, 300), (0, 0, 200)).save(other)
    with page.expect_file_chooser() as chooser:
        page.click("#replace-media")
    chooser.value.set_files(str(other))
    page.wait_for_function("window.replaced")
    replaced = page.evaluate("window.replaced")
    assert replaced["same"] is True
    assert replaced["info"]["width"] == 300 and "other" in replaced["info"]["href"]
    assert "Replaced the image" in toast_text(page)
    # From the actions menu and the inspector too.
    page.locator("#object-actions").click()
    assert page.locator("#context-menu").get_by_role("menuitem", name="Replace image…").count() == 1
    page.keyboard.press("Escape")
    assert page.locator("#panel button", has_text="Replace image…").count() == 1


def test_replace_failure_shows_a_toast(page, tmp_path):
    insert_image(page, tmp_path)
    page.evaluate("() => { svgdeckEditor.editor.mediaTools.replace = () => { throw new Error('unsupported file'); }; }")
    from PIL import Image
    other = tmp_path / "other.png"
    Image.new("RGB", (30, 30)).save(other)
    with page.expect_file_chooser() as chooser:
        page.locator("#panel button", has_text="Replace image…").click()
    chooser.value.set_files(str(other))
    page.wait_for_function("document.getElementById('toast').textContent.includes('unsupported file')")
    assert "Could not replace" in toast_text(page)


# --- 9: system clipboard -----------------------------------------------------------------------------------
def grant(page):
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])


def paste_event(page, text, mime="text/plain"):
    return page.evaluate("""([text, mime]) => {
      const data = new DataTransfer(); data.setData(mime, text);
      return document.body.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
    }""", [text, mime])


def shapes(page, tag):
    return page.evaluate(f"svgdeckEditor.editor.svg.querySelectorAll('{tag}:not([data-locked])').length")


def test_copy_writes_svg_markup_and_our_own_copy_pastes_internally(page):
    grant(page)
    add_rects(page, [[100, 100, 200, 100]])
    select_rect(page)
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("Control+c")
    page.wait_for_function("navigator.clipboard.readText().then(t => t.startsWith('<svg'))")
    text = page.evaluate("navigator.clipboard.readText()")
    assert 'xmlns="http://www.w3.org/2000/svg"' in text and "<rect" in text and 'viewBox="100 100 200 100"' in text
    assert paste_event(page, text) is False
    assert shapes(page, "rect") == 2
    # The internal paste: offset as always, not moved to the paste point.
    assert geometry(page)["x"] == 124
    # Cut writes it too.
    page.evaluate("navigator.clipboard.writeText('')")
    page.keyboard.press("Control+x")
    page.wait_for_function("navigator.clipboard.readText().then(t => t.startsWith('<svg'))")
    assert shapes(page, "rect") == 1


def test_svg_markup_from_elsewhere_pastes_as_objects(page):
    markup = """<?xml version="1.0"?>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="#ff0000">
        <title>icon</title><defs><linearGradient id="g"><stop offset="0" stop-color="#00f"/></linearGradient></defs>
        <circle id="dot" cx="50" cy="50" r="40" onclick="alert(1)"/><script>window.ran = true</script>
        <rect x="0" y="0" width="10" height="10" style="fill:url(#g)"/></svg>"""
    page.mouse.move(*to_screen(page, 800, 500))
    assert paste_event(page, markup) is False
    sel = page.evaluate("svgdeckEditor.editor.selection.map(e => e.localName)")
    assert sel == ["g"]  # the root's fill is kept on a group
    box = geometry(page)
    assert box["x"] + box["width"] / 2 == pytest.approx(800, abs=2)
    assert box["y"] + box["height"] / 2 == pytest.approx(500, abs=2)
    svg = page.evaluate("svgdeckEditor.editor.serialize()")
    assert "<script" not in svg and "onclick" not in svg and "<title" not in svg
    gradient = re.search(r'<linearGradient [^>]*id="(g-copy-\w+)"', svg).group(1)
    assert f"url(#{gradient})" in svg and 'fill="#ff0000"' in svg
    # One undo step takes it all back.
    page.evaluate("svgdeckEditor.undo()")
    assert shapes(page, "circle") == 0


def test_svg_fragment_without_namespace_pastes(page):
    assert paste_event(page, '  <rect x="10" y="20" width="50" height="40" fill="blue"/>') is False
    assert page.evaluate("svgdeckEditor.editor.selection[0].localName") == "rect"
    assert geometry(page)["width"] == 50


def test_plain_text_pastes_as_a_text_object(page, server):
    page.mouse.move(*to_screen(page, 400, 300))
    assert paste_event(page, "Hello\r\nworld\n") is False
    sel = page.evaluate("svgdeckEditor.editor.selection.map(e => e.localName)")
    assert sel == ["text"]
    lines = page.evaluate("Array.from(svgdeckEditor.editor.selection[0].children, c => c.textContent)")
    assert lines == ["Hello", "world"]
    assert float(page.evaluate("svgdeckEditor.editor.selection[0].getAttribute('x')")) == pytest.approx(400, abs=2)
    assert "Hello</tspan>" in saved_slide(page, server)


def test_context_menu_paste_reads_text_from_the_system_clipboard(page):
    grant(page)
    page.evaluate("navigator.clipboard.writeText('<svg><ellipse cx=\"0\" cy=\"0\" rx=\"30\" ry=\"20\"/></svg>')")
    x, y = to_screen(page, 600, 400)
    page.mouse.click(x, y, button="right")
    page.locator("#context-menu").get_by_role("menuitem", name="Paste", exact=True).click()
    page.wait_for_function("svgdeckEditor.editor.selection[0]?.localName === 'ellipse'")
    box = geometry(page)
    assert box["x"] == pytest.approx(570, abs=2) and box["y"] == pytest.approx(380, abs=2)


def test_internal_copy_wins_when_the_system_clipboard_could_not_be_written(page):
    page.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: () => Promise.reject(new Error('no'))}})")
    add_rects(page, [[100, 100, 20, 20]])
    select_rect(page)
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("Control+c")
    page.wait_for_function("svgdeckEditor.state.clipboardText.wrote === false")
    assert paste_event(page, "older text from another app") is False
    assert shapes(page, "rect") == 2 and shapes(page, "text") == 0
