/* ============================================================
   VIDEO TEST — a real 2-person WebRTC call.

   Deliberately separate from app.js: the scripted "Book trial
   lesson" demo in there is finished and shouldn't be disturbed.
   Every id in here is vt-* namespaced to avoid colliding with
   the demo's call screen (which owns call-timer, captions,
   btn-end-call) — reusing those would silently wire this
   prototype into the travel-fund flow.
   ============================================================ */
const VT = {
  iceServers: [{
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun.cloudflare.com:3478"
    ]
  }],
  media: {
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  }
};

let ws = null;
let pc = null;
let localStream = null;
let mediaPromise = null;   // memoised so concurrent callers share one gUM prompt
let peerPromise = null;    // memoised so the peer is built exactly once
let myRole = null;         // "host" | "guest"
let myCode = null;
let pendingCandidates = [];
let signalChain = Promise.resolve();
let vtTimerInterval = null;
let vtSeconds = 0;
let creating = false;

const $ = id => document.getElementById(id);

function vtToast(text){
  const toast = $("toast");
  toast.textContent = text;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2200);
}

/* ---------- signaling socket ---------- */
function connectSocket(onOpen){
  if (ws && ws.readyState === WebSocket.OPEN){
    onOpen();
    return;
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(proto + "//" + location.host + "/rtc");

  ws.addEventListener("open", onOpen);
  ws.addEventListener("message", ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch(e){ return; }
    handleMessage(msg);
  });
  ws.addEventListener("close", () => {
    // Media is peer-to-peer, so an established call survives a signaling
    // drop — say so quietly rather than tearing the call down.
    if (myCode && pc && pc.connectionState === "connected"){
      setStatus("Lost the signaling server, but the call is still up.");
    } else if (myCode){
      setStatus("Connection to the server dropped.");
    }
  });
  ws.addEventListener("error", () => {
    if (myCode) setStatus("Couldn't reach the signaling server.");
  });
}

function sendWs(msg){
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handleMessage(msg){
  if (msg.t === "created"){
    creating = false;
    $("vt-create").disabled = false;
    myCode = msg.code;
    myRole = "host";
    $("vt-code").textContent = msg.code;
    showScreen("vtcreate");
    $("vt-create-status").textContent = "Waiting for your partner to join…";
    // Ask for the camera now rather than when the partner arrives, so
    // permission problems surface early and the wait isn't a dead screen.
    acquireMedia().then(stream => {
      if (stream) applyStreamToViews();
    });
    return;
  }

  if (msg.t === "joined"){
    myCode = msg.code;
    myRole = "guest";
    enterCall();
    return;
  }

  if (msg.t === "peer-joined"){
    // Host is always the offerer — fixed roles mean no negotiation glare.
    enterCall().then(startOffer);
    // They arrived with no idea what is already on screen here.
    sharePlan();
    return;
  }

  if (msg.t === "lesson"){
    planPoints = normalisePlan(msg.points);
    renderPlan();
    /* Points arriving are the teacher putting something up, so the panel comes
       out to meet them. Either side can tap it away again. */
    if (planPoints.length) setPlanOpen(true);
    return;
  }

  if (msg.t === "signal"){
    // Serialise: two frames arriving back to back would otherwise both
    // enter their awaits and interleave, corrupting the handshake.
    signalChain = signalChain
      .then(() => handleRtcSignal(msg.data))
      .catch(err => console.warn("[vt] signal failed", err));
    return;
  }

  if (msg.t === "peer-left"){
    setStatus("Your partner left the lesson.");
    setRemoteMsg("Your partner left.");
    stopVtTimer();
    closePeer();
    return;
  }

  if (msg.t === "error"){
    creating = false;
    $("vt-create").disabled = false;
    const messages = {
      "not-found": "No lesson with that code. Check it and try again.",
      "full": "That lesson already has two people in it.",
      "bad-code": "That code doesn't look right — it should be 6 digits."
    };
    // Release the camera we may already have taken, or the light stays on.
    teardownMedia();
    myCode = null;
    showJoinError(messages[msg.code] || "Something went wrong.");
    originalShowScreen("vtjoin");
    return;
  }
}

/* ---------- media ---------- */
function acquireMedia(){
  if (!mediaPromise) mediaPromise = requestMedia();
  return mediaPromise;
}

async function requestMedia(){
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    // The API is simply absent outside a secure context — no error to catch.
    const text = "This needs a secure connection. Open the https:// site rather than a local IP address.";
    mediaError(text);
    return null;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia(VT.media);
    return localStream;
  } catch (err){
    const name = err && err.name;
    if (name === "NotFoundError" || name === "OverconstrainedError"){
      // No camera — fall back to audio so the lesson can still happen.
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        vtToast("No camera found — joining with audio only.");
        return localStream;
      } catch (e2){
        mediaError("No camera or microphone available on this device.");
        return null;
      }
    }
    if (name === "NotAllowedError" || name === "SecurityError"){
      mediaError("Camera and microphone access was blocked. Allow it in your browser settings, then try again.");
    } else if (name === "NotReadableError" || name === "AbortError"){
      mediaError("Your camera is in use by another app. Quit that app and try again.");
    } else {
      mediaError("Couldn't access your camera and microphone.");
    }
    return null;
  }
}

