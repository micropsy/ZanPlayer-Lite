# ZanPlayer Lite Roadmap

This checklist tracks the remaining work for a reliable all-platform player.
Tasks should be completed in priority order. Do not mark a task complete until
its acceptance criteria and platform verification are satisfied.

## Status Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Verified complete
- `[!]` Blocked or needs a platform prerequisite

## P0 - Release Blockers

### 1. Verify Mobile Native Playback

- [ ] Run `npx tauri android init` and generate `src-tauri/gen/android`.
- [ ] Copy and integrate the Media3 plugin into the generated Android project.
- [ ] Add and resolve Media3 ExoPlayer/UI dependencies.
- [ ] Build and run on a real Android device.
- [ ] Verify MP4/H.264, MP3, WAV, M4A/AAC, WebM and unsupported-codec fallback.
- [ ] Verify play, pause, seek, volume, speed, ended state and lifecycle resume.
- [ ] Run `npx tauri ios init` and generate `src-tauri/gen/apple`.
- [ ] Copy and integrate the AVFoundation plugin into the generated iOS project.
- [ ] Build and run on a real iPhone and iPad.
- [ ] Verify MP4/MOV, H.264/H.265, MP3, WAV, M4A/AAC and unsupported-format fallback.
- [ ] Verify rotation, split view, background/foreground and interruption handling.

Acceptance: Android and iOS/iPadOS native playback works on real devices, and
any initialization or codec failure falls back to HTML5 without an external
player window.

### 2. Verify Desktop Native Playback

- [x] Verify macOS Render API + software render + CAMetalLayer smoke path.
- [ ] Run the full macOS smoke test with a real video and audio file.
- [ ] Build and test Windows native mpv playback.
- [ ] Build and test Linux X11 native mpv playback.
- [ ] Verify Linux Wayland HTML5 fallback and document z-order limitations.
- [ ] Verify resize, sidebar changes, fullscreen and captions on each desktop.

Acceptance: native playback stays inside the app window; no detached window is
created; HTML5 fallback preserves the current position and playback settings.

### 3. Media Format Compatibility Matrix

- [ ] Test MP4/H.264/AAC.
- [ ] Test MOV/H.265.
- [ ] Test MKV with supported and unsupported codecs.
- [ ] Test WebM/VP8/VP9.
- [ ] Test AVI, WMV and FLV.
- [ ] Test MP3, WAV, OGG, FLAC, M4A, AAC and WMA.
- [ ] Record results per platform instead of claiming universal codec support.
- [ ] Show a clear unsupported-format error before or during fallback.

Acceptance: file picker, drag/drop, native backend and HTML5 fallback use the
same centralized media-format catalog.

## P1 - Subtitle and Playback Quality

### 4. Validate Local AI Pipeline

- [ ] Verify local Whisper model download and offline startup.
- [ ] Verify VAD-gated streaming transcription.
- [ ] Verify batch transcription.
- [ ] Verify Original, English and Both output modes.
- [ ] Verify dual-pass progress and generated track separation.
- [ ] Verify long-video memory and CPU usage.
- [ ] Use Tiny/Base as mobile defaults and avoid loading duplicate contexts.

Acceptance: local transcription works without network access after the model is
available and does not block normal playback.

### 5. Validate PTS Sync and Seeking

- [ ] Verify subtitle timestamps against the active player clock.
- [ ] Verify seek purges stale render-queue cues.
- [ ] Verify streaming transcription repositions its audio reader after seek.
- [ ] Verify resume-from-history does not create a stale subtitle jump.
- [ ] Verify pause, end-of-file and duration changes across every backend.

Acceptance: after any seek, only cues for the new playhead position are shown.

### 6. Validate Subtitle UI and Export

- [ ] Verify Original/English/Both subtitle display.
- [ ] Verify subtitle style, position, outline, background and font settings.
- [ ] Verify captions remain above native video layers.
- [ ] Verify SRT and VTT export for loaded and generated tracks.
- [ ] Verify subtitle editor seek uses the same native seek funnel.

Acceptance: captions, OSD, controls and quick settings remain usable above the
video on every supported native backend.

## P1 - Web App and Installation

### 7. Add Web App Install Support (PWA)

- [x] Add a web app manifest with name, short name, icons, theme colors and display mode.
- [x] Add 192px and 512px install icons.
- [x] Add a service worker for app-shell caching and offline startup behavior.
- [x] Register the service worker only in production/web builds.
- [x] Add install capability detection for Chrome/Edge Android and desktop.
- [x] Add an install action in the UI only when the browser supports installation.
- [ ] Verify iOS/iPadOS Add to Home Screen behavior and safe-area layout (needs a real device).
- [x] Document that browser Web App playback uses HTML5 and browser codec support.
- [x] Keep local Whisper model storage and permissions explicit for the Web App.

Acceptance: the Web App can be installed from a supported browser, opens in a
standalone window, retains the app shell offline, and never claims native mpv,
Media3 or AVFoundation support.

### 8. Web Playback and Browser Compatibility

- [ ] Test Chrome/Edge desktop.
- [ ] Test Safari macOS/iOS/iPadOS.
- [ ] Test Firefox desktop.
- [ ] Verify local file selection, audio playback and subtitle rendering.
- [ ] Verify browser codec fallback messaging.
- [ ] Verify Web App storage limits for local Whisper models.

Acceptance: unsupported browser capabilities produce a clear fallback message
and do not break normal HTML5 playback.

## P2 - Performance, Security and Release

### 9. Performance and Resource Limits

- [ ] Add model-memory and transcription-job cancellation guards.
- [ ] Bound subtitle render-queue size for long videos.
- [ ] Pause or reduce transcription work when the app is backgrounded.
- [ ] Measure CPU, RAM, battery and frame presentation on mobile.
- [ ] Verify native render thread cleanup on stop and app shutdown.

### 10. Security and File Handling

- [ ] Review Android content URI permissions and security-scoped iOS URLs.
- [ ] Avoid unnecessary storage permissions.
- [ ] Validate paths before handing them to FFmpeg, Whisper or native players.
- [ ] Verify external URLs are not accepted unintentionally by local-file flows.

### 11. Documentation and Release Matrix

- [x] Update README with platform/backend support and verification status.
- [x] Document Android JDK/SDK and iOS Xcode prerequisites.
- [x] Document PWA installation and browser limitations.
- [ ] Publish a tested media-format matrix.
- [x] Run `npm run build`.
- [x] Run `npm run test`.
- [x] Run `cargo test`.
- [x] Run `cargo test --features native-player,macos-render` on macOS.
- [x] Run platform builds where toolchains are available (macOS `app,dmg` release build verified locally; signing needs the CI `TAURI_SIGNING_PRIVATE_KEY`).
- [x] Mark untested platforms as unverified instead of claiming support.

Acceptance: release notes clearly distinguish implemented, device-tested and
unsupported functionality.

## Recommended Execution Order

1. Mobile Android/iOS real-device integration and verification.
2. Desktop Windows/Linux native verification.
3. Media compatibility matrix and fallback messaging.
4. Subtitle PTS/seek and dual-pass validation.
5. Web App/PWA manifest, service worker and install flow.
6. Performance, security, documentation and release checks.