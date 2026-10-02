"""Picture adjustments survive saving and exporting without touching source media."""
import base64
import io

from PIL import Image
from svgdeck.deck import Deck
from svgdeck.export import export
from test_editor import page, saved_slide, server


def add_image(page, original=""):
    buffer = io.BytesIO()
    Image.new("RGB", (20, 20), "red").save(buffer, format="PNG")
    href = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()
    page.evaluate("""({href, original}) => {
      const e = svgdeckEditor.editor;
      e.change(() => {
        const image = document.createElementNS(e.svg.namespaceURI, 'image');
        for (const [k,v] of Object.entries({id:'adjustme', x:200, y:200, width:400, height:400, href})) image.setAttribute(k,v);
        if (original) image.style.filter = original;
        e.svg.append(image); e.select([image]);
      });
    }""", {"href": href, "original": original})
    return href


def set_value(page, label, value):
    field = page.get_by_label(label + " value", exact=True)
    field.fill(str(value))
    field.dispatch_event("change")


def image_style(page):
    return page.locator("#adjustme").evaluate("i => i.style.filter")


def filter_values(page, selector="#adjustme"):
    return page.locator(selector).evaluate("""i => {
      const f = i.ownerSVGElement.querySelector('#' + i.getAttribute('data-svgdeck-image-filter'));
      return [...f.children].map(n => n.localName === 'feColorMatrix'
        ? [n.getAttribute('type'), Number(n.getAttribute('values'))]
        : [...n.children].map(c => [Number(c.getAttribute('slope')), Number(c.getAttribute('intercept'))]));
    }""")


