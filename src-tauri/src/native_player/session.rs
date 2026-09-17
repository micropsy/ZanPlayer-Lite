//! Embedded LibVLC (C API) session wired to the main window's native surface.
//!
//! `VlcSession` owns a [`crate::native_player::libvlc::VlcPlayer`] and embeds
//! VLC's video output into a dedicated host view below the transparent webview
//! (macOS: `macos_surface` host NSView via `set_nsobject`; Windows: an HWND via
//! `set_hwnd`; X11: a window id via `set_xwindow`). A 250 ms ticker mirrors
//! time/state to the frontend as coalesced `vlc-timeupdate` snapshots.
//!
//! This is a full replacement for the old libmpv `wid`/Render-API backends:
//! there is only ONE VLC backend and one gate (`vlc-native`).

use crate::native_player::{VlcTimeUpdate, position_clamped, snapshot_changed};
use crate::native_player::libvlc::{STATE_ENDED, STATE_PAUSED, VlcPlayer};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Embedded LibVLC session. Wrap the player in a Mutex: the 250 ms ticker
/// thread reads the clock from one thread while Tauri command handlers (async
/// runtime threads) seek/pause/volume from others — libvlc is thread-safe, but
/// each call still takes the lock so seek/time reads never interleave mid call.
pub struct VlcSession {
    player: Arc<Mutex<VlcPlayer>>,
    ticking: Arc<AtomicBool>,
    /// The native embed target this session draws into (see `embed_surface`).
    /// Re-affixed to every media player because libvlc creates a fresh player
    /// per media; kept as an integer so it is `Send`.
    drawable: i64,
    /// macOS: set once at creation so the ticker can cheaply detect the host
    /// view detaching from the window hierarchy (the VLC analog of the old
    /// `wid` embed gate).
    verified: bool,
}

// SAFETY: libvlc documents its API as thread-safe; the player inner is always
// accessed under the mutex. The session is only ever shared as an `Arc`.
unsafe impl Send for VlcSession {}
unsafe impl Sync for VlcSession {}

impl VlcSession {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let drawable = embed_surface(app)?;
        let verified = {
            #[cfg(target_os = "macos")]
            {
                macos_surface::verify_embedded(app)
            }
            #[cfg(not(target_os = "macos"))]
            {
                true
            }
        };
        if !verified {
            return Err(
                "native embed host is not attached to the window hierarchy — \
                 refusing to run VLC detached"
                    .into(),
            );
        }
        let player = VlcPlayer::new().map_err(|e| format!("libvlc init failed: {e}"))?;
        Ok(Self {
            player: Arc::new(Mutex::new(player)),
            ticking: Arc::new(AtomicBool::new(false)),
            drawable,
            verified,
        })
    }

    /// Learn whether our embed target is (still) attached to a real window.
    /// A detached VLC would be invisible-at-best / floating-window-at-worst;
    /// the frontend watchdog treats a lost embed like any decode failure and
    /// falls back to HTML5.
    pub fn embed_ok(&self) -> bool {
        if !self.verified {
            return false;
        }
        #[cfg(target_os = "macos")]
        {
            // Called from the ticker thread; only reads the cached hierarchy,
            // never mutates it.
            !self.verified || macos_surface::host_still_attached()
        }
        #[cfg(not(target_os = "macos"))]
        {
            true
        }
    }

    /// Block until the current media leaves the NothingSpecial/Opening states or
    /// errors (used by the smoke harness to prove the path actually demuxes).
    pub fn wait_loaded(&self, timeout: Duration) -> bool {
        let player = self.player.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        player.wait_loaded(timeout)
    }

    /// Affix the drawable and start the file. A 250 ms ticker thread mirrors
    /// time/state/pause/EOF to the webview. The ticker runs for the session's
    /// lifetime (until `stop`), so a second `load` never spawns a duplicate.
    pub fn load(&self, app: &AppHandle, path: &str) -> Result<(), String> {
        {
            let mut player =
                self.player.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            player.set_drawable(self.drawable as *mut std::ffi::c_void);
            player.load(path)?;
            // `load` starts the file: `libvlc_media_player_set_media` alone
            // leaves the pipeline in NothingSpecial — the demux/decode path only
            // runs once `play` is issued, which is exactly what the smoke
            // battery (checks 5-7) and the autoplay flow depend on.
            player.play();
        }

        if !self.ticking.swap(true, Ordering::SeqCst) {
            let app = app.clone();
            let player = self.player.clone();
            let ticking = self.ticking.clone();
            std::thread::spawn(move || {
                // Coalesced emission (same contract as the old mpv ticker): a
                // beat only crosses the bridge when the snapshot actually
                // changed, so the webview gets a smooth 250 ms clock while
                // playing but the bridge stays silent when paused/stalled/EOF.
                let mut last_snapshot: Option<VlcTimeUpdate> = None;
                while ticking.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(250));
                    keep_webview_on_top(&app);
                    let snapshot = {
                        let player =
                            player.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                        read_clock(&player)
                    };
                    if snapshot_changed(&last_snapshot, &snapshot) {
                        last_snapshot = Some(snapshot.clone());
                        let _ = app.emit("vlc-timeupdate", snapshot);
                    }
                }
            });
        }

        // VLC attaches its video drawable when the first frame reaches the VOUT,
        // so re-assert the stack right after load, then every ticker beat keeps
        // the transparent webview (DOM chrome) above the decoded frames.
        keep_webview_on_top(app);

        let _ = app.emit("vlc-loaded", ());
        let _ = app.emit("vlc-embed-ok", self.embed_ok());
        Ok(())
    }

    pub fn play(&self) -> Result<(), String> {
        let player = self.player.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // Idempotent: resume only when not already playing (VLC's `play` on an
        // ending/ended media restarts it from the beginning otherwise).
        if !player.is_playing() {
            player.play();
        }
        Ok(())
    }

    pub fn pause(&self) -> Result<(), String> {
        let player = self.player.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // Idempotent: libvlc_media_player_pause TOGGLES play/pause, so only
        // issue it while playing. At EOF (is_playing == false) pausing would
        // rewind and restart the clip — exactly what we must never do from a
        // pause command.
        if player.is_playing() {
            player.pause();
        }
        Ok(())
    }

    pub fn seek(&self, position: f64) -> Result<(), String> {
        let player = self.player.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        player.seek_ms((position * 1000.0).round() as i64);
        Ok(())
    }

    pub fn set_volume(&self, level: f64) -> Result<(), String> {
        let player = self.player.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        player.set_volume(level.round() as i32);
        Ok(())
    }

    pub fn set_speed(&self, speed: f64) -> Result<(), String> {
        let player = self.player.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        player.set_rate(speed as f32);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.ticking.store(false, Ordering::SeqCst);
        let player = self.player.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        player.stop();
        Ok(())
    }

    /// One-shot playback snapshot for the smoke path / debugging.
    #[allow(dead_code)]
    pub fn diagnostics(&self) -> String {
        let player = self.player.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let state = player.state();
        format!(
            "libvlc={} state={} time={:.2}s length={:.2}s playing={} vout={} volume={} rate={}",
            libvlc_version(),
            state_name(state),
            player.time_ms() as f64 / 1000.0,
            player.length_ms() as f64 / 1000.0,
            player.is_playing(),
            player.has_vout(),
            player.get_volume(),
            player.get_rate(),
        )
    }

    /// Time, seconds, when VLC has a media loaded.
    #[allow(dead_code)]
    pub fn time_pos(&self) -> f64 {
        let player = self.player.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        (player.time_ms().max(0) as f64) / 1000.0
    }
}

