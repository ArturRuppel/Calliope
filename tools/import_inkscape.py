"""One-off importer: an Inkscape + reveal.js talk -> an svgdeck deck.

Written for the 2026-05-19 talk, the development test ground; not a general
Inkscape converter. That talk is one Inkscape canvas (slides/slides.svg) in
which each `slideN` is a frame rectangle and a slide is whatever lies inside
its frame (what `inkscape --export-id=slideN` renders). Movies were laid over
the exported PNGs in index.html; they become movie objects, and for slides
with a `slideNb.png` overlay the objects overlapping the movie are put above
it, as the overlay did.

Needs Inkscape (only for `--query-all` bounding boxes) and ffmpeg/ffprobe.

    python tools/import_inkscape.py TALK_DIR DECK_DIR --fonts FONT_LIBRARY
"""
from __future__ import annotations

import argparse
import base64
import copy
import csv
import hashlib
import io
import json
import math
import re
import shutil
import subprocess
from pathlib import Path

from fontTools.ttLib import TTFont
from lxml import etree

SVG = "http://www.w3.org/2000/svg"
XLINK = "http://www.w3.org/1999/xlink"
INKSCAPE = "http://www.inkscape.org/namespaces/inkscape"
SODIPODI = "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
W, H = 1920, 1080
URL_REF = re.compile(r"url\(\s*['\"]?#([^'\")\s]+)['\"]?\s*\)")
PLAIN_GROUP_STYLE = {"display": {"inline"}, "opacity": {"1"}}


def q(tag: str) -> str:
    return f"{{{SVG}}}{tag}"


# --- transforms ----------------------------------------------------------
Matrix = tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1, 0, 0, 1, 0, 0)


def mul(m: Matrix, n: Matrix) -> Matrix:
    return (m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
            m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
            m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5])


def parse_transform(text: str | None) -> Matrix:
    m = IDENTITY
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", text or ""):
        v = [float(x) for x in re.split(r"[\s,]+", args.strip()) if x]
        if name == "matrix":
            t = tuple(v)
        elif name == "translate":
            t = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0)
        elif name == "scale":
            t = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == "rotate":
            r = math.radians(v[0])
            t = (math.cos(r), math.sin(r), -math.sin(r), math.cos(r), 0, 0)
            if len(v) > 2:
                t = mul(mul((1, 0, 0, 1, v[1], v[2]), t), (1, 0, 0, 1, -v[1], -v[2]))
        elif name == "skewX":
            t = (1, 0, math.tan(math.radians(v[0])), 1, 0, 0)
        elif name == "skewY":
            t = (1, math.tan(math.radians(v[0])), 0, 1, 0, 0)
        else:
            raise ValueError(f"unknown transform {name}")
        m = mul(m, t)
    return m


def format_matrix(m: Matrix) -> str | None:
    if all(abs(a - b) < 1e-9 for a, b in zip(m, IDENTITY)):
        return None
    if abs(m[0] - 1) < 1e-9 and abs(m[3] - 1) < 1e-9 and abs(m[1]) < 1e-9 and abs(m[2]) < 1e-9:
        return f"translate({m[4]:.6g},{m[5]:.6g})"
    return "matrix(" + ",".join(f"{x:.8g}" for x in m) + ")"


def set_transform(el, m: Matrix) -> None:
    text = format_matrix(m)
    if text:
        el.set("transform", text)
    elif "transform" in el.attrib:
        del el.attrib["transform"]


# --- styles --------------------------------------------------------------
def parse_style(text: str | None) -> dict[str, str]:
    out = {}
    for part in (text or "").split(";"):
        if ":" in part:
            k, v = part.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def format_style(style: dict[str, str]) -> str:
    return ";".join(f"{k}:{v}" for k, v in style.items())


def prop(el, name: str) -> str | None:
    return parse_style(el.get("style")).get(name) or el.get(name)


def hidden(el) -> bool:
    return prop(el, "display") == "none"


