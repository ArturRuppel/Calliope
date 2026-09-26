"""Standalone export: a folder that plays offline from index.html."""
from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

from fontTools.ttLib import TTFont

from .deck import Deck, render_page


def to_woff2(source: Path, target: Path) -> None:
    font = TTFont(source)
    font.flavor = "woff2"
    font.save(target)


def export(deck: Deck, out: Path, zip_path: Path | None = None) -> Path:
    """Write the deck to `out`: index.html, media/ (only what the slides use)
    and fonts/ as woff2. Existing contents of `out` are replaced."""
    out = Path(out)
    if out.exists():
        if not (out / "index.html").exists() and any(out.iterdir()):
            raise FileExistsError(f"{out} exists and is not an svgdeck export")
        shutil.rmtree(out)
    out.mkdir(parents=True)

    for rel in sorted(deck.media_files()):
        source = deck.path / rel
        if not source.is_file():
            raise FileNotFoundError(f"slide references missing file {rel}")
        target = out / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    font_files = {}
    fonts_dir = out / "fonts"
    for font in deck.meta.get("fonts", []):
        if font["file"] in font_files:
            continue
        name = Path(font["file"]).with_suffix(".woff2").name
        fonts_dir.mkdir(exist_ok=True)
        to_woff2(deck.path / font["file"], fonts_dir / name)
        font_files[font["file"]] = f"fonts/{name}"

    (out / "index.html").write_text(render_page(deck, font_files))

    if zip_path:
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(out.rglob("*")):
                if f.is_file():
                    # Movies and woff2 are already compressed.
                    kind = zipfile.ZIP_STORED if f.suffix in (".mp4", ".woff2", ".jpg", ".png") else zipfile.ZIP_DEFLATED
                    z.write(f, Path(out.name) / f.relative_to(out), compress_type=kind)
    return out

