import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { SubtitleEditor } from "./SubtitleEditor";
import { useAppStore } from "../services/store";

const TRACK = {
  id: "track-1",
  name: "Movie.srt",
  language: "my",
  cues: [
    { id: "c1", startTime: 0, endTime: 5, text: "မင်္ဂလာပါ" },
    { id: "c2", startTime: 10, endTime: 15, text: "Hello there" },
  ],
};

const baseline = () =>
  useAppStore.setState({
    subtitleTracks: [TRACK],
    activeSubtitleTrackId: "track-1",
    currentTime: 0,
    seekTo: null,
  });

const cardFor = (cueId: string) =>
  document.querySelector<HTMLElement>(`[data-cue-id="${cueId}"]`);

const activeCueId = () =>
  document
    .querySelector('[data-cue-active="true"]')
    ?.getAttribute("data-cue-id");

describe("SubtitleEditor click-to-seek", () => {
  beforeEach(() => {
    localStorage.clear();
    baseline();
  });

  afterEach(() => {
    cleanup();
  });

  it("clicking a cue dispatches the seek and highlights it the same frame", () => {
    render(<SubtitleEditor onClose={() => {}} />);
    expect(activeCueId()).toBe("c1"); // playhead starts at 0

    fireEvent.click(cardFor("c2")!);

    const state = useAppStore.getState();
    expect(state.seekTo).toBe(10); // seek command dispatched to the player
    expect(state.currentTime).toBe(10); // optimistic — no timeupdate roundtrip
    expect(activeCueId()).toBe("c2");
  });

  it("the active highlight follows the playhead during playback", async () => {
    render(<SubtitleEditor onClose={() => {}} />);
    await act(async () => {
      useAppStore.getState().setCurrentTime(12);
    });
    expect(activeCueId()).toBe("c2");

    // Between cues there is nothing active, matching the player overlay.
    await act(async () => {
      useAppStore.getState().setCurrentTime(16);
    });
    expect(activeCueId()).toBeUndefined();
  });

  it("Enter on a focused cue card seeks exactly like a click", () => {
    render(<SubtitleEditor onClose={() => {}} />);
    fireEvent.keyDown(cardFor("c2")!, { key: "Enter" });
    expect(useAppStore.getState().seekTo).toBe(10);
    expect(useAppStore.getState().currentTime).toBe(10);
  });

  it("clicking the same cue twice does not leave a stale seek behind", () => {
    render(<SubtitleEditor onClose={() => {}} />);
    const store = useAppStore.getState();
    store.seekTo = 10;
    store.setSeekTo(null);

    fireEvent.click(cardFor("c1")!);
    expect(useAppStore.getState().seekTo).toBe(0);
    expect(useAppStore.getState().currentTime).toBe(0);
  });
});