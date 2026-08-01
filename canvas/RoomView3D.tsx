import React, { useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, View } from "react-native";
import Svg, { Circle, Ellipse, G, Line, Path, Polygon } from "react-native-svg";
import {
  CELL,
  FOOT_METERS,
  CELL_METERS,
  behaviorColor,
  isDoorKind,
  isNpcKind,
  isWallKind,
  paletteById,
  type PlacedObject,
  type Room,
} from "../rooms";
import { colors } from "../theme";
import type { NpcPositions, TrackMark } from "../tracking";
import type { DoorAngles } from "../protocol";

// A live "dollhouse" view of a room being cleared.
//
// This exists because casting real video off a Quest costs frame budget the game
// cannot spare (an extra camera render plus an encode, every frame). Everything
// drawn here comes from data the headset ALREADY streams for the 2D map — pose,
// npcPoses, doorStates — so the view is free on the headset side: no new
// messages, no new bandwidth, no Unity changes.
//
// It is a parallel (axonometric) projection, not a perspective camera: the room
// model has no heights, so the geometry is extruded from 2D footprints with
// assumed real-world heights, and a parallel projection keeps that honest —
// nothing gets bigger as it "approaches", because there is no real depth here to
// misrepresent. Drag to spin.
//
// Deliberately plain react-native-svg. Core ships with no dependencies of its
// own, and a WebGL renderer would pin it to the browser; the update rate is
// 5–10 Hz off the relay anyway, which no amount of GPU makes smoother.

// ── Heights ───────────────────────────────────────────────────────
// The room model is a floor plan: footprints and rotations, no third dimension.
// These are the assumed real-world heights, in FEET, that give the extrusion
// something believable to work with. Furniture is keyed by palette category.
const feetToCells = (ft: number) => (ft * FOOT_METERS) / CELL_METERS;

const WALL_FT = 8;
const DOOR_FT = 6.7;
const PERSON_FT = 5.9;

// Door parts, in cells (0.5 m each). A door's own footprint is only 2 × 0.5
// cells, so these are small on purpose — the frame has to read as trim around an
// opening, not as more furniture.
const JAMB = 0.18; // width of each side post
const LINTEL = 0.3; // depth of the header above the opening
const LEAF_T = 0.12; // the swinging panel is thinner than its frame
const KNOB_Z = 2; // knob height in cells = 1 m, about where a handle sits
const FURNITURE_FT: Record<string, number> = {
  Bed: 2,
  Sofa: 2.6,
  Table: 2.5,
  Chair: 3,
  Cabinet: 3,
  Closet: 6.5,
  Drawer: 2.5,
  "Bathroom Vanity": 2.8,
  Bathtub: 1.8,
  Toilet: 2.5,
  "File Cabinet": 4,
};

function objectHeightCells(o: PlacedObject): number {
  if (isWallKind(o.kind)) return feetToCells(WALL_FT);
  if (isDoorKind(o.kind)) return feetToCells(DOOR_FT);
  const cat = paletteById[o.kind]?.category;
  return feetToCells((cat ? FURNITURE_FT[cat] : undefined) ?? 2.5);
}

// ── Projection ────────────────────────────────────────────────────
// World axes match the 2D map exactly: x east, y SOUTH (screen-down), z up. Yaw
// spins the room about its own centre; PITCH is how flat the floor lies and
// Z_SCALE how tall the extrusion reads. Both are taste, not maths.
const PITCH = 0.5;
const Z_SCALE = 0.62;

type Pt = { sx: number; sy: number; depth: number };

function makeProjector(room: Room, yaw: number) {
  const cx = room.width / 2;
  const cy = room.height / 2;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // depth = the rotated y. Larger means nearer the viewer, so it doubles as the
  // painter's-algorithm sort key.
  return (x: number, y: number, z = 0): Pt => {
    const dx = x - cx;
    const dy = y - cy;
    const xr = dx * c - dy * s;
    const yr = dx * s + dy * c;
    return { sx: xr * CELL, sy: yr * CELL * PITCH - z * CELL * Z_SCALE, depth: yr };
  };
}

