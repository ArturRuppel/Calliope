/* Where the browser build keeps the bytes of pictures and movies, by SHA-1.

   The Origin Private File System where there is one (Chromium, Safari 16.4+,
   over http(s)); IndexedDB otherwise (Chromium has no OPFS for a page opened
   over file://). Writing to OPFS takes a sync access handle, which only a worker
   has (and the only OPFS write Safari offers), so `put` runs in the worker;
   `get` runs in both. tools/build-web.mjs puts this in front of web/worker.js
   and web/runtime.js. */
/* exported CalliopeMediaStore */
const CalliopeMediaStore = (() => {
  "use strict";
  const DIR = "calliope-media", DB = "calliope-media", STORE = "blobs";
  let opfsDir, db;

  async function opfs() {
    if (opfsDir === undefined) {
      try { opfsDir = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true }); }
      catch (e) { opfsDir = null; }
    }
    return opfsDir;
  }
  function idb() {
    db ??= new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return db;
  }
  const request = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

  async function putOpfs(dir, hash, blob) {
    try {
      const existing = await (await dir.getFileHandle(hash)).getFile();
      if (existing.size === blob.size) return true;
    } catch (e) { /* not there yet */ }
    const handle = await dir.getFileHandle(hash, { create: true });
    if (!handle.createSyncAccessHandle) return false;
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
      access.close();
    } catch (e) {
      access.close();
      await dir.removeEntry(hash).catch(() => {});
      throw e;
    }
    return true;
  }

  /** Store `blob` under its SHA-1 `hash` (a file already there is kept). */
  async function put(hash, blob) {
    const dir = await opfs();
    if (dir && await putOpfs(dir, hash, blob)) return "opfs";
    const tx = (await idb()).transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, hash);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    return "idb";
  }

  /** The stored file (a disk-backed Blob), or an error when it is not here. */
  async function get(hash) {
    const dir = await opfs();
    if (dir) {
      try { return await (await dir.getFileHandle(hash)).getFile(); } catch (e) { /* try IndexedDB */ }
    }
    const blob = await request((await idb()).transaction(STORE).objectStore(STORE).get(hash));
    if (!blob) throw new Error(`media ${hash} is not stored in this browser`);
    return blob;
  }

  return { put, get };
})();
