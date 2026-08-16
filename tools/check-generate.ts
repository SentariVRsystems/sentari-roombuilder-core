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
import { generateRoom } from "../generateRoom";
import { checkBacking } from "./backing-check";

let failures = 0;
const fail = (i: number, msg: string) => {
  failures++;
  if (failures <= 20) console.error(`room ${i}: ${msg}`);
};

const N = 5000;
const stats = { objects: 0, doors: 0, furniture: 0, npcs: 0 };
const npcKindsSeen = new Set<string>();
let roomsWithNonHostile = 0;

for (let i = 0; i < N; i++) {
  // Half the batch simulates play-space-fitted sizes (small, odd dimensions),
  // half uses the generator's own random sizing.
  const room =
    i % 2 === 0
      ? generateRoom()
      : generateRoom({
          width: 6 + Math.floor(Math.random() * 18),
          height: 6 + Math.floor(Math.random() * 16),
        });

  // The start zone stages outside the house (below the southmost wall) in any
  // room deep enough for the yard strip; shallower rooms start inside.
  {
    const start = room.objects.find((o) => o.kind === "start");
    const walls0 = room.objects.filter((o) => isWallKind(o.kind));
    const southmost = Math.max(...walls0.map((w) => w.y + objectExtent(w).h));
    if (start) {
      const outside = start.y - objectExtent(start).h >= southmost;
      const expectOutside = room.height - 1 - 2.1 - 1 >= 2.5;
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

  // Every door must actually cut a wall: gapping should split at least one
  // wall per door (wall count strictly grows, or a wall got consumed by
  // an end-of-wall gap — check per door instead: the gapped set must differ).
  const walls = room.objects.filter((o) => isWallKind(o.kind));
  const doors = room.objects.filter((o) => isDoorKind(o.kind));
  const gapped = wallsWithDoorGaps(room.objects).filter((o) => isWallKind(o.kind));
  // Each door removes ~2 cells of wall; total wall length must shrink by
  // roughly 2 cells per door (allow slack for merged/edge gaps).
  const totalLen = (ws: PlacedObject[]) => ws.reduce((s, w) => s + w.w, 0);
  const cut = totalLen(walls) - totalLen(gapped);
  if (cut < doors.length * 1.9) fail(i, `doors not cutting walls: ${doors.length} doors, only ${cut.toFixed(2)} cells cut`);

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

  // At least one hostile to clear.
  if (!room.objects.some((o) => o.behavior === "hostile")) fail(i, "no hostile");

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

  for (const o of room.objects) {
    if (paletteById[o.kind]?.render === "npc") {
      npcKindsSeen.add(o.kind);
      if (o.behavior && o.behavior !== "hostile") {
        roomsWithNonHostile++;
        break;
      }
    }
  }

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
if (failures) {
  console.error(`FAILED: ${failures} invariant violations`);
  process.exit(1);
}
console.log("all invariants hold");