# --- the canvas ------------------------------------------------------------
class Canvas:
    def __init__(self, svg_path: Path, query_csv: Path):
        self.tree = etree.parse(str(svg_path), etree.XMLParser(huge_tree=True, remove_blank_text=False))
        self.root = self.tree.getroot()
        self.by_id = {el.get("id"): el for el in self.root.iter() if isinstance(el.tag, str) and el.get("id")}
        self.bbox: dict[str, tuple[float, float, float, float]] = {}
        with open(query_csv) as f:
            for row in csv.reader(f):
                if len(row) < 5:
                    continue
                self.bbox[row[0]] = tuple(float(x) for x in row[1:5])
        vb = [float(x) for x in self.root.get("viewBox").split()]
        self.scale = float(self.root.get("width").removesuffix("px")) / vb[2]

    def slides(self) -> list[tuple[int, str]]:
        found = [(int(m.group(1)), i) for i in self.by_id if (m := re.fullmatch(r"slide(\d+)", i))]
        return sorted(found)

    def overlaps(self, el_id: str | None, frame) -> bool | None:
        """True/False if the element's box overlaps the frame; None if unknown."""
        if el_id not in self.bbox:
            return None
        x, y, w, h = self.bbox[el_id]
        fx, fy, fw, fh = frame
        return min(x + w, fx + fw) - max(x, fx) > 0.5 and min(y + h, fy + fh) - max(y, fy) > 0.5

    def inside(self, el_id: str, frame) -> bool:
        x, y, w, h = self.bbox[el_id]
        fx, fy, fw, fh = frame
        return x >= fx - 0.5 and y >= fy - 0.5 and x + w <= fx + fw + 0.5 and y + h <= fy + fh + 0.5


def is_plain_group(el) -> bool:
    if el.tag != q("g"):
        return False
    for attr in el.attrib:
        local = etree.QName(attr).localname
        if etree.QName(attr).namespace in (INKSCAPE, SODIPODI) or local in ("id", "transform"):
            continue
        if local == "style":
            if all(v in PLAIN_GROUP_STYLE.get(k, ()) for k, v in parse_style(el.get("style")).items()):
                continue
        return False
    return True


def extract(canvas: Canvas, frame, parent, m: Matrix, out: list, sid: str = "") -> None:
    """Copy the children of `parent` that show inside `frame` into `out`,
    composing `m` (canvas -> slide pixels) into their transforms."""
    for el in parent:
        if not isinstance(el.tag, str) or el.tag in (q("defs"), q("metadata"), f"{{{SODIPODI}}}namedview"):
            continue
        if hidden(el):
            continue
        hit = canvas.overlaps(el.get("id"), frame)
        if hit is False:
            continue
        # Groups straddling slides are split; a group holding this slide's
        # frame is unpacked too, so the frame can become the locked background.
        holds_frame = el.tag == q("g") and sid and el.find(f'.//*[@id="{sid}"]') is not None
        if el.tag == q("g") and (hit is None or not canvas.inside(el.get("id"), frame) or holds_frame):
            if is_plain_group(el):
                extract(canvas, frame, el, mul(m, parse_transform(el.get("transform"))), out, sid)
            else:
                wrapper = copy.copy(el)  # attributes only
                for child in list(wrapper):
                    wrapper.remove(child)
                set_transform(wrapper, mul(m, parse_transform(el.get("transform"))))
                inner: list = []
                extract(canvas, frame, el, IDENTITY, inner, sid)
                if inner:
                    wrapper.extend(inner)
                    out.append(wrapper)
            continue
        clone = copy.deepcopy(el)
        clone.tail = None
        set_transform(clone, mul(m, parse_transform(el.get("transform"))))
        out.append(clone)


# --- references and defs -------------------------------------------------
def references(el) -> set[str]:
    refs = set()
    for node in el.iter():
        if not isinstance(node.tag, str):
            continue
        for name, value in node.attrib.items():
            if etree.QName(name).localname == "href" and value.startswith("#"):
                refs.add(value[1:])
            elif "url(" in value:
                refs.update(URL_REF.findall(value))
    return refs


