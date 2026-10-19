"""Speaker view and real separate-window state synchronization."""
from svgdeck.deck import Deck
from svgdeck.export import export
from test_editor import page, server
from test_player import page as player_page


def test_speaker_view_has_the_panel_and_no_icon_bar(page, server):
    page.goto(server[0] + '/d/talk/?speaker=1')
    page.wait_for_function('document.querySelector(".svgdeck-ready")')
    # The panel carries every control; the player's own bar and board buttons stay out.
    assert page.locator('.svgdeck-controls, .svgdeck-board-tools').count() == 0
    assert page.locator('.speaker-counter').inner_text().startswith('1 / ')
    assert page.locator('.speaker-status').get_attribute('data-connected') == 'false'
    assert page.get_by_role('button', name='Open audience window').is_visible()
    assert page.get_by_role('link', name='Back to editor').get_attribute('href').endswith('/edit/talk')
    page.locator('.speaker-actions').get_by_role('button', name='Overview', exact=True).click()
    assert page.locator('.svgdeck-overview').is_visible()
    page.keyboard.press('Escape')
    assert page.locator('.svgdeck-overview').is_hidden()


def test_speaker_audience_sync_offline(player_page):
    page = player_page
    page.get_by_role('button', name='Speaker view', exact=True).click()
    page.wait_for_url('**/*speaker=1*')
    page.wait_for_function('document.querySelector(".svgdeck-ready")')
    assert page.locator('.speaker-next svg').count() == 1
    with page.expect_popup() as popup:
        page.get_by_role('button', name='Open audience window').click()
    audience = popup.value
    audience.wait_for_function('document.querySelector(".svgdeck-ready")')
    page.locator('.speaker-actions').get_by_role('button', name='Next', exact=True).click()
    audience.wait_for_function('svgdeck.svgdeck.state.index === 1')
    page.locator('.speaker-actions').get_by_role('button', name='Next', exact=True).click()
    audience.wait_for_function('svgdeck.svgdeck.state.step === 1')
    assert audience.locator('.speaker-panel').count() == 0
    page.get_by_role('button', name='Blank audience').click()
    audience.wait_for_function('svgdeck.svgdeck.state.blank')
    page.get_by_role('button', name='Show audience').click()
    audience.wait_for_function('!svgdeck.svgdeck.state.blank')
    audience.keyboard.press('End')
    page.wait_for_function('svgdeck.svgdeck.state.index === 2')
    assert page.locator('.speaker-next').inner_text() == 'End of presentation'
    page.get_by_role('button', name='Pause timer').click()
    value = page.get_by_label('Elapsed time').inner_text()
    page.wait_for_timeout(1100)
    assert page.get_by_label('Elapsed time').inner_text() == value
    page.get_by_role('button', name='Reset timer').click()
    assert page.get_by_label('Elapsed time').inner_text() == '00:00'
    audience.close()


def test_zoom_marks_and_pointer_reach_the_audience(player_page):
    page = player_page
    page.get_by_role('button', name='Speaker view', exact=True).click()
    page.wait_for_url('**/*speaker=1*')
    page.wait_for_function('document.querySelector(".svgdeck-ready")')
    with page.expect_popup() as popup:
        page.get_by_role('button', name='Open audience window').click()
    audience = popup.value
    audience.wait_for_function('document.querySelector(".svgdeck-ready")')
    page.wait_for_function('document.querySelector(".speaker-status").dataset.connected === "true"')
    page.evaluate("""() => {
      const pe = (type, id, x, y, pointerType) => svgdeck.dispatchEvent(new PointerEvent(type,
        {pointerId: id, clientX: x, clientY: y, pointerType, isPrimary: true, bubbles: true, button: 0}));
      pe('pointerdown', 7, 100, 100, 'pen'); pe('pointermove', 7, 200, 150, 'pen'); pe('pointerup', 7, 200, 150, 'pen');
      svgdeck.svgdeck.setLive({...svgdeck.svgdeck.live, view: {k: 2, x: 100, y: 0}, pointer: [300, 300]});
      svgdeck.dispatchEvent(new CustomEvent('svgdeck:live'));
    }""")
    audience.wait_for_function('svgdeck.svgdeck.live.view.k === 2 && svgdeck.svgdeck.live.pointer')
    assert audience.evaluate('svgdeck.svgdeck.live') == page.evaluate('svgdeck.svgdeck.live')
    assert audience.locator('.svgdeck-ink path').count() == 1
    page.locator('.speaker-actions').get_by_role('button', name='Next', exact=True).click()
    audience.wait_for_function('svgdeck.svgdeck.state.index === 1')
    audience.wait_for_function('svgdeck.svgdeck.live.ink.length === 0 && svgdeck.svgdeck.live.view.k === 1')
    page.wait_for_timeout(200)
    assert page.evaluate('svgdeck.svgdeck.live.ink.length') == 0
    page.locator('.speaker-actions').get_by_role('button', name='Board', exact=True).click()
    audience.wait_for_function('svgdeck.svgdeck.live.board')
    assert audience.locator('.svgdeck-board').is_visible() and audience.locator('.svgdeck-board-tools').count() == 0
    assert page.locator('.speaker-board-tools').is_visible()
    page.locator('.speaker-actions').get_by_role('button', name='Back to slides', exact=True).click()
    audience.wait_for_function('!svgdeck.svgdeck.live.board')
    assert page.locator('.speaker-board-tools').is_hidden()
    audience.close()


