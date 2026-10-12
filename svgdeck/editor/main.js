// svgdeck editor: deck state, saving, undo, slide strip, toolbar, properties.
import { SlideEditor, firstGlyphElement, cssFamily, isLayout } from "./canvas.js";
import { prefixIds, toHex } from "./geom.js";
import { Controller, DEFAULT_BINDINGS, TOOL_NAMES, actionGroups, actionLabel, inputLabel } from "./inputs.js";
import { installNotes } from "./notes.js";
import { installObjects } from "./objects.js";
import { installMediaTools } from "./media-tools.js";
import { installRecovery } from "./recovery.js";
import { installCommits } from "./commits.js";
import { createColorControl } from "./colors.js";
import { IMAGE_ADJUSTMENTS, adjustmentValue, setImageAdjustment, resetImageAdjustments, upgradeImageAdjustments } from "./image-adjustments.js";
import { openMovieTrim } from "./movie-trim.js";

const DECK = document.body.dataset.deck;
const $ = (id) => document.getElementById(id);
const PALETTE = ["#000000", "#333333", "#7c7c7c", "#c2c2c2", "#ffffff", "#92b1e5",
                 "#1f77b4", "#d62728", "#2ca02c", "#ff7f0e", "#9467bd", "#8c564b"];
const TOOLS = [
  ["select", "Select (V)", "M5 3l14 9-6 1.5L16 20l-2.5 1-3-6.5L5 18z"],
  ["pan", "Pan (H)", "M8 12V6a2 2 0 014 0v5-7a2 2 0 014 0v7-4a2 2 0 014 0v8c0 4-3 6-7 6-3 0-5-2-7-5l-3-4a2 2 0 013-2l2 2"],
  ["text", "Text (T)", "M5 5h14M12 5v14M9 19h6"],
  ["rect", "Rectangle (R)", "M4 6h16v12H4z"],
  ["ellipse", "Ellipse (E)", "M12 5c5 0 9 3.1 9 7s-4 7-9 7-9-3.1-9-7 4-7 9-7z"],
  ["circle", "Circle (C)", "M12 3a9 9 0 100 18 9 9 0 000-18"],
  ["polygon", "Polygon (G)", "M12 3l9 7-4 11H7L3 10z"],
  ["bezier", "Bézier (B)", "M3 18C3 1 21 23 21 6"],
  ["nodes", "Edit points (N)", "M4 18L8 5l12 5M6 3h4v4H6zM18 8h4v4h-4zM2 16h4v4H2z"],
  ["line", "Line (L)", "M5 19L19 5"],
  ["arrow", "Arrow (A)", "M5 19L19 5M11 5h8v8"],
  ["layout", "Layout box (F)", "M4 9V6h3M10 6h4M17 6h3v3M20 11v2M20 15v3h-3M14 18h-4M7 18H4v-3M4 13v-2"],
  ["pen", "Draw (P)", "M4 20c3-1 4-5 7-8s5-6 9-8M16 4l4 4"],
  ["erase", "Erase (X)", "M15 4l5 5-10 10H6l-3-3zM9 10l5 5M10 19h10"],
];
const KEYS = { c: "circle", g: "polygon", b: "bezier", n: "nodes", v: "select", h: "pan", t: "text", r: "rect", f: "layout", e: "ellipse", l: "line", a: "arrow", p: "pen", x: "erase" };

const api = {
  async json(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).detail || r.statusText), { status: r.status });
    return r.json();
  },
  deck: () => api.json("GET", `/api/decks/${DECK}`),
  putDeck: (deck, base) => api.json("PUT", `/api/decks/${DECK}`, { deck, base }),
  fonts: () => api.json("GET", "/api/fonts"),
  useFamily: (family) => api.json("POST", `/api/decks/${DECK}/fonts`, { family }),
  commits: () => api.json("GET", `/api/decks/${DECK}/commits`),
  createCommit: (message, expectedDeck, expectedSlides) => api.json("POST", `/api/decks/${DECK}/commits`, {message,expectedDeck,expectedSlides}),
  restoreCommit: (id, expectedDeck, expectedSlides) => api.json("POST", `/api/decks/${DECK}/commits/${encodeURIComponent(id)}/restore`, {expectedDeck,expectedSlides}),
  async commitDiff(id, target = "parent") {
    const r = await fetch(`/api/decks/${DECK}/commits/${encodeURIComponent(id)}/diff?target=${encodeURIComponent(target)}`);
    if (!r.ok) throw new Error(`Could not read commit diff: ${r.status}`);
    return r.text();
  },
  revisions: (id) => api.json("GET", `/api/decks/${DECK}/slides/${id}/revisions`),
  async revision(id, token) {
    const r = await fetch(`/api/decks/${DECK}/slides/${id}/revisions/${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(`Could not read revision: ${r.status}`);
    return r.text();
  },
  async restoreRevision(id, token, base) {
    const r = await fetch(`/api/decks/${DECK}/slides/${id}/revisions/${encodeURIComponent(token)}/restore`, {
      method:"POST", headers:{"If-Match":`"${base}"`},
    });
    if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).detail || r.statusText), {status:r.status});
    return r.json();
  },
  trash: () => api.json("GET", `/api/decks/${DECK}/trash`),
  restoreTrash: (token) => api.json("POST", `/api/decks/${DECK}/trash/${encodeURIComponent(token)}/restore`),
  async preserveConflict(id, text) {
    const r = await fetch(`/api/decks/${DECK}/slides/${id}/preserve-conflict`, {
      method:"POST", headers:{"Content-Type":"image/svg+xml"}, body:text,
    });
    if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).detail || r.statusText), {status:r.status});
    return r.json();
  },
  async slide(id) {
    const r = await fetch(`/api/decks/${DECK}/slides/${id}`);
    if (!r.ok) throw new Error(`slide ${id}: ${r.status}`);
    const etag = r.headers.get("ETag");
    if (!etag) throw new Error(`slide ${id}: the server sent no version (ETag)`);
    return { text: await r.text(), version: etag.replaceAll('"', "") };
  },
  /** keepalive lets a save started while the page hides or unloads finish
   *  (browsers allow it only for small bodies). */
  async putSlide(id, text, base, { keepalive = false } = {}) {
    const r = await fetch(`/api/decks/${DECK}/slides/${id}`, {
      method: "PUT", body: text, headers: { "Content-Type": "image/svg+xml", ...(base ? { "If-Match": `"${base}"` } : {}) },
      keepalive: keepalive && new Blob([text]).size < 60000,
    });
    if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).detail || r.statusText), { status: r.status });
    return (await r.json()).version;
  },
  async upload(url, file) {
    const r = await fetch(url, { method: "POST", body: file });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  },
};

// --- state ------------------------------------------------------------------------
const state = {
  deck: null, version: null, current: null, faces: [],
  slides: new Map(),  // id -> {text, version, dirty, saving, undo, redo, timer}
  prefs: loadPrefs(),
};
let objectPanels = null, mediaTools = null, recovery = null, notes = null, commits = null;

function loadPrefs() {
  const defaults = { fill: "#92b1e5", stroke: "none", strokeWidth: 4, textFill: "#000000", family: null,
                     weight: 400, size: 48, recent: [], grid: { show: false, snap: false, size: 20 },
                     penTool: "pen", penLinked: false, penSeen: false, pressure: true, bindings: { ...DEFAULT_BINDINGS } };
  try {
    const stored = JSON.parse(localStorage.getItem("svgdeck-prefs") || "{}");
    // Merge the objects one level deeper, so settings and bindings added
    // later appear for browsers that stored older ones.
    return { ...defaults, ...stored, grid: { ...defaults.grid, ...stored.grid },
             bindings: { ...defaults.bindings, ...stored.bindings } };
  } catch (e) { return defaults; }
}
function savePrefs() {
  try { localStorage.setItem("svgdeck-prefs", JSON.stringify(state.prefs)); } catch (e) { /* private mode */ }
}

// Media paths: slides say ../media/x (relative to slides/); the editor page
// needs URLs the server can answer.
const slideBase = `/d/${DECK}/slides/`;
const hrefIn = (v) => (/^(#|data:|[a-z][a-z0-9+.-]*:|\/)/i.test(v) ? v : new URL(v, location.origin + slideBase).pathname);
const hrefOut = (v) => {
  if (v.startsWith(location.origin)) v = v.slice(location.origin.length);
  const prefix = `/d/${DECK}/`;
  return v.startsWith(prefix) ? "../" + v.slice(prefix.length) : v;
};

let toastTimer = null;
function toast(msg, ms = 3500) {
  const t = $("toast");
  t.textContent = msg;
  t.dataset.show = "true";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.dataset.show = "false"; }, ms);
}

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").dataset.kind = kind;
}

/** Wrap an asynchronous entry point (a click, a key, an observer): a failure
 *  is shown and logged instead of being lost. Errors that already showed
 *  their own message (e.reported) are only logged. */
function guard(fn, what = "That did not work") {
  const report = (e) => {
    console.error(e);
    if (!e?.reported) toast(`${what}: ${e?.message || e}`, 8000);
  };
  return (...args) => {
    try { return Promise.resolve(fn(...args)).catch(report); } catch (e) { report(e); return Promise.resolve(); }
  };
}

// --- editor --------------------------------------------------------------------------
const editor = new SlideEditor($("stage"), {
  commit(before, after) {
    const rec = state.slides.get(state.current);
    if (!rec) return;  // no slide is open (it could not be loaded)
    rec.undo.push(before);
    if (rec.undo.length > 150) rec.undo.shift();
    rec.redo = [];
    markDirty(state.current, after);
  },
  select() { closeContextMenu(); updateActions(); renderPanel(); updateBreadcrumb(); refreshStatus(); updateHistoryButtons(); },
  contextMenu: (x, y) => showContextMenu(x, y),
  textChanged(text) {
    const rec = state.slides.get(state.current);
    if (rec && rec.text !== text) markDirty(state.current, text);
  },
  toast,
  hrefIn, hrefOut,
  shapeStyle: () => ({ fill: state.prefs.fill, stroke: state.prefs.stroke, strokeWidth: state.prefs.strokeWidth }),
  textStyle: () => ({ family: state.prefs.family || defaultFamily(), weight: state.prefs.weight,
                      size: state.prefs.size, fill: state.prefs.textFill }),
  ensureFont: (family) => ensureFamily(family),
  toolDone: (slot) => setTool("select", { keepEdit: true, slot }),
  inputChanged: () => { updateToolButtons(); renderPanel(); updateSelBar(); },
  usePressure: () => state.prefs.pressure,
  fitTolerance: () => state.prefs.fitTolerance || 5,
  penFound: () => {
    state.prefs.penSeen = true; savePrefs();
    updateToolButtons();
    if (!state.prefs.penLinked) toast(`The Pencil has its own tool: ${TOOL_NAMES[editor.tools.pen]}. Tap a tool with the Pencil to change it.`, 6000);
  },
  zoomChanged: (z) => {
    $("zoom-label").textContent = editor.fitMode ? "Fit" : `${Math.round(z * 100)}%`;
    placeSelBar();
  },
});

function defaultFamily() {
  const used = (state.deck.fonts || []).map((f) => f.family);
  return used[0] || state.faces[0]?.family || "sans-serif";
}

// --- saving ---------------------------------------------------------------------------
function markDirty(id, text) {
  const rec = state.slides.get(id);
  if (!rec) return;
  rec.text = text;
  rec.dirty = true;
  setStatus("Unsaved", "dirty");
  if (id === state.current) updateHistoryButtons();
  // After a failed save, the retry timer (backing off) is already set.
  if (!rec.saveError) {
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => save(id).catch(() => {}), 700);
  }
  scheduleThumb(id);
}

// While saving fails (offline), retries back off and the status says so;
// one toast when it starts failing, one when it works again.
const RETRY_FIRST = 3000, RETRY_MAX = 60000;
let saveTrouble = false;

async function save(id, { keepalive = false } = {}) {
  const rec = state.slides.get(id);
  if (!rec) return;
  if (rec.conflict) throw rec.saveError || new Error("This slide has a save conflict");
  if (rec.savePromise) return rec.savePromise;
  if (!rec.dirty) return;
  clearTimeout(rec.timer);
  rec.saving = true;
  rec.savePromise = (async () => {
    while (rec.dirty && !rec.conflict) {
      const text = rec.text;
      setStatus("Saving…", "busy");
      try {
        rec.version = await api.putSlide(id, text, rec.version, { keepalive });
        rec.saveError = null;
        rec.retryDelay = 0;
        if (rec.text === text) rec.dirty = false;
        if (saveTrouble && ![...state.slides.values()].some((r) => r.saveError && !r.conflict)) {
          saveTrouble = false;
          toast("Saving works again.");
        }
      } catch (e) {
        rec.saveError = e;
        if (e.status === 409) {
          rec.conflict = true;
          setStatus("Conflict", "error");
          toast("This slide was changed elsewhere. Open the deck menu → History and recovery, then Keep both versions to preserve your edits.", 10000);
        } else {
          rec.retryDelay = rec.retryDelay ? Math.min(rec.retryDelay * 2, RETRY_MAX) : RETRY_FIRST;
          setStatus("Not saved · retrying", "error");
          if (!saveTrouble) {
            saveTrouble = true;
            toast(`Saving failed: ${e.message}. Your edits are kept here and saving is retried.`, 8000);
          }
          clearTimeout(rec.timer);
          rec.timer = setTimeout(() => save(id).catch(() => {}), rec.retryDelay);
        }
        throw e;
      }
    }
  })().finally(() => {
    rec.saving = false;
    rec.savePromise = null;
    refreshStatus();
  });
  return rec.savePromise;
}

function refreshStatus() {
  const recs = [...state.slides.values()];
  if (recs.some((r) => r.conflict)) setStatus("Conflict", "error");
  else if (recs.some((r) => r.saving)) setStatus("Saving…", "busy");
  else if (recs.some((r) => r.saveError)) setStatus("Not saved · retrying", "error");
  else if (recs.some((r) => r.dirty)) setStatus("Unsaved", "dirty");
  else if (editor.pathDraft) setStatus("Drawing path…", "busy");
  else setStatus("Saved · working copy", "ok");
}

/** Save everything without ending what is being done: an open text box
 *  stays open and a path being drawn stays a draft. */
async function saveAll({ keepalive = false } = {}) {
  editor.syncTextEdit();
  const savingNotes = notes?.flush();
  savingNotes?.catch(() => {});  // its failure is thrown below, after the slides
  while (true) {
    const pending = [...state.slides.entries()].filter(([, r]) => r.dirty || r.savePromise);
    if (!pending.length) break;
    await Promise.all(pending.map(([id]) => save(id, { keepalive })));
  }
  await savingNotes;
}

/** Finish the current interaction and save everything: before leaving,
 *  presenting or exporting. */
async function flush() {
  mediaTools?.finish?.();
  editor.finishPath();
  await saveAll();
}

window.addEventListener("beforeunload", (e) => {
  if (editor.pathDraft?.nodes.length || [...state.slides.values()].some((r) => r.dirty || r.saving)) { e.preventDefault(); e.returnValue = ""; }
});
// Switching apps on the iPad hides the page and may end it: save, but keep
// the text box and the path draft for when the user comes back.
document.addEventListener("visibilitychange", () => { if (document.hidden) saveAll({ keepalive: true }).catch(() => {}); });
window.addEventListener("pagehide", () => { saveAll({ keepalive: true }).catch(() => {}); });
window.addEventListener("online", () => {
  for (const [id, rec] of state.slides) {
    if (rec.saveError && !rec.conflict) { clearTimeout(rec.timer); save(id).catch(() => {}); }
  }
});

/** Leave the editor once everything is saved (iPad Safari does not fire
 *  beforeunload). If saving fails, a second tap leaves anyway. */
let leaveAnyway = false;
async function leave(url = "/") {
  try {
    await flush();
  } catch (e) {
    if (!leaveAnyway) {
      leaveAnyway = true;
      setTimeout(() => { leaveAnyway = false; }, 8000);
      toast(`Not everything is saved (${e.message}). Tap again to leave anyway.`, 8000);
      return;
    }
  }
  location.href = url;
}

// Deck writes go one at a time, each built from the deck and version the
// previous one left, so the app's own overlapping writes never conflict.
let deckQueue = Promise.resolve();
function deckWrite(fn) {
  const run = deckQueue.then(fn);
  deckQueue = run.catch(() => {});
  return run;
}

/** Save the deck: change is the new deck, or a function from the current
 *  deck to the new one (or to null for nothing to save). */
function putDeck(change) {
  return deckWrite(async () => {
    const deck = typeof change === "function" ? change(state.deck) : change;
    if (!deck) return;
    try {
      const res = await api.putDeck(deck, state.version);
      state.deck = deck;
      state.version = res.version;
    } catch (e) {
      toast(e.status === 409 ? "The deck was changed somewhere else; reload the page." : `Could not save deck changes: ${e.message}`, 8000);
      e.reported = true;
      throw e;
    }
  });
}

async function ensureFamily(family) {
  if (!family || (state.deck.fonts || []).some((f) => f.family === family)) return;
  if (!state.faces.some((f) => f.family === family)) return;
  try {
    await notes?.flush();
    await deckWrite(async () => {
      if ((state.deck.fonts || []).some((f) => f.family === family)) return;
      const res = await api.useFamily(family);
      state.deck = res.deck;
      state.version = res.version;
    });
  } catch (e) { toast(`Could not add ${family} to the deck: ${e.message}`); }
}

// --- slides -----------------------------------------------------------------------------
async function slideRecord(id) {
  let rec = state.slides.get(id);
  if (!rec) {
    rec = { loading: api.slide(id), undo: [], redo: [] };
    state.slides.set(id, rec);
  }
  if (rec.loading) {
    const loading = rec.loading;
    let loaded;
    try {
      loaded = await loading;
    } catch (e) {
      // Forget the failed fetch, so the next attempt fetches again.
      if (state.slides.get(id) === rec) state.slides.delete(id);
      throw e;
    }
    if (rec.loading === loading) {
      rec.loading = null;
      rec.text = loaded.text;
      rec.version = loaded.version;
    }
  }
  return rec;
}

let navigationSequence = 0;

function settleCurrentSlide() {
  // A run of arrow-key nudges becomes its undo step before anything else.
  editor.endNudge?.();
  mediaTools?.finish?.();
  editor.endTextEdit(true);
  editor.finishPath();
  editor.cancelGesture();
  editor.pointers.clear();
  editor.touchStart = null;
}

/** Show a slide. If it cannot be fetched or is not valid SVG, the current
 *  slide stays open (so no edit can be saved under the wrong slide) and a
 *  toast says why. Returns whether the slide is now open. */
async function openSlide(id) {
  // Counted first on purpose: tapping the open slide while another one is
  // still loading means "stay here" and cancels that navigation.
  const sequence = ++navigationSequence;
  if (state.current === id) return true;
  if (state.current && state.current !== id) settleCurrentSlide();
  const number = state.deck.slides.findIndex((s) => s.id === id) + 1;
  const fail = (message) => {
    toast(`Could not open slide ${number}: ${message}`, 10000);
    if (!state.current) {
      // No slide is open (the old one was deleted or replaced): what still
      // shows on the stage belongs to no slide and must not be edited.
      editor.select([]);
      $("stage").dataset.unavailable = "true";
    }
    return false;
  };
  let rec;
  try {
    rec = await slideRecord(id);
  } catch (e) {
    return sequence === navigationSequence ? fail(e.message) : false;
  }
  if (sequence !== navigationSequence) return false;
  if (state.current && state.current !== id) settleCurrentSlide();
  try {
    // load() throws before it replaces the slide on the stage.
    editor.load(rec.text);
  } catch (e) {
    return fail(`${e.message}. It was left unchanged; History and recovery can restore an earlier version.`);
  }
  delete $("stage").dataset.unavailable;
  state.current = id;
  try {
    upgradeImageAdjustments(editor);
  } catch (e) {
    toast(e.message, 8000);
  }
  history.replaceState(null, "", `#${index() + 1}`);
  paintSlidePos();
  for (const li of $("thumbs").children) li.classList.toggle("current", li.dataset.id === id);
  $("thumbs").querySelector(".current")?.scrollIntoView({ block: "nearest" });
  renderPanel();
  notes?.render();
  updateHistoryButtons();
  return true;
}
const openSlideSafely = guard(openSlide, "Could not open the slide");
/** The next (1) or previous (-1) slide. */
function stepSlide(delta) {
  const s = state.deck.slides[index() + delta];
  if (s) openSlideSafely(s.id);
}

const index = () => state.deck.slides.findIndex((s) => s.id === state.current);
const newId = () => "s" + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");

async function addSlide(text, notes = "") {
  await flush();
  const id = newId();
  const version = await api.putSlide(id, text, null);
  state.slides.set(id, { text, version, undo: [], redo: [] });
  const after = state.current;
  await putDeck((deck) => {
    const slides = [...deck.slides];
    slides.splice(slides.findIndex((s) => s.id === after) + 1, 0, { id, ...(notes ? {notes} : {}) });
    return { ...deck, slides };
  });
  renderStrip();
  await openSlide(id);
}

function blankSlide() {
  const [w, h] = state.deck.size || [1920, 1080];
  return `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xml:space="preserve">
<defs/>
<rect id="background" data-label="background" data-locked="true" width="${w}" height="${h}" fill="#ffffff"/>
</svg>
`;
}

async function moveSlide(delta) {
  await notes?.flush();
  const id = state.current;
  await putDeck((deck) => {
    const i = deck.slides.findIndex((s) => s.id === id), j = i + delta;
    if (i < 0 || j < 0 || j >= deck.slides.length) return null;
    const slides = [...deck.slides];
    [slides[i], slides[j]] = [slides[j], slides[i]];
    return { ...deck, slides };
  });
  renderStrip();
  $("thumbs").querySelector(".current")?.scrollIntoView({ block: "nearest" });
  history.replaceState(null, "", `#${index() + 1}`);
  paintSlidePos();
  renderPanel();
}

async function deleteSlide() {
  if (state.deck.slides.length < 2) { toast("A deck needs at least one slide."); return; }
  if (!confirm(`Delete slide ${index() + 1}? (It is kept in the deck's trash folder.)`)) return;
  await flush();
  const id = state.current, i = index();
  await putDeck((deck) => ({ ...deck, slides: deck.slides.filter((s) => s.id !== id) }));
  state.slides.delete(id);
  state.current = null;
  renderStrip();
  const slides = state.deck.slides;
  await openSlide(slides[Math.min(i, slides.length - 1)].id);
}

// --- slide strip with live thumbnails ------------------------------------------------------
const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) renderThumbSafely(e.target.dataset.id);
}, { root: $("thumbs"), rootMargin: "300px" });

