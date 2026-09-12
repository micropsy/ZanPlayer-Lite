//! iOS registration for the in-app `zanplayer-media` plugin (iOS only).
//!
//! The Swift counterpart (`MediaPlaybackPlugin.swift`) is NOT part of this
//! crate; it lives at `src-tauri/mobile/apple/` and is added to the generated
//! iOS app target (see `src-tauri/mobile/README.md`). The `@_cdecl("init_zanplayer_media")`
//! symbol there must match the binding name below.
//!
//! Registration failures never abort app startup: the slot is left `None`, the
//! session reports "not registered", and the frontend falls back to HTML5.

use tauri::{plugin::Builder, Manager};

tauri::ios_plugin_binding!(init_zanplayer_media);

/// `TauriPlugin` to hand to `tauri::Builder::plugin(...)`. Bridges to the Swift
/// `init_zanplayer_media()` cdecl, which returns the retained `MediaPlaybackPlugin`
/// instance, then stashes the bridge handle in `super::MediaPlaybackState`.
pub(crate) fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    Builder::new("zanplayer-media")
        .setup(|app, api| {
            match api.register_ios_plugin(init_zanplayer_media) {
                Ok(handle) => {
                    let state = app.state::<super::MediaPlaybackState>();
                    *state
                        .0
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(handle);
                    Ok(())
                }
                Err(e) => {
                    eprintln!("[zanplayer-mobile] ios plugin registration failed: {e}");
                    Ok(())
                }
            }
        })
        .build()
}