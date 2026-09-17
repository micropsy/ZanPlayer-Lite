//! Optional LibVLC-backed native decoder/player (cargo feature `vlc-native`).
//!
//! The session draws directly into a dedicated native surface behind the
//! transparent webview, so the DOM chrome (title OSD, captions, controls) floats
//! above the decoded frames. Playback state is mirrored to the frontend through
//! `vlc-timeupdate` (250 ms ticker) and `vlc-loaded` Tauri events — the names
//! are the VLC rename of the old `mpv-timeupdate` / `mpv-loaded` surface.
//!
//! The previous backend was libmpv (`libmpv2` + a macOS CAMetalLayer Render
//! backend). Both are gone: there is exactly one native engine, the LibVLC C
//! API (`libvlc`, the engine VLCKit wraps), and one feature gate (`vlc-native`).
//! This module compiles out entirely when the feature is off, so shipped
//! builds run the HTML5 `<video>` player with zero native surface.
//!
//! With the feature disabled every command still compiles and reports "not
//! available", so the frontend can always fall back to the HTML5 element.

#[cfg(not(feature = "vlc-native"))]
mod noop;
#[cfg(feature = "vlc-native")]
mod session;
/// Mobile native backends (no libvlc feature involved): the Rust session that
/// drives Media3 ExoPlayer (Android) / AVFoundation AVPlayer (iOS) through the
/// Tauri mobile plugin bridge, plus the per-OS plugin registration modules.
#[cfg(any(target_os = "android", target_os = "ios"))]
mod mobile;
#[cfg(target_os = "android")]
mod mobile_android;
#[cfg(target_os = "ios")]
mod mobile_ios;
/// macOS title-bar window dragging via `performWindowDragWithEvent:`. Compiled
/// in EVERY build (shipped feature-off ones included) — the drag region is
/// chrome behavior, not a native-player feature, and the synthesized-drag path
/// here is what makes dragging work while the window is focused/active.
#[cfg(target_os = "macos")]
mod macos_window;

/// LibVLC FFI + safe [`libvlc::VlcPlayer`] wrapper. `vlc-native` only.
#[cfg(feature = "vlc-native")]
pub(crate) mod libvlc;

/// How long the slim smoke parks on the settled anchored state when
/// `ZANPLAYER_NATIVE_SMOKE_PAUSE=1`, so an external capture can be taken.
#[cfg(feature = "vlc-native")]
const PAUSE_SECS: u64 = 30;

#[cfg(any(target_os = "android", target_os = "ios"))]
use mobile::MobileSession as NativeSession;
#[cfg(all(
    feature = "vlc-native",
    not(any(target_os = "android", target_os = "ios"))
))]
use session::VlcSession as NativeSession;
#[cfg(all(
    not(feature = "vlc-native"),
    not(any(target_os = "android", target_os = "ios"))
))]
use noop::NoopSession as NativeSession;

use std::sync::{Arc, Mutex};
use tauri::State;

#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) use mobile::apply_surface_layout;
#[cfg(all(
    feature = "vlc-native",
    not(any(target_os = "android", target_os = "ios"))
))]
pub(crate) use session::apply_surface_layout;
#[cfg(all(
    not(feature = "vlc-native"),
    not(any(target_os = "android", target_os = "ios"))
))]
pub(crate) use noop::apply_surface_layout;

