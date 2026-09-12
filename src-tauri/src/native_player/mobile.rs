//! Mobile native playback backends behind the same `MpvControl`/commands as the
//! desktop libmpv sessions. Only compiled on Android and iOS.
//!
//! There is no libmpv here: playback is owned by the platform player — Media3
//! ExoPlayer on Android, AVFoundation AVPlayer on iOS — reached through an
//! in-app Tauri mobile plugin (`zanplayer-media`) registered from `main.rs`
//! (`mobile_android.rs` / `mobile_ios.rs`). Rust drives it with synchronous
//! `run_mobile_plugin` commands, and a 250 ms ticker polls the `position`
//! command to feed the exact same coalesced `mpv-timeupdate` payload the
//! desktop tickers emit — the webview never knows or cares which engine is
//! underneath (`mpv_*` commands, `mpv-loaded`, `mpv-timeupdate`,
//! `mpv-embed-lost` all behave identically).
//!
//! The native video surface is inserted BEHIND the transparent webview on
//! first `load` (full-stage; the webview chrome floats above), so
//! `apply_surface_layout` is a deliberate no-op here — the DOM stage maps to
//! the whole window on mobile. There is no `wid` embed dance, so `mpv-embed-lost`
//! only fires if the position poll persistently fails (a dead/native player),
//! which routes the frontend to the same HTML5-blob fallback as desktop.

use crate::native_player::{
    position_clamped, snapshot_changed, MediaPlaybackState, MpvTimeUpdate, SurfaceLayout,
};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Command verbs shared with the native plugin. These strings are the method
/// names the Kotlin/Swift plugin classes expose (`@Command` / `@objc`), so they
/// must stay in sync with `src-tauri/mobile/android/MediaPlaybackPlugin.kt` and
/// `src-tauri/mobile/apple/MediaPlaybackPlugin.swift`.
const CMD_LOAD: &str = "load";
const CMD_PLAY: &str = "play";
const CMD_PAUSE: &str = "pause";
const CMD_SEEK: &str = "seek";
const CMD_VOLUME: &str = "set_volume";
const CMD_SPEED: &str = "set_speed";
const CMD_STOP: &str = "stop";
const CMD_POSITION: &str = "position";
const CMD_DIAGNOSTICS: &str = "diagnostics";

#[derive(Serialize)]
struct LoadPayload {
    path: String,
}

#[derive(Serialize)]
struct SeekPayload {
    position: f64,
}

#[derive(Serialize)]
struct VolumePayload {
    level: f64,
}

#[derive(Serialize)]
struct SpeedPayload {
    speed: f64,
}

/// Mobile native playback session behind the unified `mpv_*` command surface.
pub struct MobileSession {
    handle: tauri::plugin::PluginHandle<tauri::Wry>,
    ticking: Arc<AtomicBool>,
}

impl MobileSession {
    /// Grab the plugin handle the mobile plugin registration stashed in managed
    /// state. A `None` means registration failed at startup; erroring here lets
    /// the command layer report it and the frontend falls back to HTML5.
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let state = app.state::<MediaPlaybackState>();
        let guard = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let handle = guard.clone().ok_or_else(|| {
            "mobile media-playback plugin is not registered — falling back to HTML5".to_string()
        })?;
        Ok(Self {
            handle,
            ticking: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Start media through the platform player and drive the webview clock. A
    /// 250 ms ticker polls the native `position` command for the session's
    /// lifetime (only the first `load` spawns it; like desktop, a second `load`
    /// never spawns a duplicate thread).
    pub fn load(&self, app: &AppHandle, path: &str) -> Result<(), String> {
        self.handle
            .run_mobile_plugin::<serde_json::Value>(CMD_LOAD, LoadPayload {
                path: path.to_string(),
            })
            .map_err(|e| format!("mobile load: {e}"))?;

        if !self.ticking.swap(true, Ordering::SeqCst) {
            let handle = self.handle.clone();
            let ticking = self.ticking.clone();
            let app = app.clone();
            std::thread::spawn(move || {
                // Same coalescing contract as the desktop tickers: a beat only
                // crosses the Tauri event bridge when position moved >= epsilon
                // or paused/ended/duration changed. Mirror the native snapshot
                // through the shared clamp so a stale poll can never echo a
                // position past the clip tail.
                let mut last_snapshot: Option<MpvTimeUpdate> = None;
                while ticking.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(250));
                    let snapshot =
                        match handle.run_mobile_plugin::<MpvTimeUpdate>(CMD_POSITION, ()) {
                            Ok(s) => MpvTimeUpdate {
                                position: position_clamped(s.position, s.duration),
                                ..s
                            },
                            Err(e) => {
                                // Persistent polling failure = the native player
                                // is gone. Reuse desktop's embed-loss recovery:
                                // emit once, stop the clock, webview drops to HTML5.
                                let _ = app.emit(
                                    "mpv-embed-lost",
                                    format!("mobile position poll failed: {e}"),
                                );
                                break;
                            }
                        };
                    if snapshot_changed(&last_snapshot, &snapshot) {
                        last_snapshot = Some(snapshot.clone());
                        let _ = app.emit("mpv-timeupdate", snapshot);
                    }
                }
            });
        }

        let _ = app.emit("mpv-loaded", ());
        Ok(())
    }

