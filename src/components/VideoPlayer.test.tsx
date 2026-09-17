import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

type EmitFn = (event: { payload?: unknown }) => void;

const { listeners, invoke, emit } = vi.hoisted(() => ({
  listeners: {} as Record<string, EmitFn>,
  invoke: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: EmitFn) => {
    listeners[name] = cb;
    return Promise.resolve(() => {});
  },
  emit,
}));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn().mockResolvedValue("/home"),
}));

import { VideoPlayer } from "./VideoPlayer";
import { Sidebar } from "./Sidebar";
import { useAppStore } from "../services/store";
import type { SubtitleCue } from "../types/subtitle";

const backendCue = (
  id: string,
  text: string,
  startTime: number,
  endTime: number,
  kind: string
) => ({ id, start_time: startTime, end_time: endTime, text, kind });

/** Open the CC menu and flip the Subtitles toggle on, which kicks off
 * transcription through the same user path as the real app. */
const startTranscriptionViaUi = async () => {
  fireEvent.click(screen.getByText("CC")); // open the CC menu
  fireEvent.click(screen.getByText("Subtitles")); // flip the toggle -> transcribeVideo()
};

const currentTime = (t: number) => {
  const video = document.querySelector("video");
  expect(video).toBeTruthy();
  (video as HTMLVideoElement).currentTime = t;
};

