#!/usr/bin/env node
/* Build Calliope with nothing to install into dist-web/: the editor, the
   player and the svgdeck service, which runs in Pyodide in a Web Worker.

   The editor stays plain JavaScript (no bundler): its files are copied as they
   are, and its two pages get the runtime in front (web/runtime.js). Python,
   its packages and svgdeck are installed and compiled here, in Pyodide under
   Node, and shipped as filesystem images (tools/web-image.mjs, the Iris
   pipeline). Every runtime file is a classic script holding base64, because a
   classic <script> is the one way a page opened over file:// can read a
   neighbouring file. Each downloaded wheel is checked against the SHA-256 in
   Pyodide's lock file. Design: docs/browser-runtime.md */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { samplePicture } from "./sample-picture.mjs";
import { appImage, packageImages } from "./web-image.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist-web");
const PYO = join(OUT, "pyodide");
const CACHE = join(ROOT, "node_modules", ".cache", "calliope-web");
const NPM_PYO = join(ROOT, "node_modules", "pyodide");
const EDITOR = join(ROOT, "svgdeck", "editor");

/* What the service imports. FastAPI's lock entry also names httpx and jinja2,
   which only its test client and templates use: left out. */
const ROOTS = ["fastapi", "fonttools", "brotli"];
const SKIP = new Set(["httpx", "jinja2", "httpcore", "h11", "certifi", "markupsafe"]);
/* Wheels other projects here already fetched (same lock, same SHA-256). */
const SEEDS = [join(ROOT, "..", "Iris", "node_modules", ".cache", "iris-web")];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function fetchVerified(url, name, expected) {
  mkdirSync(CACHE, { recursive: true });
  const cached = join(CACHE, name);
  let buf = existsSync(cached) ? readFileSync(cached) : null;
  for (const seed of SEEDS) if (!buf && existsSync(join(seed, name))) buf = readFileSync(join(seed, name));
  if (!buf) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  if (sha256(buf) !== expected) throw new Error(`${name}: SHA-256 mismatch`);
  writeFileSync(cached, buf);
}

function lockClosure(lock) {
  const names = new Set();
  const visit = (name) => {
    const key = name.toLowerCase().replaceAll("_", "-");
    if (SKIP.has(key) || names.has(key)) return;
    const pkg = lock.packages[key];
    if (!pkg) throw new Error(`not in pyodide-lock.json: ${name}`);
    names.add(key);
    pkg.depends.forEach(visit);
  };
  ROOTS.forEach(visit);
  return [...names].sort();
}

function walk(dir, keep = () => true, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "__pycache__") walk(path, keep, out); }
    else if (keep(path)) out.push(path);
  }
  return out;
}

/* --- the pages --------------------------------------------------------------- */
const describe = execFileSync("git", ["-C", ROOT, "describe", "--always", "--dirty", "--abbrev=7"], { encoding: "utf8" }).trim();

function page(source, kind) {
  let html = readFileSync(source, "utf8");
  html = html.replace(/<html([^>]*)>/, `<html$1 data-calliope-page="${kind}">`)
    .replace(/<meta charset="utf-8">/, `<meta charset="utf-8">\n<script src="runtime.js"></script>`)
    .replace(/<link rel="manifest"[^>]*>\n?/g, "")
    .replace(/(<title>)/, `<link rel="manifest" href="manifest.webmanifest">\n<meta name="generator" content="calliope-web ${describe}">\n$1`)
    .replace(/(href|src)="\/editor\//g, '$1="editor/');
  if (kind === "edit") {
    html = html.replace("<title>{{DECK}} · Calliope</title>", "<title>Calliope</title>")
      .replace('data-deck="{{DECK}}"', 'data-deck=""')
      .replace(/(<body[^>]*>)/, `$1\n<script>document.body.dataset.deck = CalliopeRuntime.param("deck") || ""; ` +
        `document.title = document.body.dataset.deck + " · Calliope";</script>`);
    if (html.includes("{{DECK}}")) throw new Error("editor.html: a {{DECK}} left over");
    const module = /<script type="module" src="editor\/main\.js"><\/script>/;
    if (!module.test(html)) throw new Error("editor.html: no main.js module tag");
    html = html.replace(module, `<script>CalliopeRuntime.loadModule("editor/main.js");</script>`);
  }
  return html;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "editor"), { recursive: true });
