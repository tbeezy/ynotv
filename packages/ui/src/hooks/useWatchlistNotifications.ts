import { useState, useEffect } from 'react';
import { db } from '../db';
import { addToRecentChannels } from '../utils/recentChannels';
import type { WatchlistNotificationItem } from '../components/WatchlistNotification';
import type { StoredChannel } from '../db';

/**
 * Polls the watchlist every 10 seconds, fires reminder notifications,
 * and auto-switches the player when the autoswitch time arrives.
 *
 * Extracted from App.tsx lines ~860-932.
 *
 * @param onPlayChannel Called when autoswitch triggers — load the channel in MPV.
 */
export function useWatchlistNotifications(
    onPlayChannel: (channel: StoredChannel) => void
) {
    const [notifications, setNotifications] = useState<WatchlistNotificationItem[]>([]);

    const dismiss = (id: number) =>
        setNotifications(prev => prev.filter(n => n.id !== id));

    useEffect(() => {
        const checkWatchlist = async () => {
            const { clearExpiredWatchlist, getWatchlist, markReminderShown, markAutoswitchTriggered } =
                await import('../db');

            await clearExpiredWatchlist();
            const items = await getWatchlist();
            const now = Date.now();

            for (const item of items) {
                const { start_time: startTime, reminder_minutes, reminder_enabled,
                    reminder_shown, autoswitch_enabled, autoswitch_triggered,
                    autoswitch_seconds_before } = item;

                // ── Reminder notification ────────────────────────────────────────
                const reminderTime = startTime - (reminder_minutes * 60_000);
                if (
                    reminder_enabled && !reminder_shown &&
                    now >= reminderTime && now < startTime + 30_000
                ) {
                    setNotifications(prev => [...prev, {
                        id: Date.now() + (item.id ?? 0),
                        watchlistId: item.id ?? 0,
                        programTitle: item.program_title,
                        channelName: item.channel_name,
                        channelId: item.channel_id,
                        sourceId: item.source_id,
                        startTime,
                        type: 'reminder',
                    }]);
                    await markReminderShown(item.id!);
                }

                // ── Auto-switch ──────────────────────────────────────────────────
                const secBefore = autoswitch_seconds_before ?? 0;
                const autoswitchAt = startTime - secBefore * 1_000;
                if (
                    autoswitch_enabled && !autoswitch_triggered &&
                    now >= autoswitchAt && now < startTime + 60_000
                ) {
                    try {
                        const channel = await db.channels.get(item.channel_id);
                        if (channel) {
                            addToRecentChannels(channel);
                            onPlayChannel(channel);
                            setNotifications(prev => [...prev, {
                                id: Date.now() + (item.id ?? 0) + 1000,
                                watchlistId: item.id ?? 0,
                                programTitle: item.program_title,
                                channelName: item.channel_name,
                                channelId: item.channel_id,
                                sourceId: item.source_id,
                                startTime,
                                type: 'autoswitch',
                            }]);
                        }
                    } catch (err) {
                        console.error('[Watchlist] Auto-switch failed:', err);
                    }
                    await markAutoswitchTriggered(item.id!);
                }
            }
        };

        checkWatchlist();
        const interval = setInterval(checkWatchlist, 10_000);
        return () => clearInterval(interval);
    }, []); // Only attaches once — onPlayChannel accessed via stable closure

    return { notifications, dismiss };
}
