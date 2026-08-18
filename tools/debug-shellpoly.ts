// Probe which polygon-shell validation step rejects each fixture.
// Run: npx tsx tools/debug-shellpoly.ts
import {
  clipHalfPlane,
  fitRegionsCells,
  longestChord,
  normalizeShellPoly,
  polySelfIntersects,
  type Pt,
} from "../generateRoom";

const fixtures: Array<{ name: string; pts: number[] }> = [
  { name: "quad", pts: [4, 20, 16, 20, 16.5, 6, 3.5, 7] },
  { name: "chamfer", pts: [5, 20, 15, 20, 19, 17, 19, 6, 4, 5, 3, 16] },
  { name: "Lshape", pts: [4, 20, 12, 20, 12, 13, 19, 13, 19, 4, 4, 4] },
  { name: "sevenpt", pts: [4, 21, 13, 21, 17, 18, 20, 10, 14, 4, 6, 5, 3, 13] },
  { name: "spike", pts: [4, 20, 14, 20, 21, 19, 15, 16, 20, 6, 5, 5] },
  { name: "shorts", pts: [4, 20, 14, 20, 14.3, 19.8, 14.5, 19.6, 18, 12, 14, 5, 5, 5, 4.2, 12] },
  { name: "revwind", pts: [15, 20, 5, 20, 3, 16, 4, 5, 19, 6, 19, 17] },
];

for (const fx of fixtures) {
  const poly: Pt[] = [];
  for (let i = 0; i < fx.pts.length; i += 2) poly.push({ x: fx.pts[i], y: fx.pts[i + 1] });
  const p = normalizeShellPoly(poly);
  if (!p) {
    console.log(`${fx.name}: REJECTED by normalizeShellPoly`);
    continue;
  }
  const eY = p[0].y;
  let depth = 0;
  for (const v of p) depth = Math.max(depth, eY - v.y);
  let yard = depth - 2.1 >= 2.5 ? 2.1 : 1.5;
  const exterior = depth - yard >= 2.5;
  if (!exterior) yard = 0;
  const entryY1 = eY - yard;
  const ip = yard > 0 ? clipHalfPlane(p, { x: 0, y: entryY1 }, { x: 0, y: -1 }) : p;
  const chord = ip.length >= 3 ? longestChord(ip, { x: 0, y: entryY1 }, { x: 1, y: 0 }) : { len: 0, lo: 0, hi: 0 };
  const selfX = ip.length >= 3 ? polySelfIntersects(ip) : true;
  const regions = fitRegionsCells(ip, 26, 26, 0.6);
  console.log(
    `${fx.name}: norm=${p.length}v yard=${yard} entryY1=${entryY1.toFixed(2)} ` +
      `clip=${ip.length}v chord=${chord.len.toFixed(2)} [${chord.lo.toFixed(1)},${chord.hi.toFixed(1)}] ` +
      `selfX=${selfX} regions=${regions ? regions.map((r) => `(${r.x0},${r.y0})-(${r.x1},${r.y1})`).join(" ") : "NULL"}`
  );
}