describe("VideoPlayer dual-pass rendering", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.keys(listeners).forEach((k) => delete listeners[k]);
    invoke.mockReset();
    emit.mockClear();
    useAppStore.setState({
      currentVideo: null,
      currentVideoUrl: "https://media.example/video.mp4",
      currentVideoPath: "/tmp/media.wav",
      subtitleTracks: [],
      activeSubtitleTrackId: null,
      showSubtitles: false,
      currentTime: 0,
      isPlaying: false,
      isTranscribing: false,
      transcriptionProgress: 0,
      subtitleMode: "both",
      transcriptionMode: "stream",
      sourceLanguage: "my",
      seekTo: null,
      resumeAt: null,
      recentFiles: [],
      playbackRate: 1,
      sidebarVisible: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("streams the original pass first, then merges the translation into a dual overlay", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "start_transcription") return undefined;
      if (cmd === "poll_transcript_cues") return polled.shift() ?? [];
      if (cmd === "transcription_active") return true;
      return undefined;
    });

    // Whisper decodes the source pass first; the English pass lands one poll later.
    const polled: unknown[][] = [
      [backendCue("o1", "မင်္ဂလာပါ", 4, 6, "original")],
      [backendCue("t1", "Hello", 4, 6, "translation")],
    ];

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    currentTime(5);

    await startTranscriptionViaUi();

    // The invocation must carry the requested output + generation modes and the
    // pinned source language (Burmese -> "my"), never a hardcoded English task.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "start_transcription",
        expect.objectContaining({ subtitleMode: "both", transcriptionMode: "stream", language: "my" })
      )
    );

    // Original pass lands first -> single-mode overlay shows source captions.
    await waitFor(() => expect(screen.getByText("မင်္ဂလာပါ")).toBeTruthy(), { timeout: 3000 });
    expect(screen.queryByText("Hello")).toBeNull();

    // A poll later the translation arrives -> dual mode stacks both lines.
    await waitFor(() => expect(screen.getByText("Hello")).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText("မင်္ဂလာပါ")).toBeTruthy();

    // Both cues were routed to their own generated track, each kind-pure.
    const tracks = useAppStore.getState().subtitleTracks;
    expect(tracks.map((t) => t.name).sort()).toEqual([
      "Auto-Generated (English)",
      "Auto-Generated (Original)",
    ]);
    expect(tracks.flatMap((t) => t.cues).map((c) => c.kind).sort()).toEqual([
      "original",
      "translation",
    ]);
  });

  it("batch mode delivers complete dual tracks in one shot with no polling and no duplicates", async () => {
    useAppStore.setState({ transcriptionMode: "batch" });
    let pollCalls = 0;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "start_transcription") return undefined;
      if (cmd === "poll_transcript_cues") {
        pollCalls += 1;
        return [];
      }
      if (cmd === "transcription_active") return true;
      return undefined;
    });

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    currentTime(5);

    await startTranscriptionViaUi();
    await waitFor(() => expect(useAppStore.getState().isTranscribing).toBe(true));

    // The full job completes and hands both timelines to the UI at once.
    await act(async () => {
      listeners["transcription-batch-done"]!({
        payload: {
          tracks: [
            {
              kind: "original",
              language: "my",
              cues: [{ id: "o1", startTime: 4, endTime: 6, text: "မင်္ဂလာပါ", kind: "original" }],
            },
            {
              kind: "translation",
              language: "en",
              cues: [{ id: "t1", startTime: 4, endTime: 6, text: "Hello", kind: "translation" }],
            },
          ],
        },
      });
    });

    await waitFor(() => expect(screen.getByText("Hello")).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText("မင်္ဂလာပါ")).toBeTruthy();
    expect(useAppStore.getState().isTranscribing).toBe(false);
    expect(useAppStore.getState().transcriptionProgress).toBe(100);

    const tracks = useAppStore.getState().subtitleTracks;
    expect(tracks).toHaveLength(2);

    // Zero-latency delivery: the UI never polls the render queue in batch mode.
    expect(pollCalls).toBe(0);

    // A duplicate delivery must not accumulate tracks (replace semantics).
    await act(async () => {
      listeners["transcription-batch-done"]!({
        payload: { tracks: useAppStore.getState().subtitleTracks.map((t) => ({ ...t, cues: t.cues as SubtitleCue[] })) },
      });
    });
    expect(useAppStore.getState().subtitleTracks).toHaveLength(2);
  });

  it("a store-dispatched cue seek wins over stale timeupdate reports and syncs on seeked", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "start_transcription") return undefined;
      return undefined;
    });

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    const video = document.querySelector("video") as HTMLVideoElement;
    video.currentTime = 0;

    // SubtitleEditor click dispatches a store seek, mimicked for the player.
    await act(async () => {
      useAppStore.getState().setSeekTo(8);
    });

    // Optimistic clock + immediate media jump, same frame as the click.
    expect(useAppStore.getState().currentTime).toBe(8);
    expect(video.currentTime).toBe(8);

    // A stale `timeupdate` racing in from the pre-seek position must not
    // regress the clock (and therefore the editor's active-cue highlight).
    video.currentTime = 2;
    fireEvent.timeUpdate(video);
    expect(useAppStore.getState().currentTime).toBe(8);

    // The engine confirms the seek; the handler syncs the true position...
    video.currentTime = 8.4;
    fireEvent.seeked(video);
    expect(useAppStore.getState().currentTime).toBe(8.4);

    // ...and live playback updates resume flowing normally again.
    video.currentTime = 9.5;
    fireEvent.timeUpdate(video);
    expect(useAppStore.getState().currentTime).toBe(9.5);
  });

  it("realtime mode notifies the streaming job on a skip so the WAV reader repositions", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "start_transcription") return undefined;
      if (cmd === "poll_transcript_cues") return [];
      if (cmd === "transcription_active") return true;
      return undefined;
    });

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    const video = document.querySelector("video") as HTMLVideoElement;
    video.currentTime = 10;

    await startTranscriptionViaUi();
    await waitFor(() => expect(useAppStore.getState().isTranscribing).toBe(true));

    // ArrowRight = skip +5s; the live pass must drop its VAD/utterance state
    // and resume from the playhead's new position (PTS 15), never the stale
    // pre-seek audio it was decoding.
    fireEvent.keyDown(window, { code: "ArrowRight" });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("seek_transcription", {
        mediaPath: "/tmp/media.wav",
        seekTo: 15,
      })
    );
  });

  it("batch mode never pokes the streaming job: all cues arrive up-front", async () => {
    useAppStore.setState({ transcriptionMode: "batch" });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "start_transcription") return undefined;
      if (cmd === "poll_transcript_cues") return [];
      if (cmd === "transcription_active") return true;
      return undefined;
    });

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    const video = document.querySelector("video") as HTMLVideoElement;
    video.currentTime = 10;

    await startTranscriptionViaUi();
    await waitFor(() => expect(useAppStore.getState().isTranscribing).toBe(true));

    fireEvent.keyDown(window, { code: "ArrowRight" });
    fireEvent.keyDown(window, { code: "ArrowLeft" });

    const seekCalls = invoke.mock.calls.filter(([cmd]) => cmd === "seek_transcription");
    expect(seekCalls).toHaveLength(0);
  });

  it("drains only the started job's cues: polls carry the job id, stale completions are ignored", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "start_transcription") return undefined;
      if (cmd === "poll_transcript_cues") return [{ id: "x", start_time: 1, end_time: 3, text: "cue", kind: "original" }];
      if (cmd === "transcription_active") return true;
      return undefined;
    });

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    currentTime(2);

    await startTranscriptionViaUi();
    await waitFor(() => expect(useAppStore.getState().isTranscribing).toBe(true));

    // Every queue poll targets the exact job the frontend started.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("poll_transcript_cues", { jobId: expect.any(Number) })
    );

    // A completion from a *different* (previous video's) run is dropped: the
    // current job stays active so its cues keep streaming.
    await act(async () => {
      listeners["transcription-done"]!({ payload: { job_id: 999999, total: 3 } });
    });
    expect(useAppStore.getState().isTranscribing).toBe(true);
    expect(useAppStore.getState().transcriptionProgress).not.toBe(100);

    // The matching run's completion finalizes normally.
    await act(async () => {
      listeners["transcription-done"]!({ payload: { total: 3 } });
    });
    await waitFor(() => expect(useAppStore.getState().isTranscribing).toBe(false));
    expect(useAppStore.getState().transcriptionProgress).toBe(100);
  });

  it("a missed completion event cannot strand the flag: transcription_active clears it", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "start_transcription") return undefined;
      if (cmd === "poll_transcript_cues") return [];
      if (cmd === "transcription_active") return false; // job already done, event was missed
      return undefined;
    });

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());

    await startTranscriptionViaUi();
    await waitFor(() => expect(useAppStore.getState().isTranscribing).toBe(true));

    // The status probe notices the backend finished and un-sticks the flag so
    // a later video can still auto-transcribe.
    await waitFor(() => expect(useAppStore.getState().isTranscribing).toBe(false));
    expect(useAppStore.getState().transcriptionProgress).toBe(100);
  });

  it("changing the spoken language regenerates the generated track in the new language", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "start_transcription") return undefined;
      if (cmd === "transcription_active") return true;
      return undefined;
    });
    useAppStore.setState({
      subtitleTracks: [
        {
          id: "track-gen",
          name: "Auto-Generated (Original)",
          language: "my",
          isGenerated: true,
          cues: [{ id: "c1", startTime: 1, endTime: 3, text: "မင်္ဂလာပါ", kind: "original" }],
        },
      ],
      activeSubtitleTrackId: "track-gen",
      showSubtitles: true,
      isTranscribing: false,
      sourceLanguage: "my",
    });

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());

    await act(async () => {
      useAppStore.getState().setSourceLanguage("ko");
    });

    // The stale generated track is dropped and a fresh job is pinned to "ko".
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "start_transcription",
        expect.objectContaining({ language: "ko", mediaPath: "/tmp/media.wav" })
      )
    );
    expect(useAppStore.getState().subtitleTracks.every((t) => !t.isGenerated)).toBe(true);
  });

  it("retries a failed transcription in place: fresh job id, generated tracks wiped, no video reload", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "start_transcription") return undefined;
      if (cmd === "poll_transcript_cues") return [];
      if (cmd === "transcription_active") return true;
      return undefined;
    });
    useAppStore.setState({
      showSubtitles: true, // auto-transcribe fires on mount like a fresh drop
      isTranscribing: false,
      subtitleTracks: [],
    });

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "start_transcription",
      expect.objectContaining({ mediaPath: "/tmp/media.wav" })
    ));
    const firstJobId = invoke.mock.calls.find((c) => c[0] === "start_transcription")![1].jobId as number;
    expect(firstJobId).toBeTypeOf("number");

    // A partial generated track may have streamed in before the run died; the
    // retry must drop it so it can't linger under the fresh regenerated cues.
    useAppStore.setState({
      subtitleTracks: [
        { id: "track-partial", name: "Auto-Generated (Original)", language: "my", isGenerated: true, cues: [] },
      ],
    });

    await act(async () => {
      listeners["transcription-error"]!({
        payload: { job_id: firstJobId, message: "decode exploded" },
      });
    });
    expect(useAppStore.getState().isTranscribing).toBe(false);

    // The failure is surfaced with a Retry affordance in the CC menu.
    fireEvent.click(screen.getByText("CC"));
    await waitFor(() => expect(screen.getByText("decode exploded")).toBeTruthy());
    fireEvent.click(screen.getByText("Retry"));

    // Same file, brand-new job id — the current video stays loaded (no reload).
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter((c) => c[0] === "start_transcription").length
      ).toBeGreaterThanOrEqual(2)
    );
    const lastJobId = [...invoke.mock.calls]
      .reverse()
      .find((c) => c[0] === "start_transcription")![1].jobId as number;
    expect(lastJobId).not.toBe(firstJobId);
    expect(invoke).toHaveBeenCalledWith(
      "start_transcription",
      expect.objectContaining({ mediaPath: "/tmp/media.wav", jobId: lastJobId })
    );
    expect(useAppStore.getState().subtitleTracks.every((t) => !t.isGenerated)).toBe(true);
    expect(screen.queryByText("decode exploded")).toBeNull();
    expect(useAppStore.getState().isTranscribing).toBe(true);
  });
});