function paintSlidePos() {
  $("slide-pos").textContent = state.current ? `Slide ${index() + 1} of ${state.deck.slides.length}` : "";
}

function renderStrip() {
  paintSlidePos();
  thumbObserver.disconnect();
  const ol = $("thumbs");
  ol.replaceChildren();
  state.deck.slides.forEach((s, i) => {
    const li = document.createElement("li");
    li.dataset.id = s.id;
    li.className = s.id === state.current ? "current" : "";
    li.innerHTML = `<span class="num">${i + 1}</span><div class="thumb"></div>`;
    li.addEventListener("click", () => openSlideSafely(s.id));
    ol.appendChild(li);
    thumbObserver.observe(li);
  });
}

const thumbTimers = new Map();
function scheduleThumb(id) {
  clearTimeout(thumbTimers.get(id));
  thumbTimers.set(id, setTimeout(() => renderThumbSafely(id, true), 600));
}
const renderThumbSafely = guard(renderThumb, "Could not draw a slide thumbnail");

async function renderThumb(id, force = false) {
  const li = $("thumbs").querySelector(`li[data-id="${CSS.escape(id)}"]`);
  if (!li || (li.dataset.rendered && !force)) return;
  li.dataset.rendered = "1";
  let rec;
  try { rec = await slideRecord(id); } catch (e) { delete li.dataset.rendered; throw e; }
  const doc = new DOMParser().parseFromString(rec.text, "image/svg+xml");
  if (doc.querySelector("parsererror")) return;
  for (const el of doc.querySelectorAll("[href]")) el.setAttribute("href", hrefIn(el.getAttribute("href")));
  const svg = document.importNode(doc.documentElement, true);
  prefixIds(svg, `t-${id}-`);
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  li.querySelector(".thumb").replaceChildren(svg);
}

// --- tool rail -------------------------------------------------------------------------------
function icon(path, cls = "icon") {
  return `<svg viewBox="0 0 24 24" class="${cls}"><path d="${path}"/></svg>`;
}

const TOOL = Object.fromEntries(TOOLS.map(([id, title, path]) =>
  [id, { title, path, name: title.split(" (")[0], key: /\((\w)\)$/.exec(title)?.[1] || "" }]));
// Families share one rail slot and open a flyout; the slot shows the member used last.
const FAMILIES = {
  shapes: { name: "Shapes", tools: ["rect", "ellipse", "circle", "polygon", "line", "arrow", "layout"] },
  paths: { name: "Path", tools: ["bezier", "nodes"] },
};
const RAIL = ["select", "pan", "pen", "erase", null, "shapes", "paths", null, "text", "media"];
const familyOf = (tool) => Object.keys(FAMILIES).find((f) => FAMILIES[f].tools.includes(tool));
const lastInFamily = { shapes: "rect", paths: "bezier" };

let toolPointer = null;
let flyout = null;

/** Which input a tool button was tapped with: the Pencil's tap gives it the tool. */
function takeSlot(fallback = "touch") {
  const kind = toolPointer;
  toolPointer = null;
  if (!kind) return fallback;
  if (kind === "pen" && !editor.penSeen) { editor.penSeen = true; editor.hooks.penFound(); }
  return kind === "pen" ? "pen" : "touch";
}

function buildRail() {
  const rail = $("tools");
  for (const id of RAIL) {
    if (!id) { rail.append(el("div", { class: "rail-sep", role: "presentation" })); continue; }
    const b = el("button", { type: "button", class: "tool" });
    if (FAMILIES[id]) {
      Object.assign(b.dataset, { family: id, more: "" });
      b.title = FAMILIES[id].name;
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-expanded", "false");
    } else if (id === "select") {
      Object.assign(b.dataset, { tool: id, more: "" });
      b.title = "Select (V); tap again for Select several";
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-expanded", "false");
    } else if (id === "media") {
      b.id = "media-tool";
      b.title = "Insert image or movie";
      b.innerHTML = icon("M3 3h18v18H3zM21 15l-5-5L5 21M9 8.5h.01");
      b.append(el("span", {}, "Media"));
    } else {
      b.dataset.tool = id;
      b.title = TOOL[id].title + (id === "pan" ? "; Drag to pan · Tap to select · Double-tap to add" : "");
      b.innerHTML = icon(TOOL[id].path);
      b.append(el("span", {}, TOOL[id].name));
    }
    b.addEventListener("pointerdown", (e) => { toolPointer = e.pointerType; });
    b.addEventListener("click", () => {
      const slot = takeSlot();
      if (id === "media") { showMediaPaste(); return; }
      if (FAMILIES[id]) { toggleFlyout(id, b, slot); return; }
      if (id === "select" && editor.tools[slot] === "select") { toggleSelectFlyout(b, slot); return; }
      closeFlyout();
      setTool(id, { slot });
    });
    rail.append(b);
  }
  setTool("select");
}

function closeFlyout() {
  if (!flyout) return;
  flyout.remove();
  flyout = null;
  for (const b of document.querySelectorAll("#tools [aria-haspopup]")) b.setAttribute("aria-expanded", "false");
}

const SELECT_MODES = [
  ["select", "Select", TOOLS[0][2], "V", false],
  ["multi", "Select several", "M3 3h8v8H3zM13 13h8v8h-8zM15 5h4v4h-4zM5 15h4v4H5z", "", true],
];

/** Select's flyout: one object at a time, or taps that add to the selection. */
function toggleSelectFlyout(anchor, slot) {
  const same = flyout?.dataset.family === "select";
  closeFlyout();
  if (same) return;
  flyout = el("div", { class: "flyout", id: "tool-flyout", role: "menu", "aria-label": "Select", "data-family": "select", "data-slot": slot },
    el("div", { class: "flyout-title", role: "presentation" }, "Select"));
  for (const [id, name, path, key, additive] of SELECT_MODES) {
    const b = el("button", { type: "button", role: "menuitemradio", id, "aria-pressed": String(!!editor.additive === additive) });
    b.innerHTML = icon(path);
    b.append(el("span", { class: "name" }, name));
    if (key) b.append(el("kbd", {}, key));
    b.addEventListener("click", () => { closeFlyout(); setAdditive(additive); });
    flyout.append(b);
  }
  flyout.append(el("div", { class: "flyout-hint", role: "presentation" }, "Several: taps add to or remove from the selection."));
  document.body.append(flyout);
  const r = anchor.getBoundingClientRect();
  flyout.style.left = `${r.right + 2}px`;
  flyout.style.top = `${Math.max(8, Math.min(r.top, innerHeight - flyout.offsetHeight - 8))}px`;
  anchor.setAttribute("aria-expanded", "true");
}

function toggleFlyout(family, anchor, slot) {
  const same = flyout?.dataset.family === family && flyout.dataset.slot === slot;
  closeFlyout();
  if (same) return;
  const fam = FAMILIES[family];
  flyout = el("div", { class: "flyout", id: "tool-flyout", role: "menu", "aria-label": fam.name, "data-family": family, "data-slot": slot },
    el("div", { class: "flyout-title", role: "presentation" }, fam.name + (slot === "pen" ? " · for Pencil" : "")));
  for (const t of fam.tools) {
    const b = el("button", { type: "button", role: "menuitemradio", "data-tool": t, title: TOOL[t].title });
    b.innerHTML = icon(TOOL[t].path);
    b.append(el("span", { class: "name" }, TOOL[t].name), el("kbd", {}, TOOL[t].key));
    b.addEventListener("pointerdown", (e) => { toolPointer = e.pointerType; });
    b.addEventListener("click", () => {
      const s = takeSlot(slot);
      closeFlyout();
      setTool(t, { slot: s });
    });
    flyout.append(b);
  }
  flyout.append(el("div", { class: "flyout-hint", role: "presentation" }, "Tap with the Pencil to give it this tool."));
  document.body.append(flyout);
  const r = anchor.getBoundingClientRect();
  flyout.style.left = `${r.right + 2}px`;
  flyout.style.top = `${Math.max(8, Math.min(r.top, innerHeight - flyout.offsetHeight - 8))}px`;
  anchor.setAttribute("aria-expanded", "true");
  updateToolButtons();
}

// The view controls sit in the top bar: zoom, grid, snap, guides.
function buildViewBar() {
  editor.smartSnap = state.prefs.smartSnap !== false;
  const toggle = (id, label, path, title, onclick, attrs = {}) => {
    const b = el("button", { type: "button", class: "btn", id, title, "aria-pressed": "false", onclick, ...attrs });
    b.innerHTML = icon(path);
    b.append(el("span", { class: "label" }, label));
    return b;
  };
  $("view-toggles").append(
    toggle("grid", "Grid", "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18", "Show or hide the grid",
      () => setGrid({ show: !state.prefs.grid.show })),
    toggle("snap", "Snap", "M6 15l-4-4 7-7a7.8 7.8 0 0 1 11 11l-7 7-4-4 6.4-6.4a2.1 2.1 0 0 0-3-3z", "Snap objects to the grid",
      () => setGrid({ snap: !state.prefs.grid.snap })),
    toggle("smart-guides", "Guides", "M12 2v20M2 12h20", "Snap moved objects to edges, centres and equal gaps; hold Alt to bypass",
      () => setGuides(!editor.smartSnap)),
    toggle("axis-lock", "Axis", "M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4", "Move objects straight across or straight up and down only (same as holding Shift)",
      () => { editor.axisLock = !editor.axisLock; paintViewBar(); }));
  paintViewBar();
}

function paintViewBar() {
  $("grid").setAttribute("aria-pressed", String(!!state.prefs.grid.show));
  $("snap").setAttribute("aria-pressed", String(!!state.prefs.grid.snap));
  $("smart-guides").setAttribute("aria-pressed", String(!!editor.smartSnap));
  $("axis-lock").setAttribute("aria-pressed", String(!!editor.axisLock));
  // Select shows which mode it is in.
  const select = document.querySelector('#tools [data-tool="select"]');
  if (select) {
    const [, name, path] = SELECT_MODES[editor.additive ? 1 : 0];
    select.innerHTML = icon(path);
    select.append(el("span", {}, editor.additive ? "Several" : name));
  }
}

/** Pressed: the finger's tool. Pencil badge: the Pencil's own tool. */
function updateToolButtons() {
  const own = editor.penSeen && !state.prefs.penLinked;
  for (const b of document.querySelectorAll("#tools [data-family]")) {
    const fam = FAMILIES[b.dataset.family];
    const touch = fam.tools.includes(editor.tools.touch), pen = own && fam.tools.includes(editor.tools.pen);
    if (touch) lastInFamily[b.dataset.family] = editor.tools.touch;
    const shown = touch ? editor.tools.touch : pen ? editor.tools.pen : lastInFamily[b.dataset.family];
    b.innerHTML = icon(TOOL[shown].path);
    b.append(el("span", {}, fam.name));
    b.setAttribute("aria-label", `${fam.name}: ${TOOL[shown].name}`);
    b.setAttribute("aria-pressed", String(touch));
    b.dataset.pen = String(pen);
  }
  for (const b of document.querySelectorAll("#tools [data-tool], #tool-flyout [data-tool]")) {
    b.setAttribute("aria-pressed", String(b.dataset.tool === editor.tools.touch));
    b.dataset.pen = String(own && b.dataset.tool === editor.tools.pen);
  }
  $("stage").dataset.tool = editor.tool;
  paintInkBar();
}

/** The ink palette floats at the bottom while the finger or the Pencil draws. */
const INKS = [["Black", "#000000"], ["Red", "#d62728"], ["Blue", "#1f77b4"], ["Grey", "#7c7c7c"], ["White", "#ffffff"]];
const WEIGHTS = [["Fine", 5, 2], ["Medium", 10, 4], ["Bold", 18, 7]];
function paintInkBar() {
  const bar = $("ink-bar");
  const drawing = editor.tools.touch === "pen" || (editor.penSeen && !state.prefs.penLinked && editor.tools.pen === "pen");
  bar.hidden = !drawing;
  if (!drawing) return;
  const stroke = (state.prefs.stroke || "").toLowerCase(), width = +state.prefs.strokeWidth;
  const parts = INKS.map(([name, hex]) => {
    const b = el("button", { type: "button", title: `${name} ink`, "aria-label": `${name} ink`, "aria-pressed": String(stroke === hex),
      class: stroke === hex ? "on" : "", onclick: () => { state.prefs.stroke = hex; savePrefs(); paintInkBar(); renderPanel(); } });
    b.append(el("span", { class: "chip", style: `background:${hex}` }));
    return b;
  });
  parts.push(el("span", { class: "vrule" }));
  for (const [name, w, px] of WEIGHTS) {
    const b = el("button", { type: "button", title: `${name} line`, "aria-label": `${name} line`, "aria-pressed": String(width === w),
      class: width === w ? "on" : "", onclick: () => { state.prefs.strokeWidth = w; savePrefs(); paintInkBar(); renderPanel(); } });
    b.append(el("span", { class: "weight", style: `height:${px}px` }));
    parts.push(b);
  }
  if (editor.penSeen) {
    const note = el("span", { class: "pencil-note" });
    note.innerHTML = icon("M4 20l1-5L16 4l4 4L9 19z", "icon small");
    note.append(state.prefs.penLinked ? "Pencil: as finger" : `Pencil: ${TOOL_NAMES[editor.tools.pen] || editor.tools.pen}`);
    parts.push(el("span", { class: "vrule" }), note);
  }
  bar.replaceChildren(...parts);
}

