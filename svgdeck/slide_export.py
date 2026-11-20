"""One slide as a standalone SVG file: what another program (a writing app,
a word processor, a browser) needs to show it exactly as the editor does,
with nothing next to it.

- Media become data: URLs. Pictures stay what they are (a raster stays a
  raster, an SVG picture stays vector); a raster much larger than it is shown
  is scaled down to `dpi` at its size on the slide, and a photograph goes in
  as JPEG when that is much smaller (needs Pillow; without it pictures are
  embedded as they are). A movie keeps its poster frame.
- The deck's fonts that the slide names are embedded as @font-face rules with
  woff2 data: URLs, cut down to the characters the slide uses, so the text
  renders with the same font everywhere.
- Layout boxes, camera frames and objects hidden in the Objects panel are
  left out; they never show in a presentation either.
- A figure slide (kind "figure") is measured in points: its root gets
  width="<w>pt" height="<h>pt", so one unit prints as one point.
"""
from __future__ import annotations

import base64
import io
import math
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

from .deck import Deck, css_string, font_problem

SVG = "http://www.w3.org/2000/svg"
XLINK = "http://www.w3.org/1999/xlink"
ElementTree.register_namespace("", SVG)
ElementTree.register_namespace("xlink", XLINK)

IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
               ".webp": "image/webp", ".svg": "image/svg+xml"}
MOVIE_ATTRIBUTES = ("data-video", "data-autoplay", "data-loop", "data-sync", "data-video-start", "data-video-end")
NUMBER = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def _local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def transform_scale(value: str | None) -> float:
    """How much an SVG transform list scales lengths (the square root of its
    determinant); 1 for none or one that cannot be read."""
    scale = 1.0
    for name, args in re.findall(r"(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)", value or ""):
        n = [float(x) for x in NUMBER.findall(args)]
        if name == "matrix" and len(n) == 6:
            scale *= math.sqrt(abs(n[0] * n[3] - n[1] * n[2]))
        elif name == "scale" and n:
            scale *= math.sqrt(abs(n[0] * (n[1] if len(n) > 1 else n[0])))
    return scale


def _length(value: str | None) -> float | None:
    m = NUMBER.match((value or "").strip())
    return float(m.group()) if m else None


def _picture(data: bytes, suffix: str, target_px: float | None) -> tuple[bytes, str]:
    """A raster scaled down to `target_px` wide when it is much wider, as
    JPEG when that is clearly smaller and nothing is transparent, else PNG.
    Returned as it came when nothing is gained or Pillow is missing."""
    mime = IMAGE_TYPES[suffix]
    if suffix in (".svg", ".gif") or not target_px:
        return data, mime
    try:
        from PIL import Image
    except ImportError:
        return data, mime
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception:
        return data, mime
    shrink = image.width > target_px * 1.25
    # A large PNG at its size may still be a photograph, which JPEG keeps in far less.
    if not shrink and not (suffix == ".png" and len(data) > 150_000):
        return data, mime
    alpha = image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)
    image = image.convert("RGBA" if alpha else "RGB")
    if shrink:
        image = image.resize((max(1, round(target_px)), max(1, round(image.height * target_px / image.width))), Image.LANCZOS)
    if alpha and image.getchannel("A").getextrema()[0] == 255:
        image, alpha = image.convert("RGB"), False
    if shrink:
        png = io.BytesIO()
        image.save(png, "PNG", optimize=True)
        best, best_mime = png.getvalue(), "image/png"
    else:
        best, best_mime = data, mime
    if not alpha:
        jpeg = io.BytesIO()
        image.save(jpeg, "JPEG", quality=90, optimize=True)
        if jpeg.tell() < 0.6 * len(best):
            return jpeg.getvalue(), "image/jpeg"
    return best, best_mime


