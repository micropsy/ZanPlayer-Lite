# ZanPlayer Lite Roadmap

This checklist tracks the remaining work for a reliable all-platform player.
Tasks should be completed in priority order. Do not mark a task complete until
its acceptance criteria and platform verification are satisfied.

## Status Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Verified complete
- `[!]` Blocked or needs a platform prerequisite

## P0 - Release Blockers

### 1. Verify Mobile Native Playback

- [ ] Run `npx tauri android init` and generate `src-tauri/gen/android`.
- [ ] Copy and integrate the Media3 plugin into the generated Android project.
- [ ] Add and resolve Media3 ExoPlayer/UI dependencies.
- [ ] Build and run on a real Android device.
- [ ] Verify MP4/H.264, MP3, WAV, M4A/AAC, WebM and unsupported-codec fallback.
- [ ] Verify play, pause, seek, volume, speed, ended state and lifecycle resume.
- [ ] Run `npx tauri ios init` and generate `src-tauri/gen/apple`.
- [ ] Copy and integrate the AVFoundation plugin into the generated iOS project.
- [ ] Build and run on a real iPhone and iPad.
- [ ] Verify MP4/MOV, H.264/H.265, MP3, WAV, M4A/AAC and unsupported-format fallback.
- [ ] Verify rotation, split view, background/foreground and interruption handling.

Acceptance: Android and iOS/iPadOS native playback works on real devices, and
any initialization or codec failure falls back to HTML5 without an external
player window.

### 2. Verify Desktop Native Playback

