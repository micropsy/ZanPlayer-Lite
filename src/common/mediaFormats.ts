// Centralized catalog of media file formats shared by the file-input accept
// attributes, drag-and-drop classifiers, and open-dialog filters. Keeping the
// extension lists here (instead of scattered `includes(...)` in components)
// means the set the app accepts is always exactly the set it can play, and the
// Android/iOS native backends can reuse the same expectations.

export const VIDEO_EXTENSIONS = [
  "mp4",
  "mkv",
  "mov",
  "avi",
  "wmv",
  "flv",
  "webm",
  "m4v",
] as const;

export const AUDIO_EXTENSIONS = [
  "mp3",
  "wav",
  "ogg",
  "flac",
  "m4a",
  "aac",
  "wma",
] as const;

// Formats the bundled parser can actually decode into cues. `.ass`/`.ssa` are
// recognized on drag-in but are not handwritten-subtitle payloads.
export const PARSABLE_SUBTITLE_EXTENSIONS = ["srt", "vtt"] as const;

// Full set of subtitle container extensions the app understands.
export const SUBTITLE_EXTENSIONS = [
  ...PARSABLE_SUBTITLE_EXTENSIONS,
  "ass",
  "ssa",
] as const;

const extensionOf = (fileName: string): string =>
  (fileName.toLowerCase().split(".").pop() || "").replace(/^\./, "");

export const isVideoFile = (fileName: string): boolean =>
  (VIDEO_EXTENSIONS as readonly string[]).includes(extensionOf(fileName));

export const isAudioFile = (fileName: string): boolean =>
  (AUDIO_EXTENSIONS as readonly string[]).includes(extensionOf(fileName));

export const isSubtitleFile = (fileName: string): boolean =>
  (SUBTITLE_EXTENSIONS as readonly string[]).includes(extensionOf(fileName));

export const isParsableSubtitleFile = (fileName: string): boolean =>
  (PARSABLE_SUBTITLE_EXTENSIONS as readonly string[]).includes(extensionOf(fileName));

/** Any playable audio or video file. */
export const isMediaFile = (fileName: string): boolean =>
  isVideoFile(fileName) || isAudioFile(fileName);

/** Best-guess MIME type for a filename, used e.g. by Android intent wiring. */
export const mimeForFile = (fileName: string): string => {
  const ext = extensionOf(fileName);
  if (isVideoFile(fileName)) {
    switch (ext) {
      case "mp4":
      case "m4v":
        return "video/mp4";
      case "webm":
        return "video/webm";
      case "mov":
        return "video/quicktime";
      case "avi":
        return "video/x-msvideo";
      case "wmv":
        return "video/x-ms-wmv";
      case "flv":
        return "video/x-flv";
      case "mkv":
        return "video/x-matroska";
      default:
        return "video/*";
    }
  }
  if (isAudioFile(fileName)) {
    switch (ext) {
      case "mp3":
        return "audio/mpeg";
      case "wav":
        return "audio/wav";
      case "ogg":
        return "audio/ogg";
      case "flac":
        return "audio/flac";
      case "m4a":
        return "audio/mp4";
      case "aac":
        return "audio/aac";
      case "wma":
        return "audio/x-ms-wma";
      default:
        return "audio/*";
    }
  }
  return "application/octet-stream";
};

/** `accept` attribute for a video-and-audio file input. */
export const mediaAcceptString = (): string => "video/*,audio/*,"
  .concat(
    [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS].map((e) => `.${e}`).join(",")
  );

/** `accept` attribute for the subtitle file input. */
export const subtitleAcceptString = (): string =>
  [...PARSABLE_SUBTITLE_EXTENSIONS].map((e) => `.${e}`).join(",");

// Containers the built-in HTML5 <video>/<audio> engines can actually demux.
// WebKit/Safari cannot demux Matroska (.mkv), AVI, FLV or ASF (.wmv) at all;
// Chromium only plays a narrow codec subset inside MKV. The native VLC engine
// handles every cataloged container, so these surfaces are only hit when the
// native engine is unavailable (PWA/web, or a desktop build without the
// feature) — where a silent black frame is worse than a clear message.
const HTML5_VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm"] as const;
const HTML5_AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "flac", "m4a", "aac"] as const;

/** True when the HTML5 fallback engine can realistically decode this file. */
export const isHtml5Playable = (fileName: string): boolean => {
  const ext = extensionOf(fileName);
  return (
    (HTML5_VIDEO_EXTENSIONS as readonly string[]).includes(ext) ||
    (HTML5_AUDIO_EXTENSIONS as readonly string[]).includes(ext)
  );
};

/**
 * Actionable hint when a container can't play on the fallback engine.
 * `nativeAvailable` (true when this build ships the native VLC engine AND it
 * was reachable for the current session) tailors the call-to-action: with
 * native around, playback already tries VLC first, so an HTML5 failure here
 * means neither engine decoded it; without it, the shipped build must convert
 * the file or switch to a native-enabled build — never a dead-end error.
 */
export const html5UnsupportedHint = (
  fileName: string,
  nativeAvailable = false
): string | null => {
  if (!isMediaFile(fileName)) return null;
  if (isHtml5Playable(fileName)) return null;
  const ext = extensionOf(fileName).toUpperCase();
  return nativeAvailable
    ? `"${fileName}" uses a ${ext} container that neither engine here could decode. Convert it to MP4/WebM (H.264) and try again.`
    : `"${fileName}" uses a ${ext} container this fallback player can't decode. Convert it to MP4/WebM, or use a ZanPlayer build with the native engine enabled.`;
};