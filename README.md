# @sentari/roombuilder-core

The Room Builder, extracted. Everything two different products need to agree on
when they build a top-down CQB room and push it to a Quest running **Build &
Breach**:

| Module | What it is |
| --- | --- |
| `rooms.ts` | The room model — grid geometry, the palette registry (mirrors the game's WallCatalog / FurnitureCatalog / NPCs), wall + door snapping, `sanitizeRoom`, seed rooms. Zero imports. |
| `protocol.ts` | The relay wire contract for room push + pose. `buildLoadRoomPayload()` is the **only** place the `loadRoom` bytes are produced. |
| `tracking.ts` | Live-tracking / replay shapes (`TrackMark`, `Frame`, `Replay`), play-area fitting, replay sampling. |
| `theme.ts` + `tailwind-preset.js` | The Sentari brand system, raw tokens and Tailwind preset. Keep the two in sync. |
| `ui/` | The typography + Card/Button primitives the canvas is built from. |
| `canvas/` | The editor itself: `RoomCanvas`, `PaletteBar`, `RoomObject`, `LiveTrackingLayer`, `ReplayControls`, `RoomSizeControl`, `SelectionControls`, `RoomLibraryPanel`, `BuildHeadsetsPanel`. |

## Who consumes it

- **Sentari Command** (`../SentariCommand`) — the enterprise instructor console.
  Room Builder is one screen among many; it adds squads, facilities, auth, and
  Firestore-backed shared room libraries on top of this package.
- **Build & Breach Builder** (`../BuildAndBreachBuilder`) — the standalone
  hobbyist app. Downloaded separately from the Quest Store title, bundles the
  relay, no accounts, rooms are files on disk.

Both push the **same bytes** to the **same headset build**. That's the point of
this package: a hobbyist's room and an instructor's room are the same artifact,
so the Unity side never has to care which app sent it.

## What deliberately isn't here

State management, persistence, auth, and transport. Each app owns its own store
and decides where rooms live (Firestore vs. local files) and how it reaches the
relay. The package is model + protocol + pixels.

## Consuming it

There is no build step and nothing to publish — apps resolve the raw TypeScript
through Metro. In the consuming app:

**`metro.config.js`** — watch the folder and alias the package name:

```js
const CORE = path.resolve(__dirname, "../sentari-roombuilder-core");
config.watchFolders = [CORE];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
config.resolver.extraNodeModules = { "@sentari/roombuilder-core": CORE };
```

**`tailwind.config.js`** — the canvas uses NativeWind classNames, so the core
has to be in `content` or those classes get tree-shaken away:

```js
presets: [require("nativewind/preset"), require("../sentari-roombuilder-core/tailwind-preset")],
content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}",
          "../sentari-roombuilder-core/**/*.{ts,tsx}"],
```

**`tsconfig.json`** — for the editor and `tsc`:

```json
"paths": { "@sentari/roombuilder-core/*": ["../sentari-roombuilder-core/*"] }
```

Note there's no `npm install`: aliasing beats a `file:` dependency here, because
a `file:` install symlinks a second copy of React into the tree and Metro's
peer-dep resolution gets interesting. The alias keeps one React.

Source sits at the package **root** rather than `src/` on purpose — subpath
imports (`@sentari/roombuilder-core/canvas/RoomCanvas`) then resolve with plain
file lookup, with no package `exports` map for Metro to honor.

## Conventions

Same as Command: NativeWind `className` for styling, `brand-*` color tokens,
the `ui/Text` set for type (Kicker = the electric-blue + JetBrains Mono
signature). Inside this package all cross-file imports are **relative** — there
is no `@/` alias here.
