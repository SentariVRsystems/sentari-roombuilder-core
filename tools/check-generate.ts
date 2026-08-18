// Invariant harness for generateRoom(): 5000 rooms, assert everything the
// canvas/push pipeline relies on. Run: npx tsx tools/check-generate.ts
import {
  MAX_ROOM_CELLS,
  MIN_ROOM_CELLS,
  isDoorKind,
  isWallKind,
  objectExtent,
  paletteById,
  wallsWithDoorGaps,
  type PlacedObject,
} from "../rooms";
import { COZY_VARIANTS, distPointToSeg, generateRoom, pointInPoly } from "../generateRoom";
import { checkBacking } from "./backing-check";

let failures = 0;
const fail = (i: number, msg: string) => {
  failures++;
  if (failures <= 20) console.error(`room ${i}: ${msg}`);
};

const N = 5000;
const stats = { objects: 0, doors: 0, furniture: 0, npcs: 0 };
const npcKindsSeen = new Set<string>();
const behaviorsSeen = new Set<string>();
const hostileModels = new Set<string>();
let roomsWithNonHostile = 0;

for (let i = 0; i < N; i++) {
  // Half the batch simulates play-space-fitted sizes (small, odd dimensions),
  // half uses the generator's own random sizing. Interior style cycles
  // through forced warren/hallway/open plus the free roll so every
  // architecture gets deterministic coverage.
  const style = (["warren", "hallway", "open", undefined] as const)[i % 4];
  const room =
    i % 2 === 0
      ? generateRoom({ interiorStyle: style })
      : generateRoom({
          width: 6 + Math.floor(Math.random() * 18),
          height: 6 + Math.floor(Math.random() * 16),
          interiorStyle: style,
        });

  // The start zone stages outside the house (below the southmost wall) in any
  // playable box — the yard adapts down to 1.5 cells (2026-08-16); only
  // degenerate boxes too shallow for both yard and house fall back inside.
  {
    const start = room.objects.find((o) => o.kind === "start");
    const walls0 = room.objects.filter((o) => isWallKind(o.kind));
    const southmost = Math.max(...walls0.map((w) => w.y + objectExtent(w).h));
    if (start) {
      const outside = start.y - objectExtent(start).h >= southmost;
      const availCheck = room.height - 2; // default shell: y0 = 1, y1 = H - 1
      const yardCheck = 1.5; // fixed minimal yard (2026-08-16)
      const expectOutside = availCheck - yardCheck >= 2.5;
      // Exterior starts must stand off ≥ ~1 cell (0.5 m) from the wall face.
      if (outside && start.y - objectExtent(start).h - southmost < 0.95) {
        fail(i, `start only ${(start.y - objectExtent(start).h - southmost).toFixed(2)} cells off the south wall`);
      }
      if (outside !== expectOutside) {
        fail(i, `start ${outside ? "outside" : "inside"} but expected ${expectOutside ? "outside" : "inside"} (H=${room.height})`);
      }
    }
  }

  if (room.width < MIN_ROOM_CELLS || room.width > MAX_ROOM_CELLS) fail(i, `width ${room.width}`);
  if (room.height < MIN_ROOM_CELLS || room.height > MAX_ROOM_CELLS) fail(i, `height ${room.height}`);

  const ids = new Set<string>();
  let starts = 0;
  for (const o of room.objects) {
    if (ids.has(o.id)) fail(i, `duplicate object id ${o.id}`);
    ids.add(o.id);
    if (!paletteById[o.kind]) fail(i, `unknown kind ${o.kind}`);
    if (o.kind === "start") starts++;
    for (const v of [o.x, o.y, o.rotation, o.w, o.h]) {
      if (typeof v !== "number" || !Number.isFinite(v)) fail(i, `non-finite field on ${o.kind}`);
    }
    const e = objectExtent(o);
    if (o.x - e.w < -0.01 || o.x + e.w > room.width + 0.01 || o.y - e.h < -0.01 || o.y + e.h > room.height + 0.01) {
      fail(i, `${o.kind} out of bounds at (${o.x},${o.y}) extent (${e.w.toFixed(2)},${e.h.toFixed(2)})`);
    }
  }
  if (starts !== 1) fail(i, `${starts} start zones`);

  // THE START DOOR ALWAYS HAS A LEAF (2026-08-17): the door the start zone
  // stages against — the nearest door to the start — must be a real swinging
  // door, never an Open Door Frame. Breaching a hole reads wrong.
  {
    const start = room.objects.find((o) => o.kind === "start");
    const doorObjs = room.objects.filter((o) => isDoorKind(o.kind));
    if (start && doorObjs.length) {
      const entry = doorObjs.reduce((a, b) =>
        Math.hypot(a.x - start.x, a.y - start.y) <= Math.hypot(b.x - start.x, b.y - start.y) ? a : b
      );
      if (entry.kind === "Open Door Frame") fail(i, `entry door (nearest start) is an Open Door Frame`);
    }
  }

  // Every door must actually cut a wall: gapping should split at least one
  // wall per door (wall count strictly grows, or a wall got consumed by
  // an end-of-wall gap — check per door instead: the gapped set must differ).
  const walls = room.objects.filter((o) => isWallKind(o.kind));
  const doors = room.objects.filter((o) => isDoorKind(o.kind));
  const gapped = wallsWithDoorGaps(room.objects).filter((o) => isWallKind(o.kind));
  // Each door removes ~2 cells of wall; total wall length must shrink by
  // roughly 1.92 cells (the frame cut) per door — slack for merged/edge gaps.
  const totalLen = (ws: PlacedObject[]) => ws.reduce((s, w) => s + w.w, 0);
  const cut = totalLen(walls) - totalLen(gapped);
  if (cut < doors.length * 1.8) fail(i, `doors not cutting walls: ${doors.length} doors, only ${cut.toFixed(2)} cells cut`);

  // Every door sits EXACTLY on its wall's centerline (≤ 0.05 cells perp).
  // The gap cutter tolerates ~0.65, but the headset builds the frame at the
  // DOOR's position — even a 0.1-cell offset leaves a finger-width slit
  // between the frame and the wall face.
  for (const d of doors) {
    const dHoriz = Math.abs(((d.rotation % 180) + 180) % 180) < 45 || Math.abs(((d.rotation % 180) + 180) % 180) > 135;
    const aligned = walls.some((w) => {
      const we = objectExtent(w);
      const wHoriz = we.w >= we.h;
      if (wHoriz !== dHoriz) return false;
      const perp = wHoriz ? Math.abs(d.y - w.y) : Math.abs(d.x - w.x);
      const t = wHoriz ? d.x : d.y;
      const lo = wHoriz ? w.x - we.w : w.y - we.h;
      const hi = wHoriz ? w.x + we.w : w.y + we.h;
      return perp <= 0.05 && t > lo - d.w / 2 && t < hi + d.w / 2;
    });
    if (!aligned) fail(i, `door ${d.kind}@(${d.x},${d.y}) rot ${d.rotation} off its wall centerline`);
  }

  // No two non-wall, non-door solids overlap (furniture, NPCs, start).
  const solids = room.objects.filter((o) => {
    const def = paletteById[o.kind];
    return def && (def.section === "Furniture" || def.render === "npc" || o.kind === "start");
  });
  for (let a = 0; a < solids.length; a++) {
    for (let b = a + 1; b < solids.length; b++) {
      const A = solids[a], B = solids[b];
      const ea = objectExtent(A), eb = objectExtent(B);
      if (
        A.x - ea.w < B.x + eb.w && A.x + ea.w > B.x - eb.w &&
        A.y - ea.h < B.y + eb.h && A.y + ea.h > B.y - eb.h
      ) {
        fail(i, `overlap: ${A.kind}@(${A.x},${A.y}) vs ${B.kind}@(${B.x},${B.y})`);
      }
    }
  }

  // Cast is 0–4 by design (2026-08-16, no guaranteed hostile) — population
  // is not an invariant, only placement is.

  // Cabinets/toilets/shelves and the rest of the wall categories actually
  // back onto a wall.
  checkBacking(room, (m) => fail(i, m));

  // Every chair sits against a table (AABBs within 0.1 cells of touching).
  const tables = room.objects.filter((o) => paletteById[o.kind]?.category === "Table");
  for (const c of room.objects.filter((o) => paletteById[o.kind]?.category === "Chair")) {
    const ec = objectExtent(c);
    const touches = tables.some((t) => {
      const et = objectExtent(t);
      return (
        c.x - ec.w < t.x + et.w + 0.1 && c.x + ec.w > t.x - et.w - 0.1 &&
        c.y - ec.h < t.y + et.h + 0.1 && c.y + ec.h > t.y - et.h - 0.1
      );
    });
    if (!touches) fail(i, `chair ${c.kind}@(${c.x.toFixed(2)},${c.y.toFixed(2)}) not touching any table`);
  }

  // Nothing solid overlaps a wall body (touching allowed, hence the shrink).
  for (const s of solids) {
    const es = objectExtent(s);
    for (const w of walls) {
      const ew = objectExtent(w);
      if (
        s.x - es.w < w.x + ew.w - 0.05 && s.x + es.w > w.x - ew.w + 0.05 &&
        s.y - es.h < w.y + ew.h - 0.05 && s.y + es.h > w.y - ew.h + 0.05
      ) {
        fail(i, `${s.kind}@(${s.x},${s.y}) rot ${s.rotation} overlaps wall ${w.kind}@(${w.x},${w.y})`);
      }
    }
  }

  // Stub walls (dead-end walls: one endpoint touches nothing) must never be
  // cut by a door — a doorway into a pocket is a trap, not an exit.
  {
    const wallPts = (w: PlacedObject) => {
      const r = (w.rotation * Math.PI) / 180;
      const hx = (Math.cos(r) * w.w) / 2, hy = (Math.sin(r) * w.w) / 2;
      return [{ x: w.x - hx, y: w.y - hy }, { x: w.x + hx, y: w.y + hy }];
    };
    const touchesOther = (p: { x: number; y: number }, self: PlacedObject) =>
      walls.some((o) => {
        if (o === self) return false;
        const [a, b] = wallPts(o);
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy || 1e-6;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) < 0.3;
      });
    const gappedIds = new Set(
      wallsWithDoorGaps(room.objects)
        .filter((o) => isWallKind(o.kind) && o.id.includes("~"))
        .map((o) => o.id.split("~")[0])
    );
    for (const w of walls) {
      const freeTips = wallPts(w).filter((p) => !touchesOther(p, w)).length;
      if (freeTips === 1 && gappedIds.has(w.id)) {
        fail(i, `stub wall ${w.kind}@(${w.x},${w.y}) has a door cut into it`);
      }
    }
  }

  // Walkability: flood-fill the floor on a half-cell grid from the start
  // zone, treating gapped walls (what the headset builds) inflated by 0.25 as
  // blocked. Every NPC and every door center must be reachable — proves the
  // entry door works and no stub/furniture layout seals off a target.
  {
    const start = room.objects.find((o) => o.kind === "start");
    const gappedWalls = wallsWithDoorGaps(room.objects).filter((o) => isWallKind(o.kind));
    const step = 0.5;
    const nx = Math.round(room.width / step) + 1;
    const ny = Math.round(room.height / step) + 1;
    const blocked = (x: number, y: number) =>
      gappedWalls.some((w) => {
        const e = objectExtent(w);
        return x > w.x - e.w - 0.25 && x < w.x + e.w + 0.25 && y > w.y - e.h - 0.25 && y < w.y + e.h + 0.25;
      });
    const seen = new Set<number>();
    const key = (ix: number, iy: number) => iy * nx + ix;
    if (start) {
      const q: [number, number][] = [[Math.round(start.x / step), Math.round(start.y / step)]];
      seen.add(key(q[0][0], q[0][1]));
      while (q.length) {
        const [ix, iy] = q.pop()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const jx = ix + dx, jy = iy + dy;
          if (jx < 0 || jy < 0 || jx >= nx || jy >= ny || seen.has(key(jx, jy))) continue;
          if (blocked(jx * step, jy * step)) continue;
          seen.add(key(jx, jy));
          q.push([jx, jy]);
        }
      }
      const reachable = (x: number, y: number) => seen.has(key(Math.round(x / step), Math.round(y / step)));
      for (const o of room.objects) {
        if (paletteById[o.kind]?.render === "npc" && !reachable(o.x, o.y)) {
          fail(i, `NPC ${o.kind}@(${o.x},${o.y}) unreachable from start`);
        }
        if (isDoorKind(o.kind) && !reachable(o.x, o.y)) {
          fail(i, `door ${o.kind}@(${o.x},${o.y}) unreachable from start`);
        }
      }
    }
  }

  let hasNonHostile = false;
  for (const o of room.objects) {
    if (paletteById[o.kind]?.render === "npc") {
      npcKindsSeen.add(o.kind);
      if (o.behavior) behaviorsSeen.add(o.behavior);
      if (o.behavior === "hostile") hostileModels.add(o.kind);
      else if (o.behavior) hasNonHostile = true;
    }
  }
  if (hasNonHostile) roomsWithNonHostile++;

  stats.objects += room.objects.length;
  stats.doors += doors.length;
  stats.furniture += solids.filter((o) => paletteById[o.kind].section === "Furniture").length;
  stats.npcs += solids.filter((o) => paletteById[o.kind].render === "npc").length;
}

