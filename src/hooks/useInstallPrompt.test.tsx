import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useInstallPrompt } from "./useInstallPrompt";

const dispatchInstallEvent = (
  userChoice: { outcome: "accepted" | "dismissed"; platform: string }
) => {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = new Event("beforeinstallprompt");
  Object.assign(event, { prompt, userChoice: Promise.resolve(userChoice) });
  act(() => {
    window.dispatchEvent(event);
  });
  return prompt;
};

describe("useInstallPrompt", () => {
  it("starts hidden and only advertises install when the browser offers it", () => {
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.canInstall).toBe(false);

    dispatchInstallEvent({ outcome: "dismissed", platform: "web" });
    expect(result.current.canInstall).toBe(true);
  });

  it("promptInstall shows the native dialog, accepts, and hides the button", async () => {
    const { result } = renderHook(() => useInstallPrompt());
    const prompt = dispatchInstallEvent({ outcome: "accepted", platform: "web" });

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.promptInstall();
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(accepted).toBe(true);
    expect(result.current.installed).toBe(true);
    expect(result.current.canInstall).toBe(false);

    // A second click is a no-op once the deferred prompt is consumed.
    let second: boolean | undefined;
    await act(async () => {
      second = await result.current.promptInstall();
    });
    expect(second).toBe(false);
  });

  it("a dismissed choice hides the button but does not claim install", async () => {
    const { result } = renderHook(() => useInstallPrompt());
    dispatchInstallEvent({ outcome: "dismissed", platform: "web" });

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.promptInstall();
    });

    expect(accepted).toBe(false);
    expect(result.current.installed).toBe(false);
    // The event is consumed either way; the browser may re-offer later.
    expect(result.current.canInstall).toBe(false);
  });

  it("cleans up its window listeners on unmount", () => {
    const added = { prompt: 0, installed: 0 };
    const removed = { prompt: 0, installed: 0 };

    const originalAdd = window.addEventListener.bind(window);
    const originalRemove = window.removeEventListener.bind(window);
    window.addEventListener = ((type: string) => {
      if (type === "beforeinstallprompt") added.prompt += 1;
      if (type === "appinstalled") added.installed += 1;
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string) => {
      if (type === "beforeinstallprompt") removed.prompt += 1;
      if (type === "appinstalled") removed.installed += 1;
    }) as typeof window.removeEventListener;

    const { unmount } = renderHook(() => useInstallPrompt());
    expect(added).toEqual({ prompt: 1, installed: 1 });

    unmount();
    expect(removed).toEqual({ prompt: 1, installed: 1 });

    window.addEventListener = originalAdd;
    window.removeEventListener = originalRemove;
  });
});