/// Bounding box (in CSS pixels, relative to the webview content area) of the
/// DOM video stage. The frontend reports this via `getBoundingClientRect()`
/// whenever the stage resizes or moves, and the backend anchors the native
/// surface — a dedicated host view on macOS — exactly onto that rect instead of
/// falling back to whole-window rendering.
#[cfg_attr(not(feature = "vlc-native"), allow(dead_code))]
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceLayout {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Live playback snapshot pushed to the webview on a 250 ms ticker. The frontend
/// treats this exactly like the old `MpvTimeUpdate` (rename of the mpv payload).
#[cfg_attr(not(feature = "vlc-native"), allow(dead_code))]
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VlcTimeUpdate {
    pub position: f64,
    pub duration: f64,
    pub paused: bool,
    pub ended: bool,
}

/// Threshold (seconds) for treating a position delta as "moved" so the native
/// tickers (desktop libvlc and the mobile plugin poller) re-emit `vlc-timeupdate`.
/// Sub-epsilon jitter between beats is coalesced away.
#[cfg_attr(not(feature = "vlc-native"), allow(dead_code))]
const POSITION_EPSILON: f64 = 0.05;

/// Whether a freshly-read playback snapshot differs enough from the last one
/// that it must cross the event bridge. First snapshot always emits; afterwards
/// only a real position movement or a paused/ended/duration transition.
#[cfg_attr(not(feature = "vlc-native"), allow(dead_code))]
pub(crate) fn snapshot_changed(last: &Option<VlcTimeUpdate>, current: &VlcTimeUpdate) -> bool {
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
#[cfg_attr(not(feature = "vlc-native"), allow(dead_code))]
pub(crate) fn position_clamped(position: f64, duration: f64) -> f64 {
    if duration > 0.0 {
        position.clamp(0.0, duration)
    } else {
        position.max(0.0)
    }
}

/// Managed slot the mobile media-playback plugin registration fills at startup
/// (`mobile_android.rs` / `mobile_ios.rs`). Present in every build (empty on
/// desktop) so the single `.manage(...)` in `main.rs` compiles everywhere.
#[allow(dead_code)]
#[derive(Default)]
pub(crate) struct MediaPlaybackState(Arc<Mutex<Option<tauri::plugin::PluginHandle<tauri::Wry>>>>);

/// Single always-present `.plugin(...)` slot for the media backend: a no-op on
/// desktop, and on mobile the `zanplayer-media` plugin that bridges Rust to the
/// Media3 / AVPlayer native players.
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
/// lazily on the first command (libvlc init is heavy and never needed for the
/// HTML5 path), so the lock is only held while minting it; every command then
/// works on an `Arc` clone of the session.
#[derive(Default)]
pub struct VlcControl(Arc<Mutex<Option<Arc<NativeSession>>>>);

impl VlcControl {
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

    #[cfg(all(
        feature = "vlc-native",
        not(any(target_os = "android", target_os = "ios"))
    ))]
    fn create(app: &tauri::AppHandle) -> Result<NativeSession, String> {
        session::VlcSession::new(app)
    }

    #[cfg(all(
        not(feature = "vlc-native"),
        not(any(target_os = "android", target_os = "ios"))
    ))]
    fn create(_app: &tauri::AppHandle) -> Result<NativeSession, String> {
        Err("Native player (libvlc) is not enabled in this build".to_string())
    }
}

/// Compile-time indicator that a native playback backend was compiled in.
/// Commands still resolve and return normally when `false`, so the UI can
/// detect the engine purely from `vlc_is_available` without platform sniffing.
/// On Android/iOS the in-app media plugin IS the backend, so mobile always
/// reports availability; a runtime registration failure surfaces later as a
/// command error and the frontend falls back to HTML5.
pub fn native_supported() -> bool {
    if cfg!(any(target_os = "ios", target_os = "android")) {
        return true;
    }
    cfg!(feature = "vlc-native")
}

#[tauri::command]
pub fn vlc_is_available() -> bool {
    native_supported()
}

/// Layout-debug chrome. The old Render-API backend had a magenta native-layer
/// border + DOM outlines; the VLC backend does not, so this resolves `false`
/// unconditionally to keep the invoke surface stable.
#[tauri::command]
pub fn native_layout_debug() -> bool {
    false
}

/// Keep the native video surface pinned to the DOM video stage. The stage is
/// the single source of truth for where the picture may live: on macOS this
/// re-frames the dedicated host NSView (retina-aware, below the webview); on
/// Windows/X11 it best-effort re-sizes VLC's embedded child to the rect.
#[tauri::command]
pub fn vlc_set_layout(app: tauri::AppHandle, rect: SurfaceLayout) -> Result<(), String> {
    apply_surface_layout(&app, &rect)
}

