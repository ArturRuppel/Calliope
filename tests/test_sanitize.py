"""Slides cannot carry script: svgdeck.sanitize, check_svg, the store's write
paths, the import, and the shared browser sanitiser (sanitize-svg.js) agreeing
with the Python rules."""
import io
import json
import os
import zipfile
from importlib import resources

import pytest
from starlette.testclient import TestClient

from svgdeck import sanitize
from svgdeck.browser import BrowserStore, import_deck
from svgdeck.server import create_app
from svgdeck.store import Store, check_safe_svg, check_svg, clean_svg

SVG = "http://www.w3.org/2000/svg"
HEAD = f'<svg xmlns="{SVG}" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">'


def slide(body: str) -> bytes:
    return f'<?xml version="1.0" encoding="utf-8"?>\n{HEAD}{body}</svg>\n'.encode()


# Each of these runs script in a page that imports the slide.
PAYLOADS = {
    "script": '<script>window.pwned=1</script>',
    "script-cdata": '<script><![CDATA[window.pwned=1]]></script>',
    "xhtml-script": '<script xmlns="http://www.w3.org/1999/xhtml">window.pwned=1</script>',
    "onload-root-child": '<g onload="window.pwned=1"/>',
    "image-onerror": '<image href="x" onerror="window.pwned=1"/>',
    "mixed-case-handler": '<rect OnClick="window.pwned=1" width="5" height="5"/>',
    "animate-onbegin": '<animate onbegin="window.pwned=1" attributeName="x" dur="1s"/>',
    "foreignobject": '<foreignObject width="10" height="10"><img xmlns="http://www.w3.org/1999/xhtml" src="x" onerror="window.pwned=1"/></foreignObject>',
    "xhtml-iframe": '<iframe xmlns="http://www.w3.org/1999/xhtml" src="javascript:parent.pwned=1"/>',
    "svg-iframe": '<iframe src="x"/>',
    "embed": '<embed src="x"/>',
    "object": '<object data="x"/>',
    "a-javascript": '<a href="javascript:window.pwned=1"><text>x</text></a>',
    "a-xlink-javascript": '<a xlink:href="javascript:window.pwned=1"><text>x</text></a>',
    "a-mixed-case": '<a href="JaVaScRiPt:window.pwned=1"><text>x</text></a>',
    "a-leading-space": '<a href=" &#x0A;&#x09; javascript:window.pwned=1"><text>x</text></a>',
    "a-tab-entity": '<a href="jav&#x09;ascript:window.pwned=1"><text>x</text></a>',
    "a-newline-entity": '<a href="java&#10;script:window.pwned=1"><text>x</text></a>',
    "a-char-refs": '<a href="&#106;avascript:window.pwned=1"><text>x</text></a>',
    "a-vbscript": '<a href="vbscript:msgbox"><text>x</text></a>',
    "a-data-html": '<a href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;"><text>x</text></a>',
    "set-href": '<a href="#"><set attributeName="href" to="javascript:window.pwned=1"/><text>x</text></a>',
    "animate-xlink-href": '<a href="#"><animate attributeName="xlink:href" values="javascript:window.pwned=1" dur="1s"/><text>x</text></a>',
    "animate-transform-href": '<a href="#"><animateTransform attributeName=" HREF " values="javascript:1"/><text>x</text></a>',
    "set-onclick": '<rect><set attributeName="onclick" to="window.pwned=1"/></rect>',
    "xml-base": '<a xml:base="javascript:window.pwned=1//" href="x"><text>x</text></a>',
    "style-import": '<style>@import "https://example.org/x.css";</style>',
    "style-escaped-import": '<style>@\\69mport "https://example.org/x.css";</style>',
    "style-url": '<style>rect { fill: url(https://example.org/x.svg#a) }</style>',
    "style-attr-url": '<rect style="fill: url(\'https://example.org/x.svg#a\')"/>',
    "data-video-javascript": '<image href="p.jpg" data-video="javascript:1"/>',
}

CLEAN = (
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient>'
    '<clipPath id="c"><rect width="5" height="5"/></clipPath></defs>'
    '<!-- a comment -->'
    '<rect id="background" data-label="background" data-locked="true" width="100" height="100" fill="url(#g)"/>'
    '<image href="../media/photo-0123abcd.jpg" x="1" y="2" width="3" height="4" clip-path="url(#c)" '
    'style="opacity: 0.5; filter: url(#f)" data-video="../media/clock-0123abcd.mp4"/>'
    '<image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>'
    '<a href="https://example.org/paper"><text x="1" y="9" font-family="\'Archivo\'">Link &amp; text</text></a>'
    '<a href="mailto:someone@example.org"><text>mail</text></a>'
    '<use href="#g"/><g data-step="1" data-onset="kept"><path d="M0 0L1 1"/></g>'
    '<text x="0" y="0" xml:space="preserve">  spaced  </text>'
    '<animate attributeName="opacity" from="0" to="1" dur="1s"/>'
    '<style>.a { fill: url(#g) } .b { fill: url( "data:image/png;base64,AAAA" ) }</style>'
)


