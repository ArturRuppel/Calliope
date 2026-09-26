import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SLIDE = """<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">
<defs><linearGradient id="bg"><stop offset="0" stop-color="{color}"/></linearGradient></defs>
<rect id="back" width="1920" height="1080" fill="url(#bg)"/>
{body}
</svg>"""


def write_deck(root: Path, slides: list[tuple[str, str]], media: dict[str, Path] | None = None) -> Path:
    (root / "slides").mkdir(parents=True)
    (root / "media").mkdir()
    for name, source in (media or {}).items():
        shutil.copy(source, root / "media" / name)
    for sid, svg in slides:
        (root / "slides" / f"{sid}.svg").write_text(svg)
    (root / "deck.json").write_text(json.dumps({
        "format": 1, "title": "Test deck", "size": [1920, 1080], "background": "#000",
        "slides": [{"id": sid} for sid, _ in slides], "fonts": []}))
    return root


@pytest.fixture(scope="session")
def movie(tmp_path_factory) -> Path:
    """A 4 s test movie. VP9/webm because Playwright's Chromium has no H.264."""
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not available")
    path = tmp_path_factory.mktemp("media") / "clock.webm"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=4",
                    "-c:v", "libvpx-vp9", "-b:v", "200k", str(path)], check=True)
    return path


# Headless WPE WebKit (the iPad's engine, run on Linux) freezes when it loads a
# movie; there the movies are plain images and movie tests are skipped.
MOVIES = os.environ.get("SVGDECK_BROWSER", "chromium") != "webkit"


@pytest.fixture
def deck(tmp_path, movie) -> Path:
    video = ('<image href="../media/clock.webm" data-video="../media/clock.webm" x="100" y="100" '
             'width="640" height="480" data-sync="g1"/>')
    if not MOVIES:
        video = video.replace(' data-video="../media/clock.webm"', "")
    slides = [
        ("a", SLIDE.format(color="#ff0000", body='<text id="t" x="100" y="200">first</text>')),
        ("b", SLIDE.format(color="#00ff00", body=video + '<rect id="one" data-step="1" x="800" width="100" height="100"/>'
                                                          '<rect id="two" data-step="2" x="1000" width="100" height="100"/>')),
        ("c", SLIDE.format(color="#0000ff", body=video + '<rect id="above" x="100" y="100" width="50" height="50"/>')),
    ]
    return write_deck(tmp_path / "deck", slides, {"clock.webm": movie})
