// The slide canvas: shows one slide SVG and edits it in place.
// Pointer events throughout, so mouse, finger and Apple Pencil share one path.
import {
  SVGNS, localMatrix, setTransform, toRoot, rootBox, unionBox, simplify, smoothPath, polylinePath, toHex,
} from "./geom.js";

const HANDLE_PX = { mouse: 12, pen: 14, touch: 24 };  // handle hit radius, screen pixels
const ROTATE_OFFSET_PX = 40;   // rotate handle distance above the box
const TAP_PX = { mouse: 5, pen: 8, touch: 14 };      // movement below this is a tap
const DOUBLE_TAP_MS = 350;
const BAKEABLE = new Set(["rect", "image", "ellipse", "circle", "line"]);
const SKIP = new Set(["defs", "title", "desc", "metadata", "style", "script"]);
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
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
    (toHex(a.fill) || a.fill) === (toHex(b.fill) || b.fill) && Math.abs(a.size / b.size - 1) < 0.01 &&
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
  if ((toHex(look.fill) || look.fill) !== (toHex(base.fill) || base.fill)) diff.push(["fill", toHex(look.fill) || look.fill]);
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
    this.tool = "select";
    this.selection = [];
    this.context = null;
    this.gesture = null;
    this.pointers = new Map();
    this.touchStart = null;
    this.lastTap = null;
    this.textEdit = null;
    this.before = null;
    this.grid = { show: false, snap: false, size: 20 };  // slide pixels
    this.additive = false;  // taps add to the selection (touch has no Shift)

    host.addEventListener("pointerdown", (e) => this.onDown(e));
    host.addEventListener("pointermove", (e) => this.onMove(e));
    host.addEventListener("pointerup", (e) => this.onUp(e));
    host.addEventListener("pointercancel", (e) => this.onCancel(e));
    host.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    host.addEventListener("contextmenu", (e) => {
      if (e.target.closest?.(".text-edit")) return;
      e.preventDefault();
      this.openContextMenu(e.clientX, e.clientY);
    });
    // Remember the selected words while the panel is used to format them.
    document.addEventListener("selectionchange", () => {
      const te = this.textEdit, sel = getSelection();
      if (te && sel.rangeCount && te.box.contains(sel.anchorNode)) te.range = sel.getRangeAt(0).cloneRange();
    });
    new ResizeObserver(() => { if (this.fitMode) this.fit(); else this.layout(); }).observe(host);
  }

  // --- loading and saving --------------------------------------------------
  load(text, { keepView = false } = {}) {
    this.pathDraft = null;
    this.endTextEdit(false);
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

  begin() {
    if (this.before === null) this.before = this.serialize();
  }

  commit() {
    if (this.before === null) return;
    const before = this.before;
    this.before = null;
    const after = this.serialize();
    if (after !== before) this.hooks.commit(before, after);
    this.drawOverlay();
    this.hooks.select(this.selection);
  }

  /** Run a change as one undoable step. */
  change(fn) {
    this.begin();
    try { fn(); } finally { this.commit(); }
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
    return el && el.nodeType === 1 && !SKIP.has(el.localName) && el.getAttribute("data-locked") !== "true"
      && getComputedStyle(el).display !== "none";
  }

  children() {
    return Array.from(this.context.children).filter((el) => this.selectable(el));
  }

  select(elements) {
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
    if (!this.selection.length || this.tool !== "select") return null;
    const radius = HANDLE_PX[pointerType] || HANDLE_PX.mouse;
    const line = this.lineMode();
    if (line) {
      const ends = this.lineEnds(line);
      const d = ends.map((q) => Math.hypot(p.x - q.x, p.y - q.y));
      const i = d[0] <= d[1] ? 0 : 1;
      return d[i] <= radius / this.zoom ? (i ? "end2" : "end1") : null;
    }
    const box = this.selectionBox();
    if (!box) return null;
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
    if (this.grid.show) this.drawGrid(o);
    const px = 1 / this.zoom;
    const make = (tag, attrs) => {
      const el = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      o.appendChild(el);
      return el;
    };
    if (this.pathDraft) {
      const draft = this.pathDraft;
      const nodes = [...draft.nodes];
      if (this.gesture?.kind === "path-node") nodes.push(this.gesture.node);
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
    if (this.tool === "nodes" && this.selection.length === 1) {
      const el = this.selection[0], nodes = this.editableNodes(el);
      if (nodes) {
        const points = nodes.points.map(p => toRoot(el, this.svg).transformPoint(new DOMPoint(p.x, p.y)));
        if (nodes.curve) for (let i = 0; i < points.length - 1; i++) {
          if (i % 3 === 1) continue;
          make("line", {x1: points[i].x, y1: points[i].y, x2: points[i+1].x, y2: points[i+1].y, class: "ov-box", "stroke-width": px});
        }
        points.forEach((p, i) => {
          const control = nodes.curve && i % 3;
          make(control ? "circle" : "rect", control ?
            {cx:p.x, cy:p.y, r:7*px, class:"ov-handle", "data-node":i, "stroke-width":2*px} :
            {x:p.x-8*px,y:p.y-8*px,width:16*px,height:16*px,rx:2*px,class:"ov-handle", "data-node":i,"stroke-width":2*px});
        });
        return;
      }
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
    const box = this.selectionBox();
    if (!box || this.textEdit) return;
    make("rect", { x: box.x, y: box.y, width: box.width, height: box.height, class: "ov-box", "stroke-width": px });
    if (this.tool !== "select") return;
    const pos = this.handlePositions(box);
    make("line", { x1: pos.n[0], y1: pos.n[1], x2: pos.rotate[0], y2: pos.rotate[1], class: "ov-box", "stroke-width": px });
    make("circle", { cx: pos.rotate[0], cy: pos.rotate[1], r: 8 * px, class: "ov-handle", "stroke-width": 1.5 * px });
    for (const name of HANDLES) {
      const [hx, hy] = pos[name];
      make("rect", { x: hx - 7 * px, y: hy - 7 * px, width: 14 * px, height: 14 * px, rx: 3 * px,
        class: "ov-handle", "stroke-width": 1.5 * px });
    }
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
      if (BAKEABLE.has(s.el.localName) && translateOnly && near(M.b, 0) && near(M.c, 0) && this.bake(s.el, M)) {
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

  // --- pointer handling ---------------------------------------------------------
  openContextMenu(x, y, preserveSelection = false) {
    if (this.pathDraft) { this.finishPath(); return; }
    if (!this.svg) return;
    this.endTextEdit(true);
    this.lastTap = null;
    if (!preserveSelection || !this.selection.length) {
      const event = { clientX: x, clientY: y, target: document.elementFromPoint(x, y) };
      const item = this.pick(event, this.point(event));
      if (item && !this.selection.includes(item)) this.select([item]);
    }
    this.hooks.contextMenu?.(x, y);
  }

  onDown(e) {
    if (e.target.closest && e.target.closest(".text-edit")) return;
    if (!this.svg) return;
    if (e.pointerType === "mouse" && e.button === 2) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType,
      startX: e.clientX, startY: e.clientY, started: performance.now() });
    this.host.setPointerCapture(e.pointerId);
    e.preventDefault();

    if (e.pointerType === "touch" && this.gesture && this.gesture.pointerType === "pen") {
      this.pointers.delete(e.pointerId);  // a palm or finger while the Pencil is down
      return;
    }
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

    const p = this.point(e);
    // The chosen tool applies to every pointer. Pan is explicit; a previous
    // Pencil stroke must not silently change what a later finger drag does.
    if (this.tool === "pan" || e.button === 1 || (e.button === 0 && e.altKey && e.pointerType === "mouse")) {
      this.gesture = { kind: "pan", id: e.pointerId, pointerType: e.pointerType, last: { x: e.clientX, y: e.clientY } };
      return;
    }
    if (e.button !== 0 && e.pointerType === "mouse") return;

    const base = { id: e.pointerId, pointerType: e.pointerType, start: p, now: p, client: { x: e.clientX, y: e.clientY },
      moved: false, shift: e.shiftKey };
    switch (this.tool) {
      case "select": return this.downSelect(e, p, base);
      case "nodes": return this.downNode(e, p, base);
      case "bezier": return this.downPath(p, base);
      case "pen": return this.downPen(p, base);
      case "text": this.gesture = { kind: "text", ...base }; return;
      default: this.gesture = { kind: "create", shape: this.tool, ...base }; return;
    }
  }

  pathNode(p) { return {x:p.x,y:p.y,in:{...p},out:{...p}}; }

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
          if (Math.hypot(q.x-p.x,q.y-p.y)*this.zoom < 14) {this.extendCurve(reverse); return;}
        }
      }
      this.pathDraft = {nodes:[],hover:null}; this.select([]);
    }
    const draft = this.pathDraft, first = draft.nodes[0], last = draft.nodes.at(-1);
    const near = a => a && Math.hypot(a.x-p.x,a.y-p.y)*this.zoom < (base.pointerType === "touch" ? 18 : 10);
    if (draft.nodes.length > 2 && near(first)) { this.finishPath(true); return; }
    if (draft.nodes.length > 1 && near(last) && performance.now()-draft.lastAt < 450) { this.finishPath(); return; }
    this.gesture = {kind:"path-node",...base,node:this.pathNode(p)};
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
        nodes=nodes.map(n=>({...convert(n),in:convert(n.in),out:convert(n.out)}));
      }
      path.setAttribute("d",this.pathData(nodes,closed));
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

  // Native SVG geometry remains the source of truth; there is no stale sidecar.
  curvePoints(el) {
    if (el?.localName !== "path") return null;
    const d = (el.getAttribute("d") || "").replace(/Z\s*$/i, "");
    const num = "[-+]?(?:\\d*\\.\\d+|\\d+\\.?\\d*)(?:[eE][-+]?\\d+)?";
    const pair = `${num}[ ,]+${num}`;
    if (!new RegExp(`^\\s*M\\s*${pair}(?:\\s*C\\s*${pair}[ ,]+${pair}[ ,]+${pair})+\\s*$`).test(d)) return null;
    const values = d.match(new RegExp(num, "g")).map(Number);
    if (!values.every(Number.isFinite)) return null;
    return Array.from({length: values.length / 2}, (_, i) => ({x:values[2*i], y:values[2*i+1]}));
  }

  writeCurve(el, points) {
    const p = points.map(q => `${+q.x.toFixed(3)},${+q.y.toFixed(3)}`);
    el.setAttribute("d", `M${p[0]} ` + Array.from({length:(p.length-1)/3}, (_,i) => `C${p.slice(i*3+1,i*3+4).join(" ")}`).join(" ") + (/Z\s*$/i.test(el.getAttribute("d") || "") ? " Z" : ""));
  }

  editableNodes(el) {
    const curve = this.curvePoints(el);
    if (curve) return {curve: true, points: curve};
    if (["polygon", "polyline"].includes(el?.localName)) {
      return {curve: false, points: Array.from(el.points, p => ({x:p.x,y:p.y}))};
    }
    return null;
  }

  downNode(e, p, base) {
    const el = this.selection.length === 1 && this.selection[0];
    const nodes = this.editableNodes(el);
    if (nodes) {
      const m = toRoot(el, this.svg);
      let index = -1, distance = e.pointerType === "touch" ? 22 : 12;
      nodes.points.forEach((q, i) => {
        const v = m.transformPoint(new DOMPoint(q.x,q.y));
        const d = Math.hypot(v.x-p.x,v.y-p.y) * this.zoom;
        if (d < distance) {index = i; distance = d;}
      });
      if (index >= 0) {
        this.begin();
        this.gesture = {kind:"node", ...base, ...nodes, el, index, inverse:m.inverse(), original:el.getAttribute(nodes.curve ? "d" : "points")};
        return;
      }
    }
    const picked = this.pick(e,p);
    this.select(picked ? [picked] : []);
    if (picked && !this.editableNodes(picked)) this.hooks.toast("Choose a Bézier curve or polygon to edit its points.");
  }

  extendCurve(reverse = false) {
    const el = this.selection[0], points = this.curvePoints(el);
    if (!points) return;
    if (/Z\s*$/i.test(el.getAttribute("d") || "")) { this.hooks.toast("This path is closed; edit its existing points or draw a new path."); return; }
    if (reverse) points.reverse();
    const matrix = toRoot(el,this.svg);
    const convert = p => {const q=matrix.transformPoint(new DOMPoint(p.x,p.y)); return {x:q.x,y:q.y};};
    const nodes = [];
    for (let i=0;i<points.length;i+=3) nodes.push({...convert(points[i]),
      in:convert(points[i-1] || points[i]),out:convert(points[i+1] || points[i])});
    this.pathDraft = {nodes,source:el,hover:null,initialData:this.pathData(nodes)};
    this.drawOverlay(); this.hooks.select(this.selection);
  }

  splitCurve() {
    const el = this.selection[0], points = this.curvePoints(el);
    if (!points) return;
    if (points.length > 193) { this.hooks.toast("This curve already has many anchors; drag its existing points to refine it."); return; }
    // De Casteljau subdivision preserves the exact curve while adding anchors.
    const mid = (a,b) => ({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
    const out = [points[0]];
    for (let i=0; i<points.length-1; i+=3) {
      const [a,b,c,d] = points.slice(i,i+4), ab=mid(a,b), bc=mid(b,c), cd=mid(c,d);
      const abc=mid(ab,bc), bcd=mid(bc,cd), center=mid(abc,bcd);
      out.push(ab,abc,center,bcd,cd,d);
    }
    this.change(() => this.writeCurve(el,out));
  }

  downSelect(e, p, base) {
    const handle = this.hitHandle(p, e.pointerType);
    if (handle === "end1" || handle === "end2") {
      this.begin();
      const line = this.lineMode();
      const which = handle === "end1" ? 1 : 2;
      this.gesture = { kind: "endpoint", ...base, line, which, inverse: toRoot(line, this.svg).inverse(),
        original: [line.getAttribute(`x${which}`), line.getAttribute(`y${which}`)] };
      return;
    }
    if (handle) {
      this.begin();
      const box = this.selectionBox();
      this.gesture = handle === "rotate"
        ? { kind: "rotate", ...base, center: [box.x + box.width / 2, box.y + box.height / 2], snaps: this.snapshot() }
        : { kind: "resize", ...base, handle, box, snaps: this.snapshot() };
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

  downPen(p, base) {
    const path = document.createElementNS(SVGNS, "path");
    const style = this.hooks.shapeStyle();
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", style.stroke === "none" ? "#000000" : style.stroke);
    path.setAttribute("stroke-width", style.strokeWidth);
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    this.begin();
    this.adopt(path);
    this.gesture = { kind: "draw", ...base, path, points: [[p.x, p.y]] };
    path.setAttribute("d", polylinePath(this.gesture.points));
  }

  onMove(e) {
    const ptr = this.pointers.get(e.pointerId);
    if (ptr) { ptr.x = e.clientX; ptr.y = e.clientY; }
    const g = this.gesture;
    if (!g) {
      if (this.pathDraft) { this.pathDraft.hover = this.snapPoint(this.point(e)); this.drawOverlay(); }
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
    const p = this.point(e);
    g.now = p;
    const tapPx = TAP_PX[e.pointerType] || TAP_PX.mouse;
    if (!g.moved && Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < tapPx) return;
    g.moved = true;
    switch (g.kind) {
      case "move": {
        if (!g.snaps) { this.begin(); g.snaps = this.snapshot(); g.box0 = this.selectionBox(); }
        let dx = p.x - g.start.x, dy = p.y - g.start.y;
        [dx, dy] = this.snapDelta(g.box0, dx, dy);
        if (e.shiftKey) { if (Math.abs(p.x - g.start.x) > Math.abs(p.y - g.start.y)) dy = 0; else dx = 0; }
        this.applyDelta(g.snaps, new DOMMatrix().translateSelf(dx, dy));
        break;
      }
      case "path-node": {
        const q = this.snapPoint(p), a = g.node;
        a.out = {x:q.x,y:q.y};
        a.in = {x:2*a.x-q.x,y:2*a.y-q.y};
        break;
      }
      case "node": {
        const q = g.inverse.transformPoint(new DOMPoint(p.x, p.y));
        const points = g.points.map(v => ({...v}));
        const dx = q.x - points[g.index].x, dy = q.y - points[g.index].y;
        points[g.index] = {x: q.x, y: q.y};
        if (g.curve && g.index % 3 === 0) {
          for (const i of [g.index - 1, g.index + 1]) if (points[i]) { points[i].x += dx; points[i].y += dy; }
        }
        if (g.curve && /Z\s*$/i.test(g.original) && (g.index === 0 || g.index === points.length-1)) {
          const other = g.index === 0 ? points.length-1 : 0;
          points[other] = {...points[g.index]};
          const handle = other === 0 ? 1 : other-1;
          points[handle].x += dx; points[handle].y += dy;
        }
        if (g.curve) this.writeCurve(g.el, points);
        else g.el.setAttribute("points", points.map(v => `${v.x},${v.y}`).join(" "));
        break;
      }
      case "resize": this.moveResize(g, p, e.shiftKey); break;
      case "endpoint": {
        let q = this.snapPoint(p);
        if (e.shiftKey) {
          const other = this.lineEnds(g.line)[g.which === 1 ? 1 : 0];
          const angle = Math.round(Math.atan2(p.y - other.y, p.x - other.x) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(p.x - other.x, p.y - other.y);
          q = { x: other.x + Math.cos(angle) * len, y: other.y + Math.sin(angle) * len };
        }
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
      case "create": this.moveCreate(g, p, e.shiftKey); break;
      case "draw": {
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events.length ? events : [e]) {
          const q = this.point(ev);
          g.points.push([q.x, q.y]);
        }
        g.path.setAttribute("d", polylinePath(g.points));
        return;
      }
    }
    this.drawOverlay();
  }

  moveResize(g, p, free) {
    const { box, handle } = g;
    p = this.snapPoint(p);
    const left = box.x, right = box.x + box.width, top = box.y, bottom = box.y + box.height;
    let sx = 1, sy = 1, ax = left, ay = top;
    if (handle.includes("e")) { ax = left; sx = box.width ? (p.x - left) / box.width : 1; }
    if (handle.includes("w")) { ax = right; sx = box.width ? (right - p.x) / box.width : 1; }
    if (handle.includes("s")) { ay = top; sy = box.height ? (p.y - top) / box.height : 1; }
    if (handle.includes("n")) { ay = bottom; sy = box.height ? (bottom - p.y) / box.height : 1; }
    if (handle === "n" || handle === "s") ax = left + box.width / 2;
    if (handle === "e" || handle === "w") ay = top + box.height / 2;
    if (handle.length === 2 && !free) {
      const s = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
      sx = s; sy = s;
    }
    const min = 2 / Math.max(box.width, box.height, 1);
    if (Math.abs(sx) < min) sx = Math.sign(sx || 1) * min;
    if (Math.abs(sy) < min) sy = Math.sign(sy || 1) * min;
    this.applyDelta(g.snaps, new DOMMatrix().translateSelf(ax, ay).scaleSelf(sx, sy).translateSelf(-ax, -ay));
  }

  moveCreate(g, p, square) {
    if (!g.el) {
      this.begin();
      g.el = this.adopt(this.newShape(g.shape));
    }
    this.shapeGeometry(g.el, g.shape, this.snapPoint(g.start), this.snapPoint(p), square);
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
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
        dx = Math.cos(angle) * len; dy = Math.sin(angle) * len;
      }
      el.setAttribute("x1", r(a.x)); el.setAttribute("y1", r(a.y));
      el.setAttribute("x2", r(a.x + dx)); el.setAttribute("y2", r(a.y + dy));
      return;
    }
    if (constrain || shape === "circle") { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s; }
    const x = Math.min(a.x, a.x + dx), y = Math.min(a.y, a.y + dy), w = Math.abs(dx), h = Math.abs(dy);
    if (shape === "bezier") {
      this.writeCurve(el, [{ x: a.x, y: a.y }, { x: a.x + dx / 3, y: a.y - 100 },
        { x: a.x + 2 * dx / 3, y: b.y + 100 }, { x: b.x, y: b.y }]);
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
    const p = this.point(e);
    switch (g.kind) {
      case "path-node":
        this.pathDraft.nodes.push(g.node);
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
        this.hooks.toolDone?.();
        return;
      }
      case "text": {
        const t = this.newText(this.snapPoint(p));
        this.select([t]);
        this.editText(t, true);
        this.hooks.toolDone?.();
        return;
      }
      case "draw": {
        if (g.points.length === 1) g.points.push([g.points[0][0] + 0.01, g.points[0][1]]);
        const eps = 1.2 / this.zoom;
        g.path.setAttribute("d", smoothPath(simplify(g.points, eps)));
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
    this.pointers.delete(e.pointerId);
    this.touchStart = null;
    if (this.gesture && (this.gesture.id === e.pointerId || this.gesture.kind === "pinch")) this.cancelGesture();
  }

  cancelGesture() {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    if (g.snaps) this.applyDelta(g.snaps, new DOMMatrix());
    if (g.kind === "endpoint") {
      g.line.setAttribute(`x${g.which}`, g.original[0]);
      g.line.setAttribute(`y${g.which}`, g.original[1]);
    }
    if (g.kind === "node") g.el.setAttribute(g.curve ? "d" : "points", g.original);
    if (g.kind === "draw") g.path.remove();
    if (g.kind === "create" && g.el) g.el.remove();
    this.before = null;
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
             fill: toHex(cs.fill) || cs.fill, size: parseFloat(cs.fontSize) || 16, shift: stop ? shiftOf(el, stop) : 0 };
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
    t.setAttribute("data-editing", "true");
    t.style.visibility = "hidden";
    this.textEdit = { t, box, isNew, base, styleAttr, pitch: this.linePitch(t), scale: 1, range: null, holding: false };
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); this.endTextEdit(true); }
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
      color: toHex(base.fill) || "#000",
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
        fontStyle: cs.fontStyle, fill: toHex(cs.color) || "#000000", size: (parseFloat(cs.fontSize) || 16) / scale,
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
    if (!save) { this.before = null; this.drawOverlay(); this.hooks.select(this.selection); return; }
    const trim = (ls) => { while (ls.length && !ls[ls.length - 1].some((r) => r.text.trim())) ls.pop(); return ls; };
    trim(lines);
    if (!lines.length) {
      t.remove();
      this.selection = this.selection.filter((el) => el !== t);
      if (isNew) {
        this.before = null;
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
    if (toHex(base.fill)) t.style.setProperty("fill", toHex(base.fill));
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
    const hex = toHex(color) || "#000000";
    const id = `arrow-${hex.slice(1)}-${String(ratio).replace(".", "_")}`;
    if (this.svg.querySelector(`#${CSS.escape(id)}`)) return id;
    let defs = this.svg.querySelector(":scope > defs");
    if (!defs) { defs = document.createElementNS(SVGNS, "defs"); this.svg.prepend(defs); }
    const marker = document.createElementNS(SVGNS, "marker");
    for (const [k, v] of Object.entries({ id, viewBox: "0 0 10 10", refX: "6", refY: "5", markerWidth: String(ratio),
      markerHeight: String(ratio), orient: "auto-start-reverse", "data-label": "arrowhead" })) marker.setAttribute(k, v);
    const tip = document.createElementNS(SVGNS, "path");
    tip.setAttribute("d", "M0,0 L10,5 L0,10 z");
    tip.setAttribute("fill", hex);
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

  insertMedia(info) {
    const [W, H] = this.size;
    const scale = Math.min(1, (W * 0.6) / info.width, (H * 0.6) / info.height);
    const w = info.width * scale, h = info.height * scale;
    const c = this.visibleCenter();
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
      // Movies are layered by the player at the top level of the slide.
      (info.kind === "video" ? this.svg : this.context).appendChild(img);
      this.selection = [img];
    });
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