@pytest.mark.parametrize("name", sorted(PAYLOADS))
def test_each_payload_is_found_and_removed(name):
    data = slide(PAYLOADS[name])
    check_svg(data)  # well formed: refused only by the safety rules
    assert sanitize.problems(data), name
    with pytest.raises(ValueError, match="could run script"):
        check_safe_svg(data)
    cleaned, removed = sanitize.sanitize(data)
    assert removed
    assert sanitize.problems(cleaned) == []
    text = cleaned.decode()
    assert "pwned" not in text and "javascript" not in text.lower() and "@import" not in text
    check_svg(cleaned)


def test_a_clean_slide_is_left_byte_identical():
    data = slide(CLEAN)
    assert sanitize.problems(data) == []
    cleaned, removed = sanitize.sanitize(data)
    assert removed == [] and cleaned is data
    check_safe_svg(data)


def test_cleaning_keeps_everything_else():
    data = slide(CLEAN + PAYLOADS["script"] + PAYLOADS["image-onerror"] + PAYLOADS["a-javascript"])
    cleaned = sanitize.sanitize(data)[0].decode()
    for kept in ('id="background"', "../media/photo-0123abcd.jpg", 'href="https://example.org/paper"',
                 "<!-- a comment -->", "Link &amp; text", 'xlink:href="data:image/png', "data-onset",
                 'xmlns:xlink="http://www.w3.org/1999/xlink"', "<text>x</text>", "  spaced  "):
        assert kept in cleaned, kept
    assert "<script" not in cleaned and "onerror" not in cleaned
    assert '<image href="x"' in cleaned      # the element stays, the handler goes
    assert "<a><text>x</text></a>" in cleaned  # the link stays, the href goes


def test_dtd_is_refused_in_any_encoding():
    doctype = f'<?xml version="1.0" encoding="utf-16"?><!DOCTYPE svg [<!ENTITY x "y">]>{HEAD}<text>&x;</text></svg>'
    with pytest.raises(ValueError):
        check_svg(doctype.encode("utf-16"))   # was missed by the byte test
    with pytest.raises(ValueError, match="DTD"):
        check_svg(doctype.replace("utf-16", "utf-8").encode())
    with pytest.raises(ValueError, match="UTF-8"):
        check_svg(slide("<text>x</text>").decode().encode("utf-16"))
    # Lower-case or spaced variants still reach the parser and are refused there.
    with pytest.raises(ValueError):
        check_svg(f'<!doctype svg>{HEAD}</svg>'.encode())


def test_script_in_a_utf16_slide_cannot_get_through():
    data = slide(PAYLOADS["script"]).decode().replace("utf-8", "utf-16").encode("utf-16")
    with pytest.raises(ValueError):
        check_safe_svg(data)
    with pytest.raises(ValueError):
        clean_svg(data)


def test_unsafe_url_rules():
    for bad in ["javascript:x", " JAVASCRIPT:x", "\x00javascript:x", "java\tscript:x", "java\nscript:x",
                "data:text/html,x", "vbscript:x", "file:///etc/passwd"]:
        assert sanitize.unsafe_url(bad), bad
    for good in ["", "#a", "../media/x.png", "x.png", "https://example.org", "HTTP://x", "mailto:a@b",
                 "data:image/png;base64,AA", "Data: image/svg+xml,x", "blob:https://x/y", "/d/talk/media/x.png"]:
        assert not sanitize.unsafe_url(good), good


# --- the store's write paths --------------------------------------------------
@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path)
    s.create_deck("talk", "Talk")
    return s


def first(store) -> str:
    return store.get_deck("talk")["deck"]["slides"][0]["id"]


def test_put_slide_refuses_script_and_leaves_the_slide(store):
    sid = first(store)
    before, ver = store.get_slide("talk", sid)
    with pytest.raises(ValueError, match="could run script.*onerror"):
        store.put_slide("talk", sid, slide(PAYLOADS["image-onerror"]), ver)
    assert store.get_slide("talk", sid)[0] == before
    store.put_slide("talk", sid, slide(CLEAN), ver)


def test_put_slide_over_http_says_why(tmp_path, store):
    client = TestClient(create_app(tmp_path))
    sid = first(store)
    ver = store.get_slide("talk", sid)[1]
    r = client.put(f"/api/decks/talk/slides/{sid}", content=slide(PAYLOADS["script"]),
                   headers={"If-Match": f'"{ver}"', "Content-Type": "image/svg+xml"})
    assert r.status_code == 400 and "<script> element" in r.json()["detail"]