function mediaError(text){
  mediaPromise = null;   // let the next attempt re-prompt
  vtToast(text);
  setRemoteMsg(text);
  $("vt-create-status").textContent = text;
}

/* ---------- space ranger filter ----------
   The overlay has to reach the partner, so a CSS layer over the video won't
   do — the frames themselves get repainted. The camera plays into an
   off-screen <video>, a canvas redraws each frame with the cutout on top,
   and canvas.captureStream() yields a track that replaces the camera track
   on the sender. replaceTrack swaps same-kind tracks without renegotiating,
   so this never disturbs the SDP. */
const FILTER = {
  src: "assets/filter-buzz.png",
  fps: 30,
  /* Geometry as fractions of the frame, tuned against a stand-in portrait.
     `width` is how wide the artwork is drawn; `shoulderY` is where its collar
     line lands, so a face — assumed centred, since nothing here tracks it —
     sits in the opening above the shoulders. */
  width: 0.85,
  shoulderY: 0.70,
  /* Where the collar sits inside the artwork itself, measured off the PNG. */
  artShoulder: 0.093
};

let filterOn = false;
let filterStream = null;
let filterTimer = null;
let overlayImg = null;
let overlayPromise = null;

function loadOverlay(){
  if (!overlayPromise){
    overlayPromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("overlay artwork failed to load"));
      img.src = FILTER.src;
    }).catch(err => { overlayPromise = null; throw err; });
  }
  return overlayPromise;
}

function localVideoTrack(){
  return localStream ? (localStream.getVideoTracks()[0] || null) : null;
}

/* What goes out on the wire: the composite while the filter is up, the plain
   camera otherwise. */
function outboundVideoTrack(){
  if (filterOn && filterStream){
    const track = filterStream.getVideoTracks()[0];
    if (track) return track;
  }
  return localVideoTrack();
}

/* Our own tiles show the same stream the peer receives, so the two ends can
   never silently disagree about whether the filter is on. */
function displayStream(){
  return (filterOn && filterStream) ? filterStream : localStream;
}

function applyStreamToViews(){
  const stream = displayStream();
  ["vt-local", "vt-preview-video"].forEach(id => {
    const el = $(id);
    if (el && el.srcObject !== stream) el.srcObject = stream;
  });
}

async function syncOutboundVideo(){
  if (!pc) return;
  const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
  const track = outboundVideoTrack();
  if (!sender || !track || sender.track === track) return;
  try {
    await sender.replaceTrack(track);
  } catch (err){
    console.warn("[vt] couldn't swap the outgoing video track", err);
  }
}

function paintFilterButton(){
  const btn = $("vt-filter");
  if (!btn) return;
  btn.classList.toggle("active", filterOn);
  btn.setAttribute("aria-pressed", String(filterOn));
  btn.title = filterOn ? "Remove the space ranger filter" : "Space ranger filter";
}

function drawFilterFrame(){
  const raw = $("vt-raw");
  const canvas = $("vt-canvas");
  if (!raw || !canvas || !raw.videoWidth) return;

  if (canvas.width !== raw.videoWidth || canvas.height !== raw.videoHeight){
    canvas.width = raw.videoWidth;
    canvas.height = raw.videoHeight;
  }
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  // A disabled track keeps delivering (black) frames, so the camera toggle
  // has to be honoured here too — otherwise "camera off" would still send a
  // cheerfully lit space ranger.
  const track = localVideoTrack();
  if (track && !track.enabled){
    ctx.fillStyle = "#26221c";
    ctx.fillRect(0, 0, W, H);
    return;
  }

  ctx.drawImage(raw, 0, 0, W, H);
  if (overlayImg){
    const dw = W * FILTER.width;
    const dh = dw * (overlayImg.naturalHeight / overlayImg.naturalWidth);
    const x = (W - dw) / 2;
    const y = H * FILTER.shoulderY - dh * FILTER.artShoulder;
    ctx.drawImage(overlayImg, x, y, dw, dh);
  }
}

