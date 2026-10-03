/* Calliope's offline copy: the deck list and the presenter keep working when the
   server cannot be reached. Read-only -- editing always needs the server.

   offline.js (on the deck list) fills the cache from /api/offline; this worker
   only decides where an answer comes from:
     - deck media and fonts: the cached copy first. offline.js replaces a file
       whose version changed, so the copy is as fresh as the last sync.
     - pages and the deck list: the server first, the cached copy when it does
       not answer in time.
     - everything else (the editor's API, uploads, exports): the server only. */
const CACHE = "calliope-offline-v1";
const TIMEOUT_MS = 4000;
const OFFLINE_HEADER = "X-Calliope-Offline";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const isDeckFile = (path) => /^\/d\/[^/]+\/(media|fonts)\//.test(path);
const isFallbackable = (path) =>
  path === "/" || path.startsWith("/editor/") || /^\/d\/[^/]+\/$/.test(path) || path === "/api/decks" || path === "/api/trash";

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (request.cache === "no-store") return;  // offline.js fetching fresh copies
  if (isDeckFile(url.pathname)) event.respondWith(cacheFirst(request, url));
  else if (isFallbackable(url.pathname)) event.respondWith(serverFirst(request, url));
  else if (request.mode === "navigate") event.respondWith(fetch(request).catch(() => needsServer()));
});

async function cached(url) {
  const cache = await caches.open(CACHE);
  return cache.match(url.pathname);
}

async function cacheFirst(request, url) {
  const hit = await cached(url);
  if (!hit) return fetch(request);
  const range = request.headers.get("Range");
  return range ? slice(hit, range) : hit;
}

/** A 206 cut out of a cached full response: Safari will not play a movie
 *  that is not served in ranges. */
async function slice(response, range) {
  const blob = await response.blob();
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (!m[1] && !m[2])) return new Response(blob, { status: 200, headers: response.headers });
  let start, end;
  if (!m[1]) { start = Math.max(0, blob.size - Number(m[2])); end = blob.size - 1; }
  else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), blob.size - 1) : blob.size - 1; }
  if (start > end || start >= blob.size)
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}` } });
  const headers = new Headers(response.headers);
  headers.set("Content-Range", `bytes ${start}-${end}/${blob.size}`);
  headers.set("Content-Length", String(end - start + 1));
  headers.set("Accept-Ranges", "bytes");
  return new Response(blob.slice(start, end + 1, blob.type), { status: 206, headers });
}

async function serverFirst(request, url) {
  const hit = await cached(url);
  const network = fetch(request).then((response) => {
    // Keep the copy current between syncs. Deck pages are left to offline.js,
    // which records their version.
    if (response.ok && !url.pathname.startsWith("/d/")) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(url.pathname, copy)).catch(() => {});
    }
    return response;
  });
  if (!hit) return network.catch(() => (request.mode === "navigate" ? needsServer() : Response.error()));
  network.catch(() => {});
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS));
  const response = await Promise.race([network.catch(() => null), timeout]);
  if (response && (response.ok || response.status < 500)) return response;
  const headers = new Headers(hit.headers);
  headers.set(OFFLINE_HEADER, "1");
  return new Response(hit.body, { status: hit.status, headers });
}

function needsServer() {
  return new Response(`<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Calliope</title><body style="font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 15vh auto; padding: 0 24px">
<h1 style="font-size: 20px">This needs the Calliope server</h1>
<p>The server cannot be reached. Decks that were synced can still be presented from the deck list; editing needs the server.</p>
<p><a href="/">Back to the decks</a></p></body>`, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
