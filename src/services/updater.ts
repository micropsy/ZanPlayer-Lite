import { message } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { isTauri, TauriService } from "./tauri";
import { useAppStore } from "./store";

function errorDetail(err: unknown): string {
  return err instanceof Error && err.message.trim()
    ? err.message.trim()
    : typeof err === "string"
      ? err
      : "Unknown error";
}

// The Update object is only obtainable via check(); keep it around so the modal
// can start the download without re-asking the network for the same release.
let currentUpdate: Awaited<ReturnType<typeof check>> = null;

function openModal(status: "checking" | "available" | "ready" | "uptodate") {
  const store = useAppStore.getState();
  store.setUpdateStatus(status);
  store.setUpdateModalOpen(true);
}

// Global update flow driven by the store + UpdateModal. `mode: "background"`
// runs completely silently - it only ever surfaces the modal when an update
// actually exists. `mode: "manual"` always opens the modal so the user sees the
// spinner, the result, or the error.
export async function checkForUpdates(mode: "manual" | "background" = "manual"): Promise<void> {
  if (!isTauri()) return;

  if (mode === "manual") {
    openModal("checking");
  }

  try {
    const update = await check();
    const state = useAppStore.getState();
    // The user closed the modal (or cancelled) while the network call was in
    // flight - stay silent and avoid reopening it.
    if (mode === "manual" && state.updateStatus !== "checking") return;
    if (mode === "background" && (state.updateModalOpen || state.updateStatus !== "idle")) return;
    if (update) {
      currentUpdate = update;
      state.setUpdateVersion(update.version);
      openModal("available");
    } else if (mode === "manual") {
      currentUpdate = null;
      openModal("uptodate");
    }
  } catch (error) {
    const state = useAppStore.getState();
    if (mode === "manual") {
      console.error("Update check failed:", error);
      state.setUpdateModalOpen(false);
      state.setUpdateStatus("idle");
      const detail = errorDetail(error);
      if (detail.toLowerCase().includes("offline") || detail.toLowerCase().includes("no internet")) {
        await message("No internet connection. Please check your connection and try again.", {
          title: "Update Error",
          kind: "error",
        }).catch(() => {});
      } else {
        await message(`Unable to check for updates. ${detail}`, {
          title: "Update Error",
          kind: "error",
        }).catch(() => {});
      }
    } else {
      // Background: an error is expected (e.g. offline at startup) - stay quiet.
      console.error("Background update check failed:", error);
    }
  }
}

export async function downloadUpdate(): Promise<void> {
  if (!isTauri()) return;
  const store = useAppStore.getState();
  const update = currentUpdate ?? (await check().catch(() => null));
  if (!update) {
    // The staged update is gone (re-check came back empty); bounce back to the
    // available state so the user can decide rather than getting stuck.
    store.setUpdateStatus("available");
    return;
  }

  store.setUpdateStatus("downloading");
  store.setDownloadProgress(0);
  let totalBytes = 0;
  let downloadedBytes = 0;
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        totalBytes = event.data.contentLength ?? 0;
        downloadedBytes = 0;
        useAppStore.getState().setDownloadProgress(0);
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        // Guard against division by zero when the server omits the total size;
        // the bar simply stays at its current percentage.
        if (totalBytes > 0) {
          const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
          useAppStore.getState().setDownloadProgress(percent);
        }
      } else if (event.event === "Finished") {
        useAppStore.getState().setDownloadProgress(100);
        useAppStore.getState().setUpdateStatus("ready");
      }
    });
  } catch (error) {
    // Network blip mid-download: revert to "available" so the modal shows the
    // Download button again instead of a dead progress bar.
    console.error("Update download failed:", error);
    useAppStore.getState().setDownloadProgress(0);
    useAppStore.getState().setUpdateStatus("available");
  }
}

export async function installAndRestart(): Promise<void> {
  if (!isTauri()) return;
  try {
    // Equivalent to `relaunch()` from @tauri-apps/plugin-process: the bundled
    // Rust `relaunch_app` command exits the process and the updater applies the
    // staged update on the next launch.
    await TauriService.relaunchApp();
  } catch (error) {
    console.error("Relaunch failed:", error);
    const store = useAppStore.getState();
    store.setUpdateStatus("idle");
    store.setUpdateModalOpen(false);
    await message(`Unable to restart the app. ${errorDetail(error)}`, {
      title: "Update Error",
      kind: "error",
    }).catch(() => {});
  }
}

// Close the modal at any time EXCEPT mid-download (aborting there could leave a
// corrupted staged update).
export function cancelUpdate(): void {
  const store = useAppStore.getState();
  if (store.updateStatus === "downloading") return;
  store.setUpdateModalOpen(false);
  store.setUpdateStatus("idle");
  store.setDownloadProgress(0);
  store.setUpdateVersion(null);
  currentUpdate = null;
}