def _font_rules(deck: Deck, source: str, characters: str) -> str:
    """@font-face rules for the deck's fonts whose family the slide names,
    each cut down to `characters` and embedded as woff2."""
    from fontTools import subset
    from fontTools.ttLib import TTFont
    rules = []
    text = "".join(sorted(set(characters + " ")))
    for font in deck.meta.get("fonts", []):
        if font_problem(font) or font["family"] not in source:
            continue
        path = (deck.path / font["file"]).resolve()
        if not path.is_relative_to((deck.path / "fonts").resolve()) or not path.is_file():
            continue
        try:
            face = TTFont(path)
            options = subset.Options()
            options.flavor = "woff2"
            options.layout_features = ["*"]
            options.name_IDs = ["*"]
            options.notdef_outline = True
            subsetter = subset.Subsetter(options)
            subsetter.populate(text=text)
            subsetter.subset(face)
            out = io.BytesIO()
            face.flavor = "woff2"
            face.save(out)
        except Exception:
            continue
        data = base64.b64encode(out.getvalue()).decode("ascii")
        rules.append("@font-face { font-family: %s; src: url(data:font/woff2;base64,%s) format(\"woff2\"); "
                     "font-weight: %s; font-style: %s; }"
                     % (css_string(font["family"]), data, font.get("weight", 400), font.get("style", "normal")))
    return "\n".join(rules)


def standalone_svg(deck: Deck, data: bytes, *, kind: str | None = None, dpi: int = 300) -> bytes:
    """The slide `data` (an SVG of `deck`) as one self-contained SVG file."""
    root = ElementTree.fromstring(data)
    vb = [float(x) for x in NUMBER.findall(root.get("viewBox") or "")]
    if len(vb) != 4:
        w, h = (deck.meta.get("size") or [1920, 1080])
        vb = [0, 0, _length(root.get("width")) or w, _length(root.get("height")) or h]
    unit = "pt" if kind == "figure" else ""
    root.set("viewBox", " ".join(f"{v:g}" for v in vb))
    root.set("width", f"{vb[2]:g}{unit}")
    root.set("height", f"{vb[3]:g}{unit}")
    # Pixels of a picture per unit of the slide at `dpi`: a figure's unit is a point.
    per_unit = dpi / (72 if unit == "pt" else 96)

    parents = {child: parent for parent in root.iter() for child in parent}
    for element in list(root.iter()):
        if element.get("data-layout") == "true" or element.get("data-hidden") == "true":
            parent = parents.get(element)
            if parent is not None:
                parent.remove(element)

    def scale_of(element) -> float:
        scale = 1.0
        while element is not None:
            scale *= transform_scale(element.get("transform"))
            element = parents.get(element)
        return scale

    slides_dir = (deck.path / "slides").resolve()
    deck_root = deck.path.resolve()
    for element in root.iter():
        for name in MOVIE_ATTRIBUTES:
            element.attrib.pop(name, None)
        for attribute in ("href", f"{{{XLINK}}}href"):
            ref = element.get(attribute)
            if not ref:
                continue
            url = urlsplit(ref)
            if url.scheme or url.netloc or not url.path or url.path.startswith("/"):
                continue
            path = (slides_dir / unquote(url.path)).resolve()
            suffix = path.suffix.lower()
            if not path.is_relative_to(deck_root) or not path.is_file() or suffix not in IMAGE_TYPES:
                continue
            target = None
            width = _length(element.get("width"))
            if _local(element.tag) == "image" and width:
                target = width * scale_of(element) * per_unit
            body, mime = _picture(path.read_bytes(), suffix, target)
            element.attrib.pop(attribute, None)
            element.set("href", f"data:{mime};base64,{base64.b64encode(body).decode('ascii')}")

    characters = "".join(t for t in root.itertext())
    rules = _font_rules(deck, data.decode("utf-8", "replace"), characters)
    if rules:
        style = ElementTree.Element(f"{{{SVG}}}style")
        style.text = "\n" + rules + "\n"
        root.insert(0, style)
    return b'<?xml version="1.0" encoding="utf-8"?>\n' + ElementTree.tostring(root, encoding="utf-8",
                                                                              xml_declaration=False) + b"\n"
