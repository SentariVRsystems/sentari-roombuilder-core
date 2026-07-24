// Fake headsets for testing — connects N simulated devices to the relay so
// Sentari Command can be exercised end-to-end without real Quest hardware.
//
// Unlike the in-app sim (constants/relay.ts SIMULATED_HEADSETS), these go
// through the actual WebSocket relay: they register, heartbeat, obey
// loadLesson/start/pause/end/resetLesson, and report quiz results a while
// after a lab starts. Names Quest-03… shadow the in-app sims, so the app's
// dedupe (real wins) swaps them in transparently.
//
//   node fake-headsets.js                # 6 headsets → ws://localhost:8080
//   COUNT=10 RELAY=ws://host:8080 node fake-headsets.js
//   BUILD=3 node fake-headsets.js        # first 3 report status:"building"
//                                          (Room Builder roster); they obey
//                                          loadRoom and stream poses in it

import WebSocket from "ws";

const RELAY = process.env.RELAY || "ws://localhost:8080";
const COUNT = Math.max(1, parseInt(process.env.COUNT || "6", 10));
const BUILD = Math.max(0, parseInt(process.env.BUILD || "0", 10));
const POSE_MS = 150; // pose cadence while a pushed room is live (~6.7 Hz)

const LESSONS = ["heart", "brain", "lungs", "skeleton", "muscles"];
const MODELS = ["Meta Quest 3", "Meta Quest 3S"];

// Varied starting states so the bay looks lived-in.
const PLAN = [
  { status: "in-session", lesson: "heart", elapsedSec: 64 },
  { status: "in-session", lesson: "brain", elapsedSec: 128 },
  { status: "online" },
  { status: "in-session", lesson: "skeleton", paused: true, elapsedSec: 205 },
  { status: "charging" },
  { status: "in-session", lesson: "muscles", elapsedSec: 33 },
];

// Varied fake Guardian play areas (meters), so "fit room to squad" has a
// meaningful smallest-space to snap to. Real headsets report their own.
const SPACES = [
  { w: 6.0, h: 4.2 }, { w: 5.5, h: 4.0 }, { w: 4.8, h: 4.5 }, { w: 6.2, h: 3.8 },
  { w: 5.0, h: 5.0 }, { w: 4.5, h: 3.5 }, { w: 5.8, h: 4.4 }, { w: 7.0, h: 5.0 },
];

function makeHeadset(i) {
  const n = i + 3; // Quest-03…
  const building = i < BUILD; // first BUILD headsets are in Instructor Build
  const p = building ? {} : PLAN[i % PLAN.length];
  return {
    deviceId: `sim-headset-${String(n).padStart(2, "0")}`,
    deviceName: `Quest-${String(n).padStart(2, "0")}`,
    model: MODELS[i % MODELS.length],
    battery: [76, 91, 58, 83, 100, 44, 69, 17][i % 8],
    status: building ? "building" : p.status ?? "online",
    lesson: p.lesson ?? null,
    paused: p.paused ?? false,
    elapsedSec: p.elapsedSec ?? 0,
    space: SPACES[i % SPACES.length], // reported play-area size (meters)
    quizzed: new Set(), // lessons already scored this run
    room: null, // pushed Room Builder layout (loadRoom payload)
    pose: null, // simulated trainee pose while a room is live
    ws: null,
  };
}

// Start a simulated trainee at the room's start marker (or center).
function enterRoom(h, room) {
  h.room = room;
  const start = (room.objects || []).find((o) => o.kind === "start");
  h.pose = {
    x: start?.x ?? room.width / 2,
    y: start?.y ?? room.height / 2,
    facing: -90,
    gun: -90,
    targetX: 2 + Math.random() * (room.width - 4),
    targetY: 2 + Math.random() * (room.height - 4),
  };
}

// One pose step: bounded random walk toward a target, face the direction of
// travel, sweep the gun around it — same shape Command's mock sim produced.
function stepPose(h) {
  const p = h.pose;
  const room = h.room;
  const dx = p.targetX - p.x;
  const dy = p.targetY - p.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.4) {
    p.targetX = 2 + Math.random() * (room.width - 4);
    p.targetY = 2 + Math.random() * (room.height - 4);
  } else {
    const step = Math.min(0.12, dist); // ~0.8 cells/s at the pose cadence
    p.x = Math.min(room.width - 0.5, Math.max(0.5, p.x + (dx / dist) * step));
    p.y = Math.min(room.height - 0.5, Math.max(0.5, p.y + (dy / dist) * step));
    p.facing = (Math.atan2(dy, dx) * 180) / Math.PI;
  }
  p.gun += (Math.random() - 0.5) * 30;
  const off = ((p.gun - p.facing + 540) % 360) - 180;
  if (Math.abs(off) > 70) p.gun = p.facing + Math.sign(off) * 70;
  h.ws?.send(
    JSON.stringify({
      type: "pose",
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      facing: Math.round(p.facing * 10) / 10,
      gun: Math.round(p.gun * 10) / 10,
    })
  );
}

