import os
import socket
import threading
import time

import pytest
import uvicorn

from svgdeck.server import create_app
from svgdeck.store import Store

playwright = pytest.importorskip("playwright.sync_api")
BROWSER = os.environ.get("SVGDECK_BROWSER", "chromium")


@pytest.fixture
def server(tmp_path):
    Store(tmp_path).create_deck("talk", "A talk")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(tmp_path), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    while not srv.started:
        time.sleep(0.02)
    yield f"http://127.0.0.1:{port}"
    srv.should_exit = True
    thread.join(5)


@pytest.fixture
def page(server):
    with playwright.sync_playwright() as p:
        browser = getattr(p, BROWSER).launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        errors = []
        page.on("pageerror", lambda error: errors.append(error))
        page.goto(f"{server}/edit/talk")
        page.wait_for_function("window.svgdeckEditor && svgdeckEditor.state.current")
        yield page
        browser.close()
        assert not errors


def install(page):
    page.wait_for_function("svgdeckEditor.objectPanels")


def open_panel(page, name):
    tab = {"Objects": "Objects", "Build steps": "Builds"}[name]
    page.locator("#inspector-tabs").get_by_role("tab", name=tab, exact=True).click()


def test_tree_rename_visibility_lock_and_order(page, server):
    page.evaluate("""() => { svgdeckEditor.editor.load(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs/><rect data-label="background" data-locked="true"/><text id="t" data-label="Text">first</text></svg>'); }""")
    install(page)
    open_panel(page, "Objects")
    page.get_by_role("button", name="Select Text").click()
    page.once("dialog", lambda dialog: dialog.accept("Heading"))
    page.get_by_role("listitem").filter(has_text="Text").get_by_role("button", name="Rename object").click()
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#t').dataset.label") == "Heading"
    heading = page.get_by_role("listitem").filter(has_text="Heading")
    heading.get_by_role("button", name="Hide object").click()
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#t').style.display") == "none"
    heading.get_by_role("button", name="Show object").click()
    heading.get_by_role("button", name="Lock object").click()
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('#t').dataset.locked") == "true"


def test_background_name_is_reserved(page):
    page.evaluate("""() => { svgdeckEditor.editor.load(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect data-label="Shape"/></svg>'); }""")
    install(page)
    open_panel(page, "Objects")
    page.once("dialog", lambda dialog: dialog.accept("background"))
    page.get_by_role("button", name="Rename object").click()
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('rect').dataset.label") == "Shape"


def test_computed_hidden_group_is_blocked_and_can_be_shown(page):
    page.evaluate("""() => { svgdeckEditor.editor.load(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.gone{display:none}.invisible{visibility:hidden}</style><g class="gone" data-label="CSS group"><rect data-label="Child"/></g><g display="none" data-label="Imported group"><path data-label="Imported child"/></g><circle class="invisible" data-label="Invisible"/></svg>'); }""")
    install(page)
    open_panel(page, "Objects")
    child = page.get_by_role("listitem").filter(has=page.get_by_role("button", name="Select Child", exact=True))
    assert child.get_attribute("data-hidden") == "true"
    imported_child = page.get_by_role("listitem").filter(has=page.get_by_role("button", name="Select Imported child", exact=True))
    assert imported_child.get_attribute("data-hidden") == "true"
    page.get_by_role("button", name="Select Child").click()
    assert page.evaluate("svgdeckEditor.editor.selection.length") == 0
    page.get_by_role("listitem").filter(has_text="CSS group").get_by_role("button", name="Show object").click()
    page.get_by_role("listitem").filter(has_text="Imported group").get_by_role("button", name="Show object").click()
    page.get_by_role("listitem").filter(has_text="Invisible").get_by_role("button", name="Show object").click()
    assert page.evaluate("""() => { const svg=svgdeckEditor.editor.svg;
      return [...svg.querySelectorAll('g')].every(g=>getComputedStyle(g).display !== 'none') && getComputedStyle(svg.querySelector('circle')).visibility === 'visible'; }""")


def test_nested_tree_group_context_and_movie_stays_top_level(page, server):
    page.evaluate("""() => { const e=svgdeckEditor.editor; e.load(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs/><g data-label="Cluster"><rect data-label="Child"/></g><image data-label="Film" data-video="m.mp4"/></svg>'); }""")
    install(page)
    open_panel(page, "Objects")
    page.get_by_role("button", name="Enter group").click()
    assert page.evaluate("svgdeckEditor.editor.context.dataset.label") == "Cluster"
    page.get_by_role("button", name="Leave current group").click()
    assert page.evaluate("svgdeckEditor.editor.context === svgdeckEditor.editor.svg")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('[data-video]').parentElement === svgdeckEditor.editor.svg")


