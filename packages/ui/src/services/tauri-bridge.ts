import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import * as dialog from '@tauri-apps/plugin-dialog';
import * as fs from '@tauri-apps/plugin-fs';
import { Store } from '@tauri-apps/plugin-store';
import { attachConsole } from '@tauri-apps/plugin-log';
import { openPath } from '@tauri-apps/plugin-opener';
import { appLogDir, join } from '@tauri-apps/api/path';
import { debug as logDebug, info as logInfo, warn as logWarn, error as logError } from '@tauri-apps/plugin-log';
import i18n, { translateNativeError } from '../i18n';
import { useSettingsStore } from '../stores/settingsStore';

// Store instance for Tauri
let store: Store | null = null;
async function getStore() {
    if (!store) {
        store = await Store.load('.settings.dat');
    }
    return store;
}

// ── Serialized write queue ────────────────────────────────────────────────────
// Bridge.updateSettings / saveSource / deleteSource all perform a non-atomic
// get → merge → set → save cycle. If two of these run concurrently they can
// interleave: a write that reads the store before another write lands will later
// persist its stale snapshot, silently reverting the other write (e.g. epgView
// being reset back to 'traditional' seconds after the user changed it).
// Chaining every write through this promise serializes the full read-modify-write
// cycle so later writes always merge on top of the previous write's result.
let _writeQueue: Promise<unknown> = Promise.resolve();
function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = _writeQueue.then(task);
    // Keep the chain alive even if a task rejects; the error still surfaces to
    // the caller through `run`.
    _writeQueue = run.then(() => undefined, () => undefined);
    return run;
}

// Window sync state for macOS hole punch
type UnlistenFn = () => void;
let windowSyncListeners: { move?: UnlistenFn; resize?: UnlistenFn; focus?: UnlistenFn; close?: UnlistenFn } = {};
let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let focusSyncTimer: ReturnType<typeof setTimeout> | null = null;
let fullscreenRestoreMaximized: boolean | null = null;

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Callback for app close event
let onAppCloseCallback: (() => void | Promise<void>) | null = null;
let appCloseListenerUnlisten: UnlistenFn | null = null;

/**
 * Initialize global app close listener across all platforms (Windows, macOS, Linux).
 * Listens for window close requested events and awaits state/progress save callbacks before exiting.
 */
export async function initAppCloseListener() {
    if (appCloseListenerUnlisten) return;
    try {
        const appWindow = getCurrentWindow();
        appCloseListenerUnlisten = await appWindow.onCloseRequested(async (event) => {
            console.log('[Bridge] Close requested - calling save callbacks');
            if (onAppCloseCallback) {
                try {
                    await onAppCloseCallback();
                } catch (err) {
                    console.error('[Bridge] Error during onAppCloseCallback:', err);
                }
            }
            try {
                await flushDebouncedSettings();
            } catch (err) {
                console.error('[Bridge] Failed to flush debounced settings on close:', err);
            }
        });
        console.log('[Bridge] App close listener successfully registered');
    } catch (e) {
        console.error('[Bridge] Failed to register app close listener:', e);
    }
}

/**
 * Register a callback to be called when the app is about to close
 * This allows components to save state before the app exits
 */
export function registerOnAppClose(callback: () => void | Promise<void>) {
    onAppCloseCallback = callback;
    initAppCloseListener().catch(() => {});
}

/**
 * Unregister the app close callback
 */
export function unregisterOnAppClose() {
    onAppCloseCallback = null;
}

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
    stopWindowSync();

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
                if (focusSyncTimer) {
                    clearTimeout(focusSyncTimer);
                }
                focusSyncTimer = setTimeout(() => {
                    focusSyncTimer = null;
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
    if (windowSyncListeners.close) {
        windowSyncListeners.close();
        windowSyncListeners.close = undefined;
    }
    if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
    }
    if (focusSyncTimer) {
        clearTimeout(focusSyncTimer);
        focusSyncTimer = null;
    }
}

let isCasting = false;
let castMetadata = { title: "YNotV Stream", subtitle: "" };
// Prevents concurrent cast_load_media calls from racing each other (INVALID_MEDIA_SESSION_ID)
let castLoadInFlight = false;
let castLoadSeq = 0;

// Set this to true if you want core player controls (play, pause, seek, volume, loadVideo)
// to control Chromecast instead of the local player. Kept here in case we want to re-enable.
export const REDIRECT_CONTROLS_TO_CAST = true;

