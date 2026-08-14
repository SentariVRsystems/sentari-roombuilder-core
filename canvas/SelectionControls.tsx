import { Image, Pressable, View } from "react-native";
import { thumbFor } from "../assets/thumbs";
import { BEHAVIORS, CELL_METERS, isNpcKind, paletteById, type Behavior, type PlacedObject } from "../rooms";
import { Button } from "../ui/Button";
import { Body, Kicker, Muted } from "../ui/Text";

// Controls for the currently-selected object: rotate/delete, plus — for a
// target — a behavior picker that mirrors Build & Breach's in-game
// NPCBehaviorToggle. Free rotation lives on the canvas: the ⟳ knob on the
// selected object, or Shift+drag (see RoomCanvas).
//
// `onSetBehavior` is optional: an app that hasn't wired target dispositions
// simply omits it and the picker doesn't render.
export function SelectionControls({
  object,
  onDelete,
  onSetBehavior,
}: {
  object: PlacedObject | null;
  // Rotation deliberately has no button here anymore — the canvas knob (and
  // Shift+drag) replaced the old Rotate 90° step. Accepted-and-ignored so
  // callers that still pass it keep compiling.
  onRotate?: (id: string) => void;
  onDelete: (id: string) => void;
  onSetBehavior?: (id: string, behavior: Behavior) => void;
}) {
  if (!object) {
    return <Muted className="text-[12px]">Tap to select · drag to move · drag the ⟳ knob to rotate freely.</Muted>;
  }
  const def = paletteById[object.kind];
  const isTarget = isNpcKind(object.kind);
  const current: Behavior = object.behavior ?? "random";
  const thumb = thumbFor(object.kind);
  const isFurniture = def?.section === "Furniture";

  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2 flex-wrap">
        {/* The build-menu thumbnail — on a map of same-colored rects, this is
            what says WHICH table is selected. */}
        {thumb && <Image source={thumb} style={{ width: 30, height: 30 }} resizeMode="contain" />}
        <Body className="text-brand-snow mr-1">{def?.label ?? object.kind}</Body>
        {isFurniture && (
          <Muted className="text-[11px] mr-1">
            {(object.w * CELL_METERS).toFixed(1)} × {(object.h * CELL_METERS).toFixed(1)} m
          </Muted>
        )}
        <Muted className="text-[11px] mr-1">{Math.round(object.rotation)}°</Muted>
        <Button label="Delete" variant="danger" icon="trash" onPress={() => onDelete(object.id)} className="h-9 px-3" />
      </View>

      {isTarget && onSetBehavior && (
        <View>
          <Kicker className="mb-1.5">BEHAVIOR</Kicker>
          <View className="flex-row flex-wrap gap-1.5">
            {BEHAVIORS.map((b) => {
              const active = b.id === current;
              return (
                <Pressable
                  key={b.id}
                  onPress={() => onSetBehavior(object.id, b.id)}
                  className={`flex-row items-center gap-1.5 rounded-lg border px-2.5 h-8 ${
                    active ? "border-brand-teal bg-brand-teal/15" : "border-hairline bg-surface active:bg-elevated"
                  }`}
                >
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: b.color }} />
                  <Body className={`text-[12px] ${active ? "text-brand-teal" : "text-brand-snow/80"}`}>{b.label}</Body>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}
    </View>
  );
}
