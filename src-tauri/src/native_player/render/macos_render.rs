//! macOS-native playback through the libmpv **Render API**, presented with
//! Metal + CAMetalLayer. Only compiled under `feature = "macos-render"`.
//!
//! The installed Homebrew libmpv has no Metal render export (`render.h` stops
//! at the OpenGL/SW backends), so the target is the software backend:
//! `MPV_RENDER_API_TYPE_SW`. mpv decodes into a CPU buffer (`bgr0`), we force
//! the alpha byte opaque, and upload each frame with `replaceRegion` into the
//! drawable of a CAMetalLayer attached to the dedicated host NSView under the
//! transparent webview. This replaces the `wid` window-VO embed on macOS,
//! which could still open a detached top-level window.
//!
//! Every object lives behind raw `*mut AnyObject` pointers (Metal/QuartzCore
//! types are not `Send`): mirroring the `ViewPtr` discipline in `session.rs`,
//! `ObjPtr` freezes a leaked pointer so the render thread can `msg_send!`
//! without ever dereferencing Rust-side.

use crate::native_player::{session, snapshot_changed, MpvTimeUpdate, SurfaceLayout};
use libmpv2::Mpv;
use libmpv2_sys as lmpv;
use objc2::encode::{Encode, Encoding};
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// `ZANPLAYER_NATIVE_LAYOUT_DEBUG=1` turns on the visual layout debug mode:
/// the CAMetalLayer gets a magenta border (the REAL native frame, drawn below
/// the transparent webview), so it can be compared pixel-for-pixel against the
/// DOM-side outlines (red = `[data-player-viewport]`, blue = `[data-sidebar]`,
/// green = video layer, yellow = `[data-subtitle-layer]`) that the frontend
/// paints. Also forces the structured `[zan-layout-trace]` record even in
/// release builds.
pub(crate) fn layout_debug_enabled() -> bool {
    std::env::var("ZANPLAYER_NATIVE_LAYOUT_DEBUG").map(|v| v == "1").unwrap_or(false)
}

/// `MTLPixelFormatBGRA8Unorm`: byte order B,G,R,A in memory, matching mpv's
/// little-endian `"bgr0"` SW output.
const MTL_PIXEL_FORMAT_BGRA8_UNORM: usize = 80;
/// Idle poll cadence; the update callback wakes the loop, this only bounds the
/// latency when it somehow misses a wakeup.
const POLL_INTERVAL: Duration = Duration::from_millis(8);
/// `mpv_render_context_update()` returns this when a frame must be rendered.
const UPDATE_FRAME: u64 = lmpv::mpv_render_update_flag_MPV_RENDER_UPDATE_FRAME as u64;

/// Raw `*mut AnyObject` that is `Send + Sync`: only ever dispatched through
/// `msg_send!`, pointee leaked for the process lifetime.
#[derive(Clone, Copy, Debug)]
struct ObjPtr(*mut AnyObject);
// SAFETY: never dereferenced in Rust; Metal/CoreAnimation message dispatch from
// any thread is safe, and the pointee outlives every reference (leaked).
unsafe impl Send for ObjPtr {}
unsafe impl Sync for ObjPtr {}

/// By-value CoreGraphics geometry. Apple typedefs these on 64-bit darwin to
/// `{d,d}` / `{d,d}` / `{point,size}` exactly.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct CGPointD {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct CGSizeD {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct CGRectD {
    origin: CGPointD,
    size: CGSizeD,
}

