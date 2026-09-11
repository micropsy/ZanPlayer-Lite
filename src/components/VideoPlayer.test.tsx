import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

type EmitFn = (event: { payload?: unknown }) => void;

const { listeners, invoke } = vi.hoisted(() => ({
  listeners: {} as Record<string, EmitFn>,
  invoke: vi.fn(),
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
}));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn().mockResolvedValue("/home"),
}));

import { VideoPlayer } from "./VideoPlayer";
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
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("streams the original pass first, then merges the translation into a dual overlay", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "start_transcription") return undefined;
      if (cmd === "poll_transcript_cues") return polled.shift() ?? [];
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
});