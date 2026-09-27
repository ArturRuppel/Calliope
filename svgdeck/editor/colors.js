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

function swatch(color, label, pick, selected = false, result = color) {
  const button = element("button", { type: "button", class: `swatch color-swatch${selected ? " on" : ""}`,
    title: label, "aria-label": label, style: `--swatch:${color}` });
  button.addEventListener("click", () => pick(result));
  return button;
}

export function createColorControl(value, onPick, { allowNone = false, palette = DEFAULT_PALETTE,
  recent = [], onRecent = () => {} } = {}) {
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
  const error = element("p", { class: "color-error", role: "alert", hidden: "" }, "Enter a valid colour value.");
  const cancel = element("button", { type: "button" }, "Cancel");
  const apply = element("button", { type: "button", class: "color-apply" }, "Apply");
  const dialog = element("dialog", { class: "color-editor", "aria-label": "Custom colour" },
    element("form", { method: "dialog" },
      element("header", {}, element("h2", {}, "Custom colour")),
      element("div", { class: "color-preview-row" }, preview, native),
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
    const parsed = parseColor(value);
    if (!parsed) { error.hidden = false; hex.setAttribute("aria-invalid", "true"); return; }
    hex.removeAttribute("aria-invalid");
    draft = { ...parsed, a: /^#[\da-f]{4}(?:[\da-f]{4})?$/i.test(value) ? parsed.a : draft.a };
    synchronize(hex);
  };
  hex.addEventListener("input", readHex);
  hsl.addEventListener("input", () => {
    const value = hsl.value.trim();
    const parsed = parseColor(value.startsWith("hsl") ? value : `hsl(${value})`);
    if (!parsed) { error.hidden = false; hsl.setAttribute("aria-invalid", "true"); return; }
    const explicitAlpha = /^hsla/i.test(value) || /\//.test(value) || (value.match(/[+-]?(?:\d+\.?\d*|\.\d+)/g) || []).length === 4;
    hsl.removeAttribute("aria-invalid"); draft = { ...parsed, a: explicitAlpha ? parsed.a : draft.a }; synchronize(hsl);
  });
  // RGB accepts either "12, 34, 56" or a complete rgb()/rgba() expression.
  rgb.addEventListener("input", () => {
    const value = rgb.value.trim();
    const parsed = parseColor(value.startsWith("rgb") ? value : `rgb(${value})`);
    if (!parsed) { error.hidden = false; rgb.setAttribute("aria-invalid", "true"); return; }
    const explicitAlpha = /^rgba/i.test(value) || /\//.test(value) || (value.match(/[+-]?(?:\d+\.?\d*|\.\d+)/g) || []).length === 4;
    rgb.removeAttribute("aria-invalid"); draft = { ...parsed, a: explicitAlpha ? parsed.a : draft.a }; synchronize(rgb);
  });
  native.addEventListener("input", () => { const parsed = parseColor(native.value); draft = { ...parsed, a: draft.a }; synchronize(native); });
  const setAlpha = (source) => {
    const number = Number(source.value);
    if (!Number.isFinite(number) || number < 0 || number > 100) { error.hidden = false; source.setAttribute("aria-invalid", "true"); return; }
    source.removeAttribute("aria-invalid"); draft.a = number / 100; synchronize(source);
  };
  alpha.addEventListener("input", () => setAlpha(alpha));
  alphaNumber.addEventListener("input", () => setAlpha(alphaNumber));
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
