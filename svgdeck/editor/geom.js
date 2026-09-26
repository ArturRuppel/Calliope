// Geometry helpers for the editor: matrices, boxes, freehand smoothing.
export const SVGNS = "http://www.w3.org/2000/svg";

const toDOM = (m) => new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]);

/** The element's own transform attribute as a DOMMatrix (without side effects). */
export function localMatrix(el) {
  const list = el.transform && el.transform.baseVal;
  let m = new DOMMatrix();
  if (!list) return m;
  for (let i = 0; i < list.numberOfItems; i++) m = m.multiply(toDOM(list.getItem(i).matrix));
  return m;
}

export function setTransform(el, m) {
  const r = (v) => +v.toFixed(6);
  if (m.isIdentity || [m.a - 1, m.b, m.c, m.d - 1, m.e, m.f].every((v) => Math.abs(v) < 1e-9)) {
    el.removeAttribute("transform");
  } else if (Math.abs(m.a - 1) < 1e-9 && Math.abs(m.d - 1) < 1e-9 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9) {
    el.setAttribute("transform", `translate(${r(m.e)},${r(m.f)})`);
  } else {
    el.setAttribute("transform", `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map(r).join(",")})`);
  }
}

/** Matrix from an element's user space to the slide (root svg) space. */
export function toRoot(el, svg) {
  const a = svg.getScreenCTM(), b = el.getScreenCTM();
  if (!a || !b) return new DOMMatrix();
  return toDOM(a).inverse().multiply(toDOM(b));
}

/** Axis-aligned box of an element in slide coordinates. */
export function rootBox(el, svg) {
  let b;
  try { b = el.getBBox(); } catch (e) { return null; }
  const m = toRoot(el, svg);
  const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
    .map(([x, y]) => m.transformPoint(new DOMPoint(x, y)));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function unionBox(boxes) {
  boxes = boxes.filter(Boolean);
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.width)), btm = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: r - x, height: btm - y };
}

export const intersects = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// --- freehand -------------------------------------------------------------
function perpendicularDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (!len) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

/** Ramer–Douglas–Peucker simplification. */
export function simplify(points, epsilon) {
  if (points.length < 3) return points;
  let index = 0, max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (d > max) { max = d; index = i; }
  }
  if (max <= epsilon) return [points[0], points[points.length - 1]];
  const left = simplify(points.slice(0, index + 1), epsilon);
  return left.slice(0, -1).concat(simplify(points.slice(index), epsilon));
}

const f = (v) => +v.toFixed(2);

/** Smooth path through points (Catmull–Rom as cubic Béziers). */
export function smoothPath(points) {
  if (points.length === 1) {
    const [x, y] = points[0];
    return `M${f(x)},${f(y)}l0.01,0`;
  }
  let d = `M${f(points[0][0])},${f(points[0][1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`;
  }
  return d;
}

export function polylinePath(points) {
  return points.map((p, i) => `${i ? "L" : "M"}${f(p[0])},${f(p[1])}`).join("");
}

// --- colours --------------------------------------------------------------
export function toHex(color) {
  if (!color || color === "none" || color.startsWith("url(")) return null;
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(color)) return "#" + [...color.slice(1)].map((c) => c + c).join("").toLowerCase();
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(color);
  if (!m) return null;
  if (m[4] !== undefined && +m[4] === 0) return null;
  return "#" + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, "0")).join("");
}

// --- ids across several inline SVGs -----------------------------------------
const URL_REF = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g;

/** Prefix every id (and reference) inside an SVG so copies can share a page. */
export function prefixIds(root, prefix) {
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (el.id) el.id = prefix + el.id;
    for (const attr of Array.from(el.attributes)) {
      let v = attr.value;
      if (attr.localName === "href" && v.startsWith("#")) v = "#" + prefix + v.slice(1);
      else if (v.includes("url(")) v = v.replace(URL_REF, (_, q, id) => `url(#${prefix}${id})`);
      if (v !== attr.value) el.setAttributeNS(attr.namespaceURI, attr.name, v);
    }
  }
}