/// Human name for a libvlc state id.
#[allow(dead_code)]
fn state_name(state: std::ffi::c_int) -> &'static str {
    use crate::native_player::libvlc::*;
    match state {
        STATE_NOTHING_SPECIAL => "nothing-special",
        STATE_OPENING => "opening",
        STATE_BUFFERING => "buffering",
        STATE_PLAYING => "playing",
        STATE_PAUSED => "paused",
        STATE_STOPPED => "stopped",
        STATE_ENDED => "ended",
        STATE_ERROR => "error",
        _ => "unknown",
    }
}

/// libvlc release version (from `libvlc_get_version`).
#[allow(dead_code)]
fn libvlc_version() -> String {
    crate::native_player::libvlc::version()
}

/// Snapshot the live playback state. Reads default gracefully when no media is
/// loaded (`get_time`/`get_length` return -1 => 0).
pub(crate) fn read_clock(player: &VlcPlayer) -> VlcTimeUpdate {
    let duration = (player.length_ms().max(0) as f64) / 1000.0;
    let time_ms = player.time_ms();
    let position = if time_ms < 0 { 0.0 } else { time_ms as f64 / 1000.0 };
    let state = player.state();
    VlcTimeUpdate {
        position: position_clamped(position, duration),
        duration,
        paused: state == STATE_PAUSED || !player.has_media(),
        ended: state == STATE_ENDED,
    }
}

/// A zero surface id means the embed target was never resolved — VLC would
/// fall back to its own detached window instead of embedding. Reject it.
fn ensure_embeddable_surface(surface: i64) -> Result<(), String> {
    if surface == 0 {
        Err("native window surface resolved to 0 — nothing to embed into".into())
    } else {
        Ok(())
    }
}

/// Native surface id for the current embed target:
///   * macOS   -> pointer to the dedicated host NSView
///   * Windows -> HWND
///   * X11     -> window id
///   * Wayland -> unsupported (no client-side video window; HTML5 fallback)
fn window_surface(app: &AppHandle) -> Result<i64, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    let handle = window
        .window_handle()
        .map_err(|e| format!("raw window handle: {e}"))?;
    let surface = match handle.as_raw() {
        RawWindowHandle::AppKit(h) => h.ns_view.as_ptr() as i64,
        RawWindowHandle::Win32(h) => h.hwnd.get() as i64,
        RawWindowHandle::Xlib(h) => h.window as i64,
        other => return Err(format!("unsupported window handle for VLC embedding: {other:?}")),
    };
    ensure_embeddable_surface(surface)?;
    Ok(surface)
}

