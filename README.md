# ZanPlayer Lite

[![Build](https://github.com/micropsy/ZanPlayer-Lite/actions/workflows/build.yml/badge.svg)](https://github.com/micropsy/ZanPlayer-Lite/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/github/license/micropsy/ZanPlayer-Lite.svg)](https://opensource.org/licenses/MIT)

**ZanPlayer Lite** is a modern, beautiful desktop video player with **local, offline, AI-powered subtitle generation** — built with Tauri 2, React 19, TypeScript, and Tailwind CSS v4.

**100% offline, 100% native, 100% local.** Every transcription *and* translation runs on your machine through a single bundled **Native Whisper Core** — `whisper-rs` (whisper.cpp). There are **zero Python or external ML dependencies**, no cloud calls, and no API keys. The only moving pieces are the Whisper model files you download from Settings and a bundled FFmpeg sidecar for audio extraction.

## Architecture — Native Whisper Core & Dual-Pass Inference

Everything below executes on your machine, on native threads:

- **Native Whisper Core** — speech recognition *and* translation both use `whisper-rs` (whisper.cpp). Models are downloaded from Settings and run locally.
- **Dual-Pass Inference** — whisper.cpp cannot emit the original language and an English translation in a single pass, so ZanPlayer Lite runs one or two passes over the *same* 16 kHz mono audio buffer (extracted by the bundled FFmpeg sidecar):
  - **Original Only** → `params.translate = false` (source-language captions)
  - **English Only** → `params.translate = true` (whisper's translate task)
  - **Both (Dual)** → two passes tagged `original` / `translation`; the UI render queue merges their (PTS-synced) cues into stacked dual subtitles
  - The English target is never hardcoded — the pass plan follows the selected output mode, and the **Spoken Audio (Source)** selector pins whisper's language token to prevent hallucinations on low-resource languages (e.g. Burmese).
- **VAD-gated streaming** — `silero-vad-pure` detects speech utterances and feeds them to whisper in chunks, so cues stream in live while you watch.
- **Seek-aware streaming** — jump the playhead (seek bar, `←`/`→`, or click-to-seek) and every live pass drops its current VAD/utterance state, repositions the WAV reader to the new timestamp, and resumes from there — stale pre-seek audio is never decoded.
- **Two generation strategies** (see below).

## Features

### Player
- 🎬 Modern video/audio player with seek bar, volume, mute, and fullscreen
- 🖱️ Drag-and-drop support for video, audio, and subtitle files (`.srt` / `.vtt` / `.ass` / `.ssa`)
- 📱 Responsive layout with a toggleable sidebar
- 🔄 Auto-updater via GitHub releases

### Subtitles
- 📑 Multiple output modes: **Original only**, **English only**, or **Dual** (both languages on screen)
- 🎚️ CC menu with subtitle toggle, **Spoken Audio (Source)**, **Subtitle Output**, and **Generation** (Realtime / Full-Batch) selectors
- 🎨 Styled subtitle overlay — font family, size, colors, outline, bold/italic, alignment (top/bottom)
- 📄 Load existing subtitle files (SRT, VTT, ASS/SSA)
- 💾 Export subtitles in SRT or VTT (backend also supports ASS)
- ✏️ Full subtitle editor: real-time text editing, cue timing, add/delete cues, and shifting all cues by an offset
- 🎯 **Click-to-seek**: click any cue in the subtitle editor and the player jumps to that cue's start time — with instant, race-free highlight feedback (a stale `timeupdate` report can never yank the highlight back)

### Projects
- 🗂️ **Save/Load sessions (`.zan`)** — serialize the entire workspace to a `.zan` JSON project file: the media file path, the generated dual-pass subtitle tracks (Original + English), the selected output/generation mode, source language, subtitle styling, and playhead position.
- ⚡ **Instant restore** — loading a project hydrates the store directly and **bypasses Whisper inference entirely**: no re-transcription, no model reload; the exact UI state (tracks, styles, modes) reappears the moment the file is opened.
- ✅ **Media validation** — loading verifies the stored video path still exists, warns if the file has moved or been deleted, and restores subtitles regardless.

### AI (100% local)
- 🗣️ **Transcription + translation with Whisper** (`whisper-rs`, native whisper.cpp) — models run on your machine
  - **Dual-pass inference** (see [Architecture](#architecture--native-whisper-core--dual-pass-inference)): whisper.cpp cannot emit original + English in one pass, so ZanPlayer Lite runs one or two passes over the same audio, driven by the selected output mode:
    - **Original Only** → `params.translate = false`
    - **English Only** → `params.translate = true`
    - **Both (Dual)** → two passes over the exact same audio buffer; the UI render queue merges their timestamps into stacked dual subtitles
  - **Dynamic target language**: whisper's task flag follows the user's choice — never hardcoded to English
  - **Spoken Audio (Source)** selector (Auto-Detect / Burmese / English / 12+ languages) pins the whisper language token, preventing hallucinations on low-resource languages such as Burmese
  - **Realtime (Streaming)**: VAD-gated chunked decode streams cues as they land. For "Both", the transcribe and translate passes run on **separate asynchronous threads** so dual subtitles never lag the video. **Seeking while streaming** repositions each live pass (via `seek_transcription`) so captions keep regenerating for exactly what is on screen
  - **Full (Batch)**: the entire audio track is transcribed (and translated) sequentially before playback begins, guaranteeing perfectly-synced, zero-latency dual subtitles
  - Model manager in Settings downloads/removes Whisper models (tiny → base → small → medium → large)

### Settings
- 🎨 Theme preferences (light/dark)
- 🔤 Custom subtitle styling (font family, size, colors) with real-time preview
- 🤖 Whisper model management (download/delete models)
- 🔄 Update checker

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play/Pause |
| `←` / `→` | Seek 5 seconds backward/forward |
| `↑` / `↓` | Volume up/down |
| `M` | Mute toggle |
| `F` | Fullscreen toggle |

## Installation

### Download (recommended)

Grab the bundle for your platform from the [Releases page](https://github.com/micropsy/ZanPlayer-Lite/releases):

| OS | Bundle |
|----|--------|
| macOS (Apple Silicon) | `.dmg` (aarch64) |
| macOS (Intel) | `.dmg` (x64) |
| Linux | `.AppImage` or `.deb` |
| Windows | `.msi` |

Releases are **signed**, and the built-in **auto-updater** keeps the app current — ZanPlayer Lite checks GitHub Releases on launch and installs updates in-app.

### Web App (PWA)

The frontend is also a Progressive Web App. A hosted build can be **installed** from Chrome/Edge (Android or desktop) via the in-app *Install app* button or the browser's install affordance, and on iOS/iPadOS via **Add to Home Screen**.

- **Playback is HTML5.** The web build has no native engine — it uses `<video>` and whatever codecs the host browser supports. It never claims (nor attempts) mpv, Media3 or AVFoundation playback.
- **Offline app shell.** A service worker (`public/sw.js`) caches the app shell in production web builds so the installed app opens without a connection; media is streamed, never cached.
- **No local AI on the web.** Whisper transcription needs the bundled desktop app (native whisper.cpp + bundled FFmpeg sidecar). On the web, transcription and model downloads are hidden by the Tauri-only gates, and all persistent state lives in browser `localStorage` (subject to browser storage limits). Media selected via the browser `<input>` or drag-and-drop stays in memory/`blob:` URLs — the app never requests filesystem permission.
- Service worker registration is limited to production web builds (`import.meta.env.PROD && !isTauri()`); the Tauri webview never registers.
- Safari does not fire `beforeinstallprompt`, so iOS/iPadOS installation is the manual Share → **Add to Home Screen** flow. Installed standalone windows are safe-area aware on iOS (notch/home-bar insets).

### Build from Source

#### Prerequisites
1. **Node.js** (v20 or higher; CI uses v24)
2. **Rust** (stable toolchain)
3. Platform dependencies:
   - **macOS**: Xcode Command Line Tools
   - **Linux**: `libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`, `libxdo-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, etc. (see `.github/workflows/release.yml`)
   - **Windows**: MSVC build tools

#### Steps
```bash
git clone https://github.com/micropsy/ZanPlayer-Lite.git
cd ZanPlayer-Lite
npm install
npm run tauri dev
```

#### Build & release
```bash
npm run build         # type-check (tsc) + frontend build (vite)
npm run tauri build   # full desktop bundles (app, dmg, AppImage, deb, msi)
npm run release -- patch   # semantic-version release pipeline (see RELEASE_PROCESS.md)
```

#### Mobile builds (Android / iOS)

Mobile support is **unverified work in progress** — the Rust bridge and the
plugin sources exist (`src-tauri/mobile/`), but neither platform has been built
or run on a device. Prerequisites per platform:

- **Android**: JDK 17+, Android SDK + NDK, and the `aarch64-linux-android` (and
  `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android`) Rust
  targets. `npx tauri android init` scaffolds `src-tauri/gen/android`; then copy
  `src-tauri/mobile/android/MediaPlaybackPlugin.kt` into the generated project
  (exact paths in `src-tauri/mobile/android/README.md`). Requires `minSdkVersion
  ≥ 24` (already set in `tauri.conf.json`).
- **iOS/iPadOS**: Xcode (tested against Xcode's iOS SDK), the Rust targets
  `aarch64-apple-ios` and `aarch64-apple-ios-sim`, and CocoaPods for the Tauri
  iOS harness. `npx tauri ios init` scaffolds `src-tauri/gen/apple`; then
  integrate `src-tauri/mobile/apple/MediaPlaybackPlugin.swift` per
  `src-tauri/mobile/apple/README.md`. iOS ≥ 15.0 must be set as the
  `IPHONEOS_DEPLOYMENT_TARGET` in the generated Xcode project — `tauri.conf.json`
  `bundle.ios` is rejected by the desktop `tauri-cli` (v2.11.3) and must not be
  added there.

Neither mobile plugin has been compiled on a real machine yet — expect
device-time fixes. See the two `src-tauri/mobile/*/README.md` files for the
full integration and verification checklists.

## Offline AI — Where Things Live

- **Whisper models** → app data `models/` directory, downloaded from Settings. Everything — transcription **and** translation — runs through the same native whisper.cpp engine (`whisper-rs`). No other ML runtime is involved.
- **FFmpeg** → bundled as a Tauri sidecar (`src-tauri/binaries/`) for audio extraction to 16 kHz mono WAV.

## Project Structure

```
ZanPlayer Lite/
├── src/                        # Frontend (React 19 + TypeScript)
│   ├── App.tsx                 # Root layout + drag-and-drop handling
│   ├── components/
│   │   ├── Sidebar.tsx         # Open/export subtitles, save/load .zan projects, track list
│   │   ├── VideoPlayer.tsx     # Player, overlays, CC menu (output/generation modes + dual display), click-to-seek dispatch
│   │   ├── Settings.tsx        # Theme, styles, Whisper model manager
│   │   └── SubtitleEditor.tsx  # Timeline/text editing, click-to-seek by cue
│   ├── services/
│   │   ├── tauri.ts            # Typed wrappers for Rust commands
│   │   └── store.ts            # Zustand store (persisted state)
│   ├── hooks/useInstallPrompt.ts # deferred PWA install prompt (Chrome/Edge)
│   ├── common/mediaFormats.ts  # Centralized media/subtitle format catalog
│   ├── types/subtitle.ts       # Subtitle / cue / track types
│   └── utils/                  # cn, subtitleExporter
├── scripts/
│   └── release.mjs             # SemVer release automation
├── public/                     # Static assets (favicon, icons, manifest.json, sw.js PWA shell)
├── src-tauri/                  # Backend (Rust/Tauri)
│   ├── src/main.rs             # Commands: whisper dual-pass jobs, live seek control, ffmpeg, subtitles, model downloads
│   ├── src/pipeline.rs         # Silero VAD -> chunked Whisper decode (translate on/off) -> PTS sync + seek reset
│   ├── src/native_player/      # Native playback engines (mpv on desktop, mobile plugin bridge)
│   ├── mobile/                 # Native mobile plugin sources (Android Media3 / iOS AVPlayer) + READMEs
│   ├── Cargo.toml / tauri.conf.json
│   └── capabilities/main.json  # Tauri 2 permissions
└── .github/workflows/            # CI: test.yml (quality gates) + release.yml (tag-triggered release builds)
```

## Native Playback Backends

Playback is HTML5 `<video>` by default, but ZanPlayer ships dedicated native
engines behind a single `mpv_*` command surface — the webview never knows which
one is underneath:

| Platform | Engine | Gate |
|---|---|---|
| macOS | libmpv **Render API** → CAMetalLayer (behind the transparent webview) | `--features native-player,macos-render` |
| Windows | libmpv `wid` embed (child HWND anchored to the DOM stage) | `--features native-player` |
| Linux (X11) | libmpv `wid` embed (XID anchored to the DOM stage) | `--features native-player` |
| Android | Media3 **ExoPlayer** (`src-tauri/mobile/android/MediaPlaybackPlugin.kt`) | mobile plugin (in development) |
| iOS | AVFoundation **AVPlayer** (`src-tauri/mobile/apple/MediaPlaybackPlugin.swift`) | mobile plugin (in development) |

Every backend emits the same 250 ms coalesced `mpv-timeupdate` payload, routes
seeks through one native funnel, and signals `mpv-embed-lost` to drop back to
HTML5 when the surface is lost. Shipped desktop builds are feature-off (HTML5);
see `AGENTS.md` for the engine notes.

**Codec support is per-backend.** The file picker, drag-and-drop, native
backends and HTML5 fallback all share one centralized format catalog
(`src/common/mediaFormats.ts`), but which of those formats actually *decodes*
depends on the underlying engine (browser codecs, libmpv builds, Media3,
AVFoundation). The macOS Render-API engine (libmpv) passes its 13-check
interactive smoke battery with real **MP4/H.264/AAC and MKV/H.264** files
(render context, Metal frame presentation, decode, clock, transparency,
plus stage re-anchoring through sidebar reflow, multi-step manual resize, and
native + web fullscreen). A broader decode corpus was verified against the
Homebrew libmpv 0.41 build the app links (generated with the bundled FFmpeg
9.0; every entry decoded, i.e. produced frames without error):

| Container/Codec | Native (libmpv) | HTML5 (<video>) |
|---|---|---|
| MP4 / H.264 + AAC | ✅ | ✅ (Safari/Chromium) |
| MOV / H.265 | ✅ | ✅ (Safari/Chromium) |
| WebM / VP8 | ✅ | ✅ (Safari/Chromium) |
| WebM / VP9 | ✅ | ✅ (Safari/Chromium) |
| MKV / H.264 | ✅ | ⚠️ Chromium subset; ❌ WebKit |
| MKV / H.265 | ✅ | ⚠️ Chromium subset; ❌ WebKit |
| AVI / MPEG-4 | ✅ | ❌ |
| WMV / WMV2 | ✅ | ❌ |
| FLV / FLV1 | ✅ | ❌ |
| MP3, WAV, OGG, FLAC, M4A/AAC, raw AAC | ✅ | ✅ |
| WMA | ✅ | ❌ |
| Corrupt/undecodable file | ⏱️ watchdog → HTML5 fallback | error overlay |

A file mpv accepts via `loadfile` but cannot actually demux/decode (renamed
path, corrupt container, unsupported codec) no longer strands the player on a
silent black frame: a 5 s decode watchdog (`VideoPlayer.tsx`) cuts back to the
HTML5 blob engine when the native clock never reports a real duration/playhead,
whose own failure then surfaces the visible hint overlay. Everything
else — Windows/Linux native engines, Android/iOS, and the browser-codec matrix —
is unverified; do not assume universal codec support until the compatibility
matrix in `Todo.md` is filled in per platform.

### Mobile status (honest)

The Rust side of the mobile bridge (session `MobileSession`, plugin
registration, position ticker, fallback) is implemented and covered by unit
tests. The **Kotlin and Swift plugin sources are written but have never been
compiled or run** — the development machine has no JDK, Android SDK, Xcode, or
Rust mobile toolchains. Read `src-tauri/mobile/android/README.md` and
`src-tauri/mobile/apple/README.md` for exact integration steps and the
device-time checklist.

## Technologies

- **Desktop**: Tauri 2
- **Frontend**: React 19 + TypeScript
- **Styling**: Tailwind CSS v4
- **State Management**: Zustand (with persistence)
- **Transcription / Translation AI**: whisper-rs (native whisper.cpp, local models)
- **Voice Activity Detection**: silero-vad-pure
- **Build Tool**: Vite 8
- **Icon Library**: Lucide React
- **CI/Release**: GitHub Actions matrix (macOS x64/aarch64, Linux x64, Windows x64) + `tauri-action`

## Usage

1. Launch the app, then drag-and-drop a video/audio file or use the sidebar open button.
2. Enable subtitles (CC). Transcription runs locally and streams in as cues are decoded.
3. In Settings, download a Whisper model if not present.
4. Choose **CC → Subtitle Output**: *Original* (source-speech captions), *English* (whisper's translate task), or *Both* (two parallel passes, dual lines on screen).
5. Choose **CC → Generation**: *Realtime* streams while you watch; *Full (Batch)* transcribes the entire audio before playback for perfectly-synced zero-latency dual subtitles. Seeking while a *Realtime* job runs repositions the live passes, so captions always track the playhead.
6. To keep low-resource audio (e.g. Burmese) from hallucinating English, set **CC → Spoken Audio (Source) → Burmese**.
7. Edit cues in the sidebar editor and export when ready. **Click any cue** to jump the player (and the editor highlight) straight to that moment.
8. **Save Project** (in the sidebar) writes a `.zan` file capturing the video, dual tracks, modes, and styling. **Load Project** restores the whole workspace instantly — transcription is never re-run.

## Roadmap

- [x] Tests for frontend and backend
- [x] Click-to-seek from the subtitle editor into the player
- [x] Project save/load (`.zan`)
- [x] Seek-aware realtime transcription (streaming passes follow the playhead)
- [ ] A refreshed UI/UX design pass — new player controls, settings, and playback experiences

## Testing

```bash
npm test                          # frontend unit tests (Vitest)
cd src-tauri && cargo test        # backend unit tests (pipeline, projects, models, modes)
cd src-tauri && cargo check       # Rust type-check
npm run build                     # TypeScript type-check (tsc) + frontend build
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Acknowledgments

- [Tauri](https://tauri.app/) — for the amazing desktop framework
- [whisper-rs](https://github.com/tazz4843/whisper-rs) — for local Whisper inference
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — for the native inference engine
- [silero-vad-pure](https://github.com/lmnt-com/silero-vad-pure) — for voice activity detection
- [FFmpeg](https://ffmpeg.org/) — for video/audio processing
- Everyone who contributes to open source!