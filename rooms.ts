// Room Builder data model — the top-down CQB rooms an instructor builds for
// Build & Breach (module1) and "pushes" to headsets. Prototype on mock data:
// nothing here touches the relay; see state/roombuilder.tsx for the live sim.
//
// Coordinates are in GRID CELLS (not pixels). 1 cell ~= 0.5 m, so the default
// room below is 12 m x 8 m. Object x/y is the object's CENTER, in cells.

// ── Geometry ────────────────────────────────────────────────────
// A fixed logical grid; the SVG canvas uses a matching viewBox and scales to
// fit its container (see RoomCanvas). One mapping — cells * CELL — serves the
// grid, objects, the start marker, and the live headset dots/trails.
// Default size for a NEW room, in cells. Each room now carries its own
// width/height (Room.width/height) so small bays render zoomed-in and large
// ones zoomed-out; these are just the starting dimensions.
export const ROOM_W = 24; // default cells wide  (12 m)
export const ROOM_H = 16; // default cells tall  (8 m)
export const CELL = 24; // SVG units per cell (viewBox = width*CELL x height*CELL)
export const CELL_METERS = 0.5; // real-world meters per cell (fixed — grid scale)

// Room-size limits, in cells. Cell size is fixed at 0.5 m, so a room ranges
// 2 m .. 24 m per side; only the CELL COUNT varies (that's what "zoom" is).
export const MIN_ROOM_CELLS = 4; // 2 m
export const MAX_ROOM_CELLS = 48; // 24 m

export const cellsToMeters = (c: number) => c * CELL_METERS;
export const metersToCells = (m: number) => Math.round(m / CELL_METERS);
export const clampRoomCells = (c: number) =>
  Math.max(MIN_ROOM_CELLS, Math.min(MAX_ROOM_CELLS, Math.round(c)));

// The trainee START ZONE is spec'd in FEET — a 2.5 ft × 1.5 ft floor rectangle
// (wide along the line the squad forms on, shallow front-to-back; halved from
// the original 5 × 3 so it fits in the yard strip OUTSIDE a generated house
// even when the room is sized to a small play space). The facing chevron
// points across the short axis toward the long front edge = the direction they
// advance. The headset shows it as a blue rectangle on the ground and begins
// the "house is hot" countdown once every player is standing inside it.
export const FOOT_METERS = 0.3048; // meters per foot
export const feetToCells = (ft: number) => (ft * FOOT_METERS) / CELL_METERS;
export const START_ZONE_FT = { w: 2.5, h: 1.5 }; // width × depth, in feet

export const toSvgX = (x: number) => x * CELL;
export const toSvgY = (y: number) => y * CELL;

// Snap a cell coordinate to the nearest half-cell (objects sit on a fine grid).
export const snap = (v: number) => Math.round(v * 2) / 2;

// Keep a point inside the room, leaving `margin` cells of padding. Bounds
// default to the standard room so untouched callers keep their behavior;
// pass a room's own width/height to clamp to a resized room.
export const clampToRoom = (x: number, y: number, width = ROOM_W, height = ROOM_H, margin = 0.5) => ({
  x: Math.min(width - margin, Math.max(margin, x)),
  y: Math.min(height - margin, Math.max(margin, y)),
});

// ── Palette registry ────────────────────────────────────────────
// Mirrors the actual Build & Breach in-game build menu (WallCatalog +
// FurnitureCatalog, read from the BuildAndBreach Unity project). `kind` is the
// item id (the game's displayName). `place` = how it's put down: "wall" is drawn
// by two clicks, "point" drops at center, "start" is the singleton spawn marker.
export type PlaceMode = "wall" | "point" | "start";
export type RenderShape = "rect" | "start" | "npc";

export type PaletteDef = {
  kind: string; // item id = game displayName (e.g. "Sofa01", "Brick", "start")
  label: string;
  section: string; // top-level menu section: Walls, Doors, Furniture, NPCs, Start
  category: string; // subcategory within a section (furniture type); = section otherwise
  place: PlaceMode;
  render: RenderShape;
  defaultW: number; // footprint in cells
  defaultH: number;
  fill: string;
  stroke: string;
  singleton?: boolean; // at most one per room (the start location)
};

// Top-level build-menu sections, in tab order.
export const PALETTE_SECTIONS = ["Walls", "Doors", "Furniture", "Targets", "Start"];

