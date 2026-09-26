// The slide canvas: shows one slide SVG and edits it in place.
// Pointer events throughout, so mouse, finger and Apple Pencil share one path.
import {
  SVGNS, localMatrix, setTransform, toRoot, rootBox, unionBox, simplify, smoothPath, polylinePath,
} from "./geom.js";

const HANDLE_PX = 16;          // handle hit radius, screen pixels
const ROTATE_OFFSET_PX = 36;   // rotate handle distance above the box
const TAP_PX = 6;              // movement below this is a tap
const DOUBLE_TAP_MS = 350;
const BAKEABLE = new Set(["rect", "image", "ellipse", "circle", "line"]);
const SKIP = new Set(["defs", "title", "desc", "metadata", "style", "script"]);
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const num = (el, name) => parseFloat(el.getAttribute(name)) || 0;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

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
    this.penSeen = false;
    this.lastTap = null;
    this.textEdit = null;
    this.before = null;

    host.addEventListener("pointerdown", (e) => this.onDown(e));
    host.addEventListener("pointermove", (e) => this.onMove(e));
    host.addEventListener("pointerup", (e) => this.onUp(e));
    host.addEventListener("pointercancel", (e) => this.onCancel(e));
    host.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    host.addEventListener("contextmenu", (e) => e.preventDefault());
    new ResizeObserver(() => { if (this.fitMode) this.fit(); else this.layout(); }).observe(host);
  }

  // --- loading and saving --------------------------------------------------
  load(text, { keepView = false } = {}) {
    this.endTextEdit(false);
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    if (doc.querySelector("parsererror") || doc.documentElement.localName !== "svg") {
      throw new Error("this slide is not valid SVG");
    }
    const svg = document.importNode(doc.documentElement, true);
    for (const el of svg.querySelectorAll("[href], [data-video]")) this.rewriteRefs(el, this.hooks.hrefIn);
    for (const el of svg.querySelectorAll("*")) {
      const legacy = el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      if (legacy && !el.hasAttribute("href")) {
        el.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
        el.setAttribute("href", this.hooks.hrefIn(legacy));
      }
    }
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

  serialize() {
    const clone = this.svg.cloneNode(true);
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

  handlePositions(box) {
    const { x, y, width: w, height: h } = box;
    return {
      nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + h / 2],
      se: [x + w, y + h], s: [x + w / 2, y + h], sw: [x, y + h], w: [x, y + h / 2],
      rotate: [x + w / 2, y - ROTATE_OFFSET_PX / this.zoom],
    };
  }

  hitHandle(p) {
    if (!this.selection.length || this.tool !== "select") return null;
    const box = this.selectionBox();
    if (!box) return null;
    // Inside the object, handles only win right at their centre, so small
    // objects can still be dragged and double-tapped.
    const inside = p.x > box.x && p.x < box.x + box.width && p.y > box.y && p.y < box.y + box.height;
    const r = (inside ? 7 : HANDLE_PX) / this.zoom;
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
    const px = 1 / this.zoom;
    const make = (tag, attrs) => {
      const el = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      o.appendChild(el);
      return el;
    };
    if (this.context !== this.svg) {
      const b = rootBox(this.context, this.svg);
      if (b) make("rect", { x: b.x, y: b.y, width: b.width, height: b.height, class: "ov-group", "stroke-width": px });
    }
    if (this.gesture?.kind === "marquee") {
      const g = this.gesture;
      make("rect", { x: Math.min(g.start.x, g.now.x), y: Math.min(g.start.y, g.now.y),
        width: Math.abs(g.now.x - g.start.x), height: Math.abs(g.now.y - g.start.y), class: "ov-marquee", "stroke-width": px });
    }
    if (!this.selection.length) return;
    for (const el of this.selection.length > 1 ? this.selection : []) {
      const b = rootBox(el, this.svg);
      if (b) make("rect", { x: b.x, y: b.y, width: b.width, height: b.height, class: "ov-item", "stroke-width": px });
    }
    const box = this.selectionBox();
    if (!box || this.textEdit) return;
    make("rect", { x: box.x, y: box.y, width: box.width, height: box.height, class: "ov-box", "stroke-width": px });
    if (this.tool !== "select") return;
    const pos = this.handlePositions(box);
    make("line", { x1: pos.n[0], y1: pos.n[1], x2: pos.rotate[0], y2: pos.rotate[1], class: "ov-box", "stroke-width": px });
    make("circle", { cx: pos.rotate[0], cy: pos.rotate[1], r: 7 * px, class: "ov-handle", "stroke-width": 1.5 * px });
    for (const name of HANDLES) {
      const [hx, hy] = pos[name];
      make("rect", { x: hx - 6 * px, y: hy - 6 * px, width: 12 * px, height: 12 * px, rx: 2 * px,
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
  onDown(e) {
    if (e.target.closest && e.target.closest(".text-edit")) return;
    if (!this.svg) return;
    if (e.pointerType === "pen") this.penSeen = true;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    this.host.setPointerCapture(e.pointerId);
    e.preventDefault();

    const touches = [...this.pointers.values()].filter((p) => p.type === "touch");
    if (touches.length === 2) {
      this.cancelGesture();
      this.gesture = { kind: "pinch", ...this.pinchState() };
      return;
    }
    if (this.gesture) return;
    if (this.textEdit) { this.endTextEdit(true); return; }

    const p = this.point(e);
    // With a Pencil in use, a finger pans instead of drawing (palm rejection).
    const fingerPans = e.pointerType === "touch" && this.penSeen && this.tool !== "select";
    if (e.button === 1 || fingerPans || (e.button === 0 && e.altKey && e.pointerType === "mouse")) {
      this.gesture = { kind: "pan", id: e.pointerId, last: { x: e.clientX, y: e.clientY } };
      return;
    }
    if (e.button !== 0 && e.pointerType === "mouse") return;

    const base = { id: e.pointerId, start: p, now: p, client: { x: e.clientX, y: e.clientY }, moved: false, shift: e.shiftKey };
    switch (this.tool) {
      case "select": return this.downSelect(e, p, base);
      case "pen": return this.downPen(p, base);
      case "text": this.gesture = { kind: "text", ...base }; return;
      default: this.gesture = { kind: "create", shape: this.tool, ...base }; return;
    }
  }

  downSelect(e, p, base) {
    const handle = this.hitHandle(p);
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
    if (!el) {
      if (!e.shiftKey) this.select([]);
      this.gesture = { kind: "marquee", ...base, additive: e.shiftKey };
      return;
    }
    if (e.shiftKey) {
      const has = this.selection.includes(el);
      this.select(has ? this.selection.filter((s) => s !== el) : [...this.selection, el]);
      this.gesture = { kind: "none", ...base };
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
    this.context.appendChild(path);
    this.gesture = { kind: "draw", ...base, path, points: [[p.x, p.y]] };
    path.setAttribute("d", polylinePath(this.gesture.points));
  }

  onMove(e) {
    const ptr = this.pointers.get(e.pointerId);
    if (ptr) { ptr.x = e.clientX; ptr.y = e.clientY; }
    const g = this.gesture;
    if (!g) return;
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
    if (!g.moved && Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < TAP_PX) return;
    g.moved = true;
    switch (g.kind) {
      case "move": {
        if (!g.snaps) { this.begin(); g.snaps = this.snapshot(); }
        let dx = p.x - g.start.x, dy = p.y - g.start.y;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        this.applyDelta(g.snaps, new DOMMatrix().translateSelf(dx, dy));
        break;
      }
      case "resize": this.moveResize(g, p, e.shiftKey); break;
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
      g.el = this.newShape(g.shape);
      this.context.appendChild(g.el);
    }
    this.shapeGeometry(g.el, g.shape, g.start, p, square);
  }

  newShape(shape) {
    const style = this.hooks.shapeStyle();
    const tag = { rect: "rect", ellipse: "ellipse", line: "line", arrow: "line" }[shape];
    const el = document.createElementNS(SVGNS, tag);
    if (tag === "line") {
      el.style.setProperty("stroke", style.stroke === "none" ? "#000000" : style.stroke);
      el.style.setProperty("stroke-width", style.strokeWidth);
      el.style.setProperty("stroke-linecap", "round");
      if (shape === "arrow") el.style.setProperty("marker-end", `url(#${this.ensureMarker(el.style.stroke)})`);
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
    if (constrain) { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s; }
    const x = Math.min(a.x, a.x + dx), y = Math.min(a.y, a.y + dy), w = Math.abs(dx), h = Math.abs(dy);
    if (shape === "rect") {
      el.setAttribute("x", r(x)); el.setAttribute("y", r(y)); el.setAttribute("width", r(w)); el.setAttribute("height", r(h));
    } else {
      el.setAttribute("cx", r(x + w / 2)); el.setAttribute("cy", r(y + h / 2));
      el.setAttribute("rx", r(w / 2)); el.setAttribute("ry", r(h / 2));
    }
  }

  onUp(e) {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === "pinch") {
      if ([...this.pointers.values()].filter((p) => p.type === "touch").length < 2) this.gesture = null;
      return;
    }
    if (g.id !== e.pointerId) return;
    this.gesture = null;
    const p = this.point(e);
    switch (g.kind) {
      case "pan": return;
      case "move": case "resize": case "rotate":
        this.commit();
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
          g.el = this.newShape(g.shape);
          this.context.appendChild(g.el);
          const size = g.shape === "rect" || g.shape === "ellipse" ? [240, 160] : [240, 0];
          this.shapeGeometry(g.el, g.shape, { x: p.x - size[0] / 2, y: p.y - size[1] / 2 },
            { x: p.x + size[0] / 2, y: p.y + size[1] / 2 }, false);
        }
        this.selection = [g.el];
        this.commit();
        this.hooks.toolDone?.();
        return;
      }
      case "text": {
        const t = this.newText(p);
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
    if (this.gesture && (this.gesture.id === e.pointerId || this.gesture.kind === "pinch")) this.cancelGesture();
  }

  cancelGesture() {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    if (g.snaps) this.applyDelta(g.snaps, new DOMMatrix());
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
    t.style.setProperty("font-family", `'${s.family}'`);
    t.style.setProperty("font-weight", String(s.weight));
    t.style.setProperty("font-size", `${s.size}px`);
    t.style.setProperty("fill", s.fill);
    t.style.setProperty("white-space", "pre");
    this.context.appendChild(t);
    this.hooks.ensureFont?.(s.family);
    return t;
  }

  /** How much a text's own units are scaled on the slide. */
  textScale(t) {
    const m = toRoot(t, this.svg);
    return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  }

  textLines(t) {
    const lines = Array.from(t.children).filter((c) => c.localName === "tspan" && (c.hasAttribute("x") || c.hasAttribute("dy") || c.hasAttribute("y")));
    const raw = lines.length ? lines.map((l) => l.textContent) : [t.textContent];
    return raw.map((l) => l.replace(/\n+$/, ""));
  }

  isRich(t) {
    const spans = t.querySelectorAll("tspan");
    for (const s of spans) {
      const st = s.getAttribute("style") || "";
      if (/font-weight|fill|font-style|font-family|font-size/.test(st) || s.hasAttribute("fill") || s.hasAttribute("font-weight")) {
        const line = s.parentNode === t && (s.hasAttribute("x") || s.hasAttribute("dy"));
        if (!line || s.querySelector("tspan")) return true;
      }
    }
    return false;
  }

  editText(t, isNew) {
    if (!isNew && this.isRich(t) &&
        !confirm("This text has mixed formatting (e.g. bold words). Editing it here keeps only the first word's style. Continue?")) {
      return;
    }
    this.endTextEdit(true);
    this.begin();
    const first = t.querySelector("tspan") || t;
    const cs = getComputedStyle(first.firstChild && first.firstChild.nodeType === 3 ? first : (t.querySelector("tspan tspan") || first));
    const area = document.createElement("textarea");
    area.className = "text-edit";
    area.value = isNew ? "" : this.textLines(t).join("\n");
    area.spellcheck = true;
    this.page.appendChild(area);
    t.setAttribute("data-editing", "true");
    t.style.visibility = "hidden";
    this.textEdit = { t, area, isNew, style: { family: cs.fontFamily, weight: cs.fontWeight, fontStyle: cs.fontStyle, fill: cs.fill } };
    area.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); this.endTextEdit(true); }
    });
    area.addEventListener("input", () => this.positionTextEdit());
    area.addEventListener("blur", () => setTimeout(() => { if (this.textEdit?.area === area) this.endTextEdit(true); }, 0));
    this.positionTextEdit();
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    this.drawOverlay();
  }

  positionTextEdit() {
    const te = this.textEdit;
    if (!te) return;
    const { t, area, style } = te;
    const m = toRoot(t, this.svg);
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) * this.zoom;
    const cs = getComputedStyle(t);
    const size = parseFloat(cs.fontSize) * scale;
    const b = rootBox(t, this.svg);
    const x0 = parseFloat(t.querySelector("tspan[x]")?.getAttribute("x") ?? t.getAttribute("x")) || 0;
    const y0 = parseFloat(t.querySelector("tspan[y]")?.getAttribute("y") ?? t.getAttribute("y")) || 0;
    const anchor = m.transformPoint(new DOMPoint(x0, y0));
    const lines = area.value.split("\n");
    Object.assign(area.style, {
      left: `${(b && b.width ? Math.min(b.x, anchor.x) : anchor.x) * this.zoom - 4}px`,
      top: `${anchor.y * this.zoom - size * 1.05}px`,
      fontFamily: style.family, fontWeight: style.weight, fontStyle: style.fontStyle,
      fontSize: `${size}px`, lineHeight: "1.25", color: style.fill === "none" ? "#000" : style.fill,
      textAlign: { middle: "center", end: "right" }[cs.textAnchor] || "left",
      width: `${Math.max(size * 4, ...lines.map((l) => l.length * size * 0.62)) + 16}px`,
      height: `${lines.length * size * 1.25 + 12}px`,
    });
  }

  endTextEdit(save) {
    const te = this.textEdit;
    if (!te) return;
    this.textEdit = null;
    const { t, area, isNew, style } = te;
    const value = area.value.replace(/\s+$/, "");
    area.remove();
    t.removeAttribute("data-editing");
    t.style.removeProperty("visibility");
    if (!save) { this.before = null; return; }
    if (!value.trim()) {
      t.remove();
      this.selection = this.selection.filter((el) => el !== t);
      if (isNew) { this.before = null; this.drawOverlay(); this.hooks.select(this.selection); return; }
      this.commit();
      return;
    }
    if (!isNew && value === this.textLines(t).join("\n")) { this.commit(); return; }
    this.setTextLines(t, value.split("\n"), style);
    this.commit();
  }

  setTextLines(t, lines, style) {
    const firstLine = t.querySelector("tspan[x], tspan[y]");
    const x = firstLine?.getAttribute("x") ?? t.getAttribute("x") ?? "0";
    const y = firstLine?.getAttribute("y") ?? t.getAttribute("y") ?? "0";
    const rich = t.querySelector("tspan[style], tspan[fill]");
    if (rich && style) {
      // Keep the look of the first word for the whole text.
      t.style.setProperty("font-weight", style.weight);
      t.style.setProperty("font-style", style.fontStyle);
      if (style.fill && style.fill !== "none") t.style.setProperty("fill", style.fill);
    }
    t.replaceChildren();
    t.setAttribute("x", x);
    t.setAttribute("y", y);
    lines.forEach((line, i) => {
      const span = document.createElementNS(SVGNS, "tspan");
      span.setAttribute("x", x);
      if (i === 0) span.setAttribute("y", y); else span.setAttribute("dy", "1.25em");
      span.textContent = line || " ";
      t.appendChild(span);
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
      const copies = this.selection.map((el) => {
        const c = this.cloneWithNewIds(el);
        el.after(c);
        return c;
      });
      this.selection = copies;
      this.applyDelta(this.snapshot(), new DOMMatrix().translateSelf(24, 24));
    });
  }

  /** Clone, renaming ids defined inside the clone (and references to them). */
  cloneWithNewIds(el) {
    const c = el.cloneNode(true);
    const suffix = "-" + Math.random().toString(36).slice(2, 7);
    const map = new Map();
    for (const n of [c, ...c.querySelectorAll("[id]")]) {
      if (n.id) { map.set(n.id, n.id + suffix); n.id += suffix; }
    }
    if (!map.size) return c;
    for (const n of [c, ...c.querySelectorAll("*")]) {
      for (const attr of Array.from(n.attributes)) {
        let v = attr.value;
        if (attr.localName === "href" && v.startsWith("#") && map.has(v.slice(1))) v = "#" + map.get(v.slice(1));
        else if (v.includes("url(#")) v = v.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (m, q, id) => map.has(id) ? `url(#${map.get(id)})` : m);
        if (v !== attr.value) n.setAttribute(attr.name, v);
      }
    }
    return c;
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
      if (["clip-path", "mask", "filter"].some((a) => g.hasAttribute(a) || g.style.getPropertyValue(a)) ||
          (g.style.opacity && +g.style.opacity < 1)) {
        this.hooks.toast("This group has clipping or effects; ungrouping would change how it looks.");
        return;
      }
    }
    this.change(() => {
      const released = [];
      for (const g of groups) {
        const T = localMatrix(g);
        const inherited = Array.from(g.style).map((p) => [p, g.style.getPropertyValue(p)]);
        for (const child of Array.from(g.children)) {
          if (child.nodeType === 1 && !SKIP.has(child.localName)) {
            setTransform(child, T.multiply(localMatrix(child)));
            for (const [p, v] of inherited) {
              if (!child.style.getPropertyValue(p) && !child.hasAttribute(p)) child.style.setProperty(p, v);
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
      if (prop === "stroke") this.recolorMarkers(elements, value);
    });
  }

  applyStyle(el, prop, value) {
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

  ensureMarker(color) {
    const hex = (color || "#000000").replace(/[^0-9a-z]/gi, "");
    const id = `arrow-${hex}`;
    if (this.svg.querySelector(`#${CSS.escape(id)}`)) return id;
    let defs = this.svg.querySelector(":scope > defs");
    if (!defs) { defs = document.createElementNS(SVGNS, "defs"); this.svg.prepend(defs); }
    const marker = document.createElementNS(SVGNS, "marker");
    for (const [k, v] of Object.entries({ id, viewBox: "0 0 10 10", refX: "7", refY: "5", markerWidth: "4",
      markerHeight: "4", orient: "auto-start-reverse" })) marker.setAttribute(k, v);
    const tip = document.createElementNS(SVGNS, "path");
    tip.setAttribute("d", "M0,0 L10,5 L0,10 z");
    tip.setAttribute("fill", color);
    marker.appendChild(tip);
    defs.appendChild(marker);
    return id;
  }

  recolorMarkers(elements, color) {
    for (const el of elements) {
      for (const end of ["marker-start", "marker-end"]) {
        const v = el.style.getPropertyValue(end);
        if (v && v.includes("arrow-")) el.style.setProperty(end, `url(#${this.ensureMarker(color)})`);
      }
    }
  }

  hasArrow(el, end) {
    return !!(el.style.getPropertyValue(`marker-${end}`) || el.getAttribute(`marker-${end}`));
  }

  setArrow(end, on) {
    const lines = this.selection.filter((el) => ["line", "path", "polyline"].includes(el.localName));
    if (!lines.length) return;
    this.change(() => {
      for (const el of lines) {
        el.removeAttribute(`marker-${end}`);
        if (on) {
          const stroke = getComputedStyle(el).stroke;
          const hex = /rgb/.test(stroke) ? "#" + stroke.match(/\d+/g).slice(0, 3).map((v) => (+v).toString(16).padStart(2, "0")).join("") : stroke;
          el.style.setProperty(`marker-${end}`, `url(#${this.ensureMarker(hex)})`);
        } else {
          el.style.removeProperty(`marker-${end}`);
        }
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
      const c = el.cloneNode(true);
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
      if (def && !this.selection.some((s) => s === def || s.contains(def))) { const c = def.cloneNode(true); defs.push(c); collect(c); }
    }
    const ser = new XMLSerializer();
    const out = (n) => { const c = n.cloneNode(true); this.rewriteRefs(c, this.hooks.hrefOut); for (const d of c.querySelectorAll("[href],[data-video]")) this.rewriteRefs(d, this.hooks.hrefOut); return ser.serializeToString(c); };
    return JSON.stringify({ svgdeck: 1, defs: defs.map(out), items: items.map(out) });
  }

  paste(data) {
    let clip;
    try { clip = JSON.parse(data); } catch (e) { return false; }
    if (!clip || clip.svgdeck !== 1) return false;
    const parse = (s) => {
      const doc = new DOMParser().parseFromString(`<svg xmlns="${SVGNS}">${s}</svg>`, "image/svg+xml");
      const el = document.importNode(doc.documentElement.firstElementChild, true);
      this.rewriteRefs(el, this.hooks.hrefIn);
      for (const d of el.querySelectorAll("[href],[data-video]")) this.rewriteRefs(d, this.hooks.hrefIn);
      return el;
    };
    this.change(() => {
      let defs = this.svg.querySelector(":scope > defs");
      if (!defs) { defs = document.createElementNS(SVGNS, "defs"); this.svg.prepend(defs); }
      for (const s of clip.defs) {
        const d = parse(s);
        if (!this.svg.querySelector(`#${CSS.escape(d.id)}`)) defs.appendChild(d);
      }
      const P = toRoot(this.context, this.svg).inverse();
      const pasted = clip.items.map((s) => {
        const el = this.cloneWithNewIds(parse(s));
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
