const DEFAULT_PALETTE = [
  "#000000", "#ffffff", "#d32f2f", "#f57c00", "#fbc02d", "#388e3c",
  "#00838f", "#1976d2", "#512da8", "#c2185b",
];

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const byte = (value) => clamp(Math.round(value), 0, 255);
const hexByte = (value) => byte(value).toString(16).padStart(2, "0");
const cleanNumber = (value, places = 2) => String(+Number(value).toFixed(places));

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = clamp(s / 100, 0, 1);
  l = clamp(l / 100, 0, 1);
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - chroma / 2;
  let rgb = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] :
    h < 180 ? [0, chroma, x] : h < 240 ? [0, x, chroma] :
      h < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return rgb.map((part) => byte((part + m) * 255));
}

function rgbToHsl(r, g, b) {
  const values = [r, g, b].map((part) => clamp(part / 255, 0, 1));
  const max = Math.max(...values), min = Math.min(...values);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness * 100];
  const delta = max - min;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = max === values[0] ? ((values[1] - values[2]) / delta) % 6 :
    max === values[1] ? (values[2] - values[0]) / delta + 2 :
      (values[0] - values[1]) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  return [hue, saturation * 100, lightness * 100];
}

function alphaPart(text) {
  text = text.trim();
  const value = parseFloat(text);
  if (text.endsWith("%")) return value >= 0 && value <= 100 ? value / 100 : NaN;
  return value >= 0 && value <= 1 ? value : NaN;
}

function parseColor(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  let match = text.match(/^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i);
  if (match) {
    let raw = match[1];
    if (raw.length <= 4) raw = [...raw].map((digit) => digit + digit).join("");
    return { r: parseInt(raw.slice(0, 2), 16), g: parseInt(raw.slice(2, 4), 16),
      b: parseInt(raw.slice(4, 6), 16), a: raw.length === 8 ? parseInt(raw.slice(6), 16) / 255 : 1 };
  }
  match = text.match(/^rgba?\(\s*([+-]?(?:\d+\.?\d*|\.\d+)%?)\s*[, ]\s*([+-]?(?:\d+\.?\d*|\.\d+)%?)\s*[, ]\s*([+-]?(?:\d+\.?\d*|\.\d+)%?)(?:\s*[,/]\s*([+-]?(?:\d+\.?\d*|\.\d+)%?))?\s*\)$/);
  if (match) {
    const channel = (part) => part.endsWith("%") ? byte(parseFloat(part) * 2.55) : byte(parseFloat(part));
    const parts = [match[1], match[2], match[3]];
    if (parts.some((part) => {
      const number = parseFloat(part);
      return !Number.isFinite(number) || number < 0 || number > (part.endsWith("%") ? 100 : 255);
    })) return null;
    const alpha = match[4] == null ? 1 : alphaPart(match[4]);
    if (!Number.isFinite(alpha)) return null;
    return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha };
  }
  match = text.match(/^hsla?\(\s*([+-]?(?:\d+\.?\d*|\.\d+))(?:deg)?\s*[, ]\s*([+-]?(?:\d+\.?\d*|\.\d+))%\s*[, ]\s*([+-]?(?:\d+\.?\d*|\.\d+))%(?:\s*[,/]\s*([+-]?(?:\d+\.?\d*|\.\d+)%?))?\s*\)$/);
  if (match) {
    const values = match.slice(1, 4).map(Number);
    if (values.some((part) => !Number.isFinite(part)) || values[1] < 0 || values[1] > 100 || values[2] < 0 || values[2] > 100) return null;
    const [r, g, b] = hslToRgb(values[0], values[1], values[2]);
    const alpha = match[4] == null ? 1 : alphaPart(match[4]);
    if (!Number.isFinite(alpha)) return null;
    return { r, g, b, a: alpha };
  }
  return null;
}

// Any other CSS colour (a name, a computed style) via the canvas, which
// normalises what it understands to #rrggbb or rgba().
function anyColor(text) {
  const parsed = parseColor(text);
  if (parsed || !text) return parsed;
  const context = document.createElement("canvas").getContext("2d");
  const seen = ["#010203", "#040506"].map((sentinel) => {
    context.fillStyle = sentinel; context.fillStyle = text; return context.fillStyle;
  });
  return seen[0] === seen[1] ? parseColor(seen[0]) : null;
}

