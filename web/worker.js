/* The worker half of Calliope's browser runtime (web/runtime.js is the page
   half). It boots Pyodide from the files the page passes in, runs the real
   svgdeck service (svgdeck/browser.py) and answers the page's requests one at a
   time. Requests that arrive during boot wait for it.

   Storage:
   - /data is an IDBFS mount: decks, commits, revisions, trash, the font
     library. Loaded once at boot, written back after every successful request
     that changes something.
   - Media bytes live in the Origin Private File System, in calliope-media/<sha1>,
     written here with sync access handles (the one OPFS write path Safari has).
     The deck's media/ folder in /data holds a stub per file (svgdeck/browser.py).

   Built by tools/build-web.mjs, which puts fflate and tools/fs-image.mjs in
   front of this file. Pyodide reads its files through `fetch`, which is
   overridden to answer from memory for one reserved address (the Iris recipe). */
/* global fflate, populate */
"use strict";

/* Chromium only allows a classic worker from a blob on file://, and Pyodide
   refuses classic workers because it expects import(), which works here too. */
self.importScripts = () => { throw new TypeError("importScripts is unavailable"); };

const DATA = "/data";
const VIRTUAL = "https://calliope-payload.invalid/";
const MEDIA_DIR = "calliope-media";
const STORED = /\.(mp4|m4v|mov|webm|woff2|jpe?g|png|gif|webp|avif)$/i;
const MAGIC = new TextEncoder().encode("calliope-blob\n");

const files = new Map();
const images = new Map();
const arrived = new Map();
let imageNames = new Set();
let py = null, bridge = null;
let bootDone, bootFailed;
const ready = new Promise((res, rej) => { bootDone = res; bootFailed = rej; });
ready.catch(() => {});

const progress = (stage, fraction) => self.postMessage({ type: "progress", stage, fraction });

function decode(base64) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(base64);
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== "function") return fflate.gunzipSync(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* Emscripten walks the whole global offset table after each shared library to
   find the few unresolved symbols; this answers that question from a running
   list (Iris, src/engine.worker.ts). */
function fastUnresolvedScan(GOT) {
  const entries = Object.entries;
  let scanned = 0, open = [];
  Object.entries = function (o) {
    if (o !== GOT) return entries(o);
    const keys = Object.keys(GOT);
    for (let i = scanned; i < keys.length; i++) open.push(keys[i]);
    scanned = keys.length;
    open = open.filter((k) => GOT[k].value === -1);
    return open.map((k) => [k, GOT[k]]);
  };
}

function when(name) {
  if (files.has(name) || images.has(name)) return Promise.resolve();
  return new Promise((resolve) => arrived.set(name, resolve));
}
function need(name) {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`missing from this build: ${name}`);
  return bytes;
}

const realFetch = self.fetch.bind(self);
self.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(VIRTUAL)) return realFetch(input, init);
  const name = url.slice(VIRTUAL.length);
  const type = name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
  return new Response(need(name), { status: 200, headers: { "Content-Type": type } });
};

const importFile = (name) => import(URL.createObjectURL(new Blob([need(name)], { type: "text/javascript" })));

const syncData = (populate) => new Promise((resolve, reject) => {
  py.FS.syncfs(populate, (err) => (err ? reject(err) : resolve()));
});

// --- OPFS media -----------------------------------------------------------------
let mediaDir = null;
async function media() {
  if (!mediaDir) {
    if (!navigator.storage?.getDirectory) throw new Error("this browser has no private file storage (OPFS) for pictures and movies");
    mediaDir = await (await navigator.storage.getDirectory()).getDirectoryHandle(MEDIA_DIR, { create: true });
  }
  return mediaDir;
}

