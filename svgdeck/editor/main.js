// svgdeck editor: deck state, saving, undo, slide strip, toolbar, properties.
import { SlideEditor, firstGlyphElement, cssFamily } from "./canvas.js";
import { prefixIds, toHex } from "./geom.js";
import { Controller, DEFAULT_BINDINGS, TOOL_NAMES, actionGroups, actionLabel, inputLabel } from "./inputs.js";
import { installNotes } from "./notes.js";
import { installObjects } from "./objects.js";
import { installMediaTools } from "./media-tools.js";
import { installRecovery } from "./recovery.js";
import { installCommits } from "./commits.js";
import { createColorControl } from "./colors.js";
import { IMAGE_ADJUSTMENTS, adjustmentValue, setImageAdjustment, resetImageAdjustments, upgradeImageAdjustments } from "./image-adjustments.js";

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
  ["pen", "Draw (P)", "M4 20c3-1 4-5 7-8s5-6 9-8M16 4l4 4"],
  ["erase", "Erase (X)", "M15 4l5 5-10 10H6l-3-3zM9 10l5 5M10 19h10"],
];
const KEYS = { c: "circle", g: "polygon", b: "bezier", n: "nodes", v: "select", h: "pan", t: "text", r: "rect", e: "ellipse", l: "line", a: "arrow", p: "pen", x: "erase" };

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
  async putSlide(id, text, base) {
    const r = await fetch(`/api/decks/${DECK}/slides/${id}`, {
      method: "PUT", body: text, headers: { "Content-Type": "image/svg+xml", ...(base ? { "If-Match": `"${base}"` } : {}) },
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

// --- editor --------------------------------------------------------------------------
const editor = new SlideEditor($("stage"), {
  commit(before, after) {
    const rec = state.slides.get(state.current);
    rec.undo.push(before);
    if (rec.undo.length > 150) rec.undo.shift();
    rec.redo = [];
    markDirty(state.current, after);
  },
  select() { closeContextMenu(); updateActions(); renderPanel(); updateBreadcrumb(); refreshStatus(); },
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
  clearTimeout(rec.timer);
  rec.timer = setTimeout(() => save(id).catch(() => {}), 700);
  scheduleThumb(id);
}

async function save(id) {
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
        rec.version = await api.putSlide(id, text, rec.version);
        rec.saveError = null;
        if (rec.text === text) rec.dirty = false;
      } catch (e) {
        rec.saveError = e;
        if (e.status === 409) {
          rec.conflict = true;
          setStatus("Conflict", "error");
          toast("This slide was changed elsewhere. Open the deck menu → History and recovery, then Keep both versions to preserve your edits.", 10000);
        } else {
          setStatus("Not saved", "error");
          toast(`Saving failed: ${e.message}. Retrying…`);
          rec.timer = setTimeout(() => save(id).catch(() => {}), 3000);
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
  else if (recs.some((r) => r.saveError)) setStatus("Not saved", "error");
  else if (recs.some((r) => r.dirty)) setStatus("Unsaved", "dirty");
  else if (editor.pathDraft) setStatus("Drawing path…", "busy");
  else setStatus("Saved · working copy", "ok");
}

async function flush() {
  mediaTools?.finish?.();
  editor.finishPath();
  editor.syncTextEdit();
  await notes?.flush();
  while (true) {
    const pending = [...state.slides.entries()].filter(([, r]) => r.dirty || r.savePromise);
    if (!pending.length) return;
    await Promise.all(pending.map(([id]) => save(id)));
  }
}

window.addEventListener("beforeunload", (e) => {
  if (editor.pathDraft?.nodes.length || [...state.slides.values()].some((r) => r.dirty || r.saving)) { e.preventDefault(); e.returnValue = ""; }
});
document.addEventListener("visibilitychange", () => { if (document.hidden) flush().catch(() => {}); });

async function putDeck(deck) {
  try {
    const res = await api.putDeck(deck, state.version);
    state.deck = deck;
    state.version = res.version;
  } catch (e) {
    toast(e.status === 409 ? "The deck was changed somewhere else; reload the page." : `Could not save deck changes: ${e.message}`, 8000);
    throw e;
  }
}

async function ensureFamily(family) {
  if (!family || (state.deck.fonts || []).some((f) => f.family === family)) return;
  if (!state.faces.some((f) => f.family === family)) return;
  try {
    await notes?.flush();
    const res = await api.useFamily(family);
    state.deck = res.deck;
    state.version = res.version;
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
    const { text, version } = await rec.loading;
    rec.loading = null;
    rec.text = text;
    rec.version = version;
  }
  return rec;
}

let navigationSequence = 0;

function settleCurrentSlide() {
  mediaTools?.finish?.();
  editor.endTextEdit(true);
  editor.finishPath();
  editor.cancelGesture();
  editor.pointers.clear();
  editor.touchStart = null;
}

async function openSlide(id) {
  const sequence = ++navigationSequence;
  if (state.current === id) return;
  if (state.current && state.current !== id) settleCurrentSlide();
  const rec = await slideRecord(id);
  if (sequence !== navigationSequence) return;
  if (state.current && state.current !== id) settleCurrentSlide();
  state.current = id;
  try {
    editor.load(rec.text);
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
}

const index = () => state.deck.slides.findIndex((s) => s.id === state.current);
const newId = () => "s" + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");

async function addSlide(text, notes = "") {
  await flush();
  const id = newId();
  const version = await api.putSlide(id, text, null);
  state.slides.set(id, { text, version, undo: [], redo: [] });
  const slides = [...state.deck.slides];
  slides.splice(index() + 1, 0, { id, ...(notes ? {notes} : {}) });
  await putDeck({ ...state.deck, slides });
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
  const i = index(), j = i + delta;
  if (j < 0 || j >= state.deck.slides.length) return;
  const slides = [...state.deck.slides];
  [slides[i], slides[j]] = [slides[j], slides[i]];
  await putDeck({ ...state.deck, slides });
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
  const i = index();
  const slides = state.deck.slides.filter((s) => s.id !== state.current);
  await putDeck({ ...state.deck, slides });
  state.slides.delete(state.current);
  state.current = null;
  renderStrip();
  await openSlide(slides[Math.min(i, slides.length - 1)].id);
}

// --- slide strip with live thumbnails ------------------------------------------------------
const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) renderThumb(e.target.dataset.id);
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
    li.addEventListener("click", () => openSlide(s.id));
    ol.appendChild(li);
    thumbObserver.observe(li);
  });
}

const thumbTimers = new Map();
function scheduleThumb(id) {
  clearTimeout(thumbTimers.get(id));
  thumbTimers.set(id, setTimeout(() => renderThumb(id, true), 600));
}

async function renderThumb(id, force = false) {
  const li = $("thumbs").querySelector(`li[data-id="${CSS.escape(id)}"]`);
  if (!li || (li.dataset.rendered && !force)) return;
  li.dataset.rendered = "1";
  const rec = await slideRecord(id);
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
  shapes: { name: "Shapes", tools: ["rect", "ellipse", "circle", "polygon", "line", "arrow"] },
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
      b.title = TOOL[id].title;
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
      () => setGuides(!editor.smartSnap)));
  paintViewBar();
}

