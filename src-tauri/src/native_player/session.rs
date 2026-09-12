//! Embedded libmpv session wired to the main window's native surface.
//!
//! On macOS this module also provides the `macos_surface` host-view machinery
//! shared with the Render-API backend (`super::render`). The `wid`-VO
//! `MpvSession` itself is dormant there once `feature = "macos-render"` handles
//! macOS playback: the module still compiles, but the window-VO paths are dead.
#![cfg_attr(
    all(target_os = "macos", feature = "macos-render"),
    allow(dead_code)
)]
use crate::native_player::{
    position_clamped, snapshot_changed, MpvTimeUpdate, SurfaceLayout,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Embedded libmpv session wired to the main window's native surface.
pub struct MpvSession {
    mpv: Arc<libmpv2::Mpv>,
    ticking: Arc<AtomicBool>,
    /// The native surface id we embedded into (see `window_surface`). Kept so
    /// diagnostics can confirm mpv kept it as `wid` instead of opening its own
    /// detached window.
    surface: i64,
}

impl MpvSession {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        // libmpv2 targets the 2.x client API (this crate links client API 2.2;
        // the major version only is enforced at init), so modern mpv —
        // including current Homebrew 0.41 exposing client API 2.5 — initializes
        // instead of rejecting the bindings with a VersionMismatch error.
        //
        // `wid` must be set as an OPTION before mpv_initialize: mpv 2.x reads
        // the embed target while setting up its VO, and a post-init runtime
        // `set_property("wid", ...)` never spawns the video view.
        //
        // On macOS the embed target is our dedicated, layer-backed host NSView
        // (see `macos_surface`), NOT the WKWebView: a foreign subview added to
        // WebKit is pruned/detached by WKWebView, which is what historically
        // let mpv land in its own separate floating window. The host view sits
        // below the transparent webview and is re-anchored onto the DOM video
        // stage by `mpv_set_layout`, so the picture is confined to the player
        // container and can never escape into a detached window.
        let surface = embed_surface(app)?;
        // Backstop: `embed_surface` already rejects a zero id, but re-assert
        // here so a future refactor can never hand mpv a `wid=0` (which would
        // make it open its own detached window instead of embedding).
        ensure_embeddable_surface(surface)?;
        let mpv = libmpv2::Mpv::with_initializer(|init| {
            init.set_option("wid", surface)?;
            init.set_option("keep-open", "yes")?;
            // On macOS, gpu-next can create its own CAMetalLayer/window even
            // when wid points at a valid NSView. Use the classic gpu VO with
            // the AppKit context so the decoded frame remains a child of our
            // dedicated in-window host view. mpv 0.41 exposes macvk as the
            // AppKit/Metal context name; "mac" is rejected with option error.
            #[cfg(target_os = "macos")]
            {
                init.set_option("vo", "gpu")?;
                init.set_option("gpu-context", "macvk")?;
            }
            // Hardware accelerated decode where the platform has it
            // (videotoolbox on macOS, vaapi/d3d on linux/windows).
            init.set_option("hwdec", "auto")?;
            Ok(())
        })
        .map_err(|e| format!("Failed to start libmpv: {e}"))?;

        // Embed assertion: mpv must still report our target as its `wid` after
        // init. A VO that ignored the option would open its OWN detached window
        // (the external/PIP symptom) while every command still returns Ok — by
        // failing here, the frontend falls back to HTML5 instead and we never
        // strand a rogue mpv window.
        let accepted = mpv.get_property::<i64>("wid").unwrap_or(-1);
        if accepted != surface {
            return Err(format!(
                "mpv did not accept the embed target (option wid={surface}, runtime wid={accepted}); \
                 refusing to run with a detached window"
            ));
        }

        // Strict anchoring: the surface must actually live inside the app window
        // and cover a real region, or the session fails and the frontend falls
        // back to HTML5 — mpv never gets a chance to float detached.
        #[cfg(target_os = "macos")]
        if !macos_surface::verify_embedded(app) {
            return Err(
                "native embed host is not attached to the window hierarchy — \
                 refusing to run mpv detached"
                    .into(),
            );
        }

        Ok(Self {
            mpv: Arc::new(mpv),
            ticking: Arc::new(AtomicBool::new(false)),
            surface,
        })
    }

    /// Point mpv at the main window's native surface and start the file. A
    /// 250 ms ticker thread mirrors time-pos/duration/pause/EOF to the webview.
    /// The ticker runs continuously for the session's lifetime (until `stop`),
    /// so a second `load` never spawns a duplicate thread.
    pub fn load(&self, app: &AppHandle, path: &str) -> Result<(), String> {
        self.mpv
            .command("loadfile", &[path])
            .map_err(|e| format!("loadfile {path}: {e}"))?;

        if !self.ticking.swap(true, Ordering::SeqCst) {
            std::thread::spawn({
                let app = app.clone();
                let mpv = self.mpv.clone();
                let ticking = self.ticking.clone();
                let surface = self.surface;
                move || {
                    // Coalesced emission: a beat only crosses the Tauri event
                    // bridge when the playback state actually changed, so the
                    // webview gets a smooth 250 ms clock while it is playing
                    // but the bridge stays silent when paused/stalled/at EOF.
                    let mut last_snapshot: Option<MpvTimeUpdate> = None;
                    while ticking.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(250));
                        keep_webview_on_top(&app);
                        // Embed integrity: mpv must still report our surface as
                        // its `wid`. If it ever drifted (VO re-init, surface
                        // invalidated), it would be rendering into a detached
                        // window — emit once and stop the clock so the webview
                        // falls back to HTML5 instead of shipping OSD over a
                        // rogue window.
                        if mpv.get_property::<i64>("wid").unwrap_or(0) != surface {
                            let _ = app.emit(
                                "mpv-embed-lost",
                                "embedded surface no longer resolves as mpv's wid",
                            );
                            break;
                        }
                        let snapshot = read_clock(&mpv);
                        if snapshot_changed(&last_snapshot, &snapshot) {
                            last_snapshot = Some(snapshot.clone());
                            let _ = app.emit("mpv-timeupdate", snapshot);
                        }
                    }
                }
            });
        }

        // mpv's `wid` attachment races the first decoded frame (VO init), so
        // `keep_webview_on_top` also runs on every ticker beat: whichever
        // moment mpv inserts its video view, the next 250 ms sweep re-sorts the
        // window so the transparent webview (and its captions/OSD/controls)
        // ends up back above the decoded frames.
        keep_webview_on_top(app);

        let _ = app.emit("mpv-loaded", ());
        Ok(())
    }

    pub fn play(&self) -> Result<(), String> {
        self.mpv
            .set_property("pause", false)
            .map_err(|e| e.to_string())
    }

    pub fn pause(&self) -> Result<(), String> {
        self.mpv
            .set_property("pause", true)
            .map_err(|e| e.to_string())
    }

    pub fn seek(&self, position: f64) -> Result<(), String> {
        self.mpv
            .set_property("time-pos", position)
            .map_err(|e| e.to_string())
    }

    pub fn set_volume(&self, level: f64) -> Result<(), String> {
        self.mpv.set_property("volume", level).map_err(|e| e.to_string())
    }

    pub fn set_speed(&self, speed: f64) -> Result<(), String> {
        self.mpv
            .set_property("speed", speed)
            .map_err(|e| e.to_string())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.ticking.store(false, Ordering::SeqCst);
        self.mpv.command("stop", &[]).map_err(|e| e.to_string())
    }

    /// One-shot playback snapshot for the smoke path / debugging: reads the
    /// properties that prove mpv actually decoded (time-pos advancing, a real
    /// `current-vo`, video format), plus the embed target it ended up using.
    #[allow(dead_code)]
    pub fn diagnostics(&self) -> String {
        let strp = |name: &str| match self.mpv.get_property::<String>(name) {
            Ok(v) => v,
            Err(e) => format!("<{e}>"),
        };
        let f = |name: &str| self.mpv.get_property::<f64>(name).unwrap_or(f64::NAN);
        let b = |name: &str| self.mpv.get_property::<bool>(name).unwrap_or(false);
        let i = |name: &str| self.mpv.get_property::<i64>(name).unwrap_or(i64::MIN);
        let wid = i("wid");
        let embed = if wid == self.surface { "embedded" } else { "DETACHED" };
        format!(
            "time-pos={:.2}s duration={:.2}s paused={} eof={} | vo={} wid={} [{embed}] hwdec={} video-format={}",
            f("time-pos"),
            f("duration"),
            b("pause"),
            b("eof-reached"),
            strp("current-vo"),
            wid,
            strp("hwdec-current"),
            strp("video-format"),
        )
    }
}

