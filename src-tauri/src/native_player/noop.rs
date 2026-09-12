use tauri::AppHandle;

use crate::native_player::SurfaceLayout;

/// Feature-disabled stand-in for `MpvSession`. Every method resolves to an
/// error (or a harmless no-op for `stop`), keeping the command surface stable
/// so the frontend can always call into it and observe "not available".
pub struct NoopSession;

/// No native surface exists in this build, so there is nothing to re-anchor.
pub fn apply_surface_layout(_app: &AppHandle, _rect: &SurfaceLayout) -> Result<(), String> {
    Err("Native player (libmpv) is not enabled in this build".to_string())
}

impl NoopSession {
    pub fn load(&self, _app: &AppHandle, _path: &str) -> Result<(), String> {
        Err("Native player (libmpv) is not enabled in this build".to_string())
    }

    pub fn play(&self) -> Result<(), String> {
        Err("Native player (libmpv) is not enabled in this build".to_string())
    }

    pub fn pause(&self) -> Result<(), String> {
        Err("Native player (libmpv) is not enabled in this build".to_string())
    }

    pub fn seek(&self, _position: f64) -> Result<(), String> {
        Err("Native player (libmpv) is not enabled in this build".to_string())
    }

    pub fn set_volume(&self, _level: f64) -> Result<(), String> {
        Err("Native player (libmpv) is not enabled in this build".to_string())
    }

    pub fn set_speed(&self, _speed: f64) -> Result<(), String> {
        Err("Native player (libmpv) is not enabled in this build".to_string())
    }

    pub fn stop(&self) -> Result<(), String> {
        Ok(())
    }
}