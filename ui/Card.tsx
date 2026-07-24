import { View, ViewProps } from "react-native";
import { cn } from "./cn";

export function Card({ className, ...p }: ViewProps & { className?: string }) {
  return (
    <View
      className={cn(
        "bg-surface rounded-2xl border border-hairline p-4",
        className
      )}
      {...p}
    />
  );
}
