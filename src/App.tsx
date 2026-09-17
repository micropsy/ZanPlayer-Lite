import { useAppStore } from './services/store';
import { Sidebar } from './components/Sidebar';
import { VideoPlayer } from './components/VideoPlayer';
import { SubtitleEditor } from './components/SubtitleEditor';
import { useEffect, useRef, useState, useCallback } from 'react';
import { Menu, FileVideo, Download } from 'lucide-react';
import { listen, emit } from '@tauri-apps/api/event';
import { TauriService, isTauri, isMacOs, isMobileDevice, WINDOW_FULLSCREEN_EVENT } from './services/tauri';
import { useInstallPrompt } from './hooks/useInstallPrompt';
import { checkForUpdates } from './services/updater';
import { UpdateModal } from './components/UpdateModal';
import { isMediaFile, isVideoFile, isAudioFile, isSubtitleFile, isParsableSubtitleFile } from './common/mediaFormats';

// Title-bar drag region. WKWebView does NOT honor `-webkit-app-region: drag`
// (that's a Chromium/Electron extension), and Tauri's injected
// `data-tauri-drag-region` handler calls core `startDragging`, which reads
// `NSApp.currentEvent` and silently no-ops once the FOCUSED webview consumed
// the mousedown ("drag works from other apps but dies when the app is active").
// So there is no attribute magic here: a real mousedown on the strip drives
// `TauriService.startWindowDrag()` → the backend's synthesized
// `performWindowDragWithEvent:` — the only path that drags while focused.
// Interactive children (buttons/inputs) are excluded so clicks keep working
// while chrome space drags the window.

