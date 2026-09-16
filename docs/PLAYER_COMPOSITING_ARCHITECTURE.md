# Player Compositing Architecture

Canonical specification for how ZanPlayer Lite composes the Sidebar, the Player
Viewport, the video surface (HTML5 **or** native mpv, never both), and the DOM
overlay stack (subtitles / OSD / controls / loading / error) on every platform.

Status: **CANONICAL** (normative). Implementations and code must be audited
against this document; any divergence is a defect.

---

## 1. Purpose

This document defines, once and for all, the layer model the player is built on:

- where the Sidebar sits and what it may and may not do,
- what the Player Viewport is and who computes it,
- how the video picture reaches the screen in each engine mode,
- how HTML/DOM overlays relate to that picture,
- the exact coordinate-space contract between the DOM and the native layer,
- and the set of architectures that are **forbidden**, so regressions (floating
  windows, video bleeding over the sidebar, mis-anchored/empty stages, drift)
  have a testable definition instead of a vibe.

Every change to `src/App.tsx`, `src/components/Sidebar.tsx`,
`src/components/VideoPlayer.tsx`, `src/services/videoLayout.ts`,
`src/services/tauri.ts`, and `src-tauri/src/native_player/**` must keep the
invariants below.

## 2. Scope

In scope:

- App shell layout (top bar, content row, Sidebar, PlayerViewport).
- The HTML5 `<video>` fallback path (feature-off builds, web/PWA, embed-loss,
  decode-watchdog cutover).
- The native mpv path: macOS Render-API backend (libmpv `vo=libmpv` +
  CAMetalLayer + host NSView) and the Windows/X11 `wid`-embed session.
- Subtitle / OSD / control / loading / error overlays.
- Fullscreen (native window fullscreen and the web Fullscreen API button).
- Responsive/mobile (drawer) behavior on real touch devices.

Out of scope:

- The transcription pipeline, subtitle cue storage, the SubtitleEditor UI.
- Native audio decoding (mpv/Media3/AVPlayer audio) — only its *layering*
  relative to the DOM is covered.
- Window chrome / macOS title-bar overlays beyond how they shift coordinates
  (they are handled by the coordinate-space contract below).

## 3. Principles

1. **One authority per axis.** The App layout owns *where* the PlayerViewport
   is. The Player owns *what happens inside it*. Nothing else decides where the
   picture goes.
2. **The Sidebar is not a player layer.** The Player never reads the Sidebar's
   visibility, width, rect, or state. The Sidebar is a flex sibling of the
   PlayerViewport; its open/close merely reflows that sibling and the reported
   rect changes as a consequence.
3. **One video, one engine.** Exactly one of HTML5 `<video>` or native mpv is
   active at a time. Never both.
4. **Overlays sit above the picture.** Captions, OSD, controls, loading and
   error surfaces paint inside the PlayerViewport, above the video, in a fixed
   z-order. On native builds the webview *is* the overlay plane and must stay
   above the native surface.
5. **Geometry is data, never a guess.** The native surface is positioned from a
   measured DOM rect that passes through well-defined coordinate conversions
   (CSS px → webview points → content/app coords → backing pixels). No hard-coded
   offsets, no `innerWidth` magic, no assumptions about window chrome.
6. **Invisible is not an option.** If the native surface cannot be proven visible
   and correctly placed, the player must fall back to HTML5 rather than present a
   floating window, a buried picture, or a transparent silent stage.

### The Absolute Rule

> The Player does not calculate around the Sidebar.
> The App layout calculates the Player Viewport.
> The Player simply occupies the Player Viewport.

This sentence is the acceptance test for every architectural decision in this
document.

**Sole enforced exception — the right-of-sidebar invariant.** While an OPAQUE
inline sidebar is on the page (`[data-sidebar]` with computed `position !==
"absolute"`), the rect the reporter sends to `mpv_set_layout` is additionally
passed through `enforceRightOfSidebar` (`videoLayout.ts`), which forces the
rect to start at the sidebar's measured right edge. In every correct flex
state this is an **identity** — App layout has already placed the column
exactly at that edge, so the verbatim contract holds. It only corrects a
stale / wrongly-measured viewport rect, or a mid-toggle animation frame, that
would otherwise let the picture paint under/over the sidebar. Drawer mode
(`position: absolute`, real touch devices) is deliberately NOT enforced: there
the opaque drawer overlays the video by design, and shrinking the surface
right of it would wrongly shrink the player on a phone. Covered by
`videoLayout.test.ts` (`enforceRightOfSidebar` cases) and `VideoPlayer.test.tsx`
`[B2]`.

