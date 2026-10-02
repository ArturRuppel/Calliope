"""The editor shell: inspector re-rendering, saving and leaving, slide loading
failures, deck writes, settings, keyboard focus and the decks page."""
import json

from conftest import open_doc_menu, pick_tool
from test_editor import add_rects, page, server, to_screen

SAVED = "document.getElementById('status').textContent.includes('Saved')"
BAD_SVG = "<svg xmlns='http://www.w3.org/2000/svg'><rect></svg"


def deck_dir(server):
    _, data = server
    return data / "decks" / "talk"


def add_slide_file(page, server, sid, text):
    """A second slide written straight into the deck, then the editor reloaded."""
    deck = deck_dir(server)
    (deck / "slides" / f"{sid}.svg").write_text(text)
    meta = json.loads((deck / "deck.json").read_text())
    meta["slides"].append({"id": sid})
    (deck / "deck.json").write_text(json.dumps(meta))
    page.reload()
    page.wait_for_function(SAVED)


def page_errors(page):
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    return errors


def toast(page):
    return page.locator("#toast").text_content()


# --- 1: inspector re-rendering -------------------------------------------------------------
def test_typed_value_then_canvas_tap_applies_it_without_errors(page, server):
    errors = page_errors(page)
    add_rects(page, [[100, 100, 200, 100]])
    page.evaluate("svgdeckEditor.editor.selectAll()")
    page.get_by_role("tab", name="Design").click()
    page.locator("#panel section", has_text="Rotate and flip").locator("input[type=number]").fill("60")
    page.mouse.click(1000, 850)
    assert errors == []
    assert page.evaluate("Math.round(svgdeckEditor.editor.angleOf(svgdeckEditor.editor.svg.querySelector('rect:not([data-locked])')))") == 60


def test_rerendering_the_panel_with_a_focused_field_is_safe(page, server):
    errors = page_errors(page)
    add_rects(page, [[100, 100, 200, 100]])
    page.evaluate("svgdeckEditor.editor.selectAll()")
    page.get_by_role("tab", name="Design").click()
    page.locator("#panel section", has_text="Rotate and flip").locator("input[type=number]").fill("45")
    # Deselecting re-renders the panel, which removes the focused field.
    page.evaluate("svgdeckEditor.editor.select([])")
    assert errors == []
    assert page.locator("#panel .heading", has_text="Nothing selected").count() == 1
    # The value was typed for the rectangle; it is not applied to the new (empty) selection.
    assert page.evaluate("Math.round(svgdeckEditor.editor.angleOf(svgdeckEditor.editor.svg.querySelector('rect:not([data-locked])')))") == 0
    # A field whose change re-renders the panel while it is being re-rendered.
    spacing = page.locator("#panel .row", has_text="Spacing").locator("input")
    spacing.fill("30")
    spacing.dispatch_event("change")
    page.evaluate("svgdeckEditor.editor.select([])")
    assert errors == []
    assert page.evaluate("svgdeckEditor.state.prefs.grid.size") == 30


# --- 2: leaving saves first ------------------------------------------------------------------
def leave_saves_first(page, server, click):
    url, _ = server
    requests = []
    page.on("request", lambda r: requests.append((r.method, r.url)))
    page.evaluate("(() => { const e = svgdeckEditor.editor; e.change(() => e.svg.setAttribute('data-leave-probe', 'yes')); })()")
    with page.expect_navigation(url=f"{url}/"):
        click()
    sid = json.loads((deck_dir(server) / "deck.json").read_text())["slides"][0]["id"]
    assert 'data-leave-probe="yes"' in (deck_dir(server) / "slides" / f"{sid}.svg").read_text()
    put = next(i for i, (m, u) in enumerate(requests) if m == "PUT" and "/slides/" in u)
    nav = next(i for i, (m, u) in enumerate(requests) if m == "GET" and u == f"{url}/")
    assert put < nav


def test_all_decks_saves_before_leaving(page, server):
    def click():
        open_doc_menu(page)
        page.locator("#doc-menu").get_by_role("menuitem", name="All decks").click()
    leave_saves_first(page, server, click)


def test_back_arrow_saves_before_leaving(page, server):
    leave_saves_first(page, server, lambda: page.click("#back"))