describe("VideoPlayer quality-of-life features", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.keys(listeners).forEach((k) => delete listeners[k]);
    invoke.mockReset();
    emit.mockClear();
    useAppStore.setState({
      currentVideo: null,
      currentVideoUrl: "https://media.example/video.mp4",
      currentVideoPath: "/tmp/media.wav",
      subtitleTracks: [],
      activeSubtitleTrackId: null,
      showSubtitles: false,
      currentTime: 0,
      isPlaying: false,
      isTranscribing: false,
      transcriptionProgress: 0,
      subtitleMode: "english",
      transcriptionMode: "stream",
      sourceLanguage: "auto",
      seekTo: null,
      resumeAt: null,
      recentFiles: [],
      playbackRate: 1,
      sidebarVisible: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the extracted filename as a title OSD on the loaded video", async () => {
    invoke.mockImplementation(async () => undefined);

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    expect(screen.getByText("media.wav")).toBeTruthy();
  });

  it("clicking a recent-history item resumes playback at the saved timestamp", async () => {
    useAppStore.setState({
      currentVideoUrl: null,
      currentVideoPath: null,
      recentFiles: [
        { path: "/videos/movie.mp4", fileName: "movie.mp4", lastPlayedTimestamp: 90 },
      ],
    });
    render(<VideoPlayer />);

    // Home-screen history list is shown on the empty state.
    expect(screen.getByText("Recent History")).toBeTruthy();
    expect(screen.getByText("movie.mp4")).toBeTruthy();

    fireEvent.click(screen.getByText("movie.mp4"));
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    await waitFor(() =>
      expect(useAppStore.getState().currentVideoPath).toBe("/videos/movie.mp4")
    );

    // The one-shot resume request is consumed once the media is ready.
    await waitFor(() => expect(useAppStore.getState().resumeAt).toBeNull());

    // loadedmetadata applies the parked resume position before autoplay.
    const video = document.querySelector("video") as HTMLVideoElement;
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(90);
    expect(useAppStore.getState().currentTime).toBe(90);

    // The file stays in history (upsert preserved its saved position).
    expect(useAppStore.getState().recentFiles[0].fileName).toBe("movie.mp4");
  });

  it("[hasMedia] placeholders unmount the moment a media path is set, even while engine detection is pending", async () => {
    useAppStore.setState({
      currentVideoUrl: null,
      currentVideoPath: null,
      recentFiles: [],
    });
    // Engine detection HANGS (never resolves) — the frontend must not wait for
    // it: as soon as a file path lands, the "Select a video" / keyboard
    // shortcuts / Recent History placeholder container must unmount completely
    // so no placeholder text can ever sit over an active video.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return new Promise(() => {});
      return undefined;
    });

    render(<VideoPlayer />);
    expect(screen.getByText("Select a video or audio file to start")).toBeTruthy();

    act(() => {
      useAppStore.setState({ currentVideoPath: "/tmp/media.mp4" });
    });

    // No engine decided yet, no blob resolved — but the placeholders are gone.
    expect(screen.queryByText("Select a video or audio file to start")).toBeNull();
    expect(screen.queryByText("Recent History")).toBeNull();
    expect(screen.queryByText("Keyboard shortcuts:")).toBeNull();
    // The stage element is already mounted so playback UI can take over.
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
  });

  it("playback speed selector applies the rate to the store and the media element", async () => {
    invoke.mockImplementation(async () => undefined);

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());

    fireEvent.click(screen.getByTitle("Playback speed"));
    fireEvent.click(screen.getByText("1.5x"));

    expect(useAppStore.getState().playbackRate).toBe(1.5);
    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video.playbackRate).toBe(1.5);
  });

  it("quick settings adjust subtitle size/color and the transcription mode", async () => {
    invoke.mockImplementation(async () => undefined);

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());

    fireEvent.click(screen.getByTitle("Quick Settings"));
    expect(screen.getByText("Subtitle Size")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Subtitle Size"), { target: { value: "42" } });
    expect(useAppStore.getState().subtitleStyle.fontSize).toBe(42);

    fireEvent.change(screen.getByLabelText("Subtitle Color"), { target: { value: "#ff0000" } });
    expect(useAppStore.getState().subtitleStyle.primaryColor).toBe("#ff0000");

    fireEvent.click(screen.getByText("Full (Batch)"));
    expect(useAppStore.getState().transcriptionMode).toBe("batch");

    // Popover closes on outside interaction.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Subtitle Size")).toBeNull();
  });

  it("recent-history entries are removed from the list without loading the video", async () => {
    useAppStore.setState({
      currentVideoUrl: null,
      currentVideoPath: null,
      recentFiles: [
        { path: "/videos/a.mp4", fileName: "a.mp4", lastPlayedTimestamp: 10 },
        { path: "/videos/b.mp4", fileName: "b.mp4", lastPlayedTimestamp: 20 },
      ],
    });
    render(<VideoPlayer />);

    fireEvent.click(screen.getByLabelText("Remove b.mp4 from history"));
    const files = useAppStore.getState().recentFiles.map((r) => r.fileName);
    expect(files).toEqual(["a.mp4"]);
    expect(screen.getByText("a.mp4")).toBeTruthy();
    expect(screen.queryByText("b.mp4")).toBeNull();
  });
});

