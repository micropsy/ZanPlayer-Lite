# Player Compositing Architecture — Verification Report

Date: 2026-09-15 · Vault: `/docs/PLAYER_COMPOSITING_ARCHITECTURE.md` (canonical spec)
Verdict: **PASS — CANONICAL PLAYER COMPOSITING MODEL VERIFIED**

---

## 1. Artifact (old → new)

| | Old artifact | New artifact |
|---|---|---|
| Path | `/Applications/ZanPlayer Lite.app` | `/Applications/ZanPlayer Lite.app` (rebuilt) |
| Built | 2026-09-15 20:04:42 | **2026-09-15 20:37:17** |
| Removed-to on replace | — | `/tmp/ZanPlayer Lite.app.old-<ts>` |
| App version | v0.1.3 | **v0.1.3** |
| Backend | `macos-render` (`vo=libmpv` + CAMetalLayer) | **`macos-render` (`vo=libmpv` + CAMetalLayer)** |
| binary | — | `zanplayer-lite` 30,554,112 B, `ffmpeg` 51,785,792 B |
| Signature | — | ad-hoc resign `--force --sign - --timestamp=none --deep` |

Build command: `npx tauri build --bundles app -- --no-default-features --features native-player,macos-render`
(updater signing step exit=1 only — no `TAURI_SIGNING_PRIVATE_KEY`; `.app` bundle produced).

## 2. Canonical spec

- Created **first** (before any code): `docs/PLAYER_COMPOSITING_ARCHITECTURE.md`
- Contents: §1 Purpose, §2 Scope, §3 Principles, §4 App-level layout model,
  §5 Player compositing model, §6 HTML5 model, §7 Native mpv model,
  §8 Subtitle/OSD/control model, §9 Coordinate-space contract,
  §10 Sidebar OPEN diagram, §11 Sidebar CLOSED diagram, §12 Native macOS
  hierarchy, §13 Forbidden architectures (14 items), §14 Engine switching rules,
  §15 Fullscreen rules, §16 Responsive/mobile rules, §17 Acceptance criteria,
  §18 Verification procedure.
- Absolute rule is verbatim in §3.

## 3. Implementation audit vs. spec

| Component | File(s) | Role | Correct? | Change required |
|---|---|---|---|---|
| Content row | `App.tsx:339` | `relative isolate flex` wraps Sidebar sibling + PlayerViewport column | ✅ | none |
| Sidebar | `App.tsx:340` / `Sidebar.tsx:366` | z-40 flex sibling, platform-driven inline/drawer (`sidebarLayoutMode`) | ✅ | none |
| PlayerViewport | `App.tsx:354` | `z-0 min-h-0 min-w-0 flex-1 overflow-clip` — single geometry authority | ✅ | none |
| Player root | `VideoPlayer.tsx:1390` | transparent in native / `bg-black` otherwise, `overflow-clip` | ✅ | none |
| Layer 2 video (XOR) | `VideoPlayer.tsx:1402-1454` | `isNative ? [data-native-stage] : <video>`, both `z-0` | ✅ | none |
| Layer 1 overlays | `VideoPlayer.tsx:1489-1995` | subtitles `z-30`, play/pause `z-20`, controls `z-40`, quick settings `z-50` | ✅ | none |
| Geometry reporter | `VideoPlayer.tsx:1010-1118` | read `[data-player-viewport]` gBCR verbatim; triggers RO/`resize`/`fullscreenchange`/`mpv-loaded`; rAF coa; key-idle; degenerate/missing → no IPC | ✅ | none |
| IPC contract | `tauri.ts:431` `mpvSetLayout(rect: SurfaceLayout)` | `{x,y,width,height}` only — no sidebar params | ✅ | none |
| Command | `mod.rs:292` `mpv_set_layout` | dispatch to per-OS `apply_surface_layout`, `sanitize_surface_layout` | ✅ | none |
| macOS native geometry | `session.rs:642` macOS `apply_layout` | direct content coords, no `convertRect:fromView:`, clamps to webview bounds, skip degenerate | ✅ | none |
| macOS native render | `render/macos_render.rs` | Render API `vo=libmpv` no-wid → CAMetalLayer → host NSView below webview; drawableSize/contentsScale live | ✅ | none |
| Stacking | `session.rs:717` `keep_webview_on_top` | webview topmost re-asserted per tick + post-load (macOS re-sort / Windows SetWindowPos / X11 raise) | ✅ | none |
| Mobile | `mobile.rs:199` | `apply_surface_layout` deliberate no-op; full-window native behind webview | ✅ | none |
| Engine cutover | `VideoPlayer.tsx:1121-1271` | embed-lost → HTML5 blob; watchdog `NATIVE_DECODE_WATCHDOG_MS` → HTML5 | ✅ | none |
| Visual debug | `VideoPlayer.tsx:1016-1031` + `macos_render.rs:37,532` | red=viewport, blue=sidebar, green=video/stage, yellow=subtitle, magenta=native layer | ✅ | none |

