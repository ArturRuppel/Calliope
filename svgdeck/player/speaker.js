/* Speaker view: the slide to touch, the next one to see, a clock, and the
   buttons, beside a separate audience window (or screen). Included in offline
   exports. The player's own icon bar stays out of this page: everything a
   speaker does is here. */
(function () {
  "use strict";
  window.SvgDeckSpeaker = function (root, deck, api, options, rewrite, parseSlide) {
    const params = new URL(location.href).searchParams;
    const speaker = params.get('speaker') === '1';
    const size = deck.size || [1920, 1080];
    const token = params.get('session');
    // In the iPad app a second screen stands in for the second window: messages
    // travel through the native shell, which also says whether a screen is attached.
    const native = window.svgdeckNative || null;
    let audience = null, audienceReady = false, applying = false, linked = false;
    let displayAttached = false;  // native only: a screen is there to show the audience view on
    let refreshStatus = () => {};
    const opaqueOrigin = location.protocol === 'file:' || location.origin === 'null';
    const targetOrigin = opaqueOrigin ? '*' : location.origin;
    const session = token || Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('');
    if (speaker && !token) {
      // Keep the session in the address, so reloading this window keeps it.
      try { const url = new URL(location.href); url.searchParams.set('session', session); history.replaceState(null, '', url.href); } catch (e) { /* session lasts until reload */ }
    }
    const send = (win, type, value) => {
      const message = {svgdeck: session, type, value};
      if (native) { native.postMessage(message); return; }
      if (win && !win.closed) win.postMessage(message, targetOrigin);
    };
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
    const receive = data => {
      if (data.type === 'display' && speaker) {
        // From the native shell: a screen was attached or removed.
        displayAttached = !!data.value;
        audience = displayAttached ? native : null; audienceReady = false;
        refreshStatus(); return;
      }
      if (data.type === 'ready' && speaker) { if (native) audience = native; audienceReady = true; refreshStatus(); send(audience, 'state', snapshot()); send(audience, 'live', api.live); return; }
      // In the app, two audience copies (iPad and external display) share a session
      // and drive each other: the one that hears the other arrive sends its state.
      if (data.type === 'ready' && !speaker) {
        if (native) { linked = true; send(null, 'state', snapshot()); send(null, 'live', api.live); }
        return;
      }
      // An audience window that is reused without reloading (same address) is asked to report in.
      if (data.type === 'hello' && !speaker) { send(window.opener, 'ready'); return; }
      if (data.type === 'live') { api.setLive(data.value); return; }
      if (data.type !== 'state') return;
      const v = data.value;
      if (!v || !Number.isInteger(v.index) || !Number.isInteger(v.step) || typeof v.blank !== 'boolean') return;
      linked = true;
      applying = true;
      try { api.show(v.index, v.step); api.setBlank(v.blank); } finally { applying = false; }
      update();
    };
    window.addEventListener('message', e => {
      const expected = speaker ? audience : (token ? window.opener : null);
      if (native || !expected || e.source !== expected || (!opaqueOrigin && e.origin !== location.origin) || e.data?.svgdeck !== session) return;
      receive(e.data);
    });
    if (native) window.addEventListener('svgdeck:native', e => { if (e.detail?.svgdeck === session) receive(e.detail); });
    // True while this window is one of a synchronized speaker/audience pair.
    api.paired = () => speaker ? !!audience && !audience.closed && audienceReady : linked;
    api.ready.then(() => { if (!speaker && token) send(window.opener, 'ready'); });
    if (!speaker) return;

    // --- the panel -------------------------------------------------------------
    document.body.classList.add('speaker-mode');
    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const panel = el('aside', 'speaker-panel');
    panel.setAttribute('aria-label', 'Speaker view');

    // Where we are, and the clock.
    const head = el('div', 'speaker-head');
    const counter = el('p', 'speaker-counter');
    const clockBox = el('div', 'speaker-timer');
    const clock = document.createElement('output');
    clock.setAttribute('aria-label', 'Elapsed time');
    const small = (name, fn) => { const b = el('button', 'speaker-small', name); b.type = 'button'; b.onclick = fn; return b; };
    let started = Date.now(), elapsed = 0, running = true;
    const timer = () => {
      const seconds = Math.floor((elapsed + (running ? Date.now() - started : 0)) / 1000);
      clock.textContent = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
    };
    const pause = small('Pause timer', () => {
      if (running) elapsed += Date.now() - started; else started = Date.now();
      running = !running; pause.textContent = running ? 'Pause timer' : 'Resume timer';
      clock.classList.toggle('paused', !running); timer();
    });
    const reset = small('Reset timer', () => { elapsed = 0; started = Date.now(); timer(); });
    clockBox.append(clock, pause, reset);
    head.append(counter, clockBox);

    // The other half: a screen in the app, a window in a browser.
    const status = el('p', 'speaker-status');
    status.setAttribute('role', 'status');
    const statusText = el('span');
    const open = el('button', 'speaker-small', native ? 'Show on the external display' : 'Open audience window');
    open.type = 'button';
    open.onclick = () => {
      if (!native && audience && !audience.closed) { audience.focus(); return; }
      const url = new URL(location.href); url.searchParams.delete('speaker'); url.searchParams.set('session', session);
      audienceReady = false;
      if (native) { send(null, 'open', url.href); return; }
      // A named target: after this window is reloaded, the audience window that is
      // still open is found again instead of a second one opening.
      audience = window.open(url.href, 'svgdeck-audience-' + session);
      if (!audience) statusText.textContent = 'Popup blocked. Allow popups, then try again.';
      send(audience, 'hello');
      refreshStatus();
    };
    status.append(statusText, open);
    refreshStatus = () => {
      const present = !!audience && !audience.closed;
      const connected = present && audienceReady;
      status.dataset.connected = String(connected);
      let text;
      if (native) text = !displayAttached ? 'No external display.' : connected ? 'On the external display.' : 'External display: connecting…';
      else text = !present ? 'No audience window.' : connected ? 'Audience window open. Move it to the presentation screen.' : 'Audience window: connecting…';
      statusText.textContent = text;
      open.hidden = connected || (native && !displayAttached);
    };

    // The slide after this one.
    const nextBox = el('section', 'speaker-next-box');
    nextBox.append(el('h2', null, 'Next'));
    const next = el('div', 'speaker-next');
    next.style.aspectRatio = `${size[0]} / ${size[1]}`;
    nextBox.append(next);

    // The buttons. Turning slides is also a tap on the slide; these are for a
    // hand that holds the Pencil.
    const actions = el('div', 'speaker-actions');
    const button = (name, fn, className = '') => {
      const b = el('button', className, name); b.type = 'button'; b.onclick = fn; actions.append(b); return b;
    };
    button('Previous', api.prev, 'speaker-turn');
    button('Next', api.next, 'speaker-turn');
    const blank = button('Blank audience', () => api.setBlank(!api.state.blank));
    const board = button('Board', () => api.setBoard(!api.live.board));
    button('Overview', () => api.setOverview(true));
    const clear = button('Clear marks', api.clearLive);
    const boardTools = el('div', 'speaker-board-tools');
    for (const [name, fn] of [['Undo', api.boardUndo], ['Wipe', api.boardWipe]]) {
      const b = el('button', null, name); b.type = 'button'; b.onclick = fn; boardTools.append(b);
    }
    const foot = el('div', 'speaker-foot');
    if (options.editorUrl) {
      const back = el('a', 'speaker-small', 'Back to editor');
      back.addEventListener('click', () => { back.href = options.editorUrl + `#${api.state.index + 1}`; });
      back.href = options.editorUrl;
      foot.append(back);
    }
    // The buttons sit at the bottom, where a thumb reaches them; the board's join them.
    const bottom = el('div', 'speaker-bottom');
    bottom.append(boardTools, actions, foot);
    panel.append(head, status, nextBox, bottom);
    document.body.append(panel);

    const refreshLive = () => {
      const onBoard = api.live.board;
      board.textContent = onBoard ? 'Back to slides' : 'Board';
      board.setAttribute('aria-pressed', String(onBoard));
      boardTools.classList.toggle('on', onBoard);
      clear.disabled = onBoard || !(api.live.ink.length || api.live.view.k > 1 || api.live.pointer);
    };
    root.addEventListener('svgdeck:live', refreshLive);
    let nextIndex = -2;
    update = () => {
      const index = api.state.index, slide = api.slides[index];
      counter.replaceChildren(`${index + 1} / ${api.count}`,
        slide?.maxStep ? el('small', null, ` · build ${api.state.step} of ${slide.maxStep}`) : '');
      blank.textContent = api.state.blank ? 'Show audience' : 'Blank audience';
      blank.setAttribute('aria-pressed', String(api.state.blank));
      refreshLive();
      if (nextIndex === index) return;
      nextIndex = index; next.replaceChildren();
      if (!deck.slides[index + 1]) { next.append(el('p', 'speaker-end', 'End of presentation')); return; }
      let svg;
      try { svg = parseSlide(deck.slides[index + 1].svg); } catch (e) { next.append(el('p', 'speaker-end', `Slide ${index + 2} could not be loaded`)); return; }
      rewrite(svg, `speaker-next-${index}-`, new URL(options.slideBase || 'slides/', document.baseURI));
      svg.removeAttribute('width'); svg.removeAttribute('height');
      svg.style.aspectRatio = `${size[0]} / ${size[1]}`;
      next.append(document.importNode(svg, true));
    };
    const interval = setInterval(() => {
      timer();
      if (audience?.closed) { audience = null; audienceReady = false; }
      if (audience && !audienceReady) send(audience, 'hello');
      refreshStatus();
    }, 500);
    window.addEventListener('pagehide', () => clearInterval(interval));
    new ResizeObserver(() => window.dispatchEvent(new Event('resize'))).observe(root);
    api.ready.then(update); timer(); refreshStatus();
    if (native) send(null, 'display');  // is a screen attached? The answer arrives as a 'display' message.
  };
})();
