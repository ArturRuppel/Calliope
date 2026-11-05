// Explicit, immutable full-deck snapshots. Autosave continues to own the working copy.
export function installCommits({state, api, flush, settle, toast,
                                renderStrip, openSlide, refreshStatus}) {
  let dialog = null;
  let busy = false;

  function button(label, action, className = "") {
    const el = document.createElement("button");
    el.type = "button"; el.textContent = label; el.className = className;
    el.addEventListener("click", async () => {
      if (busy) return;
      el.disabled = true;
      try { await action(); } catch (error) { toast(error.message, 9000); }
      finally { el.disabled = false; }
    });
    return el;
  }

  function ensureDialog() {
    if (dialog) return dialog;
    if (!document.querySelector("link[data-svgdeck-commits]")) {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = globalThis.CalliopeRuntime?.asset("/editor/commits.css") ?? "/editor/commits.css"; css.dataset.svgdeckCommits = "true";
      document.head.append(css);
    }
    dialog = document.createElement("dialog");
    dialog.className = "commits-dialog";
    dialog.setAttribute("aria-label", "Deck commits");
    dialog.innerHTML = `<form method="dialog"><header><div><strong>Deck commits</strong><small>Autosave updates the working copy. A commit keeps an immutable full-deck snapshot.</small></div><button value="close" aria-label="Close">×</button></header></form><div class="commits-body"></div>`;
    dialog.addEventListener("click", event => { if (event.target === dialog && !busy) dialog.close(); });
    dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
    document.body.append(dialog);
    return dialog;
  }

  async function expectedVersions() {
    const versions = {};
    for (const item of state.deck.slides) {
      const rec = state.slides.get(item.id);
      if (rec?.dirty || rec?.saving || rec?.conflict) throw new Error(`Slide ${item.id} is not safely saved yet`);
      if (rec?.version) versions[item.id] = rec.version;
      else versions[item.id] = (await api.slide(item.id)).version;
    }
    return {deck: state.version, slides: versions};
  }

  // A 409 means the deck or a slide moved on under us. Refresh what the client
  // knows of the deck before telling the user what to do next.
  async function conflictError(error) {
    if (error?.status !== 409) return error;
    try {
      const known = state.deck.slides.map(slide => slide.id).join();
      const fresh = await api.deck();
      state.deck = fresh.deck;
      state.version = fresh.version;
      let stale = fresh.deck.slides.map(slide => slide.id).join() !== known;
      for (const item of fresh.deck.slides) {
        const rec = state.slides.get(item.id);
        if (rec?.version && !rec.dirty && !rec.saving && !rec.conflict &&
            (await api.slide(item.id)).version !== rec.version) stale = true;
      }
      if (stale) return new Error("The deck was changed somewhere else; reload the page.");
      return new Error("The deck changed while committing. It has been refreshed; try again.");
    } catch (_) {
      return new Error("The deck changed somewhere else; reload the page.");
    }
  }

  async function create(message) {
    if (busy) throw new Error("Another commit operation is still running");
    busy = true; setClosable(false);
    try {
    settle?.();
    await flush();
    const expected = await expectedVersions();
    const result = await api.createCommit(message, expected.deck, expected.slides);
    toast("Deck committed.");
    return result;
    } catch (error) { throw await conflictError(error); }
    finally { busy = false; setClosable(true); }
  }

  function setClosable(enabled) {
    const close = dialog?.querySelector("header button");
    if (close) close.disabled = !enabled;
  }

  async function restore(item) {
    if (busy) throw new Error("Another commit operation is still running");
    busy = true; setClosable(false);
    try {
    settle?.();
    await flush();
    const expected = await expectedVersions();
    const current = state.current;
    const result = await api.restoreCommit(item.id, expected.deck, expected.slides);
    state.deck = result.deck;
    state.version = result.version;
    for (const rec of state.slides.values()) clearTimeout(rec.timer);
    state.slides.clear();
    renderStrip();
    const wanted = result.deck.slides.some(slide => slide.id === current)
      ? current : result.deck.slides[0]?.id;
    state.current = null;
    if (wanted) await openSlide(wanted);
    refreshStatus();
    const title = result.deck.title || document.body.dataset.deck;
    const titleNode = document.getElementById("deck-title");
    if (titleNode) titleNode.textContent = title;
    document.title = `${title} · svgdeck`;
    toast("Commit restored. The replaced working copy was saved as a safety commit.", 7000);
    } catch (error) { throw await conflictError(error); }
    finally { busy = false; setClosable(true); }
  }

  function showDiff(body, text, label) {
    let panel = body.querySelector(".commit-diff");
    if (!panel) {
      panel = document.createElement("section"); panel.className = "commit-diff";
      body.append(panel);
    }
    const title = document.createElement("h3"); title.textContent = label;
    const pre = document.createElement("pre"); pre.textContent = text || "No differences.";
    panel.replaceChildren(title, pre);
    panel.scrollIntoView({block: "nearest"});
  }

  async function render() {
    const body = ensureDialog().querySelector(".commits-body");
    body.textContent = "Loading commits…";
    const items = await api.commits();
    body.replaceChildren();

    const createSection = document.createElement("section");
    createSection.className = "commit-create";
    const input = document.createElement("input");
    input.type = "text"; input.maxLength = 500; input.placeholder = "What changed?";
    input.setAttribute("aria-label", "Commit message");
    const save = button("Commit working copy", async () => {
      const message = input.value.trim();
      if (!message) { input.focus(); throw new Error("Enter a commit message"); }
      await create(message); input.value = ""; await render();
    }, "primary");
    createSection.append(input, save);
    body.append(createSection);

    const history = document.createElement("section");
    history.innerHTML = "<h3>History</h3>";
    if (!items.length) history.insertAdjacentHTML("beforeend", "<p>No commits yet. The first working edit still protects the original deck as a baseline.</p>");
    for (const item of items) {
      const row = document.createElement("article"); row.className = "commit-row";
      const description = document.createElement("div");
      const message = document.createElement("strong"); message.textContent = item.message || "Untitled commit";
      const meta = document.createElement("small");
      meta.textContent = `${new Date(item.created * 1000).toLocaleString()} · ${item.slides} slide${item.slides === 1 ? "" : "s"} · ${item.id.slice(0, 8)}`;
      description.append(message, meta);
      const actions = document.createElement("div"); actions.className = "commit-actions";
      const choices = [
        button("Previous diff", async () => showDiff(body, await api.commitDiff(item.id, "parent"), "Changes in this commit")),
        button("Working diff", async () => {
          settle?.(); await flush();
          showDiff(body, await api.commitDiff(item.id, "working"), "Commit compared with working copy");
        }),
        // Restoring replaces the whole deck, so it takes a second, explicit click.
        button("Restore", async () => {
          const ask = document.createElement("span"); ask.className = "commit-confirm"; ask.setAttribute("role", "alert");
          ask.textContent = `Restore \u201c${item.message || "Untitled commit"}\u201d? The whole deck goes back to this snapshot; the current working copy is saved as a safety commit first.`;
          actions.replaceChildren(ask,
            button("Confirm restore", async () => { await restore(item); dialog.close(); }, "danger"),
            button("Keep working copy", async () => actions.replaceChildren(...choices)));
        }, "danger")
      ];
      actions.append(...choices);
      row.append(description, actions); history.append(row);
    }
    body.append(history);
    input.focus();
  }

  async function open() {
    settle?.();
    const el = ensureDialog();
    el.showModal();
    try { await render(); }
    catch (error) {
      const body = el.querySelector(".commits-body");
      body.textContent = `Could not load commits: ${error.message}`;
    }
  }

  return {open, commit: create};
}
