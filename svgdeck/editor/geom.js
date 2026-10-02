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
  // SVG getBBox() ignores clipping. Selection and transforms use the visible
  // crop; media-tools keeps the original image geometry for editing the crop.
  if (el.localName === "image" && el.hasAttribute("data-crop")) {
    const crop = el.getAttribute("data-crop").trim().split(/[ ,]+/).map(Number);
    if (crop.length === 4 && crop.every(Number.isFinite)) {
      const [left, top, right, bottom] = crop.map(v => Math.max(0, Math.min(99.9, v)) / 100);
      b = {x: b.x + b.width * left, y: b.y + b.height * top,
        width: b.width * Math.max(.001, 1 - left - right),
        height: b.height * Math.max(.001, 1 - top - bottom)};
    }
  }
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

/** Smallest move that aligns an edge/centre or repeats a nearby gap. */
export function smartSnapDelta(box, dx, dy, others, tolerance = 8) {
  const moved = { x: box.x + dx, y: box.y + dy, width: box.width, height: box.height };
  const axis = (name) => {
    const size = name === "x" ? "width" : "height";
    const cross = name === "x" ? "y" : "x", crossSize = name === "x" ? "height" : "width";
    const lo = (b) => b[name], hi = (b) => b[name] + b[size], mid = (b) => b[name] + b[size] / 2;
    const anchors = (b) => [lo(b), mid(b), hi(b)];
    let best = null;
    const offer = (adjust, guide) => {
      if (Math.abs(adjust) <= tolerance && (!best || Math.abs(adjust) < Math.abs(best.adjust))) best = { adjust, guide };
    };
    for (const b of others) for (const a of anchors(moved)) for (const target of anchors(b)) {
      offer(target - a, { kind: "align", axis: name, at: target,
        from: Math.min(moved[cross], b[cross]), to: Math.max(moved[cross] + moved[crossSize], b[cross] + b[crossSize]) });
    }
    const relevant = others.filter((b) => b[cross] < moved[cross] + moved[crossSize] && moved[cross] < b[cross] + b[crossSize])
      .sort((a, b) => lo(a) - lo(b));
    for (let i = 0; i + 1 < relevant.length; i++) {
      const a = relevant[i], b = relevant[i + 1];
      const gap = lo(b) - hi(a);
      if (gap < 0) continue;
      offer(hi(b) + gap - lo(moved), { kind: "gap", axis: name, gap, marks: [hi(a), lo(b), hi(b), hi(b) + gap] });
      offer(lo(a) - gap - hi(moved), { kind: "gap", axis: name, gap, marks: [lo(a) - gap, lo(a), hi(a), lo(b)] });
    }
    for (let i = 0; i + 1 < relevant.length; i++) {
      const a = relevant[i], b = relevant[i + 1];
      if (hi(a) > lo(b)) continue;
      const target = (hi(a) + lo(b) - moved[size]) / 2, gap = target - hi(a);
      if (gap >= 0) offer(target - lo(moved), { kind: "gap", axis: name, gap, marks: [hi(a), target, target + moved[size], lo(b)] });
    }
    return best || { adjust: 0, guide: null };
  };
  const sx = axis("x"), sy = axis("y");
  return { dx: dx + sx.adjust, dy: dy + sy.adjust, guides: [sx.guide, sy.guide].filter(Boolean) };
}

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
      else if (attr.localName === "data-svgdeck-clip") v = prefix + v;
      else if (v.includes("url(")) v = v.replace(URL_REF, (_, q, id) => `url(#${prefix}${id})`);
      if (v !== attr.value) el.setAttributeNS(attr.namespaceURI, attr.name, v);
    }
  }
}