def pixel(page, selector="#adjustme"):
    png = page.locator(selector).screenshot()
    im = Image.open(io.BytesIO(png)).convert("RGB")
    return im.getpixel((im.width // 2, im.height // 2))


def test_grayscale_save_reload_undo_reset_and_offline_render(page, server, tmp_path):
    source = add_image(page)
    assert pixel(page)[0] > 240
    set_value(page, "Saturation", 0)
    red, green, blue = pixel(page)
    assert max(red, green, blue) - min(red, green, blue) <= 2
    svg = saved_slide(page, server)
    assert 'type="saturate" values="0"' in svg and source in svg
    page.reload()
    page.wait_for_selector("#adjustme")
    page.evaluate("svgdeckEditor.editor.select([document.getElementById('adjustme')])")
    assert page.get_by_label("Saturation value", exact=True).input_value() == "0"
    set_value(page, "Hue shift", 90)
    page.locator("#undo").click()
    assert filter_values(page)[1] == ["hueRotate", 0]
    page.locator("#redo").click()
    assert filter_values(page)[1] == ["hueRotate", 90]
    page.evaluate("svgdeckEditor.editor.select([document.getElementById('adjustme')])")
    page.get_by_role("button", name="Reset adjustments", exact=True).click()
    assert image_style(page) == ""
    assert page.locator("#adjustme").get_attribute("href") == source
    set_value(page, "Saturation", 0)
    saved_slide(page, server)
    _, data = server
    out = export(Deck.load(data / "decks" / "talk"), tmp_path / "export")
    page.goto((out / "index.html").as_uri())
    page.wait_for_selector("image")
    red, green, blue = pixel(page, "#s0-adjustme")
    assert max(red, green, blue) - min(red, green, blue) <= 2


def test_combined_controls_opacity_clamping_and_original_filter(page, server):
    add_image(page, "sepia(20%)")
    for label, value in [("Saturation", 50), ("Hue shift", -30), ("Brightness", 150), ("Contrast", 120)]:
        set_value(page, label, value)
    assert image_style(page).startswith("sepia(20%) url(")
    assert filter_values(page)[:2] == [["saturate", .5], ["hueRotate", -30]]
    assert filter_values(page)[3] == [[1.5, 0]] * 3
    # Transparency is independent of the colour reset.
    opacity = page.locator('#panel .row').filter(has=page.locator('label', has_text='Opacity')).locator('input')
    opacity.fill('40'); opacity.dispatch_event('change')
    set_value(page, "Brightness", 500)
    assert filter_values(page)[3] == [[5, 0]] * 3
    set_value(page, "Brightness", 1500)
    assert filter_values(page)[3] == [[10, 0]] * 3
    set_value(page, "Hue shift", -999)
    assert filter_values(page)[1] == ["hueRotate", -180]
    page.get_by_role("button", name="Reset adjustments", exact=True).click()
    assert image_style(page) == "sepia(20%)"
    assert page.locator('#adjustme').evaluate('i => i.style.opacity') == '0.4'
    assert 'data-image-original-filter' not in saved_slide(page, server)


def test_imported_filter_attribute_survives_multi_image_edits(page):
    add_image(page)
    page.evaluate("""() => { const e=svgdeckEditor.editor, a=document.getElementById('adjustme');
      a.setAttribute('filter','url(#old-filter)');
      const defs=document.createElementNS(e.svg.namespaceURI,'defs');
      defs.innerHTML='<filter id="old-filter"><feColorMatrix type="saturate" values=".5"/></filter>';e.svg.prepend(defs);
      const b=a.cloneNode(true); b.id='second'; e.svg.append(b); e.select([a,b]); }
    """)
    slider = page.get_by_label("Contrast", exact=True)
    slider.fill("80"); slider.dispatch_event("change")
    assert filter_values(page, '#second')[0] == ['saturate', .5]
    assert page.locator('#second').evaluate('i => i.style.filter').startswith('url(')
    page.get_by_role("button", name="Reset adjustments", exact=True).click()
    for selector in ('#adjustme', '#second'):
        assert page.locator(selector).get_attribute('filter') == 'url(#old-filter)'
        assert page.locator(selector).evaluate('i => i.style.filter') == ''


def test_slider_live_preview_and_single_undo(page, server):
    add_image(page)
    slider = page.get_by_label("Brightness", exact=True)
    box = slider.bounding_box()
    y = box["y"] + box["height"] / 2
    page.mouse.move(box["x"] + box["width"] / 2, y)
    page.mouse.down()
    page.mouse.move(box["x"] + 8, y, steps=8)
    assert pixel(page)[0] < 80
    page.mouse.up()
    assert "feComponentTransfer" in saved_slide(page, server)
    page.locator("#undo").click()
    assert image_style(page) == ""
    assert pixel(page)[0] > 240
    page.locator("#redo").click()
    assert pixel(page)[0] < 80


def test_numeric_live_preview_keeps_focus_and_commits_on_blur(page, server):
    add_image(page)
    field = page.get_by_label("Saturation value", exact=True)
    field.fill("0")
    assert field.evaluate("i => i === document.activeElement")
    red, green, blue = pixel(page)
    assert max(red, green, blue) - min(red, green, blue) <= 2
    field.press("Tab")
    assert 'type="saturate" values="0"' in saved_slide(page, server)
    page.locator("#undo").click()
    assert image_style(page) == ""


def test_cropped_image_native_filter_and_legacy_upgrade(page, server):
    add_image(page)
    # Reproduce the large, cropped image from the iPad report and the old CSS settings.
    page.evaluate("""() => { const e=svgdeckEditor.editor, i=document.getElementById('adjustme');
      e.change(() => {
        const defs=document.createElementNS(e.svg.namespaceURI,'defs');
        defs.innerHTML='<clipPath id="crop" clipPathUnits="objectBoundingBox"><rect x=".5" y=".1" width=".48" height=".74"/></clipPath>';
        e.svg.prepend(defs);
        i.setAttribute('x',-707);i.setAttribute('y',-158);i.setAttribute('width',2703);i.setAttribute('height',1539);
        i.setAttribute('clip-path','url(#crop)');
        i.setAttribute('data-image-original-filter','');i.setAttribute('data-image-brightness','0');
        i.style.filter='brightness(0%)';
      });
    }""")
    saved_slide(page, server)
    page.reload(); page.wait_for_selector('#adjustme')
    assert page.locator('#adjustme').evaluate("i => i.style.filter.startsWith('url(')")
    # Screenshot the stage, since the unclipped image box extends past the viewport.
    png = page.locator('#stage').screenshot()
    im = Image.open(io.BytesIO(png)).convert('RGB')
    xy = page.evaluate("""() => { const e=svgdeckEditor.editor, p=e.page.getBoundingClientRect(), s=e.host.getBoundingClientRect();
      return [Math.round(p.left-s.left+1100*e.zoom), Math.round(p.top-s.top+500*e.zoom)]; }""")
    assert max(im.getpixel(tuple(xy))) < 5
    assert 'data-svgdeck-image-filter' in saved_slide(page, server)


def test_duplicate_adjustments_are_independent_and_defs_are_cleaned(page):
    add_image(page)
    set_value(page, 'Saturation', 0)
    page.evaluate("""() => { const e=svgdeckEditor.editor; e.duplicate(); }""")
    set_value(page, 'Saturation', 100)
    assert page.locator('image[data-image-saturation="0"]').count() == 1
    assert page.locator('filter[data-image-adjustment-filter]').count() == 1
    page.evaluate("svgdeckEditor.editor.select([document.getElementById('adjustme')])")
    page.get_by_role('button', name='Reset adjustments', exact=True).click()
    assert page.locator('filter[data-image-adjustment-filter]').count() == 0


def test_zero_contrast_brightness_runs_from_black_to_white(page, server):
    add_image(page)
    set_value(page, "Contrast", 0)
    for brightness, expected in [(0, 0), (100, 128), (200, 255)]:
        set_value(page, "Brightness", brightness)
        rgb = pixel(page)
        assert all(abs(channel - expected) <= 1 for channel in rgb)
    saved_slide(page, server)
    page.reload(); page.wait_for_selector('#adjustme')
    assert min(pixel(page)) >= 254


def test_old_native_filter_order_upgrades_on_reload(page, server):
    add_image(page)
    set_value(page, "Contrast", 0)
    set_value(page, "Brightness", 0)
    # Recreate a saved filter using the previous brightness-before-contrast order.
    page.evaluate("""() => {const e=svgdeckEditor.editor, i=document.getElementById('adjustme');
      e.change(() => {
        const f=e.svg.querySelector('#'+i.getAttribute('data-svgdeck-image-filter'));
        f.removeAttribute('data-image-adjustment-version');
        const transfers=f.querySelectorAll('feComponentTransfer');f.insertBefore(transfers[1], transfers[0]);
      });
    }""")
    assert all(abs(c - 128) <= 1 for c in pixel(page))
    saved_slide(page, server)
    page.reload();page.wait_for_selector('#adjustme')
    assert max(pixel(page)) <= 1
    assert page.locator('#adjustme').get_attribute('data-image-brightness') == '0'
    assert page.locator('#adjustme').get_attribute('data-image-contrast') == '0'