def test_locked_ancestor_blocks_tree_edits_and_lock_exits_group(page):
    page.evaluate("""() => { const e=svgdeckEditor.editor; e.load(
      '<svg xmlns="http://www.w3.org/2000/svg"><g data-label="Group"><rect data-label="Child"/><circle data-label="Other"/></g></svg>');
      const g=e.svg.querySelector('g'); e.enterGroup(g); e.selection=[...g.children]; }""")
    install(page)
    open_panel(page, "Objects")
    group = page.get_by_role("listitem").filter(has_text="Group")
    group.get_by_role("button", name="Lock object").click()
    assert page.evaluate("""() => { const e=svgdeckEditor.editor,g=e.svg.querySelector('g');
      return g.dataset.locked === 'true' && e.context === e.svg && e.selection.length === 0; }""")
    page.get_by_role("button", name="Select Child").click()
    assert page.evaluate("svgdeckEditor.editor.selection.length") == 0
    assert page.get_by_role("button", name="Enter group").is_disabled()


def test_background_identity_and_drag_follow_visual_stack(page):
    page.evaluate("""() => { svgdeckEditor.editor.load(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect data-label="background" data-locked="true"/><rect data-label="Bottom"/><circle data-label="Top"/></svg>'); }""")
    install(page)
    open_panel(page, "Objects")
    background = page.get_by_role("listitem").filter(has_text="background")
    assert background.get_by_role("button", name="Rename object").is_disabled()
    page.evaluate("""() => { const rows=[...document.querySelectorAll('.object-row')];
      const top=rows.find(r=>r.textContent.includes('Top')), bottom=rows.find(r=>r.textContent.includes('Bottom'));
      const dt=new DataTransfer(); top.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
      bottom.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt})); }""")
    assert page.evaluate("[...svgdeckEditor.editor.svg.children].filter(e=>e.dataset.label && e.dataset.label !== 'background').map(e=>e.dataset.label)") == ["Bottom", "Top"]


def test_build_assignment_order_and_preview_is_not_serialized(page, server):
    page.evaluate("""() => { const e=svgdeckEditor.editor; e.load(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs/><rect data-label="A"/><circle data-label="B" data-step="2"/></svg>');
      e.select([e.svg.querySelector('rect')]); }""")
    install(page)
    open_panel(page, "Build steps")
    box = page.get_by_label("Build step for selected objects")
    box.fill("1")
    page.get_by_role("button", name="Assign build step").click()
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('rect').dataset.step") == "1"
    page.get_by_label("Preview build step").fill("0")
    assert page.evaluate("getComputedStyle(svgdeckEditor.editor.svg.querySelector('circle')).visibility") == "hidden"
    assert "visibility:hidden" not in page.evaluate("svgdeckEditor.editor.serialize()")
    page.evaluate("svgdeckEditor.objectPanels.render()")
    assert page.evaluate("getComputedStyle(svgdeckEditor.editor.svg.querySelector('circle')).visibility") == "visible"


def test_build_normalization_keeps_shared_steps_and_bounds_values(page):
    page.evaluate("""() => { const e=svgdeckEditor.editor; e.load(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect data-label="A" data-step="2"/><circle data-label="B" data-step="2"/><path data-label="C" data-step="8"/></svg>'); }""")
    install(page)
    open_panel(page, "Build steps")
    page.get_by_role("button", name="Assign consecutive build steps").click()
    assert page.evaluate("[...svgdeckEditor.editor.svg.children].map(e=>e.dataset.step)") == ["1", "1", "2"]
    c_step = page.get_by_label("Build step for C")
    c_step.fill("100000")
    c_step.press("Tab")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('path').dataset.step") == "2"


def test_builds_ignore_definition_resources(page):
    page.evaluate("""() => { svgdeckEditor.editor.load(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="c"><rect data-label="Definition" data-step="2"/></clipPath></defs><rect data-label="Artwork" data-step="2"/></svg>'); }""")
    install(page)
    open_panel(page, "Build steps")
    assert page.get_by_label("Build step for Definition").count() == 0
    assert page.get_by_label("Build step for Artwork").count() == 1
    page.get_by_label("Preview build step").fill("0")
    assert page.evaluate("getComputedStyle(svgdeckEditor.editor.svg.querySelector('defs rect')).visibility") != "hidden"
    assert page.evaluate("getComputedStyle(svgdeckEditor.editor.svg.querySelector(':scope > rect')).visibility") == "hidden"


def test_switching_to_objects_clears_preview(page):
    page.evaluate("""() => { svgdeckEditor.editor.load(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect data-label="A" data-step="1"/></svg>'); }""")
    install(page)
    open_panel(page, "Build steps")
    page.get_by_label("Preview build step").fill("0")
    page.locator("#inspector-tabs").get_by_role("tab", name="Objects", exact=True).click()
    assert page.evaluate("!document.querySelector('[data-svgdeck-build-preview]')")


def test_render_after_navigation_cleans_preview(page):
    page.evaluate("""() => { svgdeckEditor.editor.load(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect data-label="First" data-step="1"/></svg>'); }""")
    install(page)
    open_panel(page, "Build steps")
    page.get_by_label("Preview build step").fill("0")
    page.evaluate("""() => { svgdeckEditor.editor.load(
      '<svg xmlns="http://www.w3.org/2000/svg"><circle data-label="Second"/></svg>');
      svgdeckEditor.state.current = 'other'; svgdeckEditor.objectPanels.render(); }""")
    assert page.evaluate("!document.querySelector('[data-svgdeck-build-preview]')")
    assert page.get_by_role("button", name="Select Second").count() == 0  # builds tab has no unassigned rows
