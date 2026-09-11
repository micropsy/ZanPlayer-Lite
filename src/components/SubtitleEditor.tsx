import { X, Trash2, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useAppStore } from "../services/store";
import { cn } from "../utils/cn";

interface SubtitleEditorProps {
  onClose: () => void;
}

const autoResize = (e: FormEvent<HTMLTextAreaElement>) => {
  const el = e.currentTarget;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
};

const formatEditorTime = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    secs
  ).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
};

export const SubtitleEditor = ({ onClose }: SubtitleEditorProps) => {
  const subtitleTracks = useAppStore((s) => s.subtitleTracks);
  const activeSubtitleTrackId = useAppStore((s) => s.activeSubtitleTrackId);
  const currentTime = useAppStore((s) => s.currentTime);
  const setSeekTo = useAppStore((s) => s.setSeekTo);
  const setCurrentTime = useAppStore((s) => s.setCurrentTime);
  const updateCue = useAppStore((s) => s.updateCue);
  const updateCueTiming = useAppStore((s) => s.updateCueTiming);
  const deleteCue = useAppStore((s) => s.deleteCue);
  const addCue = useAppStore((s) => s.addCue);
  const theme = useAppStore((s) => s.theme);

  const originalTrack = subtitleTracks.find((t) => t.id === activeSubtitleTrackId);

  // Cue card currently under the playhead (same inclusive window the player
  // overlay uses), so the editor highlights match the on-screen subtitle.
  const activeCueId = originalTrack?.cues.find(
    (cue) => currentTime >= cue.startTime && currentTime <= cue.endTime
  )?.id;

  // Ref map so the follow-along scroll can bring the active cue into view.
  const cueRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    if (!activeCueId) return;
    cueRefs.current[activeCueId]?.scrollIntoView?.({ block: "nearest" });
  }, [activeCueId]);

  // Clicking a cue jumps the player to its start time. The store clock is
  // advanced optimistically as well, so the active-cue highlight moves the same
  // frame as the click instead of waiting on a media `timeupdate`; the player
  // guards the live clock against stale interim reports while the seek lands.
  const seekPlayerToCue = (startTime: number) => {
    setSeekTo(startTime);
    setCurrentTime(startTime);
  };

  const handleCueKeyDown = (
    e: KeyboardEvent<HTMLDivElement>,
    startTime: number
  ) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      seekPlayerToCue(startTime);
    }
  };

  const inputCls = cn(
    "w-[76px] px-2 py-1 border rounded-md text-right font-mono text-xs focus:outline-none focus:border-zan-cyan focus:ring-1 focus:ring-zan-cyan/30",
    theme === "dark"
      ? "bg-gray-800 border-gray-700 text-white"
      : "bg-white border-gray-300 text-gray-900"
  );

  const textareaCls = (accent?: string) =>
    cn(
      "w-full px-2 py-1.5 border rounded-md text-sm focus:outline-none focus:border-zan-cyan resize-none overflow-y-auto min-h-[2.5rem] max-h-[120px]",
      accent,
      theme === "dark"
        ? "bg-gray-800 border-gray-700 text-white"
        : "bg-white border-gray-300 text-gray-900"
    );

  return (
    <aside
      className={cn(
        "w-96 h-full flex flex-col border-l",
        theme === "dark" ? "border-gray-700 bg-zan-black" : "border-gray-200 bg-white"
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between px-3 py-2.5 border-b shrink-0",
          theme === "dark" ? "border-gray-700 bg-gray-850" : "border-gray-200 bg-gray-50"
        )}
      >
        <h3
          className={cn(
            "text-xs font-semibold uppercase tracking-wider",
            theme === "dark" ? "text-gray-300" : "text-gray-600"
          )}
        >
          Subtitle Editor
        </h3>
        <button
          onClick={onClose}
          className={cn(
            "p-1.5 rounded-lg transition-colors",
            theme === "dark"
              ? "text-gray-400 hover:text-white hover:bg-gray-800"
              : "text-gray-500 hover:text-gray-900 hover:bg-gray-100"
          )}
          title="Close editor"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {originalTrack?.cues.map((originalCue) => {
          const isActive = originalCue.id === activeCueId;
          return (
            <div
              key={originalCue.id}
              ref={(el) => {
                cueRefs.current[originalCue.id] = el;
              }}
              role="button"
              tabIndex={0}
              aria-current={isActive ? "true" : undefined}
              data-cue-id={originalCue.id}
              data-cue-active={isActive}
              onClick={() => seekPlayerToCue(originalCue.startTime)}
              onKeyDown={(e) => handleCueKeyDown(e, originalCue.startTime)}
              className={cn(
                "rounded-lg border p-2 transition-all cursor-pointer",
                isActive
                  ? "border-zan-cyan bg-zan-blue/15 shadow-[0_0_0_1px_rgba(34,211,238,0.35)]"
                  : theme === "dark"
                    ? "bg-gray-800 border-gray-700 hover:border-zan-cyan hover:bg-zan-blue/10"
                    : "bg-white border-gray-200 hover:border-zan-cyan hover:bg-gray-50"
              )}
            >
              <div
                className="flex items-center gap-1.5 mb-1.5"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="number"
                  step="0.1"
                  value={originalCue.startTime}
                  onChange={(e) =>
                    updateCueTiming(
                      originalTrack.id,
                      originalCue.id,
                      parseFloat(e.target.value) || 0,
                      originalCue.endTime
                    )
                  }
                  className={inputCls}
                  placeholder="Start"
                />
                <span className="text-xs text-gray-500">{"\u2192"}</span>
                <input
                  type="number"
                  step="0.1"
                  value={originalCue.endTime}
                  onChange={(e) =>
                    updateCueTiming(
                      originalTrack.id,
                      originalCue.id,
                      originalCue.startTime,
                      parseFloat(e.target.value) || 0
                    )
                  }
                  className={inputCls}
                  placeholder="End"
                />
                <span
                  className={cn(
                    "text-[10px] font-mono ml-1 hidden md:block",
                    theme === "dark" ? "text-gray-500" : "text-gray-400"
                  )}
                >
                  {formatEditorTime(originalCue.startTime)}
                </span>
                <div className="flex-1" />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteCue(originalTrack.id, originalCue.id);
                  }}
                  className={cn(
                    "p-1 rounded transition-all",
                    theme === "dark"
                      ? "text-gray-500 hover:bg-red-500/20 hover:text-red-400"
                      : "text-gray-400 hover:bg-red-50 hover:text-red-500"
                  )}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              <textarea
                value={originalCue.text}
                onInput={autoResize}
                rows={2}
                onChange={(e) => updateCue(originalTrack.id, originalCue.id, e.target.value)}
                className={textareaCls()}
              />
            </div>
          );
        })}

        {originalTrack && (
          <button
            onClick={() => {
              const cues = originalTrack.cues;
              const start = cues.length > 0 ? cues[cues.length - 1].endTime + 1 : 0;
              const end = cues.length > 0 ? cues[cues.length - 1].endTime + 4 : 3;
              addCue(originalTrack.id, { id: `cue-${Date.now()}`, startTime: start, endTime: end, text: "" });
            }}
            className={cn(
              "w-full flex items-center justify-center gap-2 p-2 border border-dashed rounded-lg text-sm transition-all",
              theme === "dark"
                ? "border-gray-700 text-gray-400 hover:text-white hover:border-gray-600"
                : "border-gray-300 text-gray-500 hover:text-gray-700 hover:border-gray-400"
            )}
          >
            <Plus className="w-4 h-4" />
            Add Cue
          </button>
        )}
      </div>
    </aside>
  );
};