// The Sentari relay wire contract, for the parts the Room Builder owns.
//
// One WebSocket, JSON messages, two roles: `device` (a Quest running Build &
// Breach) and `controller` (Sentari Command, or Build & Breach Builder). This
// module is the single definition of the room-push and pose messages, so the
// enterprise app and the hobbyist Builder can never drift apart on the wire —
// one headset build talks to both.
//
// Full protocol: SentariCommand/server/protocol.md.

import { CELL_METERS, type Room } from "./rooms";

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
  space?: { w: number; h: number }; // Guardian play-area size in meters
};

// A pose sample: trainee position in the pushed room's GRID CELLS, head and gun
// headings in degrees (0° = +x/east, increasing clockwise in the top-down view).
// The relay stamps `t` and fans these to controllers only — poses are never part
// of the roster broadcast.
export type DevicePose = { deviceName: string; x: number; y: number; facing: number; gun: number; t: number };

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
    t: Number(p.t) || now,
  };
}

// ── Controller → device ─────────────────────────────────────────

// The `loadRoom` payload: what RoomBuilderLoader.cs instantiates on the Quest.
// `cell` is meters-per-cell, so the headset can convert the cell coordinates to
// world space without hard-coding the grid scale. `rot` is degrees.
// `behavior` is present only for targets/NPCs — the disposition the headset
// applies as the NPC's alignment (Hostile/Compliant/Afraid/CompToHostile, or
// Random to pick at spawn). Omitted for walls/doors/furniture.
export type LoadRoomObject = {
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
    objects: LoadRoomObject[];
  };
};

// Build the `loadRoom` payload for a room. The ONE place the wire shape is
// produced — both apps push identical bytes.
export function buildLoadRoomPayload(room: Room): LoadRoomPayload {
  return {
    room: {
      id: room.id,
      name: room.name,
      cell: CELL_METERS,
      width: room.width,
      height: room.height,
      objects: room.objects.map((o) => ({
        kind: o.kind, x: o.x, y: o.y, rot: o.rotation, w: o.w, h: o.h,
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
