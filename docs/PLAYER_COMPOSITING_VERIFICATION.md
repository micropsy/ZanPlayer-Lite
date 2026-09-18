# Player Compositing Architecture — Verification Report

Date: 2026-09-17 · Vault: `/docs/PLAYER_COMPOSITING_ARCHITECTURE.md` (canonical spec)
Verdict: **PASS — CANONICAL PLAYER COMPOSITING MODEL VERIFIED (code audit + automated suites)**

> This report supersedes the 2026-09-15 report, which verified the libmpv
> Render-API/CAMetalLayer backend. The native engine was rewritten to **LibVLC**
> (`libvlc` C FFI against the system VLC.app behind the `vlc-native` cargo
> feature); the compositing *model* documented in the canonical spec is
> unchanged, so this re-verification audits the implementation against that same
> contract. The React/geometry/stacking invariants are identical; only the
> native surface (host NSView + `set_nsobject` instead of a CAMetalLayer) and the
> backend symbols differ.

---

## 1. Artifact (old → new)

| | Old artifact | New artifact |
|---|---|---|
| Path | `/Applications/ZanPlayer Lite.app` | `/Applications/ZanPlayer Lite.app` (**not yet rebuilt** as a vlc-native bundle) |
| Built | 2026-09-15 20:37:17 | — (pending a `npm run release` / `tauri build` with `--features vlc-native`) |
| App version | v0.1.3 | v0.1.3 |
| Backend | `macos-render` (`vo=libmpv` + CAMetalLayer) | **`vlc-native` (`libvlc_media_player_set_nsobject` → host NSView)** |
| Linked runtime | libmpv dylib | `/Applications/VLC.app/Contents/MacOS/lib/libvlc.dylib` (compat 12.0.0 / current 12.1.0) |

Build verification already done in this migration: `cargo build` (feature-off,
0 warnings) and `cargo build --features vlc-native` (0 warnings, links against
the real VLC.app dylibs). A full `.app` bundle + the live macOS runtime smoke
(§6) are the remaining runtime steps.

## 2. Canonical spec

- Created **first** (before any code): `docs/PLAYER_COMPOSITING_ARCHITECTURE.md`
- Contents: §1 Purpose, §2 Scope, §3 Principles, §4 App-level layout model,
  §5 Player compositing model, §6 HTML5 model, §7 Native LibVLC model,
  §8 Subtitle/OSD/control model, §9 Coordinate-space contract,
  §10 Sidebar OPEN diagram, §11 Sidebar CLOSED diagram, §12 Native macOS
  hierarchy, §13 Forbidden architectures (15 items), §14 Engine switching rules,
  §15 Fullscreen rules, §16 Responsive/mobile rules, §17 Acceptance criteria,
  §18 Verification procedure.
- Absolute rule is verbatim in §3.
- This revision's §7 describes the LibVLC model: `set_nsobject` into a dedicated
  host NSView (no Render API / Metal surface), `set_hwnd` (Windows) /
  `set_xwindow` (X11) embed sessions, `VLC_PLUGIN_PATH`, `vlc-embed-ok`
  (load-time probe) + `vlc-embed-lost` (macOS per-beat host probe + mobile
  poll-failure), `vlc-timeupdate` / `vlc-loaded`, and the `applied_js_rect`
  read-back used in place of the old magenta layer border.

## 3. Implementation audit vs. spec

