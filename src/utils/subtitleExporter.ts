import type { SubtitleCue } from "../types/subtitle";

export const formatTimeSRT = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000);

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
};

export const formatTimeVTT = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000);

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
};

export const exportToSRT = (cues: SubtitleCue[]): string => {
  return cues
    .map((cue, index) => {
      return `${index + 1}\n${formatTimeSRT(cue.startTime)} --> ${formatTimeSRT(cue.endTime)}\n${cue.text}\n`;
    })
    .join("\n");
};

export const exportToVTT = (cues: SubtitleCue[]): string => {
  const header = "WEBVTT\n\n";
  const body = cues
    .map((cue) => {
      return `${formatTimeVTT(cue.startTime)} --> ${formatTimeVTT(cue.endTime)}\n${cue.text}\n`;
    })
    .join("\n");
  return header + body;
};
