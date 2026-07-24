import React from "react";
import { Circle, G, Line, Path } from "react-native-svg";
import { CELL, toSvgX, toSvgY } from "../rooms";
import { colors } from "../theme";
import type { TrackMark } from "../tracking";

const FOV_HALF = 45; // half the field-of-view cone angle (degrees) → 90° cone
const FOV_R = CELL * 2.4; // cone reach
const GUN_R = CELL * 1.7; // gun line length

// Headset tracking, drawn on the room canvas: a fading breadcrumb trail, the
// field-of-view cone (where they're looking), a gun-direction line (where the
// weapon points), and a position dot. Drives both live and replay views.
export function LiveTrackingLayer({ headsets }: { headsets: TrackMark[] }) {
  return (
    <G>
      {headsets.map((h) => (
        <HeadsetMark key={h.id} h={h} />
      ))}
    </G>
  );
}

function HeadsetMark({ h }: { h: TrackMark }) {
  const cx = toSvgX(h.x);
  const cy = toSvgY(h.y);
  const r = CELL * 0.26;

  // FOV cone: a sector centered on the view heading.
  const a0 = ((h.facing - FOV_HALF) * Math.PI) / 180;
  const a1 = ((h.facing + FOV_HALF) * Math.PI) / 180;
  const p0x = cx + FOV_R * Math.cos(a0);
  const p0y = cy + FOV_R * Math.sin(a0);
  const p1x = cx + FOV_R * Math.cos(a1);
  const p1y = cy + FOV_R * Math.sin(a1);
  const cone = `M ${cx} ${cy} L ${p0x} ${p0y} A ${FOV_R} ${FOV_R} 0 0 1 ${p1x} ${p1y} Z`;

  // Gun direction: a line with an arrowhead, distinct from the cone.
  const gr = (h.gunAngle * Math.PI) / 180;
  const gx = cx + GUN_R * Math.cos(gr);
  const gy = cy + GUN_R * Math.sin(gr);

  // Trail as segments fading toward the head (older = fainter).
  const segs: React.ReactNode[] = [];
  for (let i = 1; i < h.trail.length; i++) {
    const a = h.trail[i - 1];
    const b = h.trail[i];
    segs.push(
      <Line
        key={i}
        x1={toSvgX(a.x)}
        y1={toSvgY(a.y)}
        x2={toSvgX(b.x)}
        y2={toSvgY(b.y)}
        stroke={colors.teal}
        strokeWidth={2}
        strokeLinecap="round"
        opacity={(i / h.trail.length) * 0.5}
      />
    );
  }

  return (
    <G>
      {segs}
      {/* field of view */}
      <Path d={cone} fill={colors.teal} opacity={0.14} />
      <Path d={cone} fill="none" stroke={colors.teal} strokeWidth={1} opacity={0.35} />
      {/* gun direction */}
      <Line x1={cx} y1={cy} x2={gx} y2={gy} stroke={colors.sky} strokeWidth={2.5} strokeLinecap="round" />
      <Path
        d={`M ${gx} ${gy} L ${gx - Math.cos(gr - 0.5) * 6} ${gy - Math.sin(gr - 0.5) * 6} L ${gx - Math.cos(gr + 0.5) * 6} ${gy - Math.sin(gr + 0.5) * 6} Z`}
        fill={colors.sky}
      />
      {/* position dot */}
      <Circle cx={cx} cy={cy} r={r} fill={colors.teal} opacity={0.3} />
      <Circle cx={cx} cy={cy} r={r * 0.55} fill={colors.teal} stroke={colors.canvas} strokeWidth={1.5} />
    </G>
  );
}
