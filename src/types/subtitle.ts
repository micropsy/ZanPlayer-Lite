export interface SubtitleCue {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  /** Which whisper pass produced this cue: "original" | "translation" */
  kind?: string;
}

export interface SubtitleTrack {
  id: string;
  name: string;
  language: string;
  cues: SubtitleCue[];
  isGenerated?: boolean;
}