def collect_defs(canvas: Canvas, content: list) -> list:
    present = {n.get("id") for el in content for n in el.iter() if isinstance(n.tag, str) and n.get("id")}
    wanted, defs, seen = set(), [], set()
    for el in content:
        wanted |= references(el)
    while wanted - seen:
        ref = (wanted - seen).pop()
        seen.add(ref)
        if ref in present:
            continue
        source = canvas.by_id.get(ref)
        if source is None:
            print(f"  warning: missing reference #{ref}")
            continue
        clone = copy.deepcopy(source)
        clone.tail = None
        defs.append(clone)
        wanted |= references(clone)
    return defs


# --- cleanup -------------------------------------------------------------
class Fonts:
    """Maps Inkscape font names ('Helvetica Neue Light') to CSS family/weight/style
    using the font library."""

    def __init__(self, library: Path):
        self.faces: dict[tuple[str, int, str], Path] = {}
        self.full: dict[str, tuple[str, int, str]] = {}
        self.families: set[str] = set()
        for path in sorted(library.rglob("*")):
            if path.suffix.lower() not in (".otf", ".ttf"):
                continue
            font = TTFont(path, lazy=True)
            name = font["name"]
            family = (name.getDebugName(16) or name.getDebugName(1)).strip()
            weight = font["OS/2"].usWeightClass
            style = "italic" if font["OS/2"].fsSelection & 1 else "normal"
            self.faces[(family, weight, style)] = path
            self.families.add(family)
            for n in (name.getDebugName(4), f"{family} {name.getDebugName(17) or name.getDebugName(2)}"):
                if n:
                    self.full[n.strip().lower()] = (family, weight, style)
        self.used: set[str] = set()
        self.missing: dict[str, int] = {}

    def resolve(self, family: str, weight: int, style: str) -> tuple[str, int, str] | None:
        if family.lower() in self.full and family not in self.families:
            return self.full[family.lower()]
        for f in self.families:
            if f.lower() == family.lower():
                return f, weight, style
        return None


WEIGHTS = {"normal": 400, "bold": 700, "lighter": 300, "bolder": 700}


def fix_fonts(el, fonts: Fonts, inherited=("sans-serif", 400, "normal")) -> None:
    """Replace Inkscape's per-weight family names with family + weight, and
    make weight/style explicit wherever a family is set (the originals relied
    on the per-weight name, not on inheritance)."""
    style = parse_style(el.get("style"))
    family, weight, italic = inherited
    if "font-family" in style or el.get("font-family"):
        family = (style.get("font-family") or el.get("font-family")).split(",")[0].strip().strip("'\"")
    w = style.get("font-weight") or el.get("font-weight")
    if w:
        weight = WEIGHTS.get(w, int(w) if w.isdigit() else weight)
    s = style.get("font-style") or el.get("font-style")
    if s:
        italic = "italic" if s in ("italic", "oblique") else "normal"
    if "font-family" in style or "-inkscape-font-specification" in style:
        resolved = fonts.resolve(family, weight, italic)
        if resolved:
            fam, weight, italic = resolved
            style["font-family"] = f"'{fam}'" if " " in fam else fam
            style["font-weight"] = str(weight)
            style["font-style"] = italic
            fonts.used.add(fam)
        elif el.tag in (q("text"), q("tspan")) and (el.text or "").strip() or el.tag == q("text"):
            fonts.missing[family] = fonts.missing.get(family, 0) + 1
        style.pop("-inkscape-font-specification", None)
        el.set("style", format_style(style))
    for child in el:
        if isinstance(child.tag, str):
            fix_fonts(child, fonts, (family, weight, italic))


