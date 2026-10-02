"""The data directory: decks, the font library, media handling.

Layout:  <data>/decks/<name>/   one deck each (docs/format.md)
         <data>/fonts/          font library (OTF/TTF, any subfolders)
         <data>/trash/<name>.<stamp>/   deleted decks, restorable
"""
from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
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
RECOVERY_TOKEN = re.compile(r"^[A-Za-z0-9_.-]{1,180}$")
DECK_TRASH_TOKEN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\.(\d{8}T\d{6}-[0-9a-f]{6})$")
COMMIT_ID = re.compile(r"^[0-9a-f]{20}$")
REVISION_LIMIT = 30

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
    try:
        root = ElementTree.fromstring(data)
    except ElementTree.ParseError as error:
        raise ValueError(str(error)) from error
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
        self.trash = self.data / "trash"
        self._locks_guard = threading.Lock()
        self._locks: dict[str, threading.RLock] = {}

    def _lock(self, name: str) -> threading.RLock:
        with self._locks_guard:
            return self._locks.setdefault(name, threading.RLock())

    # --- decks -----------------------------------------------------------
    def deck_dir(self, name: str) -> Path:
        path = self.decks / name
        if not NAME.match(name) or not (path / "deck.json").is_file():
            raise KeyError(name)
        return path

    def list_decks(self) -> list[dict]:
        out = []
        for meta in sorted(self.decks.glob("*/deck.json")) if self.decks.is_dir() else []:
            name = meta.parent.name
            with self._lock(name):
                deck = Deck.load(meta.parent)
                # Only the slides count: revisions/, trash/ and commits/ hold
                # copies whose mtimes say nothing about the deck's last edit.
                modified = max((p.stat().st_mtime for p in (meta.parent / "slides").glob("*.svg")),
                               default=meta.stat().st_mtime)
                out.append({"name": name, "title": deck.title, "slides": len(deck.meta["slides"]),
                            "modified": modified})
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

    def delete_deck(self, name: str) -> dict:
        """Move a deck, with its history and media, to <data>/trash/."""
        with self._lock(name):
            path = self.deck_dir(name)
            self.trash.mkdir(parents=True, exist_ok=True)
            token = f"{name}.{time.strftime('%Y%m%dT%H%M%S')}-{os.urandom(3).hex()}"
            title = Deck.load(path).title
            os.rename(path, self.trash / token)
            return {"token": token, "name": name, "title": title}

    def list_deleted_decks(self) -> list[dict]:
        out = []
        for path in self.trash.iterdir() if self.trash.is_dir() else []:
            match = DECK_TRASH_TOKEN.fullmatch(path.name)
            if not match or not (path / "deck.json").is_file():
                continue
            try:
                title = Deck.load(path).title
            except (OSError, ValueError, KeyError):
                title = match[1]
            deleted = time.mktime(time.strptime(match[2][:15], "%Y%m%dT%H%M%S"))
            out.append({"token": path.name, "name": match[1], "title": title, "deleted": deleted})
        return sorted(out, key=lambda d: -d["deleted"])

    def restore_deck(self, token: str) -> dict:
        match = DECK_TRASH_TOKEN.fullmatch(token)
        source = self.trash / token
        if not match or not (source / "deck.json").is_file():
            raise KeyError(token)
        name = match[1]
        with self._lock(name):
            if (self.decks / name).exists():
                raise FileExistsError(name)
            self.decks.mkdir(parents=True, exist_ok=True)
            os.rename(source, self.decks / name)
        return self.get_deck(name)

    def get_deck(self, name: str) -> dict:
        with self._lock(name):
            data = (self.deck_dir(name) / "deck.json").read_bytes()
            return {"name": name, "deck": json.loads(data), "version": version(data)}

    def put_deck(self, name: str, meta: dict, base: str | None) -> dict:
        with self._lock(name):
            return self._put_deck(name, meta, base)

    def _put_deck(self, name: str, meta: dict, base: str | None) -> dict:
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
        self._ensure_baseline(name)
        old_records = {s["id"]: s for s in json.loads(current).get("slides", [])}
        old = set(old_records)
        data = (json.dumps(meta, indent=2, ensure_ascii=False) + "\n").encode()
        write_atomic(path / "deck.json", data)
        # Commit metadata before best-effort cleanup.  A failed metadata write
        # must leave every slide referenced by the old deck.json in place.
        for sid in old - set(ids):
            src = path / "slides" / f"{sid}.svg"
            if src.exists():
                try:
                    (path / "trash").mkdir(exist_ok=True)
                    token = f"{sid}.{time.time_ns()}"
                    write_atomic(path / "trash" / f"{token}.json",
                                 (json.dumps(old_records[sid], ensure_ascii=False) + "\n").encode())
                    shutil.move(src, path / "trash" / f"{token}.svg")
                except OSError:
                    # The committed deck no longer references this file, so it
                    # is safe to retain for recovery or later manual cleanup.
                    pass
        return {"version": version(data)}

    # --- slides ------------------------------------------------------------
    def slide_path(self, name: str, slide: str) -> Path:
        if not SLIDE_ID.match(slide):
            raise KeyError(slide)
        return self.deck_dir(name) / "slides" / f"{slide}.svg"

    def get_slide(self, name: str, slide: str) -> tuple[bytes, str]:
        with self._lock(name):
            path = self.slide_path(name, slide)
            if not path.is_file():
                raise KeyError(slide)
            data = path.read_bytes()
            return data, version(data)

    def put_slide(self, name: str, slide: str, data: bytes, base: str | None) -> str:
        """Write a slide. `base` is the version the client edited; None
        creates a new slide and fails if it exists."""
        with self._lock(name):
            path = self.slide_path(name, slide)
            check_svg(data)
            if base is None:
                if path.exists():
                    raise Conflict(slide)
            elif not path.exists() or version(path.read_bytes()) != base:
                raise Conflict(slide)
            self._ensure_baseline(name)
            if path.exists():
                self._checkpoint(name, slide, path.read_bytes())
            write_atomic(path, data)
            return version(data)

    # --- explicit deck commits ----------------------------------------------
    def _commit_root(self, name: str) -> Path:
        return self.deck_dir(name) / "commits"

    def _manifest_path(self, name: str, commit: str) -> Path:
        if not COMMIT_ID.fullmatch(commit):
            raise KeyError(commit)
        path = self._commit_root(name) / "manifests" / f"{commit}.json"
        if not path.is_file():
            raise KeyError(commit)
        return path

    def _read_manifest(self, name: str, commit: str) -> dict:
        try:
            value = json.loads(self._manifest_path(name, commit).read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise KeyError(commit) from error
        if value.get("id") != commit or not isinstance(value.get("slides"), dict):
            raise KeyError(commit)
        body = {key: value.get(key) for key in ("parent", "message", "createdNs", "deck", "slides")}
        encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        if self._sha256(encoded)[:20] != commit:
            raise ValueError("commit manifest is corrupt")
        return value

    def _head_commit(self, name: str) -> str | None:
        """The newest commit id. `commits/HEAD` caches it so a slide save does
        not parse every manifest; a missing or stale file falls back to a scan."""
        commits = self._commit_root(name)
        try:
            head = (commits / "HEAD").read_text(encoding="utf-8").strip()
        except OSError:
            head = ""
        if COMMIT_ID.fullmatch(head) and (commits / "manifests" / f"{head}.json").is_file():
            return head
        head = self._scan_head_commit(name)
        if head is not None:
            write_atomic(commits / "HEAD", (head + "\n").encode())
        return head

    def _scan_head_commit(self, name: str) -> str | None:
        root = self._commit_root(name) / "manifests"
        candidates = []
        for path in root.glob("*.json") if root.is_dir() else []:
            try:
                item = json.loads(path.read_text(encoding="utf-8"))
                if item.get("id") == path.stem and COMMIT_ID.fullmatch(path.stem):
                    candidates.append((int(item["createdNs"]), path.stem))
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return max(candidates)[1] if candidates else None

    @staticmethod
    def _sha256(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    def _put_object(self, root: Path, data: bytes) -> str:
        digest = self._sha256(data)
        target = root / "objects" / digest
        if target.exists():
            if target.read_bytes() != data:
                raise OSError("commit object hash collision")
        else:
            write_atomic(target, data)
        return digest

    def _current_versions(self, name: str) -> tuple[bytes, dict[str, bytes]]:
        root = self.deck_dir(name)
        deck_data = (root / "deck.json").read_bytes()
        meta = json.loads(deck_data)
        slides = {}
        for item in meta.get("slides", []):
            sid = item.get("id")
            if not isinstance(sid, str) or not SLIDE_ID.fullmatch(sid):
                raise ValueError("invalid slide id in deck.json")
            try:
                slides[sid] = (root / "slides" / f"{sid}.svg").read_bytes()
            except OSError as error:
                raise ValueError(f"slide {sid} has no file") from error
        return deck_data, slides

    def _assert_snapshot_cas(self, name: str, expected_deck: str | None,
                             expected_slides: dict | None) -> None:
        deck_data, slides = self._current_versions(name)
        actual = {sid: version(data) for sid, data in slides.items()}
        if expected_deck != version(deck_data) or expected_slides != actual:
            raise Conflict("deck snapshot changed")

    def _snapshot(self, name: str, message: str, parent: str | None = None) -> dict:
        root = self._commit_root(name)
        deck_data, slides = self._current_versions(name)
        deck_object = self._put_object(root, deck_data)
        slide_objects = {sid: self._put_object(root, data) for sid, data in slides.items()}
        created_ns = time.time_ns()
        body = {"parent": parent, "message": message, "createdNs": created_ns,
                "deck": deck_object, "slides": slide_objects}
        encoded_body = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        commit = self._sha256(encoded_body)[:20]
        manifest = {"id": commit, **body}
        target = root / "manifests" / f"{commit}.json"
        encoded = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode()
        if target.exists() and target.read_bytes() != encoded:
            raise OSError("commit id collision")
        if not target.exists():
            write_atomic(target, encoded)
        write_atomic(root / "HEAD", (commit + "\n").encode())
        return manifest

    def _ensure_baseline(self, name: str) -> None:
        if self._head_commit(name) is None:
            self._snapshot(name, "Baseline before editing", None)

    def list_commits(self, name: str) -> list[dict]:
        root = self._commit_root(name) / "manifests"
        result = []
        for path in root.glob("*.json") if root.is_dir() else []:
            try:
                item = self._read_manifest(name, path.stem)
                result.append({"id": item["id"], "parent": item.get("parent"),
                               "message": item.get("message", ""),
                               "created": int(item["createdNs"]) / 1_000_000_000,
                               "slides": len(item["slides"])})
            except (KeyError, ValueError, TypeError):
                continue
        return sorted(result, key=lambda item: item["created"], reverse=True)

    def create_commit(self, name: str, message: str, expected_deck: str | None,
                      expected_slides: dict | None) -> dict:
        message = message.strip()
        if not message:
            raise ValueError("commit message is required")
        if len(message) > 500:
            raise ValueError("commit message is too long")
        with self._lock(name):
            self._assert_snapshot_cas(name, expected_deck, expected_slides)
            return self._snapshot(name, message, self._head_commit(name))

    def _object(self, name: str, digest: str) -> bytes:
        if not re.fullmatch(r"[0-9a-f]{64}", digest or ""):
            raise KeyError(digest)
        path = self._commit_root(name) / "objects" / digest
        try:
            data = path.read_bytes()
        except OSError as error:
            raise KeyError(digest) from error
        if self._sha256(data) != digest:
            raise ValueError("commit object is corrupt")
        return data

    def diff_commit(self, name: str, commit: str, target: str = "parent") -> str:
        with self._lock(name):
            current = self._read_manifest(name, commit)
            commit_deck = self._object(name, current["deck"])
            commit_slides = {sid: self._object(name, digest) for sid, digest in current["slides"].items()}
            if target == "parent":
                prior = self._read_manifest(name, current["parent"]) if current.get("parent") else None
                old_deck = self._object(name, prior["deck"]) if prior else b""
                old_slides = {sid: self._object(name, digest) for sid, digest in prior["slides"].items()} if prior else {}
                new_deck, new_slides = commit_deck, commit_slides
            elif target == "working":
                old_deck, old_slides = commit_deck, commit_slides
                new_deck, new_slides = self._current_versions(name)
            else:
                raise ValueError("target must be parent or working")
        sections = []
        pairs = [("deck.json", old_deck, new_deck)]
        pairs += [(f"slides/{sid}.svg", old_slides.get(sid, b""), new_slides.get(sid, b""))
                  for sid in sorted(set(old_slides) | set(new_slides))]
        for path, before, after in pairs:
            if before == after:
                continue
            before_name = f"a/{path}" if before else "/dev/null"
            after_name = f"b/{path}" if after else "/dev/null"
            sections.extend(difflib.unified_diff(before.decode("utf-8").splitlines(),
                                                 after.decode("utf-8").splitlines(),
                                                 before_name, after_name, lineterm=""))
        return "\n".join(sections) + ("\n" if sections else "")

    def restore_commit(self, name: str, commit: str, expected_deck: str | None,
                       expected_slides: dict | None) -> dict:
        with self._lock(name):
            self._assert_snapshot_cas(name, expected_deck, expected_slides)
            manifest = self._read_manifest(name, commit)
            deck_data = self._object(name, manifest["deck"])
            meta = json.loads(deck_data)
            if not isinstance(meta, dict) or meta.get("format") != FORMAT:
                raise ValueError("commit contains an unsupported deck format")
            if not all(isinstance(sid, str) and SLIDE_ID.fullmatch(sid) for sid in manifest["slides"]):
                raise ValueError("commit manifest contains an invalid slide id")
            slides = {sid: self._object(name, digest) for sid, digest in manifest["slides"].items()}
            if {s.get("id") for s in meta.get("slides", [])} != set(slides):
                raise ValueError("commit manifest does not match deck metadata")
            for data in slides.values():
                check_svg(data)
            # Restoring replaces the whole working copy. Preserve its exact
            # pre-restore state as an immutable recovery point first.
            safety = self._snapshot(name, f"Working copy before restore attempt {commit}", self._head_commit(name))
            root = self.deck_dir(name)
            transaction = Path(tempfile.mkdtemp(prefix=".restore-", dir=root))
            stage = transaction / "stage"
            backup = transaction / "backup"
            try:
                (stage / "slides").mkdir(parents=True)
                for sid, data in slides.items():
                    write_atomic(stage / "slides" / f"{sid}.svg", data)
                write_atomic(stage / "deck.json", deck_data)
                backup.mkdir()
                write_atomic(backup / "deck.json", (root / "deck.json").read_bytes())
            except BaseException:
                shutil.rmtree(transaction, ignore_errors=True)
                raise
            try:
                os.replace(root / "slides", backup / "slides")
                os.replace(stage / "slides", root / "slides")
                os.replace(stage / "deck.json", root / "deck.json")
            except BaseException as publish_error:
                try:
                    if (backup / "deck.json").exists():
                        os.replace(backup / "deck.json", root / "deck.json")
                    if (backup / "slides").exists():
                        if (root / "slides").exists():
                            os.replace(root / "slides", transaction / "failed-slides")
                        os.replace(backup / "slides", root / "slides")
                except BaseException as rollback_error:
                    # Keep the transaction directory: it contains whichever
                    # complete old/new tree was not publishable.
                    raise RuntimeError(f"restore failed and rollback files remain in {transaction}") from rollback_error
                shutil.rmtree(transaction, ignore_errors=True)
                raise publish_error
            shutil.rmtree(transaction, ignore_errors=True)
            return {"commit": commit, "safetyCommit": safety["id"], "deck": meta, "version": version(deck_data),
                    "slideVersions": {sid: version(data) for sid, data in slides.items()}}

    def _checkpoint(self, name: str, slide: str, data: bytes) -> str:
        token = f"{time.time_ns()}-{version(data)}.svg"
        root = self.deck_dir(name) / "revisions" / slide
        write_atomic(root / token, data)
        entries = sorted(root.glob("*.svg"), key=lambda p: p.stat().st_mtime_ns, reverse=True)
        for old in entries[REVISION_LIMIT:]:
            try:
                old.unlink(missing_ok=True)
            except OSError:
                pass
        return token

    def list_revisions(self, name: str, slide: str) -> list[dict]:
        self.slide_path(name, slide)  # validate both names
        root = self.deck_dir(name) / "revisions" / slide
        result = []
        for path in sorted(root.glob("*.svg"), key=lambda p: p.stat().st_mtime_ns, reverse=True) if root.is_dir() else []:
            try:
                data = path.read_bytes()
                check_svg(data)
            except (OSError, ValueError, ElementTree.ParseError):
                continue
            result.append({"token": path.name, "version": version(data), "modified": path.stat().st_mtime})
        return result

    def get_revision(self, name: str, slide: str, token: str) -> tuple[bytes, str]:
        if not RECOVERY_TOKEN.fullmatch(token):
            raise KeyError(token)
        root = self.deck_dir(name) / "revisions" / slide
        path = root / token
        if not SLIDE_ID.fullmatch(slide) or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            raise KeyError(token)
        data = path.read_bytes()
        check_svg(data)
        return data, version(data)

    def restore_revision(self, name: str, slide: str, token: str, base: str | None) -> str:
        data, _ = self.get_revision(name, slide, token)
        return self.put_slide(name, slide, data, base)

    def list_trash(self, name: str) -> list[dict]:
        root = self.deck_dir(name) / "trash"
        result = []
        for path in sorted(root.glob("*.svg"), key=lambda p: p.stat().st_mtime_ns, reverse=True) if root.is_dir() else []:
            try:
                data = path.read_bytes()
                check_svg(data)
            except (OSError, ValueError, ElementTree.ParseError):
                continue
            original = path.name.split(".", 1)[0]
            metadata = self._trash_metadata(path)
            result.append({"token": path.name, "slide": original, "version": version(data),
                           "deleted": path.stat().st_mtime, "notes": metadata.get("notes", "")})
        return result

    def restore_trash(self, name: str, token: str) -> dict:
        if not RECOVERY_TOKEN.fullmatch(token):
            raise KeyError(token)
        with self._lock(name):
            root = self.deck_dir(name)
            source = root / "trash" / token
            if not source.is_file() or not source.resolve().is_relative_to((root / "trash").resolve()):
                raise KeyError(token)
            data = source.read_bytes()
            check_svg(data)
            metadata = self._trash_metadata(source)
            wanted = token.split(".", 1)[0]
            slide = wanted if SLIDE_ID.fullmatch(wanted) and not (root / "slides" / f"{wanted}.svg").exists() else self._new_slide_id(root, "restored")
            current = (root / "deck.json").read_bytes()
            meta = json.loads(current)
            target = root / "slides" / f"{slide}.svg"
            self._ensure_baseline(name)
            write_atomic(target, data)
            meta["slides"].append({**metadata, "id": slide})
            encoded = (json.dumps(meta, indent=2, ensure_ascii=False) + "\n").encode()
            try:
                write_atomic(root / "deck.json", encoded)
            except BaseException:
                target.unlink(missing_ok=True)
                raise
            try:
                source.unlink(missing_ok=True)
                source.with_suffix(".json").unlink(missing_ok=True)
            except OSError:
                # Metadata already committed. A duplicate trash entry is safer
                # than reporting failure and inviting a second restore.
                pass
            return {"slide": slide, "deck": meta, "version": version(encoded)}

    def preserve_conflict(self, name: str, slide: str, data: bytes) -> dict:
        check_svg(data)
        if not SLIDE_ID.fullmatch(slide):
            raise KeyError(slide)
        with self._lock(name):
            root = self.deck_dir(name)
            try:
                original, original_version = self.get_slide(name, slide)
            except KeyError:
                original = original_version = None
            current = (root / "deck.json").read_bytes()
            meta = json.loads(current)
            recovered = self._new_slide_id(root, f"{slide}-recovered")
            if not any(entry.get("id") == slide for entry in meta.get("slides", [])):
                # A failed trash move can leave an orphan file. It is still a
                # deleted slide and must not become the editor's current slide.
                original = original_version = None
            target = root / "slides" / f"{recovered}.svg"
            self._ensure_baseline(name)
            write_atomic(target, data)
            original_meta = next((entry for entry in meta.get("slides", []) if entry.get("id") == slide), {"id": slide})
            meta["slides"].append({**original_meta, "id": recovered})
            encoded = (json.dumps(meta, indent=2, ensure_ascii=False) + "\n").encode()
            try:
                write_atomic(root / "deck.json", encoded)
            except BaseException:
                target.unlink(missing_ok=True)
                raise
            return {"recovered": recovered, "deck": meta, "version": version(encoded),
                    "recoveredVersion": version(data), "original": original.decode("utf-8") if original else None,
                    "originalVersion": original_version}

    @staticmethod
    def _new_slide_id(root: Path, prefix: str) -> str:
        prefix = re.sub(r"[^A-Za-z0-9_-]", "-", prefix)[:48].strip("-") or "recovered"
        while True:
            slide = f"{prefix}-{os.urandom(4).hex()}"
            if not (root / "slides" / f"{slide}.svg").exists():
                return slide

    @staticmethod
    def _trash_metadata(svg: Path) -> dict:
        sidecar = svg.with_suffix(".json")
        try:
            value = json.loads(sidecar.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

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
            existed = target.exists()
            shutil.copyfile(upload, target)
            try:
                size = image_size(target)
            except ValueError:
                if not existed:
                    target.unlink(missing_ok=True)
                raise
            info = {"kind": "image", "href": f"../media/{target.name}"}
            info.update(zip(("width", "height"), size))
            return info
        if ext in VIDEO_TYPES:
            target = media / f"{stem}-{digest}.mp4"
            poster = target.with_suffix(".poster.jpg")
            existed = target.exists(), poster.exists()
            try:
                with tempfile.TemporaryDirectory(dir=media) as tmp:
                    source = Path(tmp) / f"upload{ext}"
                    shutil.copyfile(upload, source)
                    if ext == ".mp4" and probe_codec(source) == "h264":
                        shutil.move(source, target)
                    else:
                        # H.264 mp4 plays everywhere (Chrome has no HEVC from iPhone .mov).
                        run_tool(["ffmpeg", "-loglevel", "error", "-y", "-i", str(source), "-an",
                                  "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
                                  "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart",
                                  str(target)], "could not convert movie")
                run_tool(["ffmpeg", "-loglevel", "error", "-y", "-i", str(target), "-frames:v", "1",
                          "-q:v", "3", str(poster)], "could not make a poster frame")
                w, h = probe_size(target)
            except ValueError:
                # Do not leave half-written files behind (but keep earlier uploads).
                for path, kept in zip((target, poster), existed):
                    if not kept:
                        path.unlink(missing_ok=True)
                raise
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
        with self._lock(name):
            return self._use_family(name, family)

    def _use_family(self, name: str, family: str) -> dict:
        path = self.deck_dir(name)
        meta = json.loads((path / "deck.json").read_bytes())
        have = {f["file"] for f in meta.get("fonts", [])}
        faces = [f for f in self.font_faces() if f["family"] == family]
        if not faces:
            raise KeyError(family)
        self._ensure_baseline(name)
        for face in faces:
            source = self.fonts / face["path"]
            filename = Path(face["path"]).name
            rel = f"fonts/{filename}"
            if rel in have:
                continue
            target = path / rel
            if target.exists() and target.read_bytes() != source.read_bytes():
                stem, suffix = Path(filename).stem, Path(filename).suffix
                rel = f"fonts/{stem}-{hashlib.sha256(source.read_bytes()).hexdigest()[:12]}{suffix}"
                target = path / rel
            if rel in have:
                continue
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
            elif target.read_bytes() != source.read_bytes():
                raise OSError(f"font asset collision for {rel}")
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


def run_tool(command: list[str], failure: str) -> subprocess.CompletedProcess:
    """Run ffmpeg/ffprobe; a missing tool or a failed run becomes a ValueError
    (shown to the user as a 400 with this message)."""
    try:
        return subprocess.run(command, check=True, capture_output=True, text=True, errors="replace")
    except FileNotFoundError:
        raise ValueError(f"{command[0]} is not installed") from None
    except subprocess.CalledProcessError as error:
        lines = (error.stderr or "").strip().splitlines()
        raise ValueError(f"{failure}: {lines[-1][:300] if lines else f'{command[0]} exited with status {error.returncode}'}") from error


def probe_size(path: Path) -> tuple[int, int]:
    out = run_tool(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                    "stream=width,height", "-of", "csv=p=0", str(path)],
                   "could not read the size of the file").stdout
    try:
        w, h = (int(part) for part in out.strip().split(",")[:2])
    except ValueError:
        w = h = 0
    if w <= 0 or h <= 0:
        # ffprobe reports 0,0 (or nothing) for a file it cannot decode.
        raise ValueError("could not read the size of the file: no picture found")
    return w, h


def probe_codec(path: Path) -> str:
    try:
        return subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                               "stream=codec_name", "-of", "csv=p=0", str(path)],
                              capture_output=True, text=True, errors="replace").stdout.strip()
    except FileNotFoundError:
        raise ValueError("ffprobe is not installed") from None


def image_size(path: Path) -> tuple[int, int]:
    if path.suffix == ".svg":
        root = ElementTree.parse(path).getroot()
        vb = (root.get("viewBox") or "").replace(",", " ").split()
        if len(vb) == 4:
            return round(float(vb[2])), round(float(vb[3]))
        return 400, 300
    return probe_size(path)
