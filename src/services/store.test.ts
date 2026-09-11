import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore, whisperLangCode, languageLabel } from "./store";
import type { SubtitleCue } from "../types/subtitle";
import type { ProjectData } from "./tauri";

const cue = (
  id: string,
  text: string,
  startTime: number,
  endTime: number,
  kind?: string
): SubtitleCue => ({ id, startTime, endTime, text, kind });

const ORIG = { name: "Auto-Generated (Original)", language: "my" };
const TR = { name: "Auto-Generated (English)", language: "en" };

describe("store dual-pass cue merge", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      subtitleTracks: [],
      activeSubtitleTrackId: null,
      subtitleMode: "both",
      transcriptionMode: "stream",
    });
  });

  it("routes realtime cues into separate per-kind tracks without losing either pass", () => {
    const store = useAppStore.getState();
    store.appendStreamedCues("track-orig", ORIG, [cue("o1", "မင်္ဂလာပါ", 1, 3, "original")]);
    store.appendStreamedCues("track-tr", TR, [cue("t1", "Hello", 1, 3, "translation")]);

    const tracks = useAppStore.getState().subtitleTracks;
    expect(tracks).toHaveLength(2);
    expect(tracks.map((t) => t.id).sort()).toEqual(["track-orig", "track-tr"]);
    expect(tracks.map((t) => t.name)).toEqual([
      "Auto-Generated (Original)",
      "Auto-Generated (English)",
    ]);
  });

  it("appends later streamed cues to the matching track instead of duplicating it", () => {
    const store = useAppStore.getState();
    store.appendStreamedCues("track-orig", ORIG, [cue("o1", "first", 0, 1, "original")]);
    store.appendStreamedCues("track-tr", TR, [cue("t1", "first", 0, 1, "translation")]);
    store.appendStreamedCues("track-orig", ORIG, [cue("o2", "second", 2, 3, "original")]);
    store.appendStreamedCues("track-tr", TR, [cue("t2", "second", 2, 3, "translation")]);

    const tracks = useAppStore.getState().subtitleTracks;
    expect(tracks).toHaveLength(2);
    expect(tracks.find((t) => t.id === "track-orig")!.cues.map((c) => c.text)).toEqual([
      "first",
      "second",
    ]);
    expect(tracks.find((t) => t.id === "track-tr")!.cues.map((c) => c.text)).toEqual([
      "first",
      "second",
    ]);
  });

  it("keeps each track's timeline pure — a cue never leaks across passes", () => {
    const store = useAppStore.getState();
    store.appendStreamedCues("track-orig", ORIG, [cue("o1", "မင်္ဂလာပါ", 1, 3, "original")]);
    store.appendStreamedCues("track-tr", TR, [
      cue("t1", "Hello", 1, 3, "translation"),
      cue("t2", "Bye", 3, 5, "translation"),
    ]);
    const tracks = useAppStore.getState().subtitleTracks;
    const origTrack = tracks.find((t) => t.id === "track-orig")!;
    const trTrack = tracks.find((t) => t.id === "track-tr")!;
    expect(origTrack.cues.every((c) => c.kind === "original")).toBe(true);
    expect(trTrack.cues.every((c) => c.kind === "translation")).toBe(true);
  });

  it("applyBatchTracks replaces stale generated tracks but keeps manual ones", () => {
    useAppStore.setState({
      subtitleTracks: [
        { id: "manual", name: "Movie.srt", language: "en", cues: [], isGenerated: false },
        { id: "old-gen", name: "Auto-Generated (English)", language: "en", cues: [], isGenerated: true },
      ],
      activeSubtitleTrackId: "old-gen",
    });

    useAppStore.getState().applyBatchTracks([
      { id: "track-orig", name: "Auto-Generated (Original)", language: "my", cues: [cue("o1", "မင်္ဂလာပါ", 1, 3, "original")] },
      { id: "track-tr", name: "Auto-Generated (English)", language: "en", cues: [cue("t1", "Hello", 1, 3, "translation")] },
    ]);

    const state = useAppStore.getState();
    expect(state.subtitleTracks.map((t) => t.id)).toEqual(["manual", "track-orig", "track-tr"]);
    expect(state.subtitleTracks.filter((t) => t.isGenerated)).toHaveLength(2);
    expect(state.subtitleTracks[0].id).toBe("manual");
    expect(state.activeSubtitleTrackId).toBe("track-orig");
  });

  it("removeGeneratedTracks drops only generated tracks and clears a stale active id", () => {
    useAppStore.setState({
      subtitleTracks: [
        { id: "manual", name: "Movie.srt", language: "en", cues: [], isGenerated: false },
        { id: "gen-a", name: "Auto-Generated (Original)", language: "my", cues: [], isGenerated: true },
        { id: "gen-b", name: "Auto-Generated (English)", language: "en", cues: [], isGenerated: true },
      ],
      activeSubtitleTrackId: "gen-b",
    });

    useAppStore.getState().removeGeneratedTracks();
    const state = useAppStore.getState();
    expect(state.subtitleTracks.map((t) => t.id)).toEqual(["manual"]);
    expect(state.activeSubtitleTrackId).toBeNull();
  });
});

