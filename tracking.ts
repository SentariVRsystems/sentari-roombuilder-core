// Live-tracking and replay types shared by every app that draws trainees moving
// through a built room. Deliberately app-agnostic: no relay, no store, no
// persistence — just the shapes the canvas and the recorder agree on.
//
// Sentari Command layers squads/facilities on top of these; Build & Breach
// Builder uses them directly. Both feed the same LiveTrackingLayer.

import { CELL_METERS, clampRoomCells, MIN_ROOM_CELLS, ROOM_H, ROOM_W } from "./rooms";

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
  phase?: string; // Instructor-Led step, so the roster can show readiness
};

// One NPC's recorded motion: position (cells) + facing over time.
export type NpcFrame = { x: number; y: number; facing: number; alive?: boolean; beh?: string; firing?: boolean; det?: boolean; t: number };
export type NpcTrack = { id: string; path: NpcFrame[] };

// A door's swing over the course of a run, so the replay shows it opening rather
// than sitting shut. Same recorded-or-it-never-happened rule as NPC kills and the
// firing flag: if the frame doesn't carry it, playback can't invent it.
export type DoorFrame = { angle: number; t: number };
export type DoorTrack = { id: string; path: DoorFrame[] };

// A live/sampled NPC position, keyed by the layout object id. Screens override
// the static NPC marker with this so targets move on the map.
export type NpcPositions = Record<string, { x: number; y: number; facing: number; alive?: boolean; beh?: string; firing?: boolean; det?: boolean }>;

// A recorded run, normalized so timestamps start at 0.
export type Replay = {
  roomId: string;
  tracks: { id: string; deviceName: string; path: Frame[] }[];
  npcTracks?: NpcTrack[]; // recorded NPC motion (empty on older runs)
  doorTracks?: DoorTrack[]; // recorded door swing (empty on older runs)
  duration: number; // ms
  t: number; // playhead, ms
  playing: boolean;
  /** Playhead offset (ms) at which the house went hot — the moment the headset
   *  reported `running`, which is when its countdown cue starts. Undefined on
   *  runs recorded before this was captured. */
  hotT?: number;
};

/** Seconds the headset counts down after reporting `running` before the house is
 *  actually hot. Mirrors BuildAndBreachCanvasController.CountdownSeconds — the
 *  count itself never goes on the wire, only the moment it starts, so anything
 *  displaying the number is reproducing it from here. Keep the two in sync. */
export const HOT_COUNTDOWN_SECONDS = 5;

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
    out[tr.id] = { x: f.x, y: f.y, facing: f.facing, alive: f.alive, beh: f.beh, firing: f.firing, det: f.det };
  }
  return out;
}

