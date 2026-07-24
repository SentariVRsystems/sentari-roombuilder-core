import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Room } from "../rooms";
import { colors } from "../theme";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Body, Kicker, Mono, Muted } from "../ui/Text";

// The saved-room library: create, select, rename, duplicate, delete, and push
// ("House is hot") rooms. Rooms persist locally always; when signed in they
// also sync to the facility's Firestore library (the cloud icon).
export function RoomLibraryPanel({
  rooms,
  selectedRoomId,
  pushedRoomId,
  cloud,
  onSelect,
  onNew,
  onRename,
  onDuplicate,
  onDelete,
  onPush,
}: {
  rooms: Room[];
  selectedRoomId: string | null;
  pushedRoomId: string | null;
  cloud: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onPush: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const startEdit = (r: Room) => {
    setEditingId(r.id);
    setDraft(r.name);
  };
  const commitEdit = () => {
    if (editingId) onRename(editingId, draft);
    setEditingId(null);
  };

  return (
    <Card className="min-w-[240px]">
      <View className="flex-row items-center justify-between mb-3">
        <View className="flex-row items-center gap-2">
          <Kicker>ROOM LIBRARY</Kicker>
          <Ionicons
            name={cloud ? "cloud-done-outline" : "cloud-offline-outline"}
            size={13}
            color={cloud ? colors.teal : "rgba(247,249,251,0.35)"}
          />
        </View>
        <Button label="New" variant="secondary" icon="add" onPress={() => onNew()} className="h-9 px-3" />
      </View>

      {rooms.length === 0 ? (
        <Muted className="py-6 text-center">No rooms yet — tap New to build one.</Muted>
      ) : (
        rooms.map((r) => {
          const selected = r.id === selectedRoomId;
          const live = r.id === pushedRoomId;
          return (
            <View
              key={r.id}
              className={`rounded-xl border mb-2 px-3 py-2.5 ${selected ? "border-brand-teal/60 bg-elevated" : "border-hairline"}`}
            >
              <View className="flex-row items-center justify-between gap-2">
                {editingId === r.id ? (
                  <TextInput
                    value={draft}
                    onChangeText={setDraft}
                    onBlur={commitEdit}
                    onSubmitEditing={commitEdit}
                    autoFocus
                    style={{ flex: 1, color: colors.snow, fontSize: 14, paddingVertical: 2 }}
                    placeholderTextColor="rgba(247,249,251,0.35)"
                  />
                ) : (
                  <Pressable className="flex-1" onPress={() => onSelect(r.id)}>
                    <View className="flex-row items-center gap-2">
                      <Body className="text-brand-snow" numberOfLines={1}>{r.name}</Body>
                      {live && <Mono className="text-brand-teal text-[10px]">● LIVE</Mono>}
                    </View>
                    <Muted className="text-[11px] mt-0.5">{r.objects.length} object{r.objects.length === 1 ? "" : "s"}</Muted>
                  </Pressable>
                )}
                <View className="flex-row items-center gap-1">
                  <IconBtn icon="pencil" onPress={() => startEdit(r)} />
                  <IconBtn icon="copy-outline" onPress={() => onDuplicate(r.id)} />
                  <IconBtn icon="trash-outline" onPress={() => onDelete(r.id)} />
                </View>
              </View>
              {selected && (
                <View className="mt-2">
                  <Button
                    label={live ? "Room is hot" : "House is hot"}
                    variant={live ? "secondary" : "primary"}
                    icon="flame"
                    onPress={() => onPush(r.id)}
                    full
                  />
                </View>
              )}
            </View>
          );
        })
      )}
    </Card>
  );
}

function IconBtn({ icon, onPress }: { icon: keyof typeof Ionicons.glyphMap; onPress: () => void }) {
  return (
    <Pressable hitSlop={6} onPress={onPress} className="p-1.5 rounded-lg active:bg-elevated">
      <Ionicons name={icon} size={15} color="rgba(247,249,251,0.55)" />
    </Pressable>
  );
}