/// Which native target VLC must draw into:
///   * macOS   -> the dedicated, layer-backed host NSView (NOT the WKWebView:
///     WebKit prunes foreign subviews — the old mpv "floating window" root
///     cause). A sibling under the transparent webview, re-anchored onto the
///     DOM stage by `vlc_set_layout`.
///   * other   -> the raw window surface.
fn embed_surface(app: &AppHandle) -> Result<i64, String> {
    #[cfg(target_os = "macos")]
    {
        let host = macos_surface::host_view(app)?;
        let surface = host as i64;
        ensure_embeddable_surface(surface)?;
        Ok(surface)
    }
    #[cfg(not(target_os = "macos"))]
    {
        window_surface(app)
    }
}

/// Re-anchor the native video surface onto the DOM video stage reported by the
/// frontend (`vlc_set_layout`). Cross-platform dispatch.
pub(crate) fn apply_surface_layout(app: &AppHandle, rect: &super::SurfaceLayout) -> Result<(), String> {
    let rect = *rect;
    #[cfg(debug_assertions)]
    eprintln!(
        "[vlc-set-layout] rect=({:.1},{:.1}) {:.1}x{:.1}",
        rect.x, rect.y, rect.width, rect.height
    );
    #[cfg(target_os = "macos")]
    {
        keep_webview_on_top(app);
        macos_surface::apply_layout(app, rect)
    }
    #[cfg(target_os = "windows")]
    {
        let parent = window_surface(app)?;
        windows_layering::resize_vlc_video_window(parent, rect);
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = window_surface(app)?;
        x11_layering::resize_vlc_window(parent, rect);
        Ok(())
    }
}

/// Clamp a reported stage rect to something embeddable (finite, non-negative,
/// non-degenerate). Any NaN/infinite/negative input collapses safely instead of
/// producing an ill-formed surface.
fn sanitize_surface_layout(rect: super::SurfaceLayout) -> super::SurfaceLayout {
    let clean = |v: f64| v.max(0.0);
    super::SurfaceLayout {
        x: if rect.x.is_finite() { clean(rect.x) } else { 0.0 },
        y: if rect.y.is_finite() { clean(rect.y) } else { 0.0 },
        width: if rect.width.is_finite() {
            clean(rect.width)
        } else {
            0.0
        },
        height: if rect.height.is_finite() {
            clean(rect.height)
        } else {
            0.0
        },
    }
}

/// Runtime gate for the `[vlc-layout]` / `[vlc-set-layout]` diagnostic lines.
/// Debug builds always trace; release builds only when `ZANPLAYER_TRACE` is set.
pub(crate) fn trace_enabled() -> bool {
    static TRACE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *TRACE.get_or_init(|| {
        cfg!(debug_assertions) || std::env::var("ZANPLAYER_TRACE").is_ok()
    })
}

/// macOS embed-surface management. VLC's `set_nsobject` draws into a DEDICATED
/// host NSView we own instead of borrowing one from WebKit (WKWebView prunes
/// foreign subviews — the historical detached/floating-window bug). The host
/// view is created plain, inserted as a sibling BELOW the transparent webview,
/// layer-backed and retina-aware, and re-anchored onto the DOM video stage by
/// `vlc_set_layout`. Anchoring failures fail session creation so the frontend
/// falls back to HTML5 instead of leaking a detached VLC window.
#[cfg(target_os = "macos")]
pub(crate) mod macos_surface {
    use super::{sanitize_surface_layout, trace_enabled, window_surface};
    use crate::native_player::SurfaceLayout;
    use objc2::encode::{Encode, Encoding};
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::sync::Mutex;

    pub const NS_WINDOW_ABOVE: i64 = 1;
    pub const NS_WINDOW_BELOW: i64 = -1;

    /// Raw `*mut AnyObject` that is `Send + Sync`: only ever written while
    /// holding the mutex and read on the main thread / ticker for worst-effort
    /// repinning, so sharing the pointer is safe in this context.
    #[derive(Clone, Copy, Debug)]
    struct ViewPtr(*mut AnyObject);
    // SAFETY: the pointee is retained for the process lifetime and never
    // dereferenced off the main thread; the pointer value is thread-safe.
    unsafe impl Send for ViewPtr {}
    unsafe impl Sync for ViewPtr {}