// ── Target behavior (disposition) ───────────────────────────────
// A placed target carries a BEHAVIOR, matching Build & Breach's own
// NPCBehaviorToggle (Scripts/NPCBehaviorToggle.cs) + NPCAlignment enum. It's
// what the instructor assigns per target; the headset applies it as the NPC's
// alignment, and it drives the marker color on the map. Colors are the game's
// exact toggle colors so the plan reads the same as the drill.
export type Behavior = "hostile" | "compliant" | "afraid" | "compToHostile" | "random";

export const BEHAVIORS: { id: Behavior; label: string; color: string }[] = [
  { id: "hostile", label: "Hostile", color: "#FF3333" }, // engages on sight
  { id: "compliant", label: "Compliant", color: "#33CC33" }, // surrenders / follows commands
  { id: "afraid", label: "Afraid", color: "#FFCC33" }, // panics, flees ("scared")
  { id: "compToHostile", label: "Comp→Hostile", color: "#FF801A" }, // fake-surrender, turns when you look away
  { id: "random", label: "Random", color: "#9933FF" }, // picked at spawn (game default)
];

export const behaviorById: Record<Behavior, (typeof BEHAVIORS)[number]> = BEHAVIORS.reduce(
  (acc, b) => ((acc[b.id] = b), acc),
  {} as Record<Behavior, (typeof BEHAVIORS)[number]>
);

export const DEFAULT_BEHAVIOR: Behavior = "random";
export const isBehavior = (v: unknown): v is Behavior => typeof v === "string" && v in behaviorById;
export const behaviorColor = (b: Behavior | undefined) => behaviorById[b ?? DEFAULT_BEHAVIOR].color;

const F_STROKE = "rgba(247,249,251,0.28)";
const LIGHT_STROKE = "rgba(247,249,251,0.4)";

// Wall materials from WallCatalog — each a two-click wall in its material color.
const WALL_MATERIALS: { id: string; fill: string }[] = [
  { id: "Brick", fill: "#9E5B4A" },
  { id: "Cinderblock", fill: "#8A9096" },
  { id: "Concrete", fill: "#6E747B" },
  { id: "Drywall", fill: "#B7B1A5" },
  { id: "Wood", fill: "#A9743F" },
];

// Doors from BuildingMaterials/Doors (Brown/White/Black Door prefabs).
const DOORS: { id: string; fill: string }[] = [
  { id: "Brown Door", fill: "#8B5E3C" },
  { id: "White Door", fill: "#CFC9BE" },
  { id: "Black Door", fill: "#33383E" },
  // A doorway with no leaf — walkable, shootable-through, cuts the wall like
  // any door. The map draws it as two posts with a dashed opening.
  { id: "Open Door Frame", fill: "#7A8188" },
];

// Targets/NPCs from Resources/BuildingMaterials/NPCs/NPCs — the real placeable
// prefabs. `kind` stays the prefab displayName (the headset resolves it); the
// two generic dummies are surfaced as "Targets". A placed target's MAP color
// comes from its assigned behavior, not this fill — `fill` is only the palette
// swatch. `label` overrides the menu text where it differs from the prefab id.
const NPC_CIVILIAN = "#D98C5F";
const NPCS: { id: string; label?: string; fill: string }[] = [
  { id: "Hostile", label: "Hostile Target", fill: "#C15A4E" },
  { id: "Non-Hostile", label: "Non-Hostile Target", fill: "#5B8FB9" },
  { id: "Soldier", fill: "#6E7A55" },
  { id: "Soldier (Gas)", fill: "#6E7A55" },
  { id: "Bobby", fill: NPC_CIVILIAN },
  { id: "Freddy", fill: NPC_CIVILIAN },
  { id: "Ray", fill: NPC_CIVILIAN },
  { id: "Remy", fill: NPC_CIVILIAN },
  { id: "Susan", fill: NPC_CIVILIAN },
  { id: "Tabby", fill: NPC_CIVILIAN },
  { id: "Tom", fill: NPC_CIVILIAN },
];

