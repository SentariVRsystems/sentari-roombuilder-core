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
  openAngle,
}: {
  o: PlacedObject;
  selected: boolean;
  dead?: boolean;
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
        <Circle cx={cx} cy={cy} r={npcR} fill={fill} stroke={stroke} strokeWidth={1} />
        <Circle cx={cx} cy={cy} r={npcR / 2.6} fill={colors.canvas} opacity={0.6} />
        <Path
          d={`M ${cx + npcR * 0.5} ${cy} L ${cx + npcR * 1.7} ${cy} m ${-npcR * 0.5} ${-npcR * 0.35} L ${cx + npcR * 1.7} ${cy} l ${-npcR * 0.5} ${npcR * 0.35}`}
          stroke={fill}
          strokeWidth={2.5}
          strokeLinecap="round"
          fill="none"
        />
      </>
    ) : isDoorKind(o.kind) ? (
      // A DOOR, drawn like a floor plan: the slab in the opening, a hinge dot at
      // the pivot end, and the arc the leaf sweeps through. The instructor needs
      // to see which way it opens when placing targets behind it — a bare
      // rectangle said "there is a door here" but nothing about the swing.
      //
      // Convention matches the prefab: hinged at the +x end of the door's own
      // frame, swinging clockwise on this y-down map (DoorPhysicsSetup limits
      // 0..DOOR_SWING_DEG about +Y, and a CW map angle is a CW-from-above yaw).
      // The group's rotate() turns the whole symbol with the object.
      <>
        {(() => {
          const hx = cx + w / 2; // hinge end
          const R = w;           // leaf length = door width
          const a = (DOOR_SWING_DEG * Math.PI) / 180;
          // Free end at rest (pointing -x from the hinge) swung CW by the limit.
          const ex = hx - R * Math.cos(a);
          const ey = cy + R * Math.sin(a);
          return (
            <>
              {/* swept area + arc */}
              <Path
                d={`M ${hx} ${cy} L ${hx - R} ${cy} A ${R} ${R} 0 0 1 ${ex} ${ey} Z`}
                fill={fill}
                opacity={0.1}
              />
              <Path
                d={`M ${hx - R} ${cy} A ${R} ${R} 0 0 1 ${ex} ${ey}`}
                fill="none"
                stroke={fill}
                strokeWidth={1.2}
                strokeDasharray="3 2"
                opacity={0.75}
              />
              {/* the leaf at its LIVE angle when the headset is reporting one,
                  otherwise parked at the full-open extent as a static hint */}
              {(() => {
                const live = typeof openAngle === "number";
                const la = ((live ? openAngle! : DOOR_SWING_DEG) * Math.PI) / 180;
                const lx = hx - R * Math.cos(la);
                const ly = cy + R * Math.sin(la);
                return (
                  <Path
                    d={`M ${hx} ${cy} L ${lx} ${ly}`}
                    stroke={fill}
                    strokeWidth={live ? 3 : 1.6}
                    opacity={live ? 0.95 : 0.5}
                    strokeLinecap="round"
                  />
                );
              })()}
              {/* the opening itself — only drawn shut when no live angle says otherwise */}
              {(typeof openAngle !== "number" || Math.abs(openAngle) < 3) && (
                <Rect x={x} y={y} width={w} height={h} rx={2} fill={fill} stroke={stroke} strokeWidth={1} />
              )}
              {/* hinge */}
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
