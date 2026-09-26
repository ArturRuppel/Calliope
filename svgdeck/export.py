"""Standalone export: a folder that plays offline from index.html."""
from __future__ import annotations

import os
import shutil
import tempfile
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
    out = Path(out).absolute()
    zip_path = Path(zip_path).absolute() if zip_path else None
    _validate_targets(deck, out, zip_path)
    _check_replaceable(out)
    if zip_path and (zip_path.is_symlink() or
                     (zip_path.exists() and not zip_path.is_file())):
        raise FileExistsError(f"{zip_path} exists and is not a file")
    out.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{out.name}.tmp-", dir=out.parent))
    staged_zip: Path | None = None

    try:
        for rel in sorted(deck.media_files()):
            source = deck.path / rel
            if not source.is_file():
                raise FileNotFoundError(f"slide references missing file {rel}")
            target = staging / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

        font_files = {}
        fonts_dir = staging / "fonts"
        for font in deck.meta.get("fonts", []):
            if font["file"] in font_files:
                continue
            name = Path(font["file"]).with_suffix(".woff2").name
            fonts_dir.mkdir(exist_ok=True)
            to_woff2(deck.path / font["file"], fonts_dir / name)
            font_files[font["file"]] = f"fonts/{name}"

        (staging / "index.html").write_text(render_page(deck, font_files))

        if zip_path:
            zip_path.parent.mkdir(parents=True, exist_ok=True)
            handle, name = tempfile.mkstemp(prefix=f".{zip_path.name}.tmp-", dir=zip_path.parent)
            os.close(handle)
            staged_zip = Path(name)
            with zipfile.ZipFile(staged_zip, "w", zipfile.ZIP_DEFLATED) as z:
                for f in sorted(staging.rglob("*")):
                    if f.is_file():
                        # Movies and woff2 are already compressed.
                        kind = zipfile.ZIP_STORED if f.suffix in (".mp4", ".woff2", ".jpg", ".png") else zipfile.ZIP_DEFLATED
                        z.write(f, Path(out.name) / f.relative_to(staging), compress_type=kind)

        _replace_outputs(staging, out, staged_zip, zip_path)
        staged_zip = None
    finally:
        if staging.exists():
            shutil.rmtree(staging)
        if staged_zip and staged_zip.exists():
            staged_zip.unlink()
    return out


def _validate_targets(deck: Deck, out: Path, zip_path: Path | None) -> None:
    deck_path = deck.path.resolve()
    resolved_out = out.resolve()
    if _overlaps(deck_path, resolved_out):
        raise ValueError("export directory must not overlap the source deck")
    if zip_path and (_overlaps(resolved_out, zip_path.resolve()) or
                     _overlaps(deck_path, zip_path.resolve())):
        raise ValueError("zip path must not overlap the export directory or source deck")


def _overlaps(first: Path, second: Path) -> bool:
    return first == second or first in second.parents or second in first.parents


def _check_replaceable(out: Path) -> None:
    if out.is_symlink():
        raise FileExistsError(f"{out} exists and is not an svgdeck export")
    if not out.exists():
        return
    if not out.is_dir():
        raise FileExistsError(f"{out} exists and is not an svgdeck export")
    if not any(out.iterdir()):
        return
    index = out / "index.html"
    marker = b'<meta name="generator" content="svgdeck">'
    if not index.is_file() or marker not in index.read_bytes():
        raise FileExistsError(f"{out} exists and is not an svgdeck export")


def _replace_outputs(staging: Path, out: Path, staged_zip: Path | None,
                     zip_path: Path | None) -> None:
    out_backup = _backup_path(out) if out.exists() else None
    zip_backup = _backup_path(zip_path) if zip_path and zip_path.exists() else None
    out_backed_up = False
    zip_backed_up = False
    out_installed = False
    zip_installed = False
    try:
        if out_backup:
            out.replace(out_backup)
            out_backed_up = True
        if zip_backup and zip_path:
            zip_path.replace(zip_backup)
            zip_backed_up = True
        staging.replace(out)
        out_installed = True
        if staged_zip and zip_path:
            staged_zip.replace(zip_path)
            zip_installed = True
    except BaseException:
        if zip_installed and zip_path:
            zip_path.unlink()
        if zip_backed_up and zip_backup and zip_path:
            zip_backup.replace(zip_path)
        if out_installed:
            shutil.rmtree(out)
        if out_backed_up and out_backup:
            out_backup.replace(out)
        raise
    if out_backed_up and out_backup:
        shutil.rmtree(out_backup)
    if zip_backed_up and zip_backup:
        zip_backup.unlink()


def _backup_path(path: Path) -> Path:
    handle, name = tempfile.mkstemp(prefix=f".{path.name}.old-", dir=path.parent)
    os.close(handle)
    backup = Path(name)
    backup.unlink()
    return backup