// --- path nodes ------------------------------------------------------------
// A path as subpaths of nodes: {x, y, in, out} with `in`/`out` the Bézier
// handles (equal to the node when retracted), plus `closed`. Every SVG path
// command is read (lines and arcs become cubic segments), so any path can be
// edited node by node.
const pt = (x, y) => ({ x, y });
const lerp = (a, b, t) => pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
const same = (a, b, eps = 1e-6) => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
export const nodeAt = (p) => ({ x: p.x, y: p.y, in: pt(p.x, p.y), out: pt(p.x, p.y) });

/** Cubic segments approximating an SVG arc (endpoint form), as [c1, c2, end]. */
function arcToCubics(p0, rx, ry, phiDeg, large, sweep, p1) {
  if (same(p0, p1)) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry) return [[p0, p1, p1]];
  const phi = phiDeg * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let k = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) k = -k;
  const cx1 = k * rx * y1 / ry, cy1 = -k * ry * x1 / rx;
  const cx = cos * cx1 - sin * cy1 + (p0.x + p1.x) / 2, cy = sin * cx1 + cos * cy1 + (p0.y + p1.y) / 2;
  const angle = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / n, alpha = 4 / 3 * Math.tan(step / 4);
  const at = (t) => pt(cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos);
  const deriv = (t) => pt(-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = t1 + i * step, b = a + step, pa = at(a), pb = i === n - 1 ? p1 : at(b), da = deriv(a), db = deriv(b);
    out.push([pt(pa.x + alpha * da.x, pa.y + alpha * da.y), pt(pb.x - alpha * db.x, pb.y - alpha * db.y), pb]);
  }
  return out;
}

