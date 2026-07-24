import { View } from "react-native";
import { paletteById, type PlacedObject } from "../rooms";
import { Button } from "../ui/Button";
import { Body, Muted } from "../ui/Text";

// Controls for the currently-selected object: a 90° rotate snap and delete.
// Free rotation is Shift+drag on the object itself (see RoomCanvas).
export function SelectionControls({
  object,
  onRotate,
  onDelete,
}: {
  object: PlacedObject | null;
  onRotate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (!object) {
    return <Muted className="text-[12px]">Tap to select · drag to move · Shift+drag to rotate freely.</Muted>;
  }
  const def = paletteById[object.kind];
  return (
    <View className="flex-row items-center gap-2 flex-wrap">
      <Body className="text-brand-snow mr-1">{def?.label ?? object.kind}</Body>
      <Muted className="text-[11px] mr-1">{Math.round(object.rotation)}°</Muted>
      <Button label="Rotate 90°" variant="secondary" icon="refresh" onPress={() => onRotate(object.id)} className="h-9 px-3" />
      <Button label="Delete" variant="danger" icon="trash" onPress={() => onDelete(object.id)} className="h-9 px-3" />
    </View>
  );
}
