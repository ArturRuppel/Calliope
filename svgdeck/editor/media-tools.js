import { SVGNS } from "./geom.js";

const clamp = (v) => Math.max(0, Math.min(49.5, Number.isFinite(+v) ? +v : 0));
const cropOf = (el) => (el?.getAttribute("data-crop") || "0 0 0 0").split(/[ ,]+/).slice(0, 4).map(clamp).concat([0, 0, 0, 0]).slice(0, 4);

/** Non-destructive crop and mask controls for image and movie-image objects. */
export function installMediaTools({ editor, toast = () => {}, settle = () => {} }) {
  let media = null;
  let sessionSvg = null;
  const dialog = document.createElement("dialog");
  dialog.className = "media-tools";
  dialog.setAttribute("aria-label", "Crop and mask media");
  document.body.appendChild(dialog);

  const selectedMedia = () => editor.selection.length === 1 && editor.selection[0].localName === "image" ? editor.selection[0] : null;
  const currentMedia = () => {
    if (!sessionSvg || editor.svg !== sessionSvg) return null;
    if (media && editor.svg.contains(media)) return media;
    return null;
  };
  const clipId = (el) => /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)$/.exec(el?.getAttribute("clip-path") || "")?.[1] || null;
  const ownedClip = (el) => (el.hasAttribute("data-crop") || el.hasAttribute("data-mask")) ? clipId(el) : null;
  const existingForeignClip = (el) => el.hasAttribute("clip-path") && !ownedClip(el);
  const clipUsers = (id) => Array.from(editor.svg.querySelectorAll("[clip-path]")).filter((el) => clipId(el) === id);

  function ensureDefs() {
    let defs = Array.from(editor.svg.children).find((el) => el.localName === "defs");
    if (!defs) { defs = document.createElementNS(SVGNS, "defs"); editor.svg.prepend(defs); }
    return defs;
  }

  function uniqueId() {
    let id, n = 1;
    do id = `svgdeck-clip-${n++}`; while (editor.svg.querySelector(`#${CSS.escape(id)}`));
    return id;
  }

  function writeClip(el, crop, mask) {
    let id = ownedClip(el), clip = id && editor.svg.querySelector(`#${CSS.escape(id)}`);
    if (clip && clipUsers(id).some((user) => user !== el)) {
      const clone = clip.cloneNode(true);
      id = uniqueId(); clone.id = id; ensureDefs().appendChild(clone); clip = clone;
    }
    if (!clip) {
      id = uniqueId();
      clip = document.createElementNS(SVGNS, "clipPath");
      clip.id = id;
      clip.setAttribute("clipPathUnits", "objectBoundingBox");
      ensureDefs().appendChild(clip);
    }
    const [l, t, r, b] = crop.map((v) => v / 100), w = Math.max(.001, 1 - l - r), h = Math.max(.001, 1 - t - b);
    const shape = document.createElementNS(SVGNS, mask === "ellipse" ? "ellipse" : "rect");
    if (mask === "ellipse") {
      shape.setAttribute("cx", l + w / 2); shape.setAttribute("cy", t + h / 2);
      shape.setAttribute("rx", w / 2); shape.setAttribute("ry", h / 2);
    } else {
      shape.setAttribute("x", l); shape.setAttribute("y", t);
      shape.setAttribute("width", w); shape.setAttribute("height", h);
    }
    clip.replaceChildren(shape);
    el.setAttribute("data-svgdeck-clip", id);
    el.setAttribute("clip-path", `url(#${id})`);
  }

  function apply(crop, mask) {
    media = currentMedia();
    if (!media) return;
    if (existingForeignClip(media)) { toast("This media already has an imported clip path. Remove it before using Crop & mask."); return; }
    editor.change(() => {
      const vals = crop.map(clamp);
      media.setAttribute("data-crop", vals.map((v) => +v.toFixed(2)).join(" "));
      media.setAttribute("data-mask", mask === "ellipse" ? "ellipse" : "rect");
      writeClip(media, vals, mask);
    });
    render();
  }

  function reset() {
    media = currentMedia();
    if (!media) return;
    editor.change(() => {
      const id = ownedClip(media);
      if (id && clipUsers(id).every((user) => user === media)) editor.svg.querySelector(`#${CSS.escape(id)}`)?.remove();
      media.removeAttribute("data-crop");
      media.removeAttribute("data-mask");
      media.removeAttribute("data-svgdeck-clip");
      if (id) media.removeAttribute("clip-path");
    });
    render();
  }

  function render() {
    media = currentMedia() || selectedMedia();
    dialog.replaceChildren();
    if (!media) return dialog;
    const crop = cropOf(media), mask = media.getAttribute("data-mask") || "rect";
    const title = document.createElement("strong"); title.textContent = media.hasAttribute("data-video") ? "Crop movie" : "Crop image";
    dialog.appendChild(title);
    const fields = document.createElement("div"); fields.className = "media-crop-fields";
    ["Left", "Top", "Right", "Bottom"].forEach((name, i) => {
      const label = document.createElement("label"); label.textContent = `${name} `;
      const input = document.createElement("input"); input.type = "number"; input.min = "0"; input.max = "49.5"; input.step = "0.5";
      input.value = crop[i]; input.dataset.cropSide = name.toLowerCase();
      input.addEventListener("change", () => { const next = cropOf(media); next[i] = clamp(input.value); apply(next, maskSelect.value); });
      label.append(input, "%"); fields.appendChild(label);
    });
    const maskLabel = document.createElement("label"); maskLabel.textContent = "Mask ";
    const maskSelect = document.createElement("select"); maskSelect.dataset.mediaMask = "";
    for (const [value, text] of [["rect", "Rectangle"], ["ellipse", "Ellipse"]]) {
      const option = document.createElement("option"); option.value = value; option.textContent = text; option.selected = value === mask; maskSelect.appendChild(option);
    }
    maskSelect.addEventListener("change", () => apply(cropOf(media), maskSelect.value));
    maskLabel.appendChild(maskSelect);
    const resetButton = document.createElement("button"); resetButton.type = "button"; resetButton.textContent = "Reset"; resetButton.addEventListener("click", reset);
    const close = document.createElement("button"); close.type = "button"; close.textContent = "Done"; close.addEventListener("click", () => dialog.close());
    dialog.append(fields, maskLabel, resetButton, close);
    return dialog;
  }

  function open() {
    settle();
    media = selectedMedia();
    if (!media) { toast("Select one image or movie to crop."); return false; }
    sessionSvg = editor.svg;
    render();
    if (!dialog.open) dialog.showModal();
    return true;
  }

  const api = { open, render, onLoad() {
    if (dialog.open) dialog.close();
    media = null; sessionSvg = null; dialog.replaceChildren();
  } };
  editor.mediaTools = api;
  return api;
}
