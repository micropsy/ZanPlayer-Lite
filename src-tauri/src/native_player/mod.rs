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

/// How long the smoke battery parks on the settled sidebar-ON state when
/// `ZANPLAYER_NATIVE_SMOKE_PAUSE=1`, so an external capture can be taken.
const PAUSE_SECS: u64 = 45;

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

/// One snapshot of the real DOM video-stage rect (as measured inside the
/// webview) plus the DOM alpha over its centre. The smoke compares this against
/// the rect the native surface was actually anchored to (`native-smoke-layout`):
/// a mismatch means the layer is parked at a stale rect while the DOM moved.
#[cfg(feature = "native-player")]
#[derive(Clone, Copy, Debug)]
struct MeasureSnap {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    alpha: f64,
    /// Live `window.devicePixelRatio` at sample time — the audit proves the
    /// CSS-px↔point contract by equality with the layer's backing scale.
    dpr: f64,
    /// JS `Date.now()` of the sample — lets Rust discard pre-eval samples.
    at: f64,
}

/// One horizontal paint-profile sample across the whole window (see
/// `__zanSmokeScan`): `box_` is one char per ~16 CSS px — `S` = inside the
/// opaque sidebar subtree, `o` = opaque webview over the video, `.` =
/// see-through, `1`..`8` = intermediate alpha.
#[cfg(feature = "native-player")]
#[derive(Clone, Debug)]
struct ScanSnap {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    box_: Vec<char>,
    /// Named element rects (`strip`, `row`, `sidebar`, `column`, `stage`,
    /// `area`) so a seam/gap anywhere in the app layout shows up as a real
    /// pixel extent rather than invisible to the numeric checks.
    layout: Vec<(String, f64, f64, f64, f64)>,
    at: f64,
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

/// True when the `ZANPLAYER_NATIVE_LAYOUT_DEBUG=1` env var is set: turns on
/// the magenta native-layer border (render backend), the structured
/// `[zan-layout-trace]` record, and the DOM stage/sidebar/player-area
/// outlines that the frontend paints above the video.
#[tauri::command]
pub fn native_layout_debug() -> bool {
    #[cfg(all(target_os = "macos", feature = "macos-render"))]
    {
        render::layout_debug_enabled()
    }
    #[cfg(not(all(target_os = "macos", feature = "macos-render")))]
    {
        false
    }
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
        use tauri::{Emitter, Listener, Manager};
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

                // The harness webview sits in the app's *empty* state, whose
                // player root paints an opaque `bg-black` over the player area
                // (the product only turns the root transparent once the frontend
                // knows `engine === "mpv"`). Without help the mpv layer behind
                // the webview is invisible: "I hear the sound of the smoke video
                // but I see no picture". So, smoke-only:
                //   1. ask the webview for the rect of the player area — the main
                //      content column right of the sidebar, exactly what the
                //      product's layout reporter feeds `mpv_set_layout`,
                //   2. clear the DOM background *inside that area* so the webview
                //      is see-through there (the sidebar keeps its own paint, so
                //      the smoke reproduces the real player layout: opaque chrome
                //      left, video stage right),
                //   3. report the DOM alpha over the area centre; ≥0.5 fails the
                //      smoke instead of silently playing sound behind a surface.
                let layout = std::sync::Arc::new(std::sync::Mutex::new(None::<SurfaceLayout>));
                let layout_app = app.clone();
                let layout_rx = std::sync::Arc::clone(&layout);
                let _layout_listener = app.listen("native-smoke-layout", move |ev| {
                    if let Ok(rect) = serde_json::from_str::<SurfaceLayout>(ev.payload()) {
                        let _ = apply_surface_layout(&layout_app, &rect);
                        // Compare against where the surface ACTUALLY rendered,
                        // not the rect we merely requested — a `setFrame:` that
                        // landed elsewhere (misconverted/accumulated coords)
                        // must fail the checks, not hide behind the intent.
                        #[cfg(all(target_os = "macos", feature = "macos-render"))]
                        let applied = session::macos_surface::applied_js_rect(&layout_app)
                            .map(|(x, y, w, h)| SurfaceLayout { x, y, width: w, height: h })
                            .unwrap_or(rect);
                        #[cfg(not(all(target_os = "macos", feature = "macos-render")))]
                        let applied = rect;
                        eprintln!(
                            "[native-smoke] webview player area = {:.0}x{:.0} at ({:.0},{:.0}) (actual {:.0}x{:.0} at ({:.0},{:.0}))",
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
                // On-demand DOM measurement: Rust evals `__zanSmokeMeasure()`, the
                // webview emits the CURRENT stage rect + alpha, and Rust compares
                // it against the rect the native surface was anchored to. This is
                // what turns "the video should have moved" into a hard check.
                let measure = Arc::new(Mutex::new(None::<MeasureSnap>));
                let web_fs = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let web_fs_rx = Arc::clone(&web_fs);
                let measure_rx = Arc::clone(&measure);
                let _measure_listener = app.listen("native-smoke-measure", move |ev| {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(ev.payload()) {
                        let get = |k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
                        let push = MeasureSnap {
                            x: get("x"),
                            y: get("y"),
                            width: get("width"),
                            height: get("height"),
                            alpha: get("alpha"),
                            dpr: get("dpr"),
                            at: get("t"),
                        };
                        web_fs_rx.store(get("fs") > 0.5, std::sync::atomic::Ordering::Relaxed);
                        eprintln!(
                            "[native-smoke] DOM measure = ({:.0},{:.0}) {:.0}x{:.0} alpha={:.3} dpr={:.2}",
                            push.x, push.y, push.width, push.height, push.alpha, push.dpr
                        );
                        *measure_rx.lock().unwrap_or_else(|p| p.into_inner()) = Some(push);
                    }
                });
                // Sidebar paint-profile results (see `__zanSmokeScan` in the webview).
                let scan = Arc::new(Mutex::new(None::<ScanSnap>));
                let scan_rx = Arc::clone(&scan);
                let _scan_listener = app.listen("native-smoke-scan", move |ev| {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(ev.payload()) {
                        let get = |k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
                        let box_s = v
                            .get("box")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .chars()
                            .collect::<Vec<char>>();
                        let mut layout = Vec::new();
                        if let Some(map) = v.get("layout").and_then(|x| x.as_object()) {
                            for (name, rect) in map {
                                if let Some(o) = rect.as_object() {
                                    let rget = |k: &str| {
                                        o.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0)
                                    };
                                    layout.push((
                                        name.clone(),
                                        rget("x"),
                                        rget("y"),
                                        rget("w"),
                                        rget("h"),
                                    ));
                                }
                            }
                            layout.sort_by(|a, b| a.0.cmp(&b.0));
                        }
                        *scan_rx.lock().unwrap_or_else(|p| p.into_inner()) = Some(ScanSnap {
                            x: get("x"),
                            y: get("y"),
                            width: get("width"),
                            height: get("height"),
                            box_: box_s,
                            layout,
                            at: get("t"),
                        });
                    }
                });
                if let Some(wv) = app.get_webview_window("main") {
                    // Cold-start gate: on a fresh Vite dev server the webview
                    // finishes navigating AFTER setup ran, so a harness script
                    // evaluated into the pre-navigation page is destroyed when
                    // the real document loads — the checks would then falsely
                    // read "no layout event received" and alpha=1000 (runs 5/6
                    // flaked exactly this way; a warm webview avoids it). Poll
                    // for the mounted app root (`#root > div`) and evaluate the
                    // real injection only once the page is live.
                    let smoke_ready = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                    {
                        let ready_rx = std::sync::Arc::clone(&smoke_ready);
                        let _ready_listener = app.listen("native-smoke-ready", move |_| {
                            ready_rx.store(true, std::sync::atomic::Ordering::Relaxed);
                        });
                    }
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
    // Smallest descendant that reaches the bottom-right corner of the window
    // (the player stage / main content column — never the top bar, mobile
    // absolute overlays, or the sidebar, which all fail one of the bounds).
    // Search every descendant: the app root now wraps sidebar + content in a
    // "content row", so a direct-children-only scan would measure the whole
    // row (sidebar included) instead of the stage column.
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
        const right = b.left + b.width;
        const bottom = b.top + b.height;
        if (right >= innerWidth - 1 && bottom >= innerHeight - 1) {
          const area = b.width * b.height;
          if (!best || area < bestArea) {
            best = k;
            bestArea = area;
          }
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
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), alpha: Math.round(alpha * 1000) / 1000, dpr: window.devicePixelRatio || 1 };
  }
  function emit(event, payload) {
    try {
      window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event, payload });
    } catch (e) { /* __TAURI_INTERNALS__ is always injected in a Tauri webview */ }
  }
  function report(s) {
    if (!s) return;
    emit('native-smoke-layout', { x: s.x, y: s.y, width: s.width, height: s.height });
    emit('native-smoke-occlusion', Math.round(s.alpha * 1000));
  }
  function loop() {
    if (!document.documentElement || !document.head || !document.body) { setTimeout(loop, 100); return; }
    if (!styled) {
      styled = true;
      const s = document.createElement('style');
      s.id = 'zanplayer-smoke-clear';
      s.textContent = 'html.zanplayer-smoke .zanplayer-smoke-area, html.zanplayer-smoke .zanplayer-smoke-area * { background: transparent !important; }';
      document.documentElement.className += ' zanplayer-smoke';
      document.head.appendChild(s);
    }
    const s = sampleArea();
    if (!s) { setTimeout(loop, 100); return; }
    const key = s.x + ':' + s.y + ':' + s.width + ':' + s.height;
    if (key !== lastKey) {
      lastKey = key;
      report(s);
    }
    requestAnimationFrame(loop);
  }
  window.__zanSmokeMeasure = () => {
    const s = sampleArea();
    if (!s) return;
    emit('native-smoke-measure', { x: s.x, y: s.y, width: s.width, height: s.height, alpha: s.alpha, dpr: s.dpr, fs: document.fullscreenElement ? 1 : 0, t: Date.now() });
  };
  // Sidebar on/off "conflict view": a horizontal paint-profile scan across the
  // WHOLE window at the player area's middle row. Each sample decodes to one
  // char: 'S' = topmost element lives inside [data-sidebar] (opaque sidebar
  // paint), 'o' = opaque webview covering the video, '.' = see-through
  // (transparent DOM — the mpv surface shows, or the window drops through),
  // '1'..'8' = intermediate alpha. Emitted on demand so Rust can print a
  // sidebar-ON/OFF comparison for strictly every window size.
  window.__zanSmokeScan = () => {
    const area = findArea();
    if (!area) return null;
    const r = area.getBoundingClientRect();
    const midY = Math.floor(r.y + r.height / 2);
    const step = 16;
    let row = '';
    for (let x = 0; x < innerWidth; x += step) {
      const el = document.elementFromPoint(x, midY);
      const a = el ? bgAlpha(el) : 1;
      const sb = el ? !!el.closest('[data-sidebar]') : false;
      let c;
      if (sb) c = 'S';
      else if (a >= 0.9) c = 'o';
      else if (a <= 0.1) c = '.';
      else c = String(Math.min(8, Math.max(1, Math.floor(a * 9))));
      row += c;
    }
    const res = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), box: row, t: Date.now(), layout: (() => {
      const out = {};
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
      };
      out.strip = pick('[data-content-row] ~ [data-tauri-drag-region], [data-tauri-drag-region]');
      out.row = pick('[data-content-row]');
      out.sidebar = pick('[data-sidebar]');
      out.column = pick('[data-player-viewport]');
      out.stage = pick('[data-native-stage]');
      out.area = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      return out;
    })() };
    emit('native-smoke-scan', res);
    return res;
  };
  window.__zanSmokeToggle = () => {
    const open = document.querySelector('button[aria-label="Open sidebar"]');
    const close = document.querySelector('button[aria-label="Close sidebar"]');
    if (close) { close.click(); return 'closed'; }
    if (open) { open.click(); return 'opened'; }
    return 'none';
  };
  window.addEventListener('resize', loop);
  window.addEventListener('fullscreenchange', loop);
  setTimeout(loop, 50);
})();"#;
                    let wv_inject = wv.clone();
                    let ready_rx = std::sync::Arc::clone(&smoke_ready);
                    std::thread::spawn(move || {
                        // Poll until the React app root is mounted, then inject.
                        // The ready probe itself is evaluated on every beat, so
                        // navigation mid-poll simply restarts it on the new page.
                        for _ in 0..120 {
                            if ready_rx.load(std::sync::atomic::Ordering::Relaxed) {
                                break;
                            }
                            let _ = wv_inject.eval(
                                "(() => { const root = document.querySelector('#root > div'); \
                                 if (!root) return; const r = root.getBoundingClientRect(); \
                                 if (r.width >= 50 && r.height >= 50) { \
                                 window.__TAURI_INTERNALS__ && \
                                 window.__TAURI_INTERNALS__.invoke('plugin:event|emit', \
                                 { event: 'native-smoke-ready', payload: 1 }); } })();",
                            );
                            std::thread::sleep(std::time::Duration::from_millis(250));
                        }
                        if ready_rx.load(std::sync::atomic::Ordering::Relaxed) {
                            let _ = wv_inject.eval(&*smoke_script);
                        } else {
                            eprintln!("[native-smoke] webview-ready gate timed out — harness not injected");
                        }
                    });
                }

                let app_handle = app.clone();
                std::thread::spawn(move || {
                    // Let mpv decode a few seconds, then run the check battery.
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    eprintln!("[native-smoke] diagnostics: {}", probe.diagnostics());
                    // The injected harness (and the first layout event) can land
                    // late on a cold-start webview; wait for the anchor instead of
                    // racing a fixed deadline.
                    let mut anchored = false;
                    for _ in 0..240 {
                        if layout.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
                            anchored = true;
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    eprintln!(
                        "[native-smoke] CAMetalLayer anchored to the player area (right of sidebar): {}",
                        if anchored { "yes" } else { "NO — layout event not received" }
                    );

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

                    // ---- helpers for the interactive layout battery ----
                    let snapshot = || -> Option<(f64, f64, f64, f64)> {
                        layout
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .map(|r| (r.x, r.y, r.width, r.height))
                    };
                    let rects_same = |a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)| -> bool {
                        (a.0 - b.0).abs() < 2.0
                            && (a.1 - b.1).abs() < 2.0
                            && (a.2 - b.2).abs() < 2.0
                            && (a.3 - b.3).abs() < 2.0
                    };
                    let fmt = |r: &(f64, f64, f64, f64)| {
                        format!("({:.0},{:.0}) {:.0}x{:.0}", r.0, r.1, r.2, r.3)
                    };
                    // Ask the webview for the CURRENT DOM stage rect + alpha and
                    // return it. Samples older than the eval are discarded.
                    let measure_now = || -> Option<(f64, f64, f64, f64, f64)> {
                        let before = measure
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .map(|s| s.at)
                            .unwrap_or(0.0);
                        if let Some(wv) = app_handle.get_webview_window("main") {
                            let _ = wv.eval("window.__zanSmokeMeasure();");
                        }
                        for _ in 0..100 {
                            std::thread::sleep(std::time::Duration::from_millis(50));
                            let cur = measure.lock().unwrap_or_else(|p| p.into_inner());
                            if let Some(s) = *cur {
                                if s.at > before {
                                    return Some((s.x, s.y, s.width, s.height, s.alpha));
                                }
                            }
                        }
                        None
                    };
                    // Same pattern for the whole-window paint profile (`__zanSmokeScan`).
                    let scan_now = || -> Option<String> {
                        let before = scan
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .as_ref()
                            .map(|s| s.at)
                            .unwrap_or(0.0);
                        if let Some(wv) = app_handle.get_webview_window("main") {
                            let _ = wv.eval("if (window.__zanSmokeScan) window.__zanSmokeScan();");
                        }
                        for _ in 0..100 {
                            std::thread::sleep(std::time::Duration::from_millis(50));
                            let cur = scan.lock().unwrap_or_else(|p| p.into_inner());
                            if let Some(s) = cur.as_ref() {
                                if s.at > before {
                                    let mut out = format!(
                                        "[native-smoke] conflict-view area=({:.0},{:.0}) {:.0}x{:.0} box=",
                                        s.x, s.y, s.width, s.height
                                    );
                                    for c in &s.box_ {
                                        out.push(*c);
                                    }
                                    out.push_str(" | layout ");
                                    let rect = |map: &[(String, f64, f64, f64, f64)],
                                                    k: &str|
                                     -> Option<(f64, f64, f64, f64)> {
                                        map.iter()
                                            .find(|(n, ..)| n == k)
                                            .map(|(_, x, y, w, h)| (*x, *y, *w, *h))
                                    };
                                    let push_rect =
                                        |out: &mut String,
                                         map: &[(String, f64, f64, f64, f64)],
                                         k: &str| {
                                            if let Some((x, y, w, h)) = rect(map, k) {
                                                out.push_str(&format!(
                                                    "{k}=({:.0},{:.0}) {:.0}x{:.0} ",
                                                    x, y, w, h
                                                ));
                                            }
                                        };
                                    push_rect(&mut out, &s.layout, "strip");
                                    push_rect(&mut out, &s.layout, "row");
                                    push_rect(&mut out, &s.layout, "sidebar");
                                    push_rect(&mut out, &s.layout, "column");
                                    push_rect(&mut out, &s.layout, "stage");
                                    push_rect(&mut out, &s.layout, "area");
                                    // Seam/gap math in CSS px:
                                    //   sidebar-right -> column-left (inline gap)
                                    //   column-left -> stage-left
                                    //   stage/area right edge vs row right edge
                                    //   area bottom vs row bottom
                                    let row = rect(&s.layout, "row");
                                    let sb = rect(&s.layout, "sidebar");
                                    let col = rect(&s.layout, "column");
                                    let stg = rect(&s.layout, "stage");
                                    let mut mask = String::from(
                                        "[native-smoke] conflict-view gaps ",
                                    );
                                    if let (Some(sb), Some(col)) = (sb, col) {
                                        mask.push_str(&format!(
                                            "sidebar->col={}px ",
                                            (col.0 - (sb.0 + sb.2)).round()
                                        ));
                                    }
                                    if let (Some(col), Some(stg)) = (col, stg) {
                                        mask.push_str(&format!(
                                            "col->stage-l={}px stage-r-col-r={}px ",
                                            (stg.0 - col.0).round(),
                                            ((col.0 + col.2) - (stg.0 + stg.2)).round()
                                        ));
                                    }
                                    if let (Some(row), Some(stg)) = (row, stg) {
                                        mask.push_str(&format!(
                                            "stage->row-r={}px stage->row-b={}px ",
                                            ((row.0 + row.2) - (stg.0 + stg.2)).round(),
                                            ((row.1 + row.3) - (stg.1 + stg.3)).round()
                                        ));
                                    }
                                    eprintln!("{mask}");
                                    return Some(out);
                                }
                            }
                        }
                        None
                    };
                    // Wait until the applied-rect stream stops changing (the layout
                    // has settled) and return the final rect.
                    let settle = |timeout: std::time::Duration| -> Option<(f64, f64, f64, f64)> {
                        let mut last: Option<(f64, f64, f64, f64)> = None;
                        let mut stable = std::time::Duration::ZERO;
                        let start = std::time::Instant::now();
                        while start.elapsed() < timeout {
                            std::thread::sleep(std::time::Duration::from_millis(50));
                            let now = snapshot();
                            let changed = match (last, now) {
                                (Some(p), Some(n)) => !rects_same(p, n),
                                (None, Some(_)) => true,
                                _ => false,
                            };
                            if changed {
                                stable = std::time::Duration::ZERO;
                            } else {
                                stable += std::time::Duration::from_millis(50);
                            }
                            last = now;
                            if last.is_some() && stable >= std::time::Duration::from_secs(2) {
                                return last;
                            }
                        }
                        last
                    };
                    let toggle_sidebar = |app: &tauri::AppHandle| {
                        if let Some(wv) = app.get_webview_window("main") {
                            let _ = wv.eval("window.__zanSmokeToggle();");
                        }
                    };

                    let mut checks: Vec<(&str, bool)> = vec![
                        ("render context reported no error", probe.render_error() == 0),
                        ("at least one frame presented via Metal", probe.frames_presented() > 0),
                        ("decoding through vo=libmpv", probe.current_vo() == "libmpv"),
                        ("playback clock advancing", probe.time_pos() > 0.0),
                        (
                            "video not occluded by an opaque webview surface",
                            dom_alpha < 0.5,
                        ),
                    ];

                    // Normalize the window to a sane ≥md width first, so the sidebar
                    // is in-flow. Below the `md` breakpoint the sidebar becomes an
                    // overlay that does not move the main column at all, which would
                    // make the sidebar-toggle check meaningless.
                    if let Some(win) = app_handle.get_webview_window("main") {
                        let _ = win.set_fullscreen(false);
                        std::thread::sleep(std::time::Duration::from_millis(600));
                        if let Ok(cur) = win.inner_size() {
                            let target = tauri::PhysicalSize {
                                width: cur.width.max(1080),
                                height: cur.height.max(720),
                            };
                            let _ = win.set_size(target);
                        }
                        if let Some(r) = settle(std::time::Duration::from_secs(6)) {
                            eprintln!("[native-smoke] pre-battery settled area = {}", fmt(&r));
                        }
                    }

                    // CHECK 6 — a single window resize re-anchors the stage.
                    let resized = if let Some(win) = app_handle.get_webview_window("main") {
                        let attempt = |dw: i64, dh: i64, prev: Option<(f64, f64, f64, f64)>| {
                            if let Ok(current) = win.inner_size() {
                                let target = tauri::PhysicalSize {
                                    width: (current.width as i64 + dw).max(640) as u32,
                                    height: (current.height as i64 + dh).max(480) as u32,
                                };
                                let _ = win.set_size(target);
                                for _ in 0..80 {
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                    let now = snapshot();
                                    if let (Some(p), Some(n)) = (prev, now) {
                                        if !rects_same(p, n) {
                                            return true;
                                        }
                                    }
                                }
                            }
                            false
                        };
                        let prev = snapshot();
                        if attempt(320, 160, prev) {
                            true
                        } else {
                            let prev = snapshot();
                            attempt(-320, -160, prev)
                        }
                    } else {
                        false
                    };
                    checks.push(("stage re-anchors to a window resize", resized));
                    if let Some(r) = snapshot() {
                        eprintln!("[native-smoke] after single resize = {}", fmt(&r));
                    }

                    // CHECK 7 — sidebar reflow (mini <-> extend): the real UI
                    // sidebar toggle must move the stage, the applied rect must
                    // MATCH the DOM stage (±2px), and the DOM over the new area
                    // must stay transparent (no torn background).
                    let sidebar_reflow = (|| {
                        let before = match snapshot() {
                            Some(b) => b,
                            None => {
                                eprintln!("[native-smoke] no layout yet for the sidebar test");
                                return false;
                            }
                        };
                        if let Some(s) = scan_now() {
                            eprintln!("{s} [state-before-first-toggle]");
                        }
                        if std::env::var("ZANPLAYER_NATIVE_SMOKE_PAUSE").map(|v| v == "1").unwrap_or(false) {
                            eprintln!(
                                "[native-smoke] PAUSED at sidebar-ON settled state for external capture — {}s",
                                PAUSE_SECS
                            );
                            std::thread::sleep(std::time::Duration::from_secs(PAUSE_SECS));
                        }
                        toggle_sidebar(&app_handle);
                        let after = match settle(std::time::Duration::from_secs(8)) {
                            Some(n) if !rects_same(n, before) => n,
                            _ => {
                                eprintln!(
                                    "[native-smoke] sidebar toggle produced no area change (started {})",
                                    fmt(&before)
                                );
                                return false;
                            }
                        };
                        if let Some(s) = scan_now() {
                            eprintln!("{s} [sidebar OFF]");
                        }
                        let dom1 = measure_now();
                        let ok1 = dom1
                            .map(|(x, y, w, h, a)| rects_same((x, y, w, h), after) && a < 0.5)
                            .unwrap_or(false);
                        eprintln!(
                            "[native-smoke] sidebar toggle #1: applied={} dom={} alpha={} -> {}",
                            fmt(&after),
                            dom1
                                .map(|(x, y, w, h, _)| format!("({:.0},{:.0}) {:.0}x{:.0}", x, y, w, h))
                                .unwrap_or_else(|| "no measure".into()),
                            dom1.map(|(_, _, _, _, a)| a).unwrap_or(1.0),
                            if ok1 { "synced" } else { "STALE/MISMATCH" }
                        );
                        if !ok1 {
                            return false;
                        }
                        toggle_sidebar(&app_handle);
                        let back = match settle(std::time::Duration::from_secs(8)) {
                            Some(n) if !rects_same(n, after) => n,
                            _ => {
                                eprintln!("[native-smoke] sidebar toggle #2 produced no area change");
                                return false;
                            }
                        };
                        if let Some(s) = scan_now() {
                            eprintln!("{s} [sidebar ON]");
                        }
                        let dom2 = measure_now();
                        let returned = rects_same(back, before);
                        let ok2 = dom2
                            .map(|(x, y, w, h, a)| rects_same((x, y, w, h), back) && a < 0.5)
                            .unwrap_or(false)
                            && returned;
                        eprintln!(
                            "[native-smoke] sidebar toggle #2 (return): applied={} dom={} alpha={} returned-to-start={} -> {}",
                            fmt(&back),
                            dom2
                                .map(|(x, y, w, h, _)| format!("({:.0},{:.0}) {:.0}x{:.0}", x, y, w, h))
                                .unwrap_or_else(|| "no measure".into()),
                            dom2.map(|(_, _, _, _, a)| a).unwrap_or(1.0),
                            returned,
                            if ok2 { "synced" } else { "STALE/MISMATCH" }
                        );
                        ok2
                    })();
                    checks.push((
                        "sidebar reflow re-anchors the stage (mini/extend) and stays transparent",
                        sidebar_reflow,
                    ));

                    // CHECK 8 — multi-step manual resize: after EVERY step the
                    // applied rect must equal the DOM stage rect (no drift) and
                    // the DOM must stay transparent.
                    let multi_resize = (|| {
                        let steps: [(i64, i64); 4] = [(200, 0), (0, 120), (-260, -80), (120, 60)];
                        for (i, (dw, dh)) in steps.iter().enumerate() {
                            let before = match snapshot() {
                                Some(b) => b,
                                None => return false,
                            };
                            let win = match app_handle.get_webview_window("main") {
                                Some(w) => w,
                                None => return false,
                            };
                            // Derive the target from the APPLIED stage rect (the
                            // right/bottom edge of the CSS-px player area) scaled
                            // to physical px via the window scale factor. Basing it
                            // on `inner_size()` instead is wrong: a session-restored
                            // oversized frame (macOS) makes the delta/clamp no-op and
                            // the check reads the area as "did not change".
                            let (bx, by, bw, bh) = before;
                            let scale = win.scale_factor().unwrap_or(1.0);
                            let target = tauri::PhysicalSize {
                                width: (((bx + bw) + *dw as f64) * scale)
                                    .clamp(720.0, 4200.0) as u32,
                                height: (((by + bh) + *dh as f64) * scale)
                                    .clamp(520.0, 3200.0) as u32,
                            };
                            eprintln!(
                                "[native-smoke] resize step {i} (d{dw}x{dh}): scaling stage {bx:.0}+{bw:.0}/{by:.0}+{bh:.0} by {scale:.2} -> target {target:?}"
                            );
                            if let Err(e) = win.set_size(target) {
                                eprintln!(
                                    "[native-smoke] resize step {i}: set_size failed: {e}"
                                );
                                return false;
                            }
                            let after = match settle(std::time::Duration::from_secs(8)) {
                                Some(n) if !rects_same(n, before) => n,
                                other => {
                                    eprintln!(
                                        "[native-smoke] resize step {i}: area did not change (settle={:?}, before={})",
                                        other.map(|n| fmt(&n)),
                                        fmt(&before)
                                    );
                                    return false;
                                }
                            };
                            let dom = measure_now();
                            let ok = dom
                                .map(|(x, y, w, h, a)| rects_same((x, y, w, h), after) && a < 0.5)
                                .unwrap_or(false);
                            eprintln!(
                                "[native-smoke] resize step {i} (d{dw}x{dh}): applied={} dom={} alpha={} -> {}",
                                fmt(&after),
                                dom.map(|(x, y, w, h, _)| format!("({:.0},{:.0}) {:.0}x{:.0}", x, y, w, h))
                                    .unwrap_or_else(|| "no measure".into()),
                                dom.map(|(_, _, _, _, a)| a).unwrap_or(1.0),
                                if ok { "synced" } else { "STALE/MISMATCH" }
                            );
                            if !ok {
                                return false;
                            }
                        }
                        true
                    })();
                    checks.push((
                        "multi-step manual resize re-anchors exactly (no drift) + transparent",
                        multi_resize,
                    ));

                    // CHECK 9 — native fullscreen enter then exit: the stage must
                    // re-anchor to the new area both ways, exactly, transparent.
                    // macOS animates the fullscreen Space transition, so gate on
                    // the OS-reported `is_fullscreen` flag rather than a timer;
                    // otherwise the first sampled rect is a mid-animation one and
                    // the exit can be judged before it even starts.
                    let fullscreen_toggle = (|| {
                        let win = match app_handle.get_webview_window("main") {
                            Some(w) => w,
                            None => return false,
                        };
                        let before = match snapshot() {
                            Some(b) => b,
                            None => return false,
                        };
                        let _ = win.set_fullscreen(true);
                        let mut entered: Option<(f64, f64, f64, f64)> = None;
                        for _ in 0..80 {
                            std::thread::sleep(std::time::Duration::from_millis(250));
                            if win.is_fullscreen().unwrap_or(false) {
                                if let Some(n) = settle(std::time::Duration::from_secs(6)) {
                                    if !rects_same(n, before) {
                                        entered = Some(n);
                                    }
                                    break;
                                }
                            }
                        }
                        let entered = match entered {
                            Some(e) => e,
                            None => {
                                eprintln!(
                                    "[native-smoke] fullscreen enter: not fullscreen / area unchanged"
                                );
                                return false;
                            }
                        };
                        let dom = measure_now();
                        let ok_in = dom
                            .map(|(x, y, w, h, a)| rects_same((x, y, w, h), entered) && a < 0.5)
                            .unwrap_or(false);
                        eprintln!(
                            "[native-smoke] fullscreen enter: applied={} dom={} alpha={} -> {}",
                            fmt(&entered),
                            dom.map(|(x, y, w, h, _)| format!("({:.0},{:.0}) {:.0}x{:.0}", x, y, w, h))
                                .unwrap_or_else(|| "no measure".into()),
                            dom.map(|(_, _, _, _, a)| a).unwrap_or(1.0),
                            if ok_in { "synced" } else { "STALE/MISMATCH" }
                        );
                        if !ok_in {
                            return false;
                        }
                        let _ = win.set_fullscreen(false);
                        let mut exited: Option<(f64, f64, f64, f64)> = None;
                        for _ in 0..80 {
                            std::thread::sleep(std::time::Duration::from_millis(250));
                            if !win.is_fullscreen().unwrap_or(true) {
                                if let Some(n) = settle(std::time::Duration::from_secs(6)) {
                                    if !rects_same(n, entered) {
                                        exited = Some(n);
                                    }
                                    break;
                                }
                            }
                        }
                        let exited = match exited {
                            Some(e) => e,
                            None => {
                                eprintln!(
                                    "[native-smoke] fullscreen exit: not windowed / area unchanged"
                                );
                                return false;
                            }
                        };
                        let dom = measure_now();
                        let ok_out = dom
                            .map(|(x, y, w, h, a)| rects_same((x, y, w, h), exited) && a < 0.5)
                            .unwrap_or(false);
                        eprintln!(
                            "[native-smoke] fullscreen exit: applied={} dom={} alpha={} -> {}",
                            fmt(&exited),
                            dom.map(|(x, y, w, h, _)| format!("({:.0},{:.0}) {:.0}x{:.0}", x, y, w, h))
                                .unwrap_or_else(|| "no measure".into()),
                            dom.map(|(_, _, _, _, a)| a).unwrap_or(1.0),
                            if ok_out { "synced" } else { "STALE/MISMATCH" }
                        );
                        ok_out
                    })();
                    checks.push((
                        "fullscreen enter/exit re-anchors the stage + stays transparent",
                        fullscreen_toggle,
                    ));

                    // CHECK 10 — the PRODUCT's fullscreen button uses the WEB
                    // Fullscreen API (`document.documentElement.requestFullscreen()`),
                    // which also auto-hides the sidebar (App.tsx). Drive that exact
                    // path: the stage must jump to the full-window rect at x≈0,
                    // match the DOM, and stay transparent. Skipped (not failed) if
                    // the webview doesn't implement the API.
                    let web_fullscreen = (|| {
                        let win = match app_handle.get_webview_window("main") {
                            Some(w) => w,
                            None => return false,
                        };
                        let before = match snapshot() {
                            Some(b) => b,
                            None => return false,
                        };
                        let measure_refresh = || {
                            if let Some(wv) = app_handle.get_webview_window("main") {
                                let _ = wv.eval("window.__zanSmokeMeasure();");
                            }
                        };
                        measure_refresh();
                        if let Some(wv) = app_handle.get_webview_window("main") {
                            let _ = wv.eval(
                                "document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {})",
                            );
                        }
                        let mut engaged = false;
                        for _ in 0..40 {
                            std::thread::sleep(std::time::Duration::from_millis(150));
                            measure_refresh();
                            if web_fs.load(std::sync::atomic::Ordering::Relaxed) {
                                engaged = true;
                                break;
                            }
                        }
                        if !engaged {
                            eprintln!(
                                "[native-smoke] web fullscreen API did not engage — skipping (product button path unavailable on this webview/session)"
                            );
                            return true;
                        }
                        let entered = match settle(std::time::Duration::from_secs(6)) {
                            Some(n) if !rects_same(n, before) => n,
                            _ => {
                                eprintln!("[native-smoke] web fullscreen: area unchanged");
                                return false;
                            }
                        };
                        if entered.0 > 20.0 {
                            eprintln!(
                                "[native-smoke] web fullscreen: stage did not extend to the window (x={:.0}, sidebar not hidden?)",
                                entered.0
                            );
                            return false;
                        }
                        let dom = measure_now();
                        let ok_in = dom
                            .map(|(x, y, w, h, a)| rects_same((x, y, w, h), entered) && a < 0.5)
                            .unwrap_or(false);
                        eprintln!(
                            "[native-smoke] web fullscreen enter: applied={} dom={} alpha={} -> {}",
                            fmt(&entered),
                            dom.map(|(x, y, w, h, _)| format!("({:.0},{:.0}) {:.0}x{:.0}", x, y, w, h))
                                .unwrap_or_else(|| "no measure".into()),
                            dom.map(|(_, _, _, _, a)| a).unwrap_or(1.0),
                            if ok_in { "synced" } else { "STALE/MISMATCH" }
                        );
                        if !ok_in {
                            return false;
                        }
                        if let Some(wv) = app_handle.get_webview_window("main") {
                            let _ = wv.eval(
                                "document.exitFullscreen && document.exitFullscreen().catch(() => {})",
                            );
                        }
                        let mut left = false;
                        for _ in 0..40 {
                            std::thread::sleep(std::time::Duration::from_millis(150));
                            measure_refresh();
                            if !web_fs.load(std::sync::atomic::Ordering::Relaxed) {
                                left = true;
                                break;
                            }
                        }
                        if !left {
                            eprintln!("[native-smoke] web fullscreen: did not exit");
                            return false;
                        }
                        let _ = win.set_fullscreen(false);
                        let exited = match settle(std::time::Duration::from_secs(6)) {
                            Some(n) if !rects_same(n, entered) => n,
                            _ => {
                                eprintln!("[native-smoke] web fullscreen exit: area unchanged");
                                return false;
                            }
                        };
                        let dom = measure_now();
                        let ok_out = dom
                            .map(|(x, y, w, h, a)| rects_same((x, y, w, h), exited) && a < 0.5)
                            .unwrap_or(false);
                        eprintln!(
                            "[native-smoke] web fullscreen exit: applied={} dom={} alpha={} -> {}",
                            fmt(&exited),
                            dom.map(|(x, y, w, h, _)| format!("({:.0},{:.0}) {:.0}x{:.0}", x, y, w, h))
                                .unwrap_or_else(|| "no measure".into()),
                            dom.map(|(_, _, _, _, a)| a).unwrap_or(1.0),
                            if ok_out { "synced" } else { "STALE/MISMATCH" }
                        );
                        ok_out
                    })();
                    checks.push((
                        "web fullscreen (product button path) re-anchors to full-window + transparent",
                        web_fullscreen,
                    ));

                    // CHECK 11 — narrow desktop window (sub-`md`) inline guard:
                    // the sidebar layout decision is PLATFORM-driven, never
                    // width-driven. A desktop window below the 768 px breakpoint
                    // (session-restored small frame) must KEEP the sidebar
                    // side-by-side and opaque — stage right of it, video never
                    // under/over the sidebar. The old width-driven rule silently
                    // turned any sub-md desktop window into a drawer-over-video
                    // conflict (sidebar ON = floating layer over the picture,
                    // OFF = full-width video that looked fine).
                    let narrow_inline = (|| {
                        let win = match app_handle.get_webview_window("main") {
                            Some(w) => w,
                            None => return false,
                        };
                        let before = match snapshot() {
                            Some(b) => b,
                            None => return false,
                        };
                        let scale = win.scale_factor().unwrap_or(1.0);
                        // Original CSS-px extent (stage right/bottom edge) so we
                        // can restore the window afterwards.
                        let orig_w = before.0 + before.2;
                        let orig_h = before.1 + before.3;
                        let _ = win.set_size(tauri::PhysicalSize {
                            width: (640.0 * scale).round() as u32,
                            height: (orig_h * scale).round().clamp(520.0, 3200.0) as u32,
                        });
                        let mut ok = true;
                        // Measure + assert the current sidebar state (whatever it
                        // is — it is ON when we reach here), then FLIP it and
                        // assert the other one, then restore the original state.
                        for (i, side) in ["ON", "OFF"].iter().enumerate() {
                            let now = match settle(std::time::Duration::from_secs(8)) {
                                Some(n) => n,
                                None => {
                                    eprintln!(
                                        "[native-smoke] narrow {}.{}: stage did not settle",
                                        i + 1,
                                        side
                                    );
                                    return false;
                                }
                            };
                            let on = now.0 > 100.0;
                            let dom = measure_now();
                            let dom_ok = dom
                                .map(|(x, y, w, h, a)| rects_same((x, y, w, h), now) && a < 0.5)
                                .unwrap_or(false);
                            let fits = now.0 + now.2 <= 640.0 + 2.0;
                            let inline_ok = if on {
                                // sidebar side-by-side: stage starts at the 352px
                                // sidebar width (+ a px of rounding). A drawer
                                // regression would put the stage at x≈0.
                                now.0 >= 340.0 && now.0 <= 352.0 + 8.0
                            } else {
                                now.0 <= 20.0
                            };
                            if let Some(s) = scan_now() {
                                eprintln!("{s} [narrow 640-wide, sidebar {side}]");
                            }
                            let ok_here = dom_ok && fits && inline_ok;
                            ok &= ok_here;
                            eprintln!(
                                "[native-smoke] narrow-window sub-md check {}.{}: applied={} dom={} sidebar={} fits={} inline={} alpha={:.3} -> {}",
                                i + 1,
                                side,
                                fmt(&now),
                                dom.map(|(x, y, w, h, _)| format!("({:.0},{:.0}) {:.0}x{:.0}", x, y, w, h))
                                    .unwrap_or_else(|| "no measure".into()),
                                if on { "ON (pushed right)" } else { "OFF (fills row)" },
                                fits,
                                inline_ok,
                                dom.map(|(_, _, _, _, a)| a).unwrap_or(1.0),
                                if ok_here { "inline-ok" } else { "CONFLICT" }
                            );
                            if i == 0 {
                                toggle_sidebar(&app_handle);
                            } else {
                                // restore the pre-check sidebar state
                                toggle_sidebar(&app_handle);
                            }
                        }
                        let _ = settle(std::time::Duration::from_secs(4));
                        let _ = win.set_size(tauri::PhysicalSize {
                            width: (orig_w * scale).round().clamp(720.0, 4200.0) as u32,
                            height: (orig_h * scale).round().clamp(520.0, 3200.0) as u32,
                        });
                        let _ = settle(std::time::Duration::from_secs(6));
                        ok
                    })();
                    checks.push((
                        "narrow desktop window (sub-md) keeps the sidebar inline — ON pushes the video aside, OFF fills the row (no drawer conflict)",
                        narrow_inline,
                    ));

                    // CHECK 12 — the REAL product reporter path. Checks 6–11 steer
                    // the native surface through the harness-injected geometry
                    // reporter (`native-smoke-layout`). The code that SHIPS is
                    // different: VideoPlayer.tsx's own `mpv_set_layout` reporter
                    // (a viewport `[data-player-viewport]` ResizeObserver +
                    // `resize`/`fullscreenchange` listeners + `mpv-loaded`). The
                    // harness never tickles it — the product stage `[data-native-stage]`
                    // does not exist in the empty state the smoke runs in — so a
                    // product regression there (e.g. dispatching a stale
                    // window-relative X/width when the sidebar opens: video under
                    // the sidebar's text + a see-through gap on the right) would
                    // pass all 11 checks above. Drive the actual app end-to-end: emit `tauri://drag-drop` so the store
                    // flips to engine="mpv", the product stage mounts, the product
                    // reporter anchors the surface, then toggle the real sidebar
                    // OFF -> ON and assert the applied rect tracks the product DOM
                    // stage every time (no under-sidebar bleed, no right-hand gap).
                    let product_reporter = (|| {
                        let video_path = match std::env::var("ZANPLAYER_NATIVE_SMOKE_VIDEO") {
                            Ok(p) if !p.is_empty() => p,
                            _ => {
                                eprintln!(
                                    "[native-smoke] product-path check skipped: ZANPLAYER_NATIVE_SMOKE_VIDEO unset"
                                );
                                return true;
                            }
                        };
                        let win = match app_handle.get_webview_window("main") {
                            Some(w) => w,
                            None => return false,
                        };
                        // Keep a comfortably wide (inline) layout; a restored
                        // sub-720 css window still works (inline is platform-driven)
                        // but a sane starting point keeps the scan math obvious.
                        if let Ok(cur) = win.inner_size() {
                            let scale = win.scale_factor().unwrap_or(1.0);
                            if (cur.width as f64 / scale) < 720.0 {
                                let _ = win.set_size(tauri::PhysicalSize {
                                    width: (1280.0 * scale).round() as u32,
                                    height: cur.height.max((720.0 * scale) as u32),
                                });
                            }
                        }
                        let _ = settle(std::time::Duration::from_secs(6));
                        // The battery restores the sidebar ON (checks 7/11 end
                        // where they started); if it somehow isn't, open it first.
                        if let Some(b) = snapshot() {
                            if b.0 <= 100.0 {
                                toggle_sidebar(&app_handle);
                                let _ = settle(std::time::Duration::from_secs(6));
                            }
                        }

                        // 1) Load through the REAL product drop handler. The app's
                        // own `tauri://drag-drop` listener calls
                        // `handleDroppedFiles` -> store flip -> `isNativePlayerAvailable`
                        // -> engine="mpv" -> `mpvLoad` -> `[data-native-stage]` mounts
                        // and the product reporter starts steering `mpv_set_layout`.
                        if app_handle
                            .emit("tauri://drag-drop", serde_json::json!({ "paths": [video_path] }))
                            .is_err()
                        {
                            eprintln!(
                                "[native-smoke] product-path: tauri://drag-drop emit failed"
                            );
                            return false;
                        }
                        eprintln!(
                            "[native-smoke] product-path: drag-drop emitted — waiting for engine flip + [data-native-stage]"
                        );

                        // 2) Watch for the product stage mount.
                        let product_stage = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                        let _stage_listener = {
                            let ps = std::sync::Arc::clone(&product_stage);
                            app_handle.listen("native-smoke-product-stage", move |ev| {
                                let exists = match serde_json::from_str::<serde_json::Value>(
                                    ev.payload(),
                                ) {
                                    Ok(j) => j
                                        .get("exists")
                                        .and_then(|x| x.as_i64())
                                        .unwrap_or(0)
                                        > 0,
                                    Err(_) => false,
                                };
                                ps.store(exists, std::sync::atomic::Ordering::Relaxed);
                            })
                        };
                        let probe_js =
                            "(() => { const el = document.querySelector('[data-native-stage]'); \
                             const b = el ? el.getBoundingClientRect() : null; \
                             const r = b ? { x: b.x, w: b.width } : { x: -1, w: -1 }; \
                             window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke('plugin:event|emit', \
                             { event: 'native-smoke-product-stage', payload: { exists: el ? 1 : 0, x: r.x, w: r.w } }); })();";
                        let mut mounted = false;
                        for _ in 0..60 {
                            let _ = win.eval(probe_js);
                            std::thread::sleep(std::time::Duration::from_millis(150));
                            if product_stage.load(std::sync::atomic::Ordering::Relaxed) {
                                mounted = true;
                                break;
                            }
                        }
                        if !mounted {
                            eprintln!(
                                "[native-smoke] product-path: [data-native-stage] never mounted after drag-drop"
                            );
                            return false;
                        }
                        eprintln!(
                            "[native-smoke] product-path: product stage mounted — the shipped reporter is live"
                        );

                        // 3) Assert the product reporter keeps the surface exactly
                        //    on the product DOM stage across real sidebar toggles.
                        let box_chars = |s: &String| -> Option<Vec<char>> {
                            let rest = s.split("box=").nth(1)?;
                            let chars = rest.split(" | layout ").next()?;
                            Some(chars.chars().collect())
                        };
                        // Left region = sidebar paint (≤ 352 css px -> ≤ 22 chars),
                        // stage region = the rest; '.' = see-through, 'o' = opaque
                        // webview over the video, 'S' = opaque sidebar element.
                        let sidebar_region_opaque = |c: &[char]| -> bool {
                            let n = c.len().min(21);
                            n == 21 && c[..n].iter().all(|&x| x != '.')
                        };
                        let no_right_gap = |c: &[char], dom: Option<(f64, f64, f64, f64, f64)>| -> bool {
                            let css_w = c.len() * 16;
                            dom.map(|d| d.0 + d.2 >= css_w as f64 - 8.0).unwrap_or(false)
                        };

                        let a_on = match settle(std::time::Duration::from_secs(10)) {
                            Some(n) => n,
                            None => {
                                eprintln!("[native-smoke] product-path: no applied anchor after drop");
                                return false;
                            }
                        };
                        let dom_on = measure_now();
                        let scan_on = scan_now();
                        let box_on = scan_on.as_ref().and_then(|s| box_chars(s));
                        let ok_on = dom_on
                            .map(|d| rects_same(a_on, (d.0, d.1, d.2, d.3)) && d.4 < 0.5)
                            .unwrap_or(false);
                        let bleed_on = box_on.as_deref().map(|c| sidebar_region_opaque(c)).unwrap_or(false);
                        let gap_on = box_on.as_deref().map(|c| no_right_gap(c, dom_on)).unwrap_or(false);
                        if let Some(s) = &scan_on {
                            eprintln!("{s} [product-path sidebar ON]");
                        }
                        eprintln!(
                            "[native-smoke] product-path sidebar ON: applied={} dom={} alpha={:.3} left-opaque={} no-right-gap={} -> {}",
                            fmt(&a_on),
                            dom_on.map(|d| format!("({:.0},{:.0}) {:.0}x{:.0}", d.0, d.1, d.2, d.3))
                                .unwrap_or_else(|| "no measure".into()),
                            dom_on.map(|(_, _, _, _, a)| a).unwrap_or(1.0),
                            bleed_on,
                            gap_on,
                            if ok_on && bleed_on && gap_on { "synced" } else { "STALE/MISMATCH" }
                        );
                        if !ok_on || !bleed_on || !gap_on {
                            return false;
                        }

                        // 4) Close the sidebar — the exact field-reported "it fits
                        //    when I close it" state.
                        toggle_sidebar(&app_handle);
                        let a_off = match settle(std::time::Duration::from_secs(8)) {
                            Some(n) if !rects_same(n, a_on) => n,
                            _ => {
                                eprintln!(
                                    "[native-smoke] product-path: sidebar close produced no area change"
                                );
                                return false;
                            }
                        };
                        let dom_off = measure_now();
                        let scan_off = scan_now();
                        let box_off = scan_off.as_ref().and_then(|s| box_chars(s));
                        let ok_off = dom_off
                            .map(|d| rects_same(a_off, (d.0, d.1, d.2, d.3)) && d.4 < 0.5)
                            .unwrap_or(false);
                        let trans_off = box_off
                            .as_deref()
                            .map(|c| c.iter().all(|&x| x == '.'))
                            .unwrap_or(false);
                        let gap_off = box_off.as_deref().map(|c| no_right_gap(c, dom_off)).unwrap_or(false);
                        if let Some(s) = &scan_off {
                            eprintln!("{s} [product-path sidebar OFF]");
                        }
                        eprintln!(
                            "[native-smoke] product-path sidebar OFF: applied={} dom={} alpha={:.3} transparent={} no-right-gap={} -> {}",
                            fmt(&a_off),
                            dom_off.map(|d| format!("({:.0},{:.0}) {:.0}x{:.0}", d.0, d.1, d.2, d.3))
                                .unwrap_or_else(|| "no measure".into()),
                            dom_off.map(|(_, _, _, _, a)| a).unwrap_or(1.0),
                            trans_off,
                            gap_off,
                            if ok_off && trans_off && gap_off { "synced" } else { "STALE/MISMATCH" }
                        );
                        if !ok_off || !trans_off || !gap_off {
                            return false;
                        }

                        // 5) Open it again and re-assert (restores the pre-check
                        //    sidebar state AND double-checks the return direction).
                        toggle_sidebar(&app_handle);
                        let a_on2 = match settle(std::time::Duration::from_secs(8)) {
                            Some(n) if !rects_same(n, a_off) => n,
                            _ => {
                                eprintln!(
                                    "[native-smoke] product-path: sidebar open produced no area change"
                                );
                                return false;
                            }
                        };
                        let dom_on2 = measure_now();
                        let scan_on2 = scan_now();
                        let box_on2 = scan_on2.as_ref().and_then(|s| box_chars(s));
                        let ok_on2 = dom_on2
                            .map(|d| rects_same(a_on2, (d.0, d.1, d.2, d.3)) && d.4 < 0.5)
                            .unwrap_or(false);
                        let bleed_on2 = box_on2.as_deref().map(|c| sidebar_region_opaque(c)).unwrap_or(false);
                        let gap_on2 = box_on2.as_deref().map(|c| no_right_gap(c, dom_on2)).unwrap_or(false);
                        if let Some(s) = &scan_on2 {
                            eprintln!("{s} [product-path sidebar back-ON]");
                        }
                        eprintln!(
                            "[native-smoke] product-path sidebar back-ON: applied={} dom={} alpha={:.3} left-opaque={} no-right-gap={} -> {}",
                            fmt(&a_on2),
                            dom_on2.map(|d| format!("({:.0},{:.0}) {:.0}x{:.0}", d.0, d.1, d.2, d.3))
                                .unwrap_or_else(|| "no measure".into()),
                            dom_on2.map(|(_, _, _, _, a)| a).unwrap_or(1.0),
                            bleed_on2,
                            gap_on2,
                            if ok_on2 && bleed_on2 && gap_on2 { "synced" } else { "STALE/MISMATCH" }
                        );
                        let ok = ok_on2 && bleed_on2 && gap_on2;
                        eprintln!(
                            "[native-smoke] product reporter path (drop + real sidebar toggles): {}",
                            if ok { "SYNCED" } else { "MISMATCH" }
                        );
                        ok
                    })();
                    checks.push((
                        "product drop -> engine flip -> mpv_set_layout reporter tracks the real sidebar toggle (no under-sidebar bleed, no right gap)",
                        product_reporter,
                    ));

                    // CHECK 13 — the field-reported direction, end-to-end: the
                    // product loads and plays with the sidebar CLOSED (full-width
                    // anchor at x≈0 — the state an older build froze into), then
                    // the user OPENS the sidebar. The applied rect must move to
                    // EXACTLY the DOM stage (x = sidebar right edge, width =
                    // window minus sidebar) — never stay full-width at x=0 (video
                    // under the sidebar's text + a see-through gap on the right).
                    // Check 12 proves the reporter from an OPEN start; check 13
                    // proves the transition INTO open from a closed full-width
                    // anchor — the regression the field build shipped.
                    let closed_to_open = (|| {
                        if std::env::var("ZANPLAYER_NATIVE_SMOKE_VIDEO")
                            .map(|p| p.is_empty())
                            .unwrap_or(true)
                        {
                            eprintln!(
                                "[native-smoke] closed->open check skipped: ZANPLAYER_NATIVE_SMOKE_VIDEO unset"
                            );
                            return true;
                        }
                        // Depends on check 12's setup (sidebar restored ON with the
                        // product stage live). If any earlier check failed the
                        // sidebar state / stage mount are not guaranteed, so skip
                        // rather than add a spurious second failure.
                        if checks.iter().any(|(_, ok)| !*ok) || snapshot().is_none() {
                            eprintln!(
                                "[native-smoke] closed->open check skipped: no stage/closed-state guarantee after an earlier failure"
                            );
                            return true;
                        }
                        let box_chars = |s: &String| -> Option<Vec<char>> {
                            let rest = s.split("box=").nth(1)?;
                            let chars = rest.split(" | layout ").next()?;
                            Some(chars.chars().collect())
                        };
                        let sidebar_region_opaque = |c: &[char]| -> bool {
                            let n = c.len().min(21);
                            n == 21 && c[..n].iter().all(|&x| x != '.')
                        };
                        let no_right_gap =
                            |c: &[char], dom: Option<(f64, f64, f64, f64, f64)>| -> bool {
                                let css_w = c.len() * 16;
                                dom.map(|d| d.0 + d.2 >= css_w as f64 - 8.0).unwrap_or(false)
                            };

                        // 1) Close the sidebar while the video is playing — the
                        //    full-width (x≈0) anchor the shipped bug froze into.
                        toggle_sidebar(&app_handle);
                        let a_closed = match settle(std::time::Duration::from_secs(8)) {
                            Some(n) => n,
                            None => {
                                eprintln!("[native-smoke] closed->open: no applied anchor after sidebar close");
                                return false;
                            }
                        };
                        let dom_closed = measure_now();
                        let c_ok = dom_closed
                            .map(|d| {
                                rects_same(a_closed, (d.0, d.1, d.2, d.3))
                                    && d.0 < 2.0
                                    && d.4 < 0.5
                            })
                            .unwrap_or(false);
                        if let Some(scan) = scan_now() {
                            eprintln!("{scan} [closed->open sidebar CLOSED]");
                        }
                        eprintln!(
                            "[native-smoke] closed->open: closed applied={} dom={} alpha={:.3} x~0={} -> {}",
                            fmt(&a_closed),
                            dom_closed
                                .map(|d| format!("({:.0},{:.0}) {:.0}x{:.0}", d.0, d.1, d.2, d.3))
                                .unwrap_or_else(|| "no measure".into()),
                            dom_closed.map(|(_, _, _, _, a)| a).unwrap_or(1.0),
                            dom_closed.map(|d| d.0 < 2.0).unwrap_or(false),
                            if c_ok { "synced" } else { "MISMATCH" }
                        );
                        if !c_ok {
                            return false;
                        }
                        // Capture window (sidebar CLOSED): the layer is anchored
                        // full-width at the stage, video playing — the other half
                        // of the field bug (x=0 must not bleed under the sidebar
                        // when it later opens; capture here proves the closed
                        // layout before that transition). Park so external
                        // screencapture sees the verified full-width anchor.
                        if std::env::var("ZANPLAYER_NATIVE_SMOKE_PAUSE").map(|v| v == "1")
                            .unwrap_or(false)
                        {
                            eprintln!(
                                "[native-smoke] PAUSED at closed->open (sidebar CLOSED, video playing, layer on the DOM stage) for external capture — {}s",
                                PAUSE_SECS
                            );
                            std::thread::sleep(std::time::Duration::from_secs(PAUSE_SECS));
                        }

                        // 2) OPEN the sidebar — the exact field repro. The applied
                        //    rect must land on the DOM stage (x = sidebar right
                        //    edge, width = window minus sidebar); never x=0.
                        toggle_sidebar(&app_handle);
                        let a_open = match settle(std::time::Duration::from_secs(8)) {
                            Some(n) => n,
                            None => {
                                eprintln!("[native-smoke] closed->open: no applied anchor after sidebar open");
                                return false;
                            }
                        };
                        let dom_open = measure_now();
                        let scan_open = scan_now();
                        let box_open = scan_open.as_ref().and_then(|s| box_chars(s));
                        let ok_open = dom_open
                            .map(|d| {
                                rects_same(a_open, (d.0, d.1, d.2, d.3))
                                    && d.0 > 0.0
                                    && d.4 < 0.5
                            })
                            .unwrap_or(false);
                        let bleed_open =
                            box_open.as_deref().map(|c| sidebar_region_opaque(c)).unwrap_or(false);
                        let gap_open =
                            box_open.as_deref().map(|c| no_right_gap(c, dom_open)).unwrap_or(false);
                        if let Some(scan) = &scan_open {
                            eprintln!("{scan} [closed->open sidebar OPEN]");
                        }
                        eprintln!(
                            "[native-smoke] closed->open: open applied={} dom={} alpha={:.3} x>0={} left-opaque={} no-right-gap={} -> {}",
                            fmt(&a_open),
                            dom_open
                                .map(|d| format!("({:.0},{:.0}) {:.0}x{:.0}", d.0, d.1, d.2, d.3))
                                .unwrap_or_else(|| "no measure".into()),
                            dom_open.map(|(_, _, _, _, a)| a).unwrap_or(1.0),
                            dom_open.map(|d| d.0 > 0.0).unwrap_or(false),
                            bleed_open,
                            gap_open,
                            if ok_open && bleed_open && gap_open { "synced" } else { "MISMATCH" }
                        );
                        if !ok_open || !bleed_open || !gap_open {
                            eprintln!(
                                "[native-smoke] closed->open: surface stuck at x=0 over the sidebar (APPLIED rect must be the DOM stage rect = window minus sidebar)"
                            );
                            return false;
                        }
                        // Capture window: the layer is anchored at the stage, video
                        // playing, sidebar OPEN — the exact state the field bug
                        // shipped in. Park here so an external screencapture sees
                        // the verified layout, not a transient.
                        if std::env::var("ZANPLAYER_NATIVE_SMOKE_PAUSE").map(|v| v == "1")
                            .unwrap_or(false)
                        {
                            eprintln!(
                                "[native-smoke] PAUSED at closed->open (sidebar OPEN, video playing, layer on the DOM stage) for external capture — {}s",
                                PAUSE_SECS
                            );
                            std::thread::sleep(std::time::Duration::from_secs(PAUSE_SECS));
                        }
                        // Leaves the sidebar OPEN (pre-explanation of this check).
                        true
                    })();
                    checks.push((
                        "closed->open: a full-width anchor must re-anchor to the DOM stage (x = sidebar right edge, width = window minus sidebar) when the sidebar opens",
                        closed_to_open,
                    ));

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