def test_movie_crop_and_build_visibility_in_export(deck, tmp_path):
    from playwright.sync_api import sync_playwright
    from xml.etree import ElementTree as ET
    path = deck / 'slides/b.svg'
    root = ET.fromstring(path.read_text())
    image = root.find('{http://www.w3.org/2000/svg}image')
    image.set('data-crop', '10 20 30 5')
    image.set('data-mask', 'ellipse')
    image.set('data-step', '1')
    path.write_text(ET.tostring(root, encoding='unicode'))
    out = export(Deck.load(deck), tmp_path / 'crop-export')
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto((out / 'index.html').as_uri() + '#2')
        page.wait_for_function('svgdeck.svgdeck.state.index === 1')
        video = page.locator('.svgdeck-current video')
        assert video.evaluate('v => v.style.clipPath') == 'ellipse(30% 37.5% at 40% 57.5%)'
        assert video.evaluate('v => v.paused')
        page.keyboard.press('ArrowRight')
        page.wait_for_function('!document.querySelector(".svgdeck-current video").paused')
        page.keyboard.press('ArrowLeft')
        assert video.evaluate('v => v.paused')
        browser.close()


def test_two_audience_copies_drive_each_other_through_the_app_bridge(deck, tmp_path):
    """The iPad app shows the audience page on the iPad and on the external display,
    in one session; the native bridge relays messages between them. The iPad's copy
    keeps the controls (Speaker view, board) and what is done on either side reaches
    the other."""
    import time
    import playwright.sync_api as playwright
    from test_editor import BROWSER
    url = (export(Deck.load(deck), tmp_path / "out") / "index.html").as_uri()
    with playwright.sync_playwright() as p:
        browser = getattr(p, BROWSER).launch()
        context = browser.new_context(viewport={"width": 960, "height": 540})
        errors = []
        pages = {}
        # A fake bridge: each page queues what it posts, the test carries it across.
        for role in ('speaker', 'audience'):
            page = context.new_page()
            page.on("pageerror", lambda e: errors.append(e))
            page.add_init_script(f"""
              window.__outbox = [];
              window.svgdeckNative = {{ role: '{role}', closed: false,
                postMessage: function (m) {{ window.__outbox.push(m); }} }};""")
            pages[role] = page
        ipad, external = pages['speaker'], pages['audience']

        def pump():
            for role, other in (('speaker', external), ('audience', ipad)):
                for message in pages[role].evaluate("window.__outbox.splice(0)"):
                    other.evaluate("d => window.dispatchEvent(new CustomEvent('svgdeck:native', {detail: d}))", message)

        def wait(page, expression, timeout=5.0):
            deadline = time.time() + timeout
            while True:
                pump()
                if page.evaluate(expression):
                    return
                assert time.time() < deadline, f"timed out waiting for {expression}"
                time.sleep(0.05)

        ipad.goto(url + '?session=abcd')
        ipad.wait_for_function('document.querySelector(".svgdeck-ready")')
        external.goto(url + '?session=abcd')
        external.wait_for_function('document.querySelector(".svgdeck-ready")')
        # The iPad's copy is the one the speaker works from; the external one is bare.
        assert ipad.get_by_role('button', name='Speaker view', exact=True).count() == 1
        assert ipad.locator('.svgdeck-board-tools').count() == 1
        assert external.locator('.svgdeck-board-tools, .speaker-panel').count() == 0
        assert external.get_by_role('button', name='Speaker view', exact=True).count() == 0
        wait(ipad, 'svgdeck.svgdeck.paired()')
        ipad.keyboard.press('ArrowRight')
        wait(external, 'svgdeck.svgdeck.state.index === 1')
        external.keyboard.press('ArrowLeft')
        wait(ipad, 'svgdeck.svgdeck.state.index === 0')
        ipad.evaluate("svgdeck.svgdeck.setBlank(true)")
        wait(external, 'svgdeck.svgdeck.state.blank')
        ipad.evaluate("svgdeck.svgdeck.setLive({view: {k: 2, x: 100, y: 50}, ink: [], pointer: [300, 200]})")
        ipad.evaluate("document.getElementById('svgdeck').dispatchEvent(new CustomEvent('svgdeck:live'))")
        wait(external, 'svgdeck.svgdeck.live.view.k === 2 && svgdeck.svgdeck.live.pointer?.[0] === 300')
        # Speaker view is still a tap away (the bar has hidden itself by now) and takes the session along.
        ipad.evaluate("svgdeck.svgdeck.setBlank(false); svgdeck.svgdeck.clearLive()")
        wait(external, '!svgdeck.svgdeck.state.blank && svgdeck.svgdeck.live.view.k === 1')
        ipad.get_by_role('button', name='Speaker view', exact=True, include_hidden=True).click(force=True)
        ipad.wait_for_url('**/*speaker=1*')
        ipad.wait_for_function('document.querySelector(".svgdeck-ready")')
        assert 'session=abcd' in ipad.url
        browser.close()
        assert not errors
