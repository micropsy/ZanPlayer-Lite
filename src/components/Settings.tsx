import { useAppStore } from "../services/store";
import { Languages, Settings as SettingsIcon, CheckCircle2, Info, Download, Trash2, Loader2, RefreshCw, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { isTauri } from "../services/tauri";
import { checkForUpdates } from "../services/updater";
import { getVersion } from "@tauri-apps/api/app";
import logoUrl from "../assets/icon.png";

interface WhisperModel {
  id: string;
  name: string;
  description: string;
  accuracy: number;
  speed: number;
  size: string;
  isPlus?: boolean;
}

const whisperModels: WhisperModel[] = [
  {
    id: "tiny",
    name: "Tiny",
    description: "Fastest transcription with acceptable accuracy",
    accuracy: 55,
    speed: 100,
    size: "75MB",
  },
  {
    id: "base",
    name: "Base",
    description: "Good balance of speed and accuracy",
    accuracy: 65,
    speed: 85,
    size: "142MB",
  },
  {
    id: "small",
    name: "Small",
    description: "High accuracy with fast transcription speed",
    accuracy: 75,
    speed: 60,
    size: "461MB",
  },
  {
    id: "medium",
    name: "Medium",
    description: "Very high accuracy with good speed",
    accuracy: 85,
    speed: 35,
    size: "1.5GB",
    isPlus: true,
  },
  {
    id: "large",
    name: "Large",
    description: "Maximum accuracy with slowest transcription speed",
    accuracy: 95,
    speed: 10,
    size: "2.9GB",
    isPlus: true,
  },
];

const systemFonts = [
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif",
  "Arial, sans-serif",
  "Helvetica, sans-serif",
  "Georgia, serif",
  "Times New Roman, serif",
  "Verdana, sans-serif",
  "Tahoma, sans-serif",
  "Geneva, sans-serif",
  "Courier New, monospace",
  "monospace",
  "serif",
  "sans-serif",
];

const card = (theme: string) =>
  theme === "dark" ? "bg-zan-black/40 border-gray-700/50" : "bg-white border-gray-200";

const labelClass = (theme: string) =>
  theme === "dark" ? "text-gray-400" : "text-gray-500";

const valueClass = (theme: string) =>
  theme === "dark" ? "text-white" : "text-gray-900";

const controlClass = (theme: string) =>
  theme === "dark"
    ? "bg-zan-black/60 border-gray-700/60 text-gray-100"
    : "bg-white border-gray-300 text-gray-900";

const trackClass = (theme: string) => (theme === "dark" ? "bg-gray-700" : "bg-gray-200");

const Toggle = ({
  on,
  onClick,
}: {
  on: boolean;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
      on ? "bg-zan-cyan" : "bg-gray-600"
    }`}
  >
    <span
      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
        on ? "translate-x-6" : "translate-x-1"
      }`}
    />
  </button>
);