    #[repr(C)]
    #[derive(Clone, Copy, Debug)]
    pub struct NSPoint {
        pub x: f64,
        pub y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug)]
    pub struct NSSize {
        pub width: f64,
        pub height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug)]
    pub struct NSRect {
        pub origin: NSPoint,
        pub size: NSSize,
    }

    // Objective-C type-encodings so `msg_send!` can marshal these structs by
    // value (ABI for `setFrame:`, `bounds`, ...).
    // SAFETY: sizeof/align of these repr(C) structs match the ObjC layout
    // ({d,d}, {d,d}={x,y},{w,h}, and the composition of the two) exactly.
    unsafe impl Encode for NSPoint {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for NSSize {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for NSRect {
        const ENCODING: Encoding =
            Encoding::Struct("CGRect", &[NSPoint::ENCODING, NSSize::ENCODING]);
    }

    // Cached, deliberately-leaked host view handle. Leaking (never dropped) is
    // intentional: the view must outlive the session because VLC's macosx vout
    // keeps the NSView around, and `msg_send!` needs a stable pointer.
    static HOST_VIEW: Mutex<Option<ViewPtr>> = Mutex::new(None);

    fn cg_size(width: f64, height: f64) -> NSSize {
        NSSize { width, height }
    }

    fn cg_rect(x: f64, y: f64, width: f64, height: f64) -> NSRect {
        NSRect {
            origin: NSPoint { x, y },
            size: cg_size(width, height),
        }
    }

    /// Run an AppKit-touching closure on the main thread. View hierarchy
    /// mutations (`addSubview:`, `setFrame:`, `setNeedsDisplay:`) are
    /// main-thread-only in AppKit; calling them from the session ticker, the
    /// smoke thread, or a Tauri async command handler is undefined behaviour and
    /// segfaults on macOS. If already on the main thread this runs directly;
    /// otherwise the closure is posted to the AppKit main loop and the caller
    /// blocks (bounded) for its result. Only the returned value crosses the
    /// channel — never Objective-C pointers (`*mut AnyObject` is not `Send`) —
    /// so callers transport any touched pointers as `i64` handles instead.
    fn on_main<R, F>(app: &tauri::AppHandle, f: F) -> Result<R, String>
    where
        R: Send + 'static,
        F: FnOnce(&tauri::AppHandle) -> R + Send + 'static,
    {
        unsafe extern "C" {
            fn pthread_main_np() -> i32;
        }
        if unsafe { pthread_main_np() != 0 } {
            return Ok(f(app));
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = tx.send(f(&handle));
        });
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|e| format!("macOS main-thread handoff timed out: {e}"))
    }

    /// The window content view that hosts both the WKWebView and our host view.
    pub fn content_view(app: &tauri::AppHandle) -> Result<*mut AnyObject, String> {
        let surface = window_surface(app)?;
        Ok(surface as *mut AnyObject)
    }

    /// The WKWebView subview of the content view (found once, cached).
    pub(super) fn webview_view(content: *mut AnyObject) -> Result<*mut AnyObject, String> {
        static WEBVIEW: Mutex<Option<ViewPtr>> = Mutex::new(None);
        let mut guard = WEBVIEW.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(view) = *guard {
            if !view.0.is_null() {
                return Ok(view.0);
            }
        }
        unsafe {
            let subviews: *mut AnyObject = msg_send![content, subviews];
            if subviews.is_null() {
                return Err("no subviews to find the webview in".into());
            }
            let count: usize = msg_send![subviews, count];
            for i in 0..count {
                let view: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
                let cls = super::macos_layering::class_name(view);
                if cls.contains("wry_web_view") || cls.contains("WKWebView") {
                    *guard = Some(ViewPtr(view));
                    return Ok(view);
                }
            }
        }
        Err("WKWebView not found under the window content view".into())
    }

    /// The dedicated, Rust-owned host NSView VLC embeds into
    /// (`libvlc_media_player_set_nsobject`). Created lazily once per process;
    /// leaked deliberately (it lives for the app's lifetime). Layer-backed and
    /// retina-scaled, inserted below the WKWebView so DOM chrome stays above.
    pub fn host_view(app: &tauri::AppHandle) -> Result<*mut AnyObject, String> {
        // AppKit alloy: creating/inserting the host view (`new`, `addSubview:`,
        // `setWantsLayer:`, `setFrame:`) is main-thread-only. Callers reach this
        // from the smoke thread, the session ticker, and async Tauri commands,
        // so marshal the creation itself onto the AppKit main loop; the pointer
        // is transported as an opaque i64 handle (raw ObjC pointers are not
        // `Send` and must never cross the channel).
        let handle = on_main(app, |app| host_view_impl(app).map(|v| v as i64))??;
        Ok(handle as *mut AnyObject)
    }

    /// (main-thread-only body of `host_view` — never call off the main thread)
    fn host_view_impl(app: &tauri::AppHandle) -> Result<*mut AnyObject, String> {
        let mut guard = HOST_VIEW.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(view) = *guard {
            if !view.0.is_null() {
                return Ok(view.0);
            }
        }
        let content = content_view(app)?;
        unsafe {
            let ns_view_class = AnyClass::get(c"NSView")
                .ok_or("NSView class not registered with the Objective-C runtime")?;
            let host: *mut AnyObject = msg_send![ns_view_class, new];
            if host.is_null() {
                return Err("failed to allocate the native host view".into());
            }
            // Layer-backing is a hard requirement: VLC's macosx video output
            // refuses to draw into non-layer-backed views.
            let yes: i8 = 1;
            let _: () = msg_send![host, setWantsLayer: yes];
            if let Ok(webview) = webview_view(content) {
                let _: () = msg_send![
                    content,
                    addSubview: host,
                    positioned: NS_WINDOW_BELOW,
                    relativeTo: webview
                ];
            } else {
                let _: () = msg_send![content, addSubview: host];
            }
            // Retina: keep the backing layer's contentsScale on the window's
            // backing scale factor so the decoded picture is native-res.
            let layer: *mut AnyObject = msg_send![host, layer];
            if !layer.is_null() {
                let window: *mut AnyObject = msg_send![content, window];
                if !window.is_null() {
                    let scale: f64 = msg_send![window, backingScaleFactor];
                    if scale > 0.0 {
                        let _: () = msg_send![layer, setContentsScale: scale];
                    }
                }
            }
            // VLC's vout needs a real sized embed target at `set_nsobject` time;
            // stretch to the content area now — the layout reporter re-anchors
            // it exactly onto the DOM stage right after.
            let initial_frame: NSRect = msg_send![content, bounds];
            let _: () = msg_send![host, setFrame: initial_frame];
            *guard = Some(ViewPtr(host));
            Ok(host)
        }
    }

    /// True when the host view is still attached to a real window and covers a
    /// non-degenerate region — the precondition that makes an embedded (never
    /// detached) VLC. Checked before init so a broken anchor fails the session.
    pub fn verify_embedded(app: &tauri::AppHandle) -> bool {
        on_main(app, verify_embedded_impl).unwrap_or(false)
    }

    /// (main-thread-only body of `verify_embedded`)
    fn verify_embedded_impl(app: &tauri::AppHandle) -> bool {
        let host = match host_view_impl(app) {
            Ok(host) => host,
            Err(_) => return false,
        };
        unsafe {
            let superview: *mut AnyObject = msg_send![host, superview];
            let window: *mut AnyObject = msg_send![host, window];
            if superview.is_null() || window.is_null() {
                return false;
            }
            let frame: NSRect = msg_send![host, frame];
            frame.size.width > 0.0 && frame.size.height > 0.0
        }
    }

    /// Cheap, lock-free check used by the ticker thread (must NOT touch the
    /// view hierarchy off the main thread — this only reads cached state that
    /// was captured before the session existed).
    pub fn host_still_attached() -> bool {
        let guard = HOST_VIEW.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.map(|v| !v.0.is_null()).unwrap_or(false)
    }

    /// Read back where the host view ACTUALLY ended up, expressed in the same
    /// webview-local top-left CSS-px space as the DOM rect (inverse of
    /// `apply_layout`). Used by the smoke harness to assert the rendered frame
    /// — not the requested rect — matches the DOM stage.
    pub fn applied_js_rect(app: &tauri::AppHandle) -> Result<(f64, f64, f64, f64), String> {
        on_main(app, applied_js_rect_impl)?
    }

    /// (main-thread-only body of `applied_js_rect`)
    fn applied_js_rect_impl(app: &tauri::AppHandle) -> Result<(f64, f64, f64, f64), String> {
        let content = content_view(app)?;
        let host = host_view_impl(app)?;
        let webview = webview_view(content)?;
        unsafe {
            let bounds: NSRect = msg_send![webview, bounds];
            let webview_frame: NSRect = msg_send![webview, frame];
            let frame: NSRect = msg_send![host, frame];
            let x = frame.origin.x - webview_frame.origin.x;
            let y = (webview_frame.origin.y + bounds.size.height) - (frame.origin.y + frame.size.height);
            Ok((x, y, frame.size.width, frame.size.height))
        }
    }

    /// Re-frame the host NSView onto the DOM stage rect (CSS pixels, relative to
    /// the webview content area, top-left origin). The rect is converted from
    /// webview-local points into content-view coordinates via AppKit-like math:
    ///
    /// **X-origin sidebar invariant**: when the sidebar is inline (desktop
    /// open), the DOM-reported `rect.x` equals the sidebar's right edge. The
    /// host view's X-origin must match this value exactly so the native layer
    /// never bleeds under or over the sidebar. `rect.x` (the CSS-px offset from
    /// the webview origin) is passed through faithfully; Y is flipped for the
    /// content view's bottom-left origin.
    pub fn apply_layout(app: &tauri::AppHandle, rect: SurfaceLayout) -> Result<(), String> {
        on_main(app, move |app| apply_layout_impl(app, rect))?
    }

    /// (main-thread-only body of `apply_layout`)
    fn apply_layout_impl(app: &tauri::AppHandle, rect: SurfaceLayout) -> Result<(), String> {
        let rect = sanitize_surface_layout(rect);
        // A degenerate or not-yet-laid-out stage must never move the surface to
        // (0,0)/zero size (the "video stuck at the top-left" symptom): keep the
        // last good anchor instead.
        if rect.width < 1.0 || rect.height < 1.0 {
            return Ok(());
        }
        let content = content_view(app)?;
        let host = host_view_impl(app)?;
        let webview = webview_view(content)?;
        unsafe {
            let bounds: NSRect = msg_send![webview, bounds];
            if bounds.size.width <= 0.0 || bounds.size.height <= 0.0 {
                return Ok(()); // not laid out yet — nothing meaningful to anchor to
            }
            let clamp = |v: f64, max: f64| v.max(0.0).min(max);
            let x = clamp(rect.x, bounds.size.width - 1.0);
            let y_css = clamp(rect.y, bounds.size.height - 1.0);
            let w = clamp(rect.width, bounds.size.width - x);
            let h = clamp(rect.height, bounds.size.height - y_css);
            let webview_frame: NSRect = msg_send![webview, frame];
            // Content-view coords computed directly (the webview and host are
            // unflipped siblings): CSS top-left -> content bottom-left flip.
            let expected_x = webview_frame.origin.x + rect.x;
            let frame_in_content = cg_rect(
                expected_x.clamp(0.0, f64::MAX),
                webview_frame.origin.y + (bounds.size.height - (y_css + h)),
                w,
                h,
            );
            // X-ORIGIN INVARIANT (sidebar inline): re-anchor X directly to the
            // CSS rect origin so the host view starts exactly at the sidebar's
            // right edge even if the webview frame was repositioned.
            if trace_enabled() {
                eprintln!(
                    "[vlc-layout] js=({:.0},{:.0}) {:.0}x{:.0} webview={:.0}x{:.0}@({:.0},{:.0}) -> content=({:.1},{:.1}) {:.1}x{:.1}",
                    rect.x,
                    rect.y,
                    rect.width,
                    rect.height,
                    bounds.size.width,
                    bounds.size.height,
                    webview_frame.origin.x,
                    webview_frame.origin.y,
                    frame_in_content.origin.x,
                    frame_in_content.origin.y,
                    frame_in_content.size.width,
                    frame_in_content.size.height
                );
            }
            let _: () = msg_send![host, setFrame: frame_in_content];
            let _: () = msg_send![host, setNeedsDisplay: 1i8];
            let _: () = msg_send![content, setNeedsLayout: 1i8];
        }
        Ok(())
    }
}