def bake_context_stroke(root, defs: list, marker_ids: dict) -> None:
    """Markers drawn with fill:context-stroke get a copy per stroke colour, so
    browsers without SVG2 context paint render them too."""
    by_id = {d.get("id"): d for d in defs}
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue
        style = parse_style(el.get("style"))
        stroke = style.get("stroke") or el.get("stroke")
        fill = style.get("fill") or el.get("fill")
        changed = False
        for key in ("marker-start", "marker-mid", "marker-end", "marker"):
            value = style.get(key) or el.get(key)
            if not value or "url(" not in value:
                continue
            mid = URL_REF.search(value).group(1)
            marker = by_id.get(mid)
            if marker is None or "context-" not in etree.tostring(marker, encoding="unicode"):
                continue
            key_id = (mid, stroke, fill)
            if key_id not in marker_ids:
                new_id = f"{mid}-{len(marker_ids)}"
                clone = copy.deepcopy(marker)
                clone.set("id", new_id)
                for node in clone.iter():
                    if not isinstance(node.tag, str):
                        continue
                    for attr, v in node.attrib.items():
                        if "context-" in v:
                            node.set(attr, v.replace("context-stroke", stroke or "none")
                                            .replace("context-fill", fill or "none"))
                defs.append(clone)
                by_id[new_id] = clone
                marker_ids[key_id] = new_id
            new = f"url(#{marker_ids[key_id]})"
            if key in style:
                style[key] = new
            else:
                el.set(key, new)
            changed = True
        if changed and el.get("style") is not None:
            el.set("style", format_style(style))


def flatten_clip_groups(root) -> None:
    """Browsers ignore <g> inside <clipPath> (Inkscape draws it): move the
    group's children up, composing its transform into theirs."""
    for clip in root.iter(q("clipPath")):
        while (group := next((c for c in clip.iter(q("g")) if c is not clip), None)) is not None:
            parent = group.getparent()
            m = parse_transform(group.get("transform"))
            index = parent.index(group)
            for child in list(group):
                if isinstance(child.tag, str):
                    set_transform(child, mul(m, parse_transform(child.get("transform"))))
                parent.insert(index, child)
                index += 1
            parent.remove(group)


ANCHOR_SHIFT = {"start": 0.0, "middle": 0.5, "end": 1.0}


def anchor_of(el, inherited: str) -> str:
    return parse_style(el.get("style")).get("text-anchor") or el.get("text-anchor") or inherited


def fix_inline_size(root) -> None:
    """SVG2 wrapped text (inline-size), which browsers don't lay out. Inkscape
    already wrote each line as a positioned tspan; place the lines as Inkscape
    did: the wrapping box is anchored at x by the text's anchor, and the whole
    paragraph is aligned in the box by the anchor of its first character."""
    for text in root.iter(q("text")):
        style = parse_style(text.get("style"))
        if "inline-size" not in style:
            continue
        width = float(re.sub(r"[a-z]+$", "", style.pop("inline-size")))
        text.set("style", format_style(style))
        anchor = anchor_of(text, "start")
        left = float(text.get("x", "0")) - ANCHOR_SHIFT.get(anchor, 0) * width
        first, align = text, anchor
        while not (first.text or "").strip():
            child = next((c for c in first if isinstance(c.tag, str)), None)
            if child is None:
                break
            first = child
            align = anchor_of(first, align)
        for line in text:
            if line.tag != q("tspan") or line.get("x") is None:
                continue
            # Browsers take the anchor from each line's first character, so
            # set it once on the line and drop the per-span values.
            for span in line.iter(q("tspan")):
                span_style = parse_style(span.get("style"))
                if span_style.pop("text-anchor", None) is not None:
                    span.set("style", format_style(span_style))
                span.attrib.pop("text-anchor", None)
            line_style = parse_style(line.get("style"))
            line_style["text-anchor"] = align
            line.set("style", format_style(line_style))
            line.set("x", f"{left + ANCHOR_SHIFT.get(align, 0) * width:.6g}")

