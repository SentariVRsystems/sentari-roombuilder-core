// The Sentari relay wire contract, for the parts the Room Builder owns.
//
// One WebSocket, JSON messages, two roles: `device` (a Quest running Build &
// Breach) and `controller` (Sentari Command, or Build & Breach Builder). This
// module is the single definition of the room-push and pose messages, so the
// enterprise app and the hobbyist Builder can never drift apart on the wire —
// one headset build talks to both.
//
// Full protocol: SentariCommand/server/protocol.md.

import { CELL_METERS, wallsWithDoorGaps, type Room } from "./rooms";

// ── Device → controller ─────────────────────────────────────────

// `building` = the headset opted into the instructor/builder-run mode. The wire
// value stays "building" for compatibility; Command calls the mode
// "Instructor-Led" and the Builder calls it "Builder Mode".
export type DeviceStatus = "online" | "in-session" | "charging" | "offline" | "building";
export const BUILD_STATUS: DeviceStatus = "building";

export type RelayDevice = {
  id: number;
  deviceName: string;
  model: string;
  battery: number;
  status: DeviceStatus;
  lesson: string | null;
  paused?: boolean;
  elapsedSec?: number;
  lastSeen: number;
  // Where a headset is in the Instructor-Led flow, so the instructor isn't pushing
  // blind: calibrating | loadout | armed | running | debrief ("" outside the flow).
  phase?: string;
  space?: { w: number; h: number }; // Guardian play-area size in meters
};

// A pose sample: trainee position in the pushed room's GRID CELLS, head and gun
// headings in degrees (0° = +x/east, increasing clockwise in the top-down view).
// The relay stamps `t` and fans these to controllers only — poses are never part
// of the roster broadcast.
export type DevicePose = {
  deviceName: string;
  x: number;
  y: number;
  facing: number;
  gun: number;
  firing: boolean;
  /** true = no room is pushed yet: x/y are START-relative cells (anchor the mark at the room's start object). */
  rel?: boolean;
  t: number;
};

// Parse an incoming `pose` frame defensively — a malformed field must not blow
// up the tracking loop. Returns null when the message isn't a usable pose.
export function parsePose(m: unknown, now: number): DevicePose | null {
  const p = m as Partial<DevicePose> & { type?: string };
  if (!p || p.type !== "pose" || typeof p.deviceName !== "string") return null;
  return {
    deviceName: p.deviceName,
    x: Number(p.x) || 0,
    y: Number(p.y) || 0,
    facing: Number(p.facing) || 0,
    gun: Number(p.gun) || 0,
    firing: !!p.firing,
    rel: !!p.rel,
    t: Number(p.t) || now,
  };
}

// An NPC's live position in the pushed room's GRID CELLS + facing heading. `id`
// matches the placed object's id from the loadRoom payload, so a controller can
// correlate a moving NPC back to the target it authored. The headset streams
// these as one batched `npcPoses` message (all NPCs at once) while a room is
// live; the relay fans it to controllers only.
export type NpcPose = {
  id: string;
  x: number;
  y: number;
  facing: number;
  alive: boolean;
  /** The NPC's CURRENT behavior ("hostile" | "compliant" | "afraid" | "comptohostile") — live because
   *  "random" targets roll at mission start and comply-then-turn NPCs flip mid-run. */
  beh?: string;
  /** Fired at least one round since the last batch — the map flashes the shooter. */
  firing?: boolean;
  /** DETAINED: the surrender animation finished — kneeling, hands behind the head. */
  det?: boolean;
};

// Parse an incoming `npcPoses` batch. Returns [] for anything malformed so a bad
// frame can't break the tracking loop.
// A door's live swing angle in the pushed room. `id` matches the placed object,
// `angle` is degrees from closed — the map draws the leaf there instead of shut.
export type DoorState = { id: string; angle: number };
export type DoorAngles = Record<string, number>;

// The corners of a headset's real space (any polygon), in METERS on the map's
// axes, in WALK ORDER. Reference geometry only — the Room Builder outlines it
// so the instructor can see the space they're authoring into.
export type BoundsPoint = { x: number; y: number };

export function parseBounds(m: unknown): BoundsPoint[] {
  const b = m as { type?: string; points?: unknown };
  if (!b || b.type !== "bounds" || !Array.isArray(b.points)) return [];
  const out: BoundsPoint[] = [];
  for (const raw of b.points) {
    const p = raw as Partial<BoundsPoint>;
    if (!p || typeof p.x !== "number" || typeof p.y !== "number") continue;
    out.push({ x: Number(p.x) || 0, y: Number(p.y) || 0 });
  }
  // WALK ORDER preserved: the trainee traces the perimeter and explicitly
  // closes the loop, so the marked sequence IS the polygon. The old sort-by-
  // angle-around-centroid (a fixed-four bowtie guard) mangled concave spaces.
  return out;
}

