"""Reading decks and rendering the player page (see docs/format.md)."""
from __future__ import annotations

import html
import json
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

FORMAT = 1
XLINK_HREF = "{http://www.w3.org/1999/xlink}href"
REFERENCE_ATTRIBUTES = {"href", XLINK_HREF, "data-video"}
LINK_ELEMENTS = {"a", "script"}


@dataclass
class Deck:
    path: Path
    meta: dict

    @classmethod
    def load(cls, path: Path) -> "Deck":
        path = Path(path)
        meta = json.loads((path / "deck.json").read_text(encoding="utf-8"))
        if meta.get("format") != FORMAT:
            raise ValueError(f"{path}: unsupported deck format {meta.get('format')!r}")
        return cls(path, meta)

    @property
    def title(self) -> str:
        return self.meta.get("title") or self.path.name

    def slide_file(self, slide_id: str) -> Path:
        return self.path / "slides" / f"{slide_id}.svg"

    def _read_slide(self, slide_id: str) -> str:
        try:
            return self.slide_file(slide_id).read_text(encoding="utf-8")
        except FileNotFoundError:
            raise FileNotFoundError(f"slide {slide_id!r}: file slides/{slide_id}.svg is missing") from None

    def slide_sources(self, include_notes: bool = True) -> list[dict]:
        sources = []
        for s in self.meta["slides"]:
            source = {"id": s["id"], "svg": self._read_slide(s["id"])}
            if include_notes:
                source["notes"] = str(s.get("notes") or "")
            sources.append(source)
        return sources

    def media_files(self) -> set[str]:
        """Deck-relative paths of every file the slides reference."""
        files = set()
        for slide in self.meta["slides"]:
            root = ElementTree.fromstring(self._read_slide(slide["id"]).encode("utf-8"))
            for element in root.iter():
                # Hyperlinks and scripts are not media the export has to carry.
                if _local_name(element.tag) in LINK_ELEMENTS:
                    continue
                for attribute, ref in element.attrib.items():
                    if attribute not in REFERENCE_ATTRIBUTES:
                        continue
                    url = urlsplit(ref)
                    if not url.path or url.scheme or url.netloc or url.path.startswith("/"):
                        continue
                    path = unquote(url.path)
                    if path.startswith("/"):
                        raise ValueError(f"reference is not relative: {ref}")
                    files.add((Path("slides") / path).as_posix())
        return {_normalize(f) for f in files}


def _local_name(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _normalize(path: str) -> str:
    parts: list[str] = []
    for part in path.split("/"):
        if part == "..":
            if not parts:
                raise ValueError(f"reference leaves the deck: {path}")
            parts.pop()
        elif part not in ("", "."):
            parts.append(part)
    return "/".join(parts)


def _asset(name: str) -> str:
    return resources.files("svgdeck.player").joinpath(name).read_text(encoding="utf-8")


def font_faces(fonts: list[dict], files: dict[str, str] | None = None) -> str:
    """@font-face rules; `files` maps a deck font file to the URL to use."""
    formats = {".otf": "opentype", ".ttf": "truetype", ".woff": "woff", ".woff2": "woff2"}
    rules = []
    for font in fonts:
        url = (files or {}).get(font["file"], font["file"])
        fmt = formats.get(Path(url).suffix.lower(), "opentype")
        rules.append(
            "@font-face { font-family: %s; src: url(%s) format(%s); font-weight: %s; font-style: %s; }"
            % (json.dumps(font["family"]), json.dumps(url), json.dumps(fmt),
               font.get("weight", 400), font.get("style", "normal")))
    return "\n".join(rules)


def render_page(deck: Deck, font_files: dict[str, str] | None = None, *, editor_url: str | None = None,
                include_notes: bool = True) -> str:
    """The self-contained player page: player, styles and all slides inline.

    Media and fonts stay as files next to the page (media/, fonts/). Speaker
    notes are inlined unless `include_notes` is false."""
    data = dict(deck.meta, slides=deck.slide_sources(include_notes))
    # "</" would end the <script> element early.
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    options = json.dumps({"slideBase": "slides/", "editorUrl": editor_url}).replace("</", "<\\/")
    # The served presenter can reach the family fonts for its chrome; an export stays self-contained.
    chrome_fonts = '<link rel="stylesheet" href="/editor/harmonia/harmonia-fonts.css">\n' if editor_url else ""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="generator" content="svgdeck">
<title>{html.escape(deck.title)}</title>
{chrome_fonts}<style>
{font_faces(deck.meta.get("fonts", []), font_files)}
{_asset("player.css")}
</style>
</head>
<body>
<div id="svgdeck"></div>
<script type="application/json" id="svgdeck-data">{payload}</script>
<script>
{_asset("speaker.js")}
{resources.files("svgdeck").joinpath("editor/movie-range.js").read_text()}
{_asset("player.js")}
</script>
<script>
SvgDeck.start(document.getElementById("svgdeck"),
  JSON.parse(document.getElementById("svgdeck-data").textContent), {options});
</script>
</body>
</html>
"""