/** Parse path data into subpaths of nodes; null if it cannot be read. */
export function parsePath(d) {
  const tokens = (d || "").match(/[a-df-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi);
  if (!tokens || !/^[mM]$/.test(tokens[0])) return null;
  const subs = [];
  let i = 0, cmd = null, cur = pt(0, 0), start = pt(0, 0), sub = null, lastCtrl = null, lastQuad = null;
  const numAt = () => {
    const v = tokens[i];
    if (v === undefined || /^[a-z]$/i.test(v)) throw new Error("path: missing number");
    i++;
    return parseFloat(v);
  };
  const flag = () => {
    // Arc flags may be written without separators ("a5 5 0 105 5").
    const v = tokens[i];
    if (v === undefined) throw new Error("path: missing flag");
    if (v.length > 1 && (v[0] === "0" || v[0] === "1") && !/^[01]\./.test(v)) { tokens[i] = v.slice(1); return +v[0]; }
    i++;
    return parseFloat(v) ? 1 : 0;
  };
  const cubic = (c1, c2, end) => {
    sub.nodes[sub.nodes.length - 1].out = c1;
    sub.nodes.push({ x: end.x, y: end.y, in: c2, out: pt(end.x, end.y) });
    cur = end;
  };
  try {
    while (i < tokens.length) {
      if (/^[a-z]$/i.test(tokens[i])) cmd = tokens[i++];
      else if (!cmd) return null;
      const rel = cmd === cmd.toLowerCase();
      const P = (x, y) => (rel ? pt(cur.x + x, cur.y + y) : pt(x, y));
      const C = cmd.toUpperCase();
      if (C !== "M" && !sub) return null;
      let ctrl = null, quad = null;
      switch (C) {
        case "M": {
          const p = P(numAt(), numAt());
          sub = { nodes: [nodeAt(p)], closed: false };
          subs.push(sub);
          cur = start = p;
          cmd = rel ? "l" : "L";  // further pairs are lines
          break;
        }
        case "Z":
          if (sub.nodes.length > 1 && same(cur, start, 1e-3)) {
            // The last node sits on the first: merge them.
            const last = sub.nodes.pop();
            sub.nodes[0].in = last.in;
          }
          sub.closed = true;
          cur = start;
          sub = { nodes: [nodeAt(cur)], closed: false, implicit: true };
          subs.push(sub);
          break;
        case "L": { const p = P(numAt(), numAt()); cubic(pt(cur.x, cur.y), pt(p.x, p.y), p); break; }
        case "H": { const x = numAt(), p = pt(rel ? cur.x + x : x, cur.y); cubic(pt(cur.x, cur.y), pt(p.x, p.y), p); break; }
        case "V": { const y = numAt(), p = pt(cur.x, rel ? cur.y + y : y); cubic(pt(cur.x, cur.y), pt(p.x, p.y), p); break; }
        case "C": {
          const c1 = P(numAt(), numAt()), c2 = P(numAt(), numAt()), p = P(numAt(), numAt());
          cubic(c1, c2, p); ctrl = c2; break;
        }
        case "S": {
          const c1 = lastCtrl ? pt(2 * cur.x - lastCtrl.x, 2 * cur.y - lastCtrl.y) : pt(cur.x, cur.y);
          const c2 = P(numAt(), numAt()), p = P(numAt(), numAt());
          cubic(c1, c2, p); ctrl = c2; break;
        }
        case "Q": case "T": {
          const q = C === "Q" ? P(numAt(), numAt()) : lastQuad ? pt(2 * cur.x - lastQuad.x, 2 * cur.y - lastQuad.y) : pt(cur.x, cur.y);
          const p = P(numAt(), numAt());
          cubic(lerp(cur, q, 2 / 3), lerp(p, q, 2 / 3), p); quad = q; break;
        }
        case "A": {
          const rx = numAt(), ry = numAt(), rot = numAt(), large = flag(), sweep = flag(), p = P(numAt(), numAt());
          for (const [c1, c2, end] of arcToCubics(cur, rx, ry, rot, large, sweep, p)) cubic(c1, c2, end);
          cur = p;
          break;
        }
        default: return null;
      }
      lastCtrl = ctrl; lastQuad = quad;
    }
  } catch (e) { return null; }
  const out = subs.filter((s) => !(s.implicit && s.nodes.length === 1));
  for (const s of out) delete s.implicit;
  return out.length ? out : null;
}

const fmt = (v) => String(+v.toFixed(3));
const P2 = (p) => `${fmt(p.x)},${fmt(p.y)}`;

/** Path data for subpaths of nodes; straight segments are written as lines. */
export function pathFromNodes(subs) {
  let d = "";
  for (const { nodes, closed } of subs) {
    if (!nodes.length) continue;
    d += `${d ? " " : ""}M${P2(nodes[0])}`;
    const n = nodes.length, count = closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const a = nodes[i], b = nodes[(i + 1) % n];
      if (same(a.out, a) && same(b.in, b)) d += ` L${P2(b)}`;
      else d += ` C${P2(a.out)} ${P2(b.in)} ${P2(b)}`;
    }
    if (closed) d += " Z";
  }
  return d;
}

/** Node type from its handles: "c" cusp, "s" smooth, "z" symmetric. */
export function inferNodeType(n) {
  const ax = n.in.x - n.x, ay = n.in.y - n.y, bx = n.out.x - n.x, by = n.out.y - n.y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-6 || lb < 1e-6) return "c";
  const cross = (ax * by - ay * bx) / (la * lb), dot = (ax * bx + ay * by) / (la * lb);
  if (dot > -0.999 || Math.abs(cross) > 0.03) return "c";
  return Math.abs(la - lb) / Math.max(la, lb) < 0.02 ? "z" : "s";
}

/** Split the segment from node a to node b at t (de Casteljau); returns the
 *  new node and updates a.out and b.in, so the shape is unchanged. */
export function splitSegment(a, b, t) {
  const p01 = lerp(a, a.out, t), p12 = lerp(a.out, b.in, t), p23 = lerp(b.in, b, t);
  const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t), mid = lerp(p012, p123, t);
  const straight = same(a.out, a) && same(b.in, b);
  a.out = straight ? pt(a.x, a.y) : p01;
  b.in = straight ? pt(b.x, b.y) : p23;
  return { x: mid.x, y: mid.y, in: straight ? pt(mid.x, mid.y) : p012, out: straight ? pt(mid.x, mid.y) : p123 };
}

