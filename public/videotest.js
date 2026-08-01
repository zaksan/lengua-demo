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
      if (stream) $("vt-preview-video").srcObject = stream;
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

/* Every screen stays in the DOM — only `display` changes — so a hidden
   <video> would keep the camera light on. Stop the tracks explicitly;
   nulling srcObject alone does not stop them, and stopping without
   nulling can leave Safari's indicator lit. Both are needed. */
function teardownMedia(){
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

  await ensurePeer();
  if (localStream) $("vt-local").srcObject = localStream;
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

$("vt-copy").addEventListener("click", async () => {
  const code = $("vt-code").textContent.trim();
  let ok = false;
  if (navigator.clipboard && window.isSecureContext){
    try { await navigator.clipboard.writeText(code); ok = true; } catch(e){}
  }
  if (!ok){
    // Fallback for non-secure contexts and older Safari.
    const tmp = document.createElement("input");
    tmp.value = code;
    tmp.setAttribute("readonly", "");
    tmp.style.cssText = "position:fixed;top:-1000px;opacity:0;";
    document.body.appendChild(tmp);
    tmp.select();
    tmp.setSelectionRange(0, 6);     // required on iOS
    try { ok = document.execCommand("copy"); } catch(e){}
    tmp.remove();
  }
  vtToast(ok ? "Code copied — " + code : "Couldn't copy. The code is " + code);
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
  // Codes get pasted with stray spaces, or as a whole URL — keep the digits.
  const digits = ev.target.value.replace(/\D/g, "");
  ev.target.value = digits.slice(-6);
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
