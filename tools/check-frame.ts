import { fitRectForBounds } from "../tracking";
import { generateRoom } from "../generateRoom";
import { objectExtent, paletteById, isWallKind } from "../rooms";

// Shapes like the user's whole-home boundary: big, rotated, concave, with a
// notch through the middle (so the bbox-centered fit collapses).
const shapes: Record<string, { x: number; y: number }[]> = {
  "notched home (like screenshot)": [
    { x: 0.2, y: 0 }, { x: 9, y: 0.4 }, { x: 10.5, y: 3.4 }, { x: 10.8, y: 4.6 },
    { x: 6.2, y: 5.6 }, { x: 5.4, y: 9.2 }, { x: 1.6, y: 9.8 }, { x: 0, y: 0.6 },
  ],
  "L-shaped apartment": [
    { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 8 }, { x: 0, y: 8 },
  ],
  "rotated rect 20deg": (() => {
    const r = (20 * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    return [[-3.25,-2.75],[3.25,-2.75],[3.25,2.75],[-3.25,2.75]].map(([x,y]) => ({ x: x*c - y*s + 5, y: x*s + y*c + 5 }));
  })(),
};

let bad = 0;
for (const [label, pts] of Object.entries(shapes)) {
  const fr = fitRectForBounds(pts);
  if (!fr) { console.log(label, "-> NULL"); bad++; continue; }
  const f = fr.frame;
  console.log(label, `-> box ${fr.box.width}x${fr.box.height}, frame ${(f.x1-f.x0)/2}x${(f.y1-f.y0)/2} m at (${f.x0},${f.y0})`);
  for (let n = 0; n < 50; n++) {
    const room = generateRoom({ width: fr.box.width, height: fr.box.height, frame: f });
    for (const o of room.objects) {
      const e = objectExtent(o);
      if (o.x - e.w < f.x0 - 0.01 || o.x + e.w > f.x1 + 0.01 || o.y - e.h < f.y0 - 0.01 || o.y + e.h > f.y1 + 0.01) {
        console.log(`  VIOLATION: ${o.kind}@(${o.x},${o.y}) outside frame`); bad++;
      }
    }
    if (!room.objects.some((o) => o.behavior === "hostile")) { console.log("  no hostile"); bad++; }
    if (room.objects.filter((o) => o.kind === "start").length !== 1) { console.log("  bad start count"); bad++; }
    const walls = room.objects.filter((o) => isWallKind(o.kind));
    if (walls.length < 4) { console.log("  too few walls:", walls.length); bad++; }
  }
}
console.log(bad ? `FAILED: ${bad}` : "frame generation OK");
