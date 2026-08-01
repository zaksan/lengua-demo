const express = require("express");
const http = require("http");
const path = require("path");
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
