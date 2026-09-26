// svgdeck editor: deck state, saving, undo, slide strip, toolbar, properties.
import { SlideEditor, firstGlyphElement, cssFamily } from "./canvas.js";
import { prefixIds, toHex } from "./geom.js";

const DECK = document.body.dataset.deck;
const $ = (id) => document.getElementById(id);
const PALETTE = ["#000000", "#333333", "#7c7c7c", "#c2c2c2", "#ffffff", "#92b1e5",
                 "#1f77b4", "#d62728", "#2ca02c", "#ff7f0e", "#9467bd", "#8c564b"];
const TOOLS = [
  ["select", "Select (V)", "M5 3l14 9-6 1.5L16 20l-2.5 1-3-6.5L5 18z"],
  ["text", "Text (T)", "M5 5h14M12 5v14M9 19h6"],
  ["rect", "Rectangle (R)", "M4 6h16v12H4z"],
  ["ellipse", "Ellipse (E)", "M12 5c5 0 9 3.1 9 7s-4 7-9 7-9-3.1-9-7 4-7 9-7z"],
  ["line", "Line (L)", "M5 19L19 5"],
  ["arrow", "Arrow (A)", "M5 19L19 5M11 5h8v8"],
  ["pen", "Draw (P) — Pencil or finger", "M4 20c3-1 4-5 7-8s5-6 9-8M16 4l4 4"],
];
const KEYS = { v: "select", t: "text", r: "rect", e: "ellipse", l: "line", a: "arrow", p: "pen" };

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
  async slide(id) {
    const r = await fetch(`/api/decks/${DECK}/slides/${id}`);
    if (!r.ok) throw new Error(`slide ${id}: ${r.status}`);
    return { text: await r.text(), version: r.headers.get("ETag").replaceAll('"', "") };
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

function loadPrefs() {
  const defaults = { fill: "#92b1e5", stroke: "none", strokeWidth: 4, textFill: "#000000", family: null,
                     weight: 400, size: 48, recent: [] };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem("svgdeck-prefs") || "{}") }; } catch (e) { return defaults; }
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
  select() { renderPanel(); updateBreadcrumb(); },
  toast,
  hrefIn, hrefOut,
  shapeStyle: () => ({ fill: state.prefs.fill, stroke: state.prefs.stroke, strokeWidth: state.prefs.strokeWidth }),
  textStyle: () => ({ family: state.prefs.family || defaultFamily(), weight: state.prefs.weight,
                      size: state.prefs.size, fill: state.prefs.textFill }),
  ensureFont: (family) => ensureFamily(family),
  toolDone: () => setTool("select", { keepEdit: true }),
  zoomChanged: (z) => { $("zoom-label").textContent = editor.fitMode ? "fit" : `${Math.round(z * 100)}%`; },
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
  rec.timer = setTimeout(() => save(id), 700);
  scheduleThumb(id);
}

async function save(id) {
  const rec = state.slides.get(id);
  if (!rec || !rec.dirty || rec.conflict) return;
  if (rec.saving) { rec.again = true; return; }
  rec.saving = true;
  const text = rec.text;
  setStatus("Saving…", "busy");
  try {
    rec.version = await api.putSlide(id, text, rec.version);
    if (rec.text === text) rec.dirty = false;
  } catch (e) {
    if (e.status === 409) {
      rec.conflict = true;
      setStatus("Conflict", "error");
      toast("This slide was changed somewhere else. Reload the page to get the latest version (your last edits here are not saved).", 10000);
    } else {
      setStatus("Not saved", "error");
      toast(`Saving failed: ${e.message}. Retrying…`);
      setTimeout(() => save(id), 3000);
    }
  } finally {
    rec.saving = false;
  }
  if (rec.again || (rec.dirty && !rec.conflict && rec.text !== text)) { rec.again = false; save(id); }
  refreshStatus();
}

function refreshStatus() {
  const recs = [...state.slides.values()];
  if (recs.some((r) => r.conflict)) setStatus("Conflict", "error");
  else if (recs.some((r) => r.dirty || r.saving)) setStatus("Saving…", "busy");
  else setStatus("Saved", "ok");
}

async function flush() {
  await Promise.all([...state.slides.entries()].filter(([, r]) => r.dirty).map(([id]) => save(id)));
}

window.addEventListener("beforeunload", (e) => {
  if ([...state.slides.values()].some((r) => r.dirty || r.saving)) { e.preventDefault(); e.returnValue = ""; }
});
document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });

async function putDeck(deck) {
  try {
    const res = await api.putDeck(deck, state.version);
    state.deck = deck;
    state.version = res.version;
  } catch (e) {
    toast(e.status === 409 ? "The deck was changed somewhere else; reload the page." : `Could not save the slide order: ${e.message}`, 8000);
    throw e;
  }
}

