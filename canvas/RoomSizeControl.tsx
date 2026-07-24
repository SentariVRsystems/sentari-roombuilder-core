import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { cellsToMeters, MAX_ROOM_CELLS, MIN_ROOM_CELLS, type Room } from "../rooms";
import { colors } from "../theme";
import { Kicker, Mono, Muted } from "../ui/Text";

// Compact per-room size control: nudge width/height in 0.5 m steps (one grid
// cell), or snap the room to the selected squad's smallest play area. Sizes are
// stored in cells; this surface talks in meters.
export function RoomSizeControl({
  room,
  onSetSize,
  fit,
  onFit,
}: {
  room: Room;
  onSetSize: (width: number, height: number) => void;
  fit: { width: number; height: number } | null;
  onFit: () => void;
}) {
  const stepW = (d: number) => onSetSize(room.width + d, room.height);
  const stepH = (d: number) => onSetSize(room.width, room.height + d);
  const canFit = !!fit && (fit.width !== room.width || fit.height !== room.height);

  return (
    <View className="flex-row items-center gap-x-3 gap-y-2 flex-wrap">
      <Kicker>ROOM SIZE</Kicker>
      <Dim
        label="W"
        meters={cellsToMeters(room.width)}
        onDec={() => stepW(-1)}
        onInc={() => stepW(1)}
        canDec={room.width > MIN_ROOM_CELLS}
        canInc={room.width < MAX_ROOM_CELLS}
      />
      <Dim
        label="H"
        meters={cellsToMeters(room.height)}
        onDec={() => stepH(-1)}
        onInc={() => stepH(1)}
        canDec={room.height > MIN_ROOM_CELLS}
        canInc={room.height < MAX_ROOM_CELLS}
      />
      {fit && (
        <Pressable
          onPress={onFit}
          disabled={!canFit}
          className={`flex-row items-center gap-1.5 h-9 px-3 rounded-xl border ${canFit ? "border-brand-teal/50 active:bg-elevated" : "border-hairline opacity-40"}`}
        >
          <Ionicons name="resize" size={13} color={colors.teal} />
          <Mono className="text-brand-teal text-[11px]">
            Fit to squad · {cellsToMeters(fit.width).toFixed(1)} × {cellsToMeters(fit.height).toFixed(1)} m
          </Mono>
        </Pressable>
      )}
    </View>
  );
}

function Dim({
  label,
  meters,
  onDec,
  onInc,
  canDec,
  canInc,
}: {
  label: string;
  meters: number;
  onDec: () => void;
  onInc: () => void;
  canDec: boolean;
  canInc: boolean;
}) {
  return (
    <View className="flex-row items-center gap-1.5">
      <Muted className="text-[11px]">{label}</Muted>
      <Step icon="remove" onPress={onDec} disabled={!canDec} />
      <Mono className="text-brand-snow text-[12px] text-center" style={{ minWidth: 44 }}>
        {meters.toFixed(1)} m
      </Mono>
      <Step icon="add" onPress={onInc} disabled={!canInc} />
    </View>
  );
}

function Step({ icon, onPress, disabled }: { icon: "remove" | "add"; onPress: () => void; disabled: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      className={`w-8 h-8 rounded-lg border items-center justify-center ${disabled ? "border-hairline opacity-35" : "border-hairline active:bg-elevated"}`}
    >
      <Ionicons name={icon} size={14} color="rgba(247,249,251,0.7)" />
    </Pressable>
  );
}
