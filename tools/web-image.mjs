/* Build-time half of the browser runtime's boot, adapted from Iris
   (tools/web-image.mjs there): install the packages into Pyodide running in
   Node, compile every module to bytecode, strip what a running service never
   reads, and pack each package's files as one image (tools/fs-image.mjs) that
   the worker writes straight into its filesystem.

   The .pyc files come from the very interpreter the site ships, so their magic
   number always matches. Design: docs/browser-runtime.md */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { loadPyodide } from "pyodide";
import { packImage, populate } from "./fs-image.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "/lib/python3.14/site-packages";
const quiet = { messageCallback: () => {} };
const IMAGE_FORMAT = 1;   // bump when the image's content rules change
/* bytecode without column positions: .pyc files near the size of their sources */
const ENV = { PYTHONNODEBUGRANGES: "1" };

const STRIP_DIR = /\/(tests|test|__pycache__|include)\//;
const STRIP_FILE = /\.(pyi|pxd|pyx|pxi|c|cc|cpp|h|hpp)$|\/py\.typed$/;

export function walkFS(FS, dir, out = []) {
  for (const name of FS.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const path = `${dir}/${name}`;
    const { mode } = FS.lstat(path);
    if (FS.isDir(mode)) walkFS(FS, path, out);
    else if (FS.isFile(mode)) out.push(path);
  }
  return out;
}

const COMPILE = (dirs) => `
import compileall, py_compile
for d in ${JSON.stringify(dirs)}:
    compileall.compile_dir(d, quiet=2, legacy=True, workers=1,
                           invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
`;

function owners(py, names) {
  const own = new Map();
  for (const name of names) {
    const info = py.runPython(`
import importlib.metadata as m
d = m.distribution(${JSON.stringify(name)})
[str(f).split("/")[0] for f in (d.files or [])]`).toJs();
    for (const top of new Set(info)) if (top !== ".." && !own.has(top)) own.set(top, name);
  }
  return own;
}

/* The packages, installed, compiled and stripped: { name: gzipped image }.
   Cached on disk, keyed on everything that determines the result. */
export async function packageImages({ packages, cacheDir, lock }) {
  const key = createHash("sha256").update(JSON.stringify({
    IMAGE_FORMAT, packages: packages.map((p) => [p, lock.packages[p].sha256]),
    source: readFileSync(fileURLToPath(import.meta.url), "utf8"),
  })).digest("hex").slice(0, 16);
  const dir = join(cacheDir, `image-${key}`);
  const index = join(dir, "index.json");
  if (existsSync(index)) {
    const names = JSON.parse(readFileSync(index, "utf8"));
    return Object.fromEntries(names.map((n) => [n, readFileSync(join(dir, `${n}.gz`))]));
  }
  const py = await loadPyodide({ packageCacheDir: cacheDir, env: ENV, stdout: () => {}, stderr: () => {} });
  const FS = py.FS;
  const before = new Set(walkFS(FS, SITE));
  await py.loadPackage(packages, quiet);
  py.runPython(COMPILE([SITE]));

  const own = owners(py, packages);
  const groups = new Map(packages.map((n) => [n, []]));
  const all = walkFS(FS, SITE).filter((p) => !before.has(p));
  const dropped = new Set();
  const paths = new Set(all);
  for (const path of all.sort()) {
    const rel = path.slice(SITE.length + 1);
    if (STRIP_DIR.test(`/${rel}`) || STRIP_FILE.test(path)) continue;
    if (path.endsWith(".py") && paths.has(`${path}c`)) continue;   // the bytecode replaces it
    const top = rel.split("/")[0];
    const name = own.get(top) ?? own.get(top.replace(/\.pyc$/, ".py"));
    if (!name) { dropped.add(top); continue; }   // pulled in for a package left out (build-web.mjs SKIP)
    groups.get(name).push({ path, data: FS.readFile(path) });
  }
  if (dropped.size) console.log(`left out: ${[...dropped].sort().join(", ")}`);
  for (const old of readdirSync(cacheDir)) {
    if (old.startsWith("image-")) rmSync(join(cacheDir, old), { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  const out = {};
  for (const [name, files] of groups) {
    out[name] = gzipSync(packImage(files), { level: 9 });
    writeFileSync(join(dir, `${name}.gz`), out[name]);
  }
  writeFileSync(index, JSON.stringify(packages));
  return out;
}

/* The Python standard library with bytecode in place of its sources. */
async function compiledStdlib(py) {
  const stdlib = readFileSync(join(ROOT, "node_modules", "pyodide", "python_stdlib.zip"));
  py.FS.writeFile("/tmp/stdlib.zip", new Uint8Array(stdlib));
  py.runPython(`
import compileall, os, py_compile, shutil, zipfile
src = zipfile.ZipFile("/tmp/stdlib.zip")
src.extractall("/tmp/stdlib")
compileall.compile_dir("/tmp/stdlib", quiet=2, legacy=True, ddir="/lib/python314.zip",
                       invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
with zipfile.ZipFile("/tmp/stdlib-compiled.zip", "w", zipfile.ZIP_DEFLATED, compresslevel=9) as out:
    for info in src.infolist():
        name = info.filename
        if name.endswith(".py") and os.path.exists("/tmp/stdlib/" + name + "c"):
            name += "c"
        if name.endswith("/"):
            continue
        z = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        z.compress_type = zipfile.ZIP_DEFLATED
        with open("/tmp/stdlib/" + name, "rb") as f:
            out.writestr(z, f.read())
shutil.rmtree("/tmp/stdlib")
`);
  return py.FS.readFile("/tmp/stdlib-compiled.zip");
}

/* svgdeck itself (and the sample deck), compiled the same way. Then boots the
   whole image once and runs a smoke test through the real app, which proves it
   imports and serves, and records which shared libraries the import loads so
   the worker can load them ahead of it. */
export async function appImage({ images, appFiles, smoke }) {
  const py = await loadPyodide({ env: ENV, stdout: () => {}, stderr: (s) => console.error(s) });
  const FS = py.FS;
  for (const gz of Object.values(images)) populate(FS, new Uint8Array(gunzipSync(gz)));
  for (const [path, data] of Object.entries(appFiles)) {
    FS.mkdirTree(dirname(path));
    FS.writeFile(path, new Uint8Array(data));
  }
  py.runPython(COMPILE(["/app"]));
  const stdlib = await compiledStdlib(py);
  const extensions = () => py.runPython(`
import sys
[m.__file__ for m in list(sys.modules.values())
 if (getattr(m, "__file__", None) or "").endswith(".so")]`).toJs();
  py.runPython(`
import sys
sys.path.insert(0, "/app")
from svgdeck import browser
browser.install()
import svgdeck.server, svgdeck.export
`);
  const boot = extensions();
  if (smoke) py.runPython(smoke);

  const files = [];
  for (const path of walkFS(FS, "/app").sort()) {
    if (path.includes("/__pycache__/") || (path.endsWith(".py") && exists(FS, `${path}c`))) continue;
    files.push({ path, data: FS.readFile(path) });
  }
  return { image: gzipSync(packImage(files), { level: 9 }), stdlib, dynlibs: boot };
}

function exists(FS, path) {
  try { FS.lstat(path); return true; } catch { return false; }
}
