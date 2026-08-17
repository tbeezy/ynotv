import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import i18n, { translateNativeError } from '../i18n';
import { useSettingsStore } from './settingsStore';

export interface DownloadItem {
  id: string;
  title: string;
  url: string;
  savePath: string;
  status: 'downloading' | 'queued' | 'completed' | 'failed' | 'canceled' | 'paused';
  progress: number;
  bytesWritten: number;
  totalBytes: number | null;
  speedBytes: number;
  error?: string;
  statusText?: string;
  addedAt: number;
  userAgent?: string;
  durationSecs?: number;
  poster?: string;
  watchProgressSeconds?: number;
  sourceId?: string;
  directUrl?: string;
  extractSubtitles?: boolean;
}

export interface PendingStalkerDownload {
  title: string;
  url: string;
  userAgent?: string;
  durationSecs?: number;
  preResolvedSavePath?: string;
  poster?: string;
  sourceId?: string;
  directUrl?: string;
  category?: 'Movies' | 'Series';
}

interface DownloadState {
  downloads: DownloadItem[];
  pendingStalkerDownload: PendingStalkerDownload | null;
  startDownload: (
    title: string,
    url: string,
    userAgent?: string,
    durationSecs?: number,
    preResolvedSavePath?: string,
    poster?: string,
    sourceId?: string,
    directUrl?: string,
    extractSubtitles?: boolean,
    category?: 'Movies' | 'Series'
  ) => Promise<void>;
  confirmStalkerDownload: (extractSubtitles: boolean) => Promise<void>;
  cancelStalkerDownload: () => void;
  cancelDownload: (id: string) => Promise<void>;
  pauseDownload: (id: string) => Promise<void>;
  resumeDownload: (id: string) => Promise<void>;
  removeDownload: (id: string) => void;
  clearCompleted: () => void;
  processQueue: () => Promise<void>;
  updateDownloadProgress: (payload: {
    id: string;
    title: string;
    status: 'downloading' | 'completed' | 'failed' | 'canceled' | 'paused';
    progress: number;
    bytes_written: number;
    total_bytes: number | null;
    speed_bytes: number;
    file_path: string;
    error: string | null;
    status_text?: string | null;
  }) => void;
  saveDownloadProgress: (
    savePath: string,
    progressSeconds: number,
    durationSecs?: number
  ) => void;
}

