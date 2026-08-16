// Random room generator — one click in the library produces a plausible small
// house: a walled shell split into 2–4 rooms, doors connecting every room, an
// entry door on the south wall with the start zone staged OUTSIDE it (the
// squad stacks up in the yard and breaches in), furniture dressed by room
// type, and at least one hostile to clear. The output is a plain Room;
// nothing downstream knows it was generated.
//
// Layout is a simple axis-aligned BSP: split the biggest leaf on its longer
// axis until we have the target room count. One door per split wall keeps the
// whole house connected by construction. Doors are placed dead-center ON their
// wall's line with the wall's rotation, so wallsWithDoorGaps always cuts a
// clean opening at push time (its tolerance is ~0.65 cells / 25°).

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
};

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
  const clearOf = (t: number) => junctions.every((j) => Math.abs(t - j) >= 1.6);
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
const HOSTILE_KINDS = ["Soldier", "Soldier (Gas)"];
const CIVILIAN_KINDS = ["Bobby", "Freddy", "Ray", "Remy", "Susan", "Tabby", "Tom"];

// ── the generator ───────────────────────────────────────────────
export function generateRoom(opts: GenerateRoomOptions = {}): Room {
  const W = clampRoomCells(opts.width ?? randInt(8, 14) * 2);
  const H = clampRoomCells(opts.height ?? randInt(6, 10) * 2);

  // One perimeter material per house reads as a building, not a patchwork.
  // Interior walls each pick their own material — a whole WALL stays one
  // material (no mid-wall patchwork), but room to room the partitions vary.
  const shellKind = pick(["Brick", "Cinderblock", "Concrete", "Wood"]);
  const interiorKinds = ["Brick", "Cinderblock", "Concrete", "Drywall", "Wood"];
  const doorKinds = PALETTE.filter((p) => p.section === "Doors").map((p) => p.kind);

  // The walkable region: one or more axis-aligned WINGS — adjoining
  // rectangles decomposed from a real play space by fitWingsForBounds, so an
  // L-shaped space grows an L-shaped house instead of one inscribed box.
  // Contacts name the shared edges; each gets a wall with a doorway so the
  // wings connect. Default: a single wing covering the box (or the caller's
  // `frame`), which reproduces the classic rectangular house exactly.
  const walkWings: Leaf[] = (opts.wings?.length
    ? opts.wings
    : [{ x0: opts.frame?.x0 ?? 0, y0: opts.frame?.y0 ?? 0, x1: opts.frame?.x1 ?? W, y1: opts.frame?.y1 ?? H }]
  ).map((r) => ({
    x0: Math.max(0, r.x0),
    y0: Math.max(0, r.y0),
    x1: Math.min(W, r.x1),
    y1: Math.min(H, r.y1),
  }));
  const contacts: WingContact[] = opts.wings?.length ? opts.contacts ?? [] : [];
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
  const shells: Leaf[] = walkWings.map((wg, i) => ({
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
  const YARD = 2.1;
  const entryCands = shells.filter((_, i) => !touchesContact(i, "S"));
  const entryShell = (entryCands.length ? entryCands : shells).reduce((a, b) =>
    a.x1 - a.x0 >= b.x1 - b.x0 ? a : b
  );
  const exteriorStart = entryShell.y1 - YARD - entryShell.y0 >= 2.5; // keep ≥ 2.5 cells of house depth
  if (exteriorStart) entryShell.y1 -= YARD;
  const entryY1 = entryShell.y1;

  // Exterior shell walls: each wing edge, minus the spans where it meets
  // another wing. Contact walls (one per contact, sized to the two shells'
  // final overlap) go up with a doorway each — declared here, filled after
  // the door helpers below exist.
  const perimeter: PlacedObject[] = [];
  const contactSpan = (ct: WingContact) => {
    const A = shells[ct.a];
    const B = shells[ct.b];
    return ct.axis === "x"
      ? { lo: Math.max(A.y0, B.y0), hi: Math.min(A.y1, B.y1) }
      : { lo: Math.max(A.x0, B.x0), hi: Math.min(A.x1, B.x1) };
  };
  shells.forEach((s, i) => {
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
  const leaves: Leaf[] = shells.map((s) => ({ ...s }));
  const splits: Split[] = [];
  // Every extra wing is already a room; the split budget scales with them.
  const targetRooms = randInt(2, 4) + (shells.length - 1);
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
    const kind = pick(interiorKinds);
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
  const addDoorClearance = (dx: number, dy: number) => clearances.push(boxAt(dx, dy, 1.25, 1.25));

  // Party walls between wings, one doorway each — this is what keeps an
  // L-shaped house one house. Two exceptions go OPEN instead (no wall):
  // spans too tight for a doorway (connectivity beats tidiness), and a
  // random quarter of the rest — an open threshold between wings is real
  // architecture and varies the structure. Open contacts still get a
  // clearance box so furniture never plugs the passage.
  // Open (wall-less) contact lines — wall-hugging furniture must never back
  // onto these; a cabinet "against" an open threshold stands in the passage.
  const openContacts: Array<{ axis: "x" | "y"; c: number; lo: number; hi: number }> = [];
  for (const ct of contacts) {
    const sp = contactSpan(ct);
    if (sp.hi - sp.lo < 2.2 || Math.random() < 0.25) {
      addDoorClearance(...((ct.axis === "x" ? [ct.c, (sp.lo + sp.hi) / 2] : [(sp.lo + sp.hi) / 2, ct.c]) as [number, number]));
      openContacts.push({ axis: ct.axis, c: ct.c, lo: sp.lo, hi: sp.hi });
      continue;
    }
    const kind = pick(interiorKinds);
    perimeter.push(
      ct.axis === "x" ? makeWall(kind, ct.c, sp.lo, ct.c, sp.hi, W, H) : makeWall(kind, sp.lo, ct.c, sp.hi, ct.c, W, H)
    );
    const t = pickDoorT(sp.lo, sp.hi, []);
    const [dx, dy] = ct.axis === "x" ? [ct.c, t] : [t, ct.c];
    doors.push({ ...makeObject(pick(doorKinds), dx, dy, W, H), rotation: ct.axis === "x" ? 90 : 0 });
    addDoorClearance(dx, dy);
  }

  for (const s of splits) {
    const junctions = splits
      .filter((o) => o !== s && o.axis !== s.axis && (o.lo === s.cut || o.hi === s.cut))
      .filter((o) => o.cut > s.lo && o.cut < s.hi)
      .map((o) => o.cut);
    const t = pickDoorT(s.lo, s.hi, junctions);
    const [dx, dy] = s.axis === "x" ? [s.cut, t] : [t, s.cut];
    doors.push({ ...makeObject(pick(doorKinds), dx, dy, W, H), rotation: s.axis === "x" ? 90 : 0 });
    addDoorClearance(dx, dy);
  }

  // Entry: the widest leaf on the entry wing's south wall gets a perimeter
  // door; the start zone stages outside it. Leaves from OTHER wings can share
  // the same y1 by coincidence, so the filter also pins the x-range.
  const southLeaves = leaves.filter(
    (l) => Math.abs(l.y1 - entryY1) < eps && l.x0 >= entryShell.x0 - eps && l.x1 <= entryShell.x1 + eps
  );
  const entryLeaf = southLeaves.reduce((a, b) => (a.x1 - a.x0 >= b.x1 - b.x0 ? a : b));
  const southJunctions = splits
    .filter((s) => s.axis === "x" && Math.abs(s.hi - entryY1) < eps && s.cut > entryLeaf.x0 && s.cut < entryLeaf.x1)
    .map((s) => s.cut);
  const entryX = pickDoorT(entryLeaf.x0, entryLeaf.x1, southJunctions);
  doors.push({ ...makeObject(pick(doorKinds), entryX, entryY1, W, H), rotation: 0 });
  addDoorClearance(entryX, entryY1);

  const startDef = paletteById.start;
  // Centered on the entry door, just OUTSIDE the south wall — or just inside
  // it when there's no yard strip. The clamp keeps the zone clear of the room
  // edge (outside, where the yard is open) or inside the entry leaf (inside,
  // where drifting sideways would cross an interior wall). Snapped up front so
  // the collision box below matches where makeObject puts the zone.
  const startLo = exteriorStart ? entryShell.x0 : entryLeaf.x0;
  const startHi = exteriorStart ? entryShell.x1 : entryLeaf.x1;
  const startX = Math.min(Math.max(entryX, snapUp(startLo + 1)), snapDown(startHi - 1));
  // Outside: wall half-thickness + a 1-cell (0.5 m) standoff + the zone's
  // half-depth — the zone's near edge is half a meter clear of the door, so
  // nobody stages nose-to-leaf. Exact placement (the spread below skips
  // makeObject's half-cell snap, which would eat a third of the standoff).
  // Inside (tiny-space fallback): tight to the wall as before — a room too
  // small for a yard can't afford a standoff either.
  const startY = exteriorStart ? entryY1 + 1.55 : snapDown(entryY1 - 0.76);
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
  const stubs: PlacedObject[] = [];
  for (const leaf of shuffle(leaves)) {
    if (stubs.length >= 2) break;
    if (Math.random() < 0.5) continue;
    for (let attempt = 0; attempt < 8; attempt++) {
      const side = pick(["N", "S", "W", "E"] as const);
      const vertical = side === "N" || side === "S"; // stub runs along y
      const cross = vertical ? leaf.y1 - leaf.y0 : leaf.x1 - leaf.x0;
      const along = vertical ? leaf.x1 - leaf.x0 : leaf.y1 - leaf.y0;
      if (cross - 1.6 < 1.5 || along < 4) break; // leaf too small for a pocket
      const len = snapDown(Math.min(cross - 1.6, randRange(1.5, cross * 0.6)));
      if (len < 1.5) continue;
      const t = vertical
        ? snapBetween(leaf.x0 + 1.5, leaf.x1 - 1.5)
        : snapBetween(leaf.y0 + 1.5, leaf.y1 - 1.5);
      if (t === null) break;
      const stubKind = pick(interiorKinds);
      const wall =
        side === "N" ? makeWall(stubKind, t, leaf.y0, t, leaf.y0 + len, W, H)
        : side === "S" ? makeWall(stubKind, t, leaf.y1, t, leaf.y1 - len, W, H)
        : side === "W" ? makeWall(stubKind, leaf.x0, t, leaf.x0 + len, t, W, H)
        : makeWall(stubKind, leaf.x1, t, leaf.x1 - len, t, W, H);
      const e = objectExtent(wall);
      const box = boxAt(wall.x, wall.y, e.w, e.h);
      // Extra breathing room (0.4) against the start zone; doorway clearance
      // keeps a stub from walling off a door's approach.
      if (hitsAny(box, placed, 0.4) || hitsAny(box, clearances)) continue;
      stubs.push(wall);
      placed.push(box); // furniture and NPCs route around it
      break;
    }
  }

  // ── the guaranteed hostile ────────────────────────────────────
  // Placed BEFORE furniture: in a tiny play space the free floor can be
  // little more than the start zone, and a hostile to clear matters more than
  // one more cabinet — furniture placed afterwards simply works around it.
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

  const leafCenter = (l: Leaf) => ({ x: (l.x0 + l.x1) / 2, y: (l.y0 + l.y1) / 2 });
  const distFromStart = (l: Leaf) => {
    const c = leafCenter(l);
    return Math.hypot(c.x - startX, c.y - startY);
  };
  // Random tries in the farthest leaves first; if those all fail, sweep the
  // floor half-cell by half-cell for a genuinely free spot.
  const hostileLeaves = leaves.length > 1 ? leaves.filter((l) => l !== entryLeaf) : leaves;
  const byDistance = [...hostileLeaves].sort((a, b) => distFromStart(b) - distFromStart(a));
  // Usually a soldier model, but ~30% of houses hide the hostile in a
  // civilian model — reading INTENT, not outfits, is the drill.
  const hostileKind = Math.random() < 0.3 ? pick(CIVILIAN_KINDS) : pick(HOSTILE_KINDS);
  if (!byDistance.some((l) => tryNpc(l, hostileKind, "hostile", 20))) {
    // Progressively relax: entry leaf included, then the stay-away-from-start
    // rule waived, then doorway clearances waived (a hostile standing in a
    // doorway is a legal, mean room — a tiny house may have no other floor).
    // The last tier also packs tight: exact 1×1 footprint (rotation 0 so the
    // AABB isn't inflated), no breathing gap. Overlapping the start zone or a
    // wall is never allowed.
    const sweepLeaves = byDistance.includes(entryLeaf) ? byDistance : [...byDistance, entryLeaf];
    const tiers = [
      { nearStart: false, doorway: false, tight: false },
      { nearStart: true, doorway: false, tight: false },
      { nearStart: true, doorway: true, tight: false },
      { nearStart: true, doorway: true, tight: true },
    ];
    outer: for (const relax of tiers) {
      for (const l of sweepLeaves) {
        for (let y = l.y0 + 1; y <= l.y1 - 1; y += 0.5) {
          for (let x = l.x0 + 1; x <= l.x1 - 1; x += 0.5) {
            const half = relax.tight ? 0.5 : 0.71;
            const box = boxAt(x, y, half, half);
            if (hitsAny(box, placed, relax.tight ? 0 : 0.25)) continue;
            if (!relax.doorway && hitsAny(box, clearances)) continue;
            if (!relax.nearStart && Math.hypot(x - startX, y - startY) < 2.5) continue;
            placed.push(box);
            npcs.push({
              ...makeObject(hostileKind, x, y, W, H),
              rotation: relax.tight ? 0 : randInt(0, 359),
              behavior: "hostile",
            });
            break outer;
          }
        }
      }
    }
  }

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
        // FLUSH against the wall: wall half-thickness (~0.1) + a 5 cm gap.
        // The perpendicular coordinate is exact — snapping it to the half-cell
        // grid pushed pieces up to 40 cm off the wall face, which reads as
        // "floating in the room" at VR scale. Only the along-wall coordinate
        // keeps the grid.
        const HUG = 0.2; // cells off the wall CENTERLINE (≈5 cm off its face)
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
        const backsOntoOpen = openContacts.some(
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

  // The entry leaf is always the living room; the rest draw types without
  // replacement so a two-bathroom house doesn't happen.
  const typePool = shuffle<RoomType>(["bedroom", "bathroom", "office", "living"]);
  for (const leaf of leaves) {
    const type: RoomType = leaf === entryLeaf ? "living" : typePool.pop() ?? "living";
    for (const item of menuFor(type)) {
      const kinds = kindsIn(item.category);
      if (!kinds.length) continue;
      const res = tryPlace(leaf, pick(kinds), item.wall);
      // Tables seat 1–2 chairs; chairs appear nowhere else.
      if (res && item.category === "Table") placeChairs(leaf, res.obj, res.box, randInt(1, 2));
    }
  }

  // ── extra targets ─────────────────────────────────────────────
  // On top of the guaranteed hostile placed earlier: 1–3 more characters,
  // biased so nearly every room has someone NON-hostile — an all-shooter
  // house plays as a range, and reading friend-from-foe is the drill. Each
  // extra tries EVERY room before giving up: the old single-leaf, 10-attempt
  // roll almost never landed in a small play-space house, which is why
  // rooms kept coming out with one lone (always-hostile) soldier.
  const placeExtra = (kind: string, behavior: Behavior): boolean => {
    for (const leaf of shuffle(leaves)) if (tryNpc(leaf, kind, behavior, 12)) return true;
    return false;
  };
  const extras = randInt(1, 3);
  for (let i = 0; i < extras; i++) {
    // The first extra leans hard toward a civilian; later ones are a coin flip.
    if (Math.random() < (i === 0 ? 0.75 : 0.5)) {
      placeExtra(pick(CIVILIAN_KINDS), pick(["compliant", "compliant", "afraid", "compToHostile"]));
    } else {
      placeExtra(pick(HOSTILE_KINDS), pick(["hostile", "random"]));
    }
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
