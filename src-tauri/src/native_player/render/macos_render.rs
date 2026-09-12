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

        // Seed the drawable size from the host's current backing-scaled bounds;
        // `mpv_set_layout` keeps it pinned to the DOM stage from here on.
        let (w, h, scale) = host_size_px(app)?;
        set_layer_geometry(layer, w, h, scale);
        *shared.size.lock().unwrap_or_else(|p| p.into_inner()) = (w, h);

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
/// `macos_surface::apply_layout`; we then correct drawable size / scale.
pub(crate) fn apply_surface_layout(app: &AppHandle, rect: &SurfaceLayout) -> Result<(), String> {
    #[cfg(debug_assertions)]
    eprintln!(
        "[mpv-set-layout] rect=({:.1},{:.1}) {:.1}x{:.1}",
        rect.x, rect.y, rect.width, rect.height
    );
    session::macos_surface::apply_layout(app, *rect)?;
    let surface = METAL_SURFACE.lock().unwrap_or_else(|p| p.into_inner()).clone();
    if let Some(rig) = surface {
        let (w, h, scale) = host_size_px(app)?;
        set_layer_geometry(rig.layer, w, h, scale);
        *rig.shared.size.lock().unwrap_or_else(|p| p.into_inner()) = (w, h);
        // A resize changes the render target — ask for a redraw even if mpv
        // didn't push a new frame (e.g. resizing while paused).
        rig.shared.frame_requested.store(true, Ordering::SeqCst);
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
        let bounds: CGRectD = msg_send![host.0, bounds];
        let _: () = msg_send![layer, setFrame: bounds];
    }
    Ok(ObjPtr(layer))
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
        let (w, h) = *rig
            .shared
            .size
            .lock()
            .unwrap_or_else(|p| p.into_inner());
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

/// Present one CPU frame through the CAMetalLayer. Returns true when the frame
/// was actually handed to the GPU (a drawable was acquired and committed).
fn present_frame(rig: &MetalRig, buf: &[u8], w: usize, h: usize, stride: usize) -> bool {
    unsafe {
        let drawable: *mut AnyObject = msg_send![rig.layer.0, nextDrawable];
        if drawable.is_null() {
            return false;
        }
        let texture: *mut AnyObject = msg_send![drawable, texture];
        if texture.is_null() {
            return false;
        }
        let region = MTLRegion {
            origin: MTLOrigin { x: 0, y: 0, z: 0 },
            size: MTLSize {
                width: w,
                height: h,
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

/// Current host-view size in pixels: bounds (points) × backing scale.
fn host_size_px(app: &AppHandle) -> Result<(u32, u32, f64), String> {
    let host = session::macos_surface::host_view(app)?;
    unsafe {
        let window: *mut AnyObject = msg_send![host, window];
        let scale: f64 = if window.is_null() {
            2.0
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