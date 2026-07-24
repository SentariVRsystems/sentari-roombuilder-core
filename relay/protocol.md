# Sentari relay protocol (v0)

Plain JSON over a single WebSocket connection. Every message has a `type`.
Transport: `ws://<laptop-ip>:8080` on the local network.

There are two client **roles**: `device` (a headset) and `controller`
(Sentari Command app, or the built-in debug console).

---

## Device → Server

**register** — first message after connecting:
```json
{ "type": "register", "role": "device", "deviceName": "Quest-01", "model": "Meta Quest 3" }
```

**heartbeat** — every ~3s (and immediately after handling a command):
```json
{ "type": "heartbeat", "battery": 84, "status": "in-session",
  "lesson": "lesson1", "paused": false, "elapsedSec": 73,
  "space": { "w": 5.8, "h": 4.2 } }
```
`status`: `"online" | "in-session" | "charging" | "building"`. `lesson`: current
lesson id or `null`. `paused`: true if the in-session drill is frozen.
`elapsedSec`: wall-clock seconds since the current module loaded (0 in the
lobby). `building` = the headset opted into **Instructor-Led** mode (the
Sentari Command Room Builder runs the session); Command lists it in the
Instructor-Led roster. The wire value stays `building` for compatibility —
only the human-facing mode name is "Instructor-Led".
`space` (optional): the headset's Guardian **play-area** size in meters
(`w` = width, `h` = depth). Lets the Room Builder size a room to the space the
trainee actually has ("fit room to squad" = the per-axis minimum across a
squad). Omitted / `0×0` when no boundary is configured; the relay ignores that.

**pose** — ~5–10 Hz while a pushed room is live (Room Builder tracking):
```json
{ "type": "pose", "x": 11.4, "y": 9.2, "facing": -87.5, "gun": -60.0 }
```
`x,y`: trainee position in the pushed room's **grid cells** (the same
coordinates as the `loadRoom` layout — the headset converts world → cells).
`facing`: head/view heading, `gun`: weapon heading — both in degrees,
`0° = +x (east)`, increasing clockwise in the top-down view. The relay stamps
the sender and fans it out to controllers only (see Server → Controller); it is
deliberately **not** part of the roster broadcast.

**quizResult** — sent once when a headset finishes a lab/lesson quiz:
```json
{ "type": "quizResult", "lesson": "firstlaw", "score": 80, "correct": 4, "total": 5 }
```
`lesson`: the lesson id that was quizzed. `score`: 0-100. `correct`/`total` optional.
The relay keys these by `deviceName|lesson` (latest wins) and broadcasts the set to
controllers; a `resetLesson` command for that lesson clears them.

---

## Controller → Server

**register**:
```json
{ "type": "register", "role": "controller" }
```

**command** — routed to a device by `deviceName`/`id`, or `"all"`:
```json
{ "type": "command", "target": "all", "action": "showText", "payload": { "text": "Begin Module 3" } }
```

**catalog** — the org's entitled module list (Command sends it on connect and
whenever the library changes, e.g. after a marketplace "Get"):
```json
{ "type": "catalog", "modules": [
  { "id": "module1", "name": "Build & Breach CQB", "content": "builtin" }
] }
```
`id` is the ModuleLoader registry key. `content`: `"builtin"` = the scene ships
in the Lobby build (just reveal it); `"addressable"` = downloadable bundle
(Phase 2 — will carry a bundle URL). The relay caches the latest list and
forwards it to every headset, including ones that connect later. One relay
serves one org, so last-write-wins.

Defined actions (extend freely):
| action      | payload                       | meaning                       |
| ----------- | ----------------------------- | ----------------------------- |
| `showText`  | `{ "text": "..." }`           | display text on the headset   |
| `loadLesson`| `{ "lessonId": "lesson1" }`   | load a scenario               |
| `start`     | `{}`                          | start the loaded lesson       |
| `pause`     | `{}`                          | pause                         |
| `end`       | `{}`                          | end / return to lobby         |
| `resetLesson`| `{ "lessonId": "firstlaw" }` | reset/replay a lab (also clears its quiz result) |
| `loadRoom`  | `{ "room": { … } }`           | build an instructor-authored room (Room Builder) |

**loadRoom payload** — the full room layout, in grid cells (`cell` = meters per
cell, so `world = origin + (x*cell, 0, y*cell)` on the headset):
```json
{ "type": "command", "target": "all", "action": "loadRoom", "payload": {
  "room": {
    "id": "room-abc", "name": "Shooter House A",
    "cell": 0.5, "width": 24, "height": 16,
    "objects": [
      { "kind": "Concrete",   "x": 12, "y": 1,    "rot": 0,  "w": 20, "h": 0.5 },
      { "kind": "Brown Door", "x": 12, "y": 11.5, "rot": 90, "w": 2,  "h": 0.5 },
      { "kind": "Sofa01",     "x": 17, "y": 10,   "rot": 0,  "w": 4,  "h": 2 },
      { "kind": "start",      "x": 12, "y": 14,   "rot": 0,  "w": 1,  "h": 1 }
    ]
  }
} }
```
`kind` matches a Build & Breach catalog `displayName` (walls/doors/furniture/
NPCs) or `start` (trainee spawn — not a prefab). `x,y` = object **center** in
cells; `rot` = degrees CW in the top-down view; for walls `w` is the length and
`h` the thickness. A second push replaces the previous room. Full contract:
`docs/room-builder-integration.md`.

---

## Server → Device

**welcome** (after register):
```json
{ "type": "welcome", "id": 3, "role": "device" }
```

**command** (forwarded from a controller):
```json
{ "type": "command", "action": "showText", "payload": { "text": "Begin Module 3" } }
```

**catalog** — the org's entitled modules (sent right after `welcome` if known,
and again whenever Command announces a change). The Lobby menu should show
exactly these:
```json
{ "type": "catalog", "modules": [
  { "id": "module1", "name": "Build & Breach CQB", "content": "builtin" }
] }
```

## Server → Controller

**devices** — the live roster, broadcast whenever it changes:
```json
{ "type": "devices", "devices": [
  { "id": 3, "deviceName": "Quest-01", "model": "Meta Quest 3",
    "battery": 84, "status": "in-session", "lesson": "lesson1",
    "paused": false, "elapsedSec": 73, "space": { "w": 5.8, "h": 4.2 },
    "lastSeen": 1718900000000 }
] }
```
`space` (when reported) is the headset's Guardian play-area size in meters; used
by the Room Builder to size a room to the trainees' real space.

**pose** — forwarded per device as poses arrive (~5–10 Hz per headset in a
live room; the relay stamps `deviceName` + `t`):
```json
{ "type": "pose", "deviceName": "Quest-01",
  "x": 11.4, "y": 9.2, "facing": -87.5, "gun": -60.0, "t": 1718900000000 }
```

**quizResults** — broadcast whenever a result arrives (and on controller register):
```json
{ "type": "quizResults", "results": [
  { "deviceName": "Quest-01", "lesson": "firstlaw", "score": 80,
    "correct": 4, "total": 5, "at": 1718900000000 }
] }
```

---

### Notes
- Devices also receive the `devices` roster (lobby join-up UX), but with
  `lesson` coarsened to the parent module id (`"lungs"` → `"module3"`; unknown
  lesson ids → `null`). The specific lab a trainee is in is controller-only.
- A device drops off the roster automatically when its socket closes.
- `showText` is the v0 proof action. `loadLesson/start/pause/end` use the exact
  same plumbing — only the headset's handler changes.