def test_preserve_conflict_keeps_a_cleaned_copy(store):
    result = store.preserve_conflict("talk", first(store), slide(CLEAN + PAYLOADS["script"]))
    data = (store.deck_dir("talk") / "slides" / f"{result['recovered']}.svg").read_bytes()
    assert b"<script" not in data and b"photo-0123abcd" in data
    assert result["recoveredVersion"] == __import__("svgdeck.store", fromlist=["version"]).version(data)


def test_svg_media_upload_is_cleaned_and_named_by_the_clean_bytes(store):
    info = store.add_media("talk", "figure.svg", slide(PAYLOADS["foreignobject"] + '<rect width="5" height="5"/>'))
    data = (store.deck_dir("talk") / "media" / info["href"].rsplit("/", 1)[1]).read_bytes()
    assert b"foreignObject" not in data and b"<rect" in data
    clean = store.add_media("talk", "plain.svg", slide('<rect width="5" height="5"/>'))
    assert (store.deck_dir("talk") / "media" / clean["href"].rsplit("/", 1)[1]).read_bytes() == slide('<rect width="5" height="5"/>')


def test_svg_media_is_served_sandboxed(tmp_path, store):
    info = store.add_media("talk", "figure.svg", slide('<rect width="5" height="5"/>'))
    client = TestClient(create_app(tmp_path))
    r = client.get("/d/talk/" + info["href"][3:])
    assert r.status_code == 200
    assert r.headers["content-security-policy"] == "sandbox"
    assert r.headers["x-content-type-options"] == "nosniff"
    for url in [f"/api/decks/talk/slides/{first(store)}"]:
        r = client.get(url)
        assert r.headers["content-security-policy"] == "sandbox" and r.headers["x-content-type-options"] == "nosniff"


def deck_zip(slides: dict[str, bytes], meta: dict | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("talk/deck.json", json.dumps(meta or {"format": 1, "title": "T", "size": [100, 100],
                                                         "slides": [{"id": s} for s in slides], "fonts": []}))
        for sid, svg in slides.items():
            z.writestr(f"talk/slides/{sid}.svg", svg)
    return buf.getvalue()


def test_import_cleans_every_slide(tmp_path):
    store = BrowserStore(tmp_path)
    payload = "".join(PAYLOADS.values())
    summary = import_deck(store, deck_zip({"a": slide(CLEAN + payload), "b": slide(CLEAN)}))
    root = store.deck_dir(summary["name"])
    a, b = (root / "slides" / "a.svg").read_bytes(), (root / "slides" / "b.svg").read_bytes()
    assert sanitize.problems(a) == [] and b"pwned" not in a and b"photo-0123abcd" in a
    assert b == slide(CLEAN)   # a clean slide comes in byte for byte


def test_import_of_an_offline_export_is_cleaned(tmp_path):
    store = BrowserStore(tmp_path)
    meta = {"format": 1, "title": "T", "size": [100, 100], "fonts": [],
            "slides": [{"id": "a", "svg": slide(PAYLOADS["script"]).decode()}]}
    page = ('<script type="application/json" id="svgdeck-data">'
            + json.dumps(meta).replace("</", "<\\/") + "</script>")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("talk/index.html", page)
    summary = import_deck(store, buf.getvalue())
    assert b"<script" not in (store.deck_dir(summary["name"]) / "slides" / "a.svg").read_bytes()


# --- the browser side agrees -----------------------------------------------------
playwright = pytest.importorskip("playwright.sync_api")


def test_the_browser_sanitiser_removes_what_python_refuses(tmp_path):
    """sanitize-svg.js, run on every payload in Chromium: what it leaves behind
    passes check_safe_svg, and it leaves clean slides alone."""
    script = resources.files("svgdeck").joinpath("editor/sanitize-svg.js").read_text()
    cases = {name: slide(CLEAN + body).decode() for name, body in PAYLOADS.items()}
    cases["clean"] = slide(CLEAN).decode()
    with playwright.sync_playwright() as p:
        browser = getattr(p, os.environ.get("SVGDECK_BROWSER", "chromium")).launch()
        page = browser.new_page()
        page.set_content("<html><body></body></html>")
        page.add_script_tag(content=script)
        out = page.evaluate("""(cases) => Object.fromEntries(Object.entries(cases).map(([name, text]) => {
            const doc = new DOMParser().parseFromString(text, "image/svg+xml");
            const removed = SvgDeckSanitize.sanitize(doc.documentElement);
            return [name, {removed, text: '<?xml version="1.0" encoding="utf-8"?>\\n' + new XMLSerializer().serializeToString(doc.documentElement)}];
        }))""", cases)
        browser.close()
    assert out["clean"]["removed"] == []
    for name in PAYLOADS:
        assert out[name]["removed"], name
        cleaned = out[name]["text"].encode()
        check_safe_svg(cleaned)
        assert "pwned" not in out[name]["text"], name
        # Both sides name the same problems for the same slide.
        assert sorted(out[name]["removed"]) == sorted(sanitize.problems(cases[name].encode())), name
