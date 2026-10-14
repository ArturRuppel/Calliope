/* Speaker controls and a separate audience window. Included in offline exports. */
(function () {
  "use strict";
  window.SvgDeckSpeaker = function (root, deck, api, options, rewrite, parseSlide) {
    const params = new URL(location.href).searchParams;
    const speaker = params.get('speaker') === '1';
    const size = deck.size || [1920, 1080];
    const token = params.get('session');
    let audience = null, audienceReady = false, applying = false, linked = false;
    let refreshStatus = () => {};
    const opaqueOrigin = location.protocol === 'file:' || location.origin === 'null';
    const targetOrigin = opaqueOrigin ? '*' : location.origin;
    const session = token || Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('');
    if (speaker && !token) {
      // Keep the session in the address, so reloading this window keeps it.
      try { const url = new URL(location.href); url.searchParams.set('session', session); history.replaceState(null, '', url.href); } catch (e) { /* session lasts until reload */ }
    }
    const send = (win, type, value) => { if (win && !win.closed) win.postMessage({svgdeck: session, type, value}, targetOrigin); };
    const snapshot = () => ({index: api.state.index, step: api.state.step, blank: api.state.blank});
    let update = () => {};
    root.addEventListener('svgdeck:change', () => {
      update();
      if (!applying && (speaker || linked)) send(speaker ? audience : (token ? window.opener : null), 'state', snapshot());
    });
    // Zoom, marks and pointer follow at most once a frame.
    let livePending = false;
    root.addEventListener('svgdeck:live', () => {
      if (applying || livePending || !(speaker || linked)) return;
      livePending = true;
      setTimeout(() => { livePending = false; send(speaker ? audience : (token ? window.opener : null), 'live', api.live); }, 16);
    });
    window.addEventListener('message', e => {
      const expected = speaker ? audience : (token ? window.opener : null);
      if (!expected || e.source !== expected || (!opaqueOrigin && e.origin !== location.origin) || e.data?.svgdeck !== session) return;
      if (e.data.type === 'ready' && speaker) { audienceReady = true; refreshStatus(); send(audience, 'state', snapshot()); send(audience, 'live', api.live); return; }
      // An audience window that is reused without reloading (same address) is asked to report in.
      if (e.data.type === 'hello' && !speaker) { send(window.opener, 'ready'); return; }
      if (e.data.type === 'live') { api.setLive(e.data.value); return; }
      if (e.data.type !== 'state') return;
      const v = e.data.value;
      if (!v || !Number.isInteger(v.index) || !Number.isInteger(v.step) || typeof v.blank !== 'boolean') return;
      linked = true;
      applying = true;
      try { api.show(v.index, v.step); api.setBlank(v.blank); } finally { applying = false; }
      update();
    });
    // True while this window is one of a synchronized speaker/audience pair.
    api.paired = () => speaker ? !!audience && !audience.closed && audienceReady : linked;
    api.ready.then(() => { if (!speaker && token) send(window.opener, 'ready'); });
    if (!speaker) return;

    document.body.classList.add('speaker-mode');
    const panel = document.createElement('aside'); panel.className = 'speaker-panel';
    panel.setAttribute('aria-label', 'Speaker view');
    const heading = document.createElement('h1'); heading.textContent = 'Speaker view'; panel.append(heading);
    const controls = document.createElement('div'); controls.className = 'speaker-actions'; panel.append(controls);
    const button = (name, fn) => { const b = document.createElement('button'); b.textContent = name; b.onclick = fn; controls.append(b); return b; };
    const connection = document.createElement('p'); connection.className = 'speaker-connection';
    button('Open audience window', () => {
      if (audience && !audience.closed) { audience.focus(); return; }
      const url = new URL(location.href); url.searchParams.delete('speaker'); url.searchParams.set('session', session);
      // A named target: after this window is reloaded, the audience window that is
      // still open is found again instead of a second one opening.
      audienceReady = false;
      audience = window.open(url.href, 'svgdeck-audience-' + session);
      send(audience, 'hello');
      refreshStatus();
      connection.textContent = audience ? 'Move the audience window to your presentation screen.' : 'Popup blocked. Allow popups, then try again.';
    });
    button('Previous', api.prev); button('Next', api.next);
    const blank = button('Blank audience', () => api.setBlank(!api.state.blank));
    const board = button('Board', () => api.setBoard(!api.live.board));
    root.addEventListener('svgdeck:live', () => { board.textContent = api.live.board ? 'Back to slides' : 'Board'; });
    const status = document.createElement('p'); status.className = 'speaker-status'; status.setAttribute('role', 'status');
    refreshStatus = () => {
      const open = !!audience && !audience.closed;
      status.dataset.connected = String(open && audienceReady);
      status.textContent = 'Audience window: ' + (!open ? 'disconnected' : audienceReady ? 'connected' : 'connecting');
    };
    const counter = document.createElement('p'); panel.append(counter, status, connection);
    const clock = document.createElement('output'); clock.setAttribute('aria-label', 'Elapsed time'); clock.className = 'speaker-timer'; panel.append(clock);
    let started = Date.now(), elapsed = 0, running = true;
    const timer = () => { const seconds = Math.floor((elapsed + (running ? Date.now() - started : 0)) / 1000); clock.textContent = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; };
    const pause = button('Pause timer', () => { if (running) elapsed += Date.now() - started; else started = Date.now(); running = !running; pause.textContent = running ? 'Pause timer' : 'Resume timer'; timer(); });
    button('Reset timer', () => { elapsed = 0; started = Date.now(); timer(); });
    const notesTitle = document.createElement('h2'); notesTitle.textContent = 'Notes';
    const notes = document.createElement('div'); notes.className = 'speaker-notes';
    const nextTitle = document.createElement('h2'); nextTitle.textContent = 'Next slide';
    const next = document.createElement('div'); next.className = 'speaker-next';
    panel.append(notesTitle, notes, nextTitle, next);
    document.body.append(panel);
    let nextIndex = -2;
    update = () => {
      const index = api.state.index;
      counter.textContent = `Slide ${index + 1} of ${api.count} · Build ${api.state.step}`;
      blank.textContent = api.state.blank ? 'Show audience' : 'Blank audience';
      notes.textContent = deck.slides[index]?.notes || 'No notes for this slide.';
      if (nextIndex === index) return;
      nextIndex = index; next.replaceChildren();
      if (!deck.slides[index + 1]) { next.textContent = 'End of presentation'; return; }
      let svg;
      try { svg = parseSlide(deck.slides[index + 1].svg); } catch (e) { next.textContent = `Slide ${index + 2} could not be loaded`; return; }
      rewrite(svg, `speaker-next-${index}-`, new URL(options.slideBase || 'slides/', document.baseURI));
      svg.removeAttribute('width'); svg.removeAttribute('height');
      svg.style.aspectRatio = `${size[0]} / ${size[1]}`;
      next.append(document.importNode(svg, true));
    };
    const interval = setInterval(() => { timer(); if (audience?.closed) { connection.textContent = 'Audience window closed. Open it again to reconnect.'; audience = null; audienceReady = false; }
      if (audience && !audienceReady) send(audience, 'hello');
      refreshStatus();
    }, 500);
    window.addEventListener('pagehide', () => clearInterval(interval));
    new ResizeObserver(() => window.dispatchEvent(new Event('resize'))).observe(root);
    api.ready.then(update); timer(); refreshStatus();
  };
})();
