/* What a slide may not carry into the page: anything that runs script.
   Shared by the editor (canvas, thumbnails, clipboard) and the player, which
   apply it to every parsed slide before it enters the document. Classic
   script (no modules): the player inlines it into presenter pages and
   exports, which also run from file://.

   The rules are those of svgdeck/sanitize.py, in the same order; the service
   refuses to save a slide that breaks them, so the two must stay in step.

   SvgDeckSanitize.sanitize(root) removes, in place, from a parsed <svg> (or
   any element) and its descendants, and returns what it removed as a list of
   short descriptions ([] when the slide was clean, and then nothing changed). */
(function () {
  "use strict";
  const XHTML = "http://www.w3.org/1999/xhtml";
  const MATHML = "http://www.w3.org/1998/Math/MathML";
  const XMLNS = "http://www.w3.org/2000/xmlns/";
  const XML = "http://www.w3.org/XML/1998/namespace";

  const DROP_ELEMENTS = new Set(["script", "foreignobject", "iframe", "embed", "object", "frame", "frameset",
    "applet", "base", "link", "meta", "handler", "listener"]);
  const FOREIGN_NAMESPACES = new Set([XHTML, MATHML]);
  const ANIMATIONS = new Set(["set", "animate", "animatetransform", "animatemotion", "animatecolor"]);
  const URL_ATTRIBUTES = new Set(["href", "src", "data-video", "action", "formaction"]);
  const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);
  const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/;

  // A URL as a browser reads it: tabs and newlines go, controls and spaces at the ends too.
  const cleanUrl = (value) => value.replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
  function urlScheme(value) {
    const match = SCHEME.exec(cleanUrl(value));
    return match ? match[1].toLowerCase() : null;
  }
  function unsafeUrl(value) {
    const scheme = urlScheme(value);
    if (scheme === null || SAFE_SCHEMES.has(scheme)) return false;
    return !(scheme === "data" && cleanUrl(value).slice(5).replace(/^\s+/, "").toLowerCase().startsWith("image/"));
  }

  function cssChar(_, hex) {
    const code = parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
  }
  function unsafeCss(text) {
    const css = text.replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?/g, cssChar)
      .replace(/\\([\s\S])/g, "$1");
    if (css.toLowerCase().includes("@import")) return true;
    for (const match of css.matchAll(/url\(\s*(['"]?)\s*([^'")\s]*)/gi)) {
      const target = match[2].toLowerCase();
      if (!(target.startsWith("#") || target.startsWith("data:image/"))) return true;
    }
    return false;
  }

  const nameOf = (node) => (node.localName || node.nodeName || "").toLowerCase();

  function elementProblem(el) {
    const name = nameOf(el);
    if (DROP_ELEMENTS.has(name) || FOREIGN_NAMESPACES.has(el.namespaceURI)) return `<${el.localName}> element`;
    if (ANIMATIONS.has(name)) {
      const target = (el.getAttribute("attributeName") || "").trim().toLowerCase().split(":").pop();
      if (target === "href" || target.startsWith("on")) return `<${el.localName}> of ${target}`;
    }
    if (name === "style" && unsafeCss(el.textContent || "")) return "<style> that loads from elsewhere";
    return null;
  }

  function attributeProblem(attr) {
    if (attr.namespaceURI === XMLNS || attr.name === "xmlns" || attr.name.startsWith("xmlns:")) return null;
    const name = nameOf(attr);
    if (name.startsWith("on")) return `${attr.name} attribute`;
    if (attr.namespaceURI === XML && name === "base") return "xml:base attribute";
    if (URL_ATTRIBUTES.has(name) && unsafeUrl(attr.value)) return `${attr.name} with a ${urlScheme(attr.value)}: URL`;
    if (name === "style" && unsafeCss(attr.value)) return "style attribute that loads from elsewhere";
    return null;
  }

  function walk(el, removed) {
    for (const attr of Array.from(el.attributes || [])) {
      const problem = attributeProblem(attr);
      if (problem) { removed.push(problem); el.removeAttributeNode(attr); }
    }
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType !== 1) continue;
      const problem = elementProblem(child);
      if (problem) { removed.push(problem); child.remove(); }
      else walk(child, removed);
    }
  }

  function sanitize(root) {
    const removed = [];
    if (root && root.nodeType === 1) walk(root, removed);
    return removed;
  }

  const api = { sanitize, unsafeUrl, unsafeCss };
  if (typeof window !== "undefined") window.SvgDeckSanitize = api;
  else if (typeof globalThis !== "undefined") globalThis.SvgDeckSanitize = api;
})();