function paintViewBar() {
  $("grid").setAttribute("aria-pressed", String(!!state.prefs.grid.show));
  $("snap").setAttribute("aria-pressed", String(!!state.prefs.grid.snap));
  $("smart-guides").setAttribute("aria-pressed", String(!!editor.smartSnap));
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
    case "next-slide": { const s = state.deck.slides[index() + 1]; if (s) openSlide(s.id); break; }
    case "prev-slide": { const s = state.deck.slides[index() - 1]; if (s) openSlide(s.id); break; }
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
  if (first.getAttribute("data-ink") === "pressure") return "Ink stroke";
  if (["line", "path", "polyline"].includes(first.localName) && editor.hasArrow(first, "end")) return "Arrow";
  return { text: "Text", rect: "Rectangle", ellipse: "Ellipse", circle: "Circle", line: "Line", path: "Path", polygon: "Polygon",
    polyline: "Line", image: "Image", g: "Group", use: "Clone" }[first.localName] || first.localName;
}

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
      barButton("Done", "Finish editing (Esc)", () => editor.endTextEdit(true), { on: true }),
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
  const tail = [barSep(), alignBtn, more];

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
      ...(movie ? [barSep(),
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
  if (!items) { bar.hidden = true; alignOpen = false; return; }
  const [kind, buttons] = items;
  $("sel-row").replaceChildren(el("span", { class: "sel-kind" }, kind), ...buttons);
  const alignRow = $("align-row");
  const sel = editor.selection;
  alignRow.hidden = !(alignOpen && sel.length && !editor.textEdit);
  if (!alignRow.hidden) {
    const toSlide = sel.length === 1 || editor.alignToSlide;
    alignRow.replaceChildren(
      ...ALIGN.map(([how, title, path]) => barButton("", title, () => editor.align(how, toSlide), { path })),
      ...(sel.length > 2 ? [barSep(),
        barButton("Across", "Space evenly left to right", () => editor.distribute("x")),
        barButton("Down", "Space evenly top to bottom", () => editor.distribute("y"))] : []),
      barSep(),
      sel.length > 1
        ? barButton(toSlide ? "to slide" : "to selection", "Align to the slide or to the selection's bounds",
          () => { editor.alignToSlide = !editor.alignToSlide; updateSelBar(); })
        : el("span", { class: "note" }, "to slide"));
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
  const sep = () => el("div", { class: "menu-sep", role: "separator" });
  const pencil = state.prefs.penLinked ? "Pencil acts as a finger" : `Pencil: ${TOOL_NAMES[editor.tools.pen] || editor.tools.pen}`;
  menu.replaceChildren(
    item("commit-deck", "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M2 12h6M16 12h6", "Commit snapshot…", "An immutable copy of the whole deck", () => commits?.open()),
    item(null, "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2", "History and recovery", "Slide revisions, deleted slides", () => recovery?.open()),
    sep(),
    item("export", "M12 3v12M7 10l5 5 5-5M5 21h14", "Export offline copy", "A .zip that plays without network", exportDeck),
    item(null, "M3 4h18v12H3zM8 20h8M12 16v4", "Speaker view", "Notes, next slide, timer", () => present(true)),
    sep(),
    item(null, "M4 6h16M4 12h16M4 18h16", "Deck settings", `Fonts · ${state.deck.size?.join(" × ") || "1920 × 1080"}`, () => openSettings("deck")),
    item("pen-status", "M4 20l1-5L16 4l4 4L9 19z", "Pencil and controller",
      pencil + (controller.pads.length ? " · controller connected" : ""), () => openSettings("pencil")),
    sep(),
    item(null, "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z", "All decks", "", () => { location.href = "/"; }));
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
  $("settings-body").replaceChildren(...(settingsKind === "pencil" ? [pencilSection()] : [
    section("Slides", el("p", { class: "hint" }, `${state.deck.slides.length} slides, ${(state.deck.size || [1920, 1080]).join(" × ")} pixels.`)),
    section("Fonts", el("p", { class: "hint" }, `${families().length} families in the library.`),
      buttonRow([["Upload font…", "Add an .otf or .ttf file to the font library", () => $("font-file").click()]])),
  ]));
}

async function exportDeck() {
  try { await flush(); } catch (error) { return; }
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
  if (sel.length === 1 && first.localName === "image") {
    parts.push(section("Crop",
      buttonRow([[isMovie ? "Crop movie" : "Crop image", "Drag the crop handles on the slide", () => mediaTools?.open()]]),
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
    parts.push(section("Playback", check("data-autoplay", "Play automatically", true), check("data-loop", "Loop", true),
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
  if (controller.keydown(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
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
  if (k.startsWith("arrow") && editor.selection.length) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    editor.moveBy(k === "arrowleft" ? -d : k === "arrowright" ? d : 0, k === "arrowup" ? -d : k === "arrowdown" ? d : 0);
    return;
  }
  if (k === "pagedown") { e.preventDefault(); const s = state.deck.slides[index() + 1]; if (s) openSlide(s.id); return; }
  if (k === "pageup") { e.preventDefault(); const s = state.deck.slides[index() - 1]; if (s) openSlide(s.id); return; }
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
  const items = await navigator.clipboard.read();
  const files = [];
  for (const item of items) {
    const type = item.types.find(t => t.startsWith("image/"));
    if (!type) continue;
    const blob = await item.getType(type);
    const ext = type === "image/jpeg" ? "jpg" : type.split("/")[1].split("+")[0];
    files.push(new File([blob], `pasted-image.${ext}`, { type }));
  }
  return files;
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
      const files = await readImageClipboard();
      if (files.length) { uploadMedia(files, target, center); return; }
      if (clipboardData() && state.current === target) { pasteClipboard(); return; }
      toast("No image found. Copy an image and choose Paste again.");
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
    if (files.length) { e.preventDefault(); insert(files); }
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
  const files = imageFiles(e.clipboardData);
  if (files.length) { e.preventDefault(); uploadMedia(files); return; }
  if (clipboardData()) { e.preventDefault(); pasteClipboard(); }
});

// The clipboard lives in localStorage, so it works across slides and decks.
function copySelection(cut) {
  const data = editor.copy();
  if (!data) return;
  state.clipboard = data;
  try { localStorage.setItem("svgdeck-clipboard", data); } catch (err) { /* private mode: memory only */ }
  if (cut) editor.deleteSelection();
  else { toast(`Copied ${editor.selection.length} object${editor.selection.length === 1 ? "" : "s"}.`, 1500); renderPanel(); }
}

function clipboardData() {
  if (state.clipboard) return state.clipboard;  // a copy made in this page is the freshest
  try { return localStorage.getItem("svgdeck-clipboard"); } catch (err) { return null; }
}

function pasteClipboard() {
  const data = clipboardData();
  if (data) editor.paste(data);
}

function undo() {
  const rec = state.slides.get(state.current);
  if (!rec?.undo.length) return;
  editor.endTextEdit(true);
  rec.redo.push(rec.text);
  const text = rec.undo.pop();
  editor.load(text, { keepView: true });
  markDirty(state.current, text);
}

function redo() {
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
  catch (e) { win?.close(); }
}

function wire() {
  $("undo").onclick = undo;
  $("redo").onclick = redo;
  $("zoom-in").onclick = () => editor.zoomBy(1.25);
  $("zoom-out").onclick = () => editor.zoomBy(0.8);
  $("zoom-fit").onclick = () => editor.fit();
  $("present").onclick = () => present();
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
  $("slide-add").onclick = () => addSlide(blankSlide());
  $("slide-dup").onclick = duplicateSlide;
  $("slide-up").onclick = () => moveSlide(-1);
  $("slide-down").onclick = () => moveSlide(1);
  $("slide-del").onclick = deleteSlide;
  $("settings-close").onclick = () => $("settings-dialog").close();
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
  $("deck-title").textContent = state.deck.title || DECK;
  document.title = `${state.deck.title || DECK} · svgdeck`;
  renderStrip();
  const m = /^#(\d+)$/.exec(location.hash);
  const start = state.deck.slides[m ? Math.min(+m[1] - 1, state.deck.slides.length - 1) : 0];
  await openSlide(start.id);
  setStatus("Saved · working copy", "ok");
}

main();
window.svgdeckEditor = { editor, state, openSlide, undo, redo, flush, controller, runAction, setTool, exportDeck,
  get objectPanels() {return objectPanels;}, get mediaTools() {return mediaTools;}, get recovery() {return recovery;}, get commits() {return commits;} };
