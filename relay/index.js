// Sentari relay — a tiny LAN WebSocket hub.
//
// Two kinds of clients connect over the same port:
//   • devices     (headsets: SentariLobby, later Build & Breach)
//   • controllers (Sentari Command app, or the built-in debug console)
//
// Devices register + heartbeat. Controllers send commands targeted at a
// device (or "all"). The relay routes commands to devices and broadcasts the
// live device roster to controllers. No internet required — runs on the
// instructor's laptop, everything on the same WiFi.
//
//   npm install   (once)
//   npm start     ->  ws://<laptop-ip>:8080   +   http://<laptop-ip>:8080 (console)

import http from "http";
import fs from "fs";
import { WebSocketServer } from "ws";
import { advertise } from "./discovery.js";

// What this relay advertises itself as over mDNS. Sentari Command and Build &
// Breach Builder each embed this same relay, so the name is the one thing that
// differs — a headset browsing _sentari._tcp sees which app is hosting it.
const RELAY_NAME = process.env.SENTARI_RELAY_NAME || "Sentari Command";

const PORT = process.env.PORT || 8080;

// Persistent friendly-name assignment, keyed by each headset's stable hardware
// id. First time we see a device we hand it the next free "Quest-NN" and
// remember it in devices.json — so one build works on every headset and names
// stay consistent across restarts.
const NAMES_FILE = new URL("./devices.json", import.meta.url);
let nameMap = {}; // deviceId -> friendlyName
try {
  nameMap = JSON.parse(fs.readFileSync(NAMES_FILE, "utf8"));
} catch {}

function saveNames() {
  try {
    fs.writeFileSync(NAMES_FILE, JSON.stringify(nameMap, null, 2));
  } catch (e) {
    console.warn("could not save devices.json:", e.message);
  }
}

function nextQuestName() {
  const used = new Set(Object.values(nameMap));
  let n = 1;
  while (used.has(`Quest-${String(n).padStart(2, "0")}`)) n++;
  return `Quest-${String(n).padStart(2, "0")}`;
}

// requested name (from Inspector) wins and is remembered; otherwise reuse the
// previously assigned name for this hardware id, or mint a new one.
function resolveDeviceName(deviceId, requested) {
  if (requested && requested.trim()) {
    nameMap[deviceId] = requested.trim();
    saveNames();
    return nameMap[deviceId];
  }
  if (nameMap[deviceId]) return nameMap[deviceId];
  const name = nextQuestName();
  nameMap[deviceId] = name;
  saveNames();
  return name;
}

// Lesson → parent module. Lobbies only ever see module-level activity
// ("module3" / Human Anatomy) — which specific lab a trainee is in is
// instructor-only detail. Keep in sync with data/catalog.ts.
const LESSON_TO_MODULE = {
  firstlaw: "module2",
  secondlaw: "module2",
  thirdlaw: "module2",
  heart: "module3",
  brain: "module3",
  lungs: "module3",
  skeleton: "module3",
  muscles: "module3",
};

// Module-level view of a lesson id. Unknown ids coarsen to null rather than
// leak a lesson the map doesn't know about yet.
function publicLesson(lesson) {
  if (!lesson) return null;
  if (LESSON_TO_MODULE[lesson]) return LESSON_TO_MODULE[lesson];
  return /^module\d+$/.test(lesson) ? lesson : null;
}

/** Connected clients. Each: { ws, role, id, deviceName, model, battery, status, lesson, lastSeen } */
const clients = new Set();
let nextId = 1;

// Quiz results reported by headsets after each lab/lesson.
// key `${deviceName}|${lesson}` -> { deviceName, lesson, score, correct, total, at }
const quizResults = new Map();
const quizList = () => [...quizResults.values()];

// The org's entitled module list, as last announced by Command. Cached so a
// headset that connects later still learns its catalog. One relay serves one
// org (the instructor's laptop), so last-write-wins is correct.
// [{ id, name, content }] — content: "builtin" | "addressable" (Phase 2 adds a bundle URL).
let catalog = null;

const devices = () => [...clients].filter((c) => c.role === "device");
const controllers = () => [...clients].filter((c) => c.role === "controller");

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function deviceRoster() {
  return devices().map((d) => ({
    id: d.id,
    deviceName: d.deviceName,
    model: d.model,
    battery: d.battery,
    status: d.status,
    phase: d.phase || "",
    lesson: d.lesson,
    paused: d.paused,
    elapsedSec: d.elapsedSec,
    space: d.space,
    lastSeen: d.lastSeen,
  }));
}

