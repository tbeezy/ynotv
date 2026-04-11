import { useState, useEffect, useCallback, useRef } from 'react';
import type { SportsEvent } from '@ynotv/core';
import { getLiveScores } from '../services/sports';
import { DEFAULT_LIVE_LEAGUES } from '../services/sports/config';

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

// Global cache to persist data across component mounts and navigation
// Store on window to survive module reloads in dev mode
interface SportsCache {
  events: SportsEvent[];
  lastUpdated: Date | null;
  leagues: string[] | undefined;
}

const getSportsCache = (): SportsCache => {
  const w = window as unknown as { __sportsCache?: SportsCache };
  if (!w.__sportsCache) {
    console.log('[SportsPolling] Creating new cache on window');
    w.__sportsCache = {
      events: [],
      lastUpdated: null,
      leagues: undefined,
    };
  }
  return w.__sportsCache;
};

// Global flag to prevent multiple hook instances from fetching simultaneously
const isGlobalFetching = (): boolean => {
  return !!(window as unknown as { __sportsFetching?: boolean }).__sportsFetching;
};

const setGlobalFetching = (value: boolean): void => {
  (window as unknown as { __sportsFetching?: boolean }).__sportsFetching = value;
};

// How long cache is considered fresh (5 minutes if no live games, 30s if live)
const CACHE_FRESH_NO_LIVE = 5 * 60 * 1000;
const CACHE_FRESH_LIVE = 30 * 1000;

