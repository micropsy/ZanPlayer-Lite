import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SubtitleTrack, SubtitleCue } from "../types/subtitle";
import { TauriService, type ProjectData } from "./tauri";

export type ProgressStep = "idle" | "saving" | "extracting" | "transcribing";
export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "uptodate";

/// Subtitle output the user selected. Whisper emits either source-language text
/// or an English translation, never both in one pass, so "both" runs two passes
/// over the same audio and the UI merges cues by kind.
export type SubtitleOutputMode = "original" | "english" | "both";

/// Generation strategy: real-time streaming (cues land as chunks decode) or
/// full batch (the whole track is processed before playback starts).
export type TranscriptionMode = "stream" | "batch";

export interface SubtitleStyle {
    fontName: string;
    fontSize: number;
    primaryColor: string;
    outlineColor: string;
    backColor: string;
    bold: boolean;
    italic: boolean;
    alignment: "bottom" | "top";
}

// Full display names -> whisper ISO-639-1 codes. whisper.cpp's `g_lang` table only
// resolves ISO codes ("en", "my") or its own full names ("english", "myanmar");
// any other string yields lang_id == -1 and then indexes `ailang_2_tok[-1]` out of
// bounds while building the prompt, silently breaking transcription. This is the
// single sanitization point before a language reaches the Rust backend.
const WHISPER_LANG_MAP: Record<string, string> = {
    auto: "auto",
    "auto-detect": "auto",
    autodetect: "auto",
    english: "en",
    en: "en",
    burmese: "my",
    myanmar: "my",
    my: "my",
    spanish: "es",
    espanol: "es",
    es: "es",
    french: "fr",
    fr: "fr",
    german: "de",
    deu: "de",
    de: "de",
    japanese: "ja",
    ja: "ja",
    korean: "ko",
    ko: "ko",
    chinese: "zh",
    "chinese (simplified)": "zh",
    zh: "zh",
    portuguese: "pt",
    pt: "pt",
    russian: "ru",
    ru: "ru",
    thai: "th",
    th: "th",
    vietnamese: "vi",
    vi: "vi",
    hindi: "hi",
    hi: "hi",
    arabic: "ar",
    ar: "ar",
};

// Normalize a spoken-audio language value ("auto", "Burmese", "en", ...) into an
// ISO-639-1 code Whisper understands, or `undefined` for auto-detection so the
// backend never receives an unresolvable string.
export function whisperLangCode(lang: string | undefined | null): string | undefined {
    if (!lang) return undefined;
    const key = lang.trim().toLowerCase();
    const mapped = WHISPER_LANG_MAP[key];
    if (mapped === "auto") return undefined;
    if (mapped) return mapped;
    // A clean lowercase 2-letter ISO code passes through; anything else falls
    // back to auto-detection rather than breaking whisper.cpp's tokenizer.
    return /^[a-z]{2}$/.test(key) ? key : undefined;
}

/// Reverse lookup of a whisper ISO code / display name for subtitle labels.
export function languageLabel(lang: string | undefined | null): string {
    if (!lang) return "Auto-Detect";
    const lower = lang.trim().toLowerCase();
    if (isCodeToName(lower)) return isCodeToName(lower)!;
    const key = Object.keys(WHISPER_LANG_MAP).find(
        (k) => WHISPER_LANG_MAP[k] === lower && !k.includes("-")
    );
    if (key) return key.charAt(0).toUpperCase() + key.slice(1);
    return lower;
}

const CODE_TO_NAME: Record<string, string> = {
    auto: "Auto-Detect",
    en: "English",
    my: "Burmese",
    es: "Spanish",
    fr: "French",
    de: "German",
    ja: "Japanese",
    ko: "Korean",
    zh: "Chinese",
    pt: "Portuguese",
    ru: "Russian",
    th: "Thai",
    vi: "Vietnamese",
    hi: "Hindi",
    ar: "Arabic",
};

function isCodeToName(code: string): string | undefined {
    return CODE_TO_NAME[code];
}