function broadcastRoster() {
  const roster = deviceRoster();
  // Controllers (Command) get the full roster, specific lessons included.
  const controllerMsg = { type: "devices", devices: roster };
  for (const c of controllers()) send(c.ws, controllerMsg);
  // Devices get the roster too, so lobbies can show who else is training
  // (join-up UX) — but only at module granularity ("module3"), never the
  // specific lab ("lungs"). That detail is Command-only.
  const deviceMsg = {
    type: "devices",
    devices: roster.map((d) => ({ ...d, lesson: publicLesson(d.lesson) })),
  };
  for (const c of devices()) send(c.ws, deviceMsg);
}

function broadcastQuiz() {
  const msg = { type: "quizResults", results: quizList() };
  for (const c of controllers()) send(c.ws, msg);
}

function routeCommand(cmd) {
  // cmd: { type:"command", target:"all"|deviceName, action, payload }
  const targets =
    !cmd.target || cmd.target === "all"
      ? devices()
      : devices().filter((d) => d.deviceName === cmd.target || d.id === cmd.target);
  for (const d of targets) {
    send(d.ws, { type: "command", action: cmd.action, payload: cmd.payload ?? {} });
  }
  // Resetting a lesson clears its quiz results for the targeted headsets so
  // Command's view stays in sync with the headset.
  if (cmd.action === "resetLesson" && cmd.payload && cmd.payload.lessonId) {
    const lesson = cmd.payload.lessonId;
    const names = new Set(targets.map((d) => d.deviceName));
    const all = !cmd.target || cmd.target === "all";
    let changed = false;
    for (const [k, v] of quizResults) {
      if (v.lesson === lesson && (all || names.has(v.deviceName))) {
        quizResults.delete(k);
        changed = true;
      }
    }
    if (changed) broadcastQuiz();
  }
  return targets.length;
}

// ── HTTP: serve the debug console ───────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(CONSOLE_HTML);
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

