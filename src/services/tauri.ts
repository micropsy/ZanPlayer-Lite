import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { SubtitleCue } from "../types/subtitle";

type BackendCue = {
  id: string;
  start_time: number;
  end_time: number;
  text: string;
  kind?: string;
};

export interface BatchDoneTrack {
  kind: string;
  language: string;
  cues: Array<{
    id: string;
    startTime: number;
    endTime: number;
    text: string;
    kind?: string;
  }>;
}

interface VideoFile {
  path: string;
  name: string;
}

export interface TranscriptionBatchDonePayload {
  job_id?: number;
  tracks: BatchDoneTrack[];
}

/** Completion/failure event shapes emitted with a `job_id` so a stale run (a
 *  previous video whose job outlived the switch) can be recognized and dropped. */
export interface TranscriptionDonePayload {
  job_id?: number;
  total?: number;
}

export interface TranscriptionErrorPayload {
  job_id?: number;
  message?: string;
}

export interface InterfaceVideoFile {
  path: string;
  name: string;
}

/** Live clock snapshot pushed by the native VLC session (250 ms ticker). */
export interface VlcTimeUpdatePayload {
  position: number;
  duration: number;
  paused: boolean;
  ended: boolean;
}

/** Mirrors the Rust `SurfaceLayout` (DOM video-stage rect in CSS px, top-left
 * origin) used to re-anchor the embedded VLC surface onto the React stage. */
export interface SurfaceLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Mirrors the Rust `ProjectData` struct (see src-tauri/src/main.rs). The
// `.zan` project file is plain JSON keyed in camelCase, so this interface maps
// 1:1 onto both the on-disk schema and the store's hydration action.
export interface ProjectData {
  version: number;
  videoPath: string;
  subtitleTracks: Array<{
    id: string;
    name: string;
    language: string;
    isGenerated?: boolean;
    cues: Array<{
      id: string;
      startTime: number;
      endTime: number;
      text: string;
      kind?: string;
    }>;
  }>;
  activeSubtitleTrackId: string | null;
  showSubtitles: boolean;
  subtitleMode: "original" | "english" | "both";
  transcriptionMode: "stream" | "batch";
  sourceLanguage: string;
  subtitleStyle: {
    fontName: string;
    fontSize: number;
    primaryColor: string;
    outlineColor: string;
    backColor: string;
    bold: boolean;
    italic: boolean;
    alignment: "bottom" | "top";
  };
  currentTime: number;
}

// Check if we're running inside the Tauri webview. Tauri injects
// `window.__TAURI_INTERNALS__` at runtime; plain browsers (including the PWA
// installed from a browser) do not have it, so every native call in this file
// falls back cleanly instead of throwing.
export const isTauri = (): boolean => {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window;
};

/** Backend event mirroring Tauri window fullscreen state. The Rust
 *  `set_window_fullscreen` command emits this right after calling
 *  `set_fullscreen`, so the React chrome (top bar, sidebar, fullscreen icon)
 *  flips before the macOS Space transition settles. Also lets the layout
 *  reporter re-anchor the native surface on the transition, since the DOM
 *  `fullscreenchange` event does NOT fire for window-level fullscreen. */
export const WINDOW_FULLSCREEN_EVENT = "zan-fullscreen";

/** True when running inside the native macOS app window. With
 *  `titleBarStyle: "Overlay"` + `hiddenTitle` the macOS traffic lights
 *  (close/minimize/zoom) float over the top-left of the custom DOM strip, so
 *  chrome there must clear ~76px or the sidebar hamburger crowds the buttons. */
export const isMacOs = (): boolean => {
  if (typeof navigator === "undefined") return false;
  return /Macintosh|Mac OS X/.test(navigator.userAgent);
};

/** True when running on a touch OS (Android / iOS) — the ONLY case the sidebar
 *  may be a drawer that overlays the video below `md`. On any desktop platform
 *  (macOS/Windows/Linux Tauri webview or a desktop browser, however narrow the
 *  window) the sidebar is ALWAYS inline and pushes the video, so a small
 *  desktop window can never turn it into a floating layer over the picture. */
export const isMobileDevice = (): boolean => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPod/i.test(ua)) return true;
  if (/iPad/i.test(ua)) return true;
  // iPadOS 13+ sends a desktop Mac UA; distinguish a real iPad by its touch
  // hardware (an iPad reports multiple touch points, a Mac laptop has none).
  return /Macintosh|Mac OS X/i.test(ua) && navigator.maxTouchPoints > 1;
};

