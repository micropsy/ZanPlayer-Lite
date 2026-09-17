# Layers & Layouts Reference

Practical, line-referenced map of every layout box and every paint layer in
ZanPlayer Lite: the App shell, Sidebar, PlayerViewport, the native LibVLC
surface (or the HTML5 `<video>` fallback), the DOM overlay stack, and their
pointer-events behavior.

This file is a **descriptive reference**, not a spec. The normative contract
lives in [`PLAYER_COMPOSITING_ARCHITECTURE.md`](./PLAYER_COMPOSITING_ARCHITECTURE.md);
the smoke battery and its permutations are documented in [`AGENTS.md`](../AGENTS.md).
Line numbers point at the current source and drift with edits — treat them as
starting points, not fixtures.

All DOM coordinates are **CSS pixels, top-left origin**. Native coordinates are
converted from that space by the backend (`macos_surface::apply_layout` on
macOS; `resize_vlc_video_window` / `resize_vlc_window` on Windows/X11).

---

## 1. Layout boxes

### 1.1 App shell — `src/App.tsx:286`

```
┌────────────────────────────────────────────────────────────┐
│ Top bar — h-10, z-40, opaque, drag region   (App.tsx:304)  │
├────────────────────────────────────────────────────────────┤
│ Content row — relative isolate flex-1 overflow-hidden      │
│ (App.tsx:357)                                              │
│ ┌──────────────┬──────────────────────────────────────────┐ │
│ │ Sidebar      │ [data-player-viewport] z-0 overflow-clip │ │
│ │ (z-40,       │   holds VideoPlayer + PWA/folder buttons │ │
│ │ opaque)      │                                        │ │ │
│ └──────────────┴──────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────┤
│ SubtitleEditor / UpdateModal — rendered last (App.tsx:405) │
└────────────────────────────────────────────────────────────┘
```

- Root: `flex flex-col w-screen h-screen overflow-hidden`
  (`App.tsx:287`), text color from `theme`, drag/drop handlers attached.
- **Top bar** (`App.tsx:304-327`): `z-40 flex h-10 shrink-0 items-center
  border-b`. Opaque `bg-zan-black` (dark) / `bg-white` (light). The whole strip
  is the drag surface: `onMouseDown` → `TauriService.startWindowDrag()` → the
  backend `start_window_drag` command (`native_player/macos_window.rs`,
  `performWindowDragWithEvent:`), plus the "Open
  sidebar" hamburger when the sidebar is hidden. macOS clears the traffic-light
  group with `pl-[76px]` (`isMacOs()`); non-Mac keeps `pl-2`. **Hidden when
  `isTauri()` is false or in fullscreen (`isFullscreenUi`).**
- **Content row** (`App.tsx:357`): `relative isolate flex min-h-0 flex-1
  overflow-hidden`. `isolate` guarantees the row is its own stacking context:
  the sidebar (z-40) and the viewport column (z-0) are siblings whose internal
  paints can never cross each other.
- **Modals** (`App.tsx:405-406`): the SubtitleEditor and UpdateModal are direct
  children of the root, rendered after the content row, so they sit above the
  entire shell.

### 1.2 Sidebar — `src/components/Sidebar.tsx:365`

- `aside[data-sidebar]`: `flex h-full w-[min(22rem,calc(100vw-1rem))]
  max-w-full shrink-0 flex-col border-r z-40 opacity-100`, opaque theme
  background (`bg-zan-black` / `bg-white`, `Sidebar.tsx:368-372`). The
  explicit `opacity-100` is a strict guarantee: the sidebar has zero
  transparency bleed in both themes at every window size (locked by the `[L]`
  regression in `VideoPlayer.test.tsx`).
- **Position is platform-driven, never width-driven** (`videoLayout.ts:44`):
  - Desktop (macOS/Windows/Linux Tauri + desktop browsers) → `relative`
    (**inline**): pushes the video right; the video can never paint under it.
  - Android/iOS below `md` (768 px) → `absolute inset-y-0 left-0` (**drawer**
    overlay over the video), upgraded back to inline at `md` on a rotated
    phone/tablet (`Sidebar.tsx:357-360`).
- Internal bands: header row ~`min-h-[4.25rem]` (logo + tabs, border-b,
  `Sidebar.tsx:388`) then the library browser.
- Own drag-and-drop overlay fills the sidebar only (`Sidebar.tsx:379`).

### 1.3 PlayerViewport column — `src/App.tsx:372`

- `div[data-player-viewport]`: `relative z-0 min-h-0 min-w-0 flex-1
  overflow-clip`.
- **Why `z-0`**: it forces the column into its own stacking context. The
  player's highest popovers (Quick Settings z-50) stay trapped *below* the
  sidebar (z-40) instead of being promoted into the row and painted over it.
- **Why `overflow-clip`**: physically stops the HTML5 fallback box and every
  DOM overlay from painting outside the column. The sidebar is a flex sibling,
  so it can never be clipped by this column.
