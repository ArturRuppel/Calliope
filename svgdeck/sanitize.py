"""What a slide may not carry: anything that runs script when the slide is in a page.

A slide is SVG markup that the editor and the presenter put into their own
page, so a <script>, an onload= or a javascript: link in it runs with the
page's rights. These rules decide what is unsafe. The same rules, in the same
order, are in svgdeck/editor/sanitize-svg.js, which the editor and the player
apply to every slide before it enters the page; keep the two in step, or the
editor will save slides this side refuses.

Unsafe is:
- the elements script, foreignObject, iframe, embed, object, frame, frameset,
  applet, base, link, meta, handler and listener (any namespace), and any
  element in the XHTML or MathML namespace (a slide has no HTML outside a
  foreignObject, and those are dropped);
- set / animate / animateTransform / animateMotion / animateColor that animate
  an href or an on* attribute;
- every on* attribute, and xml:base;
- an href / xlink:href / src / data-video / action / formaction whose URL has
  a scheme other than http, https, mailto, blob or data:image/ (after removing what
  a browser ignores in a URL: tabs and newlines anywhere, controls and spaces
  at the ends);
- a <style> element or style attribute with @import, or with a url() that
  points anywhere but #fragment or data:image/ (after undoing CSS escapes and
  comments).

Checks run on the parsed tree, never on the bytes, so an encoding or entity
trick cannot hide anything from them.
"""
from __future__ import annotations

import re
from xml.dom import minidom

XHTML_NS = "http://www.w3.org/1999/xhtml"
MATHML_NS = "http://www.w3.org/1998/Math/MathML"
XMLNS_NS = "http://www.w3.org/2000/xmlns/"
XML_NS = "http://www.w3.org/XML/1998/namespace"

DROP_ELEMENTS = {"script", "foreignobject", "iframe", "embed", "object", "frame", "frameset", "applet",
                 "base", "link", "meta", "handler", "listener"}
FOREIGN_NAMESPACES = {XHTML_NS, MATHML_NS}
ANIMATIONS = {"set", "animate", "animatetransform", "animatemotion", "animatecolor"}
URL_ATTRIBUTES = {"href", "src", "data-video", "action", "formaction"}
# blob: is how the browser build hands media to the page; only script of the
# page's own origin can make one, so a slide cannot bring a working one along.
SAFE_SCHEMES = {"http", "https", "mailto", "blob"}

_SCHEME = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.\-]*):")
_CSS_HEX = re.compile(r"\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?")
_CSS_ESCAPE = re.compile(r"\\(.)", re.S)
_CSS_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_CSS_URL = re.compile(r"url\(\s*(['\"]?)\s*([^'\")\s]*)", re.I)


_URL_ENDS = "".join(chr(c) for c in range(0x21))   # C0 controls and space


def _clean_url(value: str) -> str:
    """A URL as a browser reads it: tabs and newlines go, ends are trimmed."""
    return re.sub(r"[\t\n\r]", "", value).strip(_URL_ENDS)


def url_scheme(value: str) -> str | None:
    match = _SCHEME.match(_clean_url(value))
    return match.group(1).lower() if match else None


def unsafe_url(value: str) -> bool:
    """Whether a URL attribute value could run script (or load an HTML page)."""
    scheme = url_scheme(value)
    if scheme is None or scheme in SAFE_SCHEMES:
        return False   # relative, #fragment, empty, or a web or mail link
    return not (scheme == "data" and _clean_url(value)[5:].lstrip().lower().startswith("image/"))


def _css_char(match: re.Match) -> str:
    code = int(match.group(1), 16)
    return chr(code) if 0 < code <= 0x10FFFF and not 0xD800 <= code <= 0xDFFF else "�"


def unsafe_css(text: str) -> bool:
    """Whether CSS imports a sheet or fetches anything but a fragment or data: image."""
    css = _CSS_COMMENT.sub("", text)
    css = _CSS_ESCAPE.sub(r"\1", _CSS_HEX.sub(_css_char, css))
    if "@import" in css.lower():
        return True
    for match in _CSS_URL.finditer(css):
        target = match.group(2).lower()
        if not (target.startswith("#") or target.startswith("data:image/")):
            return True
    return False


def _name(node) -> str:
    return (node.localName or node.nodeName or "").lower()


def _element_problem(el) -> str | None:
    name = _name(el)
    if name in DROP_ELEMENTS or el.namespaceURI in FOREIGN_NAMESPACES:
        return f"<{el.localName or el.nodeName}> element"
    if name in ANIMATIONS:
        target = (el.getAttribute("attributeName") or "").strip().lower().rsplit(":", 1)[-1]
        if target == "href" or target.startswith("on"):
            return f"<{el.localName}> of {target}"
    if name == "style" and unsafe_css(_text(el)):
        return "<style> that loads from elsewhere"
    return None


def _attribute_problem(attr) -> str | None:
    if attr.namespaceURI == XMLNS_NS or attr.name == "xmlns" or attr.name.startswith("xmlns:"):
        return None   # a namespace declaration, not an attribute
    name = _name(attr)
    if name.startswith("on"):
        return f"{attr.name} attribute"
    if attr.namespaceURI == XML_NS and name == "base":
        return "xml:base attribute"
    if name in URL_ATTRIBUTES and unsafe_url(attr.value):
        return f"{attr.name} with a {url_scheme(attr.value)}: URL"
    if name == "style" and unsafe_css(attr.value):
        return "style attribute that loads from elsewhere"
    return None


def _text(el) -> str:
    out = []
    for child in el.childNodes:
        if child.nodeType in (child.TEXT_NODE, child.CDATA_SECTION_NODE):
            out.append(child.data)
        elif child.nodeType == child.ELEMENT_NODE:
            out.append(_text(child))
    return "".join(out)


def _walk(el, fix: bool, problems: list[str]) -> None:
    attrs = el.attributes
    for attr in [attrs.item(i) for i in range(attrs.length)]:
        problem = _attribute_problem(attr)
        if problem:
            problems.append(problem)
            if fix:
                el.removeAttributeNode(attr)
    for child in list(el.childNodes):
        if child.nodeType != child.ELEMENT_NODE:
            continue
        problem = _element_problem(child)
        if problem:
            problems.append(problem)
            if fix:
                el.removeChild(child).unlink()
        else:
            _walk(child, fix, problems)


def _parse(data: bytes):
    # Callers have run store.check_svg first: no DTD, a well-formed <svg>.
    return minidom.parseString(data)


def problems(data: bytes) -> list[str]:
    """What in a slide is unsafe, in document order; [] for a clean slide."""
    doc = _parse(data)
    found: list[str] = []
    try:
        _walk(doc.documentElement, False, found)
    finally:
        doc.unlink()
    return found


def sanitize(data: bytes) -> tuple[bytes, list[str]]:
    """The slide without its unsafe parts, and what was removed. A clean slide
    comes back as the very same bytes."""
    doc = _parse(data)
    try:
        found: list[str] = []
        _walk(doc.documentElement, False, found)
        if not found:
            return data, []
        _walk(doc.documentElement, True, [])
        body = doc.documentElement.toxml()
    finally:
        doc.unlink()
    return ('<?xml version="1.0" encoding="utf-8"?>\n' + body + "\n").encode("utf-8"), found