/// Door angles at the playhead, keyed by object id — the replay's equivalent of
/// the live doorStates stream.
export function sampleDoorsAt(replay: Replay, t: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const tr of replay.doorTracks ?? []) {
    const path = tr.path;
    if (!path.length) continue;
    let i = 0;
    while (i + 1 < path.length && path[i + 1].t <= t) i++;
    out[tr.id] = path[i].angle;
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

// Largest room, in cells, that fits INSIDE a walked-out bounds polygon at the
// position pushes anchor it to. fitCellsForSpaces trusts the headset's
// reported w×h — but that rectangle lives in the GUARDIAN'S frame. A play
// space placed at an angle to the room grid is a ROTATED rectangle on the
// map, and a room of the reported size pokes out of its corners (and gets
// built outside the real space, since the push anchors the room to the
// bounds). This fits in the MAP frame instead: the room rect is centered on
// the polygon's bounding-box center — the same centering boundsCellPolygon
// applies — so what fits here is exactly what fits on the floor. Uniform-
// shrink the bounding box until it fits, then grow each axis back
// independently to recover area.
export function fitCellsForBounds(points: { x: number; y: number }[]): { width: number; height: number } | null {
  if (points.length < 3) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const A = (Math.max(...xs) - Math.min(...xs)) / 2;
  const B = (Math.max(...ys) - Math.min(...ys)) / 2;
  if (A <= 0 || B <= 0) return null;

  const inside = (x: number, y: number) => {
    let inPoly = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const pi = points[i];
      const pj = points[j];
      if (pi.y > y !== pj.y > y && x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) inPoly = !inPoly;
    }
    return inPoly;
  };
  // The whole rect perimeter must be inside, sampled every ~20 cm so a
  // concave notch between corners can't slip through.
  const rectFits = (a: number, b: number) => {
    const nx = Math.max(2, Math.ceil((2 * a) / 0.2));
    const ny = Math.max(2, Math.ceil((2 * b) / 0.2));
    for (let i = 0; i <= nx; i++) {
      const x = cx - a + (2 * a * i) / nx;
      if (!inside(x, cy - b) || !inside(x, cy + b)) return false;
    }
    for (let i = 0; i <= ny; i++) {
      const y = cy - b + (2 * b * i) / ny;
      if (!inside(cx - a, y) || !inside(cx + a, y)) return false;
    }
    return true;
  };
  // Binary search the largest passing value in [lo, hi]; null if even lo fails.
  const largest = (fits: (t: number) => boolean, lo: number, hi: number): number | null => {
    if (!fits(lo)) return null;
    for (let k = 0; k < 20; k++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const s = largest((t) => rectFits(A * t, B * t), 0.02, 1);
  if (s === null) return null;
  let a = A * s;
  let b = B * s;
  a = A * (largest((t) => rectFits(A * t, b), s, 1) ?? s);
  b = B * (largest((t) => rectFits(a, B * t), s, 1) ?? s);
  return {
    width: clampRoomCells(Math.floor((2 * a) / CELL_METERS)),
    height: clampRoomCells(Math.floor((2 * b) / CELL_METERS)),
  };
}

// Where to BUILD inside a walked-out space: the room box spanning the whole
// polygon, plus the largest walkable axis-aligned rectangle ANYWHERE inside
// it, in that box's cell coordinates. fitCellsForBounds can only shrink a
// rect centered on the outline (that's where pushes anchor the room box) —
// but a real play space is often a whole home: big, concave, with the
// anchor point sitting in a hallway notch, where a centered rect collapses
// to nothing. So instead: box = the polygon's bounding box, frame = the best
// open rectangle found by rasterizing the polygon (10 cm grid) and running
// max-rectangle-in-binary-matrix. The generator then builds its house within
// `frame` while the box keeps the outline centering unchanged.
export function fitRectForBounds(
  points: { x: number; y: number }[]
): { box: { width: number; height: number }; frame: { x0: number; y0: number; x1: number; y1: number } } | null {
  if (points.length < 3) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const wM = Math.max(...xs) - minX;
  const hM = Math.max(...ys) - minY;
  if (wM <= 0.5 || hM <= 0.5) return null;
  const boxW = clampRoomCells(Math.ceil(wM / CELL_METERS));
  const boxH = clampRoomCells(Math.ceil(hM / CELL_METERS));

  const inside = (x: number, y: number) => {
    let inPoly = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const pi = points[i];
      const pj = points[j];
      if (pi.y > y !== pj.y > y && x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) inPoly = !inPoly;
    }
    return inPoly;
  };

  // Rasterize at 10 cm; a cell counts only if its center is inside.
  const step = 0.1;
  const nx = Math.ceil(wM / step);
  const ny = Math.ceil(hM / step);
  const cellInside = (i: number, j: number) => inside(minX + (i + 0.5) * step, minY + (j + 0.5) * step);

  // Max rectangle in a binary matrix via the histogram method. Prefer rects
  // whose short side is at least 1.5 m (something you can actually breach
  // through); fall back to raw max area only if nothing qualifies.
  const MIN_SIDE = Math.round(1.5 / step);
  type Rect = { area: number; i0: number; i1: number; j0: number; j1: number };
  let best: Rect | null = null;
  let bestWide: Rect | null = null;
  const heights = new Array<number>(nx).fill(0);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) heights[i] = cellInside(i, j) ? heights[i] + 1 : 0;
    const stack: number[] = [];
    for (let i = 0; i <= nx; i++) {
      const cur = i < nx ? heights[i] : 0;
      while (stack.length && heights[stack[stack.length - 1]] >= cur) {
        const hgt = heights[stack.pop()!];
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const cand: Rect = { area: hgt * (i - left), i0: left, i1: i - 1, j0: j - hgt + 1, j1: j };
        if (!best || cand.area > best.area) best = cand;
        if (Math.min(hgt, i - left) >= MIN_SIDE && (!bestWide || cand.area > bestWide.area)) bestWide = cand;
      }
      stack.push(i);
    }
  }
  const pickRect = bestWide ?? best;
  if (!pickRect || pickRect.area <= 0) return null;

  // Into room-box cells: the outline's bbox gets centered on the box
  // (boundsCellPolygon), so the frame shifts by the same centering offset.
  // Snap inward to half-cells and clamp into the box.
  const offX = (boxW - wM / CELL_METERS) / 2;
  const offY = (boxH - hM / CELL_METERS) / 2;
  const upHalf = (v: number) => Math.ceil(v * 2) / 2;
  const downHalf = (v: number) => Math.floor(v * 2) / 2;
  const frame = {
    x0: Math.max(0, upHalf((pickRect.i0 * step) / CELL_METERS + offX)),
    y0: Math.max(0, upHalf((pickRect.j0 * step) / CELL_METERS + offY)),
    x1: Math.min(boxW, downHalf(((pickRect.i1 + 1) * step) / CELL_METERS + offX)),
    y1: Math.min(boxH, downHalf(((pickRect.j1 + 1) * step) / CELL_METERS + offY)),
  };
  if (frame.x1 - frame.x0 < MIN_ROOM_CELLS || frame.y1 - frame.y0 < MIN_ROOM_CELLS) return null;
  return { box: { width: boxW, height: boxH }, frame };
}

