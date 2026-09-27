// Object tree and build-step editor for SVGDeck.
// The host calls render() after selection, load, and committed edits.

const SKIP = new Set(["defs", "title", "desc", "metadata", "style", "script"]);
const NON_ARTWORK = new Set([...SKIP, "clipPath", "mask", "marker", "pattern", "symbol"]);
const SVGNS = "http://www.w3.org/2000/svg";
const MAX_STEP = 999;

export function installObjects({ editor, state, toast, settle, mount = document.body }) {
  let mode = "objects";
  let preview = null;
  let renderedSlide = null;
  let dragging = null;

  ensureCss();
  const panel = document.createElement("aside");
  panel.className = "objects-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Objects and builds");
  // Editing resumes from the full artwork, even if a build preview hides the
  // object the user is about to select or change.
  editor.host.addEventListener("pointerdown", () => exitPreview(), true);
  panel.addEventListener("focusin", (e) => { if (!e.target.closest(".build-preview")) exitPreview(); });
  mount.append(panel);

  function ensureCss() {
    if (document.querySelector('link[data-svgdeck-objects]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/editor/objects.css";
    link.dataset.svgdeckObjects = "";
    document.head.append(link);
  }

  const objectChildren = (parent) => Array.from(parent?.children || []).filter((el) => !SKIP.has(el.localName));
  const isBackground = (el) => el.getAttribute("data-label") === "background";
  const isMovie = (el) => el.matches("image[data-video]");
  const locked = (el) => el.getAttribute("data-locked") === "true";
  const hidden = (el) => {
    if (el.getAttribute("data-hidden") === "true") return true;
    const style = getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse";
  };
  const ownStep = (el) => {
    const n = Number.parseInt(el.getAttribute("data-step") || "", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const ancestorHas = (el, test) => {
    for (let p = el.parentElement; p && p !== editor.svg; p = p.parentElement) if (test(p)) return true;
    return false;
  };
  const blockedByAncestor = (el) => ancestorHas(el, (parent) => locked(parent) || hidden(parent));
  const blocked = (el) => locked(el) || hidden(el) || blockedByAncestor(el);
  const artwork = (el) => {
    for (let node = el; node && node !== editor.svg; node = node.parentElement) {
      if (NON_ARTWORK.has(node.localName)) return false;
    }
    return true;
  };
  const label = (el) => el.getAttribute("data-label") || el.id || ({
    g: "Group", text: "Text", image: isMovie(el) ? "Movie" : "Image", rect: "Rectangle",
    circle: "Circle", ellipse: "Ellipse", line: "Line", path: "Path", polygon: "Polygon", polyline: "Polyline",
  }[el.localName] || el.localName);

  function button(text, title, action, className = "") {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = text; b.title = title; b.setAttribute("aria-label", title);
    b.className = className; b.addEventListener("click", action); return b;
  }

  function mutate(fn) {
    exitPreview();
    settle?.();
    editor.begin();
    try { fn(); } finally { editor.commit(); }
    draw(false);
  }

  function selectObject(el) {
    exitPreview();
    if (!el?.isConnected) return;
    if (!editor.selectable(el) || blockedByAncestor(el)) {
      toast?.("Unlock and show the object and its groups before editing it.");
      return;
    }
    // Selecting from the tree also enters the object's editable parent group.
    editor.context = el.parentElement === editor.svg ? editor.svg : el.parentElement;
    editor.select([el]);
    draw(false);
  }

  function rename(el) {
    if (isBackground(el) || blocked(el)) { toast?.("Locked or hidden objects cannot be renamed."); return; }
    const old = label(el);
    const next = prompt("Object name", old);
    if (next === null) return;
    if (next.trim().toLowerCase() === "background") {
      toast?.('“background” is reserved for the slide background.');
      return;
    }
    mutate(() => {
      const value = next.trim();
      if (value) el.setAttribute("data-label", value); else el.removeAttribute("data-label");
    });
  }

  function toggleHidden(el) {
    if (isBackground(el)) return;
    if (blockedByAncestor(el)) { toast?.("Show and unlock the containing group first."); return; }
    mutate(() => {
      if (hidden(el)) {
        el.removeAttribute("data-hidden");
        const previous = el.getAttribute("data-svgdeck-display");
        if (previous !== null) { el.style.display = previous; el.removeAttribute("data-svgdeck-display"); }
        else el.style.removeProperty("display");
        const previousVisibility = el.getAttribute("data-svgdeck-visibility");
        if (previousVisibility !== null) { el.style.visibility = previousVisibility; el.removeAttribute("data-svgdeck-visibility"); }
        else el.style.removeProperty("visibility");
        // Imported attributes or stylesheet rules can remain hidden after the
        // inline editor state is restored. “Show” is an explicit override.
        const computed = getComputedStyle(el);
        if (computed.display === "none") el.style.setProperty("display", "inline", "important");
        if (computed.visibility === "hidden" || computed.visibility === "collapse") el.style.setProperty("visibility", "visible", "important");
        if (!el.getAttribute("style")) el.removeAttribute("style");
      } else {
        el.setAttribute("data-hidden", "true");
        el.setAttribute("data-svgdeck-display", el.style.display || "");
        el.setAttribute("data-svgdeck-visibility", el.style.visibility || "");
        el.style.setProperty("display", "none", "important");
        editor.selection = editor.selection.filter((selected) => selected !== el && !el.contains(selected));
        leaveBlockedContext(el);
      }
    });
  }

  function toggleLocked(el) {
    if (isBackground(el)) return;
    if (blockedByAncestor(el)) { toast?.("Show and unlock the containing group first."); return; }
    mutate(() => {
      if (locked(el)) el.removeAttribute("data-locked"); else el.setAttribute("data-locked", "true");
      if (locked(el)) {
        editor.selection = editor.selection.filter((selected) => selected !== el && !el.contains(selected));
        leaveBlockedContext(el);
      }
    });
  }

  function leaveBlockedContext(el) {
    if (editor.context !== el && !el.contains(editor.context)) return;
    let context = el.parentElement;
    while (context && context !== editor.svg && (locked(context) || hidden(context) || blockedByAncestor(context))) context = context.parentElement;
    editor.context = context && editor.svg.contains(context) ? context : editor.svg;
  }

  function reorder(el, delta) {
    if (blocked(el)) { toast?.("Show and unlock the object and its group before reordering it."); return; }
    const siblings = objectChildren(el.parentElement);
    const i = siblings.indexOf(el), target = siblings[i + delta];
    if (!target || isBackground(el) || isBackground(target)) return;
    mutate(() => delta < 0 ? target.before(el) : target.after(el));
  }

  function dropBefore(el, target) {
    if (!el || !target || el === target || el.parentElement !== target.parentElement || isBackground(el) || isBackground(target)) return;
    if (blocked(el) || blocked(target)) { toast?.("Show and unlock both objects before reordering them."); return; }
    // The tree is reverse DOM order (topmost first), so visually before means
    // after the target in SVG paint order.
    mutate(() => target.after(el));
  }

  function rowFor(el, depth) {
    const li = document.createElement("li");
    li.className = "object-row";
    li.style.setProperty("--depth", depth);
    li.dataset.selected = String(editor.selection.includes(el));
    li.dataset.locked = String(locked(el) || ancestorHas(el, locked));
    li.dataset.hidden = String(hidden(el) || ancestorHas(el, hidden));
    li.draggable = !isBackground(el);
    li.addEventListener("dragstart", (event) => { dragging = el; event.dataTransfer.effectAllowed = "move"; });
    li.addEventListener("dragover", (event) => { if (dragging?.parentElement === el.parentElement) event.preventDefault(); });
    li.addEventListener("drop", (event) => { event.preventDefault(); dropBefore(dragging, el); dragging = null; });
    li.addEventListener("dragend", () => { dragging = null; });

    const name = button(label(el), `Select ${label(el)}`, () => selectObject(el), "object-name");
    const kind = document.createElement("span"); kind.className = "object-kind"; kind.textContent = el.localName === "g" ? "group" : el.localName;
    li.append(name, kind);
    if (ancestorHas(el, hidden)) li.append(icon("◌", "Hidden by group"));
    else li.append(button(hidden(el) ? "◌" : "●", hidden(el) ? "Show object" : "Hide object", () => toggleHidden(el)));
    if (ancestorHas(el, locked)) li.append(icon("▣", "Locked by group"));
    else li.append(button(locked(el) ? "▣" : "□", locked(el) ? "Unlock object" : "Lock object", () => toggleLocked(el)));
    li.append(button("✎", "Rename object", () => rename(el)));
    if (!isBackground(el)) {
      li.append(button("↑", "Raise object", () => reorder(el, 1)), button("↓", "Lower object", () => reorder(el, -1)));
    }
    if (el.localName === "g") {
      const enter = button("Enter group", "Enter group", () => { editor.enterGroup(el); draw(false); }, "group-enter");
      enter.disabled = blocked(el);
      li.append(enter);
    }
    if (isBackground(el)) {
      for (const control of li.querySelectorAll('button[aria-label="Rename object"],button[aria-label="Hide object"],button[aria-label="Show object"]')) control.disabled = true;
    }
    return li;
  }

  function icon(text, title) {
    const span = document.createElement("span"); span.textContent = text; span.title = title; span.className = "object-state"; return span;
  }

  function appendTree(list, parent, depth = 0) {
    // Topmost objects are shown first, matching the visual stack.
    for (const el of objectChildren(parent).reverse()) {
      list.append(rowFor(el, depth));
      if (el.localName === "g") appendTree(list, el, depth + 1);
    }
  }

  function drawObjects(body) {
    const tools = document.createElement("div"); tools.className = "objects-tools";
    tools.append(button("Leave group", "Leave current group", () => { editor.exitGroup(); draw(false); }));
    tools.lastChild.disabled = editor.context === editor.svg;
    const hint = document.createElement("p"); hint.className = "objects-hint";
    hint.textContent = "Manage the objects on this slide: name them, show or hide them, lock them, and enter groups. The top of this list is the front of the slide. Drag within a group to reorder, or use the arrows.";
    const tree = document.createElement("ul"); tree.className = "object-tree"; tree.setAttribute("aria-label", "Slide objects");
    appendTree(tree, editor.svg);
    body.append(tools, hint, tree);
  }

  function buildEntries() {
    const all = Array.from(editor.svg?.querySelectorAll("[data-step]") || []).filter(artwork);
    return all.sort((a, b) => ownStep(a) - ownStep(b) || documentOrder(a, b));
  }

  function documentOrder(a, b) {
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  function setStep(el, value) {
    if (blocked(el)) { toast?.("Show and unlock the object and its group before changing builds."); return; }
    const n = validStep(value);
    if (n === null) { toast?.(`Build steps must be whole numbers from 0 to ${MAX_STEP}.`); draw(false); return; }
    mutate(() => {
      if (n) el.setAttribute("data-step", String(n)); else el.removeAttribute("data-step");
    });
  }

  function validStep(value) {
    const n = Number(value);
    return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= MAX_STEP ? n : null;
  }

  function renumber(entries) {
    if (entries.some(blocked)) { toast?.("Show and unlock every build object before renumbering."); return; }
    const groups = [...new Set(entries.map(ownStep))].sort((a, b) => a - b);
    const steps = new Map(groups.map((old, i) => [old, i + 1]));
    mutate(() => entries.forEach((el) => el.setAttribute("data-step", String(steps.get(ownStep(el))))));
  }

  function previewAt(step) {
    exitPreview();
    const style = document.createElement("style");
    style.dataset.svgdeckBuildPreview = "";
    const selectors = buildEntries().filter((el) => ownStep(el) > step)
      .map((el) => `[data-step="${CSS.escape(el.getAttribute("data-step"))}"]:not(defs,clipPath,mask,marker,pattern,symbol):not(defs *,clipPath *,mask *,marker *,pattern *,symbol *)`);
    style.textContent = selectors.length ? `.svgdeck-build-preview ${selectors.join(",.svgdeck-build-preview ")}{visibility:hidden!important}` : "";
    document.head.append(style);
    editor.page.classList.add("svgdeck-build-preview");
    preview = { step, style };
    drawBuilds(panel.querySelector(".objects-body"), true);
  }

  function exitPreview() {
    if (!preview) return;
    preview.style.remove();
    editor.page?.classList.remove("svgdeck-build-preview");
    preview = null;
  }

  function drawBuilds(body, replace = false) {
    if (replace) body.replaceChildren();
    const stepped = buildEntries();
    const max = Math.min(MAX_STEP, stepped.reduce((n, el) => Math.max(n, ownStep(el)), 0));
    const previewBox = document.createElement("div"); previewBox.className = "build-preview";
    const range = document.createElement("input"); range.type = "range"; range.min = "0"; range.max = String(max); range.step = "1";
    range.value = String(preview?.step ?? max); range.setAttribute("aria-label", "Preview build step");
    const value = document.createElement("output"); value.textContent = range.value === "0" ? "Initial" : `Step ${range.value}`;
    range.addEventListener("input", () => previewAt(Number(range.value)));
    previewBox.append(range, value, button("Exit preview", "Show every object and exit preview", () => { exitPreview(); draw(false); }));
    previewBox.lastChild.disabled = !preview;

    const assign = document.createElement("div"); assign.className = "build-assign";
    const selected = editor.selection.filter((el) => el !== editor.svg && !SKIP.has(el.localName));
    const input = document.createElement("input"); input.type = "number"; input.min = "0"; input.step = "1"; input.inputMode = "numeric";
    input.value = selected.length === 1 ? String(ownStep(selected[0])) : ""; input.placeholder = "0"; input.max = String(MAX_STEP);
    input.setAttribute("aria-label", "Build step for selected objects");
    const apply = button("Assign", "Assign build step to selected objects", () => {
      if (!selected.length) { toast?.("Select one or more objects first."); return; }
      if (selected.some(blocked)) { toast?.("Show and unlock selected objects and their groups first."); return; }
      const n = validStep(input.value);
      if (n === null) { toast?.(`Build steps must be whole numbers from 0 to ${MAX_STEP}.`); return; }
      mutate(() => selected.forEach((el) => {
        if (n) el.setAttribute("data-step", String(n)); else el.removeAttribute("data-step");
      }));
    });
    assign.append(input, apply);

    const list = document.createElement("ol"); list.className = "build-list"; list.setAttribute("aria-label", "Build sequence");
    for (const el of stepped) {
      const li = document.createElement("li");
      const name = button(label(el), `Select ${label(el)}`, () => selectObject(el), "object-name");
      const n = document.createElement("input"); n.type = "number"; n.min = "0"; n.max = String(MAX_STEP); n.step = "1"; n.value = String(ownStep(el));
      n.disabled = blocked(el);
      n.setAttribute("aria-label", `Build step for ${label(el)}`);
      n.addEventListener("change", () => setStep(el, n.value));
      li.append(name, n, button("×", "Remove from builds", () => setStep(el, 0)));
      list.append(li);
    }
    const normalize = button("Number in this order", "Assign consecutive build steps", () => renumber(stepped));
    normalize.disabled = !stepped.length;
    const explanation = document.createElement("p"); explanation.className = "objects-hint";
    explanation.textContent = "Builds reveal objects one step at a time while presenting. For example, show a question first, then its answer on the next click. Step 0 means visible from the start; objects with the same step appear together. This does not create new slides.";
    body.append(explanation, previewBox, assign, list, normalize);
  }

  function draw(external = true) {
    if (external || renderedSlide !== state.current) exitPreview();
    renderedSlide = state.current;
    if (!editor.svg) return;
    panel.replaceChildren();
    const header = document.createElement("header");
    const title = document.createElement("h2"); title.textContent = mode === "objects" ? "Objects" : "Presentation builds";
    header.append(title, button("×", "Close panel", () => { exitPreview(); panel.hidden = true; }));
    const tabs = document.createElement("div"); tabs.className = "object-tabs"; tabs.setAttribute("role", "tablist");
    for (const name of ["objects", "builds"]) {
      const b = button(name === "objects" ? "Objects" : "Builds · reveal order", `Open ${name}`, () => { exitPreview(); mode = name; draw(false); });
      b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(mode === name)); tabs.append(b);
    }
    const body = document.createElement("div"); body.className = "objects-body";
    if (mode === "objects") drawObjects(body); else drawBuilds(body);
    panel.append(header, tabs, body);
  }

  function open(nextMode = "objects") {
    if (nextMode === "objects") exitPreview();
    mode = nextMode === "builds" ? "builds" : "objects";
    panel.hidden = false;
    draw(false);
    panel.querySelector('[role="tab"][aria-selected="true"]')?.focus();
  }

  return { render: () => draw(true), open };
}
