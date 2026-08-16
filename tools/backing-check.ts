// Shared invariant: wall-category furniture (cabinets, toilets, vanities,
// closets, drawers, beds, sofas, bathtubs, file cabinets) must back onto a
// real wall: back edge within 1 cell of a wall line that covers its center.
import { objectExtent, isWallKind, paletteById, type PlacedObject, type Room } from "../rooms";

const WALL_CATS = new Set(["Sofa", "Bed", "Cabinet", "Closet", "Drawer", "Bathroom Vanity", "Bathtub", "Toilet", "File Cabinet"]);

export function checkBacking(room: Room, fail: (msg: string) => void): void {
  const walls = room.objects.filter((o) => isWallKind(o.kind));
  for (const o of room.objects) {
    const cat = paletteById[o.kind]?.category;
    if (!cat || !WALL_CATS.has(cat)) continue;
    const e = objectExtent(o);
    const rot = ((o.rotation % 360) + 360) % 360;
    // rot 0 faces south (placed against the north wall) etc.
    const horizBack = rot === 0 || rot === 180;
    const backCoord = rot === 0 ? o.y - e.h : rot === 180 ? o.y + e.h : rot === 270 ? o.x - e.w : o.x + e.w;
    const center = horizBack ? o.x : o.y;
    const backed = walls.some((w) => {
      const we = objectExtent(w);
      const wallHoriz = we.w >= we.h; // long axis along x = horizontal wall
      if (wallHoriz !== horizBack) return false;
      const line = wallHoriz ? w.y : w.x;
      const lo = wallHoriz ? w.x - we.w : w.y - we.h;
      const hi = wallHoriz ? w.x + we.w : w.y + we.h;
      return Math.abs(line - backCoord) <= 0.5 && center > lo - 0.1 && center < hi + 0.1;
    });
    if (!backed) fail(`${o.kind}@(${o.x.toFixed(1)},${o.y.toFixed(1)}) rot ${rot} not backed by a wall`);
  }
}