/* A timer rather than requestAnimationFrame: rAF stops dead while the tab is
   in the background, which would freeze the canvas — and since the canvas is
   what the peer is receiving, they'd be left staring at one still frame with
   no clue anything was wrong. A throttled timer degrades to a low frame rate
   instead, which is survivable. */
function startFilterLoop(){
  if (filterTimer !== null) return;
  filterTimer = setInterval(drawFilterFrame, Math.round(1000 / FILTER.fps));
  drawFilterFrame();
}

function stopFilterLoop(){
  if (filterTimer !== null){
    clearInterval(filterTimer);
    filterTimer = null;
  }
}

async function startFilter(){
  const track = localVideoTrack();
  if (!track) return false;

  try {
    overlayImg = await loadOverlay();
  } catch (err){
    vtToast("Couldn't load the filter artwork.");
    return false;
  }

  const raw = $("vt-raw");
  // Video only — the camera track is already carrying audio to the peer, and
  // feeding it in here as well risks a second playback path.
  raw.srcObject = new MediaStream([track]);
  try { await raw.play(); } catch(e){}

  // captureStream inherits the canvas size, so the canvas has to know the
  // frame dimensions before the stream is taken or it starts at 300x150.
  if (!raw.videoWidth){
    await new Promise(resolve => {
      const done = () => { raw.removeEventListener("loadedmetadata", done); resolve(); };
      raw.addEventListener("loadedmetadata", done);
      setTimeout(done, 1500);
    });
  }

  filterOn = true;
  startFilterLoop();
  if (!filterStream) filterStream = $("vt-canvas").captureStream(FILTER.fps);

  applyStreamToViews();
  await syncOutboundVideo();
  paintFilterButton();
  return true;
}

function stopFilter(){
  filterOn = false;
  stopFilterLoop();
  if (filterStream){
    filterStream.getTracks().forEach(t => { try { t.stop(); } catch(e){} });
    filterStream = null;
  }
  const raw = $("vt-raw");
  if (raw){
    try { raw.pause(); } catch(e){}
    raw.srcObject = null;
  }
  paintFilterButton();
}

/* Every screen stays in the DOM — only `display` changes — so a hidden
   <video> would keep the camera light on. Stop the tracks explicitly;
   nulling srcObject alone does not stop them, and stopping without
   nulling can leave Safari's indicator lit. Both are needed. */
function teardownMedia(){
  // Before the camera goes: the render loop and the captured canvas track
  // would otherwise keep running against a dead source.
  stopFilter();
  if (localStream){
    localStream.getTracks().forEach(t => { try { t.stop(); } catch(e){} });
    localStream = null;
  }
  mediaPromise = null;
  ["vt-local", "vt-remote", "vt-preview-video"].forEach(id => {
    const el = $(id);
    if (el){
      try { el.pause(); } catch(e){}
      el.srcObject = null;
    }
  });
  closePeer();
}

function closePeer(){
  if (pc){
    // Detach handlers before closing so the state change doesn't flash
    // a "connection failed" message during an intentional hangup.
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    try { pc.close(); } catch(e){}
    pc = null;
  }
  peerPromise = null;
  pendingCandidates = [];
}

function leaveSession(){
  sendWs({ t: "leave" });
  stopVtTimer();
  teardownMedia();
  myCode = null;
  myRole = null;
  // The plan belongs to the lesson that just ended, so it clears here rather
  // than on entering the call screen — a rejoining partner re-enters that.
  resetPlan();
}

/* ---------- peer connection ---------- */
/* Memoised: enterCall() and an incoming offer can race, and building the
   peer twice — or building it before getUserMedia resolves, which would
   add no tracks and give one-way video — is the subtle failure here. */
function ensurePeer(){
  if (!peerPromise){
    peerPromise = (async () => {
      await acquireMedia();
      buildPeer();
      // The filter can already be up if the peer is rebuilt mid-session, and
      // buildPeer only knows about the raw camera track.
      await syncOutboundVideo();
      return pc;
    })();
  }
  return peerPromise;
}

