// Notes are plain text, stored with the slide entry in deck.json.
export function installNotes({state,putDeck,toast}) {
  const drafts = new Map();
  let current = null, pending = null, timer = null;
  const panel = document.createElement('section'); panel.className = 'notes-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', 'Speaker notes');
  const title = document.createElement('h2'); title.textContent = 'Speaker notes';
  const text = document.createElement('textarea'); text.setAttribute('aria-label', 'Notes for this slide');
  text.placeholder = 'Notes appear only in speaker view.';
  const status = document.createElement('span'); status.setAttribute('role', 'status');
  const save = document.createElement('button'); save.className = 'btn'; save.textContent = 'Save notes';
  const close = document.createElement('button'); close.className = 'btn'; close.textContent = 'Close notes';
  close.onclick = () => { panel.hidden = true; };
  panel.append(title,text,save,close,status); document.body.append(panel);
  text.addEventListener('input', () => {
    if (!current) return;
    drafts.set(current,text.value); status.textContent = 'Unsaved notes';
    clearTimeout(timer); timer = setTimeout(() => flush().catch(e => toast(`Notes not saved: ${e.message}`)),700);
  });
  function render() {
    if (current === state.current) return;
    current = state.current;
    text.value = drafts.get(current) ?? state.deck?.slides.find(s => s.id === current)?.notes ?? '';
    status.textContent = drafts.has(current) ? 'Unsaved notes' : 'Saved';
  }
  async function flush() {
    clearTimeout(timer);
    if (pending) { await pending; if (drafts.size) return flush(); return; }
    if (!drafts.size) return;
    pending = (async () => {
      while (drafts.size) {
        const batch = new Map(drafts);
        const slides = state.deck.slides.map(s => batch.has(s.id) ? {...s,notes:batch.get(s.id)} : s);
        await putDeck({...state.deck,slides});
        for (const [id,value] of batch) if (drafts.get(id) === value) drafts.delete(id);
      }
      status.textContent = 'Saved';
    })().catch(e => {status.textContent='Notes not saved'; throw e;}).finally(() => {pending=null;});
    return pending;
  }
  save.onclick = () => flush().catch(e => toast(`Notes not saved: ${e.message}`));
  window.addEventListener('beforeunload', e => {if (drafts.size) { e.preventDefault(); e.returnValue=''; }});
  return {render,flush,open() {render();panel.hidden=false;text.focus();}};
}
