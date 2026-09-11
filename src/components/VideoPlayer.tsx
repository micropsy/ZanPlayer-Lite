import { useRef, useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, whisperLangCode } from "../services/store";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  SkipForward,
  SkipBack,
  FileVideo,
  CheckCircle2,
  Loader2,
  ChevronRight,
  ChevronLeft,
} from "lucide-react";
import { cn } from "../utils/cn";
import { TauriService, isTauri, type TranscriptionBatchDonePayload } from "../services/tauri";
import type { SubtitleCue } from "../types/subtitle";

// Spoken-audio languages shown in the CC menu. The selection pins whisper's
// language token for the *original* pass (default: auto-detect). The subtitle
// output mode (Original / English / Both) decides whether whisper runs its
// translate task — the target language is never hardcoded.
const SOURCE_LANGUAGES = [
  { code: "auto", name: "Auto-Detect" },
  { code: "my", name: "Burmese" },
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Chinese" },
  { code: "pt", name: "Portuguese" },
  { code: "ru", name: "Russian" },
  { code: "th", name: "Thai" },
  { code: "vi", name: "Vietnamese" },
  { code: "hi", name: "Hindi" },
  { code: "ar", name: "Arabic" },
];

// Dual-pass output modes. Whisper emits original OR English per pass; "both"
// runs two passes over the same audio and the UI merges the cue streams.
const OUTPUT_MODES = [
  { value: "original", name: "Original Only" },
  { value: "english", name: "English Only" },
  { value: "both", name: "Both (Dual)" },
] as const;

const GEN_MODES = [
  { value: "stream", name: "Realtime (Streaming)" },
  { value: "batch", name: "Full (Batch)" },
] as const;

const ORIGINAL_TRACK_NAME = "Auto-Generated (Original)";
const TRANSLATION_TRACK_NAME = "Auto-Generated (English)";

