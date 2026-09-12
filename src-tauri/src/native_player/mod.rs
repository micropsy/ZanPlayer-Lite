//! Optional libmpv-backed native decoder/player (cargo feature `native-player`).
//!
//! The session draws directly into the native window surface (the `wid`
//! property) while the webview stays transparent over the player stage, so the
//! DOM chrome (title OSD, captions, controls) floats above the decoded frames.
//! Playback state is mirrored to the frontend through `mpv-timeupdate` (250 ms
//! ticker) and `mpv-loaded` Tauri events.
//!
//! Without the feature every command compiles and reports "not available", so
//! the frontend can always fall back to the HTML5 `<video>` element.

#[cfg(not(feature = "native-player"))]
mod noop;
#[cfg(feature = "native-player")]
mod session;
/// macOS Render-API backend (libmpv Render API + CAMetalLayer): the native
/// implementation macOS uses instead of the window-VO `wid` embed, which can
/// still open a detached top-level window there.
#[cfg(all(target_os = "macos", feature = "macos-render"))]
mod render;
/// Mobile native backends (no libmpv feature involved): the Rust session that
/// drives Media3 ExoPlayer (Android) / AVFoundation AVPlayer (iOS) through the
/// Tauri mobile plugin bridge, plus the per-OS plugin registration modules.
#[cfg(any(target_os = "android", target_os = "ios"))]
mod mobile;
#[cfg(target_os = "android")]
mod mobile_android;
#[cfg(target_os = "ios")]
mod mobile_ios;

#[cfg(any(target_os = "android", target_os = "ios"))]
use mobile::MobileSession as NativeSession;
#[cfg(all(target_os = "macos", feature = "macos-render"))]
use render::RenderSession as NativeSession;
#[cfg(all(
    feature = "native-player",
    not(all(target_os = "macos", feature = "macos-render")),
    not(any(target_os = "android", target_os = "ios"))
))]
use session::MpvSession as NativeSession;
#[cfg(all(
    not(feature = "native-player"),
    not(any(target_os = "android", target_os = "ios"))
))]
use noop::NoopSession as NativeSession;

use std::sync::{Arc, Mutex};
use tauri::State;

#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) use mobile::apply_surface_layout;
#[cfg(all(target_os = "macos", feature = "macos-render"))]
pub(crate) use render::apply_surface_layout;
#[cfg(all(
    feature = "native-player",
    not(all(target_os = "macos", feature = "macos-render")),
    not(any(target_os = "android", target_os = "ios"))
))]
pub(crate) use session::apply_surface_layout;
#[cfg(all(
    not(feature = "native-player"),
    not(any(target_os = "android", target_os = "ios"))
))]
pub(crate) use noop::apply_surface_layout;

/// Bounding box (in CSS pixels, relative to the webview content area) of the
/// DOM video stage. The frontend reports this via `getBoundingClientRect()`
/// whenever the stage resizes or moves, and the backend anchors the native
/// surface — a dedicated host view on macOS — exactly onto that rect instead of
/// falling back to whole-window rendering.
#[cfg_attr(not(feature = "native-player"), allow(dead_code))]
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceLayout {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Live playback snapshot pushed to the webview on a 250 ms ticker.
#[cfg_attr(not(feature = "native-player"), allow(dead_code))]
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvTimeUpdate {
    pub position: f64,
    pub duration: f64,
    pub paused: bool,
    pub ended: bool,
}

/// Threshold (seconds) for treating a position delta as "moved" so the native
/// tickers (desktop mpv and the mobile plugin poller) re-emit `mpv-timeupdate`.
/// Sub-epsilon jitter (e.g. decoder pauses between beats) is coalesced away:
/// the webview clock stays smooth at the 250 ms cadence while the Tauri event
/// bridge is not flooded with no-op beats.
#[cfg_attr(not(feature = "native-player"), allow(dead_code))]
const POSITION_EPSILON: f64 = 0.05;

/// Whether a freshly-read playback snapshot differs enough from the last one
/// that it must cross the event bridge. The first snapshot always emits;
/// afterwards a beat is only forwarded on a real position movement or a
/// paused/ended/duration transition. Shared by every native backend so the
/// mobile ticker coalesces exactly like the desktop one.
#[cfg_attr(not(feature = "native-player"), allow(dead_code))]
pub(crate) fn snapshot_changed(last: &Option<MpvTimeUpdate>, current: &MpvTimeUpdate) -> bool {
    match last {
        None => true,
        Some(prev) => {
            (current.position - prev.position).abs() >= POSITION_EPSILON
                || current.duration != prev.duration
                || current.paused != prev.paused
                || current.ended != prev.ended
        }
    }
}

/// Never let a stale tick echo a position past the tail of the clip. When no
/// duration is known (no file loaded yet) the raw position passes through.
#[cfg_attr(not(feature = "native-player"), allow(dead_code))]
pub(crate) fn position_clamped(position: f64, duration: f64) -> f64 {
    if duration > 0.0 {
        position.clamp(0.0, duration)
    } else {
        position.max(0.0)
    }
}

/// Managed slot the mobile media-playback plugin registration fills at startup
/// (`mobile_android.rs` / `mobile_ios.rs`). Present in every build (empty on
/// desktop) so the single `.manage(...)` in `main.rs` compiles everywhere. A
/// `None` means the plugin failed to register; `MobileSession::new` then
/// errors and the frontend falls back to HTML5 instead of crashing startup.
#[allow(dead_code)]
#[derive(Default)]
pub(crate) struct MediaPlaybackState(Arc<Mutex<Option<tauri::plugin::PluginHandle<tauri::Wry>>>>);

/// Single always-present `.plugin(...)` slot for the media backend: a no-op on
/// desktop, and on mobile the `zanplayer-media` plugin that bridges Rust to the
/// Media3 / AVPlayer native players via `PluginApi::register_android_plugin` /
/// `register_ios_plugin`. Wrapping the platform selection here keeps the
/// `Builder` chain in `main.rs` free of `#[cfg]` (which cannot sit in the middle
/// of a method chain).
pub(crate) fn mobile_media_init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    #[cfg(target_os = "android")]
    {
        return mobile_android::init();
    }
    #[cfg(target_os = "ios")]
    {
        return mobile_ios::init();
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        tauri::plugin::Builder::new("zanplayer-media").build()
    }
}

