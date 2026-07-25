// Raw brand tokens for code that can't use NativeWind classes
// (LinearGradient stops, chart fills, status-driven colors).
// Mirrors tailwind.config.js — keep the two in sync.

export const colors = {
  charcoal: "#3E3B3C",
  slate: "#45505D",
  steel: "#4F5A64",
  snow: "#F7F9FB",
  deep: "#1F90DB",
  midblue: "#2EA2EE",
  teal: "#3DB4FF",
  sky: "#00D4FF",
  amber: "#B5701A",
  // Live-fire red. The brand rule keeps amber for alerts, but rounds going out
  // is not an alert — it's a distinct, instantaneous event on the map, and amber
  // beside the blue gun line reads as a warning rather than "shooting".
  danger: "#EF4444",
  // dark ops-console chrome (must match tailwind.config.js)
  canvas: "#0C1219",
  surface: "#111A24",
  elevated: "#18232F",
  hairline: "rgba(247,249,251,0.09)",
} as const;

// Status -> color mapping for devices/sessions.
export const statusColor = {
  "in-session": colors.teal,
  building: colors.teal,
  online: colors.sky,
  charging: colors.amber,
  offline: "#7A828C",
  running: colors.teal,
  paused: colors.amber,
  complete: colors.sky,
  "not-started": "#7A828C",
} as const;

// Distinct, off-theme colors auto-assigned to modules (by catalog order) so the
// same module reads the same color in every lobby. 20 hues spread across the
// spectrum to stay legible on the dark UI and separable from each other.
export const MODULE_PALETTE = [
  "#F97316", // orange
  "#8B5CF6", // violet
  "#F43F5E", // rose
  "#10B981", // emerald
  "#EAB308", // gold
  "#3B82F6", // blue
  "#EC4899", // pink
  "#84CC16", // lime
  "#06B6D4", // cyan
  "#A855F7", // purple
  "#EF4444", // red
  "#22C55E", // green
  "#F59E0B", // amber
  "#6366F1", // indigo
  "#D946EF", // fuchsia
  "#14B8A6", // teal
  "#FB7185", // light rose
  "#FACC15", // yellow
  "#2DD4BF", // aqua
  "#C084FC", // light purple
] as const;

// The hero visual: Deep -> Teal. Use sparingly (<=10%).
export const SIGNAL_GRADIENT = [colors.deep, colors.midblue, colors.teal] as const;

export const fonts = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
  mono: "JetBrainsMono_400Regular",
  monoMedium: "JetBrainsMono_500Medium",
  monoBold: "JetBrainsMono_700Bold",
} as const;
