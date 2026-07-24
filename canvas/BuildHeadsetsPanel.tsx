import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme";
import { Card } from "../ui/Card";
import { Body, Kicker, Mono, Muted } from "../ui/Text";
import type { TrackedHeadset } from "../tracking";

// The roster of headsets that opted into the builder-run mode (wire status
// "building"). `live` means a room is pushed and they're being tracked in it;
// `replaying` means a finished run is being reviewed.
//
// The MODE NAME is a prop because the two apps call it different things for
// different audiences: Sentari Command says "Instructor-Led" (someone else is
// running your session), Build & Breach Builder says "Builder Mode" (you are).
// It's the same wire value either way — one headset build serves both.
export function BuildHeadsetsPanel({
  headsets,
  live,
  replaying,
  modeName = "Instructor-Led",
  subject = "Trainees",
}: {
  headsets: TrackedHeadset[];
  live: boolean;
  replaying?: boolean;
  /** What this app calls the mode, e.g. "Instructor-Led" or "Builder Mode". */
  modeName?: string;
  /** Who's wearing the headsets, e.g. "Trainees" or "You". */
  subject?: string;
}) {
  const status = live ? "● TRACKING" : replaying ? "● REPLAY" : "idle";
  const note = live
    ? `${subject} are standing in the pushed room.`
    : replaying
    ? "Reviewing the recorded run."
    : "Push a room to place these headsets in it.";
  return (
    <Card className="min-w-[240px]">
      <View className="flex-row items-center justify-between mb-1">
        <Kicker>{modeName.toUpperCase()}</Kicker>
        <Mono className={live || replaying ? "text-brand-teal text-[10px]" : "text-brand-snow/40 text-[10px]"}>
          {status}
        </Mono>
      </View>
      <Muted className="text-[12px] mb-3">{note}</Muted>
      {headsets.length === 0 ? (
        <Muted className="py-4 text-center">No headsets in {modeName}.</Muted>
      ) : (
        headsets.map((h) => (
          <View key={h.id} className="flex-row items-center justify-between py-2 border-t border-hairline">
            <View className="flex-row items-center gap-2">
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: live ? colors.teal : colors.sky }} />
              <Body className="text-brand-snow">{h.deviceName}</Body>
              {h.space && (
                <Mono className="text-brand-snow/35 text-[10px]">
                  {h.space.w.toFixed(1)}×{h.space.h.toFixed(1)}m
                </Mono>
              )}
            </View>
            <View className="flex-row items-center gap-1.5">
              <Ionicons name="battery-half" size={13} color="rgba(247,249,251,0.45)" />
              <Mono className="text-brand-snow/45 text-[11px]">{Math.round(h.battery)}%</Mono>
            </View>
          </View>
        ))
      )}
    </Card>
  );
}
