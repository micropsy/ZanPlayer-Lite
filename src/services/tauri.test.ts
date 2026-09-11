import { describe, it, expect, vi, beforeEach } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn().mockResolvedValue("/home"),
}));

import { TauriService } from "./tauri";

describe("TauriService dual-pass wiring", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("startTranscription forwards the output and generation modes to Rust", async () => {
    invoke.mockResolvedValue(undefined);
    await TauriService.startTranscription("/v.mp4", "small", "my", "both", "stream");
    expect(invoke).toHaveBeenCalledWith("start_transcription", {
      mediaPath: "/v.mp4",
      modelName: "small",
      language: "my",
      subtitleMode: "both",
      transcriptionMode: "stream",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("startTranscription forwards original/batch with auto-detect (undefined) language", async () => {
    invoke.mockResolvedValue(undefined);
    await TauriService.startTranscription("/v.mp4", "tiny", undefined, "original", "batch");
    expect(invoke).toHaveBeenCalledWith("start_transcription", {
      mediaPath: "/v.mp4",
      modelName: "tiny",
      language: undefined,
      subtitleMode: "original",
      transcriptionMode: "batch",
    });
  });

  it("seekTranscription forwards the playhead target to the streaming job", async () => {
    invoke.mockResolvedValue(undefined);
    await TauriService.seekTranscription("/v.mp4", 42.5);
    expect(invoke).toHaveBeenCalledWith("seek_transcription", {
      mediaPath: "/v.mp4",
      seekTo: 42.5,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("pollTranscriptCues maps backend cues and preserves the pass kind", async () => {
    invoke.mockResolvedValue([
      { id: "o1", start_time: 1.0, end_time: 3.0, text: "မင်္ဂလာပါ", kind: "original" },
      { id: "t1", start_time: 1.0, end_time: 3.0, text: "Hello", kind: "translation" },
    ]);
    const cues = await TauriService.pollTranscriptCues();
    expect(cues).toEqual([
      { id: "o1", startTime: 1.0, endTime: 3.0, text: "မင်္ဂလာပါ", kind: "original" },
      { id: "t1", startTime: 1.0, endTime: 3.0, text: "Hello", kind: "translation" },
    ]);
  });

  it("writeProjectFile serializes data and calls invoke correctly", async () => {
    invoke.mockResolvedValue(undefined);
    const project = {
      version: 1,
      videoPath: "/tmp/test.mp4",
      subtitleTracks: [],
      activeSubtitleTrackId: null,
      showSubtitles: true,
      subtitleMode: "both" as const,
      transcriptionMode: "stream" as const,
      sourceLanguage: "my",
      subtitleStyle: {
        fontName: "Arial",
        fontSize: 24,
        primaryColor: "#FFFFFF",
        outlineColor: "#000000",
        backColor: "#80000000",
        bold: false,
        italic: false,
        alignment: "bottom" as const,
      },
      currentTime: 0,
    };
    await TauriService.writeProjectFile("/tmp/save.zan", project);
    expect(invoke).toHaveBeenCalledWith("write_project_file", {
      filePath: "/tmp/save.zan",
      data: project,
    });
  });

  it("readProjectFile returns parsed project and media existence flag", async () => {
    const project = {
      version: 1,
      videoPath: "/tmp/test.mp4",
      subtitleTracks: [{ id: "t1", name: "Orig", language: "my", cues: [] }],
      activeSubtitleTrackId: "t1",
      showSubtitles: true,
      subtitleMode: "english",
      transcriptionMode: "batch",
      sourceLanguage: "auto",
      subtitleStyle: {
        fontName: "Arial", fontSize: 24, primaryColor: "#FFFFFF",
        outlineColor: "#000000", backColor: "#80000000",
        bold: false, italic: false, alignment: "bottom",
      },
      currentTime: 5.0,
    };
    invoke.mockResolvedValue([project, true]);
    const result = await TauriService.readProjectFile("/tmp/load.zan");
    expect(invoke).toHaveBeenCalledWith("read_project_file", { filePath: "/tmp/load.zan" });
    expect(result.project.version).toBe(1);
    expect(result.project.videoPath).toBe("/tmp/test.mp4");
    expect(result.mediaExists).toBe(true);
  });
});