import { ActivityIndicator, Pressable, PressableProps, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";

type Props = PressableProps & {
  label: string;
  variant?: Variant;
  icon?: keyof typeof Ionicons.glyphMap;
  className?: string;
  full?: boolean;
};

// Solid, flat variants — clean on the dark console. Primary = the Sentari teal
// HUD signature (dark ink on teal). The Deep→Teal gradient is reserved for large
// hero surfaces, not buttons.
const VARIANTS: Record<Variant, { box: string; color: string }> = {
  primary: { box: "bg-brand-teal active:bg-brand-teal/85", color: "#0E1726" },
  secondary: { box: "bg-elevated border border-hairline active:bg-elevated/70", color: colors.snow },
  ghost: { box: "bg-transparent border border-hairline active:bg-elevated/40", color: colors.snow },
  danger: { box: "bg-transparent border border-brand-amber/70 active:bg-brand-amber/10", color: colors.amber },
};

export function Button({ label, variant = "secondary", icon, className, full, ...p }: Props) {
  const s = VARIANTS[variant];
  return (
    <Pressable
      className={cn(
        "flex-row items-center justify-center gap-2 rounded-xl px-4 h-11",
        s.box,
        full && "w-full",
        className
      )}
      {...p}
    >
      {icon ? <Ionicons name={icon} size={16} color={s.color} /> : null}
      {/* Empty label = icon-only button (pass a square className and an
          accessibilityLabel); skipping the Text keeps gap-2 from adding a
          phantom gap after the icon. */}
      {label ? (
        <Text className="font-sans-semibold text-[14px]" style={{ color: s.color }}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function Spinner() {
  return <ActivityIndicator color={colors.teal} />;
}
