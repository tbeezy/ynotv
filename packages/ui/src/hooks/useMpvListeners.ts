import { useState, useEffect, useRef, useCallback } from 'react';
import type { MpvStatus } from '../types/app';
import { Bridge } from '../services/tauri-bridge';
import i18n, { translateNativeError } from '../i18n';
import { createAudioOnlyTracker, resolveAudioOnly } from '../utils/audioOnly';
import { logInfo, logWarn } from '../utils/logger';

/**
 * How long a suppressible HTTP error is held before it is shown.
 *
 * Stalker/MAC sources (and some LAN panels) raise false 401/403s that don't stop
 * playback, so those errors are deferred rather than shown immediately: a stream
 * that starts making progress inside this window keeps them silent, and a stream
 * that never starts reports why instead of leaving a bare black screen.
 */
const HTTP_ERROR_GRACE_MS = 5000;

export interface MpvState {
    mpvReady: boolean;
    playing: boolean;
    volume: number;
    muted: boolean;
    position: number;
    duration: number;
    error: string | null;
    pausedForCache: boolean;
    coreIdle: boolean;
    isAudioOnly: boolean;
    setIsAudioOnly: React.Dispatch<React.SetStateAction<boolean>>;
    // Drag/seek refs exposed for NowPlayingBar
    volumeDraggingRef: React.MutableRefObject<boolean>;
    seekingRef: React.MutableRefObject<boolean>;
    setError: React.Dispatch<React.SetStateAction<string | null>>;
    setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
    setPosition: React.Dispatch<React.SetStateAction<number>>;
    setVolume: React.Dispatch<React.SetStateAction<number>>;
    setCurrentChannelNull: () => void;
    suppressStatusUpdates: (durationMs: number) => void;
}

interface UseMpvListenersOptions {
    onReady?: () => void;
    /** Fired when mpv reports a file ended (mpv-end-file event with its reason).
     *  `position`/`duration` are the values observed at end-of-file time (mpv
     *  resets time-pos to 0 after unloading an ended file). */
    onEndFile?: (payload: { reason?: string; fileError?: string; position?: number; duration?: number }) => void;
    timeshiftEnabled?: boolean;
    timeshiftCacheBytes?: number;
    settingsLoaded?: boolean; // Wait for settings before initializing MPV
}

/**
 * Subscribes to all Tauri mpv-* events and exposes the resulting player state.
 * Extracted from App.tsx to keep the event wiring self-contained.
 */
