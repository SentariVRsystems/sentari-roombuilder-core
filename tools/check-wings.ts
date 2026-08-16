import { fitWingsForBounds } from "../tracking";
import { generateRoom } from "../generateRoom";
import { isDoorKind, isWallKind, objectExtent, paletteById, wallsWithDoorGaps } from "../rooms";
import { checkBacking } from "./backing-check";

// An L-shaped play space like the user's: 5.5x5.5 m with the top-left 2.5x2.5 notched out.
const L = [
  { x: 2.5, y: 0 }, { x: 5.5, y: 0 }, { x: 5.5, y: 5.5 }, { x: 0, y: 5.5 }, { x: 0, y: 2.5 }, { x: 2.5, y: 2.5 },
];
const fw = fitWingsForBounds(L)!;
console.log("box", fw.box, "wings", JSON.stringify(fw.wings), "contacts", JSON.stringify(fw.contacts));

let bad = 0;
const fail = (i: number, m: string) => { bad++; if (bad < 15) console.log(`room ${i}: ${m}`); };
for (let i = 0; i < 300; i++) {
  const room = generateRoom({ width: fw.box.width, height: fw.box.height, wings: fw.wings, contacts: fw.contacts });
  const inWing = (x: number, y: number) =>
    fw.wings.some((w) => x >= w.x0 - 0.01 && x <= w.x1 + 0.01 && y >= w.y0 - 0.01 && y <= w.y1 + 0.01);
  let starts = 0;
  for (const o of room.objects) {
    if (o.kind === "start") starts++;
    const e = objectExtent(o);
    if (isWallKind(o.kind) || isDoorKind(o.kind)) {
      // Walls/doors legitimately sit ON wing boundaries (party walls, the
      // notch-facing edge) — require their centerline inside the wings.
      const r = (o.rotation * Math.PI) / 180;
      const hx = (Math.cos(r) * o.w) / 2, hy = (Math.sin(r) * o.w) / 2;
      for (const [cx, cy] of [[o.x - hx * 0.98, o.y - hy * 0.98], [o.x + hx * 0.98, o.y + hy * 0.98]] as const) {
        if (!inWing(cx, cy)) fail(i, `${o.kind}@(${o.x.toFixed(1)},${o.y.toFixed(1)}) centerline outside wings`);
      }
    } else {
      // Solids must be fully inside walkable floor, all four corners.
      for (const [cx, cy] of [[o.x - e.w, o.y - e.h], [o.x + e.w, o.y - e.h], [o.x - e.w, o.y + e.h], [o.x + e.w, o.y + e.h]] as const) {
        if (!inWing(cx, cy)) fail(i, `${o.kind}@(${o.x.toFixed(1)},${o.y.toFixed(1)}) corner outside wings`);
      }
    }
  }
  if (starts !== 1) fail(i, `${starts} starts`);
  if (!room.objects.some((o) => o.behavior === "hostile")) fail(i, "no hostile");
  checkBacking(room, (m) => fail(i, m));

  // walkability: flood from start, all doors + NPCs reachable
  const walls = wallsWithDoorGaps(room.objects).filter((o) => isWallKind(o.kind));
  const blocked = (x: number, y: number) =>
    walls.some((w) => { const e = objectExtent(w); return x > w.x - e.w - 0.25 && x < w.x + e.w + 0.25 && y > w.y - e.h - 0.25 && y < w.y + e.h + 0.25; });
  const st = room.objects.find((o) => o.kind === "start")!;
  const nx = room.width * 2 + 1, seen = new Set<number>();
  const key = (ix: number, iy: number) => iy * nx + ix;
  const q: [number, number][] = [[Math.round(st.x * 2), Math.round(st.y * 2)]];
  seen.add(key(q[0][0], q[0][1]));
  while (q.length) {
    const [ix, iy] = q.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const jx = ix + dx, jy = iy + dy;
      if (jx < 0 || jy < 0 || jx > room.width * 2 || jy > room.height * 2 || seen.has(key(jx, jy))) continue;
      if (blocked(jx / 2, jy / 2)) continue;
      seen.add(key(jx, jy)); q.push([jx, jy]);
    }
  }
  const reach = (x: number, y: number) => seen.has(key(Math.round(x * 2), Math.round(y * 2)));
  for (const o of room.objects) {
    if (paletteById[o.kind]?.render === "npc" && !reach(o.x, o.y)) fail(i, `NPC ${o.kind} unreachable`);
    if (isDoorKind(o.kind) && !reach(o.x, o.y)) fail(i, `door unreachable`);
  }
}
console.log(bad ? `FAILED: ${bad}` : "wing generation OK (300 rooms)");
