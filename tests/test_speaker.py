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
