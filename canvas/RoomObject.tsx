import React from "react";
import { Circle, G, Line, Path, Rect } from "react-native-svg";
import { behaviorColor, CELL, DOOR_SWING_DEG, isDoorKind, paletteById, toSvgX, toSvgY, type PlacedObject } from "../rooms";
import { colors } from "../theme";

// One placed object, drawn in SVG coordinates. Walls and furniture are rects in
// their catalog color; targets are colored by their assigned behavior (so the
// map reads dispositions at a glance); the start marker is a teal spawn glyph.
export function RoomObject({
  o,
  selected,
  dead = false,
  firing = false,
  detained = false,
  openAngle,
}: {
  o: PlacedObject;
  selected: boolean;
  dead?: boolean;
  firing?: boolean; // this target fired since the last batch — flash it
  detained?: boolean; // surrender animation finished — kneeling, hands behind head
  openAngle?: number; // live swing angle from the headset, degrees from closed
}) {
  const def = paletteById[o.kind];
  // Targets take their color from behavior, not the palette swatch.
  const fill = def?.render === "npc" ? behaviorColor(o.behavior) : def?.fill ?? colors.steel;
  const stroke = def?.stroke ?? "rgba(247,249,251,0.28)";
  const cx = toSvgX(o.x);
  const cy = toSvgY(o.y);
  const w = o.w * CELL;
  const h = o.h * CELL;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const sel = selected ? { stroke: colors.teal, strokeWidth: 2 } : null;

  const npcR = Math.min(w, h) / 2;
  const shape =
    def?.render === "start" ? (
      // The trainee START ZONE — a blue floor rectangle (3 ft × 5 ft) the headset
      // shows on the ground; the "house is hot" countdown begins once every
      // player stands inside it. An up-chevron marks the facing direction (into
      // the room); the group's rotate() turns the whole zone with the object.
      <>
        <Rect x={x} y={y} width={w} height={h} rx={CELL * 0.12} fill={fill} opacity={0.2} stroke={stroke} strokeWidth={2} />
        <Path
          d={`M ${cx - CELL * 0.32} ${cy + CELL * 0.12} L ${cx} ${cy - CELL * 0.3} L ${cx + CELL * 0.32} ${cy + CELL * 0.12}`}
          stroke={stroke}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </>
    ) : def?.render === "npc" ? (
      // A person marker — filled disc with a head dot, plus a facing arrow:
      // the headset spawns the NPC looking this way. Drawn along local +x; the
      // group's rotate() turns it with the object.
      <>
        {/* Muzzle flash: a red ring + hot facing arrow for the batch(es) where
            this target fired — the instructor sees WHO is shooting, not just
            that shots are happening somewhere. */}
        {firing && !dead && (
          <Circle cx={cx} cy={cy} r={npcR * 1.55} fill="none" stroke={colors.danger} strokeWidth={2.5} opacity={0.9} />
        )}
        <Circle cx={cx} cy={cy} r={npcR} fill={fill} stroke={stroke} strokeWidth={1} />
        <Circle cx={cx} cy={cy} r={npcR / 2.6} fill={colors.canvas} opacity={0.6} />
        <Path
          d={`M ${cx + npcR * 0.5} ${cy} L ${cx + npcR * 1.7} ${cy} m ${-npcR * 0.5} ${-npcR * 0.35} L ${cx + npcR * 1.7} ${cy} l ${-npcR * 0.5} ${npcR * 0.35}`}
          stroke={firing && !dead ? colors.danger : fill}
          strokeWidth={firing && !dead ? 3.2 : 2.5}
          strokeLinecap="round"
          fill="none"
        />
      </>
    ) : o.kind === "Open Door Frame" ? (
      // An OPEN threshold — no leaf. Two frame posts and a faint dashed line so
      // the gap reads as intentional, not as missing geometry.
      <>
        <Line
          x1={cx - w / 2}
          y1={cy}
          x2={cx + w / 2}
          y2={cy}
          stroke={stroke}
          strokeWidth={1.2}
          strokeDasharray="3 3"
          opacity={0.6}
        />
        <Circle cx={cx - w / 2} cy={cy} r={2.6} fill={colors.snow} opacity={0.9} />
        <Circle cx={cx + w / 2} cy={cy} r={2.6} fill={colors.snow} opacity={0.9} />
      </>
    ) : isDoorKind(o.kind) ? (
      // A DOOR: just the leaf, where it actually is. No swept arc, no preview of
      // where it COULD go — a map full of speculative arcs is noise; what the
      // instructor needs is the current state. Closed (or before a run, when the
      // headset isn't reporting) the leaf lies in the opening; during a run it
      // tracks the real hinge angle.
      //
      // Hinged at the +x end of the door's own frame, opening clockwise on this
      // y-down map — matching the prefab's hinge. The group's rotate() carries
      // the whole symbol with the object.
      <>
        {(() => {
          const hx = cx + w / 2;                    // hinge end
          const R = w;                              // leaf length = door width
          const a = ((openAngle ?? 0) * Math.PI) / 180;
          // The leaf lies along -x from the hinge when shut. Opening rotates it
          // CLOCKWISE on this y-down canvas, which is -sin: the headset reports a
          // Unity yaw delta (positive = clockwise seen from above) and the map view
          // preserves that handedness, so +sin swung it the wrong way round.
          const lx = hx - R * Math.cos(a);
          const ly = cy - R * Math.sin(a);
          const open = Math.abs(openAngle ?? 0) > 3;
          return (
            <>
              <Path
                d={`M ${hx} ${cy} L ${lx} ${ly}`}
                stroke={open ? colors.teal : fill}
                strokeWidth={open ? 3.5 : Math.max(h, 3)}
                opacity={open ? 1 : 0.95}
                strokeLinecap="round"
              />
              <Circle cx={hx} cy={cy} r={2.6} fill={colors.snow} opacity={0.9} />
            </>
          );
        })()}
      </>
    ) : (
      <Rect x={x} y={y} width={w} height={h} rx={2} fill={fill} stroke={stroke} strokeWidth={1} />
    );

  // A KILLED target: faded, with a red X over it. The marker stays at the spot it
  // fell (the headset keeps reporting its last pose), so the map distinguishes
  // "cleared" from "still up" instead of a target simply vanishing.
  const kx = npcR * 0.62;
  return (
    <G transform={`rotate(${o.rotation} ${cx} ${cy})`}>
      <G opacity={dead ? 0.32 : 1}>{shape}</G>
      {/* DETAINED: kneeling with hands behind the head — a handcuff glyph (two
          linked rings) beside the disc, in teal so it reads as "secured", not a
          casualty. Counter-rotated so the cuffs stay upright on screen. */}
      {detained && !dead && (
        <G transform={`rotate(${-o.rotation} ${cx} ${cy})`}>
          <Circle cx={cx - npcR * 0.42} cy={cy + npcR * 1.5} r={npcR * 0.34} fill="none" stroke={colors.teal} strokeWidth={1.8} />
          <Circle cx={cx + npcR * 0.42} cy={cy + npcR * 1.5} r={npcR * 0.34} fill="none" stroke={colors.teal} strokeWidth={1.8} />
          <Line x1={cx - npcR * 0.1} y1={cy + npcR * 1.5} x2={cx + npcR * 0.1} y2={cy + npcR * 1.5} stroke={colors.teal} strokeWidth={1.8} />
        </G>
      )}
      {dead && (
        <G transform={`rotate(${-o.rotation} ${cx} ${cy})`} opacity={0.95}>
          <Line x1={cx - kx} y1={cy - kx} x2={cx + kx} y2={cy + kx} stroke={colors.danger} strokeWidth={2.2} strokeLinecap="round" />
          <Line x1={cx - kx} y1={cy + kx} x2={cx + kx} y2={cy - kx} stroke={colors.danger} strokeWidth={2.2} strokeLinecap="round" />
        </G>
      )}
      {sel && <Rect x={x - 3} y={y - 3} width={w + 6} height={h + 6} rx={3} fill="none" {...sel} strokeDasharray="4 3" />}
    </G>
  );
}
