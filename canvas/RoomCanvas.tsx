import React, { useEffect, useMemo, useRef, useState } from "react";
import { GestureResponderEvent, LayoutChangeEvent, PanResponder, Pressable, Text, View } from "react-native";
import type { View as RNView } from "react-native";
import Svg, { Circle, G, Line, Rect } from "react-native-svg";
import { CELL, CELL_METERS, isNpcKind, toSvgX, toSvgY, type PlacedObject, type Room } from "../rooms";
import { colors } from "../theme";
import { RoomObject } from "./RoomObject";
import { LiveTrackingLayer } from "./LiveTrackingLayer";
import type { NpcPositions, TrackMark } from "../tracking";

type DragState = { id: string; mode: "move" | "rotate"; dcx: number; dcy: number; rot: number; moved: boolean };

type Props = {
  room: Room;
  selectedObjectId: string | null;
  live: TrackMark[] | null; // headset marks to overlay (live or replay)
  npcOverride?: NpcPositions; // move targets to their live/replay positions (by object id)
  mode?: "edit" | "wall"; // wall = click two points to place a wall
  wallStart?: { x: number; y: number } | null; // first wall point, awaiting the second
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onRotate?: (id: string, rotation: number) => void;
  onCanvasPoint?: (x: number, y: number) => void; // a click on the ground (wall mode)
  readOnly?: boolean; // replay mode — no editing overlays
};