## 4. App-level layout model

The App shell is a vertical stack:

```
┌──────────────────────────────────────────────┐
│  Top bar (h-10, opaque, traffic lights)       │  App shell
├──────────────────────────────────────────────┤
│  Content row:  <div data-content-row>         │
│  ┌──────────┬───────────────────────────┐     │
│  │ Sidebar  │ PlayerViewport            │     │
│  │ z-40     │ [data-player-viewport]    │     │
│  │flex sibling│  z-0  flex-1  overflow-clip │  │
│  └──────────┴───────────────────────────┘     │
└──────────────────────────────────────────────┘
```

Rules:

- `<div data-content-row>` is `relative isolate flex min-h-0 flex-1
  overflow-hidden`. `isolate` guarantees the row is its own stacking context, so
  the Sidebar (`z-40`) and the PlayerViewport column (`z-0`) can never bleed
  their internal paints across each other.
- The Sidebar renders **only** when visible, as a flex sibling of the
  PlayerViewport. It paints its own opaque theme background. On desktop it is
  `relative` (inline), on real touch devices below `md` it is an `absolute`
  drawer overlay (`md:relative` upgrades rotated phones/tablets back to inline).
- `<div data-player-viewport>` is the canonical PlayerViewport region:
  `relative z-0 min-h-0 min-w-0 flex-1 overflow-clip`.
  - `z-0` forces this column into its **own stacking context**, so the player's
    high-z DOM (controls `z-40`, quick settings `z-50`, subtitles `z-30`) is
    trapped **below** the Sidebar (`z-40`) instead of being promoted into the
    row and painted over it.
  - `overflow-clip` physically prevents the HTML5 fallback box and the DOM
    overlays from painting outside the viewport.
  - `flex-1` makes the column fill whatever the flex row leaves after the
    Sidebar.

The PlayerViewport box is the **single geometry authority** for the player. App
shell flex owns placing it; the Player measures it and consumes it verbatim.

## 5. Player compositing model

Inside the PlayerViewport, the `VideoPlayer` component composes exactly two
layers:

| Layer | Purpose | Contents |
|-------|---------|----------|
| **Layer 1 — Overlay** | Above the picture | Subtitles (`z-30`), play/pause `z-20`, big/center status `z-20`, speed/CC popovers `z-30`, controls bar `z-40`, quick settings `z-50`, subtitle timing editor, loading spinner |
| **Layer 2 — Video** | The picture | Native stage (`[data-native-stage]`, `z-0`) **xor** HTML5 `<video>` (`z-0`) |

Rules:

- Layer 1 and Layer 2 are stacked inside the same `relative` root
  (`relative w-full h-full group overflow-clip`).
- The root is **transparent** when the native engine is active (so the native
  surface behind the webview shows through) and opaque `bg-black` in every
  non-native state (a clean letterbox for HTML5 and a clean empty state).
- Layer 2 renders exactly one child: `[data-native-stage]` when
  `engine === "mpv"`, else the `<video>` element. There is no path where both
  exist.
- Every DOM overlay must carry an explicit z-index in the fixed ladder above.
  New overlays must pick a layer; an overlay without an explicit z can land
  under the native video view on macOS/Windows/X11.

## 6. HTML5 model

- Shipped builds and web/PWA use a plain `<video class="relative z-0 w-full h-full
  object-contain">` filling the PlayerViewport.
- The viewport's `overflow-clip` guarantees the letterbox cannot paint outside
  the column (per Principle 5 geometry stays intact).
- Captions/controls are the same Layer-1 DOM overlays; there is no native surface
  to coordinate.
- Container limits are enforced by extension classification (`isHtml5Playable`);
  an unplayable container surfaces a visible `videoLoadError` overlay instead of
  a silent black frame (subtitles can still appear since ffmpeg decodes audio
  natively in the transcription backend).
