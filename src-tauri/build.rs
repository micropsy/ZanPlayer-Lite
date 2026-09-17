fn main() {
    tauri_build::build();

    // The `vlc-native` feature links the system LibVLC (`libvlc`) — the C
    // engine VLCKit wraps. dlopen-free direct linking needs the dylib on both
    // the link path AND the runtime rpath, so we resolve the install here:
    //
    //   * macOS   -> `VLC_PREFIX` env override, else the dylibs bundled in
    //                /Applications/VLC.app (Contents/MacOS/lib). Their install
    //                name is `@rpath/libvlc.dylib`, so a matching -rpath must
    //                be embedded at link time for the running app to find it.
    //   * Linux   -> pkg-config `libvlc` probe (then `VLC_LIB_DIR` override).
    //   * Windows -> `VLC_LIB_DIR` dir containing libvlc.dll + libvlccore.dll.
    if std::env::var("CARGO_FEATURE_VLC_NATIVE").is_err() {
        return;
    }

    #[cfg(target_os = "macos")]
    {
        let candidate = std::env::var("VLC_PREFIX").ok().filter(|p| !p.is_empty());
        let dir = match candidate {
            Some(prefix) => {
                // Allow pointing at either the prefix or the concrete lib dir.
                let lib = std::path::Path::new(&prefix).join("lib");
                if std::path::Path::new(&lib).join("libvlc.dylib").exists() {
                    lib
                } else {
                    std::path::PathBuf::from(&prefix)
                }
            }
            None => std::path::PathBuf::from("/Applications/VLC.app/Contents/MacOS/lib"),
        };
        if !dir.join("libvlc.dylib").exists() {
            panic!(
                "vlc-native: libvlc not found at {} — install VLC.app or set VLC_PREFIX to a dir containing libvlc.dylib",
                dir.display()
            );
        }
        println!("cargo:rustc-link-search=native={}", dir.display());
        println!("cargo:rustc-link-lib=dylib=vlc");
        // @rpath/libvlc.dylib install name: without this the binary links but
        // the running app fails to load the dylib at startup.
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dir.display());
        println!("cargo:rerun-if-env-changed=VLC_PREFIX");
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(library) = pkg_config::Config::new().probe("libvlc") {
            for path in library.link_paths {
                println!("cargo:rustc-link-search=native={}", path.display());
            }
            println!("cargo:rustc-link-lib=vlc");
            return;
        }
        if let Ok(dir) = std::env::var("VLC_LIB_DIR") {
            println!("cargo:rustc-link-search=native={dir}");
            println!("cargo:rustc-link-lib=vlc");
        }
        println!("cargo:rerun-if-env-changed=VLC_LIB_DIR");
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(dir) = std::env::var("VLC_LIB_DIR") {
            println!("cargo:rustc-link-search=native={dir}");
            println!("cargo:rustc-link-lib=libvlc");
        }
        println!("cargo:rerun-if-env-changed=VLC_LIB_DIR");
    }
}