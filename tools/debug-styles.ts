// Isolate which interior style produces unreachable NPCs/doors, then dump
// one failing layout. Run: npx tsx tools/debug-styles.ts
import { isDoorKind, isWallKind, objectExtent, paletteById, wallsWithDoorGaps } from "../rooms";
import { generateRoom, type InteriorStyle } from "../generateRoom";

function unreachables(room: ReturnType<typeof generateRoom>): string[] {
  const bad: string[] = [];
  const start = room.objects.find((o) => o.kind === "start");
  if (!start) return bad;
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
    if (paletteById[o.kind]?.render === "npc" && !reachable(o.x, o.y)) bad.push(`NPC ${o.kind}@(${o.x},${o.y})`);
    if (isDoorKind(o.kind) && !reachable(o.x, o.y)) bad.push(`door ${o.kind}@(${o.x},${o.y})`);
  }
  return bad;
}

const counts: Record<string, number> = {};
let dumped = false;
for (const style of ["warren", "hallway", "open", "cozy"] as InteriorStyle[]) {
  counts[style] = 0;
  for (let i = 0; i < 2000; i++) {
    const small = style === "cozy" || i % 2 === 1;
    const room = generateRoom(
      small
        ? { width: 6 + Math.floor(Math.random() * 18), height: 6 + Math.floor(Math.random() * 16), interiorStyle: style }
        : { interiorStyle: style }
    );
    const bad = unreachables(room);
    if (bad.length) {
      counts[style]++;
      if (!dumped) {
        dumped = true;
        console.log(`--- failing ${style} ${room.width}x${room.height}: ${bad.join("; ")}`);
        for (const o of room.objects) {
          if (isWallKind(o.kind))
            console.log(`wall ${o.kind} @(${o.x},${o.y}) rot ${o.rotation} len ${o.w}`);
          else console.log(`${o.kind} @(${o.x},${o.y}) rot ${o.rotation} ${o.behavior ?? ""}`);
        }
      }
    }
  }
}
console.log(counts);