- The fallback is entered when native is unavailable, when `mpv-embed-lost` fires,
  or when the native decode watchdog (clock never proves decode within
  `NATIVE_DECODE_WATCHDOG_MS`, see §14) trips.

## 7. Native mpv model

Two backends share one contract (`mpv_set_layout` with a `SurfaceLayout{ x, y,
width, height }` — the PlayerViewport rect in CSS px).

### macOS (Render-API backend, `macos-render`)

```
libmpv (vo=libmpv, hwdec=no) ──▶ mpv_render_context (SW)
                                     │  bgr0 CPU buffer, alpha forced 0xFF
                                     ▼
                              CAMetalLayer (BGRA8Unorm, opaque,
                              contentsScale=backingScaleFactor,
                              drawableSize = stage backing px)
                                     │  framed to host view bounds, layer-hosting
                                     ▼
                         host NSView (below the WKWebView)
                                     │  setFrame: computed from the viewport rect
                                     ▼
                         NSWindow content view  ──▶  screen
```

Rules:

- `wid` is **never** used on macOS (structurally impossible to detach).
- The host NSView is a dedicated layer-backed view inserted **below** the
  transparent WKWebView (`addSubview:positioned:NS_WINDOW_BELOW`) with
  `contentsScale = backingScaleFactor`.
- The CAMetalLayer is layer-hosting (`setLayer:`), so AppKit does not auto-size
  it — `apply_layout` re-pins the layer frame to the host bounds, resizes the
  drawable to the stage backing px, and flushes CATransaction on every
  `mpv_set_layout`.
- Correct **stacking** (webview on top = DOM chrome visible above the picture)
  and correct **geometry** (layer on the viewport rect) are both mandatory.
  Stacking is re-asserted on every ticker beat and after every `load`
  (`keep_webview_on_top`).
- Layout debug mode (`ZANPLAYER_NATIVE_LAYOUT_DEBUG=1`) draws a **magenta**
  border on the CAMetalLayer — the true native frame — so a mis-anchored layer
  is visible against the DOM outlines (see §17.9).

### Windows / X11 (wid-embed session)

- `wid` is set as a **pre-init option** (`Mpv::with_initializer`), never a
  post-init `set_property`; a mismatch fails the session and the frontend falls
  back to HTML5 (embed guard).
- mpv's video view is added **above** the webview; `keep_webview_on_top`
  re-raises the webview / pins the mpv child to the bottom on every ticker beat.
- Layout rects are DPI-scaled (`GetDpiForWindow/96` on Windows; root physical
  geometry on X11) and applied to mpv's child window — never to the app window.
- Wayland: no client-side z-order (compositor-owned); captions may sit under the
  video — a known, documented limitation, not a regression.
- The ticker watches `wid` on every beat; if mpv stops resolving the surface,
  `mpv-embed-lost` is emitted once and the frontend drops to HTML5.

### Embed-loss / decode watchdogs

- `mpv-embed-lost` → cut to HTML5 blob URL. A detached/rogue window is never
  presented as in-app playback.
- `NATIVE_DECODE_WATCHDOG_MS` (5 s) grace timer while `engine === "mpv"`: if the
  250 ms clock never proves a real duration or advancing playhead
  (`nativeDecodeProvenRef`), cut back to HTML5. The watchdog reads the shared
  decode-proof ref and does **not** register a competing `mpv-timeupdate`
  listener.

## 8. Subtitle / OSD / control model

Subtitle/OSD/controls are **DOM**, not native.

- The dual-pass subtitle container is `[data-subtitle-layer]`, absolutely
  positioned inside the Layer-1 overlay stack at `z-30`, below the controls bar
  but above the picture.
- Because the whole overlay plane *is* the webview, native builds must keep the
  webview on top of the native surface (see §7).
- Captions/OSD/controls are clipped to the PlayerViewport by `overflow-clip`,
  so they always sit on the picture, never over the sidebar or chrome.

## 9. Coordinate-space contract

The chain from DOM to native backing pixels:

