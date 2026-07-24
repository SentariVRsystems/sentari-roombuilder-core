import { Text, TextProps } from "react-native";
import { cn } from "./cn";

type Props = TextProps & { className?: string };

// Title — screen headers
export function Title({ className, ...p }: Props) {
  return <Text className={cn("font-sans-bold text-brand-snow text-[26px] leading-tight", className)} {...p} />;
}

// Section heading
export function Heading({ className, ...p }: Props) {
  return <Text className={cn("font-sans-semibold text-brand-snow text-[17px]", className)} {...p} />;
}

// Body copy
export function Body({ className, ...p }: Props) {
  return <Text className={cn("font-sans text-brand-snow/80 text-[14px] leading-[20px]", className)} {...p} />;
}

// De-emphasized body
export function Muted({ className, ...p }: Props) {
  return <Text className={cn("font-sans text-brand-snow/45 text-[13px]", className)} {...p} />;
}

// The signature: electric blue + mono, uppercase, tracked-out kicker label
export function Kicker({ className, ...p }: Props) {
  return (
    <Text
      className={cn("font-mono-medium text-brand-teal text-[11px] uppercase", className)}
      style={{ letterSpacing: 2 }}
      {...p}
    />
  );
}

// Big mono stat number
export function Stat({ className, ...p }: Props) {
  return <Text className={cn("font-mono-bold text-brand-snow text-[30px]", className)} {...p} />;
}

// Inline mono — codes, metrics, serials
export function Mono({ className, ...p }: Props) {
  return <Text className={cn("font-mono text-brand-snow/70 text-[12px]", className)} {...p} />;
}
