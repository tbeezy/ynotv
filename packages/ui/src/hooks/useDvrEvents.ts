/**
 * useDvrEvents.ts
 *
 * Subscribes to the Tauri `dvr:event` channel and logs recording lifecycle
 * events (started / completed / failed). Previously a useEffect in App.tsx.
 *
 * This intentionally does NO state management — it is a pure side-effect
 * listener so the caller doesn't need to handle any returned values.
 * In the future, return a `recentEvents` array here when toast notifications
 * are wired up.
 */

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';

interface DvrEventPayload {
    event_type: 'started' | 'completed' | 'failed' | string;
    schedule_id: number;
    recording_id?: number;
    channel_name: string;
    program_title: string;
    message?: string;
}

/**
 * Registers a `dvr:event` listener for the lifetime of the component.
 *
 * Call once at the app root level (e.g. inside App.tsx).
 * The listener is automatically removed when the component unmounts.
 */
export function useDvrEvents(): void {
    useEffect(() => {
        let unlistenFn: (() => void) | undefined;

        const setup = async () => {
            try {
                const unlisten = await listen<DvrEventPayload>('dvr:event', (event) => {
                    const data = event.payload;
                    console.log('[DVR Event]', data.event_type, data);

                    // Show toast notification for recording events
                    if (data.event_type === 'started') {
                        console.log(`[DVR] Started recording: ${data.program_title}`);
                    } else if (data.event_type === 'completed') {
                        console.log(`[DVR] Completed recording: ${data.program_title}`);
                    } else if (data.event_type === 'failed') {
                        console.error(`[DVR] Failed recording: ${data.program_title}`, data.message);
                    }
                });

                unlistenFn = unlisten;
            } catch (error) {
                console.error('[useDvrEvents] Failed to setup DVR listener:', error);
            }
        };

        setup();

        return () => {
            unlistenFn?.();
        };
    }, []);
}