// ── WebSocket ───────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const client = {
    ws,
    role: "unknown",
    id: nextId++,
    deviceId: null,
    deviceName: null,
    model: null,
    battery: 0,
    status: "online",
    lesson: null,
    phase: "",
    paused: false,
    elapsedSec: 0,
    space: null,
    lastSeen: Date.now(),
  };
  clients.add(client);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    client.lastSeen = Date.now();

    switch (msg.type) {
      case "register": {
        client.role = msg.role === "controller" ? "controller" : "device";
        if (client.role === "device") {
          client.deviceId = msg.deviceId || `conn-${client.id}`;
          client.model = msg.model || "Unknown";
          client.status = "online";
          client.deviceName = resolveDeviceName(client.deviceId, msg.deviceName);
          console.log(`✓ device registered: ${client.deviceName} (${client.model}) [${client.deviceId}]`);
          send(ws, { type: "welcome", id: client.id, role: client.role, deviceName: client.deviceName });
          // Late joiners still learn which modules their org has.
          if (catalog) send(ws, { type: "catalog", modules: catalog });
        } else {
          console.log(`✓ controller connected (#${client.id})`);
          send(ws, { type: "welcome", id: client.id, role: client.role });
          send(ws, { type: "quizResults", results: quizList() });
        }
        broadcastRoster();
        break;
      }
      case "heartbeat": {
        if (typeof msg.phase === "string") client.phase = msg.phase;
        if (typeof msg.battery === "number") client.battery = msg.battery;
        if (msg.status) client.status = msg.status;
        // JsonUtility on the headset emits "" for a null lesson — treat as none.
        if (msg.lesson !== undefined) client.lesson = msg.lesson || null;
        if (typeof msg.paused === "boolean") client.paused = msg.paused;
        if (typeof msg.elapsedSec === "number") client.elapsedSec = msg.elapsedSec;
        // Guardian play-area size (meters), for Room Builder room-sizing. A
        // headset with no boundary set reports 0×0 (JsonUtility can't omit the
        // field) — ignore that so it doesn't surface as a zero-size space.
        if (msg.space && msg.space.w > 0 && msg.space.h > 0) {
          client.space = { w: msg.space.w, h: msg.space.h };
        }
        broadcastRoster();
        break;
      }
      case "pose": {
        // High-frequency (~5-10 Hz) trainee pose from a headset in a pushed
        // room: position in room grid cells + head/gun headings in degrees.
        // Fanned out per-device to controllers only — never rebroadcast the
        // full roster at this rate.
        if (client.role !== "device" || !client.deviceName) break;
        const out = {
          type: "pose",
          deviceName: client.deviceName,
          x: Number(msg.x) || 0,
          y: Number(msg.y) || 0,
          facing: Number(msg.facing) || 0,
          gun: Number(msg.gun) || 0,
          firing: !!msg.firing, // fired since the last pose — the map flashes the gun line
          rel: !!msg.rel, // true = no room pushed yet: x/y are START-relative cells
          t: Date.now(),
        };
        for (const c of controllers()) send(c.ws, out);
        break;
      }
      case "npcPoses": {
        // Batched NPC positions from a headset running a pushed room, keyed by
        // the layout object id. Fanned to controllers only, like trainee poses.
        if (client.role !== "device" || !Array.isArray(msg.npcs)) break;
        const npcs = [];
        for (const n of msg.npcs) {
          if (!n || typeof n.id !== "string") continue;
          // `alive` defaults TRUE for older headset builds that don't send it.
          npcs.push({
            id: n.id,
            x: Number(n.x) || 0,
            y: Number(n.y) || 0,
            facing: Number(n.facing) || 0,
            alive: n.alive !== false,
            // Live behavior + firing: "random" targets roll at mission start and
            // comply-then-turn NPCs flip — the map recolors as it changes.
            ...(typeof n.beh === "string" && n.beh ? { beh: n.beh } : {}),
            firing: !!n.firing,
          });
        }
        const out = { type: "npcPoses", deviceName: client.deviceName, npcs, t: Date.now() };
        for (const c of controllers()) send(c.ws, out);
        break;
      }
      case "bounds": {
        // The four corners of a headset's real space, relative to its placed
        // start. Reference geometry for the Room Builder's canvas.
        if (client.role !== "device" || !Array.isArray(msg.points)) break;
        const points = msg.points
          .filter((p) => p && typeof p.x === "number" && typeof p.y === "number")
          .map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
        console.log(`▢ ${client.deviceName} reported ${points.length} room corner(s)`);
        for (const c of controllers())
          send(c.ws, { type: "bounds", deviceName: client.deviceName, points, t: Date.now() });
        break;
      }
      case "doorStates": {
        // Live door swing angles from a headset in a pushed room, keyed by layout
        // object id. Fanned to controllers only, same as poses.
        if (client.role !== "device" || !Array.isArray(msg.doors)) break;
        const doors = [];
        for (const d of msg.doors) {
          if (!d || typeof d.id !== "string") continue;
          doors.push({ id: d.id, angle: Number(d.angle) || 0 });
        }
        const out = { type: "doorStates", deviceName: client.deviceName, doors, t: Date.now() };
        for (const c of controllers()) send(c.ws, out);
        break;
      }
      case "runEnded": {
        // The trainee ended the run on the headset. Mirror of the "end" command
        // going the other way, so whichever side stops a run, both agree it's over.
        if (client.role !== "device" || !client.deviceName) break;
        console.log(`⏹ ${client.deviceName} ended its run (${msg.hits ?? 0}/${msg.shots ?? 0} hits)`);
        for (const c of controllers())
          send(c.ws, {
            type: "runEnded",
            deviceName: client.deviceName,
            // AAR numbers, so the board can keep a record per run, not just a replay.
            shots: Number(msg.shots) || 0,
            hits: Number(msg.hits) || 0,
            misses: Number(msg.misses) || 0,
            seconds: Number(msg.seconds) || 0,
            hostilesDown: Number(msg.hostilesDown) || 0,
            hostilesCustody: Number(msg.hostilesCustody) || 0,
            hostilesActive: Number(msg.hostilesActive) || 0,
            civiliansDown: Number(msg.civiliansDown) || 0,
            civiliansCustody: Number(msg.civiliansCustody) || 0,
            civiliansActive: Number(msg.civiliansActive) || 0,
            muzzleFlagSeconds: Number(msg.muzzleFlagSeconds) || 0,
            muzzleFlagEvents: Number(msg.muzzleFlagEvents) || 0,
            shotByHostile: !!msg.shotByHostile,
            t: Date.now(),
          });
        break;
      }
      case "quizResult": {
        // From a headset after a lab quiz: { type, lesson, score, correct, total }
        if (client.role === "device" && client.deviceName && msg.lesson) {
          quizResults.set(`${client.deviceName}|${msg.lesson}`, {
            deviceName: client.deviceName,
            lesson: msg.lesson,
            score: typeof msg.score === "number" ? msg.score : 0,
            correct: typeof msg.correct === "number" ? msg.correct : undefined,
            total: typeof msg.total === "number" ? msg.total : undefined,
            at: Date.now(),
          });
          broadcastQuiz();
        }
        break;
      }
      case "rename": {
        // From a controller: rename a headset; remembered against its hardware id.
        if (client.role !== "controller") break;
        const name = (msg.name || "").trim();
        const dev = devices().find((d) => d.deviceName === msg.target || String(d.id) === String(msg.target));
        if (dev && name) {
          dev.deviceName = name;
          if (dev.deviceId) {
            nameMap[dev.deviceId] = name;
            saveNames();
          }
          console.log(`✎ renamed "${msg.target}" → "${name}"`);
          // Tell the headset its new name so lobby UI updates immediately.
          send(dev.ws, { type: "welcome", deviceName: name });
          broadcastRoster();
        }
        break;
      }
      case "command": {
        const n = routeCommand(msg);
        console.log(`→ command "${msg.action}" to ${msg.target || "all"} (${n} device${n === 1 ? "" : "s"})`);
        break;
      }
      case "catalog": {
        // From Command: the org's entitled modules. Cache + fan out to every
        // headset so lobbies reveal exactly what the org owns.
        if (client.role !== "controller" || !Array.isArray(msg.modules)) break;
        catalog = msg.modules
          .filter((m) => m && typeof m.id === "string" && m.id)
          .map((m) => ({
            id: m.id,
            name: typeof m.name === "string" ? m.name : m.id,
            content: m.content === "addressable" ? "addressable" : "builtin",
          }));
        const out = { type: "catalog", modules: catalog };
        for (const d of devices()) send(d.ws, out);
        console.log(`→ catalog [${catalog.map((m) => m.id).join(", ") || "empty"}] to ${devices().length} device(s)`);
        break;
      }
      default:
        break;
    }
  });

  ws.on("close", () => {
    clients.delete(client);
    if (client.role === "device") console.log(`✗ device left: ${client.deviceName}`);
    broadcastRoster();
  });

  ws.on("error", () => {});
});