# --- 3: hiding the page saves without ending the text edit -----------------------------------
def test_hiding_the_page_saves_but_keeps_editing(page, server):
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, 300, 300))
    page.keyboard.type("Half written")
    page.evaluate("""() => {
      Object.defineProperty(document, 'hidden', {value: true, configurable: true});
      document.dispatchEvent(new Event('visibilitychange'));
    }""")
    page.wait_for_function(SAVED)
    sid = page.evaluate("svgdeckEditor.state.current")
    page.wait_for_function("svgdeckEditor.state.slides.get(svgdeckEditor.state.current).dirty === false")
    assert "Half written" in (deck_dir(server) / "slides" / f"{sid}.svg").read_text()
    assert page.evaluate("!!svgdeckEditor.editor.textEdit")
    assert page.locator(".text-edit").count() == 1


def hide_page(page):
    page.evaluate("""() => {
      Object.defineProperty(document, 'hidden', {value: true, configurable: true});
      document.dispatchEvent(new Event('visibilitychange'));
    }""")


def test_hiding_the_page_keeps_a_path_being_drawn(page, server):
    pick_tool(page, "bezier")
    for x, y in ((200, 200), (400, 250)):
        page.mouse.click(*to_screen(page, x, y))
    assert page.evaluate("svgdeckEditor.editor.pathDraft.nodes.length") == 2
    hide_page(page)
    page.wait_for_timeout(200)
    assert page.evaluate("svgdeckEditor.editor.pathDraft?.nodes.length") == 2
    assert page.evaluate("svgdeckEditor.editor.svg.querySelectorAll('path').length") == 0


# --- 4, 5: slides that cannot be opened --------------------------------------------------------
def test_invalid_slide_is_not_overwritten_by_the_open_one(page, server):
    add_slide_file(page, server, "sbad", BAD_SVG)
    first = page.evaluate("svgdeckEditor.state.current")
    page.locator('#thumbs li[data-id="sbad"]').click()
    page.wait_for_function("document.getElementById('toast').textContent.includes('Could not open slide 2')")
    assert page.evaluate("svgdeckEditor.state.current") == first
    assert page.locator("#thumbs li.current").get_attribute("data-id") == first
    add_rects(page, [[10, 10, 50, 50]])
    page.evaluate("svgdeckEditor.flush()")
    assert (deck_dir(server) / "slides" / "sbad.svg").read_text() == BAD_SVG
    assert "<rect x=\"10\"" in (deck_dir(server) / "slides" / f"{first}.svg").read_text()


def test_failed_slide_fetch_can_be_retried(page, server):
    blank = (deck_dir(server) / "slides" / f"{page.evaluate('svgdeckEditor.state.current')}.svg").read_text()
    failing = {"on": True}

    def handle(route):
        if failing["on"] and route.request.method == "GET":
            route.fulfill(status=500, body="boom")
        else:
            route.continue_()
    page.route("**/api/decks/talk/slides/stwo", handle)
    errors = page_errors(page)
    add_slide_file(page, server, "stwo", blank.replace("#ffffff", "#123456"))
    first = page.evaluate("svgdeckEditor.state.current")
    page.locator('#thumbs li[data-id="stwo"]').click()
    page.wait_for_function("document.getElementById('toast').textContent.includes('Could not open slide 2')")
    assert page.evaluate("svgdeckEditor.state.current") == first
    failing["on"] = False
    page.locator('#thumbs li[data-id="stwo"]').click()
    page.wait_for_function("svgdeckEditor.state.current === 'stwo'")
    assert "#123456" in page.evaluate("svgdeckEditor.editor.svg.outerHTML")
    assert errors == []