function buildPeer(){
  pc = new RTCPeerConnection({ iceServers: VT.iceServers });

  pc.onicecandidate = ev => {
    if (ev.candidate) sendWs({ t: "signal", data: { candidate: ev.candidate.toJSON() } });
  };

  pc.ontrack = ev => {
    const remote = $("vt-remote");
    const stream = ev.streams && ev.streams[0];
    // Fires once per track (audio, then video) with the same stream —
    // reassigning each time causes a flicker.
    if (stream && remote.srcObject !== stream) remote.srcObject = stream;
    const p = remote.play();
    if (p && p.catch) p.catch(() => setRemoteMsg("Tap the video to start playback."));
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === "connected"){
      setRemoteMsg("");
      setStatus("");
      $("vt-live-dot").style.display = "block";
      startVtTimer();
    } else if (pc.connectionState === "failed"){
      // The STUN-only failure mode — no direct path exists on this network.
      setRemoteMsg("Couldn't connect on this network.");
      setStatus("No direct route between you two. This network needs a TURN relay.");
      stopVtTimer();
    } else if (pc.connectionState === "disconnected"){
      setStatus("Connection interrupted…");
    }
  };

  if (localStream){
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }
}

async function startOffer(){
  await ensurePeer();
  if (!pc) return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendWs({ t: "signal", data: { sdp: pc.localDescription } });
}

async function handleRtcSignal(data){
  if (!data) return;
  await ensurePeer();
  if (!pc) return;

  if (data.sdp){
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    // Candidates that arrived before the remote description was set would
    // have thrown InvalidStateError, so they were queued. Flush them.
    for (const c of pendingCandidates){
      try { await pc.addIceCandidate(c); } catch(e){}
    }
    pendingCandidates = [];

    if (data.sdp.type === "offer"){
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendWs({ t: "signal", data: { sdp: pc.localDescription } });
    }
    return;
  }

  if (data.candidate){
    const candidate = new RTCIceCandidate(data.candidate);
    if (pc.remoteDescription){
      try { await pc.addIceCandidate(candidate); } catch(e){}
    } else {
      pendingCandidates.push(candidate);
    }
  }
}

/* ---------- call screen ---------- */
async function enterCall(){
  showScreen("vtcall");
  $("vt-live-dot").style.display = "none";
  setRemoteMsg("Connecting…");
  setStatus("");
  $("vt-timer").textContent = "00:00";
  $("vt-call-title").textContent = "Live lesson · " + myCode;

  setSelfCorner(0);
  /* Only the visibility of the editor and the rendered text, not the points
     themselves — a partner who drops and rejoins runs through here again, and
     wiping the plan under the host at that moment would be its own bug. */
  $("vt-plan-edit").hidden = !planEditable();
  renderPlan();
  /* A plan written before the call was written to be shown, so it opens with the
     call rather than waiting for a tap. The guest arrives with nothing and opens
     on the points landing instead — see the lesson branch of handleMessage. */
  setPlanOpen(planPoints.length > 0);
  await ensurePeer();
  applyStreamToViews();
  // No camera means nothing to composite — the audio-only fallback path.
  $("vt-filter").disabled = !localVideoTrack();
  paintFilterButton();
}

function setRemoteMsg(text){
  const el = $("vt-remote-msg");
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
}

function setStatus(text){
  const el = $("vt-status");
  el.textContent = text || "";
}

function startVtTimer(){
  if (vtTimerInterval) return;
  vtSeconds = 0;
  vtTimerInterval = setInterval(() => {
    vtSeconds++;
    const m = String(Math.floor(vtSeconds / 60)).padStart(2, "0");
    const s = String(vtSeconds % 60).padStart(2, "0");
    $("vt-timer").textContent = m + ":" + s;
  }, 1000);
}

function stopVtTimer(){
  clearInterval(vtTimerInterval);
  vtTimerInterval = null;
}

/* ---------- wiring ---------- */
document.querySelectorAll(".vt-entry").forEach(el => {
  el.addEventListener("click", () => showScreen("vtlobby"));
});

$("vt-lobby-back").addEventListener("click", () => showScreen("landing"));

$("vt-create").addEventListener("click", () => {
  if (creating) return;              // double-click would make two rooms
  creating = true;
  $("vt-create").disabled = true;
  connectSocket(() => sendWs({ t: "create" }));
});

