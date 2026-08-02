/* ============================================================
   BETA — CONSOLE TV

   Thirteen channels on a 1965 set. A channel holds either an
   uploaded file (played by a <video>) or a YouTube video (played
   by an IFrame API player); empty channels show static.

   Everything here is tv-* namespaced. In particular this file
   must not redeclare `$` or `originalShowScreen` — videotest.js
   already owns those at global scope, and a second `const` with
   the same name is a SyntaxError that would kill the whole file.
   ============================================================ */
const TV = {
  channels: 13,
  staticFps: 15,      // chunky and cheap; the tube hides the low frame rate
  burstMs: 380,       // static between channels, long enough to mask loading
  osdMs: 1900,
  warmupMs: 500
};

const TV_STEP = 360 / TV.channels;

let tvOn = false;
let tvChannel = 1;
let tvEntries = {};        // "3" -> { type, ... }
let tvStaticTimer = null;
let tvOsdTimer = null;
let tvBurstTimer = null;
let tvDialAngle = 0;       // accumulates so repeated clicks keep turning one way
let tvDragging = false;
let tvAudioCtx = null;

let ytPlayer = null;
let ytState = "idle";      // idle | loading | ready
let ytPending = null;      // entry waiting for the API to finish loading

const tvGet = id => document.getElementById(id);

const tvScreen  = tvGet("tv-screen");
const tvVideo   = tvGet("tv-video");
const tvYtHold  = tvGet("tv-yt-holder");
const tvCanvas  = tvGet("tv-static");
const tvMsg     = tvGet("tv-msg");
const tvOsd     = tvGet("tv-osd");
const tvWarmup  = tvGet("tv-warmup");
const tvDial    = tvGet("tv-dial");
const tvRing    = tvGet("tv-dial-ring");
const tvPower   = tvGet("tv-power");

/* Low-resolution noise stretched over the tube: a full-resolution buffer
   costs ~40x more pixels a frame for grain nobody can distinguish. */
tvCanvas.width = 200;
tvCanvas.height = 150;

function tvToast(text){
  const toast = tvGet("toast");
  toast.textContent = text;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2200);
}

/* A synthesized detent click — a short filtered blip. Cheaper than shipping
   an audio file, and the context is created lazily because browsers refuse
   to start one before the first user gesture. */
function tvClickSound(){
  try {
    if (!tvAudioCtx){
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      tvAudioCtx = new Ctx();
    }
    const now = tvAudioCtx.currentTime;
    const osc = tvAudioCtx.createOscillator();
    const gain = tvAudioCtx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(1400, now);
    osc.frequency.exponentialRampToValueAtTime(320, now + 0.045);
    gain.gain.setValueAtTime(0.055, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);
    osc.connect(gain).connect(tvAudioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.06);
  } catch(e){}
}

/* ---------- static ---------- */
function tvDrawStatic(){
  const ctx = tvCanvas.getContext("2d");
  const frame = ctx.createImageData(tvCanvas.width, tvCanvas.height);
  const data = frame.data;
  for (let i = 0; i < data.length; i += 4){
    const v = (Math.random() * 255) | 0;
    data[i] = data[i+1] = data[i+2] = v;
    data[i+3] = 255;
  }
  ctx.putImageData(frame, 0, 0);
}

function tvStartStatic(){
  tvCanvas.classList.add("on");
  if (tvStaticTimer) return;
  tvDrawStatic();
  tvStaticTimer = setInterval(tvDrawStatic, 1000 / TV.staticFps);
}

// Always paired with hiding the canvas: a noise loop left running on a screen
// nobody is looking at is pure battery drain on a phone.
function tvStopStatic(){
  clearInterval(tvStaticTimer);
  tvStaticTimer = null;
  tvCanvas.classList.remove("on");
}

function tvShowMsg(text){
  tvMsg.textContent = text;
  tvMsg.classList.toggle("on", !!text);
}

function tvShowOsd(text){
  tvOsd.textContent = text;
  tvOsd.classList.add("on");
  clearTimeout(tvOsdTimer);
  tvOsdTimer = setTimeout(() => tvOsd.classList.remove("on"), TV.osdMs);
}

