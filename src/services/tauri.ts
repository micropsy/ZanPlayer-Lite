import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
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
  tracks: BatchDoneTrack[];
}

export interface InterfaceVideoFile {
  path: string;
  name: string;
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

// Check if we're running in a Tauri environment
export const isTauri = () => {
  return true;
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
    transcriptionMode: "stream" | "batch"
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

  static async pollTranscriptCues(): Promise<SubtitleCue[]> {
    if (!isTauri()) {
      return [];
    }
    const cues = await invoke<BackendCue[]>("poll_transcript_cues");
    return cues.map((c) => ({
      id: c.id,
      startTime: c.start_time,
      endTime: c.end_time,
      text: c.text,
      kind: c.kind,
    }));
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
}