function App() {
  const theme = useAppStore(state => state.theme);
  const sidebarVisible = useAppStore(state => state.sidebarVisible);
  const setSidebarVisible = useAppStore(state => state.setSidebarVisible);
  const setCurrentVideo = useAppStore(state => state.setCurrentVideo);
  const setCurrentVideoUrl = useAppStore(state => state.setCurrentVideoUrl);
  const setCurrentVideoPath = useAppStore(state => state.setCurrentVideoPath);
  const setSubtitleTracks = useAppStore(state => state.setSubtitleTracks);
  const resetSubtitles = useAppStore(state => state.resetSubtitles);
  const setActiveSubtitleTrackId = useAppStore(state => state.setActiveSubtitleTrackId);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [isFullscreenUi, setIsFullscreenUi] = useState(false);
  const { canInstall, promptInstall } = useInstallPrompt();

  // Helper to parse SRT
  const parseSRT = (text: string) => {
    const cues: any[] = [];
    const blocks = text.trim().split('\n\n');
    for (const block of blocks) {
      const lines = block.split('\n');
      if (lines.length >= 3) {
        const timeLine = lines[1];
        const times = timeLine.split(' --> ');
        if (times.length === 2) {
          const parseTime = (t: string) => {
            const parts = t.split(/[:,]/);
            if (parts.length === 4) {
              return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]) + parseInt(parts[3]) / 1000;
            }
            return 0;
          };
          const startTime = parseTime(times[0]);
          const endTime = parseTime(times[1]);
          const cueText = lines.slice(2).join('\n');
          cues.push({
            id: crypto.randomUUID(),
            startTime,
            endTime,
            text: cueText
          });
        }
      }
    }
    return cues;
  };

  // Helper to parse VTT
  const parseVTT = (text: string) => {
    const cues: any[] = [];
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].includes('-->')) {
      i++;
    }
    while (i < lines.length) {
      if (lines[i].includes('-->')) {
        const times = lines[i].split(' --> ');
        if (times.length === 2) {
          const parseTime = (t: string) => {
            const parts = t.split(/[:.]/);
            if (parts.length === 4) {
              return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]) + parseInt(parts[3]) / 1000;
            } else if (parts.length === 3) {
              return parseInt(parts[0]) * 60 + parseInt(parts[1]) + parseInt(parts[2]) / 1000;
            }
            return 0;
          };
          const startTime = parseTime(times[0]);
          const endTime = parseTime(times[1]);
          i++;
          let cueText = '';
          while (i < lines.length && lines[i].trim() !== '' && !lines[i].includes('-->')) {
            if (cueText) cueText += '\n';
            cueText += lines[i];
            i++;
          }
          if (cueText) {
            cues.push({
              id: crypto.randomUUID(),
              startTime,
              endTime,
              text: cueText
            });
          }
        }
      }
      i++;
    }
    return cues;
  };

  // Handle dropped file paths from Tauri
  const handleDroppedFiles = useCallback(async (filePaths: string[]) => {
    for (const filePath of filePaths) {
      const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || '';
      if (isVideoFile(fileName) || isAudioFile(fileName)) {
        // Handle video/audio file
        try {
          const url = await TauriService.getVideoBlobUrl(filePath);
          resetSubtitles(); // Wipe out subtitles from the previous video
          setCurrentVideo(null); // Clear any File object
          setCurrentVideoUrl(url);
          setCurrentVideoPath(filePath);
          emit('zanplayer-lite:video-dropped');
        } catch (error) {
          console.error('Failed to load video/audio:', error);
        }
      } else if (isSubtitleFile(fileName)) {
        // Handle subtitle file
        try {
          const cues = await TauriService.readSubtitleFile(filePath);
          const track = {
            id: crypto.randomUUID(),
            name: fileName,
            language: 'Unknown',
            cues
          };
          setSubtitleTracks([track]);
          setActiveSubtitleTrackId(track.id);
        } catch (error) {
          console.error('Failed to read subtitle file:', error);
        }
      }
    }
  }, [setCurrentVideo, setCurrentVideoUrl, setCurrentVideoPath, resetSubtitles, setSubtitleTracks, setActiveSubtitleTrackId]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.classList.toggle('light', theme === 'light');
  }, [theme]);

  // Silent background update check on startup. Keep it completely invisible
  // when there is nothing new; only prompt if an update is actually found.
  const startupUpdateCheckRef = useRef(false);
  useEffect(() => {
    if (!isTauri()) return;
    if (startupUpdateCheckRef.current) return;
    startupUpdateCheckRef.current = true;
    if (!useAppStore.getState().autoCheckUpdates) return;
    void checkForUpdates('background');
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFullscreen = document.fullscreenElement !== null;
      setIsFullscreenUi(isFullscreen);
      setSidebarVisible(!isFullscreen);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    // Tauri window fullscreen (the product button path) does NOT fire the DOM
    // `fullscreenchange` event — the document element never goes fullscreen.
    // The backend emits `zan-fullscreen` right after `set_fullscreen`, so the
    // chrome (top strip, sidebar) mirrors the same hide-on-fullscreen state
    // before the macOS Space transition settles.
    let unlistenWindowFullscreen: (() => void) | null = null;
    if (isTauri()) {
      void listen<boolean>(WINDOW_FULLSCREEN_EVENT, (event) => {
        const isFullscreen = !!event.payload;
        setIsFullscreenUi(isFullscreen);
        setSidebarVisible(!isFullscreen);
      }).then((fn) => {
        unlistenWindowFullscreen = fn;
      });
    }

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      unlistenWindowFullscreen?.();
    };
  }, [setSidebarVisible]);

  // Setup Tauri drag-and-drop listeners
  useEffect(() => {
    if (!isTauri()) return;

    let unlistenEnter: (() => void) | null = null;
    let unlistenOver: (() => void) | null = null;
    let unlistenDrop: (() => void) | null = null;
    let unlistenLeave: (() => void) | null = null;

    const setupListeners = async () => {
      unlistenEnter = await listen('tauri://drag-enter', () => {
        setIsDragging(true);
      });

      unlistenOver = await listen('tauri://drag-over', () => {
        setIsDragging(true);
      });

      unlistenDrop = await listen('tauri://drag-drop', (event: any) => {
        setIsDragging(false);
        const paths: string[] = event.payload.paths || event.payload || [];
        if (paths.length > 0) {
          handleDroppedFiles(paths);
        }
      });

      unlistenLeave = await listen('tauri://drag-leave', () => {
        setIsDragging(false);
      });
    };

    setupListeners();

    return () => {
      unlistenEnter?.();
      unlistenOver?.();
      unlistenDrop?.();
      unlistenLeave?.();
    };
  }, [handleDroppedFiles]);

  // Fallback for web browser (non-Tauri) using HTML5 drag-and-drop
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!isTauri()) {
      setIsDragging(true);
    }
  }, []);

  /** PROGRAMMATIC top-bar drag (the ONLY drag path — see the header comment on
   *  why neither `-webkit-app-region` nor `data-tauri-drag-region` can work
   *  while the app is focused). Only the strip surface triggers it; interactive
   *  children (hamburger button) and right/middle clicks are excluded so clicks
   *  keep working while chrome space drags the window. */
  const handleTopBarMouseDown = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (e.button !== 0) {
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, [data-no-drag]')) {
      return;
    }
    e.preventDefault();
    void TauriService.startWindowDrag();
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!isTauri()) {
      setIsDragging(false);
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    if (!isTauri() && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      // Classification is strictly extension-driven. Browser/OS MIME types are
      // unreliable (an MKV drop can arrive labeled audio, or empty), so the
      // supported-container catalog is the single source of truth.
      if (isMediaFile(file.name)) {
        resetSubtitles(); // Wipe out subtitles from the previous video
        setCurrentVideo(file);
        const url = URL.createObjectURL(file);
        setCurrentVideoUrl(url);
        setCurrentVideoPath(null);
      } else if (isParsableSubtitleFile(file.name)) {
        // Handle subtitle file
        const reader = new FileReader();
        reader.onload = (event) => {
          const text = event.target?.result as string;
          let cues: any[] = [];
          if (file.name.toLowerCase().endsWith('.srt')) {
            cues = parseSRT(text);
          } else {
            cues = parseVTT(text);
          }
          if (cues.length > 0) {
            const track = {
              id: crypto.randomUUID(),
              name: file.name,
              language: 'Unknown',
              cues
            };
            setSubtitleTracks([track]);
            setActiveSubtitleTrackId(track.id);
          }
        };
        reader.readAsText(file);
      }
    }
  }, [setCurrentVideo, setCurrentVideoUrl, setCurrentVideoPath, resetSubtitles, setSubtitleTracks, setActiveSubtitleTrackId]);

  return (
    <div 
      ref={containerRef}
      className={`flex flex-col w-screen h-screen overflow-hidden ${
        theme === 'dark' ? 'text-white' : 'text-gray-900'
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Solid top bar — replaces the native macOS title bar (window is
          `titleBarStyle: Overlay` + `transparent`, so the traffic lights float
          over this strip). Chrome must paint its own opaque background here —
          otherwise the transparent window leaks the desktop behind the
          native title bar area. On macOS the strip clears the traffic-light
          group (~76px) so the sidebar toggle icon never crowds the native
          window controls. Hidden in web fullscreen. The strip + its `flex-1`
          spacer are the drag surface (`onMouseDown` → `startWindowDrag`). */}
      {isTauri() && !isFullscreenUi && (
        <div
          onMouseDown={handleTopBarMouseDown}
          className={`z-40 flex h-10 w-full shrink-0 items-center border-b ${
            isMacOs() ? "pl-[76px]" : "pl-2"
          } pr-2 ${
            theme === 'dark' ? 'bg-zan-black border-white/10' : 'bg-white border-gray-200'
          }`}
        >
          {!sidebarVisible && (
            <button
              onClick={() => setSidebarVisible(true)}
              aria-label="Open sidebar"
              title="Open sidebar"
              className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                theme === 'dark' ? 'hover:bg-white/10 text-white' : 'hover:bg-gray-100 text-gray-900'
              }`}
            >
              <Menu className="h-4 w-4" />
            </button>
          )}
          <div className="flex-1" />
        </div>
      )}

      {/* Drag & Drop Overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-zan-cyan/10 border-4 border-dashed border-zan-cyan flex items-center justify-center">
          <div className="text-center text-white">
            <FileVideo className="w-16 h-16 mx-auto mb-4" />
            <p className="text-2xl font-semibold">Drop video or subtitle file</p>
          </div>
        </div>
      )}

      {/* Touch-device sidebar backdrop: dims the video behind the DRAWER only.
          On desktop this never renders — the sidebar is always inline there,
          so a narrow window must not blur/dim the stage behind it. `md:hidden`
          drops it for a rotated phone/tablet that upgraded to inline. */}
      {sidebarVisible && isMobileDevice() && (
        <div
          className="absolute inset-0 z-30 bg-black/45 backdrop-blur-[2px] md:hidden"
          onClick={() => setSidebarVisible(false)}
          aria-hidden="true"
        />
      )}

      {/* Content row — sidebar + main stage, below the top bar. The sidebar
          paints its own opaque theme background; the main stage is transparent
          so the native VLC surface (behind the webview) shows through.
          `isolate` makes the row an airtight stacking context of its own: the
          sidebar (z-40) and `data-player-viewport` (z-0) are then guaranteed
          siblings whose internal paints can never bleed across each other. */}
      <div data-content-row className="relative isolate flex min-h-0 flex-1 overflow-hidden">
        {sidebarVisible && <Sidebar />}
        {/* `data-player-viewport`: the canonical PlayerViewport region. App
            shell layout owns it — the sidebar is a flex SIBLING (`z-40`), so
            this column's box slides with the sidebar edge in the same commit:
            open -> X/width shrink, closed -> the column fills the row. The
            Player consumes this box VERBATIM for the native surface
            (`vlc_set_layout`) and renders every overlay (subtitles, controls,
            OSD) inside it; it never re-derives or clamps against sidebar
            geometry. `overflow-clip` physically prevents the HTML5 fallback
            box and the DOM overlays from painting outside the viewport.
            `z-0` forces this column into its OWN stacking context: the player's
            high-z DOM (controls bar z-40, quick settings z-50, subtitles z-30)
            is then trapped BELOW the sidebar (z-40) instead of being promoted
            into the row and painted over it. */}
        <div data-player-viewport className="relative z-0 min-h-0 min-w-0 flex-1 overflow-clip">
          {!isTauri() && canInstall && (
            <button
              onClick={() => void promptInstall()}
              aria-label="Install app"
              title="Install ZanPlayer Lite on this device"
              className={`absolute right-4 pwa-safe-top z-40 flex h-10 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition-colors ${
                theme === 'dark'
                  ? 'border-white/10 bg-zan-black/90 text-white shadow-xl shadow-black/20 hover:bg-zan-deep'
                  : 'border-gray-200 bg-white/95 text-gray-900 shadow-xl shadow-gray-300/30 hover:bg-gray-100'
              }`}
            >
              <Download className="h-4 w-4" />
              Install app
            </button>
          )}
          {!isTauri() && !sidebarVisible && (
            <button
              onClick={() => setSidebarVisible(true)}
              aria-label="Open sidebar"
              title="Open sidebar"
              className={`absolute left-4 pwa-safe-top z-40 flex h-10 w-10 items-center justify-center rounded-xl border transition-colors ${
                theme === 'dark'
                  ? 'border-white/10 bg-zan-black/90 text-white shadow-xl shadow-black/20 hover:bg-zan-deep'
                  : 'border-gray-200 bg-white/95 text-gray-900 shadow-xl shadow-gray-300/30 hover:bg-gray-100'
              }`}
            >
              <Menu className="h-5 w-5" />
            </button>
          )}
          <VideoPlayer onEditSubtitles={() => setEditorOpen(true)} />
        </div>
      </div>
      {editorOpen && <SubtitleEditor onClose={() => setEditorOpen(false)} />}
      <UpdateModal />
    </div>
  );
}

export default App;