server.listen(PORT, () => {
  console.log(`\nSentari relay listening on port ${PORT}`);
  console.log(`  WebSocket : ws://<this-laptop-ip>:${PORT}`);
  console.log(`  Console   : http://<this-laptop-ip>:${PORT}`);
  // Advertise over mDNS so headsets on the same WiFi auto-find us.
  advertise(PORT, RELAY_NAME);
  console.log("");
});

// ── Built-in browser debug console (no app needed to test) ──────
const CONSOLE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentari Relay — Console</title>
<style>
  :root{--canvas:#0C1219;--surface:#111A24;--elev:#18232F;--snow:#F7F9FB;--teal:#3DB4FF;--sky:#00D4FF;--amber:#B5701A;--line:rgba(247,249,251,.09)}
  *{box-sizing:border-box;font-family:-apple-system,Inter,system-ui,sans-serif}
  body{margin:0;background:var(--canvas);color:var(--snow);padding:24px;max-width:760px;margin:0 auto}
  h1{font-size:18px;letter-spacing:3px;margin:0}
  .kick{color:var(--teal);font-family:ui-monospace,monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px;margin-top:16px}
  .dot{display:inline-block;width:8px;height:8px;border-radius:4px;margin-right:8px}
  .dev{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line)}
  .mono{font-family:ui-monospace,monospace;font-size:12px;color:rgba(247,249,251,.7)}
  input,button{font-size:14px;border-radius:10px;border:1px solid var(--line);padding:10px 12px}
  input{background:var(--elev);color:var(--snow);flex:1}
  button{background:var(--teal);color:#0E1726;font-weight:600;border:none;cursor:pointer}
  .row{display:flex;gap:8px;margin-top:12px}
  #status{font-family:ui-monospace,monospace;font-size:12px}
</style></head><body>
  <div class="kick">SENTARI COMMAND · RELAY CONSOLE</div>
  <h1>SENTARI RELAY</h1>
  <div class="card">
    <div class="kick" style="margin-bottom:8px">CONNECTED HEADSETS</div>
    <div id="devices"><span class="mono">No devices yet…</span></div>
  </div>
  <div class="card">
    <div class="kick" style="margin-bottom:8px">PUSH TEXT TO ALL</div>
    <div class="row">
      <input id="text" placeholder='e.g. "Everyone begin Module 3"' value="Connected to Sentari Command">
      <button onclick="push()">Send</button>
    </div>
    <div id="status" class="mono" style="margin-top:10px"></div>
  </div>
<script>
  const ws = new WebSocket("ws://" + location.host);
  ws.onopen = () => ws.send(JSON.stringify({type:"register", role:"controller"}));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "devices") render(m.devices);
  };
  function color(s){ return s==="offline"?"#7A828C":(s==="in-session"?"#3DB4FF":"#00D4FF"); }
  function render(devs){
    const el = document.getElementById("devices");
    if(!devs.length){ el.innerHTML = '<span class="mono">No devices yet…</span>'; return; }
    el.innerHTML = devs.map(d =>
      '<div class="dev"><div><span class="dot" style="background:'+color(d.status)+'"></span>'
      + '<b>'+d.deviceName+'</b> <span class="mono">'+d.model+'</span></div>'
      + '<span class="mono">'+d.battery+'% · '+d.status+(d.lesson?' · '+d.lesson:'')+(d.paused?' · paused':'')+(d.elapsedSec?' · '+d.elapsedSec+'s':'')+'</span></div>').join("");
  }
  function push(){
    const text = document.getElementById("text").value;
    ws.send(JSON.stringify({type:"command", target:"all", action:"showText", payload:{text}}));
    document.getElementById("status").textContent = '→ sent "'+text+'" to all headsets';
  }
</script></body></html>`;