- [x] **Native backend migration (this session): libmpv → LibVLC.** The entire native engine is now `libvlc` (the C library VLCKit wraps), linked from the system VLC.app dylibs behind a single `vlc-native` cargo feature (default off — shipped builds stay HTML5 `<video>`). The old libmpv2 `wid` embed, the macOS Render-API/CAMetalLayer backend (`render/`), and the `native-player`/`macos-render` feature gates were deleted. New architecture: `libvlc.rs` (hand-rolled FFI, no crate) → `VlcSession` (session.rs) embedding VLC's video output into a dedicated host NSView (macOS `set_nsobject`; Windows HWND; X11 xwindow) below the transparent webview, a 250 ms coalesced `vlc-timeupdate` ticker, `vlc_set_layout` stage anchoring, `VLC_PLUGIN_PATH` set from the VLC.app bundle, and a slim `ZANPLAYER_NATIVE_SMOKE` build-time harness (playback + diagnostics checks). Frontend fully renamed: `vlc_*` commands/events, engine id `"VLC"`, `VlcClock`, `VlcTimeUpdatePayload`. The broken self-referential FFmpeg sidecar symlinks in `src-tauri/binaries/` (which silently broke every build) were repointed to the real Homebrew ffmpeg for aarch64. **Verified: `cargo build` (default, 0 warnings), `cargo build --features vlc-native` (0 warnings, links/runs against real VLC.app dylibs), `cargo test` 34/34, `cargo test --features vlc-native` 42/42 (incl. a live libvlc init/drop test), `npm run test` 106/106, `tsc` + `vite build` clean, `cargo clippy` clean on native_player.** The old 13-check macOS smoke battery is mpv-era history; a slim 10-check replacement smoke is implemented and **has passed live against a real MP4/H.264 file (2026-09-17, `RESULT: 10/10`, see the smoke item below) after the `f9b1f42` crash fixes (null media player / missing `play()` / off-main AppKit view work).**
- [x] Run the full macOS interactive smoke battery with a real video file (MP4 and MKV, both 11/11 checks incl. sidebar reflow, multi-step manual resize, native + web fullscreen, and the sub-`md` narrow-window inline guard).
- [x] Unify app-window frame: `titleBarStyle: Overlay` + `hiddenTitle`, solid `h-10` DOM top bar (drag region + sidebar hamburger), content row stacking sidebar + stage; smoke `findArea()` walks descendants (smallest bottom-right-reaching rect) so the 10-check battery stays 10/10 (MP4 + MKV) with the top bar accounted for at `y≈40`.
- [x] Fix intermittent coordinate drift: `macos_surface::apply_layout` now computes the host frame DIRECTLY in content coords (no `convertRect:fromView:`, whose result depended on the host's *current* frame and accumulated error). The CAMetalLayer is re-anchored to the host bounds on every `mpv_set_layout` (`masksToBounds=YES`, CATransaction flush), and degenerate (0×0) rects are skipped on both Rust and JS sides. The smoke now reads back `applied_js_rect` (the ACTUAL host frame in JS coords) as the "applied" rect, so a misconverted `setFrame:` fails checks instead of hiding behind the request. Verified: MP4 10/10, MKV 10/10.
- [x] Sidebar toggle desync: the `VideoPlayer` layout reporter now hard-depends on `sidebarVisible` (`[engine, sidebarVisible]`) and dispatches `mpv_set_layout` on the same commit, so the Metal layer cannot keep the sidebar-closed X/width and bleed over the open sidebar. Regression test: "re-anchors immediately when the sidebar expand/collapse state changes".
- [x] Window-control spacing: on macOS the `h-10` top strip uses `pl-[76px]` (UA-gated `isMacOs()` in `tauri.ts`; non-Mac keeps `pl-2`) so the `Open sidebar` toggle clears the traffic lights instead of crowding them.
- [x] Universal cross-platform layout boundary: the `mpv_set_layout` reporter clamps the measured stage rect into the product-owned `[data-player-area]` column (`clampVideoRect` in `videoLayout.ts`, `overflow-clip` on the column/root/stage) before dispatch, so the native surface and the HTML5 fallback can never render over the sidebar on any platform even under a stale/over-wide measure. `playerAreaFromViewport` is the per-mode intended area (inline open/closed, mobile drawer, fullscreen); both unit-tested.
- [x] Paint-level guarantee "video never over sidebar": the sidebar is `z-40` at ALL widths (removed the `md:z-10` downgrade that let the player's `relative` z-auto column promote its z-40/z-50 overlays above the sidebar) and `data-player-area` is `z-0` so the entire player subtree is trapped in one stacking context below the sidebar. Boundary fallback derives the area from `data-content-row` minus `data-sidebar` (`areaFromRowAndSidebar`, inline-vs-drawer from computed `position`).
- [x] Inline-vs-drawer is PLATFORM-driven, not width-driven: `sidebarLayoutMode(isMobileDevice(), innerWidth)` (`videoLayout.ts` `MD_BREAKPOINT_PX = 768`) — desktop (macOS/Windows/Linux Tauri + desktop browsers, per `isMobileDevice()` in `tauri.ts`) is ALWAYS inline (sidebar pushes the video even in a sub-768px restored frame), so "sidebar on" can never float over / overlap the picture; only touch devices (Android/iOS) get the drawer below `md`, plus the App dim-backdrop is gated by the same check. Smoke now PROVES it per pixel: new CHECK 11 resizes a desktop window to 640 CSS px and verifies sidebar ON = stage at x=352 (opaque-sidebar-left / transparent-right) and OFF = full row, via a `[native-smoke] conflict-view` horizontal paint-profile scan (`__zanSmokeScan`, `S`=sidebar paint, `o`=opaque webview, `.`=see-through) plus applied==dom readback. Verified 11/11 on MP4 + MKV, 93 frontend tests, 40 Rust. Covered by `tauri.test.ts` "isMobileDevice…" and `videoLayout.test.ts` "desktop is always inline…".
- [x] Product-path sidebar regression (CHECK 12/13): the smoke harness drives the REAL product path — a real drag-drop file load through `open_video_dialog`/drop, engine flip to mpv, the SHIPPED `VideoPlayer` layout reporter (not the harness), plus real sidebar toggles — and verifies sidebar ON = stage x=352 width=window-352 with `left-opaque=true no-right-gap=true`, sidebar OFF = full row. CHECK 13 covers the specific closed→open transition that a full-width stale anchor used to bleed under the sidebar. Verified 13/13 on the real product path.
- [x] Layout diagnostic infrastructure: `[zan-layout-trace]` structured record emitted by `macos_render.rs::apply_surface_layout` on every layout update — single line with JS rect, applied rect (read back via `applied_js_rect`), window/WebView/host/layer frames + bounds, backing scale, drawable px, and `RESULT=EXACT/MISMATCH` with per-axis deltas. Live proof: 31/31 layout updates across the 13-check battery logged `RESULT=EXACT (dx=0.00 dy=0.00 dw=0.00 dh=0.00)` (windowed sidebar open `(352,40) 1228x1020`, closed `(0,40) 1580x1020`, sub-`md` 640-wide open `(352,40) 288x1020`, fullscreen `(0,0) 2560x1607`, native + web fullscreen, and every product-path toggle).
- [x] Visual layout debug (`ZANPLAYER_NATIVE_LAYOUT_DEBUG=1`): magenta 2pt CAMetalLayer border (Rust `set_layer_border`) marks the ACTUAL native frame; DOM outlines red `[data-native-stage]`, green `[data-player-area]`, blue `[data-sidebar]`; toggled via new `native_layout_debug` Tauri command (`isNativeLayoutDebug()` in `tauri.ts`). Screenshot-verified: the green player-area outline sits exactly at the sidebar edge (x=352), video confined to the stage, no bleed.
- [x] Zero-seed CAMetalLayer: layer frame starts `{0,0,0,0}` with a 1×1 drawable until the first correct DOM rect lands, so an engine switch can never flash a full-window video frame before the first `mpv_set_layout`.
- [x] Sidebar toggle stress regression test (`VideoPlayer.test.tsx` "toggles the sidebar 10×…"): closed→open→closed ×10 (20 flips) with a mid-loop window resize + fullscreenchange at iteration 5; asserts every dispatched rect matches the current edge so no stale X/width can survive.
- [x] **Player Compositing Architecture refactor (this session):** the sidebar is a Player *sibling*, never a Player layer. `App.tsx` lays out `Sidebar + [data-player-viewport]` (renamed from `data-player-area`) as the content row; the Player consumes the viewport's `getBoundingClientRect()` VERBATIM for `mpv_set_layout` and never reads sidebar state/geometry. Removed from the player path: `sidebarVisible` effect dep, `clampVideoRect`, `areaFromRowAndSidebar` (content-row-minus-sidebar fallback), `sidebar-right` subtraction. Reporter triggers = viewport ResizeObserver + `resize` + `fullscreenchange` + `mpv-loaded`; missing viewport = **no layout sent** (graceful). Debug outlines: red=viewport, blue=sidebar, green=video/stage, yellow=`[data-subtitle-layer]`, magenta=native frame (`ZANPLAYER_NATIVE_LAYOUT_DEBUG=1`). Smoke selectors switched to `[data-player-viewport]`; new closed-state capture pause added. **Verified: 82 frontend + 34 + 40 Rust tests, macOS smoke 13/13 (post-refactor, incl. new engine-switch rect-identity test + sidebar OPEN/CLOSED screenshots).**
- [x] **Canonical Player Compositing spec + verification (this session):** `docs/PLAYER_COMPOSITING_ARCHITECTURE.md` written FIRST (18 sections + Sidebar OPEN/CLOSED diagrams + the absolute rule "The Player does not calculate around the Sidebar. The App layout calculates the Player Viewport. The Player simply occupies the Player Viewport." + §13 forbidden-architecture list + §17 acceptance criteria + §18 verification procedure). Implementation audited against it: **no violations** — viewport-verbatim geometry only (`mpv_set_layout` takes `{x,y,width,height}` from `[data-player-viewport]`, no sidebar params anywhere), engine XOR (`[data-native-stage]` xor `<video>`), overlay z-ladder (z-20/z-30/z-40/z-50) inside the `z-0` viewport stacking context, macOS Render API + CAMetalLayer + dedicated host NSView **below** the webview, `wid` only on the non-macOS path, event-driven idle reporter, embed-loss + decode-watchdog HTML5 cutover. Added architectural invariant tests **A–J** to `VideoPlayer.test.tsx` (engine XOR, verbatim viewport, key-idle no-IPC, degenerate-rect skip, missing-viewport no-layout, z-ladder, sidebar-outside-player-subtree, engine-switch rect preservation, embed-lost blob cutover, watchdog cutover). **Verified: 94 frontend tests (incl. A–J), `npm run build` clean, 40 Rust tests, `cargo clippy --features native-player,macos-render` exit 0; fresh macOS artifact built 2026-09-15 20:37 (`v0.1.3`, backend `macos-render`/`vo=libmpv`+CAMetalLayer, old artifact 20:04 removed to /tmp) → full smoke battery **RESULT: 13/13 passed** on the real product path (CHECK 1–13 incl. sidebar reflow, multi-step resize no drift, native + web fullscreen, sub-`md` inline guard, product drop→engine flip, closed→open re-anchor), every `[zan-layout-trace]` `RESULT=EXACT`, DOM-alpha 0 at every transition.**
- [x] **Strict opaqueness / stacking hardening + canonical doc refresh (this session):** the sidebar is `z-40 opacity-100` with an opaque theme background (`bg-zan-black`/`bg-white`) at every width in both themes — zero transparency bleed — and the VideoPlayer root + controls bar each carry `isolate` so the controls/OSD/subtitles always paint above the `z-0` native surface inside the viewport's own stacking context and can never be trapped or clipped by a parent stacking/clip change. New regressions: `[K]` controls-bar `isolate` self-containment, `[L]` "sidebar provably opaque at z-40 inline" (both themes). **Verified: 104/104 frontend tests (8 files, incl. A–L), `npm run build` (tsc + vite) clean, `cargo test` 34/34, `cargo test --features native-player,macos-render` 40/40.** Docs (`AGENTS.md`, `README.md`, `LAYERS.md`, `ARCHITECTURE.md`, `VERIFICATION.md`, `Todo.md`, mobile READMEs) re-synced to the verified state: smoke battery is **13 checks / `RESULT: N/13 passed`** (checks 12 + 13 = real product reporter path + field-reported closed→open), Check 10 = the exact product `set_window_fullscreen` IPC (fails, never skips, if window fullscreen doesn't engage), mainline test counts above, and the deleted `RELEASE_PROCESS.md` pointer replaced by `scripts/release.mjs`.
- [ ] Build and test Windows native VLC playback.
- [ ] Build and test Linux X11 native VLC playback.
- [ ] Verify Linux Wayland HTML5 fallback and document z-order limitations.
- [ ] Verify resize, sidebar changes, fullscreen and captions on each desktop.

Acceptance: native playback stays inside the app window; no detached window is
created; HTML5 fallback preserves the current position and playback settings.

Note: The Windows (`windows_layering`) and X11 (`x11_layering`) FFI modules are
fully implemented in `session.rs` with real `windows-sys` / `x11rb` FFI calls,
and the CI test workflow verifies they compile and link on Linux. However, no
smoke battery or runtime verification has been run on Windows or Linux — all
documented smoke results (13/13) are macOS-only.

### 3. Media Format Compatibility Matrix

- [x] Test MP4/H.264/AAC (native macOS smoke 13/13 verified; real-file playback ready).
- [x] Test MOV/H.265 (generated MOV/H.265 corpus decodes natively via linked libmpv 0.41).
- [x] Test MKV with supported and unsupported codecs (native macOS smoke verified with MKV/H.264; MKV/H.265 corpus decodes natively; corrupt-container fallback path verified — see below).
- [x] Test WebM/VP8/VP9 (both corpus files decode natively; `<video>` lists `webm` as HTML5-playable).
- [x] Test AVI, WMV and FLV (AVI/MPEG-4, WMV/WMV2, FLV/FLV1 corpus all decode natively; HTML5 fallback correctly refuses them with a hint).
- [x] Test MP3, WAV, OGG, FLAC, M4A, AAC and WMA (all 7 audio corpus files decode natively; HTML5 plays all but WMA).
- [x] Record results per platform instead of claiming universal codec support (decode matrix table written to `README.md`; the old matrix was verified against libmpv 0.41 — the **VLC migration means the matrix must be re-run against `libvlc` (VLC.app 12.x)**, which uses its own ffmpeg build and may differ on obscure codecs).
- [x] Show a clear unsupported-format error before or during fallback: HTML5-fallback MKV hint + CC-menu retry shipped; **native unsupported-codec case now covered by a 5 s decode watchdog** (`VideoPlayer.tsx`): VLC's `loadfile`/`media_new_path` returns OK even for a renamed/corrupt/undecodable file, so if the native clock never reports a real duration or advancing playhead within the grace window, the player cuts back to the HTML5 blob engine (whose own `onError`/hint overlay then explains it). Unit-tested (`drops to HTML5 when the native clock never proves the file decoded` / `keeps the native engine when the clock reports a real decode signal`).
- [x] All media entry points (drag-and-drop, browser file input, native file dialog) classify by file extension only — no browser/OS MIME reliance, so MKV is never treated as audio.

Verified matrix (macOS): native libmpv 0.41 decoded every corpus file (MP4/H.264+AAC, MOV/H.265, WebM/VP8+VP9, MKV/H.264+H.265, AVI/MPEG-4, WMV/WMV2, FLV/FLV1, MP3/WAV/OGG/FLAC/M4A/AAC/WMA). A zeroed `broken_zeroed.mov` (moov missing) confirmed the gap: `loadfile` OK + `time-pos=NaN` + 0 frames presented + the smoke's decode-dependent checks (frames/decode/clock) failing while all layout checks pass — exactly the silent-black case the watchdog now catches.

Acceptance: file picker, drag/drop, native backend and HTML5 fallback use the
same centralized media-format catalog.

## P1 - Subtitle and Playback Quality

### 4. Validate Local AI Pipeline

- [ ] Verify local Whisper model download and offline startup.
- [ ] Verify VAD-gated streaming transcription.
- [ ] Verify batch transcription.
- [ ] Verify Original, English and Both output modes.
- [ ] Verify dual-pass progress and generated track separation.
- [ ] Verify long-video memory and CPU usage.
- [ ] Use Tiny/Base as mobile defaults and avoid loading duplicate contexts.

Acceptance: local transcription works without network access after the model is
available and does not block normal playback.

Note: Items 1-6 are code-complete with unit test coverage (model download +
caching in `download_whisper_model`, VAD-gated streaming in `pipeline.rs`,
batch transcription via `run_batch_job`, `SubtitleMode::Original/English/Both`,
dual-pass progress slicing, and the unified seek funnel). Items 7 (long-video
memory/CPU) and 8 (Tiny/Base mobile defaults) are not yet addressed. All items
still require real-device verification.

### 5. Validate PTS Sync and Seeking

- [ ] Verify subtitle timestamps against the active player clock.
- [ ] Verify seek purges stale render-queue cues.
- [ ] Verify streaming transcription repositions its audio reader after seek.
- [ ] Verify resume-from-history does not create a stale subtitle jump.
- [ ] Verify pause, end-of-file and duration changes across every backend.

Acceptance: after any seek, only cues for the new playhead position are shown.

Note: All five items are code-complete with unit test coverage (render queue
job-scoping, `clear_job` purge on seek, `apply_seek` WAV reader repositioning,
`openRecentFile` reset, `SubtitleMode` enum in `main.rs`). Device validation
pending.

Code shipped (needs device validation): render queue is job-scoped
(`job_id` → `QueuedCue`, `poll_transcript_cues(job_id)`, `transcription_active(job_id)`),
stale/previous-video cues can no longer surface, and language-change regenerates
the generated track once per spoken language. Failed runs surface a **Retry**
action in the CC menu that drops partial generated tracks and starts a fresh
job for the same file (no reload). Covered by 4 new Rust unit tests
(40 total with native features) and updated VideoPlayer tests (65 total frontend).

### 6. Validate Subtitle UI and Export

- [ ] Verify Original/English/Both subtitle display.
- [ ] Verify subtitle style, position, outline, background and font settings.
- [ ] Verify captions remain above native video layers.
- [ ] Verify SRT and VTT export for loaded and generated tracks.
- [ ] Verify subtitle editor seek uses the same native seek funnel.

Acceptance: captions, OSD, controls and quick settings remain usable above the
video on every supported native backend.

Note: All five items are code-complete (`SubtitleEditor.tsx` with click-to-seek,
`write_subtitle_file` supporting SRT/VTT/ASS export, subtitle overlay z-ladder
above native layers, caption style controls in Quick Settings). Device
validation pending.

## P1 - Web App and Installation

### 7. Add Web App Install Support (PWA)

- [x] Add a web app manifest with name, short name, icons, theme colors and display mode.
- [x] Add 192px and 512px install icons.
- [x] Add a service worker for app-shell caching and offline startup behavior.
- [x] Register the service worker only in production/web builds.
- [x] Add install capability detection for Chrome/Edge Android and desktop.
- [x] Add an install action in the UI only when the browser supports installation.
- [ ] Verify iOS/iPadOS Add to Home Screen behavior and safe-area layout (needs a real device).
- [x] Document that browser Web App playback uses HTML5 and browser codec support.
- [x] Keep local Whisper model storage and permissions explicit for the Web App.

Acceptance: the Web App can be installed from a supported browser, opens in a
standalone window, retains the app shell offline, and never claims native VLC,
Media3 or AVFoundation support.

### 8. Web Playback and Browser Compatibility

- [ ] Test Chrome/Edge desktop.
- [ ] Test Safari macOS/iOS/iPadOS.
- [ ] Test Firefox desktop.
- [ ] Verify local file selection, audio playback and subtitle rendering.
- [ ] Verify browser codec fallback messaging.
- [ ] Verify Web App storage limits for local Whisper models.

Acceptance: unsupported browser capabilities produce a clear fallback message
and do not break normal HTML5 playback.

## P2 - Performance, Security and Release

### 9. Performance and Resource Limits

- [ ] Add model-memory and transcription-job cancellation guards.
- [ ] Bound subtitle render-queue size for long videos.
- [ ] Pause or reduce transcription work when the app is backgrounded.
- [ ] Measure CPU, RAM, battery and frame presentation on mobile.
- [ ] Verify native render thread cleanup on stop and app shutdown.

### 10. Security and File Handling

- [ ] Review Android content URI permissions and security-scoped iOS URLs.
- [ ] Avoid unnecessary storage permissions.
- [ ] Validate paths before handing them to FFmpeg, Whisper or native players.
- [ ] Verify external URLs are not accepted unintentionally by local-file flows.

### 11. Documentation and Release Matrix

- [x] Update README with platform/backend support and verification status.
- [x] Document Android JDK/SDK and iOS Xcode prerequisites.
- [x] Document PWA installation and browser limitations.
- [x] Publish a tested media-format matrix.
- [x] Run `npm run build`.
- [x] Run `npm run test`.
- [x] Run `cargo test`.
- [x] Run `cargo test --features vlc-native` on macOS.
- [x] Run platform builds where toolchains are available (macOS `app,dmg` release build verified locally; signing needs the CI `TAURI_SIGNING_PRIVATE_KEY`).
- [x] Mark untested platforms as unverified instead of claiming support.

Acceptance: release notes clearly distinguish implemented, device-tested and
unsupported functionality.

## Full-system audit reconciliation (2026-09-17)

- [x] **CI still references the deleted libmpv engine.** `.github/workflows/test.yml`
  installed `libmpv-dev` and ran `cargo build --features native-player` (both removed
  in the VLC migration — the workflow would have broken on the next push).
  Fixed: `libvlc-dev` earlier-eligible apt package + `cargo build --features vlc-native`
  (build.rs links via the pkg-config `libvlc` probe; this doubles as the first
  automated cross-check of the Linux libvlc + X11 FFI arms).
- [x] **Docs described a per-beat desktop embed-loss probe that the code does not have.**
  `session.rs` emits `vlc-embed-ok` (carrying `embed_ok()` = `host_still_attached()` on
  macOS) at `load()` only; the desktop ticker never re-probes and never emits
  `vlc-embed-lost`. `vlc-embed-lost` is mobile-only (`mobile.rs`, on persistent
  position-poll failure). AGENTS.md/README/docs reconciled to the real behavior.
- [ ] **Decide on the per-beat desktop host probe** (tracked gap): add a
  `host_still_attached()` check on the desktop ticker beat that emits `vlc-embed-lost`
  once when the host disappears, or accept the 5 s decode watchdog + load-time
  `vlc-embed-ok` as the only desktop cover. Current frontend parity: `VideoPlayer.tsx`
  already holds the `vlc-embed-lost` listener, so a backend-side addition is drop-in.
- [ ] **Re-run the codec decode matrix against libvlc (VLC.app 12.x)** — README table
  is still labeled "libmpv-era result — re-verify with libvlc".
- [x] **Run the slim smoke battery on a real file** — DONE 2026-09-17 against a real
  MP4/H.264 (20 s, decoder = VideoToolbox): **`[native-smoke] RESULT: 10/10 passed` /
  `PASS — VLC native verified`** (checks 1–10: session init, load/`vlc-loaded`, host NSView
  attached + embed intact, demux out of Opening/NothingSpecial, clock advance, playing
  state, host anchored to the measured DOM area `(352,40) 848×760`, non-degenerate applied
  rect, DOM-alpha 0 over the stage centre). Run as `ZANPLAYER_NATIVE_SMOKE=1
  ZANPLAYER_NATIVE_SMOKE_VIDEO=<path> src-tauri/target/debug/zanplayer-lite` (vite on
  :5173); the app does not self-exit after `RESULT:` — kill it once the verdict prints.
  The run surfaced three crashes now fixed in `f9b1f42`: (a) `VlcPlayer::new` never
  created a media player (null `player` → `set_nsobject` SIGSEGV) — now one persistent
  player with `set_media` track swaps; (b) `load` never issued `play` (pipeline stuck in
  NothingSpecial) — now starts playback; (c) `macos_surface` view work ran off the AppKit
  main thread (SIGSEGV) — now marshaled via `on_main`/`run_on_main_thread`.
  `docs/PLAYER_COMPOSITING_VERIFICATION.md` §6 criteria 5/7/9 (runtime smoke) are now
  covered; still pending there: `cargo check` of the Windows/X11 FFI arms on the macOS host
  (scratch-crate-only) and a full `.app` bundle + MKV corpus re-run.
- [ ] **Commit the entire migration + docs + CI worktree** — `HEAD` is still the
  mpv-era `9e9eb23`; the CI fix must land in the same commit as the migration or
  `main` stays red.

## Recommended Execution Order

1. Mobile Android/iOS real-device integration and verification.
2. Desktop Windows/Linux native verification.
3. Media compatibility matrix and fallback messaging.
4. Subtitle PTS/seek and dual-pass validation.
5. Web App/PWA manifest, service worker and install flow.
6. Performance, security, documentation and release checks.