$("vt-open-join").addEventListener("click", () => {
  showJoinError("");
  $("vt-code-input").value = "";
  showScreen("vtjoin");
  $("vt-code-input").focus();
});

$("vt-join-back").addEventListener("click", () => showScreen("vtlobby"));

$("vt-create-cancel").addEventListener("click", () => {
  leaveSession();
  showScreen("vtlobby");
});

/* Six digits on their own have to be retyped on the other end. The link
   carries them, so tapping it lands on the join screen already filled in.
   Read off the current URL rather than configured anywhere, so localhost, a
   LAN address and the deployed domain each hand out a link to themselves. */
function joinLink(code){
  return location.origin + location.pathname + "#join/" + code;
}

$("vt-copy").addEventListener("click", async () => {
  const code = $("vt-code").textContent.trim();
  const link = joinLink(code);
  let ok = false;
  if (navigator.clipboard && window.isSecureContext){
    try { await navigator.clipboard.writeText(link); ok = true; } catch(e){}
  }
  if (!ok){
    // Fallback for non-secure contexts and older Safari.
    const tmp = document.createElement("input");
    tmp.value = link;
    tmp.setAttribute("readonly", "");
    tmp.style.cssText = "position:fixed;top:-1000px;opacity:0;";
    document.body.appendChild(tmp);
    tmp.select();
    tmp.setSelectionRange(0, link.length);     // required on iOS
    try { ok = document.execCommand("copy"); } catch(e){}
    tmp.remove();
  }
  /* The code, not the URL, in the message: it's the part worth reading, and
     it's the fallback if the paste goes somewhere that mangles links. */
  vtToast(ok ? "Link copied — opens the lesson with code " + code
             : "Couldn't copy. The code is " + code);
});

$("vt-push").addEventListener("click", async () => {
  const code = $("vt-code").textContent.trim();
  try {
    const res = await fetch("/api/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    if (!res.ok) return vtToast("Notify endpoint returned " + res.status);
    const data = await res.json();
    vtToast(data.stubbed
      ? "Pushover is stubbed — code logged on the server"
      : "Sent to your phone");
  } catch (e){
    vtToast("Couldn't reach the notify endpoint.");
  }
});

function submitJoin(){
  const code = $("vt-code-input").value.trim();
  if (!/^\d{6}$/.test(code)) return showJoinError("Enter all 6 digits.");
  showJoinError("");
  connectSocket(() => sendWs({ t: "join", code }));
}

$("vt-join").addEventListener("click", submitJoin);
$("vt-code-input").addEventListener("keydown", ev => {
  if (ev.key === "Enter") submitJoin();
});
$("vt-code-input").addEventListener("input", ev => {
  /* Codes arrive pasted with stray spaces, or as a whole link now that the
     copy button hands one out. A link is read off its #join/ segment rather
     than by scraping digits, so a port number in the host can't be mistaken
     for part of the code; anything else falls back to the last six digits.
     The field deliberately has no maxlength — it would truncate a pasted
     link to its first six characters and leave nothing to find. */
  const raw = ev.target.value;
  const link = raw.match(/#join\/(\d{6})/);
  ev.target.value = link ? link[1] : raw.replace(/\D/g, "").slice(-6);
});

function showJoinError(text){
  const el = $("vt-join-error");
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
}

/* Toggles flip `enabled` — never stop() the track, which is irreversible
   without renegotiating. */
$("vt-mic").addEventListener("click", () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("vt-mic").classList.toggle("off", !track.enabled);
  $("vt-mic").setAttribute("aria-pressed", String(!track.enabled));
  $("vt-mic").title = track.enabled ? "Mute microphone" : "Unmute microphone";
});

$("vt-cam").addEventListener("click", () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("vt-cam").classList.toggle("off", !track.enabled);
  $("vt-cam").setAttribute("aria-pressed", String(!track.enabled));
  $("vt-cam").title = track.enabled ? "Turn camera off" : "Turn camera on";
});

$("vt-filter").addEventListener("click", async () => {
  const btn = $("vt-filter");
  if (btn.disabled) return;
  // Compositing and the track swap are both async; a double tap part way
  // through would leave the sender and the button disagreeing.
  btn.disabled = true;
  try {
    if (filterOn){
      stopFilter();
      applyStreamToViews();
      await syncOutboundVideo();
    } else {
      await startFilter();
    }
  } finally {
    btn.disabled = !localVideoTrack();
  }
});