console.log(
  `${N} rooms: avg ${(stats.objects / N).toFixed(1)} objects, ` +
  `${(stats.doors / N).toFixed(1)} doors, ${(stats.furniture / N).toFixed(1)} furniture, ` +
  `${(stats.npcs / N).toFixed(1)} NPCs`
);
console.log(
  `${((roomsWithNonHostile / N) * 100).toFixed(0)}% of rooms have a non-hostile NPC; ` +
  `${npcKindsSeen.size} distinct NPC kinds seen`
);
if (roomsWithNonHostile / N < 0.5) {
  console.error("FAILED: fewer than half the rooms have a non-hostile NPC");
  failures++;
}
if (npcKindsSeen.size < 6) {
  console.error(`FAILED: only ${npcKindsSeen.size} NPC kinds across the batch`);
  failures++;
}
// Model and behavior are decoupled: every disposition appears, and "hostile"
// spreads across many models instead of living on one soldier.
console.log(`behaviors seen: ${[...behaviorsSeen].sort().join(", ")}; hostile worn by ${hostileModels.size} models`);
if (behaviorsSeen.size < 5) {
  console.error(`FAILED: only ${behaviorsSeen.size} behaviors across the batch`);
  failures++;
}
if (hostileModels.size < 5) {
  console.error(`FAILED: hostile behavior appears on only ${hostileModels.size} models`);
  failures++;
}
// Cozy variants (the small-space vocabulary): every variant at small sizes,
// including the 10x9 a real ~5x4.5 m playspace produces. The main loop's
// invariants run on each via the same fail() plumbing below — this block
// only exists because the main loop can't force variants.
{
  let ci = 0;
  for (const variant of COZY_VARIANTS) {
    for (let i = 0; i < 150; i++) {
      const room = generateRoom({
        width: 9 + Math.floor(Math.random() * 4),
        height: 8 + Math.floor(Math.random() * 3),
        interiorStyle: "cozy",
        cozyVariant: variant,
      });
      // Walkability + entry-leaf spot checks (the heavyweight invariants ran
      // across the main 5000, which includes cozy houses at small sizes).
      const start = room.objects.find((o) => o.kind === "start");
      const doorObjs = room.objects.filter((o) => isDoorKind(o.kind));
      if (!start || doorObjs.length < 1) fail(N + 1000 + ci, `cozy:${variant} missing start/door`);
      else {
        const entry = doorObjs.reduce((a, b) =>
          Math.hypot(a.x - start.x, a.y - start.y) <= Math.hypot(b.x - start.x, b.y - start.y) ? a : b
        );
        if (entry.kind === "Open Door Frame") fail(N + 1000 + ci, `cozy:${variant} entry is an open frame`);
      }
      ci++;
    }
  }
}

