import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import * as dialog from '@tauri-apps/plugin-dialog';
import * as fs from '@tauri-apps/plugin-fs';
import { Store } from '@tauri-apps/plugin-store';
import { openPath } from '@tauri-apps/plugin-opener';
import { appLogDir, join } from '@tauri-apps/api/path';
import { debug as logDebug, info as logInfo, warn as logWarn, error as logError } from '@tauri-apps/plugin-log';

// Store instance for Tauri
let store: Store | null = null;
async function getStore() {
    if (!store) {
        store = await Store.load('.settings.dat');
    }
    return store;
}

// Window sync state for macOS hole punch
type UnlistenFn = () => void;
let windowSyncListeners: { move?: UnlistenFn; resize?: UnlistenFn; focus?: UnlistenFn } = {};
let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Initialize window position syncing for macOS hole punch mode.
 * This keeps the MPV window positioned behind the Tauri window.
 * Only runs on macOS - Windows uses embedded MPV so no sync needed.
 */
export async function initWindowSync() {
    // Only enable on macOS - Windows uses embedded mode
    const isMacOS = navigator.platform.toLowerCase().includes('mac');
    if (!isMacOS) {
        console.log('[WindowSync] Not macOS, skipping window sync');
        return;
    }

    console.log('[WindowSync] Initializing macOS window sync for MPV hole punch');

    const appWindow = getCurrentWindow();

    // Debounced sync function to avoid excessive IPC calls
    const debouncedSync = () => {
        if (syncDebounceTimer) {
            clearTimeout(syncDebounceTimer);
        }
        syncDebounceTimer = setTimeout(() => {
            console.log('[WindowSync] Syncing MPV window position');
            invoke('mpv_sync_window').catch(err => {
                console.error('[WindowSync] Failed to sync window:', err);
            });
        }, 150); // 150ms debounce
    };

    // Listen for window move events
    try {
        windowSyncListeners.move = await appWindow.onMoved(debouncedSync);
        console.log('[WindowSync] Move listener attached');
    } catch (e) {
        console.error('[WindowSync] Failed to attach move listener:', e);
    }

    // Listen for window resize events
    try {
        windowSyncListeners.resize = await appWindow.onResized(debouncedSync);
        console.log('[WindowSync] Resize listener attached');
    } catch (e) {
        console.error('[WindowSync] Failed to attach resize listener:', e);
    }

    // Listen for focus changes to re-assert window ordering
    try {
        windowSyncListeners.focus = await appWindow.onFocusChanged(({ payload: focused }) => {
            if (focused) {
                console.log('[WindowSync] Window focused, re-syncing MPV');
                // Small delay to let macOS settle window ordering
                setTimeout(() => {
                    invoke('mpv_sync_window').catch(err => {
                        console.error('[WindowSync] Failed to sync on focus:', err);
                    });
                }, 50);
            }
        });
        console.log('[WindowSync] Focus listener attached');
    } catch (e) {
        console.error('[WindowSync] Failed to attach focus listener:', e);
    }
}

/**
 * Stop window sync listeners
 */
export function stopWindowSync() {
    console.log('[WindowSync] Stopping window sync');
    if (windowSyncListeners.move) {
        windowSyncListeners.move();
        windowSyncListeners.move = undefined;
    }
    if (windowSyncListeners.resize) {
        windowSyncListeners.resize();
        windowSyncListeners.resize = undefined;
    }
    if (windowSyncListeners.focus) {
        windowSyncListeners.focus();
        windowSyncListeners.focus = undefined;
    }
    if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
    }
}