function setAdditive(on) {
  if (on) setTool("select");
  editor.additive = on;
  paintViewBar();
  if (on) toast("Tap objects to select them, then choose Group or More.", 5000);
}

function setGuides(on) {
  editor.smartSnap = on;
  state.prefs.smartSnap = on;
  savePrefs();
  paintViewBar();
  if (!editor.selection.length) renderPanel();
}

function setGrid(change) {
  Object.assign(state.prefs.grid, change);
  savePrefs();
  Object.assign(editor.grid, state.prefs.grid);
  paintViewBar();
  editor.drawOverlay();
  if (!editor.selection.length) renderPanel();
}

/** Give a tool to the finger ("touch": also the mouse) or the Pencil. By
 *  default the input used last; linked, both change together. */
function setTool(name, { keepEdit = false, slot = editor.input } = {}) {
  mediaTools?.finish?.();
  if (editor.pathDraft) editor.finishPath();
  closeContextMenu();
  closeFlyout();
  editor.cancelGesture();
  editor.pointers.clear();
  editor.touchStart = null;
  if (editor.textEdit && !keepEdit) editor.endTextEdit(true);
  const previous = editor.tools.pen;
  if (state.prefs.penLinked) { editor.tools.touch = name; editor.tools.pen = name; }
  else editor.tools[slot] = name;
  if (editor.tools.pen !== previous && !state.prefs.penLinked) {
    state.penPrevious = previous;
    state.prefs.penTool = editor.tools.pen;
    savePrefs();
  }
  if (slot === "pen" && !state.prefs.penLinked && editor.penSeen) editor.setInput("pen");
  if (["polygon", "bezier"].includes(name)) showInspector("design");
  updateToolButtons();
  editor.drawOverlay();
  renderPanel();
  updateSelBar();
}

function setPenLinked(on) {
  state.prefs.penLinked = on;
  if (on) editor.tools.pen = editor.tools.touch;
  else editor.tools.pen = state.prefs.penTool || "pen";
  savePrefs();
  updateToolButtons();
  editor.drawOverlay();
  renderPanel();
  renderSettings();
}

// --- other input devices --------------------------------------------------------------------
const held = new Map();  // penhold action -> tool to go back to
function runAction(action, phase) {
  if (phase !== "up" && document.querySelector("dialog[open]")) return;
  const [kind, tool] = action.split(":");
  if (kind === "penhold") {
    if (phase === "down" && !held.has(action)) {
      held.set(action, editor.tools.pen);
      setTool(tool, { slot: "pen", keepEdit: true });
    } else if (phase === "up" && held.has(action)) {
      setTool(held.get(action), { slot: "pen", keepEdit: true });
      held.delete(action);
    }
    return;
  }
  if (phase !== "down") return;
  if (kind === "pen" || kind === "touch") {
    setTool(tool, { slot: kind === "pen" ? "pen" : "touch" });
    toast(actionLabel(action), 1200);
    return;
  }
  switch (action) {
    case "pen-swap":
      if (state.penPrevious) { setTool(state.penPrevious, { slot: "pen" }); toast(actionLabel(`pen:${editor.tools.pen}`), 1200); }
      break;
    case "undo": undo(); break;
    case "redo": redo(); break;
    case "delete": if (!(editor.usesTool("nodes") && editor.deleteSelectedNode())) editor.deleteSelection(); break;
    case "fit": editor.fit(); break;
    case "rotate-left": editor.rotateBy(-90); break;
    case "rotate-right": editor.rotateBy(90); break;
    case "flip-x": editor.flip("x"); break;
    case "flip-y": editor.flip("y"); break;
    case "next-slide": stepSlide(1); break;
    case "prev-slide": stepSlide(-1); break;
  }
}

const controller = new Controller({
  run: runAction,
  bindings: state.prefs.bindings,
  save: savePrefs,
  onChange: () => {
    updateToolButtons();
    renderSettings();
  },
});
window.addEventListener("gamepadconnected", () => {
  toast("Controller connected: its buttons switch tools. See Pencil and controller in the deck menu.", 5000);
});

function updateActions() {
  if (editor.tools) updateToolButtons();
  updateSelBar();
}

// --- the contextual bar over the selection ------------------------------------------------------
const ALIGN = [
  ["left", "Align left edges", "M4 2v20M8 6h12v4H8zM8 14h8v4H8z"],
  ["centre", "Align centres", "M12 2v20M6 6h12v4H6zM8 14h8v4H8z"],
  ["right", "Align right edges", "M20 2v20M4 6h12v4H4zM8 14h8v4H8z"],
  ["top", "Align top edges", "M2 4h20M6 8h4v12H6zM14 8h4v8h-4z"],
  ["middle", "Align middles", "M2 12h20M6 6h4v12H6zM14 8h4v8h-4z"],
  ["bottom", "Align bottom edges", "M2 20h20M6 4h4v12H6zM14 8h4v8h-4z"],
];
let alignOpen = false;
// What several objects line up with; the canvas outlines it in purple.
let alignRef = "selection";
const ALIGN_REFS = [
  ["selection", "Each other", "Line up within the box around the selected objects"],
  ["first", "First picked", "Line up with the object you selected first; it stays where it is"],
  ["slide", "Slide", "Line up with the slide"],
];

/** A bar button. With an icon and no text, the title is its name. */
function barButton(label, title, fn, { on, id, path, chip, cls, disabled } = {}) {
  const b = el("button", { type: "button", class: "btn" + (cls ? ` ${cls}` : ""), title, id, disabled,
    "aria-label": label ? null : title, "aria-pressed": on === undefined ? null : String(!!on) });
  if (path) b.innerHTML = icon(path, "icon small");
  if (chip) b.append(el("span", { class: "swatch-chip", style: `background:${chip}` }));
  if (label) b.append(label);
  b.addEventListener("click", fn);
  return b;
}
const barSep = () => el("span", { class: "vrule", role: "separator" });
const paint = (c) => (!c || c === "none" ? "transparent" : c);

function selectionKind(sel) {
  if (sel.length > 1) return `${sel.length} objects`;
  const first = sel[0];
  if (first.hasAttribute("data-video")) return "Movie";
  if (isLayout(first)) return "Layout box";
  if (first.getAttribute("data-ink") === "pressure") return "Ink stroke";
  if (["line", "path", "polyline"].includes(first.localName) && editor.hasArrow(first, "end")) return "Arrow";
  return { text: "Text", rect: "Rectangle", ellipse: "Ellipse", circle: "Circle", line: "Line", path: "Path", polygon: "Polygon",
    polyline: "Line", image: "Image", g: "Group", use: "Clone" }[first.localName] || first.localName;
}

// What Split makes of a layout box; kept between boxes.
const layoutGrid = { rows: 2, cols: 2, gap: 40 };

