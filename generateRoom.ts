// ⚠ MIRROR RULE: BuildAndBreach's in-game Fish Bowl carries a hand-port of this
// generator (BuildAndBreachMain/Assets/Sentari/RandomHouseGenerator.cs), which
// also inlines wallsWithDoorGaps and the FOOTPRINT_M data (as a fallback — the
// headset measures real collider AABBs at runtime). When this file changes,
// mirror the change there; the C# file carries the same note.
//
// Random room generator — one click in the library produces a plausible small
// house: a walled shell split into 2–4 rooms, doors connecting every room, an
// entry door on the south wall with the start zone staged OUTSIDE it (the
// squad stacks up in the yard and breaches in), furniture dressed by room
// type, and a cast of 0–4 people of mixed disposition (no guaranteed
// hostile — a no-threat house is a legal round). The output is a plain Room;
// nothing downstream knows it was generated.
//
// Layout ("Blueprint Deck", 2026-08-17): every house rolls one of three
// interior STYLES so consecutive houses read as different architecture —
//   warren  — axis-aligned BSP: split the biggest leaf until the target room
//             count; one door per split wall (connected by construction)
//   hallway — a corridor runs from the entry door with rooms opening off both
//             sides, occasionally dead-ending into a full-width back room
//   open    — no interior rooms at all; freestanding partitions and stub
//             walls carve the sightlines instead
// On top of any style, a stub-wall budget (scaled to floor area) adds blind
// corners: straight stubs, L-pockets, and floating partitions. Doors are
// placed dead-center ON their wall's line with the wall's rotation, so
// wallsWithDoorGaps always cuts a clean opening at push time (its tolerance
// is ~0.65 cells / 25°). The in-game Fish Bowl deals style / entry side /
// cast size / behaviors from shuffle decks (C#-side state — see the mirror);
// here the equivalents arrive via options or roll fresh per call.

import {
  Behavior,
  PALETTE,
  PlacedObject,
  Room,
  clampRoomCells,
  makeObject,
  makeWall,
  newRoomId,
  objectExtent,
  paletteById,
  snap,
} from "./rooms";

export type GenerateRoomOptions = {
  name?: string;
  /**
   * Room size in cells; defaults to a random even 16–28 × 12–20. Pass a
   * headset's fitted play-space size (fitCellsForSpaces) to generate a house
   * the players can physically walk.
   */
  width?: number;
  height?: number;
  /**
   * Build the house inside this sub-rectangle of the room box (cells),
   * instead of filling the whole box. This is how a big concave play space —
   * a whole home walked out as one boundary — gets a properly sized house:
   * the box spans the space (keeping the outline anchoring centered) while
   * the house occupies the largest walkable rectangle fitRectForBounds found
   * anywhere inside the polygon. Defaults to the full box.
   */
  frame?: { x0: number; y0: number; x1: number; y1: number };
  /**
   * Multi-wing layout from fitWingsForBounds: adjoining walkable rectangles
   * (an L-shaped space becomes an L-shaped house) plus the contacts where
   * they share an edge. Takes precedence over `frame`.
   */
  wings?: Array<{ x0: number; y0: number; x1: number; y1: number }>;
  contacts?: WingContact[];
  /**
   * POLYGON-SHELL MODE (2026-08-17): the house perimeter IS this polygon —
   * walls at arbitrary angles riding the real walked playspace outline.
   * CELL coordinates in the entry-oriented frame; canonical form: vertex 0→1
   * is the ENTRY EDGE, axis-aligned (y equal, x ascending), interior at
   * SMALLER y. Takes precedence over wings/frame; an unusable polygon
   * degrades to its AABB as a classic frame house.
   */
  shellPoly?: Array<{ x: number; y: number }>;
  /**
   * "warren" | "hallway" | "open" | "cozy"; omitted = roll here. Infeasible
   * picks (hallway in a tiny shell) fall back — lastInteriorStyle reports
   * what was actually built. Small shells force "cozy" regardless.
   */
  interiorStyle?: InteriorStyle;
  /**
   * Which small-space layout a "cozy" house builds (deck-dealt by Fish Bowl
   * so tight playspaces still never repeat architecture); omitted = roll
   * here. One of COZY_VARIANTS.
   */
  cozyVariant?: CozyVariant;
  /** Exact cast size 0–4; omitted = roll here (Fish Bowl deals from a deck). */
  castCount?: number;
  /**
   * Behavior for each cast member in order (deck-dealt by Fish Bowl for even
   * distribution); omitted = roll each from the weighted pool. A person who
   * fails placement still consumed their card.
   */
  castBehaviors?: Behavior[];
};

export type InteriorStyle = "warren" | "hallway" | "open" | "cozy";

// Small-space layout vocabulary (2026-08-17): a shell too tight for real
// rooms-with-doors used to degenerate into the same two-room split every
// round. Below the cozy threshold the house deals one of these instead:
//   duplex    — the two-room split, forced-axis + off-center for variety
//   nook      — an L-walled corner alcove behind an open threshold
//   vestibule — a baffle wall inside the entry door: breach left or right
//   diagonal  — a 45° wall cutting one or two back corners
//   slalom    — staggered stubs from opposite walls: an S-route to clear
//   openplan  — the open style (partitions/stubs carve one bay)
export const COZY_VARIANTS = ["duplex", "nook", "vestibule", "diagonal", "slalom", "openplan"] as const;
export type CozyVariant = (typeof COZY_VARIANTS)[number];

/** The interior style the last generateRoom call actually built (after
 * feasibility fallbacks; "cozy:<variant>" for cozy houses) — for logging/tests. */
export let lastInteriorStyle: string = "warren";

/** A shared edge between wings a and b: the line (axis+c) and its span. */
export type WingContact = { a: number; b: number; axis: "x" | "y"; c: number; lo: number; hi: number };

// ── randomness ──────────────────────────────────────────────────
const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const randRange = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
// Directional snapping: plain snap() rounds to the NEAREST half-cell, which
// can move a piece 0.25 cells TOWARD the wall it was offset from and leave it
// grazing the wall body. These always round into the room instead.
const snapUp = (v: number) => Math.ceil(v * 2) / 2;
const snapDown = (v: number) => Math.floor(v * 2) / 2;
// A random half-cell coordinate strictly inside [lo, hi]; null when the range
// contains no half-cell (too tight — treat as a failed placement attempt).
const snapBetween = (lo: number, hi: number): number | null => {
  const a = snapUp(lo);
  const b = snapDown(hi);
  return a > b ? null : a + 0.5 * randInt(0, Math.round((b - a) * 2));
};
const shuffle = <T,>(arr: readonly T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ── polygon utilities (polygon-shell mode) ──────────────────────
export type Pt = { x: number; y: number };

export const polygonArea = (p: Pt[]): number => {
  if (!p || p.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j].x * p[i].y - p[i].x * p[j].y;
  return Math.abs(a) * 0.5;
};

export const pointInPoly = (poly: Pt[], pt: Pt): boolean => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

export const distPointToSeg = (p: Pt, a: Pt, b: Pt): number => {
  const abx = b.x - a.x, aby = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / Math.max(1e-6, abx * abx + aby * aby)));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
};

const cross2 = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

/** Sutherland–Hodgman clip against one half-plane: keeps Dot(p−onLine, keepNormal) ≥ 0. */
export const clipHalfPlane = (poly: Pt[], onLine: Pt, keepNormal: Pt): Pt[] => {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i], prev = poly[(i + poly.length - 1) % poly.length];
    const dc = (cur.x - onLine.x) * keepNormal.x + (cur.y - onLine.y) * keepNormal.y;
    const dp = (prev.x - onLine.x) * keepNormal.x + (prev.y - onLine.y) * keepNormal.y;
    const lerp = () => {
      const t = dp / (dp - dc);
      return { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t };
    };
    if (dc >= 0) {
      if (dp < 0) out.push(lerp());
      out.push({ x: cur.x, y: cur.y });
    } else if (dp >= 0) out.push(lerp());
  }
  return out;
};

export const polySelfIntersects = (p: Pt[]): boolean => {
  const n = p.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const a = p[i], b = p[(i + 1) % n], c = p[j], d = p[(j + 1) % n];
      const d1 = cross2(d.x - c.x, d.y - c.y, a.x - c.x, a.y - c.y);
      const d2 = cross2(d.x - c.x, d.y - c.y, b.x - c.x, b.y - c.y);
      const d3 = cross2(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
      const d4 = cross2(b.x - a.x, b.y - a.y, d.x - a.x, d.y - a.y);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    }
  return false;
};

/** Longest single chord of the polygon on the infinite line (onLine, dir). */
export const longestChord = (poly: Pt[], onLine: Pt, dir: Pt): { len: number; lo: number; hi: number } => {
  const nx = -dir.y, ny = dir.x;
  const ts: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    const da = (a.x - onLine.x) * nx + (a.y - onLine.y) * ny;
    const db = (b.x - onLine.x) * nx + (b.y - onLine.y) * ny;
    if (Math.abs(da) < 1e-5 && Math.abs(db) < 1e-5) {
      ts.push((a.x - onLine.x) * dir.x + (a.y - onLine.y) * dir.y);
      ts.push((b.x - onLine.x) * dir.x + (b.y - onLine.y) * dir.y);
    } else if (da > 0 !== db > 0) {
      const t = da / (da - db);
      const xx = a.x + (b.x - a.x) * t, yy = a.y + (b.y - a.y) * t;
      ts.push((xx - onLine.x) * dir.x + (yy - onLine.y) * dir.y);
    }
  }
  if (ts.length < 2) return { len: 0, lo: 0, hi: 0 };
  ts.sort((a, b) => a - b);
  let best = 0, lo = 0, hi = 0;
  for (let i = 0; i + 1 < ts.length; i++) {
    const len = ts[i + 1] - ts[i];
    if (len <= best) continue;
    const m = (ts[i] + ts[i + 1]) * 0.5;
    const mx = onLine.x + dir.x * m, my = onLine.y + dir.y * m;
    // The chord may lie ON a polygon edge (the clipped entry line) where the
    // point-in-poly ray cast is degenerate — probe a hair to EITHER side.
    if (!pointInPoly(poly, { x: mx + nx * 0.05, y: my + ny * 0.05 })
        && !pointInPoly(poly, { x: mx - nx * 0.05, y: my - ny * 0.05 })) continue;
    best = len; lo = ts[i]; hi = ts[i + 1];
  }
  return { len: best, lo, hi };
};

/** Usable entry span of edge i once its line is pushed `inset` into the polygon. */
export const insetSpanLength = (poly: Pt[], edgeIdx: number, inset: number): number => {
  const n = poly.length;
  const a = poly[edgeIdx], b = poly[(edgeIdx + 1) % n];
  const len = Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y));
  const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  let inward = { x: d.y, y: -d.x };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (!pointInPoly(poly, { x: mid.x + inward.x * 0.15, y: mid.y + inward.y * 0.15 })) inward = { x: -inward.x, y: -inward.y };
  return longestChord(poly, { x: mid.x + inward.x * inset, y: mid.y + inward.y * inset }, d).len;
};

// ── geometry helpers ────────────────────────────────────────────
// Leaves and boxes are in wall-centerline coordinates (cells).
type Leaf = { x0: number; y0: number; x1: number; y1: number };
type Split = { axis: "x" | "y"; cut: number; lo: number; hi: number };
type Box = { x0: number; y0: number; x1: number; y1: number };