/// Keep the transparent webview (DOM chrome: captions/OSD/controls) above the
/// VLC video surface. VLC's embed never re-parents our host view on macOS and
/// never eats into the webview's own stacking on Windows/X11 (it draws INSIDE a
/// pinned child), but this re-asserts the stack on every ticker beat anyway.
///   * macOS   -> NSView re-sort (macos_layering)
///   * Windows -> SetWindowPos: pin VLC's "VLC"-class video HWND to the bottom
///   * X11     -> raise the webview X window above VLC's child (x11_layering)
///   * Wayland -> no client-side z-order; compositor-owned, no back-end
#[cfg(target_os = "macos")]
pub(crate) fn keep_webview_on_top(app: &AppHandle) {
    macos_layering::keep_webview_on_top(app);
}

#[cfg(target_os = "windows")]
fn keep_webview_on_top(app: &AppHandle) {
    windows_layering::keep_webview_on_top(app);
}

#[cfg(all(unix, not(target_os = "macos")))]
fn keep_webview_on_top(app: &AppHandle) {
    x11_layering::keep_webview_on_top(app);
}

/// macOS layering: VLC draws into the dedicated host view (below the webview),
/// so the only stacking concern is keeping that host pinned UNDER the WKWebView.
#[cfg(target_os = "macos")]
pub(crate) mod macos_layering {
    use super::macos_surface;
    use objc2::ffi::object_getClassName;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use std::ffi::CStr;