function selBarItems() {
  const sel = editor.selection;
  if (editor.textEdit) {
    const base = editor.textEdit.base;
    return ["Editing text", [
      barButton("B", "Bold (Ctrl+B)", () => editor.formatText("bold"), { cls: "b" }),
      barButton("I", "Italic (Ctrl+I)", () => editor.formatText("italic"), { cls: "i" }),
      barButton("U", "Underline (Ctrl+U)", () => editor.formatText("underline"), { cls: "u" }),
      barButton("x₂", "Subscript", () => editor.formatText("subscript")),
      barButton("x²", "Superscript", () => editor.formatText("superscript")),
      barSep(),
      barButton("", "Colour of the selected words", () => showInspector("design"), { chip: paint(base.fill) }),
      barSep(),
      barButton("Done", "Finish editing (Ctrl+Enter)", () => editor.endTextEdit(true), { on: true }),
    ]];
  }
  if (!sel.length) return null;
  const first = sel[0];
  const alignBtn = barButton("Align", "Align", () => { alignOpen = !alignOpen; closeContextMenu(); updateSelBar(); },
    { on: alignOpen, path: ALIGN[0][2] });
  const more = barButton("", "More actions", () => {
    if (contextMenu) { closeContextMenu(); return; }
    const r = more.getBoundingClientRect();
    if (alignOpen) { alignOpen = false; updateSelBar(); }
    showContextMenu(r.left, r.bottom + 4);
  }, { id: "object-actions", path: "M5 12h.01M12 12h.01M19 12h.01", cls: "dots" });
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", String(!!contextMenu));
  const fit = editor.canFitToLayout()
    ? [barButton("Fit to box", "Fill the layout box around it, keeping its proportions, and centre it there (text is only centred)",
      () => editor.fitToLayout(), { id: "fit-layout" }), barSep()] : [];
  const tail = [barSep(), ...fit, alignBtn, more];

  // Point editing takes over the bar while a shape shows its points.
  const model = editor.usesTool("nodes") && sel.length === 1 && editor.nodeModel(first);
  if (model && !editor.pathDraft) {
    const chosen = editor.selectedNode();
    const isPath = model.kind === "path";
    const closed = model.subs[chosen ? chosen.sub : 0].closed;
    const type = chosen?.node.type;
    const done = barButton("Done", "Stop editing points", () => setTool("select"), { on: true });
    return ["Points", [
      ...(chosen && isPath ? [
        barButton("Corner", "Handles move independently", () => editor.setNodeType("c"), { on: type === "c" }),
        barButton("Smooth", "Handles stay in line", () => editor.setNodeType("s"), { on: type === "s" }),
        barButton("Symmetric", "Handles stay in line and equally long", () => editor.setNodeType("z"), { on: type === "z" }),
        barSep()] : []),
      ...(chosen ? [
        barButton("Add point", "Add a point halfway to the next one", () => editor.insertNodeAfterSelected()),
        barButton("Delete point", "Delete the chosen point (Delete)", () => editor.deleteSelectedNode()),
        barSep()] : [el("span", { class: "note" }, "Tap a point to choose it")]),
      ...(chosen && isPath ? [
        barButton("Straight", "Make the segment after this point a straight line", () => editor.setSegment("line")),
        barButton("Curved", "Give the segment after this point curve handles", () => editor.setSegment("curve")),
        barSep()] : []),
      barButton("Subdivide", "Add a point in the middle of every segment, keeping the shape", () => editor.splitCurve()),
      isPath && model.subs.length === 1 && !closed
        ? barButton("Continue path", "Continue drawing from the end of this path", () => { setTool("bezier"); editor.extendCurve(); }) : null,
      barButton(closed ? "Open path" : "Close path", closed ? "Open the outline at the chosen point" : "Join the ends", () => editor.toggleClosed()),
      barSep(), done,
    ].filter(Boolean)];
  }

  const kind = selectionKind(sel);
  if (sel.length > 1) {
    return [kind, [barButton("Group", "Group (Ctrl+G)", () => { setTool("select"); editor.group(); }, { id: "group-selection" }), ...tail]];
  }
  if (isLayout(first)) {
    // Rows, columns and gap are in a row of their own (drawSelBar), so the bar stays narrow.
    const { rows, cols } = layoutGrid;
    return [kind, [
      barButton(`Split ${rows} × ${cols}`, "Replace this box by a grid of equal boxes that fills it",
        () => editor.splitLayout(layoutGrid.rows, layoutGrid.cols, layoutGrid.gap), { id: "split-layout", on: true, disabled: rows * cols < 2 }),
      ...tail]];
  }
  const cs = getComputedStyle(lookOf(first));
  if (first.localName === "text") {
    const glyphs = firstGlyphElement(first);
    const tcs = getComputedStyle(glyphs);
    const size = Math.round((parseFloat(tcs.fontSize) || 16) * editor.textScale(first));
    const setSize = (v) => {
      v = Math.max(1, v);
      editor.change(() => editor.applyStyle(first, "font-size", `${+(v / editor.textScale(first)).toFixed(4)}px`));
      state.prefs.size = v; savePrefs();
    };
    const weight = parseInt(tcs.fontWeight, 10) || 400;
    const underlined = editor.lookAt(glyphs, first).decoration.includes("underline");
    return [kind, [
      barButton("Edit", "Edit the text (double-tap)", () => editor.editText(first, false), { id: "edit-text" }),
      barSep(),
      barButton(tcs.fontFamily.split(",")[0].replace(/['"]/g, "").trim(), "Font", () => showInspector("design")),
      barSep(),
      barButton("−", "Smaller text", () => setSize(size - 2)),
      el("span", { class: "note size", title: "Size in slide pixels" }, String(size)),
      barButton("+", "Larger text", () => setSize(size + 2)),
      barSep(),
      barButton("B", "Bold", () => editor.setStyle("font-weight", weight >= 600 ? "400" : "700", [first]), { on: weight >= 600, cls: "b" }),
      barButton("I", "Italic", () => editor.setStyle("font-style", tcs.fontStyle === "italic" ? "normal" : "italic", [first]),
        { on: tcs.fontStyle === "italic", cls: "i" }),
      barButton("U", "Underline", () => editor.setStyle("text-decoration-line", underlined ? "none" : "underline", [first]),
        { on: underlined, cls: "u" }),
      barSep(),
      barButton("", "Text colour", () => showInspector("design"), { chip: paint(cs.fill) }),
      ...tail]];
  }
  if (first.localName === "image") {
    const movie = first.hasAttribute("data-video");
    const flag = (attr) => (first.getAttribute(attr) ?? "true") !== "false";
    return [kind, [
      barButton("Crop", movie ? "Crop movie" : "Crop image", () => mediaTools?.open(), { id: "crop-selection",
        path: "M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2" }),
      barButton("Replace…", movie ? "Replace the movie with another file" : "Replace the image with another file",
        () => chooseReplacement(first), { id: "replace-media" }),
      ...(movie ? [barButton("Trim", "Trim movie", () => openMovieTrim(editor, first)), barSep(),
        barButton("Autoplay", "Play automatically", () => editor.setAttr("data-autoplay", flag("data-autoplay") ? "false" : "true"),
          { on: flag("data-autoplay") }),
        barButton("Loop", "Loop the movie", () => editor.setAttr("data-loop", flag("data-loop") ? "false" : "true"), { on: flag("data-loop") }),
        barButton(`Sync ${first.getAttribute("data-sync") || "none"}`, "Sync group: set it in the inspector", () => showInspector("design"))] : []),
      ...tail]];
  }
  if (first.localName === "g" || first.localName === "a") {
    return [kind, [
      barButton("Edit inside", "Work inside the group (double-tap)", () => { setTool("select"); editor.enterGroup(first); }),
      barButton("Ungroup", "Ungroup (Ctrl+Shift+G)", () => { setTool("select"); editor.ungroup(); }),
      ...tail]];
  }
  const ink = first.getAttribute("data-ink") === "pressure";
  const lineLike = ["line", "path", "polyline"].includes(first.localName) && !ink;
  return [kind, [
    ink ? barButton("Colour", "Ink colour", () => showInspector("design"), { chip: paint(cs.fill) })
      : lineLike ? null : barButton("Fill", "Fill colour", () => showInspector("design"), { chip: paint(cs.fill) }),
    ink ? null : barButton("Stroke", "Line colour", () => showInspector("design"), { chip: paint(cs.stroke) }),
    editor.editableNodes(first) ? barButton("Edit points", "Edit anchors and control handles (N)", () => setTool("nodes"),
      { path: TOOL.nodes.path }) : null,
    ...tail].filter(Boolean)];
}

// Like renderPanel, a nested call (from a released button) asks for one more pass.
let selBarDrawing = false, selBarAgain = false;
function updateSelBar() {
  if (selBarDrawing) { selBarAgain = true; return; }
  selBarDrawing = true;
  try {
    releaseFocus($("sel-bar"));
    for (let pass = 0; pass < 3; pass++) {
      selBarAgain = false;
      drawSelBar();
      if (!selBarAgain) break;
    }
  } finally {
    selBarDrawing = false;
  }
}

/** Draw the bar above the selection (below it near the top), right-aligned
 *  for objects on the right half, so it never covers what it edits. */
function drawSelBar() {
  const bar = $("sel-bar");
  const items = editor.svg ? selBarItems() : null;
  if (!items) {
    bar.hidden = true; alignOpen = false;
    if (editor.alignRef) { editor.alignRef = null; editor.drawOverlay(); }
    return;
  }
  const [kind, buttons] = items;
  $("sel-row").replaceChildren(el("span", { class: "sel-kind" }, kind), ...buttons);
  const alignRow = $("align-row");
  const sel = editor.selection;
  alignRow.hidden = !(alignOpen && sel.length && !editor.textEdit);
  // The canvas outlines what Align lines up with for as long as the row is open.
  const ref = alignRow.hidden ? null : sel.length === 1 ? "slide" : alignRef;
  if (editor.alignRef !== ref) { editor.alignRef = ref; editor.drawOverlay(); }
  if (!alignRow.hidden) {
    const refButton = ([id, label, title]) => barButton(label, title, () => { alignRef = id; updateSelBar(); }, { on: ref === id });
    alignRow.replaceChildren(
      ...ALIGN.map(([how, title, path]) => barButton("", title, () => { editor.align(how, ref); editor.drawOverlay(); }, { path })),
      ...(sel.length > 2 ? [barSep(),
        barButton("Across", "Space evenly left to right", () => editor.distribute("x")),
        barButton("Down", "Space evenly top to bottom", () => editor.distribute("y"))] : []),
      barSep(),
      el("span", { class: "note" }, sel.length > 1 ? "with" : "with the slide"),
      ...(sel.length > 1 ? ALIGN_REFS.map(refButton) : []));
  }
  const layoutRow = $("layout-row");
  layoutRow.hidden = !(alignRow.hidden && sel.length === 1 && isLayout(sel[0]) && !editor.textEdit);
  if (!layoutRow.hidden) {
    const stepper = (key, label, title, step, min) => [
      el("span", { class: "note" }, label),
      barButton("−", `Fewer: ${title}`, () => { layoutGrid[key] = Math.max(min, layoutGrid[key] - step); updateSelBar(); }),
      el("span", { class: "note size", id: `layout-${key}`, title }, String(layoutGrid[key])),
      barButton("+", `More: ${title}`, () => { layoutGrid[key] += step; updateSelBar(); })];
    layoutRow.replaceChildren(
      ...stepper("rows", "Rows", "rows", 1, 1), barSep(),
      ...stepper("cols", "Cols", "columns", 1, 1), barSep(),
      ...stepper("gap", "Gap", "space between the boxes, in slide pixels", 10, 0));
  }
  bar.hidden = false;
  placeSelBar();
}

function placeSelBar() {
  const bar = $("sel-bar");
  if (bar.hidden) return;
  const host = $("stage-wrap").getBoundingClientRect();
  let box = null;
  if (editor.textEdit?.box?.isConnected) box = editor.textEdit.box.getBoundingClientRect();
  else if (editor.selection.length) {
    let b = editor.selectionBox();
    // Points and curve handles reach outside the outline's box: keep clear of them too.
    if (b && editor.showingNodes()) {
      const el = editor.selection[0], model = editor.nodeModel(el);
      if (model) {
        const pts = editor.nodeTargets(el, model).targets.map((t) => t.p);
        const x0 = Math.min(b.x, ...pts.map((q) => q.x)), y0 = Math.min(b.y, ...pts.map((q) => q.y));
        const x1 = Math.max(b.x + b.width, ...pts.map((q) => q.x)), y1 = Math.max(b.y + b.height, ...pts.map((q) => q.y));
        b = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      }
    }
    const page = editor.page.getBoundingClientRect();
    if (b) box = { left: page.left + b.x * editor.zoom, top: page.top + b.y * editor.zoom,
      right: page.left + (b.x + b.width) * editor.zoom, bottom: page.top + (b.y + b.height) * editor.zoom };
  }
  if (!box) { bar.style.left = "12px"; bar.style.right = ""; bar.style.top = "64px"; return; }
  const h = bar.offsetHeight, w = bar.offsetWidth, margin = 12;
  // Above the box, clear of the rotate handle (40 px up); below, clear of the edge handles.
  const above = editor.tool === "select" && !editor.textEdit && !editor.showingNodes() ? 60 : 20;
  let top = box.top - host.top - h - above;
  if (top < 60) top = Math.min(box.bottom - host.top + 20, host.height - h - margin);
  const right = (box.left + box.right) / 2 - host.left > host.width / 2;
  bar.classList.toggle("right", right);
  let left = right ? box.right - host.left - w : box.left - host.left;
  left = Math.max(margin, Math.min(left, host.width - w - margin));
  bar.style.left = `${left}px`;
  bar.style.top = `${Math.max(60, top)}px`;
}

// The stage never takes focus (its pointerdown is prevented). A field or
// button outside it gives focus up here, so a typed value is applied before
// the gesture, and Enter or Delete afterwards act on the canvas.
$("stage").addEventListener("pointerdown", () => {
  const active = document.activeElement;
  if (active && active !== document.body && !$("stage").contains(active)) active.blur();
}, true);

// Hide the bar while a finger or the Pencil is moving something.
$("stage").addEventListener("pointerdown", () => document.body.classList.add("gesturing"));
for (const type of ["pointerup", "pointercancel"]) {
  window.addEventListener(type, () => {
    if (!document.body.classList.contains("gesturing")) return;
    document.body.classList.remove("gesturing");
    requestAnimationFrame(updateSelBar);
  });
}

// The same commands are available to mouse, touch and keyboard users.
let contextMenu = null;
let menuFocus = null;
function closeContextMenu(restoreFocus = false) {
  if (!contextMenu) return;
  contextMenu.remove();
  contextMenu = null;
  $("object-actions")?.setAttribute("aria-expanded", "false");
  if (restoreFocus && menuFocus?.isConnected) menuFocus.focus({ preventScroll: true });
}

function showContextMenu(x, y) {
  closeContextMenu();
  closeFlyout();
  menuFocus = document.activeElement;
  const selection = editor.selection;
  const count = selection.length;
  const menu = el("div", { class: "context-menu", id: "context-menu", role: "menu", "aria-label": "Object actions" });
  contextMenu = menu;
  menu.append(el("div", { class: "menu-title", role: "presentation" }, count ? `${count} object${count === 1 ? "" : "s"} selected` : "Slide actions"));
  const action = (label, fn, { enabled = true, key = "", danger = false } = {}) => {
    menu.append(el("button", { type: "button", role: "menuitem", disabled: !enabled, class: danger ? "danger" : null,
      onclick: () => { closeContextMenu(); fn(); } }, label, key ? el("span", { class: "key", "aria-hidden": "true" }, key) : null));
  };
  const sep = () => menu.append(el("div", { class: "menu-sep", role: "separator" }));
  if (count) {
    action("Copy", () => copySelection(false), { key: "⌘C" });
    action("Cut", () => copySelection(true), { key: "⌘X" });
  }
  action("Paste", () => pasteSystemClipboard(x, y), { key: "⌘V" });
  if (clipboardData()) action("Paste copied objects", pasteClipboard);
  if (count) action("Duplicate", () => editor.duplicate(), { key: "⌘D" });
  if (count === 1 && selection[0].localName === "image") {
    const target = selection[0];
    action(target.hasAttribute("data-video") ? "Replace movie…" : "Replace image…", () => chooseReplacement(target));
  }
  if (count) {
    sep();
    action("Rotate 90° left", () => editor.rotateBy(-90));
    action("Rotate 90° right", () => editor.rotateBy(90));
    action("Flip horizontal", () => editor.flip("x"));
    action("Flip vertical", () => editor.flip("y"));
  }
  sep();
  action("Group", () => { setTool("select"); editor.group(); }, { enabled: count > 1, key: "⌘G" });
  if (selection.some((item) => item.localName === "g")) action("Ungroup", () => { setTool("select"); editor.ungroup(); }, { key: "⇧⌘G" });
  if (count === 1 && selection[0].localName === "g") action("Edit group", () => { setTool("select"); editor.enterGroup(selection[0]); });
  if (editor.context !== editor.svg) action("Leave group", () => editor.exitGroup());
  action(editor.additive ? "Finish selecting several" : "Select several", () => setAdditive(!editor.additive));
  action("Select all", () => { setTool("select"); editor.selectAll(); }, { key: "⌘A" });
  if (count) {
    sep();
    action("Bring to front", () => editor.order("front"));
    action("Bring forward", () => editor.order("forward"));
    action("Send backward", () => editor.order("backward"));
    action("Send to back", () => editor.order("back"));
    sep();
    action("Lock", () => editor.lock());
    action("Delete", () => editor.deleteSelection(), { key: "⌫", danger: true });
  }
  if (count < 2) menu.append(el("p", { class: "menu-hint", role: "presentation" }, "To group: choose Select several, tap each object, then Group."));
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeContextMenu(true); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const buttons = [...menu.querySelectorAll("button:not(:disabled)")];
      const current = buttons.indexOf(document.activeElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 :
        (current + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (e.key === "Tab") closeContextMenu();
    e.stopPropagation();
  });
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;
  $("object-actions")?.setAttribute("aria-expanded", "true");
  menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
}

// --- menus: slide actions, the document menu ------------------------------------------------------
function toggleMenu(menu, button, open = menu.hidden) {
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) menu.querySelector("button")?.focus({ preventScroll: true });
}
function closeMenus() {
  toggleMenu($("slide-menu"), $("slide-menu-btn"), false);
  toggleMenu($("doc-menu"), $("doc-menu-btn"), false);
}

function buildDocMenu() {
  const menu = $("doc-menu");
  const item = (id, path, name, sub, fn) => {
    const b = el("button", { type: "button", role: "menuitem", id, onclick: () => { closeMenus(); fn(); } });
    b.innerHTML = icon(path);
    b.append(el("span", { class: "item-text" }, el("span", {}, name), sub ? el("span", { class: "item-sub" }, sub) : null));
    return b;
  };
  // Downloads are links (long-press or right-click can save them), opened
  // with fetch so a server without PDF support says so in a toast.
  const download = (id, name, sub, href, notes) => {
    const a = el("a", { role: "menuitem", id, href, download: "", onclick: (e) => {
      if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      closeMenus();
      guard(() => downloadPdf(href, notes), "Could not download the PDF")();
    } });
    a.innerHTML = icon("M6 2h9l5 5v15H6zM14 2v6h6M9 13h6M9 17h6");
    a.append(el("span", { class: "item-text" }, el("span", {}, name), el("span", { class: "item-sub" }, sub)));
    return a;
  };
  const sep = () => el("div", { class: "menu-sep", role: "separator" });
  const pencil = state.prefs.penLinked ? "Pencil acts as a finger" : `Pencil: ${TOOL_NAMES[editor.tools.pen] || editor.tools.pen}`;
  menu.replaceChildren(
    item("commit-deck", "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M2 12h6M16 12h6", "Commit snapshot…", "An immutable copy of the whole deck", () => commits?.open()),
    item(null, "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2", "History and recovery", "Slide revisions, deleted slides", () => recovery?.open()),
    sep(),
    item("export", "M12 3v12M7 10l5 5 5-5M5 21h14", "Export offline copy", "A .zip that plays without network", guard(exportDeck, "Could not export")),
    download("download-pdf", "Download PDF", "One page per slide", `/api/decks/${DECK}/pdf`, false),
    download("download-handout", "Download handout (with notes)", "Each slide with its speaker notes", `/api/decks/${DECK}/pdf?notes=1`, true),
    item(null, "M3 4h18v12H3zM8 20h8M12 16v4", "Speaker view", "Notes, next slide, timer", guard(() => present(true), "Could not open speaker view")),
    sep(),
    item("deck-settings", "M4 6h16M4 12h16M4 18h16", "Deck settings…", `Title, size, background, fonts · ${state.deck.size?.join(" × ") || "1920 × 1080"}`, () => openSettings("deck")),
    item("pen-status", "M4 20l1-5L16 4l4 4L9 19z", "Pencil and controller",
      pencil + (controller.pads.length ? " · controller connected" : ""), () => openSettings("pencil")),
    sep(),
    item(null, "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z", "All decks", "", () => leave("/")));
}

document.addEventListener("pointerdown", (e) => {
  if (contextMenu && !contextMenu.contains(e.target) && !e.target.closest("#object-actions")) closeContextMenu();
  if (flyout && !flyout.contains(e.target) && !e.target.closest("#tools [aria-haspopup]")) closeFlyout();
  if (!e.target.closest("#doc-menu, #doc-menu-btn, #slide-menu, #slide-menu-btn")) closeMenus();
}, true);
window.addEventListener("resize", () => { closeContextMenu(); closeFlyout(); placeSelBar(); });

// --- inspector tabs and settings dialogs --------------------------------------------------------
let inspectorTab = "design";
function showInspector(tab = inspectorTab) {
  document.body.classList.remove("no-panel");
  $("toggle-panel").setAttribute("aria-pressed", "true");
  inspectorTab = tab;
  for (const b of document.querySelectorAll("#inspector-tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const body of document.querySelectorAll("#inspector [data-tab-body]")) body.hidden = !body.dataset.tabBody.split(" ").includes(tab);
  if (tab === "objects" || tab === "builds") objectPanels?.open(tab);
  else if (tab === "notes") notes?.open(false);
  else renderPanel();
}

let settingsKind = null;
function openSettings(kind) {
  settingsKind = kind;
  renderSettings();
  const dialog = $("settings-dialog");
  if (!dialog.open) dialog.showModal();
}
function renderSettings() {
  const dialog = $("settings-dialog");
  if (!settingsKind || !state.deck) return;
  $("settings-title").textContent = settingsKind === "pencil" ? "Pencil and controller" : "Deck settings";
  releaseFocus(dialog);
  $("settings-body").replaceChildren(...(settingsKind === "pencil" ? [pencilSection()] : [
    ...deckSections(),
    section("Fonts", el("p", { class: "hint" }, `${families().length} families in the library.`),
      buttonRow([["Upload font…", "Add an .otf or .ttf file to the font library", () => $("font-file").click()]])),
  ]));
}

const SLIDE_SIZES = [[1920, 1080, "16:9"], [3840, 2160, "16:9, 4K"], [1920, 1200, "16:10"], [1024, 768, "4:3"]];

/** Deck settings: title, background colour and slide size. */
function deckSections() {
  const deck = state.deck;
  const [w0, h0] = deck.size || [1920, 1080];
  const title = el("input", { type: "text", id: "deck-title-field", value: deck.title || DECK, "aria-label": "Deck title", spellcheck: "true" });
  title.addEventListener("change", guard(async () => {
    const value = title.value.trim();
    if (!value) { title.value = state.deck.title || DECK; return; }
    if (value === state.deck.title) return;
    await notes?.flush();
    await putDeck((d) => ({ ...d, title: value }));
    showDeckTitle();
    toast("Title saved.", 1500);
  }, "Could not save the title"));
  const preset = SLIDE_SIZES.findIndex(([w, h]) => w === w0 && h === h0);
  const size = el("select", { id: "deck-size", "aria-label": "Slide size" },
    SLIDE_SIZES.map(([w, h, ratio], i) => el("option", { value: String(i), selected: i === preset }, `${w} × ${h} (${ratio})`)),
    el("option", { value: "custom", selected: preset < 0 }, "Custom…"));
  const width = el("input", { type: "number", id: "deck-width", min: 16, max: 20000, step: 1, value: w0, inputmode: "numeric", "aria-label": "Slide width" });
  const height = el("input", { type: "number", id: "deck-height", min: 16, max: 20000, step: 1, value: h0, inputmode: "numeric", "aria-label": "Slide height" });
  const custom = row("Pixels", el("span", { class: "num" }, width, "×", height));
  custom.hidden = preset >= 0;
  size.addEventListener("change", () => {
    custom.hidden = size.value !== "custom";
    if (size.value !== "custom") [width.value, height.value] = SLIDE_SIZES[+size.value];
  });
  const apply = el("button", { type: "button", class: "btn small", id: "deck-size-apply", onclick: guard(async () => {
    const [w, h] = size.value === "custom" ? [Math.round(+width.value), Math.round(+height.value)] : SLIDE_SIZES[+size.value];
    if (!(w >= 16 && h >= 16 && w <= 20000 && h <= 20000)) { toast("Choose a width and height between 16 and 20000 pixels."); return; }
    await resizeSlides(w, h);
  }, "Could not change the slide size") }, "Apply size");
  return [
    section("Deck",
      row("Title", title),
      row("Background", colorControl(deck.background || "#000000", guard(async (c) => {
        await notes?.flush();
        await putDeck((d) => ({ ...d, background: c }));
        renderSettings();
      }, "Could not save the background"), false)),
      el("p", { class: "hint" }, "The background is the colour behind the slides, saved with the deck.")),
    section("Slide size",
      el("p", { class: "hint" }, `${deck.slides.length} slide${deck.slides.length === 1 ? "" : "s"}, ${w0} × ${h0} pixels.`),
      row("Size", size), custom,
      el("div", { class: "buttons" }, apply),
      el("p", { class: "hint" }, "Changing the size changes every slide; what is on them keeps its place and size. Each slide can undo it.")),
  ];
}

function showDeckTitle() {
  $("deck-title").textContent = state.deck.title || DECK;
  document.title = `${state.deck.title || DECK} · svgdeck`;
}

/** A slide's SVG with another slide size: the root's width, height and
 *  viewBox change, and so does a background rect that filled the old
 *  slide. Everything else keeps its coordinates. */
function resizedSlide(text, w, h) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (doc.querySelector("parsererror") || svg.localName !== "svg") throw new Error("a slide is not valid SVG");
  const vb = (svg.getAttribute("viewBox") || `0 0 ${svg.getAttribute("width") || 1920} ${svg.getAttribute("height") || 1080}`).trim().split(/[\s,]+/).map(Number);
  const [x0, y0, ow, oh] = vb;
  if (ow === w && oh === h && svg.getAttribute("width") === String(w) && svg.getAttribute("height") === String(h)) return text;
  svg.setAttribute("viewBox", `${x0} ${y0} ${w} ${h}`);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  const back = [...svg.children].find((c) => c.localName === "rect" && (c.id === "background" || c.getAttribute("data-label") === "background"));
  const at = (name, value) => Math.abs((parseFloat(back.getAttribute(name)) || 0) - value) < 0.5;
  if (back && !back.hasAttribute("transform") && at("x", x0) && at("y", y0) && at("width", ow) && at("height", oh)) {
    back.setAttribute("width", String(w));
    back.setAttribute("height", String(h));
  }
  return '<?xml version="1.0" encoding="utf-8"?>\n' + new XMLSerializer().serializeToString(svg) + "\n";
}

/** Give every slide a new size, each as one undo step of its own, after a
 *  confirmation; then the deck's size. */
async function resizeSlides(w, h) {
  const n = state.deck.slides.length;
  const [w0, h0] = state.deck.size || [1920, 1080];
  if (w === w0 && h === h0) { toast(`The slides are already ${w} × ${h} pixels.`); return; }
  if (!confirm(`Change the size of all ${n} slide${n === 1 ? "" : "s"} from ${w0} × ${h0} to ${w} × ${h} pixels? ` +
    "What is on them keeps its place and size.")) return;
  // An open text box or crop ends first, so its edit is part of what is resized.
  settleCurrentSlide();
  await flush();
  const ids = state.deck.slides.map((s) => s.id);
  const recs = await Promise.all(ids.map((id) => slideRecord(id)));
  if (recs.some((rec) => rec.conflict)) throw new Error("a slide has a save conflict; resolve it under History and recovery first");
  const changed = recs.map((rec) => resizedSlide(rec.text, w, h));  // all or nothing: a bad slide stops here
  ids.forEach((id, i) => {
    const rec = recs[i];
    if (changed[i] === rec.text) return;
    rec.undo.push(rec.text);
    if (rec.undo.length > 150) rec.undo.shift();
    rec.redo = [];
    markDirty(id, changed[i]);
  });
  const current = state.slides.get(state.current);
  if (current) editor.load(current.text);
  await putDeck((deck) => ({ ...deck, size: [w, h] }));
  for (const li of $("thumbs").children) delete li.dataset.rendered;
  renderSettings();
  buildDocMenu();
  updateHistoryButtons();
  toast(`The slides are now ${w} × ${h} pixels.`);
}

/** Fetch a PDF and save it; a server that cannot make PDFs says why. */
async function downloadPdf(url, withNotes) {
  try { await flush(); } catch (error) { toast(`Not downloaded: the deck is not saved (${error.message}).`, 8000); return; }
  toast(withNotes ? "Preparing the handout…" : "Preparing the PDF…", 120000);
  const r = await fetch(url);
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).detail; } catch (e) { /* not JSON */ }
    if (detail && typeof detail !== "string") detail = JSON.stringify(detail);
    toast(r.status === 501 ? (detail || "This server cannot make PDFs.") : `Could not make the PDF: ${detail || `${r.status} ${r.statusText}`}`, 10000);
    return;
  }
  const blob = await r.blob();
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(r.headers.get("Content-Disposition") || "");
  const name = named ? decodeURIComponent(named[1]) : `${DECK}${withNotes ? "-handout" : ""}.pdf`;
  const href = URL.createObjectURL(blob);
  const a = el("a", { href, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60000);
  toast(`Downloaded ${name}`);
}

async function exportDeck() {
  try { await flush(); } catch (error) { toast(`Not exported: the deck is not saved (${error.message}).`, 8000); return; }
  toast("Preparing the export…");
  location.href = `/api/decks/${DECK}/export.zip`;
}

async function uploadMedia(files, target = state.current, center = editor.visibleCenter()) {
  for (const file of files) {
    const video = file.type.startsWith("video/");
    toast(video ? `Uploading ${file.name} (movies are converted for playback, this can take a while)…` : `Uploading ${file.name}…`, 60000);
    try {
      const info = await api.upload(`/api/decks/${DECK}/media?filename=${encodeURIComponent(file.name)}`, file);
      // Let an in-progress pointer gesture end naturally, keeping the upload
      // out of that gesture's undo transaction.
      while (state.current === target && editor.gesture) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const rec = state.slides.get(target);
      if (!rec || !state.deck.slides.some((s) => s.id === target)) {
        toast(`Uploaded ${file.name}, but its slide was deleted before it could be inserted.`, 8000);
        continue;
      }
      if (state.current === target) {
        settleCurrentSlide();
        editor.insertMedia(info, center);
      } else {
        const before = rec.text;
        const after = editor.insertMediaInText(before, info, center);
        rec.undo.push(before);
        if (rec.undo.length > 150) rec.undo.shift();
        rec.redo = [];
        markDirty(target, after);
      }
      toast(`Inserted ${file.name}`);
    } catch (e) {
      toast(`Could not insert ${file.name}: ${e.message}`, 8000);
    }
  }
}

// Replace media: another file in the same place, keeping the box, crop,
// adjustments, build step and transform (the media tools do the swap).
let replacing = null;  // {el, slide} the file picker was opened for
function chooseReplacement(target) {
  if (!target?.isConnected || target.localName !== "image") return;
  replacing = { el: target, slide: state.current };
  $("replace-file").click();
}

async function replaceMedia(file, { el: target, slide }) {
  const movie = target.hasAttribute("data-video");
  const what = movie ? "movie" : "image";
  toast(file.type.startsWith("video/") ? `Uploading ${file.name} (movies are converted for playback, this can take a while)…`
    : `Uploading ${file.name}…`, 60000);
  try {
    const info = await api.upload(`/api/decks/${DECK}/media?filename=${encodeURIComponent(file.name)}`, file);
    while (state.current === slide && editor.gesture) await new Promise((resolve) => requestAnimationFrame(resolve));
    if (state.current !== slide || !target.isConnected || !editor.svg?.contains(target)) {
      toast(`Uploaded ${file.name}, but the ${what} is no longer on the open slide.`, 8000);
      return;
    }
    if (typeof editor.mediaTools?.replace !== "function") throw new Error("replacing media is not available in this version");
    settleCurrentSlide();
    await editor.mediaTools.replace(target, info);
    toast(`Replaced the ${what} with ${file.name}`);
  } catch (e) {
    toast(`Could not replace the ${what} with ${file.name}: ${e.message}`, 8000);
  }
}

// --- properties panel ------------------------------------------------------------------------
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

function heading(title, sub) {
  return el("div", { class: "heading" }, el("strong", {}, title), sub ? el("small", {}, sub) : null);
}

function section(title, ...content) {
  return el("section", {}, el("h3", {}, title), ...content);
}

function row(label, ...controls) {
  return el("div", { class: "row" }, el("label", {}, label), el("div", { class: "controls" }, ...controls));
}

function colorControl(value, onPick, allowNone) {
  return createColorControl(value, onPick, {
    allowNone, palette:PALETTE, recent:state.prefs.recent, sampleArea: () => editor.svg,
    onRecent(c) {
      state.prefs.recent = [c, ...state.prefs.recent.filter(r => r !== c)].slice(0, 6);
      savePrefs();
    },
  });
}

function numberControl(value, { min = 0, max = 1000, step = 1, suffix = "" } = {}, onSet) {
  const input = el("input", { type: "number", value: +(+value).toFixed(2), min, max, step, inputmode: "decimal" });
  const shown = panelSelection;
  input.addEventListener("change", () => {
    // A value typed for objects that are no longer selected is not applied to others.
    const sel = editor.selection;
    if (shown.length !== sel.length || shown.some((o, i) => o !== sel[i])) return;
    if (input.value !== "") onSet(+input.value);
  });
  return el("span", { class: "num" }, input, suffix);
}

function buttonRow(buttons) {
  return el("div", { class: "buttons" }, buttons.map(([label, title, fn, on]) =>
    el("button", { class: "btn small" + (on ? " on" : ""), title, onclick: fn }, label)));
}

function iconButton(title, d, fn) {
  const b = el("button", { type: "button", class: "btn small", title, "aria-label": title, onclick: fn });
  b.innerHTML = icon(d);
  return b;
}

function families() {
  return [...new Set(state.faces.map((f) => f.family))].sort();
}

/** Blur the focused element if it is inside one of hosts. A field that is
 *  removed while focused fires its change event in the middle of the
 *  removal; blurring first lets that change (an edit, a commit, a nested
 *  re-render) happen while nothing is being replaced. */
function releaseFocus(...hosts) {
  const active = document.activeElement;
  if (active && active !== document.body && hosts.some((h) => h?.contains(active))) active.blur();
}

// renderPanel can be reached again while it runs (a released field commits,
// the commit re-selects): the nested call only asks for one more pass.
let panelRendering = false, panelAgain = false;
function renderPanel() {
  if (!state.deck) return;
  if (panelRendering) { panelAgain = true; return; }
  panelRendering = true;
  // A position field typed into with Enter stays focused when the panel is
  // redrawn for the same selection, so several values can be typed in a row.
  const active = document.activeElement;
  const keep = active?.id?.startsWith("pos-") && $("panel").contains(active) ? active.id : null;
  const before = [...panelSelection];
  try {
    releaseFocus($("panel"), $("objects-mount"), document.querySelector("dialog.media-tools"));
    for (let pass = 0; pass < 3; pass++) {
      panelAgain = false;
      drawPanel();
      if (!panelAgain) break;
    }
  } finally {
    panelRendering = false;
  }
  const sel = editor.selection;
  if (keep && before.length === sel.length && before.every((o, i) => o === sel[i])) $(keep)?.focus({ preventScroll: true });
}

let panelSelection = [];  // the selection the panel's fields were drawn for
function drawPanel() {
  objectPanels?.render();
  mediaTools?.render();
  panelSelection = [...editor.selection];
  const panel = $("panel");
  const sel = editor.selection;
  const parts = [];
  if (editor.usesTool("polygon")) parts.push(section("Polygon tool",
    row("Sides", numberControl(editor.polygonSides || 5, {min:3,max:32,step:1}, v => {editor.polygonSides = Math.max(3,Math.min(32,Math.round(v)));})),
    el("p", {class:"hint"}, "Drag to draw a polygon. Use Edit points to move individual vertices.")));
  if (editor.usesTool("bezier") || editor.pathDraft) parts.push(section("Drawing a path",
    el("p", {class:"hint"}, "Tap to add points; drag while placing a point to pull out its curve handles. Enter, double-tap or right-click finishes. Tap the first point to close. Escape cancels; Backspace removes the last point."),
    el("p", {class:"hint"}, "Draw a line freehand (the Pencil always does; a finger or the mouse once the drag curves) and it becomes a few smooth points, with corners where it turns sharply. Start on the end of a path to continue it; end on its start to close it."),
    row("Smoothing", numberControl(state.prefs.fitTolerance || 5, {min:1,max:40,step:1,suffix:"px"}, v => {state.prefs.fitTolerance = Math.max(1,Math.min(40,v)); savePrefs();})),
    el("p", {class:"hint"}, "Higher smoothing gives fewer points and a looser fit. It is measured on screen, so zooming in gives finer detail."),
    editor.pathDraft ? buttonRow([
      ["Finish path", "Finish path (Enter)", () => editor.finishPath()],
      ["Close path", "Connect back to the first point", () => editor.finishPath(true)],
      ["Remove last node", "Remove last point (Backspace)", () => editor.removePathNode()],
      ["Cancel path", "Cancel path (Escape)", () => editor.cancelPath()],
    ]) : null));
  if (editor.usesTool("nodes") && !editor.pathDraft) parts.push(pointsSection(sel));
  if (editor.textEdit) {
    const base = editor.textEdit.base;
    parts.unshift(heading("Editing text", "Bold, italic and Done are in the bar above the text"));
    parts.push(section("Colour",
      colorControl(base.fill, (c) => editor.formatText("foreColor", c), false),
      el("p", { class: "hint" }, "Select words to format them; with nothing selected, the whole text changes. " +
        "Font, size and alignment are set after editing.")));
    panel.replaceChildren(...parts);
    return;
  }
  if (!sel.length) {
    const svg = editor.svg;
    const bg = svg && (svg.querySelector('[data-label="background"]') || svg.querySelector("[data-locked='true']"));
    parts.unshift(heading(`Slide ${index() + 1}`, "Nothing selected"));
    if (bg) parts.push(section("Background", colorControl(getComputedStyle(bg).fill, (c) => editor.setStyle("fill", c, [bg]), false)));
    const grid = state.prefs.grid;
    const check = (on, text, fn) => el("label", { class: "check" },
      el("input", { type: "checkbox", checked: on, onchange: (e) => fn(e.target.checked) }), text);
    parts.push(section("Grid and guides",
      row("Spacing", numberControl(grid.size, { min: 1, max: 960, step: 1, suffix: "px" }, (v) => setGrid({ size: Math.max(1, v) }))),
      buttonRow([10, 20, 40, 60, 120].map((s) => [String(s), `${s} px grid`, () => setGrid({ size: s }), grid.size === s])),
      check(grid.show, "Show grid", (on) => setGrid({ show: on })),
      check(grid.snap, "Snap to grid", (on) => setGrid({ snap: on })),
      check(editor.smartSnap, "Guides to other objects", (on) => setGuides(on))));
    parts.push(section("Slide",
      buttonRow([["Select all", "Select every object (Ctrl+A)", () => editor.selectAll()],
                 ["Unlock all", "Make locked objects selectable again", () => editor.unlockAll()],
                 clipboardData() ? ["Paste", "Paste copied objects (Ctrl+V)", pasteClipboard] : null,
                 ["Duplicate slide", "Add a copy of this slide after it", duplicateSlide]].filter(Boolean))));
    parts.push(section("New shapes",
      row("Fill", colorControl(state.prefs.fill, (c) => { state.prefs.fill = c; savePrefs(); renderPanel(); }, true)),
      row("Line", colorControl(state.prefs.stroke, (c) => { state.prefs.stroke = c; savePrefs(); renderPanel(); paintInkBar(); }, true)),
      row("Width", numberControl(state.prefs.strokeWidth, { min: 0.5, max: 100, step: 0.5 }, (v) => { state.prefs.strokeWidth = v; savePrefs(); paintInkBar(); }))));
    parts.push(section("New text",
      row("Colour", colorControl(state.prefs.textFill, (c) => { state.prefs.textFill = c; savePrefs(); renderPanel(); }, false)),
      row("Size", numberControl(state.prefs.size, { min: 4, max: 400 }, (v) => { state.prefs.size = v; savePrefs(); }))));
    parts.push(el("p", { class: "hint" }, "Double-tap text to edit it, or a group to work inside it. Two fingers pan and zoom."));
    panel.replaceChildren(...parts.filter(Boolean));
    return;
  }

  const first = sel[0];
  if (sel.every(isLayout)) {
    // A layout box has a place and a size, and no look of its own.
    parts.unshift(heading(sel.length > 1 ? `${sel.length} layout boxes` : "Layout box", "Shown only while editing, never in the presentation or the PDF"));
    parts.push(positionSection());
    parts.push(el("p", { class: "hint" }, "Objects snap to a box's edges and centre. Select an object lying in a box and choose Fit to box to fill it."));
    panel.replaceChildren(...parts.filter(Boolean));
    return;
  }
  const cs = getComputedStyle(lookOf(first));
  const kinds = new Set(sel.map((e) => e.localName));
  const isMovie = sel.length === 1 && first.hasAttribute("data-video");
  const inks = sel.every((e) => e.getAttribute("data-ink") === "pressure");
  const texts = sel.filter((e) => e.localName === "text");
  const lines = sel.filter((e) => ["line", "path", "polyline"].includes(e.localName) && !e.hasAttribute("data-ink"));
  const label = isMovie ? "Movie" : sel.length > 1 ? `${sel.length} objects` : ({
    text: "Text", rect: "Rectangle", ellipse: "Ellipse", circle: "Circle", line: "Line", path: "Path",
    image: "Image", g: "Group", use: "Clone" }[first.localName] || first.localName);
  parts.unshift(heading(label, sel.length > 1 ? "Group, align and arrange are in the bar" :
    first.localName === "text" ? "Double-tap to edit" : isMovie ? (first.getAttribute("data-video") || "").split("/").pop() : null));
  parts.push(positionSection());
  if (sel.length === 1 && first.localName === "image") {
    parts.push(section("Crop",
      buttonRow([[isMovie ? "Crop movie" : "Crop image", "Drag the crop handles on the slide", () => mediaTools?.open()],
                 [isMovie ? "Replace movie…" : "Replace image…", "Choose another file; size, crop and adjustments stay", () => chooseReplacement(first)]]),
      el("p", {class:"hint"}, "Drag the edges or corners to crop. Your original media stays intact.")));
  }

  if (sel.every(image => image.localName === "image" && !image.hasAttribute("data-video"))) {
    parts.push(section("Image adjustments",
      ...IMAGE_ADJUSTMENTS.map(spec => {
        const value = adjustmentValue(first, spec);
        const slider = el("input", {type:"range", min:spec.min, max:spec.max, step:1, value,
          "aria-label":spec.label, style:"width:100%;min-width:0"});
        let pending = false;
        const preview = v => {
          if (!Number.isFinite(v)) return;
          setImageAdjustment(editor, spec, v, sel, true);
          pending = true;
        };
        const finish = () => {
          if (!pending) return;
          pending = false;
          editor.commit();
        };
        const numeric = numberControl(value, {min:spec.min, max:spec.max, step:1, suffix:spec.unit},
          v => { preview(v); finish(); });
        const input = numeric.querySelector("input");
        input.setAttribute("aria-label", `${spec.label} value`);
        input.addEventListener("input", () => {
          if (input.value === "" || !input.validity.valid) return;
          slider.value = input.value;
          preview(+input.value);
        });
        slider.addEventListener("input", () => { input.value = slider.value; preview(+slider.value); });
        slider.addEventListener("change", () => { preview(+slider.value); finish(); });
        for (const control of [slider, input]) {
          control.addEventListener("blur", finish);
          control.addEventListener("pointercancel", finish);
        }
        return row(spec.label, slider, numeric);
      }),
      buttonRow([["Reset adjustments", "Restore original image colours", () => resetImageAdjustments(editor, sel)]]),
      el("p", {class:"hint"}, "Saturation 0% makes grayscale. Original images stay intact.")));
  }

  if (inks) {
    // Pressure strokes are filled outlines: their colour is the fill.
    parts.push(section(sel.length > 1 ? `${sel.length} ink strokes` : "Ink stroke",
      row("Colour", colorControl(cs.fill, (c) => { editor.setStyle("fill", c); state.prefs.stroke = c; savePrefs(); }, false)),
      row("Opacity", numberControl(Math.round((Number.isFinite(parseFloat(cs.opacity)) ? parseFloat(cs.opacity) : 1) * 100), { min: 0, max: 100, step: 5, suffix: "%" },
        (v) => editor.setStyle("opacity", String(Math.max(0, Math.min(100, v)) / 100))))));
  } else if (!kinds.has("image") || kinds.size > 1) {
    parts.push(section("Style",
      !texts.length || kinds.size > 1 ? row("Fill", colorControl(cs.fill, (c) => { editor.setStyle("fill", c); if (c !== "none") { state.prefs.fill = c; savePrefs(); } }, true)) : null,
      row(texts.length && kinds.size === 1 ? "Colour" : "Line", texts.length && kinds.size === 1
        ? colorControl(cs.fill, (c) => { editor.setStyle("fill", c); state.prefs.textFill = c; savePrefs(); }, false)
        : colorControl(cs.stroke, (c) => { setStroke(sel, c); if (c !== "none") { state.prefs.stroke = c; savePrefs(); } }, true)),
      !(texts.length && kinds.size === 1) ? row("Width", numberControl(+editor.strokeWidthOf(lookOf(first)).toFixed(2), { min: 0, max: 200, step: 0.5 },
        (v) => { setStrokeWidth(sel, v); state.prefs.strokeWidth = v; savePrefs(); })) : null,
      row("Opacity", numberControl(Math.round((Number.isFinite(parseFloat(cs.opacity)) ? parseFloat(cs.opacity) : 1) * 100), { min: 0, max: 100, step: 5, suffix: "%" },
        (v) => editor.setStyle("opacity", String(Math.max(0, Math.min(100, v)) / 100))))));
  } else {
    parts.push(section("Style", row("Opacity", numberControl(Math.round((Number.isFinite(parseFloat(cs.opacity)) ? parseFloat(cs.opacity) : 1) * 100),
      { min: 0, max: 100, step: 5, suffix: "%" }, (v) => editor.setStyle("opacity", String(Math.max(0, Math.min(100, v)) / 100))))));
  }

  const strokable = sel.filter((e) => STROKABLE.has(e.localName) && e.getAttribute("data-ink") !== "pressure");
  if (strokable.length) parts.push(lineStyleSection(strokable));

  if (texts.length) {
    // Read the style where the text actually is: imported texts keep it on
    // inner spans, and are often scaled, so sizes are shown in slide pixels.
    const glyphs = firstGlyphElement(texts[0]);
    const tcs = getComputedStyle(glyphs);
    const scale = editor.textScale(texts[0]);
    const family = tcs.fontFamily.split(",")[0].replace(/['"]/g, "").trim();
    const fams = families();
    const famSelect = el("select", {}, [...new Set([family, ...fams])].map((f) => el("option", { value: f, selected: f === family }, f)));
    famSelect.addEventListener("change", async () => {
      await ensureFamily(famSelect.value);
      editor.setStyle("font-family", cssFamily(famSelect.value), texts);
      state.prefs.family = famSelect.value; savePrefs();
    });
    const weights = [...new Set(state.faces.filter((f) => f.family === family && f.style === "normal").map((f) => f.weight))].sort((a, b) => a - b);
    const weight = parseInt(tcs.fontWeight, 10) || 400;
    const weightSelect = el("select", {}, [...new Set([weight, ...(weights.length ? weights : [400, 700])])].sort((a, b) => a - b).map((w) =>
      el("option", { value: w, selected: w === weight }, `${w} ${weightName(w)}`)));
    weightSelect.addEventListener("change", () => { editor.setStyle("font-weight", weightSelect.value, texts); state.prefs.weight = +weightSelect.value; savePrefs(); });
    const size = Math.round((parseFloat(tcs.fontSize) || 16) * scale * 10) / 10;
    const anchor = tcs.textAnchor;
    const underlined = editor.lookAt(glyphs, texts[0]).decoration.includes("underline");
    parts.push(section("Font",
      buttonRow([
        ["Bold", "Toggle bold", () => editor.setStyle("font-weight", weight >= 600 ? "400" : "700", texts), weight >= 600],
        ["Italic", "Toggle italic", () => editor.setStyle("font-style", tcs.fontStyle === "italic" ? "normal" : "italic", texts), tcs.fontStyle === "italic"],
        ["Underline", "Toggle underline", () => editor.setStyle("text-decoration-line", underlined ? "none" : "underline", texts), underlined],
      ]),
      row("Font", famSelect), row("Weight", weightSelect),
      row("Size", numberControl(size, { min: 1, max: 1000, step: 1 }, (v) => {
        editor.change(() => { for (const t of texts) editor.applyStyle(t, "font-size", `${+(v / editor.textScale(t)).toFixed(4)}px`); });
        state.prefs.size = v; savePrefs();
      })),
      row("Lines", buttonRow([["Left", "Align lines left", () => editor.setAlign("start", texts), anchor === "start"],
                              ["Centre", "Centre lines", () => editor.setAlign("middle", texts), anchor === "middle"],
                              ["Right", "Align lines right", () => editor.setAlign("end", texts), anchor === "end"]])),
      buttonRow([["Edit text", "Or double-tap the text", () => editor.editText(texts[0], false)]])));
  }

  if (lines.length) {
    parts.push(section("Arrowheads", buttonRow([
      ["Start", "Arrowhead at the start", () => editor.setArrow("start", !editor.hasArrow(lines[0], "start")), editor.hasArrow(lines[0], "start")],
      ["End", "Arrowhead at the end", () => editor.setArrow("end", !editor.hasArrow(lines[0], "end")), editor.hasArrow(lines[0], "end")],
    ])));
  }

  if (isMovie) {
    const check = (attr, text, dflt) => {
      const on = (first.getAttribute(attr) ?? String(dflt)) !== "false";
      return el("label", { class: "check" }, el("input", { type: "checkbox", checked: on,
        onchange: (e) => editor.setAttr(attr, e.target.checked ? "true" : "false") }), text);
    };
    const sync = el("input", { type: "text", value: first.getAttribute("data-sync") || "", placeholder: "none", size: 8 });
    sync.addEventListener("change", () => editor.setAttr("data-sync", sync.value.trim() || null));
    parts.push(section("Playback", el("button", {class:"btn", type:"button", onclick:() => openMovieTrim(editor, first)}, "Trim movie…"), check("data-autoplay", "Play automatically", true), check("data-loop", "Loop", true),
      row("Sync group", sync),
      el("p", { class: "hint" }, "Movies with the same sync group continue across slides without restarting.")));
  }

  if (!editor.lineMode()) {
    const angles = sel.map((e) => Math.round(editor.angleOf(e) * 10) / 10);
    const angle = angles.every((a) => a === angles[0]) ? angles[0] : 0;
    parts.push(section("Rotate and flip",
      row("Angle", numberControl(angle, { min: -360, max: 360, step: 1, suffix: "°" }, (v) => editor.setAngle(((v + 180) % 360 + 360) % 360 - 180))),
      el("div", { class: "buttons" },
        iconButton("Rotate 90° left", "M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5", () => editor.rotateBy(-90)),
        iconButton("Rotate 90° right", "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5", () => editor.rotateBy(90)),
        iconButton("Flip horizontal", "M12 3v3M12 10.5v3M12 18v3M9 6L3 18h6zM15 6l6 12h-6z", () => editor.flip("x")),
        iconButton("Flip vertical", "M3 12h3M10.5 12h3M18 12h3M6 9l12-6v6zM6 15l12 6v-6z", () => editor.flip("y")))));
  }

  const steps = new Set(sel.map((e) => Number.parseInt(e.getAttribute("data-step") || "0", 10) || 0));
  const step = steps.size === 1 ? [...steps][0] : 0;
  const setStep = (n) => editor.setAttr("data-step", n > 0 ? String(n) : null);
  parts.push(section("Build step",
    el("div", { class: "num" },
      el("button", { class: "btn small", title: "Earlier build step", onclick: () => setStep(Math.max(0, step - 1)) }, "−"),
      el("strong", { class: "step-value" }, steps.size === 1 ? (step ? `Step ${step}` : "On entry") : "Mixed"),
      el("button", { class: "btn small", title: "Later build step", onclick: () => setStep(step + 1) }, "+")),
    el("p", { class: "hint" }, "Objects appear on this click while presenting. The Builds tab shows the whole order.")));
  panel.replaceChildren(...parts.filter(Boolean));
}

// --- position and size -------------------------------------------------------------------------
let positionFields = null;  // the X, Y, W, H inputs the panel shows, or null
const oneDecimal = (v) => String(Math.round(v * 10) / 10);

/** X, Y, W and H of the selection's bounds in slide pixels, and a lock that
 *  keeps W and H in proportion when one of them is typed. */
function positionSection() {
  const box = editor.selectionGeometry();
  positionFields = null;
  if (!box) return null;
  const shown = panelSelection;
  const fields = {};
  const field = (key, label, title) => {
    const input = el("input", { type: "number", id: `pos-${key}`, step: "0.1", inputmode: "decimal", "aria-label": title,
      value: oneDecimal({ x: box.x, y: box.y, w: box.width, h: box.height }[key]) });
    input.addEventListener("change", () => {
      const sel = editor.selection;
      if (shown.length !== sel.length || shown.some((o, i) => o !== sel[i])) return;
      const v = parseFloat(input.value), now = editor.selectionGeometry();
      if (!Number.isFinite(v) || !now) { refreshPosition(true); return; }
      const lock = !!state.prefs.lockAspect;
      const change = {};
      if (key === "x") change.x = v;
      else if (key === "y") change.y = v;
      else if (key === "w") {
        change.width = Math.max(v, 0.1);
        if (lock && now.width > 1e-9) change.height = now.height * change.width / now.width;
      } else {
        change.height = Math.max(v, 0.1);
        if (lock && now.height > 1e-9) change.width = now.width * change.height / now.height;
      }
      editor.setSelectionGeometry(change);
      refreshPosition(true);
    });
    fields[key] = input;
    return el("label", { class: "pos-field" }, el("span", {}, label), input);
  };
  const lock = el("button", { type: "button", class: "btn small pos-lock", id: "pos-lock", title: "Keep the proportions when W or H changes",
    "aria-label": "Lock proportions", "aria-pressed": String(!!state.prefs.lockAspect), onclick: () => {
      state.prefs.lockAspect = !state.prefs.lockAspect;
      savePrefs();
      lock.setAttribute("aria-pressed", String(state.prefs.lockAspect));
    } });
  lock.innerHTML = icon("M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z", "icon small");
  const out = section("Position",
    el("div", { class: "pos-grid" }, field("x", "X", "X position"), field("y", "Y", "Y position"),
      field("w", "W", "Width"), field("h", "H", "Height"), lock),
    el("p", { class: "hint" }, "Slide pixels, of the selection's bounds."));
  positionFields = fields;
  return out;
}

/** Show the selection's bounds in the position fields again, in place.
 *  A field being typed into keeps its text unless force is set. */
function refreshPosition(force = false) {
  if (!positionFields || !positionFields.x.isConnected) return;
  const box = editor.selectionGeometry();
  if (!box) return;
  const values = { x: box.x, y: box.y, w: box.width, h: box.height };
  for (const [key, input] of Object.entries(positionFields)) {
    if (force || document.activeElement !== input) input.value = oneDecimal(values[key]);
  }
}

// --- line style ------------------------------------------------------------------------------------
const STROKABLE = new Set(["rect", "ellipse", "circle", "polygon", "polyline", "line", "path"]);
const DASH_KINDS = [["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"], ["custom", "Custom"]];
let dashCustomFor = null;  // the object Custom was chosen for, until something else is selected
const dashNumbers = (v) => (!v || v === "none" ? [] : (v.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number));
const short = (n) => String(+n.toFixed(2));

/** The preset dash patterns, in the object's units for its line width. With
 *  round or square ends the caps grow into the gaps, so those leave room. */
function dashPreset(kind, width, cap) {
  const w = width || 1, butt = cap === "butt";
  if (kind === "dashed") return butt ? `${short(4 * w)} ${short(2 * w)}` : `${short(3 * w)} ${short(3 * w)}`;
  if (kind === "dotted") return butt ? `${short(w)} ${short(w)}` : `0 ${short(2 * w)}`;
  return "none";
}

function dashKind(value, width) {
  const nums = dashNumbers(value);
  if (!nums.length || nums.every((n) => n === 0)) return "solid";
  const same = (pattern) => {
    const p = dashNumbers(pattern);
    return p.length === nums.length && p.every((n, i) => Math.abs(n - nums[i]) < 0.01);
  };
  for (const kind of ["dashed", "dotted"]) {
    if (same(dashPreset(kind, width, "butt")) || same(dashPreset(kind, width, "round"))) return kind;
  }
  return "custom";
}

const DASH_PATTERN = /^\s*(?:\d*\.?\d+(?:px)?)(?:[\s,]+\d*\.?\d+(?:px)?)*\s*$/i;

/** Dash, line ends and corners of shapes, lines and paths; corner radius of rects. */
function lineStyleSection(items) {
  const first = items[0];
  const cs = getComputedStyle(first);
  const width = parseFloat(cs.strokeWidth) || 1;
  const cap = cs.strokeLinecap || "butt", join = cs.strokeLinejoin || "miter";
  if (dashCustomFor && dashCustomFor !== first) dashCustomFor = null;
  let kind = dashKind(cs.strokeDasharray, width);
  if (dashCustomFor === first) kind = "custom";
  const dash = el("select", { id: "stroke-dash", "aria-label": "Dash" },
    DASH_KINDS.map(([id, name]) => el("option", { value: id, selected: id === kind }, name)));
  const custom = el("input", { type: "text", id: "stroke-dash-custom", "aria-label": "Dash pattern", placeholder: "e.g. 12 6 2 6",
    spellcheck: "false", value: kind === "custom" ? dashNumbers(cs.strokeDasharray).map(short).join(" ") : "" });
  const customRow = row("Pattern", custom);
  customRow.hidden = kind !== "custom";
  dash.addEventListener("change", () => {
    if (dash.value === "custom") {
      dashCustomFor = first;
      customRow.hidden = false;
      if (!custom.value) custom.value = dashNumbers(getComputedStyle(first).strokeDasharray).map(short).join(" ") || `${short(2 * width)} ${short(width)}`;
      custom.focus();
      return;
    }
    dashCustomFor = null;
    editor.setStyle("stroke-dasharray", dashPreset(dash.value, width, cap), items);
  });
  custom.addEventListener("change", () => {
    const v = custom.value.trim();
    if (v && v.toLowerCase() !== "none" && !DASH_PATTERN.test(v)) {
      custom.setAttribute("aria-invalid", "true");
      toast("A dash pattern is a list of lengths, like 12 6 or 12 6 2 6.");
      return;
    }
    custom.removeAttribute("aria-invalid");
    const pattern = !v || v.toLowerCase() === "none" ? "none" : dashNumbers(v).map(short).join(" ");
    editor.setStyle("stroke-dasharray", pattern, items);
  });
  const choice = (prop, options, current, apply) => el("div", { class: "buttons", role: "group" }, options.map(([value, label, title]) =>
    el("button", { type: "button", class: "btn small" + (value === current ? " on" : ""), title, "aria-pressed": String(value === current),
      [`data-${prop}`]: value, onclick: () => apply(value) }, label)));
  const setCap = (value) => editor.change(() => {
    editor.setStyle("stroke-linecap", value, items);
    // A preset dash follows the ends, or round dots would vanish with flat ends.
    if (kind === "dashed" || kind === "dotted") editor.setStyle("stroke-dasharray", dashPreset(kind, width, value), items);
  });
  const rects = items.filter((e) => e.localName === "rect");
  let corners = null;
  if (rects.length) {
    const r = editor.radiusOf(rects[0]) * editor.scaleOf(rects[0]);
    corners = numberControl(Math.round(r * 10) / 10, { min: 0, max: 5000, step: 1, suffix: "px" }, (v) => {
      const px = Math.max(0, v);
      editor.change(() => { for (const rect of rects) editor.setRadius(px / editor.scaleOf(rect), [rect]); });
    });
    const input = corners.querySelector("input");
    input.id = "corner-radius";
    input.setAttribute("aria-label", "Corner radius");
  }
  return section("Line style",
    row("Dash", dash), customRow,
    row("Ends", choice("cap", [["butt", "Flat", "Flat line ends"], ["round", "Round", "Round line ends"], ["square", "Square", "Square line ends"]], cap, setCap)),
    row("Joins", choice("join", [["miter", "Mitre", "Pointed corners"], ["round", "Round", "Round corners"], ["bevel", "Bevel", "Bevelled corners"]], join,
      (value) => editor.setStyle("stroke-linejoin", value, items))),
    corners ? row("Corners", corners) : null);
}

/** Point editing: the buttons are in the bar; the inspector explains. */
function pointsSection(sel) {
  const target = sel.length === 1 && editor.nodeModel(sel[0]);
  if (!target) return section("Edit points", el("p", { class: "hint" }, "Select a path, curve or polygon to edit its points."));
  const chosen = editor.selectedNode();
  const total = target.subs.reduce((n, s) => n + s.nodes.length, 0);
  return section("Edit points",
    chosen ? row("Point", el("span", {}, `${chosen.i + 1} of ${target.subs[chosen.sub].nodes.length}` +
      (target.subs.length > 1 ? ` (part ${chosen.sub + 1} of ${target.subs.length})` : ""))) : el("p", { class: "hint" }, `${total} points.`),
    el("p", { class: "hint" }, "Tap a point to choose it, then drag it or its handles. Double-tap the outline to add a point there. " +
      "Point type, adding, deleting and opening are in the bar above the shape."));
}

/** Pencil tool and the bindings of other input devices. */
function pencilSection() {
  const linked = state.prefs.penLinked;
  const toolSelect = el("select", { "aria-label": "Pencil tool", disabled: linked },
    Object.entries(TOOL_NAMES).map(([id, name]) => el("option", { value: id, selected: id === editor.tools.pen }, name)));
  // Not runAction: device actions are ignored while a dialog is open.
  toolSelect.onchange = () => setTool(toolSelect.value, { slot: "pen" });
  const bindings = Object.entries(state.prefs.bindings).filter(([, action]) => action).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  const actionSelect = el("select", { "aria-label": "Action to assign" }, actionGroups().map(([label, ids]) =>
    el("optgroup", { label }, ids.map((id) => el("option", { value: id }, actionLabel(id))))));
  const learn = el("button", { class: "btn small", onclick: () => {
    learn.textContent = "Press a key or controller button… (Esc cancels)";
    learn.classList.add("on");
    controller.learn(actionSelect.value, (input) => {
      if (input) toast(`${inputLabel(input)} → ${actionLabel(actionSelect.value)}`);
      renderSettings();
    });
  } }, "Assign a key or button");
  return section("Pencil and controller",
    el("label", { class: "check" }, el("input", { type: "checkbox", checked: !linked,
      onchange: (e) => setPenLinked(!e.target.checked) }), "The Pencil has its own tool"),
    row("Pencil", toolSelect),
    el("label", { class: "check" }, el("input", { type: "checkbox", checked: state.prefs.pressure,
      onchange: (e) => { state.prefs.pressure = e.target.checked; savePrefs(); } }), "Pressure changes the line width"),
    el("p", { class: "hint" }, "Tap a tool with the Pencil to give it to the Pencil; tap with a finger to give it to your finger and the mouse. " +
      (editor.penSeen ? "" : "(Pencil not used yet in this browser.)")),
    el("p", { class: "hint" }, controller.pads.length ? `Controller: ${controller.pads.join(", ")}` :
      "Controllers and key devices (macro pads, pedals, clickers) can switch tools. Press a controller button to connect it."),
    el("ul", { class: "bindings" }, bindings.map(([input, action]) => el("li", {},
      el("span", { class: "binding-input" }, inputLabel(input)), el("span", {}, actionLabel(action)),
      el("button", { class: "btn small", title: `Remove ${inputLabel(input)}`, "aria-label": `Remove ${inputLabel(input)}`,
        onclick: () => controller.unbind(input) }, "✕")))),
    row("Action", actionSelect),
    learn,
    buttonRow([["Default controller layout", "Restore the default controller buttons", () => {
      for (const k of Object.keys(state.prefs.bindings)) if (k.startsWith("pad:")) delete state.prefs.bindings[k];
      Object.assign(state.prefs.bindings, DEFAULT_BINDINGS);
      savePrefs(); renderSettings();
    }]]));
}

/** The element whose style shows an object's look: a text's first glyph, a
 *  group's first drawn shape. */
function lookOf(obj) {
  if (obj.localName === "text") return firstGlyphElement(obj);
  if (obj.localName === "g" || obj.localName === "a") {
    return obj.querySelector("path, rect, ellipse, circle, line, polyline, polygon, text") || obj;
  }
  return obj;
}

/** Stroke width typed in slide pixels, stored in each object's own units. */
function setStrokeWidth(sel, px) {
  editor.change(() => {
    for (const obj of sel) editor.applyStyle(obj, "stroke-width", String(+(px / editor.scaleOf(obj)).toFixed(4)));
    editor.recolorMarkers(sel);
  });
}

/** A stroke colour should be visible: give objects without a stroke width one. */
function setStroke(sel, color) {
  editor.change(() => {
    for (const obj of sel) {
      editor.applyStyle(obj, "stroke", color);
      if (color !== "none" && editor.strokeWidthOf(obj) === 0) {
        editor.applyStyle(obj, "stroke-width", String(+(state.prefs.strokeWidth / editor.scaleOf(obj)).toFixed(4)));
      }
    }
    editor.recolorMarkers(sel);
  });
}

function weightName(w) {
  return { 100: "Ultra light", 200: "Thin", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold",
           700: "Bold", 800: "Heavy", 900: "Black" }[w] || "";
}

function updateBreadcrumb() {
  $("breadcrumb").hidden = !editor.svg || editor.context === editor.svg;
}

// --- fonts ------------------------------------------------------------------------------------
function installFaces(faces) {
  const css = faces.map((f) => `@font-face { font-family: ${JSON.stringify(f.family)}; src: url(${JSON.stringify(
    "/api/fonts/file/" + f.path.split("/").map(encodeURIComponent).join("/"))}); font-weight: ${f.weight}; font-style: ${f.style}; }`).join("\n");
  let style = $("library-fonts");
  if (!style) { style = el("style", { id: "library-fonts" }); document.head.append(style); }
  style.textContent = css;
}

// --- keyboard ------------------------------------------------------------------------------------
document.addEventListener("keyup", (e) => { controller.keyup(e); });
document.addEventListener("keydown", (e) => {
  // Learning a binding comes first: it happens in the Pencil and controller
  // dialog, and Escape there cancels the learning, not the dialog.
  if (controller.learning) { if (e.key === "Escape") e.preventDefault(); controller.keydown(e); return; }
  const modal = document.querySelector("dialog[open]");
  if (modal && !(modal.classList.contains("media-tools") && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z")) return;
  if (e.target.closest("input, textarea, select, [contenteditable]") || editor.textEdit) return;
  if (!state.current) return;  // no slide open
  if (controller.keydown(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  // Escape closes an open flyout or menu before it acts on the canvas.
  if (k === "escape" && (flyout || contextMenu || !$("doc-menu").hidden || !$("slide-menu").hidden)) {
    e.preventDefault();
    closeFlyout();
    closeContextMenu(true);
    closeMenus();
    return;
  }
  // Arrow keys inside an open menu move between its items, never the selection.
  const inMenu = e.target.closest?.('[role="menu"]');
  if (inMenu && k.startsWith("arrow")) {
    e.preventDefault();
    if (k === "arrowdown" || k === "arrowup") {
      const items = [...inMenu.querySelectorAll("button:not(:disabled), a[href]")];
      const at = items.indexOf(document.activeElement);
      items[(at + (k === "arrowdown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
    return;
  }
  // A focused button or link outside the stage keeps its own keys: Enter
  // and Space activate it rather than editing the selection, Delete does
  // not delete objects. (Tool letters and arrows still apply.)
  const control = e.target.closest?.("button, a[href], summary, [role=button], [role=menuitem], [role=tab]");
  if (control && !$("stage").contains(control) && !mod && ["enter", " ", "delete", "backspace", "escape"].includes(k)) return;
  if (editor.pathDraft && ["enter", "escape", "backspace", "delete"].includes(k)) {
    e.preventDefault();
    if (k === "enter") editor.finishPath(e.shiftKey);
    else if (k === "escape") editor.cancelPath();
    else editor.removePathNode();
    return;
  }
  if (editor.pathDraft && mod && k === "z") { e.preventDefault(); editor.removePathNode(); return; }
  if (mod && k === "z") { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
  if (mod && k === "y") { e.preventDefault(); redo(); return; }
  if (mod && k === "d") { e.preventDefault(); editor.duplicate(); return; }
  if (mod && k === "g") { e.preventDefault(); (e.shiftKey ? editor.ungroup() : editor.group()); return; }
  if (mod && k === "a") { e.preventDefault(); editor.selectAll(); return; }
  if (mod && (k === "c" || k === "x")) {
    if (editor.selection.length) { e.preventDefault(); copySelection(k === "x"); }
    return;
  }
  if (mod && k === "v") {
    // Let the native paste event deliver system images before internal objects.
    return;
  }
  if (mod) return;
  if (k === "delete" || k === "backspace") {
    e.preventDefault();
    if (!(editor.usesTool("nodes") && editor.deleteSelectedNode())) editor.deleteSelection();
    return;
  }
  if (k === "escape") {
    if (editor.nodeSel && editor.selectedNode()) { editor.nodeSel = null; editor.drawOverlay(); renderPanel(); updateSelBar(); return; }
    if (!editor.exitGroup()) editor.select([]);
    setTool("select");
    return;
  }
  if (k.startsWith("arrow") && editor.selection.length && !editor.textEdit) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    // nudge() refuses (returns false) during a gesture, a text edit or for locked objects.
    if (editor.nudge(k === "arrowleft" ? -d : k === "arrowright" ? d : 0, k === "arrowup" ? -d : k === "arrowdown" ? d : 0) !== false) {
      refreshPosition();
      updateHistoryButtons();
      placeSelBar();
    }
    return;
  }
  if (k === "pagedown") { e.preventDefault(); stepSlide(1); return; }
  if (k === "pageup") { e.preventDefault(); stepSlide(-1); return; }
  if (k === "enter" && editor.selection.length === 1) {
    const s = editor.selection[0];
    if (s.localName === "text") { e.preventDefault(); editor.editText(s, false); }
    else if (s.localName === "g") { e.preventDefault(); editor.enterGroup(s); }
    return;
  }
  if (KEYS[k]) {
    setTool(KEYS[k]);
    if (editor.input === "pen") toast(actionLabel(`pen:${KEYS[k]}`), 1200);
  }
});

// Image paste shares the upload path, including origin-slide tracking and undo.
function imageFiles(data) {
  const files = [...(data?.files || [])].filter(f => f.type.startsWith("image/"));
  if (files.length) return files;
  return [...(data?.items || [])].filter(i => i.kind === "file" && i.type.startsWith("image/"))
    .map(i => i.getAsFile()).filter(Boolean);
}

async function readImageClipboard() {
  return (await readClipboard()).files;
}

/** The system clipboard's images, and its text (SVG markup counts as text)
 *  when it holds no image. */
async function readClipboard() {
  const items = await navigator.clipboard.read();
  const files = [];
  let text = "";
  for (const item of items) {
    // Raster images; SVG on the clipboard is markup to paste as objects.
    const type = item.types.find(t => t.startsWith("image/") && t !== "image/svg+xml");
    if (!type) continue;
    const blob = await item.getType(type);
    const ext = type === "image/jpeg" ? "jpg" : type.split("/")[1].split("+")[0];
    files.push(new File([blob], `pasted-image.${ext}`, { type }));
  }
  if (!files.length) {
    for (const item of items) {
      const type = ["image/svg+xml", "text/plain"].find((t) => item.types.includes(t));
      if (!type) continue;
      text = await (await item.getType(type)).text();
      if (text.trim()) break;
    }
  }
  return { files, text };
}

async function insertedImageFiles(box) {
  const files = [];
  for (const image of box.querySelectorAll("img")) {
    const src = image.getAttribute("src") || "";
    if (!/^(blob:|data:image\/)/i.test(src)) continue;
    const response = await fetch(src);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) continue;
    const ext = blob.type === "image/jpeg" ? "jpg" : blob.type.split("/")[1].split("+")[0];
    files.push(new File([blob], `pasted-image.${ext}`, { type: blob.type }));
  }
  return files;
}

let clearCanvasPaste = null;
async function pasteSystemClipboard(x, y) {
  clearCanvasPaste?.();
  const target = state.current;
  const center = editor.point({ clientX: x, clientY: y });
  if (navigator.clipboard?.read) {
    try {
      // Start the read in the menu click, before any asynchronous work.
      const { files, text } = await readClipboard();
      if (files.length) { uploadMedia(files, target, center); return; }
      if (state.current !== target) return;
      if (text.trim()) { pasteText(text, center); return; }
      if (clipboardData()) { pasteClipboard(); return; }
      toast("Nothing to paste. Copy an image, objects or text and choose Paste again.");
      return;
    } catch (error) { /* expose a native paste target on the canvas */ }
  }
  // HTTP has no async clipboard API. Use WebKit's native user-initiated paste
  // into a temporary editable on the main canvas, never into the saved SVG.
  const box = el("div", { id: "canvas-paste-target", contenteditable: "true", role: "textbox",
    "aria-label": "Paste on slide", style: `position:fixed;z-index:1000;left:${Math.max(8, Math.min(x, innerWidth - 168))}px;top:${Math.max(8, Math.min(y, innerHeight - 56))}px;width:160px;min-height:44px;padding:10px;background:var(--color-bg);border:1px solid var(--accent);user-select:text;-webkit-user-select:text;-webkit-touch-callout:default` }, "Paste here");
  let active = true, importing = false;
  let timeout;
  const clear = () => {
    active = false;
    clearTimeout(timeout);
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", escape, true);
    box.remove();
    if (clearCanvasPaste === clear) clearCanvasPaste = null;
  };
  const outside = e => { if (!box.contains(e.target)) clear(); };
  const escape = e => { if (e.key === "Escape") clear(); };
  const insert = files => {
    if (!active || importing || !files.length) return;
    importing = true;
    clear(); uploadMedia(files, target, center);
  };
  box.addEventListener("paste", e => {
    e.stopPropagation();
    const files = imageFiles(e.clipboardData);
    if (files.length) { e.preventDefault(); insert(files); return; }
    // Text and SVG markup become objects at this spot.
    const text = clipboardText(e.clipboardData);
    if (text.trim() && active && !importing) {
      e.preventDefault();
      clear();
      if (state.current === target) pasteText(text, center);
      return;
    }
    // Preserve native image insertion even when Safari exposes no clipboard
    // types. Internal objects have their own menu action.
  });
  box.addEventListener("input", async () => {
    try {
      const files = await insertedImageFiles(box);
      if (files.length) insert(files);
      else if (active) toast("No image found. Copy an image from Photos and try Paste again.");
    } catch (error) { if (active) toast("Could not read this image. Try copying it from Photos."); }
  });
  document.body.append(box);
  clearCanvasPaste = clear;
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", escape, true);
  timeout = setTimeout(clear, 60000);
  box.focus({ preventScroll: true });
  const range = document.createRange(); range.selectNodeContents(box);
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  try { document.execCommand("paste"); } catch (error) { /* native touch callout remains available */ }
  if (active) toast("Choose Paste in iPad’s prompt, or touch and hold Paste here.", 8000);
}

function showMediaPaste() {
  if (document.querySelector("dialog[open]")) return;
  const dialog = el("dialog", { class: "settings-dialog", id: "image-paste-dialog", "aria-labelledby": "image-paste-title" });
  const hint = el("p", { class: "hint" }, "Copy an image, tap Paste image, then approve iPad’s Paste prompt. You can also touch and hold in the box and choose Paste.");
  const target = state.current, center = editor.visibleCenter();
  const box = el("div", { id: "image-paste-target", contenteditable: "true", role: "textbox", "aria-label": "Paste an image here",
    style: "min-height:80px;padding:16px;border:1px solid currentColor;user-select:text;-webkit-user-select:text;-webkit-touch-callout:default" });
  const close = () => dialog.close();
  let importing = false;
  const insert = files => {
    if (importing || !dialog.open || !files.length) return;
    importing = true;
    close(); uploadMedia(files, target, center);
  };
  const focusBox = () => {
    box.focus();
    const range = document.createRange();
    range.selectNodeContents(box); range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
  };
  // iPad can insert an image into contenteditable without exposing a File in
  // the paste event. Let that native insertion finish and import its bytes.
  box.addEventListener("input", async () => {
    const images = [...box.querySelectorAll("img")];
    if (!images.length) return;
    try {
      const files = await insertedImageFiles(box);
      if (files.length) insert(files);
      else hint.textContent = "This image’s bytes are unavailable. Copy it from Photos, or choose a file.";
    } catch (error) {
      hint.textContent = "Could not read this image. Copy it from Photos, or choose a file.";
    }
  });
  const read = el("button", { class: "btn", type: "button", onclick: async () => {
    if (!navigator.clipboard?.read) {
      // WebKit supports this user-initiated paste over HTTP, where the async
      // clipboard API is absent. It may show the native iOS Paste callout.
      focusBox();
      try { document.execCommand("paste"); } catch (error) { /* use the native callout below */ }
      if (dialog.open) hint.textContent = "Choose Paste in iPad’s prompt. If it does not appear, touch and hold in the box and choose Paste.";
      return;
    }
    try {
      // Call read directly in the click gesture: Safari requires user activation.
      const files = await readImageClipboard();
      if (!dialog.open) return;
      if (!files.length) { hint.textContent = "No image found. Copy an image, then try again."; return; }
      insert(files);
    } catch (error) {
      if (dialog.open) hint.textContent = "Clipboard access was not available. Touch and hold in the box below and choose Paste, or choose a file.";
    }
  } }, "Paste image");
  box.addEventListener("paste", e => {
    e.stopPropagation();
    const files = imageFiles(e.clipboardData);
    if (files.length) { e.preventDefault(); insert(files); }
    // With no files, preserve Safari’s default rich image insertion; input
    // above imports it. Preventing default here used to discard that image.
  });
  dialog.append(el("header", {}, el("h2", { id: "image-paste-title" }, "Insert media"),
    el("button", { class: "btn", type: "button", onclick: close, "aria-label": "Close" }, "×")),
    el("div", { class: "panel settings-body" },
      el("button", { class: "btn", type: "button", onclick: () => { close(); $("media-file").click(); } }, "Choose image or movie…"),
      read, hint, box));
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
}

document.addEventListener("paste", e => {
  if (e.defaultPrevented || document.querySelector("dialog[open]") || editor.textEdit ||
      e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (!state.current) return;
  const files = imageFiles(e.clipboardData);
  if (files.length) { e.preventDefault(); uploadMedia(files); return; }
  const text = clipboardText(e.clipboardData);
  if (text.trim()) { e.preventDefault(); pasteText(text, pastePoint()); return; }
  if (clipboardData()) { e.preventDefault(); pasteClipboard(); }
});

function clipboardText(data) {
  try { return data?.getData("image/svg+xml") || data?.getData("text/plain") || ""; } catch (err) { return ""; }
}

// Safari zooms the page on a pinch or a double tap and selects text on a long
// press whatever the viewport says. Fields and the text being edited keep theirs.
const nativeText = (e) => {
  const at = e.target?.nodeType === 1 ? e.target : e.target?.parentElement;  // selectstart names a text node
  return !!at?.closest("input, textarea, select, [contenteditable]");
};
for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener("dblclick", (e) => { if (!nativeText(e)) e.preventDefault(); });
document.addEventListener("selectstart", (e) => { if (!nativeText(e)) e.preventDefault(); });

// Where keyboard paste puts objects: under the mouse when it is over the
// slide, otherwise the middle of what is visible.
let stagePointer = null;
$("stage").addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") stagePointer = { clientX: e.clientX, clientY: e.clientY }; });
$("stage").addEventListener("pointerleave", () => { stagePointer = null; });
function pastePoint() {
  return stagePointer ? editor.point(stagePointer) : editor.visibleCenter();
}

// The clipboard lives in localStorage, so it works across slides and decks.
// Copy and Cut also put the objects on the system clipboard as SVG markup,
// so they paste into other apps (and other browsers' Calliope).
function copySelection(cut) {
  const data = editor.copy();
  if (!data) return;
  state.clipboard = data;
  const markup = clipboardMarkup(data, editor.selectionGeometry());
  const mine = state.clipboardText = { text: markup, wrote: null };
  try {
    localStorage.setItem("svgdeck-clipboard", data);
    localStorage.setItem("svgdeck-clipboard-text", markup);
  } catch (err) { /* private mode: memory only */ }
  if (navigator.clipboard?.writeText) {
    try {
      navigator.clipboard.writeText(markup).then(() => { mine.wrote = true; }, () => { mine.wrote = false; });
    } catch (err) { mine.wrote = false; }
  } else mine.wrote = false;
  if (cut) editor.deleteSelection();
  else { toast(`Copied ${editor.selection.length} object${editor.selection.length === 1 ? "" : "s"}.`, 1500); renderPanel(); }
}

function clipboardData() {
  if (state.clipboard) return state.clipboard;  // a copy made in this page is the freshest
  try { return localStorage.getItem("svgdeck-clipboard"); } catch (err) { return null; }
}

/** The markup of our own last copy, as written to the system clipboard. */
function ownClipboardText() {
  if (state.clipboardText) return state.clipboardText.text;
  try { return localStorage.getItem("svgdeck-clipboard-text"); } catch (err) { return null; }
}

const SVG_NS = "http://www.w3.org/2000/svg", XLINK_NS = "http://www.w3.org/1999/xlink";

/** Internal clipboard data (editor.copy()) as one standalone SVG document,
 *  its viewBox the copied objects' bounds. */
function clipboardMarkup(data, box) {
  const clip = JSON.parse(data);
  const n = (v) => String(+(+v).toFixed(2));
  const view = box ? ` width="${n(Math.max(box.width, 1))}" height="${n(Math.max(box.height, 1))}"` +
    ` viewBox="${n(box.x)} ${n(box.y)} ${n(Math.max(box.width, 1))} ${n(Math.max(box.height, 1))}"` : "";
  return `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}"${view}>` +
    (clip.defs.length ? `<defs>${clip.defs.join("")}</defs>` : "") + clip.items.join("") + "</svg>";
}

const SVG_START = /^<(svg|g|a|rect|circle|ellipse|line|polyline|polygon|path|text|image|use|defs|symbol|switch)[\s/>]/i;
const stripProlog = (t) => t.replace(/^\s*(?:(?:<\?xml[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>|<!--[\s\S]*?-->)\s*)*/i, "");
const looksLikeSvg = (t) => SVG_START.test(stripProlog(t.trim()));
// Attributes of a root <svg> that only place it; the rest (fill, stroke,
// style…) are inherited by its contents, which keep them in a group.
const SVG_ROOT_ONLY = new Set(["width", "height", "viewBox", "x", "y", "id", "version", "baseProfile", "preserveAspectRatio",
  "class", "zoomAndPan", "enable-background", "overflow"]);

/** SVG markup from the system clipboard in the internal clipboard format,
 *  or null when it is not SVG that can be read. Scripts, embedded HTML and
 *  event handlers are dropped. */
function svgToClipboard(text) {
  const body = stripProlog(text.trim());
  let markup = /^<svg[\s/>]/i.test(body) ? body : `<svg>${body}</svg>`;
  markup = markup.replace(/^<svg\b([^>]*?)(\/?)>/i, (m, attrs, close) => {
    let a = attrs;
    if (!/\sxmlns\s*=/.test(a)) a += ` xmlns="${SVG_NS}"`;
    if (/\bxlink:/.test(markup) && !/\sxmlns:xlink\s*=/.test(a)) a += ` xmlns:xlink="${XLINK_NS}"`;
    return `<svg${a}${close}>`;
  });
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = doc.documentElement;
  if (doc.querySelector("parsererror") || root.namespaceURI !== SVG_NS || root.localName !== "svg") return null;
  for (const bad of [...root.querySelectorAll("script, foreignObject, iframe, embed, object")]) bad.remove();
  for (const node of [root, ...root.querySelectorAll("*")]) {
    for (const attr of [...node.attributes]) {
      const value = attr.value.trim().toLowerCase();
      if (/^on/i.test(attr.localName) || (attr.localName === "href" && value.startsWith("javascript:"))) node.removeAttributeNode(attr);
    }
  }
  const ser = new XMLSerializer();
  const defs = [], items = [];
  for (const child of [...root.children]) {
    if (child.namespaceURI !== SVG_NS || ["title", "desc", "metadata"].includes(child.localName)) continue;
    if (child.localName === "defs") {
      for (const d of child.children) if (d.namespaceURI === SVG_NS) defs.push(ser.serializeToString(d));
    } else if (child.localName === "style") defs.push(ser.serializeToString(child));
    else items.push(child);
  }
  if (!items.length) return null;
  const inherited = [...root.attributes].filter((a) => !a.namespaceURI && !SVG_ROOT_ONLY.has(a.localName));
  if (inherited.length) {
    const group = doc.createElementNS(SVG_NS, "g");
    for (const a of inherited) group.setAttribute(a.localName, a.value);
    group.append(...items);
    items.splice(0, items.length, group);
  }
  return JSON.stringify({ svgdeck: 1, defs, items: items.map((item) => ser.serializeToString(item)) });
}

/** Paste text from the system clipboard at a slide point: our own last copy
 *  pastes the internal objects (ids and transforms handled as always), SVG
 *  markup becomes objects, anything else a text object. */
function pasteText(text, point) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const internal = clipboardData();
  const own = ownClipboardText();
  if (internal && own && trimmed === own.trim()) { pasteClipboard(); return true; }
  // Our latest copy never reached the system clipboard: it is the newer one.
  if (internal && state.clipboardText?.wrote === false) { pasteClipboard(); return true; }
  settleCurrentSlide();
  if (looksLikeSvg(trimmed)) {
    const data = svgToClipboard(trimmed);
    if (!data) { toast("The clipboard holds SVG that could not be read."); return false; }
    pasteObjectsAt(data, point);
    return true;
  }
  pastePlainText(text, point);
  return true;
}

/** Paste internal clipboard data centred on a slide point, as one undo step. */
function pasteObjectsAt(data, point) {
  const before = editor.selection;
  editor.change(() => {
    if (!editor.paste(data) || editor.selection === before) return;
    const box = editor.selectionGeometry();
    if (box && point) editor.setSelectionGeometry({ x: point.x - box.width / 2, y: point.y - box.height / 2 });
  });
}

/** A new text object holding plain text, in the style for new text. */
function pastePlainText(text, point) {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
  editor.change(() => {
    const t = editor.newText(point || editor.visibleCenter());
    const base = { ...editor.lookAt(t), paint: {} };
    editor.setTextRuns(t, lines.map((line) => (line ? [{ text: line, look: base }] : [])), base, null);
    editor.selection = [t];
  });
}

function pasteClipboard() {
  const data = clipboardData();
  if (data) editor.paste(data);
}

/** Undo and Redo are disabled while there is nothing to take back or
 *  redo. An open text edit counts: the button ends it as one step. */
function updateHistoryButtons() {
  const rec = state.current ? state.slides.get(state.current) : null;
  const can = {
    undo: !!(editor.textEdit || editor.nudging || rec?.undo?.length),
    redo: !!(editor.textEdit || rec?.redo?.length),
  };
  for (const [what, on] of Object.entries(can)) {
    for (const b of document.querySelectorAll(`#${what}, [data-history="${what}"]`)) {
      b.disabled = !on;
      b.setAttribute("aria-disabled", String(!on));
    }
  }
}

function undo() {
  // While editing text, Undo ends the edit (keeping it as one undo step);
  // the next Undo takes it back.
  if (editor.textEdit) { editor.endTextEdit(true); return; }
  // Arrow-key nudges still waiting to join one step become that step first.
  editor.endNudge?.();
  const rec = state.slides.get(state.current);
  if (!rec?.undo.length) return;
  rec.redo.push(rec.text);
  const text = rec.undo.pop();
  editor.load(text, { keepView: true });
  markDirty(state.current, text);
}

function redo() {
  if (editor.textEdit) { editor.endTextEdit(true); return; }
  editor.endNudge?.();
  const rec = state.slides.get(state.current);
  if (!rec?.redo.length) return;
  rec.undo.push(rec.text);
  const text = rec.redo.pop();
  editor.load(text, { keepView: true });
  markDirty(state.current, text);
}

// --- wiring ------------------------------------------------------------------------------------------
async function present(speaker = false) {
  const url = `/d/${DECK}/${speaker ? "?speaker=1" : ""}#${index() + 1}`;
  const win = window.open("about:blank", "_blank");
  try { await flush(); if (win) win.location.href = url; else location.href = url; }
  catch (e) { win?.close(); toast(`Not presenting: the deck is not saved (${e.message}).`, 8000); }
}

function wire() {
  $("undo").onclick = undo;
  $("redo").onclick = redo;
  updateHistoryButtons();
  for (const id of ["undo", "redo"]) {
    // Keep an open text box focused until the click, which ends the edit as one step.
    $(id).addEventListener("pointerdown", (e) => { if (editor.textEdit) { editor.textEdit.holding = true; e.preventDefault(); } });
  }
  $("zoom-in").onclick = () => editor.zoomBy(1.25);
  $("zoom-out").onclick = () => editor.zoomBy(0.8);
  $("zoom-fit").onclick = () => editor.fit();
  $("present").onclick = guard(() => present(), "Could not present");
  const side = (cls, button) => {
    document.body.classList.toggle(cls);
    $(button).setAttribute("aria-pressed", String(!document.body.classList.contains(cls)));
  };
  $("toggle-strip").onclick = () => side("no-strip", "toggle-strip");
  $("toggle-panel").onclick = () => {
    if (document.body.classList.contains("no-panel")) showInspector();
    else side("no-panel", "toggle-panel");
  };
  for (const b of document.querySelectorAll("#inspector-tabs [data-tab]")) b.onclick = () => showInspector(b.dataset.tab);
  $("doc-menu-btn").onclick = () => { buildDocMenu(); toggleMenu($("doc-menu"), $("doc-menu-btn")); };
  $("slide-menu-btn").onclick = () => toggleMenu($("slide-menu"), $("slide-menu-btn"));
  $("slide-menu").addEventListener("click", (e) => { if (e.target.closest("button")) closeMenus(); });
  for (const menu of ["doc-menu", "slide-menu"]) {
    $(menu).addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeMenus(); $(`${menu}-btn`).focus(); }
    });
  }
  $("back").onclick = (e) => {
    if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;  // a new tab or window: nothing is left
    e.preventDefault();
    leave($("back").getAttribute("href"));
  };
  $("slide-add").onclick = guard(() => addSlide(blankSlide()), "Could not add a slide");
  $("slide-dup").onclick = guard(duplicateSlide, "Could not duplicate the slide");
  $("slide-up").onclick = guard(() => moveSlide(-1), "Could not move the slide");
  $("slide-down").onclick = guard(() => moveSlide(1), "Could not move the slide");
  $("slide-del").onclick = guard(deleteSlide, "Could not delete the slide");
  $("settings-close").onclick = () => {
    // The close event fires a task later; stop learning before any key can arrive.
    if (controller.learning) controller.cancelLearning();
    $("settings-dialog").close();
  };
  $("settings-dialog").addEventListener("close", () => {
    settingsKind = null;
    // A key pressed after closing must not be bound.
    if (controller.learning) controller.cancelLearning();
  });
  $("settings-dialog").addEventListener("cancel", (e) => { if (controller.learning) e.preventDefault(); });
  $("exit-group").onclick = () => editor.exitGroup();
  $("inspector").addEventListener("pointerdown", () => { if (editor.textEdit) editor.textEdit.holding = true; }, true);
  $("sel-bar").addEventListener("pointerdown", (e) => {
    // Formatting while editing text must not end the edit.
    if (editor.textEdit) { editor.textEdit.holding = true; e.preventDefault(); }
  }, true);
  $("media-file").onchange = (e) => { uploadMedia([...e.target.files]); e.target.value = ""; };
  $("replace-file").onchange = (e) => {
    const file = e.target.files[0], target = replacing;
    e.target.value = "";
    replacing = null;
    if (file && target) replaceMedia(file, target);
  };
  $("font-file").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const face = await api.upload(`/api/fonts?filename=${encodeURIComponent(file.name)}`, file);
      state.faces = await api.fonts();
      installFaces(state.faces);
      toast(`Added ${face.name} to the font library.`);
      renderPanel();
      renderSettings();
    } catch (err) { toast(`Could not add the font: ${err.message}`, 8000); }
  };
  // Narrow windows (a phone, iPad Split View) give the stage the room: the
  // strip and inspector close, and open again from the top bar.
  const narrow = matchMedia("(max-width: 899px)");
  const collapse = () => {
    if (!narrow.matches) return;
    document.body.classList.add("no-strip", "no-panel");
    $("toggle-strip").setAttribute("aria-pressed", "false");
    $("toggle-panel").setAttribute("aria-pressed", "false");
  };
  narrow.addEventListener("change", collapse);
  collapse();
}

async function duplicateSlide() {
  await flush();
  await addSlide(state.slides.get(state.current).text, state.deck.slides[index()].notes);
}

async function main() {
  wire();
  notes = installNotes({state,putDeck,toast,mount:$("notes-mount")});
  const objects = installObjects({editor,state,toast,settle:settleCurrentSlide,mount:$("objects-mount")});
  // Objects, builds and notes opened from anywhere show in the inspector's tabs.
  objectPanels = { render: objects.render, open(mode = "objects") {
    const tab = mode === "builds" ? "builds" : "objects";
    if (inspectorTab !== tab || document.body.classList.contains("no-panel")) showInspector(tab);
    else objects.open(tab);
  } };
  const openNotes = notes.open;
  notes.open = (focus = true) => {
    if (inspectorTab !== "notes" || document.body.classList.contains("no-panel")) {
      inspectorTab = "notes";
      showInspector("notes");
    }
    openNotes(focus);
  };
  mediaTools = installMediaTools({editor,toast,settle:settleCurrentSlide});
  recovery = installRecovery({editor,state,api,toast,settle:settleCurrentSlide,flush,openSlide,renderStrip,refreshStatus,putDeck});
  commits = installCommits({editor,state,api,toast,settle:settleCurrentSlide,flush,openSlide,renderStrip,refreshStatus});
  editor.tools.pen = state.prefs.penLinked ? "select" : state.prefs.penTool || "pen";
  editor.penSeen = !!state.prefs.penSeen;
  buildRail();
  buildViewBar();
  Object.assign(editor.grid, state.prefs.grid);
  try {
    const [deck, faces] = await Promise.all([api.deck(), api.fonts()]);
    state.deck = deck.deck;
    state.version = deck.version;
    state.faces = faces;
  } catch (e) {
    setStatus("Error", "error");
    toast(`Could not load the deck: ${e.message}`, 20000);
    return;
  }
  installFaces(state.faces);
  showDeckTitle();
  renderStrip();
  const slides = state.deck.slides;
  if (!slides.length) {
    setStatus("No slides", "error");
    toast("This deck has no slides. Tap + Slide to add one.", 20000);
    return;
  }
  const m = /^#(\d+)$/.exec(location.hash);
  const start = m ? Math.max(0, Math.min(+m[1] - 1, slides.length - 1)) : 0;
  // A slide that cannot be opened is skipped for the next one that can.
  for (const s of [...slides.slice(start), ...slides.slice(0, start)]) {
    if (await openSlide(s.id)) break;
  }
  if (!state.current) { setStatus("Error", "error"); updateHistoryButtons(); return; }
  setStatus("Saved · working copy", "ok");
  updateHistoryButtons();
}

main();
window.svgdeckEditor = { editor, state, openSlide, undo, redo, flush, controller, runAction, setTool, exportDeck, copySelection, pasteText,
  get objectPanels() {return objectPanels;}, get mediaTools() {return mediaTools;}, get recovery() {return recovery;}, get commits() {return commits;} };