const leafArea = (l: Leaf) => (l.x1 - l.x0) * (l.y1 - l.y0);

// Rotation-aware half-extents for a kind at a given rotation, via the same
// objectExtent the room-growth logic uses — so clearances here match the map.
const halfExtent = (w: number, h: number, rotation: number) =>
  objectExtent({ id: "", kind: "", x: 0, y: 0, rotation, w, h });

const boxAt = (x: number, y: number, ew: number, eh: number): Box => ({
  x0: x - ew, y0: y - eh, x1: x + ew, y1: y + eh,
});

// AABB overlap with a breathing gap, so placements never sit flush against
// each other (or a doorway) even after half-cell snapping moves them ±0.25.
const hitsAny = (b: Box, list: Box[], gap = 0.25) =>
  list.some((o) => b.x0 < o.x1 + gap && b.x1 > o.x0 - gap && b.y0 < o.y1 + gap && b.y1 > o.y0 - gap);

// Where to put a door along a wall span: at least 1.5 cells from either end
// (the cut gap is ~2 cells wide — this keeps it clear of corners) and 1.6
// cells from every T-junction where another wall meets this one (a gap there
// would open a hole at the junction). Random tries first; if the wall is
// crowded, fall back to the spot farthest from every junction.
function pickDoorT(lo: number, hi: number, junctions: number[]): number {
  const min = lo + 1.5;
  const max = hi - 1.5;
  // 2.2, not 1.6 (2026-08-16): the farther a door sits from a T-junction, the
  // more of the leaf's 90° swing stays clear of the perpendicular wall.
  const clearOf = (t: number) => junctions.every((j) => Math.abs(t - j) >= 2.2);
  for (let i = 0; i < 20; i++) {
    const t = snap(randRange(min, max));
    if (clearOf(t)) return t;
  }
  let best = snap((min + max) / 2);
  let bestD = -1;
  for (let t = Math.ceil(min * 2) / 2; t <= max; t += 0.5) {
    const d = junctions.length ? Math.min(...junctions.map((j) => Math.abs(t - j))) : Infinity;
    if (d > bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

// ── polygon-shell builders (mirror of the C# helpers) ───────────
const makeWallExact = (kind: string, x1: number, y1: number, x2: number, y2: number, W: number, H: number): PlacedObject => {
  // makeWall clamps endpoints into the box, which BENDS an angled wall —
  // rebuild the pose exactly and keep only its id/kind/thickness plumbing.
  const w0 = makeWall(kind, x1, y1, x2, y2, W, H);
  const len = Math.max(0.5, Math.hypot(x2 - x1, y2 - y1));
  return { ...w0, x: (x1 + x2) / 2, y: (y1 + y2) / 2, rotation: (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI, w: len };
};

export const normalizeShellPoly = (raw: Pt[]): Pt[] | null => {
  if (!raw || raw.length < 3) return null;
  let p = raw.map((v) => ({ x: v.x, y: v.y }));
  for (let i = p.length - 1; i >= 2; i--)
    if (Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y) < 0.6
        || (i === p.length - 1 && Math.hypot(p[i].x - p[0].x, p[i].y - p[0].y) < 0.6))
      p.splice(i, 1);
  for (let i = p.length - 1; i >= 2 && p.length > 3; i--) {
    const prev = p[i - 1], next = p[(i + 1) % p.length];
    const a1 = Math.atan2(p[i].y - prev.y, p[i].x - prev.x);
    const a2 = Math.atan2(next.y - p[i].y, next.x - p[i].x);
    let da = Math.abs(a1 - a2) % (Math.PI * 2);
    if (da > Math.PI) da = Math.PI * 2 - da;
    if (da < (5 * Math.PI) / 180) p.splice(i, 1);
  }
  if (p.length < 3) return null;
  if (Math.abs(p[0].y - p[1].y) > 0.02) return null;
  if (p[0].x > p[1].x) {
    p.reverse();
    const n0 = p.length, shift = n0 - 2;
    p = p.map((_, j) => p[(j + shift) % n0]);
  }
  if (p[1].x - p[0].x < 3) return null;
  if (polySelfIntersects(p)) return null;
  if (polygonArea(p) < 12) return null;
  const em = { x: (p[0].x + p[1].x) / 2, y: p[0].y - 0.3 };
  if (!pointInPoly(p, em)) return null;
  return p;
};

export const buildShellWalls = (poly: Pt[], entryY1: number, kind: string, W: number, H: number): PlacedObject[] => {
  const n = poly.length;
  const starts: Pt[] = new Array(n);
  const ends: Pt[] = new Array(n);
  const dirs: Pt[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const len = Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y));
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const entryLine = Math.abs(a.y - entryY1) < 0.03 && Math.abs(b.y - entryY1) < 0.03;
    let sx = 0, sy = 0;
    if (!entryLine) {
      let ox = d.y, oy = -d.x;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (pointInPoly(poly, { x: mid.x + ox * 0.15, y: mid.y + oy * 0.15 })) { ox = -ox; oy = -oy; }
      sx = ox * 0.25; sy = oy * 0.25;
    }
    starts[i] = { x: a.x + sx, y: a.y + sy };
    ends[i] = { x: b.x + sx, y: b.y + sy };
    dirs[i] = d;
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const det = cross2(dirs[i].x, dirs[i].y, dirs[j].x, dirs[j].y);
    if (Math.abs(det) < 0.1) continue;
    const rx = starts[j].x - starts[i].x, ry = starts[j].y - starts[i].y;
    const t = cross2(rx, ry, dirs[j].x, dirs[j].y) / det;
    const m = { x: starts[i].x + dirs[i].x * t, y: starts[i].y + dirs[i].y * t };
    if (Math.hypot(m.x - ends[i].x, m.y - ends[i].y) > 2 || Math.hypot(m.x - starts[j].x, m.y - starts[j].y) > 2) continue;
    ends[i] = m;
    starts[j] = { x: m.x, y: m.y };
  }
  const out: PlacedObject[] = [];
  for (let i = 0; i < n; i++) {
    if (Math.hypot(ends[i].x - starts[i].x, ends[i].y - starts[i].y) >= 0.3)
      out.push(makeWallExact(kind, starts[i].x, starts[i].y, ends[i].x, ends[i].y, W, H));
    const j = (i + 1) % n;
    const gap = Math.hypot(starts[j].x - ends[i].x, starts[j].y - ends[i].y);
    if (gap > 0.3) out.push(makeWallExact(kind, ends[i].x, ends[i].y, starts[j].x, starts[j].y, W, H));
  }
  return out;
};

const segOfWall = (wall: PlacedObject): { a: Pt; b: Pt } => {
  const r = (wall.rotation * Math.PI) / 180;
  const hx = (Math.cos(r) * wall.w) / 2, hy = (Math.sin(r) * wall.w) / 2;
  return { a: { x: wall.x - hx, y: wall.y - hy }, b: { x: wall.x + hx, y: wall.y + hy } };
};

const lineAngleDiffDeg = (a: number, b: number): number => {
  let d = (((a - b) % 180) + 180) % 180;
  return d > 90 ? 180 - d : d;
};

const wallBehindSpan = (
  segs: Array<{ a: Pt; b: Pt }>, horizontalEdge: boolean, edgeC: number, lo: number, hi: number,
  interiorSign: number
): boolean => {
  const edgeRot = horizontalEdge ? 0 : 90;
  for (let k = 0; k < 3; k++) {
    const t = k === 0 ? lo : k === 1 ? (lo + hi) / 2 : hi;
    const p = horizontalEdge ? { x: t, y: edgeC } : { x: edgeC, y: t };
    let ok = false;
    for (const s of segs) {
      const segRot = (Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x) * 180) / Math.PI;
      if (lineAngleDiffDeg(segRot, edgeRot) > 8) continue;
      const abx = s.b.x - s.a.x, aby = s.b.y - s.a.y;
      const tt = ((p.x - s.a.x) * abx + (p.y - s.a.y) * aby) / Math.max(1e-6, abx * abx + aby * aby);
      // The perpendicular foot must land WITHIN the segment — being near a
      // wall's END means the wall stops mid-span and the piece would poke
      // past it into whatever comes next.
      if (tt < 0 || tt > 1) continue;
      const q = { x: s.a.x + abx * tt, y: s.a.y + aby * tt };
      if (Math.hypot(p.x - q.x, p.y - q.y) > 0.7) continue;
      // SIGNED: the wall must sit ON or OUTSIDE the leaf edge — a skewed
      // wall encroaching inside would let hugged furniture poke through it.
      const inwardOff = (horizontalEdge ? q.y - edgeC : q.x - edgeC) * interiorSign;
      if (inwardOff > 0.05) continue;
      ok = true;
      break;
    }
    if (!ok) return false;
  }
  return true;
};

const raySegT = (origin: Pt, dir: Pt, a: Pt, b: Pt, tMin: number): number => {
  const ex = b.x - a.x, ey = b.y - a.y;
  const det = cross2(dir.x, dir.y, ex, ey);
  if (Math.abs(det) < 1e-6) return Infinity;
  const dx = a.x - origin.x, dy = a.y - origin.y;
  const t = cross2(dx, dy, ex, ey) / det;
  const s = cross2(dx, dy, dir.x, dir.y) / det;
  return t >= tMin && s >= -0.02 && s <= 1.02 ? t : Infinity;
};

const extendEnd = (end: Pt, dir: Pt, regions: Leaf[], shellSegs: Array<{ a: Pt; b: Pt }>): Pt => {
  const probe = { x: end.x + dir.x * 0.35, y: end.y + dir.y * 0.35 };
  for (const rg of regions)
    if (probe.x > rg.x0 + 0.05 && probe.x < rg.x1 - 0.05 && probe.y > rg.y0 + 0.05 && probe.y < rg.y1 - 0.05)
      return end;
  let best = Infinity;
  for (const s of shellSegs) best = Math.min(best, raySegT(end, dir, s.a, s.b, -0.3));
  if (!isFinite(best) || best > 3) return end;
  return { x: end.x + dir.x * (best + 0.25), y: end.y + dir.y * (best + 0.25) };
};

const extendWallEnds = (wall: PlacedObject, regions: Leaf[], shellSegs: Array<{ a: Pt; b: Pt }>): void => {
  const seg = segOfWall(wall);
  const len = Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y);
  if (len < 0.05) return;
  const dir = { x: (seg.b.x - seg.a.x) / len, y: (seg.b.y - seg.a.y) / len };
  const na = extendEnd(seg.a, { x: -dir.x, y: -dir.y }, regions, shellSegs);
  const nb = extendEnd(seg.b, dir, regions, shellSegs);
  wall.x = (na.x + nb.x) / 2;
  wall.y = (na.y + nb.y) / 2;
  wall.w = Math.hypot(nb.x - na.x, nb.y - na.y);
};