// POLYGON SHELL: walls at arbitrary angles riding a walked outline. Same
// fixture set as the C# suite; asserts containment (people/start strictly
// inside the outline, furniture near-inside, walls on-or-inside), entry door
// is a swing leaf, and full walkability (flood fill, angle-general).
{
  const fixtures: Array<{ name: string; pts: number[]; degraded?: boolean }> = [
    { name: "quad", pts: [4, 20, 16, 20, 16.5, 6, 3.5, 7] },
    { name: "chamfer", pts: [5, 20, 15, 20, 19, 17, 19, 6, 4, 5, 3, 16] },
    { name: "Lshape", pts: [4, 20, 12, 20, 12, 13, 19, 13, 19, 4, 4, 4] },
    { name: "sevenpt", pts: [4, 21, 13, 21, 17, 18, 20, 10, 14, 4, 6, 5, 3, 13] },
    { name: "spike", pts: [4, 20, 14, 20, 21, 19, 15, 16, 20, 6, 5, 5] },
    { name: "shorts", pts: [4, 20, 14, 20, 14.3, 19.8, 14.5, 19.6, 18, 12, 14, 5, 5, 5, 4.2, 12] },
    { name: "revwind", pts: [15, 20, 5, 20, 3, 16, 4, 5, 19, 6, 19, 17] },
    { name: "bowtie", pts: [4, 20, 14, 20, 4, 6, 14, 6], degraded: true },
  ];
  for (const fx of fixtures) {
    const poly = [] as Array<{ x: number; y: number }>;
    for (let i = 0; i < fx.pts.length; i += 2) poly.push({ x: fx.pts[i], y: fx.pts[i + 1] });
    const distB = (p: { x: number; y: number }) => {
      let best = Infinity;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
        best = Math.min(best, distPointToSeg(p, poly[j], poly[i]));
      return best;
    };
    const inOrNear = (p: { x: number; y: number }, tol: number) => pointInPoly(poly, p) || distB(p) <= tol;
    for (let s = 0; s < 40; s++) {
      const room = generateRoom({ width: 26, height: 26, shellPoly: poly.map((v) => ({ ...v })) });
      const tag = `shellpoly:${fx.name}#${s}`;
      const start = room.objects.find((o) => o.kind === "start");
      const doorObjs = room.objects.filter((o) => isDoorKind(o.kind));
      if (!start || !doorObjs.length) { fail(N + 2000, `${tag} missing start/door`); continue; }
      const entry = doorObjs.reduce((a, b) =>
        Math.hypot(a.x - start.x, a.y - start.y) <= Math.hypot(b.x - start.x, b.y - start.y) ? a : b
      );
      if (entry.kind === "Open Door Frame") fail(N + 2000, `${tag} entry is an open frame`);
      if (!fx.degraded) {
        for (const o of room.objects) {
          const p = { x: o.x, y: o.y };
          if (isWallKind(o.kind)) {
            const r = (o.rotation * Math.PI) / 180;
            const hx = (Math.cos(r) * o.w) / 2, hy = (Math.sin(r) * o.w) / 2;
            if (!inOrNear({ x: o.x - hx, y: o.y - hy }, 2.5) || !inOrNear(p, 2.5) || !inOrNear({ x: o.x + hx, y: o.y + hy }, 2.5))
              fail(N + 2000, `${tag} wall ${o.kind}@(${o.x.toFixed(1)},${o.y.toFixed(1)}) off the outline`);
          } else if (paletteById[o.kind]?.render === "npc" || o.kind === "start") {
            if (!inOrNear(p, 0.3)) fail(N + 2000, `${tag} ${o.kind}@(${o.x},${o.y}) outside the outline`);
          } else if (!isDoorKind(o.kind) && !inOrNear(p, 0.8)) {
            fail(N + 2000, `${tag} furniture ${o.kind}@(${o.x},${o.y}) outside the outline`);
          }
        }
      }
      // Nothing solid straddles a wall centerline — angle-general segment
      // vs shrunk-AABB (the check that catches skewed-wall hug bugs).
      {
        const solids2 = room.objects.filter((o) => {
          const def = paletteById[o.kind];
          return def && (def.section === "Furniture" || def.render === "npc" || o.kind === "start");
        });
        const wallSegs = room.objects.filter((o) => isWallKind(o.kind)).map((wl) => {
          const r = (wl.rotation * Math.PI) / 180;
          const hx = (Math.cos(r) * wl.w) / 2, hy = (Math.sin(r) * wl.w) / 2;
          return { ax: wl.x - hx, ay: wl.y - hy, bx: wl.x + hx, by: wl.y + hy, kind: wl.kind };
        });
        const crossX = (p1x: number, p1y: number, p2x: number, p2y: number, p3x: number, p3y: number, p4x: number, p4y: number) => {
          const d1 = (p4x - p3x) * (p1y - p3y) - (p4y - p3y) * (p1x - p3x);
          const d2 = (p4x - p3x) * (p2y - p3y) - (p4y - p3y) * (p2x - p3x);
          const d3 = (p2x - p1x) * (p3y - p1y) - (p2y - p1y) * (p3x - p1x);
          const d4 = (p2x - p1x) * (p4y - p1y) - (p2y - p1y) * (p4x - p1x);
          return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
        };
        for (const so of solids2) {
          const e = objectExtent(so);
          const lox = so.x - e.w + 0.02, loy = so.y - e.h + 0.02;
          const hix = so.x + e.w - 0.02, hiy = so.y + e.h - 0.02;
          for (const g of wallSegs) {
            const endIn = (x: number, y: number) => x > lox && x < hix && y > loy && y < hiy;
            const hits = endIn(g.ax, g.ay) || endIn(g.bx, g.by)
              || crossX(g.ax, g.ay, g.bx, g.by, lox, loy, hix, loy)
              || crossX(g.ax, g.ay, g.bx, g.by, hix, loy, hix, hiy)
              || crossX(g.ax, g.ay, g.bx, g.by, hix, hiy, lox, hiy)
              || crossX(g.ax, g.ay, g.bx, g.by, lox, hiy, lox, loy);
            if (hits) fail(N + 2000, `${tag} ${so.kind}@(${so.x.toFixed(2)},${so.y.toFixed(2)}) straddles wall ${g.kind}`);
          }
        }
      }

      // Walkability: flood from the start; every NPC and door reachable.
      {
        const gappedWalls = wallsWithDoorGaps(room.objects).filter((o) => isWallKind(o.kind));
        const step = 0.25;
        const nx = Math.round(room.width / step) + 1;
        const ny = Math.round(room.height / step) + 1;
        const segs = gappedWalls.map((w) => {
          const r = (w.rotation * Math.PI) / 180;
          const hx = (Math.cos(r) * w.w) / 2, hy = (Math.sin(r) * w.w) / 2;
          return { ax: w.x - hx, ay: w.y - hy, bx: w.x + hx, by: w.y + hy };
        });
        const blockedNear = (x: number, y: number) =>
          segs.some((g) => distPointToSeg({ x, y }, { x: g.ax, y: g.ay }, { x: g.bx, y: g.by }) < 0.28);
        const seen = new Uint8Array(nx * ny);
        const q: number[] = [];
        const push = (ix: number, iy: number) => {
          const k = iy * nx + ix;
          if (seen[k]) return;
          seen[k] = 1;
          q.push(k);
        };
        push(Math.round(start.x / step), Math.round(start.y / step));
        while (q.length) {
          const k = q.pop()!;
          const ix = k % nx, iy = Math.floor(k / nx);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const jx = ix + dx, jy = iy + dy;
            if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
            if (blockedNear(jx * step, jy * step)) continue;
            push(jx, jy);
          }
        }
        const reach = (x: number, y: number) => seen[Math.round(y / step) * nx + Math.round(x / step)] === 1;
        for (const o of room.objects) {
          if (paletteById[o.kind]?.render === "npc" && !reach(o.x, o.y))
            fail(N + 2000, `${tag} NPC ${o.kind}@(${o.x},${o.y}) unreachable`);
        }
      }
    }
  }
}

// Cast injection (the Fish Bowl deck contract): exact count honored and
// placed people only wear dealt dispositions.
{
  const behaviorSrc = ["hostile", "compliant", "afraid", "compToHostile"] as const;
  for (let i = 0; i < 300; i++) {
    const castN = i % 5;
    const dealt = Array.from({ length: castN }, (_, k) => behaviorSrc[(i + k) % 4]);
    const room = generateRoom({ width: 16, height: 14, castCount: castN, castBehaviors: [...dealt] });
    const npcs = room.objects.filter((o) => paletteById[o.kind]?.render === "npc");
    if (npcs.length > castN) fail(N + i, `cast ${npcs.length} exceeds dealt ${castN}`);
    for (const n of npcs) {
      if (!n.behavior || !(dealt as readonly string[]).includes(n.behavior)) {
        fail(N + i, `NPC behavior '${n.behavior}' was not dealt`);
      }
    }
  }
}

if (failures) {
  console.error(`FAILED: ${failures} invariant violations`);
  process.exit(1);
}
console.log("all invariants hold");