/** The point at t on the segment from node a to node b. */
export function segmentPoint(a, b, t) {
  const u = 1 - t;
  return pt(u * u * u * a.x + 3 * u * u * t * a.out.x + 3 * u * t * t * b.in.x + t * t * t * b.x,
            u * u * u * a.y + 3 * u * u * t * a.out.y + 3 * u * t * t * b.in.y + t * t * t * b.y);
}

/** Nearest point on a segment to p, as {t, dist}, using a transform `map`
 *  from node space to the space p is in. */
export function nearestOnSegment(a, b, p, map = (q) => q) {
  let best = { t: 0, dist: Infinity };
  const N = 48;
  const d = (t) => { const q = map(segmentPoint(a, b, t)); return Math.hypot(q.x - p.x, q.y - p.y); };
  for (let i = 0; i <= N; i++) { const t = i / N, v = d(t); if (v < best.dist) best = { t, dist: v }; }
  let lo = Math.max(0, best.t - 1 / N), hi = Math.min(1, best.t + 1 / N);
  for (let k = 0; k < 30; k++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (d(m1) < d(m2)) hi = m2; else lo = m1;
  }
  const t = (lo + hi) / 2;
  return { t, dist: d(t) };
}

// --- freehand fitting ----------------------------------------------------------
// A freehand stroke becomes a few cubic Béziers (Schneider, "An algorithm for
// automatically fitting digitized curves", Graphics Gems 1990). Sharp turns are
// found first and kept as corners; the pieces between them are fitted with
// tangent-continuous (smooth) joins.

const sub2 = (a, b) => pt(a.x - b.x, a.y - b.y);
const dot2 = (a, b) => a.x * b.x + a.y * b.y;
const unit = (v) => { const l = Math.hypot(v.x, v.y) || 1; return pt(v.x / l, v.y / l); };
const along = (p, v, s) => pt(p.x + v.x * s, p.y + v.y * s);

function bezierAt(b, t) {
  const u = 1 - t;
  return pt(u * u * u * b[0].x + 3 * u * u * t * b[1].x + 3 * u * t * t * b[2].x + t * t * t * b[3].x,
            u * u * u * b[0].y + 3 * u * u * t * b[1].y + 3 * u * t * t * b[2].y + t * t * t * b[3].y);
}

