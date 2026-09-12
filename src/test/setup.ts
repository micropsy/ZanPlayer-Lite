import { vi } from "vitest";

// Simulate the Tauri webview shell so `isTauri()` (which keys off
// `window.__TAURI_INTERNALS__`) resolves true, exactly like the packaged app.
// The invoke/event mocks in each test file then handle the IPC calls. Tests
// that exercise the plain-browser path delete this key themselves.
Object.defineProperty(window, "__TAURI_INTERNALS__", {
  configurable: true,
  value: {},
});

// jsdom stubs media playback instead of implementing it. Give the video
// element harmless no-ops so handlers that call play()/pause()/load() don't
// blow up, a default duration, and a real currentTime so cue lookups run
// against a playhead the tests can move.
Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
  configurable: true,
  value: vi.fn().mockResolvedValue(undefined),
});
Object.defineProperty(window.HTMLMediaElement.prototype, "pause", {
  configurable: true,
  value: vi.fn(),
});
Object.defineProperty(window.HTMLMediaElement.prototype, "load", {
  configurable: true,
  value: vi.fn(),
});
Object.defineProperty(window.HTMLMediaElement.prototype, "duration", {
  configurable: true,
  get() {
    return (this as unknown as { __duration: number }).__duration ?? 100;
  },
  set(v: number) {
    (this as unknown as { __duration: number }).__duration = v;
  },
});
Object.defineProperty(window.HTMLMediaElement.prototype, "currentTime", {
  configurable: true,
  get() {
    return (this as unknown as { __currentTime: number }).__currentTime ?? 0;
  },
  set(v: number) {
    (this as unknown as { __currentTime: number }).__currentTime = v;
  },
});