export function useMpvListeners(options: UseMpvListenersOptions = {}) {
    const [mpvReady, setMpvReady] = useState(false);
    const [playing, setPlaying] = useState(false);

    const getInitialVolume = () => {
        try {
            const saved = localStorage.getItem('ynotv_volume');
            if (saved !== null) {
                const parsed = parseInt(saved, 10);
                if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
                    return parsed;
                }
            }
        } catch {}
        return 100;
    };

    const [volume, setVolumeState] = useState<number>(getInitialVolume);
    const [muted, setMuted] = useState(false);
    const [position, setPosition] = useState(0);
    const [duration, setDuration] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [pausedForCache, setPausedForCache] = useState(false);
    const [coreIdle, setCoreIdle] = useState(true);
    const [isAudioOnly, setIsAudioOnly] = useState(false);
    // Mirrors the last applied audio-only decision so a stream transition is
    // logged once instead of on every status tick.
    const lastAudioOnlyRef = useRef(false);
    // Confirms the audio-only signal over two polls before applying it.
    const audioOnlyTrackerRef = useRef(createAudioOnlyTracker());

    const volumeRef = useRef(volume);
    useEffect(() => {
        volumeRef.current = volume;
    }, [volume]);

    const setVolume = useCallback((action: React.SetStateAction<number>) => {
        setVolumeState(prev => {
            const nextVol = typeof action === 'function' ? action(prev) : action;
            try {
                localStorage.setItem('ynotv_volume', String(nextVol));
                if ((window as any).storage?.updateSettings) {
                    (window as any).storage.updateSettings({ savedVolume: nextVol }).catch(() => {});
                }
            } catch (e) {}
            return nextVol;
        });
    }, []);

    const volumeDraggingRef = useRef(false);
    const seekingRef = useRef(false);
    const initializedRef = useRef(false);
    const hasSyncedInitialVolumeRef = useRef(false);
    const suppressStatusUntilRef = useRef<number>(0);
    // True once the current file has actually produced playback progress.
    // `playing` alone is not enough: mpv reports it as soon as loadfile is
    // accepted, which is also true for a stream that never opens.
    const progressRef = useRef(false);
    // A deferred (suppressed) HTTP error, and the timer that surfaces it when the
    // stream still hasn't started progressing.
    const pendingHttpErrorRef = useRef<string | null>(null);
    const pendingHttpErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearPendingHttpError = useCallback(() => {
        if (pendingHttpErrorTimerRef.current !== null) {
            clearTimeout(pendingHttpErrorTimerRef.current);
            pendingHttpErrorTimerRef.current = null;
        }
        pendingHttpErrorRef.current = null;
    }, []);
    
    const suppressStatusUpdates = useCallback((durationMs: number) => {
        suppressStatusUntilRef.current = Date.now() + durationMs;
        lastAudioOnlyRef.current = false;
        audioOnlyTrackerRef.current.reset();
        setIsAudioOnly(false);
        // Called on every stream transition: the previous file's progress says
        // nothing about the new one, so suppression must not carry over.
        progressRef.current = false;
        clearPendingHttpError();
    }, [clearPendingHttpError]);

    // Keep the latest onEndFile callback in a ref so the one-shot listener
    // registered below never captures a stale closure.
    const onEndFileRef = useRef(options.onEndFile);
    useEffect(() => { onEndFileRef.current = options.onEndFile; }, [options.onEndFile]);
    const timeshiftSettingsRef = useRef({
        enabled: options.timeshiftEnabled,
        cacheBytes: options.timeshiftCacheBytes,
    });

    // When true, the mpv-http-error event is silenced.
    // Used for Stalker/MAC sources where auth headers cause false 401/403 errors
    // even when the stream actually plays successfully.
    const ignoreHttpErrorsRef = useRef(false);
    const setIgnoreHttpErrors = useCallback((val: boolean) => { ignoreHttpErrorsRef.current = val; }, []);
    const isIgnoringHttpErrors = useCallback(() => ignoreHttpErrorsRef.current, []);

    // Keep a ref to the onReady callback to avoid re-running the effect on identity changes
    const onReadyRef = useRef(options.onReady);
    useEffect(() => { onReadyRef.current = options.onReady; }, [options.onReady]);
    useEffect(() => {
        timeshiftSettingsRef.current = {
            enabled: options.timeshiftEnabled,
            cacheBytes: options.timeshiftCacheBytes,
        };
    }, [options.timeshiftEnabled, options.timeshiftCacheBytes]);

    // Cache limits are MPV properties, so update the active player immediately
    // when the user changes the setting; no restart is required.
    useEffect(() => {
        if (!mpvReady || options.timeshiftCacheBytes == null) return;
        Bridge.setProperty('demuxer-max-back-bytes', options.timeshiftCacheBytes).catch(() => {});
        Bridge.setProperty('demuxer-max-bytes', options.timeshiftCacheBytes).catch(() => {});
    }, [mpvReady, options.timeshiftCacheBytes]);

    useEffect(() => {
        if (!Bridge.isTauri) {
            setError(i18n.t('player:mpvApiUnavailable'));
            return;
        }

        // Don't initialize MPV until settings are loaded from store
        // This ensures timeshift settings are available before MPV starts
        if (!options.settingsLoaded) {
            return;
        }

        let unlistenFns: (() => void)[] = [];
        let disposed = false;

        import('@tauri-apps/api/event').then(async ({ listen }) => {
            const unlistenReady = await listen('mpv-ready', (e: any) => {
                setMpvReady(e.payload);
                if (e.payload) {
                    Bridge.setVolume(volumeRef.current).catch(console.error);
                    hasSyncedInitialVolumeRef.current = true;
                    onReadyRef.current?.();
                }
            });

            const unlistenStatus = await listen('mpv-status', (e: any) => {
                const status = e.payload as MpvStatus;

                // Ignore stale position/playing updates from the old stream during channel transitions
                if (Date.now() < suppressStatusUntilRef.current) {
                    if (status.position === 0) {
                        // Clear suppression early once the player state has reset
                        suppressStatusUntilRef.current = 0;
                    } else {
                        return;
                    }
                }

                if (status.playing !== undefined) setPlaying(status.playing);
                if (status.volume !== undefined && !volumeDraggingRef.current) {
                    if (!hasSyncedInitialVolumeRef.current && status.volume === 100 && volumeRef.current !== 100) {
                        // MPV default volume status before initial sync — preserve user saved volume
                    } else {
                        hasSyncedInitialVolumeRef.current = true;
                        setVolumeState(status.volume);
                    }
                }
                if (status.muted !== undefined) setMuted(status.muted);
                if (status.position !== undefined && !seekingRef.current) setPosition(status.position);
                if (status.pausedForCache !== undefined) setPausedForCache(status.pausedForCache);
                if (status.coreIdle !== undefined) setCoreIdle(status.coreIdle);
                // Each engine reports the video track in its own shape, so the
                // interpretation lives in one place (see utils/audioOnly): both
                // the sidecar and the embedded engine send mpv's node form
                // (false with no video track, the track id otherwise), while a
                // raw int64 read arrives as -2. A null means the engine told us
                // nothing: keep the state we already have rather than flipping
                // to "has video".
                //
                // While the engine is idle it has no track selected either, and
                // that says nothing about the stream, so it counts as unknown;
                // entering audio-only also needs a second agreeing poll because
                // mpv selects its video track a moment after playback starts.
                const audioOnly = audioOnlyTrackerRef.current.next(
                    status.coreIdle ? null : resolveAudioOnly(status.videoTrackId, status.videoFormat)
                );
                if (audioOnly !== null && audioOnly !== lastAudioOnlyRef.current) {
                    lastAudioOnlyRef.current = audioOnly;
                    logInfo(
                        `[Playback] ${audioOnly
                            ? 'Audio-only stream: audio visualiser available'
                            : 'Video stream: audio visualiser hidden'} ` +
                        `(vid=${JSON.stringify(status.videoTrackId)}, format=${JSON.stringify(status.videoFormat)})`
                    );
                    setIsAudioOnly(audioOnly);
                }
                if (status.duration !== undefined) {
                    const dur = status.duration;
                    setDuration(prev => {
                        // If we are playing a growing file (appending://) and the duration is being updated
                        // externally, don't let MPV's 0 duration override it.
                        if (dur === 0 && prev > 0) {
                            return prev;
                        }
                        return dur;
                    });
                }

                // Track real progress so HTTP-error suppression can tell a stream
                // that is playing from one that never opened. One-way latch: once
                // playback has progressed, it stays latched until the next stream
                // transition so pauses or position resets don't un-latch it.
                const hasProgressed = status.playing === true && (
                    (status.position !== undefined && status.position > 0) ||
                    Boolean(status.videoTrackId || status.videoFormat)
                ) && !status.coreIdle;

                if (hasProgressed) {
                    progressRef.current = true;
                    // The stream got there after all: drop any deferred HTTP error
                    // instead of showing it seconds into healthy playback.
                    clearPendingHttpError();
                    setError(null);
                }
            });

            const unlistenError = await listen('mpv-error', (e: any) => {
                const err: string = translateNativeError(e.payload) || e.payload;
                setError(prev => {
                    // Don't overwrite specific HTTP/contextual errors with generic ones
                    if (prev && prev !== err && (
                        prev.includes('HTTP Error') ||
                        prev.includes('Access Denied') ||
                        prev.includes('Stream Not Found') ||
                        prev.includes('Stream Error:')
                    )) return prev;
                    return err;
                });
            });

            const unlistenHttpError = await listen('mpv-http-error', (e: any) => {
                const message = translateNativeError(e.payload) || e.payload;
                // Stalker/MAC sources (and some LAN panels) raise false 401/403s
                // that don't stop playback. Where errors are suppressed, defer
                // them instead of dropping them: a stream that never plays must
                // report the reason, otherwise the user gets a black screen with
                // no explanation and nothing lands in the log.
                if (ignoreHttpErrorsRef.current && !progressRef.current) {
                    const alreadyPending = pendingHttpErrorRef.current !== null;
                    pendingHttpErrorRef.current = message;
                    if (!alreadyPending) {
                        logInfo(`[Playback] HTTP error deferred (stream has not started yet): ${message}`);
                        pendingHttpErrorTimerRef.current = setTimeout(() => {
                            pendingHttpErrorTimerRef.current = null;
                            const pending = pendingHttpErrorRef.current;
                            pendingHttpErrorRef.current = null;
                            if (pending && !progressRef.current) {
                                logWarn(`[Playback] Stream never started, reporting deferred HTTP error: ${pending}`);
                                setError(pending);
                            }
                        }, HTTP_ERROR_GRACE_MS);
                    }
                    return;
                }
                // Already playing: the error is noise from a client that got past
                // whatever the panel objected to, so keep it out of the UI.
                if (ignoreHttpErrorsRef.current && progressRef.current) {
                    logWarn(`[Playback] HTTP error ignored (stream is already playing): ${message}`);
                    return;
                }
                setError(message);
            });

            const unlistenEndFileError = await listen('mpv-end-file-error', (e: any) => {
                setError(prev => prev ? prev : (translateNativeError(e.payload) || e.payload));
            });

            // Natural end of file (reason "eof") — lets the UI advance to the
            // next episode without misreading a user pause as an episode end.
            const unlistenEndFile = await listen('mpv-end-file', (e: any) => {
                onEndFileRef.current?.(e.payload as { reason?: string; fileError?: string; position?: number; duration?: number });
            });

            unlistenFns = [
                unlistenReady, unlistenStatus, unlistenError,
                unlistenHttpError, unlistenEndFileError, unlistenEndFile,
            ];

            if (disposed) {
                unlistenFns.forEach(fn => fn());
                return;
            }

            // Init MPV after listeners are registered to catch the ready event
            // Pass timeshift settings from frontend state (already loaded from store)
            if (!initializedRef.current) {
                initializedRef.current = true;
                const { enabled, cacheBytes } = timeshiftSettingsRef.current;
                Bridge.initMpv(enabled, cacheBytes);
            }
        });

        return () => {
            disposed = true;
            unlistenFns.forEach(fn => fn());
            clearPendingHttpError();
        };
    }, [
        options.settingsLoaded,
        clearPendingHttpError,
    ]); // Register listeners once after settings load; MPV init is intentionally one-shot.

    return {
        mpvReady, playing, volume, muted, position, duration, error,
        pausedForCache, coreIdle, isAudioOnly, setIsAudioOnly,
        volumeDraggingRef, seekingRef,
        setError, setPlaying, setPosition, setVolume, setMuted,
        setDuration, setMpvReady,
        setIgnoreHttpErrors, isIgnoringHttpErrors,
        suppressStatusUpdates,
    };
}