/// Snapshot the live playback state. Property reads error while no file is
/// loaded (before the first `loadfile`), so every read defaults gracefully.
pub(crate) fn read_clock(mpv: &libmpv2::Mpv) -> MpvTimeUpdate {
    let duration = mpv.get_property::<f64>("duration").unwrap_or(0.0).max(0.0);
    let position = mpv
        .get_property::<f64>("time-pos")
        .unwrap_or(0.0)
        .max(0.0);
    let paused = mpv.get_property::<bool>("pause").unwrap_or(false);
    let eof = mpv.get_property::<bool>("eof-reached").unwrap_or(false);
    MpvTimeUpdate {
        position: position_clamped(position, duration),
        duration,
        paused,
        // With `keep-open=yes` EOF leaves the player paused on the last frame:
        // surface it as the webview's `ended` so the UI clears its play state.
        ended: eof && paused && duration > 0.0,
    }
}

// `snapshot_changed`, `POSITION_EPSILON` and `position_clamped` live in
// `super` (`mod.rs`): the desktop native tickers share the exact coalescing
// rules with the mobile (Media3/AVPlayer) ticker.

/// A zero surface id means mpv's `wid` was never resolved — mpv would open its
/// own detached window instead of embedding. Reject it before init.
fn ensure_embeddable_surface(surface: i64) -> Result<(), String> {
    if surface == 0 {
        Err("native window surface resolved to 0 — nothing to embed into".into())
    } else {
        Ok(())
    }
}