- Widgets rendered inside it: PWA install prompt button (non-Tauri,
  `App.tsx:373`), non-Tauri "Open sidebar" hamburger (`App.tsx:391`), and
  `<VideoPlayer>` (`App.tsx:402`).

### 1.4 VideoPlayer — `src/components/VideoPlayer.tsx:1528` (root)

Root: `relative w-full h-full group isolate overflow-clip` — transparent while
the engine is **VLC** (the host NSView surface shows through behind the
transparent webview), `bg-black` in every non-native state (HTML5 letterboxing,
empty state). The `isolate` forces the whole player subtree into a single
self-contained stacking context: the controls bar and its popovers can never be
re-parented under a sibling overlay or trapped by an ancestor context changing
beneath them.

Two branches:

- **Empty state** (`VideoPlayer.tsx:2204`): centered "Select a video or audio
  file", keyboard-shortcut legend, Recent History, titles.
- **hasMedia** (`VideoPlayer.tsx:1540`): the stage + the overlay stack in §2.
  `hasMedia` is decoded-by-proof: `engine === "VLC" || currentVideoPath ||
  currentVideoUrl || videoSource || vlcClock.position > 0 || vlcClock.duration
  > 0` (`VideoPlayer.tsx:218-224`) — the empty state can never flash over an
  active video.

### 1.5 Native player surface (non-DOM) — `src-tauri/src/native_player/`

- macOS (`session.rs` → `macos_surface`): LibVLC draws via
  `libvlc_media_player_set_nsobject` into a dedicated **host NSView** inserted
  as a sibling **below** the transparent WKWebView in the window content view.
  Verified order at runtime (smoke log):
  `subviews: NSView | NSKVONotifying_wry::wkwebview…`.
- The host view is **re-framed exactly onto the DOM stage rect** by
  `vlc_set_layout` → `macos_surface::apply_layout` (content coordinates,
  y-flip, retina-aware, clamped to webview bounds, never `convertRect:fromView:`).
- The rect comes from the PlayerViewport **verbatim** (`VideoPlayer.tsx:1064`
  → `vlcSetLayout`), with one clamp: the **right-of-sidebar invariant**
  (`enforceRightOfSidebar`, `videoLayout.ts:105`) — while the sidebar is inline
  (`[data-sidebar]` with `position !== "absolute"`), the surface rect must start
  at the sidebar's right edge. Drawer mode is untouched (the opaque drawer
  overlays the video by design).
- Windows uses child-HWND attach (`libvlc_media_player_set_hwnd`, VLC child
  class `"VLC"`); Linux X11 uses `set_xwindow`. Wayland is a no-op (no backend).

---

## 2. DOM overlay stack (z-ladder)

Canonical order, highest layer last. When added, every overlay must pick an
explicit z-index from this ladder and a pointer-events decision.

| Layer | z-index | Source | pointer-events |
|---|---|---|---|
| Native host frame (NSView below webview; VLC VOUT) | below webview | `session.rs` (`macos_surface`) | never (non-DOM) |
| Video stage / `<video>` | `z-0` | `VideoPlayer.tsx:1560` / `:1575` | native: `none` |
| Video title OSD (gradient) | `z-10` | `VideoPlayer.tsx:1635` | `none` |
| Play/pause capture layer | `z-20` | `VideoPlayer.tsx:1713` | **`auto`** (`togglePlay`) |
| Transcribing pill (top-right) | `z-20` | `VideoPlayer.tsx:1736` | `none` |
| Fallback-load error toast | `z-[25]` | `VideoPlayer.tsx:1726` | `none` |
| Subtitles (dual-pass container) | `z-30` | `VideoPlayer.tsx:1648` | `none` |
| Speed menu popover | `z-30` | `VideoPlayer.tsx:1834` | `auto` |
| CC menu popover | `z-30` | `VideoPlayer.tsx:1877` | `auto` |
| Controls bar (incl. gradient) | `z-40`, `isolate` | `VideoPlayer.tsx:1754` | `auto` only while visible |
| Sidebar | `z-40` | `Sidebar.tsx:368` | `auto` |
| Quick Settings popover | `z-50` | `VideoPlayer.tsx:2095` | `auto` |
| Drag & Drop overlay (App / sidebar) | `z-50` | `App.tsx:331`, `Sidebar.tsx:379` | `auto` |
| SubtitleEditor modal | above content row | `App.tsx:405` | `auto` |
| UpdateModal | above content row | `App.tsx:406` | `auto` |

**Ordering subtleties that matter:**

- The player tree's z-40 / z-50 elements are **trapped inside the
  PlayerViewport's `z-0` stacking context**. Despite lower *values* than the
  sidebar, the controls bar (z-40) coexists with the sidebar at z-40 — ties are
  decided by DOM order, and the sidebar (earlier flex sibling) wins. The Quick
  Settings popover can be `z-50` yet never appear over the sidebar.
- The **sidebar is z-40 at ALL widths** — never `md:z-10`. A lower value let the
  player's high-z popovers be promoted into the content row and paint above the
  sidebar on any spatial leak.