export function rewriteTsToM3u8(url: string): string {
    if (!url) return url;
    try {
        const parsed = new URL(url);
        if (parsed.pathname.toLowerCase().endsWith('.ts')) {
            parsed.pathname = parsed.pathname.slice(0, -3) + '.m3u8';
            return parsed.toString();
        }

        if (parsed.searchParams.get('output')?.toLowerCase() === 'ts') {
            parsed.searchParams.set('output', 'm3u8');
            return parsed.toString();
        }

        if (parsed.searchParams.get('extension')?.toLowerCase() === 'ts') {
            parsed.searchParams.set('extension', 'm3u8');
            return parsed.toString();
        }

        const segments = parsed.pathname.split('/').filter(Boolean);
        const liveIndex = segments.findIndex(segment => segment.toLowerCase() === 'live');
        const lastSegment = segments[segments.length - 1] || '';
        if (liveIndex >= 0 && segments.length >= liveIndex + 4 && !lastSegment.includes('.')) {
            parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}.m3u8`;
            return parsed.toString();
        }
    } catch (e) {
        // Fallback for simple string replacement if URL parsing fails
        return url
            .replace(/\.ts(?=([?#]|$))/i, '.m3u8')
            .replace(/([?&](?:output|extension)=)ts(?=(&|$))/i, '$1m3u8');
    }
    return url;
}

function guessMimeType(url: string, fallbackUrl?: string): string {
    const candidates = [url, fallbackUrl].filter(Boolean).map((candidate) => candidate!.toLowerCase());
    const hasMatch = (predicate: (candidate: string) => boolean) => candidates.some(predicate);

    if (hasMatch((u) => u.includes('.m3u8') || u.includes('/m3u8') || u.includes('/hls') || u.includes('output=m3u8') || u.includes('extension=m3u8'))) {
        return 'application/x-mpegURL';
    }
    if (hasMatch((u) => u.includes('.ts') || u.includes('/ts'))) {
        return 'video/mp2t';
    }
    if (hasMatch((u) => u.includes('.mp4') || u.includes('/mp4'))) {
        return 'video/mp4';
    }
    if (hasMatch((u) => u.includes('.mkv'))) {
        return 'video/x-matroska';
    }
    if (hasMatch((u) => u.includes('.webm'))) {
        return 'video/webm';
    }
    return 'application/x-mpegURL';
}

export const Bridge = {
    isTauri: true,

    // Google Cast State Management
    setIsCasting(active: boolean) {
        isCasting = active;
        console.log('[Bridge] setIsCasting:', active);
    },

    getIsCasting() {
        return isCasting;
    },

    setCastMetadata(title: string, subtitle: string) {
        castMetadata = { title, subtitle };
        console.log('[Bridge] setCastMetadata:', castMetadata);
    },

    getCastMetadata() {
        return castMetadata;
    },

    // MPV Controls
    async initMpv(timeshiftEnabled?: boolean, timeshiftCacheBytes?: number) {
        console.log('[Bridge.initMpv] Called with:', { timeshiftEnabled, timeshiftCacheBytes });
        console.trace('[Bridge.initMpv] Stack trace:');

        // Build args array with cache settings if provided
        const args: string[] = [];
        if (timeshiftEnabled && timeshiftCacheBytes && timeshiftCacheBytes > 0) {
            args.push('--cache=yes');
            args.push(`--demuxer-max-back-bytes=${timeshiftCacheBytes}`);
        }
        try {
            const savedVol = localStorage.getItem('ynotv_volume');
            if (savedVol !== null) {
                const parsed = parseInt(savedVol, 10);
                if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
                    args.push(`--volume=${parsed}`);
                }
            }
        } catch (e) {}
        console.log('[Bridge.initMpv] Invoking init_mpv with args:', args);
        const result = await invoke('init_mpv', { args });
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

    async loadVideo(url: string, userAgent?: string) {
        if (REDIRECT_CONTROLS_TO_CAST && isCasting) {
            const isLocal = url.startsWith('file://') || (!url.startsWith('http://') && !url.startsWith('https://'));
            if (isLocal) {
                return { success: false, error: 'Local files cannot be cast. Only remote streams are supported.' };
            }

            // Check settings to see if we should rewrite TS to M3U8
            let castRewriteTs = false;
            try {
                const s = await getStore();
                const settings: any = await s.get('settings') ?? {};
                castRewriteTs = settings.castRewriteTs ?? true;
            } catch (e) {
                console.warn('[Bridge] Failed to load castRewriteTs setting:', e);
            }

            // Chromecast's Default Media Receiver (CC1AD845) does not support raw MPEG-TS (.ts) streams.
            // Therefore, if the URL is a .ts stream, we should rewrite it to HLS (.m3u8) when casting.
            // We force this rewrite if castRewriteTs is true, OR if the URL is a standard IPTV .ts stream
            // (meaning it contains .ts, output=ts, or extension=ts).
            const isStandardTs = url.toLowerCase().includes('.ts') || 
                                 url.toLowerCase().includes('output=ts') || 
                                 url.toLowerCase().includes('extension=ts');
            const shouldRewrite = castRewriteTs || isStandardTs;

            // Apply TS->M3U8 rewrite before resolving redirects
            const preRewriteUrl = shouldRewrite ? rewriteTsToM3u8(url) : url;

            // Serialise concurrent cast_load_media calls
            castLoadSeq += 1;
            const mySeq = castLoadSeq;
            while (castLoadInFlight) {
                await new Promise(r => setTimeout(r, 50));
                if (castLoadSeq !== mySeq) {
                    console.log('[Bridge.loadVideo] Superseded by newer cast load, bailing');
                    return { success: true };
                }
            }
            if (castLoadSeq !== mySeq) return { success: true };

            // Lock early to prevent concurrent URL resolutions/loads
            castLoadInFlight = true;

            // Stop/pause previous cast stream to free up connection slot
            try {
                await invoke('cast_stop');
            } catch (stopErr) {
                try {
                    await invoke('cast_pause');
                } catch (pauseErr) {
                    console.warn('[Bridge.loadVideo] Failed to stop/pause previous cast stream:', pauseErr);
                }
            }

            // Resolve HTTP redirects server-side so Chromecast gets the final CDN URL.
            // Xtreamcode servers redirect: hostname/.../ch.m3u8 -> CDN_IP/.../ch.m3u8?token=...
            // Token is IP-bound; resolving from app (same LAN) creates a token the Chromecast can use.
            let castUrl = preRewriteUrl;
            try {
                const resolved: string = await invoke('cast_resolve_url', { url: preRewriteUrl, userAgent });
                castUrl = shouldRewrite ? rewriteTsToM3u8(resolved) : resolved;
                console.log('[Bridge.loadVideo] Resolved cast URL:', castUrl);
            } catch (e) {
                console.warn('[Bridge.loadVideo] Redirect resolve failed, using URL as-is:', e);
            }

            try {
                await invoke('cast_load_media', {
                    url: castUrl,
                    title: castMetadata.title,
                    subtitle: castMetadata.subtitle,
                    mimeType: guessMimeType(castUrl, preRewriteUrl),
                });
                return { success: true };
            } catch (e: any) {
                return { success: false, error: typeof e === 'string' ? e : translateNativeError(e.message) || i18n.t('player:failedToCastMedia') };
            } finally {
                castLoadInFlight = false;
            }
        }
        try {
            await invoke('mpv_load', { url });
            return { success: true };
        } catch (e: any) {
            return { success: false, error: typeof e === 'string' ? e : translateNativeError(e.message) || i18n.t('player:unknownError') };
        }
    },

    async play() {
        if (REDIRECT_CONTROLS_TO_CAST && isCasting) {
            try {
                return await invoke('cast_play');
            } catch (e) {
                console.warn('[Bridge.play] Cast play failed, falling back to MPV:', e);
            }
        }
        return invoke('mpv_play');
    },

    async pause() {
        if (REDIRECT_CONTROLS_TO_CAST && isCasting) {
            try {
                return await invoke('cast_pause');
            } catch (e) {
                console.warn('[Bridge.pause] Cast pause failed, falling back to MPV:', e);
            }
        }
        return invoke('mpv_pause');
    },

    async resume() {
        if (REDIRECT_CONTROLS_TO_CAST && isCasting) {
            try {
                return await invoke('cast_play');
            } catch (e) {
                console.warn('[Bridge.resume] Cast resume failed, falling back to MPV:', e);
            }
        }
        return invoke('mpv_resume');
    },

    async stop() {
        if (REDIRECT_CONTROLS_TO_CAST && isCasting) {
            try {
                return await invoke('cast_pause');
            } catch (e) {
                console.warn('[Bridge.stop] Cast stop (pause) failed, falling back to MPV:', e);
            }
        }
        return invoke('mpv_stop');
    },

    async stopLocalVideo() {
        return invoke('mpv_stop');
    },

    async setVolume(volume: number) {
        try {
            localStorage.setItem('ynotv_volume', String(volume));
            if ((window as any).storage?.updateSettings) {
                (window as any).storage.updateSettings({ savedVolume: volume }).catch(() => {});
            }
        } catch (e) {}

        if (REDIRECT_CONTROLS_TO_CAST && isCasting) {
            try {
                return await invoke('cast_set_volume', { level: parseFloat(String(volume)) / 100.0 });
            } catch (e) {
                console.warn('[Bridge.setVolume] Cast set volume failed, falling back to MPV:', e);
            }
        }
        return invoke('mpv_set_volume', { volume: parseFloat(String(volume)) });
    },

    async seek(seconds: number) {
        if (REDIRECT_CONTROLS_TO_CAST && isCasting) {
            try {
                return await invoke('cast_seek', { seconds: parseFloat(String(seconds)) });
            } catch (e) {
                console.warn('[Bridge.seek] Cast seek failed, falling back to MPV:', e);
            }
        }
        return invoke('mpv_seek', { seconds: parseFloat(String(seconds)) });
    },

    async cycleSubtitle() {
        return invoke('mpv_cycle_sub');
    },

    async cycleAudio() {
        return invoke('mpv_cycle_audio');
    },

    async toggleMute() {
        if (REDIRECT_CONTROLS_TO_CAST && isCasting) {
            try {
                return await invoke('cast_toggle_mute');
            } catch (e) {
                console.warn('[Bridge.toggleMute] Cast toggle mute failed, falling back to MPV:', e);
            }
        }
        return invoke('mpv_toggle_mute');
    },

    async toggleStats() {
        return invoke('mpv_toggle_stats');
    },

    async toggleFullscreen() {
        const appWindow = getCurrentWindow();
        const isFullscreen = await appWindow.isFullscreen();

        if (!isFullscreen) {
            fullscreenRestoreMaximized = await appWindow.isMaximized();
            await invoke('mpv_toggle_fullscreen', { restoreToMaximized: false });
            return;
        }

        if (fullscreenRestoreMaximized) {
            await invoke('mpv_toggle_fullscreen', { restoreToMaximized: true });
            fullscreenRestoreMaximized = null;
            return;
        }
        await invoke('mpv_toggle_fullscreen', { restoreToMaximized: false });
        fullscreenRestoreMaximized = null;
    },

    async isFullscreen() {
        const appWindow = getCurrentWindow();
        return appWindow.isFullscreen();
    },

    async setFullscreen(fullscreen: boolean, options?: { restoreMaximized?: boolean }) {
        const appWindow = getCurrentWindow();
        const isFullscreen = await appWindow.isFullscreen();
        if (isFullscreen === fullscreen) {
            return;
        }

        if (fullscreen) {
            fullscreenRestoreMaximized = await appWindow.isMaximized();
            await invoke('mpv_toggle_fullscreen', { restoreToMaximized: false });
            return;
        }

        const shouldRestoreMaximized = options?.restoreMaximized ?? fullscreenRestoreMaximized === true;
        fullscreenRestoreMaximized = null;

        if (shouldRestoreMaximized) {
            await invoke('mpv_toggle_fullscreen', { restoreToMaximized: shouldRestoreMaximized });
            return;
        }

        await invoke('mpv_toggle_fullscreen', { restoreToMaximized: shouldRestoreMaximized });

        if (!fullscreen) {
            await delay(50);
            if (await appWindow.isMaximized()) {
                await appWindow.unmaximize();
            }
        }
    },

    async isMaximized() {
        const appWindow = getCurrentWindow();
        return appWindow.isMaximized();
    },

    async getTrackList(): Promise<any[]> {
        const result = await invoke('mpv_get_track_list');
        return result as any[] || [];
    },

    async setAudioTrack(id: number) {
        return invoke('mpv_set_audio', { id });
    },

    async setSubtitleTrack(id: number) {
        const res = await invoke('mpv_set_subtitle', { id });
        if (id > 0) {
            // Force rendering on. A user-supplied --sub-visibility=no in custom
            // mpv parameters would otherwise silently hide every selected subtitle.
            await invoke('mpv_set_property', { name: 'sub-visibility', value: true }).catch(() => {});
            try {
                const ss = useSettingsStore.getState().subtitleSettings;
                const size = ss?.defaultSize || 35;
                const override = ss?.subAssOverride || 'yes';
                const effectiveOverride = override === 'no' ? 'no' : (override === 'scale' ? 'scale' : 'strip');
                const scale = Math.max(0.2, Math.min(3.0, size / 35));
                await invoke('mpv_set_property', { name: 'sub-font-size', value: size }).catch(() => {});
                await invoke('mpv_set_property', { name: 'sub-scale', value: scale }).catch(() => {});
                await invoke('mpv_set_property', { name: 'sub-ass-override', value: effectiveOverride }).catch(() => {});
                await invoke('mpv_set_property', { name: 'sub-use-media-style', value: override === 'no' }).catch(() => {});
                await invoke('mpv_set_property', { name: 'sub-ass-scale-with-window', value: true }).catch(() => {});
                if (ss?.subColor) {
                    await invoke('mpv_set_property', { name: 'sub-color', value: ss.subColor }).catch(() => {});
                }
                if (ss?.subBackgroundEnabled && ss?.subBackgroundColor) {
                    const opacityPercent = ss.subBackgroundOpacity ?? 80;
                    const hex = ss.subBackgroundColor.replace('#', '').substring(0, 6);
                    const r = parseInt(hex.substring(0, 2), 16) / 255;
                    const g = parseInt(hex.substring(2, 4), 16) / 255;
                    const b = parseInt(hex.substring(4, 6), 16) / 255;
                    const a = opacityPercent / 100;
                    await invoke('mpv_set_property', { name: 'sub-back-color', value: `${r}/${g}/${b}/${a}` }).catch(() => {});
                    await invoke('mpv_set_property', { name: 'sub-border-style', value: 'background-box' }).catch(() => {});
                } else if (ss?.subBackgroundEnabled === false) {
                    const hex = (ss.subBackgroundColor || '#000000').replace('#', '').substring(0, 6);
                    const r = parseInt(hex.substring(0, 2), 16) / 255;
                    const g = parseInt(hex.substring(2, 4), 16) / 255;
                    const b = parseInt(hex.substring(4, 6), 16) / 255;
                    await invoke('mpv_set_property', { name: 'sub-back-color', value: `${r}/${g}/${b}/0` }).catch(() => {});
                    await invoke('mpv_set_property', { name: 'sub-border-style', value: 'outline-and-shadow' }).catch(() => {});
                }
                if (ss?.subOutlineColor) {
                    await invoke('mpv_set_property', { name: 'sub-border-color', value: ss.subOutlineColor }).catch(() => {});
                }
                if (ss?.subVerticalOffset !== undefined) {
                    const pos = Math.max(0, Math.min(100, ss.subVerticalOffset));
                    await invoke('mpv_set_property', { name: 'sub-pos', value: pos }).catch(() => {});
                }
                const align = ss?.subAlign || 'center';
                const alignX = align === 'left' ? 'left' : (align === 'right' ? 'right' : 'center');
                await invoke('mpv_set_property', { name: 'sub-align-x', value: alignX }).catch(() => {});
            } catch (e) {}
        } else {
            await invoke('mpv_set_property', { name: 'sub-visibility', value: false }).catch(() => {});
        }
        return res;
    },

    async addSubtitleFile(filePath: string, flag?: string) {
        return invoke('mpv_add_subtitle', { filePath, flag });
    },

    async getMpvLog(tail?: number): Promise<{ log: string; path: string }> {
        return invoke('mpv_get_log', { tail: tail ?? 400 });
    },

    async setMpvVerboseLogging(enabled: boolean) {
        return invoke('mpv_set_verbose_logging', { enabled });
    },

    async removeSubtitleFile(filePath: string) {
        return invoke('mpv_remove_subtitle', { filePath });
    },

    async setSubtitleDelay(delay: number) {
        return invoke('mpv_set_property', { name: 'sub-delay', value: delay });
    },

    async setSubtitleSize(size: number) {
        const scale = Math.max(0.2, Math.min(3.0, size / 35));
        await invoke('mpv_set_property', { name: 'sub-font-size', value: size }).catch(() => {});
        await invoke('mpv_set_property', { name: 'sub-scale', value: scale }).catch(() => {});
        await invoke('mpv_set_property', { name: 'sub-ass-override', value: 'strip' }).catch(() => {});
        await invoke('mpv_set_property', { name: 'sub-use-media-style', value: false }).catch(() => {});
        await invoke('mpv_set_property', { name: 'sub-ass-scale-with-window', value: true }).catch(() => {});
        return;
    },

    async setSubtitleScale(scale: number) {
        return invoke('mpv_set_property', { name: 'sub-scale', value: scale });
    },

    async setSubAssOverride(override: string) {
        if (override === 'yes' || override === 'force' || override === 'strip') {
            await invoke('mpv_set_property', { name: 'sub-ass-override', value: 'strip' }).catch(() => {});
            await invoke('mpv_set_property', { name: 'sub-use-media-style', value: false }).catch(() => {});
        } else if (override === 'no') {
            await invoke('mpv_set_property', { name: 'sub-ass-override', value: 'no' }).catch(() => {});
            await invoke('mpv_set_property', { name: 'sub-use-media-style', value: true }).catch(() => {});
        } else {
            await invoke('mpv_set_property', { name: 'sub-ass-override', value: override }).catch(() => {});
        }
    },

    async setSubtitleColor(color: string) {
        return invoke('mpv_set_property', { name: 'sub-color', value: color });
    },

    async setSubtitleBackColor(color: string, opacity: number = 100) {
        // MPV IPC accepts colors as r/g/b/a floats (alpha: 0.0=transparent, 1.0=opaque)
        const hex = color.replace('#', '').substring(0, 6);
        const r = parseInt(hex.substring(0, 2), 16) / 255;
        const g = parseInt(hex.substring(2, 4), 16) / 255;
        const b = parseInt(hex.substring(4, 6), 16) / 255;
        const a = opacity / 100;
        return invoke('mpv_set_property', { name: 'sub-back-color', value: `${r}/${g}/${b}/${a}` });
    },

    async setSubtitleBackOpacity(opacity: number) {
        // MPV does not have a sub-back-opacity property, alpha should be passed via setSubtitleBackColor
        return Promise.resolve();
    },

    async setSubtitleBorderColor(color: string) {
        return invoke('mpv_set_property', { name: 'sub-border-color', value: color });
    },

    async setSubtitleBorderStyle(style: string | number) {
        return invoke('mpv_set_property', { name: 'sub-border-style', value: style });
    },

    async setSubtitlePos(pos: number) {
        await invoke('mpv_set_property', { name: 'sub-ass-override', value: 'strip' }).catch(() => {});
        return invoke('mpv_set_property', { name: 'sub-pos', value: pos });
    },

    async setSubtitleAlign(align: string) {
        const alignX = align === 'left' ? 'left' : (align === 'right' ? 'right' : 'center');
        await invoke('mpv_set_property', { name: 'sub-ass-override', value: 'strip' }).catch(() => {});
        await invoke('mpv_set_property', { name: 'sub-align-x', value: alignX }).catch(() => {});
    },

    async setProperty(name: string, value: any) {
        if (name === 'volume' && typeof value === 'number') {
            try {
                localStorage.setItem('ynotv_volume', String(value));
                if ((window as any).storage?.updateSettings) {
                    (window as any).storage.updateSettings({ savedVolume: value }).catch(() => {});
                }
            } catch (e) {}
        }
        return invoke('mpv_set_property', { name, value });
    },

    async setProperties(properties: Record<string, any>) {
        const entries = Object.entries(properties);
        return invoke('mpv_set_properties', { properties: entries });
    },

    async getProperty(name: string): Promise<any> {
        return invoke('mpv_get_property', { name });
    },

    // Popout MPV Controls
    async popoutOpen(url: string, alwaysOnTop: boolean = false, customParams: string = '') {
        return invoke('popout_open', { url, alwaysOnTop, customParams });
    },

    async popoutLoad(url: string) {
        return invoke('popout_load', { url });
    },

    async popoutStop() {
        return invoke('popout_stop');
    },

    async popoutClose() {
        return invoke('popout_close');
    },

    async popoutSetProperty(property: string, value: any) {
        return invoke('popout_set_property', { property, value });
    },

    async popoutSetAlwaysOnTop(onTop: boolean) {
        return invoke('popout_set_always_on_top', { onTop });
    },

    popoutIsRunning(): Promise<boolean> {
        return invoke('popout_is_running');
    },

    async popoutTogglePause() {
        return invoke('popout_toggle_pause');
    },

    async popoutToggleFullscreen() {
        return invoke('popout_toggle_fullscreen');
    },

    async popoutSeek(seconds: number) {
        return invoke('popout_seek', { seconds });
    },

    async popoutGetParamsDebug(): Promise<Record<string, unknown>> {
        return invoke('popout_get_params_debug');
    },

    async openExternalPlayer(playerPath: string, url: string) {
        return invoke('spawn_external_player', { playerPath, url });
    },

    async openExternalPlayerWithArgs(playerPath: string, args: string[]) {
        return invoke('spawn_external_player_with_args', { playerPath, args });
    },

    async openExternalPlayerReuse(playerPath: string, url: string) {
        return invoke('spawn_external_player_reuse', { playerPath, url });
    },

    async killExternalPlayer() {
        return invoke('kill_external_player');
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

    async saveM3UFile(content: string, defaultName: string) {
        const path = await dialog.save({
            defaultPath: `${defaultName}.m3u`,
            filters: [{ name: 'M3U Playlist', extensions: ['m3u', 'm3u8'] }]
        });
        if (!path) return { canceled: true };
        await fs.writeTextFile(path, content);
        return { success: true, data: { filePath: path } };
    },

    async saveCsvFile(content: string, defaultName: string) {
        const path = await dialog.save({
            defaultPath: `${defaultName}.csv`,
            filters: [{ name: 'CSV Spreadsheet', extensions: ['csv'] }]
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
        return enqueueWrite(async () => {
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
        });
    },

    async deleteSource(id: string) {
        return enqueueWrite(async () => {
            const s = await getStore();
            let sources: any[] = (await s.get('sources')) || [];
            sources = sources.filter((src: any) => src.id !== id);
            await s.set('sources', sources);
            await s.save();
            return { success: true };
        });
    },

    async getSettings() {
        const s = await getStore();
        const settings = (await s.get('settings')) as Record<string, any> | null;
        return { success: true, data: settings || {} };
    },

    async updateSettings(newSettings: any) {
        // Mirror to localStorage so uiStore's synchronous hydration
        // (getInitialEpgView) sees the latest value before the async disk
        // write settles. Disk (.settings.dat) remains authoritative for reads.
        try {
            const existing = typeof localStorage !== 'undefined' ? localStorage.getItem('app-settings') : null;
            const parsed = existing ? JSON.parse(existing) : {};
            localStorage.setItem('app-settings', JSON.stringify({ ...parsed, ...newSettings }));
        } catch (e) {}

        return enqueueWrite(async () => {
            const s = await getStore();
            const current = (await s.get('settings')) || {};
            const updated = { ...current as object, ...newSettings };
            await s.set('settings', updated);
            await s.save();
            return { success: true };
        });
    },

    async getSource(id: string) {
        const s = await getStore();
        const sources: any[] = (await s.get('sources')) || [];
        const source = sources.find((src: any) => src.id === id);
        return { success: true, data: source };
    }
};

export type AspectRatioMode = 'fit' | 'fill' | 'stretch' | '4:3' | '16:9';

export async function applyAspectRatio(mode: AspectRatioMode) {
    switch (mode) {
        case 'fit':
            await Bridge.setProperties({
                'video-aspect-override': -1,
                'panscan': 0,
                'keepaspect': true,
            });
            break;
        case 'fill':
            await Bridge.setProperties({
                'video-aspect-override': -1,
                'panscan': 1,
                'keepaspect': true,
            });
            break;
        case 'stretch':
            await Bridge.setProperties({
                'video-aspect-override': -1,
                'panscan': 0,
                'keepaspect': false,
            });
            break;
        case '4:3':
            await Bridge.setProperties({
                'video-aspect-override': '4:3',
                'panscan': 0,
                'keepaspect': true,
            });
            break;
        case '16:9':
            await Bridge.setProperties({
                'video-aspect-override': '16:9',
                'panscan': 0,
                'keepaspect': true,
            });
            break;
    }
}

// ── Debounced settings helper ────────────────────────────────────────────────
// Coalesces frequent updateSettings calls (slider/text inputs) into a single write.
let _debouncedSettingsTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingSettings: Record<string, any> = {};

export function debouncedUpdateSettings(partial: Record<string, any>): void {
  Object.assign(_pendingSettings, partial);
  if (_debouncedSettingsTimer) clearTimeout(_debouncedSettingsTimer);
  _debouncedSettingsTimer = setTimeout(async () => {
    const updates = { ..._pendingSettings };
    _pendingSettings = {};
    _debouncedSettingsTimer = null;
    try {
      await Bridge.updateSettings(updates);
    } catch (err) {
      console.error('[DebouncedSettings] Failed to save:', err);
    }
  }, 300);
}

/** Flush any pending debounced settings immediately (e.g. before app close). */
export async function flushDebouncedSettings(): Promise<void> {
  if (_debouncedSettingsTimer) {
    clearTimeout(_debouncedSettingsTimer);
    _debouncedSettingsTimer = null;
  }
  const updates = { ..._pendingSettings };
  _pendingSettings = {};
  if (Object.keys(updates).length > 0) {
    await Bridge.updateSettings(updates);
  }
}

export function getAspectRatioLabel(mode: AspectRatioMode): string {
    switch (mode) {
        case '4:3': return '4:3';
        case '16:9': return '16:9';
        default: return mode.charAt(0).toUpperCase() + mode.slice(1);
    }
}

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
        debouncedUpdateSettings: debouncedUpdateSettings,
        getSource: Bridge.getSource,
        saveJsonFile: Bridge.saveJsonFile,
        saveM3UFile: Bridge.saveM3UFile,
        saveCsvFile: Bridge.saveCsvFile,
        openJsonFile: Bridge.openJsonFile,
        importM3UFile: Bridge.importM3UFile,
        isEncryptionAvailable: () => Promise.resolve({ success: true, data: true })
    };

    // Polyfill window.debug with actual file logging
    console.log('[TauriBridge] Initializing Debug Polyfill with file logging');
    const existingDebug = (window as any).debug || {};
    
    // Check if debug logging is enabled from settings
    // NOTE: DebugTab stores this inside the 'settings' object via updateSettings(),
    // so we must read it from store.get('settings').debugLoggingEnabled, NOT store.get('debugLoggingEnabled')
    let debugLoggingEnabled = false;
    try {
        const store = await getStore();
        const settings: any = await store.get('settings') ?? {};
        debugLoggingEnabled = settings.debugLoggingEnabled ?? false;
        console.log('[TauriBridge] Debug logging enabled:', debugLoggingEnabled);
    } catch (e) {
        console.warn('[TauriBridge] Failed to read debug logging setting:', e);
    }

    // If debug logging is enabled at startup, attach console NOW so all subsequent
    // console.info/warn/error calls are forwarded to the native log file.
    if (debugLoggingEnabled) {
        try {
            await attachConsole();
            console.info('[TauriBridge] Console attached to Tauri log plugin on startup');
        } catch (err) {
            console.error('[TauriBridge] Failed to attach console on startup:', err);
        }
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

            // If debug logging is enabled, attempt to attach console
            if (enabled) {
                attachConsole().catch(err => console.error("[TauriBridge] Failed to attach console dynamically:", err));
            }
            // Note: We don't un-mock console.log here if it was mocked,
            // as that would require storing original console methods.
            // For simplicity, once mocked, they stay mocked until app restart.
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
        addSubtitleFile: Bridge.addSubtitleFile,
        removeSubtitleFile: Bridge.removeSubtitleFile,
        setSubtitleDelay: Bridge.setSubtitleDelay,
        setSubtitleSize: Bridge.setSubtitleSize,
        setSubtitleScale: Bridge.setSubtitleScale,
        setSubAssOverride: Bridge.setSubAssOverride,
        setSubtitleColor: Bridge.setSubtitleColor,
        setSubtitleBackColor: Bridge.setSubtitleBackColor,
        setSubtitleBackOpacity: Bridge.setSubtitleBackOpacity,
        setSubtitleBorderColor: Bridge.setSubtitleBorderColor,
        setSubtitleBorderStyle: Bridge.setSubtitleBorderStyle,
        setSubtitlePos: Bridge.setSubtitlePos,
        setSubtitleAlign: Bridge.setSubtitleAlign,
        destroy: () => { },
        setProperty: Bridge.setProperty,
        setProperties: Bridge.setProperties,
        getProperty: Bridge.getProperty,
        onError: (cb: any) => console.log('[MPV] onError listener added'),
        removeAllListeners: () => console.log('[MPV] removeAllListeners called'),
        on: (event: string, handler: any) => console.log(`[MPV] Added listener for ${event}`),
        off: (event: string, handler: any) => console.log(`[MPV] Removed listener for ${event}`),
        getDuration: () => 0,
        getPosition: () => 0,
        getVolume: () => 100,
        getMuted: () => false,
        getPaused: () => false,
        // Popout player methods
        popoutOpen: Bridge.popoutOpen,
        popoutLoad: Bridge.popoutLoad,
        popoutStop: Bridge.popoutStop,
        popoutClose: Bridge.popoutClose,
        popoutSetProperty: Bridge.popoutSetProperty,
        popoutSetAlwaysOnTop: Bridge.popoutSetAlwaysOnTop,
        popoutIsRunning: Bridge.popoutIsRunning,
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
            const contentLength = response.headers.get('content-length');
            const sizeMb = contentLength ? (parseInt(contentLength) / (1024 * 1024)).toFixed(1) : 'unknown';
            if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) {
                console.warn(`[fetchProxy] Large fetch (${sizeMb}MB) — consider using native streaming for M3U/EPG:`, url);
            }
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
    fetchBinary: async (url: string, options?: any) => {
        try {
            const response = await fetch(url, options);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const contentLength = response.headers.get('content-length');
            const sizeMb = contentLength ? (parseInt(contentLength) / (1024 * 1024)).toFixed(1) : 'unknown';
            if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) {
                console.warn(`[fetchProxy] Large binary fetch (${sizeMb}MB) — consider using native streaming:`, url);
            }
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