export function useSportsPolling(options: UseSportsPollingOptions = {}): UseSportsPollingResult {
  const { pollingInterval = 30000, enabled = true, leagues } = options;

  const [events, setEvents] = useState<SportsEvent[]>(() => {
    // Initialize from cache if available and fresh — even if leagues don't match yet
    // (leagues may still be loading from settings). We prefer showing stale data
    // over an empty flash while the real fetch runs in the background.
    const cache = getSportsCache();
    if (cache.events.length > 0) {
      return cache.events;
    }
    return [];
  });
  const [loading, setLoading] = useState(() => {
    const cache = getSportsCache();
    return cache.events.length === 0;
  });
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(() => {
    const cache = getSportsCache();
    return cache.lastUpdated;
  });
  const [isPolling, setIsPolling] = useState(false);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRefreshingRef = useRef(false);

  const hasLiveGames = events.some(e => e.status === 'live');

  // Normalize leagues for comparison (undefined = default leagues)
  const normalizedLeagues = leagues ?? DEFAULT_LIVE_LEAGUES;

  // Sync with cache on mount (in case cache was populated by another instance)
  useEffect(() => {
    const cache = getSportsCache();
    if (cache.events.length > 0 && events.length === 0) {
      console.log('[SportsPolling] Syncing state from cache on mount:', cache.events.length, 'events');
      setEvents(cache.events);
      setLastUpdated(cache.lastUpdated);
      setLoading(false);
    }
  }, []);

  const fetchData = useCallback(async (isManualRefresh = false) => {
    if (isRefreshingRef.current && !isManualRefresh) return;
    if (!isManualRefresh && isGlobalFetching()) {
      console.log('[SportsPolling] Another instance is already fetching, skipping');
      return;
    }

    isRefreshingRef.current = true;
    setGlobalFetching(true);

    if (isManualRefresh) {
      setLoading(true);
    }

    setError(null);

    try {
      // Read the LATEST cache state directly from window (not the closure variable)
      // This ensures we see any updates from other instances
      const latestCache = (window as unknown as { __sportsCache?: SportsCache }).__sportsCache;
      const currentCacheEvents = latestCache?.events ?? [];

      // Track if we've received any data during batch fetching
      let hasReceivedData = false;

      // Progressive callback - update UI immediately as batches complete
      const onProgress = (batchEvents: SportsEvent[], batchIndex: number, totalBatches: number) => {
        hasReceivedData = batchEvents.length > 0 || hasReceivedData;

        // Update React state immediately with batch results
        setEvents(batchEvents);
        setLastUpdated(new Date());

        // Update global cache progressively if we have data
        // This allows other components/tabs to see results immediately
        if (batchEvents.length > 0 || currentCacheEvents.length === 0) {
          const cache = getSportsCache();
          cache.events = batchEvents;
          cache.lastUpdated = new Date();
          cache.leagues = normalizedLeagues;
          console.log(`[SportsPolling] Batch ${batchIndex + 1}/${totalBatches}: Updated cache with`,
            batchEvents.length, 'events,', batchEvents.filter(e => e.status === 'live').length, 'live');
        }
      };

      // Use normalized leagues (undefined becomes DEFAULT_LIVE_LEAGUES)
      // This will call onProgress after each batch completes
      const data = await getLiveScores(normalizedLeagues, onProgress);

      // Final update after all batches complete
      // Don't update if we got empty data and cache already has data (unless manual refresh)
      if (data.length === 0 && currentCacheEvents.length > 0 && !isManualRefresh && !hasReceivedData) {
        console.log('[SportsPolling] Skipping empty response, keeping', currentCacheEvents.length, 'cached events');
        return;
      }

      // Final state update (already updated by onProgress, but ensure consistency)
      setEvents(data);
      setLastUpdated(new Date());

      // Final cache update
      if (data.length > 0 || isManualRefresh || currentCacheEvents.length === 0) {
        const cache = getSportsCache();
        cache.events = data;
        cache.lastUpdated = new Date();
        cache.leagues = normalizedLeagues;
        console.log('[SportsPolling] Final: Updated cache with', data.length, 'events,', data.filter(e => e.status === 'live').length, 'live');
      } else {
        console.log('[SportsPolling] NOT updating cache - empty data and existing cache has', currentCacheEvents.length, 'events');
      }
    } catch (err) {
      console.error('[SportsPolling] Failed to fetch:', err);
      setError('Failed to load scores. Retrying...');
    } finally {
      setLoading(false);
      isRefreshingRef.current = false;
      setGlobalFetching(false);
    }
  }, [normalizedLeagues]);

  const refresh = useCallback(async () => {
    await fetchData(true);
  }, [fetchData]);

// Helper to compare leagues arrays (order-independent)
function leaguesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return JSON.stringify(sortedA) === JSON.stringify(sortedB);
}

  // Check if cache is fresh enough to skip initial fetch
  const isCacheFresh = useCallback(() => {
    const cache = getSportsCache();
    if (!cache.lastUpdated) return false;
    const age = Date.now() - cache.lastUpdated.getTime();
    const hasLive = cache.events.some(e => e.status === 'live');
    const freshDuration = hasLive ? CACHE_FRESH_LIVE : CACHE_FRESH_NO_LIVE;
    const isFresh = age < freshDuration;
    console.log('[SportsPolling] Cache check:', {
      age: Math.round(age / 1000) + 's',
      hasLive,
      freshDuration: Math.round(freshDuration / 1000) + 's',
      isFresh,
    });
    return isFresh;
  }, []);

  // Initial fetch - only if cache is empty, stale, or leagues changed
  useEffect(() => {
    const cache = getSportsCache();
    // Normalize cached leagues for comparison
    const cachedLeaguesNormalized = cache.leagues ?? DEFAULT_LIVE_LEAGUES;
    const leaguesChanged = !leaguesEqual(cachedLeaguesNormalized, normalizedLeagues);

    const cacheExists = cache.events.length > 0;
    const fresh = isCacheFresh();

    console.log('[SportsPolling] Initial fetch check:', {
      cacheExists,
      eventsCount: cache.events.length,
      windowCacheExists: !!(window as unknown as { __sportsCache?: SportsCache }).__sportsCache,
      isFresh: fresh,
      leaguesChanged,
      cachedLeaguesCount: cachedLeaguesNormalized?.length,
      currentLeaguesCount: normalizedLeagues?.length,
      cachedLeagues: cachedLeaguesNormalized?.slice(0, 3),
      currentLeagues: normalizedLeagues?.slice(0, 3),
    });

    if (cacheExists && fresh && !leaguesChanged) {
      console.log('[SportsPolling] Using cached data');
      return;
    }

    if (!cacheExists) {
      console.log('[SportsPolling] No cache, fetching...');
    } else if (!fresh) {
      const age = Date.now() - (cache.lastUpdated?.getTime() || 0);
      console.log('[SportsPolling] Cache stale (age: ' + Math.round(age/1000) + 's), fetching...');
    } else if (leaguesChanged) {
      console.log('[SportsPolling] Leagues changed, fetching...');
    }

    // Cache hit but leagues changed — fetch silently in background (don't flash empty)
    // Small delay to allow any in-flight requests from other instances to complete
    const timer = setTimeout(() => {
      const latestCache = getSportsCache();
      if (latestCache.events.length > 0 && isCacheFresh() && !leaguesChanged) {
        console.log('[SportsPolling] Cache populated by another instance, using cached data');
        return;
      }
      fetchData();
    }, 100);

    return () => clearTimeout(timer);
  }, [fetchData, isCacheFresh, normalizedLeagues]);

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

  // Visibility change handler - refresh when tab becomes visible only if cache is stale
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        const cache = getSportsCache();
        // Check the GLOBAL CACHE directly, not React state
        // This ensures we don't refetch just because component remounted
        if (!cache.lastUpdated) {
          console.log('[SportsPolling] Tab visible, no cache exists, fetching...');
          fetchData();
          return;
        }
        const age = Date.now() - cache.lastUpdated.getTime();
        const hasLive = cache.events.some(e => e.status === 'live');
        const isFresh = age < (hasLive ? CACHE_FRESH_LIVE : CACHE_FRESH_NO_LIVE);

        if (!isFresh) {
          console.log('[SportsPolling] Tab visible, cache stale (age: ' + Math.round(age/1000) + 's), refreshing...');
          fetchData();
        } else {
          console.log('[SportsPolling] Tab visible, cache fresh (age: ' + Math.round(age/1000) + 's), skipping fetch');
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchData]);

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
