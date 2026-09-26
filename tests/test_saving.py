"""Regression tests for saving orchestration and active text edits."""
from test_editor import page, server


def test_flush_waits_for_pending_save_and_follow_up(page, server):
    result = page.evaluate("""async () => {
      const e = svgdeckEditor.editor;
      const original = window.fetch;
      let puts = 0, releaseFirst;
      window.fetch = async (...args) => {
        if (args[1]?.method === 'PUT' && args[0].includes('/slides/')) {
          puts += 1;
          if (puts === 1) await new Promise(resolve => { releaseFirst = resolve; });
        }
        return original(...args);
      };
      e.change(() => e.svg.setAttribute('data-save-probe', 'first'));
      const firstFlush = svgdeckEditor.flush();
      while (!releaseFirst) await new Promise(resolve => setTimeout(resolve, 5));
      e.change(() => e.svg.setAttribute('data-save-probe', 'latest'));
      let flushed = false;
      const secondFlush = svgdeckEditor.flush().then(() => { flushed = true; });
      await new Promise(resolve => setTimeout(resolve, 30));
      const waited = !flushed;
      releaseFirst();
      await Promise.all([firstFlush, secondFlush]);
      window.fetch = original;
      return { waited, puts };
    }""")
    assert result == {"waited": True, "puts": 2}
    _, data = server
    sid = page.evaluate("svgdeckEditor.state.current")
    saved = (data / "decks" / "talk" / "slides" / f"{sid}.svg").read_text()
    assert 'data-save-probe="latest"' in saved


def test_flush_propagates_save_failure(page):
    result = page.evaluate("""async () => {
      const e = svgdeckEditor.editor;
      const original = window.fetch;
      window.fetch = async (...args) => {
        if (args[1]?.method === 'PUT' && args[0].includes('/slides/')) {
          return new Response(JSON.stringify({detail: 'probe failure'}), {
            status: 500, headers: {'Content-Type': 'application/json'}
          });
        }
        return original(...args);
      };
      e.change(() => e.svg.setAttribute('data-failure-probe', 'yes'));
      try {
        await svgdeckEditor.flush();
        return { rejected: false };
      } catch (error) {
        return { rejected: true, message: error.message,
                 dirty: svgdeckEditor.state.slides.get(svgdeckEditor.state.current).dirty };
      } finally {
        window.fetch = original;
      }
    }""")
    assert result == {"rejected": True, "message": "probe failure", "dirty": True}


def test_flush_saves_active_text_without_ending_edit(page, server):
    page.evaluate("""() => {
      const e = svgdeckEditor.editor, t = e.newText({x: 300, y: 300});
      e.select([t]);
      e.editText(t, true);
    }""")
    page.keyboard.type("Still editing")
    page.evaluate("svgdeckEditor.flush()")

    _, data = server
    sid = page.evaluate("svgdeckEditor.state.current")
    saved = (data / "decks" / "talk" / "slides" / f"{sid}.svg").read_text()
    assert "Still editing" in saved
    assert page.locator(".text-edit").count() == 1
    assert page.evaluate("document.activeElement.classList.contains('text-edit')")

    page.keyboard.type(" after flush")
    page.keyboard.press("Escape")
    page.evaluate("svgdeckEditor.flush()")
    saved = (data / "decks" / "talk" / "slides" / f"{sid}.svg").read_text()
    assert "Still editing after flush" in saved

    page.keyboard.press("Control+z")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('text').textContent") == ""


def test_cleared_new_text_is_removed_after_an_active_save(page, server):
    page.evaluate("""() => {
      const e = svgdeckEditor.editor, t = e.newText({x: 300, y: 300});
      e.select([t]);
      e.editText(t, true);
    }""")
    page.keyboard.type("Temporary")
    page.evaluate("svgdeckEditor.flush()")
    page.keyboard.press("Control+a")
    page.keyboard.press("Backspace")
    page.keyboard.press("Escape")
    page.evaluate("svgdeckEditor.flush()")

    _, data = server
    sid = page.evaluate("svgdeckEditor.state.current")
    saved = (data / "decks" / "talk" / "slides" / f"{sid}.svg").read_text()
    assert "Temporary" not in saved
    assert "<text" not in saved