/* ---------- YouTube ---------- */
function tvLoadYouTubeApi(){
  if (ytState !== "idle") return;
  ytState = "loading";
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  tag.onerror = () => {
    ytState = "idle";
    ytPending = null;
    if (tvOn) { tvStartStatic(); tvShowMsg("NO SIGNAL"); }
  };
  document.head.appendChild(tag);
}

// The IFrame API calls this by name once it has loaded; it has to be global.
function onYouTubeIframeAPIReady(){
  ytPlayer = new YT.Player("tv-yt", {
    host: "https://www.youtube-nocookie.com",
    width: "100%",
    height: "100%",
    playerVars: {
      controls: 0,        // no scrubber, no chrome
      rel: 0,
      iv_load_policy: 3,  // no annotation cards
      disablekb: 1,
      playsinline: 1,
      modestbranding: 1,
      fs: 0
    },
    events: {
      onReady: () => {
        ytState = "ready";
        if (ytPending){
          const entry = ytPending;
          ytPending = null;
          tvPlayYouTube(entry);
        }
      },
      // 101 and 150 both mean the owner disabled embedding. Nothing to do but
      // admit the channel is dead rather than leave a broken frame on screen.
      onError: e => {
        const dead = e && (e.data === 101 || e.data === 150);
        tvYtHold.classList.remove("on");
        tvStartStatic();
        tvShowMsg(dead ? "EMBEDDING BLOCKED" : "NO SIGNAL");
      },
      onStateChange: e => {
        // Channels run continuously. The loop playerVar only applies to the
        // video the player was built with, so looping is done by hand here.
        if (e.data === YT.PlayerState.ENDED){
          const entry = tvEntries[String(tvChannel)];
          try {
            ytPlayer.seekTo(entry && entry.start ? entry.start : 0);
            ytPlayer.playVideo();
          } catch(err){}
        }
        if (e.data === YT.PlayerState.PLAYING){
          tvStopStatic();
          tvShowMsg("");
        }
      }
    }
  });
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function tvPlayYouTube(entry){
  if (ytState !== "ready"){
    ytPending = entry;
    tvLoadYouTubeApi();
    tvStartStatic();           // static covers the wait for the API
    return;
  }
  tvYtHold.classList.add("on");
  try {
    ytPlayer.loadVideoById({ videoId: entry.videoId, startSeconds: entry.start || 0 });
    ytPlayer.unMute();
    ytPlayer.playVideo();
  } catch(e){
    tvStartStatic();
    tvShowMsg("NO SIGNAL");
  }
}

/* ---------- tuning ---------- */
function tvStopSources(){
  try { tvVideo.pause(); } catch(e){}
  tvVideo.removeAttribute("src");
  tvVideo.load();               // drops the buffered stream instead of leaving it resident
  tvVideo.classList.remove("on");
  if (ytPlayer && ytState === "ready"){
    try { ytPlayer.stopVideo(); } catch(e){}
  }
  ytPending = null;
  tvYtHold.classList.remove("on");
}

function tvTune(){
  tvStopSources();
  tvShowMsg("");

  if (!tvOn) return;

  const entry = tvEntries[String(tvChannel)];

  if (!entry){
    tvStartStatic();
    tvShowMsg("NO SIGNAL");
    return;
  }

  if (entry.type === "youtube"){
    tvPlayYouTube(entry);
    return;
  }

  tvStopStatic();
  tvVideo.classList.add("on");
  tvVideo.loop = true;
  tvVideo.src = "/media/" + entry.file;
  const played = tvVideo.play();
  if (played && played.catch){
    // Autoplay should be allowed — every tune starts from a click — but if a
    // browser disagrees, a muted picture beats a black screen.
    played.catch(() => {
      tvVideo.muted = true;
      tvVideo.play().catch(() => {
        tvStartStatic();
        tvShowMsg("NO SIGNAL");
      });
    });
  }
}

// The burst does double duty: it sells the channel change and it hides
// however long the next source takes to start.
function tvTuneWithBurst(){
  if (!tvOn) return;
  tvStopSources();
  tvShowMsg("");
  tvStartStatic();
  clearTimeout(tvBurstTimer);
  tvBurstTimer = setTimeout(tvTune, TV.burstMs);
}

/* ---------- dial ---------- */
function tvRenderTicks(){
  tvRing.querySelectorAll(".tv-dial-tick").forEach(el => el.remove());
  for (let i = 0; i < TV.channels; i++){
    const tick = document.createElement("span");
    tick.className = "tv-dial-tick";
    tick.dataset.ch = String(i + 1);
    tick.textContent = String(i + 1);
    tvRing.appendChild(tick);
  }
  tvLayoutTicks();
  tvMarkTicks();
}

// Radius depends on the rendered ring, which changes at the mobile breakpoint,
// so this reruns on resize rather than baking in a pixel value.
function tvLayoutTicks(){
  const radius = tvRing.clientWidth * 0.38;
  tvRing.querySelectorAll(".tv-dial-tick").forEach((tick, i) => {
    const angle = i * TV_STEP;
    tick.style.transform =
      "rotate(" + angle + "deg) translateY(" + (-radius) + "px) rotate(" + (-angle) + "deg)";
  });
}

function tvMarkTicks(){
  tvRing.querySelectorAll(".tv-dial-tick").forEach(tick => {
    const n = Number(tick.dataset.ch);
    tick.classList.toggle("active", n === tvChannel);
    tick.classList.toggle("has", !!tvEntries[String(n)]);
  });
}

function tvSetChannel(n, opts){
  const options = opts || {};
  const next = ((n - 1 + TV.channels) % TV.channels) + 1;
  const changed = next !== tvChannel;
  tvChannel = next;

  if (options.absoluteAngle != null){
    tvDialAngle = options.absoluteAngle;
  } else {
    // Advance rather than snap to (channel * step): the knob should keep
    // rotating the same direction on 13 -> 1 instead of unwinding 12 detents.
    tvDialAngle += TV_STEP;
  }
  tvDial.style.transform = "rotate(" + tvDialAngle + "deg)";

  tvDial.setAttribute("aria-valuenow", String(tvChannel));
  tvDial.setAttribute("aria-valuetext", "Channel " + tvChannel);
  tvMarkTicks();

  if (options.silent) return;
  tvClickSound();
  if (tvOn){
    tvShowOsd("CH " + tvChannel);
    if (changed || options.force) tvTuneWithBurst();
  }
}

function tvNudge(delta){
  const target = ((tvChannel - 1 + delta + TV.channels) % TV.channels) + 1;
  if (delta > 0){
    tvSetChannel(target);
  } else {
    tvDialAngle -= TV_STEP * 2; // offset the +1 step tvSetChannel always adds
    tvSetChannel(target);
  }
}

tvDial.addEventListener("click", () => {
  if (tvDragging) return;   // the pointerup that ends a drag also fires a click
  tvNudge(1);
});

tvDial.addEventListener("keydown", e => {
  if (e.key === "ArrowUp" || e.key === "ArrowRight"){ e.preventDefault(); tvNudge(1); }
  if (e.key === "ArrowDown" || e.key === "ArrowLeft"){ e.preventDefault(); tvNudge(-1); }
});

/* Free rotation that snaps to the nearest detent, so the knob can also be
   spun straight to a channel instead of clicked through every one. */
(function initDialDrag(){
  let startAngle = 0;
  let startDial = 0;
  let moved = false;

  function angleFrom(e){
    const box = tvDial.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    return Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
  }

  tvDial.addEventListener("pointerdown", e => {
    startAngle = angleFrom(e);
    startDial = tvDialAngle;
    moved = false;
    tvDragging = false;
    tvDial.setPointerCapture(e.pointerId);
    tvDial.classList.add("dragging");
  });

  tvDial.addEventListener("pointermove", e => {
    if (!tvDial.hasPointerCapture(e.pointerId)) return;
    let delta = angleFrom(e) - startAngle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    // A few degrees of slop keeps an ordinary click from registering as a drag.
    if (Math.abs(delta) > 6) { moved = true; tvDragging = true; }
    if (!moved) return;
    tvDialAngle = startDial + delta;
    tvDial.style.transform = "rotate(" + tvDialAngle + "deg)";
  });

  function endDrag(e){
    if (!tvDial.hasPointerCapture(e.pointerId)) return;
    tvDial.releasePointerCapture(e.pointerId);
    tvDial.classList.remove("dragging");
    if (!moved) return;

    const detent = Math.round(tvDialAngle / TV_STEP);
    const snapped = detent * TV_STEP;
    const channel = ((detent % TV.channels) + TV.channels) % TV.channels + 1;
    const changed = channel !== tvChannel;
    tvSetChannel(channel, { absoluteAngle: snapped, silent: true });
    tvClickSound();
    if (tvOn){
      tvShowOsd("CH " + tvChannel);
      if (changed) tvTuneWithBurst();
    }
    // Cleared after the click event that follows pointerup has been swallowed.
    setTimeout(() => { tvDragging = false; }, 0);
  }

  tvDial.addEventListener("pointerup", endDrag);
  tvDial.addEventListener("pointercancel", endDrag);
})();

window.addEventListener("resize", tvLayoutTicks);

/* ---------- power ---------- */
function tvPowerOn(){
  tvOn = true;
  tvPower.setAttribute("aria-pressed", "true");
  tvWarmup.classList.remove("collapse");
  void tvWarmup.offsetWidth;         // restart the animation rather than reuse the finished one
  tvWarmup.classList.add("warm");
  tvClickSound();
  tvShowOsd("CH " + tvChannel);
  setTimeout(() => { if (tvOn) tvTune(); }, TV.warmupMs * 0.45);
}

function tvPowerOff(silent){
  tvOn = false;
  tvPower.setAttribute("aria-pressed", "false");
  clearTimeout(tvBurstTimer);
  tvStopSources();
  tvStopStatic();
  tvShowMsg("");
  tvOsd.classList.remove("on");
  tvWarmup.classList.remove("warm");
  if (!silent){
    void tvWarmup.offsetWidth;
    tvWarmup.classList.add("collapse");
    tvClickSound();
  } else {
    tvWarmup.classList.remove("collapse");
  }
}

tvPower.addEventListener("click", () => {
  if (tvOn) tvPowerOff(false); else tvPowerOn();
});

/* ---------- channel data ---------- */
async function tvLoadChannels(){
  try {
    const res = await fetch("/api/channels");
    const data = await res.json();
    if (data && data.ok) tvEntries = data.channels || {};
  } catch(e){
    tvEntries = {};
  }
  tvMarkTicks();
  tvRenderList();
  tvRenderSelect();
}

function tvEntryLabel(entry){
  if (!entry) return "";
  if (entry.type === "youtube") return entry.title || ("YouTube · " + entry.videoId);
  return entry.originalName || entry.file;
}

/* ---------- program channels modal ---------- */
const tvModal    = tvGet("tv-modal");
const tvSelect   = tvGet("tv-ch-select");
const tvList     = tvGet("tv-ch-list");
const tvModalMsg = tvGet("tv-modal-msg");
const tvFile     = tvGet("tv-file");
const tvProgress = tvGet("tv-progress");
const tvBar      = tvGet("tv-progress-bar");
const tvYtUrl    = tvGet("tv-yt-url");
const tvYtPrev   = tvGet("tv-yt-preview");
const tvYtThumb  = tvGet("tv-yt-thumb");
const tvYtTitle  = tvGet("tv-yt-title");

function tvSetMsg(text, kind){
  tvModalMsg.textContent = text;
  tvModalMsg.className = "modal-msg" + (kind ? " " + kind : "");
}

function tvRenderSelect(){
  const keep = tvSelect.value;
  tvSelect.innerHTML = "";
  for (let n = 1; n <= TV.channels; n++){
    const entry = tvEntries[String(n)];
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = "Channel " + n + (entry ? " — " + tvEntryLabel(entry) : " — empty");
    tvSelect.appendChild(opt);
  }
  tvSelect.value = keep || String(tvChannel);
}

function tvRenderList(){
  tvList.innerHTML = "";
  const used = Object.keys(tvEntries).map(Number).sort((a, b) => a - b);
  if (!used.length){
    const li = document.createElement("li");
    li.className = "ch-empty";
    li.textContent = "Nothing programmed yet — every channel is static.";
    tvList.appendChild(li);
    return;
  }
  used.forEach(n => {
    const entry = tvEntries[String(n)];
    const li = document.createElement("li");
    li.className = "ch-row";

    const num = document.createElement("span");
    num.className = "ch-num";
    num.textContent = "CH " + n;

    const name = document.createElement("span");
    name.className = "ch-name";
    name.textContent = tvEntryLabel(entry);
    name.title = tvEntryLabel(entry);

    const kind = document.createElement("span");
    kind.className = "ch-kind";
    kind.textContent = entry.type === "youtube" ? "YouTube" : "File";

    const clear = document.createElement("button");
    clear.className = "ch-clear";
    clear.type = "button";
    clear.textContent = "×";
    clear.title = "Clear channel " + n;
    clear.addEventListener("click", () => tvClearChannel(n));

    li.append(num, name, kind, clear);
    tvList.appendChild(li);
  });
}

// Re-tune only when the channel currently on screen was the one that changed.
function tvAfterChange(n){
  tvMarkTicks();
  tvRenderList();
  tvRenderSelect();
  if (tvOn && Number(n) === tvChannel) tvTuneWithBurst();
}

async function tvClearChannel(n){
  try {
    const res = await fetch("/api/channels/" + n, { method: "DELETE" });
    const data = await res.json();
    if (!data.ok) return tvSetMsg("Couldn't clear that channel.", "err");
    delete tvEntries[String(n)];
    tvSetMsg("Channel " + n + " cleared.", "ok");
    tvAfterChange(n);
  } catch(e){
    tvSetMsg("Couldn't reach the server.", "err");
  }
}

const TV_UPLOAD_ERRORS = {
  "too-large": "That file is over the 500 MB limit. Put it on YouTube and paste the link instead.",
  "not-video": "That doesn't look like a video file.",
  "no-file": "Pick a file first.",
  "bad-channel": "Pick a channel between 1 and 13."
};

tvGet("tv-do-upload").addEventListener("click", () => {
  const file = tvFile.files && tvFile.files[0];
  if (!file) return tvSetMsg("Pick a file first.", "err");
  const n = tvSelect.value;

  // XHR rather than fetch purely for upload progress — fetch still can't
  // report it, and a 500 MB upload with no feedback looks like a hang.
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/channels/" + n + "/video");

  tvProgress.hidden = false;
  tvBar.style.width = "0%";
  tvSetMsg("Uploading…");

  xhr.upload.addEventListener("progress", e => {
    if (!e.lengthComputable) return;
    tvBar.style.width = Math.round((e.loaded / e.total) * 100) + "%";
  });

  xhr.addEventListener("load", () => {
    tvProgress.hidden = true;
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch(e){}
    if (!data.ok){
      return tvSetMsg(TV_UPLOAD_ERRORS[data.error] || "Upload failed.", "err");
    }
    tvEntries[String(n)] = data.entry;
    tvFile.value = "";
    tvSetMsg("Channel " + n + " is programmed.", "ok");
    tvAfterChange(n);
  });

  xhr.addEventListener("error", () => {
    tvProgress.hidden = true;
    tvSetMsg("Upload failed — check the connection.", "err");
  });

  const form = new FormData();
  form.append("video", file);
  xhr.send(form);
});

/* Mirrors the server's parser so the thumbnail can appear the moment a link
   is pasted, without a round trip. */
function tvParseYouTubeId(input){
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
  } catch(e){ return null; }
  const host = url.hostname.replace(/^(www|m)\./, "");
  let id = null;
  if (host === "youtu.be"){
    id = url.pathname.slice(1).split("/")[0];
  } else if (host === "youtube.com" || host === "youtube-nocookie.com"){
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const match = url.pathname.match(/^\/(?:embed|shorts|v|live)\/([^/?#]+)/);
      if (match) id = match[1];
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

function tvPreviewYouTube(){
  const id = tvParseYouTubeId(tvYtUrl.value);
  if (!id){
    tvYtPrev.hidden = true;
    return;
  }
  tvYtThumb.src = "https://img.youtube.com/vi/" + id + "/mqdefault.jpg";
  tvYtTitle.textContent = "Checking…";
  tvYtPrev.hidden = false;

  // oEmbed usually allows cross-origin reads, but it isn't guaranteed — the
  // thumbnail alone already confirms the right video, so a failure is quiet.
  fetch("https://www.youtube.com/oembed?format=json&url=" +
        encodeURIComponent("https://www.youtube.com/watch?v=" + id))
    .then(r => r.ok ? r.json() : null)
    .then(data => { tvYtTitle.textContent = (data && data.title) || "Ready to assign."; })
    .catch(() => { tvYtTitle.textContent = "Ready to assign."; });
}

tvYtUrl.addEventListener("input", tvPreviewYouTube);
tvYtUrl.addEventListener("paste", () => setTimeout(tvPreviewYouTube, 0));

tvGet("tv-do-yt").addEventListener("click", async () => {
  const url = tvYtUrl.value.trim();
  if (!url) return tvSetMsg("Paste a YouTube link first.", "err");
  const n = tvSelect.value;
  tvSetMsg("Saving…");
  try {
    const res = await fetch("/api/channels/" + n + "/youtube", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!data.ok){
      return tvSetMsg(data.error === "bad-url"
        ? "That isn't a YouTube link we recognise."
        : "Couldn't save that channel.", "err");
    }
    tvEntries[String(n)] = data.entry;
    tvYtUrl.value = "";
    tvYtPrev.hidden = true;
    tvSetMsg("Channel " + n + " is programmed.", "ok");
    tvAfterChange(n);
  } catch(e){
    tvSetMsg("Couldn't reach the server.", "err");
  }
});

document.querySelectorAll("[data-tv-tab]").forEach(tab => {
  tab.addEventListener("click", () => {
    const name = tab.dataset.tvTab;
    document.querySelectorAll("[data-tv-tab]").forEach(t => {
      const on = t === tab;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", String(on));
    });
    document.querySelectorAll("[data-tv-panel]").forEach(panel => {
      panel.hidden = panel.dataset.tvPanel !== name;
    });
    tvSetMsg("");
  });
});

function tvOpenModal(){
  tvSetMsg("");
  tvRenderSelect();
  tvSelect.value = String(tvChannel);
  tvRenderList();
  tvModal.hidden = false;
}
function tvCloseModal(){
  tvModal.hidden = true;
  tvProgress.hidden = true;
}

tvGet("tv-program").addEventListener("click", tvOpenModal);
tvGet("tv-modal-x").addEventListener("click", tvCloseModal);
tvModal.querySelector("[data-tv-close]").addEventListener("click", tvCloseModal);
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !tvModal.hidden) tvCloseModal();
});

/* ---------- entry / exit ---------- */
document.querySelectorAll(".beta-entry").forEach(el => {
  el.addEventListener("click", () => showScreen("beta"));
});
tvGet("beta-back").addEventListener("click", () => showScreen("landing"));

/* Wrapping showScreen the way videotest.js does. Without this a YouTube
   channel would keep playing audio from a screen that is no longer visible —
   the iframe doesn't care that its section lost the .active class. */
const showScreenBeforeBeta = showScreen;
showScreen = function(name){
  if (name !== "beta"){
    if (tvOn) tvPowerOff(true);
    tvCloseModal();
  }
  showScreenBeforeBeta(name);
  if (name === "beta"){
    tvLoadChannels();
    tvLayoutTicks();
  }
};

tvRenderTicks();
tvSetChannel(1, { silent: true, absoluteAngle: 0 });

/* Matches the #video deep link videotest.js already supports, so the set is
   reachable directly from a bookmark or a link sent to a phone. */
if ((location.hash || "") === "#tv") showScreen("beta");