describe("VideoPlayer native VLC engine", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.keys(listeners).forEach((k) => delete listeners[k]);
    invoke.mockReset();
    emit.mockClear();
    useAppStore.setState({
      currentVideo: null,
      currentVideoUrl: null,
      currentVideoPath: "/tmp/media.wav",
      subtitleTracks: [],
      activeSubtitleTrackId: null,
      showSubtitles: false,
      currentTime: 0,
      isPlaying: false,
      isTranscribing: false,
      transcriptionProgress: 0,
      subtitleMode: "english",
      transcriptionMode: "stream",
      sourceLanguage: "auto",
      seekTo: null,
      resumeAt: null,
      recentFiles: [],
      playbackRate: 1,
      sidebarVisible: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("loads the path into libvlc and mirrors its clock into the store when the feature is compiled in", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      return undefined;
    });

    render(<VideoPlayer />);

    // The transparent native stage replaces the <video> element...
    await waitFor(() => expect(screen.getByLabelText("Native video surface")).toBeTruthy());
    expect(document.querySelector("video")).toBeNull();

    // ...and the backend receives the load request for the filesystem path.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("vlc_load", { path: "/tmp/media.wav" })
    );

    // The first tick mirrors position/duration and the running state.
    await act(async () => {
      listeners["vlc-timeupdate"]!({
        payload: { position: 12.5, duration: 100, paused: false, ended: false },
      });
    });
    expect(useAppStore.getState().currentTime).toBe(12.5);
    expect(useAppStore.getState().isPlaying).toBe(true);

    // A paused / ended tick stops the UI clock (EOF with keep-open=yes).
    await act(async () => {
      listeners["vlc-timeupdate"]!({
        payload: { position: 99, duration: 100, paused: true, ended: true },
      });
    });
    expect(useAppStore.getState().isPlaying).toBe(false);

    // Space drives libvlc play/pause instead of a media element.
    fireEvent.keyDown(window, { code: "Space" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("vlc_play"));
    fireEvent.keyDown(window, { code: "Space" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("vlc_pause"));
  });

  it("applies resume, volume, and speed when the native file first reports a duration", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      return undefined;
    });
    useAppStore.setState({ resumeAt: 90 });

    render(<VideoPlayer />);
    await waitFor(() => expect(screen.getByLabelText("Native video surface")).toBeTruthy());

    await act(async () => {
      listeners["vlc-timeupdate"]!({
        payload: { position: 0, duration: 100, paused: false, ended: false },
      });
    });

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("vlc_set_volume", { level: 100 }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("vlc_set_speed", { speed: 1 }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("vlc_seek", { position: 90 }));
    expect(useAppStore.getState().resumeAt).toBeNull();
    expect(useAppStore.getState().currentTime).toBe(90);
  });

  it("routes the playback-speed menu to vlc_set_speed in native mode", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      return undefined;
    });

    render(<VideoPlayer />);
    await waitFor(() => expect(screen.getByLabelText("Native video surface")).toBeTruthy());

    fireEvent.click(screen.getByTitle("Playback speed"));
    fireEvent.click(screen.getByText("1.5x"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("vlc_set_speed", { speed: 1.5 }));
    expect(useAppStore.getState().playbackRate).toBe(1.5);
  });

  it("falls back to the HTML5 blob pipeline when libvlc rejects the load", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "vlc_load") throw new Error("libvlc unavailable");
      return undefined;
    });

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    expect(screen.queryByLabelText("Native video surface")).toBeNull();
    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video.src).toContain("asset://");
  });

  it("uses HTML5 when the backend reports the native engine unavailable", async () => {
    // Nothing to sniff in the frontend: `vlc_is_available` is the single source
    // of truth for engine selection, so a feature-off desktop build or a mobile
    // build with a failed plugin registration both land here without any UA or
    // platform detection.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return false;
      return undefined;
    });

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    expect(screen.queryByLabelText("Native video surface")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("vlc_is_available");
  });

  it("surfaces a clear message when the HTML5 fallback is handed an MKV it can't demux", async () => {
    // Native engine unavailable (feature-off build, PWA) + an MKV on disk: the
    // fallback <video> must present the container limitation instead of a
    // silent black frame, and never pretend the native engine handles it.
    useAppStore.setState({ currentVideoPath: "/movies/collection.mkv" });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return false;
      return undefined;
    });

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());

    await waitFor(() => expect(screen.getByText(/MKV container/)).toBeTruthy(), { timeout: 3000 });
    expect(screen.queryByLabelText("Native video surface")).toBeNull();
  });

  it("[visibility] the fallback-load error card renders fully opaque, high-contrast, and above the play layer but below the controls bar", async () => {
    useAppStore.setState({ currentVideoPath: "/movies/broken.mkv" });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return false;
      return undefined;
    });

    render(<VideoPlayer />);
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());

    const overlay = await waitFor(() => {
      const el = document.querySelector("[data-load-error]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // wrapper: centered over the stage, full-stop pointer pass-through, correct
    // layer slot (z-[25] → above the z-20 play/pause capture, below z-40 chrome)
    expect(overlay.className).toContain("z-[25]");
    expect(overlay.className).toContain("pointer-events-none");
    // card: SOLID zan-black — never the old translucent bg-black/70 ghost that
    // washed out over bright video
    const card = overlay.firstElementChild as HTMLElement;
    expect(card.className).toContain("bg-zan-black");
    expect(card.className).not.toContain("bg-black/70");
    // heading + container reason both visible and on-screen
    expect(screen.getByText("Playback unavailable in this build")).toBeTruthy();
    expect(screen.getByText(/MKV container/)).toBeTruthy();
    // stays in the fallback engine, never over the native surface
    expect(screen.queryByLabelText("Native video surface")).toBeNull();
  });

  it("prefers the native engine even under a mobile-style user agent (no UA sniffing)", async () => {
    const original = navigator.userAgent;
    try {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      });
    } catch {
      // jsdom may forbid redefinition in some versions; the assertion below is
      // about the engine gate, not the UA value itself.
    }

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      return undefined;
    });

    render(<VideoPlayer />);
    await waitFor(() => expect(screen.getByLabelText("Native video surface")).toBeTruthy());
    expect(document.querySelector("video")).toBeNull();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("vlc_load", { path: "/tmp/media.wav" }));

    if (navigator.userAgent !== original) {
      Object.defineProperty(navigator, "userAgent", { configurable: true, value: original });
    }
  });

  it("re-anchors the stage rect via vlc_set_layout and falls back to HTML5 when the embed is lost", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      return undefined;
    });

    render(<VideoPlayer />);
    await waitFor(() => expect(screen.getByLabelText("Native video surface")).toBeTruthy());

    // jsdom measures every element as 0×0; the reporter refuses degenerate
    // rects (a real 0×0 PlayerViewport must never collapse the native surface
    // to the top-left corner), so give the canonical `[data-player-viewport]`
    // element real dimensions to anchor against.
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    document.body.appendChild(viewport);
    viewport.getBoundingClientRect = vi.fn(() => ({
      x: 352,
      y: 40,
      width: 848,
      height: 760,
      top: 40,
      left: 352,
      right: 1200,
      bottom: 800,
    })) as unknown as () => DOMRect;

    try {
      // The surface is anchored once the viewport is measured (rect coalesced to px).
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("vlc_set_layout", {
          rect: expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
            width: expect.any(Number),
            height: expect.any(Number),
          }),
        })
      );

      // Backend detects the wid stopped resolving to the host surface.
      await act(async () => {
        listeners["vlc-embed-lost"]!({ payload: "embedded surface no longer resolves as VLC's wid" });
      });

      // The rogue window is never presented as in-app playback: straight to the
      // blob-backed <video>, no lingering native stage.
      await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
      expect(screen.queryByLabelText("Native video surface")).toBeNull();
      const video = document.querySelector("video") as HTMLVideoElement;
      expect(video.src).toContain("asset://");
    } finally {
      viewport.remove();
    }
  });

  it("re-anchors on window/fullscreen resize so the stage tracks the container", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      return undefined;
    });

    render(<VideoPlayer />);
    await screen.findByLabelText("Native video surface");
    // jsdom measures every element as 0×0, so give the canonical
    // `[data-player-viewport]` real dimensions for the first anchor.
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    document.body.appendChild(viewport);
    let vpRect = {
      x: 352,
      y: 40,
      width: 848,
      height: 760,
      top: 40,
      left: 352,
      right: 1200,
      bottom: 800,
    };
    viewport.getBoundingClientRect = vi.fn(() => vpRect) as unknown as () => DOMRect;
    try {
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("vlc_set_layout", {
          rect: expect.objectContaining({ width: expect.any(Number) }),
        })
      );
      invoke.mockClear();

      // The window grows (manual drag-resize / fullscreen toggle): the
      // viewport rect changes and the reporter must dispatch the updated
      // layout instead of the stale one.
      const bigger = {
        x: 10,
        y: 20,
        width: 1440,
        height: 900,
        top: 20,
        left: 10,
        right: 1450,
        bottom: 920,
      };
      vpRect = bigger;
      fireEvent(window, new Event("resize"));
      fireEvent(document, new Event("fullscreenchange"));

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("vlc_set_layout", {
          rect: expect.objectContaining({ x: 10, y: 20, width: 1440, height: 900 }),
        })
      );
    } finally {
      viewport.remove();
    }
  });

  it("re-anchors exactly when sidebar expand/collapse reflows the PlayerViewport", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      return undefined;
    });

    render(<VideoPlayer />);
    await screen.findByLabelText("Native video surface");
    // App shell layout owns the PlayerViewport: an open sidebar reflows the
    // column (x=352, width shrinks), a closed one fills the row (x=0, grows).
    // The Player consumes that canvas rect VERBATIM — it never measures the
    // sidebar. In the real browser the sidebar toggle fires the viewport's
    // ResizeObserver; in jsdom (no RO) we simulate the reflow the same way the
    // product surfaces `resize`.
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    document.body.appendChild(viewport);
    let vpRect = {
      x: 352,
      y: 40,
      width: 848,
      height: 760,
      top: 40,
      left: 352,
      right: 1200,
      bottom: 800,
    };
    viewport.getBoundingClientRect = vi.fn(() => vpRect) as unknown as () => DOMRect;
    try {
      // Sidebar open → surface anchored to the right of the sidebar.
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("vlc_set_layout", {
          rect: expect.objectContaining({ x: 352, width: 848 }),
        })
      );
      invoke.mockClear();

      // Close the sidebar: App shell reflows the column and the reporter MUST
      // dispatch the new rect — otherwise the Metal surface keeps rendering
      // with the sidebar-open X/width and bleeds over the sidebar.
      vpRect = { x: 0, y: 40, width: 1200, height: 760, top: 40, left: 0, right: 1200, bottom: 800 };
      fireEvent(window, new Event("resize"));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("vlc_set_layout", {
          rect: expect.objectContaining({ x: 0, width: 1200 }),
        })
      );
      invoke.mockClear();

      // Re-open → surface must move back right of the sidebar, full width -> 848.
      vpRect = {
        x: 352,
        y: 40,
        width: 848,
        height: 760,
        top: 40,
        left: 352,
        right: 1200,
        bottom: 800,
      };
      fireEvent(window, new Event("resize"));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("vlc_set_layout", {
          rect: expect.objectContaining({ x: 352, width: 848 }),
        })
      );
    } finally {
      viewport.remove();
    }
  });

  it("toggles the sidebar 10x (open/close/resize/fullscreen) without a stale anchor", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    // Start CLOSED so the loop starts with a meaningful first toggle.
    useAppStore.setState({ sidebarVisible: false });

    render(<VideoPlayer />);
    await screen.findByLabelText("Native video surface");
    const OPEN = { x: 352, y: 40, width: 848, height: 760, top: 40, left: 352, right: 1200, bottom: 800 } as DOMRect;
    const CLOSED = { x: 0, y: 40, width: 1200, height: 760, top: 40, left: 0, right: 1200, bottom: 800 } as DOMRect;
    // The canonical PlayerViewport: App shell reflows this column when the
    // sidebar toggles; the reporter consumes its rect VERBATIM (no sidebar
    // math in the Player). jsdom has no ResizeObserver, so each toggle is
    // surfaced the way the product listens — a `resize` event.
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    document.body.appendChild(viewport);
    let vpRect: DOMRect = CLOSED;
    viewport.getBoundingClientRect = vi.fn(() => vpRect) as unknown as () => DOMRect;

    try {
      // First anchor: sidebar CLOSED (x=0).
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("vlc_set_layout", {
          rect: expect.objectContaining({ x: 0, width: 1200 }),
        })
      );

      const lastLayout = () => {
        const calls = invoke.mock.calls.filter((c) => c[0] === "vlc_set_layout");
        const last = calls[calls.length - 1];
        return (last?.[1] as { rect: { x: number; y: number; width: number; height: number } })?.rect;
      };

      for (let i = 0; i < 10; i++) {
        const open = i % 2 === 0;
        invoke.mockClear();
        vpRect = open ? OPEN : CLOSED;
        fireEvent(window, new Event("resize"));

        await waitFor(() => {
          const rect = lastLayout();
          expect(rect).toBeTruthy();
          expect(rect!.x).toBe(open ? 352 : 0);
          expect(rect!.width).toBe(open ? 848 : 1200);
        });

        // Every dispatch during this tick must carry the CURRENT edge, never the previous one.
        const layouts = invoke.mock.calls.filter((c) => c[0] === "vlc_set_layout");
        for (const [, payload] of layouts) {
          const r = (payload as { rect: { x: number; width: number } }).rect;
          expect(r.x).toBe(open ? 352 : 0);
          expect(r.width).toBe(open ? 848 : 1200);
        }

        // Mid-loop (after iteration 5): fire resize + fullscreenchange, confirm
        // the reporter dispatches an updated rect still matching the current edge.
        if (i === 5) {
          invoke.mockClear();
          vpRect = {
            x: open ? 352 : 0, y: 20, width: open ? 948 : 1300, height: 860,
            top: 20, left: open ? 352 : 0, right: open ? 1300 : 1300, bottom: 880,
          } as DOMRect;
          fireEvent(window, new Event("resize"));
          fireEvent(document, new Event("fullscreenchange"));
          await waitFor(() => {
            const rect = lastLayout();
            expect(rect).toBeTruthy();
            expect(rect!.x).toBe(open ? 352 : 0);
            expect(rect!.width).toBe(open ? 948 : 1300);
          });
        }
      }
    } finally {
      viewport.remove();
    }
  });

  it("anchors the native surface to the PlayerViewport rect verbatim (no sidebar-derived geometry)", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    // The canonical PlayerViewport — laid out by App shell right of the open
    // sidebar. Its rect IS the region; the Player dispatches it as-is.
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    document.body.appendChild(viewport);
    viewport.getBoundingClientRect = vi.fn(
      () =>
        ({
          x: 352,
          y: 40,
          width: 848,
          height: 760,
          top: 40,
          left: 352,
          right: 1200,
          bottom: 800,
        }) as unknown as DOMRect
    );
    try {
      render(<VideoPlayer />);
      const stage = await screen.findByLabelText("Native video surface");
      // The video layer box may measure anywhere (here: a stale full-width
      // rect) — it is NOT the geometry source anymore. The Player is blind to
      // it; App shell placement is the only authority.
      stage.getBoundingClientRect = vi.fn(
        () =>
          ({
            x: 0,
            y: 0,
            width: 1200,
            height: 800,
            top: 0,
            left: 0,
            right: 1200,
            bottom: 800,
          }) as unknown as DOMRect
      );

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("vlc_set_layout", {
          rect: expect.objectContaining({ x: 352, y: 40, width: 848, height: 760 }),
        })
      );

      // Every dispatch must equal the viewport rect — never the stale stage box.
      const layouts = invoke.mock.calls.filter((c) => c[0] === "vlc_set_layout");
      for (const [, payload] of layouts) {
        const rect = (payload as { rect: { x: number; width: number } }).rect;
        expect(rect.x).toBe(352);
        expect(rect.width).toBe(848);
      }
    } finally {
      viewport.remove();
    }
  });

  it("sends NO native layout while `[data-player-viewport]` is absent (graceful missing element)", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    // No PlayerViewport in the DOM: the Player must not fall back to deriving
    // geometry from the content row / sidebar. It sends nothing.
    render(<VideoPlayer />);
    await screen.findByLabelText("Native video surface");
    // Let the reporter's bounded per-frame retry run a moment — still no layout.
    await new Promise((r) => setTimeout(r, 50));
    const withoutViewport = invoke.mock.calls.filter((c) => c[0] === "vlc_set_layout");
    expect(withoutViewport).toHaveLength(0);

    // App shell mounts the PlayerViewport (the content column appears) → the
    // same reporter immediately anchors the surface to it, verbatim.
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    document.body.appendChild(viewport);
    viewport.getBoundingClientRect = vi.fn(
      () =>
        ({
          x: 352,
          y: 40,
          width: 848,
          height: 760,
          top: 40,
          left: 352,
          right: 1200,
          bottom: 800,
        }) as unknown as DOMRect
    );
    try {
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("vlc_set_layout", {
          rect: expect.objectContaining({ x: 352, y: 40, width: 848, height: 760 }),
        })
      );
    } finally {
      viewport.remove();
    }
  });

  it("keeps the SAME PlayerViewport rect across engine switches (native -> HTML5)", async () => {
    // One canonical `[data-player-viewport]` (the App shell's content column),
    // with the Player RENDERED INSIDE it — exactly App.tsx's `<div
    // data-player-viewport>{<Sidebar sibling/> + <VideoPlayer/>}</div>`
    // nesting. Whatever video implementation is active, the viewport rect must
    // never change — only the visible surface swaps. No HTML5-specific box and
    // no native-specific box may ever be allowed to drift apart.
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    const viewportRect = {
      x: 352,
      y: 40,
      width: 848,
      height: 760,
      top: 40,
      left: 352,
      right: 1200,
      bottom: 800,
    };
    viewport.getBoundingClientRect = vi.fn(
      () => viewportRect as unknown as DOMRect
    );
    viewport.className = "relative z-0 min-h-0 min-w-0 flex-1 overflow-clip";
    document.body.appendChild(viewport);

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    try {
      render(<VideoPlayer />, { container: viewport });
      // Native state first: the VLC stage mounts INSIDE the canonical viewport.
      await waitFor(() =>
        expect(screen.getByLabelText("Native video surface")).toBeTruthy()
      );
      const stage = screen.getByLabelText("Native video surface");
      expect(stage.closest("[data-player-viewport]")).not.toBeNull();

      // The reporter anchors the surface to the SAME viewport rect.
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("vlc_set_layout", {
          rect: expect.objectContaining({ x: 352, y: 40, width: 848, height: 760 }),
        })
      );

      // Every native dispatch to date carries the identical viewport rect — no
      // engine-dependent box was ever substituted.
      const layouts = invoke.mock.calls.filter((c) => c[0] === "vlc_set_layout");
      expect(layouts.length).toBeGreaterThan(0);
      for (const [, payload] of layouts) {
        const rect = (payload as { rect: { x: number; width: number } }).rect;
        expect(rect.x).toBe(352);
        expect(rect.width).toBe(848);
      }

      // Engine flips back to HTML5 (embed lost): the blob-backed <video> owns
      // the stage, native stage gone — viewport still untouched.
      await act(async () => {
        listeners["vlc-embed-lost"]!({ payload: "downgrade" });
      });
      await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
      expect(screen.queryByLabelText("Native video surface")).toBeNull();

      // The HTML5 video remained inside the same PlayerViewport.
      const videoAfter = document.querySelector("video") as HTMLVideoElement;
      expect(videoAfter.closest("[data-player-viewport]")).not.toBeNull();
    } finally {
      viewport.remove();
    }
  });

  it("drops to HTML5 when the native clock never proves the file decoded", async () => {
    // A file VLC accepts via `loadfile` but cannot actually demux/decode (a
    // renamed path, a corrupt container, or an unsupported codec) produces no
    // `VLC-load` error: `vlc-loaded` fires, then the 250 ms ticker emits a
    // single (0,0) snapshot and nothing else. The watchdog must not strand the
    // player on a silent black frame — it falls back to the blob <video>.
    vi.useFakeTimers();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    render(<VideoPlayer />);
    // Flush the mount pipeline (availability check → setEngine("VLC") → the
    // watchdog effect that schedules the decode-timeout timer).
    for (let i = 0; i < 4; i++) await act(async () => {});
    expect(screen.getByLabelText("Native video surface")).toBeTruthy();

    // Corruption signature: the first (and only) clock snapshot is all zeros.
    await act(async () => {
      listeners["vlc-timeupdate"]!({
        payload: { position: 0, duration: 0, paused: false, ended: false },
      });
    });

    // The decode grace window elapses with no real duration/playhead signal.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await act(async () => {});
    await act(async () => {});

    // The cutover lands on the HTML5 blob engine, and the native stage is gone.
    expect(document.querySelector("video")).toBeTruthy();
    expect(screen.queryByLabelText("Native video surface")).toBeNull();
    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video.src).toContain("asset://");

    vi.useRealTimers();
  });

  it("keeps the native engine when the clock reports a real decode signal", async () => {
    // A healthy file delivers a duration (or advancing playhead) inside the
    // grace window — the watchdog must neither fire nor touch the native stage.
    vi.useFakeTimers();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    render(<VideoPlayer />);
    for (let i = 0; i < 4; i++) await act(async () => {});
    expect(screen.getByLabelText("Native video surface")).toBeTruthy();

    await act(async () => {
      listeners["vlc-timeupdate"]!({
        payload: { position: 0.25, duration: 120, paused: false, ended: false },
      });
    });

    // Same elapsed time as the failure case: nothing may fall back.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await act(async () => {});

    expect(document.querySelector("video")).toBeNull();
    expect(screen.getByLabelText("Native video surface")).toBeTruthy();

    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // A–J  Architectural invariant tests (canonical Player Compositing model)
  // -----------------------------------------------------------------------

  it("[A] Engine XOR: exactly one of data-native-stage or <video> exists in both modes", async () => {
    // §5 / Forbidden #11: the two video surfaces are mutually exclusive.
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    viewport.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 0, width: 1280, height: 720,
      top: 0, left: 0, right: 1280, bottom: 720,
    }) as unknown as DOMRect);
    viewport.className = "relative z-0 min-h-0 min-w-0 flex-1 overflow-clip";
    document.body.appendChild(viewport);

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    try {
      render(<VideoPlayer />, { container: viewport });
      await waitFor(() =>
        expect(screen.getByLabelText("Native video surface")).toBeTruthy()
      );
      // Native mode: data-native-stage present, <video> absent
      expect(document.querySelector("[data-native-stage]")).not.toBeNull();
      expect(document.querySelector("video")).toBeNull();

      // Flip to HTML5 via embed-lost
      await act(async () => {
        listeners["vlc-embed-lost"]!({ payload: "downgrade" });
      });
      await waitFor(() =>
        expect(document.querySelector("video")).toBeTruthy()
      );
      // HTML5 mode: <video> present, data-native-stage absent
      expect(screen.queryByLabelText("Native video surface")).toBeNull();
    } finally {
      viewport.remove();
    }
  });

  it("[B] Verbatim viewport: rect sent to vlc_set_layout equals getBoundingClientRect exactly", async () => {
    // §4 / The Absolute Rule: the player consumes the viewport box verbatim;
    // no sidebar width subtracted, no clamping to a sidebar boundary.
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    const expected = {
      x: 352, y: 40, width: 848, height: 760,
      top: 40, left: 352, right: 1200, bottom: 800,
    };
    viewport.getBoundingClientRect = vi.fn(() => expected as unknown as DOMRect);
    viewport.className = "relative z-0 min-h-0 min-w-0 flex-1 overflow-clip";
    document.body.appendChild(viewport);

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    try {
      render(<VideoPlayer />, { container: viewport });
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("vlc_set_layout", {
          rect: expect.objectContaining({ x: 352, y: 40, width: 848, height: 760 }),
        })
      );
      // Confirm the four SurfaceLayout fields match exactly — no sidebar subtraction
      const layoutCall = invoke.mock.calls.find((c) => c[0] === "vlc_set_layout");
      const sent = (layoutCall![1] as { rect: { x: number; y: number; width: number; height: number } }).rect;
      expect(sent).toEqual({ x: 352, y: 40, width: 848, height: 760 });
    } finally {
      viewport.remove();
    }
  });

  it("[B2] Right-of-sidebar invariant: an inline sidebar forces the native rect to its edge (never under/over)", async () => {
    // §4 / Right-of-sidebar invariant: even if a stale/wrongly-measured
    // viewport rect would start left of the inline sidebar, the rect sent to
    // vlc_set_layout must start at the sidebar's right edge — the picture never
    // bleeds under/over the sidebar. (Verbatim when flex is correct — no-op.)
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    // Pathological measurement: full-window rect reported while the sidebar is open.
    viewport.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 40, width: 1200, height: 760,
      top: 40, left: 0, right: 1200, bottom: 800,
    }) as unknown as DOMRect);
    document.body.appendChild(viewport);

    const sidebar = document.createElement("aside");
    sidebar.setAttribute("data-sidebar", "");
    sidebar.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 40, width: 352, height: 760,
      top: 40, left: 0, right: 352, bottom: 800,
    }) as unknown as DOMRect);
    document.body.appendChild(sidebar);

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    try {
      render(<VideoPlayer />, { container: viewport });
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("vlc_set_layout", {
          rect: expect.objectContaining({ x: 352, y: 40, width: 848, height: 760 }),
        })
      );
      const layoutCall = invoke.mock.calls.find((c) => c[0] === "vlc_set_layout");
      const sent = (layoutCall![1] as { rect: { x: number; y: number; width: number; height: number } }).rect;
      expect(sent).toEqual({ x: 352, y: 40, width: 848, height: 760 });
    } finally {
      viewport.remove();
      sidebar.remove();
    }
  });

  it("[C] Event-driven: no IPC fires when the viewport rect is unchanged (key short-circuit)", async () => {
    // §4 / §18.11: the reporter coalesces and stops at idle once anchored.
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    viewport.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 0, width: 1280, height: 720,
      top: 0, left: 0, right: 1280, bottom: 720,
    }) as unknown as DOMRect);
    viewport.className = "relative z-0 min-h-0 min-w-0 flex-1 overflow-clip";
    document.body.appendChild(viewport);

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    try {
      render(<VideoPlayer />, { container: viewport });
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("vlc_set_layout", expect.anything())
      );

      // Record how many vlc_set_layout calls exist after the initial anchor
      const countAfterAnchor = invoke.mock.calls.filter((c) => c[0] === "vlc_set_layout").length;

      // Trigger a window resize; the rect is unchanged, so the key short-circuits
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
      });
      await act(async () => {});
      await act(async () => {});

      const countAfterResize = invoke.mock.calls.filter((c) => c[0] === "vlc_set_layout").length;
      expect(countAfterResize).toBe(countAfterAnchor);
    } finally {
      viewport.remove();
    }
  });

  it("[D] Degenerate rect (0×0): no vlc_set_layout is sent", async () => {
    // §9 / §18.4: degenerate rects are skipped so the surface never collapses
    // to a top-left patch while the layout settles.
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    viewport.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 0, width: 0, height: 0,
      top: 0, left: 0, right: 0, bottom: 0,
    }) as unknown as DOMRect);
    viewport.className = "relative z-0 min-h-0 min-w-0 flex-1 overflow-clip";
    document.body.appendChild(viewport);

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    try {
      render(<VideoPlayer />, { container: viewport });
      await waitFor(() =>
        expect(screen.getByLabelText("Native video surface")).toBeTruthy()
      );
      // Give the reporter time to run (even if it were to fire, which it must not)
      await act(async () => {});
      await act(async () => {});

      const layoutCalls = invoke.mock.calls.filter((c) => c[0] === "vlc_set_layout");
      expect(layoutCalls).toHaveLength(0);
    } finally {
      viewport.remove();
    }
  });

  it("[E] Missing [data-player-viewport]: no native layout is sent (graceful absence)", async () => {
    // §4 / §18.1: when the viewport element is absent, the reporter retries
    // each frame instead of sending a wrong rect.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    // Render into document.body — there is no [data-player-viewport]
    render(<VideoPlayer />);
    await waitFor(() =>
      expect(screen.getByLabelText("Native video surface")).toBeTruthy()
    );
    await act(async () => {});
    await act(async () => {});

    const layoutCalls = invoke.mock.calls.filter((c) => c[0] === "vlc_set_layout");
    expect(layoutCalls).toHaveLength(0);
  });

  it("[F] Overlay z-ladder: controls bar and play/pause carry explicit z-indexes above video", async () => {
    // §5 / §8: the overlay stack sits above the picture with fixed z-ladder
    // so new overlays cannot silently land under the native surface.
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    viewport.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 0, width: 1280, height: 720,
      top: 0, left: 0, right: 1280, bottom: 720,
    }) as unknown as DOMRect);
    viewport.className = "relative z-0 min-h-0 min-w-0 flex-1 overflow-clip";
    document.body.appendChild(viewport);

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    try {
      render(<VideoPlayer />, { container: viewport });
      await waitFor(() =>
        expect(screen.getByLabelText("Native video surface")).toBeTruthy()
      );
      // The controls bar is always in the DOM (toggled via opacity) and carries z-40
      const controlsBar = viewport.querySelector("[class*='z-40']");
      expect(controlsBar).not.toBeNull();
      expect(controlsBar!.className).toContain("z-40");

      // Strict hardening: the bar is a SELF-CONTAINED stacking context
      // (`isolate`) so it can never be trapped under a parent stacking/clip
      // context, and stays anchored inside the viewport container.
      expect(controlsBar!.className).toContain("isolate");
      expect(controlsBar!.closest("[data-player-viewport]")).not.toBeNull();

      // The play/pause overlay is always in the DOM and carries z-20
      const playPause = viewport.querySelector("[class*='z-20']");
      expect(playPause).not.toBeNull();
      expect(playPause!.className).toContain("z-20");

      // The video surface (native stage) is z-0 — below both overlay layers
      const stage = screen.getByLabelText("Native video surface");
      expect(stage.className).toContain("z-0");
    } finally {
      viewport.remove();
    }
  });

  it("[G] Sidebar is never inside the Player's DOM subtree", async () => {
    // §3 / §4: the Sidebar is a sibling in the content row, never a child of
    // the PlayerViewport. The player root must not contain [data-sidebar].
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    viewport.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 0, width: 1280, height: 720,
      top: 0, left: 0, right: 1280, bottom: 720,
    }) as unknown as DOMRect);
    viewport.className = "relative z-0 min-h-0 min-w-0 flex-1 overflow-clip";
    document.body.appendChild(viewport);

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return false;
      return undefined;
    });

    render(<VideoPlayer />, { container: viewport });
    await waitFor(() =>
      expect(document.querySelector("video")).toBeTruthy()
    );

    // [data-sidebar] must NOT appear anywhere inside the viewport
    expect(viewport.querySelector("[data-sidebar]")).toBeNull();
  });

  it("[H] Engine switch preserves the viewport rect exactly (native -> HTML5 -> native)", async () => {
    // §14: switching engines changes the surface, never the region. The rect
    // fed to vlc_set_layout before and after the switch must be identical.
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    const rect = {
      x: 352, y: 40, width: 848, height: 760,
      top: 40, left: 352, right: 1200, bottom: 800,
    };
    viewport.getBoundingClientRect = vi.fn(() => rect as unknown as DOMRect);
    viewport.className = "relative z-0 min-h-0 min-w-0 flex-1 overflow-clip";
    document.body.appendChild(viewport);

    let nativeAvailable = true;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return nativeAvailable;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    try {
      render(<VideoPlayer />, { container: viewport });
      await waitFor(() =>
        expect(screen.getByLabelText("Native video surface")).toBeTruthy()
      );
      const rects = () => invoke.mock.calls
        .filter((c) => c[0] === "vlc_set_layout")
        .map((c) => (c[1] as { rect: { x: number } }).rect.x);
      expect(rects()).toContain(352);

      // Embed-lost → HTML5
      await act(async () => {
        listeners["vlc-embed-lost"]!({ payload: "downgrade" });
      });
      await waitFor(() =>
        expect(document.querySelector("video")).toBeTruthy()
      );
      expect(screen.queryByLabelText("Native video surface")).toBeNull();
    } finally {
      viewport.remove();
    }
  });

  it("[I] vlc-embed-lost always cutover to HTML5 with a blob-backed src", async () => {
    // §7 / §13 Forbidden #12: a detached or rogue window is never presented
    // as in-app playback; the embed-loss path lands on the blob engine.
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    viewport.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 0, width: 1280, height: 720,
      top: 0, left: 0, right: 1280, bottom: 720,
    }) as unknown as DOMRect);
    viewport.className = "relative z-0 min-h-0 min-w-0 flex-1 overflow-clip";
    document.body.appendChild(viewport);

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    try {
      render(<VideoPlayer />, { container: viewport });
      await waitFor(() =>
        expect(screen.getByLabelText("Native video surface")).toBeTruthy()
      );

      await act(async () => {
        listeners["vlc-embed-lost"]!({ payload: "downgrade" });
      });
      await waitFor(() =>
        expect(document.querySelector("video")).toBeTruthy()
      );
      const video = document.querySelector("video") as HTMLVideoElement;
      expect(video.src).toContain("asset://");
      expect(screen.queryByLabelText("Native video surface")).toBeNull();
    } finally {
      viewport.remove();
    }
  });

  it("[J] Watchdog: a file that never proves decode drops to HTML5 within NATIVE_DECODE_WATCHDOG_MS", async () => {
    // §7 watchdog: a corrupt or unsupported file fires vlc-loaded but the
    // clock only returns (0,0) — the watchdog fires after 5 s and the player
    // must fall back to the blob engine (NOT stay silent on a black frame).
    vi.useFakeTimers();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    render(<VideoPlayer />);
    for (let i = 0; i < 4; i++) await act(async () => {});
    expect(screen.getByLabelText("Native video surface")).toBeTruthy();

    // Corrupt signature: position=0, duration=0 — no real decode proof
    await act(async () => {
      listeners["vlc-timeupdate"]!({
        payload: { position: 0, duration: 0, paused: false, ended: false },
      });
    });

    // Advance past the 5 s grace window
    await act(async () => { vi.advanceTimersByTime(5000); });
    await act(async () => {});
    await act(async () => {});

    // Verify cutover: HTML5 blob engine owns the stage
    expect(document.querySelector("video")).toBeTruthy();
    expect(screen.queryByLabelText("Native video surface")).toBeNull();

    vi.useRealTimers();
  });

  it("[K] Click routing: an auto-hidden controls bar never eats a play/pause click (pointer-events disabled while hidden)", async () => {
    // §20 click-interception regression: the controls bar stays in the DOM and
    // toggles `opacity-0` when hidden — an INVISIBLE z-40 bar was swallowing
    // every click over the stage, so pause/resume "failed" intermittently.
    // Pointer events must be disabled exactly while the bar is hidden
    // (`pointer-events-none`) and re-enabled when it shows; the base native
    // stage stays pointer-events-none so the host frame never intercepts ahead
    // of a DOM control.
    useAppStore.setState({ isPlaying: true }); // makes onMouseLeave auto-hide
    const viewport = document.createElement("div");
    viewport.setAttribute("data-player-viewport", "");
    viewport.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 0, width: 1280, height: 720,
      top: 0, left: 0, right: 1280, bottom: 720,
    }) as unknown as DOMRect);
    viewport.className = "relative z-0 min-h-0 min-w-0 flex-1 overflow-clip";
    document.body.appendChild(viewport);

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vlc_is_available") return true;
      if (cmd === "native_layout_debug") return false;
      return undefined;
    });

    try {
      render(<VideoPlayer />, { container: viewport });
      await waitFor(() =>
        expect(screen.getByLabelText("Native video surface")).toBeTruthy()
      );

      // The base native stage never intercepts pointer events ahead of DOM chrome
      const stage = screen.getByLabelText("Native video surface");
      expect(stage.className).toContain("pointer-events-none");

      // Controls bar starts visible → interactive (pointer-events-auto)
      const bar = viewport
        .querySelector("input[type='range']")!
        .closest("[class*='z-40']") as HTMLElement;
      expect(bar).not.toBeNull();
      expect(bar.className).toContain("pointer-events-auto");
      expect(bar.className).not.toContain("pointer-events-none");

      // Mouse leaves the player while playing → controls auto-hide AND lose
      // pointer events, so a subsequent click falls through to the play/pause
      // toggle capture layer (z-20) instead of being swallowed by the bar.
      const playerRoot = viewport.querySelector("[data-native-stage]")!.parentElement!;
      fireEvent.mouseLeave(playerRoot);
      await waitFor(() => expect(bar.className).toContain("pointer-events-none"));
      expect(bar.className).toContain("opacity-0");

      // Moving the mouse anywhere in the player re-shows the controls →
      // clickable again. (Bubble the event up from the stage, not the container.)
      fireEvent.mouseMove(stage);
      await waitFor(() => expect(bar.className).toContain("pointer-events-auto"));
      expect(bar.className).not.toContain("pointer-events-none");
    } finally {
      viewport.remove();
    }
  });

  it("[L] Sidebar is provably opaque (zero transparency bleed) at z-40 inline", async () => {
    // §2 strict hardening: the opaque sidebar must stay fully opaque so
    // desktop/wallpaper can never bleed through, in BOTH themes, at explicit
    // opacity-100, and inline (relative) on desktop so the video is pushed
    // aside instead of painted under a translucent drawer.
    for (const theme of ["dark", "light"] as const) {
      useAppStore.setState({
        theme,
        sidebarVisible: true,
        currentVideo: null,
        currentVideoUrl: null,
        currentVideoPath: null,
        subtitleTracks: [],
        activeSubtitleTrackId: null,
      });
      const { container, unmount } = render(<Sidebar />);
      const aside = container.querySelector("[data-sidebar]") as HTMLElement;
      expect(aside).not.toBeNull();

      // Explicit opacity + a fully opaque theme background. Dark theme is now
      // hardcoded to literal solid black in JSX (and index.css pins
      // aside[data-sidebar] to #000 !important as a raw backstop), so the
      // sidebar can never turn transparent — light keeps solid white.
      expect(aside.className).toContain("opacity-100");
      expect(aside.className).toContain(theme === "dark" ? "bg-black" : "bg-white");

      // Desktop is ALWAYS inline (relative) — never a floating drawer over the video
      expect(aside.className).toContain("relative");
      expect(aside.className).not.toContain("absolute");
      unmount();
    }
    // Restore the default theme/sidebar so later tests see a clean store.
    useAppStore.setState({ theme: "dark", sidebarVisible: true });
  });
});