import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./store";
import type { ProjectData } from "./tauri";

/**
 * Roundtrip helper: pull workspace fields from the store in the same shape
 * that Sidebar's `handleSaveProject` would, then hydrate back in.
 */
const buildProjectFromStore = (): ProjectData => {
  const s = useAppStore.getState();
  return {
    version: 1,
    videoPath: s.currentVideoPath ?? "",
    subtitleTracks: s.subtitleTracks,
    activeSubtitleTrackId: s.activeSubtitleTrackId,
    showSubtitles: s.showSubtitles,
    subtitleMode: s.subtitleMode,
    transcriptionMode: s.transcriptionMode,
    sourceLanguage: s.sourceLanguage,
    subtitleStyle: s.subtitleStyle,
    currentTime: s.currentTime,
  };
};

describe("project format roundtrip", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      subtitleTracks: [],
      activeSubtitleTrackId: null,
      currentVideoPath: null,
      currentTime: 0,
    });
  });

  it("JSON roundtrip preserves every field without data loss", () => {
    // Populate a realistic workspace.
    useAppStore.setState({
      currentVideoPath: "/tmp/movie.mp4",
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
          id: "manual",
          name: "Movie.srt",
          language: "en",
          isGenerated: false,
          cues: [
            { id: "c3", startTime: 2, endTime: 4, text: "Manual cue" },
          ],
        },
      ],
      activeSubtitleTrackId: "track-orig",
      subtitleMode: "both",
      transcriptionMode: "stream",
      sourceLanguage: "my",
      currentTime: 15.0,
    });

    const project = buildProjectFromStore();
    const json = JSON.stringify(project);
    const restored: ProjectData = JSON.parse(json);

    expect(restored.version).toBe(1);
    expect(restored.videoPath).toBe("/tmp/movie.mp4");
    expect(restored.subtitleTracks).toHaveLength(2);

    // Cue kinds survive the JSON journey.
    const origTrack = restored.subtitleTracks.find((t) => t.id === "track-orig")!;
    expect(origTrack.cues[0].kind).toBe("original");
    expect(origTrack.isGenerated).toBe(true);

    // Manual track also survives intact.
    const manualTrack = restored.subtitleTracks.find((t) => t.id === "manual")!;
    expect(manualTrack.cues[0].kind).toBeUndefined();
    expect(manualTrack.isGenerated).toBe(false);

    expect(restored.activeSubtitleTrackId).toBe("track-orig");
    expect(restored.currentTime).toBe(15.0);
    expect(restored.subtitleMode).toBe("both");
  });

  it("loadProject hydrates a JSON-serialised project back into the store identically", () => {
    useAppStore.setState({
      currentVideoPath: "/tmp/movie.mp4",
      subtitleTracks: [
        {
          id: "track-orig",
          name: "Auto-Generated (Original)",
          language: "my",
          isGenerated: true,
          cues: [
            { id: "c1", startTime: 1, endTime: 3, text: "Hello", kind: "original" },
          ],
        },
      ],
      activeSubtitleTrackId: "track-orig",
      currentTime: 12.0,
    });

    const project = buildProjectFromStore();
    const json = JSON.stringify(project);
    const restored: ProjectData = JSON.parse(json);

    // Wipe the store, then hydrate.
    useAppStore.setState({
      currentVideoPath: null,
      subtitleTracks: [],
      activeSubtitleTrackId: null,
      currentTime: 0,
    });

    useAppStore.getState().loadProject(restored);
    const s = useAppStore.getState();

    expect(s.currentVideoPath).toBe("/tmp/movie.mp4");
    expect(s.subtitleTracks).toHaveLength(1);
    expect(s.subtitleTracks[0].id).toBe("track-orig");
    expect(s.subtitleTracks[0].cues[0]).toEqual({
      id: "c1",
      startTime: 1,
      endTime: 3,
      text: "Hello",
      kind: "original",
    });
    expect(s.activeSubtitleTrackId).toBe("track-orig");
    expect(s.currentTime).toBe(12.0);
  });
});
