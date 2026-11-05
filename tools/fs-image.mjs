/* A filesystem image: many files packed into one buffer, so the browser can put
   a whole installed package into Pyodide's in-memory filesystem in one pass
   instead of unzipping a wheel at boot (the format Iris uses, src/fsImage.ts).

     u32 (little-endian) header length · header JSON · the files' bytes, in order

   The header is `{ files: [path, size][] }`, absolute paths. Node imports this
   module; tools/build-web.mjs also inlines it into the worker (without `export`). */

export function readImage(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength)));
  let offset = 4 + headerLength;
  const files = header.files.map(([path, size]) => {
    const file = { path, size, offset };
    offset += size;
    return file;
  });
  if (offset !== bytes.byteLength) throw new Error("filesystem image is truncated");
  return { files, bytes };
}

export function packImage(files) {
  const header = new TextEncoder().encode(JSON.stringify({ files: files.map((f) => [f.path, f.data.byteLength]) }));
  const out = new Uint8Array(4 + header.byteLength + files.reduce((n, f) => n + f.data.byteLength, 0));
  new DataView(out.buffer).setUint32(0, header.byteLength, true);
  out.set(header, 4);
  let offset = 4 + header.byteLength;
  for (const f of files) { out.set(f.data, offset); offset += f.data.byteLength; }
  return out;
}

/* Writes every file without copying it (MEMFS keeps a view into the image).
   Returns the paths written. */
export function populate(FS, image) {
  const { files, bytes } = readImage(image);
  const made = new Set();
  for (const f of files) {
    const dir = f.path.slice(0, f.path.lastIndexOf("/"));
    if (dir && !made.has(dir)) { FS.mkdirTree(dir); made.add(dir); }
    FS.writeFile(f.path, bytes.subarray(f.offset, f.offset + f.size), { canOwn: true });
  }
  return files.map((f) => f.path);
}