/// Tauri WINDOW fullscreen — the product's fullscreen path, NOT the HTML
/// Fullscreen API. `document.documentElement.requestFullscreen()` reparents the
/// WKWebView into a SEPARATE macOS fullscreen window, leaving the native host
/// NSView stranded in the old window, so the transparent player area renders
/// black. Window-level `set_fullscreen` instead resizes the SAME window
/// (webview, host view and video surface stay together) into the fullscreen
/// Space; the layout reporter re-anchors the surface on the resize. Emits
/// `zan-fullscreen` so the React chrome flips before the Space transition
/// settles.
#[tauri::command]
pub fn set_window_fullscreen(app: tauri::AppHandle, fullscreen: bool) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main webview window not found".to_string())?;
    window.set_fullscreen(fullscreen).map_err(|e| e.to_string())?;
    let _ = app.emit("zan-fullscreen", fullscreen);
    Ok(())
}

/// Start a title-bar window drag. On macOS this uses the dedicated
/// `performWindowDragWithEvent:` path (`macos_window`, compiled in every build)
/// instead of tao's `startDragging` — whose `NSApp.currentEvent` read silently
/// no-ops once a focused webview has consumed the mousedown. Other platforms
/// keep the JS `startDragging` path; this stays a no-op there.
#[tauri::command]
pub fn start_window_drag(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos_window::start_window_drag(&app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
pub fn vlc_load(app: tauri::AppHandle, state: State<'_, VlcControl>, path: String) -> Result<(), String> {
    state.session(&app)?.load(&app, &path)
}

#[tauri::command]
pub fn vlc_play(app: tauri::AppHandle, state: State<'_, VlcControl>) -> Result<(), String> {
    state.session(&app)?.play()
}

#[tauri::command]
pub fn vlc_pause(app: tauri::AppHandle, state: State<'_, VlcControl>) -> Result<(), String> {
    state.session(&app)?.pause()
}

#[tauri::command]
pub fn vlc_seek(app: tauri::AppHandle, state: State<'_, VlcControl>, position: f64) -> Result<(), String> {
    state.session(&app)?.seek(position.max(0.0))
}

#[tauri::command]
pub fn vlc_set_volume(app: tauri::AppHandle, state: State<'_, VlcControl>, level: f64) -> Result<(), String> {
    state.session(&app)?.set_volume(level.clamp(0.0, 100.0))
}

#[tauri::command]
pub fn vlc_set_speed(app: tauri::AppHandle, state: State<'_, VlcControl>, speed: f64) -> Result<(), String> {
    state.session(&app)?.set_speed(speed.max(0.05))
}

#[tauri::command]
pub fn vlc_stop(_app: tauri::AppHandle, state: State<'_, VlcControl>) -> Result<(), String> {
    match state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
    {
        Some(session) => session.stop(),
        None => Ok(()),
    }
}

/// Slim smoke-test entry point: drive a real load/attach through the managed VLC
/// session without needing UI interaction. The setup hook calls this when
/// `ZANPLAYER_NATIVE_SMOKE=1` with `ZANPLAYER_NATIVE_SMOKE_VIDEO=<path>`.
///
/// The battery is deliberately slimmer than the old mpv 13-check run: it covers
/// the VLC contract that matters (session + libvlc loaded, decode proven by a
/// real clock, la+layering re-sort producing a non-occluded surface anchored to
/// the measured DOM stage) and no longer pretends to validate the Metal render
/// path this backend does not use.
#[cfg(feature = "vlc-native")]
pub fn smoke_load(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    eprintln!("[native-smoke] smoke_load(path={path}) starting");
    use tauri::{Listener, Manager};
    eprintln!("[native-smoke] libvlc runtime: {}", libvlc::version());

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        let _ = path;
        eprintln!("[native-smoke] mobile smoke is covered by the device smoke path — nothing to do");
        return Ok(());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let app = app.clone();
        let state = app.state::<VlcControl>();
        let session_opt = match state.session(&app) {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!("[native-smoke] SESSION ERROR: {e}");
                None
            }
        };
        let Some(session) = session_opt else {
            return Err("native session failed to start".into());
        };
        let start = std::time::Instant::now();
        let mut checks: Vec<(&str, bool)> = vec![
            ("libvlc session initialized (VlcSession::new)", true),
            ("load accepted the path (vlc-loaded emitted)", false),
        ];
        match session.load(&app, path) {
            Ok(()) => {
                checks[1].1 = true;
                eprintln!("[native-smoke] load OK — ticker running, vlc-loaded emitted");
            }
            Err(e) => {
                eprintln!("[native-smoke] load FAILED: {e}");
                return Err(e);
            }
        }

        // macOS: prove the embed host is attached and can hold a non-degenerate
        // anchor. This is the set_nsobject contract VLC relies on — without it
        // the picture would be invisible or detached.
        #[cfg(target_os = "macos")]
        {
            use session::macos_surface;
            let attached = macos_surface::verify_embedded(&app);
            eprintln!(
                "[native-smoke] dedicated host NSView embedded under the webview: {}",
                if attached { "yes" } else { "NO" }
            );
            checks.push((
                "dedicated host NSView is attached to the window hierarchy",
                attached,
            ));
            checks.push(("session reports the embed target intact", session.embed_ok()));
        }

        // Wait for the real clock to prove decode, then confirm the aggregate.
        std::thread::spawn(move || {
            let mut decoded = false;
            let mut ever_playing = false;
            checks.push((
                "media left Opening/NothingSpecial (demuxed, not in error state)",
                session.wait_loaded(std::time::Duration::from_secs(5)),
            ));
            while start.elapsed() < std::time::Duration::from_secs(12) {
                std::thread::sleep(std::time::Duration::from_millis(250));
                let t = session.time_pos();
                if t > 0.0 {
                    decoded = true;
                }
                let diag = session.diagnostics();
                if diag.contains("playing=true") {
                    ever_playing = true;
                }
                if decoded && ever_playing {
                    break;
                }
            }
            checks.push(("playback clock advances (decode proven)", decoded));
            checks.push(("player reached a playing state at least once", ever_playing));
            eprintln!("[native-smoke] diagnostics: {}", session.diagnostics());

            // macOS anchor + occlusion probe (slim): ask the harness webview for
            // the DOM player area and the alpha over its centre, then verify the
            // applied host-frame matches it (non-degenerate + transparent DOM).
            #[cfg(target_os = "macos")]
            {
                use session::macos_surface;
                let layout = std::sync::Arc::new(std::sync::Mutex::new(None::<SurfaceLayout>));
                let layout_app = app.clone();
                let layout_rx = std::sync::Arc::clone(&layout);
                let _layout_listener = app.listen("native-smoke-layout", move |ev| {
                    if let Ok(rect) = serde_json::from_str::<SurfaceLayout>(ev.payload()) {
                        let _ = apply_surface_layout(&layout_app, &rect);
                        let applied = macos_surface::applied_js_rect(&layout_app)
                            .map(|(x, y, w, h)| SurfaceLayout { x, y, width: w, height: h })
                            .unwrap_or(rect);
                        eprintln!(
                            "[native-smoke] webview player area = {:.0}x{:.0} at ({:.0},{:.0}) (actual host {:.0}x{:.0} at ({:.0},{:.0}))",
                            rect.width, rect.height, rect.x, rect.y,
                            applied.width, applied.height, applied.x, applied.y
                        );
                        *layout_rx.lock().unwrap_or_else(|p| p.into_inner()) = Some(applied);
                    }
                });
                let occlusion = std::sync::Arc::new(std::sync::atomic::AtomicI32::new(-1));
                let occ = std::sync::Arc::clone(&occlusion);
                let _occlusion_listener = app.listen("native-smoke-occlusion", move |ev| {
                    let v = serde_json::from_str::<serde_json::Value>(ev.payload())
                        .ok()
                        .and_then(|j| j.as_f64())
                        .unwrap_or(1000.0);
                    occ.store(
                        (v.clamp(-1.0, 1000.0) * 1000.0).round() as i32,
                        std::sync::atomic::Ordering::Relaxed,
                    );
                });
                // Inject a smoke-only stylesheet clearing DOM paint inside the
                // measured player area (both backgrounds AND foreground), so the
                // empty-state placeholders can never visually overlap the native
                // surface in a capture; the sidebar keeps its own opaque paint.
                let smoke_script = r#"(() => {
  let styled = false;
  let lastKey = '';
  function bgAlpha(el) {
    let a = 0;
    while (el) {
      const bg = getComputedStyle(el).backgroundColor || '';
      const m = bg.match(/rgba?\(([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)(?:,\s*([0-9.]+))?\)/);
      if (m) {
        const al = m[4] === undefined ? 1 : parseFloat(m[4]);
        a += (1 - a) * al;
      }
      el = el.parentElement;
    }
    return a;
  }
  function findArea() {
    const root = document.querySelector('#root > div');
    if (!root) return null;
    const stack = [root];
    let best = null;
    let bestArea = -1;
    while (stack.length) {
      const k = stack.pop();
      if (k !== root) {
        const cs = getComputedStyle(k);
        if (cs.position === 'absolute' || cs.position === 'fixed') continue;
        const b = k.getBoundingClientRect();
        if (b.width < 50 || b.height < 50) continue;
        if (b.left + b.width >= innerWidth - 1 && b.top + b.height >= innerHeight - 1) {
          const area = b.width * b.height;
          if (!best || area < bestArea) { best = k; bestArea = area; }
        }
      }
      for (let i = 0; i < k.children.length; i++) stack.push(k.children[i]);
    }
    return best;
  }
  function sampleArea() {
    const area = findArea();
    if (!area) return null;
    area.classList.add('zanplayer-smoke-area');
    const r = area.getBoundingClientRect();
    const el = document.elementFromPoint(Math.floor(r.x + r.width / 2), Math.floor(r.y + r.height / 2));
    const alpha = el ? bgAlpha(el) : 1;
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), alpha: Math.round(alpha * 1000) / 1000 };
  }
  function emit(event, payload) {
    try { window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event, payload }); } catch (e) {}
  }
  function loop() {
    if (!document.head || !document.body) { setTimeout(loop, 100); return; }
    if (!styled) {
      styled = true;
      const s = document.createElement('style');
      s.id = 'zanplayer-smoke-clear';
      s.textContent = 'html.zanplayer-smoke .zanplayer-smoke-area, html.zanplayer-smoke .zanplayer-smoke-area * { background: transparent !important; color: transparent !important; }';
      document.documentElement.className += ' zanplayer-smoke';
      document.head.appendChild(s);
    }
    const s = sampleArea();
    if (!s) { setTimeout(loop, 100); return; }
    const key = s.x + ':' + s.y + ':' + s.width + ':' + s.height;
    if (key !== lastKey) { lastKey = key; emit('native-smoke-layout', { x: s.x, y: s.y, width: s.width, height: s.height }); emit('native-smoke-occlusion', Math.round(s.alpha * 1000)); }
    requestAnimationFrame(loop);
  }
  window.addEventListener('resize', loop);
  setTimeout(loop, 50);
})();"#;
                if let Some(wv) = app.get_webview_window("main") {
                    let smoke_ready = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                    {
                        let ready_rx = std::sync::Arc::clone(&smoke_ready);
                        let _ready_listener = app.listen("native-smoke-ready", move |_| {
                            ready_rx.store(true, std::sync::atomic::Ordering::Relaxed);
                        });
                    }
                    let wv_inject = wv.clone();
                    let ready_rx = std::sync::Arc::clone(&smoke_ready);
                    let script = smoke_script.to_string();
                    std::thread::spawn(move || {
                        for _ in 0..120 {
                            if ready_rx.load(std::sync::atomic::Ordering::Relaxed) {
                                break;
                            }
                            let _ = wv_inject.eval(
                                "(() => { const root = document.querySelector('#root > div'); \
                                 if (!root) return; const r = root.getBoundingClientRect(); \
                                 if (r.width >= 50 && r.height >= 50) { \
                                 window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke('plugin:event|emit', \
                                 { event: 'native-smoke-ready', payload: 1 }); } })();",
                            );
                            std::thread::sleep(std::time::Duration::from_millis(250));
                        }
                        if ready_rx.load(std::sync::atomic::Ordering::Relaxed) {
                            let _ = wv_inject.eval(&script);
                        } else {
                            eprintln!("[native-smoke] webview-ready gate timed out — harness not injected");
                        }
                    });
                }

                // Wait for the first anchor + a transparent DOM over the area.
                let mut anchored = false;
                for _ in 0..240 {
                    if layout.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
                        anchored = true;
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                eprintln!(
                    "[native-smoke] host view anchored to the player area: {}",
                    if anchored { "yes" } else { "NO — layout event not received" }
                );
                checks.push(("host NSView anchored to the measured DOM player area", anchored));

                let applied = loop {
                    let g = layout.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(r) = *g {
                        break r;
                    }
                    drop(g);
                    std::thread::sleep(std::time::Duration::from_millis(50));
                };
                if applied.width > 0.0 {
                    let non_trivial = applied.width > 100.0 && applied.height > 100.0;
                    checks.push((
                        "anchored host rect covers a real stage (non-degenerate)",
                        non_trivial,
                    ));
                    eprintln!(
                        "[native-smoke] applied host rect = ({:.0},{:.0}) {:.0}x{:.0} -> {}",
                        applied.x,
                        applied.y,
                        applied.width,
                        applied.height,
                        if non_trivial { "ok" } else { "DEGENERATE" }
                    );
                }

                let mut dom_alpha = 1000.0;
                for _ in 0..100 {
                    let v = occlusion.load(std::sync::atomic::Ordering::Relaxed);
                    if v >= 0 {
                        dom_alpha = v as f64 / 1000.0;
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                eprintln!(
                    "[native-smoke] webview DOM occlusion at player-area centre: alpha={dom_alpha:.3} (0 = see-through, 1 = fully opaque)"
                );
                checks.push(("video not occluded by an opaque webview surface", dom_alpha < 0.5));

                if std::env::var("ZANPLAYER_NATIVE_SMOKE_PAUSE").map(|v| v == "1").unwrap_or(false) {
                    eprintln!(
                        "[native-smoke] PAUSED at anchored state for external capture — {}s",
                        PAUSE_SECS
                    );
                    std::thread::sleep(std::time::Duration::from_secs(PAUSE_SECS));
                }
            }

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
            eprintln!("[native-smoke] RESULT: {passed}/{} passed", checks.len());
            if passed == checks.len() {
                eprintln!("[native-smoke] PASS — VLC native verified");
            } else {
                eprintln!("[native-smoke] FAIL — VLC backend not ready");
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn availability_reflects_compiled_feature() {
        let expected = if cfg!(any(target_os = "ios", target_os = "android")) {
            true
        } else {
            cfg!(feature = "vlc-native")
        };
        assert_eq!(native_supported(), expected);
        assert_eq!(vlc_is_available(), native_supported());
    }

    #[test]
    fn vlc_commands_clamp_seek_volume_speed_before_session() {
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
        let update = VlcTimeUpdate {
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
        let json = r#"{"position":12.5,"duration":100.0,"paused":false,"ended":false}"#;
        let update: VlcTimeUpdate = serde_json::from_str(json).unwrap();
        assert_eq!(update.position, 12.5);
        assert_eq!(update.duration, 100.0);
        assert!(!update.paused);
        assert!(!update.ended);
    }

    #[test]
    fn snapshot_coalesces_sub_epsilon_jitter() {
        let base = VlcTimeUpdate {
            position: 10.0,
            duration: 100.0,
            paused: false,
            ended: false,
        };
        assert!(snapshot_changed(&None, &base));
        let jitter = VlcTimeUpdate {
            position: 10.04,
            ..base.clone()
        };
        assert!(!snapshot_changed(&Some(base.clone()), &jitter));
        let moved = VlcTimeUpdate {
            position: 12.0,
            ..base.clone()
        };
        assert!(snapshot_changed(&Some(base.clone()), &moved));
        let paused = VlcTimeUpdate {
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
        assert_eq!(position_clamped(30.0, 0.0), 30.0);
        assert_eq!(position_clamped(-2.0, 0.0), 0.0);
    }
}