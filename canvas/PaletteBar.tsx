import { useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { thumbFor } from "../assets/thumbs";
import { CELL_METERS, FURNITURE_TYPES, PALETTE, PALETTE_SECTIONS, ROOM_H, ROOM_W, type PaletteDef } from "../rooms";
import { Kicker, Muted } from "../ui/Text";

// The build menu, mirroring Build & Breach. Two clearly-separated levels:
//
//   1. A segmented BAR of asset classes (Walls, Doors, Furniture, NPCs, Start).
//      It's one cohesive control — joined segments, the active one filled — so
//      it reads as a selector, not as another row of items.
//   2. The selected class's items "unnest" into a distinct inset panel below.
//      Furniture adds a second row of type sub-tabs inside that panel.
//
// Picking a Wall material arms two-click draw mode; other items drop at room
// center to drag.
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

      {/* ── Level 1: the asset-class bar (segmented control) ── */}
      <View className="flex-row rounded-xl border border-hairline bg-elevated overflow-hidden">
        {PALETTE_SECTIONS.map((s, i) => {
          const active = s === section;
          return (
            <Pressable
              key={s}
              onPress={() => setSection(s)}
              className={`flex-1 h-10 items-center justify-center ${i > 0 ? "border-l border-hairline" : ""} ${
                active ? "bg-brand-teal" : "active:bg-brand-snow/5"
              }`}
            >
              <Text
                numberOfLines={1}
                className={`font-sans-semibold ${active ? "text-[#0E1726]" : "text-brand-snow/70"}`}
                style={{ fontSize: 11 }}
              >
                {s}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* ── Level 2: the selected class's items, unnested into an inset panel ── */}
      <View className="mt-2 rounded-xl border border-hairline bg-canvas p-2.5">
        {/* Furniture type sub-tabs (a lighter, secondary strip) */}
        {isFurniture && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="mb-2.5"
            contentContainerStyle={{ gap: 6, paddingRight: 8 }}
          >
            {FURNITURE_TYPES.map((t) => {
              const active = t === furnType;
              return (
                <Pressable
                  key={t}
                  onPress={() => setFurnType(t)}
                  className={`rounded-full px-3 h-7 items-center justify-center ${
                    active ? "bg-brand-teal/20 border border-brand-teal/60" : "bg-elevated active:bg-elevated/60"
                  }`}
                >
                  <Text className={`font-sans-medium text-[11px] ${active ? "text-brand-teal" : "text-brand-snow/55"}`}>
                    {t}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}

        {/* Items. Furniture/doors/targets show the game's own build-menu
            thumbnail — Table07 and Table02 are different builds, and a color
            chip can't say so. Walls and the start marker keep their swatch.
            Furniture also states its real footprint (the size the headset
            will build it at), so clearances can be planned from the menu. */}
        <View className="flex-row flex-wrap gap-2">
          {items.map((item) => {
            const armed = item.place === "wall" && item.kind === activeWallKind;
            const round = item.render === "npc" || item.render === "start";
            const thumb = thumbFor(item.kind);
            const size =
              item.section === "Furniture"
                ? `${(item.defaultW * CELL_METERS).toFixed(1)} × ${(item.defaultH * CELL_METERS).toFixed(1)} m`
                : null;
            return (
              <Pressable
                key={item.kind}
                onPress={() => onPick(item, ROOM_W / 2, ROOM_H / 2)}
                className={`flex-row items-center gap-2 rounded-lg border px-2.5 ${thumb ? "h-12" : "h-9"} ${
                  armed ? "border-brand-teal bg-brand-teal/15" : "border-hairline bg-surface active:bg-elevated"
                }`}
              >
                {thumb ? (
                  <Image source={thumb} style={{ width: 34, height: 34 }} resizeMode="contain" />
                ) : (
                  <View style={{ width: 12, height: 12, borderRadius: round ? 6 : 3, backgroundColor: item.fill }} />
                )}
                <View>
                  <Text className={`font-sans-medium text-[12px] ${armed ? "text-brand-teal" : "text-brand-snow/80"}`}>
                    {item.label}
                  </Text>
                  {size && <Text className="font-sans text-[10px] text-brand-snow/45">{size}</Text>}
                </View>
              </Pressable>
            );
          })}
        </View>

        {section === "Walls" && (
          <Muted className="text-[12px] mt-2.5 text-brand-teal/90">
            Pick a wall material, then click two points on the map. Tap it again to finish.
          </Muted>
        )}
      </View>
    </View>
  );
}
