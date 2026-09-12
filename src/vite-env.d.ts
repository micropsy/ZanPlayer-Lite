/// <reference types="vite/client" />

declare module '*.css' {
  const content: { [className: string]: string };
  export default content;
}

/** Exposed by the Tauri webview at runtime. Absent in plain browsers and test
 *  environments. */
interface Window {
  __TAURI_INTERNALS__?: Record<string, unknown>;
}