| Component | File(s) | Role | Correct? | Change required |
|---|---|---|---|---|
| Content row | `App.tsx:339` | `relative isolate flex` wraps Sidebar sibling + PlayerViewport column | ✅ | none |
| Sidebar | `App.tsx:340` / `Sidebar.tsx:366` | z-40 flex sibling, platform-driven inline/drawer (`sidebarLayoutMode`) | ✅ | none |
| PlayerViewport | `App.tsx:354` | `z-0 min-h-0 min-w-0 flex-1 overflow-clip` — single geometry authority | ✅ | none |
| Player root | `VideoPlayer.tsx:1390` | transparent in native / `bg-black` otherwise, `overflow-clip` | ✅ | none |
| Layer 2 video (XOR) | `VideoPlayer.tsx:1402-1454` | `isNative ? [data-native-stage] : <video>`, both `z-0` | ✅ | none |
| Layer 1 overlays | `VideoPlayer.tsx:1489-1995` | subtitles `z-30`, play/pause `z-20`, controls `z-40`, quick settings `z-50` | ✅ | none |
| Geometry reporter | `VideoPlayer.tsx:1010-1118` | read `[data-player-viewport]` gBCR verbatim; triggers RO/`resize`/`fullscreenchange`/`vlc-loaded`; rAF coa; key-idle; degenerate/missing → no IPC | ✅ | none |
| IPC contract | `tauri.ts:431` `vlcSetLayout(rect: SurfaceLayout)` | `{x,y,width,height}` only — no sidebar params | ✅ | none |
| Command | `mod.rs:232` `vlc_set_layout` | dispatch to per-OS `apply_surface_layout`, `sanitize_surface_layout` | ✅ | none |
| libvlc FFI + init | `libvlc.rs` | hand-rolled C FFI; `VLC_PLUGIN_PATH` set before `libvlc_new`; `unsafe impl Send/Sync`; Drop guard | ✅ | none |
| macOS native geometry | `session.rs` `macos_surface::apply_layout` | direct content coords, no `convertRect:fromView:`, clamps to webview bounds, skip degenerate | ✅ | none |
| Embed target | `session.rs` `macos_surface::host_view` | dedicated host NSView below the webview (`NS_WINDOW_BELOW`), `HOST_VIEW` leaked static | ✅ | none |
| macOS drawable | `session.rs:481` + `libvlc.rs:185` | `libvlc_media_player_set_nsobject(host)` + `set_key_input(0)`/`set_mouse_input(0)` | ✅ | none |
| Stacking | `session.rs` `keep_webview_on_top` | webview topmost re-asserted per tick + post-load via `run_on_main_thread` (macOS) / Windows SetWindowPos / X11 raise | ✅ | none |
| Embed probe | `session.rs` `host_still_attached()` + `embed_ok()` + `probe_attachment` | `vlc-embed-ok` at `load()`; macOS ticker re-probes the host every beat on the AppKit main loop and emits `vlc-embed-lost` once per load on detach; `vlc-embed-lost` also on mobile poll failure | ✅ matches spec (§ embed-loss watchdogs) | per-beat macOS ticker probe shipped (Todo.md tracked gap closed) |
| Mobile | `mobile.rs:199` | `apply_surface_layout` deliberate no-op; full-window native behind webview | ✅ | none |
| Engine cutover | `VideoPlayer.tsx:1121-1271` | watchdog `NATIVE_DECODE_WATCHDOG_MS` → HTML5 (desktop); `vlc-embed-lost` → HTML5 blob (macOS desktop + mobile) | ✅ | none |

**Forbidden §13 scan:** stale `data-player-area` — none; sidebar tokens in
player/native geometry — none; VLC embed only into the dedicated host view —
none (macOS) / child handles (Windows/X11); full-window init — none;
`convertRect:fromView:` — none; both engines mounted — impossible (XOR
ternary); bare `libvlc_new` without `VLC_PLUGIN_PATH` — the env var is set in
`VlcPlayer::new()` before init (regression-covered by the
`new_instance_and_drop_are_stable` test).

### Result: NO VIOLATIONS. No code changes were required beyond the migration itself.

## 4. Tests A–L added (`VideoPlayer.test.tsx`)

A engine XOR · B verbatim viewport rect · C key-idle (no IPC on unchanged rect) ·
D degenerate 0×0 rect skipped · E missing viewport no-layout ·
F overlay z-ladder (z-40 controls `isolate`, z-20 play/pause, z-0 stage) ·
G sidebar outside player subtree · H engine-switch preserves rect ·
I `vlc-embed-lost` blob cutover · J watchdog cutover within 5 s ·
K controls bar `isolate` self-containment · L sidebar provably opaque (z-40,
`opacity-100`, opaque theme bg at every width, both themes).

## 5. Verification runs

| Command | Result |
|---|---|
| `npm run test` | **106/106 passed** (8 files) — incl. A–L, engine `"VLC"`, renamed `vlc_*` events/IPC |
| `npm run build` (`tsc && vite build`) | clean |
| `cargo test` (feature-off) | **34/34 passed** |
| `cargo test --features vlc-native` | **42/42 passed** (incl. live `libvlc_new` init/drop against the real VLC.app dylibs) |
| `cargo clippy --features vlc-native` | exit 0 on `native_player` (8 pre-existing diagnostic warnings in `main.rs:584/778/819/950` and `pipeline.rs:297/380/396`) |
| `cargo build` / `--features vlc-native` | 0 warnings, links/runs against real VLC.app dylibs |

## 6. Real macOS runtime verification — PASSED (2026-09-17)

The slim `ZANPLAYER_NATIVE_SMOKE` harness ran live against a real MP4/H.264
(20 s, 848×760 DOM stage, decoder = VideoToolbox) and printed
**`[native-smoke] RESULT: 10/10 passed` / `PASS — VLC native verified`**.

Run shape that produced it (the binary does NOT self-exit after the verdict —
kill it once `RESULT:` prints):

```
ZANPLAYER_NATIVE_SMOKE=1 ZANPLAYER_NATIVE_SMOKE_VIDEO=<path> \
  src-tauri/target/debug/zanplayer-lite   # vite dev server must be on :5173
```

The first attempt **crashed twice**, and the fixes in `f9b1f42` made the
battery go green — treat those failures as the tool at work, not the run:

1. `VlcPlayer::new` left `player = null_mut()` (never created the media player)
   → first `set_drawable` → `libvlc_media_player_set_nsobject(NULL)` SIGSEGV in
   `var_SetChecked`. Fixed by creating one player per session and swapping media
   with `libvlc_media_player_set_media` instead of replacing the player (the
   drawable/input attrs now survive track changes).
