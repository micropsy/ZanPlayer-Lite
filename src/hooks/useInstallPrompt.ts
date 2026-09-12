import { useEffect, useState, useCallback } from "react";

/** The standard `beforeinstallprompt` event, narrowed to the parts Chrome/Edge
 *  expose for deferred installs (Android + desktop). iOS/iPadOS Safari never
 *  fires this event — "Add to Home Screen" there is a manual, documented flow. */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

/** Tracks whether the browser is offering a PWA install and drives the
 *  deferred prompt. Returns `canInstall` (true only while Chrome/Edge present
 *  an installable app and nothing has been accepted yet) and `promptInstall()`
 *  which shows the native install dialog and reports the user's choice. */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const canInstall = deferred !== null && !installed;

  const promptInstall = useCallback(async (): Promise<boolean> => {
    if (!deferred || installed) return false;
    const promptEvent = deferred;
    // Consume immediately so a second click can't re-open a spent event.
    setDeferred(null);
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome === "accepted") setInstalled(true);
    return outcome === "accepted";
  }, [deferred, installed]);

  return { canInstall, installed, promptInstall };
}