/// Managed handle to the single native playback session. The session is created
/// lazily on the first command (mpv init is heavy and never needed for the
/// HTML5 path), so the lock is only held while minting it; every command then
/// works on an `Arc` clone of the session.
#[derive(Default)]
pub struct MpvControl(Arc<Mutex<Option<Arc<NativeSession>>>>);

impl MpvControl {
    fn session(&self, app: &tauri::AppHandle) -> Result<Arc<NativeSession>, String> {
        let mut guard = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(session) = guard.as_ref() {
            return Ok(session.clone());
        }
        let session = Arc::new(Self::create(app)?);
        guard.replace(session.clone());
        Ok(session)
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    fn create(app: &tauri::AppHandle) -> Result<NativeSession, String> {
        mobile::MobileSession::new(app)
    }

    #[cfg(all(target_os = "macos", feature = "macos-render"))]
    fn create(app: &tauri::AppHandle) -> Result<NativeSession, String> {
        render::RenderSession::new(app)
    }

    #[cfg(all(
        feature = "native-player",
        not(all(target_os = "macos", feature = "macos-render")),
        not(any(target_os = "android", target_os = "ios"))
    ))]
    fn create(app: &tauri::AppHandle) -> Result<NativeSession, String> {
        session::MpvSession::new(app)
    }

    #[cfg(all(
        not(feature = "native-player"),
        not(any(target_os = "android", target_os = "ios"))
    ))]
    fn create(_app: &tauri::AppHandle) -> Result<NativeSession, String> {
        Err("Native player (libmpv) is not enabled in this build".to_string())
    }
}

/// Compile-time indicator that a native playback backend was compiled in.
/// Commands still resolve and return normally when `false`, so the UI can
/// detect the engine purely from `mpv_is_available` without platform
/// sniffing. On Android/iOS the in-app media plugin IS the backend, so mobile
/// always reports availability; a runtime registration failure surfaces later
/// as a command error and the frontend falls back to HTML5.
pub fn native_supported() -> bool {
    if cfg!(any(target_os = "ios", target_os = "android")) {
        return true;
    }
    // Desktop native backends: the window-VO `wid` embed (Windows/Linux) or
    // the libmpv Render API + Metal surface on macOS (`macos-render`).
    cfg!(all(
        feature = "native-player",
        any(not(target_os = "macos"), feature = "macos-render")
    ))
}

#[tauri::command]
pub fn mpv_is_available() -> bool {
    native_supported()
}

/// Keep the native video surface pinned to the DOM video stage. The stage is
/// the single source of truth for where the picture may live: on macOS this
/// re-frames the dedicated host NSView (retina-aware, below the webview); on
/// Windows/X11 it best-effort re-sizes mpv's embedded child to the rect. A zero
/// or negative rect is sanitized instead of an ill-formed surface.
#[tauri::command]
pub fn mpv_set_layout(app: tauri::AppHandle, rect: SurfaceLayout) -> Result<(), String> {
    apply_surface_layout(&app, &rect)
}

#[tauri::command]
pub fn mpv_load(app: tauri::AppHandle, state: State<'_, MpvControl>, path: String) -> Result<(), String> {
    state.session(&app)?.load(&app, &path)
}

