/**
 * useDvrUrlResolver.ts
 *
 * Subscribes to the Tauri `dvr:resolve_url_now` event and resolves Stalker
 * stream URLs on behalf of the DVR scheduler.
 *
 * Background: Stalker portal tokens expire quickly, so the Rust DVR scheduler
 * cannot store them ahead of time. Instead it fires `dvr:resolve_url_now`
 * just before a recording starts so the frontend can call the Stalker API
 * and write the resolved URL back via the `update_dvr_stream_url` command.
 *
 * Previously this was an inline useEffect in App.tsx.
 * Extracted here to keep App.tsx focused on UI orchestration.
 */

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { resolvePlayUrl } from '../services/stream-resolver';
import { db } from '../db';

interface DvrResolveUrlPayload {
    schedule_id: number;
    channel_id: string;
    source_id: string;
}

/**
 * Registers a `dvr:resolve_url_now` listener for the lifetime of the component.
 *
 * Call once at the app root level (e.g. inside App.tsx).
 * The listener is automatically removed when the component unmounts.
 */
export function useDvrUrlResolver(): void {
    useEffect(() => {
        let unlistenFn: (() => void) | undefined;

        const setup = async () => {
            try {
                const unlisten = await listen<DvrResolveUrlPayload>(
                    'dvr:resolve_url_now',
                    async (event) => {
                        const { schedule_id, channel_id, source_id } = event.payload;

                        try {
                            // Get channel info from database
                            const channel = await db.channels.get(channel_id);

                            // Only Stalker channels need URL pre-resolution
                            if (!channel?.direct_url?.startsWith('stalker_')) {
                                return;
                            }

                            if (!window.storage) {
                                console.error('[useDvrUrlResolver] Storage API not available');
                                return;
                            }

                            // resolvePlayUrl handles Stalker token resolution via StalkerClient
                            const resolved = await resolvePlayUrl(source_id, channel.direct_url);

                            // Update the schedule with the resolved URL so the recorder can use it
                            await invoke('update_dvr_stream_url', {
                                scheduleId: schedule_id,
                                streamUrl: resolved.url,
                            });
                        } catch (error) {
                            console.error('[useDvrUrlResolver] Failed to resolve URL:', error);
                        }
                    },
                );

                unlistenFn = unlisten;
            } catch (error) {
                console.error('[useDvrUrlResolver] Failed to setup listener:', error);
            }
        };

        setup();

        return () => {
            unlistenFn?.();
        };
    }, []);
}
