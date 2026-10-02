"""Replacing the media of an image or movie in place, and the crop aspect lock."""
import pytest
from test_editor import page, server, to_screen

RED = ('data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="300" height="200"%3E'
       '%3Crect width="300" height="200" fill="red"/%3E%3C/svg%3E')
BLUE = ('data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="400" height="100"%3E'
        '%3Crect width="400" height="100" fill="blue"/%3E%3C/svg%3E')
GREEN = BLUE.replace("blue", "green")
POSTER = GREEN.replace("green", "orange")


def undo_depth(page):
    return page.evaluate("svgdeckEditor.state.slides.get(svgdeckEditor.state.current).undo.length")


def add_image(page, attrs=None, select=True):
    page.evaluate("""([href, attrs, select]) => { const e=svgdeckEditor.editor, ns='http://www.w3.org/2000/svg';
      const i=document.createElementNS(ns,'image');
      for(const [k,v] of Object.entries({id:'pic',x:200,y:150,width:500,height:300,href,
        preserveAspectRatio:'xMidYMid meet',...attrs}))i.setAttribute(k,v);
      e.change(() => { e.svg.append(i); if (select) e.select([i]); }); }""", [RED, attrs or {}, select])


def attrs_of(page):
    return page.evaluate("""() => Object.fromEntries([...document.getElementById('pic').attributes].map(a => [a.name, a.value]))""")


def replace(page, info):
    return page.evaluate("""(info) => { const e=svgdeckEditor.editor, i=document.getElementById('pic');
      return svgdeckEditor.mediaTools.replace(i, info) === i; }""", info)


IMAGE = {"kind": "image", "href": BLUE, "width": 400, "height": 100}
MOVIE = {"kind": "video", "href": POSTER, "video": "../media/new.mp4", "width": 400, "height": 100}


# --- replace ----------------------------------------------------------------------------
def test_replace_keeps_box_crop_filter_step_and_is_one_undo_step(page, server):
    add_image(page, {"transform": "rotate(8 450 300)", "opacity": "0.6", "data-step": "2", "data-label": "hero",
                     "data-locked": "true", "data-crop": "10 5 20 15", "data-mask": "ellipse"})
    # Crop through the real tool so the editor-owned clipPath exists, then adjust.
    page.evaluate("svgdeckEditor.mediaTools.open()")
    page.evaluate("document.querySelector('.direct-crop-tools details').open = true")
    field = page.locator('[data-crop-side="left"]')
    field.fill("12"); field.dispatch_event("change")
    page.evaluate("svgdeckEditor.mediaTools.finish()")
    page.evaluate("""async () => { const e=svgdeckEditor.editor;
      const {setImageAdjustment, IMAGE_ADJUSTMENTS} = await import('/editor/image-adjustments.js');
      e.select([document.getElementById('pic')]);
      setImageAdjustment(e, IMAGE_ADJUSTMENTS[0], 0); }""")
    assert "svgdeck-image-filter" in page.evaluate("document.getElementById('pic').style.filter")
    before = attrs_of(page)
    clip = page.evaluate("document.getElementById('pic').getAttribute('clip-path')")
    depth = undo_depth(page)
    assert replace(page, IMAGE)
    after = attrs_of(page)
    assert after.pop("href") == BLUE and before.pop("href") == RED
    assert after == before
    assert page.evaluate("document.getElementById('pic').getAttribute('clip-path')") == clip
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('clipPath') !== null")
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('filter[data-image-adjustment-filter]') !== null")
    assert page.evaluate("document.getElementById('pic').getAttribute('data-crop')") == "12 5 20 15"
    assert "svgdeck-image-filter" in page.evaluate("document.getElementById('pic').style.filter")
    assert page.evaluate("svgdeckEditor.editor.selection.map(n => n.id)") == ["pic"]
    assert undo_depth(page) == depth + 1
    page.locator("#undo").click()
    assert attrs_of(page)["href"] == RED
    assert undo_depth(page) == depth


def test_replace_image_with_movie_adds_defaults_and_poster(page, server):
    add_image(page, {"data-step": "1"})
    assert replace(page, MOVIE)
    a = attrs_of(page)
    assert a["href"] == POSTER and a["data-video"].endswith("/media/new.mp4")
    assert a["data-autoplay"] == "true" and a["data-loop"] == "true"
    assert (a["x"], a["y"], a["width"], a["height"], a["data-step"]) == ("200", "150", "500", "300", "1")
    page.locator("#undo").click()
    assert "data-video" not in attrs_of(page) and "data-autoplay" not in attrs_of(page)


def test_replace_movie_with_movie_keeps_playback_settings(page, server):
    add_image(page, {"data-video": "../media/old.mp4", "data-autoplay": "false", "data-loop": "false", "data-sync": "g1"})
    assert replace(page, MOVIE)
    a = attrs_of(page)
    assert a["data-video"].endswith("/media/new.mp4") and a["href"] == POSTER
    assert (a["data-autoplay"], a["data-loop"], a["data-sync"]) == ("false", "false", "g1")


def test_replace_movie_with_image_drops_movie_attributes(page, server):
    add_image(page, {"data-video": "../media/old.mp4", "data-autoplay": "true", "data-loop": "true", "data-sync": "g1",
                     "data-label": "movie"})
    assert replace(page, IMAGE)
    a = attrs_of(page)
    assert a["href"] == BLUE and a["data-label"] == "movie"
    for name in ("data-video", "data-autoplay", "data-loop", "data-sync"):
        assert name not in a
    page.locator("#undo").click()
    assert attrs_of(page)["data-video"] == "../media/old.mp4" or attrs_of(page)["data-video"].endswith("/media/old.mp4")