export const VideoPlayer = ({ onEditSubtitles }: { onEditSubtitles?: () => void }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [showControls, setShowControls] = useState(true);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [videoSource, setVideoSource] = useState<string | null>(null);
  const [showCCMenu, setShowCCMenu] = useState(false);
  const [ccMenuView, setCcMenuView] = useState<"root" | "source" | "output" | "genmode">("root");
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const {
    currentVideoUrl,
    currentVideoPath,
    setCurrentTime,
    isPlaying,
    setIsPlaying,
    subtitleTracks,
    activeSubtitleTrackId,
    showSubtitles,
    setShowSubtitles,
    seekTo,
    setSeekTo,
    subtitleStyle,
    sourceLanguage,
    setSourceLanguage,
    subtitleMode,
    setSubtitleMode,
    transcriptionMode,
    setTranscriptionMode,
    isTranscribing,
    setIsTranscribing,
    transcriptionProgress,
    setTranscriptionProgress,
  } = useAppStore();

  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPlayRef = useRef(false);
  const transcriptionGenerationRef = useRef(0);
  // Live streamed tracks / job identity. Cues are polled from the Rust render
  // queue while a job is active and routed to these by `kind`.
  const originalStreamTrackIdRef = useRef<string | null>(null);
  const translationStreamTrackIdRef = useRef<string | null>(null);
  const streamingPathRef = useRef<string | null>(null);
  const isBatchRef = useRef(false);
  const realtimeStartedRef = useRef(false);
  const pollInFlightRef = useRef(false);
  // A manual cue-click seek that hasn't landed yet. While set, `timeupdate`
  // events are ignored so a stale report from before the seek completes cannot
  // yank the editor highlight back to the old position. The `seeked` handler
  // (or a fallback timer) resolves it.
  const pendingSeekRef = useRef(false);
  const pendingSeekTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trackForId = (id: string | null) =>
    subtitleTracks.find((t) => t.id === id) ?? null;

  // Dual-subtitle mode uses both generated tracks; single mode uses the active track.
  const originalGeneratedTrack = trackForId(originalStreamTrackIdRef.current);
  const translationGeneratedTrack = trackForId(translationStreamTrackIdRef.current);
  const inDualMode =
    subtitleMode === "both" &&
    !!originalGeneratedTrack &&
    !!translationGeneratedTrack;
  const activeTrack = inDualMode ? null : trackForId(activeSubtitleTrackId);

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleTimeUpdate = () => {
    // Ignore reports while a manual seek is still in flight: some engines
    // fire `timeupdate` with the pre-seek position mid-seek, which would race
    // the optimistic clock and regress the editor highlight.
    if (videoRef.current && !pendingSeekRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  const clearPendingSeek = () => {
    pendingSeekRef.current = false;
    if (pendingSeekTimeoutRef.current) {
      clearTimeout(pendingSeekTimeoutRef.current);
      pendingSeekTimeoutRef.current = null;
    }
  };

  const handleSeeked = () => {
    clearPendingSeek();
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  // Realtime (streaming) jobs decode audio in lock-step with the playhead. When
  // that playhead jumps — seek bar, skip keys, or an editor click-to-seek — the
  // active Rust pass must drop its VAD/utterance state and reposition its WAV
  // reader to the new position, or it keeps generating subtitles for audio we
  // already skipped. Batch jobs surface everything up-front, so they never seek.
  const notifyPipelineSeek = (target: number) => {
    const s = useAppStore.getState();
    if (!isTauri()) return;
    if (!s.isTranscribing || isBatchRef.current) return;
    const videoPath = streamingPathRef.current || s.currentVideoPath;
    if (!videoPath) return;
    void TauriService.seekTranscription(videoPath, target).catch((err) => {
      console.error("Failed to notify transcription seek:", err);
    });
  };
  const notifyPipelineSeekRef = useRef<(target: number) => void>(() => {});
  notifyPipelineSeekRef.current = notifyPipelineSeek;

  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
      }
    }, 3000);
  };

  const toggleMute = () => {
    if (videoRef.current) {
      const newMuted = !isMuted;
      videoRef.current.muted = newMuted;
      setIsMuted(newMuted);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
      setIsMuted(newVolume === 0);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (videoRef.current) {
      clearPendingSeek();
      const newTime = parseFloat(e.target.value);
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
      notifyPipelineSeekRef.current(newTime);
    }
  };

  const skipForward = (seconds: number) => {
    if (videoRef.current) {
      clearPendingSeek();
      const next = Math.min(
        videoRef.current.duration || Infinity,
        videoRef.current.currentTime + seconds
      );
      videoRef.current.currentTime = next;
      setCurrentTime(next);
      notifyPipelineSeekRef.current(next);
    }
  };

  const skipBackward = (seconds: number) => {
    if (videoRef.current) {
      clearPendingSeek();
      const next = Math.max(0, videoRef.current.currentTime - seconds);
      videoRef.current.currentTime = next;
      setCurrentTime(next);
      notifyPipelineSeekRef.current(next);
    }
  };

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch (err) {
      console.error("Error toggling fullscreen:", err);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.code) {
        case "Space":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          skipBackward(5);
          break;
        case "ArrowRight":
          skipForward(5);
          break;
        case "ArrowUp":
          if (videoRef.current) {
            const newVolume = Math.min(1, videoRef.current.volume + 0.1);
            videoRef.current.volume = newVolume;
            setVolume(newVolume);
            if (newVolume > 0) setIsMuted(false);
          }
          break;
        case "ArrowDown":
          if (videoRef.current) {
            const newVolume = Math.max(0, videoRef.current.volume - 0.1);
            videoRef.current.volume = newVolume;
            setVolume(newVolume);
            if (newVolume === 0) setIsMuted(true);
          }
          break;
        case "KeyM":
          toggleMute();
          break;
        case "KeyF":
          toggleFullscreen();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPlaying, isMuted]);

  // Handle fullscreen change
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // Close CC menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (showCCMenu && !target.closest('[data-cc-menu]')) {
        setShowCCMenu(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showCCMenu]);

  // Handle seeking dispatched from the subtitle editor (or anywhere else). The
  // store clock advances optimistically so the editor highlight moves the same
  // frame as the click; late `timeupdate` reports are suppressed until the
  // media engine confirms the new position via `seeked` (or a 500 ms fallback).
  useEffect(() => {
    if (seekTo === null) return;
    clearPendingSeek();
    const video = videoRef.current;
    if (!video) {
      // No media element yet: drop the stale request instead of firing it late.
      setSeekTo(null);
      return;
    }
    const target = seekTo;
    setSeekTo(null);
    if (Math.abs(video.currentTime - target) < 0.05) {
      // Already on that position — just sync the clock, no seek to complete.
      setCurrentTime(target);
      return;
    }
    pendingSeekRef.current = true;
    video.currentTime = target;
    setCurrentTime(target);
    notifyPipelineSeekRef.current(target);
    pendingSeekTimeoutRef.current = setTimeout(() => {
      pendingSeekRef.current = false;
      pendingSeekTimeoutRef.current = null;
      if (videoRef.current) {
        setCurrentTime(videoRef.current.currentTime);
      }
    }, 500);
  }, [seekTo, setSeekTo, setCurrentTime]);

  // Cancel a pending seek on unmount so its fallback timer never fires late.
  useEffect(
    () => () => {
      if (pendingSeekTimeoutRef.current) {
        clearTimeout(pendingSeekTimeoutRef.current);
        pendingSeekTimeoutRef.current = null;
      }
    },
    []
  );

  const sortCues = (list: SubtitleCue[]) =>
    [...list].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);

  const getCurrentCue = (track: typeof activeTrack) => {
    if (!track || !videoRef.current) return null;
    return track.cues.find(
      (cue) =>
        videoRef.current!.currentTime >= cue.startTime &&
        videoRef.current!.currentTime <= cue.endTime
    );
  };

  const currentCue = getCurrentCue(activeTrack);
  const originalCue = inDualMode ? getCurrentCue(originalGeneratedTrack) : null;
  const translationCue = inDualMode ? getCurrentCue(translationGeneratedTrack) : null;

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };

  // Kick off the native dual-pass pipeline (VAD -> Whisper decode -> PTS sync)
  // for the current media file. The output mode drives whisper's task: Original
  // => translate=false, English => translate=true, Both => two passes over the
  // same audio. The command returns immediately; the Rust job streams cues
  // through the render queue and the `transcription-*` events.
  const transcribeVideo = async (videoPathOverride?: string) => {
    const s = useAppStore.getState();
    if (s.isTranscribing) return;
    const videoPath = videoPathOverride || s.currentVideoPath;
    if (!videoPath) {
      console.error("Auto-transcribe requires a video path");
      return;
    }
    setTranscriptionError(null);
    const gen = ++transcriptionGenerationRef.current;
    streamingPathRef.current = videoPath;
    // Stable per-job track ids. Streamed cues are routed to one or both by kind.
    const baseTrackId = `track-${Date.now()}`;
    originalStreamTrackIdRef.current = `${baseTrackId}-orig`;
    translationStreamTrackIdRef.current = `${baseTrackId}-tr`;
    isBatchRef.current = s.transcriptionMode === "batch";
    realtimeStartedRef.current = false;
    setIsTranscribing(true);
    setTranscriptionProgress(0);
    // Pin whisper's recognition to the selected spoken language (auto-detection
    // otherwise); `whisperLangCode` guarantees only valid ISO codes reach Rust.
    const lang = whisperLangCode(s.sourceLanguage);
    try {
      await TauriService.startTranscription(
        videoPath,
        s.whisperModel,
        lang,
        s.subtitleMode,
        s.transcriptionMode
      );
    } catch (err) {
      if (transcriptionGenerationRef.current === gen) {
        console.error("Failed to start transcription:", err);
        setTranscriptionError(err instanceof Error ? err.message : String(err));
        setIsTranscribing(false);
      }
    }
  };

  const transcribeVideoRef = useRef<(videoPath?: string) => Promise<void>>(async () => {});
  transcribeVideoRef.current = transcribeVideo;

  const flushQueuedCues = useCallback(async (): Promise<void> => {
    if (pollInFlightRef.current) return;
    if (isBatchRef.current) return; // batch surfaces cues via the done event
    pollInFlightRef.current = true;
    try {
      const cues = await TauriService.pollTranscriptCues();
      const s = useAppStore.getState();
      if (cues.length === 0) return;
      if (s.currentVideoPath !== streamingPathRef.current) return;
      if (transcriptionGenerationRef.current === 0) return;
      // Merge the render queue into per-language tracks by pass kind.
      const original = sortCues(cues.filter((c) => c.kind !== "translation"));
      const translation = sortCues(cues.filter((c) => c.kind === "translation"));
      if (original.length > 0 && originalStreamTrackIdRef.current) {
        s.appendStreamedCues(
          originalStreamTrackIdRef.current,
          { name: ORIGINAL_TRACK_NAME, language: s.sourceLanguage || "auto" },
          original
        );
      }
      if (translation.length > 0 && translationStreamTrackIdRef.current) {
        s.appendStreamedCues(
          translationStreamTrackIdRef.current,
          { name: TRANSLATION_TRACK_NAME, language: "en" },
          translation
        );
      }
      s.setShowSubtitles(true);
      // First decoded content: if autoplay hasn't started yet (e.g. the video
      // element was still buffering), nudge playback once now that captions exist.
      if (!realtimeStartedRef.current) {
        realtimeStartedRef.current = true;
        if (!s.isPlaying) {
          videoRef.current?.play().catch(() => setIsPlaying(false));
        }
      }
    } catch (err) {
      console.error("Poll transcript cues failed:", err);
    } finally {
      pollInFlightRef.current = false;
    }
  }, [setIsPlaying]);

  // Poll the Rust render queue while a realtime transcription job is active. Cues