```
CSS px (getBoundingClientRect on [data-player-viewport],
        top-left origin, relative to the webview port)
        │
        ▼
Webview points (1:1 with CSS px in a zoom-less WKWebView)
        │
        ▼
Content-view / app coordinates (macOS: unflipped siblings —
        x += webview.frame.origin.x,
        y = webview.frame.origin.y + webview.bounds.height − (y + h);
        Windows/X11: DPI-scaled root physical px)
        │
        ▼
Backing pixels (drawableSize = stage px × contentsScale)
        │
        ▼
CAMetalLayer present / mpv window resize
```

Rules:

- The rect is **always** the measured `[data-player-viewport]` box. Never the
  app-window rect, never a sidebar-derived rect, never a hard-coded scale.
- macOS frames the host directly in content coordinates — never
  `convertRect:fromView:` (its result depends on the destination view's current
  frame, so one wrong frame drifts every later frame).
- Rect values are coalesced to whole CSS px up front so IPC never spams and the
  `key` short-circuit stops the reporter at idle once anchored.
- Degenerate (0×0 or <1px) rects are skipped on both the JS and Rust sides so a
  settling layout can never collapse the surface to a top-left patch.
- `sanitize_surface_layout` rejects non-finite / negative values. Windows/X11
  clamp the rect into the webview/content bounds.

## 10. Sidebar OPEN diagram

Windowed desktop, sidebar open (1580 × 860 example — **example only, never
hard-coded**; the actual numbers always come from live measurement):

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Top bar (h-10, opaque, drag region)                                 … ──── │
├──────────────┬─────────────────────────────────────────────────────────────┤
│              │                                                             │
│  [data-sidebar]  z-40  flex sibling            [data-player-viewport] z-0  │
│  relative inline                               flex-1  overflow-clip        │
│  opaque theme bg                               ┌─────────────────────────┐  │
│  x:0  w:352 (min(22rem,…))                     │   VideoPlayer root      │  │
│              y:40  h:820                       │   (transparent native)   │  │
│  ┌────────┐   SPACE:                          │  ┌─────────────────────┐ │  │
│  │  nav / │   only what the row                │  │ Layer 2: video      │ │  │
│  │  files │   leaves                           │  │ [data-native-stage]  │ │  │
│  │  ...   │                                   │  │ XOR <video>          │ │  │
│  └────────┘                                   │  └─────────────────────┘ │  │
│              │                                 │  Layer 1: subtitles z-30 │  │
│              │                                 │           controls z-40  │  │
│              │                                 │  └─────────────────────────┘ │
│              │                                                             │
└──────────────┴─────────────────────────────────────────────────────────────┘
   x:0..352                                      x:352..1580  w:1228
```

- The App reflows the row in a single commit: sidebar mounts → the column's box
  slides right and shrinks → the viewport `ResizeObserver` fires → the reporter
  sends `mpv_set_layout(rect)` → the native surface re-anchors. The Player never
  reads sidebar state.
- The sidebar never clips the video and the video never bleeds over the sidebar
  (sidebar `z-40` > viewport `z-0` stacking context).

## 11. Sidebar CLOSED diagram

Windowed desktop, sidebar closed (`sidebarVisible === false`):

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Top bar (h-10, opaque, drag region)                                 … ──── │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  [data-player-viewport]  z-0  flex-1  overflow-clip                        │
│  x:0  y:40  w:1580  h:820                                                 │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  VideoPlayer root                                                  │    │
│  │  ┌──────────────────────────────────────────────────────────────┐  │    │
│  │  │ Layer 2: video (native stage / HTML5)                       │  │    │
│  │  └──────────────────────────────────────────────────────────────┘  │    │
│  │  Layer 1: subtitles z-30, controls z-40  …                       │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                            │
│  (top bar holds the "Open sidebar" hamburger; desktop width is          │
│   not a factor — inline is platform-driven, see §16)                    │
└────────────────────────────────────────────────────────────────────────────┘
```

- Same compositing model, just a full-width column. The Sidebar element is not in
  the DOM at all.

## 12. Native macOS hierarchy (bottom → top)

```
NSWindow content view
  ├─ host NSView  (dedicated, layer-backed, width/height == stage rect)
  │    └─ CAMetalLayer  (layer-hosting; frame == host bounds; drawableSize
  │                      == stage backing px; opaque; magenta border in debug)
  ├─ WKWebView   (transparent)  ← DOM: overlay plane + chrome
  └─ (traffic lights float over the DOM top strip in the window/server layer)
```

