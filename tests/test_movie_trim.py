"""Temporal crops survive editor saves and constrain offline movie playback."""
import shutil

import pytest

from conftest import MOVIES, SLIDE, write_deck
from svgdeck.deck import Deck
from svgdeck.export import export
from test_editor import page, saved_slide, server

pytestmark = pytest.mark.skipif(not MOVIES, reason="movies require Chromium")


def add_movie(page, server, movie):
    _, data = server
    shutil.copy(movie, data / 'decks/talk/media/clip.webm')
    page.evaluate("""() => {
      const e = svgdeckEditor.editor;
      e.change(() => {
        const image = document.createElementNS(e.svg.namespaceURI, 'image');
        for (const [k,v] of Object.entries({id:'clip',x:100,y:100,width:640,height:480,
          href:'', 'data-video':'/d/talk/media/clip.webm'})) image.setAttribute(k,v);
        e.svg.append(image); e.select([image]);
      });
    }""")


def open_trim(page):
    page.get_by_role('button', name='Trim', exact=True).click()
    page.wait_for_function("!document.querySelector('[aria-label=\"Start time\"]').disabled")


def change_time(page, label, value):
    field = page.get_by_label(label + ' time', exact=True)
    field.fill(str(value)); field.dispatch_event('change')


def test_editor_save_undo_cancel_reset_and_preview(page, server, movie):
    add_movie(page, server, movie)
    open_trim(page)
    change_time(page, 'Start', 1)
    change_time(page, 'End', 2)
    page.get_by_role('button', name='Play excerpt', exact=True).click()
    page.wait_for_function("document.querySelector('.movie-trim video').paused && document.querySelector('.movie-trim video').currentTime >= 2")
    page.get_by_role('button', name='Apply trim', exact=True).click()
    svg = saved_slide(page, server)
    assert 'data-video-start="1"' in svg and 'data-video-end="2"' in svg
    assert 'data-video="../media/clip.webm"' in svg
    page.locator('#undo').click()
    assert not page.locator('#clip').get_attribute('data-video-start')
    page.locator('#redo').click()
    assert page.locator('#clip').get_attribute('data-video-start') == '1'
    saved_slide(page, server)
    page.reload(); page.wait_for_selector('#clip')
    page.evaluate("svgdeckEditor.editor.select([document.getElementById('clip')])")
    open_trim(page)
    assert page.get_by_label('Start time', exact=True).input_value() == '1'
    change_time(page, 'Start', 3)
    assert page.get_by_role('button', name='Apply trim', exact=True).is_disabled()
    page.get_by_role('button', name='Cancel', exact=True).click()
    assert page.locator('#clip').get_attribute('data-video-start') == '1'
    open_trim(page)
    page.get_by_role('button', name='Reset to full movie', exact=True).click()
    page.get_by_role('button', name='Apply trim', exact=True).click()
    svg = saved_slide(page, server)
    assert 'data-video-start' not in svg and 'data-video-end' not in svg


def player_page(page, movie, tmp_path, attributes):
    body = '<image href="" data-video="../media/clip.webm" x="0" y="0" width="640" height="480" ' + attributes + '/>'
    deck = write_deck(tmp_path / 'trimmed', [('a',SLIDE.format(color='#000',body=body)),
       ('b',SLIDE.format(color='#000',body=body))], {'clip.webm':movie})
    out = export(Deck.load(deck),tmp_path / 'out')
    page.goto((out / 'index.html').as_uri())
    page.wait_for_function("document.querySelector('.svgdeck-current video')?.readyState >= 2")


def test_offline_autoplay_stop_and_reentry(page, movie, tmp_path):
    player_page(page,movie,tmp_path,'data-video-start="1" data-video-end="1.6" data-loop="false"')
    page.wait_for_function("document.querySelector('.svgdeck-current video').paused && document.querySelector('.svgdeck-current video').currentTime >= 1.6")
    assert page.locator('.svgdeck-current video').evaluate('v => v.currentTime') == pytest.approx(1.6,abs=.05)
    page.keyboard.press('ArrowRight')
    page.wait_for_function("document.querySelector('.svgdeck-current video').currentTime > 1.1")
    page.keyboard.press('ArrowLeft')
    assert page.locator('.svgdeck-current video').evaluate('v => v.currentTime') < 1.4


def test_offline_loop_stays_in_excerpt(page,movie,tmp_path):
    player_page(page,movie,tmp_path,'data-video-start="1" data-video-end="1.5"')
    page.evaluate("""() => {
      const v = document.querySelector('.svgdeck-current video');
      window.samples=[]; window.wraps=0; let previous=v.currentTime;
      v.addEventListener('timeupdate', () => {
        if(v.currentTime < previous - .1) window.wraps++;
        previous=v.currentTime; window.samples.push(previous);
      });
    }""")
    page.wait_for_function('window.wraps >= 2')
    assert all(.99 <= t <= 1.55 for t in page.evaluate('window.samples'))
    assert not page.locator('.svgdeck-current video').evaluate('v => v.loop')


def test_sync_uses_source_time_and_respects_different_ranges(page,movie,tmp_path):
    player_page(page,movie,tmp_path,'data-video-start="1" data-video-end="3" data-sync="group"')
    page.wait_for_function("document.querySelector('.svgdeck-current video').currentTime > 1.6")
    before=page.locator('.svgdeck-current video').evaluate('v => v.currentTime')
    page.keyboard.press('ArrowRight')
    assert page.locator('.svgdeck-current video').evaluate('v => v.currentTime') >= before-.1
    # A different excerpt in the same sync group restarts if source time falls outside it.
    page.evaluate("document.querySelectorAll('video')[0].movieRange.setRange({start:3.2,end:3.8})")
    page.keyboard.press('ArrowLeft')
    assert page.locator('.svgdeck-current video').evaluate('v => v.currentTime') >= 3.2


def test_no_autoplay_shows_trim_start_after_metadata(page,movie,tmp_path):
    player_page(page,movie,tmp_path,'data-video-start="2" data-video-end="3" data-autoplay="false"')
    page.wait_for_function("document.querySelector('.svgdeck-current video').currentTime >= 2")
    assert page.locator('.svgdeck-current video').evaluate('v => v.paused')