- Native transparency requires the window `transparent: true` +
  `app.macOSPrivateApi` + `macos-private-api` feature, and the webview must stay
  topmost relative to the host NSView (`keep_webview_on_top`, re-asserted each
  ticker beat and after every `vtl_load`).

---

## 3. Click / pointer-events routing

- **Base native stage = `pointer-events-none`** (`VideoPlayer.tsx:1560`): the
  host frame under the webview never intercepts a pointer event ahead of a DOM
  control. VLC's own key/mouse input is disabled too
  (`libvlc_video_set_key_input/set_mouse_input(0)` on macOS).
- **Controls bar toggles pointer-events with its opacity**
  (`VideoPlayer.tsx:1754`): `opacity-100 pointer-events-auto` while shown,
  `opacity-0 pointer-events-none` while auto-hidden. This fixes the historical
  bug where an invisible z-40 bar swallowed every pause/resume click over the
  stage ("pause doesn't work").
- **Play/pause capture layer** (`z-20`, `VideoPlayer.tsx:1713`) is always
  `pointer-events: auto` and calls `togglePlay` — with the bar hidden, clicks
  fall through to it; the visible bar's own buttons (all children of the bar)
  take priority when the bar is showing.
- **Subtitles / title OSD / transcribing pill / error toast** are
  `pointer-events-none` (chrome only).
- **Popovers** (speed z-30, CC z-30, Quick Settings z-50) are interactive and
  close on an outside `mousedown` (`VideoPlayer.tsx:541`).

---

## 4. The controls bar in detail — `VideoPlayer.tsx:1754`

`absolute bottom-0 left-0 right-0 isolate z-40` with `bg-gradient-to-t from-black/80
-to-transparent`, always in the DOM (opacity toggles). The `isolate` makes the bar
a self-contained stacking context so it can never be clipped or hidden behind
the `[data-player-viewport]` container by a parent stacking/clip change, and its
`z-40` never re-parents under a sibling overlay. Contents:

```
Time/progress  [============== slider ==============]   00:42 / 01:30

left group:    ▶/⏸  ⏮-5  ⏭+5   🔊 [volume]      M   1.0x  CC  ⚙  ⛶
right group:                                speed  CC  gear fullscreen
```

- Progress bar: `<input type="range">` + elapsed / duration (`:1761`).
- Left (`:1776`): Play/Pause, Skip Back 5, Skip Forward 5, Mute +
  volume slider.
- Right (`:1817`): Playback speed badge → popover (`SPEED_RATES`), CC → subtitle
  menu, ⚙ Quick Settings (gear, `:2080`), ⛶ Fullscreen
  (`:2194`, `Minimize`/`Maximize`, `toggleFullscreen`).

## 5. Popovers

- **Speed** (`:1819`): `absolute bottom-full right-0 mb-3 z-30`, list of rates.
- **CC menu** (`:1854`): `z-30`, views: root → Source tracks / Translation
  tracks / Retry (failed).
- **Quick Settings** (`:2080`): `absolute bottom-28 right-0 z-50 w-72` — Subtitle
  Size slider, Subtitle Color swatch + hex field, Transcription Mode
  Realtime/Full-Batch toggle.

## 6. Fullscreen (window vs element)

- Product path = **Tauri window fullscreen**: `toggleFullscreen`
  (`VideoPlayer.tsx:424`) → `TauriService.setWindowFullscreen` →
  `set_window_fullscreen` command (`native_player/mod.rs`) → `set_fullscreen`
  on the same window + emits `zan-fullscreen`.
- The `zan-fullscreen` event is consumed by: App (`App.tsx:158`, hide top bar +
  sidebar), VideoPlayer (`:517`, mirror `isFullscreen` for icon / "F"), and the
  layout reporter (`:1236`, synchronous re-anchor when the DOM
  `fullscreenchange` never fires).
- The HTML Fullscreen API (`document.documentElement.requestFullscreen()`) is
  **forbidden on Tauri** — it reparents the WKWebView into a separate macOS
  fullscreen window and strands the host NSView in the old one (permanent black
  stage). It remains only the web/PWA path.

## 7. File index

| Concern | File |
|---|---|
| App shell, top bar, content row, viewport column | `src/App.tsx` |
| Sidebar layout & z-40 cap | `src/components/Sidebar.tsx` |
| Player overlay stack, controls, fullscreen, pointer-events | `src/components/VideoPlayer.tsx` |
| Playerviewport / sidebar layout math | `src/services/videoLayout.ts` |
| Platform/UA helpers, Tauri service, fullscreen IPC | `src/services/tauri.ts` |
| libvlc FFI surface (`VlcPlayer`) | `src-tauri/src/native_player/libvlc.rs` |
| macOS host NSView + `apply_layout` (macos_surface), ticker, layering | `src-tauri/src/native_player/session.rs` |
| Commands (`vlc_*`), fullscreen, drag, smoke harness | `src-tauri/src/native_player/mod.rs` |
| Windows/X11 child-window resize + layering | `src-tauri/src/native_player/session.rs` (`windows_layering`/`x11_layering`) |