for (const path of walk(EDITOR, (p) => !/\/(sw\.js|decks\.html|editor\.html|manifest\.webmanifest)$/.test(p))) {
  const target = join(OUT, "editor", relative(EDITOR, path));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(path, target);
}
/* the same modules as text, for a page opened over file:// (web/runtime.js, loadModule) */
const modules = Object.fromEntries(readdirSync(EDITOR).filter((f) => f.endsWith(".js") && f !== "sw.js")
  .filter((f) => /^\s*(import|export)\b/m.test(readFileSync(join(EDITOR, f), "utf8")))
  .map((f) => [f, readFileSync(join(EDITOR, f), "utf8")]));
writeFileSync(join(OUT, "editor", "modules.js"), `__calliopeModules(${JSON.stringify(modules)});\n`);
writeFileSync(join(OUT, "index.html"), page(join(EDITOR, "decks.html"), "index"));
writeFileSync(join(OUT, "edit.html"), page(join(EDITOR, "editor.html"), "edit"));
for (const f of ["present.html", "manifest.webmanifest"]) copyFileSync(join(ROOT, "web", f), join(OUT, f));
const mediaStore = readFileSync(join(ROOT, "web", "media-store.js"), "utf8");
writeFileSync(join(OUT, "runtime.js"), `${mediaStore}\n${readFileSync(join(ROOT, "web", "runtime.js"), "utf8")}`);

/* --- Python ------------------------------------------------------------------ */
mkdirSync(PYO, { recursive: true });
const payload = [];
function addPayload(name, bytes) {
  const script = `${name}.js`;
  writeFileSync(join(PYO, script), `__calliopePayload(${JSON.stringify(name)},"${Buffer.from(bytes).toString("base64")}");\n`);
  payload.push({ name, script, bytes: bytes.length });
}

const version = JSON.parse(readFileSync(join(NPM_PYO, "package.json"), "utf8")).version;
const lock = JSON.parse(readFileSync(join(NPM_PYO, "pyodide-lock.json"), "utf8"));
const packages = lockClosure(lock);
for (const name of packages) {
  const { file_name, sha256: expected } = lock.packages[name];
  await fetchVerified(`https://cdn.jsdelivr.net/pyodide/v${version}/full/${file_name}`, file_name, expected);
}
const images = await packageImages({ packages, cacheDir: CACHE, lock });

/* svgdeck: the Python modules and what they read at run time (the player,
   inlined into every presenter page, and the two page templates). */
const appFiles = {};
const PKG = join(ROOT, "svgdeck");
for (const path of walk(PKG, (p) => /\.py$/.test(p) || /\/player\//.test(p)
  || /\/editor\/(movie-range\.js|sanitize-svg\.js|decks\.html|editor\.html)$/.test(p))) {
  appFiles[`/app/svgdeck/${relative(PKG, path)}`] = readFileSync(path);
}
const picture = samplePicture();
const pictureFile = `pattern-${createHash("sha1").update(picture).digest("hex").slice(0, 8)}.png`;
for (const path of walk(join(ROOT, "web", "sample"))) {
  let data = readFileSync(path);
  if (path.endsWith(".svg")) data = Buffer.from(data.toString("utf8").replaceAll("../media/PICTURE", `../media/${pictureFile}`));
  appFiles[`/app/sample/${relative(join(ROOT, "web", "sample"), path)}`] = data;
}

/* Proof that the service imports and answers under Pyodide, through the same
   dispatch the worker uses: a deck made, edited, presented and exported. */
