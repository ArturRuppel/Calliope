// Trim playback without modifying the source movie or the poster.
export function openMovieTrim(editor, image) {
  if (!image?.hasAttribute("data-video") || document.querySelector("dialog[open]")) return;
  const make = (tag, attrs = {}, text = "") => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    if (text) node.textContent = text;
    return node;
  };
  const dialog = make("dialog", {class:"settings-dialog movie-trim", "aria-labelledby":"movie-trim-title"});
  const header = make("header");
  header.append(make("h2", {id:"movie-trim-title"}, "Trim movie"));
  const close = make("button", {class:"btn", type:"button", "aria-label":"Close"}, "×");
  close.onclick = () => dialog.close(); header.append(close);
  const body = make("div", {class:"settings-body"});
  const video = make("video", {controls:"", playsinline:"", muted:"", preload:"auto", "aria-label":"Movie trim preview"});
  video.muted = true;
  video.src = image.getAttribute("data-video");
  const playback = SvgDeckMovieRange.attach(video, {start:0, end:null}, false);
  const hint = make("p", {class:"hint", role:"status"}, "Loading movie…");
  const fields = {};
  const apply = make("button", {class:"btn primary", type:"button", disabled:""}, "Apply trim");
  const preview = make("button", {class:"btn", type:"button", disabled:""}, "Play excerpt");
  let duration = null;
  function values() { return {start:Number(fields.start.number.value), end:Number(fields.end.number.value)}; }
  function validate() {
    const {start, end} = values();
    const valid = duration !== null && Number.isFinite(start) && Number.isFinite(end) &&
      fields.start.number.value !== "" && fields.end.number.value !== "" && start >= 0 && end > start && end <= duration;
    apply.disabled = preview.disabled = !valid;
    hint.textContent = valid ? `${(end - start).toFixed(2)} seconds selected. Source movie stays unchanged.`
      : duration === null ? "Loading movie…" : "Start must be earlier than end, within the movie’s duration.";
    return valid;
  }
  for (const key of ["start", "end"]) {
    const name = key === "start" ? "Start" : "End";
    const label = make("label", {}, `${name} (seconds)`);
    const number = make("input", {type:"number", min:0, step:"0.01", "aria-label":`${name} time`, disabled:""});
    label.append(number);
    const slider = make("input", {type:"range", min:0, step:"0.01", "aria-label":`${name} time slider`, disabled:""});
    const mark = make("button", {class:"btn", type:"button", disabled:""}, `Use current time as ${key}`);
    const update = source => {
      video.pause();
      if (source === slider) number.value = slider.value;
      else slider.value = number.value;
      if (validate()) { playback.setRange({start:0,end:null}); playback.seek(Number(number.value)); }
    };
    slider.oninput = () => update(slider);
    number.onchange = () => update(number);
    mark.onclick = () => { number.value = Math.min(duration, video.currentTime).toFixed(2); update(number); };
    fields[key] = {number, slider, mark};
    body.append(label, slider, mark);
  }
  video.onloadedmetadata = () => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      hint.textContent = "This movie has no finite duration and cannot be trimmed."; return;
    }
    duration = video.duration;
    const {start,end} = SvgDeckMovieRange.read(image);
    const from = start < duration ? start : 0;
    const to = end > from ? Math.min(end,duration) : duration;
    for (const [key,value] of [["start",from],["end",to]]) {
      const f = fields[key];
      f.number.max = f.slider.max = String(duration);
      f.number.value = f.slider.value = String(value);
      f.number.disabled = f.slider.disabled = f.mark.disabled = false;
    }
    playback.seek(from); validate();
  };
  video.onerror = () => { hint.textContent = "Could not load this movie. Close and try again."; };
  preview.onclick = () => { if (validate()) { playback.setRange(values()); video.play().catch(() => {}); } };
  apply.onclick = () => {
    if (!validate()) return;
    const {start,end} = values();
    editor.change(() => {
      if (start > 0) image.setAttribute("data-video-start", String(start)); else image.removeAttribute("data-video-start");
      if (end < duration) image.setAttribute("data-video-end", String(end)); else image.removeAttribute("data-video-end");
    });
    dialog.close();
  };
  const reset = make("button", {class:"btn", type:"button"}, "Reset to full movie");
  reset.onclick = () => {
    if (duration === null) return;
    fields.start.number.value = fields.start.slider.value = "0";
    fields.end.number.value = fields.end.slider.value = String(duration);
    video.pause(); playback.setRange({start:0,end:null}); validate();
  };
  const cancel = make("button", {class:"btn", type:"button"}, "Cancel"); cancel.onclick = () => dialog.close();
  const buttons = make("div", {class:"buttons"}); buttons.append(preview,reset,cancel,apply);
  body.prepend(video); body.append(hint,buttons); dialog.append(header,body);
  dialog.addEventListener("close", () => { video.pause(); playback.destroy(); video.removeAttribute("src"); video.load(); dialog.remove(); }, {once:true});
  document.body.append(dialog); dialog.showModal();
}