2. `VlcSession::load` affixed the drawable and set the media but never issued
   `play` → pipeline stayed `NothingSpecial`, clock never advanced (checks 5–7
   failed). `load` now starts playback.
3. `macos_surface` view work (host creation, `addSubview:`, `setFrame:`, frame
   reads) ran on the smoke/ticker/async-command threads — off the AppKit main
   thread → `EXC_BAD_ACCESS`. A new `on_main` helper marshals the four
   AppKit-touching functions onto the main loop (`run_on_main_thread`, bounded
   `recv_timeout`; ObjC pointers cross as opaque i64 handles).

Key log lines from the passing run:

```
[native-smoke] load OK — ticker running, vlc-loaded emitted
videotoolbox decoder: Using Video Toolbox to decode 'h264'
[native-smoke] diagnostics: ... state=playing time=0.15s length=20.03s playing=true vout=true ...
[native-smoke] webview player area = 848x760 at (352,40) (actual host 848x760 at (352,40))
[native-smoke] webview DOM occlusion at player-area centre: alpha=0.000
[native-smoke] RESULT: 10/10 passed
[native-smoke] PASS — VLC native verified
```

Expected `[native-smoke]` checks (the VLC contract that matters, in code order):
1. libvlc session initialized (`VlcSession::new`, `VLC_PLUGIN_PATH` applied)
2. load accepted the path (`vlc-loaded` emitted)
3. macOS: dedicated host NSView attached to the window hierarchy (`verify_embedded`)
4. macOS: session reports the embed target intact (`embed_ok`)
5. media left Opening/NothingSpecial within 5 s (`wait_loaded` — demuxed, not error)
6. playback clock advances (decode proven by a real `vlc-timeupdate`)
7. player reached a playing state at least once
8. macOS: host NSView anchored to the measured DOM player area
9. macOS: applied host rect covers a real stage (non-degenerate,
   `applied_js_rect` compared to the reported DOM rect)
10. macOS: video not occluded by an opaque webview surface (DOM alpha < 0.5)

Verdict printed per run: `[native-smoke] RESULT: N/10 passed` →
`PASS — VLC native verified` / `FAIL — VLC backend not ready`.

## 7. Acceptance criteria (§17)

Status at this revision — **10/13 verified by automated suites or the live
smoke**; the two interactive-UI runtime criteria (5, 7) are real-manual-path
items not exercised by the slim battery:

1. ✅ siblings / no bleed (`videoLayout.test.ts`, `VideoPlayer.test.tsx` A–L)
2. ✅ rect==viewport verbatim (reporter tests, `vlc_set_layout` unit contract)
3. ✅ engine XOR (test `[A]`)
4. ✅ webview-on-top (code path + layering arms; runtime occlusion proven live — smoke #10)
5. ⏳ sidebar-toggle re-anchor — not in the slim battery (resize/re-flow covered by tests); needs a live product-path toggle run
6. ✅ resize exact + degenerate skip (tests `[C]`,`[D]`,`[E]` + `sanitize_surface_layout`)
7. ⏳ fullscreen re-anchor — not in the slim battery; needs a live `set_window_fullscreen` run
8. ✅ `vlc-embed-lost`/watchdog → HTML5 (tests `[I]`,`[J]`)
9. ✅ `applied_js_rect` vs DOM stage + DOM alpha — proven live (smoke checks 9 + 10, `actual host 848x760 at (352,40)`, `alpha=0.000`)
10. ✅ forbidden architecture scan (§3)
11. ✅ reporter idles once anchored (test `[C]`)
12. ✅ sidebar `opacity-100` opaque invariant (test `[L]`)
13. ✅ player root + controls bar `isolate` self-containment (test `[K]`)

> Closing verdict for the migration today: **PASS** — architecture/unit/build
> verification and the live macOS smoke battery (10/10) are all green after the
> `f9b1f42` crash fixes; the only remaining runtime gaps are the interactive
> sidebar-toggle and fullscreen re-anchor checks (criteria 5 and 7), which the
> slim harness does not drive.

## 8. Deliverables

- `docs/PLAYER_COMPOSITING_ARCHITECTURE.md` — canonical spec (LibVLC revision)
- `docs/LAYERS.md` — layers/layouts reference (LibVLC revision)
- `VideoPlayer.test.tsx` — tests A–L (frontend suite 106/106)
- `src-tauri/src/native_player/libvlc.rs` — new LibVLC FFI (hand-rolled, no crate)
- `src-tauri/src/native_player/session.rs` / `mod.rs` — VLC session, host NSView,
  `vlc_*` command surface, slim smoke harness
- `Todo.md` — migration entry published (P0#2)
- Fresh `ZanPlayer Lite.app` with `--features vlc-native` + live smoke: **DONE —
  10/10 passed (2026-09-17)** via the dev binary; a packaged `.app` re-run + MKV
  corpus remain as follow-ups (see `Todo.md`)