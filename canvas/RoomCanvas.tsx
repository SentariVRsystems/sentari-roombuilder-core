import React, { useEffect, useMemo, useRef, useState } from "react";
import { GestureResponderEvent, LayoutChangeEvent, PanResponder, Pressable, Text, View } from "react-native";
import type { View as RNView } from "react-native";
import Svg, { Circle, G, Line, Path, Rect } from "react-native-svg";
import { CELL, CELL_METERS, isNpcKind, paletteById, toSvgX, toSvgY, type PlacedObject, type Room } from "../rooms";
import { colors } from "../theme";
import { RoomObject } from "./RoomObject";
import { LiveTrackingLayer } from "./LiveTrackingLayer";
import type { NpcPositions, TrackMark } from "../tracking";
import { boundsCellPolygon, type BoundsPoint, type DoorAngles } from "../protocol";

type DragState = { id: string; mode: "move" | "rotate"; dcx: number; dcy: number; rot: number; moved: boolean };

// Zoom range. The floor is set by how far out the grid stays meaningful rather
// than by any room limit — at 0.3 a max-size 24 m room still fits with room to
// spare around it. The ceiling is where one 0.5 m cell fills a good chunk of the
// card, which is as close as placing furniture ever needs.
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.15; // per −/+ button press, where a discrete step is wanted
// Wheel zoom scales with how far you actually scrolled, rather than taking one
// fixed step per event. A trackpad emits a STREAM of small-delta events for a
// single flick, so a constant factor per event compounded — ten events of a
// lazy two-finger scroll multiplied out to 4x and the room shot away from you.
const WHEEL_SENSITIVITY = 0.001; // per pixel: a ~100px mouse notch ≈ 10%
const MAX_WHEEL_PX = 60; // clamp momentum spikes so one flick can't jump the view

// Normalize a wheel event to pixels. deltaMode 1 = lines, 2 = pages; a mouse
// reporting lines would otherwise scroll ~3 and register as 3 pixels of zoom.
const wheelPixels = (e: WheelEvent) => {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  return Math.max(-MAX_WHEEL_PX, Math.min(MAX_WHEEL_PX, e.deltaY * unit));
};
// Below this many pixels the 0.5 m lines stop reading as a grid and start
// reading as grey fill, so only the 1 m lines are drawn.
const MINOR_LINE_MIN_PX = 7;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

type Props = {
  room: Room;
  selectedObjectId: string | null;
  live: TrackMark[] | null; // headset marks to overlay (live or replay)
  npcOverride?: NpcPositions; // move targets to their live/replay positions (by object id)
  doorAngles?: DoorAngles; // live swing angle per door id — draws the leaf where it is
  bounds?: BoundsPoint[]; // the trainee's real space, meters, in walk order
  mode?: "edit" | "wall" | "shiftRoom"; // wall = two-point wall placement; shiftRoom = drag moves EVERY object
  wallStart?: { x: number; y: number } | null; // first wall point, awaiting the second
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onRotate?: (id: string, rotation: number) => void;
  onCanvasPoint?: (x: number, y: number) => void; // a click on the ground (wall mode)
  onShiftAll?: (dx: number, dy: number) => void; // shift-room drag committed (cells)
  readOnly?: boolean; // replay mode — no editing overlays
};

