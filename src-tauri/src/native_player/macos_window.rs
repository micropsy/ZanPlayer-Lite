//! macOS window dragging for the title-bar chrome drag region.
//!
//! WKWebView does NOT honor `-webkit-app-region: drag` (a Chromium/Electron
//! extension — there is no WebKit-native drag region), and Tauri's JS
//! `startDragging()` → tao `drag_window()` reads `NSApp.currentEvent` on the
//! main thread to feed `performWindowDragWithEvent:`. Once the FOCUSED webview
//! has consumed the mousedown into its own tracking session, no current event
//! survives to the (asynchronous) IPC time — so the window silently cannot be
//! dragged exactly when the app is active/focused (the field-reported bug).
//!
//! Unlike tao, this module never trusts `currentEvent`: it synthesizes a fresh
//! LeftMouseDown `NSEvent` at the live cursor location (the same synthesis tao
//! itself uses for its drag path) and hands it to `performWindowDragWithEvent:` —
//! the documented way to start a window drag. AppKit runs its whole drag loop
//! (menu-bar confinement, edge snap) on that event, focused or not.
//!
//! This is compiled in EVERY build (including the shipped feature-off ones) —
//! the drag region is chrome behavior, not a native-player feature.

use objc2::encode::{Encode, Encoding};
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};
use tauri::{AppHandle, Manager};

const NSEVENT_TYPE_LEFT_MOUSE_DOWN: isize = 1;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct NSPoint {
    x: f64,
    y: f64,
}

// SAFETY: NSPoint is `{CGPoint=dd}` on Darwin; sizeof/align of the repr(C)
// struct match, so `msg_send!` can marshal it to/from the ObjC ABI by value.
unsafe impl Encode for NSPoint {
    const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}

/// Raw `*mut c_void` that is `Send`: it is only ever dereferenced inside the
/// AppKit main-thread closure (`msg_send!` dispatch), never on the command/IPC
/// thread that hands the handle over — the same discipline `macos_surface`
/// uses for its leaked view pointers.
#[derive(Clone, Copy)]
struct WinPtr(*mut std::ffi::c_void);
// SAFETY: the pointee is owned by AppKit for the process lifetime and only
// messaged on the main thread; the pointer value itself is thread-safe.
unsafe impl Send for WinPtr {}

/// Start a top-bar window drag. Dispatched to the AppKit main thread — a
/// `performWindowDragWithEvent:` runs a modal drag loop and must never touch
/// the view hierarchy off the main thread.
pub fn start_window_drag(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main webview window not found".to_string())?;
    let ns_window = window.ns_window().map_err(|e| e.to_string())?;
    let handle = WinPtr(ns_window);
    app.run_on_main_thread(move || {
        if let Err(e) = perform_window_drag(handle) {
            eprintln!("[window-drag] failed: {e}");
        }
    })
    .map_err(|e| format!("failed to schedule window drag on the main thread: {e}"))?;
    Ok(())
}

fn perform_window_drag(handle: WinPtr) -> Result<(), String> {
    let ns_window: *mut std::ffi::c_void = handle.0;
    unsafe {
        let ns_window: *mut AnyObject = ns_window.cast();
        let nsevent = AnyClass::get(c"NSEvent")
            .ok_or_else(|| "NSEvent class not registered with the Objective-C runtime".to_string())?;
        // Live cursor position (global screen coordinates): the drag starts
        // where the user actually pressed instead of a stale/inferred point.
        let location: NSPoint = msg_send![nsevent, mouseLocation];
        let window_number: isize = msg_send![ns_window, windowNumber];
        let no_context: *mut AnyObject = std::ptr::null_mut();
        let event: *mut AnyObject = msg_send![
            nsevent,
            mouseEventWithType: NSEVENT_TYPE_LEFT_MOUSE_DOWN,
            location: location,
            modifierFlags: 0usize,
            timestamp: 0.0,
            windowNumber: window_number,
            context: no_context,
            eventNumber: 0isize,
            clickCount: 1isize,
            pressure: 1.0
        ];
        if event.is_null() {
            return Err("failed to synthesize a left-mouse-down event".into());
        }
        let _: () = msg_send![ns_window, performWindowDragWithEvent: event];
    }
    Ok(())
}