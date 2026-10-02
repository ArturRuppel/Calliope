// Slide revision/trash browser and conflict preservation.
export function installRecovery({ state, api, toast, settle, flush, openSlide,
                                  renderStrip, refreshStatus }) {
  let dialog = null;
  let busy = false;

  function setBusy(value) {
    busy = value;
    const close = dialog?.querySelector("header button");
    if (close) close.disabled = value;
  }

  const cleanRecord = (text, version) => ({ text, version, dirty: false, saving: false,
    savePromise: null, saveError: null, conflict: false, undo: [], redo: [] });

  async function showOriginal(id, text, version) {
    state.slides.set(id, cleanRecord(text, version));
    renderStrip();
    state.current = null;
    await openSlide(id);
    refreshStatus();
  }

  async function preserveConflict(id) {
    const rec = state.slides.get(id);
    if (!rec?.text) throw new Error("There is no local slide to recover");
    settle?.();
    const snapshot = rec.text;
    try {
      const result = await api.preserveConflict(id, snapshot, rec.version);
      state.deck = result.deck;
      state.version = result.version;
      state.slides.set(result.recovered, cleanRecord(snapshot, result.recoveredVersion));
      renderStrip();
      const changedDuringSave = rec.text !== snapshot;
      if (changedDuringSave) {
        rec.conflict = true;
        rec.dirty = true;
        toast(`A snapshot was preserved as ${result.recovered}; newer local edits still need recovery.`, 10000);
      } else if (result.original != null) {
        clearTimeout(rec.timer);
        state.slides.set(id, cleanRecord(result.original, result.originalVersion));
        if (state.current === id) { state.current = null; await openSlide(id); }
      } else {
        clearTimeout(rec.timer);
        state.slides.delete(id);
        if (state.current === id) {
          state.current = null;
          await openSlide(result.recovered);
        }
      }
      if (!changedDuringSave) toast(`Your edits were preserved as recovered slide ${result.recovered}.`, 8000);
      refreshStatus();
      return result.recovered;
    } catch (error) {
      rec.conflict = true;
      rec.saveError = error;
      refreshStatus();
      downloadFallback(id, snapshot);
      toast(`Could not preserve the conflicting edits: ${error.message}`, 10000);
      throw error;
    }
  }

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    if (!document.querySelector('link[data-svgdeck-recovery]')) {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = "/editor/recovery.css"; css.dataset.svgdeckRecovery = "true";
      document.head.append(css);
    }
    dialog.className = "recovery-dialog";
    dialog.setAttribute("aria-label", "Slide recovery");
    dialog.innerHTML = `<form method="dialog"><header><strong>Slide recovery</strong><button value="close" aria-label="Close">×</button></header></form><div class="recovery-body"></div>`;
    dialog.addEventListener("click", (event) => { if (event.target === dialog && !busy) dialog.close(); });
    dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
    document.body.append(dialog);
    return dialog;
  }

  function downloadFallback(id, text) {
    const href = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    const link = document.createElement("a");
    link.href = href; link.download = `${id}-unsaved.svg`; link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function conflictsSection(body) {
    const conflicts = [...state.slides.entries()].filter(([, rec]) => rec.conflict);
    if (!conflicts.length) return;
    const section = document.createElement("section");
    section.innerHTML = "<h3>Save conflicts</h3><p>Keep both versions before continuing. The server version stays in place and your local edits become a recovered slide.</p>";
    for (const [id] of conflicts) {
      const row = document.createElement("div"); row.className = "recovery-row";
      const label = document.createElement("span"); label.textContent = id;
      row.append(label, button("Keep both versions", async () => { await preserveConflict(id); dialog.close(); }));
      section.append(row);
    }
    body.append(section);
  }

  function button(label, action) {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    el.addEventListener("click", async () => {
      if (busy) return;
      el.disabled = true; setBusy(true);
      try { await action(); } catch (error) { toast(error.message, 8000); }
      finally { el.disabled = false; setBusy(false); }
    });
    return el;
  }

  async function revisionsSection(body, id) {
    const section = document.createElement("section");
    section.innerHTML = `<h3>Earlier versions of this slide</h3>`;
    const revisions = await api.revisions(id);
    if (!revisions.length) section.insertAdjacentHTML("beforeend", "<p>No earlier versions yet.</p>");
    for (const item of revisions) {
      const row = document.createElement("div");
      row.className = "recovery-row";
      const date = document.createElement("span");
      date.textContent = new Date(item.modified * 1000).toLocaleString();
      const actions = document.createElement("span");
      actions.className = "recovery-actions";
      actions.append(button("Restore", async () => {
        await flush();
        const rec = state.slides.get(id);
        const text = await api.revision(id, item.token);
        const result = await api.restoreRevision(id, item.token, rec.version);
        await showOriginal(id, text, result.version);
        dialog.close();
        toast("Earlier version restored.");
      }));
      row.append(date, actions);
      section.append(row);
    }
    body.append(section);
  }

  async function trashSection(body) {
    const section = document.createElement("section");
    section.innerHTML = `<h3>Deleted slides</h3>`;
    const items = await api.trash();
    if (!items.length) section.insertAdjacentHTML("beforeend", "<p>No deleted slides.</p>");
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "recovery-row";
      const label = document.createElement("span");
      label.textContent = `${item.slide} · ${new Date(item.deleted * 1000).toLocaleString()}`;
      row.append(label, button("Restore", async () => {
        await flush();
        const result = await api.restoreTrash(item.token);
        state.deck = result.deck;
        state.version = result.version;
        state.slides.delete(result.slide);
        renderStrip();
        dialog.close();
        await openSlide(result.slide);
        toast("Deleted slide restored.");
      }));
      section.append(row);
    }
    body.append(section);
  }

  async function open() {
    settle?.();
    const el = ensureDialog();
    const body = el.querySelector(".recovery-body");
    body.textContent = "Loading recovery history…";
    el.showModal();
    setBusy(true);
    // Build off-screen so the loading text stays until the data has arrived.
    const content = document.createDocumentFragment();
    try {
      conflictsSection(content);
      if (state.current) await revisionsSection(content, state.current);
      await trashSection(content);
      body.replaceChildren(content);
    } catch (error) {
      const message = document.createElement("p");
      message.textContent = `Could not load recovery history: ${error.message}`;
      body.replaceChildren(message);
    } finally { setBusy(false); }
  }

  return { open, preserveConflict };
}
