import { useState, useEffect, useCallback, useRef } from 'react';
import type { SportsEvent } from '@ynotv/core';
import { getLiveScores } from '../services/sports';

interface UseSportsPollingOptions {
  pollingInterval?: number;
  enabled?: boolean;
  leagues?: string[];
}

interface UseSportsPollingResult {
  events: SportsEvent[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => Promise<void>;
  isPolling: boolean;
}

export function useSportsPolling(options: UseSportsPollingOptions = {}): UseSportsPollingResult {
  const { pollingInterval = 30000, enabled = true, leagues } = options;
  
  const [events, setEvents] = useState<SportsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRefreshingRef = useRef(false);

  const hasLiveGames = events.some(e => e.status === 'live');

  const fetchData = useCallback(async (isManualRefresh = false) => {
    if (isRefreshingRef.current && !isManualRefresh) return;
    
    isRefreshingRef.current = true;
    
    if (isManualRefresh) {
      setLoading(true);
    }
    
    setError(null);
    
    try {
      const data = await getLiveScores(leagues);
      setEvents(data);
      setLastUpdated(new Date());
      console.log('[SportsPolling] Fetched', data.length, 'events,', data.filter(e => e.status === 'live').length, 'live');
    } catch (err) {
      console.error('[SportsPolling] Failed to fetch:', err);
      setError('Failed to load scores. Retrying...');
    } finally {
      setLoading(false);
      isRefreshingRef.current = false;
    }
  }, [leagues]);

  const refresh = useCallback(async () => {
    await fetchData(true);
  }, [fetchData]);

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Polling effect
  useEffect(() => {
    if (!enabled) {
      setIsPolling(false);
      return;
    }

    // Only poll if there are live games or we haven't loaded yet
    const shouldPoll = hasLiveGames || events.length === 0;

    if (shouldPoll && !intervalRef.current) {
      console.log('[SportsPolling] Starting poll (30s interval)');
      setIsPolling(true);
      
      intervalRef.current = setInterval(() => {
        // Don't poll if tab is hidden
        if (document.hidden) {
          console.log('[SportsPolling] Tab hidden, skipping poll');
          return;
        }
        fetchData();
      }, pollingInterval);
    } else if (!shouldPoll && intervalRef.current) {
      console.log('[SportsPolling] No live games, stopping poll');
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      setIsPolling(false);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
        setIsPolling(false);
      }
    };
  }, [enabled, hasLiveGames, events.length, pollingInterval, fetchData]);

  // Visibility change handler - refresh when tab becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden && lastUpdated) {
        const timeSinceLastUpdate = Date.now() - lastUpdated.getTime();
        // If more than 30 seconds since last update, refresh immediately
        if (timeSinceLastUpdate > pollingInterval) {
          console.log('[SportsPolling] Tab visible, refreshing...');
          fetchData();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [lastUpdated, pollingInterval, fetchData]);

  return {
    events,
    loading,
    error,
    lastUpdated,
    refresh,
    isPolling,
  };
}

// Helper to format the last updated time
export function formatLastUpdated(date: Date | null): string {
  if (!date) return '';
  
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}