- Host and webview are **siblings** under the content view. The webview is kept
  topmost via re-sorting on every ticker beat and after each load.
- Content-view coords account for macOS coordinates being flipped vs. CSS:
  `content.y = webview.frame.y + webview.bounds.height − (y + h)`.

## 13. Forbidden architectures

The following are **not allowed**. Any of these appearing in the implementation
fails the audit and the runtime verification:

1. Native surface sized to the app-window/content-row bounds while the sidebar
   is open (picture slides under the sidebar). The picture must track the
   PlayerViewport rect only.
2. The Player reading/using the sidebar's visibility, width, or rect to derive
   the stage (any `sidebarWidth`/`sidebarVisible`/`sidebarRect` in native
   geometry or the step before it — the viewport reporter includes the sidebar
   effect only through the flex row reflow measured on the column).
3. Manual subtraction of a hard-coded sidebar width from `window.innerWidth` /
   the window rect to estimate the stage.
4. Hard-coded scale factors (e.g. `*2`, `*devicePixelRatio` baked into geometry)
   replacing live backing-scale measurement (`contentsScale`,
   `GetDpiForWindow/96`, X11 root mm).
5. Positioning via `convertRect:fromView:` on macOS (frame-dependent drift).
6. A native surface stacked **above** the webview on macOS/Windows/X11 (captions/
   OSD/controls buried). The webview/DOM must stay on top; native fills the
   stage behind it.
7. `z-index` hacks at the content-row level to paint the player over the sidebar
   (the correct answer is the `z-0` viewport column + `isolate` row).
8. App-window bounds used as the player bounds (must be the measured
   `[data-player-viewport]` rect).
9. Initiating native surface placement at a full-window rect before the first
   correct viewport rect arrives (the initial anchor must be the real viewport
   rect; degenerate rects are skipped, not guessed).
10. The Sidebar implemented as a player layer (absolutely positioned inside the
    VideoPlayer, or the Player rendering it).
11. Both `<video>` and the native stage mounted at once (engine XOR).
12. Any path where `mpv-embed-lost` or the decode watchdog does **not** drop to
    HTML5 (a detached window presented as in-app playback).
13. Native geometry that reads DOM `getBoundingClientRect` of anything except
    `[data-player-viewport]`, or that re-derives the sidebar boundary and grows
    the viewport over it.
14. An overlay without an explicit z-index that can land under the native video
    view.

## 14. Engine switching rules

- The engine is decided once per load: `engine === "mpv"` when the native
  backend reports available and the file is loadable; otherwise `"html5"`.
