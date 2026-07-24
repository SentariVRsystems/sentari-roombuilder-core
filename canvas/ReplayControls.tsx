import { useRef } from "react";
import { GestureResponderEvent, Pressable, View } from "react-native";
import type { View as RNView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme";
import { Kicker, Mono } from "../ui/Text";

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// Playback bar for a recorded run: play/pause, restart, a tap-to-seek scrubber,
// and a time readout. Close returns to the editor.
export function ReplayControls({
  t,
  duration,
  playing,
  onToggle,
  onSeek,
  onRestart,
  onClose,
}: {
  t: number;
  duration: number;
  playing: boolean;
  onToggle: () => void;
  onSeek: (t: number) => void;
  onRestart: () => void;
  onClose: () => void;
}) {
  const barRef = useRef<RNView>(null);
  const pct = duration > 0 ? Math.min(1, t / duration) : 0;

  // Measure the bar in the window and use pageX — RN Web's Pressable onPress
  // doesn't reliably populate nativeEvent.locationX.
  const seek = (e: GestureResponderEvent) => {
    if (duration <= 0 || !barRef.current) return;
    const pageX = e.nativeEvent.pageX;
    barRef.current.measureInWindow((x, _y, w) => {
      if (w > 0 && Number.isFinite(pageX)) {
        const frac = Math.max(0, Math.min(1, (pageX - x) / w));
        onSeek(frac * duration);
      }
    });
  };

  return (
    <View>
      <View className="flex-row items-center justify-between mb-2">
        <Kicker>REPLAY</Kicker>
        <Pressable onPress={onClose} hitSlop={6} className="flex-row items-center gap-1 px-2 py-1 rounded-lg active:bg-elevated">
          <Ionicons name="close" size={14} color="rgba(247,249,251,0.6)" />
          <Mono className="text-brand-snow/60 text-[11px]">Close</Mono>
        </Pressable>
      </View>
      <View className="flex-row items-center gap-3">
        <Pressable onPress={onToggle} hitSlop={6} className="w-9 h-9 rounded-full items-center justify-center bg-brand-teal active:bg-brand-teal/85">
          <Ionicons name={playing ? "pause" : "play"} size={18} color="#0E1726" />
        </Pressable>
        <Pressable onPress={onRestart} hitSlop={6} className="w-9 h-9 rounded-full items-center justify-center border border-hairline active:bg-elevated">
          <Ionicons name="play-back" size={16} color={colors.snow} />
        </Pressable>

        {/* Scrubber */}
        <Pressable
          ref={barRef}
          className="flex-1"
          onPress={seek}
          style={{ paddingVertical: 8 }}
        >
          <View style={{ height: 5, borderRadius: 3, backgroundColor: colors.elevated, overflow: "hidden" }}>
            <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct * 100}%`, backgroundColor: colors.teal }} />
          </View>
        </Pressable>

        <Mono className="text-brand-snow/70 text-[11px]" style={{ minWidth: 74, textAlign: "right" }}>
          {fmt(t)} / {fmt(duration)}
        </Mono>
      </View>
    </View>
  );
}