describe("whisperLangCode", () => {
  it("pins known spoken languages to whisper ISO codes", () => {
    expect(whisperLangCode("Burmese")).toBe("my");
    expect(whisperLangCode("my")).toBe("my");
    expect(whisperLangCode("MY")).toBe("my");
    expect(whisperLangCode("Myanmar")).toBe("my");
    expect(whisperLangCode("English")).toBe("en");
    expect(whisperLangCode("fr")).toBe("fr");
    expect(whisperLangCode("Japanese")).toBe("ja");
  });

  it("falls back to auto-detection (undefined) for auto and unknown values", () => {
    expect(whisperLangCode("auto")).toBeUndefined();
    expect(whisperLangCode("Auto-Detect")).toBeUndefined();
    expect(whisperLangCode("klingon")).toBeUndefined();
    expect(whisperLangCode("myanmar-extra")).toBeUndefined();
    expect(whisperLangCode(undefined)).toBeUndefined();
    expect(whisperLangCode(null)).toBeUndefined();
  });
});

describe("languageLabel", () => {
  it("reverse-maps whisper codes to display names", () => {
    expect(languageLabel("my")).toBe("Burmese");
    expect(languageLabel("en")).toBe("English");
    expect(languageLabel("es")).toBe("Spanish");
    expect(languageLabel(undefined)).toBe("Auto-Detect");
    expect(languageLabel(null)).toBe("Auto-Detect");
    expect(languageLabel("tagalog")).toBe("tagalog");
  });
});

describe("store loadProject hydration", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      subtitleTracks: [],
      activeSubtitleTrackId: null,
      currentVideoPath: null,
      currentTime: 0,
      isTranscribing: false,
    });
  });

  const sampleProject: ProjectData = {
    version: 1,
    videoPath: "/tmp/movie.mp4",
    subtitleTracks: [
      {
        id: "track-orig",
        name: "Auto-Generated (Original)",
        language: "my",
        isGenerated: true,
        cues: [
          { id: "c1", startTime: 1, endTime: 3, text: "Hello", kind: "original" },
          { id: "c2", startTime: 4, endTime: 6, text: "World", kind: "original" },
        ],
      },
      {
        id: "track-tr",
        name: "Auto-Generated (English)",
        language: "en",
        isGenerated: true,
        cues: [
          { id: "c3", startTime: 1, endTime: 3, text: "Hello", kind: "translation" },
        ],
      },
    ],
    activeSubtitleTrackId: "track-orig",
    showSubtitles: true,
    subtitleMode: "both",
    transcriptionMode: "stream",
    sourceLanguage: "my",
    subtitleStyle: {
      fontName: "Arial",
      fontSize: 24,
      primaryColor: "#FFFFFF",
      outlineColor: "#000000",
      backColor: "#80000000",
      bold: false,
      italic: false,
      alignment: "bottom",
    },
    currentTime: 12.5,
  };

  it("hydrates all workspace fields in one shot", () => {
    useAppStore.getState().loadProject(sampleProject);
    const s = useAppStore.getState();

    expect(s.currentVideoPath).toBe("/tmp/movie.mp4");
    expect(s.subtitleTracks).toHaveLength(2);
    expect(s.activeSubtitleTrackId).toBe("track-orig");
    expect(s.showSubtitles).toBe(true);
    expect(s.subtitleMode).toBe("both");
    expect(s.transcriptionMode).toBe("stream");
    expect(s.sourceLanguage).toBe("my");
    expect(s.currentTime).toBe(12.5);
    expect(s.subtitleStyle.fontName).toBe("Arial");
  });

  it("blocks auto-transcription: tracks are populated and isTranscribing is false", () => {
    // Simulate an in-progress transcription before load.
    useAppStore.setState({ isTranscribing: true, subtitleTracks: [] });
    useAppStore.getState().loadProject(sampleProject);
    const s = useAppStore.getState();

    expect(s.isTranscribing).toBe(false);
    expect(s.subtitleTracks.length).toBeGreaterThan(0);
    // The VideoPlayer auto-transcribe effect checks subtitleTracks.length === 0;
    // with tracks present, Whisper is never re-run.
  });

  it("preserves cue data exactly — startTime, endTime, text, and kind survive hydration", () => {
    useAppStore.getState().loadProject(sampleProject);
    const tracks = useAppStore.getState().subtitleTracks;
    const origTrack = tracks.find((t) => t.id === "track-orig")!;
    expect(origTrack.cues).toHaveLength(2);
    expect(origTrack.cues[0]).toEqual({
      id: "c1",
      startTime: 1,
      endTime: 3,
      text: "Hello",
      kind: "original",
    });
    expect(origTrack.cues[1]).toEqual({
      id: "c2",
      startTime: 4,
      endTime: 6,
      text: "World",
      kind: "original",
    });
  });
});