interface AppState {
    currentVideo: File | null;
    setCurrentVideo: (video: File | null) => void;
    currentVideoUrl: string | null;
    setCurrentVideoUrl: (url: string | null) => void;
    currentVideoPath: string | null;
    setCurrentVideoPath: (path: string | null) => void;
    subtitleTracks: SubtitleTrack[];
    setSubtitleTracks: (tracks: SubtitleTrack[]) => void;
    resetSubtitles: () => void;
    appendStreamedCues: (trackId: string, meta: { name: string; language: string }, cues: SubtitleCue[]) => void;
    setTrackCues: (trackId: string, cues: SubtitleCue[]) => void;
    removeGeneratedTracks: () => void;
    applyBatchTracks: (tracks: Array<{ id: string; name: string; language: string; cues: SubtitleCue[] }>) => void;
    loadProject: (project: ProjectData) => void;
    activeSubtitleTrackId: string | null;
    setActiveSubtitleTrackId: (id: string | null) => void;
    showSubtitles: boolean;
    setShowSubtitles: (show: boolean) => void;
    currentTime: number;
    setCurrentTime: (time: number) => void;
    isPlaying: boolean;
    setIsPlaying: (playing: boolean) => void;
    updateCue: (trackId: string, cueId: string, newText: string) => void;
    updateCueTiming: (trackId: string, cueId: string, startTime: number, endTime: number) => void;
    shiftAllCues: (trackId: string, offset: number) => void;
    deleteCue: (trackId: string, cueId: string) => void;
    addCue: (trackId: string, cue: SubtitleCue) => void;

    // Progress
    progressStep: ProgressStep;
    progressPercent: number;
    setProgress: (step: ProgressStep, percent: number) => void;

    // Seek
    seekTo: number | null;
    setSeekTo: (time: number | null) => void;

    // Settings
    theme: "dark" | "light";
    setTheme: (theme: "dark" | "light") => void;
    useLocalWhisper: boolean;
    setUseLocalWhisper: (use: boolean) => void;
    whisperModel: string;
    setWhisperModel: (model: string) => void;
    sourceLanguage: string;
    setSourceLanguage: (lang: string) => void;
    subtitleMode: SubtitleOutputMode;
    setSubtitleMode: (mode: SubtitleOutputMode) => void;
    transcriptionMode: TranscriptionMode;
    setTranscriptionMode: (mode: TranscriptionMode) => void;
    autoCheckUpdates: boolean;
    setAutoCheckUpdates: (check: boolean) => void;
    isTranscribing: boolean;
    setIsTranscribing: (val: boolean) => void;
    transcriptionProgress: number;
    setTranscriptionProgress: (progress: number) => void;

    // Model management
    downloadedModels: string[];
    setDownloadedModels: (models: string[]) => void;
    downloadingModels: Set<string>;
    setDownloadingModels: (models: Set<string>) => void;
    modelDownloadProgress: Record<string, { percent: number; speedMBps: number; etaSeconds: number; error: boolean; message?: string }>;
    setModelDownloadProgress: (modelName: string, progress: { percent: number; speedMBps: number; etaSeconds: number; error: boolean; message?: string }) => void;
    loadDownloadedModels: () => Promise<void>;
    downloadModel: (modelName: string) => Promise<void>;
    deleteModel: (modelName: string) => Promise<void>;

    // Subtitle style
    subtitleStyle: SubtitleStyle;
    setSubtitleStyle: (style: Partial<SubtitleStyle>) => void;

    // Sidebar
    sidebarVisible: boolean;
    setSidebarVisible: (visible: boolean) => void;

    // Updater (global UpdateModal; shared by manual Settings flow + background startup check)
    updateModalOpen: boolean;
    setUpdateModalOpen: (open: boolean) => void;
    updateStatus: UpdateStatus;
    setUpdateStatus: (status: UpdateStatus) => void;
    downloadProgress: number;
    setDownloadProgress: (progress: number) => void;
    updateVersion: string | null;
    setUpdateVersion: (version: string | null) => void;
}

