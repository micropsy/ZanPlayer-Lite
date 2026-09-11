import { BadgeCheck, CheckCircle2, Download, DownloadCloud, Loader2, Rocket, X } from "lucide-react";
import { useAppStore } from "../services/store";
import { cancelUpdate, downloadUpdate, installAndRestart } from "../services/updater";

// Global update prompt. Rendered at the app root so it overlays everything with
// a blurred backdrop. Driven entirely by the store's updater state machine; the
// only phase that cannot be dismissed is the active download, to avoid leaving
// a corrupted staged update behind.
export const UpdateModal = () => {
  const updateModalOpen = useAppStore((s) => s.updateModalOpen);
  const updateStatus = useAppStore((s) => s.updateStatus);
  const downloadProgress = useAppStore((s) => s.downloadProgress);
  const updateVersion = useAppStore((s) => s.updateVersion);

  if (!updateModalOpen) return null;

  const locked = updateStatus === "downloading";

  return (
    <div
      onClick={() => {
        if (!locked) cancelUpdate();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md transition-opacity animate-modal-backdrop-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative bg-[#1a1b26] border border-white/10 rounded-2xl shadow-2xl w-[400px] p-6 transform transition-all scale-100 opacity-100 animate-modal-in overflow-hidden"
      >
        {/* Decorative top glow */}
        <div className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-64 h-64 rounded-full bg-blue-500/10 blur-3xl" />

        {!locked && (
          <button
            onClick={cancelUpdate}
            aria-label="Close"
            className="absolute top-4 right-4 z-10 p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/10 transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {updateStatus === "checking" && (
          <div className="relative flex flex-col items-center text-center py-6">
            <div className="w-14 h-14 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center mb-5 ring-1 ring-blue-500/20 shadow-lg shadow-blue-500/10">
              <Loader2 className="w-7 h-7 animate-spin" />
            </div>
            <h3 className="text-xl font-semibold text-white tracking-wide">Checking for updates...</h3>
            <p className="text-sm text-gray-400 mt-2 leading-relaxed">
              We're looking for the latest version of ZanPlayer Lite.
            </p>
          </div>
        )}

        {updateStatus === "available" && (
          <div className="relative flex flex-col items-center text-center py-4">
            <div className="w-14 h-14 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center mb-4 ring-1 ring-blue-500/20 shadow-lg shadow-blue-500/10">
              <DownloadCloud className="w-7 h-7" />
            </div>
            <h3 className="text-xl font-semibold text-white tracking-wide">Version available!</h3>
            <span className="bg-blue-500/20 text-blue-400 px-2 py-1 rounded text-xs font-medium mt-3">
              v{updateVersion}
            </span>
            <p className="text-sm text-gray-400 mt-2 leading-relaxed max-w-[300px]">
              A new version of ZanPlayer Lite is ready to download. Get the latest features and
              improvements now.
            </p>
            <div className="flex gap-2 w-full mt-6">
              <button
                onClick={cancelUpdate}
                className="flex-1 px-4 py-2.5 bg-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium rounded-lg transition-all"
              >
                Later
              </button>
              <button
                onClick={() => void downloadUpdate()}
                className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg shadow-md hover:shadow-blue-500/25 transition-all flex items-center justify-center gap-2"
              >
                <Download className="w-4 h-4" />
                Download
              </button>
            </div>
          </div>
        )}

        {updateStatus === "downloading" && (
          <div className="relative flex flex-col items-center text-center py-6">
            <div className="w-14 h-14 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center mb-5 ring-1 ring-blue-500/20 shadow-lg shadow-blue-500/10">
              <Loader2 className="w-7 h-7 animate-spin" />
            </div>
            <h3 className="text-xl font-semibold text-white tracking-wide">Downloading update...</h3>
            <div className="w-full mt-5">
              <div className="flex justify-between items-center text-sm mb-2">
                <span className="text-gray-400">
                  Downloading... {downloadProgress}%
                </span>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-gradient-to-r from-blue-500 to-cyan-400 h-2 rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${downloadProgress}%` }}
                />
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-4">
              Please keep the app open while the update downloads.
            </p>
          </div>
        )}

        {updateStatus === "ready" && (
          <div className="relative flex flex-col items-center text-center py-4">
            <div className="w-14 h-14 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center mb-4 ring-1 ring-green-500/20 shadow-lg shadow-green-500/10">
              <CheckCircle2 className="w-7 h-7" />
            </div>
            <h3 className="text-xl font-semibold text-white tracking-wide">Download complete.</h3>
            <span className="bg-green-500/20 text-green-400 px-2 py-1 rounded text-xs font-medium mt-3">
              v{updateVersion}
            </span>
            <p className="text-sm text-gray-400 mt-2 leading-relaxed max-w-[300px]">
              Your update is ready to install. Restart ZanPlayer Lite to apply the latest changes.
            </p>
            <div className="flex flex-col gap-2 w-full mt-6">
              <button
                onClick={() => void installAndRestart()}
                className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg shadow-md hover:shadow-blue-500/25 transition-all flex items-center justify-center gap-2"
              >
                <Rocket className="w-4 h-4" />
                Install & Restart
              </button>
              <button
                onClick={cancelUpdate}
                className="w-full px-4 py-2.5 bg-transparent hover:bg-white/5 text-gray-400 hover:text-white font-medium rounded-lg transition-all"
              >
                Later
              </button>
            </div>
          </div>
        )}

        {updateStatus === "uptodate" && (
          <div className="relative flex flex-col items-center text-center py-4">
            <div className="w-14 h-14 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center mb-4 ring-1 ring-green-500/20 shadow-lg shadow-green-500/10">
              <BadgeCheck className="w-7 h-7" />
            </div>
            <h3 className="text-xl font-semibold text-white tracking-wide">You're up to date!</h3>
            <p className="text-sm text-gray-400 mt-2 leading-relaxed max-w-[300px]">
              ZanPlayer Lite is running the latest version. Nothing to install.
            </p>
            <button
              onClick={cancelUpdate}
              className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg shadow-md hover:shadow-blue-500/25 transition-all mt-6"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
};