def test_replace_during_crop_session_ends_it_and_stays_one_step(page, server):
    add_image(page)
    page.evaluate("svgdeckEditor.mediaTools.open()")
    page.evaluate("document.querySelector('.direct-crop-tools details').open = true")
    field = page.locator('[data-crop-side="left"]')
    field.fill("30"); field.dispatch_event("change")
    depth = undo_depth(page)
    assert replace(page, IMAGE)
    assert page.evaluate("svgdeckEditor.mediaTools.active()") is False
    a = attrs_of(page)
    assert a["href"] == BLUE and "data-crop" not in a and "clip-path" not in a
    assert undo_depth(page) == depth + 1
    assert page.evaluate("svgdeckEditor.editor.svg.querySelector('clipPath')") is None


def test_replace_rejects_non_images_without_changes(page, server):
    page.evaluate("""() => { const e=svgdeckEditor.editor, r=document.createElementNS(e.svg.namespaceURI,'rect');
      r.id='box'; r.setAttribute('width',10); r.setAttribute('height',10); e.change(() => e.svg.append(r)); }""")
    depth = undo_depth(page)
    assert page.evaluate("info => svgdeckEditor.mediaTools.replace(document.getElementById('box'), info)", IMAGE) is None
    assert page.evaluate("svgdeckEditor.mediaTools.replace(null, {href: 'x'})") is None
    assert undo_depth(page) == depth


# --- aspect lock ------------------------------------------------------------------------
def crop_values(page):
    return page.evaluate("document.getElementById('pic').getAttribute('data-crop').split(' ').map(Number)")


def ratio(crop):
    l, t, r, b = crop
    return 500 * (100 - l - r) / (300 * (100 - t - b))


def drag_handle(page, name, dx, dy, shift=False):
    box = page.locator(f'[data-crop-handle="{name}"]').bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    if shift: page.keyboard.down("Shift")
    page.mouse.down(); page.mouse.move(x + dx, y + dy, steps=6); page.mouse.up()
    if shift: page.keyboard.up("Shift")


def open_crop(page, crop="10 10 30 20"):
    add_image(page, {"data-crop": crop})
    page.evaluate("svgdeckEditor.mediaTools.open()")


def test_corner_drag_is_free_without_the_lock(page, server):
    open_crop(page)
    start = ratio(crop_values(page))
    drag_handle(page, "se", -120, -10)
    assert abs(ratio(crop_values(page)) - start) > .15


def test_aspect_toggle_keeps_ratio_on_every_corner(page, server):
    open_crop(page)
    start = ratio(crop_values(page))
    assert page.evaluate("svgdeckEditor.mediaTools.aspectLocked()") is False
    page.get_by_role("button", name="Aspect").click()
    assert page.evaluate("svgdeckEditor.mediaTools.aspectLocked()") is True
    assert page.get_by_role("button", name="Aspect").get_attribute("aria-pressed") == "true"
    drag_handle(page, "se", -60, -10)
    c = crop_values(page)
    assert abs(ratio(c) - start) < .02 and c[2] > 30 and c[0] == 10 and c[1] == 10
    drag_handle(page, "nw", 30, 20)
    c = crop_values(page)
    assert abs(ratio(c) - start) < .02 and c[0] > 10
    drag_handle(page, "ne", 40, -60)  # grow the other way
    assert abs(ratio(crop_values(page)) - start) < .02
    drag_handle(page, "sw", -300, 300)  # past the image: clamped, shape kept
    c = crop_values(page)
    assert abs(ratio(c) - start) < .02 and min(c) >= 0
    page.get_by_role("button", name="Aspect").click()
    assert page.evaluate("svgdeckEditor.mediaTools.aspectLocked()") is False


def test_shift_while_dragging_a_corner_locks_the_ratio(page, server):
    open_crop(page)
    start = ratio(crop_values(page))
    drag_handle(page, "se", -100, -20, shift=True)
    assert abs(ratio(crop_values(page)) - start) < .02
    assert page.evaluate("svgdeckEditor.mediaTools.aspectLocked()") is False
    drag_handle(page, "se", 20, -60)  # Shift released: free again
    assert abs(ratio(crop_values(page)) - start) > .1


def test_edge_handle_with_lock_resizes_the_other_axis_around_the_centre(page, server):
    open_crop(page)
    start, before = ratio(crop_values(page)), crop_values(page)
    page.evaluate("svgdeckEditor.mediaTools.setAspectLock(true)")
    drag_handle(page, "e", -60, 0)
    c = crop_values(page)
    assert abs(ratio(c) - start) < .02
    assert c[0] == before[0] and c[2] > before[2]
    # Top and bottom shrink by the same amount around the centre.
    assert abs((c[1] - before[1]) - (c[3] - before[3])) < .1 and c[1] > before[1]


def test_aspect_lock_applies_to_one_session_and_commits_one_undo_step(page, server):
    open_crop(page)
    page.evaluate("svgdeckEditor.mediaTools.setAspectLock(true)")
    drag_handle(page, "se", -80, -30)
    page.get_by_role("button", name="Done").click()
    assert page.evaluate("svgdeckEditor.mediaTools.aspectLocked()") is False
    assert undo_depth(page) == 2  # insert + crop
    page.evaluate("svgdeckEditor.mediaTools.open()")
    assert page.evaluate("svgdeckEditor.mediaTools.aspectLocked()") is False
    page.keyboard.press("Escape")
    assert page.evaluate("svgdeckEditor.mediaTools.setAspectLock(true)") is False
    assert page.evaluate("svgdeckEditor.mediaTools.aspectLocked()") is False