// Furniture categories from FurnitureCatalog. `items` are the exact displayNames.
const seq = (prefix: string, n: number, start = 1) =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(start + i).padStart(2, "0")}`);

// Real per-item footprints in METERS (w = prefab X, d = prefab Z), measured
// from each prefab's BoxCollider world AABB in the BuildAndBreach Unity
// project (tools/measure-footprints.py); `h` is the real prefab height, which
// the 3D view's extrusion uses. The headset places furniture prefabs
// at NATIVE scale — RoomBuilderLoader ignores the wire w/h for sizing — so the
// map has to use the prefab's real size or the plan lies about clearances.
// Category w/h below remain only as a fallback for items missing here.
const FOOTPRINT_M: Record<string, { w: number; d: number; h: number }> = {
  Bed01: { w: 0.97, d: 1.97, h: 0.89 },
  Bed02: { w: 1.47, d: 1.97, h: 0.89 },
  Bed03: { w: 0.93, d: 1.84, h: 0.95 },
  Bed04: { w: 1.48, d: 2.0, h: 0.6 },
  Bed05: { w: 0.93, d: 1.84, h: 0.44 },
  Sofa01: { w: 2.36, d: 0.97, h: 0.92 },
  Sofa02: { w: 0.88, d: 0.97, h: 0.92 },
  Sofa03: { w: 2.38, d: 0.95, h: 0.74 },
  Sofa04: { w: 0.96, d: 0.95, h: 0.74 },
  Sofa05: { w: 0.73, d: 0.78, h: 0.46 },
  Sofa06: { w: 2.08, d: 0.92, h: 0.76 },
  Sofa07: { w: 1.2, d: 0.92, h: 0.76 },
  Sofa08: { w: 2.36, d: 1.16, h: 0.88 },
  Sofa09: { w: 1.32, d: 1.16, h: 0.89 },
  Sofa10: { w: 1.32, d: 1.17, h: 0.5 },
  Sofa11: { w: 2.17, d: 1.02, h: 0.81 },
  // L-shaped sectionals: the single BoxCollider covers only the main run, so
  // these two under-report (and their pivot sits off the visual center).
  Sofa12: { w: 0.9, d: 1.63, h: 0.76 },
  Sofa13: { w: 0.9, d: 1.63, h: 0.76 },
  Table01: { w: 1.19, d: 0.73, h: 0.72 },
  Table02: { w: 0.73, d: 0.73, h: 0.72 },
  Table03: { w: 1.19, d: 0.73, h: 0.72 },
  Table04: { w: 1.19, d: 0.73, h: 0.72 },
  Table05: { w: 1.19, d: 0.73, h: 0.72 },
  Table06: { w: 1.17, d: 0.71, h: 0.72 },
  Table07: { w: 1.17, d: 0.71, h: 0.72 },
  Table08: { w: 1.17, d: 0.71, h: 0.72 },
  Table09: { w: 1.17, d: 0.71, h: 0.72 },
  Table10: { w: 1.17, d: 0.71, h: 0.72 },
  Table11: { w: 1.19, d: 0.73, h: 0.72 },
  Chair01: { w: 0.44, d: 0.52, h: 0.96 },
  Chair02: { w: 0.43, d: 0.5, h: 0.98 },
  CabinetA_Sink: { w: 0.83, d: 0.57, h: 0.91 },
  CabinetA01: { w: 0.42, d: 0.57, h: 0.91 },
  CabinetACorner01: { w: 0.77, d: 0.77, h: 0.91 },
  CabinetB_Sink: { w: 0.83, d: 0.57, h: 0.91 },
  CabinetB01: { w: 0.42, d: 0.57, h: 0.91 },
  CabinetB03: { w: 0.41, d: 0.57, h: 0.91 },
  Closet01: { w: 1.35, d: 0.49, h: 1.96 },
  Closet02: { w: 1.87, d: 0.49, h: 1.96 },
  Closet03: { w: 1.56, d: 0.49, h: 1.96 },
  Closet04: { w: 1.0, d: 0.49, h: 1.96 },
  Closet05: { w: 1.0, d: 0.49, h: 1.96 },
  Closet06: { w: 1.0, d: 0.49, h: 1.96 },
  Closet07: { w: 1.5, d: 0.49, h: 1.96 },
  Closet08: { w: 1.5, d: 0.49, h: 1.96 },
  Closet09: { w: 1.98, d: 0.49, h: 1.96 },
  Closet10: { w: 1.98, d: 0.49, h: 1.96 },
  Closet11: { w: 0.84, d: 0.49, h: 1.96 },
  Closet12: { w: 0.84, d: 0.49, h: 1.96 },
  Drawer01: { w: 1.89, d: 0.4, h: 1.1 },
  Drawer02: { w: 0.99, d: 0.4, h: 1.1 },
  Drawer03: { w: 0.41, d: 0.47, h: 1.19 },
  Drawer04: { w: 0.8, d: 0.28, h: 1.19 },
  BathroomVanity01: { w: 0.86, d: 0.51, h: 0.88 },
  BathroomVanity02: { w: 0.86, d: 0.51, h: 0.88 },
  BathroomVanity03: { w: 1.14, d: 0.51, h: 0.88 },
  BathroomVanity04: { w: 0.87, d: 0.53, h: 0.68 },
  BathroomVanity05: { w: 1.14, d: 0.51, h: 0.98 },
  BathroomVanity06: { w: 1.1, d: 0.51, h: 0.68 },
  BathroomVanity07: { w: 0.86, d: 0.51, h: 0.88 },
  BathTub02: { w: 1.47, d: 0.65, h: 0.52 },
  BathTub05: { w: 1.47, d: 0.72, h: 0.57 },
  BathTub06: { w: 1.32, d: 1.32, h: 0.56 },
  BathTub07: { w: 1.39, d: 1.39, h: 0.54 },
  Toilet01: { w: 0.43, d: 0.65, h: 0.87 },
  "File Cabinet01": { w: 0.32, d: 0.37, h: 0.97 },
};

// Real prefab height in meters for a furniture kind, when measured — lets the
// 3D view extrude a Closet tall and a BathTub low instead of guessing by
// category.
export const furnitureHeightM = (kind: string): number | undefined => FOOTPRINT_M[kind]?.h;

const FURNITURE: { category: string; w: number; h: number; fill: string; items: string[] }[] = [
  { category: "Bed", w: 3, h: 4, fill: "#6E5E86", items: seq("Bed", 5) },
  { category: "Sofa", w: 4, h: 2, fill: "#3F7E7F", items: seq("Sofa", 13) },
  { category: "Table", w: 3, h: 2, fill: "#8A6A44", items: seq("Table", 11) },
  { category: "Chair", w: 1, h: 1, fill: "#9A7450", items: seq("Chair", 2) },
  { category: "Cabinet", w: 2, h: 1, fill: "#4F6E9E", items: ["CabinetA_Sink", "CabinetA01", "CabinetACorner01", "CabinetB_Sink", "CabinetB01", "CabinetB03"] },
  { category: "Closet", w: 2, h: 2, fill: "#82577F", items: seq("Closet", 12) },
  { category: "Drawer", w: 2, h: 1, fill: "#7A7248", items: seq("Drawer", 4) },
  { category: "Bathroom Vanity", w: 2, h: 1, fill: "#3F7E82", items: seq("BathroomVanity", 7) },
  { category: "Bathtub", w: 3, h: 2, fill: "#4E7A9E", items: ["BathTub02", "BathTub05", "BathTub06", "BathTub07"] },
  { category: "Toilet", w: 1, h: 1, fill: "#6A7480", items: ["Toilet01"] },
  { category: "File Cabinet", w: 1, h: 1, fill: "#75695B", items: ["File Cabinet01"] },
];

// Furniture subcategories, in order — the type tabs inside the Furniture section.
export const FURNITURE_TYPES: string[] = FURNITURE.map((c) => c.category);

export const PALETTE: PaletteDef[] = [
  ...WALL_MATERIALS.map<PaletteDef>((m) => ({
    kind: m.id, label: m.id, section: "Walls", category: "Walls", place: "wall", render: "rect",
    // Thickness tracks the game's wall prefabs, which were slimmed to half
    // their original depth — keep in sync if they change again.
    defaultW: 4, defaultH: 0.1875, fill: m.fill, stroke: "rgba(247,249,251,0.35)",
  })),
  ...DOORS.map<PaletteDef>((d) => ({
    kind: d.id, label: d.id, section: "Doors", category: "Doors", place: "point", render: "rect",
    defaultW: 2, defaultH: 0.5, fill: d.fill, stroke: LIGHT_STROKE,
  })),
  ...FURNITURE.flatMap((c) =>
    c.items.map<PaletteDef>((id) => {
      const m = FOOTPRINT_M[id];
      return {
        kind: id, label: id, section: "Furniture", category: c.category, place: "point", render: "rect",
        defaultW: m ? m.w / CELL_METERS : c.w, defaultH: m ? m.d / CELL_METERS : c.h, fill: c.fill, stroke: F_STROKE,
      };
    })
  ),
  ...NPCS.map<PaletteDef>((n) => ({
    kind: n.id, label: n.label ?? n.id, section: "Targets", category: "Targets", place: "point", render: "npc",
    defaultW: 1, defaultH: 1, fill: n.fill, stroke: LIGHT_STROKE,
  })),
  { kind: "start", label: "Start Zone", section: "Start", category: "Start", place: "start", render: "start", defaultW: feetToCells(START_ZONE_FT.w), defaultH: feetToCells(START_ZONE_FT.h), fill: "#3DB4FF", stroke: "#3DB4FF", singleton: true },
];

export const paletteById: Record<string, PaletteDef> = PALETTE.reduce(
  (acc, def) => ((acc[def.kind] = def), acc),
  {} as Record<string, PaletteDef>
);

// ── Room types ──────────────────────────────────────────────────
export type PlacedObject = {
  id: string;
  kind: string; // palette item id
  x: number; // center, in cells
  y: number;
  rotation: number; // degrees, any angle (0 = as authored)
  w: number; // footprint in cells
  h: number;
  behavior?: Behavior; // targets/NPCs only — disposition applied on the headset
};

export type Room = {
  id: string;
  name: string;
  width: number; // room size in cells (X) — 0.5 m each
  height: number; // room size in cells (Y)
  objects: PlacedObject[]; // includes 0..1 object with kind "start"
  createdAt: number;
  updatedAt: number;
};

// Validate untrusted room data (AsyncStorage, Firestore) into a Room, dropping
// malformed objects rather than crashing the canvas on a bad write.
export function sanitizeRoom(id: string, data: unknown): Room | null {
  const d = data as Partial<Room> | null;
  if (!d || typeof d.name !== "string" || !Array.isArray(d.objects)) return null;
  const objects: PlacedObject[] = [];
  for (const raw of d.objects) {
    const o = raw as Partial<PlacedObject>;
    if (
      typeof o?.id === "string" && typeof o.kind === "string" &&
      typeof o.x === "number" && typeof o.y === "number" &&
      typeof o.rotation === "number" && typeof o.w === "number" && typeof o.h === "number"
    ) {
      // Furniture is always built at the prefab's native size (the headset
      // ignores stored w/h for it), so stale footprints from before the
      // catalog carried real sizes are corrected on load. Walls keep their
      // drawn LENGTH but take the catalog's thickness — the game's wall
      // prefabs slimmed down, and rooms saved before that would draw (and
      // cut door gaps) at the old depth forever. Everything else keeps what
      // was stored.
      const def = paletteById[o.kind];
      const native = def?.section === "Furniture";
      const wall = def?.section === "Walls";
      objects.push({
        id: o.id, kind: o.kind, x: o.x, y: o.y, rotation: o.rotation,
        w: native ? def.defaultW : o.w,
        h: native || wall ? def!.defaultH : o.h,
        ...(isBehavior(o.behavior) ? { behavior: o.behavior } : {}),
      });
    }
  }
  return {
    id,
    name: d.name,
    width: typeof d.width === "number" ? clampRoomCells(d.width) : ROOM_W,
    height: typeof d.height === "number" ? clampRoomCells(d.height) : ROOM_H,
    objects,
    createdAt: typeof d.createdAt === "number" ? d.createdAt : 0,
    updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : 0,
  };
}

// ── id helpers ──────────────────────────────────────────────────
let counter = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
export const newObjectId = () => uid("obj");
export const newRoomId = () => uid("room");

// Build a placed object from the registry defaults at a dropped position,
// clamped into the room's bounds.
export function makeObject(kind: string, x: number, y: number, width = ROOM_W, height = ROOM_H): PlacedObject {
  const def = paletteById[kind];
  const p = clampToRoom(snap(x), snap(y), width, height);
  return {
    id: newObjectId(), kind, x: p.x, y: p.y, rotation: 0, w: def?.defaultW ?? 1, h: def?.defaultH ?? 1,
    // Targets start on the game's default disposition (Random); other objects
    // carry no behavior.
    ...(def?.render === "npc" ? { behavior: DEFAULT_BEHAVIOR } : {}),
  };
}

// Is this kind a placeable target/NPC (behavior applies)?
export const isNpcKind = (kind: string) => paletteById[kind]?.render === "npc";

// Build a wall of the given material spanning two points: centered on their
// midpoint, length = distance between them, rotated to the line's angle. Points
// are used as given (already snapped/connected by snapWallPoint), just clamped.
export function makeWall(kind: string, x1: number, y1: number, x2: number, y2: number, width = ROOM_W, height = ROOM_H): PlacedObject {
  const a = clampToRoom(x1, y1, width, height);
  const b = clampToRoom(x2, y2, width, height);
  const len = Math.max(0.5, Math.hypot(b.x - a.x, b.y - a.y));
  const rotation = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const def = paletteById[kind];
  return { id: newObjectId(), kind, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, rotation, w: len, h: def?.defaultH ?? 0.5 };
}

// ── The room box follows the layout ─────────────────────────────────────
// `width`/`height` are not a viewing preference — they go on the wire and tell
// the headset how big a house to build, and they're what the walked-space
// outline is centred on. So the box has to contain everything placed in it.
//
// The canvas zooms independently of the room now, which means you can scroll
// out and keep building past the old edge; rather than make you go and nudge a
// pair of steppers to match, the box grows to cover what you drew. It only ever
// grows: a room that shrank as you deleted things would move the walls out from
// under you mid-edit. Fitting a room back DOWN stays deliberate — that's what
// fitCellsForSpaces / "fit to space" is for.

/** Half-extents of a placed object's axis-aligned box at its current rotation. */
export function objectExtent(o: PlacedObject): { w: number; h: number } {
  const r = (o.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return { w: (o.w * c + o.h * s) / 2, h: (o.w * s + o.h * c) / 2 };
}

/**
 * The room size needed to contain `objects`, never smaller than the current one
 * and never past MAX_ROOM_CELLS. Returns null when the room already fits, so a
 * caller can skip the state update entirely on the common path.
 */
export function grownRoomSize(
  objects: PlacedObject[],
  width: number,
  height: number,
  margin = 1
): { width: number; height: number } | null {
  let maxX = 0;
  let maxY = 0;
  for (const o of objects) {
    const e = objectExtent(o);
    maxX = Math.max(maxX, o.x + e.w);
    maxY = Math.max(maxY, o.y + e.h);
  }
  const w = clampRoomCells(Math.max(width, Math.ceil(maxX + margin)));
  const h = clampRoomCells(Math.max(height, Math.ceil(maxY + margin)));
  return w === width && h === height ? null : { width: w, height: h };
}

// ── Connection helpers (walls snap to walls, doors snap onto walls) ──────
export const isWallKind = (kind: string) => paletteById[kind]?.section === "Walls";
export const isDoorKind = (kind: string) => paletteById[kind]?.section === "Doors";

// How far a door leaf swings, in degrees — what the map's swing arc draws. This
// is the door PREFAB's own hinge limit (min -154 / max 160), which is what the
// headset actually enforces; RoomBuilderLoader additionally clamps to ±180 so a
// leaf can never wrap past flat. Keep in sync if the prefab's joint changes.
export const DOOR_SWING_DEG = 160;

// The two endpoints of a wall segment (center ± half-length along its rotation).
export function wallEndpoints(o: PlacedObject): [{ x: number; y: number }, { x: number; y: number }] {
  const r = (o.rotation * Math.PI) / 180;
  const hx = (Math.cos(r) * o.w) / 2;
  const hy = (Math.sin(r) * o.w) / 2;
  return [{ x: o.x - hx, y: o.y - hy }, { x: o.x + hx, y: o.y + hy }];
}

// Nearest point on segment AB to P, and squared distance to it.
function nearestOnSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-6;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { x: cx, y: cy, d2: (px - cx) * (px - cx) + (py - cy) * (py - cy) };
}

// Snap a wall click to a nearby existing wall endpoint (corner-connect) or onto
// a wall body (T-junction); otherwise to the half-cell grid.
export function snapWallPoint(objects: PlacedObject[], x: number, y: number, radius = 1.25): { x: number; y: number } {
  const r2 = radius * radius;
  let best: { x: number; y: number } | null = null;
  let bestD = r2;
  // Endpoints first — corners take priority.
  for (const o of objects) {
    if (!isWallKind(o.kind)) continue;
    for (const e of wallEndpoints(o)) {
      const d = (x - e.x) * (x - e.x) + (y - e.y) * (y - e.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
  }
  if (best) return { x: best.x, y: best.y };
  // Then wall bodies — snap onto the line for a T-junction.
  bestD = r2;
  for (const o of objects) {
    if (!isWallKind(o.kind)) continue;
    const [a, b] = wallEndpoints(o);
    const n = nearestOnSeg(x, y, a.x, a.y, b.x, b.y);
    if (n.d2 < bestD) {
      bestD = n.d2;
      best = { x: n.x, y: n.y };
    }
  }
  if (best) return best;
  return clampToRoom(snap(x), snap(y));
}

// Smallest angle between two orientations treating them as undirected lines
// (walls are bidirectional): result in [0, 90].
function lineAngleDiff(a: number, b: number): number {
  let d = (((a - b) % 180) + 180) % 180; // 0..180
  return d > 90 ? 180 - d : d;
}

// Snap a door onto nearby walls — but only when the door is already roughly
// parallel to them (within `maxAngle`), so snapping never hijacks a door the
// instructor deliberately set to a different orientation.
//
// Corner snap first: a door fills the gap walls leave for it, so near a wall
// ENDPOINT the door aligns to that wall and sits edge-flush at the endpoint —
// door corner touching wall corner, continuing the wall line. Only when no
// corner is in range does it fall back to snapping onto a wall body (centered
// on the line). Returns null when nothing aligned is in range.
export function snapDoorToWall(
  objects: PlacedObject[],
  x: number,
  y: number,
  doorRotation: number,
  doorW = 2,
  radius = 1.2,
  maxAngle = 30
): { x: number; y: number; rotation: number } | null {
  const r2 = radius * radius;

  // A wall's rotation describes a LINE (mod 180), but a door's rotation is a
  // DIRECTION — it encodes the hinge side. Snapping used to overwrite the
  // door's rotation with the wall's raw angle, silently flipping the hinge
  // (270° door on a 90° wall "matched" and became 90°). Keep the door's
  // facing: of the two equivalent wall headings, take the one closer to it.
  const dirDiff = (a: number, b: number) => {
    const d = Math.abs((a - b) % 360);
    return Math.min(d, 360 - d);
  };
  const alignRot = (wallRot: number) =>
    dirDiff(doorRotation, wallRot) <= dirDiff(doorRotation, wallRot + 180) ? wallRot : (wallRot + 180) % 360;

  let corner: { x: number; y: number; rotation: number } | null = null;
  let bestD = r2;
  for (const o of objects) {
    if (!isWallKind(o.kind)) continue;
    if (lineAngleDiff(doorRotation, o.rotation) > maxAngle) continue;
    const [a, b] = wallEndpoints(o);
    for (const [end, other] of [[a, b], [b, a]] as const) {
      const d = (x - end.x) * (x - end.x) + (y - end.y) * (y - end.y);
      if (d >= bestD) continue;
      // Extend past the endpoint, away from the wall body, by half the door's
      // length — the door's near edge lands exactly on the wall's corner.
      const len = Math.hypot(end.x - other.x, end.y - other.y) || 1;
      const ux = (end.x - other.x) / len;
      const uy = (end.y - other.y) / len;
      bestD = d;
      corner = { x: end.x + (ux * doorW) / 2, y: end.y + (uy * doorW) / 2, rotation: alignRot(o.rotation) };
    }
  }
  if (corner) return corner;

  let nearest: { x: number; y: number; rotation: number } | null = null;
  bestD = r2;
  for (const o of objects) {
    if (!isWallKind(o.kind)) continue;
    const [a, b] = wallEndpoints(o);
    const n = nearestOnSeg(x, y, a.x, a.y, b.x, b.y);
    if (n.d2 < bestD) {
      bestD = n.d2;
      nearest = { x: n.x, y: n.y, rotation: alignRot(o.rotation) };
    }
  }
  if (!nearest) return null;
  if (lineAngleDiff(doorRotation, nearest.rotation) > maxAngle) return null; // deliberately off-axis — don't grab it
  return nearest;
}

// ── Door openings (cut a gap in the wall for each door) ──────────
// A door drawn ON a continuous wall means the door's swinging leaf hits the wall
// body on the headset. Fix it geometrically: wherever a door lies along a wall,
// split that wall into segments leaving a DOOR-WIDTH gap — a real opening the
// leaf swings through. Returns the object list with walls replaced by their
// gapped segments (doors and everything else unchanged). Used when building the
// headset payload (and can drive the map so the opening is visible).
export function wallsWithDoorGaps(objects: PlacedObject[]): PlacedObject[] {
  const doors = objects.filter((o) => isDoorKind(o.kind));
  if (!doors.length) return objects;

  const MIN_SEG = 0.2; // cells — drop slivers left after cutting
  const MAX_ANGLE = 25; // door must be ~parallel to the wall to cut it
  // The headset places door PREFABS at their native meter size (frame ~1.1m
  // outside-to-outside) regardless of the door's cell footprint. The gap has to
  // clear the REAL frame: cut it narrower and invisible wall stubs poke into
  // the opening and eat shots fired near the frame posts.
  // The prefab frame measures 1.05m and its leaf 1.00m. Cut 1.02m — between
  // the two: narrower than the frame so wall ends tuck behind the posts (no
  // visible crack), wider than the leaf so the wall never intrudes into the
  // swing. This is a CONTRACT with the headset: RoomBuilderLoader's
  // FreeDoorLeavesFromWalls comment records that cutting narrower than the
  // frame is what caused doors jamming at 90°. (A brief 1.00m experiment here
  // chased a "gap at the frame" report that turned out to be the headset
  // rendering walls short/floating — cut width was never the culprit.)
  const DOOR_FRAME_CELLS = 1.02 / CELL_METERS;
  const out: PlacedObject[] = [];

  for (const o of objects) {
    if (!isWallKind(o.kind)) {
      out.push(o);
      continue;
    }
    const [a, b] = wallEndpoints(o);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-6;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const halfThick = Math.max(o.h, 0.5) / 2 + 0.4; // wall half-thickness + tolerance (cells)

    // Collect [start,end] gaps (in distance along the wall) for doors on it.
    const gaps: Array<[number, number]> = [];
    for (const d of doors) {
      if (lineAngleDiff(d.rotation, o.rotation) > MAX_ANGLE) continue;
      const px = d.x - a.x;
      const py = d.y - a.y;
      const t = px * ux + py * uy; // projection onto the wall line
      const perp = Math.abs(px * -uy + py * ux); // perpendicular distance to the line
      if (perp > halfThick) continue; // door isn't sitting on this wall
      if (t < -d.w / 2 || t > len + d.w / 2) continue; // door is past the wall's span
      const half = Math.max(d.w / 2, DOOR_FRAME_CELLS / 2);
      gaps.push([t - half, t + half]);
    }
    if (!gaps.length) {
      out.push(o);
      continue;
    }

    // Merge overlapping gaps, clamp to the wall, then emit the solid segments
    // between them as new wall pieces (same kind/thickness/rotation).
    gaps.sort((g1, g2) => g1[0] - g2[0]);
    const merged: Array<[number, number]> = [];
    for (const g of gaps) {
      const last = merged[merged.length - 1];
      if (last && g[0] <= last[1]) last[1] = Math.max(last[1], g[1]);
      else merged.push([Math.max(0, g[0]), Math.min(len, g[1])]);
    }
    let cursor = 0;
    let seg = 0;
    const emit = (t0: number, t1: number) => {
      if (t1 - t0 < MIN_SEG) return;
      const sx = a.x + ux * t0;
      const sy = a.y + uy * t0;
      const ex = a.x + ux * t1;
      const ey = a.y + uy * t1;
      out.push({ ...o, id: `${o.id}~${seg++}`, x: (sx + ex) / 2, y: (sy + ey) / 2, w: t1 - t0 });
    };
    for (const [gs, ge] of merged) {
      emit(cursor, gs);
      cursor = Math.max(cursor, ge);
    }
    emit(cursor, len);
  }
  return out;
}

// ── Seed rooms ──────────────────────────────────────────────────
// A couple of prebuilt rooms so the library isn't empty on first load. Fixed
// ids + zero timestamps make them merge-friendly: every fresh install seeds
// the SAME rooms, and any persisted copy (updatedAt from a real edit, or an
// equal 0) wins over a pristine seed — so seeds never duplicate across
// devices or clobber an edited copy in Firestore.
export function seedRooms(): Room[] {
  const now = 0;
  const obj = (kind: string, x: number, y: number, rotation = 0, w?: number, h?: number, behavior?: Behavior): PlacedObject => {
    const def = paletteById[kind];
    return {
      id: newObjectId(), kind, x, y, rotation, w: w ?? def?.defaultW ?? 1, h: h ?? def?.defaultH ?? 1,
      ...(def?.render === "npc" ? { behavior: behavior ?? DEFAULT_BEHAVIOR } : {}),
    };
  };
  const shooterHouse: PlacedObject[] = [
    obj("Concrete", 12, 1, 0, 20),
    obj("Concrete", 12, 15, 0, 20),
    obj("Concrete", 2, 8, 90, 14),
    obj("Concrete", 22, 8, 90, 14),
    obj("Drywall", 12, 8, 90, 9),
    obj("Brown Door", 12, 11.5, 90),
    obj("Table01", 6, 5),
    obj("Sofa01", 17, 10),
    obj("Chair01", 18, 5),
    obj("Hostile", 5, 4, 0, undefined, undefined, "hostile"),
    obj("Bobby", 6, 11, 0, undefined, undefined, "compliant"),
    obj("start", 12, 14),
  ];
  const openBay: PlacedObject[] = [
    obj("Cinderblock", 12, 1, 0, 20),
    obj("Cinderblock", 12, 15, 0, 20),
    obj("Table02", 8, 8),
    obj("Closet01", 16, 8),
    obj("start", 12, 13),
  ];
  return [
    { id: "room-seed-shooter-house-a", name: "Shooter House A", width: ROOM_W, height: ROOM_H, objects: shooterHouse, createdAt: now, updatedAt: now },
    { id: "room-seed-open-bay", name: "Open Bay", width: ROOM_W, height: ROOM_H, objects: openBay, createdAt: now, updatedAt: now },
  ];
}
