import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { isTauri } from './services/tauri'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Register the app-shell service worker only on production web builds. The
// Tauri webview never registers (native caching is N/A and file:// startup
// predates any offline concern), and dev keeps the worker out of HMR's way.
if (import.meta.env.PROD && !isTauri() && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
