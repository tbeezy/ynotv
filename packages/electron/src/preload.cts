import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { Source } from '@sbtltv/core';

// Types for the exposed APIs
export interface MpvStatus {
  playing: boolean;
  volume: number;
  muted: boolean;
  position: number;
  duration: number;
}

export interface MpvResult {
  success?: boolean;
  error?: string;
}

export interface MpvApi {
  load: (url: string, options?: { userAgent?: string }) => Promise<MpvResult>;
  play: () => Promise<MpvResult>;
  pause: () => Promise<MpvResult>;
  togglePause: () => Promise<MpvResult>;
  stop: () => Promise<MpvResult>;
  setVolume: (volume: number) => Promise<MpvResult>;
  toggleMute: () => Promise<MpvResult>;
  seek: (seconds: number) => Promise<MpvResult>;
  getStatus: () => Promise<MpvStatus>;
  cycleSubtitle: () => Promise<MpvResult>;
  cycleAudio: () => Promise<MpvResult>;
  toggleStats: () => Promise<MpvResult>;
  setProperty: (name: string, value: unknown) => Promise<MpvResult>;
  onReady: (callback: (ready: boolean) => void) => void;
  onStatus: (callback: (status: MpvStatus) => void) => void;
  onError: (callback: (error: string) => void) => void;
  removeAllListeners: () => void;
}

export interface ElectronWindowApi {
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  getSize: () => Promise<[number, number]>;
  setSize: (width: number, height: number) => Promise<void>;
}

export interface StorageResult<T = void> {
  success?: boolean;
  error?: string;
  data?: T;
}

export interface AppSettings {
  theme: 'dark' | 'light';
  lastSourceId?: string;
}

export interface M3UImportResult {
  content: string;
  fileName: string;
}

export interface StorageApi {
  getSources: () => Promise<StorageResult<Source[]>>;
  getSource: (id: string) => Promise<StorageResult<Source | undefined>>;
  saveSource: (source: Source) => Promise<StorageResult>;
  deleteSource: (id: string) => Promise<StorageResult>;
  getSettings: () => Promise<StorageResult<AppSettings>>;
  updateSettings: (settings: Partial<AppSettings>) => Promise<StorageResult>;
  isEncryptionAvailable: () => Promise<StorageResult<boolean>>;
  importM3UFile: () => Promise<StorageResult<M3UImportResult> & { canceled?: boolean }>;
  saveJsonFile: (data: string, defaultName: string) => Promise<StorageResult<{ filePath: string }> & { canceled?: boolean }>;
  openJsonFile: () => Promise<StorageResult<{ data: string }> & { canceled?: boolean }>;
}

// Fetch proxy response
export interface FetchProxyResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
}

export interface FetchProxyApi {
  fetch: (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<StorageResult<FetchProxyResponse>>;
  fetchBinary: (url: string) => Promise<StorageResult<string>>; // Returns base64-encoded data
}

export interface DebugApi {
  getLogPath: () => Promise<StorageResult<string>>;
  logFromRenderer: (message: string) => Promise<StorageResult>;
  openLogFolder: () => Promise<StorageResult>;
}

// Expose window control API
contextBridge.exposeInMainWorld('electronWindow', {
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  getSize: () => ipcRenderer.invoke('window-get-size'),
  setSize: (width: number, height: number) => ipcRenderer.invoke('window-set-size', width, height),
} satisfies ElectronWindowApi);

// Expose mpv API to the renderer process
contextBridge.exposeInMainWorld('mpv', {
  // Control functions
  load: (url: string, options?: { userAgent?: string }) => ipcRenderer.invoke('mpv-load', url, options),
  play: () => ipcRenderer.invoke('mpv-play'),
  pause: () => ipcRenderer.invoke('mpv-pause'),
  togglePause: () => ipcRenderer.invoke('mpv-toggle-pause'),
  stop: () => ipcRenderer.invoke('mpv-stop'),
  setVolume: (volume: number) => ipcRenderer.invoke('mpv-volume', volume),
  toggleMute: () => ipcRenderer.invoke('mpv-toggle-mute'),
  seek: (seconds: number) => ipcRenderer.invoke('mpv-seek', seconds),
  getStatus: () => ipcRenderer.invoke('mpv-get-status'),
  cycleSubtitle: () => ipcRenderer.invoke('mpv-cycle-subtitle'),
  cycleAudio: () => ipcRenderer.invoke('mpv-cycle-audio'),
  toggleStats: () => ipcRenderer.invoke('mpv-toggle-stats'),
  setProperty: (name: string, value: unknown) => ipcRenderer.invoke('mpv-set-property', name, value),

  // Event listeners
  onReady: (callback: (ready: boolean) => void) => {
    ipcRenderer.on('mpv-ready', (_event: IpcRendererEvent, data: boolean) => callback(data));
  },
  onStatus: (callback: (status: MpvStatus) => void) => {
    ipcRenderer.on('mpv-status', (_event: IpcRendererEvent, data: MpvStatus) => callback(data));
  },
  onError: (callback: (error: string) => void) => {
    ipcRenderer.on('mpv-error', (_event: IpcRendererEvent, data: string) => callback(data));
  },

  // Cleanup
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('mpv-ready');
    ipcRenderer.removeAllListeners('mpv-status');
    ipcRenderer.removeAllListeners('mpv-error');
  },
} satisfies MpvApi);

// Expose storage API for sources and settings
contextBridge.exposeInMainWorld('storage', {
  getSources: () => ipcRenderer.invoke('storage-get-sources'),
  getSource: (id: string) => ipcRenderer.invoke('storage-get-source', id),
  saveSource: (source: Source) => ipcRenderer.invoke('storage-save-source', source),
  deleteSource: (id: string) => ipcRenderer.invoke('storage-delete-source', id),
  getSettings: () => ipcRenderer.invoke('storage-get-settings'),
  updateSettings: (settings: Partial<AppSettings>) => ipcRenderer.invoke('storage-update-settings', settings),
  isEncryptionAvailable: () => ipcRenderer.invoke('storage-is-encryption-available'),
  importM3UFile: () => ipcRenderer.invoke('import-m3u-file'),
  saveJsonFile: (data: string, defaultName: string) => ipcRenderer.invoke('dialog-save-json', data, defaultName),
  openJsonFile: () => ipcRenderer.invoke('dialog-open-json'),
} satisfies StorageApi);

// Expose fetch proxy API - bypasses CORS for API calls
contextBridge.exposeInMainWorld('fetchProxy', {
  fetch: (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) =>
    ipcRenderer.invoke('fetch-proxy', url, options),
  fetchBinary: (url: string) =>
    ipcRenderer.invoke('fetch-binary', url),
} satisfies FetchProxyApi);

// Expose platform info for conditional UI (e.g., resize grip on Windows only)
contextBridge.exposeInMainWorld('platform', {
  isWindows: process.platform === 'win32',
  isMac: process.platform === 'darwin',
  isLinux: process.platform === 'linux',
});

// Expose debug API for logging
contextBridge.exposeInMainWorld('debug', {
  getLogPath: () => ipcRenderer.invoke('debug-get-log-path'),
  logFromRenderer: (message: string) => ipcRenderer.invoke('debug-log-renderer', message),
  openLogFolder: () => ipcRenderer.invoke('debug-open-log-folder'),
} satisfies DebugApi);
