"""Independent integration checks for the feature review."""
from conftest import open_doc_menu
from test_editor import page, server
from svgdeck.store import Store


def test_revision_restore_refreshes_thumbnail(page, server):
    page.evaluate("""async () => {
      const e=svgdeckEditor.editor;
      e.change(()=>e.svg.querySelector('[data-label="background"]').setAttribute('fill','#eebb99'));
      await svgdeckEditor.flush();
      e.change(()=>e.svg.querySelector('[data-label="background"]').setAttribute('fill','#99bbee'));
      await svgdeckEditor.flush();
    }""")
    open_doc_menu(page)
    page.get_by_role('menuitem',name='History and recovery').click()
    page.locator('.recovery-dialog button').filter(has_text='Restore').first.click()
    page.wait_for_function("svgdeckEditor.editor.svg.querySelector('[data-label=background]').getAttribute('fill') === '#eebb99'")
    page.wait_for_function("document.querySelector('.thumbs .current .thumb [data-label=background]')?.getAttribute('fill') === '#eebb99'")


def test_conflict_snapshot_does_not_discard_newer_edits(page, server):
    page.evaluate("""() => {
      const e=svgdeckEditor.editor;
      e.change(()=>e.svg.querySelector('[data-label="background"]').setAttribute('fill','#111111'));
      const rec=svgdeckEditor.state.slides.get(svgdeckEditor.state.current);
      clearTimeout(rec.timer); rec.conflict=true;
    }""")

    def respond_after_edit(route):
        response = route.fetch()
        page.evaluate("""() => svgdeckEditor.editor.change(()=>
          svgdeckEditor.editor.svg.querySelector('[data-label="background"]').setAttribute('fill','#222222'))""")
        route.fulfill(response=response)

    page.route('**/preserve-conflict', respond_after_edit)
    recovered = page.evaluate('svgdeckEditor.recovery.preserveConflict(svgdeckEditor.state.current)')
    current = page.evaluate('svgdeckEditor.state.current')
    assert current != recovered
    assert page.evaluate('svgdeckEditor.state.slides.get(svgdeckEditor.state.current).conflict')
    assert '#222222' in page.evaluate('svgdeckEditor.state.slides.get(svgdeckEditor.state.current).text')
    assert b'#111111' in Store(server[1]).get_slide('talk',recovered)[0]


def test_conflict_recovery_treats_orphan_as_deleted(tmp_path, monkeypatch):
    import svgdeck.store as storage
    store = Store(tmp_path)
    rec = store.create_deck('talk','Talk')
    sid = rec['deck']['slides'][0]['id']
    svg,_ = store.get_slide('talk',sid)
    store.put_slide('talk','second',svg,None)
    meta = {**rec['deck'],'slides':[{'id':'second'}]}
    monkeypatch.setattr(storage.shutil,'move',lambda *a,**k: (_ for _ in ()).throw(OSError('busy')))
    store.put_deck('talk',meta,rec['version'])
    assert store.slide_path('talk',sid).exists()
    result = store.preserve_conflict('talk',sid,svg)
    assert result['original'] is None
    assert result['recovered'] in [s['id'] for s in result['deck']['slides']]
