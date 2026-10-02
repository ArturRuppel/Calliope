/* svgdeck player: plays a deck of SVG slides with movies and build steps.
   Classic script (no modules) so it also runs from file:// in an export.
   Usage: SvgDeck.start(root, deck, {slideBase: "slides/"}) where deck is the
   parsed deck.json with each slide carrying its SVG source in `svg`.
   Print mode ({print: true} or {print: {notes, steps}}, or ?print=1,
   ?print=notes,steps, #print in the address) lays every slide out as a page
   instead of presenting. */
(function () {
  "use strict";
  const SVGNS = "http://www.w3.org/2000/svg";
  const XLINK = "http://www.w3.org/1999/xlink";
  const URL_REF = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g;

  // --- SVG transform attribute -> [a, b, c, d, e, f] ---------------------
  function multiply(m, n) {
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
            m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
            m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  }
  function parseTransform(text) {
    let m = [1, 0, 0, 1, 0, 0];
    const re = /(\w+)\s*\(([^)]*)\)/g;
    let match;
    while ((match = re.exec(text || ""))) {
      const v = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
      let t;
      switch (match[1]) {
        case "matrix": t = v; break;
        case "translate": t = [1, 0, 0, 1, v[0], v[1] || 0]; break;
        case "scale": t = [v[0], 0, 0, v.length > 1 ? v[1] : v[0], 0, 0]; break;
        case "rotate": {
          const r = v[0] * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
          t = [c, s, -s, c, 0, 0];
          if (v.length > 2) t = multiply(multiply([1, 0, 0, 1, v[1], v[2]], t), [1, 0, 0, 1, -v[1], -v[2]]);
          break;
        }
        case "skewX": t = [1, 0, Math.tan(v[0] * Math.PI / 180), 1, 0, 0]; break;
        case "skewY": t = [1, Math.tan(v[0] * Math.PI / 180), 0, 1, 0, 0]; break;
        default: continue;
      }
      m = multiply(m, t);
    }
    return m;
  }

  // --- slide construction ---------------------------------------------
  // Ids are made unique across slides and relative paths resolved, since all
  // slides share one HTML document.
  // The class that scopes a slide's <style> rules to that slide.
  const scopeOf = (prefix) => "sd-" + prefix.replace(/-$/, "");

  // Index of the first of `chars` outside quotes, parentheses and brackets.
  function skipTo(text, from, chars) {
    let depth = 0, quote = "";
    for (let i = from; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
      else if (!depth && chars.includes(c)) return i;
    }
    return -1;
  }
  // Index of the "}" closing the "{" at `open`.
  function closing(text, open) {
    let depth = 0, quote = "";
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return i;
    }
    return text.length;
  }

  // Slide CSS shares one document with every other slide: ids and url(#id)
  // get the slide's prefix and every selector is confined to its scope class.
  function scopeCss(css, prefix) {
    const scope = "." + scopeOf(prefix);
    css = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(URL_REF, (_, q, id) => `url(#${prefix}${id})`);
    const selector = (text) => {
      const parts = [];
      for (let i = 0; i < text.length;) {
        const comma = skipTo(text, i, ",");
        parts.push(text.slice(i, comma < 0 ? text.length : comma).trim());
        i = comma < 0 ? text.length : comma + 1;
      }
      return parts.filter(Boolean).map((part) => {
        part = part.replace(/\[[^\]]*\]|"[^"]*"|'[^']*'|#(-?[_a-zA-Z -￿][\w -￿-]*)/g,
          (m, id) => id ? `#${prefix}${id}` : m);
        return /^(:root|svg)(?![\w-])/.test(part) ? part.replace(/^(:root|svg)/, scope) : `${scope} ${part}`;
      }).join(",");
    };
    const rules = (text) => {
      let out = "";
      for (let i = 0; i < text.length;) {
        const stop = skipTo(text, i, "{;");
        if (stop < 0 || text[stop] === ";") {
          const end = stop < 0 ? text.length : stop + 1;
          out += text.slice(i, end); i = end; continue;
        }
        const end = closing(text, stop), prelude = text.slice(i, stop).trim(), body = text.slice(stop + 1, end);
        if (!prelude.startsWith("@")) out += `${selector(prelude)}{${body}}`;
        else if (/^@(media|supports|layer|container)\b/i.test(prelude)) out += `${prelude}{${rules(body)}}`;
        else out += `${prelude}{${body}}`;  // @font-face, @keyframes: no selectors to scope
        i = end + 1;
      }
      return out;
    };
    return rules(css);
  }

  function rewrite(el, prefix, base) {
    el.classList.add(scopeOf(prefix));
    rewriteNode(el, prefix, base);
  }
  function rewriteNode(el, prefix, base) {
    if (el.id) el.id = prefix + el.id;
    if (el.localName === "style") el.textContent = scopeCss(el.textContent, prefix);
    for (const attr of Array.from(el.attributes)) {
      const name = attr.localName;
      let value = attr.value;
      if (name === "href" || name === "data-video") {
        if (value.startsWith("#")) value = "#" + prefix + value.slice(1);
        else if (el.localName === "a" && name === "href") continue;  // a hyperlink, not a file of the deck
        else if (!/^(data:|[a-z]+:\/\/|\/)/i.test(value)) value = new URL(value, base).href;
      } else if (value.includes("url(")) {
        value = value.replace(URL_REF, (_, q, id) => `url(#${prefix}${id})`);
      }
      if (value !== attr.value) {
        if (attr.namespaceURI) el.setAttributeNS(attr.namespaceURI, attr.name, value);
        else el.setAttribute(attr.name, value);
      }
    }
    for (const child of el.children) rewriteNode(child, prefix, base);
  }

  function parseSlide(source) {
    const doc = new DOMParser().parseFromString(String(source), "image/svg+xml");
    const svg = doc.documentElement;
    if (!svg || svg.localName !== "svg" || doc.getElementsByTagName("parsererror").length) {
      throw new Error("not a valid SVG");
    }
    return svg;
  }

  // Root attributes the layers must inherit, since each layer is its own <svg>.
  const INHERITED = new Set(["style", "preserveAspectRatio", "xml:space", "xml:lang", "lang", "color", "direction",
    "unicode-bidi", "writing-mode", "text-anchor", "text-rendering", "letter-spacing", "word-spacing",
    "white-space", "dominant-baseline", "shape-rendering", "image-rendering", "color-interpolation",
    "color-interpolation-filters", "paint-order", "visibility", "clip-rule", "cursor", "pointer-events"]);
  const inheritedAttribute = (name) => INHERITED.has(name) || /^(font(-[a-z-]+)?|fill(-[a-z]+)?|stroke(-[a-z]+)?|marker(-[a-z]+)?)$/.test(name);

  // opts.prefix overrides the id prefix (print mode builds a slide once per
  // page); opts.posters keeps movies as their poster <image>.
  function buildSlide(source, index, defs, size, base, opts = {}) {
    const svg = parseSlide(source);
    const prefix = opts.prefix || `s${index}-`, scope = scopeOf(prefix);
    rewrite(svg, prefix, base);

    const slide = document.createElement("div");
    slide.className = "svgdeck-slide";
    const viewBox = svg.getAttribute("viewBox") || `0 0 ${size[0]} ${size[1]}`;
    const videos = [];
    let layer = null;
    // Definitions and top-level styles live in a scoped group of the shared
    // <defs>, so the slide's CSS reaches them and nothing else.
    const scoped = document.createElementNS(SVGNS, "g");
    scoped.setAttribute("class", scope);

    for (const child of Array.from(svg.children)) {
      if (child.localName === "defs") {
        for (const d of Array.from(child.children)) scoped.appendChild(document.importNode(d, true));
        continue;
      }
      if (child.localName === "style") { scoped.appendChild(document.importNode(child, true)); continue; }
      if (["title", "desc", "metadata"].includes(child.localName)) continue;
      if (!opts.posters && child.localName === "image" && child.hasAttribute("data-video")) {
        const video = makeVideo(child, size);
        videos.push(video);
        slide.appendChild(video);
        layer = null;
        continue;
      }
      if (!layer) {
        layer = document.createElementNS(SVGNS, "svg");
        layer.setAttribute("viewBox", viewBox);
        layer.setAttribute("class", "svgdeck-layer");
        for (const a of Array.from(svg.attributes)) {
          if (a.name === "class") layer.classList.add(...a.value.split(/\s+/).filter(Boolean));
          else if (inheritedAttribute(a.name)) {
            if (a.namespaceURI) layer.setAttributeNS(a.namespaceURI, a.name, a.value);
            else layer.setAttribute(a.name, a.value);
          }
        }
        slide.appendChild(layer);
      }
      layer.appendChild(document.importNode(child, true));
    }

    if (scoped.firstChild) defs.appendChild(scoped);
    const steps = Array.from(slide.querySelectorAll("[data-step]"));
    const maxStep = steps.reduce((m, el) => Math.max(m, parseInt(el.dataset.step, 10) || 0), 0);
    const stepVisibility = new Map(steps.map(el => [el, el.style.visibility]));
    return { el: slide, videos, steps, maxStep, stepVisibility };
  }

  function failedSlide(index) {
    const el = document.createElement("div");
    el.className = "svgdeck-slide svgdeck-failed";
    const message = document.createElement("p");
    message.className = "svgdeck-error"; message.setAttribute("role", "alert");
    message.textContent = `Slide ${index + 1} could not be loaded`;
    el.append(message);
    return { el, videos: [], steps: [], maxStep: 0, stepVisibility: new Map(), failed: true };
  }

  function makeVideo(image, size) {
    const video = document.createElement("video");
    video.className = "svgdeck-video";
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    video.preload = "none";
    video.movieRange = SvgDeckMovieRange.attach(video, SvgDeckMovieRange.read(image), image.getAttribute("data-loop") !== "false");
    video.dataset.src = image.getAttribute("data-video");  // kept: unloading removes src, loading restores it
    video.dataset.autoplay = image.getAttribute("data-autoplay") !== "false" ? "true" : "false";
    if (image.hasAttribute("data-sync")) video.dataset.sync = image.getAttribute("data-sync");
    if (image.hasAttribute("data-step")) video.dataset.step = image.getAttribute("data-step");
    const poster = image.getAttribute("href") || image.getAttributeNS(XLINK, "href");
    if (poster) video.poster = poster;
    const num = (name) => parseFloat(image.getAttribute(name)) || 0;
    const m = multiply(parseTransform(image.getAttribute("transform")), [1, 0, 0, 1, num("x"), num("y")]);
    // In percent of the slide, so the movie keeps its place at any slide
    // size (the stage is deck-sized, a printed page is not).
    const pct = (value, total) => `${value / total * 100}%`;
    Object.assign(video.style, {
      left: pct(m[4], size[0]), top: pct(m[5], size[1]),
      width: pct(num("width"), size[0]), height: pct(num("height"), size[1]),
      transform: `matrix(${m.slice(0, 4).join(",")},0,0)`,
    });
    // Editor crop percentages describe the image box, including letterboxing.
    const crop = (image.getAttribute("data-crop") || "0 0 0 0").trim().split(/\s+/).map(Number);
    if (crop.length === 4 && crop.every(v => Number.isFinite(v) && v >= 0 && v < 100) && crop[0]+crop[2] < 100 && crop[1]+crop[3] < 100) {
      const [l, t, r, b] = crop;
      if (image.getAttribute("data-mask") === "ellipse") {
        video.style.clipPath = `ellipse(${(100-l-r)/2}% ${(100-t-b)/2}% at ${(100+l-r)/2}% ${(100+t-b)/2}%)`;
      } else if (image.hasAttribute("data-crop")) video.style.clipPath = `inset(${t}% ${r}% ${b}% ${l}%)`;
    }
    for (const prop of ["display", "visibility", "opacity"]) {
      const value = image.style.getPropertyValue(prop) || image.getAttribute(prop);
      if (value) video.style.setProperty(prop, value);
    }
    return video;
  }

  // --- print mode ------------------------------------------------------------
  // {notes, steps} when the page should print instead of present, else null.
  // options.print wins; otherwise ?print=… or #print=… in the address, whose
  // value lists the flags ("1" or nothing for a plain print, "0" for off).
  function printOptions(options) {
    if (options.print !== undefined && options.print !== null) {
      const p = options.print;
      return p ? { notes: !!p.notes, steps: !!p.steps } : null;
    }
    let value = new URLSearchParams(location.search).get("print");
    if (value === null) {
      const m = /^#print(?:=(.*))?$/.exec(location.hash);
      if (m) value = m[1] ? decodeURIComponent(m[1]) : "";
    }
    if (value === null || /^(0|false|no|off)$/i.test(value)) return null;
    const flags = value.toLowerCase().split(/[\s,+]+/);
    return { notes: flags.includes("notes"), steps: flags.includes("steps") };
  }

  const stepOf = (el) => parseInt(el.dataset.step, 10) || 0;

  // Resolves once every <image> under `container` has loaded or failed, or
  // after `ms`: pages are printed only when their pictures are there.
  function imagesLoaded(container, ms) {
    const hrefs = new Set();
    for (const image of container.querySelectorAll("image")) {
      const href = image.getAttribute("href") || image.getAttributeNS(XLINK, "href");
      if (href && !href.startsWith("#")) hrefs.add(href);
    }
    const loads = Array.from(hrefs, (href) => new Promise((resolve) => {
      const img = new Image();
      img.onload = img.onerror = resolve;
      img.src = href;
    }));
    return Promise.race([Promise.all(loads), new Promise((resolve) => setTimeout(resolve, ms))]);
  }

  // Shrinks a handout's notes until they fit under the slide.
  function fitNotes(block) {
    let fit = 1;
    block.style.setProperty("--svgdeck-fit", "1");
    while (block.scrollHeight > block.clientHeight + 1 && fit > 0.3) {
      fit *= 0.9;
      block.style.setProperty("--svgdeck-fit", String(fit));
    }
  }

  // Every slide as a page of the deck's aspect, fully built (or one page per
  // build step), with no controls, keys or movies: movies show their poster.
  function startPrint(root, deck, options, size, base, print) {
    root.classList.add("svgdeck", "svgdeck-print");
    if (print.notes) root.classList.add("svgdeck-handout");
    document.documentElement.classList.add("svgdeck-print-document");
    root.style.setProperty("--svgdeck-aspect", `${size[0]} / ${size[1]}`);
    root.style.setProperty("--svgdeck-background", deck.background || "#000");
    const pageRule = document.createElement("style");
    pageRule.textContent = `@page { size: ${size[0]}px ${size[1]}px; margin: 0; }`;
    document.head.appendChild(pageRule);

    const defsSvg = document.createElementNS(SVGNS, "svg");
    defsSvg.setAttribute("class", "svgdeck-defs");
    defsSvg.setAttribute("aria-hidden", "true");
    const defs = document.createElementNS(SVGNS, "defs");
    defsSvg.appendChild(defs);
    root.appendChild(defsSvg);
    const container = document.createElement("div");
    container.className = "svgdeck-pages";
    root.appendChild(container);

    const pages = [], notesBlocks = [];
    const slides = deck.slides.map((s, i) => {
      const build = (prefix) => {
        try {
          return buildSlide(s.svg, i, defs, size, base, { prefix, posters: true });
        } catch (error) {
          console.error(`svgdeck: slide ${i + 1} could not be loaded`, error);
          return failedSlide(i);
        }
      };
      const first = build(`s${i}-`);
      first.id = s.id;
      // null: the fully built slide. With steps: the initial state, then the
      // state after each distinct step number.
      let states = [null];
      if (print.steps && !first.failed) {
        states = [0, ...Array.from(new Set(first.steps.map(stepOf))).filter((n) => n > 0).sort((a, b) => a - b)];
      }
      states.forEach((step, k) => {
        const slide = k === 0 ? first : build(`s${i}p${step}-`);
        if (step !== null) {
          for (const el of slide.steps) if (stepOf(el) > step) el.style.visibility = "hidden";
        }
        const page = document.createElement("section");
        page.className = "svgdeck-page";
        page.dataset.slide = String(i + 1);
        if (step !== null) page.dataset.buildStep = String(step);
        const label = `Slide ${i + 1}` + (states.length > 1 ? ` (${k + 1}/${states.length})` : "");
        page.setAttribute("aria-label", label);
        page.append(slide.el);
        if (print.notes) {
          const block = document.createElement("div");
          block.className = "svgdeck-print-notes";
          const heading = document.createElement("p");
          heading.className = "svgdeck-print-label";
          heading.textContent = label;
          const text = document.createElement("div");
          text.className = "svgdeck-print-notes-text";
          text.textContent = String(s.notes || "");
          block.append(heading, text);
          page.append(block);
          notesBlocks.push(block);
        }
        container.append(page);
        pages.push({ el: page, index: i, step, slide });
      });
      return first;
    });

    const faces = (deck.fonts || []).map((f) =>
      document.fonts.load(`${f.style || "normal"} ${f.weight || 400} 32px "${f.family}"`).catch(() => {}));
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    const ready = Promise.race([Promise.all(faces), timeout])
      .then(() => document.fonts.ready)
      .then(() => imagesLoaded(root, 15000))
      .then(() => {
        notesBlocks.forEach(fitNotes);
        root.classList.add("svgdeck-ready");
      });
    const api = { print: { ...print }, slides, pages, ready, count: slides.length, options };
    root.svgdeck = api;
    return api;
  }

  // --- player ------------------------------------------------------------
  function start(root, deck, options) {
    options = options || {};
    const size = deck.size || [1920, 1080];
    const base = new URL(options.slideBase || "slides/", document.baseURI);
    const print = printOptions(options);
    if (print) return startPrint(root, deck, options, size, base, print);
    root.classList.add("svgdeck");
    root.style.background = deck.background || "#000";
    // For the browser's own printing (player.css, @media print).
    root.style.setProperty("--svgdeck-aspect", `${size[0]} / ${size[1]}`);
    root.style.setProperty("--svgdeck-ratio", String(size[0] / size[1]));
    root.style.setProperty("--svgdeck-background", deck.background || "#000");

    const defsSvg = document.createElementNS(SVGNS, "svg");
    defsSvg.setAttribute("class", "svgdeck-defs");
    defsSvg.setAttribute("aria-hidden", "true");
    const defs = document.createElementNS(SVGNS, "defs");
    defsSvg.appendChild(defs);
    root.appendChild(defsSvg);

    const stage = document.createElement("div");
    stage.className = "svgdeck-stage";
    stage.style.width = `${size[0]}px`;
    stage.style.height = `${size[1]}px`;
    root.appendChild(stage);

    const slides = deck.slides.map((s, i) => {
      let slide;
      try {
        slide = buildSlide(s.svg, i, defs, size, base);
      } catch (error) {
        // One broken slide must not take the whole deck down with it.
        console.error(`svgdeck: slide ${i + 1} could not be loaded`, error);
        slide = failedSlide(i);
      }
      slide.id = s.id;
      stage.appendChild(slide.el);
      return slide;
    });

    const state = { index: -1, step: 0, blank: false };
    let mirrorStop = null;
    let overviewOpen = false, resumeVideos = [];
    const controls = document.createElement("nav");
    controls.className = "svgdeck-controls";
    controls.setAttribute("aria-label", "Presentation controls");
    // Small icon buttons, hidden while presenting: a mouse move, keyboard
    // focus or a tap along the bottom edge brings them back for a moment.
    const ICONS = {
      prev: "M15 5l-7 7 7 7", next: "M9 5l7 7-7 7",
      overview: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
      edit: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
      fullscreen: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
      speaker: "M3 4h18v12H3zM8 21l4-5 4 5M7 8h10M7 12h6",
    };
    const iconSvg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
    const button = (label, fn, parent = controls, iconName = null) => {
      const b = document.createElement("button"); b.type = "button";
      if (iconName) { b.innerHTML = iconSvg(iconName); b.setAttribute("aria-label", label); b.title = label; }
      else b.textContent = label;
      b.addEventListener("click", fn); parent.append(b); return b;
    };
    button("Previous", prev, controls, "prev");
    const counter = document.createElement("span"); counter.className = "svgdeck-counter"; controls.append(counter);
    button("Next", next, controls, "next");
    const overviewButton = button("Slide overview", () => setOverview(true), controls, "overview");
    overviewButton.setAttribute("aria-expanded", "false");
    if (options.editorUrl) {
      const back = document.createElement("a"); back.innerHTML = iconSvg("edit");
      back.setAttribute("aria-label", "Back to editor"); back.title = "Back to editor";
      back.addEventListener("click", () => { back.href = options.editorUrl + `#${state.index+1}`; });
      back.href = options.editorUrl; controls.append(back);
    }
    button("Fullscreen", toggleFullscreen, controls, "fullscreen");
    const query = new URLSearchParams(location.search);
    if (query.get("speaker") !== "1" && !query.has("session")) {
      button("Speaker view", () => {
        const url = new URL(location.href); url.searchParams.set("speaker", "1"); location.href = url.href;
      }, controls, "speaker");
    }
    root.append(controls);
    let hideTimer = null;
    function revealControls(ms = 2500) {
      root.classList.add("svgdeck-show-controls");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function hide() {
        if (controls.matches(":hover, :focus-within")) { hideTimer = setTimeout(hide, 1000); return; }
        root.classList.remove("svgdeck-show-controls");
      }, ms);
    }
    function hideControls() { clearTimeout(hideTimer); root.classList.remove("svgdeck-show-controls"); }
    controls.addEventListener("focusin", () => revealControls());
    root.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") revealControls(); });
    const overview = document.createElement("div");
    overview.className = "svgdeck-overview"; overview.hidden = true;
    overview.setAttribute("role", "dialog"); overview.setAttribute("aria-modal", "true");
    overview.setAttribute("aria-label", "Slide overview");
    button("Return to presentation", () => setOverview(false), overview);
    const grid = document.createElement("div"); grid.className = "svgdeck-overview-grid"; overview.append(grid);
    const thumbnails = deck.slides.map((s,i) => {
      const b = button("", () => { setOverview(false, i === state.index); setBlank(false); show(i,0); root.tabIndex = -1; root.focus(); }, grid);
      b.setAttribute("aria-label", `Go to slide ${i+1}`);
      if (slides[i].failed) {
        const failed = document.createElement("span"); failed.className = "svgdeck-thumb-failed";
        failed.textContent = "Could not be loaded"; b.append(failed);
      } else {
        const svg = parseSlide(s.svg);
        rewrite(svg, `overview-${i}-`, base);
        svg.setAttribute("viewBox",svg.getAttribute("viewBox") || `0 0 ${size[0]} ${size[1]}`);
        svg.setAttribute("aria-hidden","true");
        svg.style.aspectRatio = `${size[0]} / ${size[1]}`;
        b.append(document.importNode(svg,true));
      }
      const label = document.createElement("span"); label.textContent = `Slide ${i+1}`; b.append(label);
      return b;
    });
    root.append(overview);
    function setOverview(on, resume = true) {
      if (overviewOpen === on) return;
      overviewOpen = on; overview.hidden = !on;
      root.classList.toggle("svgdeck-overview-open",on);
      overviewButton.setAttribute("aria-expanded",String(on));
      typed = ""; touch = null;
      if (on) {
        setBlank(false);
        resumeVideos = slides[state.index]?.videos.filter(v => !v.paused) || [];
        resumeVideos.forEach(v => v.pause());
        thumbnails.forEach((b,i) => b.setAttribute("aria-current",String(i===state.index)));
        thumbnails[state.index]?.focus();
      } else {
        if (resume) resumeVideos.forEach(v => v.play().catch(() => {}));
        resumeVideos = [];
        overviewButton.focus();
      }
    }


    function fit() {
      const scale = Math.min(root.clientWidth / size[0], root.clientHeight / size[1]);
      stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
    }

    function load(video) {
      if (!video.dataset.src || video.hasAttribute("src")) return;
      video.src = video.dataset.src;
      video.preload = "auto";
      video.load();
    }
    // A hidden <video> keeps its media resource alive, and iPadOS evicts them
    // silently when there are too many: only the neighbours stay loaded.
    function unload(video) {
      if (!video.hasAttribute("src")) return;
      video.pause();
      video.removeAttribute("src");
      video.preload = "none";
      video.load();  // releases the resource; the poster stays
    }

    const SEEK_DRIFT = 0.1, SEEK_INTERVAL = 250;  // seconds, milliseconds
    // How far a looping video is from where a seek to `time` would put it,
    // wrapping at its duration.
    function drift(video, time) {
      const d = video.duration;
      const diff = Math.abs(video.currentTime - video.movieRange.target(time));
      return isFinite(d) && d > 0 ? Math.min(diff, d - diff) : diff;
    }

    function seekTo(video, time) {
      video.movieRange.seek(time);
    }

    function syncVideos(index) {
      // Videos in the same sync group on neighbouring slides follow the
      // current one frame by frame, so switching slides shows no jump.
      if (mirrorStop) { mirrorStop(); mirrorStop = null; }
      const driver = slides[index].videos.find((v) => v.dataset.sync);
      if (!driver) return;
      const followers = [];
      for (const j of [index - 1, index + 1]) {
        if (!slides[j]) continue;
        for (const v of slides[j].videos) {
          if (v.dataset.sync === driver.dataset.sync) { load(v); followers.push(v); }
        }
      }
      if (!followers.length) return;
      let stopped = false, lastSeek = 0;
      const rvfc = typeof driver.requestVideoFrameCallback === "function";
      const tick = () => {
        if (stopped) return;
        // Followers are hidden: a rough match is enough, and a seek per
        // presented frame would keep every decoder busy.
        const now = Date.now();
        if (now - lastSeek >= SEEK_INTERVAL) {
          for (const f of followers) {
            if (f.readyState >= 1 && !f.seeking && drift(f, driver.currentTime) > SEEK_DRIFT) { seekTo(f, driver.currentTime); lastSeek = now; }
          }
        }
        if (rvfc) driver.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
      };
      tick();
      mirrorStop = () => { stopped = true; };
    }

    function applyStep(slide, step) {
      for (const el of slide.steps) {
        el.style.visibility = (parseInt(el.dataset.step, 10) || 0) <= step ? slide.stepVisibility.get(el) : "hidden";
      }
      for (const v of slide.videos) {
        const style = getComputedStyle(v);
        if (style.display === "none" || style.visibility === "hidden") v.pause();
        else if (v.dataset.autoplay === "true" && v.paused && !overviewOpen) v.play().catch(() => {});
      }
    }

    function show(index, step) {
      index = Math.max(0, Math.min(slides.length - 1, index));
      const slide = slides[index];
      step = Math.max(0, Math.min(slide.maxStep, step));
      const previous = slides[state.index];
      if (index !== state.index) {
        const playing = new Map();
        if (previous) {
          for (const v of previous.videos) {
            if (v.dataset.sync) playing.set(v.dataset.sync, v.currentTime);  // paused ones too: the overview pauses them
            v.pause();
          }
          previous.el.classList.remove("svgdeck-current");
        }
        slides.forEach((s, j) => s.videos.forEach(Math.abs(j - index) <= 1 ? load : unload));
        slide.el.classList.add("svgdeck-current");
        for (const v of slide.videos) {
          if (v.dataset.sync && playing.has(v.dataset.sync)) seekTo(v, playing.get(v.dataset.sync));
          else if (!v.dataset.sync) seekTo(v, v.movieRange.bounds().start);
        }
        syncVideos(index);
      }
      state.index = index;
      state.step = step;
      counter.textContent = `${index+1} / ${slides.length}`;
      applyStep(slide, step);
      const hash = `#${index + 1}` + (step ? `.${step}` : "");
      if (location.hash !== hash) history.replaceState(null, "", hash);
      root.dispatchEvent(new CustomEvent("svgdeck:change", { detail: { index, step } }));
    }

    function next() {
      if (state.index < 0) return;
      const slide = slides[state.index];
      if (state.step < slide.maxStep) show(state.index, state.step + 1);
      else if (state.index < slides.length - 1) show(state.index + 1, 0);
    }
    function prev() {
      if (state.index < 0) return;
      if (state.step > 0) show(state.index, state.step - 1);
      else if (state.index > 0) show(state.index - 1, slides[state.index - 1].maxStep);
    }
    function setBlank(on) {
      state.blank = on;
      root.classList.toggle("svgdeck-blank", on);
      root.dispatchEvent(new CustomEvent("svgdeck:change", { detail: { ...state } }));
    }
    // [slide, step] from a "#N" or "#N.step" hash; null for any other hash.
    function fromHash() {
      const m = /^#(\d+)(?:\.(\d+))?$/.exec(location.hash);
      return m ? [parseInt(m[1], 10) - 1, parseInt(m[2] || "0", 10)] : null;
    }

    let typed = "";
    document.addEventListener("keydown", (e) => {
      if (e.target.closest("input,textarea,select,[contenteditable]")) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      // Escape only closes: clickers and leaving fullscreen send it too.
      if (e.key === "Escape") { if (overviewOpen) { e.preventDefault(); setOverview(false); } return; }
      if (e.key.toLowerCase() === "o") { e.preventDefault(); setOverview(!overviewOpen); return; }
      if (overviewOpen) {
        if (e.key === "Tab") {
          const buttons = [...overview.querySelectorAll("button")], index = buttons.indexOf(document.activeElement);
          buttons[(index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus(); e.preventDefault();
        }
        return;
      }
      if (e.target.closest("button,a") && ["Enter"," "].includes(e.key)) return;
      if (state.blank && !["b", "B", "."].includes(e.key)) { setBlank(false); e.preventDefault(); return; }
      if (/^\d$/.test(e.key)) { typed += e.key; return; }
      switch (e.key) {
        case "ArrowRight": case "ArrowDown": case "PageDown": case " ": case "n": case "N":
          next(); break;
        case "ArrowLeft": case "ArrowUp": case "PageUp": case "Backspace": case "p": case "P":
          prev(); break;
        case "Enter":
          if (typed) show(parseInt(typed, 10) - 1, 0); else next();
          break;
        case "Home": show(0, 0); break;
        case "End": show(slides.length - 1, slides[slides.length - 1].maxStep); break;
        case "b": case "B": case ".": setBlank(!state.blank); break;
        case "f": case "F": toggleFullscreen(); break;
        default: typed = ""; return;
      }
      typed = "";
      e.preventDefault();
    });

    function toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    }

    // One finger or button drives a gesture: [x, y, pointerId]. A second
    // finger (a pinch, a resting palm) cancels it instead of advancing.
    let touch = null, mouseTap = null, doubleAt = -Infinity, lastType = "mouse";
    const DOUBLE_MS = 300;
    root.addEventListener("pointerdown", (e) => {
      if (!e.isPrimary) { touch = null; return; }
      touch = e.target.closest(".svgdeck-controls,.svgdeck-overview") || overviewOpen ? null : [e.clientX, e.clientY, e.pointerId];
    });
    root.addEventListener("pointerup", (e) => {
      lastType = e.pointerType;
      if (!touch || !e.isPrimary || e.pointerId !== touch[2]) return;
      const dx = e.clientX - touch[0], dy = e.clientY - touch[1];
      touch = null;
      if (e.button !== 0) return;
      if (state.blank) { setBlank(false); return; }
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { if (dx < 0) next(); else prev(); }
      else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
        // Touch has no hover: a tap along the bottom edge shows or hides the controls.
        if (e.pointerType !== "mouse" && e.clientY > root.getBoundingClientRect().bottom - 80) {
          if (root.classList.contains("svgdeck-show-controls")) hideControls(); else revealControls(4000);
          return;
        }
        if (e.pointerType !== "mouse") { next(); return; }  // touch and pen: every tap advances at once
        // A mouse click waits briefly: a second click is a double-click, which
        // goes fullscreen instead of advancing.
        if (mouseTap) {
          clearTimeout(mouseTap); mouseTap = null;
          doubleAt = performance.now();
          toggleFullscreen();
          return;
        }
        mouseTap = setTimeout(() => { mouseTap = null; if (!overviewOpen) next(); }, DOUBLE_MS);
      }
    });
    root.addEventListener("pointercancel", () => { touch = null; });
    root.addEventListener("dblclick", e => {
      // Fullscreen by double-click is for the mouse; touch never triggers it.
      if (e.target.closest(".svgdeck-controls,.svgdeck-overview") || performance.now() - doubleAt < 1000 || lastType !== "mouse") return;
      toggleFullscreen();
    });
    window.addEventListener("resize", fit);
    window.addEventListener("hashchange", () => { const target = fromHash(); if (target) show(target[0], target[1]); });

    fit();
    const faces = (deck.fonts || []).map((f) =>
      document.fonts.load(`${f.style || "normal"} ${f.weight || 400} 32px "${f.family}"`).catch(() => {}));
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    const ready = Promise.race([Promise.all(faces), timeout]).then(() => {
      root.classList.add("svgdeck-ready");
      revealControls(3000);  // show where the controls are, then get out of the way
      const [i, s] = fromHash() || [0, 0];
      show(i, s);
    });

    const api = { slides, state, next, prev, show, setBlank, ready, count: slides.length };
    root.svgdeck = api;
    window.SvgDeckSpeaker?.(root, deck, api, options, rewrite, parseSlide);
    return api;
  }

  window.SvgDeck = { start, parseTransform };
})();
