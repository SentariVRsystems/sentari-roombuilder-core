// Live-tracking and replay types shared by every app that draws trainees moving
// through a built room. Deliberately app-agnostic: no relay, no store, no
// persistence — just the shapes the canvas and the recorder agree on.
//
// Sentari Command layers squads/facilities on top of these; Build & Breach
// Builder uses them directly. Both feed the same LiveTrackingLayer.

import { CELL_METERS, clampRoomCells, ROOM_H, ROOM_W } from "./rooms";

// A headset's real-world play-area rectangle, in METERS (the Quest's Guardian
// bounds, reported over the relay heartbeat). Used to size a room to the space
// the trainee actually has.
export type Space = { w: number; h: number };

// A point on the fading movement trail: position in cells + epoch ms.
export type TrailPoint = { x: number; y: number; t: number };

// A recorded motion frame: position, view heading, and gun heading.
export type Frame = { x: number; y: number; facing: number; gun: number; firing?: boolean; t: number };

// How long the gun line reads as "firing" after a shot, in replay. Matches the
// live hold: a recorded firing frame covers only one pose interval (~143 ms), so
// sampling the single frame under the playhead made shots flicker past unseen.
export const FIRING_FLASH_MS = 500;

// The minimal shape the tracking layer draws. Both a live headset and a replay
// sample satisfy it, so the canvas never knows which it's rendering.
export type TrackMark = {
  id: string;
  deviceName: string;
  x: number; // position in cells
  y: number;
  facing: number; // head/view heading in degrees (0 = +x / east, clockwise)
  gunAngle: number; // where the weapon points (degrees)
  firing?: boolean; // fired since the last pose — the gun line goes red
  trail: TrailPoint[];
};

// The minimal shape the roster panel lists. Command's richer BuildHeadset
// satisfies it structurally.
export type TrackedHeadset = {
  id: string;
  deviceName: string;
  battery: number;
  space?: Space;
};

// One NPC's recorded motion: position (cells) + facing over time.
export type NpcFrame = { x: number; y: number; facing: number; alive?: boolean; t: number };
export type NpcTrack = { id: string; path: NpcFrame[] };

// A live/sampled NPC position, keyed by the layout object id. Screens override
// the static NPC marker with this so targets move on the map.
export type NpcPositions = Record<string, { x: number; y: number; facing: number; alive?: boolean }>;

// A recorded run, normalized so timestamps start at 0.
export type Replay = {
  roomId: string;
  tracks: { id: string; deviceName: string; path: Frame[] }[];
  npcTracks?: NpcTrack[]; // recorded NPC motion (empty on older runs)
  duration: number; // ms
  t: number; // playhead, ms
  playing: boolean;
};

// Every recorded NPC's position at playhead `t` (ms), keyed by object id — feeds
// the same npc-override the live view uses, so replay shows targets moving too.
export function sampleNpcsAt(replay: Replay, t: number): NpcPositions {
  const out: NpcPositions = {};
  for (const tr of replay.npcTracks ?? []) {
    const path = tr.path;
    if (!path.length) continue;
    let i = 0;
    while (i + 1 < path.length && path[i + 1].t <= t) i++;
    const f = path[i];
    // Carry `alive` so the replay marks kills the same way the live map does —
    // without it a recorded run showed every target still standing.
    out[tr.id] = { x: f.x, y: f.y, facing: f.facing, alive: f.alive };
  }
  return out;
}

// How long a movement trail stays visible, in ms.
export const TRAIL_MS = 10_000;

// Largest room, in cells, that fits inside EVERY reported play area — the
// per-axis minimum. Null when nothing reported a usable space. Floored to whole
// cells so the fitted room never exceeds anyone's boundary.
export function fitCellsForSpaces(spaces: (Space | undefined)[]): { width: number; height: number } | null {
  const usable = spaces.filter((s): s is Space => !!s && s.w > 0 && s.h > 0);
  if (!usable.length) return null;
  const w = Math.min(...usable.map((s) => s.w));
  const h = Math.min(...usable.map((s) => s.h));
  return {
    width: clampRoomCells(Math.floor(w / CELL_METERS)),
    height: clampRoomCells(Math.floor(h / CELL_METERS)),
  };
}

// Trim a trail to the last `windowMs`, dropping points that have aged out.
export function trimTrail(trail: TrailPoint[], now: number, windowMs = TRAIL_MS): TrailPoint[] {
  const cutoff = now - windowMs;
  const first = trail.findIndex((p) => p.t >= cutoff);
  return first <= 0 ? trail : trail.slice(first);
}

// Sample every track at playhead `t` (ms from the start of the run), producing
// marks the tracking layer can draw.
//
// Unlike the LIVE view — which fades the trail out after TRAIL_MS so the canvas
// shows only recent movement — a replay draws the WHOLE path walked so far by
// default: reviewing a run is about seeing the route, not the last few seconds.
// Pass `windowMs` to get the live-style fading trail instead.
export function sampleReplayAt(replay: Replay, t: number, windowMs = Infinity): TrackMark[] {
  return replay.tracks.map((track) => {
    const path = track.path;
    // A track with no frames still has to render somewhere — park it at the
    // room's center rather than dropping the headset out of the replay.
    if (!path.length) {
      return { id: track.id, deviceName: track.deviceName, x: ROOM_W / 2, y: ROOM_H / 2, facing: 0, gunAngle: 0, trail: [] };
    }
    // Last frame at or before the playhead (paths are time-ordered).
    let i = 0;
    while (i + 1 < path.length && path[i + 1].t <= t) i++;
    const f = path[i];
    const cutoff = t - windowMs;
    const trail: TrailPoint[] = [];
    for (let j = i; j >= 0 && path[j].t >= cutoff; j--) trail.unshift({ x: path[j].x, y: path[j].y, t: path[j].t });
    // Fired at any point in the last half-second of playback? Look back rather
    // than testing only `f`, so a shot flashes for the same duration it does live.
    let firing = false;
    for (let j = i; j >= 0 && f.t - path[j].t <= FIRING_FLASH_MS; j--) {
      if (path[j].firing) { firing = true; break; }
    }
    return { id: track.id, deviceName: track.deviceName, x: f.x, y: f.y, facing: f.facing, gunAngle: f.gun, firing, trail };
  });
}