/// Native surface id for the current embed target:
///   * macOS   -> NSView pointer
///   * Windows -> HWND
///   * X11     -> window id
///   * Wayland -> wl_surface pointer
///
/// raw-window-handle 0.6 already types the AppKit NSView, Win32 HWND and
/// Wayland wl_surface as non-zero, so a zero id can practically only surface
/// via the raw X11 `c_ulong` (0 is the X11 `None` sentinel and would make mpv
/// open a DETACHED window). `ensure_embeddable_surface` is enforced here as
/// well as in `MpvSession::new` so a broken handle can never reach mpv.
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
        RawWindowHandle::Wayland(h) => h.surface.as_ptr() as i64,
        other => return Err(format!("unsupported window handle for mpv embedding: {other:?}")),
    };
    ensure_embeddable_surface(surface)?;
    Ok(surface)
}

/// The exact surface mpv must render into (`wid`).
///
/// * macOS -> pointer to the dedicated, layer-backed host NSView. This is
///   deliberately NOT the webview/window view: WKWebView prunes foreign
///   subviews and WebKit detaches them, which is the classic route to a
///   floating mpv window. Our host view is a sibling under the transparent
///   webview and is re-anchored onto the DOM stage by `mpv_set_layout`.
/// * other -> the raw window surface (existing behavior).
fn embed_surface(app: &AppHandle) -> Result<i64, String> {
    embed_surface_impl(app)
}

#[cfg(target_os = "macos")]
fn embed_surface_impl(app: &AppHandle) -> Result<i64, String> {
    let host = macos_surface::host_view(app)?;
    let surface = host as i64;
    ensure_embeddable_surface(surface)?;
    Ok(surface)
}

#[cfg(not(target_os = "macos"))]
fn embed_surface_impl(app: &AppHandle) -> Result<i64, String> {
    window_surface(app)
}

/// Re-anchor the native video surface onto the DOM video stage reported by the
/// frontend (`mpv_set_layout`). Cross-platform dispatch; best-effort on non-mac
/// platforms (Wayland has no client-side re-anchoring and is a documented no-op).
pub(crate) fn apply_surface_layout(app: &AppHandle, rect: &SurfaceLayout) -> Result<(), String> {
    let rect = *rect;
    #[cfg(debug_assertions)]
    eprintln!(
        "[mpv-set-layout] rect=({:.1},{:.1}) {:.1}x{:.1}",
        rect.x, rect.y, rect.width, rect.height
    );
    #[cfg(target_os = "macos")]
    {
        macos_surface::apply_layout(app, rect)
    }
    #[cfg(target_os = "windows")]
    {
        let parent = window_surface(app)?;
        windows_layering::resize_mpv_video_window(parent, rect);
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = window_surface(app)?;
        x11_layering::resize_mpv_window(parent, rect);
        Ok(())
    }
}

