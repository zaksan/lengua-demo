const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

/* ============================================================
   PUSHOVER — stubbed for now.

   When we're ready to send the lesson code as a real push
   notification, replace the body of this handler with:

     const body = new URLSearchParams({
       token: process.env.PUSHOVER_TOKEN,   // Pushover application token
       user: process.env.PUSHOVER_USER,     // recipient's user key
       title: "Lengua lesson",
       message: "Your lesson code is " + code
     });
     const r = await fetch("https://api.pushover.net/1/messages.json", {
       method: "POST", body
     });

   Both credentials stay server-side on purpose — a Pushover app
   token must never ship to the browser. Set them as Railway
   variables when the time comes.
   ============================================================ */
app.post("/api/notify", express.json(), (req, res) => {
  const code = String((req.body && req.body.code) || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ ok: false, error: "bad-code" });
  }
  console.log("[pushover:stub] would send lesson code " + code);
  res.json({ ok: true, stubbed: true });
});

/* ============================================================
   BETA: TV CHANNELS

   Thirteen channels, each holding either an uploaded video file
   or a YouTube link. Uploads land on disk; YouTube channels are
   just an id in the metadata, which is how a 2-hour movie gets
   on the set without touching our storage at all.

   Storage has to live on a Railway volume in production. Without
   one the container's filesystem is wiped on every redeploy and
   the channels come back empty.

   Railway injects RAILWAY_VOLUME_MOUNT_PATH by itself whenever a
   volume is attached, so attaching one is the only step — there
   is deliberately no variable to set and get wrong. UPLOAD_DIR
   stays available to override it.
   ============================================================ */
const CHANNEL_COUNT = 13;
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

const UPLOAD_DIR = process.env.UPLOAD_DIR ||
                   process.env.RAILWAY_VOLUME_MOUNT_PATH ||
                   path.join(__dirname, "uploads");
const VIDEO_DIR = path.join(UPLOAD_DIR, "videos");
const CHANNELS_FILE = path.join(UPLOAD_DIR, "channels.json");

fs.mkdirSync(VIDEO_DIR, { recursive: true });

// Logged on purpose: "my channels vanished" is almost always this path
// pointing somewhere ephemeral, and the deploy logs make that obvious.
console.log("[tv] channel storage: " + UPLOAD_DIR +
  (process.env.UPLOAD_DIR ? " (UPLOAD_DIR override)"
   : process.env.RAILWAY_VOLUME_MOUNT_PATH ? " (Railway volume)"
   : " (local disk — NOT persistent on Railway)"));

function readChannels() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {}; // absent or corrupt reads as "nothing programmed yet"
  }
}

// Write to a sibling temp file and rename: rename is atomic on the same
// filesystem, so a crash mid-write can't leave a half-written channels.json
// that would read back as empty and wipe every channel.
function writeChannels(channels) {
  const tmp = CHANNELS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(channels, null, 2));
  fs.renameSync(tmp, CHANNELS_FILE);
}

function parseChannel(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= CHANNEL_COUNT ? n : null;
}

// Removes whatever a channel was holding. Only uploads leave a file behind;
// clearing a YouTube channel is pure metadata.
function clearChannel(channels, n) {
  const existing = channels[String(n)];
  if (existing && existing.type === "upload" && existing.file) {
    try {
      fs.unlinkSync(path.join(VIDEO_DIR, path.basename(existing.file)));
    } catch (e) {}
  }
  delete channels[String(n)];
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, VIDEO_DIR),
    // Never trust the client's filename — it can contain path separators.
    // The channel is already validated by the time multer runs.
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || ".mp4").toLowerCase().slice(0, 10);
      const safeExt = /^\.[a-z0-9]+$/.test(ext) ? ext : ".mp4";
      cb(null, "ch" + req.params.n + "-" + Date.now() + safeExt);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!String(file.mimetype || "").startsWith("video/")) {
      return cb(new Error("not-video"));
    }
    cb(null, true);
  }
});

app.get("/api/channels", (req, res) => {
  res.json({ ok: true, count: CHANNEL_COUNT, channels: readChannels() });
});

app.post("/api/channels/:n/video", (req, res) => {
  const n = parseChannel(req.params.n);
  if (!n) return res.status(400).json({ ok: false, error: "bad-channel" });

  upload.single("video")(req, res, err => {
    if (err) {
      const error = err.code === "LIMIT_FILE_SIZE" ? "too-large"
                  : err.message === "not-video" ? "not-video"
                  : "upload-failed";
      return res.status(400).json({ ok: false, error, maxBytes: MAX_UPLOAD_BYTES });
    }
    if (!req.file) return res.status(400).json({ ok: false, error: "no-file" });

    const channels = readChannels();
    clearChannel(channels, n); // frees the old file before the new one takes the slot
    channels[String(n)] = {
      type: "upload",
      file: req.file.filename,
      originalName: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size,
      addedAt: new Date().toISOString()
    };
    writeChannels(channels);
    console.log("[tv] channel " + n + " <- upload " + req.file.filename);
    res.json({ ok: true, channel: n, entry: channels[String(n)] });
  });
});

/* Accepts anything someone might realistically paste: a full watch URL, a
   youtu.be short link, a Shorts or embed path, or the bare 11-char id. */
