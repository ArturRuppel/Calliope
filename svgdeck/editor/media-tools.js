import { SVGNS, toRoot } from "./geom.js";

const MIN_REMAINING = .1;
const clamp = (v) => Math.max(0, Math.min(100 - MIN_REMAINING, Number.isFinite(+v) ? +v : 0));
const cropOf = (el) => (el?.getAttribute("data-crop") || "0 0 0 0").split(/[ ,]+/).slice(0, 4)
  .map(clamp).concat([0, 0, 0, 0]).slice(0, 4);
const round = (v) => +v.toFixed(2);

export function installMediaTools({ editor, toast = () => {}, settle = () => {} }) {
  let session = null;
  // Pointers the canvas is tracking for its own gestures (pan, pinch, select).
  // The selection changes the moment one lands, so a selection change that would
  // cancel the crop only suspends it until they are all up: a pinch puts the
  // selection back and the crop resumes where it was.
  const canvasPointers = new Set();
  const dialog = document.createElement("dialog");
  dialog.className = "media-tools direct-crop-tools";
  dialog.setAttribute("aria-label", "Crop media");
  document.body.appendChild(dialog);
  const style = document.createElement("style");
  style.textContent = `
    .direct-crop-tools{position:fixed;inset:auto 20px 20px auto;z-index:60;margin:0;max-width:min(430px,calc(100vw - 40px));color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 16px;box-shadow:0 8px 30px #0006}
    .direct-crop-tools strong{display:block;font:600 17px system-ui;margin-bottom:8px}.direct-crop-tools .crop-actions{display:flex;gap:8px;align-items:center}.direct-crop-tools button{margin:0;padding:7px 14px;min-height:36px}.direct-crop-tools details{margin-top:8px}.direct-crop-tools summary{cursor:pointer;color:var(--muted)}.direct-crop-tools .media-crop-fields{margin-top:8px}.direct-crop-tools .media-crop-fields input{width:62px}.direct-crop-tools button[aria-pressed=true]{background:var(--accent,#1769d2);color:#fff;border-color:var(--accent,#1769d2)}
    .overlay .ov-crop-shade{fill:#07111b;fill-opacity:.55;fill-rule:evenodd;pointer-events:none}.overlay .ov-crop-frame{fill:none;stroke:#fff;stroke-dasharray:8 5;pointer-events:none}.overlay .ov-crop-handle{fill:#fff;stroke:#1769d2;pointer-events:all;touch-action:none}`;
  document.head.appendChild(style);

  const selectedMedia = () => editor.selection.length === 1 && editor.selection[0].localName === "image" ? editor.selection[0] : null;
  const clipId = (el) => /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)$/.exec(el?.getAttribute("clip-path") || "")?.[1] || null;
  // A clip is ours only when the element names it in data-svgdeck-clip and clip-path still points there.
  const ownedClip = (el) => { const id = clipId(el); return id && el.getAttribute("data-svgdeck-clip") === id ? id : null; };
  const existingForeignClip = (el) => el?.hasAttribute("clip-path") && !ownedClip(el);
  const clipUsers = (id) => Array.from(editor.svg.querySelectorAll("[clip-path]")).filter((el) => clipId(el) === id);
  function ensureDefs() {
    let defs = Array.from(editor.svg.children).find((el) => el.localName === "defs");
    if (!defs) {
      defs = document.createElementNS(SVGNS, "defs");
      editor.svg.prepend(defs);
    }
    return defs;
  }

  function uniqueId() {
    let id, n = 1;
    do id = `svgdeck-clip-${n++}`;
    while (editor.svg.querySelector(`#${CSS.escape(id)}`));
    return id;
  }
  function normalized(crop, changed = []) {
    const values = crop.map(clamp);
    const active = new Set(Array.isArray(changed) ? changed : [changed]);
    for (const [first, opposite] of [[0, 2], [1, 3]]) {
      if (values[first] + values[opposite] <= 100 - MIN_REMAINING) continue;
      if (active.has(first)) values[first] = 100 - MIN_REMAINING - values[opposite];
      else values[opposite] = 100 - MIN_REMAINING - values[first];
    }
    return values.map((value) => Math.max(0, round(value)));
  }
  function writeClip(el, crop, mask) {
    let id = ownedClip(el);
    let clip = id && editor.svg.querySelector(`#${CSS.escape(id)}`);
    if (clip && clip.localName !== "clipPath") clip = null;
    if (clip && clipUsers(id).some((user) => user !== el)) {
      clip = clip.cloneNode(true);
      id = uniqueId();
      clip.id = id;
      ensureDefs().append(clip);
    }
    if (!clip) {
      id = uniqueId();
      clip = document.createElementNS(SVGNS, "clipPath");
      clip.id = id;
      clip.setAttribute("clipPathUnits", "objectBoundingBox");
      ensureDefs().append(clip);
    }
    const [left, top, right, bottom] = crop.map((value) => value / 100);
    const width = Math.max(.001, 1 - left - right), height = Math.max(.001, 1 - top - bottom);
    const shape = document.createElementNS(SVGNS, mask === "ellipse" ? "ellipse" : "rect");
    if (mask === "ellipse") {
      shape.setAttribute("cx", left + width / 2); shape.setAttribute("cy", top + height / 2);
      shape.setAttribute("rx", width / 2); shape.setAttribute("ry", height / 2);
    } else {
      shape.setAttribute("x", left); shape.setAttribute("y", top);
      shape.setAttribute("width", width); shape.setAttribute("height", height);
    }
    clip.setAttribute("clipPathUnits", "objectBoundingBox");
    clip.replaceChildren(shape);
    el.setAttribute("data-svgdeck-clip", id);
    el.setAttribute("clip-path", `url(#${id})`);
  }
  const valid = () => !!(session && editor.svg === session.svg && editor.svg.contains(session.media));

  function preview(crop, mask = session?.mask || "rect", changed = [], renderUi = true) {
    if (!valid()) return;
    session.crop = normalized(crop, changed);
    session.mask = mask === "ellipse" ? "ellipse" : "rect";
    if (session.suspended) { if (renderUi) render(); return; }
    session.media.setAttribute("data-crop", session.crop.join(" "));
    session.media.setAttribute("data-mask", session.mask);
    writeClip(session.media, session.crop, session.mask);
    editor.drawOverlay();
    if (renderUi) render();
  }

  function snapshot(media) {
    const id = ownedClip(media), clip = id && editor.svg.querySelector(`#${CSS.escape(id)}`);
    return { attrs: Array.from(media.attributes, (a) => [a.name, a.value]), clip: clip?.cloneNode(true) || null, clipId: id };
  }

  function restore() {
    if (!valid()) return;
    const { media, original } = session, now = ownedClip(media);
    if (now && now !== original.clipId && clipUsers(now).every((user) => user === media)) {
      editor.svg.querySelector(`#${CSS.escape(now)}`)?.remove();
    }
    for (const attribute of [...media.attributes]) media.removeAttribute(attribute.name);
    for (const [name, value] of original.attrs) media.setAttribute(name, value);
    if (original.clip) {
      const current = editor.svg.querySelector(`#${CSS.escape(original.clipId)}`);
      if (current) current.replaceWith(original.clip.cloneNode(true));
      else ensureDefs().append(original.clip.cloneNode(true));
    }
  }

  function finish(commit) {
    if (!session) return;
    canvasPointers.clear();
    if (commit && valid() && !session.suspended) editor.commit();
    else {
      restore();
      if (typeof editor.abort === "function") editor.abort(); else editor.before = null;
    }
    session = null;
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    editor.drawOverlay();
  }
  function removeOwnedClip() {
    if (!valid()) return;
    const id = ownedClip(session.media);
    if (id && clipUsers(id).every((u) => u === session.media)) editor.svg.querySelector(`#${CSS.escape(id)}`)?.remove();
    for (const name of ["data-crop", "data-mask", "data-svgdeck-clip"]) session.media.removeAttribute(name);
    if (id) session.media.removeAttribute("clip-path");
    session.crop = [0, 0, 0, 0];
    session.mask = "rect";
    editor.drawOverlay();
    render();
  }
  function render() {
    const wasOpen = dialog.querySelector("details")?.open || false;
    dialog.replaceChildren();
    if (!valid()) return dialog;
    const title = document.createElement("strong"), actions = document.createElement("div");
    title.textContent = session.media.hasAttribute("data-video") ? "Crop movie" : "Crop image";
    actions.className = "crop-actions";
    for (const [label, fn] of [["Done", () => finish(true)], ["Cancel", () => finish(false)], ["Reset", removeOwnedClip],
      ["Aspect", () => api.setAspectLock(!session?.aspect)]]) {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = label; button.addEventListener("click", fn);
      if (label === "Aspect") {
        button.dataset.cropAspect = ""; button.title = "Keep the crop's proportions while dragging (or hold Shift)";
        button.setAttribute("aria-pressed", String(!!session.aspect));
      }
      actions.append(button);
    }
    dialog.append(title, actions);
    const advanced = document.createElement("details"), summary = document.createElement("summary"), fields = document.createElement("div");
    summary.textContent = "Advanced"; fields.className = "media-crop-fields";
    ["Left", "Top", "Right", "Bottom"].forEach((name, i) => {
      const label = document.createElement("label"), input = document.createElement("input");
      label.textContent = `${name} `; input.type = "number"; input.min = "0"; input.max = "99.9"; input.step = "0.5";
      input.value = session.crop[i]; input.dataset.cropSide = name.toLowerCase();
      input.addEventListener("change", () => {
        if (!valid()) return;
        const next = [...session.crop];
        next[i] = input.value;
        preview(next, session.mask, i, false);
        input.value = session.crop[i];
      });
      label.append(input, "%"); fields.append(label);
    });
    const maskLabel = document.createElement("label"), maskSelect = document.createElement("select");
    maskLabel.textContent = "Mask "; maskSelect.dataset.mediaMask = "";
    for (const [value, text] of [["rect", "Rectangle"], ["ellipse", "Ellipse"]]) {
      const option = document.createElement("option");
      option.value = value; option.textContent = text; option.selected = value === session.mask; maskSelect.append(option);
    }
    maskSelect.addEventListener("change", () => preview(session.crop, maskSelect.value));
    maskLabel.append(maskSelect); advanced.append(summary, fields, maskLabel); advanced.open = wasOpen; dialog.append(advanced);
    return dialog;
  }

  function open() {
    if (session) finish(false);
    settle();
    const media = selectedMedia();
    if (!media) { toast("Select one image or movie to crop."); return false; }
    if (existingForeignClip(media)) { toast("This media already has an imported clip path. Remove it before using Crop."); return false; }
    session = { media, svg: editor.svg, original: snapshot(media), crop: cropOf(media), mask: media.getAttribute("data-mask") || "rect", drag: null, aspect: false };
    editor.begin(); render();
    if (!dialog.open) dialog.show();
    editor.drawOverlay();
    return true;
  }
  /** Swap the media of an existing <image> for newly uploaded media (`info` is the
   *  upload response given to editor.insertMedia), keeping its box, transform,
   *  opacity, step, label, lock, crop and adjustments. One undo step. */
  function replace(el, info) {
    if (!el || el.localName !== "image" || !editor.svg.contains(el) || !info?.href) return null;
    // An open crop belongs to the old picture; drop it (restoring the slide) first.
    if (session) finish(false);
    const movie = info.kind === "video" && !!info.video;
    editor.change(() => {
      el.setAttribute("href", editor.hooks.hrefIn(info.href));
      el.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
      // A trim is in the old movie's seconds.
      for (const name of ["data-video-start", "data-video-end"]) el.removeAttribute(name);
      if (movie) {
        el.setAttribute("data-video", editor.hooks.hrefIn(info.video));
        for (const name of ["data-autoplay", "data-loop"]) if (!el.hasAttribute(name)) el.setAttribute(name, "true");
      } else for (const name of ["data-video", "data-autoplay", "data-loop", "data-sync"]) el.removeAttribute(name);
      editor.selection = [el];
    });
    return el;
  }

  function geometry() {
    if (!valid()) return null;
    const matrix = toRoot(session.media, editor.svg);
    const x = parseFloat(session.media.getAttribute("x")) || 0, y = parseFloat(session.media.getAttribute("y")) || 0;
    const w = parseFloat(session.media.getAttribute("width")) || 0, h = parseFloat(session.media.getAttribute("height")) || 0;
    const [left, top, right, bottom] = session.crop;
    const local = { left: x + w * left / 100, top: y + h * top / 100,
      right: x + w * (1 - right / 100), bottom: y + h * (1 - bottom / 100), x, y, w, h };
    const point = (a, b) => matrix.transformPoint(new DOMPoint(a, b));
    const corners = [point(local.left, local.top), point(local.right, local.top),
      point(local.right, local.bottom), point(local.left, local.bottom)];
    const mids = [point((local.left + local.right) / 2, local.top), point(local.right, (local.top + local.bottom) / 2),
      point((local.left + local.right) / 2, local.bottom), point(local.left, (local.top + local.bottom) / 2)];
    return { inv: matrix.inverse(), local, corners,
      points: [corners[0], mids[0], corners[1], mids[1], corners[2], mids[2], corners[3], mids[3]] };
  }
  const names = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  function drawOverlay(o, make, px) {
    const g = geometry();
    if (!g) return false;
    const polygon = g.corners.map((p) => `${p.x},${p.y}`).join(" ");
    const matrix = toRoot(session.media, editor.svg);
    const href = session.media.getAttribute("href") ||
      session.media.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "";
    make("image", {
      x: session.media.getAttribute("x") || 0,
      y: session.media.getAttribute("y") || 0,
      width: session.media.getAttribute("width") || 0,
      height: session.media.getAttribute("height") || 0,
      href,
      preserveAspectRatio: session.media.getAttribute("preserveAspectRatio") || "xMidYMid meet",
      transform: `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`,
      opacity: .38,
      "pointer-events": "none",
    });
    make("path", {
      d: `M0 0H${editor.size[0]}V${editor.size[1]}H0Z M${polygon.replaceAll(" ", "L")}Z`,
      class: "ov-crop-shade",
    });
    make("polygon", { points: polygon, class: "ov-crop-frame", "stroke-width": 2 * px });
    g.points.forEach((p, i) => make("rect", {
      x: p.x - 9 * px, y: p.y - 9 * px, width: 18 * px, height: 18 * px, rx: 3 * px,
      class: "ov-crop-handle", "stroke-width": 2 * px, "data-crop-handle": names[i],
    }));
    return true;
  }
  function onPointerDown(e) {
    if (!valid()) return false;
    const handle = e.target?.getAttribute?.("data-crop-handle");
    // Only handles belong to the crop. Anything else (a second finger, a tap on
    // the stage) goes to the canvas to pan, zoom or change the selection, which
    // cancels the crop. While a handle is held, a stray second pointer is ignored.
    if (!handle) {
      if (session.drag) return true;
      canvasPointers.add(e.pointerId);
      return false;
    }
    if (session.drag) return true;
    session.drag = { id: e.pointerId, handle, crop: [...session.crop] };
    editor.host.setPointerCapture(e.pointerId); e.preventDefault();
    return true;
  }
  // Aspect lock. The ratio is that of the visible crop (in the image's own units)
  // when the drag began. A corner follows the pointer along the crop's diagonal
  // with the opposite corner fixed. An edge handle sets that axis and the other
  // axis follows symmetrically about the crop's centre, so the crop grows and
  // shrinks around its middle (easy to steer with a thumb on an iPad). Both are
  // clamped to the image, so the pointer can run past the image without the
  // crop losing its shape.
  function locked(next, changed, q, side, start, { x, y, w, h }) {
    const [sl, st, sr, sb] = start;
    const L = x + w * sl / 100, T = y + h * st / 100, R = x + w * (1 - sr / 100), B = y + h * (1 - sb / 100);
    const r = (R - L) / (B - T);
    if (!(r > 0) || !Number.isFinite(r)) return;
    const horiz = side.includes("w") || side.includes("e"), vert = side.includes("n") || side.includes("s");
    const sx = side.includes("e") ? 1 : -1, sy = side.includes("s") ? 1 : -1;
    const ax = sx > 0 ? L : R, ay = sy > 0 ? T : B;           // fixed corner or edge
    const cx = (L + R) / 2, cy = (T + B) / 2;
    const minH = Math.max(h * MIN_REMAINING / 100, w * MIN_REMAINING / 100 / r);
    let height;
    if (horiz && vert) {
      const dw = Math.max(0, sx * (q.x - ax)), dh = Math.max(0, sy * (q.y - ay));
      height = (dw * r + dh) / (r * r + 1);
      height = Math.min(height, (sx > 0 ? x + w - ax : ax - x) / r, sy > 0 ? y + h - ay : ay - y);
    } else if (horiz) {
      height = Math.max(0, sx * (q.x - ax)) / r;
      height = Math.min(height, 2 * Math.min(cy - y, y + h - cy), (sx > 0 ? x + w - ax : ax - x) / r);
    } else {
      height = Math.max(0, sy * (q.y - ay));
      height = Math.min(height, (sy > 0 ? y + h - ay : ay - y), 2 * Math.min(cx - x, x + w - cx) / r);
    }
    height = Math.max(height, minH);
    const width = height * r;
    let l = L, t = T, rr = R, b = B;
    if (horiz) { if (sx > 0) rr = L + width; else l = R - width; } else { l = cx - width / 2; rr = cx + width / 2; }
    if (vert) { if (sy > 0) b = T + height; else t = B - height; } else { t = cy - height / 2; b = cy + height / 2; }
    next[0] = (l - x) / w * 100; next[1] = (t - y) / h * 100;
    next[2] = (x + w - rr) / w * 100; next[3] = (y + h - b) / h * 100;
  }
  function onPointerMove(e, p) {
    if (!valid() || session.drag?.id !== e.pointerId) return false;
    const g = geometry(), q = g.inv.transformPoint(p), next = [...session.crop];
    const { x, y, w, h } = g.local, side = session.drag.handle, changed = [];
    if (side.includes("w")) { next[0] = (q.x - x) / w * 100; changed.push(0); }
    if (side.includes("e")) { next[2] = (x + w - q.x) / w * 100; changed.push(2); }
    if (side.includes("n")) { next[1] = (q.y - y) / h * 100; changed.push(1); }
    if (side.includes("s")) { next[3] = (y + h - q.y) / h * 100; changed.push(3); }
    if ((session.aspect || e.shiftKey) && w > 0 && h > 0) {
      locked(next, changed, q, side, session.drag.crop, { x, y, w, h });
      changed.push(0, 1, 2, 3);
    }
    preview(next, session.mask, changed);
    e.preventDefault();
    return true;
  }
  function onPointerUp(e) {
    canvasPointers.delete(e.pointerId);
    if (!session) return false;
    if (session.drag?.id !== e.pointerId) { queueMicrotask(afterCanvasGesture); return false; }
    session.drag = null; e.preventDefault(); return true;
  }
  // Runs once the canvas has handled a pointer release.
  function afterCanvasGesture() {
    if (!session || canvasPointers.size) return;
    if (session.suspended) {
      session.suspended = false;
      if (editor.selection.length !== 1 || editor.selection[0] !== session.media) {
        finish(false);
        editor.hooks?.select?.(editor.selection);
        return;
      }
      session.original = snapshot(session.media);
      editor.begin();
      const { media } = session;
      if (session.crop.join() !== cropOf(media).join() || session.mask !== (media.getAttribute("data-mask") || "rect")) preview(session.crop, session.mask);
      return;
    }
    // The canvas may have committed its own gesture (moving the media) and with it the crop.
    if (editor.before === null) finish(true);
  }
  function onPointerCancel(e) {
    canvasPointers.delete(e.pointerId);
    if (session && session.drag?.id !== e.pointerId) queueMicrotask(afterCanvasGesture);
    if (!session || session.drag?.id !== e.pointerId) return false;
    const crop = session.drag.crop; session.drag = null; preview(crop, session.mask); e.preventDefault(); return true;
  }
  function onKeyDown(e) {
    if (!session || !valid()) return false;
    // Keys typed into the notes, a commit message or any other field are theirs.
    const target = e.target instanceof Element ? e.target : document.activeElement;
    if (target && !dialog.contains(target) && target.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return false;
    if (e.key === "Escape" || (e.key.toLowerCase() === "z" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault(); e.stopPropagation(); finish(false); return true;
    }
    if (e.key === "Enter") {
      e.preventDefault(); e.stopPropagation();
      if (dialog.contains(document.activeElement)) document.activeElement.blur();
      finish(true);
      return true;
    }
    return false;
  }
  document.addEventListener("keydown",onKeyDown,true);
  const api = { open, render, drawOverlay, onPointerDown, onPointerMove, onPointerUp, onPointerCancel,
    cancel() {
      if (!canvasPointers.size) return finish(false);
      if (!session || session.suspended) return;
      // Put the slide back now so the canvas gesture cannot commit half a crop.
      session.suspended = true;
      restore();
      if (typeof editor.abort === "function") editor.abort(); else editor.before = null;
    },
    finish: () => finish(true), active: () => !!session,
    // Keep the crop's proportions while dragging handles. Applies to the open
    // crop session only (a new session starts unlocked); ignored with no session.
    setAspectLock(on) {
      if (!session) return false;
      session.aspect = !!on; render();
      return session.aspect;
    },
    aspectLocked: () => !!session?.aspect,
    replace,
    onLoad() {
      if (session) finish(false);
      else { dialog.replaceChildren(); if (dialog.open) dialog.close(); }
    },
  };
  editor.mediaTools = api;
  return api;
}
