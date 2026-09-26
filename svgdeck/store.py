"""The data directory: decks, the font library, media handling.

Layout:  <data>/decks/<name>/   one deck each (docs/format.md)
         <data>/fonts/          font library (OTF/TTF, any subfolders)
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from xml.etree import ElementTree

from fontTools.ttLib import TTFont

from .deck import FORMAT, Deck

NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
SLIDE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
VIDEO_TYPES = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
FONT_TYPES = {".otf", ".ttf"}

BLANK_SLIDE = """<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" xml:space="preserve">
<defs/>
<rect id="background" data-label="background" data-locked="true" width="{w}" height="{h}" fill="#ffffff"/>
</svg>
"""


class Conflict(Exception):
    """The file changed since the client read it."""


def version(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()[:16]


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def check_svg(data: bytes) -> None:
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise ValueError("DTDs are not allowed in slides")
    root = ElementTree.fromstring(data)
    if root.tag != "{http://www.w3.org/2000/svg}svg":
        raise ValueError("not an SVG document")


def safe_filename(name: str) -> str:
    stem, ext = os.path.splitext(os.path.basename(name))
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "-", stem).strip("-.") or "file"
    return f"{stem[:60]}{ext.lower()}"


class Store:
    def __init__(self, data: Path):
        self.data = Path(data)
        self.decks = self.data / "decks"
        self.fonts = self.data / "fonts"

    # --- decks -----------------------------------------------------------
    def deck_dir(self, name: str) -> Path:
        path = self.decks / name
        if not NAME.match(name) or not (path / "deck.json").is_file():
            raise KeyError(name)
        return path

    def list_decks(self) -> list[dict]:
        out = []
        for meta in sorted(self.decks.glob("*/deck.json")) if self.decks.is_dir() else []:
            deck = Deck.load(meta.parent)
            out.append({"name": meta.parent.name, "title": deck.title, "slides": len(deck.meta["slides"]),
                        "modified": max(p.stat().st_mtime for p in meta.parent.rglob("*.svg")) if deck.meta["slides"] else meta.stat().st_mtime})
        return sorted(out, key=lambda d: -d["modified"])

    def create_deck(self, name: str, title: str, size=(1920, 1080)) -> dict:
        if not NAME.match(name):
            raise ValueError("deck names use letters, digits, - _ and .")
        path = self.decks / name
        if path.exists():
            raise FileExistsError(name)
        for sub in ("slides", "media", "fonts"):
            (path / sub).mkdir(parents=True)
        slide = "s" + os.urandom(4).hex()
        write_atomic(path / "slides" / f"{slide}.svg", BLANK_SLIDE.format(w=size[0], h=size[1]).encode())
        meta = {"format": FORMAT, "title": title or name, "size": list(size), "background": "#000000",
                "slides": [{"id": slide}], "fonts": []}
        write_atomic(path / "deck.json", (json.dumps(meta, indent=2) + "\n").encode())
        return self.get_deck(name)

    def get_deck(self, name: str) -> dict:
        data = (self.deck_dir(name) / "deck.json").read_bytes()
        return {"name": name, "deck": json.loads(data), "version": version(data)}

    def put_deck(self, name: str, meta: dict, base: str | None) -> dict:
        path = self.deck_dir(name)
        current = (path / "deck.json").read_bytes()
        if base != version(current):
            raise Conflict("deck.json")
        if meta.get("format") != FORMAT:
            raise ValueError("unsupported format")
        ids = [s.get("id") for s in meta.get("slides", [])]
        if not ids or len(set(ids)) != len(ids) or not all(isinstance(i, str) and SLIDE_ID.match(i) for i in ids):
            raise ValueError("slides must be a non-empty list of unique ids")
        for sid in ids:
            if not (path / "slides" / f"{sid}.svg").is_file():
                raise ValueError(f"slide {sid} has no file")
        # Slides dropped from the order are moved to trash/, not deleted.
        old = {s["id"] for s in json.loads(current).get("slides", [])}
        for sid in old - set(ids):
            src = path / "slides" / f"{sid}.svg"
            if src.exists():
                (path / "trash").mkdir(exist_ok=True)
                shutil.move(src, path / "trash" / f"{sid}.{int(time.time())}.svg")
        data = (json.dumps(meta, indent=2, ensure_ascii=False) + "\n").encode()
        write_atomic(path / "deck.json", data)
        return {"version": version(data)}

    # --- slides ------------------------------------------------------------
    def slide_path(self, name: str, slide: str) -> Path:
        if not SLIDE_ID.match(slide):
            raise KeyError(slide)
        return self.deck_dir(name) / "slides" / f"{slide}.svg"

    def get_slide(self, name: str, slide: str) -> tuple[bytes, str]:
        path = self.slide_path(name, slide)
        if not path.is_file():
            raise KeyError(slide)
        data = path.read_bytes()
        return data, version(data)

    def put_slide(self, name: str, slide: str, data: bytes, base: str | None) -> str:
        """Write a slide. `base` is the version the client edited; None
        creates a new slide and fails if it exists."""
        path = self.slide_path(name, slide)
        check_svg(data)
        if base is None:
            if path.exists():
                raise Conflict(slide)
        elif not path.exists() or version(path.read_bytes()) != base:
            raise Conflict(slide)
        write_atomic(path, data)
        return version(data)

    # --- media -------------------------------------------------------------
    def add_media(self, name: str, filename: str, upload: Path | bytes) -> dict:
        """Add an uploaded file (a path, or bytes) to the deck's media."""
        media = self.deck_dir(name) / "media"
        media.mkdir(exist_ok=True)
        if isinstance(upload, (bytes, bytearray)):
            fd, tmp = tempfile.mkstemp(dir=media, prefix=".upload-")
            with os.fdopen(fd, "wb") as f:
                f.write(upload)
            try:
                return self.add_media(name, filename, Path(tmp))
            finally:
                Path(tmp).unlink(missing_ok=True)
        filename = safe_filename(filename)
        stem, ext = os.path.splitext(filename)
        digest = file_digest(upload)
        if ext in IMAGE_TYPES:
            if ext == ".svg":
                check_svg(upload.read_bytes())
            target = media / f"{stem}-{digest}{ext}"
            shutil.copyfile(upload, target)
            info = {"kind": "image", "href": f"../media/{target.name}"}
            info.update(zip(("width", "height"), image_size(target)))
            return info
        if ext in VIDEO_TYPES:
            target = media / f"{stem}-{digest}.mp4"
            with tempfile.TemporaryDirectory(dir=media) as tmp:
                source = Path(tmp) / f"upload{ext}"
                shutil.copyfile(upload, source)
                if ext == ".mp4" and probe_codec(source) == "h264":
                    shutil.move(source, target)
                else:
                    # H.264 mp4 plays everywhere (Chrome has no HEVC from iPhone .mov).
                    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(source), "-an",
                                    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
                                    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart",
                                    str(target)], check=True)
            poster = target.with_suffix(".poster.jpg")
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(target), "-frames:v", "1",
                            "-q:v", "3", str(poster)], check=True)
            w, h = probe_size(target)
            return {"kind": "video", "href": f"../media/{poster.name}", "video": f"../media/{target.name}",
                    "width": w, "height": h}
        raise ValueError(f"unsupported file type {ext or '(none)'}")

    # --- fonts ---------------------------------------------------------------
    def font_faces(self) -> list[dict]:
        faces = []
        for path in sorted(self.fonts.rglob("*")) if self.fonts.is_dir() else []:
            if path.suffix.lower() not in FONT_TYPES:
                continue
            try:
                faces.append(dict(face_info(path), path=path.relative_to(self.fonts).as_posix()))
            except Exception:
                continue
        return faces

    def add_font(self, filename: str, data: bytes) -> dict:
        filename = safe_filename(filename)
        if os.path.splitext(filename)[1] not in FONT_TYPES:
            raise ValueError("fonts must be .otf or .ttf")
        target = self.fonts / "uploaded" / filename
        write_atomic(target, data)
        try:
            return dict(face_info(target), path=target.relative_to(self.fonts).as_posix())
        except Exception:
            target.unlink()
            raise ValueError("not a readable font")

    def use_family(self, name: str, family: str) -> dict:
        """Copy every face of `family` from the library into the deck."""
        path = self.deck_dir(name)
        meta = json.loads((path / "deck.json").read_bytes())
        have = {f["file"] for f in meta.get("fonts", [])}
        faces = [f for f in self.font_faces() if f["family"] == family]
        if not faces:
            raise KeyError(family)
        for face in faces:
            rel = f"fonts/{Path(face['path']).name}"
            if rel in have:
                continue
            shutil.copy2(self.fonts / face["path"], path / rel)
            meta.setdefault("fonts", []).append(
                {"family": family, "weight": face["weight"], "style": face["style"], "file": rel})
        data = (json.dumps(meta, indent=2, ensure_ascii=False) + "\n").encode()
        write_atomic(path / "deck.json", data)
        return {"deck": meta, "version": version(data)}


def file_digest(path: Path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()[:8]


def face_info(path: Path) -> dict:
    font = TTFont(path, lazy=True)
    name = font["name"]
    family = (name.getDebugName(16) or name.getDebugName(1)).strip()
    return {"family": family, "weight": font["OS/2"].usWeightClass,
            "style": "italic" if font["OS/2"].fsSelection & 1 else "normal",
            "name": (name.getDebugName(4) or family).strip()}


def probe_size(path: Path) -> tuple[int, int]:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height", "-of", "csv=p=0", str(path)],
                         check=True, capture_output=True, text=True).stdout
    w, h = out.strip().split(",")[:2]
    return int(w), int(h)


def probe_codec(path: Path) -> str:
    return subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                           "stream=codec_name", "-of", "csv=p=0", str(path)],
                          capture_output=True, text=True).stdout.strip()


def image_size(path: Path) -> tuple[int, int]:
    if path.suffix == ".svg":
        root = ElementTree.parse(path).getroot()
        vb = (root.get("viewBox") or "").replace(",", " ").split()
        if len(vb) == 4:
            return round(float(vb[2])), round(float(vb[3]))
        return 400, 300
    return probe_size(path)