export const Bridge = {
    isTauri: true,

    // MPV Controls
    async initMpv() {
        const result = await invoke('init_mpv', { args: [] });
        // On macOS, also start window sync for hole punch mode
        const isMacOS = navigator.platform.toLowerCase().includes('mac');
        if (isMacOS) {
            await initWindowSync();
        }
        return result;
    },

    // Window sync for macOS hole punch mode
    async syncWindow() {
        const isMacOS = navigator.platform.toLowerCase().includes('mac');
        if (isMacOS) {
            return invoke('mpv_sync_window');
        }
    },

    async loadVideo(url: string) {
        try {
            await invoke('mpv_load', { url });
            return { success: true };
        } catch (e: any) {
            return { success: false, error: typeof e === 'string' ? e : e.message || 'Unknown error' };
        }
    },

    async play() {
        return invoke('mpv_play');
    },

    async pause() {
        return invoke('mpv_pause');
    },

    async resume() {
        return invoke('mpv_resume');
    },

    async stop() {
        return invoke('mpv_stop');
    },

    async setVolume(volume: number) {
        return invoke('mpv_set_volume', { volume: parseFloat(String(volume)) });
    },

    async seek(seconds: number) {
        return invoke('mpv_seek', { seconds: parseFloat(String(seconds)) });
    },

    async cycleSubtitle() {
        return invoke('mpv_cycle_sub');
    },

    async cycleAudio() {
        return invoke('mpv_cycle_audio');
    },

    async toggleMute() {
        return invoke('mpv_toggle_mute');
    },

    async toggleStats() {
        return invoke('mpv_toggle_stats');
    },

    async toggleFullscreen() {
        return invoke('mpv_toggle_fullscreen');
    },

    async getTrackList(): Promise<any[]> {
        const result = await invoke('mpv_get_track_list');
        return result as any[] || [];
    },

    async setAudioTrack(id: number) {
        return invoke('mpv_set_audio', { id });
    },

    async setSubtitleTrack(id: number) {
        return invoke('mpv_set_subtitle', { id });
    },

    async setProperty(name: string, value: any) {
        return invoke('mpv_set_property', { name, value });
    },

    async getProperty(name: string): Promise<any> {
        return invoke('mpv_get_property', { name });
    },

    // Window Controls
    async minimize() {
        console.log('[Bridge] minimize called');
        const appWindow = getCurrentWindow();
        return appWindow.minimize();
    },

    async toggleMaximize() {
        console.log('[Bridge] toggleMaximize called');
        const appWindow = getCurrentWindow();
        const isMaximized = await appWindow.isMaximized();
        if (isMaximized) {
            return appWindow.unmaximize();
        } else {
            return appWindow.maximize();
        }
    },

    async close() {
        console.log('[Bridge] close called');
        const appWindow = getCurrentWindow();
        return appWindow.close();
    },

    async startDragging() {
        const appWindow = getCurrentWindow();
        return appWindow.startDragging();
    },

    // File System (Import/Export)
    async saveJsonFile(content: string, defaultName: string) {
        const path = await dialog.save({
            defaultPath: defaultName,
            filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (!path) return { canceled: true };
        await fs.writeTextFile(path, content);
        return { success: true, data: { filePath: path } };
    },

    async importM3UFile() {
        const path = await dialog.open({
            multiple: false,
            filters: [{ name: 'M3U Playlist', extensions: ['m3u', 'm3u8'] }]
        });
        if (!path) return { canceled: true };
        const content = await fs.readTextFile(path as string);
        // Extract filename from path for default name
        const fileName = (path as string).split(/[\\/]/).pop()?.replace(/\.m3u8?$/i, '') || 'Imported Playlist';
        return { success: true, data: { content, fileName } };
    },

    async openJsonFile() {
        const path = await dialog.open({
            multiple: false,
            filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (!path) return { canceled: true };
        const content = await fs.readTextFile(path as string);
        return { success: true, data: content };
    },
    // Storage Methods (Polyfill)
    async getSources() {
        const s = await getStore();
        const sources = await s.get('sources');
        return { success: true, data: sources || [] };
    },

    async saveSource(source: any) {
        const s = await getStore();
        let sources: any[] = (await s.get('sources')) || [];
        // Update or Add
        const index = sources.findIndex((src: any) => src.id === source.id);
        if (index >= 0) {
            sources[index] = source;
        } else {
            sources.push(source);
        }
        await s.set('sources', sources);
        await s.save();
        return { success: true };
    },

    async deleteSource(id: string) {
        const s = await getStore();
        let sources: any[] = (await s.get('sources')) || [];
        sources = sources.filter((src: any) => src.id !== id);
        await s.set('sources', sources);
        await s.save();
        return { success: true };
    },

    async getSettings() {
        const s = await getStore();
        const settings = await s.get('settings');
        return { success: true, data: settings || {} };
    },

    async updateSettings(newSettings: any) {
        const s = await getStore();
        const current = (await s.get('settings')) || {};
        const updated = { ...current as object, ...newSettings };
        await s.set('settings', updated);
        await s.save();
        return { success: true };
    },

    async getSource(id: string) {
        const s = await getStore();
        const sources: any[] = (await s.get('sources')) || [];
        const source = sources.find((src: any) => src.id === id);
        return { success: true, data: source };
    }
};

export async function initPolyfills() {
    if ((window as any).__polyfillsInitialized) return;
    (window as any).__polyfillsInitialized = true;

    // Polyfill window.storage for Tauri environment
    console.log('[TauriBridge] Initializing Storage Polyfill');
    (window as any).storage = {
        getSources: Bridge.getSources,
        saveSource: Bridge.saveSource,
        deleteSource: Bridge.deleteSource,
        getSettings: Bridge.getSettings,
        updateSettings: Bridge.updateSettings,
        getSource: Bridge.getSource,
        saveJsonFile: Bridge.saveJsonFile,
        openJsonFile: Bridge.openJsonFile,
        importM3UFile: Bridge.importM3UFile,
        isEncryptionAvailable: () => Promise.resolve({ success: true, data: true })
    };

    // Polyfill window.debug with actual file logging
    console.log('[TauriBridge] Initializing Debug Polyfill with file logging');
    const existingDebug = (window as any).debug || {};
    
    // Check if debug logging is enabled from settings
    let debugLoggingEnabled = false;
    try {
        const store = await getStore();
        debugLoggingEnabled = await store.get('debugLoggingEnabled') ?? false;
        console.log('[TauriBridge] Debug logging enabled:', debugLoggingEnabled);
    } catch (e) {
        console.warn('[TauriBridge] Failed to read debug logging setting:', e);
    }
    
    // Set global flag for sync debug logs
    (window as any).__debugLoggingEnabled = debugLoggingEnabled;
    
    (window as any).debug = {
        ...existingDebug,
        logFromRenderer: async (msg: string) => {
            // Only log if debug logging is enabled
            if (!debugLoggingEnabled) {
                return;
            }
            // Log to both console and file
            console.log('[Renderer]', msg);
            await logDebug(msg);
        },
        // Method to update debug logging state
        setDebugLoggingEnabled: (enabled: boolean) => {
            debugLoggingEnabled = enabled;
            (window as any).__debugLoggingEnabled = enabled;
            console.log('[TauriBridge] Debug logging state updated:', enabled);
        },
        getLogPath: async () => {
            try {
                const logDir = await appLogDir();
                // Log files are named with timestamp pattern: ynotv_YYYY-MM-DD.log
                const today = new Date().toISOString().split('T')[0];
                const logPath = await join(logDir, `ynotv_${today}.log`);
                return { data: logPath };
            } catch (e) {
                console.warn('Failed to get log dir:', e);
                return { data: 'logs\\ynotv.log' };
            }
        },
        openLogFolder: async () => {
            console.log('[Bridge] openLogFolder called');
            try {
                await invoke('open_log_folder');
            } catch (e) {
                console.error('Failed to open log folder:', e);
            }
        }
    };
    console.log('[TauriBridge] Debug Polyfill initialized with file logging. getLogPath type:', typeof (window as any).debug.getLogPath);

    // Polyfill window.mpv
    console.log('[TauriBridge] Initializing MPV Polyfill');
    (window as any).mpv = {
        init: Bridge.initMpv,
        load: Bridge.loadVideo,
        pause: Bridge.pause,
        resume: Bridge.resume,
        stop: Bridge.stop,
        seek: Bridge.seek,
        setVolume: Bridge.setVolume,
        cycleAudio: Bridge.cycleAudio,
        cycleSubtitle: Bridge.cycleSubtitle,
        toggleMute: Bridge.toggleMute,
        toggleStats: Bridge.toggleStats,
        toggleFullscreen: Bridge.toggleFullscreen,
        getTrackList: Bridge.getTrackList,
        setAudioTrack: Bridge.setAudioTrack,
        setSubtitleTrack: Bridge.setSubtitleTrack,
        destroy: () => { },
        setProperty: Bridge.setProperty,
        getProperty: Bridge.getProperty,
        onError: (cb: any) => console.log('[MPV] onError listener added'),
        removeAllListeners: () => console.log('[MPV] removeAllListeners called'),
        on: (event: string, handler: any) => console.log(`[MPV] Added listener for ${event}`),
        off: (event: string, handler: any) => console.log(`[MPV] Removed listener for ${event}`),
        getDuration: () => 0,
        getPosition: () => 0,
        getVolume: () => 100,
        getMuted: () => false,
        getPaused: () => false
    };
}

// Auto-initialize if side-effects are preserved, but export allows forcing it
initPolyfills().catch(err => console.error('[TauriBridge] Failed to initialize polyfills:', err));

console.log('[TauriBridge] Polyfill complete, window.storage:', (window as any).storage);

import { fetch } from '@tauri-apps/plugin-http';

// Polyfill window.fetchProxy
console.log('[TauriBridge] Initializing fetchProxy Polyfill');
(window as any).fetchProxy = {
    fetch: async (url: string, options: any) => {
        try {
            const response = await fetch(url, options);
            const text = await response.text();
            return {
                data: {
                    ok: response.ok,
                    status: response.status,
                    statusText: response.statusText,
                    text: text,
                    json: async () => JSON.parse(text)
                }
            };
        } catch (e: any) {
            console.error('[fetchProxy] fetch failed:', e);
            return { error: e.message };
        }
    },
    fetchBinary: async (url: string) => {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const buffer = await response.arrayBuffer();
            return {
                data: new Uint8Array(buffer),
                success: true
            };
        } catch (e: any) {
            console.error('[fetchProxy] fetchBinary failed:', e);
            return { error: e.message, success: false };
        }
    }
};
