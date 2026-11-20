// Figure mode: the editor as a figure workshop for a document (docs/format.md,
// "Figure mode"). Opened with ?mode=figures on the edit page. It hides what
// belongs to presenting and lists the deck's slides as Figures and Material.
// Without the parameter nothing here runs and the editor is as it always was.
import { rootBox, unionBox, localMatrix, setTransform, toRoot } from "./geom.js";

const SVGNS = "http://www.w3.org/2000/svg";
const params = new URLSearchParams(location.search);
export const FIGURE_MODE = params.get("mode") === "figures";
/** The slide to open first (?slide=<id>). */
export const START_SLIDE = params.get("slide");

/** The document's figures, in its order, from ?figs=<slide>~<number>~<label>,…
 *  (the writing app knows the numbers and labels; the deck does not). */
export function figureLinks(value = params.get("figs")) {
  const links = new Map();
  for (const part of (value || "").split(",")) {
    const [slide, number, label = ""] = part.split("~");
    if (!slide || !/^[A-Za-z0-9_-]{1,64}$/.test(slide)) continue;
    links.set(slide, { number: /^\d{1,4}$/.test(number || "") ? +number : null, label: label.slice(0, 64) });
  }
  return links;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
export const kindOf = (entry) => entry?.kind || "slide";

/** Letters in reading order: rows from the top (a letter less than a letter
 *  height lower is on the same row), each row from the left. */
export function readingOrder(items, rowHeight) {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  const rows = [];
  for (const item of sorted) {
    const row = rows.find((r) => Math.abs(r.y - item.y) < rowHeight);
    if (row) row.items.push(item); else rows.push({ y: item.y, items: [item] });
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
}

export function installFigureMode(ctx) {
  const { editor, state, DECK, el, section, row, buttonRow, toast, guard } = ctx;
  const links = figureLinks();
  document.body.classList.add("figure-mode");

  const entry = (id = state.current) => state.deck.slides.find((s) => s.id === id);
  const style = () => {
    const s = state.deck.figureStyle || {};
    return { width: s.width || null, textSize: s.textSize || 9, letterSize: s.letterSize || 10.5,
             font: s.font || null };
  };
  const family = () => {
    const wanted = style().font;
    return wanted && state.faces.some((f) => f.family === wanted) ? wanted : null;
  };

  /** Figures first, in the document's order (the ones it does not name after
   *  them, in deck order), then everything else as material. */
  function groups() {
    const slides = state.deck.slides;
    const figures = slides.filter((s) => kindOf(s) === "figure");
    figures.sort((a, b) => {
      const la = links.get(a.id), lb = links.get(b.id);
      const na = la?.number ?? Infinity, nb = lb?.number ?? Infinity;
      return na - nb || slides.indexOf(a) - slides.indexOf(b);
    });
    return { figures, material: slides.filter((s) => kindOf(s) !== "figure") };
  }

  function title(s) {
    if (kindOf(s) === "figure") {
      const link = links.get(s.id);
      if (link?.number) return `Figure ${link.number}${link.label ? ` · ${link.label}` : ""}`;
      return s.name || "Figure (not in the document)";
    }
    const { material } = groups();
    return s.name || `${kindOf(s) === "material" ? "Board" : "Slide"} ${material.indexOf(s) + 1}`;
  }

  /** The strip as two lists; `item(s, label)` makes one thumbnail row. */
  function renderStrip(ol, item) {
    const { figures, material } = groups();
    const head = (text, n) => el("li", { class: "strip-head", role: "presentation" }, text, el("small", {}, String(n)));
    ol.append(head("Figures", figures.length));
    if (!figures.length) ol.append(el("li", { class: "strip-empty", role: "presentation" }, "No figures yet. Add one from the document."));
    for (const s of figures) ol.append(item(s, title(s)));
    ol.append(head("Material", material.length));
    for (const s of material) ol.append(item(s, title(s)));
  }

  // --- canvas size -------------------------------------------------------------------
  async function setSize(w, h) {
    const id = state.current, rec = state.slides.get(id);
    if (!rec || !(w >= 1 && h >= 1 && w <= 100000 && h <= 100000)) { toast("Choose a size from 1 to 100000."); return; }
    ctx.settle();
    const before = editor.serialize();
    const after = ctx.resizedSlide(before, +(+w).toFixed(2), +(+h).toFixed(2));
    if (after === before) return;
    rec.undo.push(before);
    if (rec.undo.length > 150) rec.undo.shift();
    rec.redo = [];
    ctx.markDirty(id, after);
    editor.load(after, { keepView: true });
    ctx.renderPanel();
  }

  /** The box around everything but the background and layout boxes. */
  function contentBox() {
    const items = Array.from(editor.svg.children).filter((c) =>
      !["defs", "style", "title", "desc", "metadata"].includes(c.localName) &&
      c.getAttribute("data-label") !== "background" && c.getAttribute("data-layout") !== "true" &&
      c.getAttribute("data-hidden") !== "true");
    return unionBox(items.map((c) => rootBox(c, editor.svg)).filter((b) => b && (b.width || b.height)));
  }

  async function fitToContent(heightOnly) {
    const box = contentBox();
    if (!box) { toast("There is nothing on it to fit."); return; }
    const [w, h] = editor.size;
    const pad = heightOnly ? 0 : 20;
    await setSize(heightOnly ? w : Math.ceil(box.x + box.width + pad), Math.ceil(box.y + box.height + pad));
  }

  // --- panel letters -----------------------------------------------------------------
  const letterNodes = () => Array.from(editor.svg.querySelectorAll("text[data-panel-letter]"));

  function styleLetter(t, letter) {
    const s = style();
    t.textContent = letter;
    t.setAttribute("data-panel-letter", letter);
    t.setAttribute("data-label", `Letter ${letter}`);
    t.style.setProperty("font-family", ctx.cssFamily(family() || ctx.defaultFamily()));
    t.style.setProperty("font-weight", "700");
    t.style.setProperty("font-size", `${s.letterSize}px`);
    t.style.setProperty("fill", "#000000");
    t.style.setProperty("white-space", "pre");
  }

  function addLetter() {
    const used = new Set(letterNodes().map((t) => t.getAttribute("data-panel-letter")));
    const letter = [...LETTERS].find((l) => !used.has(l)) || "z";
    const box = editor.selection.length ? editor.selectionBox() : null;
    const c = editor.visibleCenter();
    const size = style().letterSize;
    const x = box ? box.x : c.x, y = box ? box.y + size * 0.75 : c.y;
    ctx.settle();
    editor.change(() => {
      const t = document.createElementNS(SVGNS, "text");
      t.setAttribute("x", String(+x.toFixed(2)));
      t.setAttribute("y", String(+y.toFixed(2)));
      styleLetter(t, letter);
      editor.context = editor.svg;
      editor.svg.appendChild(t);
      editor.selection = [t];
    });
    if (family()) ctx.ensureFamily(family());
  }

  /** a, b, c… in reading order, all in the letter style. */
  function renumberLetters() {
    const letters = letterNodes();
    if (!letters.length) { toast("No panel letters on this figure yet."); return; }
    const items = letters.map((t) => ({ t, ...(rootBox(t, editor.svg) || { x: 0, y: 0 }) }));
    ctx.settle();
    editor.change(() => {
      readingOrder(items, style().letterSize).forEach((item, i) => styleLetter(item.t, LETTERS[i] || "z"));
    });
    toast(`Lettered ${letters.length} panel${letters.length === 1 ? "" : "s"} a to ${LETTERS[Math.min(letters.length, 26) - 1]}.`);
  }

  // --- text at the document's size ----------------------------------------------------
  /** Every text in `root` at the figure text size (letters at the letter size), whatever scaling it lies under. */
  function documentSizes(root) {
    const s = style();
    for (const t of root.querySelectorAll("text")) {
      const m = toRoot(t, editor.svg);
      const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
      const want = t.hasAttribute("data-panel-letter") ? s.letterSize : s.textSize;
      t.style.setProperty("font-size", `${+(want / scale).toFixed(3)}px`);
      t.removeAttribute("font-size");
      for (const span of t.querySelectorAll("tspan")) { span.style.removeProperty("font-size"); span.removeAttribute("font-size"); }
    }
  }

  let offer = null;
  function closeOffer() { offer?.remove(); offer = null; }
  function offerSizes(group) {
    closeOffer();
    const texts = group.querySelectorAll("text").length;
    if (!texts) return;
    const s = style();
    offer = el("div", { class: "figure-offer", role: "dialog", "aria-label": "Text sizes" },
      el("span", {}, `${texts} text${texts === 1 ? "" : "s"} came with it. Set ${texts === 1 ? "it" : "them"} to the document's size (${s.textSize} pt)?`),
      el("button", { type: "button", class: "btn small primary", id: "figure-offer-set", onclick: () => {
        closeOffer();
        if (!group.isConnected) return;
        editor.change(() => documentSizes(group));
        toast(`Text set to ${s.textSize} pt.`);
      } }, "Set sizes"),
      el("button", { type: "button", class: "btn small", onclick: closeOffer }, "Keep"));
    document.body.append(offer);
    setTimeout(closeOffer, 30000);
  }

  // --- copy to a figure ---------------------------------------------------------------
  async function copyToFigure(targetId) {
    const clip = editor.copy();
    if (!clip) { toast("Select what to copy first."); return; }
    const target = entry(targetId);
    if (!target) return;
    await ctx.flush();
    if (!(await ctx.openSlide(targetId))) return;
    let group = null;
    editor.change(() => {
      editor.context = editor.svg;
      editor.select([]);
      if (!editor.paste(clip)) return;
      const items = [...editor.selection];
      if (!items.length) return;
      group = document.createElementNS(SVGNS, "g");
      group.setAttribute("data-label", "Panel");
      items[items.length - 1].after(group);
      for (const item of items) group.appendChild(item);
      const b = rootBox(group, editor.svg);
      const [W, H] = editor.size;
      if (b && b.width && b.height) {
        const s = Math.min(W / b.width, H / b.height);
        setTransform(group, new DOMMatrix().scaleSelf(s, s).translateSelf(-b.x, -b.y).multiplySelf(localMatrix(group)));
      }
      editor.selection = [group];
    });
    if (group) {
      toast(`Copied to ${title(target)}. The board keeps the original.`);
      offerSizes(group);
    }
  }

  // --- copy to another deck ----------------------------------------------------------
  /** The selection as a slide of its own: its box plus a margin. */
  function selectionSlide() {
    const clip = editor.copy();
    const box = editor.selectionBox();
    if (!clip || !box) return null;
    const { defs, items } = JSON.parse(clip);
    const pad = 20, w = Math.ceil(box.width + 2 * pad), h = Math.ceil(box.height + 2 * pad);
    return `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="${SVGNS}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xml:space="preserve">
<defs>${defs.join("")}</defs>
<rect id="background" data-label="background" data-locked="true" width="${w}" height="${h}" fill="#ffffff"/>
<g data-label="Copied" transform="translate(${+(pad - box.x).toFixed(3)} ${+(pad - box.y).toFixed(3)})">${items.join("")}</g>
</svg>
`;
  }

  async function copyToDeck(what) {
    await ctx.flush();
    const decks = (await ctx.api.json("GET", "/api/decks")).filter((d) => d.name !== DECK);
    if (!decks.length) { toast("There is no other deck to copy to."); return; }
    const svg = what === "selection" ? selectionSlide() : null;
    if (what === "selection" && !svg) { toast("Select what to copy first."); return; }
    const deck = await choose(what === "selection" ? "Copy the selection to…" : "Copy this slide to…",
      decks.map((d) => ({ label: d.title || d.name, sub: d.name, value: d.name })));
    if (!deck) return;
    const body = what === "selection"
      ? { svg, kind: "material", name: "Copied selection", from: { deck: DECK } }
      : { kind: kindOf(entry()) === "figure" ? "material" : kindOf(entry()), from: { deck: DECK, slide: state.current } };
    await ctx.api.json("POST", `/api/decks/${encodeURIComponent(deck)}/slides`, body);
    toast(`Copied to ${deck} as a material board. Nothing here changed.`);
  }

  // --- new boards ----------------------------------------------------------------------
  async function addBoard() {
    await ctx.flush();
    const n = groups().material.length + 1;
    const res = await ctx.deckWrite(async () => {
      const r = await ctx.api.json("POST", `/api/decks/${DECK}/slides`, { kind: "material", name: `Board ${n}`, after: state.current });
      state.deck = r.deck;
      state.version = r.deckVersion;
      return r;
    });
    ctx.renderStrip();
    await ctx.openSlide(res.id);
  }

  // --- a chooser ------------------------------------------------------------------------
  function choose(heading, items) {
    return new Promise((resolve) => {
      const dialog = el("dialog", { class: "settings-dialog figure-choose", "aria-label": heading });
      const done = (value) => { dialog.close(); dialog.remove(); resolve(value); };
      dialog.append(
        el("header", {}, el("h2", {}, heading), el("button", { class: "btn icon-btn", "aria-label": "Close", onclick: () => done(null) }, "×")),
        el("div", { class: "panel settings-body" }, el("div", { class: "choose-list" },
          items.map((i) => el("button", { type: "button", class: "btn choose-item", onclick: () => done(i.value) },
            el("span", {}, i.label), i.sub ? el("small", {}, i.sub) : null)))));
      dialog.addEventListener("cancel", () => done(null));
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  function chooseFigure() {
    const { figures } = groups();
    if (!figures.length) { toast("This deck has no figures yet. Add one from the document."); return; }
    choose("Copy to figure", figures.map((s) => ({ label: title(s), value: s.id })))
      .then((id) => id && guard(() => copyToFigure(id), "Could not copy to the figure")());
  }

  // --- what the editor asks ----------------------------------------------------------------
  const onFigure = () => kindOf(entry()) === "figure";
  const onMaterial = () => !onFigure();

  return {
    links, groups, title, renderStrip, addBoard, entry,
    position: () => (state.current ? title(entry()) : ""),
    /** New text and shapes on a figure are at the figure's sizes. */
    textStyle(s) { return onFigure() ? { ...s, size: style().textSize, family: family() || s.family } : s; },
    shapeStyle(s) { return onFigure() ? { ...s, strokeWidth: Math.min(s.strokeWidth, 1) } : s; },
    /** Sections of the Design tab with nothing selected. */
    slideSections() {
      const [w, h] = editor.size;
      if (onFigure()) {
        const s = style();
        return [section("Figure",
          row("Width", el("span", { class: "num" }, `${+w.toFixed(2)} pt`)),
          row("Height", ctx.numberControl(h, { min: 10, max: 100000, step: 1, suffix: "pt" }, (v) => guard(() => setSize(w, v), "Could not change the height")())),
          buttonRow([["Fit height to content", "Make the figure as tall as what is on it", guard(() => fitToContent(true), "Could not fit the height")]]),
          el("p", { class: "hint" }, `The width is the document's text width: what measures ${s.textSize} pt here prints at ${s.textSize} pt.`)),
        section("Panel letters",
          buttonRow([["Add letter", "Add the next panel letter (at the selection's corner)", addLetter],
                     ["Renumber", "Letter the panels a, b, c… in reading order, all alike", renumberLetters]]),
          el("p", { class: "hint" }, `Bold, ${s.letterSize} pt. Renumber orders them by rows, from the top left.`))];
      }
      return [section("Board",
        row("Size", el("span", { class: "num" },
          ctx.numberControl(w, { min: 16, max: 100000, step: 1 }, (v) => guard(() => setSize(v, editor.size[1]), "Could not resize")()), "×",
          ctx.numberControl(h, { min: 16, max: 100000, step: 1 }, (v) => guard(() => setSize(editor.size[0], v), "Could not resize")()))),
        buttonRow([["Fit to content", "Make the board just large enough for what is on it", guard(() => fitToContent(false), "Could not fit")],
                   ["Copy board to deck…", "Copy this board into another deck", guard(() => copyToDeck("slide"), "Could not copy")]]),
        el("p", { class: "hint" }, "Collect snapshots, drawings, plots and notes here. Select some and choose Copy to figure; the board keeps them."))];
    },
    /** Extra items of the actions menu. */
    menuActions(action, count) {
      if (count && onMaterial()) action("Copy to figure…", chooseFigure);
      if (count) action("Copy to another deck…", guard(() => copyToDeck("selection"), "Could not copy"));
      if (onFigure()) action("Add panel letter", addLetter);
      if (onFigure()) action("Renumber panel letters", renumberLetters);
    },
    slideMenu: () => copyToDeck("slide"),
    /** Buttons for the selection bar. */
    barButtons(barButton) {
      if (onMaterial()) return [barButton("To figure", "Copy the selection to a figure (it stays here)", chooseFigure, { id: "copy-to-figure" })];
      return [barButton("Letter", "Add a panel letter at the selection's corner", addLetter, { id: "add-letter" })];
    },
    closeOffer,
    // for tests
    copyToFigure, addLetter, renumberLetters, setSize, fitToContent, documentSizes,
  };
}