export const useDownloadStore = create<DownloadState>()(
  persist(
    (set, get) => ({
      downloads: [],
      pendingStalkerDownload: null,

      confirmStalkerDownload: async (extractSubtitles: boolean) => {
        const pending = get().pendingStalkerDownload;
        if (!pending) return;
        set({ pendingStalkerDownload: null });
        await get().startDownload(
          pending.title,
          pending.url,
          pending.userAgent,
          pending.durationSecs,
          pending.preResolvedSavePath,
          pending.poster,
          pending.sourceId,
          pending.directUrl,
          extractSubtitles,
          pending.category
        );
      },

      cancelStalkerDownload: () => {
        set({ pendingStalkerDownload: null });
      },

      startDownload: async (title, url, userAgent, durationSecs, preResolvedSavePath, poster, sourceId, directUrl, extractSubtitles, category) => {
        const isStalker = (directUrl && (directUrl.startsWith('stalker_') || directUrl.startsWith('stalker'))) ||
                          (url && (url.startsWith('stalker_') || url.includes('stalker')));

        if (isStalker && extractSubtitles === undefined) {
          set({
            pendingStalkerDownload: {
              title,
              url,
              userAgent,
              durationSecs,
              preResolvedSavePath,
              poster,
              sourceId,
              directUrl,
              category,
            }
          });
          return;
        }

        try {
          // 1. Resolve save path
          let savePath = '';
          if (preResolvedSavePath) {
            savePath = preResolvedSavePath;
          } else {
            const { downloadsPath, separateDownloadFolders } = useSettingsStore.getState();

            const isHls = url.includes('.m3u8') || url.includes('/mono.m3u8');
            const ext = isHls ? 'mkv' : 'mp4';
            const sanitizedTitle = title.replace(/[<>:"/\\|?*]/g, '_').substring(0, 50);

            if (downloadsPath) {
              const separator = downloadsPath.includes('\\') ? '\\' : '/';
              let targetDir = downloadsPath;
              if (targetDir.endsWith(separator)) {
                targetDir = targetDir.slice(0, -1);
              }

              if (separateDownloadFolders !== false) {
                let subfolder = 'Movies';
                if (category) {
                  subfolder = category === 'Series' ? 'Series' : 'Movies';
                } else if (title.match(/ - S\d+E\d+/i)) {
                  subfolder = 'Series';
                }

                const lowerTarget = targetDir.toLowerCase();
                const lowerSub = subfolder.toLowerCase();
                if (
                  !lowerTarget.endsWith(separator + lowerSub) &&
                  !lowerTarget.endsWith('/' + lowerSub) &&
                  !lowerTarget.endsWith('\\' + lowerSub)
                ) {
                  targetDir = `${targetDir}${separator}${subfolder}`;
                }
              }

              savePath = `${targetDir}${separator}${sanitizedTitle}.${ext}`;
            } else {
              // Prompt save dialog
              const selected = await save({
                defaultPath: `${sanitizedTitle}.${ext}`,
                filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'ts'] }]
              });
              if (!selected) return; // Canceled
              savePath = selected;
            }
          }

          // 2. Generate unique ID
          const id = `dl_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

          // 3. Determine status: queue it if there is already a download in progress
          const active = (get().downloads || []).some((d) => d.status === 'downloading');
          const status = active ? 'queued' : 'downloading';

          const newItem: DownloadItem = {
            id,
            title,
            url,
            savePath,
            status,
            progress: 0,
            bytesWritten: 0,
            totalBytes: null,
            speedBytes: 0,
            addedAt: Date.now(),
            userAgent,
            durationSecs,
            poster,
            sourceId,
            directUrl,
            extractSubtitles: extractSubtitles ?? true,
          };

          set((state) => ({ downloads: [newItem, ...(state.downloads || [])] }));

          // 4. If no active download is running, invoke Rust backend immediately
          if (!active) {
            await invoke('download_media', {
              request: {
                id,
                title,
                url,
                save_path: savePath,
                user_agent: userAgent || null,
                duration_secs: durationSecs || null,
                resume: false,
                extract_subtitles: extractSubtitles ?? true,
              }
            });
          }
        } catch (error: any) {
          console.error('[DownloadStore] Failed to start download:', error);
          alert(`${i18n.t('common:failedToStartDownload')}: ${translateNativeError(error?.message) || error}`);
        }
      },

      cancelDownload: async (id) => {
        try {
          const list = get().downloads || [];
          const item = list.find((d) => d.id === id);
          if (!item) return;

          if (item.status === 'queued') {
            // Cancel directly in frontend and process queue
            set((state) => ({
              downloads: (state.downloads || []).map((d) =>
                d.id === id ? { ...d, status: 'canceled' as const } : d
              ),
            }));
            get().processQueue();
          } else if (item.status === 'paused') {
            // Call delete_download_file to clean up the partial files
            try {
              await invoke('delete_download_file', { path: item.savePath });
            } catch (err) {
              console.warn('[DownloadStore] Failed to delete file for paused download:', err);
            }
            set((state) => ({
              downloads: (state.downloads || []).map((d) =>
                d.id === id ? { ...d, status: 'canceled' as const } : d
              ),
            }));
            get().processQueue();
          } else {
            try {
              await invoke('cancel_download', { id });
            } catch (invokeError) {
              console.warn('[DownloadStore] Backend cancel failed, forcing local cancel:', invokeError);
              // Force update frontend state to canceled since the backend has no record of it
              set((state) => ({
                downloads: (state.downloads || []).map((d) =>
                  d.id === id ? { ...d, status: 'canceled' as const } : d
                ),
              }));
              get().processQueue();
            }
          }
        } catch (error) {
          console.error('[DownloadStore] Failed to cancel download:', error);
        }
      },

      pauseDownload: async (id) => {
        try {
          const list = get().downloads || [];
          const item = list.find((d) => d.id === id);
          if (!item) return;

          if (item.status === 'queued') {
            // Queue state can be paused directly in frontend
            set((state) => ({
              downloads: (state.downloads || []).map((d) =>
                d.id === id ? { ...d, status: 'paused' as const } : d
              ),
            }));
            get().processQueue();
          } else if (item.status === 'downloading') {
            try {
              await invoke('pause_download', { id });
            } catch (invokeError) {
              console.warn('[DownloadStore] Backend pause failed, forcing local pause:', invokeError);
              set((state) => ({
                downloads: (state.downloads || []).map((d) =>
                  d.id === id ? { ...d, status: 'paused' as const } : d
                ),
              }));
              get().processQueue();
            }
          }
        } catch (error) {
          console.error('[DownloadStore] Failed to pause download:', error);
        }
      },

      resumeDownload: async (id) => {
        try {
          const list = get().downloads || [];
          const item = list.find((d) => d.id === id);
          if (!item) return;

          if (item.status === 'paused') {
            set((state) => ({
              downloads: (state.downloads || []).map((d) =>
                d.id === id ? { ...d, status: 'queued' as const } : d
              ),
            }));
            setTimeout(() => {
              get().processQueue();
            }, 50);
          }
        } catch (error) {
          console.error('[DownloadStore] Failed to resume download:', error);
        }
      },

      removeDownload: (id) => {
        set((state) => ({
          downloads: (state.downloads || []).filter((d) => d.id !== id),
        }));
      },

      clearCompleted: () => {
        set((state) => ({
          downloads: (state.downloads || []).filter(
            (d) => d.status === 'downloading' || d.status === 'queued'
          ),
        }));
      },

      processQueue: async () => {
        const list = get().downloads || [];
        // Check if there is an active downloading item
        const hasActive = list.some((d) => d.status === 'downloading');
        if (hasActive) return;

        // Find the oldest queued item (at the end of the list since we prepend new items)
        const nextItem = [...list]
          .reverse()
          .find((d) => d.status === 'queued');

        if (nextItem) {
          let downloadUrl = nextItem.url;
          let userAgent = nextItem.userAgent;

          // Re-resolve stream URL before downloading if sourceId/directUrl are present
          if (nextItem.sourceId && nextItem.directUrl) {
            try {
              const { resolvePlayUrl } = await import('../services/stream-resolver');
              const resolved = await resolvePlayUrl(nextItem.sourceId, nextItem.directUrl);
              downloadUrl = resolved.url;
              if (resolved.userAgent) {
                userAgent = resolved.userAgent;
              }
              console.log('[DownloadStore] Re-resolved URL for queued download:', nextItem.title, '->', downloadUrl);
            } catch (err) {
              console.warn('[DownloadStore] Failed to re-resolve URL before downloading, using original URL:', err);
            }
          }

          set((state) => ({
            downloads: (state.downloads || []).map((d) =>
              d.id === nextItem.id ? { ...d, status: 'downloading' as const, url: downloadUrl, userAgent } : d
            ),
          }));

          try {
            await invoke('download_media', {
              request: {
                id: nextItem.id,
                title: nextItem.title,
                url: downloadUrl,
                save_path: nextItem.savePath,
                user_agent: userAgent || null,
                duration_secs: nextItem.durationSecs || null,
                resume: nextItem.progress > 0,
                extract_subtitles: nextItem.extractSubtitles ?? true,
              }
            });
          } catch (error: any) {
            console.error('[DownloadStore] Failed to start queued download:', error);
            set((state) => ({
              downloads: (state.downloads || []).map((d) =>
                d.id === nextItem.id
                  ? {
                      ...d,
                      status: 'failed' as const,
                      error: translateNativeError(error?.message) || String(error),
                    }
                  : d
              ),
            }));
            // Automatically process the next one
            setTimeout(() => {
              get().processQueue();
            }, 100);
          }
        }
      },

      updateDownloadProgress: (payload) => {
        set((state) => {
          const list = state.downloads || [];
          const idx = list.findIndex((d) => d.id === payload.id);
          if (idx === -1) return state;

          const updated = [...list];
          updated[idx] = {
            ...updated[idx],
            status: payload.status,
            progress: payload.progress,
            bytesWritten: payload.bytes_written,
            totalBytes: payload.total_bytes,
            speedBytes: payload.speed_bytes,
            error: payload.error || undefined,
            statusText: payload.status_text || undefined,
          };

          return { downloads: updated };
        });

        // Trigger queue processing if the current item completed/failed/canceled/paused
        if (
          payload.status === 'completed' ||
          payload.status === 'failed' ||
          payload.status === 'canceled' ||
          payload.status === 'paused'
        ) {
          get().processQueue();
        }
      },

      saveDownloadProgress: (savePath, progressSeconds, durationSecs) => {
        const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^file:\/\/\/?/, '').toLowerCase();
        const normSavePath = normalize(savePath);

        set((state) => {
          const list = state.downloads || [];
          const idx = list.findIndex((d) => normalize(d.savePath) === normSavePath);
          if (idx === -1) return state;

          const updated = [...list];
          updated[idx] = {
            ...updated[idx],
            watchProgressSeconds: progressSeconds,
          };
          if (durationSecs && durationSecs > 0) {
            updated[idx].durationSecs = durationSecs;
          }

          return { downloads: updated };
        });
      },
    }),
    {
      name: 'ynotv-media-downloads',
      partialize: (state) => ({ downloads: state.downloads }),
      onRehydrateStorage: () => (state) => {
        if (state && state.downloads) {
          const sanitized = state.downloads.map((d) => {
            if (d.status === 'downloading') {
              return {
                ...d,
                status: 'failed' as const,
                error: d.statusText ? `${i18n.t('common:interruptedPrefix')}: ${d.statusText}` : i18n.t('common:interruptedRestart'),
                statusText: undefined,
              };
            }
            return d;
          });
          useDownloadStore.setState({ downloads: sanitized });
        }
      },
    }
  )
);

// Subscribe to Tauri events immediately for background progress updates
listen<{
  id: string;
  title: string;
  status: 'downloading' | 'completed' | 'failed' | 'canceled' | 'paused';
  progress: number;
  bytes_written: number;
  total_bytes: number | null;
  speed_bytes: number;
  file_path: string;
  error: string | null;
  status_text?: string | null;
}>('download:event', (event) => {
  useDownloadStore.getState().updateDownloadProgress(event.payload);
}).catch((err) => {
  console.error('[DownloadStore] Failed to subscribe to Tauri download:event:', err);
});
