//! Android registration for the in-app `zanplayer-media` plugin (Android only).
//!
//! The Kotlin counterpart (`MediaPlaybackPlugin.kt`) is NOT part of this crate;
//! it lives at `src-tauri/mobile/android/` and is copied into the generated
//! Android project during a mobile build/init (see `src-tauri/mobile/README.md`).
//!
//! Registration failures never abort app startup: the slot is left `None`, the
//! session reports "not registered", and the frontend falls back to HTML5.

use tauri::{plugin::Builder, Manager, Runtime};

/// `TauriPlugin` to hand to `tauri::Builder::plugin(...)`. Registers the native
/// Kotlin plugin by its package-qualified class and stashes the bridge handle
/// in `super::MediaPlaybackState` for `MobileSession` to clone.
pub(crate) fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    Builder::new("zanplayer-media")
        .setup(|app, api| {
            match api.register_android_plugin(
                "com.micropsy.zanplayer_lite",
                "MediaPlaybackPlugin",
            ) {
                Ok(handle) => {
                    let state = app.state::<super::MediaPlaybackState>();
                    *state
                        .0
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(handle);
                    Ok(())
                }
                Err(e) => {
                    eprintln!("[zanplayer-mobile] android plugin registration failed: {e}");
                    Ok(())
                }
            }
        })
        .build()
}