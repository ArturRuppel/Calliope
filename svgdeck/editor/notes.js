// Notes are plain text, stored with the slide entry in deck.json.
export function installNotes({state,putDeck,toast,mount=document.body}) {
  const drafts = new Map();
  let current = null, queued = null, last = Promise.resolve(), timer = null;
  const panel = document.createElement('section'); panel.className = 'notes-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', 'Speaker notes');
  const title = document.createElement('h2'); title.textContent = 'Speaker notes';
  const text = document.createElement('textarea'); text.setAttribute('aria-label', 'Notes for this slide');
  text.placeholder = 'Notes appear only in speaker view.';
  const status = document.createElement('span'); status.setAttribute('role', 'status');
  const save = document.createElement('button'); save.className = 'btn'; save.textContent = 'Save notes';
  const close = document.createElement('button'); close.className = 'btn'; close.textContent = 'Close notes';
  close.onclick = () => { panel.hidden = true; };
  panel.append(title,text,save,close,status); mount.append(panel);
  text.addEventListener('input', () => {
    if (!current) return;
    drafts.set(current,text.value); status.textContent = 'Unsaved notes';
    clearTimeout(timer); timer = setTimeout(() => flush().catch(e => toast(`Notes not saved: ${e.message}`)),700);
  });
  function render() {
    const value = drafts.get(state.current) ?? state.deck?.slides.find(s => s.id === state.current)?.notes ?? '';
    if (current === state.current && text.value === value) return;
    current = state.current;
    text.value = value;
    status.textContent = drafts.has(current) ? 'Unsaved notes' : 'Saved';
  }
  // putDeck queues deck writes and builds each from the latest deck, so a
  // flush only has to queue one write that takes the drafts as they are when
  // it runs. queued: that write while it waits; last: the latest write.
  function flush() {
    clearTimeout(timer);
    if (queued) return queued;
    if (!drafts.size) return last;
    let batch = null;
    const write = putDeck(deck => {
      queued = null;
      if (!drafts.size) return null;
      batch = new Map(drafts);
      return {...deck,slides:deck.slides.map(s => batch.has(s.id) ? {...s,notes:batch.get(s.id)} : s)};
    }).then(() => {
      if (batch) for (const [id,value] of batch) if (drafts.get(id) === value) drafts.delete(id);
      if (!drafts.has(current)) status.textContent = 'Saved';
    }, e => { if (queued === write) queued = null; status.textContent = 'Notes not saved'; throw e; });
    queued = write;
    last = write.catch(() => {});
    return write;
  }
  save.onclick = () => flush().catch(e => toast(`Notes not saved: ${e.message}`));
  window.addEventListener('beforeunload', e => {if (drafts.size) { e.preventDefault(); e.returnValue=''; }});
  return {render,flush,open(focus=true) {render();panel.hidden=false;if (focus) text.focus();}};
}