// are appended to the live tracks the moment they land (realtime-first). In
// batch mode cues are delivered whole by `transcription-batch-done` instead.
  useEffect(() => {
    if (!isTranscribing) return;
    if (isBatchRef.current) return;
    let disposed = false;
    const flush = async () => {
      if (disposed) return;
      await flushQueuedCues();
    };
    void flush();
    const timer = window.setInterval(() => void flush(), 150);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [isTranscribing, flushQueuedCues]);

  // Backend event wiring: progress, done, error + dropped-video autoplay.
  // Mounted once; generation refs keep stale jobs from touching the UI.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      unlisteners.push(
        await listen<{ percentage: number }>("transcription-progress", (event) => {
          if (disposed) return;
          const pct = Math.min(100, Math.max(0, event.payload?.percentage ?? 0));
          setTranscriptionProgress(pct);
        })
      );

      unlisteners.push(
        await listen<{ total: number }>("transcription-done", async () => {
          if (disposed) return;
          // Final drain so no cue is lost between the last poll and completion.
          const gen = transcriptionGenerationRef.current;
          await flushQueuedCues();
          if (disposed || transcriptionGenerationRef.current !== gen) return;
          setTranscriptionProgress(100);
          setIsTranscribing(false);
        })
      );

      unlisteners.push(
        await listen<TranscriptionBatchDonePayload>(
          "transcription-batch-done",
          (event) => {
            if (disposed) return;
            const s = useAppStore.getState();
            if (s.currentVideoPath !== streamingPathRef.current) return;
            const tracks = (event.payload?.tracks ?? []).map((batch) => {
              const isTranslation = batch.kind === "translation";
              const cueList: SubtitleCue[] = (batch.cues ?? []).map((c) => ({
                id: c.id,
                startTime: c.startTime,
                endTime: c.endTime,
                text: c.text,
                kind: c.kind,
              }));
              return {
                id: isTranslation
                  ? (translationStreamTrackIdRef.current ?? `track-batch-tr-${Date.now()}`)
                  : (originalStreamTrackIdRef.current ?? `track-batch-orig-${Date.now()}`),
                name: isTranslation ? TRANSLATION_TRACK_NAME : ORIGINAL_TRACK_NAME,
                language: isTranslation
                  ? batch.language || "en"
                  : batch.language || s.sourceLanguage || "auto",
                cues: sortCues(cueList),
              };
            });
            if (tracks.length === 0 || tracks.every((t) => t.cues.length === 0)) {
              setTranscriptionProgress(100);
              setIsTranscribing(false);
              return;
            }
            s.applyBatchTracks(tracks);
            s.setShowSubtitles(true);
            // Subtitle generation is complete; if playback hasn't started yet,
            // nudge it once now that the full, perfectly-synced timeline exists.
            if (!realtimeStartedRef.current) {
              realtimeStartedRef.current = true;
              if (!s.isPlaying) {
                videoRef.current?.play().catch(() => setIsPlaying(false));
              }
            }
            setTranscriptionProgress(100);
            setIsTranscribing(false);
          }
        )
      );

      unlisteners.push(
        await listen<string>("transcription-error", (event) => {
          if (disposed) return;
          const message = typeof event.payload === "string" ? event.payload : "Transcription failed";
          console.error("Transcription error:", message);
          setTranscriptionError(message);
          setIsTranscribing(false);
        })
      );

      unlisteners.push(
        await listen("zanplayer-lite:video-dropped", () => {
          if (disposed) return;
          pendingPlayRef.current = true;
        })
      );
    };

    void setup();
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [setTranscriptionProgress, setIsTranscribing, flushQueuedCues]);

  const handleToggleSubtitles = () => {
    const turningOn = !showSubtitles;
    setShowSubtitles(turningOn);
    if (turningOn && subtitleTracks.length === 0 && !isTranscribing) {
      transcribeVideoRef.current();
    }
  };

  // Handle video source management
  useEffect(() => {
    if (currentVideoUrl) {
      setVideoSource(currentVideoUrl);
    }
  }, [currentVideoUrl]);

  useEffect(() => {
    if (currentVideoPath && isTauri()) {
      // If we have a video path in Tauri environment, convert it to a blob URL
      let isMounted = true;
      setVideoSource(null);

      const loadVideo = async () => {
        try {
          const blobUrl = await TauriService.getVideoBlobUrl(currentVideoPath);
          if (isMounted) {
            setVideoSource(blobUrl);
          }
        } catch (error) {
          console.error("Failed to load video from path:", error);
          if (isMounted) {
            setVideoSource(null);
          }
        }
      };

      loadVideo();

      return () => {
        isMounted = false;
      };
    } else if (!currentVideoPath && !currentVideoUrl) {
      setVideoSource(null);
    }
  }, [currentVideoPath, currentVideoUrl]);

  // Auto-transcribe a newly loaded video when captions are enabled and no
  // subtitles exist yet. Playback is never blocked — cues stream in live.
  useEffect(() => {
    if (currentVideoPath && showSubtitles && subtitleTracks.length === 0) {
      transcribeVideoRef.current(currentVideoPath);
    }
  }, [currentVideoPath, showSubtitles, subtitleTracks.length]);

  const currentSourceLanguageLabel =
    SOURCE_LANGUAGES.find((l) => l.code === sourceLanguage)?.name || sourceLanguage || "Auto-Detect";

  // After the user changes the output or generation mode, drop any generated
  // tracks from a previous job and regenerate for the loaded video.
  const regenerateForVideo = useCallback(() => {
    const s = useAppStore.getState();
    if (!s.currentVideoPath) return;
    if (s.isTranscribing) return;
    s.removeGeneratedTracks();
    void transcribeVideoRef.current(s.currentVideoPath);
  }, []);

  const applyOutputMode = (mode: "original" | "english" | "both") => {
    setSubtitleMode(mode);
    setCcMenuView("root");
    regenerateForVideo();
  };

  const applyGenMode = (mode: "stream" | "batch") => {
    setTranscriptionMode(mode);
    setCcMenuView("root");
    regenerateForVideo();
  };

  const outputModeLabel =
    OUTPUT_MODES.find((m) => m.value === subtitleMode)?.name ?? "English Only";
  const genModeLabel =
    transcriptionMode === "batch" ? "Full (Batch)" : "Realtime (Streaming)";

  return (
    <div
      className="relative w-full h-full bg-black group"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
    >
      {videoSource ? (
        <>
          <video
            ref={videoRef}
            src={videoSource}
            className="w-full h-full object-contain"
            onTimeUpdate={handleTimeUpdate}
            onSeeked={handleSeeked}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
            onLoadedMetadata={() => {
              if (videoRef.current) {
                videoRef.current.volume = volume;
                videoRef.current.muted = isMuted;
                // Autoplay the moment media is ready. Transcription never blocks
                // playback in V2 — captions stream in behind the video.
                if (pendingPlayRef.current) {
                  pendingPlayRef.current = false;
                  videoRef.current.play().catch(() => setIsPlaying(false));
                }
              }
            }}
          />

          {/* Audio-only visualizer placeholder */}
          {videoRef.current && videoRef.current.videoWidth === 0 && videoRef.current.videoHeight === 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-zan-deep to-zan-black">
              <div className="flex flex-col items-center gap-6">
                <div className="w-32 h-32 bg-gradient-to-br from-zan-blue to-zan-deep rounded-3xl shadow-2xl flex items-center justify-center">
                  <FileVideo className="w-16 h-16 text-white" />
                </div>
                <div className="text-center">
                  <p className="text-white text-xl font-semibold">Now Playing</p>
                  <p className="text-gray-400 text-sm">Audio File</p>
                </div>
              </div>
            </div>
          )}

          {/* Subtitle Overlay */}
          {showSubtitles && (currentCue || originalCue || translationCue) && (
            <div
              className={cn(
                "absolute left-0 right-0 flex flex-col items-center px-4 pointer-events-none",
                subtitleStyle.alignment === "bottom" ? "bottom-24" : "top-24"
              )}
            >
              {inDualMode ? (
                <div className="flex flex-col items-center gap-1.5">
                  {translationCue && (
                    <div
                      className="px-6 py-2 rounded-lg text-center max-w-3xl"
                      style={{
                        fontFamily: subtitleStyle.fontName,
                        fontSize: `${subtitleStyle.fontSize}px`,
                        color: subtitleStyle.primaryColor,
                        backgroundColor: subtitleStyle.backColor,
                        textShadow: `2px 2px 4px ${subtitleStyle.outlineColor}`,
                        fontWeight: subtitleStyle.bold ? "bold" : "normal",
                        fontStyle: subtitleStyle.italic ? "italic" : "normal",
                      }}
                    >
                      {translationCue.text}
                    </div>
                  )}
                  {originalCue && originalCue.text !== translationCue?.text && (
                    <div
                      className="px-6 py-2 rounded-lg text-center max-w-3xl"
                      style={{
                        fontFamily: subtitleStyle.fontName,
                        fontSize: `${Math.max(12, subtitleStyle.fontSize - 2)}px`,
                        color: subtitleStyle.primaryColor,
                        backgroundColor: subtitleStyle.backColor,
                        textShadow: `2px 2px 4px ${subtitleStyle.outlineColor}`,
                        fontWeight: subtitleStyle.bold ? "bold" : "normal",
                        fontStyle: subtitleStyle.italic ? "italic" : "normal",
                        opacity: 0.9,
                      }}
                    >
                      {originalCue.text}
                    </div>
                  )}
                </div>
              ) : (
                currentCue && (
                  <div
                    className="px-6 py-2 rounded-lg text-center max-w-3xl"
                    style={{
                      fontFamily: subtitleStyle.fontName,
                      fontSize: `${subtitleStyle.fontSize}px`,
                      color: subtitleStyle.primaryColor,
                      backgroundColor: subtitleStyle.backColor,
                      textShadow: `2px 2px 4px ${subtitleStyle.outlineColor}`,
                      fontWeight: subtitleStyle.bold ? "bold" : "normal",
                      fontStyle: subtitleStyle.italic ? "italic" : "normal",
                    }}
                  >
                    {currentCue.text}
                  </div>
                )
              )}
            </div>
          )}

          {/* Play/Pause Overlay */}
          <div
            className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity"
            onClick={togglePlay}
          >
            {!isPlaying && (
              <div className="w-20 h-20 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-sm">
                <Play className="w-10 h-10 text-white ml-1" />
              </div>
            )}
          </div>

          {/* Transcribing Indicator */}
          {/* Top-right corner so it never overlaps the bottom-center subtitle overlay. */}
          {isTranscribing && transcriptionProgress < 100 && (
            <div className="absolute top-4 right-4 z-20 flex items-center gap-2 px-4 py-2 bg-black/70 backdrop-blur rounded-full border border-gray-700 shadow-xl pointer-events-none">
              <Loader2 className="w-4 h-4 animate-spin text-zan-cyan" />
              <span className="text-sm text-white">
                Transcribing... {Math.round(transcriptionProgress)}%
              </span>
            </div>
          )}

          {/* Controls Bar */}
          <div
            className={cn(
              "absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-6 py-4 transition-opacity duration-300",
              showControls ? "opacity-100" : "opacity-0"
            )}
          >
            {/* Progress Bar */}
            <div className="mb-4">
              <input
                type="range"
                min="0"
                max={videoRef.current?.duration || 100}
                value={videoRef.current?.currentTime || 0}
                onChange={handleSeek}
                className="w-full h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-zan-cyan"
              />
              <div className="flex justify-between text-xs text-gray-300 mt-1">
                <span>{formatTime(videoRef.current?.currentTime || 0)}</span>
                <span>{formatTime(videoRef.current?.duration || 0)}</span>
              </div>
            </div>

            {/* Control Buttons */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <button
                  onClick={togglePlay}
                  className="text-white hover:text-zan-cyan transition-colors"
                >
                  {isPlaying ? <Pause className="w-8 h-8" /> : <Play className="w-8 h-8" />}
                </button>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => skipBackward(5)}
                    className="text-white hover:text-zan-cyan transition-colors"
                    title="Back 5 seconds"
                  >
                    <SkipBack className="w-6 h-6" />
                  </button>
                  <button
                    onClick={() => skipForward(5)}
                    className="text-white hover:text-zan-cyan transition-colors"
                    title="Forward 5 seconds"
                  >
                    <SkipForward className="w-6 h-6" />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button onClick={toggleMute} className="text-white hover:text-zan-cyan transition-colors">
                    {isMuted || volume === 0 ? <VolumeX className="w-6 h-6" /> : <Volume2 className="w-6 h-6" />}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={isMuted ? 0 : volume}
                    onChange={handleVolumeChange}
                    className="w-20 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-zan-cyan"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="relative" data-cc-menu>
                  <button
                    onClick={() => {
                      setShowCCMenu(!showCCMenu);
                      if (showCCMenu) setCcMenuView("root");
                    }}
                    className={cn(
                      "flex items-center justify-center py-0.5 px-1 rounded-[4px] border transition-colors",
                      showSubtitles
                        ? "text-zan-cyan border-zan-cyan/70 hover:bg-zan-cyan/10"
                        : "text-white/80 border-white/70 hover:text-zan-cyan hover:border-zan-cyan/70"
                    )}
                    title={showSubtitles ? "Subtitle Settings" : "Show Subtitles"}
                  >
                    <span className="text-[11px] font-bold tracking-widest leading-none">CC</span>
                  </button>

                  {showCCMenu && (
                    <div className="absolute bottom-full right-0 mb-3 bg-zan-black/95 backdrop-blur rounded-xl shadow-2xl border border-gray-700 min-w-[220px] overflow-hidden">
                      {ccMenuView === "source" ? (
                        <>
                          <div className="flex items-center px-2 py-2 border-b border-gray-700">
                            <button
                              onClick={() => setCcMenuView("root")}
                              className="p-1.5 text-gray-400 hover:text-white hover:bg-zan-blue/15 rounded-lg transition-colors"
                            >
                              <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-sm font-semibold text-white px-2">Spoken Audio (Source)</span>
                          </div>
                          <p className="px-3 py-2 text-[11px] leading-relaxed text-gray-400 border-b border-gray-700/60">
                            Pins whisper's recognition to this language. Pair it
                            with <span className="text-zan-cyan font-medium">Subtitle Output → Original</span>{" "}
                            for captions in the original speech.
                          </p>
                          <div className="max-h-64 overflow-y-auto p-1">
                            {SOURCE_LANGUAGES.map((lang) => (
                              <button
                                key={lang.code}
                                onClick={() => {
                                  setSourceLanguage(lang.code);
                                  setCcMenuView("root");
                                }}
                                className={cn(
                                  "w-full flex items-center justify-between gap-3 px-3 py-2 text-sm rounded-lg transition-colors",
                                  sourceLanguage === lang.code
                                    ? "text-zan-cyan bg-zan-blue/25"
                                    : "text-gray-300 hover:bg-zan-blue/15"
                                )}
                              >
                                {lang.name}
                                {sourceLanguage === lang.code && <CheckCircle2 className="w-4 h-4" />}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : ccMenuView === "output" ? (
                        <>
                          <div className="flex items-center px-2 py-2 border-b border-gray-700">
                            <button
                              onClick={() => setCcMenuView("root")}
                              className="p-1.5 text-gray-400 hover:text-white hover:bg-zan-blue/15 rounded-lg transition-colors"
                            >
                              <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-sm font-semibold text-white px-2">Subtitle Output</span>
                          </div>
                          <p className="px-3 py-2 text-[11px] leading-relaxed text-gray-400 border-b border-gray-700/60">
                            Original runs whisper without translation; English
                            runs whisper's translate task; Both runs two passes
                            over the same audio and merges their timestamps.
                          </p>
                          <div className="max-h-64 overflow-y-auto p-1">
                            {OUTPUT_MODES.map((m) => (
                              <button
                                key={m.value}
                                onClick={() => applyOutputMode(m.value)}
                                className={cn(
                                  "w-full flex items-center justify-between gap-3 px-3 py-2 text-sm rounded-lg transition-colors",
                                  subtitleMode === m.value
                                    ? "text-zan-cyan bg-zan-blue/25"
                                    : "text-gray-300 hover:bg-zan-blue/15"
                                )}
                              >
                                {m.name}
                                {subtitleMode === m.value && <CheckCircle2 className="w-4 h-4" />}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : ccMenuView === "genmode" ? (
                        <>
                          <div className="flex items-center px-2 py-2 border-b border-gray-700">
                            <button
                              onClick={() => setCcMenuView("root")}
                              className="p-1.5 text-gray-400 hover:text-white hover:bg-zan-blue/15 rounded-lg transition-colors"
                            >
                              <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-sm font-semibold text-white px-2">Generation Mode</span>
                          </div>
                          <p className="px-3 py-2 text-[11px] leading-relaxed text-gray-400 border-b border-gray-700/60">
                            Realtime streams cues as chunks decode; Full (Batch)
                            processes the entire audio before playback, giving
                            zero-latency dual subtitles.
                          </p>
                          <div className="max-h-64 overflow-y-auto p-1">
                            {GEN_MODES.map((m) => (
                              <button
                                key={m.value}
                                onClick={() => applyGenMode(m.value)}
                                className={cn(
                                  "w-full flex items-center justify-between gap-3 px-3 py-2 text-sm rounded-lg transition-colors",
                                  transcriptionMode === m.value
                                    ? "text-zan-cyan bg-zan-blue/25"
                                    : "text-gray-300 hover:bg-zan-blue/15"
                                )}
                              >
                                {m.name}
                                {transcriptionMode === m.value && <CheckCircle2 className="w-4 h-4" />}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
                            <span className="text-sm font-semibold text-white">Captions</span>
                            {isTranscribing && (
                              <span className="flex items-center gap-1.5 text-xs text-zan-cyan">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                Transcribing
                              </span>
                            )}
                          </div>
                          <div className="p-1">
                            <button
                              onClick={handleToggleSubtitles}
                              className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-white hover:bg-zan-blue/15 rounded-lg transition-colors"
                            >
                              <span>Subtitles</span>
                              <span
                                className={cn(
                                  "relative w-9 h-5 rounded-full transition-colors",
                                  showSubtitles ? "bg-zan-cyan" : "bg-gray-600"
                                )}
                              >
                                <span
                                  className={cn(
                                    "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all",
                                    showSubtitles ? "left-[18px]" : "left-0.5"
                                  )}
                                />
                              </span>
                            </button>
                            <button
                              onClick={() => setCcMenuView("source")}
                              className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-gray-200 hover:bg-zan-blue/15 rounded-lg transition-colors"
                            >
                              <span>Spoken Audio (Source)</span>
                              <span className="flex items-center gap-1 text-gray-400">
                                <span className="text-xs">{currentSourceLanguageLabel}</span>
                                <ChevronRight className="w-4 h-4" />
                              </span>
                            </button>
                            <button
                              onClick={() => setCcMenuView("output")}
                              className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-gray-200 hover:bg-zan-blue/15 rounded-lg transition-colors"
                            >
                              <span>Subtitle Output</span>
                              <span className="flex items-center gap-1 text-gray-400">
                                <span className="text-xs">{outputModeLabel}</span>
                                <ChevronRight className="w-4 h-4" />
                              </span>
                            </button>
                            <button
                              onClick={() => setCcMenuView("genmode")}
                              className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-gray-200 hover:bg-zan-blue/15 rounded-lg transition-colors"
                            >
                              <span>Generation</span>
                              <span className="flex items-center gap-1 text-gray-400">
                                <span className="text-xs">{genModeLabel}</span>
                                <ChevronRight className="w-4 h-4" />
                              </span>
                            </button>
                            <button
                              onClick={() => {
                                setShowCCMenu(false);
                                onEditSubtitles?.();
                              }}
                              className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-gray-200 hover:bg-zan-blue/15 rounded-lg transition-colors border-t border-gray-700/70 mt-1 pt-2"
                            >
                              <span className="flex items-center gap-2">
                                <span className="text-sm">✏️</span>
                                Edit Subtitles
                              </span>
                              <ChevronRight className="w-4 h-4 text-gray-500" />
                            </button>
                            {transcriptionError && (
                              <p className="px-3 py-2 text-xs text-red-400 break-all">{transcriptionError}</p>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <button
                  onClick={toggleFullscreen}
                  className="text-white hover:text-zan-cyan transition-colors"
                >
                  {isFullscreen ? <Minimize className="w-6 h-6" /> : <Maximize className="w-6 h-6" />}
                </button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center w-full h-full text-gray-500">
          <FileVideo className="w-16 h-16 mb-4 opacity-50" />
          <p className="text-lg">Select a video or audio file to start</p>
          <div className="mt-6 text-sm text-gray-600 max-w-md text-center">
            <p className="mb-2">Keyboard shortcuts:</p>
            <div className="grid grid-cols-2 gap-2">
              <span><kbd className="bg-zan-black px-2 py-1 rounded">Space</kbd> Play/Pause</span>
              <span><kbd className="bg-zan-black px-2 py-1 rounded">←/→</kbd> Seek</span>
              <span><kbd className="bg-zan-black px-2 py-1 rounded">↑/↓</kbd> Volume</span>
              <span><kbd className="bg-zan-black px-2 py-1 rounded">M</kbd> Mute</span>
              <span><kbd className="bg-zan-black px-2 py-1 rounded">F</kbd> Fullscreen</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};