# --- 7: the app's own overlapping deck writes ---------------------------------------------------
def test_overlapping_deck_writes_both_succeed(page, server):
    page.evaluate("""() => {
      const original = window.fetch;
      let slowed = false;
      window.fetch = async (url, init) => {
        const u = String(url), put = init?.method === 'PUT';
        // The notes write is slow to reach the server; adding the slide's file too.
        if (put && /\\/api\\/decks\\/talk$/.test(u) && !slowed) { slowed = true; await new Promise(r => setTimeout(r, 500)); }
        if (put && u.includes('/slides/') && !init.headers?.['If-Match']) await new Promise(r => setTimeout(r, 250));
        return original(url, init);
      };
      document.getElementById('slide-add').click();
      setTimeout(() => {
        const notes = document.querySelector('.notes-panel textarea');
        notes.value = 'spoken words';
        notes.dispatchEvent(new Event('input'));
        [...document.querySelectorAll('.notes-panel button')].find(b => b.textContent === 'Save notes').click();
      }, 50);
    }""")
    page.wait_for_function("""svgdeckEditor.state.deck.slides.length === 2 &&
      document.querySelector('.notes-panel [role=status]').textContent !== 'Unsaved notes'""", timeout=10000)
    page.wait_for_function(SAVED)
    meta = json.loads((deck_dir(server) / "deck.json").read_text())
    assert len(meta["slides"]) == 2
    assert meta["slides"][0].get("notes") == "spoken words"
    assert "changed somewhere else" not in toast(page)


# --- 8: saving while offline ---------------------------------------------------------------------
def test_offline_saving_backs_off_with_one_toast(page, server):
    puts = []

    def offline(route):
        if route.request.method == "PUT":
            puts.append(route.request.url)
            route.abort()
        else:
            route.continue_()
    page.route("**/api/decks/talk/slides/*", offline)
    page.evaluate("""() => {
      window.toasts = [];
      new MutationObserver(() => toasts.push(document.getElementById('toast').textContent))
        .observe(document.getElementById('toast'), {childList: true, characterData: true, subtree: true});
      const e = svgdeckEditor.editor;
      e.change(() => e.svg.setAttribute('data-offline-probe', 'yes'));
    }""")
    page.wait_for_timeout(4500)  # the first save (0.7 s) and one retry (3 s later)
    assert len(puts) == 2
    toasts = page.evaluate("toasts")
    assert len([t for t in toasts if "Saving failed" in t]) == 1
    assert "Not saved" in page.locator("#status").text_content()
    page.unroute("**/api/decks/talk/slides/*")
    page.evaluate("window.dispatchEvent(new Event('online'))")
    page.wait_for_function(SAVED)
    assert "Saving works again" in toast(page)
    sid = page.evaluate("svgdeckEditor.state.current")
    assert 'data-offline-probe="yes"' in (deck_dir(server) / "slides" / f"{sid}.svg").read_text()


# --- 9, 10: the Pencil and controller dialog ------------------------------------------------------
def open_pencil_settings(page):
    open_doc_menu(page)
    page.click("#pen-status")


def test_pencil_tool_select_sets_the_pencils_tool(page):
    open_pencil_settings(page)
    page.select_option('select[aria-label="Pencil tool"]', "erase")
    assert page.evaluate("svgdeckEditor.editor.tools.pen") == "erase"
    assert page.evaluate("svgdeckEditor.state.prefs.penTool") == "erase"


def test_closing_the_dialog_stops_learning_a_binding(page):
    open_pencil_settings(page)
    page.get_by_role("button", name="Assign a key or button").click()
    assert page.evaluate("!!svgdeckEditor.controller.learning")
    page.click("#settings-close")
    assert page.evaluate("svgdeckEditor.controller.learning") is None
    page.keyboard.press("v")
    assert page.evaluate("'key:KeyV' in svgdeckEditor.state.prefs.bindings") is False


# --- 11: keys on a focused button ------------------------------------------------------------------
def add_selected_text(page):
    page.evaluate("""(() => { const e = svgdeckEditor.editor, ns = 'http://www.w3.org/2000/svg';
      e.change(() => { const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', '200'); t.setAttribute('y', '300'); t.setAttribute('font-size', '40');
        t.textContent = 'hello'; e.svg.append(t); });
      e.select([e.svg.querySelector('text')]); })()""")


def test_enter_and_delete_on_a_focused_button_do_not_act_on_the_canvas(page):
    add_selected_text(page)
    page.locator("#sel-bar button", has_text="Align").focus()
    page.keyboard.press("Enter")
    assert page.evaluate("svgdeckEditor.editor.textEdit") is None
    assert page.locator("#align-row").is_visible()  # the button was activated
    page.locator("#panel button", has_text="Underline").first.focus()
    page.keyboard.press("Delete")
    page.keyboard.press("Backspace")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelectorAll('text').length") == 1
    # On the canvas (nothing focused) the keys work as before.
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("Enter")
    assert page.evaluate("!!svgdeckEditor.editor.textEdit")


