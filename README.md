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

### Build from Source

#### Prerequisites
1. **Node.js** (v20 or higher; CI uses v24)
2. **Rust** (stable toolchain)
3. Platform dependencies:
   - **macOS**: Xcode Command Line Tools
   - **Linux**: `libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`, `libxdo-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, etc. (see `.github/workflows/build.yml`)
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
│   ├── types/subtitle.ts       # Subtitle / cue / track types
│   └── utils/                  # cn, subtitleExporter
├── scripts/
│   └── release.mjs             # SemVer release automation
├── public/                     # Static assets
├── src-tauri/                  # Backend (Rust/Tauri)
│   ├── src/main.rs             # Commands: whisper dual-pass jobs, live seek control, ffmpeg, subtitles, model downloads
│   ├── src/pipeline.rs         # Silero VAD -> chunked Whisper decode (translate on/off) -> PTS sync + seek reset
│   ├── Cargo.toml / tauri.conf.json
│   └── capabilities/main.json  # Tauri 2 permissions
└── .github/workflows/build.yml # CI: builds + creates releases for all 4 platforms
```

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