    const NS_WINDOW_ABOVE: i64 = macos_surface::NS_WINDOW_ABOVE;
    const NS_WINDOW_BELOW: i64 = macos_surface::NS_WINDOW_BELOW;

    /// Re-assert the stacking contract: the VLC host view stays at the bottom
    /// of the content view; the WKWebView stays at the top. Harmless no-op when
    /// the host view is not created yet; the ticker re-runs it so late
    /// insertions are covered too.
    ///
    /// Runs on the main thread only: every NSView order mutation below is
    /// AppKit-main-thread-only, and the 250 ms ticker thread that drives this
    /// must never touch the hierarchy directly — `apply_layout` reads the very
    /// same `webview_frame` on the main thread, so a background `setFrame:`
    /// would be a data race. The whole repin is posted to the run loop.
    pub fn keep_webview_on_top(app: &tauri::AppHandle) {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            let content = match macos_surface::content_view(&app) {
                Ok(content) => content,
                Err(_) => return,
            };
            // Keep the repin itself stack-only: it never touches the webview's
            // frame (apply_layout owns positioning).
            let _ = repin(content, &app);
        });
    }

    /// Move the host view to the bottom of the content view and the WKWebView
    /// to the top. `addSubview:positioned:relativeTo:` with a nil sibling
    /// inserts at the very back or very front without reparenting.
    ///
    /// Deliberately does NOT touch the webview's frame. `apply_layout` already
    /// re-anchors the host to the DOM-measured rect; z-order only here.
    fn repin(content: *mut AnyObject, app: &tauri::AppHandle) -> bool {
        let host = match macos_surface::host_view(app) {
            Ok(host) => host,
            Err(_) => return false,
        };
        unsafe {
            let nil: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![content, addSubview: host, positioned: NS_WINDOW_BELOW, relativeTo: nil];
            match super::macos_surface::webview_view(content) {
                Ok(webview) => {
                    let _: () = msg_send![
                        content,
                        addSubview: webview,
                        positioned: NS_WINDOW_ABOVE,
                        relativeTo: nil
                    ];
                    true
                }
                Err(_) => false,
            }
        }
    }

    pub(super) fn class_name(view: *mut AnyObject) -> String {
        let name = unsafe { object_getClassName(view) };
        if name.is_null() {
            return String::new();
        }
        unsafe { CStr::from_ptr(name).to_string_lossy().into_owned() }
    }
}