// Whether typed or pasted text names its own opacity ("#rgba", "rgba(…)", "… / 50%").
const statesAlpha = (text) => /^#?(?:[\da-f]{4}|[\da-f]{8})$/i.test(text) || /^(?:rgba|hsla)/i.test(text) ||
  /\//.test(text) || (text.match(/[+-]?(?:\d+\.?\d*|\.\d+)/g) || []).length === 4;

function cssColor(color) {
  if (color.a >= 0.9999) return `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`;
  return `rgba(${byte(color.r)}, ${byte(color.g)}, ${byte(color.b)}, ${cleanNumber(clamp(color.a, 0, 1), 3)})`;
}

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else if (value != null) node.setAttribute(name, value);
  }
  node.append(...children.flat().filter((child) => child != null));
  return node;
}

function eyedropperIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(ns, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "m14 7 3 3M5 19l1.5-.5L16 9l-1-1-9.5 9.5zM14 6l1.6-1.6a2.1 2.1 0 0 1 3 3L17 9");
  icon.append(path);
  return icon;
}

function swatch(color, label, pick, selected = false, result = color) {
  const button = element("button", { type: "button", class: `swatch color-swatch${selected ? " on" : ""}`,
    title: label, "aria-label": label, style: `--swatch:${color}` });
  button.addEventListener("click", () => pick(result));
  return button;
}

const paintColor = (paint) => /^(?:none|url\(|context-)/.test(paint || "none") ? null : anyColor(paint);

// The image's own pixel under a screen point, through its transform and
// preserveAspectRatio. Image adjustments (filters) are not applied.
async function imagePixel(image, x, y, cache) {
  const href = image.href.baseVal;
  if (!href) return null;
  if (!cache.has(href)) {
    const source = new Image();
    source.src = new URL(href, document.baseURI).href;
    cache.set(href, source.decode().then(() => source, () => null));
  }
  const source = await cache.get(href);
  const matrix = image.getScreenCTM();
  if (!source || !matrix) return null;
  const point = new DOMPoint(x, y).matrixTransform(matrix.inverse());
  const box = [image.x, image.y, image.width, image.height].map((length) => length.baseVal.value);
  const [width, height] = [source.naturalWidth, source.naturalHeight];
  const { align, meetOrSlice } = image.preserveAspectRatio.baseVal;
  let u, v;
  if (align === SVGPreserveAspectRatio.SVG_PRESERVEASPECTRATIO_NONE) {
    u = (point.x - box[0]) * width / box[2];
    v = (point.y - box[1]) * height / box[3];
  } else {
    const fit = meetOrSlice === SVGPreserveAspectRatio.SVG_MEETORSLICE_SLICE ? Math.max : Math.min;
    const scale = fit(box[2] / width, box[3] / height);
    const step = Math.max(0, align - SVGPreserveAspectRatio.SVG_PRESERVEASPECTRATIO_XMINYMIN);
    u = (point.x - box[0] - (box[2] - width * scale) * (step % 3) / 2) / scale;
    v = (point.y - box[1] - (box[3] - height * scale) * Math.floor(step / 3) / 2) / scale;
  }
  if (!(u >= 0 && v >= 0 && u < width && v < height)) return null;
  const canvas = Object.assign(document.createElement("canvas"), { width: 1, height: 1 });
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(source, Math.floor(u), Math.floor(v), 1, 1, 0, 0, 1, 1);
  try {
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return a ? { r, g, b, a: a / 255 } : null;
  } catch (error) { return null; }  // a cross-origin image
}

// The colour the topmost painted thing inside `area` shows at a screen point:
// a shape's line or fill, a text's fill, an image's pixel.
export async function sampleColor(area, x, y, cache = new Map()) {
  for (const node of document.elementsFromPoint(x, y)) {
    if (!area.contains(node)) continue;
    if (node instanceof SVGImageElement) {
      const pixel = await imagePixel(node, x, y, cache);
      if (pixel) return pixel;
      continue;
    }
    if (!(node instanceof SVGGraphicsElement) || node instanceof SVGSVGElement || node instanceof SVGGElement) continue;
    const style = getComputedStyle(node);
    const stroke = paintColor(style.stroke), fill = paintColor(style.fill);
    let onStroke = false;
    if (stroke && node instanceof SVGGeometryElement && node.getScreenCTM()) {
      const point = new DOMPoint(x, y).matrixTransform(node.getScreenCTM().inverse());
      try { onStroke = node.isPointInStroke(point); } catch (error) { /* not rendered */ }
    }
    const color = onStroke || !fill ? stroke : fill;
    if (color) return color;
  }
  return null;
}

async function copyText(text, host) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch (error) { /* fall back */ }
  }
  // Plain HTTP has no async clipboard: copy a selected field, as the menu would.
  const buffer = element("textarea", { class: "color-copy-buffer", readonly: "", "aria-hidden": "true", tabindex: "-1" });
  buffer.value = text;
  host.append(buffer);
  buffer.select(); buffer.setSelectionRange(0, text.length);
  let copied = false;
  try { copied = document.execCommand("copy"); } catch (error) { /* unsupported */ }
  buffer.remove();
  return copied;
}