async function ensureFamily(family) {
  if (!family || (state.deck.fonts || []).some((f) => f.family === family)) return;
  if (!state.faces.some((f) => f.family === family)) return;
  try {
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

async function openSlide(id) {
  if (state.current && state.current !== id) editor.endTextEdit(true);
  const rec = await slideRecord(id);
  state.current = id;
  try {
    editor.load(rec.text);
  } catch (e) {
    toast(e.message, 8000);
  }
  history.replaceState(null, "", `#${index() + 1}`);
  for (const li of $("thumbs").children) li.classList.toggle("current", li.dataset.id === id);
  $("thumbs").querySelector(".current")?.scrollIntoView({ block: "nearest" });
  renderPanel();
}

const index = () => state.deck.slides.findIndex((s) => s.id === state.current);
const newId = () => "s" + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");

async function addSlide(text) {
  await flush();
  const id = newId();
  const version = await api.putSlide(id, text, null);
  state.slides.set(id, { text, version, undo: [], redo: [] });
  const slides = [...state.deck.slides];
  slides.splice(index() + 1, 0, { id });
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
  const i = index(), j = i + delta;
  if (j < 0 || j >= state.deck.slides.length) return;
  const slides = [...state.deck.slides];
  [slides[i], slides[j]] = [slides[j], slides[i]];
  await putDeck({ ...state.deck, slides });
  renderStrip();
  $("thumbs").querySelector(".current")?.scrollIntoView({ block: "nearest" });
  history.replaceState(null, "", `#${index() + 1}`);
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

function renderStrip() {
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
  const svg = document.importNode(doc.documentElement, true);
  for (const el of svg.querySelectorAll("[href]")) el.setAttribute("href", hrefIn(el.getAttribute("href")));
  prefixIds(svg, `t-${id}-`);
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  li.querySelector(".thumb").replaceChildren(svg);
}

// --- toolbar -------------------------------------------------------------------------------
function icon(path) {
  return `<svg viewBox="0 0 24 24" class="icon"><path d="${path}"/></svg>`;
}

function buildToolbar() {
  const tools = $("tools");
  for (const [name, title, path] of TOOLS) {
    const b = document.createElement("button");
    b.className = "btn tool";
    b.dataset.tool = name;
    b.title = title;
    b.innerHTML = icon(path);
    b.addEventListener("click", () => setTool(name));
    tools.appendChild(b);
  }
  const media = document.createElement("button");
  media.className = "btn tool";
  media.title = "Insert image or movie";
  media.innerHTML = icon("M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M15 9h.01");
  media.addEventListener("click", () => $("media-file").click());
  tools.appendChild(media);
  setTool("select");
}

function setTool(name, { keepEdit = false } = {}) {
  if (editor.textEdit && !keepEdit) editor.endTextEdit(true);
  editor.tool = name;
  for (const b of document.querySelectorAll("[data-tool]")) b.setAttribute("aria-pressed", String(b.dataset.tool === name));
  $("stage").dataset.tool = name;
  editor.drawOverlay();
}

async function uploadMedia(files) {
  for (const file of files) {
    const video = file.type.startsWith("video/");
    toast(video ? `Uploading ${file.name} (movies are converted for playback, this can take a while)…` : `Uploading ${file.name}…`, 60000);
    try {
      const info = await api.upload(`/api/decks/${DECK}/media?filename=${encodeURIComponent(file.name)}`, file);
      editor.insertMedia(info);
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

function section(title, ...content) {
  return el("section", {}, el("h3", {}, title), ...content);
}

function row(label, ...controls) {
  return el("div", { class: "row" }, el("label", {}, label), el("div", { class: "controls" }, ...controls));
}

function colorControl(value, onPick, allowNone) {
  const current = toHex(value);
  const wrap = el("div", { class: "colors" });
  const pick = (c) => {
    if (c && c !== "none") {
      state.prefs.recent = [c, ...state.prefs.recent.filter((r) => r !== c)].slice(0, 6);
      savePrefs();
    }
    onPick(c);
  };
  const colors = [...new Set([...state.prefs.recent, ...PALETTE])].slice(0, 16);
  for (const c of colors) {
    wrap.append(el("button", { class: "swatch" + (c === current ? " on" : ""), style: `background:${c}`, title: c,
      onclick: () => pick(c) }));
  }
  if (allowNone) {
    wrap.append(el("button", { class: "swatch none" + (!current ? " on" : ""), title: "none", onclick: () => pick("none") }));
  }
  const input = el("input", { type: "color", value: current || "#000000", title: "Any colour" });
  input.addEventListener("change", () => pick(input.value));
  wrap.append(input);
  return wrap;
}

function numberControl(value, { min = 0, max = 1000, step = 1, suffix = "" } = {}, onSet) {
  const input = el("input", { type: "number", value: +(+value).toFixed(2), min, max, step, inputmode: "decimal" });
  input.addEventListener("change", () => { if (input.value !== "") onSet(+input.value); });
  return el("span", { class: "num" }, input, suffix);
}

function buttonRow(buttons) {
  return el("div", { class: "buttons" }, buttons.map(([label, title, fn, on]) =>
    el("button", { class: "btn small" + (on ? " on" : ""), title, onclick: fn }, label)));
}

function families() {
  return [...new Set(state.faces.map((f) => f.family))].sort();
}

function renderPanel() {
  const panel = $("panel");
  const sel = editor.selection;
  const parts = [];
  if (!sel.length) {
    const svg = editor.svg;
    const bg = svg && (svg.querySelector('[data-label="background"]') || svg.querySelector("[data-locked='true']"));
    parts.push(section(`Slide ${index() + 1} of ${state.deck.slides.length}`,
      bg ? row("Background", colorControl(getComputedStyle(bg).fill, (c) => editor.setStyle("fill", c, [bg]), false)) : null,
      buttonRow([["Unlock all", "Make locked objects selectable again", () => editor.unlockAll()],
                 clipboardData() ? ["Paste", "Paste copied objects (Ctrl+V)", pasteClipboard] : null].filter(Boolean))));
    parts.push(section("New shapes",
      row("Fill", colorControl(state.prefs.fill, (c) => { state.prefs.fill = c; savePrefs(); renderPanel(); }, true)),
      row("Line", colorControl(state.prefs.stroke, (c) => { state.prefs.stroke = c; savePrefs(); renderPanel(); }, true)),
      row("Width", numberControl(state.prefs.strokeWidth, { min: 0.5, max: 100, step: 0.5 }, (v) => { state.prefs.strokeWidth = v; savePrefs(); }))));
    parts.push(section("New text",
      row("Colour", colorControl(state.prefs.textFill, (c) => { state.prefs.textFill = c; savePrefs(); renderPanel(); }, false)),
      row("Size", numberControl(state.prefs.size, { min: 4, max: 400 }, (v) => { state.prefs.size = v; savePrefs(); }))));
    parts.push(section("Fonts", el("p", { class: "hint" }, `${families().length} families in the library.`),
      buttonRow([["Upload font…", "Add an .otf or .ttf file to the font library", () => $("font-file").click()]])));
    parts.push(el("p", { class: "hint" }, "Double-tap text to edit it, or a group to work inside it. Two fingers pan and zoom."));
    panel.replaceChildren(...parts.filter(Boolean));
    return;
  }

  const first = sel[0];
  const cs = getComputedStyle(lookOf(first));
  const kinds = new Set(sel.map((e) => e.localName));
  const isMovie = sel.length === 1 && first.hasAttribute("data-video");
  const texts = sel.filter((e) => e.localName === "text");
  const lines = sel.filter((e) => ["line", "path", "polyline"].includes(e.localName));
  const label = isMovie ? "Movie" : sel.length > 1 ? `${sel.length} objects` : ({
    text: "Text", rect: "Rectangle", ellipse: "Ellipse", circle: "Circle", line: "Line", path: "Path",
    image: "Image", g: "Group", use: "Clone" }[first.localName] || first.localName);

  if (!kinds.has("image") || kinds.size > 1) {
    parts.push(section(label,
      !texts.length || kinds.size > 1 ? row("Fill", colorControl(cs.fill, (c) => { editor.setStyle("fill", c); if (c !== "none") { state.prefs.fill = c; savePrefs(); } }, true)) : null,
      row(texts.length && kinds.size === 1 ? "Colour" : "Line", texts.length && kinds.size === 1
        ? colorControl(cs.fill, (c) => { editor.setStyle("fill", c); state.prefs.textFill = c; savePrefs(); }, false)
        : colorControl(cs.stroke, (c) => { setStroke(sel, c); if (c !== "none") { state.prefs.stroke = c; savePrefs(); } }, true)),
      !(texts.length && kinds.size === 1) ? row("Width", numberControl(+editor.strokeWidthOf(lookOf(first)).toFixed(2), { min: 0, max: 200, step: 0.5 },
        (v) => { setStrokeWidth(sel, v); state.prefs.strokeWidth = v; savePrefs(); })) : null,
      row("Opacity", numberControl(Math.round((parseFloat(cs.opacity) || 1) * 100), { min: 0, max: 100, step: 5, suffix: "%" },
        (v) => editor.setStyle("opacity", String(Math.max(0, Math.min(100, v)) / 100))))));
  } else {
    parts.push(section(label, row("Opacity", numberControl(Math.round((parseFloat(cs.opacity) || 1) * 100),
      { min: 0, max: 100, step: 5, suffix: "%" }, (v) => editor.setStyle("opacity", String(v / 100))))));
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
    parts.push(section("Text",
      row("Font", famSelect), row("Weight", weightSelect),
      row("Size", numberControl(size, { min: 1, max: 1000, step: 1 }, (v) => {
        editor.change(() => { for (const t of texts) editor.applyStyle(t, "font-size", `${+(v / editor.textScale(t)).toFixed(4)}px`); });
        state.prefs.size = v; savePrefs();
      })),
      row("Align", buttonRow([["Left", "Align lines left", () => editor.setAlign("start", texts), anchor === "start"],
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

  parts.push(section("Arrange",
    buttonRow([["To front", "Bring to front", () => editor.order("front")], ["Forward", "Bring forward", () => editor.order("forward")],
               ["Backward", "Send backward", () => editor.order("backward")], ["To back", "Send to back", () => editor.order("back")]]),
    buttonRow([["Copy", "Ctrl+C — paste on any slide", () => copySelection(false)],
               ["Cut", "Ctrl+X", () => copySelection(true)],
               clipboardData() ? ["Paste", "Ctrl+V", pasteClipboard] : null].filter(Boolean)),
    buttonRow([["Duplicate", "Ctrl+D", () => editor.duplicate()],
               sel.length > 1 ? ["Group", "Ctrl+G", () => editor.group()] : null,
               kinds.has("g") ? ["Ungroup", "Ctrl+Shift+G", () => editor.ungroup()] : null,
               ["Lock", "Make unselectable (e.g. backgrounds)", () => editor.lock()],
               ["Delete", "Delete", () => editor.deleteSelection()]].filter(Boolean))));
  panel.replaceChildren(...parts);
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
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select") || editor.textEdit) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === "z") { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
  if (mod && k === "y") { e.preventDefault(); redo(); return; }
  if (mod && k === "d") { e.preventDefault(); editor.duplicate(); return; }
  if (mod && k === "g") { e.preventDefault(); (e.shiftKey ? editor.ungroup() : editor.group()); return; }
  if (mod && k === "a") { e.preventDefault(); editor.select(editor.children()); return; }
  if (mod && (k === "c" || k === "x")) {
    if (editor.selection.length) { e.preventDefault(); copySelection(k === "x"); }
    return;
  }
  if (mod && k === "v") {
    if (clipboardData()) { e.preventDefault(); pasteClipboard(); }
    return;
  }
  if (mod) return;
  if (k === "delete" || k === "backspace") { e.preventDefault(); editor.deleteSelection(); return; }
  if (k === "escape") { if (!editor.exitGroup()) editor.select([]); setTool("select"); return; }
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
  if (KEYS[k]) setTool(KEYS[k]);
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
  try { return localStorage.getItem("svgdeck-clipboard") || state.clipboard; } catch (err) { return state.clipboard; }
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
function wire() {
  $("undo").onclick = undo;
  $("redo").onclick = redo;
  $("zoom-in").onclick = () => editor.zoomBy(1.25);
  $("zoom-out").onclick = () => editor.zoomBy(0.8);
  $("zoom-fit").onclick = () => editor.fit();
  $("present").onclick = async () => {
    const url = `/d/${DECK}/#${index() + 1}`;
    const win = window.open("about:blank", "_blank");
    await flush();
    if (win) win.location.href = url; else location.href = url;
  };
  $("export").onclick = async (e) => {
    e.preventDefault();
    await flush();
    toast("Preparing the export…");
    location.href = `/api/decks/${DECK}/export.zip`;
  };
  $("toggle-strip").onclick = () => document.body.classList.toggle("no-strip");
  $("toggle-panel").onclick = () => document.body.classList.toggle("no-panel");
  $("slide-add").onclick = () => addSlide(blankSlide());
  $("slide-dup").onclick = () => addSlide(state.slides.get(state.current).text);
  $("slide-up").onclick = () => moveSlide(-1);
  $("slide-down").onclick = () => moveSlide(1);
  $("slide-del").onclick = deleteSlide;
  $("exit-group").onclick = () => editor.exitGroup();
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
    } catch (err) { toast(`Could not add the font: ${err.message}`, 8000); }
  };
  if (innerWidth < 900) document.body.classList.add("no-strip", "no-panel");
}

async function main() {
  wire();
  buildToolbar();
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
  $("export").href = `/api/decks/${DECK}/export.zip`;
  renderStrip();
  const m = /^#(\d+)$/.exec(location.hash);
  const start = state.deck.slides[m ? Math.min(+m[1] - 1, state.deck.slides.length - 1) : 0];
  await openSlide(start.id);
  setStatus("Saved", "ok");
}

main();
window.svgdeckEditor = { editor, state, openSlide, undo, redo, flush };
