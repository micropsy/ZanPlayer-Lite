import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

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

import { TauriService, isTauri, isMobileDevice } from "./tauri";

describe("isTauri environment detection", () => {
  const original = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");

  afterAll(() => {
    if (original) {
      Object.defineProperty(window, "__TAURI_INTERNALS__", original);
    } else {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });

  it("returns true when the Tauri webview injected __TAURI_INTERNALS__", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    expect(isTauri()).toBe(true);
  });

  it("returns false in a plain browser without the injected internals", () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    expect(isTauri()).toBe(false);
    // The test-suite default (Tauri-like shell) is restored for later suites.
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });
});

describe("TauriService dual-pass wiring", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("startTranscription forwards the output, generation modes and job id to Rust", async () => {
    invoke.mockResolvedValue(undefined);
    await TauriService.startTranscription("/v.mp4", "small", "my", "both", "stream", 12345);
    expect(invoke).toHaveBeenCalledWith("start_transcription", {
      mediaPath: "/v.mp4",
      modelName: "small",
      language: "my",
      subtitleMode: "both",
      transcriptionMode: "stream",
      jobId: 12345,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("startTranscription forwards original/batch with auto-detect (undefined) language", async () => {
    invoke.mockResolvedValue(undefined);
    await TauriService.startTranscription("/v.mp4", "tiny", undefined, "original", "batch", 67890);
    expect(invoke).toHaveBeenCalledWith("start_transcription", {
      mediaPath: "/v.mp4",
      modelName: "tiny",
      language: undefined,
      subtitleMode: "original",
      transcriptionMode: "batch",
      jobId: 67890,
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

  it("pollTranscriptCues maps this job's backend cues and preserves the pass kind", async () => {
    invoke.mockResolvedValue([
      { id: "o1", start_time: 1.0, end_time: 3.0, text: "မင်္ဂလာပါ", kind: "original" },
      { id: "t1", start_time: 1.0, end_time: 3.0, text: "Hello", kind: "translation" },
    ]);
    const cues = await TauriService.pollTranscriptCues(42);
    expect(invoke).toHaveBeenCalledWith("poll_transcript_cues", { jobId: 42 });
    expect(cues).toEqual([
      { id: "o1", startTime: 1.0, endTime: 3.0, text: "မင်္ဂလာပါ", kind: "original" },
      { id: "t1", startTime: 1.0, endTime: 3.0, text: "Hello", kind: "translation" },
    ]);
  });

  it("transcriptionActive reports backend job liveness for the completion safety net", async () => {
    invoke.mockResolvedValue(true);
    await expect(TauriService.transcriptionActive(7)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("transcription_active", { jobId: 7 });

    invoke.mockResolvedValue(false);
    await expect(TauriService.transcriptionActive(7)).resolves.toBe(false);
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

describe("isMobileDevice (touch-OS detection for the drawer rule)", () => {
  const realUA = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  const realTouch = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");

  function setUA(ua: string, touchPoints = 0) {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: ua,
    });
    Object.defineProperty(navigator, "maxTouchPoints", {
      configurable: true,
      value: touchPoints,
    });
  }

  afterAll(() => {
    if (realUA) Object.defineProperty(navigator, "userAgent", realUA);
    if (realTouch) Object.defineProperty(navigator, "maxTouchPoints", realTouch);
  });

  it("detects Android and iPhone/iPod", () => {
    setUA(
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Mobile Safari/537.36"
    );
    expect(isMobileDevice()).toBe(true);
    setUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari/604.1");
    expect(isMobileDevice()).toBe(true);
  });

  it("detects a real iPad (incl. iPadOS 13+ which reports a desktop UA)", () => {
    setUA("Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) Mobile Safari/605.1.15");
    expect(isMobileDevice()).toBe(true);
    // iPadOS 13+ in "desktop mode": Macintosh UA but touch hardware present.
    setUA(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      5
    );
    expect(isMobileDevice()).toBe(true);
  });

  it("a Mac / Windows desktop is never a mobile device", () => {
    setUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15");
    expect(isMobileDevice()).toBe(false);
    setUA(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36"
    );
    expect(isMobileDevice()).toBe(false);
  });
});