"""Independent failure injection for full-deck restore publication."""
import pytest

from conftest import SLIDE
from test_commits import setup, versions
import svgdeck.store as store_module


@pytest.mark.parametrize('failure', ['backup-slides', 'publish-slides', 'publish-metadata'])
def test_restore_publish_failure_preserves_working_copy(tmp_path, monkeypatch, failure):
    _, root, store = setup(tmp_path)
    deck_version, slide_versions = versions(store)
    milestone = store.create_commit('talk', 'Milestone', deck_version, slide_versions)
    store.put_slide('talk', 'one', SLIDE.format(color='#abcdef', body='Working').encode(), slide_versions['one'])
    before = {p.name: p.read_bytes() for p in (root / 'slides').glob('*.svg')}
    metadata = (root / 'deck.json').read_bytes()
    deck_version, slide_versions = versions(store)
    replace = store_module.os.replace
    failed = False

    def injected(source, destination):
        nonlocal failed
        matches = {
            'backup-slides': source == root / 'slides',
            'publish-slides': destination == root / 'slides',
            'publish-metadata': destination == root / 'deck.json',
        }
        if matches[failure] and not failed:
            failed = True
            raise OSError('Injected publication failure')
        return replace(source, destination)

    monkeypatch.setattr(store_module.os, 'replace', injected)
    with pytest.raises(OSError, match='Injected publication failure'):
        store.restore_commit('talk', milestone['id'], deck_version, slide_versions)
    assert failed
    assert (root / 'deck.json').read_bytes() == metadata
    assert {p.name: p.read_bytes() for p in (root / 'slides').glob('*.svg')} == before
    assert not list(root.glob('.restore-*'))
