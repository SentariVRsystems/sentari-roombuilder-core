import React from "react";
import { Circle, G, Image as SvgImage, Line, Path, Rect } from "react-native-svg";
import { thumbFor } from "../assets/thumbs";
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
  // Targets take their color from behavior, not the palette swatch. A captured
  // target goes white — custody overrides disposition on the map.
  const fill =
    def?.render === "npc"
      ? detained && !dead
        ? colors.snow
        : behaviorColor(o.behavior)
      : def?.fill ?? colors.steel;
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
      // The trainee START ZONE — a blue floor rectangle (START_ZONE_FT) the headset
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
      // FURNITURE: the rect stays — it's the true footprint, the thing
      // clearances are planned against — and the game's build-menu thumbnail is
      // drawn inside it, because on a map of same-colored rects the fill can't
      // say which of thirteen sofas this one is. Rotates with the group, so the
      // icon also shows which way the piece faces. Walls have no thumbnail and
      // keep the plain swatch rect.
      (() => {
        const thumb = thumbFor(o.kind);
        const pad = Math.min(w, h) * 0.08;
        return (
          <>
            <Rect x={x} y={y} width={w} height={h} rx={2} fill={fill} stroke={stroke} strokeWidth={1} />
            {thumb && (
              <SvgImage
                href={thumb}
                x={x + pad}
                y={y + pad}
                width={w - pad * 2}
                height={h - pad * 2}
                preserveAspectRatio="xMidYMid meet"
                opacity={0.95}
              />
            )}
          </>
        );
      })()
    );

  // A KILLED target: faded, with a red X over it. The marker stays at the spot it
  // fell (the headset keeps reporting its last pose), so the map distinguishes
  // "cleared" from "still up" instead of a target simply vanishing.
  const kx = npcR * 0.62;
  return (
    <G transform={`rotate(${o.rotation} ${cx} ${cy})`}>
      <G opacity={dead || detained ? 0.32 : 1}>{shape}</G>
      {/* CAPTURED: secured in custody — the disc goes white and a bright white
          ring circles it, the custody counterpart of the dead marker's red X. */}
      {detained && !dead && (
        <Circle cx={cx} cy={cy} r={npcR * 0.85} fill="none" stroke={colors.snow} strokeWidth={2.2} opacity={0.95} />
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