- Actual HTML5 playback only starts after a native attempt fails or native is
  unavailable. The two engines never coexist (Forbidden #11).
- Transitions:
  - **native → HTML5**: on `mpv-embed-lost`, watchdog timeout, native load
    error, or a `wid` mismatch failing session creation. The DOM stage rect
    stays the same (`[data-player-viewport]` box) — switching engines changes
    the *surface*, never the *region*.
  - **HTML5 → native**: only via a fresh file load (no runtime promotion).
- The layout reporter is active whenever `engine === "mpv"` (mounted once per
  engine state) and event-driven: viewport `ResizeObserver` + window `resize` +
  `fullscreenchange` + `mpv-loaded` + mount coalesce into at most one rAF per
  frame. It is **not** an endless 60 fps loop — once anchored
  (`key === lastKey`) the page is idle.
- If `[data-player-viewport]` is absent, the reporter sends no native layout and
  retries once per frame until it mounts (graceful absence).

## 15. Fullscreen rules

- Fullscreen (native window fullscreen **or** the web Fullscreen API button)
  changes **geometry only, not ownership**. The player still composes inside
  `[data-player-viewport]`; the column merely becomes fullscreen-sized during
  the web-fullscreen path (the product's fullscreen button also auto-hides the
  sidebar so the viewport fills the window).
- `fullscreenchange` is an explicit trigger for the reporter; the surface
  re-anchors to the new viewport rect after the animation settles (the smoke
  harness `settle()` waits ~2 s of stable rects so the ~1.5 s macOS fullscreen
  animation can't be misread as final).
- The top bar (`h-10`) is hidden in web fullscreen (`isFullscreenUi`) so the
  viewport rect becomes the full window; the transparent/opaque rules of §5
  still apply.

## 16. Responsive / mobile rules

- **Inline vs. drawer is platform-driven, not width-driven**: desktop
  (macOS/Windows/Linux Tauri + desktop browsers, via the `isMobileDevice()` UA /
  touch-points check) is **always** `relative`/inline — even in a sub-768 px
  window. Only real touch devices below `md` get the `absolute` drawer
  (`md:relative` upgrades a rotated phone/tablet).
- In drawer mode the PlayerViewport column spans the full window (the reporter
  dispatches it verbatim — drawer mode never shrinks the column), and the
  opaque drawer paints **over** the video by App layout (a flex/absolute overlay
  decision at the App level), never the reverse.
- The mobile plugins (Media3 ExoPlayer / AVPlayer) use the same `mpv_*` command
  surface; their native surfaces fill the whole window behind the transparent
  webview and `apply_surface_layout` is a deliberate no-op there. The webview
  stays on top, so DOM overlays work identically.
- The Reporter's boundary fallback reads the sidebar's **actual computed
  `position`** so desktop-narrow windows count as inline there too.

## 17. Acceptance criteria

| # | Criterion |
|---|-----------|
| 1 | `[data-sidebar]` and `[data-player-viewport]` are siblings in `[data-content-row]`; the video never paints over the sidebar at any window size. |
| 2 | The native surface rect == the `[data-player-viewport]` rect (after §9 conversion) at all times; no sidebar-derived geometry anywhere. |
| 3 | Exactly one video surface (`[data-native-stage]` xor `<video>`) is mounted. |
| 4 | Native stacking: webview/DOM overlays above the native picture on macOS/Windows/X11. |
| 5 | Sidebar open/close re-anchors the native surface to the new viewport rect exactly (±2 px) with zero drift accumulation. |
| 6 | Window resize re-anchors exactly; degenerate rects never collapse the surface. |
| 7 | Fullscreen enter/exit re-anchors to the full window (web path) / native window (OS path) exactly and stays transparent. |
| 8 | `mpv-embed-lost` and watchdog timeout always land on HTML5 with the same viewport rect. |
| 9 | `ZANPLAYER_NATIVE_LAYOUT_DEBUG=1` shows BLUE=Sidebar, RED=PlayerViewport, GREEN=video, YELLOW=overlay, MAGENTA=native frame, and the native frame coincides with the RED viewport outline. |
| 10 | No forbidden architecture of §13 exists in the code. |
| 11 | The viewport reporter idles once anchored (no perpetual rAF). |

## 18. Verification procedure

1. `npm run test` — full frontend suite (regression-covered: verbatim viewport
   tests, engine-switch rect identity, drawer/inline matrix, reporter idleness).
2. `npm run build` — `tsc && vite build` must pass.
3. `cargo test --features native-player,macos-render` (macOS) and
   `cargo clippy --features native-player,macos-render` (must be lint-clean).
4. Real macOS runtime with a **freshly built** artifact (never a stale build):
   `ZANPLAYER_NATIVE_SMOKE=1 ZANPLAYER_NATIVE_SMOKE_VIDEO=<path>
   ZANPLAYER_NATIVE_SMOKE_PAUSE=1 ZANPLAYER_NATIVE_LAYOUT_DEBUG=1
   ZANPLAYER_TRACE=1` for the 11-check battery, plus manual
   `ZANPLAYER_NATIVE_LAYOUT_DEBUG=1` visual check of §17.9.
5. The verification log must record: old vs. new artifact build timestamps,
   app version, backend (`macos-render` vs. `native-player`), smoke result
   (`RESULT: N/11 passed`), and the outcome of every acceptance criterion above.
6. The final report must close with exactly one verdict:

   > **PASS — CANONICAL PLAYER COMPOSITING MODEL VERIFIED**

   or

   > **BLOCKED — ARCHITECTURE / IMPLEMENTATION MISMATCH REMAINS**

---

*This document is the contract.* When code and this document disagree, the code
is wrong — fix the code, never the document (unless the document is proven
factually stale, in which case update the document first, in the same commit).