// The top-down room stage. The SVG layer is purely visual; interaction rides
// on absolutely-positioned View overlays (PanResponder on SVG nodes is flaky on
// web). Object overlays handle tap-to-select, drag-to-move, and Shift+drag to
// rotate freely. In wall mode, clicks on the ground place a two-point wall.
export function RoomCanvas({ room, selectedObjectId, live, npcOverride, mode = "edit", wallStart, onSelect, onMove, onRotate, onCanvasPoint, readOnly }: Props) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null); // mirror, for commit outside setState
  const setDragBoth = (d: DragState | null) => {
    dragRef.current = d;
    setDrag(d);
  };
  const containerRef = useRef<RNView>(null);
  const originRef = useRef({ x: 0, y: 0 }); // canvas top-left in window coords
  const shiftRef = useRef(false);
  // Per-room grid dimensions (cells) → SVG viewBox. Cell size is fixed, so a
  // smaller room renders zoomed-in (more px per cell) and a larger one out.
  const roomW = room.width;
  const roomH = room.height;
  const VBW = roomW * CELL;
  const VBH = roomH * CELL;
  const pxPerCell = size.w > 0 ? size.w / roomW : 0;

  // Track the Shift key (web) so a drag can mean "rotate" instead of "move".
  useEffect(() => {
    if (typeof document === "undefined") return;
    const down = (e: KeyboardEvent) => e.key === "Shift" && (shiftRef.current = true);
    const up = (e: KeyboardEvent) => e.key === "Shift" && (shiftRef.current = false);
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    return () => {
      document.removeEventListener("keydown", down);
      document.removeEventListener("keyup", up);
    };
  }, []);

  const measureOrigin = () => containerRef.current?.measureInWindow((x, y) => (originRef.current = { x, y }));

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ w: width, h: height });
    measureOrigin();
  };

  // Gridlines every cell (0.5 m); every 2nd line (= 1 m) is drawn heavier.
  const grid = useMemo(() => {
    const lines: React.ReactNode[] = [];
    for (let i = 0; i <= roomW; i++) {
      lines.push(<Line key={`v${i}`} x1={i * CELL} y1={0} x2={i * CELL} y2={VBH} stroke={colors.hairline} strokeWidth={i % 2 === 0 ? 1 : 0.5} />);
    }
    for (let j = 0; j <= roomH; j++) {
      lines.push(<Line key={`h${j}`} x1={0} y1={j * CELL} x2={VBW} y2={j * CELL} stroke={colors.hairline} strokeWidth={j % 2 === 0 ? 1 : 0.5} />);
    }
    return lines;
  }, [roomW, roomH, VBW, VBH]);

  // Scale reference drawn as constant-size px overlays (not SVG units, so the
  // labels stay legible at any zoom). The bar's LENGTH tracks real distance:
  // 1 m, or 2 m once the room is ~10 m across.
  const roomWm = roomW * CELL_METERS;
  const roomHm = roomH * CELL_METERS;
  const barMeters = roomWm >= 10 ? 2 : 1;
  const barPx = (barMeters / CELL_METERS) * pxPerCell;

  // Object with its live drag/rotate override applied.
  const displayObject = (o: PlacedObject): PlacedObject => {
    // A live/replay NPC position overrides the authored one — the marker moves to
    // where the target actually is, facing its heading. Not draggable meanwhile.
    const ov = npcOverride && isNpcKind(o.kind) ? npcOverride[o.id] : undefined;
    if (ov) return { ...o, x: ov.x, y: ov.y, rotation: ov.facing };
    if (drag?.id !== o.id) return o;
    if (drag.mode === "move") return { ...o, x: o.x + drag.dcx, y: o.y + drag.dcy };
    return { ...o, rotation: drag.rot };
  };

  // A click on the ground: in wall mode, feed the point to the room builder.
  const handleGround = (e: GestureResponderEvent) => {
    if (mode !== "wall" || !onCanvasPoint) {
      onSelect(null);
      return;
    }
    const px = e.nativeEvent.pageX;
    const py = e.nativeEvent.pageY;
    containerRef.current?.measureInWindow((ox, oy) => {
      if (pxPerCell > 0 && Number.isFinite(px)) onCanvasPoint((px - ox) / pxPerCell, (py - oy) / pxPerCell);
    });
  };

  // ── Object drag/rotate handlers (edit mode) ──
  // Shift → rotate. Read it from the pointer event (works with automation and
  // trackpads) and fall back to the tracked keyboard state.
  const onGrant = (id: string, shiftKey: boolean) => {
    measureOrigin();
    const o = room.objects.find((x) => x.id === id);
    onSelect(id);
    setDragBoth({ id, mode: shiftKey || shiftRef.current ? "rotate" : "move", dcx: 0, dcy: 0, rot: o?.rotation ?? 0, moved: false });
  };
  const onDragMove = (id: string, g: { dx: number; dy: number; moveX: number; moveY: number }) => {
    const prev = dragRef.current;
    if (!prev || prev.id !== id) return;
    const moved = prev.moved || Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6;
    if (prev.mode === "move") {
      setDragBoth({ ...prev, dcx: g.dx / pxPerCell, dcy: g.dy / pxPerCell, moved });
      return;
    }
    const o = room.objects.find((x) => x.id === id);
    if (!o) return;
    const cx = originRef.current.x + o.x * pxPerCell;
    const cy = originRef.current.y + o.y * pxPerCell;
    const rot = (Math.atan2(g.moveY - cy, g.moveX - cx) * 180) / Math.PI;
    setDragBoth({ ...prev, rot, moved });
  };
  const onDragEnd = (id: string, g: { dx: number; dy: number }) => {
    const d = dragRef.current;
    if (d && d.id === id && d.moved) {
      const o = room.objects.find((x) => x.id === id);
      if (o && d.mode === "move") onMove(id, o.x + g.dx / pxPerCell, o.y + g.dy / pxPerCell);
      if (o && d.mode === "rotate") onRotate?.(id, d.rot);
    }
    setDragBoth(null);
  };

  const editable = !readOnly && mode === "edit" && size.w > 0;
  const wallCursor = mode === "wall";

  return (
    <View
      ref={containerRef}
      onLayout={onLayout}
      style={[{ width: "100%", aspectRatio: roomW / roomH, backgroundColor: colors.canvas, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: mode === "wall" ? colors.teal : colors.hairline }, { userSelect: "none" } as any]}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${VBW} ${VBH}`} preserveAspectRatio="xMidYMid meet">
        <G>{grid}</G>
        <Rect x={0.5} y={0.5} width={VBW - 1} height={VBH - 1} fill="none" stroke={colors.hairline} strokeWidth={1} />
        {room.objects.map((o) => {
          const d = displayObject(o);
          // A target the trainee killed is drawn struck-through, so the instructor
          // can tell "cleared" from "still standing there" at a glance.
          const ov = npcOverride && isNpcKind(o.kind) ? npcOverride[o.id] : undefined;
          return <RoomObject key={o.id} o={d} selected={o.id === selectedObjectId} dead={ov?.alive === false} />;
        })}
        {wallStart && (
          <Circle cx={toSvgX(wallStart.x)} cy={toSvgY(wallStart.y)} r={5} fill={colors.teal} stroke={colors.canvas} strokeWidth={1.5} />
        )}
        {live && <LiveTrackingLayer headsets={live} />}
      </Svg>

      {/* Interaction overlays (absolute px). In wall mode, the ground captures
          clicks to place points; object overlays are suppressed. */}
      {size.w > 0 && !readOnly && (
        <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}>
          <Pressable
            style={[{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }, wallCursor ? ({ cursor: "crosshair" } as any) : null]}
            onPress={handleGround}
          />
          {editable &&
            room.objects.map((o) => (
              <DragOverlay
                key={o.id}
                object={o}
                pxPerCell={pxPerCell}
                onGrant={(shiftKey) => onGrant(o.id, shiftKey)}
                onMove={(g) => onDragMove(o.id, g)}
                onEnd={(g) => onDragEnd(o.id, g)}
              />
            ))}
        </View>
      )}

      {/* Scale reference — constant-size labels, non-interactive so they never
          block editing. Dimensions top-left, a scale bar bottom-left. */}
      {size.w > 0 && (
        <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}>
          <View style={{ position: "absolute", left: 8, top: 8, backgroundColor: "rgba(12,18,25,0.72)", borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 }}>
            <Text style={{ color: colors.snow, fontSize: 11, fontFamily: "JetBrainsMono_500Medium" }}>
              {roomWm.toFixed(1)} × {roomHm.toFixed(1)} m
            </Text>
          </View>
          <View style={{ position: "absolute", left: 8, bottom: 8, alignItems: "flex-start" }}>
            <Text style={{ color: "rgba(247,249,251,0.75)", fontSize: 10, fontFamily: "JetBrainsMono_500Medium", marginBottom: 2 }}>
              {barMeters} m
            </Text>
            <View style={{ width: barPx, height: 6, borderLeftWidth: 1.5, borderRightWidth: 1.5, borderBottomWidth: 1.5, borderColor: "rgba(247,249,251,0.75)" }} />
          </View>
        </View>
      )}
    </View>
  );
}

function DragOverlay({
  object,
  pxPerCell,
  onGrant,
  onMove,
  onEnd,
}: {
  object: PlacedObject;
  pxPerCell: number;
  onGrant: (shiftKey: boolean) => void;
  onMove: (g: { dx: number; dy: number; moveX: number; moveY: number }) => void;
  onEnd: (g: { dx: number; dy: number }) => void;
}) {
  // Axis-aligned box that covers the object at its current rotation.
  const rad = (object.rotation * Math.PI) / 180;
  const wpx = object.w * pxPerCell;
  const hpx = object.h * pxPerCell;
  const bw = Math.abs(wpx * Math.cos(rad)) + Math.abs(hpx * Math.sin(rad));
  const bh = Math.abs(wpx * Math.sin(rad)) + Math.abs(hpx * Math.cos(rad));
  const hitW = Math.max(bw, 30);
  const hitH = Math.max(bh, 30);
  const left = object.x * pxPerCell - hitW / 2;
  const top = object.y * pxPerCell - hitH / 2;

  const cb = useRef({ onGrant, onMove, onEnd });
  cb.current = { onGrant, onMove, onEnd };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
        onPanResponderGrant: (evt) => cb.current.onGrant(!!(evt?.nativeEvent as any)?.shiftKey),
        onPanResponderMove: (_, g) => cb.current.onMove({ dx: g.dx, dy: g.dy, moveX: g.moveX, moveY: g.moveY }),
        onPanResponderRelease: (_, g) => cb.current.onEnd({ dx: g.dx, dy: g.dy }),
        onPanResponderTerminate: (_, g) => cb.current.onEnd({ dx: g.dx, dy: g.dy }),
      }),
    []
  );

  return (
    <View
      {...responder.panHandlers}
      style={[{ position: "absolute", left, top, width: hitW, height: hitH, cursor: "grab" } as any, { userSelect: "none" } as any]}
    />
  );
}
