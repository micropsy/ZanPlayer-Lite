import { useRef, useState, useEffect, useCallback } from "react";
import { listen, emit } from "@tauri-apps/api/event";
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
  Settings2,
  History,
  X,
} from "lucide-react";
import { cn } from "../utils/cn";
import {
  TauriService,
  isTauri,
  type MpvTimeUpdatePayload,
  type TranscriptionBatchDonePayload,
} from "../services/tauri";
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

// Standard media-player playback speeds, cycled/selected from the control bar.
const SPEED_RATES = [0.5, 1, 1.25, 1.5, 2] as const;

export const VideoPlayer = ({ onEditSubtitles }: { onEditSubtitles?: () => void }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const nativeStageRef = useRef<HTMLDivElement | null>(null);
  const [showControls, setShowControls] = useState(true);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [videoSource, setVideoSource] = useState<string | null>(null);
  // Playback engine. `mpv` uses the native libmpv surface embedded behind the
  // transparent webview stage; `html5` falls back to the <video> element; null
  // while engine detection is in flight.
  const [engine, setEngine] = useState<"html5" | "mpv" | null>(null);
  // Mirror of the native clock (driven by `mpv-timeupdate` events).
  const [mpvClock, setMpvClock] = useState({ position: 0, duration: 0 });
  const nativeLoadedRef = useRef(false);
  const resumeAppliedRef = useRef(false);
  const engineRef = useRef<"html5" | "mpv" | null>(null);
  engineRef.current = engine;
  const recordPlaybackRef = useRef<() => void>(() => {});
  const [showCCMenu, setShowCCMenu] = useState(false);
  const [ccMenuView, setCcMenuView] = useState<"root" | "source" | "output" | "genmode">("root");
  const [showQuickSettings, setShowQuickSettings] = useState(false);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const {
    currentVideo,
    currentVideoUrl,
    currentVideoPath,
    setCurrentVideo,
    setCurrentVideoUrl,
    setCurrentVideoPath,
    resetSubtitles,
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
    setSubtitleStyle,
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
    playbackRate,
    setPlaybackRate,
    recentFiles,
    upsertRecentFile,
    touchRecentFile,
    removeRecentFile,
    theme,
    resumeAt,
    setResumeAt,
  } = useAppStore();

  // Latest playback prefs, readable from inside async native event handlers
  // without re-registering the listeners on every change.
  const prefsRef = useRef({ volume, isMuted, playbackRate });
  prefsRef.current = { volume, isMuted, playbackRate };

  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPlayRef = useRef(false);
  const transcriptionGenerationRef = useRef(0);
  // Resume-at-load: the media element is still buffering when a recent-history
  // item is opened, so the target position is parked here and applied on the
  // next `loadedmetadata` (the store `resumeAt` request is consumed in the same
  // render the source becomes available, to avoid a stale jump later).
  const pendingResumeRef = useRef<number | null>(null);
  // Throttle the periodic recent-position save while a video is playing.
  const lastRecentSaveRef = useRef(0);
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

  // The active clock and duration come from the native mpv mirror when the
  // engine is mpv (there is no <video> element to read), otherwise fall back
  // to the media element.
  const isNative = engine === "mpv";
  const currentClock = isNative
    ? mpvClock.position
    : (videoRef.current?.currentTime ?? 0);
  const durationClock = isNative
    ? mpvClock.duration
    : (videoRef.current?.duration ?? 0);

  // Dual-subtitle mode uses both generated tracks; single mode uses the active track.
  const originalGeneratedTrack = trackForId(originalStreamTrackIdRef.current);
  const translationGeneratedTrack = trackForId(translationStreamTrackIdRef.current);
  const inDualMode =
    subtitleMode === "both" &&
    !!originalGeneratedTrack &&
    !!translationGeneratedTrack;
  const activeTrack = inDualMode ? null : trackForId(activeSubtitleTrackId);

  const togglePlay = () => {
    if (isNative) {
      if (isPlaying) {
        void TauriService.mpvPause().catch(() => setIsPlaying(true));
      } else {
        void TauriService.mpvPlay().catch(() => setIsPlaying(false));
      }
      setIsPlaying(!isPlaying);
      return;
    }
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
      maybeRecordPlayback();
    }
  };

  // Periodically save the live playhead into the recent-history entry (at most
  // every 5s while playing). Pause/ended/unmount write the exact position.
  const maybeRecordPlayback = useCallback(() => {
    const s = useAppStore.getState();
    if (!s.currentVideoPath) return;
    const now = performance.now();
    if (now - lastRecentSaveRef.current < 5000) return;
    lastRecentSaveRef.current = now;
    touchRecentFile(s.currentVideoPath, s.currentTime);
  }, [touchRecentFile]);

  // Keep the persisted-playhead helper reachable from the mpv event handlers.
  recordPlaybackRef.current = maybeRecordPlayback;

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

  // Single funnel for every native (mpv) seek. Ordering is the contract:
  //   1. clear any pending HTML5 seek guard,
  //   2. move the optimistic store clock,
  //   3. notify the streaming pipeline FIRST so its passes drop VAD state and
  //      reposition the WAV reader *before* mpv moves (no pre-seek cue race),
  //   4. then issue the mpv seek. The coalesced backend tick reconciles the
  //      exact position, so the UI clock never drifts from mpv's PTS.
  const seekNative = (target: number) => {
    clearPendingSeek();
    const clamped = Math.max(
      0,
      durationClock > 0 ? Math.min(target, durationClock) : target
    );
    setCurrentTime(clamped);
    notifyPipelineSeekRef.current(clamped);
    void TauriService.mpvSeek(clamped).catch(() => {});
  };
  const seekNativeRef = useRef<(target: number) => void>(() => {});
  seekNativeRef.current = seekNative;

  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    // Don't auto-hide while a menu is open — the user is reading an option.
    if (isPlaying && !showCCMenu && !showSpeedMenu && !showQuickSettings) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3000);
    }
  };

  const toggleMute = () => {
    if (isNative) {
      const newMuted = !isMuted;
      setIsMuted(newMuted);
      void TauriService.mpvSetVolume(newMuted ? 0 : volume * 100).catch(() => {});
      return;
    }
    if (videoRef.current) {
      const newMuted = !isMuted;
      videoRef.current.muted = newMuted;
      setIsMuted(newMuted);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (isNative) {
      setIsMuted(newVolume === 0);
      void TauriService.mpvSetVolume(newVolume * 100).catch(() => {});
      return;
    }
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
      setIsMuted(newVolume === 0);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isNative) {
      seekNativeRef.current(parseFloat(e.target.value));
      return;
    }
    if (videoRef.current) {
      clearPendingSeek();
      const newTime = parseFloat(e.target.value);
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
      notifyPipelineSeekRef.current(newTime);
    }
  };

  const skipForward = (seconds: number) => {
    if (isNative) {
      seekNativeRef.current(currentClock + seconds);
      return;
    }
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
    if (isNative) {
      seekNativeRef.current(currentClock - seconds);
      return;
    }
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
          if (isNative) {
            const newVolume = Math.min(1, volume + 0.1);
            setVolume(newVolume);
            if (newVolume > 0) setIsMuted(false);
            void TauriService.mpvSetVolume(newVolume * 100).catch(() => {});
          } else if (videoRef.current) {
            const newVolume = Math.min(1, videoRef.current.volume + 0.1);
            videoRef.current.volume = newVolume;
            setVolume(newVolume);
            if (newVolume > 0) setIsMuted(false);
          }
          break;
        case "ArrowDown":
          if (isNative) {
            const newVolume = Math.max(0, volume - 0.1);
            setVolume(newVolume);
            if (newVolume === 0) setIsMuted(true);
            void TauriService.mpvSetVolume(newVolume * 100).catch(() => {});
          } else if (videoRef.current) {
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
  }, [isPlaying, isMuted, volume]);

  // Handle fullscreen change
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // Close CC menu, speed menu, and quick-settings popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (showCCMenu && !target.closest('[data-cc-menu]')) {
        setShowCCMenu(false);
      }
      if (showSpeedMenu && !target.closest('[data-speed-menu]')) {
        setShowSpeedMenu(false);
      }
      if (showQuickSettings && !target.closest('[data-quick-settings]')) {
        setShowQuickSettings(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showCCMenu, showSpeedMenu, showQuickSettings]);

  // Handle seeking dispatched from the subtitle editor (or anywhere else). The
  // store clock advances optimistically so the editor highlight moves the same
  // frame as the click; late `timeupdate` reports are suppressed until the
  // media engine confirms the new position via `seeked` (or a 500 ms fallback).
  useEffect(() => {
    if (seekTo === null) return;
    const target = seekTo;
    setSeekTo(null);
    if (isNative) {
      // Native engine: funnel the seek through seekNative so the pipeline
      // flushes first and `mpv-timeupdate` reconciles from the backend tick.
      seekNativeRef.current(target);
      return;
    }
    clearPendingSeek();
    const video = videoRef.current;
    if (!video) {
      return;
    }
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
  }, [seekTo, setSeekTo, setCurrentTime, isNative]);

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

  // ---------------------------------------------------------------------------
  // Quality-of-life: resume-at-load, recent-history tracking, playback speed,
  // and popover auto-close when the controls bar hides itself.
  // ---------------------------------------------------------------------------

  // Consume a one-shot resume request (recent-history click). If the media
  // element is already ready, seek immediately; otherwise park the target so
  // `loadedmetadata` picks it up. The store `resumeAt` field is cleared in the
  // same render the source becomes available, to prevent a stale re-fire on a
  // future load.
  useEffect(() => {
    if (resumeAt === null) return;
    const target = resumeAt;
    setResumeAt(null);
    if (isNative) {
      // Park the target; it is applied on the first native clock tick once the
      // file is loaded (or by the `mpv-loaded` handler if that wins the race).
      pendingResumeRef.current = target;
      if (nativeLoadedRef.current) {
        seekNativeRef.current(target);
      }
      return;
    }
    const video = videoRef.current;
    if (!video || !videoSource) {
      // Media not ready (or the engine hasn't been decided yet — native
      // detection is async): park the target and let whichever engine wins
      // apply it once the file actually loads.
      pendingResumeRef.current = target;
      return;
    }
    if (video.readyState >= 1) {
      const clamped = Math.max(0, Math.min(video.duration || target, target));
      video.currentTime = clamped;
      setCurrentTime(clamped);
      notifyPipelineSeekRef.current(clamped);
    } else {
      pendingResumeRef.current = target;
    }
  }, [resumeAt, videoSource, setResumeAt, setCurrentTime, isNative]);

  // Apply playback speed to any freshly loaded video and re-apply when the
  // user picks a new rate while a video is already running. Native playback
  // is driven by `mpv_set_speed` instead (see `applyPlaybackRate`).
  useEffect(() => {
    if (isNative) return;
    if (!videoSource || !videoRef.current) return;
    videoRef.current.playbackRate = playbackRate;
  }, [playbackRate, videoSource, isNative]);

  // Upsert a recent-history entry each time a new path is loaded so the home
  // screen always lists it. Existing `lastPlayedTimestamp` values are preserved;
  // the dedicated `touchRecentFile` writes are responsible for updating the
  // playhead position.
  useEffect(() => {
    if (!currentVideoPath) return;
    const name = currentVideoPath.split(/[\\/]/).pop() || "Untitled";
    upsertRecentFile(currentVideoPath, name);
  }, [currentVideoPath, upsertRecentFile]);

  // Persist the playhead on pause / ended (the `isPlaying` flag flips to
  // false in both cases). The throttle inside `maybeRecordPlayback` covers
  // periodic mid-playback saves; this handler catches the final position
  // a timed save may miss.
  useEffect(() => {
    if (isPlaying) return;
    const s = useAppStore.getState();
    if (s.currentVideoPath) touchRecentFile(s.currentVideoPath, s.currentTime);
  }, [isPlaying, touchRecentFile]);

  // Last-chance save when the player unmounts (tab close, drag new file, etc.)
  useEffect(
    () => () => {
      const s = useAppStore.getState();
      if (s.currentVideoPath) s.touchRecentFile(s.currentVideoPath, s.currentTime);
    },
    []
  );

  // When the controls bar auto-hides (user idle while playing), dismiss any
  // open popover so it doesn't linger as a ghost over the video.
  useEffect(() => {
    if (!showControls) {
      setShowCCMenu(false);
      setShowSpeedMenu(false);
      setShowQuickSettings(false);
    }
  }, [showControls]);

  const sortCues = (list: SubtitleCue[]) =>
    [...list].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);

  const getCurrentCue = (track: typeof activeTrack) => {
    if (!track) return null;
    if (!isNative && !videoRef.current) return null;
    return track.cues.find(
      (cue) => currentClock >= cue.startTime && currentClock <= cue.endTime
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
          if (engineRef.current === "mpv") {
            void TauriService.mpvPlay().catch(() => setIsPlaying(false));
          } else {
            videoRef.current?.play().catch(() => setIsPlaying(false));
          }
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
                if (engineRef.current === "mpv") {
                  void TauriService.mpvPlay().catch(() => setIsPlaying(false));
                } else {
                  videoRef.current?.play().catch(() => setIsPlaying(false));
                }
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

  // Native mpv engine: mirror its playback clock into the store (there is no
  // <video> element firing `timeupdate`), and apply resume / volume / speed on
  // the first observed tick so it never races the backend's `mpv-loaded` event.
  useEffect(() => {
    if (!isTauri() || engine !== "mpv") return;
    let disposed = false;
    let unlistenTime: (() => void) | null = null;
    let unlistenLoaded: (() => void) | null = null;

    const applyNativePrefsAndResume = () => {
      if (resumeAppliedRef.current) return;
      resumeAppliedRef.current = true;
      const prefs = prefsRef.current;
      void TauriService.mpvSetVolume(prefs.isMuted ? 0 : prefs.volume * 100).catch(() => {});
      void TauriService.mpvSetSpeed(prefs.playbackRate).catch(() => {});
      const resume = pendingResumeRef.current;
      if (resume != null) {
        pendingResumeRef.current = null;
        // Go through the unified funnel: pipeline flush → mpv seek.
        seekNativeRef.current(resume);
      }
    };

    void (async () => {
      unlistenTime = await listen<MpvTimeUpdatePayload>("mpv-timeupdate", (event) => {
        if (disposed) return;
        const { position = 0, duration = 0, paused = false, ended = false } =
          event.payload ?? {};
        const clamped = Math.max(0, position);
        setMpvClock({ position: clamped, duration: Math.max(0, duration) });
        setCurrentTime(clamped);
        if (ended) {
          setIsPlaying(false);
        } else {
          setIsPlaying(!paused);
        }
        recordPlaybackRef.current();
        if (duration > 0) applyNativePrefsAndResume();
      });
      unlistenLoaded = await listen("mpv-loaded", () => {
        if (disposed) return;
        nativeLoadedRef.current = true;
        applyNativePrefsAndResume();
      });
    })();

    return () => {
      disposed = true;
      unlistenTime?.();
      unlistenLoaded?.();
      void TauriService.mpvStop().catch(() => {});
    };
    // Registers/unregisters only when the engine actually switches to mpv.
  }, [engine]);

  // Keep the embedded mpv surface glued to the DOM video stage: any layout
  // change (window resize, sidebar/toolbar reflow, fullscreen toggle) is
  // re-anchored through `mpv_set_layout`. A rAF chip beats ResizeObserver here
  // because it also catches *moves* (rect shifts without a size change), and
  // IPC is coalesced to whole CSS pixels so it never spams the backend.
  useEffect(() => {
    if (!isTauri() || engine !== "mpv") return;
    const stage = nativeStageRef.current;
    if (!stage) return;
    let disposed = false;
    let lastKey = "";
    const report = () => {
      if (disposed) return;
      const r = stage.getBoundingClientRect();
      const key = `${Math.round(r.x)}:${Math.round(r.y)}:${Math.round(r.width)}:${Math.round(
        r.height
      )}`;
      if (key === lastKey) return;
      lastKey = key;
      void TauriService.mpvSetLayout({ x: r.x, y: r.y, width: r.width, height: r.height }).catch(
        () => {}
      );
    };
    report();
    if (typeof requestAnimationFrame !== "function") return;
    let raf = 0;
    const loop = () => {
      if (disposed) return;
      report();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
    };
  }, [engine]);

  // Cutover guard: if mpv ever loses the embedded surface (the backend emits
  // `mpv-embed-lost` the moment the wid stops resolving to our host surface),
  // the rogue floating window must never masquerade as in-app playback — fall
  // straight back to HTML5 so the user keeps a working, embedded picture.
  useEffect(() => {
    if (!isTauri() || engine !== "mpv") return;
    let disposed = false;
    let unlistenEmbedLost: (() => void) | null = null;
    void (async () => {
      unlistenEmbedLost = await listen("mpv-embed-lost", () => {
        if (disposed) return;
        console.error("Native mpv surface lost — falling back to HTML5");
        nativeLoadedRef.current = false;
        resumeAppliedRef.current = false;
        setEngine("html5");
        const path = currentVideoPath;
        if (path) {
          TauriService.getVideoBlobUrl(path)
            .then((blobUrl) => {
              if (!disposed) setVideoSource(blobUrl);
            })
            .catch((err) => {
              if (!disposed) setVideoSource(null);
              console.error("HTML5 fallback blob load failed:", err);
            });
        }
      });
    })();
    return () => {
      disposed = true;
      unlistenEmbedLost?.();
    };
  }, [engine, currentVideoPath]);

  const handleToggleSubtitles = () => {
    const turningOn = !showSubtitles;
    setShowSubtitles(turningOn);
    if (turningOn && subtitleTracks.length === 0 && !isTranscribing) {
      transcribeVideoRef.current();
    }
  };

  // Handle video source management & engine selection. A browser-supplied
  // URL always uses the HTML5 engine; a filesystem path (Tauri) prefers the
  // native mpv surface and falls back to an HTML5 blob URL on any failure.
  // When both a URL and a path are present (recent-history / library clicks),
  // the path wins so native playback is not bypassed by a pre-fetched blob.
  useEffect(() => {
    if (currentVideoUrl && !currentVideoPath) {
      setEngine("html5");
      setVideoSource(currentVideoUrl);
    }
  }, [currentVideoUrl, currentVideoPath]);

  useEffect(() => {
    if (currentVideoPath && isTauri()) {
      let isMounted = true;
      setVideoSource(null);
      // A new file landed while the native engine was active: the listener
      // effect does not re-register (same `engine`), so flag it to re-apply
      // volume/speed and any parked resume on the next observed tick.
      nativeLoadedRef.current = false;
      resumeAppliedRef.current = false;
      void (async () => {
        let useNative = false;
        try {
          useNative = await TauriService.isNativePlayerAvailable();
        } catch (err) {
          console.error("Native player availability check failed:", err);
        }
        if (!isMounted) return;
        if (useNative) {
          setEngine("mpv");
          try {
            await TauriService.mpvLoad(currentVideoPath);
          } catch (err) {
            console.error("Native playback failed; falling back to HTML5:", err);
            if (!isMounted) return;
            setEngine("html5");
            try {
              const blobUrl = await TauriService.getVideoBlobUrl(currentVideoPath);
              if (isMounted) setVideoSource(blobUrl);
            } catch (error) {
              console.error("Failed to load video from path:", error);
            }
          }
        } else {
          setEngine("html5");
          try {
            const blobUrl = await TauriService.getVideoBlobUrl(currentVideoPath);
            if (isMounted) setVideoSource(blobUrl);
          } catch (error) {
            console.error("Failed to load video from path:", error);
          }
        }
      })();
      return () => {
        isMounted = false;
      };
    } else if (!currentVideoPath && !currentVideoUrl) {
      setEngine(null);
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

  // Open a previously-watched video from the home-screen recent list. The
  // file is loaded through the regular engine pipeline (native mpv, or the
  // HTML5 blob-URL fallback) purely by setting the path; a one-shot `resumeAt`
  // field is then dispatched so the player seeks to the saved playhead once
  // the media actually loads.
  const openRecentFile = (filePath: string, timestamp: number) => {
    if (!isTauri()) return;
    resetSubtitles();
    setCurrentVideo(null);
    setCurrentVideoUrl(null);
    setCurrentVideoPath(filePath);
    setResumeAt(timestamp);
    emit("zanplayer-lite:video-dropped");
  };

  // Quick-settings / speed popovers – mutually exclusive with the CC menu.
  const toggleSpeedMenu = () => {
    if (showSpeedMenu) setShowSpeedMenu(false);
    else {
      setShowSpeedMenu(true);
      setShowCCMenu(false);
      setShowQuickSettings(false);
    }
  };

  const toggleQuickSettings = () => {
    if (showQuickSettings) setShowQuickSettings(false);
    else {
      setShowQuickSettings(true);
      setShowCCMenu(false);
      setShowSpeedMenu(false);
    }
  };

  const applyPlaybackRate = (rate: number) => {
    setPlaybackRate(rate);
    if (isNative) {
      void TauriService.mpvSetSpeed(rate).catch(() => {});
    } else if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
    setShowSpeedMenu(false);
  };

  const outputModeLabel =
    OUTPUT_MODES.find((m) => m.value === subtitleMode)?.name ?? "English Only";
  const genModeLabel =
    transcriptionMode === "batch" ? "Full (Batch)" : "Realtime (Streaming)";

  // Filename shown in the title OSD (derived from the real filesystem path, or
  // the browser-dropped File when no path exists).
  const videoTitle = currentVideoPath
    ? currentVideoPath.split(/[\\/]/).pop() || null
    : currentVideo?.name || null;

  return (
    <div
      className={cn(
        "relative w-full h-full group",
        // Native mpv draws behind the transparent webview stage, so the player
        // root must stay transparent; HTML5 keeps an opaque letterbox.
        isNative ? "" : "bg-black"
      )}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && setShowControls(false)}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
    >
      {isNative || videoSource ? (
        <>
          {isNative ? (
            <div
              ref={nativeStageRef}
              className="relative z-0 w-full h-full"
              role="group"
              aria-label="Native video surface"
              data-native-stage
            >
              {/* Clear placeholder for the native stage: mpv renders its video
                  view INTO this region, below the transparent webview layer.
                  The root stays transparent (no background class) so the
                  decoded frames show through behind the DOM overlay stack. */}
            </div>
          ) : (
          <video
            ref={videoRef}
            src={videoSource ?? undefined}
            className="relative z-0 w-full h-full object-contain"
            onTimeUpdate={handleTimeUpdate}
            onSeeked={handleSeeked}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
            onLoadedMetadata={() => {
              if (videoRef.current) {
                videoRef.current.volume = volume;
                videoRef.current.muted = isMuted;
                videoRef.current.playbackRate = playbackRate;
                // One-shot resume for recent-history clicks: the playhead jumps
                // to the saved position before playback starts so the user picks
                // up exactly where they left off.
                if (pendingResumeRef.current != null) {
                  const target = pendingResumeRef.current;
                  pendingResumeRef.current = null;
                  const clamped = Math.max(0, Math.min(videoRef.current.duration || target, target));
                  videoRef.current.currentTime = clamped;
                  setCurrentTime(clamped);
                  notifyPipelineSeekRef.current(clamped);
                }
                // Autoplay the moment media is ready. Transcription never blocks
                // playback in V2 — captions stream in behind the video.
                if (pendingPlayRef.current) {
                  pendingPlayRef.current = false;
                  videoRef.current.play().catch(() => setIsPlaying(false));
                }
              }
            }}
          ></video>
          )}

          {/* Audio-only visualizer placeholder */}
          {!isNative && videoRef.current && videoRef.current.videoWidth === 0 && videoRef.current.videoHeight === 0 && (
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

          {/* Video Title OSD — fades in/out with the control bar */}
          {videoTitle && (
            <div
              className={cn(
                "absolute top-0 left-0 right-0 bg-gradient-to-b from-black/80 to-transparent px-6 py-4 transition-opacity duration-300 pointer-events-none z-10",
                showControls ? "opacity-100" : "opacity-0"
              )}
            >
              <h1 className="text-white text-base font-semibold truncate">{videoTitle}</h1>
            </div>
          )}

          {/* Subtitle Overlay — explicit high z-index (z-30): the dual-pass
              container must always sit above the video surface and the
              play/pause overlay, below the controls bar. */}
          {showSubtitles && (currentCue || originalCue || translationCue) && (
            <div
              className={cn(
                "absolute left-0 right-0 flex flex-col items-center px-4 pointer-events-none z-30",
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

          {/* Play/Pause Overlay — above the video surface, below subtitles. */}
          <div
            className="absolute inset-0 z-20 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity"
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

          {/* Controls Bar — top overlay layer for all DOM chrome. */}
          <div
            className={cn(
              "absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-6 py-4 transition-opacity duration-300 z-40",
              showControls ? "opacity-100" : "opacity-0"
            )}
          >
            {/* Progress Bar */}
            <div className="mb-4">
              <input
                type="range"
                min="0"
                max={durationClock || 100}
                value={currentClock}
                onChange={handleSeek}
                className="w-full h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-zan-cyan"
              />
              <div className="flex justify-between text-xs text-gray-300 mt-1">
                <span>{formatTime(currentClock)}</span>
                <span>{formatTime(durationClock)}</span>
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
                {/* Playback speed selector */}
                <div className="relative" data-speed-menu>
                  <button
                    onClick={toggleSpeedMenu}
                    className={cn(
                      "flex items-center justify-center py-0.5 px-2 rounded-[4px] border transition-colors text-xs font-semibold",
                      showSpeedMenu
                        ? "text-zan-cyan border-zan-cyan/70 bg-zan-cyan/10"
                        : "text-white/80 border-white/70 hover:text-zan-cyan hover:border-zan-cyan/70"
                    )}
                    title="Playback speed"
                  >
                    {playbackRate}x
                  </button>

                  {showSpeedMenu && (
                    <div className="absolute bottom-full right-0 mb-3 z-30 bg-zan-black/95 backdrop-blur rounded-xl shadow-2xl border border-gray-700 min-w-[130px] overflow-hidden">
                      {SPEED_RATES.map((rate) => (
                        <button
                          key={rate}
                          onClick={() => applyPlaybackRate(rate)}
                          className={cn(
                            "w-full flex items-center justify-between gap-3 px-3 py-2 text-sm transition-colors",
                            playbackRate === rate
                              ? "text-zan-cyan bg-zan-blue/25"
                              : "text-gray-300 hover:bg-zan-blue/15"
                          )}
                        >
                          {rate}x
                          {playbackRate === rate && <CheckCircle2 className="w-4 h-4" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="relative" data-cc-menu>
                  <button
                    onClick={() => {
                      if (showCCMenu) setShowCCMenu(false);
                      else {
                        setShowCCMenu(true);
                        setShowSpeedMenu(false);
                        setShowQuickSettings(false);
                        setCcMenuView("root");
                      }
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
                    <div className="absolute bottom-full right-0 mb-3 z-30 bg-zan-black/95 backdrop-blur rounded-xl shadow-2xl border border-gray-700 min-w-[220px] overflow-hidden">
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

                {/* Quick Settings gear */}
                <div className="relative" data-quick-settings>
                  <button
                    onClick={toggleQuickSettings}
                    className={cn(
                      "p-0.5 rounded-[4px] transition-colors",
                      showQuickSettings
                        ? "text-zan-cyan"
                        : "text-white hover:text-zan-cyan"
                    )}
                    title="Quick Settings"
                  >
                    <Settings2 className="w-6 h-6" />
                  </button>

                  {showQuickSettings && (
                    <div className="absolute bottom-28 right-0 z-50 w-72 bg-zan-black/95 backdrop-blur rounded-xl shadow-2xl border border-gray-700 p-4">
                      <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                        <Settings2 className="w-4 h-4" />
                        Quick Settings
                      </h3>

                      <div className="space-y-4">
                        {/* Subtitle Size */}
                        <div>
                          <label className="text-xs text-gray-400 block mb-1.5 font-medium">
                            Subtitle Size
                          </label>
                          <div className="flex items-center gap-2">
                            <input
                              type="range"
                              min="12"
                              max="72"
                              value={subtitleStyle.fontSize}
                              onChange={(e) =>
                                setSubtitleStyle({ fontSize: parseInt(e.target.value, 10) })
                              }
                              aria-label="Subtitle Size"
                              className="flex-1 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-zan-cyan"
                            />
                            <span className="w-10 text-right text-xs text-white font-mono">
                              {subtitleStyle.fontSize}px
                            </span>
                          </div>
                        </div>

                        {/* Subtitle Color */}
                        <div>
                          <label className="text-xs text-gray-400 block mb-1.5 font-medium">
                            Subtitle Color
                          </label>
                          <div className="flex items-center gap-2">
                            <span className="relative h-8 w-10 rounded-lg border border-gray-600 overflow-hidden shrink-0">
                              <span
                                className="absolute inset-0"
                                style={{ background: subtitleStyle.primaryColor }}
                              />
                              <input
                                type="color"
                                value={subtitleStyle.primaryColor}
                                onChange={(e) =>
                                  setSubtitleStyle({ primaryColor: e.target.value })
                                }
                                aria-label="Subtitle Color"
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                              />
                            </span>
                            <input
                              type="text"
                              value={subtitleStyle.primaryColor}
                              onChange={(e) =>
                                setSubtitleStyle({ primaryColor: e.target.value })
                              }
                              spellCheck={false}
                              className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg text-xs font-mono border bg-zan-black/60 border-gray-700/60 text-gray-100 focus:outline-none focus:ring-1 focus:ring-zan-cyan"
                            />
                          </div>
                        </div>

                        {/* Transcription Mode */}
                        <div>
                          <label className="text-xs text-gray-400 block mb-1.5 font-medium">
                            Transcription Mode
                          </label>
                          <div className="flex p-0.5 rounded-lg border border-gray-700/60 bg-zan-black/60">
                            <button
                              onClick={() => setTranscriptionMode("stream")}
                              className={cn(
                                "px-3 py-1 rounded-md text-xs font-medium transition-colors flex-1",
                                transcriptionMode === "stream"
                                  ? "bg-zan-cyan/15 text-zan-cyan"
                                  : "text-gray-400 hover:text-white"
                              )}
                            >
                              Realtime
                            </button>
                            <button
                              onClick={() => setTranscriptionMode("batch")}
                              className={cn(
                                "px-3 py-1 rounded-md text-xs font-medium transition-colors flex-1",
                                transcriptionMode === "batch"
                                  ? "bg-zan-cyan/15 text-zan-cyan"
                                  : "text-gray-400 hover:text-white"
                              )}
                            >
                              Full (Batch)
                            </button>
                          </div>
                        </div>
                      </div>
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
        <div className={cn(
          "flex flex-col items-center justify-center w-full h-full text-gray-500 overflow-y-auto px-6 py-8",
          theme === "dark" ? "bg-zan-black" : "bg-gray-50"
        )}>
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

          {/* Recent History */}
          {recentFiles.length > 0 && (
            <div className="mt-10 w-full max-w-md">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 flex items-center gap-2 mb-3">
                <History className="w-4 h-4" />
                Recent History
              </h3>
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {recentFiles.map((item) => (
                  <div
                    key={item.path}
                    onClick={() => openRecentFile(item.path, item.lastPlayedTimestamp)}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl text-left border border-white/10 bg-white/5 hover:bg-white/10 transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <FileVideo className="w-5 h-5 text-gray-400 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-200 truncate">{item.fileName}</p>
                        <p className="text-xs text-gray-500">
                          Resume at {formatTime(item.lastPlayedTimestamp)}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeRecentFile(item.path);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/20 rounded-lg text-gray-400 hover:text-red-400 transition-all shrink-0"
                      title="Remove from history"
                      aria-label={`Remove ${item.fileName} from history`}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};