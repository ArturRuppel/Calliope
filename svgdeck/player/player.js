/* svgdeck player: plays a deck of SVG slides with movies and build steps.
   Classic script (no modules) so it also runs from file:// in an export.
   Usage: SvgDeck.start(root, deck, {slideBase: "slides/"}) where deck is the
   parsed deck.json with each slide carrying its SVG source in `svg`. */
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
  function rewrite(el, prefix, base) {
    if (el.id) el.id = prefix + el.id;
    for (const attr of Array.from(el.attributes)) {
      const name = attr.localName;
      let value = attr.value;
      if (name === "href" || name === "data-video") {
        if (value.startsWith("#")) value = "#" + prefix + value.slice(1);
        else if (!/^(data:|[a-z]+:\/\/|\/)/i.test(value)) value = new URL(value, base).href;
      } else if (value.includes("url(")) {
        value = value.replace(URL_REF, (_, q, id) => `url(#${prefix}${id})`);
      }
      if (value !== attr.value) {
        if (attr.namespaceURI) el.setAttributeNS(attr.namespaceURI, attr.name, value);
        else el.setAttribute(attr.name, value);
      }
    }
    for (const child of el.children) rewrite(child, prefix, base);
  }

  function buildSlide(source, index, defs, size, base) {
    const doc = new DOMParser().parseFromString(source, "image/svg+xml");
    const svg = doc.documentElement;
    if (svg.localName !== "svg") throw new Error(`slide ${index + 1}: not an SVG`);
    rewrite(svg, `s${index}-`, base);

    const slide = document.createElement("div");
    slide.className = "svgdeck-slide";
    const viewBox = svg.getAttribute("viewBox") || `0 0 ${size[0]} ${size[1]}`;
    const videos = [];
    let layer = null;

    for (const child of Array.from(svg.children)) {
      if (child.localName === "defs") {
        for (const d of Array.from(child.children)) defs.appendChild(document.importNode(d, true));
        continue;
      }
      if (["title", "desc", "metadata"].includes(child.localName)) continue;
      if (child.localName === "image" && child.hasAttribute("data-video")) {
        const video = makeVideo(child);
        videos.push(video);
        slide.appendChild(video);
        layer = null;
        continue;
      }
      if (!layer) {
        layer = document.createElementNS(SVGNS, "svg");
        layer.setAttribute("viewBox", viewBox);
        layer.setAttribute("class", "svgdeck-layer");
        for (const a of ["style", "preserveAspectRatio"]) {
          if (svg.hasAttribute(a)) layer.setAttribute(a, svg.getAttribute(a));
        }
        slide.appendChild(layer);
      }
      layer.appendChild(document.importNode(child, true));
    }

    const steps = Array.from(slide.querySelectorAll("[data-step]"));
    const maxStep = steps.reduce((m, el) => Math.max(m, parseInt(el.dataset.step, 10) || 0), 0);
    return { el: slide, videos, steps, maxStep };
  }

  function makeVideo(image) {
    const video = document.createElement("video");
    video.className = "svgdeck-video";
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    video.preload = "none";
    video.loop = image.getAttribute("data-loop") !== "false";
    video.dataset.src = image.getAttribute("data-video");
    video.dataset.autoplay = image.getAttribute("data-autoplay") !== "false" ? "true" : "false";
    if (image.hasAttribute("data-sync")) video.dataset.sync = image.getAttribute("data-sync");
    if (image.hasAttribute("data-step")) video.dataset.step = image.getAttribute("data-step");
    const poster = image.getAttribute("href") || image.getAttributeNS(XLINK, "href");
    if (poster) video.poster = poster;
    const num = (name) => parseFloat(image.getAttribute(name)) || 0;
    const m = multiply(parseTransform(image.getAttribute("transform")), [1, 0, 0, 1, num("x"), num("y")]);
    Object.assign(video.style, {
      width: `${num("width")}px`, height: `${num("height")}px`,
      transform: `matrix(${m.join(",")})`,
    });
    return video;
  }

  // --- player ------------------------------------------------------------
  function start(root, deck, options) {
    options = options || {};
    const size = deck.size || [1920, 1080];
    const base = new URL(options.slideBase || "slides/", document.baseURI);
    root.classList.add("svgdeck");
    root.style.background = deck.background || "#000";

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
      const slide = buildSlide(s.svg, i, defs, size, base);
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
    const button = (label, fn, parent = controls) => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = label;
      b.addEventListener("click", fn); parent.append(b); return b;
    };
    button("Previous", prev);
    const counter = document.createElement("span"); controls.append(counter);
    button("Next", next);
    const overviewButton = button("Slide overview", () => setOverview(true));
    overviewButton.setAttribute("aria-expanded", "false");
    if (options.editorUrl) {
      const back = document.createElement("a"); back.textContent = "Back to editor";
      back.addEventListener("click", () => { back.href = options.editorUrl + `#${state.index+1}`; });
      back.href = options.editorUrl; controls.append(back);
    }
    button("Fullscreen", toggleFullscreen);
    root.append(controls);
    const overview = document.createElement("div");
    overview.className = "svgdeck-overview"; overview.hidden = true;
    overview.setAttribute("role", "dialog"); overview.setAttribute("aria-modal", "true");
    overview.setAttribute("aria-label", "Slide overview");
    button("Return to presentation", () => setOverview(false), overview);
    const grid = document.createElement("div"); grid.className = "svgdeck-overview-grid"; overview.append(grid);
    const thumbnails = deck.slides.map((s,i) => {
      const b = button("", () => { setOverview(false, i === state.index); setBlank(false); show(i,0); root.tabIndex = -1; root.focus(); }, grid);
      b.setAttribute("aria-label", `Go to slide ${i+1}`);
      const svg = new DOMParser().parseFromString(s.svg,"image/svg+xml").documentElement;
      rewrite(svg, `overview-${i}-`, base);
      svg.setAttribute("viewBox",svg.getAttribute("viewBox") || `0 0 ${size[0]} ${size[1]}`);
      svg.setAttribute("aria-hidden","true");
      svg.style.aspectRatio = `${size[0]} / ${size[1]}`;
      b.append(document.importNode(svg,true));
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
      if (!video.dataset.src) return;
      video.src = video.dataset.src;
      delete video.dataset.src;
      video.preload = "auto";
      video.load();
    }

    function seekTo(video, time) {
      const d = video.duration;
      try { video.currentTime = isFinite(d) && d > 0 ? time % d : time; } catch (e) { /* not ready */ }
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
      let stopped = false;
      const rvfc = typeof driver.requestVideoFrameCallback === "function";
      const tick = () => {
        if (stopped) return;
        for (const f of followers) if (f.readyState >= 1) seekTo(f, driver.currentTime);
        if (rvfc) driver.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
      };
      tick();
      mirrorStop = () => { stopped = true; };
    }

    function applyStep(slide, step) {
      for (const el of slide.steps) {
        el.style.visibility = (parseInt(el.dataset.step, 10) || 0) <= step ? "" : "hidden";
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
            if (v.dataset.sync && !v.paused) playing.set(v.dataset.sync, v.currentTime);
            v.pause();
          }
          previous.el.classList.remove("svgdeck-current");
        }
        for (const j of [index, index + 1, index - 1]) {
          if (slides[j]) slides[j].videos.forEach(load);
        }
        slide.el.classList.add("svgdeck-current");
        for (const v of slide.videos) {
          if (v.dataset.sync && playing.has(v.dataset.sync)) seekTo(v, playing.get(v.dataset.sync));
          else if (!v.dataset.sync) seekTo(v, 0);
          if (v.dataset.autoplay === "true") {
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
          }
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
    }
    function fromHash() {
      const m = /^#(\d+)(?:\.(\d+))?$/.exec(location.hash);
      return m ? [parseInt(m[1], 10) - 1, parseInt(m[2] || "0", 10)] : [0, 0];
    }

    let typed = "";
    document.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "Escape" || e.key.toLowerCase() === "o") { e.preventDefault(); setOverview(!overviewOpen); return; }
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
        case "ArrowRight": case "ArrowDown": case "PageDown": case " ": case "n":
          next(); break;
        case "ArrowLeft": case "ArrowUp": case "PageUp": case "Backspace": case "p":
          prev(); break;
        case "Enter":
          if (typed) show(parseInt(typed, 10) - 1, 0); else next();
          break;
        case "Home": show(0, 0); break;
        case "End": show(slides.length - 1, slides[slides.length - 1].maxStep); break;
        case "b": case "B": case ".": setBlank(!state.blank); break;
        case "f": toggleFullscreen(); break;
        default: typed = ""; return;
      }
      typed = "";
      e.preventDefault();
    });

    function toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    }

    let touch = null;
    root.addEventListener("pointerdown", (e) => { touch = e.target.closest(".svgdeck-controls,.svgdeck-overview") || overviewOpen ? null : [e.clientX, e.clientY]; });
    root.addEventListener("pointerup", (e) => {
      if (!touch) return;
      const dx = e.clientX - touch[0], dy = e.clientY - touch[1];
      touch = null;
      if (e.button !== 0) return;
      if (state.blank) { setBlank(false); return; }
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { if (dx < 0) next(); else prev(); }
      else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) next();
    });
    root.addEventListener("pointercancel", () => { touch = null; });
    root.addEventListener("dblclick", e => {if (!e.target.closest(".svgdeck-controls,.svgdeck-overview")) toggleFullscreen();});
    window.addEventListener("resize", fit);
    window.addEventListener("hashchange", () => { const [i, s] = fromHash(); show(i, s); });

    fit();
    const faces = (deck.fonts || []).map((f) =>
      document.fonts.load(`${f.style || "normal"} ${f.weight || 400} 32px "${f.family}"`).catch(() => {}));
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    const ready = Promise.race([Promise.all(faces), timeout]).then(() => {
      root.classList.add("svgdeck-ready");
      const [i, s] = fromHash();
      show(i, s);
    });

    const api = { slides, state, next, prev, show, ready, count: slides.length };
    root.svgdeck = api;
    return api;
  }

  window.SvgDeck = { start, parseTransform };
})();
