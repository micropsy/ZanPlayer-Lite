import { useAppStore } from './services/store';
import { Sidebar } from './components/Sidebar';
import { VideoPlayer } from './components/VideoPlayer';
import { SubtitleEditor } from './components/SubtitleEditor';
import { useEffect, useRef, useState, useCallback } from 'react';
import { Menu, FileVideo } from 'lucide-react';
import { listen, emit } from '@tauri-apps/api/event';
import { TauriService, isTauri } from './services/tauri';
import { checkForUpdates } from './services/updater';
import { UpdateModal } from './components/UpdateModal';

// Helper functions to check file types
const isVideoFile = (fileName: string): boolean => {
  const ext = fileName.toLowerCase().split('.').pop();
  return ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'webm', 'm4v'].includes(ext || '');
};

const isAudioFile = (fileName: string): boolean => {
  const ext = fileName.toLowerCase().split('.').pop();
  return ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma'].includes(ext || '');
};

const isSubtitleFile = (fileName: string): boolean => {
  const ext = fileName.toLowerCase().split('.').pop();
  return ['srt', 'vtt', 'ass', 'ssa'].includes(ext || '');
};

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
      setSidebarVisible(!isFullscreen);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
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
      if (file.type.startsWith('video/') || file.type.startsWith('audio/')) {
        resetSubtitles(); // Wipe out subtitles from the previous video
        setCurrentVideo(file);
        const url = URL.createObjectURL(file);
        setCurrentVideoUrl(url);
        setCurrentVideoPath(null);
      } else if (file.name.endsWith('.srt') || file.name.endsWith('.vtt')) {
        // Handle subtitle file
        const reader = new FileReader();
        reader.onload = (event) => {
          const text = event.target?.result as string;
          let cues: any[] = [];
          if (file.name.endsWith('.srt')) {
            cues = parseSRT(text);
          } else if (file.name.endsWith('.vtt')) {
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
      className={`flex w-screen h-screen overflow-hidden ${
        theme === 'dark' ? 'bg-zan-black text-white' : 'bg-gray-50 text-gray-900'
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Drag & Drop Overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-zan-cyan/10 border-4 border-dashed border-zan-cyan flex items-center justify-center">
          <div className="text-center text-white">
            <FileVideo className="w-16 h-16 mx-auto mb-4" />
            <p className="text-2xl font-semibold">Drop video or subtitle file</p>
          </div>
        </div>
      )}

      {sidebarVisible && <Sidebar />}
      <div className="flex-1 relative">
        {!sidebarVisible && (
          <button
            onClick={() => setSidebarVisible(true)}
            className={`absolute top-4 left-4 z-40 p-2 rounded-lg ${
              theme === 'dark'
                ? 'bg-zan-black/80 hover:bg-zan-deep text-white'
                : 'bg-white hover:bg-gray-100 text-gray-900'
            } shadow-lg`}
          >
            <Menu className="w-6 h-6" />
          </button>
        )}
        <VideoPlayer onEditSubtitles={() => setEditorOpen(true)} />
      </div>
      {editorOpen && <SubtitleEditor onClose={() => setEditorOpen(false)} />}
      <UpdateModal />
    </div>
  );
}

export default App;