def strip_editor_data(root) -> None:
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue
        for attr in list(el.attrib):
            qn = etree.QName(attr)
            if qn.namespace in (INKSCAPE, SODIPODI):
                if qn.localname == "label":
                    el.set("data-label", el.get(attr))
                del el.attrib[attr]
            elif qn.namespace == XLINK and qn.localname == "href":
                el.set("href", el.attrib.pop(attr))
        if "style" in el.attrib:
            style = parse_style(el.get("style"))
            for k in [k for k in style if k.startswith("-inkscape")]:
                del style[k]
            el.set("style", format_style(style))


def extract_images(root, media: Path) -> None:
    for el in root.iter(q("image")):
        href = el.get("href") or el.get(f"{{{XLINK}}}href") or ""
        m = re.match(r"data:image/([\w+.-]+);base64,(.*)", href, re.S)
        if not m:
            continue
        data = base64.b64decode(re.sub(r"\s+", "", m.group(2)))
        ext = {"jpeg": "jpg", "svg+xml": "svg"}.get(m.group(1), m.group(1))
        name = f"img-{hashlib.sha1(data).hexdigest()[:12]}.{ext}"
        if not (media / name).exists():
            (media / name).write_bytes(data)
        el.attrib.pop(f"{{{XLINK}}}href", None)
        el.set("href", f"../media/{name}")


# --- movies from index.html ------------------------------------------------
def movies(index_html: Path) -> dict[int, dict]:
    text = index_html.read_text()
    found = {}
    for sec in re.findall(r"<section\b.*?</section>", text, re.S):
        n = re.search(r'data-background-image="slides/slide(\d+)\.png"', sec)
        video = re.search(r"<video\b(.*?)>(.*?)</video>", sec, re.S)
        if not n or not video:
            continue
        attrs, body = video.groups()
        style = parse_style(re.search(r'style="([^"]*)"', attrs).group(1))
        found[int(n.group(1))] = {
            "src": re.search(r'data-src="([^"]+)"', body).group(1),
            "css": style,
            "loop": " loop" in attrs,
            "autoplay": "data-autoplay" in attrs,
            "sync": (re.search(r'data-sync-group="([^"]+)"', attrs) or [None, None])[1],
            "overlay": re.search(r"slides/slide\d+b\.png", sec) is not None,
        }
    return found


def video_box(css: dict, width: int, height: int) -> tuple[float, float, float, float]:
    """Where the old CSS put the video on the 1920x1080 slide."""
    pct = lambda v, full: float(v.rstrip("%")) / 100 * full if v.endswith("%") else float(v.removesuffix("px"))
    w = pct(css["width"], W)
    h = w * height / width
    x = pct(css["left"], W) if "left" in css else 0
    if "translateX(-50%)" in css.get("transform", ""):
        x -= w / 2
    y = pct(css["top"], H) if "top" in css else H - pct(css["bottom"], H) - h
    return x, y, w, h


def probe(path: Path) -> tuple[int, int]:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height", "-of", "csv=p=0", str(path)],
                         check=True, capture_output=True, text=True).stdout
    w, h = out.strip().split(",")[:2]
    return int(w), int(h)


def poster(video: Path, target: Path) -> None:
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(video), "-frames:v", "1",
                    "-q:v", "3", str(target)], check=True)


