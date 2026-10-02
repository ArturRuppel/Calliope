// Non-destructive picture adjustments, saved as native SVG filters in the slide SVG.
export const IMAGE_ADJUSTMENTS = [
  {key: "saturation", label: "Saturation", min: 0, max: 1000, initial: 100, unit: "%", css: "saturate"},
  {key: "hue", label: "Hue shift", min: -180, max: 180, initial: 0, unit: "°", css: "hue-rotate"},
  {key: "brightness", label: "Brightness", min: 0, max: 1000, initial: 100, unit: "%", css: "brightness"},
  {key: "contrast", label: "Contrast", min: 0, max: 1000, initial: 100, unit: "%", css: "contrast"},
];
const ORIGINAL = "data-image-original-filter";
const OWNED = "data-svgdeck-image-filter";
const SVGNS = "http://www.w3.org/2000/svg";
const urlId = value => /^url\(\s*["']?#([^"')\s]+)["']?\s*\)$/.exec(value)?.[1];
function node(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}
function ownedFilter(image) {
  if (!image.hasAttribute(OWNED)) return null;
  const refs = [...image.style.filter.matchAll(/url\(\s*["']?#([^"')\s]+)/g)];
  return refs.at(-1)?.[1] || image.getAttribute(OWNED);
}
function removeUnusedFilter(svg, id) {
  if (!id || [...svg.querySelectorAll("image")].some(image => ownedFilter(image) === id)) return;
  const filter = svg.querySelector(`#${CSS.escape(id)}`);
  if (filter?.hasAttribute("data-image-adjustment-filter")) filter.remove();
}
function writeFilter(image) {
  const svg = image.ownerSVGElement;
  const old = ownedFilter(image);
  const base = image.getAttribute(ORIGINAL) || image.getAttribute("filter") || "";
  // Clone imported native filters before adding adjustments; never edit shared defs.
  const baseId = urlId(base);
  const source = baseId && svg.querySelector(`#${CSS.escape(baseId)}`);
  const filter = source?.localName === "filter" ? source.cloneNode(true) : node("filter", {});
  // Rewrite our own filter in place while this image is its only user (a slider
  // drag runs this per input event); a shared one is cloned before it changes.
  const owned = old && svg.querySelector(`#${CSS.escape(old)}`);
  const reuse = owned?.localName === "filter" && owned.hasAttribute("data-image-adjustment-filter") &&
    ![...svg.querySelectorAll("image")].some(other => other !== image && ownedFilter(other) === old);
  let id = old, n = 1;
  if (!reuse) do id = `svgdeck-image-filter-${n++}`; while (svg.querySelector(`#${CSS.escape(id)}`));
  filter.id = id;
  filter.setAttribute("data-image-adjustment-filter", "true");
  filter.setAttribute("data-image-adjustment-version", "2");
  filter.setAttribute("color-interpolation-filters", "sRGB");
  const [saturation, hue, brightness, contrast] = IMAGE_ADJUSTMENTS.map(spec => adjustmentValue(image, spec));
  filter.append(node("feColorMatrix", {type:"saturate", values:saturation / 100}),
    node("feColorMatrix", {type:"hueRotate", values:hue}));
  // Apply contrast first, then brightness, so even a flat gray image can
  // be darkened to black or brightened to white.
  for (const [slope, intercept] of [[contrast / 100, (1 - contrast / 100) / 2], [brightness / 100, 0]]) {
    const transfer = node("feComponentTransfer", {});
    for (const channel of ["R", "G", "B"]) transfer.append(node(`feFunc${channel}`, {type:"linear", slope, intercept}));
    filter.append(transfer);
  }
  if (reuse) {
    for (const { name } of [...owned.attributes]) if (name !== "id") owned.removeAttribute(name);
    for (const { name, value } of filter.attributes) owned.setAttribute(name, value);
    owned.replaceChildren(...filter.childNodes);
  } else {
    let defs = svg.querySelector(":scope > defs");
    if (!defs) { defs = node("defs", {}); svg.prepend(defs); }
    defs.append(filter);
  }
  const prefix = base && base !== "none" && !source ? `${base} ` : "";
  image.style.setProperty("filter", `${prefix}url(#${id})`);
  image.setAttribute(OWNED, id);
  removeUnusedFilter(svg, old);
}

export function adjustmentValue(image, spec) {
  const raw = image.getAttribute(`data-image-${spec.key}`);
  const value = raw === null ? spec.initial : Number(raw);
  return Number.isFinite(value) ? Math.max(spec.min, Math.min(spec.max, value)) : spec.initial;
}

function restoreFilter(image) {
  if (!image.hasAttribute(ORIGINAL)) return;
  const old = ownedFilter(image);
  const original = image.getAttribute(ORIGINAL);
  if (original) image.style.setProperty("filter", original);
  else image.style.removeProperty("filter");
  image.removeAttribute(ORIGINAL);
  image.removeAttribute(OWNED);
  removeUnusedFilter(image.ownerSVGElement, old);
}

export function setImageAdjustment(editor, spec, value, images = editor.selection, preview = false) {
  if (!Number.isFinite(value)) return;
  const targets = images.filter(image => image.localName === "image" && !image.hasAttribute("data-video"));
  if (!targets.length) return;
  const apply = () => {
    for (const image of targets) {
      const next = Math.max(spec.min, Math.min(spec.max, value));
      if (image.hasAttribute(OWNED) && adjustmentValue(image, spec) === next) continue;
      if (!image.hasAttribute(ORIGINAL)) image.setAttribute(ORIGINAL, image.style.getPropertyValue("filter"));
      image.setAttribute(`data-image-${spec.key}`, String(Math.max(spec.min, Math.min(spec.max, value))));
      const active = IMAGE_ADJUSTMENTS.filter(s => adjustmentValue(image, s) !== s.initial);
      if (!active.length) {
        restoreFilter(image);
        for (const s of IMAGE_ADJUSTMENTS) image.removeAttribute(`data-image-${s.key}`);
        continue;
      }
      writeFilter(image);
    }
  };
  // Keep a drag or numeric edit as one undo step, with a live canvas preview.
  if (preview) { editor.begin(); apply(); }
  else editor.change(apply);
}

export function resetImageAdjustments(editor, images = editor.selection) {
  editor.change(() => {
    for (const image of images) {
      if (image.localName !== "image" || image.hasAttribute("data-video")) continue;
      restoreFilter(image);
      for (const s of IMAGE_ADJUSTMENTS) image.removeAttribute(`data-image-${s.key}`);
    }
  });
}

// Upgrade older filter pipelines when a saved slide opens; retain adjustment values.
export function upgradeImageAdjustments(editor) {
  const images = [...editor.svg.querySelectorAll("image")].filter(image => {
    if (!image.hasAttribute(ORIGINAL) || image.hasAttribute("data-video")) return false;
    const id = ownedFilter(image);
    const filter = id && editor.svg.querySelector(`#${CSS.escape(id)}`);
    return !filter || filter.getAttribute("data-image-adjustment-version") !== "2";
  });
  if (!images.length) return;
  // Not an edit: no undo step. Tell the controller the text changed so the
  // upgraded filters are saved and later undo steps start from them.
  for (const image of images) writeFilter(image);
  editor.hooks?.textChanged?.(editor.serialize());
}