export const useAppStore = create<AppState>()(
    persist(
        (set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void, get: () => AppState) => ({
            currentVideo: null,
            setCurrentVideo: (video: File | null) => set({ currentVideo: video }),
            currentVideoUrl: null,
            setCurrentVideoUrl: (url: string | null) => set({ currentVideoUrl: url }),
            currentVideoPath: null,
            setCurrentVideoPath: (path: string | null) => set({ currentVideoPath: path }),
            subtitleTracks: [],
            setSubtitleTracks: (tracks: SubtitleTrack[]) => set({ subtitleTracks: tracks }),
            resetSubtitles: () =>
                set({
                    subtitleTracks: [],
                    activeSubtitleTrackId: null,
                    isTranscribing: false,
                    transcriptionProgress: 0,
                }),
            appendStreamedCues: (trackId, meta, cues) =>
                set((state) => {
                    const exists = state.subtitleTracks.some((t) => t.id === trackId);
                    const tracks = exists
                        ? state.subtitleTracks
                        : [
                              ...state.subtitleTracks,
                              {
                                  id: trackId,
                                  name: meta.name,
                                  language: meta.language,
                                  cues: [],
                                  isGenerated: true,
                              },
                          ];
                    return {
                        subtitleTracks: tracks.map((t) =>
                            t.id === trackId ? { ...t, cues: [...t.cues, ...cues] } : t
                        ),
                        ...(exists ? {} : { activeSubtitleTrackId: trackId }),
                    };
                }),
            setTrackCues: (trackId, cues) =>
                set((state) => ({
                    subtitleTracks: state.subtitleTracks.map((t) =>
                        t.id === trackId ? { ...t, cues } : t
                    ),
                })),
            // Drop generated tracks created by a previous job (e.g. before
            // regenerating after the user changes the output/generation mode),
            // keeping manually-loaded subtitle files intact.
            removeGeneratedTracks: () =>
                set((state) => {
                    const remaining = state.subtitleTracks.filter((t) => !t.isGenerated);
                    return {
                        subtitleTracks: remaining,
                        activeSubtitleTrackId: state.activeSubtitleTrackId && remaining.some((t) => t.id === state.activeSubtitleTrackId) ? state.activeSubtitleTrackId : null,
                    };
                }),
            // Replace generated tracks in one shot with the complete timelines
            // delivered by a full (batch) job.
            applyBatchTracks: (tracks) =>
                set((state) => {
                    const manual = state.subtitleTracks.filter((t) => !t.isGenerated);
                    return {
                        subtitleTracks: [...manual, ...tracks.map((t) => ({ ...t, isGenerated: true }))],
                        activeSubtitleTrackId: tracks[0]?.id ?? null,
                    };
                }),
            // Restore a saved `.zan` project. All fields are set in a single
            // write so the VideoPlayer effects observe a fully-populated state:
            // when `currentVideoPath` flips and the auto-transcribe effect
            // re-evaluates, `subtitleTracks.length > 0` guarantees the loaded
            // captions are used as-is — Whisper inference is never re-run. The
            // transient `File` object is dropped (only the path survives across
            // sessions); the player regenerates the blob URL from the path.
            loadProject: (project) =>
                set({
                    currentVideoPath: project.videoPath,
                    currentVideo: null,
                    currentVideoUrl: null,
                    subtitleTracks: project.subtitleTracks.map((t) => ({
                        id: t.id,
                        name: t.name,
                        language: t.language,
                        isGenerated: t.isGenerated,
                        cues: t.cues.map((c) => ({
                            id: c.id,
                            startTime: c.startTime,
                            endTime: c.endTime,
                            text: c.text,
                            kind: c.kind,
                        })),
                    })),
                    activeSubtitleTrackId: project.activeSubtitleTrackId,
                    showSubtitles: project.showSubtitles,
                    subtitleMode: project.subtitleMode,
                    transcriptionMode: project.transcriptionMode,
                    sourceLanguage: project.sourceLanguage,
                    subtitleStyle: project.subtitleStyle,
                    currentTime: project.currentTime,
                    isPlaying: false,
                    isTranscribing: false,
                    transcriptionProgress: 0,
                    seekTo: null,
                }),
            activeSubtitleTrackId: null,
            setActiveSubtitleTrackId: (id: string | null) => set({ activeSubtitleTrackId: id }),
            showSubtitles: true,
            setShowSubtitles: (show: boolean) => set({ showSubtitles: show }),
            currentTime: 0,
            setCurrentTime: (time: number) => set({ currentTime: time }),
            isPlaying: false,
            setIsPlaying: (playing: boolean) => set({ isPlaying: playing }),
            updateCue: (trackId: string, cueId: string, newText: string) =>
                set((state: AppState) => ({
                    subtitleTracks: state.subtitleTracks.map((track: SubtitleTrack) =>
                        track.id === trackId
                            ? {
                                  ...track,
                                  cues: track.cues.map((cue: SubtitleCue) =>
                                      cue.id === cueId ? { ...cue, text: newText } : cue
                                  ),
                              }
                            : track
                    ),
                })),
            updateCueTiming: (trackId: string, cueId: string, startTime: number, endTime: number) =>
                set((state: AppState) => ({
                    subtitleTracks: state.subtitleTracks.map((track: SubtitleTrack) =>
                        track.id === trackId
                            ? {
                                  ...track,
                                  cues: track.cues.map((cue: SubtitleCue) =>
                                      cue.id === cueId ? { ...cue, startTime, endTime } : cue
                                  ),
                              }
                            : track
                    ),
                })),
            shiftAllCues: (trackId: string, offset: number) =>
                set((state: AppState) => ({
                    subtitleTracks: state.subtitleTracks.map((track: SubtitleTrack) =>
                        track.id === trackId
                            ? {
                                  ...track,
                                  cues: track.cues.map((cue: SubtitleCue) => ({
                                      ...cue,
                                      startTime: Math.max(0, cue.startTime + offset),
                                      endTime: Math.max(0, cue.endTime + offset),
                                  })),
                              }
                            : track
                    ),
                })),
            deleteCue: (trackId: string, cueId: string) =>
                set((state: AppState) => ({
                    subtitleTracks: state.subtitleTracks.map((track: SubtitleTrack) =>
                        track.id === trackId
                            ? { ...track, cues: track.cues.filter((cue: SubtitleCue) => cue.id !== cueId) }
                            : track
                    ),
                })),
            addCue: (trackId: string, cue: SubtitleCue) =>
                set((state: AppState) => ({
                    subtitleTracks: state.subtitleTracks.map((track: SubtitleTrack) =>
                        track.id === trackId
                            ? { ...track, cues: [...track.cues, cue] }
                            : track
                    ),
                })),

            // Progress
            progressStep: "idle",
            progressPercent: 0,
            setProgress: (step: ProgressStep, percent: number) =>
                set({ progressStep: step, progressPercent: percent }),

            // Seek
            seekTo: null,
            setSeekTo: (time: number | null) => set({ seekTo: time }),

            // Settings
            theme: "dark",
            setTheme: (theme: "dark" | "light") => set({ theme }),
            useLocalWhisper: true,
            setUseLocalWhisper: (use: boolean) => set({ useLocalWhisper: use }),
            whisperModel: "tiny",
            setWhisperModel: (model: string) => set({ whisperModel: model }),
            sourceLanguage: "auto",
            setSourceLanguage: (lang: string) => set({ sourceLanguage: lang }),
            subtitleMode: "english",
            setSubtitleMode: (mode: SubtitleOutputMode) => set({ subtitleMode: mode }),
            transcriptionMode: "stream",
            setTranscriptionMode: (mode: TranscriptionMode) => set({ transcriptionMode: mode }),
            autoCheckUpdates: true,
            setAutoCheckUpdates: (check: boolean) => set({ autoCheckUpdates: check }),
            isTranscribing: false,
            setIsTranscribing: (val: boolean) => set({ isTranscribing: val }),
            transcriptionProgress: 0,
            setTranscriptionProgress: (progress: number) => set({ transcriptionProgress: progress }),

            // Model management
            downloadedModels: [],
            setDownloadedModels: (models: string[]) => set({ downloadedModels: models }),
            downloadingModels: new Set(),
            setDownloadingModels: (models: Set<string>) => set({ downloadingModels: models }),
            modelDownloadProgress: {},
            setModelDownloadProgress: (modelName: string, progress) =>
                set((state) => ({
                    modelDownloadProgress: {
                        ...state.modelDownloadProgress,
                        [modelName]: progress,
                    },
                })),
            loadDownloadedModels: async () => {
                try {
                    const models = await TauriService.listDownloadedModels();
                    set({ downloadedModels: models });
                } catch (err) {
                    console.error("Failed to load downloaded models:", err);
                }
            },
            downloadModel: async (modelName: string) => {
                const state = get();
                if (state.downloadingModels.has(modelName) && !state.modelDownloadProgress[modelName]?.error) return;
                
                const newDownloading = new Set(state.downloadingModels);
                newDownloading.add(modelName);
                set({ 
                    downloadingModels: newDownloading,
                    modelDownloadProgress: {
                        ...state.modelDownloadProgress,
                        [modelName]: { percent: 0, speedMBps: 0, etaSeconds: 0, error: false }
                    }
                });

                try {
                    await TauriService.downloadWhisperModel(modelName, (percent, speedMBps, etaSeconds) => {
                        set((s) => ({
                            modelDownloadProgress: {
                                ...s.modelDownloadProgress,
                                [modelName]: { percent, speedMBps, etaSeconds, error: false }
                            }
                        }));
                    });
                    await state.loadDownloadedModels();
                    // Clear progress after successful download
                    set((s) => {
                        const newProgress = { ...s.modelDownloadProgress };
                        delete newProgress[modelName];
                        return { modelDownloadProgress: newProgress };
                    });
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    console.error(`Failed to download model ${modelName}:`, err);
                    set((s) => ({
                        modelDownloadProgress: {
                            ...s.modelDownloadProgress,
                            [modelName]: { 
                                ...(s.modelDownloadProgress[modelName] || { percent: 0, speedMBps: 0, etaSeconds: 0 }),
                                error: true,
                                message
                            }
                        }
                    }));
                } finally {
                    const updatedDownloading = new Set(get().downloadingModels);
                    if (!get().modelDownloadProgress[modelName]?.error) {
                        updatedDownloading.delete(modelName);
                    }
                    set({ downloadingModels: updatedDownloading });
                }
            },
            deleteModel: async (modelName: string) => {
                try {
                    await TauriService.deleteWhisperModel(modelName);
                    await get().loadDownloadedModels();
                } catch (err) {
                    console.error(`Failed to delete model ${modelName}:`, err);
                }
            },

            // Subtitle style
            subtitleStyle: {
                fontName: "Arial",
                fontSize: 24,
                primaryColor: "#FFFFFF",
                outlineColor: "#000000",
                backColor: "#00000080",
                bold: false,
                italic: false,
                alignment: "bottom",
            },
            setSubtitleStyle: (style: Partial<SubtitleStyle>) =>
                set((state: AppState) => ({
                    subtitleStyle: { ...state.subtitleStyle, ...style },
                })),
            
            // Sidebar
            sidebarVisible: true,
            setSidebarVisible: (visible: boolean) => set({ sidebarVisible: visible }),

            // Updater
            updateModalOpen: false,
            setUpdateModalOpen: (open: boolean) => set({ updateModalOpen: open }),
            updateStatus: "idle",
            setUpdateStatus: (status: UpdateStatus) => set({ updateStatus: status }),
            downloadProgress: 0,
            setDownloadProgress: (progress: number) => set({ downloadProgress: progress }),
            updateVersion: null,
            setUpdateVersion: (version: string | null) => set({ updateVersion: version }),
        }),
        {
            name: "zanplayer-lite-storage",
            partialize: (state: AppState) => ({
                theme: state.theme,
                useLocalWhisper: state.useLocalWhisper,
                whisperModel: state.whisperModel,
                subtitleStyle: state.subtitleStyle,
                sourceLanguage: state.sourceLanguage,
                subtitleMode: state.subtitleMode,
                transcriptionMode: state.transcriptionMode,
                autoCheckUpdates: state.autoCheckUpdates,
            }),
        }
    )
);