/* The browser build's service worker: keeps the app itself (pages, editor,
   Python runtime) in the cache so that Calliope opens with no network at all.
   Decks are not here: they live in IndexedDB and OPFS (web/worker.js). Over
   file:// there is no service worker and nothing needs one.
   tools/build-web.mjs fills in BUILD and FILES. */
const BUILD = "__BUILD__";
const FILES = __FILES__;
const CACHE = `calliope-web-${BUILD}`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k.startsWith("calliope-web-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* Cache first for the build's own files (the query of edit.html?deck=… is the
   page's business, not the cache's); the network for everything else. */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || !request.url.startsWith(self.registration.scope)) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(request, { ignoreSearch: true });
    return hit || fetch(request);
  }));
});
