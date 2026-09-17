# iOS native playback backend (AVFoundation AVPlayer)

In-app Tauri v2 mobile plugin that gives ZanPlayer Lite a dedicated native video
player on iOS / iPadOS, wired behind the exact same `vlc_*` command surface as
the desktop LibVLC engine. The Rust side (`src-tauri/src/native_player`) treats
it as just another `NativeSession`; the webview never knows the engine changed.

## What it is

| | |
|---|---|
| Player | AVFoundation **AVPlayer** |
| Video surface | Custom `PlayerSurfaceView` (layerClass = `AVPlayerLayer`, `resizeAspect`) inserted as the **first** subview of the webview's superview — i.e. **behind** the WKWebView |
| Layering | `load(webview:)` makes the WKWebView transparent (`isOpaque=false`, `backgroundColor=.clear`) so the DOM chrome floats over the native frames, mirroring the macOS/Windows layering model |
| Stage | Full window. `apply_surface_layout` is a no-op in Rust (`mobile.rs`), there is no DOM-stage anchoring on mobile |
| Position | 250 ms Rust ticker polls the `position` command and coalesces beats exactly like the desktop tickers |
| Fallback | If the plugin fails to register, `MobileSession::new` errors and the frontend drops to HTML5 |

## Commands (called from Rust via `run_mobile_plugin`)

| Command | Args (`Decodable`) | Result |
|---|---|---|
| `load` | `path: String` (required) | starts playback |
| `play` | — | resumes at stored rate |
| `pause` | — | pauses |
| `seek` | `position: f64` (seconds) | jumps with zero tolerance |
| `set_volume` | `level: f64` (0–100) | `AVPlayer.volume = level / 100` |
| `set_speed` | `speed: f64` (≥0.1) | `defaultRate` + `rate` if playing |
| `stop` | — | pauses + `replaceCurrentItem(nil)` (clears source, keeps surface for restart) |
| `position` | — | `[position, duration, paused, ended]` (seconds) |
| `diagnostics` | — | `[diagnostics: "..."]` |

Argument keys are snake_case and the `position` response is camelCase —
exactly what `mobile.rs` serializes/deserializes (`VlcTimeUpdate`).

## Integrating into the app

Mobile source here is dropped in (`src-tauri/mobile/apple/…`), not compiled in
place, because the iOS project is generated per-`identifier` by the Tauri CLI:

```bash
npx tauri ios init          # scaffold src-tauri/gen/apple (needs Xcode)
cp src-tauri/mobile/apple/MediaPlaybackPlugin.swift \
   src-tauri/gen/apple/Sources/MediaPlaybackPlugin.swift
```

The Swift class is registered from Rust by the `@_cdecl` symbol:
`tauri::ios_plugin_binding!(init_zanplayer_media)` expands to
`swift!(fn init_zanplayer_media() -> *const c_void)`, and the
`@_cdecl("init_zanplayer_media")` function at the bottom of the file bridges
it to a `Plugin` instance. The symbol name **must** match `init_zanplayer_media`
exactly.

The iOS plugin is a Swift package: add it as a dependency in
`src-tauri/gen/apple/Package.swift` (or wherever Tauri's generated project
expects third-party plugins), and ensure the app's deployment target is
**iOS 15.0** or later. Set it as `IPHONEOS_DEPLOYMENT_TARGET` in the generated
Xcode project — do NOT add `bundle.ios` to `tauri.conf.json`, because the
desktop `tauri-cli` (v2.11.3) rejects that key and breaks every desktop build.

### AVPlayer vs AVPlayerLayer

`PlayerSurfaceView` uses the `layerClass = AVPlayerLayer` override — the tidy
AVFoundation idiom for embedding a player into a view hierarchy. The layer is
added to the container view BELOW the WKWebView (index 0 in the subview stack).
The view auto-sizes to match the container bounds.

## Path semantics (documented assumption)

`load.path` comes from the frontend's native file handling (Tauri dialog /
opened files). The plugin resolves it as:

- strings containing `://` (content://, file://, http(s)://) → `URL(string:)`
- everything else → `URL(fileURLWithPath:)` (absolute sandbox path)

AVPlayer natively plays mp4/mov/m4v. H.264 and H.265 are hardware-decoded on
all supported iOS devices. WebM/VP9/AV1 are not supported by AVFoundation.

## Verification status — HONEST READ

- The Rust bridge (`mobile.rs`, `mobile_ios.rs`, `MediaPlaybackState`,
  shared coalescing helpers) compiles and is covered by unit tests on this
  host (`cargo test`, `cargo clippy`, `cargo build --features vlc-native`).
- **This Swift file has never been compiled or run.** There is no Xcode
  installation (`xcodebuild` → "unable to find Xcode.app"), no iOS SDK,
  no Swift compiler for the iOS target on this machine. It is written
  against the documented Tauri v2 iOS plugin API (`Plugin`,
  `Invoke.parseArgs/resolve/reject`, `@_cdecl`) and AVFoundation, but it
  WILL need device-time fixes.

Checklist for the person who builds/runs it on a real iPhone:

- [ ] `npx tauri ios init` succeeded and the Xcode project is generated.
- [ ] The `Package.swift` dependency graph resolves (Tauri's ios-api is the
      only import; no third-party media libraries needed).
- [ ] The WKWebView is actually transparent in the real app — if the
      `backgroundColor` on the root `contentView` is non-nil, the webview
      background bleeds through and buries the video layer.
- [ ] `webview.superview` is not nil when `load(invoke)` fires; if it is,
      the surface never mounts and the `position` command always returns zeros.
- [ ] Dialog-returned paths load as expected — if the Tauri dialog on iOS
      returns a sandbox-relative path (not absolute), `URL(fileURLWithPath:)`
      fails silently. Adjust `load` to resolve against the app bundle if
      needed.
- [ ] `set_speed` ramps in discrete steps on some devices (AVPlayer reports
      only certain rates like 0.5, 1.0, 1.5, 2.0). The Rust ticker's
      0.05 s coalescing hides most jitter.
- [ ] Still audio-plays-wrong-route bug: if the user plugs in AirPods mid-
      playback, AVPlayer switches output automatically; verify the state
      snapshot stays coherent (no stutter-induced `ended` spike).
- [ ] Check the `position` response when `player.currentItem` is nil (no
      media loaded yet) — Rust tickers start after `load` resolves, but a
      manual `position` call before `load` is theoretically possible and must
      return `[0, 0, true, false]`.