export function createColorControl(value, onPick, { allowNone = false, palette = DEFAULT_PALETTE,
  recent = [], onRecent = () => {}, sampleArea = null } = {}) {
  const initial = parseColor(value) || { r: 0, g: 0, b: 0, a: 1 };
  const currentCss = value === "none" ? "none" : cssColor(initial);
  const root = element("div", { class: "color-control" });
  const choices = element("div", { class: "color-choices", role: "group", "aria-label": "Colour choices" });
  const remember = (color) => {
    if (color !== "none") onRecent(color);
    onPick(color);
  };
  for (const color of [...new Set([...recent, ...palette])].slice(0, 16)) {
    const parsed = parseColor(color);
    if (parsed) choices.append(swatch(cssColor(parsed), color, remember, cssColor(parsed) === currentCss));
  }
  if (allowNone) {
    const none = swatch("transparent", "No colour", remember, value === "none" || !value, "none");
    none.classList.add("none");
    choices.append(none);
  }

  const custom = element("button", { type: "button", class: "color-custom", "aria-haspopup": "dialog" },
    element("span", { class: "color-current", style: `--swatch:${currentCss === "none" ? "transparent" : currentCss}` }),
    "Custom…");
  choices.append(custom);
  root.append(choices);

  const preview = element("div", { class: "color-preview", "aria-label": "Colour preview" });
  const native = element("input", { type: "color", value: `#${hexByte(initial.r)}${hexByte(initial.g)}${hexByte(initial.b)}`,
    "aria-label": "Visual colour picker" });
  const hex = element("input", { value: native.value.toUpperCase(), spellcheck: "false", inputmode: "text", "aria-label": "HEX" });
  const rgb = element("input", { value: `${initial.r}, ${initial.g}, ${initial.b}`, spellcheck: "false", inputmode: "decimal", "aria-label": "RGB" });
  const [ih, is, il] = rgbToHsl(initial.r, initial.g, initial.b);
  const hsl = element("input", { value: `${cleanNumber(ih)}, ${cleanNumber(is)}%, ${cleanNumber(il)}%`, spellcheck: "false",
    inputmode: "decimal", "aria-label": "HSL" });
  const alpha = element("input", { type: "range", min: "0", max: "100", step: "1", value: String(Math.round(initial.a * 100)),
    "aria-label": "Opacity" });
  const alphaNumber = element("input", { type: "number", min: "0", max: "100", step: "1", value: String(Math.round(initial.a * 100)),
    inputmode: "decimal", "aria-label": "Opacity percent" });
  const dropper = element("button", { type: "button", class: "color-dropper", title: "Pick a colour from the slide",
    hidden: sampleArea ? null : "" }, eyedropperIcon(), "Pick from slide");
  const copy = element("button", { type: "button", class: "color-copy" }, "Copy colour");
  const paste = element("button", { type: "button", class: "color-paste",
    hidden: window.isSecureContext && navigator.clipboard?.readText ? null : "" }, "Paste colour");
  const error = element("p", { class: "color-error", role: "alert", hidden: "" }, "Enter a valid colour value.");
  const cancel = element("button", { type: "button" }, "Cancel");
  const apply = element("button", { type: "button", class: "color-apply" }, "Apply");
  const dialog = element("dialog", { class: "color-editor", "aria-label": "Custom colour" },
    element("form", { method: "dialog" },
      element("header", {}, element("h2", {}, "Custom colour")),
      element("div", { class: "color-preview-row" }, preview, native),
      element("div", { class: "color-tools" }, dropper, copy, paste),
      element("label", {}, element("span", {}, "HEX"), hex),
      element("label", {}, element("span", {}, "RGB"), rgb),
      element("label", {}, element("span", {}, "HSL"), hsl),
      element("label", { class: "color-alpha" }, element("span", {}, "Opacity"), alpha, alphaNumber, "%"),
      error,
      element("footer", {}, cancel, apply)));
  root.append(dialog);

  let draft = { ...initial };
  const paint = () => { preview.style.setProperty("--preview", cssColor(draft)); };
  const synchronize = (source) => {
    const [h, s, l] = rgbToHsl(draft.r, draft.g, draft.b);
    if (source !== hex) hex.value = `#${hexByte(draft.r)}${hexByte(draft.g)}${hexByte(draft.b)}`.toUpperCase();
    if (source !== rgb) rgb.value = `${draft.r}, ${draft.g}, ${draft.b}`;
    if (source !== hsl) hsl.value = `${cleanNumber(h)}, ${cleanNumber(s)}%, ${cleanNumber(l)}%`;
    if (source !== native) native.value = `#${hexByte(draft.r)}${hexByte(draft.g)}${hexByte(draft.b)}`;
    alpha.value = alphaNumber.value = String(Math.round(draft.a * 100));
    for (const input of [hex, rgb, hsl, alpha, alphaNumber]) input.removeAttribute("aria-invalid");
    error.hidden = true;
    paint();
  };
  const readHex = () => {
    const value = hex.value.trim();
    const parsed = parseColor(/^[\da-f]+$/i.test(value) ? `#${value}` : value);
    if (!parsed) { error.hidden = false; hex.setAttribute("aria-invalid", "true"); return; }
    hex.removeAttribute("aria-invalid");
    draft = { ...parsed, a: statesAlpha(value) ? parsed.a : draft.a };
    synchronize(hex);
  };
  hex.addEventListener("input", readHex);
  hsl.addEventListener("input", () => {
    const value = hsl.value.trim();
    const parsed = parseColor(value.startsWith("hsl") ? value : `hsl(${value})`);
    if (!parsed) { error.hidden = false; hsl.setAttribute("aria-invalid", "true"); return; }
    hsl.removeAttribute("aria-invalid"); draft = { ...parsed, a: statesAlpha(value) ? parsed.a : draft.a }; synchronize(hsl);
  });
  // RGB accepts either "12, 34, 56" or a complete rgb()/rgba() expression.
  rgb.addEventListener("input", () => {
    const value = rgb.value.trim();
    const parsed = parseColor(value.startsWith("rgb") ? value : `rgb(${value})`);
    if (!parsed) { error.hidden = false; rgb.setAttribute("aria-invalid", "true"); return; }
    rgb.removeAttribute("aria-invalid"); draft = { ...parsed, a: statesAlpha(value) ? parsed.a : draft.a }; synchronize(rgb);
  });
  native.addEventListener("input", () => { const parsed = parseColor(native.value); draft = { ...parsed, a: draft.a }; synchronize(native); });
  const setAlpha = (source) => {
    const number = Number(source.value);
    if (!Number.isFinite(number) || number < 0 || number > 100) { error.hidden = false; source.setAttribute("aria-invalid", "true"); return; }
    source.removeAttribute("aria-invalid"); draft.a = number / 100; synchronize(source);
  };
  alpha.addEventListener("input", () => setAlpha(alpha));
  alphaNumber.addEventListener("input", () => setAlpha(alphaNumber));
  // A colour pasted into any field, in any notation, fills all of them.
  const take = (text, field) => {
    text = String(text || "").trim();
    const parsed = anyColor(text) || (field === hsl ? parseColor(`hsl(${text})`) : parseColor(`rgb(${text})`)) ||
      (field !== hsl && field !== rgb && /^[\da-f]{3,8}$/i.test(text) && parseColor(`#${text}`));
    if (!parsed) return false;
    draft = { ...parsed, a: statesAlpha(text) ? parsed.a : draft.a };
    synchronize();
    return true;
  };
  dialog.addEventListener("paste", (event) => {
    if (event.target === alpha || event.target === alphaNumber) return;
    if (take(event.clipboardData?.getData("text/plain"), event.target)) event.preventDefault();
  });
  const flash = (button, text) => {
    const label = button.dataset.label ||= button.textContent;
    button.textContent = text;
    clearTimeout(button.flash);
    button.flash = setTimeout(() => { button.textContent = label; }, 1400);
  };
  copy.addEventListener("click", async () => {
    const text = draft.a >= 0.9999 ? hex.value : cssColor(draft);
    const copied = await copyText(text, dialog.querySelector("form"));
    copy.focus();
    flash(copy, copied ? "Copied" : "Copy failed");
  });
  paste.addEventListener("click", async () => {
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch (error) { /* refused */ }
    if (!take(text)) flash(paste, "No colour");
  });
  dropper.addEventListener("click", () => {
    const area = typeof sampleArea === "function" ? sampleArea() : sampleArea;
    if (area) pickFrom(area);
  });

  // Picking hides the dialog and puts a layer over the page; the next tap or
  // click on the slide takes the colour under it (the opacity stays as set).
  const pickFrom = (area) => {
    const cache = new Map();
    const hint = element("p", { class: "color-sample-hint" }, "Tap a colour on the slide");
    const loupe = element("span", { class: "color-sample-loupe", hidden: "" });
    const stop = element("button", { type: "button" }, "Cancel");
    const layer = element("div", { class: "color-sample-layer", role: "dialog", "aria-label": "Pick a colour" },
      element("div", { class: "color-sample-bar" }, hint, stop), loupe);
    let pending = 0, found = null, down = false;
    const look = async (event) => {
      const ticket = ++pending;
      const color = await sampleColor(area, event.clientX, event.clientY, cache);
      if (ticket !== pending) return found;
      found = color;
      loupe.hidden = !color;
      if (color) {
        loupe.style.setProperty("--swatch", cssColor({ ...color, a: 1 }));
        // Above the finger or Pencil, which would cover it.
        loupe.style.left = `${event.clientX}px`;
        loupe.style.top = `${event.clientY}px`;
      }
      return color;
    };
    const finish = (color) => {
      layer.remove();
      window.removeEventListener("keydown", keys, true);
      if (!root.isConnected) return;
      if (color) { draft = { r: color.r, g: color.g, b: color.b, a: draft.a }; synchronize(); }
      dialog.showModal();
      dropper.focus();
    };
    const keys = (event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); finish(null); }
    };
    layer.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      if (event.target.closest("button")) return;
      event.preventDefault();
      down = true;
      layer.setPointerCapture?.(event.pointerId);
      look(event);
    });
    layer.addEventListener("pointermove", (event) => { if (down || event.pointerType === "mouse") look(event); });
    layer.addEventListener("pointerup", async (event) => {
      event.stopPropagation();
      if (!down) return;
      down = false;
      const color = await look(event);
      if (color) finish(color);
      else { hint.textContent = "No colour there. Tap a shape, text or image"; loupe.hidden = true; }
    });
    layer.addEventListener("pointercancel", () => { down = false; loupe.hidden = true; });
    for (const type of ["click", "contextmenu", "wheel"]) layer.addEventListener(type, (event) => event.stopPropagation());
    stop.addEventListener("click", () => finish(null));
    window.addEventListener("keydown", keys, true);
    dialog.close();
    document.body.append(layer);
    stop.focus();
  };

  custom.addEventListener("click", () => { draft = { ...initial }; synchronize(); dialog.showModal(); hex.focus(); hex.select(); });
  cancel.addEventListener("click", () => dialog.close());
  apply.addEventListener("click", () => {
    if (!error.hidden || [hex, rgb, hsl, alphaNumber].some((input) => input.getAttribute("aria-invalid") === "true")) return;
    const result = cssColor(draft);
    dialog.close(); remember(result);
  });
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); dialog.close(); }
  });
  dialog.addEventListener("click", (event) => event.stopPropagation());
  paint();
  return root;
}
