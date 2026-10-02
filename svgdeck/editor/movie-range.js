// Shared by the editor preview and the offline player (classic script).
(function () {
  "use strict";
  const positive = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  function read(image) {
    return {start: positive(image.getAttribute("data-video-start")),
      end: image.hasAttribute("data-video-end") && Number(image.getAttribute("data-video-end")) > 0
        ? Number(image.getAttribute("data-video-end")) : null};
  }
  function attach(video, initial, loop = true) {
    let range = initial, pending = null, frame = null;
    function bounds() {
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
      const start = range.start < duration ? positive(range.start) : 0;
      const end = range.end > start ? Math.min(range.end, duration) : duration;
      return {start, end};
    }
    // Where a seek to `time` lands.
    function target(time) {
      const {start, end} = bounds();
      // Sync uses source time. Outside a different excerpt, restart that excerpt.
      const trimmed = start > 0 || range.end !== null;
      return trimmed ? (time >= start && time < end ? time : start)
        : Number.isFinite(end) ? time % end : time;
    }
    function seek(time) {
      if (video.readyState < 1) { pending = time; return; }
      const to = target(time);
      try { video.currentTime = to; } catch (e) { pending = to; }
    }
    function check() {
      const {start, end} = bounds();
      if (video.currentTime < start - 0.001) seek(start);
      else if (!video.paused && video.currentTime >= end) {
        if (loop) { seek(start); video.play().catch(() => {}); }
        else { video.pause(); video.currentTime = end; }
      }
    }
    function tick() {
      frame = null;
      check();
      if (!video.paused) frame = requestAnimationFrame(tick);
    }
    function setRange(next) {
      range = next;
      video.loop = loop && range.start === 0 && range.end === null;
      seek(bounds().start);
    }
    const metadata = () => { const time = pending; pending = null; seek(time ?? bounds().start); };
    const play = () => {
      const {start, end} = bounds();
      if (video.currentTime < start || video.currentTime >= end) seek(start);
      if (frame === null) frame = requestAnimationFrame(tick);
    };
    const pause = () => { if (frame !== null) cancelAnimationFrame(frame); frame = null; };
    const ended = () => {
      if (loop && !video.loop) { seek(bounds().start); video.play().catch(() => {}); }
    };
    video.addEventListener("loadedmetadata", metadata);
    video.addEventListener("play", play);
    video.addEventListener("pause", pause);
    video.addEventListener("timeupdate", check);
    video.addEventListener("ended", ended);
    setRange(range);
    return {bounds, target, seek, setRange, destroy() {
      pause();
      for (const [event, fn] of [["loadedmetadata", metadata], ["play", play], ["pause", pause], ["timeupdate", check], ["ended", ended]])
        video.removeEventListener(event, fn);
    }};
  }
  window.SvgDeckMovieRange = {read, attach};
})();