# --- 12: Undo while editing text --------------------------------------------------------------------
def test_toolbar_undo_while_editing_ends_the_edit_first(page):
    add_rects(page, [[10, 10, 50, 50]])  # an earlier step to undo
    page.keyboard.press("t")
    page.mouse.click(*to_screen(page, 300, 300))
    page.keyboard.type("Keep me")
    page.click("#undo")
    assert page.evaluate("svgdeckEditor.editor.textEdit") is None
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('text')?.textContent") == "Keep me"
    page.click("#undo")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('text')?.textContent || ''") == ""
    assert page.evaluate("svgdeckEditor.editor.svg.querySelectorAll('rect:not([data-locked])').length") == 1
    page.click("#redo")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('text')?.textContent") == "Keep me"
    # Redo while editing ends the edit too, and keeps it.
    page.mouse.dblclick(*to_screen(page, 320, 290))
    page.wait_for_function("!!svgdeckEditor.editor.textEdit")
    page.keyboard.press("End")
    page.keyboard.type(" too")
    page.click("#redo")
    assert page.evaluate("svgdeckEditor.editor.textEdit") is None
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('text')?.textContent") == "Keep me too"


# --- 14: an empty deck -------------------------------------------------------------------------------
def test_empty_deck_says_so(page, server):
    errors = page_errors(page)
    meta = json.loads((deck_dir(server) / "deck.json").read_text())
    meta["slides"] = []
    (deck_dir(server) / "deck.json").write_text(json.dumps(meta))
    page.reload()
    page.wait_for_function("document.getElementById('toast').textContent.includes('no slides')")
    assert errors == []


# --- 16: the decks page ------------------------------------------------------------------------------
def test_decks_page_shows_load_errors(page, server):
    url, _ = server
    page.route("**/api/decks", lambda route: route.fulfill(status=500, body="Internal Server Error", content_type="text/plain"))
    page.goto(f"{url}/")
    page.wait_for_function("document.getElementById('status').textContent !== ''")
    assert "Could not load the decks" in page.locator("#status").text_content()
    assert "Loading" not in page.locator("#decks").text_content()


def test_decks_page_tolerates_a_non_json_error(page, server):
    url, _ = server
    page.goto(f"{url}/")
    page.route("**/api/decks/talk", lambda route: route.fulfill(status=502, body="<html>Bad gateway</html>", content_type="text/html"))
    delete = page.locator("[data-delete=talk]")
    delete.click()
    delete.click()
    page.wait_for_function("document.getElementById('status').textContent !== ''")
    assert "Could not delete the deck" in page.locator("#status").text_content()
    assert page.locator("[data-delete=talk]").count() == 1


# --- 17: stored preferences and new defaults ------------------------------------------------------------
def test_stored_prefs_keep_new_defaults(page):
    page.evaluate("""localStorage.setItem('svgdeck-prefs', JSON.stringify({
      grid: {show: true}, bindings: {'key:F9': 'pen:bezier', 'pad:0': 'pen:text'}}))""")
    page.reload()
    page.wait_for_function(SAVED)
    prefs = page.evaluate("svgdeckEditor.state.prefs")
    assert prefs["grid"] == {"show": True, "snap": False, "size": 20}
    assert prefs["bindings"]["key:F9"] == "pen:bezier"
    assert prefs["bindings"]["pad:0"] == "pen:text"  # the user's choice wins
    assert prefs["bindings"]["pad:15"] == "next-slide"  # a default it did not know
    # A removed default stays removed.
    page.evaluate("svgdeckEditor.controller.unbind('pad:1')")
    page.reload()
    page.wait_for_function(SAVED)
    assert page.evaluate("svgdeckEditor.state.prefs.bindings['pad:1'] ?? null") is None


# --- 19: Escape closes the flyout first ---------------------------------------------------------------
def test_escape_closes_the_flyout_and_keeps_the_tool(page):
    pick_tool(page, "rect")
    page.click('#tools [data-family="paths"]')
    assert page.locator("#tool-flyout").count() == 1
    page.keyboard.press("Escape")
    assert page.locator("#tool-flyout").count() == 0
    assert page.evaluate("svgdeckEditor.editor.tools.touch") == "rect"