async function sha1(blob) {
  const digest = await crypto.subtle.digest("SHA-1", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Content-addressed: a file already there with the same size is kept. */
async function putBlob(hash, blob) {
  const dir = await media();
  try {
    const existing = await (await dir.getFileHandle(hash)).getFile();
    if (existing.size === blob.size) return;
  } catch (e) { /* not there yet */ }
  const handle = await dir.getFileHandle(hash, { create: true });
  const access = await handle.createSyncAccessHandle();
  try {
    access.truncate(0);
    const reader = blob.stream().getReader();
    let at = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      access.write(value, { at });
      at += value.byteLength;
    }
    access.flush();
  } catch (e) {
    access.close();
    await dir.removeEntry(hash).catch(() => {});
    throw e;
  }
  access.close();
}

async function getBlob(hash) {
  return (await (await media()).getFileHandle(hash)).getFile();
}

function isStub(bytes) {
  if (bytes.byteLength < MAGIC.byteLength || bytes.byteLength > 4096) return false;
  for (let i = 0; i < MAGIC.byteLength; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}
const stubInfo = (bytes) => JSON.parse(new TextDecoder().decode(bytes.subarray(MAGIC.byteLength)));
function makeStub(hash, type, size) {
  return new TextEncoder().encode(`calliope-blob\n${JSON.stringify({ sha1: hash, type, size })}\n`);
}

// --- boot --------------------------------------------------------------------------
async function boot(manifest) {
  await Promise.all(manifest.core.map(when));
  progress("Starting Python", 0.1);
  const { loadPyodide } = await importFile("pyodide.mjs");
  const createPyodideModule = (await importFile("pyodide.asm.mjs")).default;
  py = await loadPyodide({
    indexURL: VIRTUAL, packageBaseUrl: VIRTUAL, createPyodideModule,
    lockFileContents: new TextDecoder().decode(need("pyodide-lock.json")),
    stdout: () => {}, stderr: (s) => console.warn("[python]", s),
  });
  for (const name of manifest.core) files.delete(name);
  if (py._module?.GOT) fastUnresolvedScan(py._module.GOT);

  progress("Preparing the deck service", 0.4);
  const pending = [...manifest.dynlibs];
  const present = new Set();
  for (const [i, name] of manifest.images.entries()) {
    await when(name);
    for (const path of populate(py.FS, await images.get(name))) present.add(path);
    images.delete(name);
    while (pending.length && present.has(pending[0])) await py._api.loadDynlib(pending.shift());
    progress("Preparing the deck service", 0.4 + 0.3 * ((i + 1) / manifest.images.length));
  }
  for (const name of manifest.packages) py.loadedPackages[name] = "default channel";

  progress("Opening the decks in this browser", 0.75);
  py.FS.mkdirTree(DATA);
  py.FS.mount(py.FS.filesystems.IDBFS, {}, DATA);
  await syncData(true);
  await py.runPythonAsync(`
import sys
sys.path.insert(0, "/app")
from svgdeck import browser
browser.install()
browser.boot("${DATA}")
`);
  bridge = py.pyimport("svgdeck.browser");
  await ensureSample(manifest.sample);
  progress("Ready", 1);
}

/* The sample deck, once, on a first visit: its picture goes to OPFS first. */
async function ensureSample(sample) {
  if (!sample || !bridge.needs_sample(DATA)) return;
  await when(sample.picture);
  const bytes = need(sample.picture);
  const blob = new Blob([bytes], { type: "image/png" });
  const hash = await sha1(blob);
  if (hash.slice(0, 8) !== sample.file.match(/-([0-9a-f]{8})\.png$/)[1]) throw new Error("sample picture does not match its name");
  await putBlob(hash, blob);
  bridge.create_sample(DATA, "/app/sample", JSON.stringify({ file: sample.file, sha1: hash, type: "image/png", size: bytes.byteLength }));
  await syncData(false);
}

// --- requests ------------------------------------------------------------------------
function call(method, url, headers = {}, body = new Uint8Array()) {
  const parsed = new URL(url, "http://browser");
  const out = bridge.dispatch(method, parsed.pathname + parsed.search, JSON.stringify(headers), py.toPy(body));
  const [status, headersJson, bytes] = out.toJs();
  out.destroy();
  return { status, headers: JSON.parse(headersJson), body: bytes };
}

const changes = (method) => method !== "GET" && method !== "HEAD";

async function answer(data) {
  const { id, method, url } = data;
  try {
    await ready;
    let res;
    if (data.kind === "media") res = await addMedia(data);
    else if (data.kind === "import") res = await importDeck(data);
    else res = call(method, url, data.headers, new Uint8Array(data.body || new ArrayBuffer(0)));
    /* written back only after a request that worked, so that a failed one
       cannot replace good data in browser storage */
    if ((changes(method) || data.kind) && res.status < 400) await syncData(false);
    if (res.headers["x-calliope-zip-stubs"]) res.body = await fillZip(res.body);
    self.postMessage({ type: "response", id, status: res.status, headers: res.headers, body: res.body },
      { transfer: [res.body.buffer] });
  } catch (err) {
    console.error(err);
    self.postMessage({ type: "response", id, error: String(err?.message ?? err) });
  }
}

const json = (status, value) => ({ status, headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(value)) });

/* The page has checked the file and taken its size (and a movie's poster);
   the bytes go to OPFS, the record to the store's add_media. */
async function addMedia({ url, file, poster, width, height, svg }) {
  const hash = await sha1(file);
  await putBlob(hash, file);
  const record = { sha1: hash, type: file.type || "", size: file.size, width, height };
  if (svg !== undefined) record.svg = svg;
  if (poster) {
    const posterHash = await sha1(poster);
    await putBlob(posterHash, poster);
    record.poster = { sha1: posterHash, size: poster.size };
  }
  return call("POST", url, { "content-type": "application/json" },
    new TextEncoder().encode(JSON.stringify(record)));
}

/* Media entries of the zip go to OPFS, the rest (now small) to the store. */
async function importDeck({ url, file }) {
  let entries;
  try { entries = fflate.unzipSync(new Uint8Array(await file.arrayBuffer())); }
  catch (e) { return json(400, { detail: `not a zip file: ${e.message}` }); }
  const out = {};
  const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    svg: "image/svg+xml", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
  for (const [path, bytes] of Object.entries(entries)) {
    if (/(^|\/)media\/[^/]/.test(path) && !path.endsWith("/") && !isStub(bytes)) {
      const type = TYPES[path.split(".").pop().toLowerCase()] || "";
      const blob = new Blob([bytes], { type });
      const hash = await sha1(blob);
      await putBlob(hash, blob);
      out[path] = makeStub(hash, type, bytes.byteLength);
    } else out[path] = bytes;
  }
  return call("POST", url, { "content-type": "application/zip" }, fflate.zipSync(out, { level: 6 }));
}

/* The export Python made carries stubs for the media: put the files back. */
async function fillZip(bytes) {
  const entries = fflate.unzipSync(bytes);
  const out = {};
  for (const [path, data] of Object.entries(entries)) {
    if (isStub(data)) {
      const info = stubInfo(data);
      out[path] = [new Uint8Array(await (await getBlob(info.sha1)).arrayBuffer()), { level: 0 }];
    } else out[path] = [data, { level: STORED.test(path) ? 0 : 6 }];
  }
  return fflate.zipSync(out);
}

let queue = Promise.resolve();
function fail(err) {
  bootFailed(err);
  self.postMessage({ type: "failed", message: String(err?.message ?? err) });
}

self.onmessage = ({ data }) => {
  if (data.type === "manifest") {
    imageNames = new Set(data.manifest.images);
    boot(data.manifest).then(bootDone, fail);
  } else if (data.type === "file") {
    const bytes = decode(data.base64);
    if (imageNames.has(data.name)) {
      const image = gunzip(bytes);
      image.catch(fail);
      images.set(data.name, image);
    } else files.set(data.name, bytes);
    arrived.get(data.name)?.();
    arrived.delete(data.name);
  } else if (data.type === "request") {
    queue = queue.then(() => answer(data));
  }
};