function connect(h) {
  const ws = new WebSocket(RELAY);
  h.ws = ws;

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        type: "register",
        role: "device",
        deviceId: h.deviceId,
        deviceName: h.deviceName,
        model: h.model,
      })
    );
    heartbeat(h);
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== "command") return;
    const { action, payload = {} } = msg;
    switch (action) {
      case "showText":
        console.log(`  ${h.deviceName} 💬 "${payload.text}"`);
        break;
      case "loadLesson":
        h.lesson = payload.lessonId ?? null;
        h.status = "in-session";
        h.paused = false;
        h.elapsedSec = 0;
        h.quizzed.delete(h.lesson);
        break;
      case "start":
        if (h.lesson) h.status = "in-session";
        h.paused = false;
        break;
      case "pause":
        if (h.status === "in-session") h.paused = true;
        break;
      case "end":
        h.lesson = null;
        h.status = "online";
        h.paused = false;
        h.elapsedSec = 0;
        break;
      case "resetLesson":
        if (h.lesson === payload.lessonId) h.elapsedSec = 0;
        h.quizzed.delete(payload.lessonId);
        break;
      case "loadRoom":
        if (payload.room) {
          enterRoom(h, payload.room);
          console.log(`  ${h.deviceName} 🏠 room "${payload.room.name}" (${(payload.room.objects || []).length} objects) — streaming poses`);
        }
        break;
    }
    heartbeat(h); // report new state immediately, like a real headset
  });

  ws.on("close", () => setTimeout(() => connect(h), 2000));
  ws.on("error", () => {});
}

function heartbeat(h) {
  if (!h.ws || h.ws.readyState !== WebSocket.OPEN) return;
  h.ws.send(
    JSON.stringify({
      type: "heartbeat",
      battery: Math.round(h.battery),
      status: h.status,
      lesson: h.lesson,
      paused: h.paused,
      elapsedSec: Math.round(h.elapsedSec),
      space: h.space,
    })
  );
}

const headsets = Array.from({ length: COUNT }, (_, i) => makeHeadset(i));
console.log(`Connecting ${COUNT} fake headsets to ${RELAY} …`);
headsets.forEach(connect);

// 1s world tick: sessions advance, batteries drain/charge, quizzes complete.
setInterval(() => {
  for (const h of headsets) {
    if (h.status === "in-session" && !h.paused) {
      h.elapsedSec += 1;
      h.battery = Math.max(3, h.battery - 0.01); // ~36%/hr in-session
      // Finish the lab's quiz a couple of minutes in (staggered by headset).
      if (h.lesson && h.elapsedSec > 120 && !h.quizzed.has(h.lesson) && Math.random() < 0.02) {
        h.quizzed.add(h.lesson);
        const total = 3;
        const correct = 1 + Math.floor(Math.random() * 3);
        h.ws?.send(
          JSON.stringify({
            type: "quizResult",
            lesson: h.lesson,
            score: Math.round((correct / total) * 100),
            correct,
            total,
          })
        );
        console.log(`  ${h.deviceName} ✅ quiz "${h.lesson}" ${correct}/${total}`);
      }
    } else if (h.status === "charging") {
      h.battery = Math.min(100, h.battery + 0.05);
      if (h.battery >= 100) h.status = "online";
    } else {
      h.battery = Math.max(3, h.battery - 0.002);
    }
  }
}, 1000);

// Heartbeat every 3s, like the real lobby build.
setInterval(() => headsets.forEach(heartbeat), 3000);

// Pose stream while a pushed room is live (build-mode headsets only).
if (BUILD > 0) {
  console.log(`Build mode: ${Math.min(BUILD, COUNT)} headset(s) reporting status:"building"`);
  setInterval(() => {
    for (const h of headsets) {
      if (h.room && h.pose && h.ws?.readyState === WebSocket.OPEN) stepPose(h);
    }
  }, POSE_MS);
}
