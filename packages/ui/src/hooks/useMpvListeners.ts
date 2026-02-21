import { useState, useEffect, useRef } from 'react';
import type { MpvStatus } from '../types/app';
import { Bridge } from '../services/tauri-bridge';

export interface MpvState {
    mpvReady: boolean;
    playing: boolean;
    volume: number;
    muted: boolean;
    position: number;
    duration: number;
    error: string | null;
    // Drag/seek refs exposed for NowPlayingBar
    volumeDraggingRef: React.MutableRefObject<boolean>;
    seekingRef: React.MutableRefObject<boolean>;
    setError: React.Dispatch<React.SetStateAction<string | null>>;
    setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
    setPosition: React.Dispatch<React.SetStateAction<number>>;
    setVolume: React.Dispatch<React.SetStateAction<number>>;
    setCurrentChannelNull: () => void;
}

interface UseMpvListenersOptions {
    onReady?: () => void;
}

/**
 * Subscribes to all Tauri mpv-* events and exposes the resulting player state.
 * Extracted from App.tsx to keep the event wiring self-contained.
 */
export function useMpvListeners(options: UseMpvListenersOptions = {}) {
    const [mpvReady, setMpvReady] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [volume, setVolume] = useState(100);
    const [muted, setMuted] = useState(false);
    const [position, setPosition] = useState(0);
    const [duration, setDuration] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const volumeDraggingRef = useRef(false);
    const seekingRef = useRef(false);

    // Keep a ref to the onReady callback to avoid re-running the effect on identity changes
    const onReadyRef = useRef(options.onReady);
    useEffect(() => { onReadyRef.current = options.onReady; }, [options.onReady]);

    useEffect(() => {
        if (!Bridge.isTauri) {
            setError('mpv API not available');
            return;
        }

        let unlistenFns: (() => void)[] = [];

        import('@tauri-apps/api/event').then(async ({ listen }) => {
            const unlistenReady = await listen('mpv-ready', (e: any) => {
                setMpvReady(e.payload);
                if (e.payload) onReadyRef.current?.();
            });

            const unlistenStatus = await listen('mpv-status', (e: any) => {
                const status = e.payload as MpvStatus;
                if (status.playing !== undefined) setPlaying(status.playing);
                if (status.volume !== undefined && !volumeDraggingRef.current) setVolume(status.volume);
                if (status.muted !== undefined) setMuted(status.muted);
                if (status.position !== undefined && !seekingRef.current) setPosition(status.position);
                if (status.duration !== undefined) setDuration(status.duration);
            });

            const unlistenError = await listen('mpv-error', (e: any) => {
                const err: string = e.payload;
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
                console.error('[mpv-http-error]', e.payload);
                setError(e.payload);
            });

            const unlistenEndFileError = await listen('mpv-end-file-error', (e: any) => {
                console.error('[mpv-end-file-error]', e.payload);
                setError(prev => prev ? prev : e.payload);
            });

            const unlistenStartFile = await listen('mpv-start-file', () => {
                // Reserved for future start-file handling
            });

            unlistenFns = [
                unlistenReady, unlistenStatus, unlistenError,
                unlistenHttpError, unlistenEndFileError, unlistenStartFile,
            ];

            // Init MPV after listeners are registered to catch the ready event
            Bridge.initMpv();
        });

        return () => { unlistenFns.forEach(fn => fn()); };
    }, []); // Run once on mount

    return {
        mpvReady, playing, volume, muted, position, duration, error,
        volumeDraggingRef, seekingRef,
        setError, setPlaying, setPosition, setVolume, setMuted,
        setDuration, setMpvReady,
    };
}
