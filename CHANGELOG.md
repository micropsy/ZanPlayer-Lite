# ZanPlayer Lite — Changelog

All notable changes to **ZanPlayer Lite** are documented here. Versions follow
[Semantic Versioning](https://semver.org/), and every release commit carries a
`vX.Y.Z` tag that triggers the automated GitHub Actions release build (DMG /
AppImage / DEB / MSI).

---

## [Unreleased]

_No unreleased changes._

---

## [0.1.6] — 2026-09-18

### 🎬 Self-contained native playback on macOS

Fixes the *"this fallback player can't decode it"* message on every shipped
macOS build: the app's native engine is now bundled **inside** the `.app`, so
MKV/AVI/WMV/FLV and every other catalogued container plays without requiring
VLC.app on the user's Mac.

- `scripts/bundle-vlc.sh` stages `libvlc.dylib` + `libvlccore.dylib` + the
  full plugin tree from the build machine's VLC.app into the macOS bundle
  (`Contents/Resources/vendor/vlc/`).
- `build.rs` emits a bundle-first rpath (`@executable_path/../Resources/vendor/
  vlc/lib`) before the system-VLC rpath, so installed apps load the embedded
  engine while unbundled dev builds still resolve against VLC.app.
- The plugin path resolver prefers the bundled tree, guaranteeing the loaded
  libvlc and plugins share one version/arch.
- The release workflow installs VLC, stages the engine, and builds the macOS
  artifacts with `--features vlc-native`.
- Result: the shipped macOS DMG/tar.gz self-contained native engine is proven
  by the 10/10 native smoke test decoding an MKV with no system VLC present.

---

## [0.1.5] — 2026-09-18

### 🛠️ Hardened subtitle parsing

- **SRT/VTT import tolerates real-world files**: the parser no longer depends on
  blank-line-separated blocks, so single-`\n` formatted SRTs, CRLF line endings,
  index-less cues, and a leading UTF-8 BOM all import correctly.
- **Cue timing is format-agnostic**: `,` or `.` millisecond separators, 1–3
  digit fractions, and VTT cue settings after the end timestamp (e.g.
  `align:start`) are all accepted; multi-line cue text is preserved.
- **Numeric cue ordinals / VTT identifiers are never mistaken for subtitle
  text**, and contiguous VTT cues (no blank line between them) are no longer
  dropped.

---

## [0.1.4] — 2026-09-17

### 🎬 Native playback engine: libmpv / CAMetalLayer → **LibVLC** (`vlc-native`)

The single biggest change in this release is a ground-up replacement of the
macOS native engine.

- **Removed** the deprecated macOS Render-API / CAMetalLayer backend and its
  `native-player` / `macos-render` feature gates.
- **New in-window LibVLC engine**: hand-rolled C FFI against the system
  `VLC.app` dylibs (no binding crate, no `#[link]`); `build.rs` emits the link
  flags, and macOS bundles the required `.app` dylibs via `otool` → `rcodesign`.
- **Embed target is a dedicated host NSView** positioned below the transparent
  webview. This fixes the classic *"VLC opens a floating window"* bug caused by
  WebKit pruning foreign subviews of the webview it owns, and keeps DOM
  captions / controls / OSD permanently above the picture.
- **Flawless offline decoding of every catalogued container** — MKV, MOV, MP4,
  AVI, WMV, FLV, WebM and more, decoded by VLC/ffmpeg (VideoToolbox hardware
  acceleration on macOS). Containers the HTML5 `<video>` fallback cannot demux
  (MKV/AVI/FLV/WMV) now play natively.
- **Stage anchoring**: `vlc_set_layout` pins the native surface exactly onto
  the DOM player viewport, with a right-of-sidebar invariant so the picture can
  never paint under or over the inline sidebar, plus degenerate-rect and
  missing-viewport guards.
- **Tauri *window* fullscreen** so the host view and webview grow together into
  the fullscreen Space — the old DOM-Fullscreen API stranded the picture in a
  separate window.
- **Unified `vlc_*` IPC** with a coalesced 250 ms `vlc-timeupdate` clock, one
  seek funnel, and webview-owned captions (VLC SPU rendering disabled).
- **Resilient fallback**: a decode watchdog + embed-loss cutover drop back to
  the HTML5 engine with a visible reason instead of a silent black frame.
- Shipped builds remain feature-off (HTML5 `<video>` is the default);
  `vlc-native` is a clean compile-time opt-in.

### 🛠️ Reliability & bug fixes

- **Window dragging fix**: dragging a *focused* webview no longer silently
  dies. A synthesized AppKit `LeftMouseDown`
  (`performWindowDragWithEvent:`) is issued at the live cursor for focused and
  unfocused states alike.
- **Crash fixes surfaced by the live native smoke battery**:
  - the VLC media player is now actually created on session start (a null
    player segfaulted `libvlc_media_player_set_nsobject`);
  - `load()` now issues `play()`, so the demux/decode pipeline actually runs;
  - all AppKit view work is marshaled onto the main thread (off-main view
    access segfaulted macOS).
- **Layout / transparency hardening**: the app window is `transparent` with the
  chrome fully self-painted — opaque top strip and `z-40 opacity-100` sidebar
  over the stage, zero background bleed; sidebar stays a flex *sibling* of the
  player (platform-driven inline vs. drawer mode).
- **UI reliability across both modes**: unchanged HTML5 fallback with explicit
  container-unsupported messaging, job-scoped transcription identity with a
  completion safety net, and crash-safe mid-video resume.

### ✅ Verification

- Rust tests: **34/34** (feature-off) and **42/42** (`--features vlc-native`,
  incl. a live `libvlc_new`/drop test against the real VLC.app dylibs).
- Frontend: **106/106** vitest suites, `tsc` + `vite build` clean.
- `cargo clippy` clean on the `native_player` module.
- Live macOS smoke battery (**10/10 PASS**) against a real MP4/H.264 file:
  session init, decode (VideoToolbox), playing state and advancing clock, host
  view anchored to the measured DOM stage (`848×760 @ (352,40)`), and a
  transparent DOM overlay over the stage centre.

---

## [0.1.3] — 2026-09-13

- PWA install support (`beforeinstallprompt`) + honest web/mobile environment
  detection.
- Removed `bundle.ios` from `tauri.conf.json` (desktop CLI rejected it).
- Updater plugin runtime (background + manual check on GitHub Releases).

---

[Unreleased]: https://github.com/micropsy/ZanPlayer-Lite/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/micropsy/ZanPlayer-Lite/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/micropsy/ZanPlayer-Lite/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/micropsy/ZanPlayer-Lite/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/micropsy/ZanPlayer-Lite/releases/tag/v0.1.3