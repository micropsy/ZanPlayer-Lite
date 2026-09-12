import { describe, it, expect } from "vitest";
import {
  isVideoFile,
  isAudioFile,
  isSubtitleFile,
  isParsableSubtitleFile,
  isMediaFile,
  mimeForFile,
  mediaAcceptString,
  subtitleAcceptString,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  PARSABLE_SUBTITLE_EXTENSIONS,
  SUBTITLE_EXTENSIONS,
} from "./mediaFormats";

describe("media formats catalog", () => {
  it("classifies every advertised video and audio extension", () => {
    for (const ext of VIDEO_EXTENSIONS) {
      expect(isVideoFile(`clip.${ext}`)).toBe(true);
      expect(isVideoFile(`CLIP.${ext.toUpperCase()}`)).toBe(true);
      expect(isMediaFile(`clip.${ext}`)).toBe(true);
    }
    for (const ext of AUDIO_EXTENSIONS) {
      expect(isAudioFile(`song.${ext}`)).toBe(true);
      expect(isMediaFile(`song.${ext}`)).toBe(true);
    }
    // no cross-contamination between catalogs
    expect(VIDEO_EXTENSIONS.filter((e) => (AUDIO_EXTENSIONS as readonly string[]).includes(e))).toEqual([]);
  });

  it("treats subtitle extensions as subtitles, never as playable media", () => {
    for (const ext of SUBTITLE_EXTENSIONS) {
      expect(isSubtitleFile(`subs.${ext}`)).toBe(true);
      expect(isMediaFile(`subs.${ext}`)).toBe(false);
      expect(isVideoFile(`subs.${ext}`)).toBe(false);
      expect(isAudioFile(`subs.${ext}`)).toBe(false);
    }
    // only srt/vtt are handwritten-subtitle payloads the parser can load
    for (const ext of PARSABLE_SUBTITLE_EXTENSIONS) {
      expect(isParsableSubtitleFile(`subs.${ext}`)).toBe(true);
    }
    expect(isParsableSubtitleFile("subs.ass")).toBe(false);
    expect(isParsableSubtitleFile("subs.ssa")).toBe(false);
  });

  it("returns false for dotless names, multi-dot names, and unknown extensions", () => {
    expect(isVideoFile("noextension")).toBe(false);
    expect(isAudioFile("noextension")).toBe(false);
    expect(isMediaFile("nothinghere")).toBe(false);
    expect(isSubtitleFile(".hidden")).toBe(false);
    expect(isVideoFile("movie.mpeg2")).toBe(false);
    expect(isMediaFile("movie.mp4.exe")).toBe(false);
  });

  it("maps known extensions to a playback-friendly MIME type", () => {
    expect(mimeForFile("clip.mp4")).toBe("video/mp4");
    expect(mimeForFile("clip.mkv")).toBe("video/x-matroska");
    expect(mimeForFile("song.mp3")).toBe("audio/mpeg");
    expect(mimeForFile("song.flac")).toBe("audio/flac");
    expect(mimeForFile("notes.txt")).toBe("application/octet-stream");
  });

  it("builds accept strings that cover every catalogued extension", () => {
    const accept = mediaAcceptString();
    for (const ext of [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]) {
      expect(accept).toContain(`.${ext}`);
    }
    expect(accept).toContain("video/*");
    expect(accept).toContain("audio/*");
    // subtitle accept never admits .ass/.ssa (parser can't decode them)
    expect(subtitleAcceptString()).toContain(".srt");
    expect(subtitleAcceptString()).toContain(".vtt");
    expect(subtitleAcceptString()).not.toContain(".ass");
    expect(subtitleAcceptString()).not.toContain(".ssa");
  });
});