# --- main ----------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("talk", type=Path, help="talk directory with index.html and slides/slides.svg")
    ap.add_argument("deck", type=Path, help="deck directory to create")
    ap.add_argument("--fonts", type=Path, required=True, help="font library directory")
    ap.add_argument("--title")
    args = ap.parse_args()

    src = args.talk / "slides" / "slides.svg"
    if args.deck.exists():
        shutil.rmtree(args.deck)
    for sub in ("slides", "media", "fonts"):
        (args.deck / sub).mkdir(parents=True)

    query = args.deck.parent / f".{args.deck.name}.query.csv"
    print("querying bounding boxes with inkscape ...")
    with open(query, "w") as f:
        subprocess.run(["inkscape", "--query-all", str(src)], stdout=f, stderr=subprocess.DEVNULL, check=True)
    canvas = Canvas(src, query)
    query.unlink()
    fonts = Fonts(args.fonts)
    videos = movies(args.talk / "index.html")
    layer_roots = [el for el in canvas.root if isinstance(el.tag, str) and el.tag == q("g")]
    order = []

    for n, sid in canvas.slides():
        frame = canvas.bbox[sid]
        m = mul((1, 0, 0, 1, -frame[0], -frame[1]), (canvas.scale, 0, 0, canvas.scale, 0, 0))
        m = mul(m, parse_transform(canvas.root.get("transform")))
        content: list = []
        for layer in layer_roots:
            if hidden(layer):
                continue
            extract(canvas, frame, [layer], m, content, sid)

        svg = etree.Element(q("svg"), nsmap={None: SVG})
        svg.set("viewBox", f"0 0 {W} {H}")
        svg.set("width", str(W))
        svg.set("height", str(H))
        svg.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        defs_list = collect_defs(canvas, content)
        defs = etree.SubElement(svg, q("defs"))
        defs.extend(defs_list)
        svg.extend(content)
        for el in svg.iter():
            if el.get("id") == sid:  # the frame rectangle is the slide background
                el.set("data-locked", "true")
                el.set("{%s}label" % INKSCAPE, "background")

        if n in videos:
            v = videos[n]
            file = args.talk / v["src"]
            shutil.copy2(file, args.deck / "media" / file.name)
            poster_name = file.with_suffix(".poster.jpg").name
            poster(file, args.deck / "media" / poster_name)
            x, y, w, h = video_box(v["css"], *probe(file))
            image = etree.Element(q("image"))
            for k, val in (("href", f"../media/{poster_name}"), ("data-video", f"../media/{file.name}"),
                           ("x", f"{x:.2f}"), ("y", f"{y:.2f}"), ("width", f"{w:.2f}"), ("height", f"{h:.2f}"),
                           ("data-autoplay", str(v["autoplay"]).lower()), ("data-loop", str(v["loop"]).lower())):
                image.set(k, val)
            if v["sync"]:
                image.set("data-sync", v["sync"])
            image.set("data-label", "movie")
            above = []
            if v["overlay"]:
                box = (x + frame[0], y + frame[1], w, h)
                above = [el for el in content if el.get("id") != sid and canvas.overlaps(el.get("id"), box)]
            for el in above:
                svg.remove(el)
            svg.append(image)
            svg.extend(above)
            print(f"  slide {n}: movie {file.name}" + (f", {len(above)} objects above it" if above else ""))

        flatten_clip_groups(svg)
        fix_inline_size(svg)
        fix_fonts(svg, fonts)
        bake_context_stroke(svg, defs_list, {})
        defs.clear()
        defs.extend(defs_list)
        extract_images(svg, args.deck / "media")
        strip_editor_data(svg)
        etree.cleanup_namespaces(svg, top_nsmap={None: SVG})

        slide_id = f"s{n:02d}"
        (args.deck / "slides" / f"{slide_id}.svg").write_bytes(
            etree.tostring(svg, xml_declaration=True, encoding="utf-8"))
        order.append({"id": slide_id})

    font_entries = []
    for (family, weight, style), path in sorted(fonts.faces.items()):
        if family in fonts.used:
            shutil.copy2(path, args.deck / "fonts" / path.name)
            font_entries.append({"family": family, "weight": weight, "style": style,
                                 "file": f"fonts/{path.name}"})
    deck = {"format": 1, "title": args.title or args.talk.name, "size": [W, H],
            "background": "#000000", "slides": order, "fonts": font_entries}
    (args.deck / "deck.json").write_text(json.dumps(deck, indent=2) + "\n")
    print(f"{len(order)} slides, fonts: {sorted(fonts.used)}")
    if fonts.missing:
        print(f"fonts not in the library (browser fallback): {fonts.missing}")


if __name__ == "__main__":
    main()
