/* Calliope's browser runtime, page half (web/worker.js is the other half).

   Loaded first by every page of the browser build (index.html, edit.html,
   present.html), as a classic script so it also runs over file://. It
   - replaces window.fetch: requests to /api/..., /d/..., /healthz and /sw.js go
     to the svgdeck service running in Pyodide in a Web Worker; anything else
     goes to the network as before;
   - hands out blob: URLs for deck media and fonts, because <img>, <image>,
     <video> and @font-face cannot go through a fetch shim (`asset`, `unasset`);
   - maps the service's page addresses (/, /edit/<deck>, /d/<deck>/) to the
     build's pages (`link`), and rewrites links that point at them;
   - checks and measures pictures and movies before they are stored (there is
     no ffmpeg here), and runs deck import and the offline export download.

   The editor and the deck list call it through `globalThis.CalliopeRuntime`,
   which is absent on the service. Design: docs/browser-runtime.md */
(function () {
  "use strict";
  const script = document.currentScript;
  const ROOT = new URL(".", script.src).href;          // the build's root, wherever it is served from
  const PAGE = document.documentElement.dataset.calliopePage || "index";
  const SERVICE = /^\/(api\/|d\/|healthz$|sw\.js$)/;
  const realFetch = window.fetch.bind(window);

  // --- boot -------------------------------------------------------------------------
  const listeners = new Set();
  let state = { stage: "Starting", fraction: 0, read: 0 };
  const setState = (next) => { state = { ...state, ...next }; listeners.forEach((f) => f(state)); };
  let worker = null, nextId = 1;
  const pending = new Map();

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const tag = document.createElement("script");
      tag.src = src;
      tag.onload = () => { tag.remove(); resolve(); };
      tag.onerror = () => { tag.remove(); reject(new Error(`Could not read ${src}`)); };
      document.head.appendChild(tag);
    });
  }

  function failAll(message) {
    setState({ error: state.error || message });
    pending.forEach(({ reject }) => reject(new Error(message)));
    pending.clear();
  }

  async function startWorker() {
    const root = ROOT + "pyodide/";
    const manifest = await new Promise((resolve, reject) => {
      window.__calliopeManifest = resolve;
      loadScript(root + "manifest.js").catch(reject);
    });
    await new Promise((resolve, reject) => {
      window.__calliopeWorker = (source) => {
        worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
        resolve();
      };
      loadScript(root + manifest.worker).catch(reject);
    });
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") setState({ stage: data.stage, fraction: data.fraction });
      else if (data.type === "failed") failAll(data.message);
      else if (data.type === "response") {
        const request = pending.get(data.id);
        if (!request) return;
        pending.delete(data.id);
        if (data.error) request.reject(new Error(data.error));
        else request.resolve(data);
      }
    };
    worker.onerror = (e) => failAll(e.message || "The Calliope worker could not start.");
    worker.postMessage({ type: "manifest", manifest });
    window.__calliopePayload = (name, base64) => worker.postMessage({ type: "file", name, base64 });
    const total = manifest.files.reduce((n, f) => n + f.bytes, 0);
    let read = 0;
    const queue = [...manifest.files];
    const next = async () => {
      const file = queue.shift();
      if (!file) return;
      await loadScript(root + file.script);
      read += file.bytes;
      setState({ read: read / total });
      return next();
    };
    await Promise.all([next(), next(), next()]);
  }

  const started = startWorker().catch((e) => { failAll(String(e?.message ?? e)); throw e; });

  /* One request to the worker; resolves with {status, headers, body}. */
  async function post(message, transfer = []) {
    await started;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: "request", id, ...message }, transfer);
    });
  }

  // --- one writer per browser ------------------------------------------------------
  /* Every tab boots its own Python over the same browser storage, so only one
     may write. The presenter only reads; another editor tab gets read-only. */
  let writable = PAGE === "present" ? Promise.resolve(false) : null;
  if (!writable) {
    writable = !navigator.locks ? Promise.resolve(true) : new Promise((resolve) => {
      navigator.locks.request("calliope-store", { ifAvailable: true }, (lock) => {
        resolve(!!lock);
        return lock ? new Promise(() => {}) : undefined;   // held until the page goes
      });
    });
  }
  writable.then((ok) => { if (!ok && PAGE !== "present") setState({ readOnly: true }); });

  // --- the media map ------------------------------------------------------------------
  const media = new Map();     // "/d/<deck>/media/<file>" -> {sha1, type, url}
  const fonts = new Map();     // "/d/<deck>/fonts/..." or "/api/fonts/file/..." -> {v, url}
  const reverse = new Map();   // blob url -> path
  let mediaDir = null;

  async function opfsFile(sha1) {
    mediaDir ??= await (await navigator.storage.getDirectory()).getDirectoryHandle("calliope-media", { create: true });
    return (await mediaDir.getFileHandle(sha1)).getFile();
  }

  let indexing = null;
  async function refreshIndex() {
    const run = async () => {
      const res = await post({ method: "GET", url: "/api/browser/media", headers: {} });
      const index = JSON.parse(new TextDecoder().decode(res.body));
      const seen = new Set();
      for (const [path, info] of Object.entries(index.media)) {
        seen.add(path);
        if (media.get(path)?.sha1 === info.sha1) continue;
        try {
          const url = URL.createObjectURL(new Blob([await opfsFile(info.sha1)], { type: info.type || "" }));
          const old = media.get(path);
          if (old) reverse.delete(old.url);
          media.set(path, { ...info, url });
          reverse.set(url, path);
        } catch (e) { console.warn(`media file missing from this browser: ${path}`, e); }
      }
      for (const path of media.keys()) if (!seen.has(path)) media.delete(path);   // urls stay valid for open pages
      for (const { url: path, v } of index.fonts) {
        if (fonts.get(path)?.v === v) continue;
        const r = await post({ method: "GET", url: path, headers: {} });
        if (r.status !== 200) continue;
        const ext = path.split(".").pop().toLowerCase();
        const type = { otf: "font/otf", ttf: "font/ttf", woff: "font/woff", woff2: "font/woff2" }[ext] || "";
        const url = URL.createObjectURL(new Blob([r.body], { type }));
        fonts.set(path, { v, url });
        reverse.set(url, path);
      }
    };
    indexing = (indexing || Promise.resolve()).then(run, run);
    return indexing;
  }
  const indexed = started.then(() => refreshIndex());

  const pathOf = (u) => {
    if (typeof u !== "string") return u;
    if (u.startsWith(location.origin + "/")) u = u.slice(location.origin.length);
    return u;
  };

  /** The URL to put in the DOM for a file of the service. */
  function asset(u) {
    const p = pathOf(u);
    if (typeof p !== "string" || !p.startsWith("/")) return u;
    if (p.startsWith("/editor/")) return ROOT + "editor/" + p.slice(8);
    const bare = decodeURI(p.split(/[?#]/)[0]);
    return media.get(bare)?.url || fonts.get(bare)?.url || u;
  }
  /** Back from a blob URL to the service path it stands for. */
  const unasset = (u) => reverse.get(u) || u;

  /** The build's page for one of the service's page addresses. */
  function link(u) {
    const url = new URL(pathOf(u), "http://service");
    if (!/^\/(edit\/[^/]+|d\/[^/]+\/?)?$/.test(url.pathname) || /^[a-z]+:/i.test(pathOf(u))) return u;
    const deck = /^\/(?:edit|d)\/([^/]+)/.exec(url.pathname)?.[1];
    const page = url.pathname === "/" ? "index.html" : url.pathname.startsWith("/edit/") ? "edit.html" : "present.html";
    const target = new URL(page, ROOT);
    if (deck) target.searchParams.set("deck", decodeURIComponent(deck));
    for (const [k, v] of url.searchParams) target.searchParams.set(k, v);
    target.hash = url.hash;
    return target.href;
  }

  // Links written for the service (<a href="/edit/x">) lead to the build's pages.
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href]");
    const href = a?.getAttribute("href");
    if (href && href.startsWith("/") && !href.startsWith("//")) a.href = link(href);
  }, true);

  // --- fetch ------------------------------------------------------------------------
  const errorResponse = (status, detail) => new Response(JSON.stringify({ detail }),
    { status, headers: { "Content-Type": "application/json" } });

  async function toResponse(res) {
    const headers = new Headers(res.headers);
    if (res.headers["x-calliope-blob"]) {
      try {
        const file = await opfsFile(res.headers["x-calliope-blob"]);
        headers.set("content-length", String(file.size));
        return new Response(file, { status: res.status, headers });
      } catch (e) { return errorResponse(404, "this file is not stored in this browser"); }
    }
    return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, headers });
  }

  async function serviceFetch(path, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    const changes = method !== "GET" && method !== "HEAD";
    if (changes && !(await writable)) {
      return errorResponse(423, "Calliope is open in another tab of this browser: edit there, or close it and reload this one.");
    }
    if (path === "/sw.js") return errorResponse(404, "the browser build has no server-side offline copy");
    const upload = /^\/api\/decks\/([^/]+)\/media\?/.test(path);
    let res;
    if (upload && method === "POST") {
      const out = await prepareMedia(new URL(path, "http://service").searchParams.get("filename") || "file", init.body);
      if (out instanceof Response) return out;
      res = await post({ kind: "media", method, url: path, ...out });
    } else if (path.startsWith("/api/browser/import") && method === "POST") {
      res = await post({ kind: "import", method, url: path, file: init.body });
    } else {
      const body = init.body == null ? new ArrayBuffer(0) : await new Response(init.body).arrayBuffer();
      const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
      res = await post({ method, url: path, headers, body }, [body]);
    }
    if (changes && res.status < 400) await refreshIndex();
    else if (!changes) await indexed;
    return toResponse(res);
  }

  window.fetch = function (input, init) {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    const path = pathOf(raw);
    if (typeof path === "string" && SERVICE.test(path)) {
      return serviceFetch(path, input instanceof Request ? { method: input.method, headers: input.headers, body: init?.body, ...init } : init);
    }
    return realFetch(input, init);
  };

  // --- pictures and movies, checked here (no ffmpeg) -----------------------------
  const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i, MOVIE = /\.(mp4|m4v|webm|mov)$/i, CONVERT = /\.(mkv|avi)$/i;
  const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    svg: "image/svg+xml", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

  function withType(blob, name) {
    const type = TYPES[name.split(".").pop().toLowerCase()];
    return blob.type || !type ? blob : new Blob([blob], { type });
  }

  async function prepareMedia(filename, body) {
    let file = body instanceof Blob ? body : new Blob([body ?? ""]);
    file = withType(file, filename);
    if (CONVERT.test(filename)) {
      return errorResponse(400, `${filename}: the browser build keeps movies as they are and cannot convert this one. Use an H.264 .mp4 or a .webm (or upload it on the Calliope service).`);
    }
    if (IMAGE.test(filename)) {
      if (/\.svg$/i.test(filename)) return { file, svg: await file.text() };
      try {
        const bitmap = await createImageBitmap(file);
        const out = { file, width: bitmap.width, height: bitmap.height };
        bitmap.close?.();
        return out;
      } catch (e) {
        return errorResponse(400, `${filename} is not a picture this browser can read.`);
      }
    }
    if (MOVIE.test(filename)) {
      const probe = await probeMovie(file);
      if (!probe) return errorResponse(400, `This browser cannot play ${filename}. The browser build stores movies as they are (there is no converter here): use an H.264 .mp4 or a .webm.`);
      return { file, ...probe };
    }
    return errorResponse(400, `unsupported file type ${filename.includes(".") ? "." + filename.split(".").pop() : "(none)"}`);
  }

  /* Size and poster frame of a movie, from the browser's own decoder; null when
     it cannot play the file. */
  function probeMovie(file) {
    return new Promise((resolve) => {
      const video = document.createElement("video");
      const url = URL.createObjectURL(file);
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 20000);
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.onerror = () => finish(null);
      video.onloadeddata = () => {
        if (!video.videoWidth || !video.videoHeight) return finish(null);
        video.onseeked = () => {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext("2d").drawImage(video, 0, 0);
          canvas.toBlob((poster) => finish(poster ? { width: canvas.width, height: canvas.height, poster } : null),
            "image/jpeg", 0.85);
        };
        video.currentTime = Math.min(0.05, (video.duration || 1) / 2);
      };
      video.src = url;
    });
  }

  // --- downloads, import, print --------------------------------------------------------
  async function download(path, fallbackName) {
    const r = await window.fetch(path);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `${r.status}`);
    const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(r.headers.get("Content-Disposition") || "");
    const name = named ? decodeURIComponent(named[1]) : fallbackName;
    const href = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement("a"), { href, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
    return name;
  }

  async function importDeck(file) {
    const r = await window.fetch(`/api/browser/import?filename=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
    const value = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(value.detail || `${r.status}`);
    return value;
  }

  // --- the presenter page ------------------------------------------------------------
  /* The service renders the whole player page (svgdeck.deck.render_page); here
     its file references become blob URLs and the page replaces this one. */
  async function present() {
    const params = new URLSearchParams(location.search);
    const deck = params.get("deck");
    const r = await window.fetch(`/d/${encodeURIComponent(deck)}/`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `no deck ${deck}`);
    let html = await r.text();
    const base = `/d/${deck}/`;
    const resolve = (ref, from) => {
      if (/^(#|data:|blob:|[a-z][a-z0-9+.-]*:|\/)/i.test(ref)) return ref;
      return asset(new URL(ref, "http://service" + from).pathname);
    };
    const data = /(<script type="application\/json" id="svgdeck-data">)([\s\S]*?)(<\/script>)/.exec(html);
    const meta = JSON.parse(data[2]);
    for (const slide of meta.slides) {
      slide.svg = slide.svg.replace(/\b(href|xlink:href|data-video)="([^"]*)"/g,
        (m, attr, ref) => `${attr}="${resolve(ref.replace(/&amp;/g, "&"), base + "slides/").replace(/&/g, "&amp;")}"`);
    }
    html = html.slice(0, data.index) + data[1] + JSON.stringify(meta).replace(/<\//g, "<\\/") + data[3]
      + html.slice(data.index + data[0].length);
    html = html.replace(/(@font-face \{[^}]*?src: )url\("([^"]+)"\)/g, (m, head, ref) => `${head}url(${JSON.stringify(resolve(ref, base))})`)
      .replace(/href="\/editor\//g, `href="${ROOT}editor/`)
      .replace(/("editorUrl":\s*)"([^"]*)"/, (m, k, u) => `${k}${JSON.stringify(link(u))}`)
      .replace("</head>", `<link rel="icon" href="${ROOT}editor/icon.svg" type="image/svg+xml">\n</head>`);
    if (params.has("print")) {
      /* PDF export here is the browser's print of the player's print mode; the
         hook goes in before the page's own start call */
      const hook = `<script>
(function () {
  const start = SvgDeck.start;
  SvgDeck.start = function () {
    const api = start.apply(this, arguments);
    Promise.resolve(api && api.ready).then(() => setTimeout(() => window.print(), 300));
    return api;
  };
})();
</script>
`;
      html = html.replace(/<script>\s*SvgDeck\.start\(/, (m) => hook + m);
    }
    document.open();
    document.write(html);
    document.close();
  }

  // --- the boot badge -------------------------------------------------------------------
  function badge() {
    const el = document.createElement("div");
    el.id = "calliope-boot";
    el.setAttribute("role", "status");
    el.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:10000;" +
      "padding:10px 16px;background:#111;color:#fff;font:600 13px/1.3 system-ui,sans-serif;" +
      "max-width:calc(100vw - 32px);box-sizing:border-box;pointer-events:none;transition:opacity .3s";
    document.body.append(el);
    const show = (s) => {
      if (s.error) {
        el.style.background = "#b3261e";
        el.style.pointerEvents = "auto";
        el.textContent = `Calliope could not start: ${s.error}`;
      } else if (s.fraction >= 1) {
        if (s.readOnly) { el.textContent = "Read-only: Calliope is open in another tab of this browser."; return; }
        el.style.opacity = "0";
        setTimeout(() => el.remove(), 400);
        listeners.delete(show);
      } else {
        const pct = Math.round(25 * (s.read || 0) + 75 * (s.fraction || 0));
        el.textContent = `${s.stage === "Starting" ? "Loading Calliope" : s.stage}… ${pct}%`;
      }
    };
    listeners.add(show);
    show(state);
  }
  if (PAGE !== "present") {
    if (document.body) badge(); else document.addEventListener("DOMContentLoaded", badge);
  }

  // --- storage that stays, and the app shell offline -----------------------------------
  navigator.storage?.persist?.().catch(() => {});
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register(ROOT + "sw.js", { scope: ROOT }).catch(() => {});
  }

  async function storageSummary() {
    const est = await navigator.storage?.estimate?.().catch(() => null);
    const kept = await navigator.storage?.persisted?.().catch(() => false);
    return { usage: est?.usage ?? null, quota: est?.quota ?? null, persisted: !!kept };
  }

  window.CalliopeRuntime = {
    root: ROOT, page: PAGE, asset, unasset, link, download, importDeck, present, storageSummary,
    param: (name) => new URLSearchParams(location.search).get(name),
    ready: () => indexed,
    onState: (f) => { listeners.add(f); f(state); return () => listeners.delete(f); },
  };
})();
