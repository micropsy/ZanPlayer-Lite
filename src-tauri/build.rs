fn main() {
    tauri_build::build();

    // The `native-player` feature links the system libmpv. `libmpv-sys` only
    // emits `cargo:rustc-link-lib=mpv` with no search path, which misses the
    // Homebrew dylib on Apple Silicon. Surface the pkg-config link path here
    // (and fall back to an explicit `MPV_LIB_DIR` for CI without a .pc file).
    if std::env::var("CARGO_FEATURE_NATIVE_PLAYER").is_ok() {
        if let Ok(library) = pkg_config::Config::new().probe("mpv") {
            for path in library.link_paths {
                println!("cargo:rustc-link-search=native={}", path.display());
            }
            return;
        }
        if let Ok(dir) = std::env::var("MPV_LIB_DIR") {
            println!("cargo:rustc-link-search=native={dir}");
        }
    }
}