import { useEffect, useState, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';

export interface TimeshiftState {
    cacheStart: number;   // seconds from start of stream
    cacheEnd: number;     // live edge (seconds from start)
    timePos: number;      // current playback position (seconds from start)
    behindLive: number;   // how far behind live edge we are
    cachedDuration: number; // total cached window size in seconds
}

/**
 * Subscribes to the `timeshift-update` Tauri event emitted by mpv_windows.rs
 * whenever the demuxer-cache-state property changes.
 *
 * Returns null when timeshift is disabled or no cache state is available yet.
 */
export function useTimeshift(enabled: boolean): TimeshiftState | null {
    const [state, setState] = useState<TimeshiftState | null>(null);
    const unlistenRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        if (!enabled) {
            setState(null);
            return;
        }

        let cancelled = false;

        listen<TimeshiftState>('timeshift-update', (event) => {
            if (!cancelled) {
                const payload = event.payload;
                // Only update if we have meaningful cache data
                if (payload.cachedDuration > 1) {
                    setState(payload);
                }
            }
        }).then((unlisten) => {
            if (cancelled) {
                unlisten();
            } else {
                unlistenRef.current = unlisten;
            }
        });

        return () => {
            cancelled = true;
            if (unlistenRef.current) {
                unlistenRef.current();
                unlistenRef.current = null;
            }
            setState(null);
        };
    }, [enabled]);

    return state;
}
