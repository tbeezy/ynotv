import { useState, useEffect, useCallback, useRef } from 'react';
import type { WatchlistItem } from '../db';
import { db, getWatchlist } from '../db';
import type { WatchlistNotificationItem } from '../components/WatchlistNotification';
import type { StoredChannel } from '../db';

export interface WatchlistState {
  // Watchlist state
  watchlistItems: WatchlistItem[];
  watchlistRefreshTrigger: number;
  watchlistNotifications: WatchlistNotificationItem[];

  // Actions
  setWatchlistItems: (items: WatchlistItem[]) => void;
  setWatchlistRefreshTrigger: (trigger: number | ((prev: number) => number)) => void;
  setWatchlistNotifications: (notifications: WatchlistNotificationItem[] | ((prev: WatchlistNotificationItem[]) => WatchlistNotificationItem[])) => void;
  refreshWatchlist: () => void;
  handleWatchlistSwitch: (notification: WatchlistNotificationItem, handlePlayChannel: (channel: StoredChannel) => void) => Promise<void>;
  handleWatchlistDismiss: (id: number) => void;
}

interface UseWatchlistOptions {
  onAutoswitch?: (channel: StoredChannel, item: WatchlistItem) => void;
}

export function useWatchlist(options: UseWatchlistOptions = {}): WatchlistState {
  const { onAutoswitch } = options;
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([]);
  const [watchlistRefreshTrigger, setWatchlistRefreshTrigger] = useState(0);
  const [watchlistNotifications, setWatchlistNotifications] = useState<WatchlistNotificationItem[]>([]);

  // Fetch watchlist when refresh is triggered
  useEffect(() => {
    const loadWatchlist = async () => {
      const items = await getWatchlist();
      setWatchlistItems(items);
    };
    loadWatchlist();
  }, [watchlistRefreshTrigger]);

  // Listen for watchlist updates from other components (EPG context menu, etc.)
  useEffect(() => {
    const handleWatchlistUpdate = () => {
      setWatchlistRefreshTrigger(v => v + 1);
    };
    window.addEventListener('watchlist-updated', handleWatchlistUpdate);
    return () => window.removeEventListener('watchlist-updated', handleWatchlistUpdate);
  }, []);

  // Background timer for watchlist reminders and autoswitch
  useEffect(() => {
    const checkWatchlist = async () => {
      // Clear expired items first
      const { clearExpiredWatchlist } = await import('../db');
      await clearExpiredWatchlist();

      const now = Date.now();
      const items = await getWatchlist();

      for (const item of items) {
        const startTime = item.start_time;
        const reminderTime = startTime - (item.reminder_minutes * 60 * 1000);

        // Check if reminder should be shown
        if (item.reminder_enabled && !item.reminder_shown && now >= reminderTime && now < startTime + 30000) {
          console.log('[useWatchlist] Reminder:', item.program_title);
          const notification: WatchlistNotificationItem = {
            id: Date.now() + (item.id || 0),
            watchlistId: item.id || 0,
            programTitle: item.program_title,
            channelName: item.channel_name,
            channelId: item.channel_id,
            sourceId: item.source_id,
            startTime: item.start_time,
            type: 'reminder',
          };
          setWatchlistNotifications(prev => [...prev, notification]);

          const { markReminderShown } = await import('../db');
          await markReminderShown(item.id!);
        }

        // Check if autoswitch should trigger
        const secondsBefore = item.autoswitch_seconds_before ?? 0;
        const autoswitchTime = startTime - (secondsBefore * 1000);
        if (item.autoswitch_enabled && !item.autoswitch_triggered && now >= autoswitchTime && now < startTime + 60000) {
          console.log('[useWatchlist] Auto-switch triggered for:', item.program_title);

          // Mark as triggered
          const { markAutoswitchTriggered } = await import('../db');
          await markAutoswitchTriggered(item.id!);

          // Actually perform the autoswitch if callback is provided
          if (onAutoswitch) {
            try {
              const channel = await db.channels.get(item.channel_id);
              if (channel) {
                onAutoswitch(channel, item);
              }
            } catch (error) {
              console.error('[useWatchlist] Auto-switch failed:', error);
            }
          }

          // Create notification for autoswitch
          const notification: WatchlistNotificationItem = {
            id: Date.now() + (item.id || 0) + 1000,
            watchlistId: item.id || 0,
            programTitle: item.program_title,
            channelName: item.channel_name,
            channelId: item.channel_id,
            sourceId: item.source_id,
            startTime: item.start_time,
            type: 'autoswitch',
          };
          setWatchlistNotifications(prev => [...prev, notification]);
        }
      }
    };

    checkWatchlist();
    const interval = setInterval(checkWatchlist, 10000);
    return () => clearInterval(interval);
  }, []);

  const refreshWatchlist = useCallback(() => {
    setWatchlistRefreshTrigger(v => v + 1);
  }, []);

  const handleWatchlistSwitch = useCallback(async (notification: WatchlistNotificationItem, handlePlayChannel: (channel: StoredChannel) => void) => {
    try {
      const channel = await db.channels.get(notification.channelId);
      if (channel) {
        handlePlayChannel(channel);
      }
    } catch (error) {
      console.error('Failed to switch to watchlist channel:', error);
    }
  }, []);

  const handleWatchlistDismiss = useCallback((id: number) => {
    setWatchlistNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  return {
    watchlistItems,
    watchlistRefreshTrigger,
    watchlistNotifications,
    setWatchlistItems,
    setWatchlistRefreshTrigger,
    setWatchlistNotifications,
    refreshWatchlist,
    handleWatchlistSwitch,
    handleWatchlistDismiss,
  };
}
