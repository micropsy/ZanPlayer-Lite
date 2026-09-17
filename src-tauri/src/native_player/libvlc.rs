//! Raw LibVLC C API bindings, declared locally with no crate dependency.
//!
//! This is the engine VLCKit wraps: the `libvlc` C library. We link the
//! system libvlc (see `build.rs` for discovery/rpath), embed VLC's video
//! output into a native host view below the transparent webview, and drive it
//! through the small safe [`VlcPlayer`] wrapper.
//!
//! Feature `vlc-native` only.

use std::ffi::{CStr, CString, c_char, c_float, c_int, c_uint, c_void};
use std::ptr;

/// libvlc media player states (`libvlc_state_t`).
pub const STATE_NOTHING_SPECIAL: c_int = 0;
pub const STATE_OPENING: c_int = 1;
pub const STATE_BUFFERING: c_int = 2;
pub const STATE_PLAYING: c_int = 3;
pub const STATE_PAUSED: c_int = 4;
pub const STATE_STOPPED: c_int = 5;
pub const STATE_ENDED: c_int = 6;
pub const STATE_ERROR: c_int = 7;

#[repr(C)]
#[derive(Copy, Clone)]
pub struct libvlc_instance_t {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct libvlc_media_t {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct libvlc_media_player_t {
    _private: [u8; 0],
}

// SAFETY: libvlc types are opaque handles with thread-safe API access
// (libvlc synchronizes internally); we additionally serialize all access
// through the single owning thread in the session.
unsafe impl Send for libvlc_instance_t {}
unsafe impl Sync for libvlc_instance_t {}
unsafe impl Send for libvlc_media_t {}
unsafe impl Sync for libvlc_media_t {}
unsafe impl Send for libvlc_media_player_t {}
unsafe impl Sync for libvlc_media_player_t {}

// No #[link] attribute: the linker flag (`-lvlc` / `-ldylib=vlc`) is emitted
// by build.rs so the search path + rpath accompany it.
extern "C" {
    fn libvlc_new(argc: c_int, argv: *const *const c_char) -> *mut libvlc_instance_t;
    fn libvlc_release(inst: *mut libvlc_instance_t);
    fn libvlc_media_new_path(inst: *mut libvlc_instance_t, path: *const c_char) -> *mut libvlc_media_t;
    fn libvlc_media_release(md: *mut libvlc_media_t);
    fn libvlc_media_player_new(inst: *mut libvlc_instance_t) -> *mut libvlc_media_player_t;
    fn libvlc_media_player_set_media(mp: *mut libvlc_media_player_t, md: *mut libvlc_media_t);
    fn libvlc_media_player_release(mp: *mut libvlc_media_player_t);
    fn libvlc_media_player_play(mp: *mut libvlc_media_player_t) -> c_int;
    fn libvlc_media_player_pause(mp: *mut libvlc_media_player_t);
    fn libvlc_media_player_stop(mp: *mut libvlc_media_player_t);
    fn libvlc_media_player_set_time(mp: *mut libvlc_media_player_t, time: i64);
    fn libvlc_media_player_get_time(mp: *mut libvlc_media_player_t) -> i64;
    fn libvlc_media_player_get_length(mp: *mut libvlc_media_player_t) -> i64;
    fn libvlc_media_player_set_rate(mp: *mut libvlc_media_player_t, rate: c_float) -> c_int;
    fn libvlc_media_player_get_rate(mp: *mut libvlc_media_player_t) -> c_float;
    fn libvlc_media_player_get_state(mp: *mut libvlc_media_player_t) -> c_int;
    fn libvlc_media_player_is_playing(mp: *mut libvlc_media_player_t) -> c_int;
    fn libvlc_media_player_has_vout(mp: *mut libvlc_media_player_t) -> c_uint;
    fn libvlc_audio_set_volume(mp: *mut libvlc_media_player_t, volume: c_int) -> c_int;
    fn libvlc_audio_get_volume(mp: *mut libvlc_media_player_t) -> c_int;
    fn libvlc_video_set_spu(mp: *mut libvlc_media_player_t, i_spu: c_int) -> c_int;
    #[cfg(target_os = "macos")]
    fn libvlc_video_set_key_input(mp: *mut libvlc_media_player_t, on: c_uint);
    #[cfg(target_os = "macos")]
    fn libvlc_video_set_mouse_input(mp: *mut libvlc_media_player_t, on: c_uint);
    #[cfg(target_os = "macos")]
    fn libvlc_media_player_set_nsobject(mp: *mut libvlc_media_player_t, drawable: *mut c_void);
    #[cfg(target_os = "windows")]
    fn libvlc_media_player_set_hwnd(mp: *mut libvlc_media_player_t, drawable: *mut c_void);

    #[cfg(all(unix, not(target_os = "macos")))]
    fn libvlc_media_player_set_xwindow(mp: *mut libvlc_media_player_t, drawable: c_ulong);

    fn libvlc_get_version() -> *const c_char;
}

pub fn version() -> String {
    // SAFETY: libvlc_get_version returns a static string.
    unsafe { CStr::from_ptr(libvlc_get_version()) }
        .to_string_lossy()
        .into_owned()
}

/// A live owned instance + media player pair. Drop releases both.
pub struct VlcPlayer {
    instance: *mut libvlc_instance_t,
    player: *mut libvlc_media_player_t,
    /// The media handle is owned by the player (libvlc_media_player_new_from_media
    /// retains it), so we do not refcount it separately.
    media_set: bool,
}

// SAFETY: libvlc's API is documented thread-safe, so sharing handles across
// threads (the session ticker + Tauri command handlers) is sound as long as
// each libvlc call happens under the session's exclusive lock.
unsafe impl Send for VlcPlayer {}
unsafe impl Sync for VlcPlayer {}

/// libvlc locates its plugins by probing the directory that holds
/// libvlccore; inside the VLC.app bundle that is Contents/MacOS/lib while the
/// plugins actually live one level up at Contents/MacOS/plugins. Mirrors the
/// `build.rs` discovery so the runtime `--plugin-path` matches the link rpath.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn vlc_plugin_dir() -> Option<std::path::PathBuf> {
    if let Some(dir) = std::env::var_os("VLC_PLUGIN_DIR") {
        return Some(std::path::PathBuf::from(dir));
    }
    let lib_dir = std::env::var_os("VLC_PREFIX").map(std::path::PathBuf::from).or_else(|| {
        let default = std::path::PathBuf::from("/Applications/VLC.app/Contents/MacOS/lib");
        if default.exists() {
            Some(default)
        } else {
            std::env::var_os("VLC_LIB_DIR").map(std::path::PathBuf::from)
        }
    })?;
    let plugin = lib_dir.join("../plugins");
    if plugin.exists() {
        Some(plugin)
    } else {
        None
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn vlc_plugin_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("VLC_PLUGIN_DIR").map(std::path::PathBuf::from)
}

impl VlcPlayer {
    /// Creates a libvlc instance with subtitle rendering left to the DOM
    /// overlay: we never autodetect filesystem subtitles (the webview draws
    /// captions/transcriptions) and we explicitly disable the SPU track so
    /// VLC's text output can't double with the webview's.
    pub fn new() -> Result<Self, String> {
        // libvlc locates its plugins via VLC_PLUGIN_PATH; inside the VLC.app
        // bundle the plugins live at Contents/MacOS/plugins while the dylibs sit
        // in Contents/MacOS/lib, so without pointing at them libvlc_new fails.
        // (The historical `--plugin-path` CLI option was removed in modern VLC.)
        if let Some(plugin_dir) = vlc_plugin_dir() {
            std::env::set_var("VLC_PLUGIN_PATH", plugin_dir);
        }
        let args: Vec<CString> = vec![
            CString::new("zanplayer-lite").unwrap(),
            CString::new("--no-video-title-show").unwrap(),
            CString::new("--no-sub-autodetect-file").unwrap(),
        ];
        let argv: Vec<*const c_char> = args.iter().map(|a| a.as_ptr()).collect();
        // SAFETY: argv is a valid null-terminated list of C strings.
        let instance = unsafe { libvlc_new(args.len() as c_int, argv.as_ptr()) };
        if instance.is_null() {
            return Err("failed to create libvlc instance".into());
        }
        // One player for the session's lifetime: `load` swaps media via
        // `libvlc_media_player_set_media` so the embed drawable and input
        // settings (`set_nsobject`, key/mouse input) survive track changes.
        let player = unsafe { libvlc_media_player_new(instance) };
        if player.is_null() {
            unsafe { libvlc_release(instance) };
            return Err("failed to create libvlc media player".into());
        }
        Ok(Self {
            instance,
            player,
            media_set: false,
        })
    }