/* Tap your own thumbnail to park it in the next corner — the usual escape
   hatch for when it's sitting on top of whatever your partner is showing you.
   Order runs anticlockwise from the default bottom-right. */
const VT_CORNERS = ["br", "bl", "tl", "tr"];
let selfCorner = 0;

function setSelfCorner(index){
  selfCorner = ((index % VT_CORNERS.length) + VT_CORNERS.length) % VT_CORNERS.length;
  $("vt-self").dataset.corner = VT_CORNERS[selfCorner];
}

$("vt-self").addEventListener("click", () => {
  // Choosing a corner by hand outranks the lesson plan's opinion of where the
  // thumbnail should sit, so there is nothing left to put back.
  selfCornerBeforePlan = null;
  setSelfCorner(selfCorner + 1);
});

/* ---------- lesson plan ----------
   Up to four points the host puts on screen for both of you. Nothing here goes
   near the video track: it's text, so each side renders its own panel from the
   same relayed strings and it stays sharp at any size.

   Content is shared; where the panel sits is not. A phone wants it docked to
   the top bar and a wide screen may want the side rail, so placement is a local
   preference — the same split as the self thumbnail's corner. */
const PLAN_MAX = 4;
const PLAN_LEN = 80;
const PLAN_PLACES = ["top", "rail", "third"];

let planPoints = [];
let planPlace = 0;
let planOpen = false;

function planEditable(){ return myRole === "host"; }

/* The lower-third band is the only placement that reaches into the bottom
   corners, and it spans the full width, so a thumbnail down there has nowhere
   to go along that edge. It moves to the corner above while the band is open
   and returns when it closes — nudging it part way up a side instead would
   leave it hovering in the middle of the picture rather than in a corner. */
let selfCornerBeforePlan = null;

function syncSelfForPlan(){
  const inTheWay = planOpen && PLAN_PLACES[planPlace] === "third";
  const at = VT_CORNERS[selfCorner];
  if (inTheWay && (at === "bl" || at === "br")){
    selfCornerBeforePlan = selfCorner;
    setSelfCorner(VT_CORNERS.indexOf(at === "bl" ? "tl" : "tr"));
  } else if (!inTheWay && selfCornerBeforePlan !== null){
    const back = selfCornerBeforePlan;
    selfCornerBeforePlan = null;
    setSelfCorner(back);
  }
}

function setPlanPlace(index){
  planPlace = ((index % PLAN_PLACES.length) + PLAN_PLACES.length) % PLAN_PLACES.length;
  $("screen-vtcall").dataset.plan = PLAN_PLACES[planPlace];
  syncSelfForPlan();
}

function setPlanOpen(open){
  planOpen = open;
  const stage = $("screen-vtcall");
  if (open) stage.setAttribute("data-plan-open", "");
  else stage.removeAttribute("data-plan-open");
  $("vt-plan-toggle").classList.toggle("active", open);
  $("vt-plan-toggle").setAttribute("aria-pressed", String(open));
  if (!open) setPlanEditing(false);
  syncSelfForPlan();
}

/* The flag goes on the stage, not the panel: the editor is taller than the list
   it replaces, and in the lower third that means the self thumbnail's clearance
   has to grow with it — a rule a child element can't reach. */
function setPlanEditing(on){
  const stage = $("screen-vtcall");
  if (on && !planEditable()) return;
  if (on){
    const inputs = $("vt-plan").querySelectorAll(".vt-plan-input");
    inputs.forEach((input, i) => { input.value = planPoints[i] || ""; });
    stage.setAttribute("data-plan-editing", "");
    inputs[0].focus();
  } else {
    stage.removeAttribute("data-plan-editing");
  }
}

/* Always via textContent. These strings arrive from the other browser, so
   building markup out of them would hand the peer script execution. */
function renderPlan(){
  const list = $("vt-plan-list");
  list.textContent = "";
  if (!planPoints.length){
    const li = document.createElement("li");
    li.className = "vt-plan-empty";
    li.textContent = planEditable()
      ? "No points yet. Tap Edit to put up to four on screen."
      : "Your teacher hasn't put up any points yet.";
    list.appendChild(li);
    return;
  }
  planPoints.forEach((text, i) => {
    const li = document.createElement("li");
    const n = document.createElement("span");
    n.className = "vt-plan-n";
    n.textContent = String(i + 1);
    const t = document.createElement("span");
    t.className = "vt-plan-t";
    t.textContent = text;
    li.append(n, t);
    list.appendChild(li);
  });
}

