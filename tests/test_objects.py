"""Grouping and clipboard behavior for SVG objects."""

from test_editor import page, server  # noqa: F401 - shared browser fixtures


def test_group_refuses_movies(page):
    result = page.evaluate("""() => {
      const e = svgdeckEditor.editor;
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><image data-video="movie.mp4"/><rect/></svg>',
        'image/svg+xml');
      const movie = document.importNode(doc.documentElement.children[0], true);
      const rect = document.importNode(doc.documentElement.children[1], true);
      e.svg.append(movie, rect);
      e.select([movie, rect]);
      e.group();
      return {groups: e.svg.querySelectorAll(':scope > g').length,
              selected: e.selection.length, toast: document.querySelector('#toast').textContent};
    }""")
    assert result["groups"] == 0
    assert result["selected"] == 2
    assert "cannot be grouped" in result["toast"]


def test_paste_refuses_movie_inside_group(page):
    result = page.evaluate("""() => {
      const e = svgdeckEditor.editor;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      e.svg.append(g);
      e.enterGroup(g);
      const clip = JSON.stringify({svgdeck: 1, defs: [], items: [
        '<image xmlns="http://www.w3.org/2000/svg" href="poster.png" data-video="movie.mp4"/>'
      ]});
      const handled = e.paste(clip);
      return {handled, movies: g.querySelectorAll('image[data-video]').length,
              toast: document.querySelector('#toast').textContent};
    }""")
    assert result["handled"] is True
    assert result["movies"] == 0
    assert "cannot be pasted into groups" in result["toast"]


def test_paste_remaps_definitions_and_cross_object_references(page):
    result = page.evaluate("""() => {
      const e = svgdeckEditor.editor;
      const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">' +
        '<defs><linearGradient id="paint"><stop stop-color="red"/></linearGradient></defs>' +
        '<rect id="shape" width="100" height="100" fill="url(#paint)"/>' +
        '<use href="#shape" x="120"/></svg>';
      e.load(source);
      e.select([e.svg.querySelector('rect'), e.svg.querySelector('use')]);
      const clip = e.copy();
      e.load(source.replace('red', 'blue'));
      e.paste(clip);
      const [rect, use] = e.selection;
      const fillId = /#([^)'\"]+)/.exec(rect.getAttribute('fill'))[1];
      const hrefId = use.getAttribute('href').slice(1);
      return {
        originalColor: e.svg.querySelector('linearGradient#paint stop').getAttribute('stop-color'),
        pastedColor: e.svg.querySelector(`linearGradient#${CSS.escape(fillId)} stop`).getAttribute('stop-color'),
        gradients: e.svg.querySelectorAll('linearGradient').length,
        rectId: rect.id,
        hrefId,
      };
    }""")
    assert result == {
        "originalColor": "blue",
        "pastedColor": "red",
        "gradients": 2,
        "rectId": result["rectId"],
        "hrefId": result["rectId"],
    }
    assert result["rectId"] != "shape"


def test_duplicate_remaps_references_across_selected_objects(page):
    result = page.evaluate("""() => {
      const e = svgdeckEditor.editor;
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect id="shape"/><use href="#shape"/></svg>',
        'image/svg+xml');
      const rect = document.importNode(doc.documentElement.children[0], true);
      const use = document.importNode(doc.documentElement.children[1], true);
      e.svg.append(rect, use);
      e.select([rect, use]);
      e.duplicate();
      return {rectId: e.selection[0].id, href: e.selection[1].getAttribute('href'),
              originalHref: use.getAttribute('href')};
    }""")
    assert result["rectId"] != "shape"
    assert result["href"] == f'#{result["rectId"]}'
    assert result["originalHref"] == "#shape"