// Rotate a face normal the same way the projector rotates the world. A face is
// visible when its normal ends up pointing toward the viewer (+y after yaw).
function facesViewer(nx: number, ny: number, rotDeg: number, yaw: number) {
  const r = (rotDeg * Math.PI) / 180;
  const lx = nx * Math.cos(r) - ny * Math.sin(r);
  const ly = nx * Math.sin(r) + ny * Math.cos(r);
  return lx * Math.sin(yaw) + ly * Math.cos(yaw) > 0.001;
}

// Multiply a hex colour toward black — the whole lighting model. Top faces keep
// full value, side faces darken, so extruded boxes read as solid.
function shade(hex: string, k: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return `rgb(${r},${g},${b})`;
}

const pts = (ps: Pt[]) => ps.map((p) => `${p.sx.toFixed(2)},${p.sy.toFixed(2)}`).join(" ");

// The four footprint corners of an object, in world cells, already rotated.
function footprint(o: PlacedObject, wOverride?: number, hOverride?: number) {
  const w = (wOverride ?? o.w) / 2;
  const h = (hOverride ?? o.h) / 2;
  const r = (o.rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    [-w, -h],
    [w, -h],
    [w, h],
    [-w, h],
  ].map(([lx, ly]) => ({ x: o.x + lx * c - ly * s, y: o.y + lx * s + ly * c }));
}

type Drawable = { depth: number; node: React.ReactNode };

// Which spans of a wall are solid, in the wall's own local x (its length axis),
// once every door piercing it has been cut out. Returns [from, to] pairs.
//
// A door counts as piercing this wall when its centre sits within the wall's
// length and close enough across it — the same "is this door on that wall"
// question snapDoorToWall answers when a door is dropped, just asked at draw
// time so it also holds for rooms built before snapping, or shifted since.
function wallSegments(wall: PlacedObject, doors: PlacedObject[]): [number, number][] {
  const half = wall.w / 2;
  const r = (wall.rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);

  const cuts: [number, number][] = [];
  for (const d of doors) {
    const px = d.x - wall.x;
    const py = d.y - wall.y;
    const along = px * c + py * s;
    const across = -px * s + py * c;
    // Generous across-tolerance: a door is thicker than the wall it sits in and
    // may straddle it, so requiring dead-centre would miss real doorways.
    if (Math.abs(across) > wall.h / 2 + d.h) continue;
    const a = along - d.w / 2;
    const b = along + d.w / 2;
    if (b < -half || a > half) continue; // past either end
    cuts.push([Math.max(a, -half), Math.min(b, half)]);
  }
  if (!cuts.length) return [[-half, half]];

  cuts.sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let cursor = -half;
  for (const [a, b] of cuts) {
    if (a > cursor) out.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < half) out.push([cursor, half]);
  // Drop slivers: a hair of wall left beside an opening reads as a rendering
  // artefact, not as trim.
  return out.filter(([a, b]) => b - a > 0.06);
}

// ── Smoothing ─────────────────────────────────────────────────────
// Poses arrive off the relay at 5–10 Hz. Drawn as they land, a trainee teleports
// 15 cm at a time and doors snap between angles — the motion is real, the
// stepping is just the sample rate showing through. So every animation frame we
// ease what's drawn toward the latest sample instead of snapping to it.
//
// This is honest: it never invents a position ahead of the data (no
// extrapolation), it only takes longer to arrive at one the headset already
// reported. Roughly one sample-interval of extra latency, in exchange for
// continuous motion.
const EASE_RATE = 14; // higher = snappier and steppier; ~14 tracks a 10 Hz feed well
const SETTLED = 0.002; // below this, stop re-rendering and let the loop idle

// Shortest-arc angle easing, so a heading crossing 359°→1° doesn't spin the long
// way round.
function easeAngle(cur: number, target: number, k: number) {
  let d = ((target - cur + 540) % 360) - 180;
  return cur + d * k;
}

type Smooth = { x: number; y: number; facing: number; gun: number };