function parseYouTube(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return { videoId: raw, start: 0 };

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
  } catch (e) {
    return null;
  }

  const host = url.hostname.replace(/^(www|m)\./, "");
  let id = null;
  if (host === "youtu.be") {
    id = url.pathname.slice(1).split("/")[0];
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") {
      id = url.searchParams.get("v");
    } else {
      const match = url.pathname.match(/^\/(?:embed|shorts|v|live)\/([^/?#]+)/);
      if (match) id = match[1];
    }
  }

  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  return { videoId: id, start: parseStart(url.searchParams.get("t") || url.searchParams.get("start")) };
}

// YouTube writes timestamps as either raw seconds or 1h2m3s.
function parseStart(value) {
  if (!value) return 0;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const match = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

/* oEmbed gives us the title with no API key and no quota. It's a nicety, so
   a failure here must not sink the request — an untitled channel still plays. */
async function fetchYouTubeTitle(videoId) {
  try {
    const target = "https://www.youtube.com/oembed?format=json&url=" +
      encodeURIComponent("https://www.youtube.com/watch?v=" + videoId);
    const res = await fetch(target, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return "";
    const data = await res.json();
    return String(data.title || "").slice(0, 200);
  } catch (e) {
    return "";
  }
}

app.post("/api/channels/:n/youtube", express.json(), async (req, res) => {
  const n = parseChannel(req.params.n);
  if (!n) return res.status(400).json({ ok: false, error: "bad-channel" });

  const parsed = parseYouTube(req.body && req.body.url);
  if (!parsed) return res.status(400).json({ ok: false, error: "bad-url" });

  const title = await fetchYouTubeTitle(parsed.videoId);

  const channels = readChannels();
  clearChannel(channels, n);
  channels[String(n)] = {
    type: "youtube",
    videoId: parsed.videoId,
    title,
    start: parsed.start,
    addedAt: new Date().toISOString()
  };
  writeChannels(channels);
  console.log("[tv] channel " + n + " <- youtube " + parsed.videoId);
  res.json({ ok: true, channel: n, entry: channels[String(n)] });
});

app.delete("/api/channels/:n", (req, res) => {
  const n = parseChannel(req.params.n);
  if (!n) return res.status(400).json({ ok: false, error: "bad-channel" });
  const channels = readChannels();
  clearChannel(channels, n);
  writeChannels(channels);
  res.json({ ok: true, channel: n });
});

// Only the videos subdirectory is exposed — channels.json lives one level up
// in UPLOAD_DIR precisely so it can't be fetched here. express.static handles
// Range requests, which is what lets the player seek.
app.use("/media", express.static(VIDEO_DIR, { maxAge: "1h" }));

// Must sit above the catch-all: without it a typo'd /api/... path returns
// index.html with a 200, and the client's res.json() fails with a baffling
// "Unexpected token '<'".
app.use("/api", (req, res) => res.status(404).json({ ok: false, error: "not-found" }));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ============================================================
   SIGNALING — just enough to introduce two browsers to each
   other. Rooms live in memory; a restart invalidates all codes.

   NOTE: this only works on a single instance. If this service is
   ever scaled past one replica, two peers can land on different
   containers and never find each other — rooms would have to move
   to something shared like Redis.
   ============================================================ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/rtc" });

const rooms = new Map(); // code -> { code, createdAt, peers: [ws] }
const ROOM_TTL_MS = 30 * 60 * 1000;

function makeCode() {
  let code;
  do {
    // 100000-999999 keeps it exactly six digits, no leading-zero ambiguity
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function otherPeer(room, ws) {
  return room.peers.find(p => p !== ws);
}

function leaveRoom(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  room.peers = room.peers.filter(p => p !== ws);
  const other = room.peers[0];
  if (other) send(other, { t: "peer-left" });
  if (room.peers.length === 0) rooms.delete(room.code);
  ws.roomCode = null;
  ws.role = null;
}

wss.on("connection", ws => {
  ws.roomCode = null;
  ws.role = null;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.t === "create") {
      leaveRoom(ws);
      const code = makeCode();
      rooms.set(code, { code, createdAt: Date.now(), peers: [ws] });
      ws.roomCode = code;
      ws.role = "host";
      console.log("[room] created " + code);
      return send(ws, { t: "created", code, role: "host" });
    }

    if (msg.t === "join") {
      const code = String(msg.code || "").trim();
      if (!/^\d{6}$/.test(code)) {
        return send(ws, { t: "error", code: "bad-code" });
      }
      const room = rooms.get(code);
      if (!room) return send(ws, { t: "error", code: "not-found" });
      if (room.peers.length >= 2) return send(ws, { t: "error", code: "full" });

      leaveRoom(ws);
      room.peers.push(ws);
      ws.roomCode = code;
      ws.role = "guest";
      console.log("[room] " + code + " joined by guest");
      send(ws, { t: "joined", code, role: "guest" });
      const host = otherPeer(room, ws);
      if (host) send(host, { t: "peer-joined" });
      return;
    }

    if (msg.t === "signal") {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const other = otherPeer(room, ws);
      if (other) send(other, { t: "signal", data: msg.data });
      return;
    }

    /* The lesson plan is text, so it rides this socket rather than the video
       track. Relayed verbatim and only ever to the room's other peer; the
       browser is what decides how many points to keep and how to render
       them, since it is the side that has to trust them. */
    if (msg.t === "lesson") {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (ws.role !== "host") return;   // only the teacher sets the plan
      const other = otherPeer(room, ws);
      if (other) send(other, { t: "lesson", points: msg.points });
      return;
    }

    if (msg.t === "leave") {
      leaveRoom(ws);
      return;
    }
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

/* A phone going to sleep or dropping off wifi often leaves a half-open
   socket with no `close` event — the other side would sit on "connected"
   forever. Ping every 30s and terminate anything that missed a round,
   which fires `close` and frees the slot. */
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch(e){}
  });
}, 30 * 1000);
heartbeat.unref();

// Drop rooms whose code was generated and never used.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.peers.length === 0 || now - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(room.code);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log("Lengua demo running on port " + PORT);
});