// The bounds polygon in canvas cells, CENTERED on the room grid (pass the
// room's dims). Centering matches how the grid itself resizes — from its
// middle — so growing the room adds space on ALL sides of the outline instead
// of pinning it in the top-left corner. The instructor drags the ROOM into the
// outline (shift-room mode), not the other way round. `origin` is corner 0 in
// those cells: the point the headset anchors everything to (its walk-derived
// pose), which the push payload carries so the built room lands exactly where
// the plan shows it relative to the real space. Every consumer (canvas draw,
// idle tracking, push payload) must pass the SAME room dims or the map and the
// house disagree about where the outline sits.
export function boundsCellPolygon(points: BoundsPoint[], roomW?: number, roomH?: number): { pts: BoundsPoint[]; origin: BoundsPoint } | null {
  if (points.length < 3) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = (Math.max(...xs) - minX) / CELL_METERS;
  const h = (Math.max(...ys) - minY) / CELL_METERS;
  const ox = roomW !== undefined ? (roomW - w) / 2 : 0;
  const oy = roomH !== undefined ? (roomH - h) / 2 : 0;
  const pts = points.map((p) => ({ x: (p.x - minX) / CELL_METERS + ox, y: (p.y - minY) / CELL_METERS + oy }));
  return { pts, origin: pts[0] };
}

export function parseDoorStates(m: unknown): DoorState[] {
  const b = m as { type?: string; doors?: unknown };
  if (!b || b.type !== "doorStates" || !Array.isArray(b.doors)) return [];
  const out: DoorState[] = [];
  for (const raw of b.doors) {
    const d = raw as Partial<DoorState>;
    if (!d || typeof d.id !== "string") continue;
    out.push({ id: d.id, angle: Number(d.angle) || 0 });
  }
  return out;
}

export function parseNpcPoses(m: unknown): NpcPose[] {
  const b = m as { type?: string; npcs?: unknown };
  if (!b || b.type !== "npcPoses" || !Array.isArray(b.npcs)) return [];
  const out: NpcPose[] = [];
  for (const raw of b.npcs) {
    const n = raw as Partial<NpcPose>;
    if (!n || typeof n.id !== "string") continue;
    // alive defaults TRUE so a headset build that predates kill reporting still draws.
    out.push({
      id: n.id,
      x: Number(n.x) || 0,
      y: Number(n.y) || 0,
      facing: Number(n.facing) || 0,
      alive: n.alive !== false,
      ...(typeof n.beh === "string" && n.beh ? { beh: n.beh } : {}),
      firing: !!n.firing,
      det: !!n.det,
    });
  }
  return out;
}

// ── Controller → device ─────────────────────────────────────────

// The `loadRoom` payload: what RoomBuilderLoader.cs instantiates on the Quest.
// `cell` is meters-per-cell, so the headset can convert the cell coordinates to
// world space without hard-coding the grid scale. `rot` is degrees.
// `behavior` is present only for targets/NPCs — the disposition the headset
// applies as the NPC's alignment (Hostile/Compliant/Afraid/CompToHostile, or
// Random to pick at spawn). Omitted for walls/doors/furniture.
export type LoadRoomObject = {
  id: string; // the placed object's id — lets the headset key NPC pose reports back to it
  kind: string;
  x: number;
  y: number;
  rot: number;
  w: number;
  h: number;
  behavior?: string;
};
export type LoadRoomPayload = {
  room: {
    id: string;
    name: string;
    cell: number;
    width: number; // room size in cells
    height: number;
    // Where the headset's walk anchor (bounds corner 0) sits in room cells —
    // present when the controller has the space's bounds. The headset pins THIS
    // cell to its anchor pose, so the room lands where the plan shows it inside
    // the outline. Absent → the headset falls back to anchoring the start cell.
    // Flat fields + flag (not a nested object) because Unity's JsonUtility
    // default-constructs missing nested objects, making absence undetectable.
    hasOrigin?: boolean;
    originX?: number;
    originY?: number;
    objects: LoadRoomObject[];
  };
};

// Build the `loadRoom` payload for a room. The ONE place the wire shape is
// produced — both apps push identical bytes. `origin` = the bounds anchor
// (corner 0) in room cells, from boundsCellPolygon, when bounds are known.
export function buildLoadRoomPayload(room: Room, origin?: BoundsPoint): LoadRoomPayload {
  return {
    room: {
      id: room.id,
      name: room.name,
      cell: CELL_METERS,
      width: room.width,
      height: room.height,
      ...(origin ? { hasOrigin: true, originX: origin.x, originY: origin.y } : {}),
      // Cut a door-width opening in every wall a door sits on, so the door's
      // leaf swings through the gap instead of into the wall body.
      objects: wallsWithDoorGaps(room.objects).map((o) => ({
        id: o.id, kind: o.kind, x: o.x, y: o.y, rot: o.rotation, w: o.w, h: o.h,
        ...(o.behavior ? { behavior: o.behavior } : {}),
      })),
    },
  };
}

// A `command` envelope, routed by the relay to `target` (a deviceName, or
// "all"). Actions the Room Builder uses: loadRoom, end.
export type CommandMessage = {
  type: "command";
  target: string;
  action: string;
  payload?: Record<string, unknown>;
};

export const registerController = () => JSON.stringify({ type: "register", role: "controller" });

export function commandMessage(target: string, action: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "command", target, action, payload });
}