    /// Sets the libvlc instance's video output window and disables VLC's own
    /// event grabbers (the DOM chrome above it owns clicks/keys).
    ///
    /// `drawable` is an opaque native handle:
    /// - macOS: the host NSView (`*mut c_void`).
    /// - Windows: an HWND.
    /// - X11: a Window id.
    pub fn set_drawable(&mut self, drawable: *mut c_void) {
        // SAFETY: drawable is a valid native window for this platform.
        unsafe {
            #[cfg(target_os = "macos")]
            {
                libvlc_media_player_set_nsobject(self.player, drawable);
                libvlc_video_set_key_input(self.player, 0);
                libvlc_video_set_mouse_input(self.player, 0);
            }
            #[cfg(target_os = "windows")]
            {
                libvlc_media_player_set_hwnd(self.player, drawable);
            }
            #[cfg(all(unix, not(target_os = "macos")))]
            {
                libvlc_media_player_set_xwindow(self.player, drawable as c_ulong);
            }
        }
    }

    pub fn load(&mut self, path: &str) -> Result<(), String> {
        let c_path = CString::new(path).map_err(|_| "path contains NUL byte".to_string())?;
        // SAFETY: instance and c_path are valid C strings.
        let media = unsafe { libvlc_media_new_path(self.instance, c_path.as_ptr()) };
        if media.is_null() {
            return Err("libvlc could not open media path".into());
        }
        // SAFETY: media is a valid handle; set_media retains it (the player
        // holds our reference), then our own refcount is released.
        unsafe { libvlc_media_player_set_media(self.player, media) };
        unsafe { libvlc_media_release(media) };
        self.media_set = true;
        // Disable VLC's own subtitle rendering (webview owns captions).
        // SAFETY: player is valid after construction.
        unsafe { libvlc_video_set_spu(self.player, -1) };
        Ok(())
    }