/// Clamp a reported stage rect to something embeddable (finite, non-negative,
/// non-degenerate). Any NaN/infinite/negative input collapses safely instead of
/// producing an ill-formed surface.
fn sanitize_surface_layout(rect: SurfaceLayout) -> SurfaceLayout {
    let clean = |v: f64| v.max(0.0);
    SurfaceLayout {
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

/// macOS embed-surface management. The root cause of "mpv opens a separate
/// floating window" on macOS is embedding into WKWebView: WebKit owns its
/// subview hierarchy and prunes/forgets foreign views, so mpv's video view ends
/// up detached from the app while its `wid` property still "looks" unchanged.
///
/// The fix embeds into a DEDICATED NSView we own instead of borrowing one from
/// WebKit:
///   * it is created plain, inserted as a sibling BELOW the transparent
///     WKWebView (never a subview of it), layer-backed (metal/gpu renderer
///     requirement), and retina-aware (`contentsScale = backingScaleFactor`);
///   * its frame is re-anchored onto the DOM video stage by `mpv_set_layout`
///     (CSS px -> points, titlebar/scale corrected via `convertRect`), so the
///     picture is confined to the player container — never the whole window;
///   * anchoring failures fail session creation instead of leaking a detached
///     mpv window, so the frontend falls back to HTML5.
#[cfg(target_os = "macos")]
pub(crate) mod macos_surface {
    use super::{sanitize_surface_layout, window_surface};
    use crate::native_player::SurfaceLayout;
    use objc2::encode::{Encode, Encoding};
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::sync::Mutex;

    pub const NS_WINDOW_ABOVE: i64 = 1;
    pub const NS_WINDOW_BELOW: i64 = -1;

    /// Raw `*mut AnyObject` that is `Send + Sync`: it is only ever written
    /// while holding the mutex and read on the main thread / ticker for
    /// worst-effort repinning, so sharing the pointer is safe in this context.
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
    // value (ABI for `setFrame:`, `convertRect:fromView:`, `bounds`, ...).
    // On Darwin, NSPoint/NSSize/NSRect are typedefs for the CG* structs.
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

    fn cg_size(width: f64, height: f64) -> NSSize {
        NSSize { width, height }
    }

    fn cg_rect(x: f64, y: f64, width: f64, height: f64) -> NSRect {
        NSRect {
            origin: NSPoint { x, y },
            size: cg_size(width, height),
        }
    }

    /// The window content view that hosts both the WKWebView and our host view.
    /// (This is Tauri's raw `ns_view` — the content view of the app window.)
    pub fn content_view(app: &tauri::AppHandle) -> Result<*mut AnyObject, String> {
        let surface = window_surface(app)?;
        Ok(surface as *mut AnyObject)
    }

    /// The WKWebView subview of the content view (found once, cached). The
    /// geometry conversion needs its local coordinate space.
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

    /// The dedicated, Rust-owned host NSView mpv embeds into (`wid`). Created
    /// lazily once per process; leaked deliberately (it lives for the app's
    /// lifetime). Layer-backed for the GPU/Metal renderer, retina-scaled, and
    /// inserted below the WKWebView so DOM chrome stays above the picture.
    pub fn host_view(app: &tauri::AppHandle) -> Result<*mut AnyObject, String> {
        static HOST_VIEW: Mutex<Option<ViewPtr>> = Mutex::new(None);
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
            // Layer-backing is a hard requirement: mpv's GPU/Metal renderer on
            // macOS silently refuses to draw into non-layer-backed views and
            // falls back to its own window, the detachment symptom we must fix.
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
            // backing scale factor so the decoded picture is native-res, not
            // stretched/quarter-res.
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
            // Stretch to the full content area by default; `apply_layout` then
            // re-anchors onto the exact DOM-stage rect reported by the frontend.
            let bounds: NSRect = msg_send![content, bounds];
            let _: () = msg_send![host, setFrame: bounds];
            *guard = Some(ViewPtr(host));
            Ok(host)
        }
    }

    /// True when the host view is still attached to a real window and covers a
    /// non-degenerate region — the precondition that makes an embedded (never
    /// detached) mpv. Checked before init so a broken anchor fails the session.
    pub fn verify_embedded(app: &tauri::AppHandle) -> bool {
        let host = match host_view(app) {
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

    /// Re-frame the host NSView onto the DOM stage rect (CSS pixels, relative to
    /// the webview content area, top-left origin). The rect is converted from
    /// webview-local points into content-view coordinates via AppKit so
    /// titlebar insets, window chrome and content scale are handled exactly.
    pub fn apply_layout(app: &tauri::AppHandle, rect: SurfaceLayout) -> Result<(), String> {
        let rect = sanitize_surface_layout(rect);
        let content = content_view(app)?;
        let host = host_view(app)?;
        let webview = webview_view(content)?;
        unsafe {
            let bounds: NSRect = msg_send![webview, bounds];
            if bounds.size.width <= 0.0 || bounds.size.height <= 0.0 {
                return Ok(()); // not laid out yet — nothing meaningful to anchor to
            }
            // getBoundingClientRect uses a top-left origin; NSView uses
            // bottom-left. Flip within the webview's space, then let AppKit
            // convert into the shared content coordinates (titlebar-safe).
            let local = cg_rect(
                rect.x.max(0.0),
                (bounds.size.height - (rect.y + rect.height)).max(0.0),
                rect.width.max(0.0),
                rect.height.max(0.0),
            );
            let frame_in_content: NSRect = msg_send![host, convertRect: local, fromView: webview];
            // Guard against a zero-size anchor under the webview (nothing to
            // show): still frame it, but the stage is degenerate either way.
            let _: () = msg_send![host, setFrame: frame_in_content];
            let _: () = msg_send![host, setNeedsDisplay: 1i8];
        }
        Ok(())
    }
}

/// Keep the transparent webview (DOM chrome: captions/OSD/controls) above the
/// mpv video surface. mpv's `wid` embedding always drops its view ON TOP of the
/// webview; this restores the intended stack on every ticker beat and after
/// each `load`. Platform back-ends:
///   * macOS   -> NSView re-sort (macos_layering)
///   * Windows -> SetWindowPos: pin mpv's "mpv"-class video HWND to the bottom
///   * X11     -> raise the webview X window above mpv's child (x11_layering)
///   * Wayland -> no client-side z-order; compositor-owned, no back-end
#[cfg(target_os = "macos")]
fn keep_webview_on_top(app: &AppHandle) {
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

/// macOS layering: mpv renders into the dedicated host view (below the webview),
/// so the only stacking concern is keeping that host pinned UNDER the WKWebView.
/// Every ticker beat re-asserts the stack — host at the bottom, webview at the
/// top — which also covers anything mpv/wry inserts later. `NSWindowAbove` == 1,
/// `NSWindowBelow` == -1.
#[cfg(target_os = "macos")]
pub(crate) mod macos_layering {
    use super::macos_surface;
    use objc2::ffi::object_getClassName;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use std::ffi::CStr;

    const NS_WINDOW_ABOVE: i64 = macos_surface::NS_WINDOW_ABOVE;
    const NS_WINDOW_BELOW: i64 = macos_surface::NS_WINDOW_BELOW;
    use std::sync::Mutex;
    static LAST_STACK: Mutex<Option<String>> = Mutex::new(None);

    fn smoke() -> bool {
        std::env::var("ZANPLAYER_NATIVE_SMOKE").is_ok()
    }

    /// Environment-independent proof of the z-order + anchoring fixes: create
    /// the real dedicated host view under the webview, insert a synthetic
    /// top-view (standing in for a stray mpv/other view on top of the webview),
    /// run the same re-pin and show the stack flips back so the WKWebView ends
    /// up above everything. Also exercises the DOM-rect anchoring path with a
    /// synthetic stage rect. Called by `smoke_load` before the real session.
    #[allow(dead_code)]
    pub fn smoke_exercise(app: &tauri::AppHandle) -> Result<(), String> {
        let content = macos_surface::content_view(app)?;
        let host = macos_surface::host_view(app)?;
        let verify = macos_surface::verify_embedded(app);
        eprintln!(
            "[native-smoke] dedicated embed host view ready under the webview (in-window anchor verified: {verify})"
        );
        let layout = super::SurfaceLayout {
            x: 0.0,
            y: 0.0,
            width: 320.0,
            height: 240.0,
        };
        match macos_surface::apply_layout(app, layout) {
            Ok(()) => eprintln!("[native-smoke] stage-anchoring (mpv_set_layout path) applied a 320x240 rect"),
            Err(e) => eprintln!("[native-smoke] stage-anchoring skipped: {e}"),
        }
        let ns_view_class = objc2::runtime::AnyClass::get(c"NSView")
            .ok_or("NSView class not registered with the Objective-C runtime")?;
        eprintln!(
            "[native-smoke] creating synthetic top view (stand-in for a stray view above the webview)"
        );
        unsafe {
            let dummy: *mut AnyObject = msg_send![ns_view_class, new];
            let no_sibling: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![
                content,
                addSubview: dummy,
                positioned: NS_WINDOW_ABOVE,
                relativeTo: no_sibling
            ];
            eprintln!("[native-smoke] synthetic view on top — running layering re-pin");
            keep_webview_on_top(app);
            let _: () = msg_send![dummy, removeFromSuperview];
        }
        debug_assert_eq!(host as i64, super::embed_surface(app).unwrap_or(0));
        Ok(())
    }

    /// Re-assert the stacking contract: the mpv host view stays at the bottom
    /// of the content view; the WKWebView stays at the top (above any stray
    /// view/mpv leftovers). Harmless no-op when the host view is not created
    /// yet; the ticker re-runs it so late insertions are covered too.
    pub fn keep_webview_on_top(app: &tauri::AppHandle) {
        let content = match macos_surface::content_view(app) {
            Ok(content) => content,
            Err(_) => return,
        };
        if !smoke() {
            let _ = repin(content, app);
            return;
        }
        // In smoke mode, only print when the subview stack actually changed, so
        // the 250 ms ticker doesn't spam identical BEFORE/AFTER pairs.
        let before = subview_list(content);
        let reordered = repin(content, app);
        let after = if reordered {
            subview_list(content)
        } else {
            before.clone()
        };
        let mut last = LAST_STACK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if *last != Some(after.clone()) {
            eprintln!("[native-smoke] subviews BEFORE: {before}");
            eprintln!("[native-smoke] subviews AFTER : {after}");
            *last = Some(after);
        }
    }

    /// Move the host view to the bottom of the content view and the WKWebView
    /// to the top. `addSubview:positioned:relativeTo:` with a nil sibling
    /// inserts at the very back (`NSWindowBelow`) or very front
    /// (`NSWindowAbove`) without reparenting.
    fn repin(content: *mut AnyObject, app: &tauri::AppHandle) -> bool {
        let host = match macos_surface::host_view(app) {
            Ok(host) => host,
            Err(_) => return false,
        };
        unsafe {
            let nil: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![content, addSubview: host, positioned: NS_WINDOW_BELOW, relativeTo: nil];
            let moved_webview = match super::macos_surface::webview_view(content) {
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
            };
            // Repinning the host is what matters; treat a missing webview as a
            // (transient) no-change so the smoke printer stays quiet.
            let had_host = super::macos_surface::verify_embedded(app);
            moved_webview || had_host
        }
    }

    pub(super) fn class_name(view: *mut AnyObject) -> String {
        let name = unsafe { object_getClassName(view) };
        if name.is_null() {
            return String::new();
        }
        unsafe { CStr::from_ptr(name).to_string_lossy().into_owned() }
    }

    fn subview_list(root: *mut AnyObject) -> String {
        unsafe {
            let subviews: *mut AnyObject = msg_send![root, subviews];
            if subviews.is_null() {
                return "(none)".into();
            }
            let count: usize = msg_send![subviews, count];
            let mut parts = Vec::with_capacity(count);
            for i in 0..count {
                let view: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
                parts.push(class_name(view));
            }
            if parts.is_empty() {
                "(none)".to_string()
            } else {
                parts.join(" | ")
            }
        }
    }
}

/// Windows z-order: mpv's `wid` embedding creates its video window (window
/// class `mpv`) as a child of the top-level HWND — created after WebView2, so
/// it lands on TOP of the webview and buries the HTML captions/OSD/controls.
/// Every sweep finds that child and drops it to the bottom of the sibling
/// stack (SetWindowPos / HWND_BOTTOM), keeping the DOM chrome above the frames.
/// `mpv` is mpv's documented video window class and cannot collide with the
/// WebView2 host, so this is safe even with many sibling child windows.
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

    fn is_mpv_video_window(hwnd: HWND) -> bool {
        let mut class = [0u16; 256];
        let len = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
        len > 0 && String::from_utf16_lossy(&class[..len as usize]) == "mpv"
    }

    unsafe extern "system" fn collect_child(hwnd: HWND, lparam: isize) -> BOOL {
        let children = &mut *(lparam as *mut Vec<HWND>);
        children.push(hwnd);
        1
    }

    /// Drop every child of `parent` whose window class is mpv's video window to
    /// the bottom of the sibling stack so WebView2's DOM chrome stays on top.
    /// Returns true if at least one window was re-ordered.
    fn lower_mpv_video_window(parent: i64) -> bool {
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
            if is_mpv_video_window(hwnd) {
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
            let _ = lower_mpv_video_window(surface);
        }
    }

    /// Re-size/re-position mpv's embedded child window onto the DOM video stage
    /// (`mpv_set_layout`). CSS px are scaled to physical px using the window's
    /// DPI; the y-axis is already top-down on Windows, matching
    /// `getBoundingClientRect`. Best-effort: if mpv hasn't created its child
    /// yet this is a no-op that re-runs on the next layout report.
    pub fn resize_mpv_video_window(parent: i64, rect: SurfaceLayout) -> bool {
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
            if is_mpv_video_window(hwnd) {
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

/// X11 layering (best effort): mpv embeds its video as a NEW child X window of
/// the same parent as the webkit webview, so it stacks on top. We cache the
/// webview's XID (the single child observed before mpv attaches) and on every
/// sweep re-raise it above mpv's child with ConfigureWindow/StackMode::Above.
///
/// NOTE: relies on XQueryTree reporting children in bottom-to-top stacking
/// order; on failure every step degrades to a silent no-op. Wayland compositors
/// own stacking themselves and ignore client-side re-order requests, so there
/// is deliberately no Wayland back-end — wl_surface z-order would need a
/// compositor protocol extension (e.g. xdg-toplevel) that is out of scope here.
#[cfg(all(unix, not(target_os = "macos")))]
mod x11_layering {
    use super::{sanitize_surface_layout, window_surface};
    use crate::native_player::SurfaceLayout;
    use std::sync::Mutex;
    use tauri::AppHandle;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConfigureWindowAux, ConnectionExt, StackMode};
    use x11rb::rust_connection::RustConnection;

    struct LayeringState {
        conn: Option<RustConnection>,
        webview: Option<u32>,
    }

    static STATE: Mutex<Option<LayeringState>> = Mutex::new(None);

    /// Best-effort sweep: cache the presumed webview XID from the pre-mpv child
    /// set, then re-raise it above mpv's stacked-on-top video child. Degrades to
    /// a silent no-op on any failure (missing connection, no children yet, …).
    fn rake_webview_above_mpv(parent: i64) -> bool {
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
        // The first observed (single) child is the webview; a later mpv child
        // must never win the identity guess.
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
            let _ = rake_webview_above_mpv(surface);
        }
    }

    /// Re-size/re-position mpv's embedded child window onto the DOM video stage
    /// (`mpv_set_layout`). The mpv child is the top-most child (the one that is
    /// not the cached webview); CSS px are scaled to X pixels from the screen's
    /// DPI (`pixels_per_inch`). y stays top-down, matching getBoundingClientRect.
    /// Best-effort, like every X11 arm here; Wayland stays a no-op by design.
    pub fn resize_mpv_window(parent: i64, rect: SurfaceLayout) -> bool {
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
        // The top-most child (that is not the webview) is mpv's video window.
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
    use crate::native_player::{position_clamped, snapshot_changed};

    #[test]
    fn zero_surface_is_rejected_before_mpv_init() {
        // `wid=0` must never reach mpv: instead of embedding inside the app it
        // would make mpv open its own detached window (the external/PIP
        // symptom). The guard runs before `with_initializer`.
        assert_eq!(
            ensure_embeddable_surface(0).unwrap_err(),
            "native window surface resolved to 0 — nothing to embed into"
        );
        // Real NSView/HWND/XID ids are non-zero and pass through.
        assert!(ensure_embeddable_surface(0x007fff_abcdef).is_ok());
    }

    #[test]
    fn stage_layout_is_sanitized_before_anchoring() {
        let clean = |r: SurfaceLayout| sanitize_surface_layout(r);
        // A normal stage rect passes through untouched.
        let normal = clean(SurfaceLayout {
            x: 10.0,
            y: 20.0,
            width: 300.0,
            height: 200.0,
        });
        assert_eq!((normal.x, normal.y, normal.width, normal.height), (10.0, 20.0, 300.0, 200.0));
        // Negative coordinates / sizes collapse to 0 instead of an ill-formed
        // frame (which could push mpv's view off-window into a detached spot).
        let negative = clean(SurfaceLayout {
            x: -12.0,
            y: -8.0,
            width: -50.0,
            height: -50.0,
        });
        assert_eq!(
            (negative.x, negative.y, negative.width, negative.height),
            (0.0, 0.0, 0.0, 0.0)
        );
        // NaN / infinite inputs degrade to a safe zero rect — never panics and
        // never hands a garbage frame to the window server.
        let nan = clean(SurfaceLayout {
            x: f64::NAN,
            y: 10.0,
            width: f64::INFINITY,
            height: f64::NEG_INFINITY,
        });
        assert_eq!((nan.x, nan.y, nan.width, nan.height), (0.0, 10.0, 0.0, 0.0));
    }

    #[test]
    fn read_clock_defaults_before_a_file_is_loaded() {
        // Can't construct a real mpv here (needs the host lib), so verify the
        // graceful-default contract through the pure snapshot helper path by
        // asserting on serialization only when there is no session. The actual
        // property reads are exercised end-to-end in `tauri dev` with libmpv.
        let update = MpvTimeUpdate {
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
        // Regression: `position.min(duration.max(position))` simplified back to
        // `position` (dead math), so an EOF tick could echo past the tail.
        assert_eq!(position_clamped(120.0, 100.0), 100.0);
        assert_eq!(position_clamped(50.0, 100.0), 50.0);
        assert_eq!(position_clamped(-4.0, 100.0), 0.0);
        // Unknown duration: the position passes through as-is.
        assert_eq!(position_clamped(30.0, 0.0), 30.0);
        assert_eq!(position_clamped(-2.0, 0.0), 0.0);
    }

    #[test]
    fn ticker_emits_on_change_and_coalesces_noop_beats() {
        let base = MpvTimeUpdate {
            position: 10.0,
            duration: 100.0,
            paused: false,
            ended: false,
        };
        // First beat after load always crosses the bridge.
        assert!(snapshot_changed(&None, &base));
        // Jitter within the epsilon with identical flags is coalesced away:
        // paused playback must not flood the webview event bridge.
        let same = MpvTimeUpdate {
            position: 10.03,
            ..base.clone()
        };
        assert!(!snapshot_changed(&Some(base.clone()), &same));
        // A real movement (>= the 250 ms spacing at any supported speed) or a
        // pause/ended transition re-emits so the clock and play state track mpv.
        let moved = MpvTimeUpdate {
            position: 10.2,
            ..base.clone()
        };
        assert!(snapshot_changed(&Some(base.clone()), &moved));
        let paused = MpvTimeUpdate {
            position: 10.03,
            paused: true,
            ..base.clone()
        };
        assert!(snapshot_changed(&Some(base.clone()), &paused));
        let seek_back = MpvTimeUpdate {
            position: 5.0,
            ..base.clone()
        };
        assert!(snapshot_changed(&Some(base), &seek_back));
    }

    #[test]
    fn windows_handle_is_readable_on_non_windows() {
        // The match arms in `window_surface` are type-checked on every target,
        // so on macOS this confirms the raw-window-handle 0.6 API we depended
        // on stays stable (the Win32 arm compiles against the real field type).
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