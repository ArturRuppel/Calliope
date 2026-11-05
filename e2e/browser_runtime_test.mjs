#!/usr/bin/env node
/* End to end, the browser build with no server: open dist-web/ (served as
   static files from this process), wait for the Python service in the worker,
   create a deck, add a slide with a shape, reload and find it kept, add a
   picture and see it drawn, export the offline zip and import it back, and
   present it. Headless Chromium; about a minute.

     npm run build:web && npm run test:e2e
     node e2e/browser_runtime_test.mjs https://host/sub/path/   # a deployed copy */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { extname, join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { chromium } from "playwright";
import { samplePicture } from "../tools/sample-picture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist-web");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf", ".webmanifest": "application/manifest+json" };

/* Served from a sub-path, as it would be on a shared host. */
function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith("/sub/calliope/")) { res.writeHead(404); return res.end(); }
    let path = normalize(join(DIST, decodeURIComponent(url.pathname.slice("/sub/calliope/".length))));
    if (!path.startsWith(DIST)) { res.writeHead(403); return res.end(); }
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!existsSync(path)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(readFileSync(path));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve({ server, url: `http://127.0.0.1:${server.address().port}/sub/calliope/` })));
}

const started = Date.now();
const step = (what) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(5)} s  ${what}`);
function check(ok, what) { if (!ok) throw new Error(`failed: ${what}`); }

const local = process.argv[2] ? null : await serve();
const base = process.argv[2] ?? local.url;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("  [console]", m.text()); });
const saved = () => page.waitForFunction("document.getElementById('status')?.textContent.includes('Saved')", null, { timeout: 30000 });

try {
  await page.goto(base + "index.html");
  await page.waitForSelector("text=Welcome to Calliope", { timeout: 60000 });
  step("deck list up, sample deck made on the first visit");

  await page.fill("#new input[name=title]", "E2E deck");
  await page.fill("#new input[name=name]", "e2e-deck");
  await page.click("#new button.primary");
  await page.waitForURL(/edit\.html\?deck=e2e-deck/, { timeout: 30000 });
  await saved();
  step("deck created, editor open");

  await page.click("#slide-add");
  await page.waitForFunction("svgdeckEditor.state.deck.slides.length === 2");
  await page.keyboard.press("r");
  const at = (x, y) => page.evaluate(([x, y]) => {
    const e = svgdeckEditor.editor, r = e.page.getBoundingClientRect();
    return [r.left + x * e.zoom, r.top + y * e.zoom];
  }, [x, y]);
  await page.mouse.move(...await at(200, 200));
  await page.mouse.down();
  await page.mouse.move(...await at(700, 500), { steps: 8 });
  await page.mouse.up();
  await saved();
  await page.evaluate("svgdeckEditor.flush()");
  await saved();
  step("slide added, rectangle drawn and saved");

  await page.reload();
  await saved();
  const kept = await page.evaluate(() => ({ slides: svgdeckEditor.state.deck.slides.length,
    rects: svgdeckEditor.editor.svg.querySelectorAll("rect").length }));
  check(kept.slides === 2 && kept.rects === 2, `slide and rectangle kept after reload (${JSON.stringify(kept)})`);
  step("reloaded: both kept (IDBFS)");

  await page.setInputFiles("#media-file", { name: "dots.png", mimeType: "image/png", buffer: samplePicture(120, 80) });
  await page.waitForFunction("svgdeckEditor.editor.svg.querySelector('image')", null, { timeout: 30000 });
  const drawn = await page.evaluate(async () => {
    const image = svgdeckEditor.editor.svg.querySelector("image");
    const href = image.getAttribute("href");
    const img = new Image();
    img.src = href;
    await img.decode();
    return { href, w: img.naturalWidth, h: img.naturalHeight, box: image.getBoundingClientRect().width };
  });
  check(drawn.href.startsWith("blob:") && drawn.w === 120 && drawn.h === 80 && drawn.box > 0, `picture drawn from OPFS (${JSON.stringify(drawn)})`);
  await saved();
  await page.evaluate("svgdeckEditor.flush()");
  const stored = await page.evaluate(async () => {
    const r = await fetch(`/api/decks/e2e-deck/slides/${svgdeckEditor.state.current}`);
    return r.text();
  });
  check(/href="\.\.\/media\/dots-[0-9a-f]{8}\.png"/.test(stored), "the slide file names the picture as ../media/, not a blob URL");
  step("picture added: stored in OPFS, drawn from a blob URL, saved as ../media/");

  /* a movie, if ffmpeg is here to make one (VP9: Playwright's Chromium has no H.264) */
  let movie = null;
  try {
    movie = join(tmpdir(), `calliope-e2e-${process.pid}.webm`);
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
      "-c:v", "libvpx-vp9", "-b:v", "50k", movie]);
  } catch (e) { movie = null; }
  if (movie) {
    await page.setInputFiles("#media-file", movie);
    const video = await page.waitForFunction(() => {
      const el = svgdeckEditor.editor.svg.querySelector("image[data-video]");
      return el && { poster: el.getAttribute("href"), video: el.getAttribute("data-video"), w: +el.getAttribute("width") };
    }, null, { timeout: 30000 });
    const v = await video.jsonValue();
    check(v.poster.startsWith("blob:") && v.video.startsWith("blob:"), `movie and poster from blob URLs (${JSON.stringify(v)})`);
    await saved();
    await page.evaluate("svgdeckEditor.flush()");
    const text = await page.evaluate(async () => (await fetch(`/api/decks/e2e-deck/slides/${svgdeckEditor.state.current}`)).text());
    check(/data-video="\.\.\/media\/calliope-e2e-\d+-[0-9a-f]{8}\.webm"/.test(text) && /\.poster\.jpg"/.test(text),
      "the slide names the movie (kept as .webm) and its poster frame");
    step("movie added: size and poster frame taken in the page, kept as .webm");
    rmSync(movie, { force: true });
  } else step("movie skipped: no ffmpeg to make one");

  await page.setInputFiles("#media-file", { name: "clip.mkv", mimeType: "video/x-matroska", buffer: Buffer.from("not a movie") });
  await page.waitForFunction(() => /cannot convert/.test(document.getElementById("toast").textContent), null, { timeout: 15000 });
  step("an .mkv is refused with a reason (no converter in the browser)");

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.evaluate("CalliopeRuntime.download('/api/decks/e2e-deck/export.zip', 'e2e-deck.zip')"),
  ]);
  const zipPath = await download.path();
  const entries = unzipSync(new Uint8Array(readFileSync(zipPath)));
  const png = Object.keys(entries).find((n) => /media\/dots-[0-9a-f]{8}\.png$/.test(n));
  check(entries["e2e-deck/index.html"] && png, `export holds the page and the picture (${Object.keys(entries).join(", ")})`);
  check(entries[png][0] === 0x89 && entries[png][1] === 0x50, "the picture in the export is the PNG, not its stub");
  step(`offline export downloaded (${download.suggestedFilename()}, ${Object.keys(entries).length} files)`);

  await page.goto(base + "index.html");
  await page.waitForSelector("text=E2E deck");
  await page.setInputFiles("#import input[type=file]", zipPath);
  await page.click("#import button.primary");
  await page.waitForSelector("text=Imported E2E deck as e2e-deck-2", { timeout: 30000 });
  step("export imported back as e2e-deck-2");

  const popup = context.waitForEvent("page");
  await page.click(".deck:has-text('e2e-deck-2') a:has-text('Present')");
  const show = await popup;
  show.on("pageerror", (e) => errors.push(`presenter: ${e.message}`));
  await show.waitForSelector(".svgdeck image", { state: "attached", timeout: 60000 });
  await show.keyboard.press("ArrowRight");
  const shown = await show.waitForFunction(async () => {
    const image = document.querySelector(".svgdeck image");
    const href = image?.getAttribute("href");
    if (!href?.startsWith("blob:")) return null;
    const img = new Image(); img.src = href;
    try { await img.decode(); } catch (e) { return null; }
    return img.naturalWidth;
  }, null, { timeout: 30000 });
  check(await shown.jsonValue() === 120, "the presenter draws the imported picture");
  step("presenter shows the imported deck with its picture");

  if (!process.argv[2]) {
    /* the same build opened straight from disk */
    const disk = await context.newPage();
    disk.on("pageerror", (e) => errors.push(`file://: ${e.message}`));
    await disk.goto(`file://${DIST}/index.html`);
    await disk.waitForSelector("text=Welcome to Calliope", { timeout: 60000 });
    await disk.goto(`file://${DIST}/edit.html?deck=Welcome-to-Calliope`);
    await disk.waitForFunction("document.getElementById('status')?.textContent.includes('Saved')", null, { timeout: 30000 });
    const width = await disk.evaluate(async () => {
      await svgdeckEditor.openSlide("s03");
      const href = svgdeckEditor.editor.svg.querySelector("image")?.getAttribute("href") || "";
      const img = new Image(); img.src = href; await img.decode();
      return href.startsWith("blob:") ? img.naturalWidth : 0;
    });
    check(width === 800, `the sample picture is drawn over file:// (${width})`);
    step("over file:// too: deck list and editor (modules from blob URLs, media in IndexedDB)");
  }

  check(!errors.length, `no page errors (${errors.join("; ")})`);
  console.log("PASS");
} catch (e) {
  console.log("FAIL:", e.message);
  if (errors.length) console.log("page errors:", errors.join("\n"));
  await page.screenshot({ path: join(ROOT, "e2e", "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  local?.server.close();
}
