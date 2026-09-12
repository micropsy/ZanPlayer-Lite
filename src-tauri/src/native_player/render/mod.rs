//! macOS-native playback via the libmpv **Render API** (cargo features
//! `native-player` + `macos-render`, macOS only).
//!
//! This is the backend that replaces the window-VO `wid` embed on macOS, which
//! is deliberately never enabled there (mpv can still detach a top-level Metal
//! window even when `wid` points at a valid NSView).
#[cfg(all(target_os = "macos", feature = "macos-render"))]
mod macos_render;

#[cfg(all(target_os = "macos", feature = "macos-render"))]
pub(crate) use macos_render::{apply_surface_layout, RenderSession};