def test_ungroup_preserves_presentation_attributes(page):
    result = page.evaluate("""() => {
      const e = svgdeckEditor.editor;
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g fill="red" stroke="blue" stroke-width="7">' +
        '<rect width="100" height="100"/></g></svg>', 'image/svg+xml');
      const g = document.importNode(doc.documentElement.firstElementChild, true);
      e.svg.append(g);
      e.select([g]);
      e.ungroup();
      const rect = e.selection[0], style = getComputedStyle(rect);
      return {fill: style.fill, stroke: style.stroke, width: style.strokeWidth,
              groups: e.svg.querySelectorAll(':scope > g').length};
    }""")
    assert result == {"fill": "rgb(255, 0, 0)", "stroke": "rgb(0, 0, 255)", "width": "7px", "groups": 0}


def test_ungroup_preserves_computed_inheritance(page):
    result = page.evaluate("""() => {
      const e = svgdeckEditor.editor;
      const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = '.presentation { color: rgb(12, 34, 56); fill: currentColor; font-size: 2em; }';
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g class="presentation"><text>Words</text></g></svg>',
        'image/svg+xml');
      e.svg.append(style);
      const g = document.importNode(doc.documentElement.firstElementChild, true);
      e.svg.append(g);
      const before = getComputedStyle(g.firstElementChild);
      const expected = {fill: before.fill, fontSize: before.fontSize};
      e.select([g]);
      e.ungroup();
      const after = getComputedStyle(e.selection[0]);
      return {expected, actual: {fill: after.fill, fontSize: after.fontSize}};
    }""")
    assert result["actual"] == result["expected"]


def test_ungroup_resolves_relative_child_override(page):
    result = page.evaluate("""() => {
      const e = svgdeckEditor.editor;
      e.svg.style.fontSize = '16px';
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g font-size="2em"><text font-size="2em">Words</text></g></svg>',
        'image/svg+xml');
      const g = document.importNode(doc.documentElement.firstElementChild, true);
      e.svg.append(g);
      const before = getComputedStyle(g.firstElementChild).fontSize;
      e.select([g]);
      e.ungroup();
      return {before, after: getComputedStyle(e.selection[0]).fontSize,
              inline: e.selection[0].style.fontSize};
    }""")
    assert result == {"before": "64px", "after": "64px", "inline": "64px"}


def test_ungroup_refuses_opacity_attribute(page):
    result = page.evaluate("""() => {
      const e = svgdeckEditor.editor;
      const doc = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><g opacity="0.5"><rect width="100" height="100"/></g></svg>',
        'image/svg+xml');
      const g = document.importNode(doc.documentElement.firstElementChild, true);
      e.svg.append(g);
      e.select([g]);
      e.ungroup();
      return {groups: e.svg.querySelectorAll(':scope > g').length,
              opacity: e.svg.querySelector(':scope > g').getAttribute('opacity'),
              toast: document.querySelector('#toast').textContent};
    }""")
    assert result["groups"] == 1
    assert result["opacity"] == "0.5"
    assert "would change how it looks" in result["toast"]


def test_ungroup_refuses_computed_opacity(page):
    result = page.evaluate("""() => {
      const e = svgdeckEditor.editor;
      const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = '.translucent { opacity: 0.4; }';
      e.svg.append(style);
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'translucent');
      g.append(document.createElementNS('http://www.w3.org/2000/svg', 'rect'));
      e.svg.append(g);
      e.select([g]);
      e.ungroup();
      return {groupPresent: g.isConnected, opacity: getComputedStyle(g).opacity};
    }""")
    assert result == {"groupPresent": True, "opacity": "0.4"}


def test_ungroup_refuses_computed_filter(page):
    result = page.evaluate("""() => {
      const e = svgdeckEditor.editor;
      const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = '.effect { filter: blur(2px); }';
      e.svg.append(style);
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'effect');
      g.append(document.createElementNS('http://www.w3.org/2000/svg', 'rect'));
      e.svg.append(g);
      e.select([g]);
      e.ungroup();
      return {groupPresent: g.isConnected, filter: getComputedStyle(g).filter};
    }""")
    assert result == {"groupPresent": True, "filter": "blur(2px)"}