// Decompose a walked-out space into up to three adjoining walkable
// RECTANGLES ("wings") — the input for an L- or T-shaped generated house
// that follows the play space instead of settling for one inscribed box.
// Greedy cover: take the biggest open rectangle, mask it, take the biggest
// remaining rectangle that shares an edge with a previous wing (≥2 m of
// contact, so a doorway fits), repeat once more. Wings and contacts come
// back in room-box cells, positioned under the same bbox-centering that
// boundsCellPolygon applies, so what fits here is exactly what fits on the
// floor.
export type FitWings = {
  box: { width: number; height: number };
  wings: { x0: number; y0: number; x1: number; y1: number }[];
  contacts: { a: number; b: number; axis: "x" | "y"; c: number; lo: number; hi: number }[];
};

export function fitWingsForBounds(points: { x: number; y: number }[]): FitWings | null {
  if (points.length < 3) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const wM = Math.max(...xs) - minX;
  const hM = Math.max(...ys) - minY;
  if (wM <= 0.5 || hM <= 0.5) return null;
  const boxW = clampRoomCells(Math.ceil(wM / CELL_METERS));
  const boxH = clampRoomCells(Math.ceil(hM / CELL_METERS));

  const inside = (x: number, y: number) => {
    let inPoly = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const pi = points[i];
      const pj = points[j];
      if (pi.y > y !== pj.y > y && x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) inPoly = !inPoly;
    }
    return inPoly;
  };

  const step = 0.1;
  const nx = Math.ceil(wM / step);
  const ny = Math.ceil(hM / step);
  if (nx < 4 || ny < 4) return null;
  const free = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++)
      free[j * nx + i] = inside(minX + (i + 0.5) * step, minY + (j + 0.5) * step) ? 1 : 0;

  type Rect = { area: number; i0: number; i1: number; j0: number; j1: number };
  const MIN_SIDE = Math.round(1.5 / step); // 1.5 m — a wing you can breach through
  const maxRect = (requireSide: boolean): Rect | null => {
    let best: Rect | null = null;
    let bestWide: Rect | null = null;
    const heights = new Array<number>(nx).fill(0);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) heights[i] = free[j * nx + i] ? heights[i] + 1 : 0;
      const stack: number[] = [];
      for (let i = 0; i <= nx; i++) {
        const cur = i < nx ? heights[i] : 0;
        while (stack.length && heights[stack[stack.length - 1]] >= cur) {
          const hgt = heights[stack.pop()!];
          const left = stack.length ? stack[stack.length - 1] + 1 : 0;
          const cand: Rect = { area: hgt * (i - left), i0: left, i1: i - 1, j0: j - hgt + 1, j1: j };
          if (!best || cand.area > best.area) best = cand;
          if (Math.min(hgt, i - left) >= MIN_SIDE && (!bestWide || cand.area > bestWide.area)) bestWide = cand;
        }
        stack.push(i);
      }
    }
    return bestWide ?? (requireSide ? null : best);
  };
  const clearRect = (r: Rect) => {
    for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) free[j * nx + i] = 0;
  };

  const first = maxRect(false);
  if (!first || first.area < MIN_SIDE * MIN_SIDE) return null;
  const rects: Rect[] = [first];
  type RasterContact = { a: number; b: number; axis: "x" | "y"; cRaster: number; lo: number; hi: number };
  const rContacts: RasterContact[] = [];
  clearRect(first);

  const CONTACT_MIN = Math.round(2.0 / step); // 2 m of shared edge → doorway fits after insets
  for (let n = 0; n < 2; n++) {
    const r = maxRect(true);
    if (!r || r.area < MIN_SIDE * MIN_SIDE) break;
    // Find the previous wing this one abuts (raster cells exactly adjacent).
    let attach: RasterContact | null = null;
    rects.forEach((p, pi) => {
      const yOv = Math.min(r.j1, p.j1) - Math.max(r.j0, p.j0) + 1;
      const xOv = Math.min(r.i1, p.i1) - Math.max(r.i0, p.i0) + 1;
      const consider = (cand: RasterContact, len: number) => {
        if (len >= CONTACT_MIN && (!attach || len > attach.hi - attach.lo)) attach = cand;
      };
      if (r.i0 === p.i1 + 1 && yOv >= CONTACT_MIN)
        consider({ a: pi, b: rects.length, axis: "x", cRaster: r.i0, lo: Math.max(r.j0, p.j0), hi: Math.max(r.j0, p.j0) + yOv }, yOv);
      if (r.i1 === p.i0 - 1 && yOv >= CONTACT_MIN)
        consider({ a: pi, b: rects.length, axis: "x", cRaster: p.i0, lo: Math.max(r.j0, p.j0), hi: Math.max(r.j0, p.j0) + yOv }, yOv);
      if (r.j0 === p.j1 + 1 && xOv >= CONTACT_MIN)
        consider({ a: pi, b: rects.length, axis: "y", cRaster: r.j0, lo: Math.max(r.i0, p.i0), hi: Math.max(r.i0, p.i0) + xOv }, xOv);
      if (r.j1 === p.j0 - 1 && xOv >= CONTACT_MIN)
        consider({ a: pi, b: rects.length, axis: "y", cRaster: p.j0, lo: Math.max(r.i0, p.i0), hi: Math.max(r.i0, p.i0) + xOv }, xOv);
    });
    if (!attach) break; // disconnected pocket — a house can't reach it
    rContacts.push(attach);
    rects.push(r);
    clearRect(r);
  }

  // Into room-box cells (bbox centered on the box, like boundsCellPolygon).
  const offX = (boxW - wM / CELL_METERS) / 2;
  const offY = (boxH - hM / CELL_METERS) / 2;
  const upHalf = (v: number) => Math.ceil(v * 2) / 2;
  const downHalf = (v: number) => Math.floor(v * 2) / 2;
  const roundHalf = (v: number) => Math.round(v * 2) / 2;
  const toCellX = (ri: number) => (ri * step) / CELL_METERS + offX;
  const toCellY = (rj: number) => (rj * step) / CELL_METERS + offY;

  // Contact lines snap ONCE and both wings adopt the same coordinate —
  // snapping each wing separately would open a slit between them.
  const contactC = rContacts.map((rc) => roundHalf(rc.axis === "x" ? toCellX(rc.cRaster) : toCellY(rc.cRaster)));
  const wings = rects.map((r, wi) => {
    let x0 = Math.max(0, upHalf(toCellX(r.i0)));
    let x1 = Math.min(boxW, downHalf(toCellX(r.i1 + 1)));
    let y0 = Math.max(0, upHalf(toCellY(r.j0)));
    let y1 = Math.min(boxH, downHalf(toCellY(r.j1 + 1)));
    rContacts.forEach((rc, ci) => {
      if (rc.a !== wi && rc.b !== wi) return;
      const c = contactC[ci];
      if (rc.axis === "x") {
        // Adopt the shared line on whichever side of this wing it matches.
        if (Math.abs(toCellX(r.i0) - c) < 0.6) x0 = c;
        else if (Math.abs(toCellX(r.i1 + 1) - c) < 0.6) x1 = c;
      } else {
        if (Math.abs(toCellY(r.j0) - c) < 0.6) y0 = c;
        else if (Math.abs(toCellY(r.j1 + 1) - c) < 0.6) y1 = c;
      }
    });
    return { x0, y0, x1, y1 };
  });

  // Validate: every wing usable, contacts still ≥ 4 cells after snapping.
  if (wings.some((w) => w.x1 - w.x0 < 3.5 || w.y1 - w.y0 < 3.5)) {
    // Drop back to the primary wing only — still a correct (rectangular) house.
    const w = wings[0];
    if (w.x1 - w.x0 < MIN_ROOM_CELLS || w.y1 - w.y0 < MIN_ROOM_CELLS) return null;
    return { box: { width: boxW, height: boxH }, wings: [w], contacts: [] };
  }
  const contacts: FitWings["contacts"] = [];
  for (let ci = 0; ci < rContacts.length; ci++) {
    const rc = rContacts[ci];
    const A = wings[rc.a];
    const B = wings[rc.b];
    const lo = rc.axis === "x" ? Math.max(A.y0, B.y0) : Math.max(A.x0, B.x0);
    const hi = rc.axis === "x" ? Math.min(A.y1, B.y1) : Math.min(A.x1, B.x1);
    if (hi - lo < 4) {
      // Too little shared edge survived snapping; keep only wings reachable
      // through surviving contacts (the primary wing always is).
      return { box: { width: boxW, height: boxH }, wings: [wings[0]], contacts: [] };
    }
    contacts.push({ a: rc.a, b: rc.b, axis: rc.axis, c: contactC[ci], lo, hi });
  }
  return { box: { width: boxW, height: boxH }, wings, contacts };
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