    pub fn play(&self) -> Result<(), String> {
        self.handle
            .run_mobile_plugin::<serde_json::Value>(CMD_PLAY, ())
            .map_err(|e| e.to_string())
    }

    pub fn pause(&self) -> Result<(), String> {
        self.handle
            .run_mobile_plugin::<serde_json::Value>(CMD_PAUSE, ())
            .map_err(|e| e.to_string())
    }

    pub fn seek(&self, position: f64) -> Result<(), String> {
        self.handle
            .run_mobile_plugin::<serde_json::Value>(CMD_SEEK, SeekPayload { position })
            .map_err(|e| e.to_string())
    }

    pub fn set_volume(&self, level: f64) -> Result<(), String> {
        self.handle
            .run_mobile_plugin::<serde_json::Value>(CMD_VOLUME, VolumePayload { level })
            .map_err(|e| e.to_string())
    }

    pub fn set_speed(&self, speed: f64) -> Result<(), String> {
        self.handle
            .run_mobile_plugin::<serde_json::Value>(CMD_SPEED, SpeedPayload { speed })
            .map_err(|e| e.to_string())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.ticking.store(false, Ordering::SeqCst);
        self.handle
            .run_mobile_plugin::<serde_json::Value>(CMD_STOP, ())
            .map_err(|e| e.to_string())
    }

    /// One-shot playback snapshot for the diagnostics path.
    #[allow(dead_code)]
    pub fn diagnostics(&self) -> String {
        match self
            .handle
            .run_mobile_plugin::<serde_json::Value>(CMD_DIAGNOSTICS, ())
        {
            Ok(v) => v
                .get("diagnostics")
                .and_then(|s| s.as_str())
                .unwrap_or("<no diagnostics payload>")
                .to_string(),
            Err(e) => format!("<mobile diagnostics unavailable: {e}>"),
        }
    }
}

/// Mobile native surfaces fill the whole window behind the transparent webview,
/// so there is nothing to anchor onto the DOM stage — the service stays a no-op
/// to keep the `mpv_set_layout` contract uniform across every backend.
pub(crate) fn apply_surface_layout(_app: &AppHandle, _rect: &SurfaceLayout) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payloads_serialize_with_expected_field_names() {
        // The Kotlin/Swift plugin parses args by these exact keys.
        let load = serde_json::to_value(LoadPayload {
            path: "/media/video.mp4".into(),
        })
        .unwrap();
        assert_eq!(load["path"], "/media/video.mp4");

        let seek = serde_json::to_value(SeekPayload { position: 12.5 }).unwrap();
        assert_eq!(seek["position"], 12.5);

        let volume = serde_json::to_value(VolumePayload { level: 42.0 }).unwrap();
        assert_eq!(volume["level"], 42.0);

        let speed = serde_json::to_value(SpeedPayload { speed: 1.5 }).unwrap();
        assert_eq!(speed["speed"], 1.5);
    }
}