export class TauriService {
  static async openVideoDialog(): Promise<VideoFile | null> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }
    return await invoke<VideoFile | null>("open_video_dialog");
  }

  static async openSubtitleDialog(): Promise<string | null> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }
    return await invoke<string | null>("open_subtitle_dialog");
  }

  static async saveSubtitleDialog(defaultName: string): Promise<string | null> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }
    return await invoke<string | null>("save_subtitle_dialog", {
      defaultName,
    });
  }

  static async readSubtitleFile(filePath: string): Promise<SubtitleCue[]> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }
    const cues = await invoke<Array<{ id: string; start_time: number; end_time: number; text: string }>>("read_subtitle_file", {
      filePath,
    });
    return cues.map((c) => ({
      id: c.id,
      startTime: c.start_time,
      endTime: c.end_time,
      text: c.text,
    }));
  }

  static async writeSubtitleFile(
    filePath: string,
    cues: SubtitleCue[],
    format: string
  ): Promise<void> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }
    const backendCues = cues.map((c) => ({
      id: c.id,
      start_time: c.startTime,
      end_time: c.endTime,
      text: c.text,
    }));
    await invoke("write_subtitle_file", {
      filePath,
      cues: backendCues,
      format,
    });
  }

  static async openProjectDialog(): Promise<string | null> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }
    return await invoke<string | null>("open_project_dialog");
  }

  static async saveProjectDialog(): Promise<string | null> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }
    return await invoke<string | null>("save_project_dialog");
  }

  static async writeProjectFile(filePath: string, data: ProjectData): Promise<void> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }
    await invoke<void>("write_project_file", { filePath, data });
  }

  static async readProjectFile(
    filePath: string
  ): Promise<{ project: ProjectData; mediaExists: boolean }> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }
    const [project, mediaExists] = await invoke<[ProjectData, boolean]>(
      "read_project_file",
      { filePath }
    );
    return { project, mediaExists };
  }

  static async writeFile(
    fileName: string,
    fileData: Uint8Array
  ): Promise<string> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }
    const home = await homeDir();
    return await invoke<string>("write_file", {
      fileName,
      fileData: Array.from(fileData),
      outputDir: home,
    });
  }

  static async extractAudio(videoPath: string): Promise<string> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }
    const home = await homeDir();
    return await invoke<string>("extract_audio", {
      videoPath,
      outputDir: home,
    });
  }

  // Native dual-pass transcription: Silero VAD -> Whisper decode. The pass
  // (`params.translate`) is driven by `subtitleMode` — "original" runs
  // translate=false, "english" runs translate=true, "both" runs two passes
  // over the same audio (parallel in realtime mode, sequential in batch mode).
  // Cues are tagged with a `kind` ("original" | "translation") so the UI can
  // merge them into per-language tracks from the render queue.
  static async startTranscription(
    mediaPath: string,
    modelName: string,
    language: string | undefined,
    subtitleMode: "original" | "english" | "both",
    transcriptionMode: "stream" | "batch",
    jobId: number
  ): Promise<void> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }
    await invoke<void>("start_transcription", {
      mediaPath,
      modelName,
      language,
      subtitleMode,
      transcriptionMode,
      jobId,
    });
  }

  // Forward a playhead jump to the active realtime (streaming) job. The Rust
  // passes drop their current VAD/utterance state and reposition the WAV reader
  // to `seekTo` so captions regenerate for the new position instead of decoding
  // stale pre-seek audio. No-op for batch jobs and when nothing is transcribing.
  static async seekTranscription(mediaPath: string, seekTo: number): Promise<void> {
    if (!isTauri()) {
      return;
    }
    await invoke<void>("seek_transcription", {
      mediaPath,
      seekTo,
    });
  }

  static async pollTranscriptCues(jobId: number): Promise<SubtitleCue[]> {
    if (!isTauri()) {
      return [];
    }
    const cues = await invoke<BackendCue[]>("poll_transcript_cues", { jobId });
    return cues.map((c) => ({
      id: c.id,
      startTime: c.start_time,
      endTime: c.end_time,
      text: c.text,
      kind: c.kind,
    }));
  }

  /** True while the backend job `jobId` is still decoding. The frontend uses
   *  this as a safety net so a completion event that was missed (fast batch
   *  run, stale listener) can still clear the `isTranscribing` flag instead of
   *  permanently blocking the next auto-transcription. */
  static async transcriptionActive(jobId: number): Promise<boolean> {
    if (!isTauri()) {
      return false;
    }
    return await invoke<boolean>("transcription_active", { jobId });
  }

  static async downloadWhisperModel(
    modelName: string,
    onProgress?: (percent: number, speedMBps: number, etaSeconds: number) => void
  ): Promise<string> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }

    let unlisten: (() => void) | null = null;
    if (onProgress) {
      unlisten = await listen<{
            modelName: string;
            percent: number;
            speedMBps: number;
            etaSeconds: number;
        }>("model-download-progress", (event: { payload: {
            modelName: string;
            percent: number;
            speedMBps: number;
            etaSeconds: number;
        } }) => {
        if (event.payload.modelName === modelName && onProgress) {
          onProgress(
            event.payload.percent,
            event.payload.speedMBps,
            event.payload.etaSeconds
          );
        }
      });
    }

    try {
      return await invoke<string>("download_whisper_model", { modelName });
    } finally {
      if (unlisten) {
        unlisten();
      }
    }
  }

  static async deleteWhisperModel(modelName: string): Promise<void> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }
    await invoke<void>("delete_whisper_model", { modelName });
  }

  static async listDownloadedModels(): Promise<string[]> {
    if (!isTauri()) {
      return [];
    }
    return await invoke<string[]>("list_downloaded_models");
  }

  static async checkModelDownloaded(modelName: string): Promise<boolean> {
    if (!isTauri()) {
      return false;
    }
    return await invoke<boolean>("check_model_downloaded", { modelName });
  }

  static async getVideoBlobUrl(filePath: string): Promise<string> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }
    return convertFileSrc(filePath);
  }

  static async relaunchApp(): Promise<void> {
    if (!isTauri()) {
      throw new Error("This feature requires the Tauri app");
    }
    await invoke<void>("relaunch_app");
  }

  // -------------------------------------------------------------------------
  // Native player capability. The backend (libvlc on Windows/Linux/macOS, the
  // Media3/AVPlayer mobile plugin on Android/iOS) decides availability via
  // `vlc_is_available`; Web and builds without the native backend return false
  // so the UI falls back to <video>. Every call resolves cleanly when native
  // playback is unavailable.
  // -------------------------------------------------------------------------

  /** Whether the current build includes the native VLC playback engine. */
  static async isNativePlayerAvailable(): Promise<boolean> {
    if (!isTauri()) {
      return false;
    }
    try {
      return (await invoke<boolean>("vlc_is_available")) === true;
    } catch {
      return false;
    }
  }

  static async vlcLoad(path: string): Promise<void> {
    if (!isTauri()) {
      return;
    }
    await invoke<void>("vlc_load", { path });
  }

  // Re-anchor the embedded VLC surface onto the DOM video stage. The Rust side
  // flips the CSS (top-left) rect into native coordinates and frames the host
  // NSView / resizes the VLC video viewport so playback tracks the container.
  static async vlcSetLayout(rect: SurfaceLayout): Promise<void> {
    if (!isTauri()) {
      return;
    }
    await invoke<void>("vlc_set_layout", { rect });
  }

  static async vlcPlay(): Promise<void> {
    if (!isTauri()) {
      return;
    }
    await invoke<void>("vlc_play");
  }

  static async vlcPause(): Promise<void> {
    if (!isTauri()) {
      return;
    }
    await invoke<void>("vlc_pause");
  }

  static async vlcSeek(position: number): Promise<void> {
    if (!isTauri()) {
      return;
    }
    await invoke<void>("vlc_seek", { position });
  }

  static async vlcSetVolume(level: number): Promise<void> {
    if (!isTauri()) {
      return;
    }
    await invoke<void>("vlc_set_volume", { level });
  }

  static async vlcSetSpeed(speed: number): Promise<void> {
    if (!isTauri()) {
      return;
    }
    await invoke<void>("vlc_set_speed", { speed });
  }

  static async vlcStop(): Promise<void> {
    if (!isTauri()) {
      return;
    }
    await invoke<void>("vlc_stop");
  }

  /** Whether `ZANPLAYER_NATIVE_LAYOUT_DEBUG=1` was active at process start:
   *  Rust sets a magenta border on the real native frame, and JS paints
   *  complementary DOM outlines (red = `[data-player-viewport]`, blue =
   *  `[data-sidebar]`, green = video layer, yellow = `[data-subtitle-layer]`)
   *  so the two layers can be visually compared pixel-for-pixel without opening
   *  a profiler. */
  static async isNativeLayoutDebug(): Promise<boolean> {
    if (!isTauri()) {
      return false;
    }
    try {
      return (await invoke<boolean>("native_layout_debug")) === true;
    } catch {
      return false;
    }
  }

  /** PRODUCT fullscreen path: Tauri WINDOW fullscreen, never the HTML Fullscreen
   *  API. `document.documentElement.requestFullscreen()` reparents the WKWebView
   *  into a separate macOS fullscreen window, leaving the native host NSView
   *  stranded in the old window — the stage goes permanently black.
   *  Window-level `set_fullscreen` resizes the SAME window into the fullscreen
   *  Space, so webview, host view and the native surface move together and the
   *  layout reporter re-anchors on the resize. */
  static async setWindowFullscreen(fullscreen: boolean): Promise<void> {
    if (!isTauri()) {
      return;
    }
    await invoke<void>("set_window_fullscreen", { fullscreen });
  }

  /** Title-bar chrome drag. On macOS this drives the backend's synthesized
   *  `performWindowDragWithEvent:` command (`start_window_drag`) — the ONLY
   *  path that works while the app is focused/active, because tao's core
   *  `startDragging` reads `NSApp.currentEvent`, which the focused WKWebView
   *  has already consumed by the time the JS mousedown round-trips to Rust.
   *  Other platforms use the core `startDragging` (works there).
   *  Must be called inside the user gesture (mousedown) — never async-deferred. */
  static async startWindowDrag(): Promise<void> {
    if (!isTauri()) {
      return;
    }
    if (isMacOs()) {
      try {
        await invoke<void>("start_window_drag");
        return;
      } catch {
        // Command unavailable (older backend) — fall through to the core path.
      }
    }
    try {
      await getCurrentWindow().startDragging();
    } catch {
      // A drag is already in progress or we are in a plain browser tab:
      // safe to ignore.
    }
  }
}