/// Windows z-order: libvlc's `set_hwnd` embed creates its video child window
/// (window class `VLC`) as a child of the top-level HWND — created after
/// WebView2, so it can land on top of the webview. Every sweep finds that child
/// and drops it to the bottom of the sibling stack. Best-effort: if VLC hasn't
/// created its child yet this is a no-op that re-runs on the next sweep.
#[cfg(target_os = "windows")]
mod windows_layering {
    use super::{sanitize_surface_layout, window_surface};
    use crate::native_player::SurfaceLayout;
    use tauri::AppHandle;
    use windows_sys::Win32::Foundation::{BOOL, HWND};
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, SetWindowPos, HWND_BOTTOM, HWND_TOP, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    };

    fn is_vlc_video_window(hwnd: HWND) -> bool {
        let mut class = [0u16; 256];
        let len = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
        len > 0 && String::from_utf16_lossy(&class[..len as usize]) == "VLC"
    }

    unsafe extern "system" fn collect_child(hwnd: HWND, lparam: isize) -> BOOL {
        let children = &mut *(lparam as *mut Vec<HWND>);
        children.push(hwnd);
        1
    }

    fn lower_vlc_video_window(parent: i64) -> bool {
        let parent = parent as isize as HWND;
        let mut children: Vec<HWND> = Vec::new();
        unsafe {
            EnumChildWindows(
                parent,
                Some(collect_child),
                &mut children as *mut Vec<HWND> as isize,
            );
        }
        let mut moved = false;
        for hwnd in children {
            if is_vlc_video_window(hwnd) {
                unsafe {
                    SetWindowPos(
                        hwnd,
                        HWND_BOTTOM,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
                moved = true;
            }
        }
        moved
    }

    pub fn keep_webview_on_top(app: &AppHandle) {
        if let Ok(surface) = window_surface(app) {
            let _ = lower_vlc_video_window(surface);
        }
    }

    /// Re-size/re-position VLC's embedded child window onto the DOM video stage
    /// (`vlc_set_layout`). CSS px are scaled to physical px using the window's
    /// DPI; the y-axis is already top-down on Windows, matching
    /// `getBoundingClientRect`.
    pub fn resize_vlc_video_window(parent: i64, rect: SurfaceLayout) -> bool {
        let rect = sanitize_surface_layout(rect);
        let parent = parent as isize as HWND;
        let scale = unsafe { GetDpiForWindow(parent) } as f64 / 96.0;
        let mut children: Vec<HWND> = Vec::new();
        unsafe {
            EnumChildWindows(
                parent,
                Some(collect_child),
                &mut children as *mut Vec<HWND> as isize,
            );
        }
        let (px, py, pw, ph) = (
            (rect.x * scale) as i32,
            (rect.y * scale) as i32,
            (rect.width * scale).max(0.0) as i32,
            (rect.height * scale).max(0.0) as i32,
        );
        for hwnd in children {
            if is_vlc_video_window(hwnd) {
                unsafe {
                    SetWindowPos(
                        hwnd,
                        HWND_TOP,
                        px,
                        py,
                        pw,
                        ph,
                        SWP_NOZORDER | SWP_NOACTIVATE,
                    );
                }
                return true;
            }
        }
        false
    }
}

/// X11 layering (best effort): libvlc's `set_xwindow` embed creates its video
/// as a child X window of the same parent as the webview. We cache the
/// webview's XID (the single child observed before VLC attaches) and on every
/// sweep re-raise it above VLC's child with ConfigureWindow/StackMode::Above.
///
/// Wayland compositors own stacking and ignore client-side re-order requests,
/// so there is deliberately no Wayland back-end.
#[cfg(all(unix, not(target_os = "macos")))]
mod x11_layering {
    use super::{sanitize_surface_layout, window_surface};
    use crate::native_player::SurfaceLayout;
    use std::sync::Mutex;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConfigureWindowAux, ConnectionExt, StackMode};
    use x11rb::rust_connection::RustConnection;

    struct LayeringState {
        conn: Option<RustConnection>,
        webview: Option<u32>,
    }

    static STATE: Mutex<Option<LayeringState>> = Mutex::new(None);

    fn rake_webview_above_vlc(parent: i64) -> bool {
        let parent = parent as u32;
        let mut guard = STATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let state = guard.get_or_insert_with(|| LayeringState {
            conn: None,
            webview: None,
        });
        if state.conn.is_none() {
            match x11rb::connect(None) {
                Ok((conn, _)) => state.conn = Some(conn),
                Err(_) => return false,
            }
        }
        let conn = match state.conn.as_ref() {
            Some(conn) => conn,
            None => return false,
        };
        let children = match conn.query_tree(parent) {
            Ok(cookie) => match cookie.reply() {
                Ok(rep) => rep.children,
                Err(_) => return false,
            },
            Err(_) => return false,
        };
        if state.webview.is_none() {
            if let Some(&first) = children.first() {
                state.webview = Some(first);
            }
        }
        let Some(webview) = state.webview else { return false };
        if children.len() < 2 || children.last().copied() == Some(webview) {
            return false;
        }
        let raised = conn.configure_window(
            webview,
            &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
        );
        match raised {
            Ok(cookie) => cookie.check().is_ok() && conn.flush().is_ok(),
            Err(_) => false,
        }
    }

    pub fn keep_webview_on_top(app: &AppHandle) {
        if let Ok(surface) = window_surface(app) {
            let _ = rake_webview_above_vlc(surface);
        }
    }

    /// Re-size/re-position VLC's embedded child window onto the DOM video stage
    /// (`vlc_set_layout`). The VLC child is the top-most child (the one that is
    /// not the cached webview); CSS px are scaled to X pixels from the screen's
    /// physical geometry. Best-effort, like every X11 arm here.
    pub fn resize_vlc_window(parent: i64, rect: SurfaceLayout) -> bool {
        let rect = sanitize_surface_layout(rect);
        let parent = parent as u32;
        let mut guard = STATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let state = guard.get_or_insert_with(|| LayeringState {
            conn: None,
            webview: None,
        });
        if state.conn.is_none() {
            match x11rb::connect(None) {
                Ok((conn, _)) => state.conn = Some(conn),
                Err(_) => return false,
            }
        }
        let conn = match state.conn.as_ref() {
            Some(conn) => conn,
            None => return false,
        };
        let children = match conn.query_tree(parent) {
            Ok(cookie) => match cookie.reply() {
                Ok(rep) => rep.children,
                Err(_) => return false,
            },
            Err(_) => return false,
        };
        let mut target = None;
        for &child in children.iter().rev() {
            if state.webview != Some(child) {
                target = Some(child);
                break;
            }
        }
        let Some(target) = target else { return false };
        let scale = conn
            .setup()
            .roots
            .first()
            .map(|root| {
                let px = root.width_in_pixels.max(1) as f64;
                let mm = root.width_in_millimeters.max(1) as f64;
                (px / mm) * 25.4 / 96.0
            })
            .unwrap_or(1.0);
        let (px, py, pw, ph) = (
            (rect.x * scale) as i32,
            (rect.y * scale) as i32,
            (rect.width * scale).max(0.0) as u32,
            (rect.height * scale).max(0.0) as u32,
        );
        let resized = conn.configure_window(
            target,
            &ConfigureWindowAux::new()
                .x(px)
                .y(py)
                .width(Some(pw))
                .height(Some(ph)),
        );
        match resized {
            Ok(cookie) => cookie.check().is_ok() && conn.flush().is_ok(),
            Err(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_player::{VlcTimeUpdate, position_clamped, snapshot_changed};

    #[test]
    fn zero_surface_is_rejected_before_vlc_init() {
        assert_eq!(
            ensure_embeddable_surface(0).unwrap_err(),
            "native window surface resolved to 0 — nothing to embed into"
        );
        assert!(ensure_embeddable_surface(0x007fff_abcdef).is_ok());
    }

    #[test]
    fn stage_layout_is_sanitized_before_anchoring() {
        let clean = |r: crate::native_player::SurfaceLayout| sanitize_surface_layout(r);
        let normal = clean(crate::native_player::SurfaceLayout {
            x: 10.0,
            y: 20.0,
            width: 300.0,
            height: 200.0,
        });
        assert_eq!((normal.x, normal.y, normal.width, normal.height), (10.0, 20.0, 300.0, 200.0));
        let negative = clean(crate::native_player::SurfaceLayout {
            x: -12.0,
            y: -8.0,
            width: -50.0,
            height: -50.0,
        });
        assert_eq!(
            (negative.x, negative.y, negative.width, negative.height),
            (0.0, 0.0, 0.0, 0.0)
        );
        let nan = clean(crate::native_player::SurfaceLayout {
            x: f64::NAN,
            y: 10.0,
            width: f64::INFINITY,
            height: f64::NEG_INFINITY,
        });
        assert_eq!((nan.x, nan.y, nan.width, nan.height), (0.0, 10.0, 0.0, 0.0));
    }

    #[test]
    fn read_clock_defaults_before_a_file_is_loaded() {
        let update = VlcTimeUpdate {
            position: 0.0,
            duration: 0.0,
            paused: true,
            ended: false,
        };
        let json = serde_json::to_string(&update).unwrap();
        assert!(json.contains("\"position\":0.0"));
        assert!(json.contains("\"ended\":false"));
    }

    #[test]
    fn position_never_exceeds_the_known_duration() {
        assert_eq!(position_clamped(120.0, 100.0), 100.0);
        assert_eq!(position_clamped(50.0, 100.0), 50.0);
        assert_eq!(position_clamped(-4.0, 100.0), 0.0);
        assert_eq!(position_clamped(30.0, 0.0), 30.0);
        assert_eq!(position_clamped(-2.0, 0.0), 0.0);
    }

    #[test]
    fn ticker_emits_on_change_and_coalesces_noop_beats() {
        let base = VlcTimeUpdate {
            position: 10.0,
            duration: 100.0,
            paused: false,
            ended: false,
        };
        assert!(snapshot_changed(&None, &base));
        let same = VlcTimeUpdate {
            position: 10.03,
            ..base.clone()
        };
        assert!(!snapshot_changed(&Some(base.clone()), &same));
        let moved = VlcTimeUpdate {
            position: 10.2,
            ..base.clone()
        };
        assert!(snapshot_changed(&Some(base.clone()), &moved));
        let paused = VlcTimeUpdate {
            position: 10.03,
            paused: true,
            ..base.clone()
        };
        assert!(snapshot_changed(&Some(base.clone()), &paused));
        let seek_back = VlcTimeUpdate {
            position: 5.0,
            ..base.clone()
        };
        assert!(snapshot_changed(&Some(base), &seek_back));
    }

    #[test]
    fn windows_handle_is_readable_on_non_windows() {
        #[cfg(windows)]
        {
            let _ = std::mem::size_of::<raw_window_handle::Win32WindowHandle>();
        }
        #[cfg(not(windows))]
        {
            let _ = std::mem::size_of::<raw_window_handle::AppKitWindowHandle>();
        }
    }
}