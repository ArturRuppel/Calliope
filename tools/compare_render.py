"""Render every slide of an exported deck in headless Chromium and compare it
with reference PNGs (the old Inkscape exports). Development check for the
importer and the player.

    python tools/compare_render.py EXPORT_DIR REFERENCE_DIR OUT_DIR

Writes OUT_DIR/sNN.png renders, OUT_DIR/report.csv (mean absolute difference
per slide, 0-255) and side-by-side sheets for the worst slides.
"""
from __future__ import annotations

import argparse
import csv
import re
from pathlib import Path

from PIL import Image, ImageChops, ImageStat
from playwright.sync_api import sync_playwright


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("export", type=Path)
    ap.add_argument("reference", type=Path, help="directory with slideN.png")
    ap.add_argument("out", type=Path)
    ap.add_argument("--worst", type=int, default=8)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    rows = []
    errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto((args.export / "index.html").resolve().as_uri())
        page.wait_for_function("document.getElementById('svgdeck').classList.contains('svgdeck-ready')")
        ids = page.evaluate("document.getElementById('svgdeck').svgdeck.slides.map(s => s.id)")
        for i, sid in enumerate(ids):
            page.evaluate(f"document.getElementById('svgdeck').svgdeck.show({i}, 99)")
            # Movies: pause on the poster frame so renders are deterministic.
            page.evaluate("""document.querySelectorAll('video').forEach(v => { v.pause(); v.currentTime = 0; })""")
            page.wait_for_timeout(150)
            shot = args.out / f"{sid}.png"
            page.screenshot(path=str(shot))
            n = int(re.sub(r"\D", "", sid))
            ref = args.reference / f"slide{n}.png"
            if not ref.exists():
                continue
            a = Image.open(shot).convert("RGB")
            b = Image.open(ref).convert("RGBA")
            flat = Image.new("RGB", b.size, (255, 255, 255))
            flat.paste(b, mask=b.getchannel("A"))
            diff = ImageChops.difference(a, flat.resize(a.size))
            rows.append((sid, round(sum(ImageStat.Stat(diff).mean) / 3, 2)))
        browser.close()

    with open(args.out / "report.csv", "w", newline="") as f:
        csv.writer(f).writerows([("slide", "mean_abs_diff"), *rows])
    rows.sort(key=lambda r: -r[1])
    for sid, d in rows[:args.worst]:
        n = int(re.sub(r"\D", "", sid))
        a = Image.open(args.out / f"{sid}.png").convert("RGB").resize((960, 540))
        b = Image.open(args.reference / f"slide{n}.png").convert("RGBA")
        flat = Image.new("RGB", b.size, (255, 255, 255))
        flat.paste(b, mask=b.getchannel("A"))
        sheet = Image.new("RGB", (1920, 540))
        sheet.paste(flat.resize((960, 540)), (0, 0))
        sheet.paste(a, (960, 0))
        sheet.save(args.out / f"compare-{sid}.jpg", quality=85)
    print("worst:", rows[:args.worst])
    print("median:", sorted(r[1] for r in rows)[len(rows) // 2] if rows else None)
    print("page errors:", errors or "none")


if __name__ == "__main__":
    main()