function useSmoothed(
  live: TrackMark[] | null,
  npcOverride: NpcPositions | undefined,
  doorAngles: DoorAngles | undefined
) {
  const marks = useRef(new Map<string, Smooth>());
  const npcs = useRef(new Map<string, Smooth>());
  const doors = useRef(new Map<string, number>());
  const [, tick] = useState(0);

  // Targets are read from props inside the loop via refs, so a new sample never
  // restarts the animation — it just moves the goalposts.
  const targets = useRef({ live, npcOverride, doorAngles });
  targets.current = { live, npcOverride, doorAngles };

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const step = (t: number) => {
      const dt = last ? Math.min((t - last) / 1000, 0.1) : 0.016;
      last = t;
      const k = 1 - Math.exp(-dt * EASE_RATE); // frame-rate independent easing
      let moved = false;

      const ease = (map: Map<string, Smooth>, id: string, tx: number, ty: number, tf: number, tg: number) => {
        const cur = map.get(id);
        if (!cur) {
          // First sight of something: start it where it actually is, rather than
          // sliding it in from wherever the last thing with this id was.
          map.set(id, { x: tx, y: ty, facing: tf, gun: tg });
          moved = true;
          return;
        }
        const nx = cur.x + (tx - cur.x) * k;
        const ny = cur.y + (ty - cur.y) * k;
        if (Math.abs(nx - cur.x) > SETTLED || Math.abs(ny - cur.y) > SETTLED) moved = true;
        const nf = easeAngle(cur.facing, tf, k);
        const ng = easeAngle(cur.gun, tg, k);
        if (Math.abs(nf - cur.facing) > SETTLED || Math.abs(ng - cur.gun) > SETTLED) moved = true;
        map.set(id, { x: nx, y: ny, facing: nf, gun: ng });
      };

      const cur = targets.current;
      const liveIds = new Set<string>();
      for (const h of cur.live ?? []) {
        liveIds.add(h.id);
        ease(marks.current, h.id, h.x, h.y, h.facing, h.gunAngle);
      }
      for (const id of [...marks.current.keys()]) if (!liveIds.has(id)) marks.current.delete(id);

      const npcIds = new Set<string>();
      for (const [id, p] of Object.entries(cur.npcOverride ?? {})) {
        npcIds.add(id);
        ease(npcs.current, id, p.x, p.y, p.facing, p.facing);
      }
      for (const id of [...npcs.current.keys()]) if (!npcIds.has(id)) npcs.current.delete(id);

      for (const [id, target] of Object.entries(cur.doorAngles ?? {})) {
        const c = doors.current.get(id);
        if (c === undefined) {
          doors.current.set(id, target);
          moved = true;
        } else {
          const n = c + (target - c) * k;
          if (Math.abs(n - c) > SETTLED) moved = true;
          doors.current.set(id, n);
        }
      }

      // Only re-render while something is actually in motion. Once everything has
      // settled the loop keeps spinning but React does nothing, so a room sitting
      // idle costs no reconciliation.
      if (moved) tick((v) => v + 1);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  return { marks: marks.current, npcs: npcs.current, doors: doors.current };
}

// ── Component ─────────────────────────────────────────────────────
export function RoomView3D({
  room,
  live,
  npcOverride,
  doorAngles,
}: {
  room: Room;
  live: TrackMark[] | null;
  npcOverride?: NpcPositions;
  doorAngles?: DoorAngles;
}) {
  // Yaw starts at 30° — straight-on reads as a flat 2D map, which defeats the
  // point of the view.
  const [yaw, setYaw] = useState((30 * Math.PI) / 180);
  const yawAtGrab = useRef(yaw);
  const smooth = useSmoothed(live, npcOverride, doorAngles);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 2,
        onPanResponderGrant: () => { yawAtGrab.current = yaw; },
        onPanResponderMove: (_e, g) => setYaw(yawAtGrab.current + g.dx * 0.01),
      }),
    [yaw]
  );

  const project = useMemo(() => makeProjector(room, yaw), [room, yaw]);
  const wallH = feetToCells(WALL_FT);

  // Fit the view box to the room's own bounding volume at this yaw, so spinning
  // reframes instead of letting the house wander off the edge.
  const viewBox = useMemo(() => {
    const corners: Pt[] = [];
    for (const x of [0, room.width]) {
      for (const y of [0, room.height]) {
        for (const z of [0, wallH]) corners.push(project(x, y, z));
      }
    }
    const xs = corners.map((p) => p.sx);
    const ys = corners.map((p) => p.sy);
    const pad = CELL;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    return `${minX} ${minY} ${Math.max(...xs) - minX + pad} ${Math.max(...ys) - minY + pad}`;
  }, [project, room.width, room.height, wallH]);

  // Depth of the room's centre. Anything nearer than this is between the viewer
  // and the action, which is what the cutaway fades.
  const centreDepth = project(room.width / 2, room.height / 2).depth;

  // ── Floor ───────────────────────────────────────────────────────
  const floor = useMemo(() => {
    const quad = [
      project(0, 0),
      project(room.width, 0),
      project(room.width, room.height),
      project(0, room.height),
    ];
    const step = Math.max(room.width, room.height) > 32 ? 2 : 1;
    const lines: React.ReactNode[] = [];
    for (let x = step; x < room.width; x += step) {
      const a = project(x, 0);
      const b = project(x, room.height);
      lines.push(<Line key={`gx${x}`} x1={a.sx} y1={a.sy} x2={b.sx} y2={b.sy} stroke={colors.snow} strokeWidth={0.5} opacity={0.07} />);
    }
    for (let y = step; y < room.height; y += step) {
      const a = project(0, y);
      const b = project(room.width, y);
      lines.push(<Line key={`gy${y}`} x1={a.sx} y1={a.sy} x2={b.sx} y2={b.sy} stroke={colors.snow} strokeWidth={0.5} opacity={0.07} />);
    }
    return (
      <G>
        <Polygon points={pts(quad)} fill={colors.surface} stroke={colors.hairline} strokeWidth={1} />
        {lines}
        <Polygon points={pts(quad)} fill="none" stroke={colors.snow} strokeWidth={1} opacity={0.18} />
      </G>
    );
  }, [project, room.width, room.height]);

  // ── Everything that sorts by depth ──────────────────────────────
  const items: Drawable[] = [];

  const pushBox = (p: {
    key: string;
    corners: { x: number; y: number }[];
    zTop: number;
    zBottom?: number; // for pieces that float, like a door's lintel
    fill: string;
    rotation: number;
    opacity?: number;
    extra?: React.ReactNode; // drawn with the box so it sorts as one thing
  }) => {
    const { key, corners, zTop, zBottom = 0, fill, rotation, opacity = 1, extra } = p;
    const base = corners.map((c) => project(c.x, c.y, zBottom));
    const top = corners.map((c) => project(c.x, c.y, zTop));
    const depth = Math.max(...base.map((p) => p.depth));
    // Local outward normals, in the same order footprint() emits corners.
    const normals: [number, number][] = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
    const faces: React.ReactNode[] = [];
    for (let i = 0; i < 4; i++) {
      const [nx, ny] = normals[i];
      if (!facesViewer(nx, ny, rotation, yaw)) continue;
      const j = (i + 1) % 4;
      faces.push(
        <Polygon
          key={`f${i}`}
          points={pts([base[i], base[j], top[j], top[i]])}
          fill={shade(fill, ny === 0 ? 0.62 : 0.78)}
          stroke={colors.canvas}
          strokeWidth={0.4}
        />
      );
    }
    items.push({
      depth,
      node: (
        <G key={key} opacity={opacity}>
          {faces}
          <Polygon points={pts(top)} fill={shade(fill, 1)} stroke={colors.canvas} strokeWidth={0.4} />
          {extra}
        </G>
      ),
    });
  };

  // A box positioned in an object's OWN frame — offset lx/ly along the object's
  // local axes, then carried through its rotation. Lets a door be built out of
  // jambs and a lintel without redoing the trigonometry for each piece.
  const localBox = (o: PlacedObject, lx: number, ly: number, w: number, h: number) => {
    const r = (o.rotation * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return footprint({ ...o, x: o.x + lx * c - ly * s, y: o.y + lx * s + ly * c, w, h });
  };

  const doors = room.objects.filter((o) => isDoorKind(o.kind));

  for (const o of room.objects) {
    const def = paletteById[o.kind];
    if (!def) continue;

    // The start zone is paint on the floor, not an object with height.
    if (def.render === "start") {
      const quad = footprint(o).map((c) => project(c.x, c.y, 0));
      items.push({
        depth: Math.min(...quad.map((p) => p.depth)) - 1000, // always under everything
        node: <Polygon key={o.id} points={pts(quad)} fill={colors.teal} opacity={0.18} stroke={colors.teal} strokeWidth={1.5} />,
      });
      continue;
    }

    // Targets are drawn from their LIVE position when the headset is reporting
    // one, so they walk around; otherwise from where they were placed.
    if (def.render === "npc") continue; // handled below, with the live override

    if (isDoorKind(o.kind)) {
      // A door is a FRAME plus a LEAF, not one slab: without the two jambs and
      // the lintel over them, a door at any angle just reads as a stray panel,
      // and an open one reads as nothing at all.
      const doorZ = feetToCells(DOOR_FT);
      const frameFill = shade(def.fill, 0.85);
      pushBox({ key: `${o.id}-j0`, corners: localBox(o, -(o.w / 2 - JAMB / 2), 0, JAMB, o.h), zTop: doorZ, fill: frameFill, rotation: o.rotation });
      pushBox({ key: `${o.id}-j1`, corners: localBox(o, o.w / 2 - JAMB / 2, 0, JAMB, o.h), zTop: doorZ, fill: frameFill, rotation: o.rotation });
      pushBox({
        key: `${o.id}-lintel`,
        corners: localBox(o, 0, 0, o.w, o.h),
        zBottom: doorZ,
        zTop: doorZ + LINTEL,
        fill: frameFill,
        rotation: o.rotation,
      });

      // An open frame is exactly that — a threshold with nothing hanging in it.
      if (o.kind === "Open Door Frame") continue;

      // Hinged at the +x jamb, swinging clockwise — the same handedness the 2D
      // map uses, so the two views never disagree about which way a door went.
      const openDeg = smooth.doors.get(o.id) ?? doorAngles?.[o.id] ?? 0;
      const a = (openDeg * Math.PI) / 180;
      const r = (o.rotation * Math.PI) / 180;
      const leafLen = Math.max(0.4, o.w - JAMB * 2);
      const hx = o.x + (o.w / 2 - JAMB) * Math.cos(r);
      const hy = o.y + (o.w / 2 - JAMB) * Math.sin(r);
      // Leaf direction from the hinge. Shut (a = 0) it lies along the door's
      // local -x, back across the opening; opening swings it CLOCKWISE on this
      // y-down world, the same handedness the map uses and the same as the Unity
      // yaw delta the headset reports. That makes the local direction
      // (-cos a, -sin a) — i.e. PI + a. Writing PI - a mirrors the swing in y and
      // sends the door the wrong way round, which is exactly what it did.
      const dir = r + Math.PI + a;
      const leafDeg = o.rotation + 180 + openDeg;
      const leaf: PlacedObject = {
        ...o,
        x: hx + (leafLen / 2) * Math.cos(dir),
        y: hy + (leafLen / 2) * Math.sin(dir),
        rotation: leafDeg,
      };
      // The knob is the cheapest possible "this is a door" signal, and being on
      // the free edge it also shows at a glance which end is hinged.
      const kd = leafLen * 0.82;
      const knob = project(hx + kd * Math.cos(dir), hy + kd * Math.sin(dir), KNOB_Z);
      const open = Math.abs(openDeg) > 3;
      pushBox({
        key: o.id,
        corners: footprint(leaf, leafLen, LEAF_T),
        zTop: doorZ,
        // Open goes teal, matching the map's one piece of door colour language.
        fill: open ? colors.teal : def.fill,
        rotation: leafDeg,
        extra: <Circle cx={knob.sx} cy={knob.sy} r={2.4} fill={colors.snow} opacity={0.9} />,
      });
      continue;
    }

    const isWall = isWallKind(o.kind);
    const corners = footprint(o);
    const depth = Math.max(...corners.map((c) => project(c.x, c.y).depth));
    // THE CUTAWAY: walls between the viewer and the middle of the room drop to a
    // ghost so you can see the clear happening behind them. Only walls — fading
    // furniture would just look like a rendering bug.
    const ghosted = isWall && depth > centreDepth;

    // A wall is drawn in SEGMENTS, with a gap wherever a door pierces it.
    //
    // Not cosmetic: a wall's sort key is its NEAREST corner, so a long wall
    // outranks a door sitting in its middle and gets painted last — straight
    // over the door. Doors in ghosted near walls still showed through the
    // translucency, which is why only doors in far, opaque walls went missing.
    // Cutting the opening fixes the ordering and gives an open door something
    // to be open THROUGH.
    if (isWall) {
      for (const [i, seg] of wallSegments(o, doors).entries()) {
        pushBox({
          key: `${o.id}-${i}`,
          corners: localBox(o, (seg[0] + seg[1]) / 2, 0, seg[1] - seg[0], o.h),
          zTop: objectHeightCells(o),
          fill: def.fill,
          rotation: o.rotation,
          opacity: ghosted ? 0.16 : 1,
        });
      }
      continue;
    }

    pushBox({
      key: o.id,
      corners,
      zTop: objectHeightCells(o),
      fill: def.fill,
      rotation: o.rotation,
      opacity: ghosted ? 0.16 : 1,
    });
  }

  // ── Targets ─────────────────────────────────────────────────────
  for (const o of room.objects) {
    if (!isNpcKind(o.kind)) continue;
    const p = npcOverride?.[o.id];
    const s = smooth.npcs.get(o.id);
    const x = s?.x ?? p?.x ?? o.x;
    const y = s?.y ?? p?.y ?? o.y;
    const dead = p ? p.alive === false : false;
    const det = !!p?.det;
    const fill = det && !dead ? colors.snow : behaviorColor((p?.beh as never) ?? o.behavior);
    items.push({
      depth: project(x, y).depth,
      node: <Figure key={o.id} at={project(x, y)} fill={fill} dead={dead} firing={!!p?.firing} detained={det} />,
    });
  }

  // ── Trainees ────────────────────────────────────────────────────
  for (const h of live ?? []) {
    const s = smooth.marks.get(h.id);
    const hx = s?.x ?? h.x;
    const hy = s?.y ?? h.y;
    const facing = s?.facing ?? h.facing;
    const gunAngle = s?.gun ?? h.gunAngle;
    const g = project(hx, hy);
    // Facing wedge and gun line lie ON the floor, where they read as direction
    // rather than as another object standing up in the room.
    const wedge = [project(hx, hy), ...[-38, 38].map((d) => {
      const a = ((facing + d) * Math.PI) / 180;
      return project(hx + Math.cos(a) * 2.4, hy + Math.sin(a) * 2.4);
    })];
    const ga = (gunAngle * Math.PI) / 180;
    const gunEnd = project(hx + Math.cos(ga) * 1.9, hy + Math.sin(ga) * 1.9);
    items.push({
      depth: g.depth,
      node: (
        <G key={h.id}>
          {/* A floor ring under the trainee: in a room full of standing figures
              the one you're actually following has to be findable at a glance. */}
          <Ellipse cx={g.sx} cy={g.sy} rx={CELL * 0.62} ry={CELL * 0.62 * PITCH} fill="none" stroke={colors.teal} strokeWidth={1.5} opacity={0.7} />
          <Polygon points={pts(wedge)} fill={colors.teal} opacity={0.14} />
          <Line
            x1={g.sx}
            y1={g.sy}
            x2={gunEnd.sx}
            y2={gunEnd.sy}
            stroke={h.firing ? colors.danger : colors.sky}
            strokeWidth={h.firing ? 3 : 2}
            strokeLinecap="round"
          />
          <Figure at={g} fill={colors.teal} dead={false} firing={!!h.firing} detained={false} />
        </G>
      ),
    });
  }

  items.sort((a, b) => a.depth - b.depth);

  // Same box as the 2D canvas — width-driven with the room's own aspect — so
  // switching views doesn't reflow the page. The projected content is letterboxed
  // inside it rather than driving its shape.
  return (
    <View
      {...pan.panHandlers}
      style={[
        {
          width: "100%",
          aspectRatio: room.width / room.height,
          backgroundColor: colors.canvas,
          borderRadius: 12,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: colors.hairline,
        },
        { userSelect: "none" } as any,
      ]}
    >
      <Svg width="100%" height="100%" viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
        {floor}
        {items.map((it) => it.node)}
      </Svg>
    </View>
  );
}