/** Least-squares cubic with fixed end tangents t1 (leaving) and t2 (arriving, reversed). */
function generateBezier(d, u, t1, t2) {
  const first = d[0], last = d.at(-1);
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < d.length; i++) {
    const s = u[i], v = 1 - s, b0 = v * v * v, b1 = 3 * s * v * v, b2 = 3 * s * s * v, b3 = s * s * s;
    const a1 = pt(t1.x * b1, t1.y * b1), a2 = pt(t2.x * b2, t2.y * b2);
    c00 += dot2(a1, a1); c01 += dot2(a1, a2); c11 += dot2(a2, a2);
    const tmp = sub2(d[i], pt(first.x * (b0 + b1) + last.x * (b2 + b3), first.y * (b0 + b1) + last.y * (b2 + b3)));
    x0 += dot2(a1, tmp); x1 += dot2(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alpha1 = det ? (x0 * c11 - x1 * c01) / det : 0, alpha2 = det ? (c00 * x1 - c01 * x0) / det : 0;
  const seg = Math.hypot(last.x - first.x, last.y - first.y), eps = 1e-6 * seg;
  // Degenerate solutions fall back to the Wu/Barsky heuristic.
  if (alpha1 < eps || alpha2 < eps) alpha1 = alpha2 = seg / 3;
  return [first, along(first, t1, alpha1), along(last, t2, alpha2), last];
}

/** One Newton step towards each point's nearest parameter on the curve. */
function reparameterize(b, d, u) {
  const q1 = [0, 1, 2].map((i) => pt(3 * (b[i + 1].x - b[i].x), 3 * (b[i + 1].y - b[i].y)));
  const q2 = [0, 1].map((i) => pt(2 * (q1[i + 1].x - q1[i].x), 2 * (q1[i + 1].y - q1[i].y)));
  return u.map((t, i) => {
    const v = 1 - t;
    const p = bezierAt(b, t);
    const d1 = pt(v * v * q1[0].x + 2 * v * t * q1[1].x + t * t * q1[2].x, v * v * q1[0].y + 2 * v * t * q1[1].y + t * t * q1[2].y);
    const d2 = pt(v * q2[0].x + t * q2[1].x, v * q2[0].y + t * q2[1].y);
    const diff = sub2(p, d[i]);
    const den = dot2(d1, d1) + dot2(diff, d2);
    const next = den ? t - dot2(diff, d1) / den : t;
    return Math.max(0, Math.min(1, next));
  });
}

function chordParams(d) {
  const u = [0];
  for (let i = 1; i < d.length; i++) u.push(u[i - 1] + Math.hypot(d[i].x - d[i - 1].x, d[i].y - d[i - 1].y));
  const total = u.at(-1) || 1;
  return u.map((v) => v / total);
}

function maxError(d, b, u) {
  let max = 0, split = Math.floor(d.length / 2);
  for (let i = 1; i < d.length - 1; i++) {
    const q = bezierAt(b, u[i]), e = (q.x - d[i].x) ** 2 + (q.y - d[i].y) ** 2;
    if (e > max) { max = e; split = i; }
  }
  return { max, split };
}

/** Béziers ([p0, c1, c2, p3]) through d within `error`, with the given end tangents. */
function fitCubic(d, t1, t2, error, depth = 0) {
  if (d.length === 2) {
    const dist = Math.hypot(d[1].x - d[0].x, d[1].y - d[0].y) / 3;
    return [[d[0], along(d[0], t1, dist), along(d[1], t2, dist), d[1]]];
  }
  let u = chordParams(d), b = generateBezier(d, u, t1, t2), { max, split } = maxError(d, b, u);
  const err2 = error * error;
  if (max < err2 || depth > 12) return [b];
  if (max < err2 * 16) {
    for (let k = 0; k < 8; k++) {
      u = reparameterize(b, d, u);
      b = generateBezier(d, u, t1, t2);
      ({ max, split } = maxError(d, b, u));
      if (max < err2) return [b];
    }
  }
  const centre = unit(sub2(d[split - 1], d[split + 1]));
  return [...fitCubic(d.slice(0, split + 1), t1, centre, error, depth + 1),
          ...fitCubic(d.slice(split), pt(-centre.x, -centre.y), t2, error, depth + 1)];
}

/** The direction the stroke leaves d[i] in, looking `reach` along it (step ±1). */
function strokeTangent(d, i, step, reach) {
  let j = i + step;
  while (j > 0 && j < d.length - 1 && Math.hypot(d[j].x - d[i].x, d[j].y - d[i].y) < reach) j += step;
  return unit(sub2(d[j], d[i]));
}

/** Indices where the stroke turns sharper than `cornerDeg` within `reach`. */
function strokeCorners(d, reach, cornerDeg) {
  const turn = d.map((p, i) => {
    if (i === 0 || i === d.length - 1) return 0;
    const back = strokeTangent(d, i, -1, reach), ahead = strokeTangent(d, i, 1, reach);
    return Math.acos(Math.max(-1, Math.min(1, -dot2(back, ahead)))) * 180 / Math.PI;
  });
  const corners = [0];
  for (let i = 1; i < d.length - 1; i++) {
    if (turn[i] < cornerDeg) continue;
    // The sharpest point of the bend, and not too close to the last corner.
    let j = i;
    while (j + 1 < d.length - 1 && turn[j + 1] >= cornerDeg) j++;
    let best = i;
    for (let k = i; k <= j; k++) if (turn[k] > turn[best]) best = k;
    const prev = d[corners.at(-1)];
    if (Math.hypot(d[best].x - prev.x, d[best].y - prev.y) > reach) corners.push(best);
    i = j;
  }
  const end = d.length - 1;
  if (corners.length > 1 && Math.hypot(d[end].x - d[corners.at(-1)].x, d[end].y - d[corners.at(-1)].y) < reach) corners.pop();
  corners.push(end);
  return corners;
}

/** Nodes ({x, y, in, out, type}) for a freehand stroke of {x, y} points:
 *  `error` is the largest allowed deviation; a turn sharper than `cornerDeg`
 *  within `reach` along the stroke is a corner ("c"), other joins are smooth ("s"). */
export function fitStroke(points, error, { reach = error * 4, cornerDeg = 55 } = {}) {
  const d = [];
  for (const p of points) if (!d.length || Math.hypot(p.x - d.at(-1).x, p.y - d.at(-1).y) > error / 8) d.push(pt(p.x, p.y));
  if (d.length < 2) return d.map((p) => ({ x: p.x, y: p.y, in: pt(p.x, p.y), out: pt(p.x, p.y), type: "c" }));
  const corners = strokeCorners(d, reach, cornerDeg);
  const nodes = [{ x: d[0].x, y: d[0].y, in: pt(d[0].x, d[0].y), out: pt(d[0].x, d[0].y), type: "c" }];
  for (let c = 0; c < corners.length - 1; c++) {
    const piece = d.slice(corners[c], corners[c + 1] + 1);
    const t1 = strokeTangent(piece, 0, 1, reach), t2 = strokeTangent(piece, piece.length - 1, -1, reach);
    const curves = fitCubic(piece, t1, t2, error);
    curves.forEach((b, k) => {
      nodes.at(-1).out = pt(b[1].x, b[1].y);
      nodes.push({ x: b[3].x, y: b[3].y, in: pt(b[2].x, b[2].y), out: pt(b[3].x, b[3].y), type: k < curves.length - 1 ? "s" : "c" });
    });
  }
  return nodes;
}

// --- pressure ink ------------------------------------------------------------
/** Width factor for a Pencil pressure (0..1); 0.5, a normal press, gives 1. */
export const pressureWidth = (p) => 0.3 + 1.4 * Math.max(0, Math.min(1, p));

function catmullSegments(points) {
  let d = "";
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`;
  }
  return d;
}

/** The outline of a stroke whose width follows the pressure: points are
 *  [x, y, pressure]; width is the line width at normal pressure. Round ends.
 *  `smooth` false gives a quick polygon for the live preview. */
export function inkOutline(points, width, smooth = true) {
  const n = points.length;
  const half = points.map((q) => (width * pressureWidth(q[2] ?? 0.5)) / 2);
  if (n === 1 || points.every((q) => Math.hypot(q[0] - points[0][0], q[1] - points[0][1]) < 1e-6)) {
    const [x, y] = points[0], r = f(Math.max(...half));
    return `M${f(x - r)},${f(y)}a${r},${r} 0 1 0 ${f(2 * r)},0a${r},${r} 0 1 0 ${f(-2 * r)},0Z`;
  }
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    const [x, y] = points[i], h = half[i];
    left.push([x - ty * h, y + tx * h]);
    right.push([x + ty * h, y - tx * h]);
  }
  right.reverse();
  const cap = (h, to) => `A${f(h)},${f(h)} 0 0 0 ${f(to[0])},${f(to[1])}`;
  const side = (pts) => (smooth ? catmullSegments(pts) : pts.slice(1).map((q) => `L${f(q[0])},${f(q[1])}`).join(""));
  return `M${f(left[0][0])},${f(left[0][1])}` + side(left) + cap(half[n - 1], right[0]) +
    side(right) + cap(half[0], left[0]) + "Z";
}
