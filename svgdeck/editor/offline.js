/* The deck list's side of the offline copy (see sw.js): copies every deck's
   presenter page, media and fonts into the browser's cache, and says how
   current that copy is. Runs by itself whenever the deck list is opened. */
const CalliopeOffline = (() => {
  const CACHE = "calliope-offline-v1", STATE = "calliope-offline-state", PARALLEL = 3;
  const LISTS = ["/api/decks", "/api/trash"];
  const supported = "serviceWorker" in navigator && "caches" in window;
  let running = null;

  const readState = () => { try { return JSON.parse(localStorage.getItem(STATE)) || {}; } catch (e) { return {}; } };
  const writeState = (state) => { try { localStorage.setItem(STATE, JSON.stringify(state)); } catch (e) { /* the copy still works */ } };
  const megabytes = (bytes) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

  /** The time of the last sync, or null. */
  const lastSync = () => readState().synced || null;

  async function sync(report = () => {}) {
    if (!supported) return { ok: false, reason: "unsupported" };
    if (!running) running = run(report).finally(() => { running = null; });
    return running;
  }

  async function run(report) {
    let manifest;
    try {
      const r = await fetch("/api/offline", { cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status}`);
      manifest = await r.json();
    } catch (e) {
      return { ok: false, reason: "unreachable" };
    }
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    const cache = await caches.open(CACHE);
    const state = readState(), versions = state.versions || {};
    const wanted = [...manifest.shell, ...manifest.decks.flatMap((deck) => [deck.page, ...deck.files])];
    const present = new Set((await cache.keys()).map((request) => new URL(request.url).pathname));
    const todo = wanted.filter((item) => versions[item.url] !== item.v || !present.has(new URL(item.url, location.origin).pathname));
    const bytes = wanted.reduce((sum, item) => sum + (item.size || 0), 0);
    let done = 0, failed = 0;
    report({ done, total: todo.length });
    const queue = [...todo];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          const response = await fetch(item.url, { cache: "no-store" });
          if (!response.ok) throw new Error(`${response.status}`);
          await cache.put(item.url, response);
          versions[item.url] = item.v;
        } catch (e) {
          failed += 1;
        }
        done += 1;
        report({ done, total: todo.length });
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    // The deck list itself, as the list page asks for it.
    for (const url of LISTS) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (response.ok) await cache.put(url, response);
      } catch (e) { /* an older list is still a list */ }
    }
    // Drop what the server no longer has: deleted decks, replaced files.
    const keep = new Set(wanted.map((item) => new URL(item.url, location.origin).pathname));
    for (const request of await cache.keys()) {
      const path = new URL(request.url).pathname;
      if (!keep.has(path) && !LISTS.includes(path)) await cache.delete(request);
    }
    for (const url of Object.keys(versions)) if (!wanted.some((item) => item.url === url)) delete versions[url];
    // A deck that cannot be copied (say, a slide file gone missing) must not
    // hide the rest of the copy: the time is kept either way, with the count.
    const next = { versions, synced: Date.now(), failed, decks: manifest.decks.length, bytes };
    writeState(next);
    return failed ? { ok: false, reason: "incomplete", failed } : { ok: true, decks: next.decks, bytes };
  }

  /** Wire the status line: `el` shows the state, and a tap syncs again. */
  function attach(el) {
    // The browser build has no server to copy from: the decks already live here.
    if (window.CalliopeRuntime) return attachBrowser(el);
    if (!supported) { el.textContent = "No offline copy: this browser cannot keep one here."; return; }
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    const when = (t) => new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const show = (result) => {
      const state = readState();
      if (result.ok) el.textContent = `Offline copy up to date · ${result.decks} deck${result.decks === 1 ? "" : "s"} · ${megabytes(result.bytes)}`;
      else if (result.reason === "incomplete") el.textContent = `Offline copy incomplete: ${result.failed} file${result.failed === 1 ? "" : "s"} could not be copied. Tap to try again.`;
      else if (!state.synced) el.textContent = "Server not reachable, and no offline copy yet.";
      else el.textContent = `Server not reachable · offline copy from ${when(state.synced)}${state.failed ? `, incomplete (${state.failed} file${state.failed === 1 ? "" : "s"} missing)` : ""}`;
    };
    const go = () => sync(({ done, total }) => { if (total) el.textContent = `Copying for offline use… ${done} of ${total}`; }).then(show);
    el.addEventListener("click", go);
    navigator.serviceWorker.ready.then(go);
  }

  async function attachBrowser(el) {
    const { usage, persisted } = await CalliopeRuntime.storageSummary();
    el.textContent = `Stored in this browser${usage ? ` · ${megabytes(usage)}` : ""} · ` +
      (persisted ? "kept until you clear the site's data" : "the browser may clear it when space runs low; add Calliope to the Home Screen to keep it");
    el.style.cursor = "default";
  }

  return { attach, sync, lastSync };
})();