**Forbidden §13 scan:** stale `data-player-area` — none; sidebar tokens in player/native geometry — none; `wid` — only non-macOS session; full-window init — none; `convertRect:fromView:` — none; both engines mounted — impossible (XOR ternary).

### Result: NO VIOLATIONS. No code changes were required.

## 4. Tests A–J added (`VideoPlayer.test.tsx`)

A engine XOR · B verbatim viewport rect · C key-idle (no IPC on unchanged rect) ·
D degenerate 0×0 rect skipped · E missing viewport no-layout ·
F overlay z-ladder (z-40 controls, z-20 play/pause, z-0 stage) ·
G sidebar outside player subtree · H engine-switch preserves rect ·
I embed-lost blob cutover · J watchdog cutover within 5 s.

## 5. Verification runs

| Command | Result |
|---|---|
| `npm run test` | **94/94 passed** (8 files) — incl. A–J |
| `npm run build` (`tsc && vite build`) | clean |
| `cargo test --features native-player,macos-render` | **40/40 passed** |
| `cargo clippy --features native-player,macos-render` | exit 0 (15 pre-existing warnings, no errors, none new) |

## 6. Real macOS runtime verification (fresh artifact)

Env: `ZANPLAYER_NATIVE_SMOKE=1 ZANPLAYER_NATIVE_SMOKE_VIDEO=<h264/aac .mp4, 4327.88 s> ZANPLAYER_NATIVE_SMOKE_PAUSE=1 ZANPLAYER_NATIVE_LAYOUT_DEBUG=1 ZANPLAYER_TRACE=1` → `/tmp/zanplayer-smoke-final.log`

- Render context no-error, **custom** `<video>`+libmpv decode: `vo=libmpv hwdec=no video-format=h264`, frames-presented=29 (rising) at first diagnostic.
- **`[native-smoke] RESULT: 13/13 passed`** — all 13 checks OK:
  1 render context error-free · 2 ≥1 Metal frame · 3 vo=libmpv decode · 4 clock advancing · 5 webview not occluding · 6 stage re-anchor to resize · 7 sidebar reflow re-anchor + transparent · 8 multi-step resize no drift + transparent · 9 native fullscreen enter/exit re-anchor + transparent · 10 product web-Fullscreen button re-anchor + transparent · 11 sub-`md` 640-wide desktop inline sidebar (ON opaque-left/transparent-right, OFF full row) · 12 product drop→engine flip→real reporter tracks sidebar toggle · 13 closed→open re-anchor (x=352, width=window−352).
- Every `[zan-layout-trace]` line `RESULT=EXACT (dx=0.00 dy=0.00 dw=0.00 dh=0.00)` — 30+ updates incl. fullscreen enter/exit and both web-fullscreen transitions (windowed `(352,40)…`, fullscreen `(0,0) 3840x2160`, native `(352,40) 3488x2120`, sub-`md` `(352,40) 288x1020`).
- DOM-alpha 0 at every transition; `conflict-view` paint scans show `S…S` (opaque sidebar left) / `.…` (see-through stage) with zero gaps at every size.
- Visual layout debug active (`native_layout_debug` = true under the env); PALETTE as specified: BLUE `[data-sidebar]`, RED `[data-player-viewport]`, GREEN video/stage, YELLOW `[data-subtitle-layer]` (DOM outlines) + MAGENTA native CAMetalLayer border (Rust) — native frame visibly coincides with the RED viewport outline.

## 7. Acceptance criteria (§17)

All 11 verified (1 siblings/no bleed · 2 native rect==viewport rect · 3 engine XOR ·
4 webview-on-top · 5 sidebar-toggle exact re-anchor · 6 resize exact + degenerate skip ·
7 fullscreen exact + transparent · 8 embed-lost/watchdog→HTML5 · 9 debug palette hit ·
10 no forbidden architecture · 11 idle reporter).

## 8. Deliverables

- `docs/PLAYER_COMPOSITING_ARCHITECTURE.md` — canonical spec
- `VideoPlayer.test.tsx` — +10 tests A–J (30 → 40 in-file; 84 → 94 suite)
- `Todo.md` — verification entry published
- Fresh `ZanPlayer Lite.app` installed at 20:37:17, smoke-logged 13/13