// The top-down room stage. The SVG layer is purely visual; interaction rides
// on absolutely-positioned View overlays (PanResponder on SVG nodes is flaky on
// web). Object overlays handle tap-to-select, drag-to-move, and Shift+drag to
// rotate freely. In wall mode, clicks on the ground place a two-point wall.
export function RoomCanvas({ room, selectedObjectId, live, npcOverride, doorAngles, bounds, mode = "edit", wallStart, onSelect, onMove, onRotate, onCanvasPoint, onShiftAll, readOnly }: Props) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Canvas pan, in cells. The whole stage (grid, room, bounds, tracking) drags
  // together — the trainee's real-space outline can extend past the room grid,
  // and without panning it was simply cropped off-screen.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panRef = useRef(pan);
  panRef.current = pan;
  // View zoom, independent of the room. 1 = the room exactly fills the card (the
  // old fixed behaviour); below 1 you see grid BEYOND the room's edge, which is
  // how you build outward. The point of this is to decouple how big a cell LOOKS
  // from how big the room is — a 24 m room and a 4 m room now draw the same
  // sized squares, and one square always means half a metre.
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null); // mirror, for commit outside setState
  // Shift-room: the whole layout rides the drag as a live preview, committed
  // once on release. Lets a pre-built room be slid into the bounds outline.
  const [shiftPreview, setShiftPreview] = useState<{ dx: number; dy: number } | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const setDragBoth = (d: DragState | null) => {
    dragRef.current = d;
    setDrag(d);
  };
  const containerRef = useRef<RNView>(null);
  const originRef = useRef({ x: 0, y: 0 }); // canvas top-left in window coords
  const shiftRef = useRef(false);
  // Per-room grid dimensions (cells) → SVG viewBox at zoom 1.
  const roomW = room.width;
  const roomH = room.height;
  const VBW = roomW * CELL;
  const VBH = roomH * CELL;
  // Pixels per cell at the current zoom. The container's aspect matches the
  // viewBox's, so x and y share one scale and every hit-test below can use it.
  const pxPerCell = size.w > 0 ? (size.w / roomW) * zoom : 0;
  // Mirrors for the wheel handler, which is a DOM listener and so can't close
  // over render state.
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const roomWRef = useRef(roomW);
  roomWRef.current = roomW;

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

  // Zoom about a point (in container px), keeping whatever cell is under that
  // point pinned there. Anchoring to the cursor is what makes wheel-zoom feel
  // like a map instead of like a slider — you zoom into what you're looking at.
  const zoomAt = (mx: number, my: number, factor: number) => {
    const base = sizeRef.current.w > 0 ? sizeRef.current.w / roomWRef.current : 0;
    if (!base) return;
    const z0 = zoomRef.current;
    const z1 = clampZoom(z0 * factor);
    if (z1 === z0) return; // already against a stop
    const px0 = base * z0;
    const px1 = base * z1;
    const p = panRef.current;
    // The cell under the cursor, before and after, solved for the new pan.
    const next = { x: mx / px1 - (mx / px0 - p.x), y: my / px1 - (my / px0 - p.y) };
    zoomRef.current = z1;
    panRef.current = next;
    setZoom(z1);
    setPan(next);
  };

  const resetView = () => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Wheel to zoom (web). Attached to the node rather than passed as a prop
  // because RN has no onWheel, and non-passive so the page doesn't scroll out
  // from under the canvas while you're working in it.
  useEffect(() => {
    const node = containerRef.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== "function") return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-wheelPixels(e) * WHEEL_SENSITIVITY));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
    // zoomAt reads everything it needs from refs, so this binds once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Gridlines every cell (0.5 m); every 2nd line (= 1 m) is drawn heavier. The
  // grid spans the VISIBLE window, not the room — zooming out has to show the
  // floor you're about to build onto, not stop at the current edge.
  const grid = useMemo(() => {
    if (zoom <= 0) return null;
    const viewW = roomW / zoom;
    const viewH = roomH / zoom;
    // One cell of slack each side so lines never pop in at the edges.
    const x0 = Math.floor(-pan.x) - 1;
    const y0 = Math.floor(-pan.y) - 1;
    const x1 = Math.ceil(-pan.x + viewW) + 1;
    const y1 = Math.ceil(-pan.y + viewH) + 1;
    // Line widths are in user units, which the viewBox scales — divide by zoom
    // so a gridline is the same thickness on screen at every zoom level.
    const major = 1 / zoom;
    const minor = 0.5 / zoom;
    const showMinor = (size.w / roomW) * zoom >= MINOR_LINE_MIN_PX;
    const lines: React.ReactNode[] = [];
    for (let i = x0; i <= x1; i++) {
      if (i % 2 !== 0 && !showMinor) continue;
      lines.push(
        <Line key={`v${i}`} x1={i * CELL} y1={y0 * CELL} x2={i * CELL} y2={y1 * CELL} stroke={colors.hairline} strokeWidth={i % 2 === 0 ? major : minor} />
      );
    }
    for (let j = y0; j <= y1; j++) {
      if (j % 2 !== 0 && !showMinor) continue;
      lines.push(
        <Line key={`h${j}`} x1={x0 * CELL} y1={j * CELL} x2={x1 * CELL} y2={j * CELL} stroke={colors.hairline} strokeWidth={j % 2 === 0 ? major : minor} />
      );
    }
    return lines;
  }, [roomW, roomH, zoom, pan.x, pan.y, size.w]);

  // Scale reference drawn as constant-size px overlays (not SVG units, so the
  // labels stay legible at any zoom). The bar's LENGTH tracks real distance:
  // 1 m, or 2 m once the room is ~10 m across.
  const roomWm = roomW * CELL_METERS;
  const roomHm = roomH * CELL_METERS;
  const barMeters = roomWm >= 10 ? 2 : 1;
  const barPx = (barMeters / CELL_METERS) * pxPerCell;

  // Bounds corners -> SVG, CENTERED on the room grid — resizing the room adds
  // grid on all sides of the outline (matching how the grid itself grows from
  // its middle). The instructor drags the ROOM into the outline (shift-room
  // mode); the push payload carries where the room ended up relative to the
  // outline, so the built house lands to match.
  const boundsPath = useMemo(() => {
    const poly = bounds ? boundsCellPolygon(bounds, roomW, roomH) : null;
    if (!poly) return null;
    const pts = poly.pts.map((p) => `${toSvgX(p.x)} ${toSvgY(p.y)}`);
    return `M ${pts.join(" L ")} Z`;
  }, [bounds, roomW, roomH]);

  // Object with its live drag/rotate override applied.
  const displayObject = (o: PlacedObject): PlacedObject => {
    // Shift-room drag: every object rides the delta together.
    if (shiftPreview && mode === "shiftRoom") o = { ...o, x: o.x + shiftPreview.dx, y: o.y + shiftPreview.dy };
    // A live/replay NPC position overrides the authored one — the marker moves to
    // where the target actually is, facing its heading. Not draggable meanwhile.
    const ov = npcOverride && isNpcKind(o.kind) ? npcOverride[o.id] : undefined;
    // Live behavior overrides the authored one — a "random" target recolors to
    // its rolled disposition the moment the mission starts.
    if (ov) return { ...o, x: ov.x, y: ov.y, rotation: ov.facing, ...(ov.beh ? { behavior: ov.beh as PlacedObject["behavior"] } : {}) };
    if (drag?.id !== o.id) return o;
    if (drag.mode === "move") return { ...o, x: o.x + drag.dcx, y: o.y + drag.dcy };
    return { ...o, rotation: drag.rot };
  };

  // A click on the ground: in wall mode, feed the point to the room builder.
  // (Pan offset is subtracted so a point lands where the cursor shows it.)
  const handleGround = (e: GestureResponderEvent) => {
    if (mode !== "wall" || !onCanvasPoint) {
      onSelect(null);
      return;
    }
    const px = e.nativeEvent.pageX;
    const py = e.nativeEvent.pageY;
    containerRef.current?.measureInWindow((ox, oy) => {
      if (pxPerCell > 0 && Number.isFinite(px))
        onCanvasPoint((px - ox) / pxPerCell - panRef.current.x, (py - oy) / pxPerCell - panRef.current.y);
    });
  };

  // Ground gestures: a DRAG grabs the grid and pans the stage — or, in
  // shift-room mode, slides the whole layout — and a plain CLICK keeps the old
  // behavior (deselect, or drop a wall point in wall mode).
  const groundCb = useRef({ handleGround, onShiftAll });
  groundCb.current = { handleGround, onShiftAll };
  const groundResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
        onPanResponderGrant: () => {
          panStartRef.current = { ...panRef.current };
        },
        onPanResponderMove: (_, g) => {
          if (pxPerCell <= 0) return;
          if (Math.abs(g.dx) <= 6 && Math.abs(g.dy) <= 6) return;
          if (modeRef.current === "shiftRoom") {
            setShiftPreview({ dx: g.dx / pxPerCell, dy: g.dy / pxPerCell });
            return;
          }
          const s = panStartRef.current;
          if (s) setPan({ x: s.x + g.dx / pxPerCell, y: s.y + g.dy / pxPerCell });
        },
        onPanResponderRelease: (evt, g) => {
          const wasDrag = Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6;
          panStartRef.current = null;
          if (modeRef.current === "shiftRoom") {
            setShiftPreview(null);
            if (wasDrag && pxPerCell > 0) groundCb.current.onShiftAll?.(g.dx / pxPerCell, g.dy / pxPerCell);
            return;
          }
          if (!wasDrag) groundCb.current.handleGround(evt);
        },
        onPanResponderTerminate: () => {
          panStartRef.current = null;
          setShiftPreview(null);
        },
      }),
    [pxPerCell]
  );

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
    const cx = originRef.current.x + (o.x + panRef.current.x) * pxPerCell;
    const cy = originRef.current.y + (o.y + panRef.current.y) * pxPerCell;
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

  // Wall mode keeps NON-wall objects tappable: touching one selects it (the
  // app exits wall mode on that select), so there's always an obvious way out
  // of drawing. Walls themselves stay click-through in wall mode — clicks near
  // them are how new walls snap to existing endpoints/bodies.
  const editable = !readOnly && (mode === "edit" || mode === "wall") && size.w > 0;
  const overlayObjects =
    mode === "wall" ? room.objects.filter((o) => paletteById[o.kind]?.place !== "wall") : room.objects;
  const wallCursor = mode === "wall";

  return (
    <View
      ref={containerRef}
      onLayout={onLayout}
      style={[{ width: "100%", aspectRatio: roomW / roomH, backgroundColor: colors.canvas, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: mode === "wall" || mode === "shiftRoom" ? colors.teal : colors.hairline }, { userSelect: "none" } as any]}
    >
      {/* Pan and zoom both live in the viewBox: the origin is the pan and the
          extent is the zoom. Doing it here rather than as a transform on the
          content means the grid above can be generated for exactly the window
          that's visible. */}
      <Svg
        width="100%"
        height="100%"
        viewBox={`${-pan.x * CELL} ${-pan.y * CELL} ${VBW / zoom} ${VBH / zoom}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <G>
        <G>{grid}</G>
        {/* The trainee's REAL space, walked corner to corner in the headset. Drawn
            under everything as a reference outline — it constrains nothing, it just
            shows how much floor the authored room actually has to fit into. The
            points arrive in meters relative to the start, so they hang off the
            room's start cell (or its centre when no start is placed yet). */}
        {boundsPath && (
          <Path d={boundsPath} fill="none" stroke={colors.snow} strokeWidth={1.4} strokeDasharray="6 4" opacity={0.5} />
        )}
        {/* The room's own edge. Now that grid is drawn past it, this is the line
            that says "this is the house" — so it's brighter than a gridline
            rather than the same weight, and holds its thickness under zoom. */}
        <Rect
          x={0}
          y={0}
          width={VBW}
          height={VBH}
          fill="none"
          stroke="rgba(247,249,251,0.28)"
          strokeWidth={1.5 / zoom}
        />
        {room.objects.map((o) => {
          const d = displayObject(o);
          // A target the trainee killed is drawn struck-through, so the instructor
          // can tell "cleared" from "still standing there" at a glance.
          const ov = npcOverride && isNpcKind(o.kind) ? npcOverride[o.id] : undefined;
          return (
            <RoomObject
              key={o.id}
              o={d}
              selected={o.id === selectedObjectId}
              dead={ov?.alive === false}
              firing={ov?.firing === true}
              detained={ov?.det === true}
              openAngle={doorAngles?.[o.id]}
            />
          );
        })}
        {wallStart && (
          <Circle cx={toSvgX(wallStart.x)} cy={toSvgY(wallStart.y)} r={5} fill={colors.teal} stroke={colors.canvas} strokeWidth={1.5} />
        )}
        {live && <LiveTrackingLayer headsets={live} />}
        </G>
      </Svg>

      {/* Interaction overlays (absolute px). In wall mode, the ground captures
          clicks to place points; object overlays are suppressed. */}
      {size.w > 0 && !readOnly && (
        <View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}>
          <View
            {...groundResponder.panHandlers}
            style={[{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }, wallCursor ? ({ cursor: "crosshair" } as any) : mode === "shiftRoom" ? ({ cursor: "move" } as any) : ({ cursor: "grab" } as any)]}
          />
          {editable &&
            overlayObjects.map((o) => (
              <DragOverlay
                key={o.id}
                object={o}
                pxPerCell={pxPerCell}
                panPx={{ x: pan.x * pxPerCell, y: pan.y * pxPerCell }}
                onGrant={(shiftKey) => onGrant(o.id, shiftKey)}
                onMove={(g) => onDragMove(o.id, g)}
                onEnd={(g) => onDragEnd(o.id, g)}
              />
            ))}
        </View>
      )}

      {/* Zoom controls. Always present (unlike the old recenter chip, which only
          appeared once you'd already panned) — a control you can't see is a
          feature nobody finds. FIT only shows once the view has actually moved. */}
      {size.w > 0 && (
        <View style={{ position: "absolute", right: 8, top: 8, alignItems: "flex-end", gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "rgba(12,18,25,0.85)", borderRadius: 6, borderWidth: 1, borderColor: colors.hairline, overflow: "hidden" }}>
            <ZoomBtn label="−" onPress={() => zoomAt(size.w / 2, size.h / 2, 1 / ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} />
            <Text style={{ color: "rgba(247,249,251,0.75)", fontSize: 10, fontFamily: "JetBrainsMono_500Medium", minWidth: 40, textAlign: "center" }}>
              {Math.round(zoom * 100)}%
            </Text>
            <ZoomBtn label="+" onPress={() => zoomAt(size.w / 2, size.h / 2, ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} />
          </View>
          {(pan.x !== 0 || pan.y !== 0 || zoom !== 1) && (
            <Pressable
              onPress={resetView}
              style={{ backgroundColor: "rgba(12,18,25,0.85)", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: colors.hairline }}
            >
              <Text style={{ color: colors.teal, fontSize: 10, fontFamily: "JetBrainsMono_500Medium" }}>⌖ FIT ROOM</Text>
            </Pressable>
          )}
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

function ZoomBtn({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{ width: 24, height: 22, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.3 : 1 }}
    >
      <Text style={{ color: colors.snow, fontSize: 13, fontFamily: "JetBrainsMono_500Medium", lineHeight: 15 }}>{label}</Text>
    </Pressable>
  );
}

function DragOverlay({
  object,
  pxPerCell,
  panPx,
  onGrant,
  onMove,
  onEnd,
}: {
  object: PlacedObject;
  pxPerCell: number;
  panPx: { x: number; y: number }; // stage pan, so hitboxes track the drawn object
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
  const left = object.x * pxPerCell + panPx.x - hitW / 2;
  const top = object.y * pxPerCell + panPx.y - hitH / 2;

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