const smoke = `
import json, os
from svgdeck import browser
os.makedirs("/smoke", exist_ok=True)
browser.boot("/smoke")
def ask(method, url, body=b"", headers=None):
    status, h, data = browser.dispatch(method, url, json.dumps(headers or {}), body)
    assert status < 400, (method, url, status, data[:300])
    return json.loads(h), data
assert browser.needs_sample("/smoke")
browser.create_sample("/smoke", "/app/sample", json.dumps({"file": "${pictureFile}", "sha1": "0" * 40, "type": "image/png", "size": 1}))
decks = json.loads(ask("GET", "/api/decks")[1])
assert [d["name"] for d in decks] == ["Welcome-to-Calliope"], decks
ask("POST", "/api/decks", json.dumps({"name": "smoke", "title": "Smoke"}).encode(), {"content-type": "application/json"})
deck = json.loads(ask("GET", "/api/decks/smoke")[1])
sid = deck["deck"]["slides"][0]["id"] if "deck" in deck else deck["slides"][0]["id"]
h, svg = ask("GET", f"/api/decks/smoke/slides/{sid}")
svg = svg.replace(b"</svg>", b'<rect x="1" y="1" width="9" height="9"/></svg>')
sver = json.loads(ask("PUT", f"/api/decks/smoke/slides/{sid}", svg, {"if-match": h["etag"], "content-type": "image/svg+xml"})[1])["version"]
rec = {"sha1": "a" * 40, "type": "image/png", "size": 3, "width": 4, "height": 5}
info = json.loads(ask("POST", "/api/decks/smoke/media?filename=x.png", json.dumps(rec).encode())[1])
assert info["href"] == "../media/x-aaaaaaaa.png", info
h, _ = ask("GET", "/d/smoke/media/x-aaaaaaaa.png")
assert h["x-calliope-blob"] == "a" * 40, h
ask("GET", "/d/Welcome-to-Calliope/")
h, z = ask("GET", "/api/decks/Welcome-to-Calliope/export.zip")
assert h["x-calliope-zip-stubs"] == "1" and z[:2] == b"PK"
ask("POST", "/api/decks/smoke/commits", json.dumps({"message": "first", "expectedDeck": deck["version"],
    "expectedSlides": {sid: sver}}).encode(), {"content-type": "application/json"})
summary = json.loads(ask("POST", "/api/browser/import?filename=w.zip", z)[1])
assert summary["name"] == "Welcome-to-Calliope-2", summary
index = json.loads(ask("GET", "/api/browser/media")[1])
assert "/d/smoke/media/x-aaaaaaaa.png" in index["media"], index
# a font: into the library (fontTools), into the deck, out as woff2 (brotli)
face = json.loads(ask("POST", "/api/fonts?filename=plex.ttf", open("/fixtures/plex.ttf", "rb").read())[1])
ask("POST", "/api/decks/smoke/fonts", json.dumps({"family": face["family"]}).encode(), {"content-type": "application/json"})
import io, zipfile
names = zipfile.ZipFile(io.BytesIO(ask("GET", "/api/decks/smoke/export.zip")[1])).namelist()
assert any(n.endswith(".woff2") for n in names), names
`;
const built = await appImage({ images, appFiles, smoke,
  fixtures: { "/fixtures/plex.ttf": readFileSync(join(EDITOR, "harmonia", "fonts", "ibm-plex-mono-400.ttf")) } });

const core = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
for (const f of core) addPayload(f, f === "python_stdlib.zip" ? built.stdlib : readFileSync(join(NPM_PYO, f)));
const imageNames = [];
for (const name of Object.keys(images)) { addPayload(`${name}.img`, images[name]); imageNames.push(`${name}.img`); }
addPayload("svgdeck.img", built.image);
imageNames.push("svgdeck.img");
addPayload("sample-picture.png", picture);

/* The worker's source: fflate, the image reader, the media store, then web/worker.js. */
const workerSource = [
  readFileSync(join(ROOT, "node_modules", "fflate", "umd", "index.js"), "utf8"),
  readFileSync(join(ROOT, "tools", "fs-image.mjs"), "utf8").replace(/^export /gm, ""),
  mediaStore,
  readFileSync(join(ROOT, "web", "worker.js"), "utf8"),
].join("\n;\n");
const workerScript = `worker-${sha256(workerSource).slice(0, 10)}.js`;
writeFileSync(join(PYO, workerScript), `__calliopeWorker(${JSON.stringify(workerSource)});\n`);

writeFileSync(join(PYO, "manifest.js"), `__calliopeManifest(${JSON.stringify({
  build: describe, core, images: imageNames, packages, dynlibs: built.dynlibs, worker: workerScript,
  sample: { picture: "sample-picture.png", file: pictureFile }, files: payload })});\n`);

/* The service worker caches every file of the build, under the build's hash. */
const all = walk(OUT).map((p) => relative(OUT, p).split("\\").join("/")).sort();
const build = sha256(all.map((p) => p + sha256(readFileSync(join(OUT, p)))).join("\n")).slice(0, 12);
writeFileSync(join(OUT, "sw.js"), readFileSync(join(ROOT, "web", "sw.js"), "utf8")
  .replace("__BUILD__", build).replace("__FILES__", JSON.stringify(["./", ...all])));

let bytes = 0;
for (const f of readdirSync(PYO)) bytes += statSync(join(PYO, f)).size;
console.log(`dist-web: ${describe} (build ${build}), Pyodide ${version}, ${packages.length} packages `
  + `(${packages.join(", ")}), ${(bytes / 1e6).toFixed(1)} MB under pyodide/, ${built.dynlibs.length} libraries at boot`);