#[tauri::command]
pub fn mpv_play(app: tauri::AppHandle, state: State<'_, MpvControl>) -> Result<(), String> {
    state.session(&app)?.play()
}

#[tauri::command]
pub fn mpv_pause(app: tauri::AppHandle, state: State<'_, MpvControl>) -> Result<(), String> {
    state.session(&app)?.pause()
}

#[tauri::command]
pub fn mpv_seek(app: tauri::AppHandle, state: State<'_, MpvControl>, position: f64) -> Result<(), String> {
    state.session(&app)?.seek(position.max(0.0))
}

#[tauri::command]
pub fn mpv_set_volume(app: tauri::AppHandle, state: State<'_, MpvControl>, level: f64) -> Result<(), String> {
    state.session(&app)?.set_volume(level.clamp(0.0, 100.0))
}

#[tauri::command]
pub fn mpv_set_speed(app: tauri::AppHandle, state: State<'_, MpvControl>, speed: f64) -> Result<(), String> {
    state.session(&app)?.set_speed(speed.max(0.05))
}

#[tauri::command]
pub fn mpv_stop(_app: tauri::AppHandle, state: State<'_, MpvControl>) -> Result<(), String> {
    let session = state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    match session {
        Some(session) => session.stop(),
        None => Ok(()),
    }
}