/* Defensive: the points come off the wire, so nothing about the shape or the
   length can be assumed even though our own sender is well behaved. */
function normalisePlan(raw){
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(p => typeof p === "string")
    .map(p => p.trim().slice(0, PLAN_LEN))
    .filter(Boolean)
    .slice(0, PLAN_MAX);
}

function resetPlan(){
  planPoints = [];
  selfCornerBeforePlan = null;
  setPlanPlace(0);
  setPlanOpen(false);
  setPlanEditing(false);
  renderPlan();
  seedPrep();   // the next lesson starts from a blank plan, not the last one's
  $("vt-plan-edit").hidden = !planEditable();
}

/* Called on the host after a partner arrives: they connected with no idea what
   was already on screen. */
function sharePlan(){
  if (!planEditable()) return;
  sendWs({ t: "lesson", points: planPoints });
}

/* ---------- writing the plan before the call ----------
   The waiting screen is where a teacher actually plans a lesson: mid-call the
   student is already watching you type. The in-call editor stays, for changing
   the plan once you are both there.

   Read on every keystroke rather than behind a Save button. The partner can
   arrive between any two keys, and their arrival switches this screen for the
   call — a draft still sitting in these inputs would be lost at exactly the
   moment it was needed. */
function prepInputs(){
  return [...$("vt-prep-fields").querySelectorAll(".vt-prep-input")];
}

function readPrep(){
  planPoints = normalisePlan(prepInputs().map(i => i.value));
  $("vt-prep-clear").hidden = !planPoints.length;
}

function seedPrep(){
  prepInputs().forEach((input, i) => { input.value = planPoints[i] || ""; });
  $("vt-prep-clear").hidden = !planPoints.length;
}

$("vt-prep-fields").addEventListener("input", readPrep);

$("vt-prep-clear").addEventListener("click", () => {
  planPoints = [];
  seedPrep();
  prepInputs()[0].focus();
});

$("vt-plan-toggle").addEventListener("click", () => {
  const next = !planOpen;
  setPlanOpen(next);
  // Nothing to read yet, so the host's first tap goes straight to the editor.
  if (next && planEditable() && !planPoints.length) setPlanEditing(true);
});

$("vt-plan-move").addEventListener("click", () => setPlanPlace(planPlace + 1));
$("vt-plan-edit").addEventListener("click", () => setPlanEditing(true));
$("vt-plan-cancel").addEventListener("click", () => setPlanEditing(false));

$("vt-plan-form").addEventListener("submit", ev => {
  ev.preventDefault();
  const inputs = [...$("vt-plan-form").querySelectorAll(".vt-plan-input")];
  planPoints = normalisePlan(inputs.map(i => i.value));
  setPlanEditing(false);
  renderPlan();
  sharePlan();
  vtToast(planPoints.length
    ? "Lesson plan is up for both of you."
    : "Lesson plan cleared.");
});

// Establishes the default placement on the stage before any lesson starts.
resetPlan();

$("vt-end").addEventListener("click", () => {
  leaveSession();
  showScreen("vtlobby");
});

/* Any navigation away from an active session must release the camera —
   including backing out to the lobby, not just leaving the flow. The two
   screens that legitimately hold a live stream are vtcreate (self-preview
   while waiting) and vtcall. */
const VT_SESSION_SCREENS = ["vtcreate", "vtcall"];
const originalShowScreen = showScreen;
showScreen = function(name){
  if (!VT_SESSION_SCREENS.includes(name) && (localStream || pc || myCode)){
    leaveSession();
  }
  originalShowScreen(name);
};

/* `pagehide` rather than `beforeunload` — the latter never fires on iOS Safari. */
window.addEventListener("pagehide", () => {
  sendWs({ t: "leave" });
  if (localStream) localStream.getTracks().forEach(t => { try { t.stop(); } catch(e){} });
});

/* Deep links, so the flow is reachable without the nav bar — handy when
   the code arrives on a phone. #video opens the lobby; #join/123456
   prefills the code ready to go. */
(function initHashRoute(){
  const hash = location.hash || "";
  const join = hash.match(/^#join\/(\d{6})$/);
  if (join){
    showScreen("vtjoin");
    $("vt-code-input").value = join[1];
    return;
  }
  if (hash === "#video") showScreen("vtlobby");
})();