// Inline port of RandomHouseGenerator.FitWings (itself a port of tracking.ts
// fitWingsForBounds with the outward-bias twist): greedy ≤3 inscribed
// rectangles used as PLANNING REGIONS for the polygon shell. Contacts are
// irrelevant here — region adjacencies stay open floor.
export const fitRegionsCells = (polyCells: Pt[], W: number, H: number, outwardBiasCells: number): Leaf[] | null => {
  if (!polyCells || polyCells.length < 3) return null;
  const step = 0.2;
  const nx = Math.ceil(W / step), ny = Math.ceil(H / step);
  if (nx < 8 || ny < 8) return null;
  const distToEdge = (x: number, y: number) => {
    let best = Infinity;
    for (let i = 0, j = polyCells.length - 1; i < polyCells.length; j = i++)
      best = Math.min(best, distPointToSeg({ x, y }, polyCells[j], polyCells[i]));
    return best;
  };
  const free = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * step, y = (j + 0.5) * step;
      free[j * nx + i] = pointInPoly(polyCells, { x, y }) || distToEdge(x, y) <= outwardBiasCells ? 1 : 0;
    }
  const MIN_SIDE = Math.round(3 / step);
  type R = { area: number; i0: number; i1: number; j0: number; j1: number };
  const maxRect = (requireSide: boolean): R | null => {
    let best: R | null = null, bestWide: R | null = null;
    const heights = new Int32Array(nx);
    const stack = new Int32Array(nx + 1);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) heights[i] = free[j * nx + i] ? heights[i] + 1 : 0;
      let top = 0;
      for (let i = 0; i <= nx; i++) {
        const cur = i < nx ? heights[i] : 0;
        while (top > 0 && heights[stack[top - 1]] >= cur) {
          const hgt = heights[stack[--top]];
          const left = top > 0 ? stack[top - 1] + 1 : 0;
          const cand: R = { area: hgt * (i - left), i0: left, i1: i - 1, j0: j - hgt + 1, j1: j };
          if (!best || cand.area > best.area) best = cand;
          if (Math.min(hgt, i - left) >= MIN_SIDE && (!bestWide || cand.area > bestWide.area)) bestWide = cand;
        }
        stack[top++] = i;
      }
    }
    return bestWide ?? (requireSide ? null : best);
  };
  const clearRect = (r: R) => {
    for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) free[j * nx + i] = 0;
  };
  const first = maxRect(false);
  if (!first || first.area < MIN_SIDE * MIN_SIDE) return null;
  const rects: R[] = [first];
  clearRect(first);
  for (let k = 0; k < 2; k++) {
    const r = maxRect(true);
    if (!r || r.area < MIN_SIDE * MIN_SIDE) break;
    // Region must touch an existing region (≥2 m shared edge) to stay
    // walkable-adjacent; standalone pockets are dropped.
    const CONTACT_MIN = Math.round(4 / step);
    let attached = false;
    for (const p of rects) {
      const yOv = Math.min(r.j1, p.j1) - Math.max(r.j0, p.j0) + 1;
      const xOv = Math.min(r.i1, p.i1) - Math.max(r.i0, p.i0) + 1;
      if ((r.i0 === p.i1 + 1 || r.i1 === p.i0 - 1) && yOv >= CONTACT_MIN) attached = true;
      if ((r.j0 === p.j1 + 1 || r.j1 === p.j0 - 1) && xOv >= CONTACT_MIN) attached = true;
    }
    if (!attached) break;
    rects.push(r);
    clearRect(r);
  }
  const up = (v: number) => Math.ceil(v * 2) / 2;
  const down = (v: number) => Math.floor(v * 2) / 2;
  const out: Leaf[] = [];
  for (const r of rects) {
    const x0 = Math.max(0, up(r.i0 * step)), x1 = Math.min(W, down((r.i1 + 1) * step));
    const y0 = Math.max(0, up(r.j0 * step)), y1 = Math.min(H, down((r.j1 + 1) * step));
    if (x1 - x0 >= 3.5 && y1 - y0 >= 3.5) out.push({ x0, y0, x1, y1 });
  }
  return out.length ? out : null;
};

// ── furniture menus ─────────────────────────────────────────────
// What each room type wants, in placement order. `wall: true` hugs a wall
// facing into the room; otherwise it stands free near the leaf's center.
type MenuItem = { category: string; wall: boolean };
type RoomType = "living" | "bedroom" | "bathroom" | "office";

function menuFor(type: RoomType): MenuItem[] {
  switch (type) {
    case "living":
      return [
        { category: "Sofa", wall: true },
        { category: "Table", wall: false },
      ];
    case "bedroom":
      return [
        { category: "Bed", wall: true },
        { category: pick(["Drawer", "Closet"]), wall: true },
      ];
    case "bathroom":
      return [
        { category: "Bathroom Vanity", wall: true },
        { category: "Toilet", wall: true },
        ...(Math.random() < 0.5 ? [{ category: "Bathtub", wall: true }] : []),
      ];
    case "office":
      return [
        { category: "Table", wall: false },
        { category: pick(["File Cabinet", "Cabinet"]), wall: true },
      ];
  }
}

// Sofa12/Sofa13 are L-sectionals whose collider under-reports (see FOOTPRINT_M
// in rooms.ts) — the overlap check would lie, so the generator skips them.
const kindsIn = (category: string): string[] =>
  PALETTE.filter(
    (p) => p.section === "Furniture" && p.category === category && p.kind !== "Sofa12" && p.kind !== "Sofa13"
  ).map((p) => p.kind);

// Character NPCs only — never the generic "Hostile"/"Non-Hostile" target
// dummies. A generated house should read as inhabited, not as a range.
// MODEL and BEHAVIOR are fully decoupled: any character can be hostile and
// any can be a bystander — reading intent, not outfits, is the drill.
const NPC_KINDS = ["Soldier", "Soldier (Gas)", "Bobby", "Freddy", "Ray", "Remy", "Susan", "Tabby", "Tom"];
// Every person rolls from one weighted pool — no guaranteed hostile and no
// guaranteed bystander (2026-08-16). Threats stay common, but a no-threat
// house is a legal round.
const CAST_BEHAVIORS: Behavior[] = ["hostile", "hostile", "compliant", "compliant", "afraid", "compToHostile", "random"];

