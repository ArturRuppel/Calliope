// The slide canvas: shows one slide SVG and edits it in place.
// Pointer events throughout, so mouse, finger and Apple Pencil share one path.
import {
  SVGNS, localMatrix, setTransform, toRoot, rootBox, unionBox, smartSnapDelta, simplify, smoothPath, polylinePath, toHex,
  parsePath, pathFromNodes, inferNodeType, splitSegment, nearestOnSegment, nodeAt, inkOutline, fitStroke,
  snapLines, snapCoordinate, constrainAngle,
} from "./geom.js";

const HANDLE_PX = { mouse: 12, pen: 14, touch: 24 };  // handle hit radius, screen pixels
const ROTATE_OFFSET_PX = 40;   // rotate handle distance above the box
const TAP_PX = { mouse: 5, pen: 8, touch: 14 };      // movement below this is a tap
const DOUBLE_TAP_MS = 350;
const MAX_EDIT_NODES = 600;     // more points than this are not offered for editing
const ALL_HANDLES_UP_TO = 16;   // bigger paths show handles near the chosen point only
const BAKEABLE = new Set(["rect", "image", "ellipse", "circle", "line"]);
const SKIP = new Set(["defs", "title", "desc", "metadata", "style", "script"]);
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const ERASABLE = new Set(["path", "line", "polyline"]);  // strokes, not shapes, text or media
const ERASER_PX = 7;  // eraser reach around the pointer, screen pixels
const PALM_MS = 500;  // touches this soon after the Pencil lifts are the resting hand
const INHERITED_PRESENTATION = new Set([
  "color", "color-interpolation", "color-interpolation-filters", "color-rendering", "cursor", "direction",
  "fill", "fill-opacity", "fill-rule", "font-family", "font-size", "font-size-adjust", "font-stretch",
  "font-style", "font-variant", "font-weight", "image-rendering", "letter-spacing", "marker-end", "marker-mid",
  "marker-start", "paint-order", "pointer-events", "shape-rendering", "stroke", "stroke-dasharray",
  "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "stroke-width",
  "text-anchor", "text-rendering", "visibility", "word-spacing", "writing-mode",
]);
const hasMovie = (el) => el.matches("image[data-video]") || !!el.querySelector("image[data-video]");

const num = (el, name) => parseFloat(el.getAttribute(name)) || 0;
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);
/** A family name as CSS: generic names bare, real ones quoted. */
export const cssFamily = (f) => (GENERIC.has(f) ? f : `'${f.replace(/'/g, "")}'`);

/** The element holding a text's first visible character (where its look is). */
export function firstGlyphElement(t) {
  const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) if (n.data.trim()) return n.parentNode;
  return t;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
// Computed colours containing alpha must not pass through toHex(), which is
// intentionally an opaque palette helper. Browsers already canonicalize them.
const paintColor = (value) => /^(rgba|hsla|color)\(/i.test(value || "") ? value : (toHex(value) || value);

// --- formatted text runs ------------------------------------------------------
const BLOCKS = new Set(["div", "p", "li"]);
// Inherited properties that inner spans often override (Inkscape puts
// stroke:none on the spans of a text that has a stroke). A rewritten text
// takes its first character's values, so it looks the same.
const TEXT_PAINT = ["stroke", "stroke-width", "stroke-opacity", "stroke-linejoin", "stroke-linecap", "stroke-dasharray",
  "fill-opacity", "paint-order", "letter-spacing", "word-spacing", "font-stretch", "font-variant"];

function sameShift(a, b, size) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < size * 0.01;
  return (a || 0) === (b || 0);
}

function decorationOf(el, stop) {
  const values = new Set();
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    for (const value of getComputedStyle(n).textDecorationLine.split(" ")) if (value !== "none") values.add(value);
    if (n === stop) break;
  }
  return [...values].sort().join(" ") || "none";
}

function sameLook(a, b) {
  return (a.decoration || "none") === (b.decoration || "none") && a.family === b.family && a.weight === b.weight && a.fontStyle === b.fontStyle &&
    paintColor(a.fill) === paintColor(b.fill) && Math.abs(a.size / b.size - 1) < 0.01 &&
    sameShift(a.shift, b.shift, b.size);
}

/** Sub/superscript of an element inside a text: "sub", "super", a raise in
 *  the text's units, or 0. Nested spans inherit their parent's shift. */
function shiftOf(el, stop, scale = 1) {
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    const cs = getComputedStyle(n);
    const v = n.namespaceURI === SVGNS ? cs.baselineShift : cs.verticalAlign;
    if (v === "sub" || v === "super") return v;
    if (v && v !== "baseline" && v !== "0px") {
      const px = v.endsWith("%") ? parseFloat(v) / 100 * parseFloat(cs.fontSize) : parseFloat(v);
      if (px) return px / scale;
    }
    if (n === stop) break;
  }
  return 0;
}

function pushRun(runs, text, look) {
  const last = runs[runs.length - 1];
  if (last && sameLook(last.look, look)) last.text += text;
  else runs.push({ text, look });
}

function sameRuns(a, b) {
  return a.length === b.length && a.every((line, i) => line.length === b[i].length &&
    line.every((r, j) => r.text === b[i][j].text && sameLook(r.look, b[i][j].look)));
}

/** How a run's look differs from the text's, as SVG style properties. */
function lookDiff(look, base) {
  const diff = [];
  if ((look.decoration || "none") !== (base.decoration || "none")) diff.push(["text-decoration-line", look.decoration || "none"]);
  if (look.family !== base.family) diff.push(["font-family", look.family]);
  if (look.weight !== base.weight) diff.push(["font-weight", look.weight]);
  if (look.fontStyle !== base.fontStyle) diff.push(["font-style", look.fontStyle]);
  if (paintColor(look.fill) !== paintColor(base.fill)) diff.push(["fill", paintColor(look.fill)]);
  if (Math.abs(look.size / base.size - 1) >= 0.01) diff.push(["font-size", `${+look.size.toFixed(4)}px`]);
  if (!sameShift(look.shift, base.shift, base.size)) {
    diff.push(["baseline-shift", typeof look.shift === "number" ? `${+look.shift.toFixed(4)}px` : look.shift || "baseline"]);
  }
  return diff;
}

/** A run in the edit box: plain text in the text's own look, a span otherwise. */
function htmlRun(run, base) {
  const diff = lookDiff(run.look, {...base, decoration:"none"});
  if (!diff.length) return document.createTextNode(run.text);
  const span = document.createElement("span");
  for (const [prop, v] of diff) {
    if (prop === "fill") span.style.color = v;
    else if (prop === "font-size") span.style.fontSize = `${run.look.size / base.size}em`;
    else if (prop === "baseline-shift") {
      const s = run.look.shift;
      span.style.verticalAlign = typeof s === "number" ? `${s / run.look.size}em` : s || "baseline";
    }
    else span.style.setProperty(prop, v);
  }
  span.textContent = run.text;
  return span;
}

