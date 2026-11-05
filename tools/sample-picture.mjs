/* The sample deck's picture, drawn here so that nothing in the build comes from
   real data: three circular waves interfering, in the family's teal and purple.
   Returns PNG bytes (an 8-bit RGB PNG written by hand: zlib + CRC32). */
import { deflateSync } from "node:zlib";

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function samplePicture(w = 800, h = 640) {
  const sources = [[0.22, 0.3, 46], [0.78, 0.38, 38], [0.5, 0.86, 54]];
  const teal = [14, 124, 123], purple = [107, 63, 160], light = [243, 243, 244];
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;   // filter: none
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (const [sx, sy, k] of sources) s += Math.cos(Math.hypot(x - sx * w, y - sy * h) / k * Math.PI);
      const t = (s / sources.length + 1) / 2;               // 0..1
      const ridge = Math.pow(Math.abs(Math.sin(t * Math.PI * 3)), 6);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      for (let c = 0; c < 3; c++) {
        const base = teal[c] + (purple[c] - teal[c]) * t;
        raw[o + c] = Math.round(base + (light[c] - base) * ridge * 0.85);
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
