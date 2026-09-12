# Android native playback backend (Media3 ExoPlayer)

In-app Tauri v2 mobile plugin that gives ZanPlayer Lite its dedicated native
video player on Android, wired behind the exact same `mpv_*` command surface as
the desktop libmpv engines. The Rust side (`src-tauri/src/native_player`) treats
it as just another `NativeSession`; the webview never knows the engine changed.

## What it is

| | |
|---|---|
| Player | Media3 **ExoPlayer** (`androidx.media3:media3-exoplayer`) |
| Video surface | `PlayerView` (`useController=false`, `RESIZE_MODE_FIT`) inserted as the **first** child of the window's decor container — i.e. **behind** the WebView |
| Layering | `load(webView)` makes the Tauri WebView transparent (`setBackgroundColor(TRANSPARENT)` + translucent window format) so the DOM chrome floats over the native frames, mirroring the macOS/Windows/X11 layering model |
| Stage | Full window. `apply_surface_layout` is a no-op in Rust (`mobile.rs`), there is no DOM-stage anchoring on mobile |
| Position | 250 ms Rust ticker polls the `position` command and coalesces beats exactly like the desktop tickers |
| Fallback | If the plugin fails to register, `MobileSession::new` errors and the frontend drops to HTML5 |

## Commands (called from Rust via `run_mobile_plugin`)

| Command | Args (`@InvokeArg`) | Result |
|---|---|---|
| `load` | `path: String` (required) | starts playback |
| `play` | — | resumes |
| `pause` | — | pauses |
| `seek` | `position: f64` (seconds) | jumps + sets `playWhenReady = true` |
| `set_volume` | `level: f64` (0–100) | `player.volume = level / 100` |
| `set_speed` | `speed: f64` (≥0.1) | `setPlaybackSpeed` |
| `stop` | — | pauses + `stop()` (keeps the surface for restart) |
| `position` | — | `{ position, duration, paused, ended }` (ms → s) |
| `diagnostics` | — | `{ diagnostics: "..." }` |

Argument keys are snake_case and the `position` response is camelCase —
exactly what `mobile.rs` serializes/deserializes (`MpvTimeUpdate`).

## Integrating into the app

Mobile source here is dropped in (`src-tauri/mobile/android/…`), not compiled in
place, because the Android project is generated per-`identifier` by the Tauri CLI:

```bash
npx tauri android init          # scaffold src-tauri/gen/android (needs JDK)
# copy the plugin into the generated project (same relative path as in this dir):
mkdir -p src-tauri/gen/android/app/src/main/java/com/micropsy/zanplayer_lite
cp src-tauri/mobile/android/MediaPlaybackPlugin.kt \
   src-tauri/gen/android/app/src/main/java/com/micropsy/zanplayer_lite/
```

The class is registered from Rust by name:
`register_android_plugin("com.micropsy.zanplayer_lite", "MediaPlaybackPlugin")`
(`src-tauri/src/native_player/mobile_android.rs`) — the Java class is looked up
as `com/micropsy/zanplayer_lite/MediaPlaybackPlugin`, so the package line and
path must match the identifier exactly.

Add the ExoPlayer dependency to the generated app module
(`src-tauri/gen/android/app/build.gradle.kts`):

```kotlin
dependencies {
    implementation("androidx.media3:media3-exoplayer:1.11.0")
    implementation("androidx.media3:media3-ui:1.11.0")
}
```

`minSdkVersion` must be ≥ 24 (see `tauri.conf.json` `bundle.android`).

## Path semantics (documented assumption)

`load.path` comes from the frontend's native file handling (Tauri dialog /
opened files). The plugin resolves it as:

- `content://`, `file://`, `http(s)://` → parsed as a `Uri` as-is;
- anything else → treated as an absolute filesystem path (`Uri.fromFile`).

## Verification status — HONEST READ

- The Rust bridge (`mobile.rs`, `mobile_android.rs`, `mobile_ios.rs`,
  `MediaPlaybackState`, shared coalescing helpers) compiles and is covered by
  unit tests on this host (`cargo test`, `cargo clippy`, `cargo build --features
  native-player,macos-render`).
- **This Kotlin file has never been compiled or run.** There is no JDK, no
  Android SDK, no Rust `aarch64-linux-android` target on the development machine
  (verified: `java` and `xcodebuild` both absent). It is written against the
  documented Tauri v2 mobile-plugin API (`app.tauri.annotation.*`,
  `app.tauri.plugin.*`, `Invoke.parseArgs/resolve/reject`) and Media3 1.11.0
  stable, but it WILL need device-time fixes.

Checklist for the person who runs it on a real phone/Gradle:

- [ ] `npx tauri android init` succeeded and the Gradle wrapper is present.
- [ ] Both `media3-exoplayer` and `media3-ui` resolve (Google Maven repo is on
      the classpath — default Tauri template has it).
- [ ] The WebView is actually transparent in the real app (if not: the surface
      behind is invisible; verify in `load(webView)`).
- [ ] The decor-view insertion at **index 0** really is *behind* the WebView on
      the device. If Tauri wraps the WebView in a container, attach the
      `PlayerView` below that container instead (comment in `ensureSurface`).
- [ ] Dialog-returned paths load as expected; adjust `resolveMediaUri` to the
      actual path shape if they don't.
- [ ] Hard-coded `paused = !isPlaying` is right for your uses (`isPlaying` is
      false while buffering, so a buffering hiccup briefly flaps `paused`; the
      Rust ticker's 0.05 s epsilon swallows most of that).
- [ ] Device still decodes HDR/10-bit content (no `setHdrMode`/tone-map
      overrides — decided to keep the surface path minimal).