#!/usr/bin/env node
/* How long the browser build takes to come up, stage by stage (adapted from
   Iris's tools/boot-timing.mjs). Every run is a cold boot in a fresh browser
   context: the deck list with its first decks, then the editor on the sample
   deck (a second boot, as every page boots its own worker).

     node tools/boot-timing.mjs                      # dist-web/ served from here
     node tools/boot-timing.mjs file                 # dist-web/ over file://
     node tools/boot-timing.mjs https://host/path/   # a deployed copy
     RUNS=3 node tools/boot-timing.mjs               # median of three */
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist-web");
const runs = Number(process.env.RUNS ?? 1);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

let server = null, base = process.argv[2];
if (base === "file") base = `file://${DIST}/`;
if (!base) {
  server = createServer((req, res) => {
    let path = normalize(join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname)));
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!path.startsWith(DIST) || !existsSync(path)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(readFileSync(path));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
}

/* In the page before anything else: the worker's progress messages, timed. */
const hook = () => {
  const log = (window.__calliopeTiming = []);
  const Base = window.Worker;
  window.Worker = class extends Base {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", ({ data }) => {
        if (data?.type === "progress") log.push({ t: performance.now(), stage: data.stage });
        else if (data?.type === "failed") log.push({ t: performance.now(), stage: `failed: ${data.message}` });
      });
    }
  };
};

async function once(browser) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addInitScript(hook);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  const t0 = Date.now();
  await page.goto(base + "index.html", { waitUntil: "commit" });
  await page.waitForSelector("text=Welcome to Calliope", { timeout: 120000 });
  const list = (Date.now() - t0) / 1000;
  const stages = (await page.evaluate(() => window.__calliopeTiming.map((e) => ({ stage: e.stage, at: e.t / 1000 }))))
    .filter((s, i, all) => i === 0 || all[i - 1].stage !== s.stage);

  const t1 = Date.now();
  await page.goto(base + "edit.html?deck=Welcome-to-Calliope", { waitUntil: "commit" });
  await page.waitForFunction("document.getElementById('status')?.textContent.includes('Saved')", null, { timeout: 120000 });
  const editor = (Date.now() - t1) / 1000;
  const editorReady = await page.evaluate(() => window.__calliopeTiming.find((e) => e.stage === "Ready")?.t / 1000);
  await context.close();
  return { list, stages, editor, editorReady };
}

const browser = await chromium.launch();
const results = [];
for (let i = 0; i < runs; i++) results.push(await once(browser));
await browser.close();
server?.close();

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pick = (k) => median(results.map((r) => r[k]));
const first = results[Math.floor(results.length / 2)];
console.log(`${base}  (${runs} cold boot${runs > 1 ? "s" : ""}, median; times from navigation start)`);
for (const [i, s] of first.stages.entries()) {
  const next = first.stages[i + 1]?.at;
  console.log(`  ${s.stage.padEnd(36)} ${s.at.toFixed(2).padStart(6)} s${next ? `  (${(next - s.at).toFixed(2)} s)` : ""}`);
}
console.log(`  deck list with its decks                ${pick("list").toFixed(2).padStart(6)} s`);
console.log(`  editor, second page: service ready      ${pick("editorReady").toFixed(2).padStart(6)} s`);
console.log(`  editor, second page: slide loaded       ${pick("editor").toFixed(2).padStart(6)} s`);