export class SlideEditor {
  /** hooks: commit(before, after), select(selection), toast(msg),
   *  hrefIn(v), hrefOut(v), shapeStyle(), textStyle(), ensureFont(family),
   *  zoomChanged(zoom) */
  constructor(host, hooks) {
    this.host = host;
    this.hooks = hooks;
    this.page = document.createElement("div");
    this.page.className = "page";
    this.overlay = document.createElementNS(SVGNS, "svg");
    this.overlay.setAttribute("class", "overlay");
    this.page.appendChild(this.overlay);
    host.appendChild(this.page);

    this.svg = null;
    this.size = [1920, 1080];
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.fitMode = true;
    // Two tool slots: the Apple Pencil has its own, fingers and the mouse
    // share the other. `input` is the slot of the latest pointer, and
    // `tool` is that slot's tool.
    this.tools = { touch: "select", pen: "pen" };
    this.input = "touch";
    this.penSeen = false;
    this.selection = [];
    this.context = null;
    this.gesture = null;
    this.pointers = new Map();
    this.touchStart = null;
    this.palms = new Set();  // touches rejected as the hand holding the Pencil
    this.penUpAt = -Infinity;
    this.lastTap = null;
    this.textEdit = null;
    this.tx = null;      // the open undo step, { before }, or null
    this.txDepth = 0;    // change() calls in progress; the outermost commits
    this.grid = { show: false, snap: false, size: 20 };  // slide pixels
    this.smartSnap = true;
    this.smartGuides = [];
    this.additive = false;  // taps add to the selection (touch has no Shift)

    host.addEventListener("pointerdown", (e) => this.onDown(e));
    host.addEventListener("pointermove", (e) => this.onMove(e));
    host.addEventListener("pointerup", (e) => this.onUp(e));
    host.addEventListener("pointercancel", (e) => this.onCancel(e));
    host.addEventListener("lostpointercapture", (e) => {
      if (this.pointers.has(e.pointerId) && !host.hasPointerCapture(e.pointerId)) this.onCancel(e);
    });
    // Native menus can retarget a release away from the captured stage.
    for (const type of ["pointerup", "pointercancel"]) {
      window.addEventListener(type, e => {
        if (!host.contains(e.target) && (this.pointers.has(e.pointerId) || this.palms.has(e.pointerId))) {
          if (type === "pointerup") this.onUp(e); else this.onCancel(e);
        }
      }, true);
    }
    window.addEventListener("blur", () => this.resetPointers());
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.resetPointers(); });
    host.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    host.addEventListener("contextmenu", (e) => {
      if (e.target.closest?.(".text-edit")) return;
      e.preventDefault();
      this.cancelGesture();
      this.openContextMenu(e.clientX, e.clientY);
    });
    // Remember the selected words while the panel is used to format them.
    document.addEventListener("selectionchange", () => {
      const te = this.textEdit, sel = getSelection();
      if (te && sel.rangeCount && te.box.contains(sel.anchorNode)) te.range = sel.getRangeAt(0).cloneRange();
    });
    new ResizeObserver(() => { if (this.fitMode) this.fit(); else this.layout(); }).observe(host);
  }

  get tool() { return this.tools[this.input]; }
  set tool(name) { this.tools[this.input] = name; }

  slotFor(pointerType) { return pointerType === "pen" && this.penSeen ? "pen" : "touch"; }

  /** Whether either input has this tool (the pen only once one was used). */
  usesTool(name) {
    return this.tools.touch === name || (this.penSeen && this.tools.pen === name);
  }

  /** Make a slot current: its tool now decides what the overlay offers. */
  setInput(slot) {
    if (slot === this.input) return;
    this.input = slot;
    this.host.dataset.tool = this.tool;
    this.drawOverlay();
    this.hooks.inputChanged?.(slot);
  }

  // --- loading and saving --------------------------------------------------
  load(text, { keepView = false } = {}) {
    clearTimeout(this.nudgeTimer); this.nudging = null;
    // A loaded document must never inherit a transaction or captured pointer
    // from the document it replaces. Callers that want to keep a draft must
    // finish it before loading.
    this.cancelGesture();
    this.pointers.clear();
    this.palms.clear();
    this.touchStart = null;
    this.abort();
    this.pathDraft = null;
    this.endTextEdit(false);
    // Nor any half-finished tap, chosen point or guide.
    this.clearLongPress();
    this.nodeSel = null;
    this.lastTap = null;
    this.lastSegmentTap = null;
    this.smartGuides = [];
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    if (doc.querySelector("parsererror") || doc.documentElement.localName !== "svg") {
      throw new Error("this slide is not valid SVG");
    }
    // Rewrite media paths before the slide enters the page, or WebKit starts
    // fetching them relative to the editor's URL.
    const parsed = doc.documentElement;
    for (const el of parsed.querySelectorAll("[href], [data-video]")) this.rewriteRefs(el, this.hooks.hrefIn);
    for (const el of parsed.querySelectorAll("*")) {
      const legacy = el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      if (legacy && !el.hasAttribute("href")) {
        el.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
        el.setAttribute("href", this.hooks.hrefIn(legacy));
      }
    }
    const svg = document.importNode(parsed, true);
    const vb = (svg.getAttribute("viewBox") || "0 0 1920 1080").split(/[\s,]+/).map(Number);
    this.size = [vb[2], vb[3]];
    this.overlay.setAttribute("viewBox", `${vb[0]} ${vb[1]} ${vb[2]} ${vb[3]}`);
    if (this.svg) this.svg.remove();
    this.svg = svg;
    this.page.insertBefore(svg, this.overlay);
    this.mediaTools?.onLoad?.();
    this.context = svg;
    this.selection = [];
    if (keepView && !this.fitMode) this.layout(); else this.fit();
    this.hooks.select(this.selection);
  }

  rewriteRefs(el, fn) {
    for (const name of ["href", "data-video"]) {
      const v = el.getAttribute(name);
      if (v) el.setAttribute(name, fn(v));
    }
  }

  /** A copy in a document without a window: nothing in it loads. (A copy
   *  in the page would fetch ../media/... relative to the editor's URL.) */
  inertClone(node) {
    this.inert ||= document.implementation.createDocument(SVGNS, "svg", null);
    return this.inert.importNode(node, true);
  }

  serialize() {
    const clone = this.inertClone(this.svg);
    for (const el of clone.querySelectorAll("[href], [data-video]")) this.rewriteRefs(el, this.hooks.hrefOut);
    for (const el of clone.querySelectorAll("[data-editing]")) {
      el.removeAttribute("data-editing");
      el.style.removeProperty("visibility");
      if (!el.getAttribute("style")) el.removeAttribute("style");
    }
    return '<?xml version="1.0" encoding="utf-8"?>\n' + new XMLSerializer().serializeToString(clone) + "\n";
  }

  /** The slide as it was when the open undo step began, or null. Setting it
   *  to null discards the open step, like abort(). */
  get before() { return this.tx ? this.tx.before : null; }
  set before(v) { if (v === null) this.abort(); else this.tx = { before: v }; }

  /** Open an undo step unless one is open. Returns the step if this call
   *  opened it (whoever opened it may abort it), null if it joined one. */
  begin() {
    if (this.tx) return null;
    this.tx = { before: this.serialize() };
    return this.tx;
  }

  commit() {
    if (!this.tx || this.txDepth > 0) return;  // inside change(): the outermost one commits
    const { before } = this.tx;
    this.tx = null;
    let after = this.serialize();
    if (after !== before && this.collectDefs()) after = this.serialize();
    if (after !== before) this.hooks.commit(before, after);
    this.drawOverlay();
    this.hooks.select(this.selection);
  }

  /** Close the open undo step without recording it; the slide stays as it is. */
  abort() {
    this.tx = null;
  }

  /** Run a change as one undoable step. Changes inside it join that step. */
  change(fn) {
    this.begin();
    this.txDepth++;
    try { fn(); } finally { this.txDepth--; this.commit(); }
  }

  /** Remove the clip paths and image filters the editor made that nothing
   *  refers to any more (their image was deleted or cut). Returns whether
   *  any were removed. Definitions from elsewhere are never touched. */
  collectDefs() {
    const owned = Array.from(this.svg.querySelectorAll('clipPath[id^="svgdeck-clip-"], filter[id^="svgdeck-image-filter-"]'))
      .filter((d) => d.localName === "clipPath" || d.hasAttribute("data-image-adjustment-filter") || d.hasAttribute("data-image-adjustment-version"));
    if (!owned.length) return false;
    const used = new Set();
    for (const el of this.svg.querySelectorAll("*")) {
      if (owned.some((d) => d.contains(el))) continue;
      for (const attr of Array.from(el.attributes)) {
        const v = attr.value;
        if (attr.localName === "href" && v.startsWith("#")) used.add(v.slice(1));
        else if (attr.localName === "data-svgdeck-clip" || attr.localName === "data-svgdeck-image-filter") used.add(v.trim());
        if (v.includes("url(")) for (const m of v.matchAll(/url\(\s*['"]?#([^'")\s]+)/g)) used.add(m[1]);
      }
    }
    const unused = owned.filter((d) => !used.has(d.id));
    for (const d of unused) d.remove();
    return unused.length > 0;
  }

  // --- view ----------------------------------------------------------------
  fit() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.zoom = Math.min(w / this.size[0], h / this.size[1]) * 0.96;
    this.pan = { x: (w - this.size[0] * this.zoom) / 2, y: (h - this.size[1] * this.zoom) / 2 };
    this.fitMode = true;
    this.layout();
  }

  zoomAt(clientX, clientY, factor) {
    const r = this.host.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    const zoom = Math.max(0.05, Math.min(8, this.zoom * factor));
    factor = zoom / this.zoom;
    this.pan = { x: x - (x - this.pan.x) * factor, y: y - (y - this.pan.y) * factor };
    this.zoom = zoom;
    this.fitMode = false;
    this.layout();
  }

  zoomBy(factor) {
    const r = this.host.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }

  layout() {
    Object.assign(this.page.style, {
      left: `${this.pan.x}px`, top: `${this.pan.y}px`,
      width: `${this.size[0] * this.zoom}px`, height: `${this.size[1] * this.zoom}px`,
    });
    this.drawOverlay();
    this.positionTextEdit();
    this.hooks.zoomChanged?.(this.zoom);
  }

  /** Slide coordinates of a pointer event. */
  point(e) {
    const r = this.page.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.zoom, y: (e.clientY - r.top) / this.zoom };
  }

  // --- grid -------------------------------------------------------------------
  snapTo(v) {
    const s = this.grid.size;
    return this.grid.snap && s > 0 ? Math.round(v / s) * s : v;
  }

  snapPoint(p) {
    return { x: this.snapTo(p.x), y: this.snapTo(p.y) };
  }

  /** A move by (dx, dy) adjusted so the nearer edge of the box lands on the grid. */
  snapDelta(box, dx, dy) {
    if (!this.grid.snap || !box) return [dx, dy];
    const fix = (lo, hi, d) => {
      const opts = [lo + d, hi + d].map((v) => this.snapTo(v) - v);
      return d + (Math.abs(opts[0]) <= Math.abs(opts[1]) ? opts[0] : opts[1]);
    };
    return [fix(box.x, box.x + box.width, dx), fix(box.y, box.y + box.height, dy)];
  }

  /** Fade whatever lies outside the slide (it is drawn, but not presented),
   *  and outline the slide edge. */
  drawOffPage(o) {
    const [W, H] = this.size, big = 20 * Math.max(W, H);
    const mask = document.createElementNS(SVGNS, "path");
    mask.setAttribute("d", `M${-big},${-big}H${W + big}V${H + big}H${-big}Z M0,0V${H}H${W}V0Z`);
    mask.setAttribute("class", "ov-offpage");
    const edge = document.createElementNS(SVGNS, "rect");
    for (const [k, v] of Object.entries({ x: 0, y: 0, width: W, height: H, class: "ov-edge", "stroke-width": 1 / this.zoom })) edge.setAttribute(k, v);
    o.append(mask, edge);
  }

  drawGrid(o) {
    const [W, H] = this.size;
    let step = this.grid.size;
    if (!(step > 0)) return;
    while (step * this.zoom < 8) step *= 2;  // never denser than 8 screen px
    const pattern = document.createElementNS(SVGNS, "pattern");
    for (const [k, v] of Object.entries({ id: "ov-grid", width: step, height: step, patternUnits: "userSpaceOnUse" })) pattern.setAttribute(k, v);
    const path = document.createElementNS(SVGNS, "path");
    path.setAttribute("d", `M${step} 0H0V${step}`);
    path.setAttribute("class", "ov-gridline");
    path.setAttribute("stroke-width", 1 / this.zoom);
    pattern.appendChild(path);
    const defs = document.createElementNS(SVGNS, "defs");
    defs.appendChild(pattern);
    const rect = document.createElementNS(SVGNS, "rect");
    for (const [k, v] of Object.entries({ x: 0, y: 0, width: W, height: H, fill: "url(#ov-grid)" })) rect.setAttribute(k, v);
    o.append(defs, rect);
  }

  // --- selection -------------------------------------------------------------
  selectable(el) {
    if (!el || el.nodeType !== 1 || SKIP.has(el.localName)) return false;
    for (let node = el; node && node !== this.svg; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.getAttribute?.("data-locked") === "true" || style.display === "none" ||
          style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return true;
  }

  children() {
    return Array.from(this.context.children).filter((el) => this.selectable(el));
  }

  select(elements) {
    if (this.mediaTools?.active?.() && (elements.length !== 1 || elements[0] !== this.selection[0])) this.mediaTools.cancel();
    this.selection = elements.filter(Boolean);
    this.drawOverlay();
    this.hooks.select(this.selection);
  }

  /** The object under the pointer, at the level of the current group. */
  pick(e, p) {
    let el = e.target;
    if (!this.svg.contains(el) || el === this.svg) el = null;
    while (el && el.parentNode !== this.context) el = el.parentNode;
    if (el && el.parentNode === this.context && this.selectable(el)) return el;
    // Thin lines and small things: fall back to boxes, topmost first.
    const pad = 10 / this.zoom;
    for (const child of this.children().reverse()) {
      const b = rootBox(child, this.svg);
      if (b && p.x >= b.x - pad && p.x <= b.x + b.width + pad && p.y >= b.y - pad && p.y <= b.y + b.height + pad) {
        if (b.width * b.height > this.size[0] * this.size[1] * 0.9) continue;  // full-slide backdrops
        return child;
      }
    }
    return null;
  }

  enterGroup(group) {
    this.context = group;
    this.select([]);
  }

  exitGroup() {
    if (this.context === this.svg) return false;
    const group = this.context;
    const parent = group.parentNode;
    this.context = parent && parent !== this.svg && this.svg.contains(parent) ? parent : this.svg;
    this.select([group]);
    return true;
  }

  selectionBox() {
    return unionBox(this.selection.map((el) => rootBox(el, this.svg)));
  }

  /** A single object turned by other than quarter turns is resized in its
   *  own frame, so it stays a rectangle: {angle, box in the frame, toSlide,
   *  toFrame}. Null when the selection is resized along the slide's axes. */
  selectionFrame() {
    if (this.selection.length !== 1 || this.lineMode()) return null;
    const m = toRoot(this.selection[0], this.svg);
    let angle = Math.atan2(m.b, m.a) * 180 / Math.PI;
    angle -= Math.round(angle / 90) * 90;  // the handle names stay nearest to the screen's
    if (Math.abs(angle) < 1e-3) return null;
    const toSlide = new DOMMatrix().rotateSelf(angle), toFrame = toSlide.inverse();
    const box = rootBox(this.selection[0], this.svg, toFrame);
    return box && { angle, box, toSlide, toFrame };
  }

  /** A single straight line is edited by its two ends, not a box. */
  lineMode() {
    return this.selection.length === 1 && this.selection[0].localName === "line" ? this.selection[0] : null;
  }

  lineEnds(line) {
    const m = toRoot(line, this.svg);
    return [m.transformPoint(new DOMPoint(num(line, "x1"), num(line, "y1"))),
            m.transformPoint(new DOMPoint(num(line, "x2"), num(line, "y2")))];
  }

  handlePositions(box) {
    const { x, y, width: w, height: h } = box;
    return {
      nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + h / 2],
      se: [x + w, y + h], s: [x + w / 2, y + h], sw: [x, y + h], w: [x, y + h / 2],
      rotate: [x + w / 2, y - ROTATE_OFFSET_PX / this.zoom],
    };
  }

  hitHandle(p, pointerType = "mouse") {
    if (!this.selection.length || this.tool !== "select" || this.showingNodes()) return null;
    const radius = HANDLE_PX[pointerType] || HANDLE_PX.mouse;
    const line = this.lineMode();
    if (line) {
      const ends = this.lineEnds(line);
      const d = ends.map((q) => Math.hypot(p.x - q.x, p.y - q.y));
      const i = d[0] <= d[1] ? 0 : 1;
      return d[i] <= radius / this.zoom ? (i ? "end2" : "end1") : null;
    }
    const frame = this.selectionFrame();
    const box = frame ? frame.box : this.selectionBox();
    if (!box) return null;
    if (frame) p = frame.toFrame.transformPoint(new DOMPoint(p.x, p.y));
    // Inside the object, handles only win right at their centre, so small
    // objects can still be dragged and double-tapped.
    const inside = p.x > box.x && p.x < box.x + box.width && p.y > box.y && p.y < box.y + box.height;
    const r = (inside ? 7 : radius) / this.zoom;
    const positions = this.handlePositions(box);
    let best = null, bestDist = Infinity;
    for (const name of ["rotate", ...HANDLES]) {
      const [hx, hy] = positions[name];
      const d = Math.hypot(p.x - hx, p.y - hy);
      if (d <= r && d < bestDist) { best = name; bestDist = d; }
    }
    return best;
  }

  drawOverlay() {
    const o = this.overlay;
    o.replaceChildren();
    if (!this.svg) return;
    this.drawOffPage(o);
    if (this.grid.show) this.drawGrid(o);
    const px = 1 / this.zoom;
    const make = (tag, attrs) => {
      const el = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      o.appendChild(el);
      return el;
    };
    if (this.mediaTools?.drawOverlay?.(o, make, px)) return;
    for (const guide of this.smartGuides) {
      if (guide.kind === "align") {
        const attrs = guide.axis === "x"
          ? { x1: guide.at, y1: guide.from, x2: guide.at, y2: guide.to }
          : { x1: guide.from, y1: guide.at, x2: guide.to, y2: guide.at };
        make("line", { ...attrs, class: "ov-smart-guide", stroke: "#d61aff", "stroke-dasharray": `${5 * px} ${4 * px}`, "pointer-events": "none", "stroke-width": 1.5 * px });
      } else {
        const box = this.gesture?.box0 || { x: 0, y: 0, width: 0, height: 0 }, cross = 7 * px;
        for (const at of guide.marks) {
          if (guide.axis === "x") make("line", { x1: at, y1: box.y - cross, x2: at, y2: box.y + box.height + cross, class: "ov-smart-guide", stroke: "#d61aff", "pointer-events": "none", "stroke-width": px });
          else make("line", { x1: box.x - cross, y1: at, x2: box.x + box.width + cross, y2: at, class: "ov-smart-guide", stroke: "#d61aff", "pointer-events": "none", "stroke-width": px });
        }
      }
    }
    if (this.pathDraft) {
      const draft = this.pathDraft;
      const nodes = [...draft.nodes];
      const g = this.gesture?.kind === "path-node" ? this.gesture : null;
      if (g?.freehand) make("polyline", {points:g.trail.map((q) => `${q.x},${q.y}`).join(" "), class:"ov-box", "stroke-width":2*px});
      else if (g) nodes.push(g.node);
      else if (draft.hover) nodes.push(this.pathNode(draft.hover));
      if (nodes.length > 1) make("path", {d:this.pathData(nodes), class:"ov-box", "stroke-width":2*px});
      for (const [i,n] of nodes.entries()) {
        make("rect", {x:n.x-5*px,y:n.y-5*px,width:10*px,height:10*px,class:"ov-handle", "stroke-width":2*px});
        if (n.out.x !== n.x || n.out.y !== n.y) {
          make("line", {x1:n.in.x,y1:n.in.y,x2:n.out.x,y2:n.out.y,class:"ov-box","stroke-width":px});
          for (const h of [n.in,n.out]) make("circle",{cx:h.x,cy:h.y,r:4*px,class:"ov-handle","stroke-width":px});
        }
      }
      return;
    }
    if (this.context !== this.svg) {
      const b = rootBox(this.context, this.svg);
      if (b) make("rect", { x: b.x, y: b.y, width: b.width, height: b.height, class: "ov-group", "stroke-width": px });
    }
    if (this.gesture?.kind === "marquee") {
      const g = this.gesture;
      make("rect", { x: Math.min(g.start.x, g.now.x), y: Math.min(g.start.y, g.now.y),
        width: Math.abs(g.now.x - g.start.x), height: Math.abs(g.now.y - g.start.y), class: "ov-marquee", "stroke-width": px });
    }
    if (this.showingNodes()) {
      const el = this.selection[0], model = this.nodeModel(el);
      const { targets, map } = this.nodeTargets(el, model);
      const ns = this.nodeSel?.el === el ? this.nodeSel : null;
      for (const t of targets) if (t.part !== "node") {
        make("line", { x1: t.anchor.x, y1: t.anchor.y, x2: t.p.x, y2: t.p.y, class: "ov-box", "stroke-width": px });
      }
      for (const t of targets) {
        if (t.part !== "node") {
          make("circle", { cx: t.p.x, cy: t.p.y, r: 6 * px, class: "ov-handle", "data-node": `${t.sub}:${t.i}:${t.part}`, "stroke-width": 2 * px });
          continue;
        }
        const chosen = ns && ns.sub === t.sub && ns.i === t.i;
        const r = (chosen ? 9 : 7) * px, type = t.node.type;
        const attrs = { class: "ov-handle" + (chosen ? " ov-chosen" : ""), "data-node": `${t.sub}:${t.i}`, "stroke-width": 2 * px };
        // Shapes tell the point types apart: square corner, circle symmetric, diamond smooth.
        if (model.kind === "path" && type === "z") make("circle", { cx: t.p.x, cy: t.p.y, r, ...attrs });
        else if (model.kind === "path" && type === "s") {
          make("path", { d: `M${t.p.x},${t.p.y - r * 1.3}L${t.p.x + r * 1.3},${t.p.y}L${t.p.x},${t.p.y + r * 1.3}L${t.p.x - r * 1.3},${t.p.y}Z`, ...attrs });
        } else make("rect", { x: t.p.x - r, y: t.p.y - r, width: 2 * r, height: 2 * r, rx: 1.5 * px, ...attrs });
      }
      return;
    }
    if (!this.selection.length) return;
    for (const el of this.selection.length > 1 ? this.selection : []) {
      const b = rootBox(el, this.svg);
      if (b) make("rect", { x: b.x, y: b.y, width: b.width, height: b.height, class: "ov-item", "stroke-width": px });
    }
    const line = this.lineMode();
    if (line && !this.textEdit) {
      for (const q of this.lineEnds(line)) {
        make("circle", { cx: q.x, cy: q.y, r: 11 * px, class: "ov-end", "stroke-width": 2 * px });
      }
      return;
    }
    const frame = this.textEdit ? null : this.selectionFrame();
    const box = frame ? frame.box : this.selectionBox();
    if (!box || this.textEdit) return;
    // A turned object's box and handles are drawn in its own frame.
    const turn = frame ? { transform: `rotate(${frame.angle})` } : {};
    make("rect", { x: box.x, y: box.y, width: box.width, height: box.height, class: "ov-box", "stroke-width": px, ...turn });
    if (!this.usesTool("select")) return;
    const pos = this.handlePositions(box);
    make("line", { x1: pos.n[0], y1: pos.n[1], x2: pos.rotate[0], y2: pos.rotate[1], class: "ov-box", "stroke-width": px, ...turn });
    make("circle", { cx: pos.rotate[0], cy: pos.rotate[1], r: 8 * px, class: "ov-handle", "stroke-width": 1.5 * px, ...turn });
    for (const name of HANDLES) {
      const [hx, hy] = pos[name];
      make("rect", { x: hx - 7 * px, y: hy - 7 * px, width: 14 * px, height: 14 * px, rx: 3 * px,
        class: "ov-handle", "stroke-width": 1.5 * px, ...turn });
    }
  }

  /** Node handles replace the box when either input edits points. */
  showingNodes() {
    return this.usesTool("nodes") && this.selection.length === 1 && !!this.editableNodes(this.selection[0]);
  }

  // --- transforms ---------------------------------------------------------------
  snapshot() {
    return this.selection.map((el) => {
      const geometry = {};
      for (const a of ["x", "y", "width", "height", "cx", "cy", "rx", "ry", "r", "x1", "y1", "x2", "y2"]) {
        if (el.hasAttribute(a)) geometry[a] = el.getAttribute(a);
      }
      return { el, T0: localMatrix(el), P: toRoot(el.parentNode, this.svg), geometry };
    });
  }

  /** Apply D (a matrix in slide coordinates) on top of the snapshot state. */
  applyDelta(snaps, D) {
    for (const s of snaps) {
      const L = s.P.inverse().multiply(D).multiply(s.P);
      const M = L.multiply(s.T0);
      for (const [a, v] of Object.entries(s.geometry)) s.el.setAttribute(a, v);
      const translateOnly = near(s.T0.a, 1) && near(s.T0.d, 1) && near(s.T0.b, 0) && near(s.T0.c, 0);
      // An image's mirror cannot be written into its geometry: it stays a transform.
      const mirrored = s.el.localName === "image" && (M.a < 0 || M.d < 0);
      if (BAKEABLE.has(s.el.localName) && translateOnly && !mirrored && near(M.b, 0) && near(M.c, 0) && this.bake(s.el, M)) {
        s.el.removeAttribute("transform");
      } else {
        setTransform(s.el, M);
      }
    }
  }

  /** Write an axis-aligned M into the element's geometry, so strokes keep their width. */
  bake(el, M) {
    const r = (v) => String(+v.toFixed(3));
    const X = (x) => M.a * x + M.e, Y = (y) => M.d * y + M.f;
    switch (el.localName) {
      case "rect": case "image": {
        let x = X(num(el, "x")), y = Y(num(el, "y"));
        let w = M.a * num(el, "width"), h = M.d * num(el, "height");
        if (w < 0) { x += w; w = -w; }
        if (h < 0) { y += h; h = -h; }
        el.setAttribute("x", r(x)); el.setAttribute("y", r(y));
        el.setAttribute("width", r(w)); el.setAttribute("height", r(h));
        return true;
      }
      case "ellipse":
        el.setAttribute("cx", r(X(num(el, "cx")))); el.setAttribute("cy", r(Y(num(el, "cy"))));
        el.setAttribute("rx", r(Math.abs(M.a) * num(el, "rx"))); el.setAttribute("ry", r(Math.abs(M.d) * num(el, "ry")));
        return true;
      case "circle":
        if (!near(Math.abs(M.a), Math.abs(M.d), 1e-4)) return false;
        el.setAttribute("cx", r(X(num(el, "cx")))); el.setAttribute("cy", r(Y(num(el, "cy"))));
        el.setAttribute("r", r(Math.abs(M.a) * num(el, "r")));
        return true;
      case "line":
        el.setAttribute("x1", r(X(num(el, "x1")))); el.setAttribute("y1", r(Y(num(el, "y1"))));
        el.setAttribute("x2", r(X(num(el, "x2")))); el.setAttribute("y2", r(Y(num(el, "y2"))));
        return true;
    }
    return false;
  }

  moveBy(dx, dy) {
    if (!this.selection.length) return;
    this.change(() => this.applyDelta(this.snapshot(), new DOMMatrix().translateSelf(dx, dy)));
  }

  /** The selection's bounding box in slide units, {x, y, width, height}, or null. */
  selectionGeometry() {
    return this.selectionBox();
  }

  /** Move and scale the selection as one piece so that its bounding box
   *  becomes the given one; fields left out keep their value. One undo step. */
  setSelectionGeometry({ x, y, width, height } = {}) {
    const box = this.selectionBox();
    if (!box) return;
    const nx = Number.isFinite(x) ? x : box.x, ny = Number.isFinite(y) ? y : box.y;
    const nw = Math.max(Number.isFinite(width) ? width : box.width, 0.01);
    const nh = Math.max(Number.isFinite(height) ? height : box.height, 0.01);
    const sx = box.width > 1e-9 ? nw / box.width : 1, sy = box.height > 1e-9 ? nh / box.height : 1;
    const D = new DOMMatrix().translateSelf(nx, ny).scaleSelf(sx, sy).translateSelf(-box.x, -box.y);
    this.change(() => this.applyDelta(this.snapshot(), D));
  }

  /** Move the selection by a key press. Presses within half a second of each
   *  other join one undo step; a pointer gesture or a load ends it at once. */
  nudge(dx, dy) {
    if (!this.selection.length || this.textEdit) return;
    clearTimeout(this.nudgeTimer);
    if (!this.nudging) this.nudging = { tx: this.begin(), snaps: this.snapshot(), dx: 0, dy: 0 };
    const n = this.nudging;
    n.dx += dx; n.dy += dy;
    this.applyDelta(n.snaps, new DOMMatrix().translateSelf(n.dx, n.dy));
    this.drawOverlay();
    this.nudgeTimer = setTimeout(() => this.endNudge(), 500);
  }

  /** Close the undo step a run of nudges opened, if one is open. */
  endNudge() {
    clearTimeout(this.nudgeTimer);
    if (!this.nudging) return;
    this.nudging = null;
    this.commit();
  }

  /** A rect's corner radius in its own units (0 when square). */
  radiusOf(el) {
    return el?.localName === "rect" ? +(el.getAttribute("rx") || el.getAttribute("ry") || 0) : 0;
  }

  /** Round the corners of the selected rects; 0 makes them square again. */
  setRadius(r, elements = this.selection.filter((el) => el.localName === "rect")) {
    const v = Math.max(0, +r || 0);
    this.change(() => {
      for (const el of elements) {
        if (v) { el.setAttribute("rx", String(v)); el.setAttribute("ry", String(v)); }
        else { el.removeAttribute("rx"); el.removeAttribute("ry"); }
      }
    });
  }

  /** The slide's own box: its edges and centre lines are snap targets. */
  slideBox() {
    return { x: 0, y: 0, width: this.size[0], height: this.size[1] };
  }

  /** Boxes of the objects beside the selection that guides can snap to
   *  (full-slide backdrops are left out: the slide itself stands for them). */
  siblingBoxes(exclude = new Set(this.selection)) {
    const area = this.size[0] * this.size[1];
    return this.children().filter((el) => !exclude.has(el))
      .map((el) => rootBox(el, this.svg)).filter((b) => b && b.width * b.height < area * .9);
  }

  /** Lines a dragged edge or point snaps to: siblings' and the slide's edges
   *  and centres, per axis. */
  snapTargets(exclude) {
    return snapLines([...this.siblingBoxes(exclude), this.slideBox()]);
  }

  /** Smart guides apply: they are on, the grid does not snap, Alt is up. */
  smartSnapping(alt = false) {
    return this.smartSnap && !this.grid.snap && !alt;
  }

  /** Snap a point's x and/or y to the targets; returns the point and guides. */
  smartPoint(p, targets, axes = ["x", "y"]) {
    const q = { x: p.x, y: p.y }, guides = [], tol = 8 / this.zoom;
    for (const axis of axes) {
      const hit = snapCoordinate(p[axis], targets[axis], tol);
      if (!hit) continue;
      q[axis] = hit.at;
      guides.push({ kind: "align", axis, at: hit.at, lo: hit.lo, hi: hit.hi });
    }
    return { p: q, guides };
  }

  /** Guides for snapped points, spanning the target and the given box. */
  pointGuides(guides, box) {
    return guides.map((g) => {
      const [lo, hi] = g.axis === "x" ? [box.y, box.y + box.height] : [box.x, box.x + box.width];
      return { kind: "align", axis: g.axis, at: g.at, from: Math.min(g.lo, lo), to: Math.max(g.hi, hi) };
    });
  }

  smartMove(box, dx, dy) {
    if (!this.smartSnap || this.grid.snap || !box) return { dx, dy, guides: [] };
    return smartSnapDelta(box, dx, dy, this.siblingBoxes(), 8 / this.zoom, [this.slideBox()]);
  }

  // --- pointer handling ---------------------------------------------------------
  openContextMenu(x, y, preserveSelection = false) {
    if (this.pathDraft) { this.finishPath(); return; }
    if (!this.svg) return;
    this.resetPointers();
    this.endTextEdit(true);
    this.lastTap = null;
    if (!preserveSelection || !this.selection.length) {
      const event = { clientX: x, clientY: y, target: document.elementFromPoint(x, y) };
      const item = this.pick(event, this.point(event));
      if (item && !this.selection.includes(item)) this.select([item]);
    }
    this.hooks.contextMenu?.(x, y);
  }

  resetPointers() {
    this.cancelGesture();
    const ids = [...this.pointers.keys()];
    this.pointers.clear();
    this.palms.clear();
    this.touchStart = null;
    // Clear bookkeeping before release: lostpointercapture can fire here.
    for (const id of ids) {
      if (this.host.hasPointerCapture(id)) this.host.releasePointerCapture(id);
    }
    document.body.classList.remove("gesturing");
  }

  clearLongPress() {
    clearTimeout(this.longPressTimer);
    this.longPressTimer = null;
  }

  startLongPress(e) {
    this.longPressTimer = setTimeout(() => {
      const pointer = this.pointers.get(e.pointerId);
      if (!pointer || this.pointers.size !== 1 || this.gesture?.moved || this.pathDraft) return;
      this.cancelGesture();
      if (this.touchStart) {
        this.context = this.touchStart.context;
        this.select(this.touchStart.selection.filter(item => this.svg.contains(item)));
      }
      this.touchStart = null;
      this.openContextMenu(pointer.startX, pointer.startY);
    }, 550);
  }

  onDown(e) {
    this.endNudge();
    this.clearLongPress();
    if (e.target.closest && e.target.closest(".text-edit")) return;
    if (!this.svg) return;
    if (e.pointerType === "mouse" && e.button === 2) return;
    // Once a Pencil is in use, touches while it is down or just lifted are
    // the palm; a Pencil landing takes over from touches that came first.
    if (e.pointerType === "touch" && this.penSeen && (this.penDown() || performance.now() - this.penUpAt < PALM_MS)) {
      this.palms.add(e.pointerId);
      e.preventDefault();
      return;
    }
    // A new primary touch starts a new physical touch sequence. Any old
    // touch entries survived a missing release from a native iPad prompt.
    if (e.pointerType === "touch" && e.isPrimary) {
      for (const [id, pointer] of [...this.pointers]) {
        if (pointer.type === "touch") this.onCancel({ pointerId: id, pointerType: "touch", clientX: pointer.x, clientY: pointer.y });
      }
    }
    if (e.pointerType === "pen") this.rejectTouches();
    if (this.mediaTools?.onPointerDown?.(e, this.point(e))) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType,
      startX: e.clientX, startY: e.clientY, started: performance.now() });
    this.host.setPointerCapture(e.pointerId);
    e.preventDefault();

    const touches = [...this.pointers.values()].filter((p) => p.type === "touch");
    if (e.pointerType === "touch" && touches.length === 1) {
      this.touchStart = { selection: [...this.selection], context: this.context };
    }
    if (this.gesture?.kind === "pinch") {
      this.gesture.tapCandidate = false; // a third/replacement finger is not a two-finger tap
      return;
    }
    if (touches.length === 2) {
      const tapCandidate = performance.now() - touches[0].started < 250 && !this.gesture?.moved &&
        touches.every((t) => Math.hypot(t.x - t.startX, t.y - t.startY) < TAP_PX.touch);
      this.cancelGesture();
      if (this.touchStart) {
        this.context = this.touchStart.context;
        this.select(this.touchStart.selection.filter((el) => this.svg.contains(el)));
      }
      const pinch = this.pinchState();
      this.gesture = { kind: "pinch", ...pinch, tapCandidate, started: touches[0].started,
        menuPoint: pinch.mid };
      return;
    }
    if (this.gesture) return;
    if (this.textEdit) { this.endTextEdit(true); return; }
    if (e.pointerType === "pen" && !this.penSeen) { this.penSeen = true; this.hooks.penFound?.(); }
    this.setInput(this.slotFor(e.pointerType));

    const p = this.point(e);
    if (e.pointerType === "touch" && touches.length === 1 && !this.pathDraft) this.startLongPress(e);
    // The chosen tool applies to every pointer. Pan is explicit; a previous
    // Pencil stroke must not silently change what a later finger drag does.
    if (this.tool === "pan" || e.button === 1) {
      this.gesture = { kind: "pan", id: e.pointerId, pointerType: e.pointerType, last: { x: e.clientX, y: e.clientY } };
      return;
    }
    if (e.button !== 0 && e.pointerType === "mouse") return;

    const base = { id: e.pointerId, pointerType: e.pointerType, start: p, now: p, client: { x: e.clientX, y: e.clientY },
      moved: false, shift: e.shiftKey };
    // A path being drawn with one input ends when the other one starts
    // something else (panning and pinching leave it open).
    if (this.pathDraft && this.tool !== "bezier") this.finishPath();
    switch (this.tool) {
      case "select": return this.downSelect(e, p, base);
      case "nodes": return this.downNode(e, p, base);
      case "bezier": return this.downPath(p, base);
      case "pen": return this.downPen(p, base, e);
      case "erase":
        this.gesture = { kind: "erase", ...base, removed: [], tx: this.begin() };
        this.eraseAt(e);
        return;
      // On an existing text the text tool edits it rather than adding one on top.
      case "text": this.gesture = { kind: "text", ...base, target: this.textAt(e, p) }; return;
      default: this.gesture = { kind: "create", shape: this.tool, ...base }; return;
    }
  }

  pathNode(p) { return {x:p.x,y:p.y,in:{x:p.x,y:p.y},out:{x:p.x,y:p.y},type:"c"}; }

  pathData(nodes, closed = false) {
    const point = p => `${+p.x.toFixed(3)},${+p.y.toFixed(3)}`;
    let d = `M${point(nodes[0])}`;
    const list = closed ? [...nodes,nodes[0]] : nodes;
    for (let i=1;i<list.length;i++) d += ` C${point(list[i-1].out)} ${point(list[i].in)} ${point(list[i])}`;
    return d + (closed ? " Z" : "");
  }

  downPath(p, base) {
    p = this.snapPoint(p);
    if (!this.pathDraft) {
      const el = this.selection.length === 1 && this.selection[0], points = this.curvePoints(el);
      if (points && !/Z\s*$/i.test(el.getAttribute("d"))) {
        const m=toRoot(el,this.svg);
        for (const [index,reverse] of [[0,true],[points.length-1,false]]) {
          const q=m.transformPoint(new DOMPoint(points[index].x,points[index].y));
          if (Math.hypot(q.x-p.x,q.y-p.y)*this.zoom < 14) {
            // A tap continues the path from this end; a stroke is drawn on from it.
            this.extendCurve(reverse);
            if (this.pathDraft) this.gesture = {kind:"path-node",...base,node:this.pathNode(p),trail:[base.start],extend:true};
            return;
          }
        }
      }
      this.pathDraft = {nodes:[],hover:null}; this.select([]);
    }
    const draft = this.pathDraft, first = draft.nodes[0], last = draft.nodes.at(-1);
    const near = a => a && Math.hypot(a.x-p.x,a.y-p.y)*this.zoom < (base.pointerType === "touch" ? 18 : 10);
    if (draft.nodes.length > 2 && near(first)) { this.finishPath(true); return; }
    if (draft.nodes.length > 1 && near(last) && performance.now()-draft.lastAt < 450) { this.finishPath(); return; }
    // Shift keeps the new segment at a multiple of 45° from the last point.
    if (base.shift && last) p = constrainAngle(last, p);
    this.gesture = {kind:"path-node",...base,node:this.pathNode(p),trail:[base.start]};
    draft.hover = null;
    this.drawOverlay();
  }

  finishPath(closed = false) {
    const draft = this.pathDraft;
    if (!draft) return;
    this.cancelGesture();
    this.pathDraft = null;
    if (draft.nodes.length > 1 && !(draft.source && !closed && this.pathData(draft.nodes) === draft.initialData)) this.change(() => {
      const path = draft.source || this.newShape("bezier");
      let nodes = draft.nodes;
      if (draft.source) {
        const inverse=toRoot(path,this.svg).inverse();
        const convert=p=>{const q=inverse.transformPoint(new DOMPoint(p.x,p.y)); return {x:q.x,y:q.y};};
        nodes=nodes.map(n=>({...convert(n),in:convert(n.in),out:convert(n.out),type:n.type}));
      }
      this.writeModel(path, {kind:"path", subs:[{nodes, closed}]});
      if (!draft.source) this.adopt(path);
      this.selection = [path];
    });
    this.drawOverlay();
    this.hooks.select(this.selection);
  }

  cancelPath() {
    this.cancelGesture(); this.pathDraft = null; this.drawOverlay(); this.hooks.select(this.selection);
  }

  removePathNode() {
    if (!this.pathDraft) return;
    this.pathDraft.nodes.pop();
    if (!this.pathDraft.nodes.length) this.cancelPath();
    else { this.drawOverlay(); this.hooks.select(this.selection); }
  }

  /** Whether a drag has curved away from the straight line between its ends. */
  bends(trail) {
    const a = trail[0], b = trail.at(-1), len = Math.hypot(b.x - a.x, b.y - a.y);
    let dev = 0, far = 0;
    for (const q of trail) {
      dev = Math.max(dev, len ? Math.abs((b.x - a.x) * (a.y - q.y) - (a.x - q.x) * (b.y - a.y)) / len : 0);
      far = Math.max(far, Math.hypot(q.x - a.x, q.y - a.y));
    }
    // Bent sideways, or doubled back towards the start.
    return dev * this.zoom > Math.max(12, 0.2 * len * this.zoom) || (far * this.zoom > 40 && len < far * 0.6);
  }

  /** A freehand stroke with the Bézier tool, fitted with a few points. A
   *  stroke on its own is a finished path; one that starts at the end of an
   *  open path (or of the points placed so far) carries on from it, and one
   *  that ends on the path's first point closes it. */
  endStroke(g) {
    const draft = this.pathDraft, tolerance = (this.hooks.fitTolerance?.() || 5) / this.zoom;
    const nodes = fitStroke(g.trail, tolerance, { reach: 14 / this.zoom });
    // A Pencil tap that slid a little is still a tap.
    const extent = Math.max(...g.trail.map((q) => Math.hypot(q.x - g.trail[0].x, q.y - g.trail[0].y)));
    if (nodes.length < 2 || extent * this.zoom < 16) {
      if (!g.extend) draft.nodes.push(g.node);
      draft.lastAt = performance.now();  // so a second tap on it finishes the path
      this.drawOverlay(); this.hooks.select(this.selection); return;
    }
    const reach = (g.pointerType === "touch" ? 18 : 10) / this.zoom;
    const near = (a, b) => a && b && Math.hypot(a.x - b.x, a.y - b.y) < reach;
    const alone = !draft.nodes.length, last = draft.nodes.at(-1);
    if (near(last, nodes[0])) {
      // Join onto the last point, smoothly if the stroke leaves in line with it.
      const first = nodes.shift(), dx = last.x - first.x, dy = last.y - first.y;
      last.out = { x: first.out.x + dx, y: first.out.y + dy };
      const vin = { x: last.x - last.in.x, y: last.y - last.in.y }, vout = { x: last.out.x - last.x, y: last.out.y - last.y };
      const lin = Math.hypot(vin.x, vin.y), lout = Math.hypot(vout.x, vout.y);
      if (lin > 1e-6 && lout > 1e-6 && (vin.x * vout.x + vin.y * vout.y) / (lin * lout) > Math.cos(Math.PI / 9)) {
        last.out = { x: last.x + vin.x / lin * lout, y: last.y + vin.y / lin * lout };
        last.type = "s";
      }
    }
    draft.nodes.push(...nodes);
    draft.hover = null;
    draft.lastAt = performance.now();
    const all = draft.nodes, end = all.at(-1);
    if (all.length > 2 && near(all[0], end)) {
      all[0].in = { x: end.in.x + all[0].x - end.x, y: end.in.y + all[0].y - end.y };
      all.pop();
      this.finishPath(true);
    } else if (alone || g.extend) this.finishPath();
    else { this.drawOverlay(); this.hooks.select(this.selection); }
  }

  // --- point editing ---------------------------------------------------------
  // Paths, polygons and polylines are edited as nodes. The SVG geometry stays
  // the source of truth; only the node types (corner, smooth, symmetric) are
  // kept alongside, in data-nodetypes, since they cannot be read back exactly.

  /** An element's nodes: {kind: "path"|"poly", subs: [{nodes, closed}]}. */
  nodeModel(el) {
    if (el?.localName === "path") {
      const subs = parsePath(el.getAttribute("d"));
      if (!subs) return null;
      const count = subs.reduce((n, sub) => n + sub.nodes.length, 0);
      if (count > MAX_EDIT_NODES) return null;
      const stored = el.getAttribute("data-nodetypes") || "";
      let k = 0;
      for (const sub of subs) for (const n of sub.nodes) {
        const c = stored.length === count ? stored[k] : "";
        n.type = c && "csz".includes(c) ? c : inferNodeType(n);
        k++;
      }
      return { kind: "path", subs };
    }
    if (["polygon", "polyline"].includes(el?.localName)) {
      const nodes = Array.from(el.points, (q) => ({ ...nodeAt(q), type: "c" }));
      if (!nodes.length || nodes.length > MAX_EDIT_NODES) return null;
      return { kind: "poly", subs: [{ nodes, closed: el.localName === "polygon" }] };
    }
    return null;
  }

  writeModel(el, model) {
    if (model.kind === "path") {
      el.setAttribute("d", pathFromNodes(model.subs));
      // Kept when they say more than the handles do: a corner whose handles
      // happen to be in line would otherwise read back as smooth.
      const nodes = model.subs.flatMap((sub) => sub.nodes);
      const types = nodes.map((n) => n.type || "c").join("");
      if (/[sz]/.test(types) || nodes.some((n) => (n.type || "c") !== inferNodeType(n))) el.setAttribute("data-nodetypes", types);
      else el.removeAttribute("data-nodetypes");
    } else {
      el.setAttribute("points", model.subs[0].nodes.map((n) => `${+n.x.toFixed(3)},${+n.y.toFixed(3)}`).join(" "));
    }
  }

  cloneModel(model) {
    return { kind: model.kind, subs: model.subs.map((sub) => ({ closed: sub.closed,
      nodes: sub.nodes.map((n) => ({ x: n.x, y: n.y, in: { ...n.in }, out: { ...n.out }, type: n.type })) })) };
  }

  /** Flat Bézier points of a one-piece path: anchor, out, in, anchor, ... */
  curvePoints(el) {
    const model = el?.localName === "path" && this.nodeModel(el);
    if (!model || model.subs.length !== 1) return null;
    const { nodes, closed } = model.subs[0];
    const out = [{ x: nodes[0].x, y: nodes[0].y }];
    const list = closed ? [...nodes, nodes[0]] : nodes;
    for (let i = 1; i < list.length; i++) out.push({ ...list[i - 1].out }, { ...list[i].in }, { x: list[i].x, y: list[i].y });
    return out;
  }

  editableNodes(el) {
    return this.nodeModel(el);
  }

  /** The chosen point of the selected object, if any. */
  selectedNode() {
    const ns = this.nodeSel, el = this.selection.length === 1 && this.selection[0];
    if (!ns || ns.el !== el) return null;
    const model = this.nodeModel(el);
    const node = model?.subs[ns.sub]?.nodes[ns.i];
    return node ? { el, model, sub: ns.sub, i: ns.i, node } : null;
  }

  /** Grabbable points in slide coordinates: nodes, and the handles shown. */
  nodeTargets(el, model) {
    const m = toRoot(el, this.svg);
    const map = (q) => { const v = m.transformPoint(new DOMPoint(q.x, q.y)); return { x: v.x, y: v.y }; };
    const total = model.subs.reduce((n, sub) => n + sub.nodes.length, 0);
    const ns = this.nodeSel?.el === el ? this.nodeSel : null;
    const targets = [];
    model.subs.forEach((sub, si) => sub.nodes.forEach((n, i) => {
      const p = map(n);
      targets.push({ sub: si, i, part: "node", p, node: n });
      if (model.kind !== "path") return;
      const near = total <= ALL_HANDLES_UP_TO || (ns && ns.sub === si &&
        [ns.i - 1, ns.i, ns.i + 1].some((j) => (j + sub.nodes.length) % sub.nodes.length === i));
      if (!near) return;
      for (const part of ["in", "out"]) {
        if (!sub.closed && ((part === "in" && i === 0) || (part === "out" && i === sub.nodes.length - 1))) continue;
        const h = map(n[part]);
        if (Math.hypot(h.x - p.x, h.y - p.y) * this.zoom < 3) continue;  // retracted
        targets.push({ sub: si, i, part, p: h, anchor: p, node: n });
      }
    }));
    return { targets, map, matrix: m };
  }

  downNode(e, p, base) {
    const el = this.selection.length === 1 && this.selection[0];
    const model = el && this.nodeModel(el);
    if (model) {
      const { targets, map, matrix } = this.nodeTargets(el, model);
      const radius = { touch: 22, pen: 14 }[e.pointerType] || 12;
      let hit = null, score = Infinity;
      for (const t of targets) {
        const d = Math.hypot(t.p.x - p.x, t.p.y - p.y) * this.zoom;
        // Nodes win over handles lying on top of them.
        const s = d - (t.part === "node" ? 6 : 0);
        if (d < radius && s < score) { hit = t; score = s; }
      }
      if (hit) {
        this.nodeSel = { el, sub: hit.sub, i: hit.i };
        this.gesture = { kind: "node", ...base, tx: this.begin(), el, model, sub: hit.sub, i: hit.i, part: hit.part,
          inverse: matrix.inverse(), attr: model.kind === "path" ? "d" : "points",
          original: el.getAttribute(model.kind === "path" ? "d" : "points"), types: el.getAttribute("data-nodetypes") };
        this.lastSegmentTap = null;
        this.drawOverlay();
        this.hooks.select(this.selection);
        return;
      }
      // On the outline: a double tap adds a point there.
      const seg = this.nearestSegment(model, map, p);
      if (seg && seg.dist * this.zoom < radius) {
        const now = performance.now(), last = this.lastSegmentTap;
        if (last && now - last.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 24) {
          this.lastSegmentTap = null;
          this.insertNode(seg.sub, seg.i, seg.t);
        } else {
          this.lastSegmentTap = { t: now, x: e.clientX, y: e.clientY };
          if (this.nodeSel) { this.nodeSel = null; this.drawOverlay(); this.hooks.select(this.selection); }
        }
        return;
      }
    }
    this.nodeSel = null;
    const picked = this.pick(e,p);
    this.select(picked ? [picked] : []);
    if (picked && !this.editableNodes(picked)) this.hooks.toast("Choose a path, curve or polygon to edit its points.");
  }

  /** The segment of a model closest to p (slide coordinates). */
  nearestSegment(model, map, p) {
    let best = null;
    model.subs.forEach((sub, si) => {
      const n = sub.nodes.length, count = sub.closed ? n : n - 1;
      for (let i = 0; i < count; i++) {
        const r = nearestOnSegment(sub.nodes[i], sub.nodes[(i + 1) % n], p, map);
        if (!best || r.dist < best.dist) best = { sub: si, i, t: r.t, dist: r.dist };
      }
    });
    return best;
  }

  /** Change the selected object's nodes as one undoable step. */
  editNodes(fn) {
    const el = this.selection.length === 1 && this.selection[0];
    const model = el && this.nodeModel(el);
    if (!model) return false;
    let ok = false;
    this.change(() => { ok = fn(model, el) !== false; if (ok) this.writeModel(el, model); });
    return ok;
  }

  /** Add a point on segment i (from node i to the next) of subpath sub at t. */
  insertNode(sub, i, t = 0.5) {
    this.editNodes((model, el) => {
      const nodes = model.subs[sub].nodes, a = nodes[i], b = nodes[(i + 1) % nodes.length];
      const n = splitSegment(a, b, t);
      n.type = model.kind === "path" && inferNodeType(n) !== "c" ? "s" : "c";
      nodes.splice(i + 1, 0, n);
      this.nodeSel = { el, sub, i: i + 1 };
    });
  }

  /** Add a point halfway along the segment after the chosen point. */
  insertNodeAfterSelected() {
    const sel = this.selectedNode();
    if (!sel) return;
    const { nodes, closed } = sel.model.subs[sel.sub];
    const i = !closed && sel.i === nodes.length - 1 ? sel.i - 1 : sel.i;
    if (i >= 0) this.insertNode(sel.sub, i, 0.5);
  }

  deleteSelectedNode() {
    const sel = this.selectedNode();
    if (!sel) return false;
    const { nodes, closed } = sel.model.subs[sel.sub];
    const min = closed ? 3 : 2;
    if (nodes.length <= min) {
      this.hooks.toast(`A ${closed ? "closed" : "open"} outline needs at least ${min} points; delete the object instead.`);
      return true;
    }
    this.editNodes((model, el) => {
      const list = model.subs[sel.sub].nodes;
      list.splice(sel.i, 1);
      // An open end has no handle beyond it.
      if (!closed) {
        list[0].in = { x: list[0].x, y: list[0].y };
        const last = list[list.length - 1];
        last.out = { x: last.x, y: last.y };
      }
      this.nodeSel = { el, sub: sel.sub, i: Math.min(sel.i, list.length - 1) };
    });
    return true;
  }

  /** Corner ("c"), smooth ("s") or symmetric ("z") for the chosen point.
   *  Smooth and symmetric pull out missing handles along the outline. */
  setNodeType(type) {
    const sel = this.selectedNode();
    if (!sel || sel.model.kind !== "path") return;
    this.editNodes((model) => {
      const sub = model.subs[sel.sub], n = sub.nodes[sel.i];
      n.type = type;
      if (type === "c") return;
      const len = (h) => Math.hypot(h.x - n.x, h.y - n.y);
      const count = sub.nodes.length;
      const prev = sel.i > 0 ? sub.nodes[sel.i - 1] : sub.closed ? sub.nodes[count - 1] : null;
      const next = sel.i < count - 1 ? sub.nodes[sel.i + 1] : sub.closed ? sub.nodes[0] : null;
      // Direction of the outline through the point.
      let dx = 0, dy = 0;
      if (len(n.out) > 1e-6) { dx += (n.out.x - n.x) / len(n.out); dy += (n.out.y - n.y) / len(n.out); }
      if (len(n.in) > 1e-6) { dx -= (n.in.x - n.x) / len(n.in); dy -= (n.in.y - n.y) / len(n.in); }
      if (Math.hypot(dx, dy) < 1e-6) {
        const a = prev || n, b = next || n;
        dx = b.x - a.x; dy = b.y - a.y;
      }
      const d = Math.hypot(dx, dy);
      if (d < 1e-9) return;
      dx /= d; dy /= d;
      let lin = len(n.in) || (prev ? Math.hypot(n.x - prev.x, n.y - prev.y) / 3 : 0);
      let lout = len(n.out) || (next ? Math.hypot(next.x - n.x, next.y - n.y) / 3 : 0);
      if (type === "z" && prev && next) lin = lout = (lin + lout) / 2;
      if (prev) n.in = { x: n.x - dx * lin, y: n.y - dy * lin };
      if (next) n.out = { x: n.x + dx * lout, y: n.y + dy * lout };
    });
  }

  /** Make the segment after the chosen point straight or curved. */
  setSegment(kind) {
    const sel = this.selectedNode();
    if (!sel || sel.model.kind !== "path") return;
    this.editNodes((model) => {
      const sub = model.subs[sel.sub], count = sub.nodes.length;
      let i = sel.i;
      if (!sub.closed && i === count - 1) i -= 1;
      if (i < 0) return false;
      const a = sub.nodes[i], b = sub.nodes[(i + 1) % count];
      if (kind === "line") {
        a.out = { x: a.x, y: a.y }; b.in = { x: b.x, y: b.y };
        for (const n of [a, b]) if (n.type !== "c") n.type = "c";
      } else {
        a.out = { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 };
        b.in = { x: a.x + 2 * (b.x - a.x) / 3, y: a.y + 2 * (b.y - a.y) / 3 };
      }
    });
  }

  /** Close an open outline, or open a closed one at the chosen point. */
  toggleClosed() {
    const el = this.selection[0];
    const model = this.nodeModel(el);
    if (!model) return;
    const sel = this.selectedNode();
    const si = sel ? sel.sub : 0;
    if (model.kind === "poly") {
      // polygon <-> polyline keeps every attribute.
      this.change(() => {
        const other = document.createElementNS(SVGNS, el.localName === "polygon" ? "polyline" : "polygon");
        for (const a of Array.from(el.attributes)) other.setAttributeNS(a.namespaceURI, a.name, a.value);
        if (other.localName === "polyline" && !el.style.fill && !el.getAttribute("fill")) other.style.setProperty("fill", "none");
        el.replaceWith(other);
        this.selection = [other];
        this.nodeSel = null;
      });
      return;
    }
    this.editNodes((m, path) => {
      const sub = m.subs[si];
      if (sub.closed) {
        // Open at the chosen point: it becomes both ends.
        const k = sel ? sel.i : 0;
        const nodes = [...sub.nodes.slice(k), ...sub.nodes.slice(0, k)];
        const start = nodes[0];
        nodes.push({ x: start.x, y: start.y, in: { ...start.in }, out: { x: start.x, y: start.y }, type: "c" });
        start.in = { x: start.x, y: start.y };
        start.type = "c";
        sub.nodes = nodes;
        sub.closed = false;
        this.nodeSel = { el: path, sub: si, i: 0 };
      } else {
        if (sub.nodes.length < 3) return false;
        sub.closed = true;
      }
    });
  }

  extendCurve(reverse = false) {
    const el = this.selection[0], model = this.nodeModel(el);
    if (!model || model.kind !== "path" || model.subs.length !== 1) return;
    if (model.subs[0].closed) { this.hooks.toast("This path is closed; edit its existing points or draw a new path."); return; }
    const nodes = model.subs[0].nodes.map((n) => (reverse ? { ...n, in: n.out, out: n.in } : n));
    if (reverse) nodes.reverse();
    const matrix = toRoot(el, this.svg);
    const convert = (p) => { const q = matrix.transformPoint(new DOMPoint(p.x, p.y)); return { x: q.x, y: q.y }; };
    const draft = nodes.map((n) => ({ ...convert(n), in: convert(n.in), out: convert(n.out), type: n.type }));
    this.pathDraft = { nodes: draft, source: el, hover: null, initialData: this.pathData(draft) };
    this.drawOverlay(); this.hooks.select(this.selection);
  }

  splitCurve() {
    const el = this.selection[0], model = this.nodeModel(el);
    if (!model) return;
    const total = model.subs.reduce((n, sub) => n + sub.nodes.length, 0);
    if (total * 2 > MAX_EDIT_NODES) { this.hooks.toast("This outline already has many points; drag its existing points to refine it."); return; }
    // Each segment is split in half without changing the shape.
    this.editNodes((m) => {
      for (const sub of m.subs) {
        const out = [], n = sub.nodes.length, count = sub.closed ? n : n - 1;
        for (let i = 0; i < n; i++) {
          out.push(sub.nodes[i]);
          if (i < count) {
            const mid = splitSegment(sub.nodes[i], sub.nodes[(i + 1) % n], 0.5);
            mid.type = m.kind === "path" && inferNodeType(mid) !== "c" ? "s" : "c";
            out.push(mid);
          }
        }
        sub.nodes = out;
      }
    });
  }

  downSelect(e, p, base) {
    const handle = this.hitHandle(p, e.pointerType);
    if (handle === "end1" || handle === "end2") {
      const tx = this.begin();
      const line = this.lineMode();
      const which = handle === "end1" ? 1 : 2;
      this.gesture = { kind: "endpoint", ...base, tx, line, which, inverse: toRoot(line, this.svg).inverse(),
        original: [line.getAttribute(`x${which}`), line.getAttribute(`y${which}`)] };
      return;
    }
    if (handle) {
      const tx = this.begin();
      const box = this.selectionBox(), frame = this.selectionFrame();
      this.gesture = handle === "rotate"
        ? { kind: "rotate", ...base, tx, center: [box.x + box.width / 2, box.y + box.height / 2], snaps: this.snapshot() }
        : { kind: "resize", ...base, tx, handle, box: frame ? frame.box : box, frame, snaps: this.snapshot() };
      return;
    }
    let el = this.pick(e, p);
    if (!el && this.context !== this.svg) {
      // Tapping outside the group leaves it.
      const b = rootBox(this.context, this.svg);
      if (!b || p.x < b.x || p.y < b.y || p.x > b.x + b.width || p.y > b.y + b.height) {
        this.exitGroup();
        el = this.pick(e, p);
      }
    }
    const additive = e.shiftKey || this.additive;
    if (!el) {
      if (!additive) this.select([]);
      this.gesture = { kind: "marquee", ...base, additive };
      return;
    }
    if (additive) {
      // Tapping a selected object takes it out; dragging moves them all.
      const had = this.selection.includes(el);
      if (!had) this.select([...this.selection, el]);
      this.gesture = { kind: "move", ...base, target: el, snaps: null, additive: true, toggle: had };
      return;
    }
    if (!this.selection.includes(el)) this.select([el]);
    this.gesture = { kind: "move", ...base, target: el, snaps: null };
  }

  downPen(p, base, e) {
    const path = document.createElementNS(SVGNS, "path");
    const style = this.hooks.shapeStyle();
    const color = style.stroke === "none" ? "#000000" : style.stroke;
    // The Pencil's pressure sets the width: the stroke is a filled outline.
    const pressure = base.pointerType === "pen" && this.hooks.usePressure?.() !== false;
    if (pressure) {
      path.setAttribute("fill", color);
      path.setAttribute("stroke", "none");
      path.setAttribute("data-ink", "pressure");
    } else {
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", style.strokeWidth);
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
    }
    const tx = this.begin();
    this.adopt(path);
    this.gesture = { kind: "draw", ...base, tx, path, pressure, width: style.strokeWidth, level: null, points: [] };
    this.addInkPoint(this.gesture, p, e);
    this.drawInk(this.gesture, false);
  }

  /** Pressure is smoothed a little: the Pencil's readings jitter. */
  addInkPoint(g, q, e) {
    let level = 0.5;
    if (g.pressure) {
      const raw = e?.pressure > 0 ? e.pressure : 0.5;
      level = g.level === null ? raw : g.level + (raw - g.level) * 0.35;
      g.level = level;
    }
    g.points.push([q.x, q.y, level]);
  }

  drawInk(g, final) {
    if (!g.pressure) {
      g.path.setAttribute("d", final ? smoothPath(simplify(g.points, 1.2 / this.zoom)) : polylinePath(g.points));
      return;
    }
    // In the stroke's own units (it may be inside a scaled group).
    const scale = this.scaleOf(g.path) || 1;
    const inverse = toRoot(g.path, this.svg).inverse();
    const local = (pts) => pts.map(([x, y, w]) => { const v = inverse.transformPoint(new DOMPoint(x, y)); return [v.x, v.y, w]; });
    const pts = final ? simplify(g.points, 0.6 / this.zoom) : g.points;
    g.path.setAttribute("d", inkOutline(local(pts), g.width / scale, final));
  }

  onMove(e) {
    if (this.palms.has(e.pointerId)) return;
    if (this.mediaTools?.onPointerMove?.(e, this.point(e))) return;
    const ptr = this.pointers.get(e.pointerId);
    if (ptr) {
      ptr.x = e.clientX; ptr.y = e.clientY;
      if (Math.hypot(ptr.x - ptr.startX, ptr.y - ptr.startY) >= TAP_PX.touch) this.clearLongPress();
    }
    const g = this.gesture;
    // Pencil hover (and the mouse) show what that input is about to do.
    if (!g && !e.buttons && e.pointerType !== "touch") this.setInput(this.slotFor(e.pointerType));
    if (!g) {
      if (this.pathDraft) {
        let hover = this.snapPoint(this.point(e));
        const last = this.pathDraft.nodes.at(-1);
        if (e.shiftKey && last) hover = constrainAngle(last, hover);
        this.pathDraft.hover = hover;
        this.drawOverlay();
      }
      return;
    }
    if (g.kind === "pinch") return this.movePinch();
    if (g.id !== e.pointerId) return;
    if (g.kind === "pan") {
      this.pan.x += e.clientX - g.last.x;
      this.pan.y += e.clientY - g.last.y;
      g.last = { x: e.clientX, y: e.clientY };
      this.fitMode = false;
      this.layout();
      return;
    }
    if (g.kind === "erase") {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [e]) this.eraseAt(ev);
      return;
    }
    const p = this.point(e);
    g.now = p;
    const tapPx = TAP_PX[e.pointerType] || TAP_PX.mouse;
    if (!g.moved && Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < tapPx) return;
    g.moved = true;
    switch (g.kind) {
      case "move": {
        if (!g.snaps) { g.tx = this.begin(); g.snaps = this.snapshot(); g.box0 = this.selectionBox(); }
        let dx = p.x - g.start.x, dy = p.y - g.start.y;
        const horizontal = e.shiftKey && Math.abs(dx) > Math.abs(dy), vertical = e.shiftKey && !horizontal;
        if (!e.altKey) {
          if (this.grid.snap) [dx, dy] = this.snapDelta(g.box0, dx, dy);
          else {
            const smart = this.smartMove(g.box0, dx, dy);
            dx = smart.dx; dy = smart.dy; this.smartGuides = smart.guides;
          }
        } else this.smartGuides = [];
        if (horizontal) { dy = 0; this.smartGuides = this.smartGuides.filter((guide) => guide.axis === "x"); }
        if (vertical) { dx = 0; this.smartGuides = this.smartGuides.filter((guide) => guide.axis === "y"); }
        this.applyDelta(g.snaps, new DOMMatrix().translateSelf(dx, dy));
        break;
      }
      case "path-node": {
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
        for (const ev of events.length ? events : [e]) g.trail.push(this.point(ev));
        // The Pencil draws freehand; a finger or the mouse pulls out handles
        // until the drag bends away from a straight line.
        if (!g.freehand && (e.pointerType === "pen" || this.bends(g.trail))) {
          g.freehand = true;
          g.node = this.pathNode(g.node);
        }
        if (g.freehand) break;
        if (g.extend) break;
        const a = g.node;
        let q = this.snapPoint(p);
        // Shift turns the handle in steps of 45° about its point.
        if (e.shiftKey) q = constrainAngle(a, q);
        a.out = {x:q.x,y:q.y};
        a.in = {x:2*a.x-q.x,y:2*a.y-q.y};
        a.type = "z";
        break;
      }
      case "node": {
        const model = this.cloneModel(g.model);
        const n = model.subs[g.sub].nodes[g.i];
        // Move by the pointer's displacement, so a point grabbed a little off
        // its centre does not jump; a node snaps where it lands.
        const grabbed = g.part === "node" ? n : n[g.part];
        const start = g.inverse.inverse().transformPoint(new DOMPoint(grabbed.x, grabbed.y));
        let target = { x: start.x + p.x - g.start.x, y: start.y + p.y - g.start.y };
        if (g.part === "node") target = this.snapPoint(target);
        const q = g.inverse.transformPoint(new DOMPoint(target.x, target.y));
        if (g.part === "node") {
          const dx = q.x - n.x, dy = q.y - n.y;
          for (const h of [n, n.in, n.out]) { h.x += dx; h.y += dy; }
        } else {
          n[g.part] = { x: q.x, y: q.y };
          const other = g.part === "in" ? "out" : "in";
          const vx = n.x - q.x, vy = n.y - q.y, v = Math.hypot(vx, vy);
          // Smooth points keep the other handle opposite; symmetric ones mirror it.
          if (v > 1e-9 && (n.type === "s" || n.type === "z")) {
            const len = n.type === "z" ? v : Math.hypot(n[other].x - n.x, n[other].y - n.y);
            n[other] = { x: n.x + vx / v * len, y: n.y + vy / v * len };
          }
        }
        this.writeModel(g.el, model);
        break;
      }
      case "resize": this.moveResize(g, p, { free: e.shiftKey, centre: e.altKey }); break;
      case "endpoint": {
        let q = this.snapPoint(p);
        if (e.shiftKey) q = constrainAngle(this.lineEnds(g.line)[g.which === 1 ? 1 : 0], p);
        const local = g.inverse.transformPoint(new DOMPoint(q.x, q.y));
        g.line.setAttribute(`x${g.which}`, String(+local.x.toFixed(2)));
        g.line.setAttribute(`y${g.which}`, String(+local.y.toFixed(2)));
        break;
      }
      case "rotate": {
        const [cx, cy] = g.center;
        let deg = (Math.atan2(p.y - cy, p.x - cx) - Math.atan2(g.start.y - cy, g.start.x - cx)) * 180 / Math.PI;
        const snapped = Math.round(deg / 15) * 15;
        if (e.shiftKey || Math.abs(deg - snapped) < 3) deg = snapped;
        this.applyDelta(g.snaps, new DOMMatrix().translateSelf(cx, cy).rotateSelf(deg).translateSelf(-cx, -cy));
        break;
      }
      case "marquee": break;
      case "create": this.moveCreate(g, p, e.shiftKey, e.altKey); break;
      case "draw": {
        this.clearLongPress();  // the stroke has begun; a hold no longer opens the menu
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events.length ? events : [e]) this.addInkPoint(g, this.point(ev), ev);
        this.drawInk(g, false);
        return;
      }
    }
    this.drawOverlay();
  }

  /** Remove the strokes under a pointer position (and a few pixels around). */
  eraseAt(e) {
    const g = this.gesture;
    const hits = new Set();
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let el of document.elementsFromPoint(e.clientX + dx * ERASER_PX, e.clientY + dy * ERASER_PX)) {
        if (!this.svg.contains(el) || el === this.svg) continue;
        while (el && el.parentNode !== this.context) el = el.parentNode;
        if (el && ERASABLE.has(el.localName) && this.selectable(el)) hits.add(el);
      }
    }
    for (const el of hits) {
      g.removed.push({ el, parent: el.parentNode, next: el.nextSibling });
      el.remove();
    }
    if (hits.size) {
      // Erasing is work a long press must not undo, however slow the finger.
      this.clearLongPress();
      this.selection = this.selection.filter((el) => !hits.has(el));
      this.drawOverlay();
    }
  }

  /** Resize with a handle. `free` (Shift) lets a corner change the
   *  proportions; `centre` (Alt) keeps the centre in place, so the opposite
   *  side moves symmetrically. The dragged edge snaps to the grid, or else to
   *  the smart guides (other objects' and the slide's edges and centres). */
  moveResize(g, p, { free = false, centre = false } = {}) {
    const { box, handle, frame } = g;
    // The handle moves as far as the pointer, so grabbing it a little off
    // its centre does not make the edge jump. A turned object is scaled
    // along its own axes (in its frame); the grid only snaps upright edges.
    const [hx, hy] = this.handlePositions(box)[handle];
    if (frame) {
      const d = frame.toFrame.transformPoint(new DOMPoint(p.x - g.start.x, p.y - g.start.y));
      p = { x: hx + d.x, y: hy + d.y };
    } else p = this.snapPoint({ x: hx + p.x - g.start.x, y: hy + p.y - g.start.y });
    const left = box.x, right = box.x + box.width, top = box.y, bottom = box.y + box.height;
    const cx = left + box.width / 2, cy = top + box.height / 2;
    const locked = handle.length === 2 && !free;
    const scales = (p, lead = null) => {
      let sx = 1, sy = 1, ax = left, ay = top;
      if (handle.includes("e")) { ax = centre ? cx : left; sx = box.width ? (p.x - ax) / (right - ax) : 1; }
      if (handle.includes("w")) { ax = centre ? cx : right; sx = box.width ? (ax - p.x) / (ax - left) : 1; }
      if (handle.includes("s")) { ay = centre ? cy : top; sy = box.height ? (p.y - ay) / (bottom - ay) : 1; }
      if (handle.includes("n")) { ay = centre ? cy : bottom; sy = box.height ? (ay - p.y) / (ay - top) : 1; }
      if (handle === "n" || handle === "s") ax = cx;
      if (handle === "e" || handle === "w") ay = cy;
      lead ||= Math.abs(sx - 1) > Math.abs(sy - 1) ? "x" : "y";
      if (locked) { const s = lead === "x" ? sx : sy; sx = s; sy = s; }
      return { sx, sy, ax, ay, lead };
    };
    let { sx, sy, ax, ay, lead } = scales(p);
    this.smartGuides = [];
    if (!frame && this.smartSnapping()) {
      // The dragged edge snaps; a corner keeping its proportions snaps by
      // the edge that leads the scale.
      g.targets ||= this.snapTargets();
      const axes = locked ? [lead] : [/[ew]/.test(handle) && "x", /[ns]/.test(handle) && "y"].filter(Boolean);
      const snapped = this.smartPoint(p, g.targets, axes);
      if (snapped.guides.length) {
        ({ sx, sy, ax, ay } = scales(snapped.p, lead));
        const after = { x: ax + (left - ax) * sx, y: ay + (top - ay) * sy, width: box.width * Math.abs(sx), height: box.height * Math.abs(sy) };
        if (sx < 0) after.x -= after.width;
        if (sy < 0) after.y -= after.height;
        this.smartGuides = this.pointGuides(snapped.guides, after);
      }
    }
    const min = 2 / Math.max(box.width, box.height, 1);
    if (Math.abs(sx) < min) sx = Math.sign(sx || 1) * min;
    if (Math.abs(sy) < min) sy = Math.sign(sy || 1) * min;
    let D = new DOMMatrix().translateSelf(ax, ay).scaleSelf(sx, sy).translateSelf(-ax, -ay);
    if (frame) D = frame.toSlide.multiply(D).multiply(frame.toFrame);
    this.applyDelta(g.snaps, D);
  }

  moveCreate(g, p, square, alt = false) {
    if (!g.el) {
      // Everything already there is a target, the selection too.
      if (this.smartSnapping()) g.targets = this.snapTargets(new Set());
      g.tx = this.begin();
      g.el = this.adopt(this.newShape(g.shape));
    }
    const a = this.snapPoint(g.start);
    let b = this.snapPoint(p);
    this.smartGuides = [];
    // The dragged corner (or line end) snaps to the smart guides, unless the
    // shape is held square or circular, which would move it off the guide.
    if (g.targets && this.smartSnapping(alt) && !square && g.shape !== "circle") {
      const snapped = this.smartPoint(b, g.targets);
      b = snapped.p;
      const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
      this.smartGuides = this.pointGuides(snapped.guides, box);
    }
    this.shapeGeometry(g.el, g.shape, a, b, square);
    if (g.shape === "arrow" && !g.arrowed) { g.arrowed = true; this.refreshArrows(g.el); }
  }

  /** Put a new object into the current group, keeping the slide coordinates
   *  it was drawn in even if the group is moved or scaled. */
  adopt(el) {
    this.context.appendChild(el);
    if (this.context !== this.svg) setTransform(el, toRoot(this.context, this.svg).inverse());
    return el;
  }

  newShape(shape) {
    const style = this.hooks.shapeStyle();
    const tag = { rect: "rect", ellipse: "ellipse", circle: "circle", polygon: "polygon", bezier: "path", line: "line", arrow: "line" }[shape];
    const el = document.createElementNS(SVGNS, tag);
    if (tag === "line" || shape === "bezier") {
      el.style.setProperty("fill", "none");
      el.style.setProperty("stroke", style.stroke === "none" ? "#000000" : style.stroke);
      el.style.setProperty("stroke-width", style.strokeWidth);
      el.style.setProperty("stroke-linecap", "round");
      if (shape === "arrow") el.style.setProperty("marker-end", "url(#arrow-pending)");
    } else {
      el.style.setProperty("fill", style.fill);
      el.style.setProperty("stroke", style.stroke);
      el.style.setProperty("stroke-width", style.strokeWidth);
    }
    return el;
  }

  shapeGeometry(el, shape, a, b, constrain) {
    const r = (v) => String(+v.toFixed(2));
    let dx = b.x - a.x, dy = b.y - a.y;
    if (shape === "line" || shape === "arrow") {
      if (constrain) {
        const q = constrainAngle({ x: 0, y: 0 }, { x: dx, y: dy });
        dx = q.x; dy = q.y;
      }
      el.setAttribute("x1", r(a.x)); el.setAttribute("y1", r(a.y));
      el.setAttribute("x2", r(a.x + dx)); el.setAttribute("y2", r(a.y + dy));
      return;
    }
    if (constrain || shape === "circle") { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s; }
    const x = Math.min(a.x, a.x + dx), y = Math.min(a.y, a.y + dy), w = Math.abs(dx), h = Math.abs(dy);
    if (shape === "bezier") {
      this.writeModel(el, { kind: "path", subs: [{ closed: false, nodes: [
        { x: a.x, y: a.y, in: { x: a.x, y: a.y }, out: { x: a.x + dx / 3, y: a.y - 100 }, type: "c" },
        { x: b.x, y: b.y, in: { x: a.x + 2 * dx / 3, y: b.y + 100 }, out: { x: b.x, y: b.y }, type: "c" }] }] });
    } else if (shape === "polygon") {
      const n = this.polygonSides || 5;
      el.setAttribute("points", Array.from({length: n}, (_, i) => {
        const angle = -Math.PI / 2 + i * 2 * Math.PI / n;
        return `${r(x + w / 2 + Math.cos(angle) * w / 2)},${r(y + h / 2 + Math.sin(angle) * h / 2)}`;
      }).join(" "));
    } else if (shape === "circle") {
      el.setAttribute("cx", r(x + w / 2)); el.setAttribute("cy", r(y + h / 2)); el.setAttribute("r", r(w / 2));
    } else if (shape === "rect") {
      el.setAttribute("x", r(x)); el.setAttribute("y", r(y)); el.setAttribute("width", r(w)); el.setAttribute("height", r(h));
    } else {
      el.setAttribute("cx", r(x + w / 2)); el.setAttribute("cy", r(y + h / 2));
      el.setAttribute("rx", r(w / 2)); el.setAttribute("ry", r(h / 2));
    }
  }

  onUp(e) {
    this.clearLongPress();
    if (this.palms.delete(e.pointerId)) return;
    if (e.pointerType === "pen") this.penUpAt = performance.now();
    if (this.mediaTools?.onPointerUp?.(e, this.point(e))) return;
    const ptr = this.pointers.get(e.pointerId);
    if (this.gesture?.kind === "pinch" && ptr &&
        Math.hypot(e.clientX - ptr.startX, e.clientY - ptr.startY) >= TAP_PX.touch) {
      this.gesture.tapCandidate = false;
    }
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === "pinch") {
      if (![...this.pointers.values()].some((p) => p.type === "touch")) {
        this.gesture = null;
        this.touchStart = null;
        if (g.tapCandidate && performance.now() - g.started < 450) {
          this.openContextMenu(g.menuPoint.x, g.menuPoint.y, true);
        }
      }
      return;
    }
    if (g.id !== e.pointerId) return;
    this.gesture = null;
    this.smartGuides = [];
    const p = this.point(e);
    switch (g.kind) {
      case "path-node":
        if (g.freehand) { this.endStroke(g); return; }
        if (!g.extend) this.pathDraft.nodes.push(g.node);
        this.pathDraft.hover = null;
        this.pathDraft.lastAt = performance.now();
        this.drawOverlay();
        this.hooks.select(this.selection);
        return;
      case "pan": return;
      case "move": case "resize": case "rotate": case "endpoint": case "node":
        this.commit();
        if (g.kind === "move" && !g.moved && g.additive) {
          if (g.toggle) this.select(this.selection.filter((s) => s !== g.target));
          return;
        }
        if (g.kind === "move" && !g.moved) {
          if (this.selection.length > 1) this.select([g.target]);
          this.tap(e, p, g.target);
        } else if (!g.moved && this.selection.length === 1) {
          this.tap(e, p, this.selection[0]);
        }
        return;
      case "none": return;
      case "erase":
        if (g.removed.length) this.commit(); else if (g.tx && this.tx === g.tx) this.abort();
        return;
      case "marquee": {
        if (!g.moved) { this.tap(e, p, null); this.drawOverlay(); return; }
        const x0 = Math.min(g.start.x, p.x), y0 = Math.min(g.start.y, p.y);
        const x1 = Math.max(g.start.x, p.x), y1 = Math.max(g.start.y, p.y);
        const inside = this.children().filter((el) => {
          const b = rootBox(el, this.svg);
          return b && b.x >= x0 && b.y >= y0 && b.x + b.width <= x1 && b.y + b.height <= y1;
        });
        this.select(g.additive ? [...new Set([...this.selection, ...inside])] : inside);
        return;
      }
      case "create": {
        if (!g.el) {
          // A tap places a default-sized shape.
          this.begin();
          const c = this.snapPoint(p);
          g.el = this.adopt(this.newShape(g.shape));
          const size = ["line", "arrow"].includes(g.shape) ? [240, 0] : [240, 160];
          this.shapeGeometry(g.el, g.shape, { x: c.x - size[0] / 2, y: c.y - size[1] / 2 },
            { x: c.x + size[0] / 2, y: c.y + size[1] / 2 }, false);
        }
        if (g.shape === "arrow") this.refreshArrows(g.el);
        this.selection = [g.el];
        this.commit();
        this.hooks.toolDone?.(this.input);
        return;
      }
      case "text": {
        const target = g.target;
        if (target && this.svg.contains(target) && this.selectable(target)) {
          this.endTextEdit(true);
          if (target.parentNode !== this.context) this.context = target.parentNode;
          this.select([target]);
          this.editText(target, false);
          this.hooks.toolDone?.(this.input);
          return;
        }
        // The undo step starts before the empty text exists, so undoing
        // the finished text removes it completely.
        this.endTextEdit(true);
        this.begin();
        const t = this.newText(this.snapPoint(p));
        this.select([t]);
        this.editText(t, true);
        this.hooks.toolDone?.(this.input);
        return;
      }
      case "draw": {
        if (g.points.length === 1 && !g.pressure) g.points.push([g.points[0][0] + 0.01, g.points[0][1], g.points[0][2]]);
        this.drawInk(g, true);
        this.commit();
        return;
      }
    }
  }

  tap(e, p, el) {
    const now = performance.now();
    const last = this.lastTap;
    this.lastTap = { t: now, x: e.clientX, y: e.clientY, el };
    if (!last || now - last.t > DOUBLE_TAP_MS || Math.hypot(e.clientX - last.x, e.clientY - last.y) > 24) return;
    this.lastTap = null;
    if (!el) { this.exitGroup(); return; }
    if (el.localName === "text") this.editText(el, false);
    else if (el.localName === "g" || el.localName === "a") this.enterGroup(el);
  }

  onCancel(e) {
    this.clearLongPress();
    if (this.palms.delete(e.pointerId)) return;
    if (e.pointerType === "pen") this.penUpAt = performance.now();
    if (this.mediaTools?.onPointerCancel?.(e, this.point(e))) return;
    this.pointers.delete(e.pointerId);
    this.touchStart = null;
    if (this.gesture && (this.gesture.id === e.pointerId || this.gesture.kind === "pinch")) this.cancelGesture();
  }

  penDown() { return [...this.pointers.values()].some((p) => p.type === "pen"); }

  /** The Pencil landed: touches already down were the palm. Undo what they
      started (a stroke, a drag, a pinch, a selection) and ignore them. */
  rejectTouches() {
    const touches = [...this.pointers].filter(([, p]) => p.type === "touch");
    if (!touches.length) return;
    for (const [id] of touches) { this.pointers.delete(id); this.palms.add(id); }
    if (this.gesture && (this.gesture.kind === "pinch" || this.gesture.pointerType === "touch")) this.cancelGesture();
    if (this.touchStart) {
      this.context = this.touchStart.context;
      this.select(this.touchStart.selection.filter((el) => this.svg.contains(el)));
      this.touchStart = null;
    }
  }

  cancelGesture() {
    this.clearLongPress();
    const g = this.gesture;
    this.gesture = null;
    this.smartGuides = [];
    if (!g) return;
    if (g.snaps) this.applyDelta(g.snaps, new DOMMatrix());
    if (g.kind === "endpoint") {
      g.line.setAttribute(`x${g.which}`, g.original[0]);
      g.line.setAttribute(`y${g.which}`, g.original[1]);
    }
    if (g.kind === "node") {
      g.el.setAttribute(g.attr, g.original);
      if (g.types === null) g.el.removeAttribute("data-nodetypes"); else g.el.setAttribute("data-nodetypes", g.types);
    }
    if (g.kind === "draw") g.path.remove();
    if (g.kind === "erase") for (const r of g.removed.reverse()) r.parent.insertBefore(r.el, r.next);
    if (g.kind === "create" && g.el) g.el.remove();
    // Only the undo step this gesture opened: a crop or adjustment in
    // progress keeps its own.
    if (g.tx && this.tx === g.tx) this.abort();
    this.drawOverlay();
  }

  pinchState() {
    const [a, b] = [...this.pointers.values()].filter((p) => p.type === "touch");
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  movePinch() {
    const g = this.gesture;
    const touches = [...this.pointers.values()].filter((p) => p.type === "touch");
    if (touches.some((t) => Math.hypot(t.x - t.startX, t.y - t.startY) >= TAP_PX.touch)) g.tapCandidate = false;
    if (g.tapCandidate || touches.length < 2) return;
    const now = this.pinchState();
    this.pan.x += now.mid.x - g.mid.x;
    this.pan.y += now.mid.y - g.mid.y;
    this.zoomAt(now.mid.x, now.mid.y, g.dist ? now.dist / g.dist : 1);
    g.dist = now.dist;
    g.mid = now.mid;
  }

  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY / 300));
    } else {
      this.pan.x -= e.deltaX;
      this.pan.y -= e.deltaY;
      this.fitMode = false;
      this.layout();
    }
  }

  // --- text ------------------------------------------------------------------------
  /** The text under the pointer, if any: one at the current level, or one
   *  hit directly inside a group (editing it works inside that group). */
  textAt(e, p) {
    const picked = this.pick(e, p);
    if (picked?.localName === "text") return picked;
    const hit = e.target?.closest?.("text");
    if (hit && this.svg.contains(hit) && this.selectable(hit) && (!picked || picked.contains(hit))) return hit;
    return null;
  }

  newText(p) {
    const s = this.hooks.textStyle();
    const t = document.createElementNS(SVGNS, "text");
    t.setAttribute("x", p.x.toFixed(1));
    t.setAttribute("y", p.y.toFixed(1));
    t.style.setProperty("font-family", cssFamily(s.family));
    t.style.setProperty("font-weight", String(s.weight));
    t.style.setProperty("font-size", `${s.size}px`);
    t.style.setProperty("fill", s.fill);
    t.style.setProperty("white-space", "pre");
    this.adopt(t);
    this.hooks.ensureFont?.(s.family);
    return t;
  }

  /** How much a text's own units are scaled on the slide. */
  textScale(t) {
    const m = toRoot(t, this.svg);
    return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  }

  /** A text's lines: the spans that start lines, or the text itself. */
  lineNodes(t) {
    const lines = Array.from(t.children).filter((c) => c.localName === "tspan" &&
      (c.hasAttribute("x") || c.hasAttribute("dy") || c.hasAttribute("y")));
    return lines.length ? lines : [t];
  }

  /** The look of the characters in an element of a text. */
  lookAt(el, stop = null) {
    const cs = getComputedStyle(el);
    return { decoration: decorationOf(el, stop || el.closest("text")), family: cs.fontFamily, weight: String(parseInt(cs.fontWeight, 10) || 400), fontStyle: cs.fontStyle,
             fill: paintColor(cs.fill), size: parseFloat(cs.fontSize) || 16, shift: stop ? shiftOf(el, stop) : 0 };
  }

  /** Each line of a text as runs of equally formatted characters. */
  textRuns(t) {
    return this.lineNodes(t).map((line) => {
      const runs = [];
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        // A blank placed on its own (Inkscape leaves these at line ends) is
        // invisible and does not move the line; joined to it, it would.
        const p = n.parentNode;
        if (p !== line && !n.data.trim() && (p.hasAttribute("x") || p.hasAttribute("y"))) continue;
        // Line breaks inside a line show as spaces (or collapse with them).
        const pre = getComputedStyle(n.parentNode).whiteSpace.startsWith("pre");
        const text = pre ? n.data.replace(/\r/g, "").replace(/\n/g, " ") : n.data.replace(/\s+/g, " ");
        if (text) pushRun(runs, text, this.lookAt(n.parentNode, t));
      }
      return runs;
    });
  }

  /** Edit a text in place. Formatting (bold words, colours, fonts) is kept,
   *  and can be changed on selected words with formatText(). */
  editText(t, isNew) {
    this.endTextEdit(true);
    this.begin();
    const glyph = firstGlyphElement(t);
    const gcs = getComputedStyle(glyph);
    const base = { ...this.lookAt(glyph), letterSpacing: parseFloat(gcs.letterSpacing) || 0,
                   paint: Object.fromEntries(TEXT_PAINT.map((p) => [p, gcs.getPropertyValue(p)])) };
    const box = document.createElement("div");
    box.className = "text-edit";
    box.contentEditable = "true";
    box.spellcheck = true;
    for (const runs of isNew ? [[]] : this.textRuns(t)) {
      const div = document.createElement("div");
      for (const run of runs) div.appendChild(htmlRun(run, base));
      if (!runs.length) div.appendChild(document.createElement("br"));
      box.appendChild(div);
    }
    this.page.appendChild(box);
    const styleAttr = t.getAttribute("style");
    // The text as it was, for Escape: typing is copied into it as it goes.
    const original = t.cloneNode(true);
    t.setAttribute("data-editing", "true");
    t.style.visibility = "hidden";
    this.textEdit = { t, box, isNew, base, styleAttr, original, tx: this.tx, pitch: this.linePitch(t), scale: 1, range: null, holding: false };
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); this.cancelTextEdit(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.endTextEdit(true); }
    });
    box.addEventListener("paste", (e) => {
      // Text from elsewhere comes in plain, in this text's look.
      e.preventDefault();
      document.execCommand("insertText", false, (e.clipboardData?.getData("text/plain") || "").replace(/\r/g, ""));
    });
    box.addEventListener("input", () => { this.textEdit.changed = true; this.syncTextEdit(); this.positionTextEdit(); });
    box.addEventListener("focus", () => { if (this.textEdit) this.textEdit.holding = false; });
    // Leaving the box ends the edit, except for a trip to the panel's
    // formatting buttons (they set `holding`).
    box.addEventListener("blur", () => setTimeout(() => {
      const te = this.textEdit;
      if (te?.box === box && !te.holding && document.activeElement !== box) this.endTextEdit(true);
    }, 0));
    this.positionTextEdit();
    box.focus();
    try { document.execCommand("styleWithCSS", false, true); } catch (e) { /* old engines: <b> tags, read the same */ }
    const range = document.createRange();
    range.selectNodeContents(box);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    this.drawOverlay();
    this.hooks.select(this.selection);
  }

  /** Bold, italic or a colour for the selected words while editing; with
   *  nothing selected, for the whole text. */
  formatText(command, value) {
    const te = this.textEdit;
    if (!te) return;
    te.box.focus();
    const sel = getSelection();
    if (te.range && te.box.contains(te.range.startContainer)) { sel.removeAllRanges(); sel.addRange(te.range); }
    const whole = sel.isCollapsed || !te.box.contains(sel.anchorNode);
    if (whole) {
      const r = document.createRange();
      r.selectNodeContents(te.box);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    document.execCommand("styleWithCSS", false, true);
    document.execCommand(command, false, value);
    if (whole) sel.collapseToEnd();
    te.changed = true;
    this.syncTextEdit();
    this.positionTextEdit();
  }

  /** Copy the active HTML editor into the SVG without closing it. This keeps
   *  autosave and unload protection current while leaving the DOM selection
   *  (and the one undo transaction opened by editText) alone. */
  syncTextEdit() {
    const te = this.textEdit;
    if (!te?.changed) return;
    const lines = this.readRuns(te.box, te.scale);
    while (lines.length && !lines[lines.length - 1].some((r) => r.text.trim())) lines.pop();
    if (lines.length) this.setTextRuns(te.t, lines, te.base, te.pitch);
    else te.t.replaceChildren();
    te.changed = false;
    te.materialized = true;
    this.hooks.textChanged?.(this.serialize());
  }

  /** Distance between lines of a text, in its own units (null if one line). */
  linePitch(t) {
    const ys = this.lineSpans(t).map((l) => parseFloat(l.getAttribute("y"))).filter((y) => !Number.isNaN(y));
    return ys.length > 1 ? (ys[ys.length - 1] - ys[0]) / (ys.length - 1) : null;
  }

  positionTextEdit() {
    const te = this.textEdit;
    if (!te) return;
    const { t, box, base } = te;
    const m = toRoot(t, this.svg);
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) * this.zoom;
    te.scale = scale;
    const size = base.size * scale;
    const pitch = te.pitch ? te.pitch * scale : size * 1.25;
    const nodes = this.lineNodes(t);
    const first = nodes[0] !== t ? nodes[0] : null;
    const x0 = parseFloat(first?.getAttribute("x") ?? t.getAttribute("x")) || 0;
    const y0 = parseFloat(first?.getAttribute("y") ?? t.getAttribute("y")) || 0;
    const anchor = m.transformPoint(new DOMPoint(x0, y0));
    const align = getComputedStyle(firstGlyphElement(t)).textAnchor;
    // The box grows with its text; it hangs off the anchor like the text does.
    Object.assign(box.style, {
      left: `${anchor.x * this.zoom}px`, top: `${anchor.y * this.zoom - size * 0.95 - 3}px`,
      transform: { middle: "translateX(-50%)", end: "translateX(-100%)" }[align] || "none",
      marginLeft: { middle: "0", end: "6px" }[align] || "-6px",
      fontFamily: base.family, fontWeight: base.weight, fontStyle: base.fontStyle,
      fontSize: `${size}px`, lineHeight: `${pitch}px`, letterSpacing: `${base.letterSpacing * scale}px`,
      color: paintColor(base.fill) || "#000",
      textAlign: { middle: "center", end: "right" }[align] || "left",
      minWidth: `${size * 2}px`,
    });
  }

  /** The edit box's lines as runs, read back from what the browser shows. */
  readRuns(box, scale) {
    const lines = [[]];
    let atStart = true, fromBlock = false;
    const newLine = (block) => { lines.push([]); atStart = true; fromBlock = block; };
    const add = (text, el) => {
      if (!text) return;
      const cs = getComputedStyle(el);
      pushRun(lines[lines.length - 1], text, { decoration: decorationOf(el,box), family: cs.fontFamily, weight: String(parseInt(cs.fontWeight, 10) || 400),
        fontStyle: cs.fontStyle, fill: paintColor(cs.color) || "#000000", size: (parseFloat(cs.fontSize) || 16) / scale,
        shift: shiftOf(el, box, scale) });
      atStart = false;
      fromBlock = false;
    };
    const visit = (node) => {
      for (const n of node.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) {
          n.data.replace(/\r/g, "").replace(/ /g, " ").split("\n").forEach((part, i) => {
            if (i) newLine(false);
            add(part, n.parentNode);
          });
        } else if (n.nodeType !== Node.ELEMENT_NODE) {
          continue;
        } else if (n.localName === "br") {
          // A <br> closing a line is a placeholder, not an extra line.
          if (n.nextSibling || !(n.parentNode === box || BLOCKS.has(n.parentNode.localName))) newLine(false);
        } else if (BLOCKS.has(n.localName)) {
          if (!atStart) newLine(true);
          visit(n);
          newLine(true);
        } else {
          visit(n);
        }
      }
    };
    visit(box);
    if (fromBlock && !lines[lines.length - 1].length) lines.pop();
    return lines;
  }

  /** Leave the text edit without keeping it (Escape): the text goes back to
   *  what it was when the edit began, a new one is removed, and no undo step
   *  is recorded. The working copy is told, since typing was synced into it. */
  cancelTextEdit() {
    if (!this.textEdit) return;
    this.endTextEdit(false);
    this.hooks.textChanged?.(this.serialize());
  }

  /** Finish the text edit: save (an undo step) or put the text back as it
   *  was (see cancelTextEdit; load() uses this without telling anyone). */
  endTextEdit(save) {
    const te = this.textEdit;
    if (!te) return;
    const { t, box, isNew, base } = te;
    const lines = save ? this.readRuns(box, te.scale) : null;
    this.textEdit = null;
    box.remove();
    t.removeAttribute("data-editing");
    // Put the style back exactly as written, so looking is not an edit.
    if (te.styleAttr === null) t.removeAttribute("style"); else t.setAttribute("style", te.styleAttr);
    if (!save) {
      if (isNew) {
        t.remove();
        this.selection = this.selection.filter((el) => el !== t);
      } else if (te.materialized) {
        for (const a of Array.from(t.attributes)) t.removeAttributeNS(a.namespaceURI, a.localName);
        for (const a of Array.from(te.original.attributes)) t.setAttributeNS(a.namespaceURI, a.name, a.value);
        t.replaceChildren(...te.original.childNodes);
      }
      // Only the undo step this edit opened (or joined from a new text).
      if (te.tx && this.tx === te.tx) this.abort();
      this.drawOverlay();
      this.hooks.select(this.selection);
      return;
    }
    const trim = (ls) => { while (ls.length && !ls[ls.length - 1].some((r) => r.text.trim())) ls.pop(); return ls; };
    trim(lines);
    if (!lines.length) {
      t.remove();
      this.selection = this.selection.filter((el) => el !== t);
      if (isNew) {
        this.abort();
        this.hooks.textChanged?.(this.serialize());
        this.drawOverlay();
        this.hooks.select(this.selection);
        return;
      }
      this.commit();
      return;
    }
    if (!isNew && !te.materialized && sameRuns(lines, trim(this.textRuns(t)))) { this.commit(); return; }
    this.setTextRuns(t, lines, base, te.pitch);
    this.commit();
  }

  /** Rewrite a text from lines of runs: the first character's look goes on
   *  the text, words that differ get a span saying how. */
  setTextRuns(t, lines, base, pitch) {
    const nodes = this.lineNodes(t);
    const first = nodes[0] !== t ? nodes[0] : null;
    const x = first?.getAttribute("x") ?? t.getAttribute("x") ?? "0";
    const y0 = parseFloat(first?.getAttribute("y") ?? t.getAttribute("y") ?? "0") || 0;
    const anchor = getComputedStyle(firstGlyphElement(t)).textAnchor;
    // Decorations propagate visually through descendants even when set to none.
    // Keep them on individual runs so later words can remain undecorated.
    t.style.removeProperty("text-decoration");
    t.style.setProperty("text-decoration-line", "none");
    t.removeAttribute("text-decoration");
    t.removeAttribute("text-decoration-line");
    t.style.setProperty("font-family", base.family);
    t.style.setProperty("font-size", `${+base.size.toFixed(4)}px`);
    t.style.setProperty("font-weight", base.weight);
    t.style.setProperty("font-style", base.fontStyle);
    if (paintColor(base.fill)) t.style.setProperty("fill", paintColor(base.fill));
    t.style.setProperty("text-anchor", anchor);
    for (const p of ["font-family", "font-size", "font-weight", "font-style", "fill", "text-anchor"]) t.removeAttribute(p);
    const tcs = getComputedStyle(t);
    for (const [p, v] of Object.entries(base.paint || {})) {
      if (v && tcs.getPropertyValue(p) !== v) { t.style.setProperty(p, v); t.removeAttribute(p); }
    }
    const step = pitch || base.size * 1.25;
    // Lines that existed keep their own place; new ones continue the spacing.
    const old = (first ? nodes : []).map((l) => [l.getAttribute("x")?.trim().split(/[\s,]+/)[0] ?? null, parseFloat(l.getAttribute("y"))]);
    const place = (i) => {
      if (i < old.length && old[i][0] !== null && !Number.isNaN(old[i][1])) return old[i];
      const k = old.findLastIndex((o) => !Number.isNaN(o[1]));
      return k >= 0 && i > k ? [x, old[k][1] + (i - k) * step] : [x, y0 + i * step];
    };
    const dys = (first ? nodes : []).map((l) => l.getAttribute("dy"));
    t.replaceChildren();
    t.setAttribute("x", x);
    t.setAttribute("y", String(y0));
    lines.forEach((runs, i) => {
      const line = document.createElementNS(SVGNS, "tspan");
      const [lx, ly] = place(i);
      line.setAttribute("x", lx);
      line.setAttribute("y", String(+ly.toFixed(3)));
      const dy = i < old.length && dys[i];
      if (dy) line.setAttribute("dy", dy);
      if (!runs.length) line.textContent = " ";
      for (const run of runs) {
        const diff = lookDiff(run.look, {...base, decoration:"none"});
        if (!diff.length) { line.append(run.text); continue; }
        const span = document.createElementNS(SVGNS, "tspan");
        for (const [prop, v] of diff) span.style.setProperty(prop, v);
        span.textContent = run.text;
        line.append(span);
      }
      t.appendChild(line);
    });
  }

  // --- operations on the selection -------------------------------------------------
  deleteSelection() {
    if (!this.selection.length) return;
    this.change(() => { for (const el of this.selection) el.remove(); this.selection = []; });
  }

  duplicate() {
    if (!this.selection.length) return;
    this.change(() => {
      const copies = this.selection.map((el) => el.cloneNode(true));
      this.remapIds(copies);
      this.selection.forEach((el, i) => {
        const c = copies[i];
        el.after(c);
      });
      this.selection = copies;
      this.applyDelta(this.snapshot(), new DOMMatrix().translateSelf(24, 24));
    });
  }

  /** Rename ids and references in several objects with one shared mapping. */
  remapIds(roots) {
    const used = new Set(Array.from(this.svg.querySelectorAll("[id]"), (el) => el.id));
    const map = new Map();
    for (const n of roots.flatMap((root) => [root, ...root.querySelectorAll("[id]")])) {
      if (!n.id || map.has(n.id)) continue;
      const base = n.id;
      let id;
      do { id = `${base}-copy-${Math.random().toString(36).slice(2, 7)}`; } while (used.has(id));
      used.add(id);
      map.set(base, id);
    }
    for (const root of roots) {
      for (const n of [root, ...root.querySelectorAll("*")]) {
        if (n.id && map.has(n.id)) n.id = map.get(n.id);
        for (const attr of Array.from(n.attributes)) {
          let v = attr.value;
          if (attr.localName === "href" && v.startsWith("#") && map.has(v.slice(1))) v = "#" + map.get(v.slice(1));
          else if (attr.localName === "data-svgdeck-clip" && map.has(v)) v = map.get(v);
          else if (v.includes("url(")) v = v.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g,
            (match, quote, id) => map.has(id) ? `url(#${map.get(id)})` : match);
          if (v !== attr.value) n.setAttributeNS(attr.namespaceURI, attr.name, v);
        }
      }
    }
    return roots;
  }

  order(where) {
    if (!this.selection.length) return;
    this.change(() => {
      const kids = () => Array.from(this.context.children);
      const floor = () => {
        // Keep defs and locked backdrops at the back.
        let i = 0;
        const k = kids();
        while (i < k.length && (SKIP.has(k[i].localName) || k[i].getAttribute("data-locked") === "true")) i++;
        return k[i] || null;
      };
      const sel = kids().filter((el) => this.selection.includes(el));
      if (where === "front") sel.forEach((el) => this.context.appendChild(el));
      if (where === "back") { const f = floor(); sel.forEach((el) => this.context.insertBefore(el, f)); }
      if (where === "forward") {
        for (const el of sel.reverse()) {
          let next = el.nextElementSibling;
          while (next && this.selection.includes(next)) next = next.nextElementSibling;
          if (next) next.after(el);
        }
      }
      if (where === "backward") {
        for (const el of sel) {
          let prev = el.previousElementSibling;
          while (prev && this.selection.includes(prev)) prev = prev.previousElementSibling;
          if (prev && !SKIP.has(prev.localName) && prev.getAttribute("data-locked") !== "true") prev.before(el);
        }
      }
    });
  }

  group() {
    if (this.selection.length < 2) return;
    if (this.selection.some(hasMovie)) {
      this.hooks.toast("Movies cannot be grouped because grouped movies do not play in presentations.");
      return;
    }
    this.change(() => {
      const sel = Array.from(this.context.children).filter((el) => this.selection.includes(el));
      const g = document.createElementNS(SVGNS, "g");
      sel[sel.length - 1].after(g);
      sel.forEach((el) => g.appendChild(el));
      this.selection = [g];
    });
  }

  ungroup() {
    const groups = this.selection.filter((el) => el.localName === "g");
    if (!groups.length) return;
    for (const g of groups) {
      const groupStyle = getComputedStyle(g);
      const opacity = parseFloat(groupStyle.opacity);
      if (["clip-path", "mask", "filter"].some((a) => {
        const value = groupStyle.getPropertyValue(a);
        return value && value !== "none";
      }) ||
          opacity !== 1) {
        this.hooks.toast("This group has clipping or effects; ungrouping would change how it looks.");
        return;
      }
    }
    this.change(() => {
      const released = [];
      for (const g of groups) {
        const T = localMatrix(g);
        // Compare with the actual new parent. A sibling <g> probe would also
        // match group-specific CSS and hide styles lost when removing a group.
        const groupStyle = getComputedStyle(g), parentStyle = getComputedStyle(g.parentNode);
        const inherited = Array.from(INHERITED_PRESENTATION)
          .map((p) => [p, groupStyle.getPropertyValue(p)])
          .filter(([p, value]) => value && value !== parentStyle.getPropertyValue(p));
        for (const child of Array.from(g.children)) {
          if (child.nodeType === 1 && !SKIP.has(child.localName)) {
            const computed = getComputedStyle(child);
            const childValues = new Map(inherited.map(([p]) => [p, computed.getPropertyValue(p)]));
            setTransform(child, T.multiply(localMatrix(child)));
            for (const [p] of inherited) {
              // Freeze the resolved child value: a relative child override
              // (for example 2em inside a 2em group) also changes on reparent.
              child.style.setProperty(p, childValues.get(p));
            }
            released.push(child);
          }
          g.before(child);
        }
        g.remove();
      }
      this.selection = released;
    });
  }

  selectAll() {
    this.select(this.children());
  }

  /** Move one object by (dx, dy) in slide coordinates. */
  shift(el, dx, dy) {
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return;
    const saved = this.selection;
    this.selection = [el];
    this.applyDelta(this.snapshot(), new DOMMatrix().translateSelf(dx, dy));
    this.selection = saved;
  }

  /** Line objects up by their edges or centres: several objects with each
   *  other, a single one with the slide. */
  align(how, toSlide = false) {
    const items = this.selection.map((el) => ({ el, b: rootBox(el, this.svg) })).filter((i) => i.b);
    if (!items.length) return;
    const r = items.length > 1 && !toSlide ? unionBox(items.map((i) => i.b)) : { x: 0, y: 0, width: this.size[0], height: this.size[1] };
    this.change(() => {
      for (const { el, b } of items) {
        const dx = { left: r.x - b.x, centre: r.x + r.width / 2 - b.x - b.width / 2, right: r.x + r.width - b.x - b.width }[how] ?? 0;
        const dy = { top: r.y - b.y, middle: r.y + r.height / 2 - b.y - b.height / 2, bottom: r.y + r.height - b.y - b.height }[how] ?? 0;
        this.shift(el, dx, dy);
      }
    });
  }

  /** Space three or more objects evenly between the outermost ones. */
  distribute(axis) {
    const [pos, len] = axis === "x" ? ["x", "width"] : ["y", "height"];
    const items = this.selection.map((el) => ({ el, b: rootBox(el, this.svg) })).filter((i) => i.b)
      .sort((a, b) => a.b[pos] + a.b[len] / 2 - (b.b[pos] + b.b[len] / 2));
    if (items.length < 3) return;
    const first = items[0].b, last = items[items.length - 1].b;
    const total = items.reduce((s, i) => s + i.b[len], 0);
    const gap = (last[pos] + last[len] - first[pos] - total) / (items.length - 1);
    this.change(() => {
      let at = first[pos];
      for (const { el, b } of items) {
        this.shift(el, axis === "x" ? at - b.x : 0, axis === "y" ? at - b.y : 0);
        at += b[len] + gap;
      }
    });
  }

  /** Turn the selection as one piece around the centre of its box. */
  rotateBy(deg) {
    const box = this.selectionBox();
    if (!box) return;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    this.change(() => this.applyDelta(this.snapshot(), new DOMMatrix().translateSelf(cx, cy).rotateSelf(deg).translateSelf(-cx, -cy)));
  }

  /** Mirror the selection as one piece: "x" flips left–right, "y" top–bottom. */
  flip(axis) {
    const box = this.selectionBox();
    if (!box) return;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const [sx, sy] = axis === "x" ? [-1, 1] : [1, -1];
    this.change(() => this.applyDelta(this.snapshot(), new DOMMatrix().translateSelf(cx, cy).scaleSelf(sx, sy).translateSelf(-cx, -cy)));
  }

  /** An object's rotation on the slide in degrees, -180 to 180. */
  angleOf(el) {
    const m = toRoot(el, this.svg);
    const flipped = m.a * m.d - m.b * m.c < 0;
    // A mirrored object reads its angle from the unmirrored y axis.
    const deg = flipped ? Math.atan2(-m.c, m.d) * 180 / Math.PI : Math.atan2(m.b, m.a) * 180 / Math.PI;
    return Math.abs(deg) < 1e-6 ? 0 : deg;
  }

  /** Turn each selected object around its own centre to the given angle. */
  setAngle(deg) {
    const snaps = this.snapshot();
    this.change(() => {
      for (const s of snaps) {
        const b = rootBox(s.el, this.svg);
        if (!b) continue;
        const d = deg - this.angleOf(s.el);
        if (Math.abs(d) < 0.01) continue;  // transforms are stored to six decimals
        const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
        this.applyDelta([s], new DOMMatrix().translateSelf(cx, cy).rotateSelf(d).translateSelf(-cx, -cy));
      }
    });
  }

  lock() {
    this.change(() => { for (const el of this.selection) el.setAttribute("data-locked", "true"); this.selection = []; });
  }

  unlockAll() {
    this.change(() => {
      for (const el of this.svg.querySelectorAll("[data-locked]")) {
        if (el.getAttribute("data-label") !== "background") el.removeAttribute("data-locked");
      }
    });
  }

  // --- styles ------------------------------------------------------------------------
  /** Set a presentation property on the selection; groups and texts pass it on
   *  to descendants that set it themselves. */
  setStyle(prop, value, elements = this.selection) {
    if (!elements.length) return;
    this.change(() => {
      for (const el of elements) this.applyStyle(el, prop, value);
      if (prop === "stroke" || prop === "stroke-width") this.recolorMarkers(elements);
    });
  }

  applyStyle(el, prop, value) {
    if (el.localName === "text") { this.applyTextStyle(el, prop, value); return; }
    el.style.setProperty(prop, value);
    el.removeAttribute(prop);
    if (el.localName === "g" || el.localName === "text" || el.localName === "a") {
      for (const d of el.querySelectorAll("*")) {
        if (d.style.getPropertyValue(prop) || d.hasAttribute(prop)) {
          d.style.setProperty(prop, value);
          d.removeAttribute(prop);
        }
      }
    }
  }

  /** Change a text's look where it matches its first character. Words
   *  formatted differently (bold, another colour) keep their look; sizes all
   *  scale together. */
  applyTextStyle(t, prop, value) {
    if (prop === "text-decoration-line") {
      for (const node of [t, ...t.querySelectorAll("*")]) {
        node.style.removeProperty("text-decoration");
        node.removeAttribute("text-decoration");
        node.removeAttribute(prop);
        node.style.setProperty(prop, node === t ? value : "none");
      }
      return;
    }
    const old = getComputedStyle(firstGlyphElement(t)).getPropertyValue(prop);
    const ratio = prop === "font-size" ? parseFloat(value) / (parseFloat(old) || 1) : null;
    const inner = Array.from(t.querySelectorAll("*"))
      .filter((d) => d.style.getPropertyValue(prop) || d.hasAttribute(prop))
      .map((d) => [d, getComputedStyle(d).getPropertyValue(prop)]);
    const own = getComputedStyle(t).getPropertyValue(prop);
    t.style.setProperty(prop, ratio ? `${+(parseFloat(own) * ratio).toFixed(4)}px` : value);
    t.removeAttribute(prop);
    for (const [d, v] of inner) {
      if (!ratio && v !== old) continue;
      d.style.setProperty(prop, ratio ? `${+(parseFloat(v) * ratio).toFixed(4)}px` : value);
      d.removeAttribute(prop);
    }
  }

  /** Uniform scale of an element's user space on the slide. */
  scaleOf(el) {
    const m = toRoot(el, this.svg);
    return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  }

  /** Stroke width as drawn on the slide, in slide pixels. */
  strokeWidthOf(el) {
    return (parseFloat(getComputedStyle(el).strokeWidth) || 0) * this.scaleOf(el);
  }

  /** Arrowhead marker for a colour and a size (as a multiple of the stroke
   *  width). Thin lines get proportionally bigger heads so they stay visible. */
  ensureMarker(color, ratio = 3.5) {
    const paint = paintColor(color) || "#000000";
    const id = `arrow-${paint.replace(/[^a-z0-9]+/gi, "_")}-${String(ratio).replace(".", "_")}`;
    if (this.svg.querySelector(`#${CSS.escape(id)}`)) return id;
    let defs = this.svg.querySelector(":scope > defs");
    if (!defs) { defs = document.createElementNS(SVGNS, "defs"); this.svg.prepend(defs); }
    const marker = document.createElementNS(SVGNS, "marker");
    for (const [k, v] of Object.entries({ id, viewBox: "0 0 10 10", refX: "6", refY: "5", markerWidth: String(ratio),
      markerHeight: String(ratio), orient: "auto-start-reverse", "data-label": "arrowhead" })) marker.setAttribute(k, v);
    const tip = document.createElementNS(SVGNS, "path");
    tip.setAttribute("d", "M0,0 L10,5 L0,10 z");
    tip.setAttribute("fill", paint);
    marker.appendChild(tip);
    defs.appendChild(marker);
    return id;
  }

  arrowRatio(el) {
    const w = this.strokeWidthOf(el) || 1;
    const length = Math.max(3.5 * w, 16);  // slide pixels
    return Math.min(16, Math.round((length / w) * 2) / 2);
  }

  /** Point the element's arrowheads at markers matching its colour and width. */
  refreshArrows(el) {
    for (const end of ["start", "end"]) {
      const v = el.style.getPropertyValue(`marker-${end}`) || el.getAttribute(`marker-${end}`) || "";
      if (!v.includes("arrow-")) continue;
      el.removeAttribute(`marker-${end}`);
      el.style.setProperty(`marker-${end}`, `url(#${this.ensureMarker(getComputedStyle(el).stroke, this.arrowRatio(el))})`);
    }
  }

  recolorMarkers(elements) {
    for (const el of elements) this.refreshArrows(el);
  }

  hasArrow(el, end) {
    const v = el.style.getPropertyValue(`marker-${end}`) || el.getAttribute(`marker-${end}`) || "";
    return v !== "" && v !== "none";
  }

  setArrow(end, on) {
    const lines = this.selection.filter((el) => ["line", "path", "polyline"].includes(el.localName));
    if (!lines.length) return;
    this.change(() => {
      for (const el of lines) {
        el.removeAttribute(`marker-${end}`);
        if (on) el.style.setProperty(`marker-${end}`, `url(#${this.ensureMarker(getComputedStyle(el).stroke, this.arrowRatio(el))})`);
        else el.style.removeProperty(`marker-${end}`);
      }
    });
  }

  setAttr(name, value, elements = this.selection) {
    this.change(() => {
      for (const el of elements) {
        if (value === null) el.removeAttribute(name); else el.setAttribute(name, value);
      }
    });
  }

  /** Align the lines of each text inside its current box (left, centre or
   *  right) without moving the box. */
  setAlign(anchor, texts) {
    this.change(() => {
      for (const t of texts) {
        let b;
        try { b = t.getBBox(); } catch (e) { continue; }
        if (!b.width && !b.height) continue;
        const x = { start: b.x, middle: b.x + b.width / 2, end: b.x + b.width }[anchor];
        for (const span of t.querySelectorAll("tspan")) {
          span.style.removeProperty("text-anchor");
          span.removeAttribute("text-anchor");
        }
        t.style.setProperty("text-anchor", anchor);
        t.removeAttribute("text-anchor");
        const lines = this.lineSpans(t);
        for (const node of lines.length ? lines : [t]) {
          node.setAttribute("x", String(+x.toFixed(3)));
          node.removeAttribute("dx");
        }
        if (lines.length && t.hasAttribute("x")) t.setAttribute("x", String(+x.toFixed(3)));
      }
    });
  }

  /** The spans that start lines (they carry their own x). */
  lineSpans(t) {
    return Array.from(t.children).filter((c) => c.localName === "tspan" && c.hasAttribute("x"));
  }

  // --- inserting ---------------------------------------------------------------------
  visibleCenter() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const x = (w / 2 - this.pan.x) / this.zoom, y = (h / 2 - this.pan.y) / this.zoom;
    return { x: Math.max(0, Math.min(this.size[0], x)), y: Math.max(0, Math.min(this.size[1], y)) };
  }

  insertMedia(info, center = null) {
    const [W, H] = this.size;
    const scale = Math.min(1, (W * 0.6) / info.width, (H * 0.6) / info.height);
    const w = info.width * scale, h = info.height * scale;
    const c = center || this.visibleCenter();
    const img = document.createElementNS(SVGNS, "image");
    img.setAttribute("href", this.hooks.hrefIn(info.href));
    for (const [k, v] of Object.entries({ x: c.x - w / 2, y: c.y - h / 2, width: w, height: h })) img.setAttribute(k, String(+v.toFixed(1)));
    img.setAttribute("preserveAspectRatio", "xMidYMid meet");
    if (info.kind === "video") {
      img.setAttribute("data-video", this.hooks.hrefIn(info.video));
      img.setAttribute("data-autoplay", "true");
      img.setAttribute("data-loop", "true");
      img.setAttribute("data-label", "movie");
    }
    this.change(() => {
      // Uploads have a stable insertion context even if the user enters or
      // leaves a group while conversion is in progress.
      this.context = this.svg;
      this.svg.appendChild(img);
      this.selection = [img];
    });
  }

  /** Insert uploaded media into serialized SVG without disturbing this editor. */
  insertMediaInText(text, info, center) {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const svg = doc.documentElement;
    if (doc.querySelector("parsererror") || svg.localName !== "svg") throw new Error("this slide is not valid SVG");
    const vb = (svg.getAttribute("viewBox") || "0 0 1920 1080").split(/[\s,]+/).map(Number);
    const W = vb[2] || 1920, H = vb[3] || 1080;
    const scale = Math.min(1, (W * 0.6) / info.width, (H * 0.6) / info.height);
    const w = info.width * scale, h = info.height * scale;
    const c = center || { x: vb[0] + W / 2, y: vb[1] + H / 2 };
    const img = doc.createElementNS(SVGNS, "image");
    img.setAttribute("href", this.hooks.hrefOut(info.href));
    for (const [k, v] of Object.entries({ x: c.x - w / 2, y: c.y - h / 2, width: w, height: h })) img.setAttribute(k, String(+v.toFixed(1)));
    img.setAttribute("preserveAspectRatio", "xMidYMid meet");
    if (info.kind === "video") {
      img.setAttribute("data-video", this.hooks.hrefOut(info.video));
      img.setAttribute("data-autoplay", "true");
      img.setAttribute("data-loop", "true");
      img.setAttribute("data-label", "movie");
    }
    svg.appendChild(img);
    return '<?xml version="1.0" encoding="utf-8"?>\n' + new XMLSerializer().serializeToString(svg) + "\n";
  }

  /** Elements as standalone SVG markup, with the defs they reference. */
  copy() {
    if (!this.selection.length) return null;
    const ids = new Set();
    const collect = (node) => {
      for (const n of [node, ...node.querySelectorAll("*")]) {
        for (const attr of Array.from(n.attributes)) {
          if (attr.localName === "href" && attr.value.startsWith("#")) ids.add(attr.value.slice(1));
          for (const m of attr.value.matchAll(/url\(\s*['"]?#([^'")\s]+)/g)) ids.add(m[1]);
        }
      }
    };
    const items = this.selection.map((el) => {
      const c = this.inertClone(el);
      setTransform(c, toRoot(el.parentNode, this.svg).multiply(localMatrix(el)));
      collect(c);
      return c;
    });
    const defs = [];
    const seen = new Set();
    while ([...ids].some((i) => !seen.has(i))) {
      const id = [...ids].find((i) => !seen.has(i));
      seen.add(id);
      const def = this.svg.querySelector(`defs #${CSS.escape(id)}`) || this.svg.getElementById?.(id);
      if (def && !this.selection.some((s) => s === def || s.contains(def))) { const c = this.inertClone(def); defs.push(c); collect(c); }
    }
    const ser = new XMLSerializer();
    const out = (n) => { const c = this.inertClone(n); this.rewriteRefs(c, this.hooks.hrefOut); for (const d of c.querySelectorAll("[href],[data-video]")) this.rewriteRefs(d, this.hooks.hrefOut); return ser.serializeToString(c); };
    return JSON.stringify({ svgdeck: 1, defs: defs.map(out), items: items.map(out) });
  }

  paste(data) {
    let clip;
    try { clip = JSON.parse(data); } catch (e) { return false; }
    if (!clip || clip.svgdeck !== 1) return false;
    const parse = (s) => {
      const doc = new DOMParser().parseFromString(`<svg xmlns="${SVGNS}">${s}</svg>`, "image/svg+xml");
      const parsed = doc.documentElement.firstElementChild;
      this.rewriteRefs(parsed, this.hooks.hrefIn);
      for (const d of parsed.querySelectorAll("[href],[data-video]")) this.rewriteRefs(d, this.hooks.hrefIn);
      return document.importNode(parsed, true);
    };
    const pastedDefs = clip.defs.map(parse);
    const pastedItems = clip.items.map(parse);
    if (this.context !== this.svg && pastedItems.some(hasMovie)) {
      this.hooks.toast("Movies cannot be pasted into groups because grouped movies do not play in presentations.");
      return true;
    }

    // Clipboard ids are slide-local. Rename definitions and items as one unit,
    // so collisions and references between separately copied objects are safe.
    this.remapIds([...pastedDefs, ...pastedItems]);

    this.change(() => {
      let defs = this.svg.querySelector(":scope > defs");
      if (!defs) { defs = document.createElementNS(SVGNS, "defs"); this.svg.prepend(defs); }
      for (const d of pastedDefs) defs.appendChild(d);
      const P = toRoot(this.context, this.svg).inverse();
      const pasted = pastedItems.map((el) => {
        setTransform(el, P.multiply(localMatrix(el)));
        this.context.appendChild(el);
        return el;
      });
      this.selection = pasted;
      this.applyDelta(this.snapshot(), new DOMMatrix().translateSelf(24, 24));
    });
    return true;
  }
}