// ── the generator ───────────────────────────────────────────────
export function generateRoom(opts: GenerateRoomOptions = {}): Room {
  const W = clampRoomCells(opts.width ?? randInt(8, 14) * 2);
  const H = clampRoomCells(opts.height ?? randInt(6, 10) * 2);

  // ONE wall material for the whole house (2026-08-16): shell, interior
  // walls, stubs and party walls all match — a real building is built of one
  // thing. Variety comes round to round, not wall to wall.
  const houseWallKind = pick(["Brick", "Cinderblock", "Concrete", "Wood"]);
  const shellKind = houseWallKind;

  // ── polygon-shell setup (mirror of the C# block) ────────────
  let polyMode = !!opts.shellPoly && opts.shellPoly.length >= 3;
  let shellP: Pt[] | null = null;
  let interiorPoly: Pt[] | null = null;
  let polyYard = 0, polyEntryY1 = 0, polyEntrySpanLo = 0, polyEntrySpanHi = 0;
  let polyExterior = false;
  let polyRegions: Leaf[] | null = null;
  let frameOpt = opts.frame;
  if (polyMode) {
    shellP = normalizeShellPoly(opts.shellPoly!);
    polyMode = shellP !== null;
    if (polyMode) {
      const eY = shellP![0].y;
      let depth = 0;
      for (const v of shellP!) depth = Math.max(depth, eY - v.y);
      // Yard tiers: 2.1 cells keeps the full 0.5 m standoff INSIDE the
      // walked outline; 1.5 compresses it; too shallow → interior start.
      polyYard = depth - 2.1 >= 2.5 ? 2.1 : 1.5;
      polyExterior = depth - polyYard >= 2.5;
      if (!polyExterior) polyYard = 0;
      polyEntryY1 = eY - polyYard;
      interiorPoly = polyYard > 0 ? clipHalfPlane(shellP!, { x: 0, y: polyEntryY1 }, { x: 0, y: -1 }) : shellP!.map((v) => ({ ...v }));
      let chord = interiorPoly.length >= 3
        ? longestChord(interiorPoly, { x: 0, y: polyEntryY1 }, { x: 1, y: 0 })
        : { len: 0, lo: 0, hi: 0 };
      if (chord.len < 3.5 && polyYard > 1.6) {
        polyYard = 1.5;
        polyEntryY1 = eY - polyYard;
        interiorPoly = clipHalfPlane(shellP!, { x: 0, y: polyEntryY1 }, { x: 0, y: -1 });
        chord = interiorPoly.length >= 3
          ? longestChord(interiorPoly, { x: 0, y: polyEntryY1 }, { x: 1, y: 0 })
          : { len: 0, lo: 0, hi: 0 };
      }
      polyEntrySpanLo = chord.lo;
      polyEntrySpanHi = chord.hi;
      if (chord.len < 3.5 || interiorPoly.length < 3 || polySelfIntersects(interiorPoly)) polyMode = false;
      else {
        polyRegions = fitRegionsCells(interiorPoly, W, H, 0.6);
        if (!polyRegions) polyMode = false;
      }
    }
    if (!polyMode) {
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
      for (const v of opts.shellPoly!) {
        mnx = Math.min(mnx, v.x); mny = Math.min(mny, v.y);
        mxx = Math.max(mxx, v.x); mxy = Math.max(mxy, v.y);
      }
      frameOpt = { x0: Math.max(0, mnx), y0: Math.max(0, mny), x1: Math.min(W, mxx), y1: Math.min(H, mxy) };
    }
  }
  const doorKinds = PALETTE.filter((p) => p.section === "Doors").map((p) => p.kind);
  // The ENTRY is always a real swinging leaf — breaching an open hole reads
  // wrong (2026-08-16). Interior doorways may still be open frames.
  const swingDoorKinds = doorKinds.filter((k) => k !== "Open Door Frame");

  // The walkable region: one or more axis-aligned WINGS — adjoining
  // rectangles decomposed from a real play space by fitWingsForBounds, so an
  // L-shaped space grows an L-shaped house instead of one inscribed box.
  // Contacts name the shared edges; each gets a wall with a doorway so the
  // wings connect. Default: a single wing covering the box (or the caller's
  // `frame`), which reproduces the classic rectangular house exactly.
  const walkWings: Leaf[] = (opts.wings?.length
    ? opts.wings
    : [{ x0: frameOpt?.x0 ?? 0, y0: frameOpt?.y0 ?? 0, x1: frameOpt?.x1 ?? W, y1: frameOpt?.y1 ?? H }]
  ).map((r) => ({
    x0: Math.max(0, r.x0),
    y0: Math.max(0, r.y0),
    x1: Math.min(W, r.x1),
    y1: Math.min(H, r.y1),
  }));
  const contacts: WingContact[] = !polyMode && opts.wings?.length ? opts.contacts ?? [] : [];
  const eps = 0.01;
  const touchesContact = (i: number, side: "N" | "S" | "W" | "E") =>
    contacts.some((ct) => {
      if (ct.a !== i && ct.b !== i) return false;
      const wg = walkWings[i];
      if (ct.axis === "x")
        return (side === "W" && Math.abs(ct.c - wg.x0) < eps) || (side === "E" && Math.abs(ct.c - wg.x1) < eps);
      return (side === "N" && Math.abs(ct.c - wg.y0) < eps) || (side === "S" && Math.abs(ct.c - wg.y1) < eps);
    });

  // Shell rects: exterior edges hug the wing tightly (0.5-cell inset — every
  // half-cell of a real play space is floor worth keeping) but never come
  // closer than 1 cell to the ROOM BOX edge, so later edits can't trigger the
  // box's auto-grow. Contact edges stay ON the shared line — that's where the
  // party wall goes.
  // Polygon mode: the fitted regions ARE the planning rects — the real
  // shell is the polygon itself; no insets, no contacts.
  const shells: Leaf[] = polyMode
    ? polyRegions!.map((rg) => ({ ...rg }))
    : walkWings.map((wg, i) => ({
        x0: touchesContact(i, "W") ? wg.x0 : Math.max(wg.x0 + 0.5, 1),
        y0: touchesContact(i, "N") ? wg.y0 : Math.max(wg.y0 + 0.5, 1),
        x1: touchesContact(i, "E") ? wg.x1 : Math.min(wg.x1 - 0.5, W - 1),
        y1: touchesContact(i, "S") ? wg.y1 : Math.min(wg.y1 - 0.5, H - 1),
      }));

  // Entry wing: its south edge must be exterior (a wing stacked atop another
  // can't host the entry); widest wins. Its south wall is pulled up to leave
  // the yard strip where the start zone stages, OUTSIDE the entry door, so
  // every run opens with a breach. Yard = 0.5 m standoff + the ~0.9-cell-deep
  // start zone + breathing room; wings too shallow for it fall back to
  // starting just inside the door instead.
  // The yard ADAPTS (2026-08-16): full 2.1 cells with depth to spare, down to
  // 1.5 (wall + the ≥0.5 m standoff + zone) in a tight box, so the start
  // stages outside in every playable size; the interior fallback survives
  // only for degenerate boxes under ~2 m of depth.
  let entryShell: Leaf;
  let YARD: number;
  let exteriorStart: boolean;
  let entryY1: number;
  if (polyMode) {
    // Entry region = the planning rect that best overlaps the entry span on
    // the inset line; its south edge snaps ONTO that line so the whole
    // entry/door/leaf pipeline below runs unchanged.
    YARD = polyYard;
    exteriorStart = polyExterior;
    entryY1 = polyEntryY1;
    entryShell = shells[0];
    let bestScore = -Infinity;
    for (const s of shells) {
      const ov = Math.min(s.x1, polyEntrySpanHi) - Math.max(s.x0, polyEntrySpanLo);
      const score = ov * 10 + s.y1; // overlap first, southernness breaks ties
      if (score > bestScore) { bestScore = score; entryShell = s; }
    }
    if (Math.abs(entryShell.y1 - entryY1) <= 0.7) entryShell.y1 = entryY1;
  } else {
    const entryCands = shells.filter((_, i) => !touchesContact(i, "S"));
    entryShell = (entryCands.length ? entryCands : shells).reduce((a, b) =>
      a.x1 - a.x0 >= b.x1 - b.x0 ? a : b
    );
    const avail = entryShell.y1 - entryShell.y0;
    // Fixed minimal yard (2026-08-16 "maximize the playspace"): wall + the
    // ≥0.5 m standoff + zone and nothing more — a deeper yard is house depth
    // thrown away.
    YARD = 1.5;
    exteriorStart = avail - YARD >= 2.5; // keep ≥ 2.5 cells of house depth
    if (exteriorStart) entryShell.y1 -= YARD;
    entryY1 = entryShell.y1;
  }

  // Exterior shell walls: each wing edge, minus the spans where it meets
  // another wing. Contact walls (one per contact, sized to the two shells'
  // final overlap) go up with a doorway each — declared here, filled after
  // the door helpers below exist.
  const perimeter: PlacedObject[] = [];
  if (polyMode) perimeter.push(...buildShellWalls(interiorPoly!, entryY1, shellKind, W, H));
  const contactSpan = (ct: WingContact) => {
    const A = shells[ct.a];
    const B = shells[ct.b];
    return ct.axis === "x"
      ? { lo: Math.max(A.y0, B.y0), hi: Math.min(A.y1, B.y1) }
      : { lo: Math.max(A.x0, B.x0), hi: Math.min(A.x1, B.x1) };
  };
  if (!polyMode) shells.forEach((s, i) => {
    const edges = [
      { axis: "y" as const, c: s.y0, lo: s.x0, hi: s.x1 },
      { axis: "y" as const, c: s.y1, lo: s.x0, hi: s.x1 },
      { axis: "x" as const, c: s.x0, lo: s.y0, hi: s.y1 },
      { axis: "x" as const, c: s.x1, lo: s.y0, hi: s.y1 },
    ];
    for (const e of edges) {
      const cuts = contacts
        .filter((ct) => (ct.a === i || ct.b === i) && ct.axis === e.axis && Math.abs(ct.c - e.c) < eps)
        .map(contactSpan)
        .filter((sp) => sp.hi - sp.lo > eps)
        .sort((p, q) => p.lo - q.lo);
      let cursor = e.lo;
      const emit = (lo: number, hi: number) => {
        if (hi - lo < 0.5) return;
        perimeter.push(
          e.axis === "y" ? makeWall(shellKind, lo, e.c, hi, e.c, W, H) : makeWall(shellKind, e.c, lo, e.c, hi, W, H)
        );
      };
      for (const sp of cuts) {
        emit(cursor, sp.lo);
        cursor = Math.max(cursor, sp.hi);
      }
      emit(cursor, e.hi);
    }
  });

  // BSP: split the biggest splittable leaf on its longer axis until we hit
  // the target room count (or nothing can fit two more rooms). The minimum
  // room size ADAPTS to what's available: roomy spans split into ≥5-cell
  // (2.5 m) rooms, but a tight span still divides down to 3.5 cells (1.75 m)
  // — a small real-world play space should still produce a multi-room house
  // to clear, not one undividable strip that looks identical every time.
  // span/3 keeps a REAL choice of cut positions on mid-size spans — a fixed
  // 5-cell minimum left exactly one legal cut in a 10-cell span, so every
  // generation split at the same spot.
  // Floor of 3 cells (1.5 m): a room a door frame plus shoulders wide — small
  // real spaces still divide into several rooms instead of one per wing.
  const minLeafFor = (span: number) => Math.max(3, Math.min(5, span / 3));
  const splittable = (l: Leaf) => {
    const sx = l.x1 - l.x0;
    const sy = l.y1 - l.y0;
    const span = Math.max(sx, sy);
    const ml = minLeafFor(span);
    if (span < 2 * ml) return false;
    // Cuts land on whole cells; half-cell shell edges can strand a span that
    // passes the size test but has no integer cut inside its margins.
    const [lo, hi] = sx >= sy ? [l.x0, l.x1] : [l.y0, l.y1];
    return Math.floor(hi - ml) >= Math.ceil(lo + ml);
  };
  // ── interior style ──────────────────────────────────────────
  // Three architectures, as different to CLEAR as possible: warren (BSP rooms
  // behind doors), hallway (a corridor from the entry with rooms off both
  // sides), open (no interior rooms; partitions/stubs carve sightlines).
  // Hallway needs a shell wide and deep enough for a corridor plus rooms.
  const entryShellW = entryShell.x1 - entryShell.x0;
  const entryShellD = entryShell.y1 - entryShell.y0;
  let style: InteriorStyle =
    opts.interiorStyle ?? (() => {
      const sr = Math.random();
      return sr < 0.5 ? "warren" : sr < 0.75 ? "hallway" : "open";
    })();
  if (style === "hallway" && (entryShellW < 8 || entryShellD < 7)) style = "warren";
  // COZY threshold: a shell too tight for the hallway, or under ~15 m², can't
  // afford real rooms-with-doors — warren degenerates into the same two-room
  // split every round there. Deal from the small-space vocabulary instead
  // (the open style already works at any size).
  const smallHouse = polyMode
    ? polygonArea(interiorPoly!) < 60
    : entryShellW < 8 || entryShellD < 7 || entryShellW * entryShellD < 60;
  let cozyVariant: CozyVariant | null = null;
  if (style === "cozy" || (smallHouse && style !== "open")) {
    cozyVariant =
      opts.cozyVariant && (COZY_VARIANTS as readonly string[]).includes(opts.cozyVariant)
        ? opts.cozyVariant
        : pick(COZY_VARIANTS);
    style = cozyVariant === "openplan" ? "open" : "cozy";
  }
  lastInteriorStyle = cozyVariant ? `cozy:${cozyVariant}` : style;

  // Seed leaves: every shell — except the entry shell under hallway or cozy,
  // which gets its special treatment below instead of the BSP.
  const leaves: Leaf[] = shells
    .filter((s) => !((style === "hallway" || style === "cozy") && s === entryShell))
    .map((s) => ({ ...s }));
  const splits: Split[] = [];
  // Corridor leaves never take furniture or stubs (people may still stand in
  // them — a figure at the end of a hallway is the drill).
  const corridorLeaves = new Set<Leaf>();
  // Every extra wing is already a room; the split budget scales with them.
  const targetRooms =
    style === "open" || style === "cozy" ? leaves.length // wings stay one bay each
    : style === "hallway" ? leaves.length + randInt(0, Math.max(0, leaves.length))
    : randInt(2, 4) + (shells.length - 1); // warren: 2–4 real rooms
  while (leaves.length < targetRooms) {
    const cands = leaves.filter(splittable);
    if (!cands.length) break;
    const leaf = cands.reduce((a, b) => (leafArea(a) >= leafArea(b) ? a : b));
    leaves.splice(leaves.indexOf(leaf), 1);
    if (leaf.x1 - leaf.x0 >= leaf.y1 - leaf.y0) {
      const ml = minLeafFor(leaf.x1 - leaf.x0);
      const cut = randInt(Math.ceil(leaf.x0 + ml), Math.floor(leaf.x1 - ml));
      leaves.push({ ...leaf, x1: cut }, { ...leaf, x0: cut });
      splits.push({ axis: "x", cut, lo: leaf.y0, hi: leaf.y1 });
    } else {
      const ml = minLeafFor(leaf.y1 - leaf.y0);
      const cut = randInt(Math.ceil(leaf.y0 + ml), Math.floor(leaf.y1 - ml));
      leaves.push({ ...leaf, y1: cut }, { ...leaf, y0: cut });
      splits.push({ axis: "y", cut, lo: leaf.x0, hi: leaf.x1 });
    }
  }

  // Interior walls: one full wall per split; wallsWithDoorGaps cuts the
  // opening at push time, so the wall is drawn continuous with the door on it.
  const interior = splits.map((s) => {
    const kind = houseWallKind;
    return s.axis === "x"
      ? makeWall(kind, s.cut, s.lo, s.cut, s.hi, W, H)
      : makeWall(kind, s.lo, s.cut, s.hi, s.cut, W, H);
  });

  // One door per split wall, avoiding the points where perpendicular walls
  // T-junction into it — cutting a gap there would open a hole at the corner.
  const doors: PlacedObject[] = [];
  // Keep doorways walkable: nothing parks in them. 1.25 cells + the placement
  // gap ≈ 1.5 from the door center — clear of the 1-cell-half opening, without
  // owning the whole floor of a shallow room the way 1.6 did.
  const clearances: Box[] = [];
  // 2.0, not 1.25 (2026-08-16): the 0.93 m leaf sweeps a ~1.86-cell quarter-
  // circle from its hinge — nothing may park within 1 m of a door center or
  // it can stop the leaf short of 90°.
  const addDoorClearance = (dx: number, dy: number) => clearances.push(boxAt(dx, dy, 2.0, 2.0));
  // Open (wall-less) contact/threshold lines — wall-hugging furniture must
  // never back onto these. Declared up here because the cozy nook adds its
  // open threshold before the party-wall loop below.
  const openContacts: Array<{ axis: "x" | "y"; c: number; lo: number; hi: number }> = [];

  // ── hallway style: carve the corridor ───────────────────────
  // A corridor runs the entry shell's full depth from the entry door;
  // flanking strips subdivide into rooms, each opening onto the corridor
  // through its own door. Sometimes the corridor hugs a side wall (a side
  // hall), and sometimes it dead-ends into one full-width back room. The
  // corridor is the entry leaf: the breach leads down a hall.
  let hallEntryLeaf: Leaf | null = null;
  let hallEntryX = NaN;
  if (style === "hallway") {
    const es = entryShell;
    const depth = entryY1 - es.y0;

    // Back room: the corridor stops short and the far end becomes one room
    // across the whole shell ("hallway to the great room").
    let backY = es.y0;
    if (depth >= 9 && Math.random() < 0.35)
      backY = snap(es.y0 + Math.min(Math.max(depth * randRange(0.3, 0.45), 3), depth - 5));

    const cw = entryShellW >= 12 ? 3 : 2.5; // corridor width (≥2: the entry leaf swings clear)
    // Polygon mode: the corridor mouth must sit where the entry span
    // actually HAS a shell wall to cut the door into.
    let cxLo = es.x0 + 3 + cw / 2, cxHi = es.x1 - 3 - cw / 2;
    if (polyMode) {
      cxLo = Math.max(cxLo, polyEntrySpanLo + 1.3);
      cxHi = Math.min(cxHi, polyEntrySpanHi - 1.3);
    }
    const cxc = snapBetween(cxLo, cxHi);
    const sideOk = (center: number) => !polyMode || (center >= polyEntrySpanLo + 1.3 && center <= polyEntrySpanHi - 1.3);
    const westOk = sideOk(es.x0 + cw / 2), eastOk = sideOk(es.x1 - cw / 2);
    let sideHall = cxc === null || Math.random() < 0.25;
    if (sideHall && !westOk && !eastOk) sideHall = false;
    if (cxc === null && !sideHall) {
      // No corridor placement carries a door on the shell — this round the
      // entry shell stays one open bay instead.
      leaves.push({ ...es });
      lastInteriorStyle = "open";
    } else {
    let cx0: number, cx1: number;
    if (sideHall) {
      const west = westOk && (!eastOk || Math.random() < 0.5);
      cx0 = west ? es.x0 : es.x1 - cw;
      cx1 = west ? es.x0 + cw : es.x1;
    } else {
      cx0 = cxc! - cw / 2;
      cx1 = cxc! + cw / 2;
    }

    const buildStrip = (sx0: number, sx1: number, wallX: number) => {
      interior.push(makeWall(houseWallKind, wallX, backY, wallX, entryY1, W, H));
      const rooms: Array<{ lo: number; hi: number }> = [{ lo: backY, hi: entryY1 }];
      const nRooms = Math.min(3, Math.max(1, Math.floor((entryY1 - backY) / 3.5)));
      while (rooms.length < nRooms) {
        let bi = 0;
        for (let i = 1; i < rooms.length; i++) if (rooms[i].hi - rooms[i].lo > rooms[bi].hi - rooms[bi].lo) bi = i;
        const seg = rooms[bi];
        if (seg.hi - seg.lo < 6.5) break;
        const cut = randInt(Math.ceil(seg.lo + 3), Math.floor(seg.hi - 3));
        if (cut <= seg.lo || cut >= seg.hi) break;
        rooms[bi] = { lo: seg.lo, hi: cut };
        rooms.push({ lo: cut, hi: seg.hi });
        interior.push(makeWall(houseWallKind, sx0, cut, sx1, cut, W, H));
      }
      for (const rm of rooms) {
        leaves.push({ x0: sx0, y0: rm.lo, x1: sx1, y1: rm.hi });
        // Room ends are real walls (cuts or shell) — junctions for the
        // leaf-swing margin; pickDoorT degrades gracefully in shallow rooms.
        const t = pickDoorT(rm.lo, rm.hi, [rm.lo, rm.hi]);
        doors.push({ ...makeObject(pick(doorKinds), wallX, t, W, H), x: wallX, y: t, rotation: 90 });
        addDoorClearance(wallX, t);
      }
    };
    if (cx0 - es.x0 >= 3) buildStrip(es.x0, cx0, cx0);
    if (es.x1 - cx1 >= 3) buildStrip(cx1, es.x1, cx1);

    if (backY > es.y0 + eps) {
      // The wall behind the corridor, doorway at the corridor mouth.
      interior.push(makeWall(houseWallKind, es.x0, backY, es.x1, backY, W, H));
      const bx = snap((cx0 + cx1) / 2);
      doors.push({ ...makeObject(pick(doorKinds), bx, backY, W, H), x: bx, y: backY, rotation: 0 });
      addDoorClearance(bx, backY);
      leaves.push({ x0: es.x0, y0: es.y0, x1: es.x1, y1: backY });
    }

    hallEntryLeaf = { x0: cx0, y0: backY, x1: cx1, y1: entryY1 };
    corridorLeaves.add(hallEntryLeaf);
    leaves.push(hallEntryLeaf);
    // Entry door dead-centered between the corridor walls: the hinge arc
    // (max ±0.90 cells from center) clears walls at ±1.25.
    hallEntryX = (cx0 + cx1) / 2;
    } // corridor built
  }

  // ── cozy style: the small-space vocabulary ──────────────────
  // Structural walls that belong to the floor plan (duplex/nook) go in
  // `interior` and shape the leaf list; stub-like pieces (vestibule baffle,
  // diagonals, slalom) collect here and join the stub pass — their boxes keep
  // furniture/NPCs off them and count into the 1.6-cell mutual-walkway rule.
  let cozyEntryX = NaN;
  const cozyStubWalls: PlacedObject[] = [];
  const cozyBoxes: Box[] = [];
  if (style === "cozy") {
    const es = entryShell;
    const exW = es.x1 - es.x0;
    const exD = entryY1 - es.y0;
    // Polygon mode: a pinned entry door must land where the entry span
    // actually has a shell wall.
    const exLo = polyMode ? Math.max(es.x0 + 2, polyEntrySpanLo + 1.5) : es.x0 + 2;
    const exHi = polyMode ? Math.min(es.x1 - 2, polyEntrySpanHi - 1.5) : es.x1 - 2;

    const buildDuplex = (): boolean => {
      // The two-room split, kept honest: forced axis + off-center cut, so
      // even the classic differs round to round.
      let axisX = Math.random() < 0.5;
      for (let flip = 0; flip < 2; flip++, axisX = !axisX) {
        const lo = axisX ? es.x0 : es.y0;
        const hi = axisX ? es.x1 : entryY1;
        if (hi - lo < 6) continue;
        const cut = randInt(Math.ceil(lo + 3), Math.floor(hi - 3));
        if (cut <= lo || cut >= hi) continue;
        if (axisX) {
          leaves.push({ x0: es.x0, y0: es.y0, x1: cut, y1: entryY1 });
          leaves.push({ x0: cut, y0: es.y0, x1: es.x1, y1: entryY1 });
          splits.push({ axis: "x", cut, lo: es.y0, hi: entryY1 });
          interior.push(makeWall(houseWallKind, cut, es.y0, cut, entryY1, W, H));
        } else {
          leaves.push({ x0: es.x0, y0: es.y0, x1: es.x1, y1: cut });
          leaves.push({ x0: es.x0, y0: cut, x1: es.x1, y1: entryY1 });
          splits.push({ axis: "y", cut, lo: es.x0, hi: es.x1 });
          interior.push(makeWall(houseWallKind, es.x0, cut, es.x1, cut, W, H));
        }
        return true;
      }
      return false;
    };

    const buildNook = (): boolean => {
      // Corner alcove behind an L of walls, entered through a 2-cell OPEN
      // threshold (no door — a doorway this size would eat the room). Back
      // corners only, clear of the entry door's swing.
      if (exW < 6 || exD < 5) return false;
      const west = Math.random() < 0.5;
      const nw = snapBetween(2.5, Math.min(exW - 3, exW * 0.55));
      const nd = snapBetween(2.5, Math.min(exD - 2.5, exD * 0.55));
      if (nw === null || nd === null) return false;
      const cx = west ? es.x0 + nw : es.x1 - nw; // vertical wall line
      const cy = es.y0 + nd; // horizontal wall line
      interior.push(
        west ? makeWall(houseWallKind, es.x0, cy, cx, cy, W, H) : makeWall(houseWallKind, cx, cy, es.x1, cy, W, H)
      );
      // The vertical wall stops 2 cells short of the cap — that gap IS the
      // threshold; below it the line is fully open floor.
      interior.push(makeWall(houseWallKind, cx, es.y0, cx, cy - 2, W, H));
      clearances.push(boxAt(cx, cy - 1, 1.5, 1.5)); // keep the threshold clear
      if (west) {
        leaves.push({ x0: es.x0, y0: es.y0, x1: cx, y1: cy });
        leaves.push({ x0: es.x0, y0: cy, x1: cx, y1: entryY1 });
        leaves.push({ x0: cx, y0: es.y0, x1: es.x1, y1: entryY1 });
      } else {
        leaves.push({ x0: cx, y0: es.y0, x1: es.x1, y1: cy });
        leaves.push({ x0: cx, y0: cy, x1: es.x1, y1: entryY1 });
        leaves.push({ x0: es.x0, y0: es.y0, x1: cx, y1: entryY1 });
      }
      openContacts.push({ axis: "x", c: cx, lo: cy - 2, hi: entryY1 });
      return true;
    };

    const buildVestibule = (): boolean => {
      // A baffle wall 2.5 cells inside the entry door (just past the leaf's
      // swing): the breach opens onto a wall and forces an immediate
      // left-or-right read.
      if (exD < 5.5 || exW < 6.5) return false;
      const ex = snapBetween(exLo, exHi);
      if (ex === null) return false;
      const len = Math.min(4, exW - 3.4);
      if (len < 3) return false;
      const by = entryY1 - 2.5;
      const bx = Math.min(Math.max(ex, es.x0 + 1.7 + len / 2), es.x1 - 1.7 - len / 2);
      const baffle = makeWall(houseWallKind, bx - len / 2, by, bx + len / 2, by, W, H);
      const be = objectExtent(baffle);
      cozyStubWalls.push(baffle);
      cozyBoxes.push(boxAt(baffle.x, baffle.y, be.w, be.h));
      cozyEntryX = ex; // the door must stay centered on the baffle
      leaves.push({ ...es });
      return true;
    };

    const buildDiagonal = (): boolean => {
      // 45° walls cutting one or (in a wide shell) two back corners. The
      // corner triangles seal shut — their boxes keep everything out, so the
      // angled wall is pure architecture, not a pocket.
      if (exW < 6 || exD < 5.5) return false;
      const corners = exW >= 10 && Math.random() < 0.4 ? 2 : 1;
      let west = Math.random() < 0.5;
      let built = false;
      for (let c = 0; c < corners; c++, west = !west) {
        let dMax = Math.min(4.5, Math.min(exW - 2, exD - 2.5));
        if (corners === 2) dMax = Math.min(dMax, (exW - 3) / 2);
        const d = snapBetween(2.5, dMax);
        if (d === null) continue;
        const diag = west
          ? makeWall(houseWallKind, es.x0 + d, es.y0, es.x0, es.y0 + d, W, H)
          : makeWall(houseWallKind, es.x1 - d, es.y0, es.x1, es.y0 + d, W, H);
        const de = objectExtent(diag);
        cozyStubWalls.push(diag);
        cozyBoxes.push(boxAt(diag.x, diag.y, de.w, de.h));
        built = true;
      }
      if (built) leaves.push({ ...es });
      return built;
    };

    const buildSlalom = (): boolean => {
      // Two staggered stubs from opposite walls: the push to the back of the
      // space becomes an S-route with two blind turns.
      if (exD < 5.5 || exW < 5) return false;
      let ex = snapBetween(exLo, exHi);
      if (ex === null) ex = snap(Math.min(Math.max((es.x0 + es.x1) / 2, exLo), Math.max(exLo, exHi)));
      const entryBox = [boxAt(ex, entryY1, 2.0, 2.0)];
      for (let attempt = 0; attempt < 10; attempt++) {
        const ya = snapBetween(es.y0 + 1.5, entryY1 - 4);
        if (ya === null) return false;
        const yb = Math.min(snapDown(entryY1 - 1.5), ya + 0.5 * randInt(4, 6));
        if (yb - ya < 2) continue; // the S-corridor stays ≥1 m wide
        const firstWest = Math.random() < 0.5;
        const la = snapDown(Math.min(Math.max(randRange(exW * 0.45, exW - 1.7), 2), exW - 1.7));
        const lb = snapDown(Math.min(Math.max(randRange(exW * 0.45, exW - 1.7), 2), exW - 1.7));
        if (la < 2 || lb < 2) continue;
        const wa = firstWest
          ? makeWall(houseWallKind, es.x0, ya, es.x0 + la, ya, W, H)
          : makeWall(houseWallKind, es.x1 - la, ya, es.x1, ya, W, H);
        const wb = firstWest
          ? makeWall(houseWallKind, es.x1 - lb, yb, es.x1, yb, W, H)
          : makeWall(houseWallKind, es.x0, yb, es.x0 + lb, yb, W, H);
        const ea = objectExtent(wa);
        const eb = objectExtent(wb);
        const boxA = boxAt(wa.x, wa.y, ea.w, ea.h);
        const boxB = boxAt(wb.x, wb.y, eb.w, eb.h);
        // The deeper stub sits near the entry wall — never inside the breach
        // leaf's swing.
        if (hitsAny(boxB, entryBox)) continue;
        cozyStubWalls.push(wa, wb);
        cozyBoxes.push(boxA, boxB);
        cozyEntryX = ex;
        leaves.push({ ...es });
        return true;
      }
      return false;
    };

    let builtVariant =
      cozyVariant === "duplex" ? buildDuplex()
      : cozyVariant === "nook" ? buildNook()
      : cozyVariant === "vestibule" ? buildVestibule()
      : cozyVariant === "diagonal" ? buildDiagonal()
      : cozyVariant === "slalom" ? buildSlalom()
      : false;
    // Graceful chain: an infeasible card falls to duplex, then to a plain
    // open bay — a correct house always ships.
    if (!builtVariant && cozyVariant !== "duplex" && buildDuplex()) {
      cozyVariant = "duplex";
      builtVariant = true;
    }
    if (!builtVariant) {
      leaves.push({ ...es });
      cozyVariant = "openplan";
    }
    lastInteriorStyle = `cozy:${cozyVariant}`;
  }

  // ── polygon mode: close rooms against the angled shell ──────
  // Interior walls span their rectangular planning leaf, but the real
  // perimeter is the polygon — extend every interior wall end to the shell
  // centerline (+0.25-cell tuck) unless the end abuts another planning
  // region, whose threshold stays open. polyHugSegs then feeds the
  // wall-behind checks for furniture hugging and stub roots.
  let polyHugSegs: Array<{ a: Pt; b: Pt }> | null = null;
  if (polyMode) {
    const shellSegs = perimeter.map(segOfWall);
    for (const iw of interior) extendWallEnds(iw, shells, shellSegs);
    polyHugSegs = [...shellSegs, ...interior.map(segOfWall)];
  }

  // Party walls between wings, one doorway each — this is what keeps an
  // L-shaped house one house. Two exceptions go OPEN instead (no wall):
  // spans too tight for a doorway (connectivity beats tidiness), and a
  // random quarter of the rest — an open threshold between wings is real
  // architecture and varies the structure. Open contacts still get a
  // clearance box so furniture never plugs the passage.
  for (const ct of contacts) {
    const sp = contactSpan(ct);
    if (sp.hi - sp.lo < 2.2 || Math.random() < 0.25) {
      addDoorClearance(...((ct.axis === "x" ? [ct.c, (sp.lo + sp.hi) / 2] : [(sp.lo + sp.hi) / 2, ct.c]) as [number, number]));
      openContacts.push({ axis: ct.axis, c: ct.c, lo: sp.lo, hi: sp.hi });
      continue;
    }
    const kind = houseWallKind;
    perimeter.push(
      ct.axis === "x" ? makeWall(kind, ct.c, sp.lo, ct.c, sp.hi, W, H) : makeWall(kind, sp.lo, ct.c, sp.hi, ct.c, W, H)
    );
    const t = pickDoorT(sp.lo, sp.hi, []);
    const [dx, dy] = ct.axis === "x" ? [ct.c, t] : [t, ct.c];
    doors.push({ ...makeObject(pick(doorKinds), dx, dy, W, H), x: dx, y: dy, rotation: ct.axis === "x" ? 90 : 0 });
    addDoorClearance(dx, dy);
  }

  for (const s of splits) {
    const junctions = splits
      .filter((o) => o !== s && o.axis !== s.axis && (o.lo === s.cut || o.hi === s.cut))
      .filter((o) => o.cut > s.lo && o.cut < s.hi)
      .map((o) => o.cut);
    const t = pickDoorT(s.lo, s.hi, junctions);
    const [dx, dy] = s.axis === "x" ? [s.cut, t] : [t, s.cut];
    doors.push({ ...makeObject(pick(doorKinds), dx, dy, W, H), x: dx, y: dy, rotation: s.axis === "x" ? 90 : 0 });
    addDoorClearance(dx, dy);
  }

  // Entry: under hallway, the corridor IS the entry leaf and the door sits at
  // its mouth; otherwise the widest leaf on the entry wing's south wall gets
  // the perimeter door. Leaves from OTHER wings can share the same y1 by
  // coincidence, so the filter also pins the x-range.
  let entryLeaf: Leaf;
  let entryX: number;
  if (style === "hallway" && hallEntryLeaf) {
    entryLeaf = hallEntryLeaf;
    entryX = hallEntryX;
  } else {
    const southLeaves = leaves.filter(
      (l) => Math.abs(l.y1 - entryY1) < eps && l.x0 >= entryShell.x0 - eps && l.x1 <= entryShell.x1 + eps
    );
    entryLeaf = southLeaves.reduce((a, b) => (a.x1 - a.x0 >= b.x1 - b.x0 ? a : b));
    const southJunctions = splits
      .filter((s) => s.axis === "x" && Math.abs(s.hi - entryY1) < eps && s.cut > entryLeaf.x0 && s.cut < entryLeaf.x1)
      .map((s) => s.cut);
    // Polygon mode: the door must land where the entry span actually has a
    // shell wall behind it.
    let dLo = entryLeaf.x0, dHi = entryLeaf.x1;
    if (polyMode) {
      dLo = Math.max(dLo, polyEntrySpanLo);
      dHi = Math.min(dHi, polyEntrySpanHi);
      if (dHi - dLo < 3) { dLo = polyEntrySpanLo; dHi = polyEntrySpanHi; }
    }
    // Vestibule/slalom pinned the door while building around it.
    entryX = !Number.isNaN(cozyEntryX) ? cozyEntryX : pickDoorT(dLo, dHi, southJunctions);
  }
  // x/y spread-override: the entry wall sits on the off-grid yard line, and
  // makeObject's half-cell snap pushed the frame 5 cm off the wall plane —
  // the finger-width slit beside generated doors.
  const entryDoor = { ...makeObject(pick(swingDoorKinds), entryX, entryY1, W, H), x: entryX, y: entryY1, rotation: 0 };
  doors.push(entryDoor);
  addDoorClearance(entryX, entryY1);
  // The breach doorway stays person-free even under the relaxed sweep tiers —
  // its leaf must always swing (see sweepNpc).
  const entryClearance = [boxAt(entryX, entryY1, 2.0, 2.0)];

  const startDef = paletteById.start;
  // Centered on the entry door, just OUTSIDE the south wall — or just inside
  // it when there's no yard strip. The clamp keeps the zone clear of the room
  // edge (outside, where the yard is open) or inside the entry leaf (inside,
  // where drifting sideways would cross an interior wall). Snapped up front so
  // the collision box below matches where makeObject puts the zone.
  const startLo = exteriorStart ? (polyMode ? polyEntrySpanLo : entryShell.x0) : entryLeaf.x0;
  const startHi = exteriorStart ? (polyMode ? polyEntrySpanHi : entryShell.x1) : entryLeaf.x1;
  let startX = Math.min(Math.max(entryX, snapUp(startLo + 1)), snapDown(startHi - 1));
  // Outside: wall half-thickness + a 1-cell (0.5 m) standoff + the zone's
  // half-depth — the zone's near edge is half a meter clear of the door, so
  // nobody stages nose-to-leaf. Exact placement (the spread below skips
  // makeObject's half-cell snap, which would eat a third of the standoff).
  // Inside (tiny-space fallback): tight to the wall as before — a room too
  // small for a yard can't afford a standoff either.
  // Zone center rides the yard depth: full standoff with a 2.1 yard,
  // proportionally tighter (never past the yard strip) when it shrank.
  let startY = exteriorStart ? entryY1 + Math.min(1.55, YARD + 0.04) : snapDown(entryY1 - 0.76);
  if (polyMode && exteriorStart) {
    // The yard strip is a trapezoid against angled neighbors — the zone must
    // fit INSIDE the walked outline (rear corners get a whisker of
    // forgiveness on the 1.5-tier where the zone kisses the line). Slide
    // along the entry wall nearest-to-door first; nothing fits → start just
    // inside the doorway instead.
    const startDef0 = paletteById.start;
    const hw = startDef0.defaultW / 2 + 0.1, hh = startDef0.defaultH / 2 + 0.1;
    const yClamp = entryY1 + YARD - 0.05;
    const fitsAt = (sx: number): boolean => {
      const yRear = Math.min(startY + hh, yClamp);
      return pointInPoly(shellP!, { x: sx - hw, y: startY - hh })
        && pointInPoly(shellP!, { x: sx + hw, y: startY - hh })
        && pointInPoly(shellP!, { x: sx - hw, y: yRear })
        && pointInPoly(shellP!, { x: sx + hw, y: yRear });
    };
    let found: number | null = null;
    for (let off = 0; off <= startHi - startLo && found === null; off += 0.5)
      for (const sx of [startX + off, startX - off]) {
        if (sx < startLo + 1 - 1e-3 || sx > startHi - 1 + 1e-3) continue;
        if (fitsAt(snap(sx))) { found = snap(sx); break; }
      }
    if (found !== null) startX = found;
    else {
      exteriorStart = false;
      startX = Math.min(Math.max(entryX, snapUp(entryLeaf.x0 + 1)), snapDown(entryLeaf.x1 - 1));
      startY = snapDown(entryY1 - 0.76);
    }
  }
  const start = { ...makeObject("start", startX, startY, W, H), x: startX, y: startY };
  const placed: Box[] = [boxAt(startX, startY, startDef.defaultW / 2, startDef.defaultH / 2)];

  // ── stub walls (deadspace) ────────────────────────────────────
  // A single interior wall jutting off a room wall makes a blind corner the
  // squad has to clear around. Walkability is guaranteed by construction: at
  // most ONE stub per leaf (two dead-ends from opposite walls could otherwise
  // join into a full divider with no door), the tip always leaves a ≥1.6-cell
  // walkway to the far wall, and the base stays 1.5 cells off the leaf's
  // corners — a dead-end wall like that can never seal floor off, it only
  // makes you walk around it.
  //
  // Stubs NEVER carry doors: doors exist only on split walls and the entry
  // (nothing below ever creates one on a stub), and the doorway-clearance
  // rejection keeps every stub far enough from every door (≥1.85 cells) that
  // wallsWithDoorGaps' cut tolerance (0.65 perp, ±half a door along the line)
  // can't reach a stub either. A doorway in a dead-end wall would read as an
  // exit that leads into a pocket.
  // Three species (2026-08-17 "Blueprint Deck"): straight stubs (the classic),
  // L-pockets (a return at the tip — a true blind pocket), and freestanding
  // partitions (a floating wall island, walkable on every side). The budget
  // scales with floor area; the open style leans on partitions for most of
  // its structure. Partitions/returns stay ≥1 cell off every wall (a return
  // that touched a wall would seal a cell shut). Corridors never take stubs.
  const stubs: PlacedObject[] = [];
  // Stub/partition boxes tracked separately with a hard 1.6-cell mutual
  // walkway: two collinear stubs from opposite walls at the same coordinate
  // would join into a full divider and SEAL the room (the exact failure the
  // old one-per-leaf rule guarded against) — the separation keeps every
  // pairing passable while still allowing several structures in a big room.
  const stubBoxes: Box[] = [];
  let stubArea = 0;
  for (const l of leaves) if (!corridorLeaves.has(l)) stubArea += leafArea(l);
  const stubBudget =
    style === "open"
      ? Math.min(5, Math.max(2, Math.round(stubArea / 20)))
      : Math.min(3, Math.max(1, Math.round(stubArea / 45)));

  const tryStraightStub = (
    leaf: Leaf
  ): { wall: PlacedObject; side: "N" | "S" | "W" | "E"; t: number; len: number } | null => {
    const side = pick(["N", "S", "W", "E"] as const);
    const vertical = side === "N" || side === "S"; // stub runs along y
    const cross = vertical ? leaf.y1 - leaf.y0 : leaf.x1 - leaf.x0;
    const along = vertical ? leaf.x1 - leaf.x0 : leaf.y1 - leaf.y0;
    if (cross - 1.6 < 1.5 || along < 4) return null; // leaf too small for a pocket
    const len = snapDown(Math.min(cross - 1.6, randRange(1.5, cross * 0.6)));
    if (len < 1.5) return null;
    const t = vertical
      ? snapBetween(leaf.x0 + 1.5, leaf.x1 - 1.5)
      : snapBetween(leaf.y0 + 1.5, leaf.y1 - 1.5);
    if (t === null) return null;
    // Polygon mode: the root edge must actually carry a wall.
    if (polyHugSegs
        && !wallBehindSpan(polyHugSegs, vertical,
                           side === "N" ? leaf.y0 : side === "S" ? leaf.y1 : side === "W" ? leaf.x0 : leaf.x1,
                           t - 0.5, t + 0.5,
                           side === "N" || side === "W" ? 1 : -1))
      return null;
    const wall =
      side === "N" ? makeWall(houseWallKind, t, leaf.y0, t, leaf.y0 + len, W, H)
      : side === "S" ? makeWall(houseWallKind, t, leaf.y1, t, leaf.y1 - len, W, H)
      : side === "W" ? makeWall(houseWallKind, leaf.x0, t, leaf.x0 + len, t, W, H)
      : makeWall(houseWallKind, leaf.x1, t, leaf.x1 - len, t, W, H);
    const e = objectExtent(wall);
    const box = boxAt(wall.x, wall.y, e.w, e.h);
    // Extra breathing room (0.4) against the start zone; doorway clearance
    // keeps a stub from walling off a door's approach; 1.6 against every
    // other stub keeps any pairing walkable.
    if (hitsAny(box, placed, 0.4) || hitsAny(box, clearances) || hitsAny(box, stubBoxes, 1.6)) return null;
    return { wall, side, t, len };
  };

  const tryStub = (leaf: Leaf): boolean => {
    // Partition: a floating wall island (needs breathing room — ≥2.1-cell
    // walkway past each end, ≥1.8 off the flanking walls).
    const partitionOdds = style === "open" ? 0.45 : 0.2;
    if (Math.random() < partitionOdds) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const alongX = Math.random() < 0.5;
        const aLo = alongX ? leaf.x0 : leaf.y0;
        const aHi = alongX ? leaf.x1 : leaf.y1;
        const cLo = alongX ? leaf.y0 : leaf.x0;
        const cHi = alongX ? leaf.y1 : leaf.x1;
        if (aHi - aLo < 6.5 || cHi - cLo < 4) continue;
        const len = snapDown(Math.min(4, randRange(2, aHi - aLo - 4.4)));
        if (len < 2) continue;
        const ac = snapBetween(aLo + 2.1 + len / 2, aHi - 2.1 - len / 2);
        const cc = snapBetween(cLo + 1.8, cHi - 1.8);
        if (ac === null || cc === null) continue;
        const pw = alongX
          ? makeWall(houseWallKind, ac - len / 2, cc, ac + len / 2, cc, W, H)
          : makeWall(houseWallKind, cc, ac - len / 2, cc, ac + len / 2, W, H);
        const pe = objectExtent(pw);
        const pbox = boxAt(pw.x, pw.y, pe.w, pe.h);
        if (hitsAny(pbox, placed, 0.5) || hitsAny(pbox, clearances) || hitsAny(pbox, stubBoxes, 1.6)) continue;
        stubs.push(pw);
        placed.push(pbox); // furniture and NPCs route around it
        stubBoxes.push(pbox);
        return true;
      }
      // No room to float one — fall through to a wall stub.
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = tryStraightStub(leaf);
      if (!res) continue;
      const { wall, side, t, len } = res;
      const e = objectExtent(wall);
      const stubBox = boxAt(wall.x, wall.y, e.w, e.h);
      stubs.push(wall);
      placed.push(stubBox);
      stubBoxes.push(stubBox);
      // L-pocket: a short return at the tip turns the stub into a true blind
      // pocket. Best-effort — the straight stub stands whether or not the
      // return fits. The return deliberately touches its OWN stub, so the
      // collision checks exclude stubBox.
      if (Math.random() < 0.45) {
        const vertical = side === "N" || side === "S";
        const tipX = vertical ? t : side === "W" ? leaf.x0 + len : leaf.x1 - len;
        const tipY = vertical ? (side === "N" ? leaf.y0 + len : leaf.y1 - len) : t;
        const rl = 0.5 * randInt(2, 3); // 1–1.5 cells
        const rdir = Math.random() < 0.5 ? 1 : -1;
        const ret = vertical
          ? makeWall(houseWallKind, tipX, tipY, tipX + rdir * rl, tipY, W, H)
          : makeWall(houseWallKind, tipX, tipY, tipX, tipY + rdir * rl, W, H);
        const re = objectExtent(ret);
        const rbox = boxAt(ret.x, ret.y, re.w, re.h);
        const inLeaf =
          rbox.x0 >= leaf.x0 + 1 && rbox.x1 <= leaf.x1 - 1 && rbox.y0 >= leaf.y0 + 1 && rbox.y1 <= leaf.y1 - 1;
        const othersPlaced = placed.filter((b) => b !== stubBox);
        const otherStubs = stubBoxes.filter((b) => b !== stubBox);
        if (
          inLeaf &&
          !hitsAny(rbox, othersPlaced, 0.4) &&
          !hitsAny(rbox, clearances) &&
          !hitsAny(rbox, otherStubs, 1.6)
        ) {
          stubs.push(ret);
          placed.push(rbox);
          stubBoxes.push(rbox);
        }
      }
      return true;
    }
    return false;
  };

  // The cozy structural pieces (baffle/diagonals/slalom) enter the stub
  // system here: emitted with the stubs, boxed against furniture/NPCs, party
  // to the 1.6-cell walkway rule, and counted against the budget.
  stubs.push(...cozyStubWalls);
  for (const b of cozyBoxes) {
    placed.push(b);
    stubBoxes.push(b);
  }
  let stubCount = cozyStubWalls.length;
  for (let pass = 0; pass < 2 && stubCount < stubBudget; pass++) {
    for (const leaf of shuffle(leaves)) {
      if (stubCount >= stubBudget) break;
      if (corridorLeaves.has(leaf)) continue;
      if (pass === 0 && Math.random() < 0.35) continue; // scatter across leaves
      if (tryStub(leaf)) stubCount++;
    }
  }

  // ── the cast ──────────────────────────────────────────────────
  // People are placed BEFORE furniture: in a tiny play space the free floor
  // can be little more than the start zone, and a person matters more than
  // one more cabinet — furniture placed afterwards simply works around them.
  const npcs: PlacedObject[] = [];
  const tryNpc = (leaf: Leaf, kind: string, behavior: Behavior, attempts = 10): boolean => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const x = snapBetween(leaf.x0 + 1, leaf.x1 - 1);
      const y = snapBetween(leaf.y0 + 1, leaf.y1 - 1);
      if (x === null || y === null) return false;
      // 0.71, not 0.5: the 1×1 marker gets a random rotation below, and a
      // rotated unit square's AABB reaches √2 across.
      const box = boxAt(x, y, 0.71, 0.71);
      if (hitsAny(box, placed) || hitsAny(box, clearances)) continue;
      if (Math.hypot(x - startX, y - startY) < 2.5) continue;
      placed.push(box);
      npcs.push({ ...makeObject(kind, x, y, W, H), rotation: randInt(0, 359), behavior });
      return true;
    }
    return false;
  };

  // Floor sweep with progressively relaxed rules — the fallback when the
  // random rolls can't find space. Shared by the guaranteed hostile (all
  // tiers, down to packed-tight) and the extras (never tight — an extra that
  // truly doesn't fit is simply dropped). Tiers: entry leaf included, then
  // the stay-away-from-start rule waived, then doorway clearances waived (a
  // target in a doorway is a legal, mean room), then exact 1×1 footprint
  // with no breathing gap. Overlapping the start zone or a wall is never
  // allowed.
  type SweepTier = { nearStart: boolean; doorway: boolean; tight: boolean };
  const sweepNpc = (sweepLeaves: Leaf[], kind: string, behavior: Behavior, tiers: SweepTier[]): boolean => {
    for (const relax of tiers) {
      for (const l of sweepLeaves) {
        for (let y = l.y0 + 1; y <= l.y1 - 1; y += 0.5) {
          for (let x = l.x0 + 1; x <= l.x1 - 1; x += 0.5) {
            const half = relax.tight ? 0.5 : 0.71;
            const box = boxAt(x, y, half, half);
            if (hitsAny(box, placed, relax.tight ? 0 : 0.25)) continue;
            if (!relax.doorway && hitsAny(box, clearances)) continue;
            // The ENTRY doorway is never waived — the breach leaf must always swing free.
            if (relax.doorway && hitsAny(box, entryClearance)) continue;
            if (!relax.nearStart && Math.hypot(x - startX, y - startY) < 2.5) continue;
            placed.push(box);
            npcs.push({
              ...makeObject(kind, x, y, W, H),
              rotation: relax.tight ? 0 : randInt(0, 359),
              behavior,
            });
            return true;
          }
        }
      }
    }
    return false;
  };


  // ── furniture ─────────────────────────────────────────────────
  // Wall-side rotation faces the piece into the room; the footprint math is
  // exact for any rotation (halfExtent), the facing itself is cosmetic.
  const SIDES = [
    { side: "N", rot: 0 },
    { side: "S", rot: 180 },
    { side: "W", rot: 270 },
    { side: "E", rot: 90 },
  ] as const;

  const furniture: PlacedObject[] = [];
  const tryPlace = (leaf: Leaf, kind: string, wall: boolean): { obj: PlacedObject; box: Box } | null => {
    const def = paletteById[kind];
    if (!def) return null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const rot = wall ? pick(SIDES).rot : pick([0, 90]);
      const e = halfExtent(def.defaultW, def.defaultH, rot);
      // Too big for this leaf (with a 1-cell walkway to spare)? Skip the item —
      // a sparse room beats an overlapping one.
      if (2 * e.w + 1 > leaf.x1 - leaf.x0 || 2 * e.h + 1 > leaf.y1 - leaf.y0) return null;
      let x: number, y: number;
      if (wall) {
        // Hug the chosen wall with a small clearance, random along it. Offsets
        // snap INTO the room (never onto the wall); the along-wall coordinate
        // must find a half-cell inside its range or the attempt fails.
        // BARELY off the wall: half the wall's 0.1-cell thickness + a hair of
        // air (≈2.5 cm), so the piece's back face almost touches the wall face.
        // The perpendicular coordinate is exact — snapping it to the half-cell
        // grid pushed pieces up to 40 cm off the wall face, which reads as
        // "floating in the room" at VR scale. Only the along-wall coordinate
        // keeps the grid. (The headset honors this only because the loader
        // re-centers each prefab's collider AABB on the wire point —
        // RoomBuilderLoader.CenterFurnitureOnPoint; off-center pivots used to
        // sink cabinets and closets deep into the wall.)
        const HUG = 0.1; // cells off the wall CENTERLINE (≈2.5 cm off its face)
        const s = SIDES.find((sd) => sd.rot === rot)!.side;
        if (s === "N" || s === "S") {
          y = s === "N" ? leaf.y0 + e.h + HUG : leaf.y1 - e.h - HUG;
          const xs = snapBetween(leaf.x0 + e.w + 0.35, leaf.x1 - e.w - 0.35);
          if (xs === null) continue;
          x = xs;
        } else {
          x = s === "W" ? leaf.x0 + e.w + HUG : leaf.x1 - e.w - HUG;
          const ys = snapBetween(leaf.y0 + e.h + 0.35, leaf.y1 - e.h - 0.35);
          if (ys === null) continue;
          y = ys;
        }
        // The chosen edge must actually HAVE a wall behind the piece — an
        // open wing-connection line has none, and "hugging" it would strand
        // the piece in the middle of the passage.
        const edgeAxis = s === "N" || s === "S" ? "y" : "x";
        const edgeC = s === "N" ? leaf.y0 : s === "S" ? leaf.y1 : s === "W" ? leaf.x0 : leaf.x1;
        const alongC = edgeAxis === "y" ? x : y;
        const alongHalf = edgeAxis === "y" ? e.w : e.h;
        // Polygon mode: a leaf edge counts as a wall only if a near-parallel
        // wall segment really is behind the span.
        const backsOntoOpen = polyHugSegs
          ? !wallBehindSpan(polyHugSegs, edgeAxis === "y", edgeC, alongC - alongHalf, alongC + alongHalf,
                            s === "N" || s === "W" ? 1 : -1)
          : openContacts.some(
              (oc) =>
                oc.axis === edgeAxis &&
                Math.abs(oc.c - edgeC) < 0.05 &&
                alongC + alongHalf > oc.lo - 0.1 &&
                alongC - alongHalf < oc.hi + 0.1
            );
        if (backsOntoOpen) continue;
      } else {
        x = snap((leaf.x0 + leaf.x1) / 2 + randRange(-1.5, 1.5));
        y = snap((leaf.y0 + leaf.y1) / 2 + randRange(-1.5, 1.5));
        if (x - e.w < leaf.x0 + 0.35 || x + e.w > leaf.x1 - 0.35) continue;
        if (y - e.h < leaf.y0 + 0.35 || y + e.h > leaf.y1 - 0.35) continue;
      }
      const box = boxAt(x, y, e.w, e.h);
      if (hitsAny(box, placed) || hitsAny(box, clearances)) continue;
      placed.push(box);
      // x/y spread-override: makeObject snaps to the half-cell grid, which
      // would pull a flush wall placement back off the wall.
      const obj = { ...makeObject(kind, x, y, W, H), x, y, rotation: rot };
      furniture.push(obj);
      return { obj, box };
    }
    return null;
  };

  // Chairs never stand alone — they're pulled up to a table, flush against a
  // random edge (a 0.02-cell hair gap keeps float noise from reading as an
  // overlap) and facing it. Positions come off the half-cell grid so the seat
  // actually touches; the map doesn't care.
  const CHAIR_KINDS = kindsIn("Chair");
  const placeChairs = (leaf: Leaf, table: PlacedObject, tableBox: Box, count: number): void => {
    const othersThanTable = placed.filter((b) => b !== tableBox);
    const et = halfExtent(table.w, table.h, table.rotation);
    // Rotation turns the seat toward the table on each edge — same convention
    // as SIDES above: a chair north of the table is "against the table's
    // north face", so it takes the north-wall rotation (0 = facing south,
    // into the table). Same numbers for the other three edges.
    const sides = shuffle([
      { dx: 0, dy: -1, rot: 0 },
      { dx: 0, dy: 1, rot: 180 },
      { dx: -1, dy: 0, rot: 270 },
      { dx: 1, dy: 0, rot: 90 },
    ]);
    let seated = 0;
    for (const side of sides) {
      if (seated >= count) break;
      const kind = pick(CHAIR_KINDS);
      const def = paletteById[kind];
      if (!def) continue;
      const ec = halfExtent(def.defaultW, def.defaultH, side.rot);
      let x: number, y: number;
      if (side.dy !== 0) {
        y = table.y + side.dy * (et.h + ec.h + 0.02);
        x = table.x + randRange(-(et.w - ec.w), et.w - ec.w);
      } else {
        x = table.x + side.dx * (et.w + ec.w + 0.02);
        y = table.y + randRange(-(et.h - ec.h), et.h - ec.h);
      }
      const box = boxAt(x, y, ec.w, ec.h);
      if (box.x0 < leaf.x0 + 0.3 || box.x1 > leaf.x1 - 0.3 || box.y0 < leaf.y0 + 0.3 || box.y1 > leaf.y1 - 0.3) continue;
      if (hitsAny(box, othersThanTable) || hitsAny(box, clearances)) continue;
      placed.push(box);
      othersThanTable.push(box);
      // Spread-override x/y: makeObject snaps to the half-cell grid, which
      // would pull the seat off the table edge.
      furniture.push({ ...makeObject(kind, x, y, W, H), x, y, rotation: side.rot });
      seated++;
    }
  };

  // Furnishing profile, rolled per house (2026-08-16): some houses are bare
  // (a cleared-out or unfinished home reads real), most are lived-in, some
  // are cluttered — dense only adds storage pieces a real room would
  // plausibly hold. 0 = bare, 1 = sparse (each item 50/50), 2 = normal,
  // 3 = dense.
  const fr = Math.random();
  const furnishProfile = fr < 0.12 ? 0 : fr < 0.37 ? 1 : fr < 0.85 ? 2 : 3;
  if (furnishProfile > 0) {
    // The entry leaf is always the living room; the rest draw types without
    // replacement so a two-bathroom house doesn't happen. Corridors stay bare
    // (a furnished hallway blocks the breach).
    const typePool = shuffle<RoomType>(["bedroom", "bathroom", "office", "living"]);
    const denseExtras = ["Drawer", "Closet", "Cabinet"];
    const furnish = (leaf: Leaf, type: RoomType) => {
      for (const item of menuFor(type)) {
        if (furnishProfile === 1 && Math.random() < 0.5) continue;
        const kinds = kindsIn(item.category);
        if (!kinds.length) continue;
        const res = tryPlace(leaf, pick(kinds), item.wall);
        // Tables seat 1–2 chairs; chairs appear nowhere else.
        if (res && item.category === "Table") placeChairs(leaf, res.obj, res.box, randInt(1, 2));
      }
    };
    for (const leaf of leaves) {
      if (corridorLeaves.has(leaf)) continue;
      const type: RoomType = leaf === entryLeaf ? "living" : typePool.pop() ?? "living";
      furnish(leaf, type);
      // A big open bay reads empty with one room's worth — deal it a second
      // suite (the open style's giant studio especially).
      if (leafArea(leaf) >= 55) furnish(leaf, typePool.pop() ?? "office");
      if (furnishProfile === 3) {
        const kinds = kindsIn(pick(denseExtras));
        if (kinds.length) tryPlace(leaf, pick(kinds), true);
      }
    }
  }

  // ── extra targets ─────────────────────────────────────────────
  // 0–4 people, each rolling model AND disposition independently — no
  // guaranteed hostile, no guaranteed bystander (2026-08-16). An empty house
  // and an all-compliant house are both legal rounds: clear every room, read
  // every person, never assume there's someone to shoot. Each person tries
  // every room, then falls back to the relaxed sweep.
  const placePerson = (kind: string, behavior: Behavior): boolean => {
    for (const leaf of shuffle(leaves)) if (tryNpc(leaf, kind, behavior, 12)) return true;
    return sweepNpc(shuffle(leaves), kind, behavior, [
      { nearStart: false, doorway: false, tight: false },
      { nearStart: true, doorway: false, tight: false },
      { nearStart: true, doorway: true, tight: false },
    ]);
  };
  // Count and behaviors are deck-dealt by Fish Bowl (castCount /
  // castBehaviors) so sizes alternate 0–4 and the four dispositions
  // distribute evenly across rounds; one-shot callers roll here.
  const cast = opts.castCount != null ? Math.min(4, Math.max(0, opts.castCount)) : randInt(0, 4);
  for (let i = 0; i < cast; i++) {
    const behavior = opts.castBehaviors?.length
      ? opts.castBehaviors[i % opts.castBehaviors.length]
      : pick(CAST_BEHAVIORS);
    placePerson(pick(NPC_KINDS), behavior);
  }

  // A person standing in an interior doorway (relaxed-sweep placements in
  // tight houses) would block the leaf's swing — swap that door for an open
  // frame instead: no leaf, nothing to block, still a cut doorway. Never the
  // entry (person-free by construction above).
  for (const d of doors) {
    if (d === entryDoor || d.kind === "Open Door Frame") continue;
    if (npcs.some((n) => Math.abs(n.x - d.x) < 2 && Math.abs(n.y - d.y) < 2)) d.kind = "Open Door Frame";
  }

  const now = Date.now();
  return {
    id: newRoomId(),
    name: opts.name ?? "Random House",
    width: W,
    height: H,
    objects: [...perimeter, ...interior, ...stubs, ...doors, ...furniture, ...npcs, start],
    createdAt: now,
    updatedAt: now,
  };
}
