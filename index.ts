// Convenience barrel. Prefer the subpath modules in app code — they keep the
// import list honest about what a file actually depends on, and let a
// non-React consumer (a CLI, the relay, a test) pull in `rooms`/`protocol`
// without dragging in React Native:
//
//   import { PALETTE } from "@sentari/roombuilder-core/rooms";
//   import { RoomCanvas } from "@sentari/roombuilder-core/canvas/RoomCanvas";
//
// Source lives at the package ROOT (not src/) on purpose: subpath imports then
// resolve with Metro's plain file resolution, with no package `exports` map.

export * from "./rooms";
export * from "./generateRoom";
export * from "./tracking";
export * from "./protocol";
export * from "./theme";