    pub fn has_media(&self) -> bool {
        self.media_set && !self.player.is_null()
    }

    /// Blocks until the media is loaded / had a chance to error, or the
    /// timeout elapses. Returns Ok(true) if the media transitioned out of
    /// NothingSpecial/Opening. NOTE: does not guarantee the file is decodable
    /// — the frontend caret sees the clock advance for that.
    pub fn wait_loaded(&self, timeout: std::time::Duration) -> bool {
        let started = std::time::Instant::now();
        loop {
            let state = self.state();
            if state != STATE_NOTHING_SPECIAL && state != STATE_OPENING {
                return state != STATE_ERROR;
            }
            if started.elapsed() >= timeout {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    pub fn play(&self) {
        // SAFETY: player valid.
        unsafe { libvlc_media_player_play(self.player) };
    }

    pub fn pause(&self) {
        // SAFETY: player valid.
        unsafe { libvlc_media_player_pause(self.player) };
    }

    pub fn stop(&self) {
        // SAFETY: player valid.
        unsafe { libvlc_media_player_stop(self.player) };
    }

    pub fn seek_ms(&self, ms: i64) {
        // SAFETY: player valid.
        unsafe { libvlc_media_player_set_time(self.player, ms) };
    }

    pub fn time_ms(&self) -> i64 {
        // SAFETY: player valid.
        unsafe { libvlc_media_player_get_time(self.player) }
    }

    pub fn length_ms(&self) -> i64 {
        // SAFETY: player valid.
        unsafe { libvlc_media_player_get_length(self.player) }
    }

    pub fn is_playing(&self) -> bool {
        // SAFETY: player valid.
        unsafe { libvlc_media_player_is_playing(self.player) != 0 }
    }

    pub fn state(&self) -> c_int {
        // SAFETY: player valid.
        unsafe { libvlc_media_player_get_state(self.player) }
    }

    pub fn has_vout(&self) -> bool {
        // SAFETY: player valid.
        unsafe { libvlc_media_player_has_vout(self.player) > 0 }
    }

    pub fn set_volume(&self, percent: i32) {
        // SAFETY: player valid. libvlc expects 0..=100.
        unsafe { libvlc_audio_set_volume(self.player, percent.clamp(0, 100)) };
    }

    pub fn get_volume(&self) -> i32 {
        // SAFETY: player valid.
        unsafe { libvlc_audio_get_volume(self.player) }
    }

    pub fn set_rate(&self, rate: f32) {
        // SAFETY: player valid.
        unsafe { libvlc_media_player_set_rate(self.player, rate) };
    }

    pub fn get_rate(&self) -> f32 {
        // SAFETY: player valid.
        unsafe { libvlc_media_player_get_rate(self.player) }
    }
}

impl Drop for VlcPlayer {
    fn drop(&mut self) {
        if !self.player.is_null() {
            // SAFETY: player valid.
            unsafe { libvlc_media_player_stop(self.player) };
            // SAFETY: player valid.
            unsafe { libvlc_media_player_release(self.player) };
        }
        if !self.instance.is_null() {
            // SAFETY: instance valid.
            unsafe { libvlc_release(self.instance) };
        }
    }
}

impl Default for VlcPlayer {
    fn default() -> Self {
        Self {
            instance: ptr::null_mut(),
            player: ptr::null_mut(),
            media_set: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_reports_libvlc() {
        assert!(!version().is_empty(), "libvlc_get_version must not be empty");
    }

    #[test]
    fn new_instance_and_drop_are_stable() {
        let vlv = VlcPlayer::new().expect("libvlc instance must initialize");
        drop(vlv);
    }
}