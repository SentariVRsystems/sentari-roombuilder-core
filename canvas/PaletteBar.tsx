import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { FURNITURE_TYPES, PALETTE, PALETTE_SECTIONS, ROOM_H, ROOM_W, type PaletteDef } from "../rooms";
import { Kicker, Muted } from "../ui/Text";

// The build menu, mirroring Build & Breach. Top-level sections (Walls, Doors,
// Furniture, NPCs, Start); the Furniture section groups its items by type in a
// second row of tabs. Picking a Wall material arms two-click draw mode; other
// items drop at room center to drag.
export function PaletteBar({
  onPick,
  activeWallKind,
}: {
  onPick: (item: PaletteDef, x: number, y: number) => void;
  activeWallKind: string | null;
}) {
  const [section, setSection] = useState<string>(PALETTE_SECTIONS[0]);
  const [furnType, setFurnType] = useState<string>(FURNITURE_TYPES[0]);

  const isFurniture = section === "Furniture";
  const items = isFurniture
    ? PALETTE.filter((p) => p.section === "Furniture" && p.category === furnType)
    : PALETTE.filter((p) => p.section === section);

  return (
    <View>
      <Kicker className="mb-2">BUILD MENU</Kicker>

      {/* Section tabs */}
      <View className="flex-row flex-wrap gap-1.5 mb-2">
        {PALETTE_SECTIONS.map((s) => {
          const active = s === section;
          return (
            <Pressable
              key={s}
              onPress={() => setSection(s)}
              className={`rounded-lg px-3 h-8 items-center justify-center border ${active ? "border-brand-teal bg-brand-teal/15" : "border-hairline bg-elevated active:bg-elevated/60"}`}
            >
              <Text className={`font-sans-semibold text-[12px] ${active ? "text-brand-teal" : "text-brand-snow/75"}`}>{s}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Furniture type sub-tabs */}
      {isFurniture && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-2" contentContainerStyle={{ gap: 6, paddingRight: 8 }}>
          {FURNITURE_TYPES.map((t) => {
            const active = t === furnType;
            return (
              <Pressable
                key={t}
                onPress={() => setFurnType(t)}
                className={`rounded-md px-2.5 h-7 items-center justify-center border ${active ? "border-brand-teal/70 bg-brand-teal/10" : "border-hairline active:bg-elevated/60"}`}
              >
                <Text className={`font-sans-medium text-[11px] ${active ? "text-brand-teal" : "text-brand-snow/60"}`}>{t}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {/* Items */}
      <View className="flex-row flex-wrap gap-2">
        {items.map((item) => {
          const armed = item.place === "wall" && item.kind === activeWallKind;
          const round = item.render === "npc" || item.render === "start";
          return (
            <Pressable
              key={item.kind}
              onPress={() => onPick(item, ROOM_W / 2, ROOM_H / 2)}
              className={`flex-row items-center gap-2 rounded-lg border px-2.5 h-9 ${armed ? "border-brand-teal bg-brand-teal/15" : "border-hairline bg-elevated active:bg-elevated/60"}`}
            >
              <View style={{ width: 12, height: 12, borderRadius: round ? 6 : 3, backgroundColor: item.fill }} />
              <Text className={`font-sans-medium text-[12px] ${armed ? "text-brand-teal" : "text-brand-snow/80"}`}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {section === "Walls" && (
        <Muted className="text-[12px] mt-2 text-brand-teal/90">
          Pick a wall material, then click two points on the map. Tap it again to finish.
        </Muted>
      )}
    </View>
  );
}
