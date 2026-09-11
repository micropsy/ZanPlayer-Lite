import React, { useState, useCallback, useRef } from "react";
import { useAppStore } from "../services/store";
import {
  Languages,
  Upload,
  AlertCircle,
  Download,
  Settings as SettingsIcon,
  Trash2,
  List,
  FileText,
  FileVideo,
  Menu,
  Save,
  FolderOpen,
} from "lucide-react";
import { emit } from "@tauri-apps/api/event";
import { TauriService, type ProjectData } from "../services/tauri";
import { SettingsComponent } from "./Settings";
import { cn } from "../utils/cn";
import type { SubtitleTrack } from "../types/subtitle";

type Tab = "main" | "settings";

export const Sidebar = () => {
  const {
    setCurrentVideoUrl,
    subtitleTracks,
    setSubtitleTracks,
    resetSubtitles,
    activeSubtitleTrackId,
    setActiveSubtitleTrackId,
    currentVideo,
    setCurrentVideo,
    setCurrentVideoPath,
    currentVideoPath,
    shiftAllCues,
    theme,
    setSidebarVisible,
  } = useAppStore();
  const [activeTab, setActiveTab] = useState<Tab>("main");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [shiftOffset, setShiftOffset] = useState<string>("0");
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    setErrorMessage(null);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith("video/")) {
        resetSubtitles();
        setCurrentVideo(file);
        const url = URL.createObjectURL(file);
        setCurrentVideoUrl(url);
        setCurrentVideoPath(null);
      } else if (file.name.endsWith(".srt") || file.name.endsWith(".vtt")) {
        // Handle subtitle file
        try {
          const text = await file.text();
          let cues;
          if (file.name.endsWith(".srt")) {
            cues = parseSRT(text);
          } else {
            cues = parseVTT(text);
          }
          const track: SubtitleTrack = {
            id: `track-${Date.now()}`,
            name: file.name,
            language: "Unknown",
            cues,
          };
          setSubtitleTracks([...subtitleTracks, track]);
          setActiveSubtitleTrackId(track.id);
        } catch (err) {
          setErrorMessage(`Error reading subtitle file: ${(err as Error).message}`);
        }
      }
    }
  }, [currentVideo, subtitleTracks, resetSubtitles]);

  const parseSRT = (text: string) => {
    const cues: any[] = [];
    const blocks = text.trim().split(/\n\n+/);
    blocks.forEach(block => {
      const lines = block.split('\n');
      if (lines.length >= 3) {
        const timeLine = lines[1];
        const timeMatch = timeLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
        if (timeMatch) {
          const startTime = parseFloat(timeMatch[1])*3600 + parseFloat(timeMatch[2])*60 + parseFloat(timeMatch[3]) + parseFloat(timeMatch[4])/1000;
          const endTime = parseFloat(timeMatch[5])*3600 + parseFloat(timeMatch[6])*60 + parseFloat(timeMatch[7]) + parseFloat(timeMatch[8])/1000;
          const text = lines.slice(2).join('\n');
          cues.push({
            id: `cue-${Date.now()}-${Math.random()}`,
            startTime,
            endTime,
            text,
          });
        }
      }
    });
    return cues;
  };

  const parseVTT = (text: string) => {
    const cues: any[] = [];
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].includes('-->')) {
      i++;
    }
    while (i < lines.length) {
      const timeLine = lines[i];
      const timeMatch = timeLine.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
      if (timeMatch) {
        const startTime = parseFloat(timeMatch[1])*3600 + parseFloat(timeMatch[2])*60 + parseFloat(timeMatch[3]) + parseFloat(timeMatch[4])/1000;
        const endTime = parseFloat(timeMatch[5])*3600 + parseFloat(timeMatch[6])*60 + parseFloat(timeMatch[7]) + parseFloat(timeMatch[8])/1000;
        i++;
        let cueText = '';
        while (i < lines.length && lines[i].trim() !== '' && !lines[i].includes('-->')) {
          cueText += (cueText ? '\n' : '') + lines[i];
          i++;
        }
        cues.push({
          id: `cue-${Date.now()}-${Math.random()}`,
          startTime,
          endTime,
          text: cueText.trim(),
        });
      } else {
        i++;
      }
    }
    return cues;
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.type.startsWith("video/")) {
        resetSubtitles();
        setCurrentVideo(file);
        const url = URL.createObjectURL(file);
        setCurrentVideoUrl(url);
        setCurrentVideoPath(null);
        setErrorMessage(null);
      } else if (file.name.endsWith(".srt") || file.name.endsWith(".vtt")) {
        // Handle subtitle file
        try {
          file.text().then(text => {
            let cues;
            if (file.name.endsWith(".srt")) {
              cues = parseSRT(text);
            } else {
              cues = parseVTT(text);
            }
            const track: SubtitleTrack = {
              id: `track-${Date.now()}`,
              name: file.name,
              language: "Unknown",
              cues,
            };
            setSubtitleTracks([...subtitleTracks, track]);
            setActiveSubtitleTrackId(track.id);
          });
        } catch (error) {
          setErrorMessage(`Error reading subtitle file: ${(error as Error).message}`);
        }
      }
    }
  };

  // Tauri v2 injects __TAURI_INTERNALS__ even without withGlobalTauri, so check for
  // either global. Without this, "Select Video" falls back to the browser file input,
  // which can never produce a filesystem path and therefore never auto-transcribes.
  const isTauriApp =
    typeof window !== "undefined" &&
    ((window as any).__TAURI_INTERNALS__ !== undefined ||
      (window as any).__TAURI__ !== undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const subtitleFileInputRef = useRef<HTMLInputElement>(null);

  const handleNativeVideoSelect = async () => {
    if (!isTauriApp) {
      fileInputRef.current?.click();
      return;
    }
    setErrorMessage(null);
    try {
      const videoFile = await TauriService.openVideoDialog();
      if (videoFile) {
        // Mirror the drag-and-drop logic (App.tsx handleDroppedFiles) exactly:
        // reset subtitles, clear the File object, set the asset URL, set the real
        // filesystem path (so VideoPlayer's auto-transcribe effect fires), and emit
        // the video-dropped event for autoplay parity.
        resetSubtitles();
        setCurrentVideo(null);
        const url = await TauriService.getVideoBlobUrl(videoFile.path);
        setCurrentVideoUrl(url);
        setCurrentVideoPath(videoFile.path);
        emit("zanplayer-lite:video-dropped");
      }
    } catch (error) {
      setErrorMessage(`Error selecting video: ${(error as Error).message}`);
    }
  };

  const handleLoadSubtitleFile = async () => {
    if (!isTauriApp) {
      subtitleFileInputRef.current?.click();
      return;
    }
    try {
      const filePath = await TauriService.openSubtitleDialog();
      if (filePath) {
        const cues = await TauriService.readSubtitleFile(filePath);
        const track: SubtitleTrack = {
          id: `track-${Date.now()}`,
          name: `Subtitles (${filePath.split("/").pop()?.split(".").pop() || ""})`,
          language: "Unknown",
          cues,
        };
        setSubtitleTracks([...subtitleTracks, track]);
        setActiveSubtitleTrackId(track.id);
      }
    } catch (error) {
      setErrorMessage(`Error loading subtitle: ${(error as Error).message}`);
    }
  };

  const handleExport = async (format: "srt" | "vtt") => {
    const tracksToExport: { track: SubtitleTrack; suffix: string }[] = [];

    if (activeSubtitleTrackId) {
      const track = subtitleTracks.find((t) => t.id === activeSubtitleTrackId);
      if (track) tracksToExport.push({ track, suffix: `-${track.language.toLowerCase()}` });
    }

    if (tracksToExport.length === 0) {
      alert("Please select at least one subtitle track");
      return;
    }

    for (const { track, suffix } of tracksToExport) {
      try {
        const defaultName = `subtitles${suffix}.${format}`;
        const savePath = await TauriService.saveSubtitleDialog(defaultName);
        if (savePath) {
          await TauriService.writeSubtitleFile(savePath, track.cues, format);
        }
      } catch (error) {
        console.error("Export error:", error);
        setErrorMessage(`Error exporting subtitles: ${(error as Error).message}`);
      }
    }

    setShowExportOptions(false);
  };

  const handleSaveProject = async () => {
    if (!currentVideoPath) return;
    setErrorMessage(null);
    try {
      const savePath = await TauriService.saveProjectDialog();
      if (!savePath) return;
      const state = useAppStore.getState();
      const projectData: ProjectData = {
        version: 1,
        videoPath: state.currentVideoPath!,
        subtitleTracks: state.subtitleTracks,
        activeSubtitleTrackId: state.activeSubtitleTrackId,
        showSubtitles: state.showSubtitles,
        subtitleMode: state.subtitleMode,
        transcriptionMode: state.transcriptionMode,
        sourceLanguage: state.sourceLanguage,
        subtitleStyle: state.subtitleStyle,
        currentTime: state.currentTime,
      };
      await TauriService.writeProjectFile(savePath, projectData);
    } catch (error) {
      setErrorMessage(`Error saving project: ${(error as Error).message}`);
    }
  };

  const handleLoadProject = async () => {
    setErrorMessage(null);
    try {
      const filePath = await TauriService.openProjectDialog();
      if (!filePath) return;
      const { project, mediaExists } = await TauriService.readProjectFile(filePath);
      if (!mediaExists) {
        setErrorMessage(
          `Video file not found: ${project.videoPath}. Subtitles and settings were restored, but playback will be unavailable.`
        );
      }
      // Hydrates every field in one store write (see store.ts `loadProject`);
      // because subtitle tracks are populated before the video path effect runs,
      // Whisper inference is bypassed entirely for a loaded project.
      useAppStore.getState().loadProject(project);
    } catch (error) {
      setErrorMessage(`Error loading project: ${(error as Error).message}`);
    }
  };

  const handleDeleteTrack = (trackId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Are you sure you want to delete this subtitle track?")) {
      const updatedTracks = subtitleTracks.filter((t) => t.id !== trackId);
      setSubtitleTracks(updatedTracks);
      if (activeSubtitleTrackId === trackId) {
        setActiveSubtitleTrackId(null);
      }
    }
  };

  const handleShiftAllCues = (trackId: string) => {
    const offset = parseFloat(shiftOffset);
    if (!isNaN(offset)) {
      shiftAllCues(trackId, offset);
    }
  };

  const hasTracks = !!activeSubtitleTrackId;



  return (
    <div 
      className={cn(
        "w-96 border-r flex flex-col h-full relative",
        theme === "dark" 
          ? "bg-zan-black border-gray-700" 
          : "bg-white border-gray-200"
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Drag & Drop Overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-zan-cyan/10 border-4 border-dashed border-zan-cyan flex items-center justify-center">
          <div className="text-center text-white">
            <FileVideo className="w-16 h-16 mx-auto mb-4" />
            <p className="text-xl font-semibold">Drop video or subtitle file</p>
          </div>
        </div>
      )}
      {/* Header Row */}
      <div className={cn(
        "flex items-center border-b",
        theme === "dark" ? "border-gray-700" : "border-gray-200"
      )}>
        {/* App Logo */}
        <div className="flex items-center gap-3 px-4 py-3">
          <img 
            src="/logo.png" 
            alt="ZanPlayer Lite" 
            className="w-10 h-10 rounded-lg"
          />
          <span className="text-xl font-bold text-white">ZanPlayer Lite</span>
        </div>
        <button
          onClick={() => setActiveTab("main")}
          className={cn(
            "flex-1 py-3 px-4 text-sm font-medium transition-colors",
            activeTab === "main"
              ? theme === "dark"
                ? "bg-zan-blue/15 text-white border-b-2 border-zan-cyan"
                : "bg-gray-100 text-gray-900 border-b-2 border-zan-cyan"
              : theme === "dark"
                ? "text-gray-500 hover:text-gray-300"
                : "text-gray-500 hover:text-gray-700"
          )}
        >
          <div className="flex items-center justify-center gap-2">
            <List className="w-4 h-4" />
            Main
          </div>
        </button>
        <button
          onClick={() => setActiveTab("settings")}
          className={cn(
            "p-3 transition-colors",
            activeTab === "settings"
              ? theme === "dark"
                ? "bg-zan-blue/15 text-white border-b-2 border-zan-cyan"
                : "bg-gray-100 text-gray-900 border-b-2 border-zan-cyan"
              : theme === "dark"
                ? "text-gray-500 hover:text-gray-300"
                : "text-gray-500 hover:text-gray-700"
          )}
        >
          <SettingsIcon className="w-4 h-4" />
        </button>
        <button
          onClick={() => setSidebarVisible(false)}
          className={cn(
            "p-3 transition-colors",
            theme === "dark"
              ? "hover:bg-zan-blue/15 text-gray-400 hover:text-white"
              : "hover:bg-gray-100 text-gray-500 hover:text-gray-700"
          )}
        >
          <Menu className="w-5 h-5" />
        </button>
      </div>

      {activeTab === "main" && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className={cn(
            "p-6 border-b",
            theme === "dark"
              ? "border-gray-700 bg-gradient-to-b from-zan-deep to-zan-black"
              : "border-gray-200 bg-gradient-to-b from-gray-50 to-white"
          )}>

            {/* Error Message */}
            {errorMessage && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2">
                <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                <p className="text-red-300 text-sm">{errorMessage}</p>
              </div>
            )}

            {/* Video Upload Section */}
            <div className="space-y-3 mb-5">
              <button
                onClick={handleNativeVideoSelect}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl transition-all hover:scale-[1.01] active:scale-[0.99]"
              >
                <Upload className="w-5 h-5" />
                Select Video
              </button>
              <label className={cn(
                "flex items-center justify-center gap-2 px-4 py-2 text-sm cursor-pointer",
                theme === "dark"
                  ? "text-gray-400 hover:text-white"
                  : "text-gray-500 hover:text-gray-700"
              )}>
                or upload a file
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={handleFileInputChange}
                />
              </label>
              <input
                ref={subtitleFileInputRef}
                type="file"
                accept=".srt,.vtt"
                className="hidden"
                onChange={handleFileInputChange}
              />
            </div>

            {/* Controls */}
            <div className="space-y-3">
              <button
                onClick={handleLoadSubtitleFile}
                className={cn(
                  "w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl transition-all",
                  theme === "dark"
                    ? "bg-gray-800 hover:bg-gray-700 text-white"
                    : "bg-gray-100 hover:bg-gray-200 text-gray-900"
                )}
              >
                <FileText className="w-5 h-5" />
                Load Subtitle File
              </button>

              <div className="flex gap-2">
                {currentVideoPath && (
                  <button
                    onClick={handleSaveProject}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl transition-all",
                      theme === "dark"
                        ? "bg-gray-800 hover:bg-gray-700 text-white"
                        : "bg-gray-100 hover:bg-gray-200 text-gray-900"
                    )}
                  >
                    <Save className="w-5 h-5" />
                    Save Project
                  </button>
                )}
                <button
                  onClick={handleLoadProject}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl transition-all",
                    theme === "dark"
                      ? "bg-gray-800 hover:bg-gray-700 text-white"
                      : "bg-gray-100 hover:bg-gray-200 text-gray-900"
                  )}
                >
                  <FolderOpen className="w-5 h-5" />
                  Load Project
                </button>
              </div>

              {/* Export Options */}
              {hasTracks && (
                <div className="relative">
                  <button
                    onClick={() => setShowExportOptions(!showExportOptions)}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-gray-700 to-gray-600 hover:from-gray-600 hover:to-gray-500 text-white rounded-xl transition-all hover:scale-[1.01] active:scale-[0.99]"
                  >
                    <Download className="w-5 h-5" />
                    Export Subtitles
                  </button>

                  {showExportOptions && (
                    <div className={cn(
                      "absolute bottom-full left-0 right-0 mb-2 border rounded-xl shadow-2xl overflow-hidden z-10",
                      theme === "dark"
                        ? "bg-gray-800 border-gray-700"
                        : "bg-white border-gray-200"
                    )}>
                      <button
                        onClick={() => handleExport("srt")}
                        className={cn(
                          "w-full px-4 py-3 text-left transition-colors flex items-center gap-3",
                          theme === "dark" ? "hover:bg-gray-700" : "hover:bg-gray-100"
                        )}
                      >
                        <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                          <span className="text-xs font-bold text-white">SRT</span>
                        </div>
                        <div>
                          <p className={cn(
                            "font-semibold",
                            theme === "dark" ? "text-white" : "text-gray-900"
                          )}>Export SRT</p>
                          <p className="text-xs text-gray-400">SubRip format</p>
                        </div>
                      </button>
                      <button
                        onClick={() => handleExport("vtt")}
                        className={cn(
                          "w-full px-4 py-3 text-left transition-colors flex items-center gap-3",
                          theme === "dark" ? "hover:bg-gray-700" : "hover:bg-gray-100"
                        )}
                      >
                        <div className="w-8 h-8 bg-purple-600 rounded-lg flex items-center justify-center">
                          <span className="text-xs font-bold text-white">VTT</span>
                        </div>
                        <div>
                          <p className={cn(
                            "font-semibold",
                            theme === "dark" ? "text-white" : "text-gray-900"
                          )}>Export VTT</p>
                          <p className="text-xs text-gray-400">WebVTT format</p>
                        </div>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Subtitle Tracks */}
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className={cn(
              "p-4 border-b",
              theme === "dark"
                ? "border-gray-700 bg-gray-850"
                : "border-gray-200 bg-gray-50"
            )}>
              <h3 className={cn(
                "text-xs font-semibold uppercase tracking-wider flex items-center gap-2",
                theme === "dark" ? "text-gray-400" : "text-gray-500"
              )}>
                <List className="w-4 h-4" />
                Subtitle Tracks
              </h3>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {subtitleTracks.map((track) => (
                <div
                  key={track.id}
                  onClick={() => {
                    setActiveSubtitleTrackId(
                      activeSubtitleTrackId === track.id ? null : track.id
                    );
                  }}
                  className={cn(
                    "relative p-4 rounded-xl border transition-all cursor-pointer group",
                    activeSubtitleTrackId === track.id
                      ? "bg-blue-900/20 border-blue-500 shadow-lg shadow-blue-900/10"
                      : theme === "dark"
                        ? "bg-gray-800 border-gray-700 hover:bg-gray-750 hover:border-gray-600"
                        : "bg-white border-gray-200 hover:bg-gray-50 hover:border-gray-300"
                  )}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h4 className={cn(
                        "font-semibold text-sm",
                        activeSubtitleTrackId === track.id
                          ? "text-blue-300"
                          : theme === "dark"
                            ? "text-white"
                            : "text-gray-900"
                      )}>
                        {track.name}
                      </h4>
                      <p className={cn(
                        "text-xs mt-0.5",
                        theme === "dark" ? "text-gray-500" : "text-gray-400"
                      )}>{track.cues.length} cues</p>
                    </div>
                    <div className="flex items-center gap-1">
                      {track.isGenerated && (
                        <span className="text-xs px-2 py-0.5 bg-green-500/20 text-green-400 rounded-full font-medium">
                          Generated
                        </span>
                      )}
                      <button
                        onClick={(e) => handleDeleteTrack(track.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-500/20 rounded-lg text-gray-400 hover:text-red-400 transition-all"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Shift controls for original track */}
                  <div className={cn(
                    "mt-2 pt-2 border-t",
                    theme === "dark" ? "border-gray-700" : "border-gray-200"
                  )}>
                    <label className={cn(
                      "text-xs mb-1 block",
                      theme === "dark" ? "text-gray-500" : "text-gray-500"
                    )}>Shift all (seconds)</label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        value={shiftOffset}
                        onChange={(e) => setShiftOffset(e.target.value)}
                        step="0.1"
                        className={cn(
                          "flex-1 px-2 py-1 border rounded text-sm",
                          theme === "dark"
                            ? "bg-gray-900 border-gray-700 text-white"
                            : "bg-white border-gray-300 text-gray-900"
                        )}
                      />
                      <button
                        onClick={() => handleShiftAllCues(track.id)}
                        className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm"
                      >
                        Shift
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {subtitleTracks.length === 0 && (
                <div className={cn(
                  "flex flex-col items-center justify-center py-12",
                  theme === "dark" ? "text-gray-500" : "text-gray-400"
                )}>
                  <div className={cn(
                    "w-12 h-12 rounded-full flex items-center justify-center mb-3",
                    theme === "dark" ? "bg-gray-800" : "bg-gray-100"
                  )}>
                    <Languages className="w-6 h-6 opacity-50" />
                  </div>
                  <p className="text-sm">No subtitle tracks yet</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === "settings" && (
        <div className="flex-1 overflow-y-auto">
          <SettingsComponent />
        </div>
      )}
    </div>
  );
};