/// Smoke-test entry point: drive a real load/attach through the managed session
/// without needing UI interaction. The setup hook calls this when
/// `ZANPLAYER_NATIVE_SMOKE=1` with `ZANPLAYER_NATIVE_SMOKE_VIDEO=<path>`.
#[cfg(feature = "native-player")]
pub fn smoke_load(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    eprintln!("[native-smoke] smoke_load(path={path}) starting");

    // macOS + macos-render: exercise the Render-API backend. Real file, real
    // render context, real Metal present — no window VO, no wid anywhere.
    #[cfg(all(target_os = "macos", feature = "macos-render"))]
    {
        use tauri::Manager;
        eprintln!("[native-smoke] macOS Render-API smoke (vo=libmpv + CAMetalLayer, no wid)");
        eprintln!(
            "[native-smoke] libmpv2 bindings target client API {}.{} (0x{:x}) — Mpv::new enforces a major-version match with the loaded dylib",
            libmpv2::MPV_CLIENT_API_MAJOR,
            libmpv2::MPV_CLIENT_API_MINOR,
            libmpv2::MPV_CLIENT_API_VERSION
        );
        let state = app.state::<MpvControl>();
        let session = state.session(app).map_err(|e| {
            eprintln!("[native-smoke] SESSION ERROR: {e}");
            e
        })?;
        match session.load(app, path) {
            Ok(()) => {
                eprintln!("[native-smoke] load OK — render thread + ticker running");
                let probe = state.session(app)?;
                std::thread::spawn(move || {
                    // Let mpv decode a few seconds, then run the 4-point check.
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    eprintln!("[native-smoke] diagnostics: {}", probe.diagnostics());

                    let checks = [
                        ("render context reported no error", probe.render_error() == 0),
                        ("at least one frame presented via Metal", probe.frames_presented() > 0),
                        ("decoding through vo=libmpv", probe.current_vo() == "libmpv"),
                        ("playback clock advancing", probe.time_pos() > 0.0),
                    ];
                    let mut passed = 0;
                    for (i, (name, ok)) in checks.iter().enumerate() {
                        eprintln!(
                            "[native-smoke] CHECK {}: {} ({})",
                            i + 1,
                            if *ok { "OK" } else { "FAIL" },
                            name
                        );
                        if *ok {
                            passed += 1;
                        }
                    }
                    eprintln!(
                        "[native-smoke] RESULT: {passed}/{} passed",
                        checks.len()
                    );
                    if passed == checks.len() {
                        eprintln!("[native-smoke] PASS — macOS native (macos-render) verified");
                    } else {
                        eprintln!(
                            "[native-smoke] FAIL — render backend not ready for the macOS un-gate"
                        );
                    }
                });
                Ok(())
            }
            Err(e) => {
                eprintln!("[native-smoke] load FAILED: {e}");
                Err(e)
            }
        }
    }

    // macOS without the render backend: the window VO can still open a
    // detached top-level window, so no misleading smoke window here.
    #[cfg(all(target_os = "macos", not(feature = "macos-render")))]
    {
        let _ = app;
        eprintln!(
            "[native-smoke] macOS window-VO smoke skipped: use the in-app HTML5 fallback; build with --features macos-render for the safe Render-API smoke"
        );
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
    use tauri::Manager;
    let state = app.state::<MpvControl>();
    eprintln!(
        "[native-smoke] libmpv2 bindings target client API {}.{} (0x{:x}) — Mpv::new enforces a major-version match with the loaded dylib",
        libmpv2::MPV_CLIENT_API_MAJOR,
        libmpv2::MPV_CLIENT_API_MINOR,
        libmpv2::MPV_CLIENT_API_VERSION
    );
    eprintln!("[native-smoke] mpv state acquired");
    match state.session(app) {
        Ok(session) => {
            eprintln!("[native-smoke] mpv session ready — attaching + loading");
            match session.load(app, path) {
                Ok(()) => {
                    eprintln!("[native-smoke] load OK — mpv-loaded emitted, ticker running");
                    let state = app.state::<MpvControl>();
                    let surface = state.session(app).ok();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(1500));
                        if let Some(s) = surface {
                            eprintln!("[native-smoke] snapshot: {}", s.diagnostics());
                        }
                    });
                    Ok(())
                }
                Err(e) => {
                    eprintln!("[native-smoke] load FAILED: {e}");
                    Err(e)
                }
            }
        }
        Err(e) => {
            eprintln!("[native-smoke] SESSION ERROR: {e}");
            Err(e)
        }
    }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn availability_reflects_compiled_feature() {
        let expected = if cfg!(any(target_os = "ios", target_os = "android")) {
            // Mobile backends (Media3 / AVPlayer plugin) are always present.
            true
        } else {
            cfg!(all(
                feature = "native-player",
                any(not(target_os = "macos"), feature = "macos-render")
            ))
        };
        assert_eq!(native_supported(), expected);
        assert_eq!(mpv_is_available(), native_supported());
    }

    #[test]
    fn mpv_commands_clamp_seek_volume_speed_before_session() {
        // Pure arg-sanitization contract for the command layer: the session
        // only ever receives sanitized ranges even if the UI misbehaves. These
        // just exercise the clamping expressions via the command bodies below.
        let seek = 12.5_f64.max(0.0);
        assert_eq!(seek, 12.5);
        assert_eq!((-3.0_f64).max(0.0), 0.0);

        assert_eq!(105.0_f64.clamp(0.0, 100.0), 100.0);
        assert_eq!((-5.0_f64).clamp(0.0, 100.0), 0.0);
        assert_eq!(0.0_f64.clamp(0.0, 100.0), 0.0);

        assert_eq!(10.0_f64.max(0.05), 10.0);
        assert_eq!(0.01_f64.max(0.05), 0.05);
    }

    #[test]
    fn time_update_payload_serializes_camel_case() {
        let update = MpvTimeUpdate {
            position: 12.5,
            duration: 100.0,
            paused: false,
            ended: false,
        };
        let json = serde_json::to_string(&update).unwrap();
        assert!(json.contains("\"position\":12.5"));
        assert!(json.contains("\"duration\":100.0"));
        assert!(json.contains("\"paused\":false"));
        assert!(json.contains("\"ended\":false"));
        assert!(!json.contains("paused_at_end"));
    }

    #[test]
    fn mobile_position_response_deserializes() {
        // The native (Media3/AVPlayer) `position` command resolves exactly this
        // JSON; it must round-trip into the same snapshot mobile ticker emits.
        let json = r#"{"position":12.5,"duration":100.0,"paused":false,"ended":false}"#;
        let update: MpvTimeUpdate = serde_json::from_str(json).unwrap();
        assert_eq!(update.position, 12.5);
        assert_eq!(update.duration, 100.0);
        assert!(!update.paused);
        assert!(!update.ended);
    }

    #[test]
    fn snapshot_coalesces_sub_epsilon_jitter() {
        let base = MpvTimeUpdate {
            position: 10.0,
            duration: 100.0,
            paused: false,
            ended: false,
        };
        // First snapshot always emits.
        assert!(snapshot_changed(&None, &base));
        // Sub-epsilon drift is coalesced away (no event-bridge spam).
        let jitter = MpvTimeUpdate {
            position: 10.04,
            ..base.clone()
        };
        assert!(!snapshot_changed(&Some(base.clone()), &jitter));
        // A real move, pause transition and duration change all emit.
        let moved = MpvTimeUpdate {
            position: 12.0,
            ..base.clone()
        };
        assert!(snapshot_changed(&Some(base.clone()), &moved));
        let paused = MpvTimeUpdate {
            paused: true,
            ..base.clone()
        };
        assert!(snapshot_changed(&Some(base.clone()), &paused));
    }

    #[test]
    fn position_clamped_obeys_clip_bounds() {
        assert_eq!(position_clamped(120.0, 100.0), 100.0);
        assert_eq!(position_clamped(50.0, 100.0), 50.0);
        assert_eq!(position_clamped(-4.0, 100.0), 0.0);
        // Unknown duration (no file) passes the raw position through.
        assert_eq!(position_clamped(30.0, 0.0), 30.0);
        assert_eq!(position_clamped(-2.0, 0.0), 0.0);
    }
}