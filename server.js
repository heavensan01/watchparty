const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 60000, pingInterval: 20000, maxHttpBufferSize: 5e6 });
app.use(require("compression")());
app.use(express.static("public"));

// ffmpeg.wasm is served from this site, so the host's browser (phone or PC) reads audio/subtitle tracks locally. No movie upload.
const NM = require("path").join(__dirname, "node_modules");
app.use("/ffmpeg", express.static(NM + "/@ffmpeg/ffmpeg/dist/umd", { maxAge: "7d" }));
app.use("/ffmpeg-core", express.static(NM + "/@ffmpeg/core/dist/umd", { maxAge: "7d" }));

app.get("/ice-config", (req, res) => {
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
  if (process.env.TURN_URL) iceServers.push({ urls: process.env.TURN_URL.split(","), username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  res.json({ iceServers });
});

const rooms = {}; // code -> { host, title, m: Map(id -> {name,face,ready}) }
const makeCode = () => {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let x;
  do { x = Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join(""); } while (rooms[x]);
  return x;
};
const clean = (s, n) => String(s || "").slice(0, n);

io.on("connection", (s) => {
  const room = () => rooms[s.room];
  const push = () => { const r = room(); if (r) io.to(s.room).emit("members", [...r.m].map(([id, v]) => ({ id, ...v, host: id === r.host }))); };

  s.on("create-room", ({ name, face, cid, title }, cb) => {
    const code = makeCode();
    rooms[code] = { host: s.id, token: require("crypto").randomBytes(12).toString("hex"), title: clean(title, 60) || "UniFlix", msgs: [], subs: [], m: new Map([[s.id, { name: clean(name, 24), face: clean(face, 8), cid: clean(cid, 24), ready: false }]]) };
    s.room = code; s.join(code); cb({ code, title: rooms[code].title, token: rooms[code].token }); push();
  });

  // host reconnect: keeps the room alive if the connection drops briefly
  s.on("rejoin-host", ({ code, token }, cb) => {
    code = clean(code, 6);
    const r = rooms[code];
    if (!r || r.token !== token) return cb({ ok: false });
    clearTimeout(r.timer);
    const old = r.m.get(r.host); r.m.delete(r.host);
    r.host = s.id; r.m.set(s.id, old || { name: "Host", face: "🍿", ready: false });
    s.room = code; s.join(code); cb({ ok: true });
    io.to(code).emit("sys", "Host is back"); push();
  });

  s.on("join-room", ({ code, name, face, cid }, cb) => {
    code = clean(code, 6).toUpperCase();
    const r = rooms[code];
    if (!r) return cb({ ok: false });
    s.room = code; s.join(code);
    r.m.set(s.id, { name: clean(name, 24), face: clean(face, 8), cid: clean(cid, 24), ready: false });
    cb({ ok: true, title: r.title }); s.emit("history", r.msgs); s.emit("subs-all", r.subs);
    io.to(r.host).emit("viewer-joined", s.id);
    io.to(code).emit("sys", clean(name, 24) + " joined the party");
    push();
  });

  s.on("signal", ({ to, data }) => io.to(to).emit("signal", { from: s.id, data }));
  s.on("state", (st) => { const r = room(); if (r && r.host === s.id) s.to(s.room).emit("state", st); });
  s.on("control", (msg) => { const r = room(); if (r && r.host !== s.id) io.to(r.host).emit("control", msg); });
  s.on("chat", (t) => {
    const r = room(), m = r?.m.get(s.id), text = clean(t, 1000).trim();
    if (!m || !text) return;
    const msg = { name: m.name, face: m.face, cid: m.cid, text, ts: Date.now() };
    r.msgs.push(msg); if (r.msgs.length > 100) r.msgs.shift();
    io.to(s.room).emit("chat", msg);
  });
  s.on("typing", () => { const m = room()?.m.get(s.id); if (m) s.to(s.room).emit("typing", { name: m.name, cid: m.cid }); });
  s.on("react", (e) => { if (room()) io.to(s.room).emit("react", clean(e, 8)); });
  s.on("subs", (t) => {
    const r = room(); if (!r || r.host !== s.id || !t) return;
    const o = { id: clean(t.id, 40), label: clean(t.label, 80), vtt: String(t.vtt || "").slice(0, 2000000) };
    r.subs = r.subs.filter(x => x.id !== o.id); r.subs.push(o); io.to(s.room).emit("subs", o);
  });
  s.on("subs-clear", () => { const r = room(); if (r && r.host === s.id) { r.subs = []; io.to(s.room).emit("subs-clear"); } });
  s.on("ready", () => {
    const r = room(), m = r?.m.get(s.id); if (!m) return;
    m.ready = !m.ready; push();
    if (r.m.size > 1 && [...r.m.values()].every(v => v.ready)) { r.m.forEach(v => v.ready = false); io.to(s.room).emit("countdown"); push(); }
  });
  s.on("countdown", () => { const r = room(); if (!r) return; r.m.forEach(v => v.ready = false); io.to(s.room).emit("countdown"); push(); });

  s.on("disconnect", () => {
    const r = room(); if (!r) return;
    if (r.host === s.id) { const c = s.room; io.to(c).emit("sys", "Host connection lost. Waiting for them to come back…"); r.timer = setTimeout(() => { io.to(c).emit("host-left"); delete rooms[c]; }, 180000); return; }
    const m = r.m.get(s.id); r.m.delete(s.id);
    io.to(r.host).emit("viewer-left", s.id);
    if (m) io.to(s.room).emit("sys", m.name + " left");
    push();
  });
});

server.listen(process.env.PORT || 3000, () => console.log("UniFlix running"));