// A person: a ground shadow, a body, and a head. Billboarded — drawn in screen
// space at the projected ground point — because a rotating cardboard cut-out is
// worse than one that simply always faces you.
function Figure({
  at,
  fill,
  dead,
  firing,
  detained,
}: {
  at: Pt;
  fill: string;
  dead: boolean;
  firing: boolean;
  detained: boolean;
}) {
  // Proportions come from the floor scale, so a person measures the same as the
  // room around them: CELL units span 0.5 m across the ground, and the vertical
  // is squashed by Z_SCALE like everything else that stands up.
  const h = feetToCells(PERSON_FT) * CELL * Z_SCALE;
  const bodyHalf = CELL * 0.34; // ~0.35 m shoulders
  const headR = CELL * 0.26;
  // Rings sit ON the floor, so they take the ground plane's foreshortening —
  // a true circle here would read as a hoop standing in the air.
  const ring = (stroke: string, k = 1) => (
    <Ellipse cx={at.sx} cy={at.sy} rx={bodyHalf * 1.6 * k} ry={bodyHalf * 1.6 * k * PITCH} fill="none" stroke={stroke} strokeWidth={2} opacity={0.95} />
  );

  // The dead lie down: a floor X where they fell, so a cleared target reads as
  // cleared instead of simply vanishing.
  if (dead) {
    const r = bodyHalf * 1.5;
    return (
      <G opacity={0.8}>
        <Ellipse cx={at.sx} cy={at.sy} rx={r} ry={r * PITCH} fill={colors.canvas} opacity={0.5} />
        <Line x1={at.sx - r} y1={at.sy - r * PITCH} x2={at.sx + r} y2={at.sy + r * PITCH} stroke={colors.danger} strokeWidth={2.2} strokeLinecap="round" />
        <Line x1={at.sx - r} y1={at.sy + r * PITCH} x2={at.sx + r} y2={at.sy - r * PITCH} stroke={colors.danger} strokeWidth={2.2} strokeLinecap="round" />
      </G>
    );
  }

  const topY = at.sy - h;
  return (
    <G>
      <Ellipse cx={at.sx} cy={at.sy} rx={bodyHalf * 1.15} ry={bodyHalf * 1.15 * PITCH} fill={colors.canvas} opacity={0.55} />
      {/* Captured: the white ring that means custody on the 2D map, kept here so
          the two views speak the same language. */}
      {detained && ring(colors.snow)}
      <Path
        d={`M ${at.sx - bodyHalf} ${at.sy} L ${at.sx - bodyHalf} ${topY + headR * 2} L ${at.sx + bodyHalf} ${topY + headR * 2} L ${at.sx + bodyHalf} ${at.sy} Z`}
        fill={fill}
        stroke={colors.canvas}
        strokeWidth={0.6}
      />
      <Circle cx={at.sx} cy={topY + headR} r={headR} fill={fill} stroke={colors.canvas} strokeWidth={0.6} />
      {/* Muzzle flash reads better as a ring around the torso than around the
          feet — it's the shooter you want to spot, not the floor they're on. */}
      {firing && (
        <Circle cx={at.sx} cy={topY + h * 0.5} r={bodyHalf * 1.9} fill="none" stroke={colors.danger} strokeWidth={2} opacity={0.9} />
      )}
    </G>
  );
}
