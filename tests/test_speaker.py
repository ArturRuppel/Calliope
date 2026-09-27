"""Speaker notes and real separate-window state synchronization."""
import json

from svgdeck.deck import Deck
from svgdeck.export import export
from test_editor import page, server
from test_player import page as player_page


def test_notes_roundtrip_and_live_speaker(page, server):
    page.get_by_role('tab', name='Notes', exact=True).click()
    notes = 'Opening remarks\n<not HTML> & reminders'
    page.get_by_role('textbox', name='Notes for this slide').fill(notes)
    page.evaluate('svgdeckEditor.flush()')
    _, data = server
    meta = json.loads((data / 'decks/talk/deck.json').read_text())
    assert meta['slides'][0]['notes'] == notes
    page.reload()
    page.wait_for_function('window.svgdeckEditor?.state.current')
    page.get_by_role('tab', name='Notes', exact=True).click()
    assert page.get_by_role('textbox', name='Notes for this slide').input_value() == notes
    page.goto(server[0] + '/d/talk/?speaker=1')
    page.wait_for_function('document.querySelector(".svgdeck-ready")')
    assert page.locator('.speaker-notes').inner_text() == notes
    assert page.locator('.speaker-notes not').count() == 0


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


def test_pending_notes_survive_slide_reorder(page, server):
    page.locator('#slide-add').click()
    page.wait_for_function('svgdeckEditor.state.deck.slides.length === 2')
    page.get_by_role('tab', name='Notes', exact=True).click()
    page.get_by_role('textbox', name='Notes for this slide').fill('Keep this note with its slide')
    sid = page.evaluate('svgdeckEditor.state.current')
    page.get_by_role('tab', name='Design', exact=True).click()
    page.click('#slide-menu-btn'); page.locator('#slide-up').click()
    page.wait_for_function('(id) => svgdeckEditor.state.deck.slides[0].id === id', arg=sid)
    page.evaluate('svgdeckEditor.flush()')
    meta = json.loads((server[1] / 'decks/talk/deck.json').read_text())
    assert meta['slides'][0] == {'id': sid, 'notes': 'Keep this note with its slide'}