def test_conflict_keeps_flush_rejected(page, server):
    _, data = server
    sid = page.evaluate("svgdeckEditor.state.current")
    path = data / "decks" / "talk" / "slides" / f"{sid}.svg"
    path.write_text(path.read_text().replace("#ffffff", "#fefefe"))
    result = page.evaluate("""async () => {
      const e = svgdeckEditor.editor;
      e.change(() => e.svg.setAttribute('data-conflict-probe', 'yes'));
      const rejected = [];
      for (let i = 0; i < 2; i++) {
        try { await svgdeckEditor.flush(); rejected.push(false); }
        catch (error) { rejected.push(error.message.length > 0); }
      }
      return rejected;
    }""")
    assert result == [True, True]
    assert "data-conflict-probe" not in path.read_text()


def test_present_and_export_stay_in_editor_on_save_failure(page):
    result = page.evaluate("""async () => {
      const original = window.fetch, originalOpen = window.open;
      let closed = 0, opened = 0, navigated = false;
      const requests = [];
      window.open = () => {
        opened++;
        return { close: () => closed++, location: { set href(value) { navigated = true; } } };
      };
      window.fetch = async (...args) => {
        if (args[1]?.method === 'PUT' && args[0].includes('/slides/')) {
          requests.push(args[0]);
          return new Response(JSON.stringify({detail:'review failure'}), {status:500});
        }
        return original(...args);
      };
      try {
        svgdeckEditor.editor.change(() => svgdeckEditor.editor.svg.setAttribute('data-latest', 'unsaved'));
        const originalURL = location.href;
        await document.getElementById('present').onclick();
        await document.getElementById('export').onclick({preventDefault() {}});
        return {closed, opened, navigated, stayed:location.href === originalURL, attempts:requests.length};
      } finally { window.fetch = original; window.open = originalOpen; }
    }""")
    assert result == {"closed": 1, "opened": 1, "navigated": False, "stayed": True, "attempts": 2}


def test_typing_activates_unload_protection_before_autosave(page):
    page.evaluate("""() => {
      const e = svgdeckEditor.editor, t = e.newText({x:300,y:300});
      e.select([t]); e.editText(t, true);
    }""")
    page.keyboard.type("Protect this text")
    result = page.evaluate("""() => {
      const event = new Event('beforeunload', {cancelable:true});
      window.dispatchEvent(event);
      return {prevented:event.defaultPrevented, dirty:svgdeckEditor.state.slides.get(svgdeckEditor.state.current).dirty};
    }""")
    assert result == {"prevented": True, "dirty": True}


def test_flush_does_not_normalize_untouched_rich_text(page):
    result = page.evaluate("""async () => {
      const e = svgdeckEditor.editor, ns = 'http://www.w3.org/2000/svg';
      e.change(() => {
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', '200');
        t.setAttribute('y', '300');
        t.setAttribute('style', 'font-size:40px;stroke:#000;stroke-width:3');
        const line = document.createElementNS(ns, 'tspan');
        line.setAttribute('x', '200');
        line.setAttribute('y', '300');
        line.setAttribute('style', 'stroke:none');
        const sub = document.createElementNS(ns, 'tspan');
        sub.setAttribute('style', 'font-size:65%;baseline-shift:sub');
        sub.textContent = 'l2';
        line.append('T', sub);
        t.append(line);
        e.svg.append(t);
        e.selection = [t];
      });
      await svgdeckEditor.flush();
      const before = e.serialize();
      const undoBefore = svgdeckEditor.state.slides.get(svgdeckEditor.state.current).undo.length;
      e.editText(e.selection[0], false);
      await svgdeckEditor.flush();
      e.endTextEdit(true);
      return {
        unchanged: e.serialize() === before,
        undoDelta: svgdeckEditor.state.slides.get(svgdeckEditor.state.current).undo.length - undoBefore,
      };
    }""")
    assert result == {"unchanged": True, "undoDelta": 0}