// SAFETY: darwin CGPoint/CGSize/CGRect are `{d,d}`, `{d,d}` and `{point,size}`.
unsafe impl Encode for CGPointD {
    const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for CGSizeD {
    const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for CGRectD {
    const ENCODING: Encoding = Encoding::Struct("CGRect", &[CGPointD::ENCODING, CGSizeD::ENCODING]);
}

/// By-value Metal geometry inside `msg_send!` (objc2-metal marshals these as
/// `{?...}` structs; the type name in the encoding is not runtime-validated).
#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct MTLOrigin {
    x: usize,
    y: usize,
    z: usize,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct MTLSize {
    width: usize,
    height: usize,
    depth: usize,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct MTLRegion {
    origin: MTLOrigin,
    size: MTLSize,
}

// SAFETY: layouts match Apple's MTLOrigin/MTLSize/MTLRegion on 64-bit darwin.
unsafe impl Encode for MTLOrigin {
    const ENCODING: Encoding =
        Encoding::Struct("MTLOrigin", &[usize::ENCODING, usize::ENCODING, usize::ENCODING]);
}
unsafe impl Encode for MTLSize {
    const ENCODING: Encoding =
        Encoding::Struct("MTLSize", &[usize::ENCODING, usize::ENCODING, usize::ENCODING]);
}
unsafe impl Encode for MTLRegion {
    const ENCODING: Encoding = Encoding::Struct("MTLRegion", &[MTLOrigin::ENCODING, MTLSize::ENCODING]);
}

// MTLCreateSystemDefaultDevice(), declared locally (rather than via an
// objc2-metal dependency) so the render path stays on plain `objc2`, and
// linked explicitly so tests / non-GUI binaries resolve the symbol.
#[link(name = "Metal", kind = "framework")]
unsafe extern "C" {
    fn MTLCreateSystemDefaultDevice() -> *mut AnyObject;
}

/// State shared between mpv's update callback (any thread), the layout path
/// (main thread) and the render thread. Leaked for the process lifetime so the
/// callback's pointer never dangles.
struct SharedRender {
    /// Set by the update callback (and by `load`/layout) when a frame should
    /// be rendered; consumed by the render thread.
    frame_requested: AtomicBool,
    /// Last `mpv_render_context_render` error code (0 == success).
    render_error: AtomicI32,
    /// Frames successfully presented through the CAMetalLayer.
    frames_rendered: AtomicU64,
    /// Current drawable surface size in pixels (backing-scaled).
    size: Mutex<(u32, u32)>,
}

impl SharedRender {
    fn new() -> &'static Self {
        Box::leak(Box::new(Self {
            frame_requested: AtomicBool::new(false),
            render_error: AtomicI32::new(0),
            frames_rendered: AtomicU64::new(0),
            size: Mutex::new((0, 0)),
        }))
    }
}

/// The single render rig: the leaked Metal surface plus the libmpv software
/// render context. Cloned into the render thread and referenced by the layout
/// path through the process-global `METAL_SURFACE`.
struct MetalRig {
    layer: ObjPtr,
    queue: ObjPtr,
    ctx: *mut lmpv::mpv_render_context,
    shared: &'static SharedRender,
}

// SAFETY: only sends raw pointers + the render context; the context is used
// exclusively from the single render thread, main thread sticks to geometry.
unsafe impl Send for MetalRig {}
unsafe impl Sync for MetalRig {}

impl MetalRig {
    fn new(app: &AppHandle, mpv: &Mpv) -> Result<Arc<Self>, String> {
        // The host NSView is the Metal layer's superview/anchored layer
        // target; `macos_surface` caches and leaks it for the process lifetime.
        let host = ObjPtr(session::macos_surface::host_view(app)?);
        let device = metal_device()?;
        let layer = metal_layer(host, device)?;
        let queue = metal_queue(device)?;
        let shared = SharedRender::new();
        let ctx = create_render_context(mpv)?;
        set_update_callback(ctx, shared);

// Seed the drawable to a degenerate 1×1 × backing scale. The real drawable
// size is set by `mpv_set_layout` once the first DOM rect arrives; seeding
// the host's (still full-window) bounds here would let a pre-layout present
// paint a whole-window frame during the engine switch.
let (_, _, scale) = host_size_px(app)?;
set_layer_geometry(layer, 1, 1, scale);
*shared.size.lock().unwrap_or_else(|p| p.into_inner()) = (1, 1);

        Ok(Arc::new(Self {
            layer,
            queue,
            ctx,
            shared,
        }))
    }
}

/// Shared surface for `apply_surface_layout` (set at session creation, never
/// cleared). Cloning the `Arc` hands the layout path the same rig.
static METAL_SURFACE: Mutex<Option<Arc<MetalRig>>> = Mutex::new(None);
/// Render thread start guard: exactly one render thread per process (the mpv
/// render API must be driven from a single thread).
static RENDER_THREAD_STARTED: AtomicBool = AtomicBool::new(false);

/// Re-anchor the CAMetalLayer onto the DOM video stage and refresh the render
/// resolution. The host view frame tracks the stage via
/// `macos_surface::apply_layout`; we then pin the layer — which is
/// **layer-hosting** (we called `setLayer:` ourselves), so AppKit does NOT
/// auto-size it — explicitly to the host bounds, correct drawable size/scale,
/// and flush the transaction so the move is visible immediately.
pub(crate) fn apply_surface_layout(app: &AppHandle, rect: &SurfaceLayout) -> Result<(), String> {
    let rect = *rect;
    if session::trace_enabled() {
        eprintln!(
            "[mpv-set-layout] rect=({:.1},{:.1}) {:.1}x{:.1}",
            rect.x, rect.y, rect.width, rect.height
        );
    }
    // A degenerate stage (0×0, still mounting, layout not committed yet) must
    // never move the surface to a zero-size (0,0) patch — keep the last good
    // anchor and just request a redraw.
    if rect.width >= 1.0 && rect.height >= 1.0 {
        session::macos_surface::apply_layout(app, rect)?;
    }
    let surface = METAL_SURFACE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if let Some(rig) = surface {
        let (w, h, scale) = host_size_px(app)?;
        if w > 0 && h > 0 {
            // 1) Frame the CAMetalLayer to the host view's bounds (host-local
            //    origin (0,0)); clamp content to the stage (masksToBounds).
            sync_layer_frame(app, rig.layer)?;
            // 2) Retina scale + backing-scaled drawable for the stage size.
            set_layer_geometry(rig.layer, w, h, scale);
            *rig.shared.size.lock().unwrap_or_else(|p| p.into_inner()) = (w, h);
            // [zan-layout-trace] ONE structured record per layout update, in
            // every coordinate space that can drift: the requested DOM rect
            // (CSS px), the window content size (points), the webview bounds
            // + frame (points), the host frame/bounds the layer was actually
            // placed at (content points), the backing scale, the layer frame,
            // the drawable size (backing px), and — the thing that matters —
            // RESULT=EXACT vs the rounded delta between the APPLIED host
            // frame (read back into webview-local CSS coords) and the
            // JS-requested rect. A misconverted or drifted surface fails here
            // instead of hiding behind the rect we merely requested.
            let trace = session::trace_enabled() || layout_debug_enabled();
            if trace {
                unsafe {
                    let hview = session::macos_surface::host_view(app).ok();
                    if let Some(hv) = hview {
                        let hframe: CGRectD = msg_send![hv, frame];
                        let hbounds: CGRectD = msg_send![hv, bounds];
                        let lframe: CGRectD = msg_send![rig.layer.0, frame];
                        let lbounds: CGRectD = msg_send![rig.layer.0, bounds];
                        let ds: CGSizeD = msg_send![rig.layer.0, drawableSize];
                        let content = session::macos_surface::content_view(app).ok();
                        let cframe: CGRectD = content
                            .map(|c| msg_send![c, bounds])
                            .unwrap_or(CGRectD {
                                origin: CGPointD { x: 0.0, y: 0.0 },
                                size: CGSizeD { width: 0.0, height: 0.0 },
                            });
                        let wv = session::macos_surface::webview_geometry(app).ok();
                        let (wvb_w, wvb_h, wvf_x, wvf_y, wvf_w, wvf_h) = wv.unwrap_or((0.0, 0.0, 0.0, 0.0, 0.0, 0.0));
                        let applied = session::macos_surface::applied_js_rect(app)
                            .unwrap_or((rect.x, rect.y, rect.width, rect.height));
                        let dx = (applied.0 - rect.x).abs();
                        let dy = (applied.1 - rect.y).abs();
                        let dw = (applied.2 - rect.width).abs();
                        let dh = (applied.3 - rect.height).abs();
                        let exact = dx <= 0.5 && dy <= 0.5 && dw <= 0.5 && dh <= 0.5;
                        eprintln!(
                            "[zan-layout-trace] js=({:.1},{:.1}) {:.1}x{:.1} | applied=({:.1},{:.1}) {:.1}x{:.1} | win={:.1}x{:.1} | webview=({:.1},{:.1}) {:.1}x{:.1} bounds={:.1}x{:.1} | host=({:.1},{:.1}) {:.1}x{:.1} bounds=({:.1},{:.1}) {:.1}x{:.1} | scale={:.2} | layer=({:.1},{:.1}) {:.1}x{:.1} bounds=({:.1},{:.1}) {:.1}x{:.1} | drawable={:.0}x{:.0}px | RESULT={} (dx={:.2} dy={:.2} dw={:.2} dh={:.2})",
                            rect.x, rect.y, rect.width, rect.height,
                            applied.0, applied.1, applied.2, applied.3,
                            cframe.size.width, cframe.size.height,
                            wvf_x, wvf_y, wvf_w, wvf_h,
                            wvb_w, wvb_h,
                            hframe.origin.x, hframe.origin.y, hframe.size.width, hframe.size.height,
                            hbounds.origin.x, hbounds.origin.y, hbounds.size.width, hbounds.size.height,
                            scale,
                            lframe.origin.x, lframe.origin.y, lframe.size.width, lframe.size.height,
                            lbounds.origin.x, lbounds.origin.y, lbounds.size.width, lbounds.size.height,
                            ds.width, ds.height,
                            if exact { "EXACT" } else { "MISMATCH" },
                            dx, dy, dw, dh,
                        );
                    }
                }
            }
        }
        // A resize changes the render target — ask for a redraw even if mpv
        // didn't push a new frame (e.g. resizing while paused).
        rig.shared.frame_requested.store(true, Ordering::SeqCst);
        // Flush the implicit CATransaction so framing/layout changes made on
        // this main-thread callback are committed this tick, not later.
        flush_catransaction();
    }
    Ok(())
}

/// The libmpv software-render session presented through the Metal surface.
pub struct RenderSession {
    mpv: Arc<Mpv>,
    rig: Arc<MetalRig>,
    ticking: Arc<AtomicBool>,
}

impl RenderSession {
    /// Create the mpv core (`vo=libmpv`, never `wid`), build the CAMetalLayer
    /// on the in-window host view and create the render context. Must run on
    /// the main thread (NSView/CALayer access).
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let mpv = Mpv::with_initializer(|init| {
            // Render API output: mpv decodes into our buffers, never a window.
            init.set_option("vo", "libmpv")?;
            init.set_option("keep-open", "yes")?;
            // Frames land in CPU memory anyway; GPU decode would copy straight
            // back, so it buys nothing here.
            init.set_option("hwdec", "no")?;
            Ok(())
        })
        .map_err(|e| format!("Failed to start libmpv (render): {e}"))?;

        let rig = MetalRig::new(app, &mpv)?;
        *METAL_SURFACE.lock().unwrap_or_else(|p| p.into_inner()) = Some(rig.clone());

        if !RENDER_THREAD_STARTED.swap(true, Ordering::SeqCst) {
            let rig_t = rig.clone();
            std::thread::spawn(move || render_loop(rig_t));
        }

        // [native-render] single startup banner: one per process; proves the
        // compiled backend, runtime render context, and surface strategy in one
        // line so the audit report can cite this verbatim.
        eprintln!("[native-render] backend=macos-render vo=libmpv surface=CAMetalLayer embedding=NSView wid=false");

        Ok(Self {
            mpv: Arc::new(mpv),
            rig,
            ticking: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Load a file and start the clock ticker. The render thread is already
    /// polling; a closed `frame_requested` latch guarantees it wakes for the
    /// first decoded frame.
    pub fn load(&self, app: &AppHandle, path: &str) -> Result<(), String> {
        self.rig.shared.frame_requested.store(true, Ordering::SeqCst);
        self.mpv
            .command("loadfile", &[path])
            .map_err(|e| format!("loadfile {path}: {e}"))?;

        if !self.ticking.swap(true, Ordering::SeqCst) {
            let app = app.clone();
            let mpv = self.mpv.clone();
            let ticking = self.ticking.clone();
            std::thread::spawn(move || {
                let mut last: Option<MpvTimeUpdate> = None;
                while ticking.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(250));
                    let snapshot = session::read_clock(&mpv);
                    if snapshot_changed(&last, &snapshot) {
                        last = Some(snapshot.clone());
                        let _ = app.emit("mpv-timeupdate", snapshot);
                    }
                }
            });
        }

        let _ = app.emit("mpv-loaded", ());
        Ok(())
    }

    pub fn play(&self) -> Result<(), String> {
        self.request_redraw();
        self.mpv
            .set_property("pause", false)
            .map_err(|e| e.to_string())
    }

    pub fn pause(&self) -> Result<(), String> {
        self.request_redraw();
        self.mpv
            .set_property("pause", true)
            .map_err(|e| e.to_string())
    }

    pub fn seek(&self, position: f64) -> Result<(), String> {
        self.request_redraw();
        self.mpv
            .set_property("time-pos", position)
            .map_err(|e| e.to_string())
    }

    pub fn set_volume(&self, level: f64) -> Result<(), String> {
        self.mpv
            .set_property("volume", level)
            .map_err(|e| e.to_string())
    }

    pub fn set_speed(&self, speed: f64) -> Result<(), String> {
        self.mpv
            .set_property("speed", speed)
            .map_err(|e| e.to_string())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.ticking.store(false, Ordering::SeqCst);
        self.request_redraw();
        self.mpv.command("stop", &[]).map_err(|e| e.to_string())
    }

    /// One-shot playback snapshot for the smoke path / debugging: proves mpv
    /// actually decoded through the render VO and reports the Metal layer state.
    pub fn diagnostics(&self) -> String {
        let strp = |name: &str| match self.mpv.get_property::<String>(name) {
            Ok(v) => v,
            Err(e) => format!("<{e}>"),
        };
        let f = |name: &str| self.mpv.get_property::<f64>(name).unwrap_or(f64::NAN);
        let b = |name: &str| self.mpv.get_property::<bool>(name).unwrap_or(false);
        let (w, h) = *self
            .rig
            .shared
            .size
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        format!(
            "time-pos={:.2}s duration={:.2}s paused={} eof={} | vo={} hwdec={} video-format={} | surface={}x{} render-rc={} frames-presented={}",
            f("time-pos"),
            f("duration"),
            b("pause"),
            b("eof-reached"),
            strp("current-vo"),
            strp("hwdec-current"),
            strp("video-format"),
            w,
            h,
            self.rig.shared.render_error.load(Ordering::SeqCst),
            self.rig.shared.frames_rendered.load(Ordering::SeqCst),
        )
    }

    pub(crate) fn render_error(&self) -> i32 {
        self.rig.shared.render_error.load(Ordering::SeqCst)
    }

    pub(crate) fn frames_presented(&self) -> u64 {
        self.rig.shared.frames_rendered.load(Ordering::SeqCst)
    }

    pub(crate) fn current_vo(&self) -> String {
        self.mpv
            .get_property::<String>("current-vo")
            .unwrap_or_default()
    }

    pub(crate) fn time_pos(&self) -> f64 {
        self.mpv
            .get_property::<f64>("time-pos")
            .unwrap_or(0.0)
            .max(0.0)
    }

    fn request_redraw(&self) {
        self.rig.shared.frame_requested.store(true, Ordering::SeqCst);
    }
}

fn metal_device() -> Result<ObjPtr, String> {
    let ptr = unsafe { MTLCreateSystemDefaultDevice() };
    if ptr.is_null() {
        return Err("MTLCreateSystemDefaultDevice returned nil".into());
    }
    Ok(ObjPtr(ptr))
}

fn metal_layer(host: ObjPtr, device: ObjPtr) -> Result<ObjPtr, String> {
    let cls = AnyClass::get(c"CAMetalLayer").ok_or("CAMetalLayer class not registered")?;
    let layer: *mut AnyObject = unsafe { msg_send![cls, new] };
    if layer.is_null() {
        return Err("failed to allocate CAMetalLayer".into());
    }
    unsafe {
        let yes: i8 = 1;
        let no: i8 = 0;
        // Attach as the host view's backing layer; the host frame follows the
        // DOM stage via mpv_set_layout, so the layer tracks it automatically.
        let _: () = msg_send![host.0, setWantsLayer: yes];
        let _: () = msg_send![host.0, setLayer: layer];
        let _: () = msg_send![layer, setDevice: device.0];
        // BGRA8Unorm == mpv's little-endian "bgr0" byte order.
        let _: () = msg_send![layer, setPixelFormat: MTL_PIXEL_FORMAT_BGRA8_UNORM];
        // `framebufferOnly = false` so `replaceRegion` can CPU-upload.
        let _: () = msg_send![layer, setFramebufferOnly: no];
        // Alpha is forced to 0xFF on upload; opaque avoids compositing surprises.
        let _: () = msg_send![layer, setOpaque: yes];
        // The stage rect is the layer's hard boundary — never draw the decoded
        // picture outside the player stage.
        let _: () = msg_send![layer, setMasksToBounds: yes];
        // Degenerate initial state, NOT the full content view: until the
        // frontend's layout reporter dispatches the first real DOM rect, the
        // layer must not draw anything over the window (a transient full-window
        // video frame during engine switch was part of the stale-build symptom
        // set). `apply_surface_layout` pins frame + drawable on the first
        // rect; until then a present clamps to this 1×1 target and is inert.
        let zero = CGRectD {
            origin: CGPointD { x: 0.0, y: 0.0 },
            size: CGSizeD { width: 0.0, height: 0.0 },
        };
        let _: () = msg_send![layer, setFrame: zero];
        if layout_debug_enabled() {
            set_layer_border(ObjPtr(layer), 2.0);
        }
    }
    Ok(ObjPtr(layer))
}

/// Magenta border on the CAMetalLayer: the true native frame boundary, drawn
/// under the transparent webview so it stays visible against any DOM paint.
/// `NSColor.magentaColor.CGColor` avoids allocating a CGColorSpace/CGColor by
/// hand — AppKit hands us a ready CGColorRef.
fn set_layer_border(layer: ObjPtr, width: f64) {
    let ns_color_class = match AnyClass::get(c"NSColor") {
        Some(cls) => cls,
        None => return,
    };
    unsafe {
        let color: *mut AnyObject = msg_send![ns_color_class, magentaColor];
        if color.is_null() {
            return;
        }
        let cg: *const c_void = msg_send![color, CGColor];
        if cg.is_null() {
            return;
        }
        let _: () = msg_send![layer.0, setBorderColor: cg];
        let _: () = msg_send![layer.0, setBorderWidth: width];
    }
}

fn metal_queue(device: ObjPtr) -> Result<ObjPtr, String> {
    let queue: *mut AnyObject = unsafe { msg_send![device.0, newCommandQueue] };
    if queue.is_null() {
        return Err("MTLDevice newCommandQueue returned nil".into());
    }
    Ok(ObjPtr(queue))
}

/// `mpv_render_context_create` with `MPV_RENDER_API_TYPE_SW`.
fn create_render_context(mpv: &Mpv) -> Result<*mut lmpv::mpv_render_context, String> {
    let mut ctx: *mut lmpv::mpv_render_context = std::ptr::null_mut();
    let api = lmpv::MPV_RENDER_API_TYPE_SW;
    let params = [
        lmpv::mpv_render_param {
            type_: lmpv::mpv_render_param_type_MPV_RENDER_PARAM_API_TYPE,
            data: api.as_ptr().cast::<c_void>().cast_mut(),
        },
        lmpv::mpv_render_param {
            type_: lmpv::mpv_render_param_type_MPV_RENDER_PARAM_INVALID,
            data: std::ptr::null_mut(),
        },
    ];
    let rc =
        unsafe { lmpv::mpv_render_context_create(&mut ctx, mpv.ctx.as_ptr(), params.as_ptr().cast_mut()) };
    if rc != 0 || ctx.is_null() {
        let msg = unsafe { std::ffi::CStr::from_ptr(lmpv::mpv_error_string(rc)) };
        return Err(format!(
            "mpv_render_context_create failed ({rc}): {}",
            msg.to_string_lossy()
        ));
    }
    Ok(ctx)
}

unsafe extern "C" fn on_render_update(cb_ctx: *mut c_void) {
    let shared = unsafe { &*(cb_ctx.cast::<SharedRender>()) };
    shared.frame_requested.store(true, Ordering::SeqCst);
}

fn set_update_callback(ctx: *mut lmpv::mpv_render_context, shared: &'static SharedRender) {
    unsafe {
        lmpv::mpv_render_context_set_update_callback(
            ctx,
            Some(on_render_update),
            (shared as *const SharedRender).cast_mut().cast(),
        );
    }
}

/// Poll the render context and present frames. Runs once per process on a
/// dedicated thread; blocks inside `mpv_render_context_render` only when mpv
/// wants to pace the frame (video FPS), idling with a short poll otherwise.
fn render_loop(rig: Arc<MetalRig>) {
    let mut buffer: Vec<u8> = Vec::new();
    let mut surface = (0u32, 0u32);
    loop {
        if !rig.shared.frame_requested.swap(false, Ordering::SeqCst) {
            std::thread::sleep(POLL_INTERVAL);
            continue;
        }
        let flags = unsafe { lmpv::mpv_render_context_update(rig.ctx) };
        if flags & UPDATE_FRAME == 0 {
            std::thread::sleep(POLL_INTERVAL);
            continue;
        }
        let (w, h) = {
            // The CAMetalLayer's live `drawableSize` is the ONLY size a present
            // may legally write: Metal allocates the next drawable's backing
            // from it, and uploading a region wider/taller raises an AGX
            // "Region width OOB" assertion (observed during resize). Fall back
            // to the layout target when the layer reports a degenerate size.
            let (dw, dh) = layer_drawable_size(rig.layer);
            if dw > 0 && dh > 0 {
                (dw, dh)
            } else {
                let lw = *rig
                    .shared
                    .size
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                lw
            }
        };
        if w == 0 || h == 0 {
            std::thread::sleep(POLL_INTERVAL);
            continue;
        }
        let (w, h) = (w as usize, h as usize);
        // 64-byte aligned stride is what mpv's SIMD path prefers.
        let stride = (w * 4 + 63) / 64 * 64;
        if surface != (w as u32, h as u32) || buffer.len() < stride * h {
            buffer = vec![0u8; stride * h];
            surface = (w as u32, h as u32);
        }

        let rc = render_into(rig.ctx, buffer.as_mut_ptr(), w, h, stride);
        rig.shared.render_error.store(rc, Ordering::SeqCst);
        if rc < 0 {
            // Renderer not ready yet (e.g. no file); back off and retry.
            std::thread::sleep(Duration::from_millis(16));
            continue;
        }

        // `bgr0`'s alpha byte is uninitialized (often 0) — force opaque or the
        // frame composites invisible over the transparent stage.
        for alpha in buffer.iter_mut().skip(3).step_by(4) {
            *alpha = 0xFF;
        }

        // A frame was produced and is being displayed: report the swap (libmpv
        // uses it for A-V sync timing).
        unsafe { lmpv::mpv_render_context_report_swap(rig.ctx) };
        if present_frame(&rig, &buffer, w, h, stride) {
            rig.shared.frames_rendered.fetch_add(1, Ordering::SeqCst);
        }
    }
}

fn render_into(
    ctx: *mut lmpv::mpv_render_context,
    buf: *mut u8,
    w: usize,
    h: usize,
    stride: usize,
) -> i32 {
    let size = [w as i32, h as i32];
    let stride_i = stride as i32;
    let fmt = c"bgr0";
    let params = [
        lmpv::mpv_render_param {
            type_: lmpv::mpv_render_param_type_MPV_RENDER_PARAM_SW_SIZE,
            data: size.as_ptr().cast_mut().cast(),
        },
        lmpv::mpv_render_param {
            type_: lmpv::mpv_render_param_type_MPV_RENDER_PARAM_SW_FORMAT,
            data: fmt.as_ptr().cast_mut().cast(),
        },
        lmpv::mpv_render_param {
            type_: lmpv::mpv_render_param_type_MPV_RENDER_PARAM_SW_STRIDE,
            data: (&stride_i as *const i32).cast_mut().cast(),
        },
        lmpv::mpv_render_param {
            type_: lmpv::mpv_render_param_type_MPV_RENDER_PARAM_SW_POINTER,
            data: buf.cast(),
        },
        lmpv::mpv_render_param {
            type_: lmpv::mpv_render_param_type_MPV_RENDER_PARAM_INVALID,
            data: std::ptr::null_mut(),
        },
    ];
    // SAFETY: all pointers are valid only for the duration of this call, and
    // `buf`/`size`/`stride` describe the allocated SW target exactly.
    unsafe { lmpv::mpv_render_context_render(ctx, params.as_ptr().cast_mut()) }
}

#[cfg(debug_assertions)]
static LAST_PRESENT_SIZE: Mutex<Option<(u32, u32)>> = Mutex::new(None);

/// Present one CPU frame through the CAMetalLayer. Returns true when the frame
/// was actually handed to the GPU (a drawable was acquired and committed).
fn present_frame(rig: &MetalRig, buf: &[u8], w: usize, h: usize, stride: usize) -> bool {
    let wx = w as u32;
    let hx = h as u32;
    #[cfg(debug_assertions)]
    {
        let mut last = LAST_PRESENT_SIZE.lock().unwrap_or_else(|p| p.into_inner());
        if *last != Some((wx, hx)) {
            *last = Some((wx, hx));
            unsafe {
                let ds: CGSizeD = msg_send![rig.layer.0, drawableSize];
                let cs: f64 = msg_send![rig.layer.0, contentsScale];
                let lf: CGRectD = msg_send![rig.layer.0, frame];
                eprintln!(
                    "[render-dbg] present: render-buf={}x{} drawableSize={}x{} contentsScale={:.2} layer-frame=({:.1},{:.1}) {:.1}x{:.1}",
                    w, h, ds.width, ds.height, cs, lf.origin.x, lf.origin.y, lf.size.width, lf.size.height
                );
            }
        }
    }
    unsafe {
        let drawable: *mut AnyObject = msg_send![rig.layer.0, nextDrawable];
        if drawable.is_null() {
            return false;
        }
        let texture: *mut AnyObject = msg_send![drawable, texture];
        if texture.is_null() {
            return false;
        }
        // Never write a region larger than the live drawable backing: a resize
        // landing between our size read and `nextDrawable` would otherwise
        // explode with an AGX "Region width OOB" assertion. Clamp to the
        // layer's current drawableSize and present the top-left crop.
        let (dw, dh) = layer_drawable_size(rig.layer);
        let rw = w.min(dw as usize);
        let rh = h.min(dh as usize);
        if rw == 0 || rh == 0 {
            return false;
        }
        let region = MTLRegion {
            origin: MTLOrigin { x: 0, y: 0, z: 0 },
            size: MTLSize {
                width: rw,
                height: rh,
                depth: 1,
            },
        };
        let _: () = msg_send![
            texture,
            replaceRegion: region,
            mipmapLevel: 0usize,
            withBytes: buf.as_ptr() as *const c_void,
            bytesPerRow: stride
        ];

        let cb: *mut AnyObject = msg_send![rig.queue.0, commandBuffer];
        if cb.is_null() {
            return false;
        }
        let _: () = msg_send![cb, presentDrawable: drawable];
        let _: () = msg_send![cb, commit];
        true
    }
}

/// The CAMetalLayer's live drawable size (`drawableSize`, backing pixels). This
/// is what the next `nextDrawable` backing is allocated at — a present may never
/// write a region larger than it.
fn layer_drawable_size(layer: ObjPtr) -> (u32, u32) {
    unsafe {
        let ds: CGSizeD = msg_send![layer.0, drawableSize];
        let w = if ds.width.is_finite() && ds.width > 0.0 {
            ds.width as u32
        } else {
            0
        };
        let h = if ds.height.is_finite() && ds.height > 0.0 {
            ds.height as u32
        } else {
            0
        };
        (w, h)
    }
}

/// Current host-view size in pixels: bounds (points) × backing scale.
fn host_size_px(app: &AppHandle) -> Result<(u32, u32, f64), String> {
    let host = session::macos_surface::host_view(app)?;
    unsafe {
        let window: *mut AnyObject = msg_send![host, window];
        // No window yet → 1:1 CSS-px==point mapping. Never assume a retina
        // scale of 2.0 ahead of the live backingScaleFactor (a scale of 1.0
        // yields a correctly-sized drawable; 2.0 would double-buffer a
        // half-sized stage into the top-left on non-retina displays).
        let scale: f64 = if window.is_null() {
            1.0
        } else {
            let s: f64 = msg_send![window, backingScaleFactor];
            if s > 0.0 { s } else { 1.0 }
        };
        let bounds: CGRectD = msg_send![host, bounds];
        let w = ((bounds.size.width * scale).round().max(1.0)) as u32;
        let h = ((bounds.size.height * scale).round().max(1.0)) as u32;
        Ok((w, h, scale))
    }
}

/// Pin the CAMetalLayer's frame (host-local, origin (0,0)) to the host NSView's
/// current bounds and clamp its content to that rect. The view is
/// **layer-hosting**: we attached a custom layer with `setLayer:`, so AppKit
/// does not manage its geometry — a frame set once at creation would leave the
/// drawable stretched across the original full-window bounds while the view
/// moved to the stage, the classic "video stuck at (0,0)/wrong rect" symptom.
fn sync_layer_frame(app: &AppHandle, layer: ObjPtr) -> Result<(), String> {
    let host = session::macos_surface::host_view(app)?;
    unsafe {
        let bounds: CGRectD = msg_send![host, bounds];
        let frame = CGRectD {
            origin: CGPointD { x: 0.0, y: 0.0 },
            size: CGSizeD {
                width: bounds.size.width.max(0.0),
                height: bounds.size.height.max(0.0),
            },
        };
        let _: () = msg_send![layer.0, setFrame: frame];
        let yes: i8 = 1;
        let _: () = msg_send![layer.0, setMasksToBounds: yes];
        let _: () = msg_send![layer.0, setNeedsDisplay];
    }
    Ok(())
}

/// Commit any implicit Core Animation transaction immediately (geometry set on
/// this tick is presented now rather than at the next run-loop flush).
fn flush_catransaction() {
    if let Some(cls) = AnyClass::get(c"CATransaction") {
        unsafe {
            let _: () = msg_send![cls, flush];
        }
    }
}

fn set_layer_geometry(layer: ObjPtr, w: u32, h: u32, scale: f64) {
    unsafe {
        let _: () = msg_send![layer.0, setContentsScale: scale];
        let size = CGSizeD {
            width: w as f64,
            height: h as f64,
        };
        let _: () = msg_send![layer.0, setDrawableSize: size];
    }
}