describe("store recent history and playback rate", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ recentFiles: [], playbackRate: 1, resumeAt: null });
  });

  it("upsertRecentFile adds new entries to the front and dedups by path", () => {
    const s = useAppStore.getState();
    s.upsertRecentFile("/v/a.mp4", "a.mp4");
    s.upsertRecentFile("/v/b.mp4", "b.mp4");
    s.upsertRecentFile("/v/a.mp4", "a.mp4"); // dedupe, keeps lastPlayedTimestamp 0
    const files = useAppStore.getState().recentFiles;
    expect(files.map((f) => f.fileName)).toEqual(["a.mp4", "b.mp4"]);
    expect(files[0].lastPlayedTimestamp).toBe(0);
  });

  it("touchRecentFile preserves existing entries and updates the playhead", () => {
    const s = useAppStore.getState();
    s.upsertRecentFile("/v/a.mp4", "a.mp4");
    s.upsertRecentFile("/v/b.mp4", "b.mp4");
    s.touchRecentFile("/v/a.mp4", 42);
    const fileA = useAppStore.getState().recentFiles.find((f) => f.path === "/v/a.mp4");
    expect(fileA?.lastPlayedTimestamp).toBe(42);
    expect(useAppStore.getState().recentFiles[0].fileName).toBe("a.mp4");
  });

  it("touchRecentFile no-ops for unknown paths (no history entry created)", () => {
    useAppStore.getState().touchRecentFile("/v/ghost.mp4", 5);
    expect(useAppStore.getState().recentFiles).toHaveLength(0);
  });

  it("removeRecentFile removes only the requested entry", () => {
    const s = useAppStore.getState();
    s.upsertRecentFile("/v/a.mp4", "a.mp4");
    s.upsertRecentFile("/v/b.mp4", "b.mp4");
    s.removeRecentFile("/v/a.mp4");
    expect(useAppStore.getState().recentFiles.map((f) => f.fileName)).toEqual(["b.mp4"]);
  });

  it("caps history at 20 entries, dropping the oldest", () => {
    const s = useAppStore.getState();
    for (let i = 0; i < 25; i++) s.upsertRecentFile(`/v/${i}.mp4`, `${i}.mp4`);
    const files = useAppStore.getState().recentFiles;
    expect(files).toHaveLength(20);
    expect(files[0].fileName).toBe("24.mp4");
    expect(files[files.length - 1].fileName).toBe("5.mp4");
  });

  it("playback rate defaults to 1, updates via the store, and resumeAt is one-shot", () => {
    expect(useAppStore.getState().playbackRate).toBe(1);
    useAppStore.getState().setPlaybackRate(1.5);
    expect(useAppStore.getState().playbackRate).toBe(1.5);

    expect(useAppStore.getState().resumeAt).toBeNull();
    useAppStore.getState().setResumeAt(77);
    expect(useAppStore.getState().resumeAt).toBe(77);
  });
});