export const SettingsComponent = () => {
  const {
    theme,
    setTheme,
    whisperModel,
    setWhisperModel,
    subtitleStyle,
    setSubtitleStyle,
    transcriptionMode,
    setTranscriptionMode,
    downloadedModels,
    downloadingModels,
    modelDownloadProgress,
    loadDownloadedModels,
    downloadModel,
    deleteModel,
    autoCheckUpdates,
    setAutoCheckUpdates,
    updateStatus,
    setUpdateModalOpen,
  } = useAppStore();

  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");

  useEffect(() => {
    loadDownloadedModels();
  }, [loadDownloadedModels]);

  const handleCheckUpdate = () => {
    if (updateStatus === "ready") {
      // A download is already staged - reopen the modal to offer
      // "Install & Restart" without hitting the network again.
      setUpdateModalOpen(true);
      return;
    }
    void checkForUpdates("manual");
  };

  useEffect(() => {
    if (!isTauri()) return;
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  const currentModelName = whisperModels.find(m => m.id === whisperModel)?.name || whisperModel;
  const inputClass = `w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-zan-cyan ${controlClass(theme)}`;
  const selectFieldClass = `px-2.5 py-1.5 rounded-lg text-sm border focus:outline-none focus:ring-1 focus:ring-zan-cyan ${controlClass(theme)}`;

  return (
    <div className="p-8 space-y-8 overflow-y-auto">
      <div className="flex items-center gap-2">
        <SettingsIcon className={`w-5 h-5 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-600'}`} />
        <h2 className={`text-lg font-semibold ${valueClass(theme)}`}>
          Settings
        </h2>
      </div>

      {/* Theme */}
      <section className="space-y-2">
        <label className={`block text-sm font-medium ${labelClass(theme)}`}>
          Theme
        </label>
        <select
          value={theme}
          onChange={(e) => setTheme(e.target.value as "dark" | "light")}
          className={inputClass}
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </section>

      {/* Updates */}
      <section className="space-y-2">
        <label className={`block text-sm font-medium ${labelClass(theme)}`}>
          Updates
        </label>
        {isTauri() ? (
          <>
            <div className={`p-4 rounded-xl border flex items-center justify-between gap-3 ${card(theme)}`}>
              <div className="space-y-0.5">
                <span className={`block text-sm font-medium ${valueClass(theme)}`}>
                  Automatically check for updates on startup
                </span>
                <span className={`block text-xs ${labelClass(theme)}`}>
                  ZanPlayer Lite silently looks for new versions when it launches.
                </span>
              </div>
              <Toggle on={autoCheckUpdates} onClick={() => setAutoCheckUpdates(!autoCheckUpdates)} />
            </div>
            <button
              onClick={handleCheckUpdate}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-zan-blue hover:bg-zan-deep text-white rounded-lg text-sm transition-all"
            >
              <RefreshCw className="w-4 h-4" />
              Check for Updates
            </button>
          </>
        ) : (
          <p className={`text-xs ${labelClass(theme)}`}>
            Update feature is only available in the desktop app.
          </p>
        )}
      </section>

      {/* Transcription Mode */}
      <section className="space-y-2">
        <label className={`block text-sm font-medium ${labelClass(theme)}`}>
          Transcription Mode
        </label>
        <p className={`text-xs ${labelClass(theme)}`}>
          Realtime streams a new caption the moment Whisper decodes it, so subtitles appear as you watch. Full (Batch) transcribes the entire audio before playback, then surfaces perfectly-synced captions with zero lag.
        </p>
        <div className={`flex p-0.5 rounded-lg border ${controlClass(theme)}`}>
          <button
            onClick={() => setTranscriptionMode("stream")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex-1 ${
              transcriptionMode === "stream"
                ? "bg-zan-cyan/15 text-zan-cyan"
                : theme === 'dark'
                  ? "text-gray-400 hover:text-white"
                  : "text-gray-500 hover:text-gray-900"
            }`}
          >
            Realtime (Streaming)
          </button>
          <button
            onClick={() => setTranscriptionMode("batch")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex-1 ${
              transcriptionMode === "batch"
                ? "bg-zan-cyan/15 text-zan-cyan"
                : theme === 'dark'
                  ? "text-gray-400 hover:text-white"
                  : "text-gray-500 hover:text-gray-900"
            }`}
          >
            Full (Batch)
          </button>
        </div>
      </section>

      {/* Models */}
      <section className="space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className={`text-sm font-semibold ${valueClass(theme)}`}>
              Whisper Models
            </h3>
            <Info className={`w-4 h-4 ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`} />
          </div>
          <p className={`text-xs ${labelClass(theme)}`}>
            Select a model to use for creating subtitles. Higher quality models provide better accuracy for more difficult audio.
          </p>
        </div>

        <div className={`flex items-center justify-between px-4 py-2.5 rounded-xl border ${card(theme)}`}>
          <span className={`text-xs font-medium ${labelClass(theme)}`}>
            Current Model
          </span>
          <span className={`text-xs font-semibold ${valueClass(theme)}`}>
            {currentModelName}
          </span>
        </div>

        <div className="flex flex-col gap-4">
          {whisperModels.map((model) => {
            const isDownloaded = downloadedModels.includes(model.id);
            const isDownloading = downloadingModels.has(model.id);
            const isSelected = whisperModel === model.id;
            const progress = modelDownloadProgress[model.id];

            return (
              <div
                key={model.id}
                className={`p-4 rounded-xl border transition-all ${card(theme)} ${
                  isSelected
                    ? theme === 'dark'
                      ? "border-zan-cyan/60 bg-zan-cyan/5"
                      : "border-zan-cyan bg-zan-cyan/10"
                    : theme === 'dark'
                      ? "hover:border-gray-600"
                      : "hover:border-gray-300"
                }`}
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center flex-wrap gap-2 min-w-0 flex-1">
                    <span className={`text-base font-semibold ${valueClass(theme)}`}>
                      {model.name}
                    </span>
                    {model.isPlus && (
                      <span className="px-1.5 py-0.5 bg-zan-cyan/15 text-zan-cyan text-[10px] font-semibold rounded-full">
                        Plus
                      </span>
                    )}
                    {isDownloaded && (
                      <span className={`px-1.5 py-0.5 text-[10px] font-semibold rounded-full ${
                        isSelected
                          ? "bg-zan-cyan/15 text-zan-cyan"
                          : "bg-green-500/10 text-green-400"
                      }`}>
                        {isSelected ? "Active" : "Loaded"}
                      </span>
                    )}
                    {isSelected && <CheckCircle2 className="w-4 h-4 text-green-400" />}
                  </div>
                  <span className={`text-xs font-medium ${labelClass(theme)} whitespace-nowrap shrink-0`}>
                    {model.size}
                  </span>
                </div>

                <p className={`text-[11px] mt-1 ${labelClass(theme)}`}>
                  {model.description}
                </p>

                <div className="my-3 space-y-2.5">
                  <div className="flex items-center justify-between text-xs text-gray-400">
                    <span className="w-16">Accuracy</span>
                    <div className={`flex-1 h-1.5 bg-gray-700 rounded-full ml-2 overflow-hidden`}>
                      <div className="h-full bg-blue-500 rounded-full" style={{ width: `${model.accuracy}%` }} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-xs text-gray-400">
                    <span className="w-16">Speed</span>
                    <div className={`flex-1 h-1.5 bg-gray-700 rounded-full ml-2 overflow-hidden`}>
                      <div className="h-full bg-blue-500 rounded-full" style={{ width: `${model.speed}%` }} />
                    </div>
                  </div>
                </div>

                <div className="mt-5 flex items-center justify-end gap-3">
                  {!isDownloaded && !progress?.error && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isTauri()) downloadModel(model.id);
                      }}
                      disabled={isDownloading || !isTauri()}
                      className={`px-3 py-1.5 text-white rounded-lg text-xs font-medium flex items-center gap-1 ${
                        isTauri()
                          ? isDownloading
                            ? 'bg-gray-600 cursor-not-allowed'
                            : 'bg-zan-blue hover:bg-zan-deep'
                          : 'bg-gray-400 cursor-not-allowed'
                      }`}
                    >
                      {isDownloading ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Download className="w-3 h-3" />
                      )}
                      {!isTauri()
                        ? 'Requires App'
                        : isDownloading
                          ? 'Downloading...'
                          : 'Download'}
                    </button>
                  )}
                  {isDownloaded && (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setWhisperModel(model.id);
                        }}
                        className={`px-4 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                          isSelected
                            ? "bg-zan-cyan/20 text-zan-cyan border-zan-cyan/30"
                            : "bg-zan-cyan/10 text-zan-cyan border-zan-cyan/30 hover:bg-zan-cyan/15"
                        }`}
                      >
                        Use
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isTauri()) setShowDeleteConfirm(model.id);
                        }}
                        disabled={!isTauri()}
                        className={`p-1.5 rounded-lg ${
                          isTauri()
                            ? theme === 'dark'
                              ? 'text-gray-400 hover:text-red-400 hover:bg-red-500/20'
                              : 'text-gray-500 hover:text-red-500 hover:bg-red-50'
                            : 'text-gray-400 cursor-not-allowed'
                        }`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                  {progress?.error && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isTauri()) downloadModel(model.id);
                        }}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 border transition-all ${
                          theme === 'dark'
                            ? 'border-gray-700 text-gray-300 hover:bg-gray-700/60'
                            : 'border-gray-300 text-gray-600 hover:bg-gray-100'
                        }`}
                      >
                        <RefreshCw className="w-3 h-3 text-red-400" />
                        Retry
                      </button>
                      {progress.message && (
                        <span className="text-[10px] text-red-400 max-w-[8rem] truncate" title={progress.message}>
                          {progress.message}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {progress && !progress.error && (
                  <div className="mt-2 space-y-1">
                    <div className={`h-1 rounded-full overflow-hidden ${trackClass(theme)}`}>
                      <div
                        className="h-full bg-zan-cyan transition-all duration-300"
                        style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[10px]">
                      <span className={labelClass(theme)}>
                        {progress.percent.toFixed(1)}%
                      </span>
                      <span className={labelClass(theme)}>
                        {progress.speedMBps.toFixed(1)} MB/s · ETA {progress.etaSeconds}s
                      </span>
                    </div>
                  </div>
                )}

                {showDeleteConfirm === model.id && (
                  <div className={`mt-3 p-3 rounded-lg border ${
                    theme === 'dark'
                      ? 'bg-red-500/10 border-red-500/20'
                      : 'bg-red-50 border-red-200'
                  }`}>
                    <p className={`text-xs mb-2 ${theme === 'dark' ? 'text-red-300' : 'text-red-600'}`}>
                      Are you sure you want to delete this model?
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setShowDeleteConfirm(null)}
                        className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium ${
                          theme === 'dark'
                            ? 'bg-gray-700 hover:bg-gray-600 text-white'
                            : 'bg-gray-200 hover:bg-gray-300 text-gray-900'
                        }`}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          deleteModel(model.id);
                          setShowDeleteConfirm(null);
                          if (whisperModel === model.id) {
                            setWhisperModel("tiny");
                          }
                        }}
                        className="flex-1 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-medium"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Subtitle Style */}
      <section className="space-y-4">
        <h3 className={`text-sm font-semibold flex items-center gap-2 ${valueClass(theme)}`}>
          <Languages className="w-4 h-4" />
          Subtitle Style
        </h3>

        {/* Subtitle Preview Box */}
        <div className={`relative rounded-xl overflow-hidden border ${
          theme === 'dark'
            ? 'bg-gradient-to-br from-zan-deep to-zan-black border-gray-700'
            : 'bg-gradient-to-br from-gray-100 to-gray-200 border-gray-300'
        }`}>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-xs opacity-20">
              Video Preview Placeholder
            </div>
          </div>
          <div className="relative h-40 flex items-end justify-center p-4">
            <div
              style={{
                fontFamily: subtitleStyle.fontName,
                fontSize: `${subtitleStyle.fontSize}px`,
                color: subtitleStyle.primaryColor,
                backgroundColor: subtitleStyle.backColor,
                textShadow: `2px 2px 4px ${subtitleStyle.outlineColor}`,
                fontWeight: subtitleStyle.bold ? 'bold' : 'normal',
                fontStyle: subtitleStyle.italic ? 'italic' : 'normal',
              }}
              className="text-center px-6 py-2 rounded-lg"
            >
              Sample Subtitle Text / နမူနာ စာတန်းထိုး
            </div>
          </div>
        </div>

        {/* Grouped settings list */}
        <div className="grid grid-cols-2 gap-3">
          {/* Font Family */}
          <div className={`p-4 rounded-xl border flex flex-col gap-2 ${card(theme)}`}>
            <span className={`text-sm ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
              Font
            </span>
            <select
              value={subtitleStyle.fontName}
              onChange={(e) => setSubtitleStyle({ fontName: e.target.value })}
              className={`w-full ${selectFieldClass}`}
            >
              {systemFonts.map((font) => (
                <option key={font} value={font} style={{ fontFamily: font }}>
                  {font.split(',')[0].replace(/['"]/g, '')}
                </option>
              ))}
            </select>
          </div>

          {/* Font Size */}
          <div className={`p-4 rounded-xl border flex flex-col gap-2 ${card(theme)}`}>
            <span className={`text-sm ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
              Font Size
            </span>
            <div className="flex items-center justify-between gap-3">
              <input
                type="range"
                min="12"
                max="72"
                value={subtitleStyle.fontSize}
                onChange={(e) => setSubtitleStyle({ fontSize: parseInt(e.target.value) })}
                className={`appearance-none flex-1 h-1 rounded-full cursor-pointer accent-zan-cyan ${trackClass(theme)}`}
              />
              <span className={`w-10 text-right text-xs font-mono ${valueClass(theme)}`}>
                {subtitleStyle.fontSize}px
              </span>
            </div>
          </div>

          {/* Text Color */}
          <div className={`p-4 rounded-xl border flex flex-col gap-2 ${card(theme)}`}>
            <span className={`text-sm ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
              Text Color
            </span>
            <div className="flex items-center gap-2">
              <span className={`relative h-8 w-10 rounded-lg border shrink-0 overflow-hidden ${
                theme === 'dark' ? 'border-gray-600' : 'border-gray-300'
              }`}>
                <span className="absolute inset-0" style={{ background: subtitleStyle.primaryColor }} />
                <input
                  type="color"
                  value={subtitleStyle.primaryColor}
                  onChange={(e) => setSubtitleStyle({ primaryColor: e.target.value })}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </span>
              <input
                type="text"
                value={subtitleStyle.primaryColor}
                onChange={(e) => setSubtitleStyle({ primaryColor: e.target.value })}
                className={`w-full min-w-0 px-2.5 py-1.5 rounded-lg text-xs font-mono border focus:outline-none focus:ring-1 focus:ring-zan-cyan ${controlClass(theme)}`}
                spellCheck={false}
              />
            </div>
          </div>

          {/* Outline Color */}
          <div className={`p-4 rounded-xl border flex flex-col gap-2 ${card(theme)}`}>
            <span className={`text-sm ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
              Outline Color
            </span>
            <div className="flex items-center gap-2">
              <span className={`relative h-8 w-10 rounded-lg border shrink-0 overflow-hidden ${
                theme === 'dark' ? 'border-gray-600' : 'border-gray-300'
              }`}>
                <span className="absolute inset-0" style={{ background: subtitleStyle.outlineColor }} />
                <input
                  type="color"
                  value={subtitleStyle.outlineColor}
                  onChange={(e) => setSubtitleStyle({ outlineColor: e.target.value })}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </span>
              <input
                type="text"
                value={subtitleStyle.outlineColor}
                onChange={(e) => setSubtitleStyle({ outlineColor: e.target.value })}
                className={`w-full min-w-0 px-2.5 py-1.5 rounded-lg text-xs font-mono border focus:outline-none focus:ring-1 focus:ring-zan-cyan ${controlClass(theme)}`}
                spellCheck={false}
              />
            </div>
          </div>

          {/* Background Color */}
          <div className={`p-4 rounded-xl border flex flex-col gap-2 ${card(theme)}`}>
            <span className={`text-sm ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
              Background
            </span>
            <div className="flex items-center gap-2">
              <span className={`relative h-8 w-10 rounded-lg border shrink-0 overflow-hidden ${
                theme === 'dark' ? 'border-gray-600' : 'border-gray-300'
              }`}>
                <span className="absolute inset-0" style={{ background: subtitleStyle.backColor }} />
                <input
                  type="color"
                  value={subtitleStyle.backColor.slice(0, 7)}
                  onChange={(e) => {
                    const newColor = e.target.value + subtitleStyle.backColor.slice(7);
                    setSubtitleStyle({ backColor: newColor });
                  }}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </span>
              <input
                type="text"
                value={subtitleStyle.backColor}
                onChange={(e) => setSubtitleStyle({ backColor: e.target.value })}
                className={`w-full min-w-0 px-2.5 py-1.5 rounded-lg text-xs font-mono border focus:outline-none focus:ring-1 focus:ring-zan-cyan ${controlClass(theme)}`}
                spellCheck={false}
              />
            </div>
          </div>

          {/* Bold */}
          <div className={`p-4 rounded-xl border flex items-center justify-between gap-3 ${card(theme)}`}>
            <span className={`text-sm ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
              Bold
            </span>
            <Toggle
              on={subtitleStyle.bold}
              onClick={() => setSubtitleStyle({ bold: !subtitleStyle.bold })}
            />
          </div>

          {/* Italic */}
          <div className={`p-4 rounded-xl border flex items-center justify-between gap-3 ${card(theme)}`}>
            <span className={`text-sm ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
              Italic
            </span>
            <Toggle
              on={subtitleStyle.italic}
              onClick={() => setSubtitleStyle({ italic: !subtitleStyle.italic })}
            />
          </div>

          {/* Position */}
          <div className={`p-4 rounded-xl border flex flex-col gap-2 ${card(theme)}`}>
            <span className={`text-sm ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
              Subtitle Position
            </span>
            <div className={`flex p-0.5 rounded-lg border ${controlClass(theme)}`}>
              <button
                onClick={() => setSubtitleStyle({ alignment: "top" })}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  subtitleStyle.alignment === "top"
                    ? "bg-zan-cyan/15 text-zan-cyan"
                    : theme === 'dark'
                      ? "text-gray-400 hover:text-white"
                      : "text-gray-500 hover:text-gray-900"
                }`}
              >
                Top
              </button>
              <button
                onClick={() => setSubtitleStyle({ alignment: "bottom" })}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  subtitleStyle.alignment === "bottom"
                    ? "bg-zan-cyan/15 text-zan-cyan"
                    : theme === 'dark'
                      ? "text-gray-400 hover:text-white"
                      : "text-gray-500 hover:text-gray-900"
                }`}
              >
                Bottom
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* About */}
      <section className="space-y-2">
        <h3 className={`text-sm font-medium flex items-center gap-2 ${labelClass(theme)}`}>
          <Info className="w-4 h-4 opacity-70" />
          About
        </h3>
        <div className={`p-8 rounded-2xl border flex flex-col items-center text-center gap-3 ${card(theme)}`}>
          <img src={logoUrl} alt="ZanPlayer Lite logo" className="w-20 h-20 rounded-2xl shadow-xl" />
          <div>
            <h4 className={`text-xl font-bold ${valueClass(theme)}`}>ZanPlayer Lite</h4>
            <p className={`text-sm mt-1 ${labelClass(theme)}`}>
              Version {appVersion || "—"}
            </p>
          </div>
          <a
            href="https://github.com/micropsy/ZanPlayer-Lite/releases"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-zan-cyan hover:underline"
          >
            Check Release Notes
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>
      </section>
    </div>
  );
};