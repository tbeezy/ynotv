import { useState, useEffect, useCallback, useRef } from 'react';
import type { SportsEvent } from '@ynotv/core';
import { getUpcomingEvents } from '../services/sports';
import { DEFAULT_UPCOMING_LEAGUES } from '../services/sports/config';

interface UseUpcomingOptions {
  daysAhead?: number;
  enabled?: boolean;
  leagues?: string[];
}

interface UseUpcomingResult {
  events: SportsEvent[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => Promise<void>;
}

// Global cache to persist data across component mounts and navigation
interface UpcomingCache {
  events: SportsEvent[];
  lastUpdated: Date | null;
  leagues: string[] | undefined;
  daysAhead: number;
  cachedDate: string; // Store the date when cache was saved (for "new day" detection)
}

const CACHE_KEY = '__upcomingCache';

const getUpcomingCache = (): UpcomingCache => {
  const w = window as unknown as { [CACHE_KEY]?: UpcomingCache };
  if (!w[CACHE_KEY]) {
    console.log('[UpcomingSports] Creating new cache on window');
    w[CACHE_KEY] = {
      events: [],
      lastUpdated: null,
      leagues: undefined,
      daysAhead: 3,
      cachedDate: '',
    };
  }
  return w[CACHE_KEY];
};

// Global flag to prevent multiple hook instances from fetching simultaneously
const isGlobalFetching = (): boolean => {
  return !!(window as unknown as { __upcomingFetching?: boolean }).__upcomingFetching;
};

const setGlobalFetching = (value: boolean): void => {
  (window as unknown as { __upcomingFetching?: boolean }).__upcomingFetching = value;
};

// Cache considered stale after 2 hours (in ms)
const CACHE_STALE_DURATION = 2 * 60 * 60 * 1000;

// Helper to get today's date string for comparison
const getTodayString = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
};

// Helper to compare leagues arrays (order-independent)
function leaguesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return JSON.stringify(sortedA) === JSON.stringify(sortedB);
}

export function useUpcomingSports(options: UseUpcomingOptions = {}): UseUpcomingResult {
  const { daysAhead = 3, enabled = true, leagues } = options;

  const normalizedLeagues = leagues ?? DEFAULT_UPCOMING_LEAGUES;

  const [events, setEvents] = useState<SportsEvent[]>(() => {
    // Initialize from cache if available
    const cache = getUpcomingCache();
    if (cache.events.length > 0) {
      return cache.events;
    }
    return [];
  });
  const [loading, setLoading] = useState(() => {
    const cache = getUpcomingCache();
    return cache.events.length === 0;
  });
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(() => {
    const cache = getUpcomingCache();
    return cache.lastUpdated;
  });

  const isRefreshingRef = useRef(false);

  // Sync with cache on mount (in case cache was populated by another instance)
  useEffect(() => {
    const cache = getUpcomingCache();
    if (cache.events.length > 0 && events.length === 0) {
      console.log('[UpcomingSports] Syncing state from cache on mount:', cache.events.length, 'events');
      setEvents(cache.events);
      setLastUpdated(cache.lastUpdated);
      setLoading(false);
    }
  }, []);

  // Check if cache is stale (older than 2 hours OR different date)
  const isCacheStale = useCallback((): boolean => {
    const cache = getUpcomingCache();
    if (!cache.lastUpdated) return true;

    const age = Date.now() - cache.lastUpdated.getTime();
    const isTooOld = age >= CACHE_STALE_DURATION;
    const isDifferentDay = cache.cachedDate !== getTodayString();

    console.log('[UpcomingSports] Cache check:', {
      age: Math.round(age / 1000) + 's',
      staleDuration: Math.round(CACHE_STALE_DURATION / 1000) + 's',
      isTooOld,
      cachedDate: cache.cachedDate,
      today: getTodayString(),
      isDifferentDay,
      isStale: isTooOld || isDifferentDay,
    });

    return isTooOld || isDifferentDay;
  }, []);

  const fetchData = useCallback(async (isManualRefresh = false) => {
    if (isRefreshingRef.current && !isManualRefresh) return;
    if (!isManualRefresh && isGlobalFetching()) {
      console.log('[UpcomingSports] Another instance is already fetching, skipping');
      return;
    }

    isRefreshingRef.current = true;
    setGlobalFetching(true);

    if (isManualRefresh) {
      setLoading(true);
    }

    setError(null);

    try {
      const data = await getUpcomingEvents(daysAhead, normalizedLeagues);

      // Read the LATEST cache state directly from window
      const latestCache = (window as unknown as { [CACHE_KEY]?: UpcomingCache })[CACHE_KEY];
      const currentCacheEvents = latestCache?.events ?? [];

      // Don't update if we got empty data and cache already has data (unless manual refresh)
      if (data.length === 0 && currentCacheEvents.length > 0 && !isManualRefresh) {
        console.log('[UpcomingSports] Skipping empty response, keeping', currentCacheEvents.length, 'cached events');
        return;
      }

      // Update React state
      setEvents(data);
      setLastUpdated(new Date());

      // Update global cache
      if (data.length > 0 || isManualRefresh || currentCacheEvents.length === 0) {
        const cache = getUpcomingCache();
        cache.events = data;
        cache.lastUpdated = new Date();
        cache.leagues = normalizedLeagues;
        cache.daysAhead = daysAhead;
        cache.cachedDate = getTodayString();
        console.log('[UpcomingSports] Updated cache with', data.length, 'events');
      } else {
        console.log('[UpcomingSports] NOT updating cache - empty data and existing cache has', currentCacheEvents.length, 'events');
      }
    } catch (err) {
      console.error('[UpcomingSports] Failed to fetch:', err);
      setError('Failed to load upcoming games. Retrying...');
    } finally {
      setLoading(false);
      isRefreshingRef.current = false;
      setGlobalFetching(false);
    }
  }, [daysAhead, normalizedLeagues]);

  const refresh = useCallback(async () => {
    await fetchData(true);
  }, [fetchData]);

  // Initial fetch - only if cache is empty, stale, leagues changed, or daysAhead changed
  useEffect(() => {
    if (!enabled) return;

    const cache = getUpcomingCache();
    const cachedLeaguesNormalized = cache.leagues ?? DEFAULT_UPCOMING_LEAGUES;
    const leaguesChanged = !leaguesEqual(cachedLeaguesNormalized, normalizedLeagues);
    const daysAheadChanged = cache.daysAhead !== daysAhead;

    const cacheExists = cache.events.length > 0;
    const stale = isCacheStale();

    console.log('[UpcomingSports] Initial fetch check:', {
      cacheExists,
      eventsCount: cache.events.length,
      isStale: stale,
      leaguesChanged,
      daysAheadChanged,
      cachedDaysAhead: cache.daysAhead,
      currentDaysAhead: daysAhead,
    });

    if (cacheExists && !stale && !leaguesChanged && !daysAheadChanged) {
      console.log('[UpcomingSports] Using cached data');
      return;
    }

    if (!cacheExists) {
      console.log('[UpcomingSports] No cache, fetching...');
    } else if (stale) {
      const age = Date.now() - (cache.lastUpdated?.getTime() || 0);
      console.log('[UpcomingSports] Cache stale (age: ' + Math.round(age/1000) + 's or new day), fetching...');
    } else if (leaguesChanged) {
      console.log('[UpcomingSports] Leagues changed, fetching...');
    } else if (daysAheadChanged) {
      console.log('[UpcomingSports] Days ahead changed, fetching...');
    }

    // Small delay to allow any in-flight requests from other instances to complete
    const timer = setTimeout(() => {
      const latestCache = getUpcomingCache();
      const isStillStale = isCacheStale();
      const stillLeaguesChanged = !leaguesEqual(latestCache.leagues ?? DEFAULT_UPCOMING_LEAGUES, normalizedLeagues);
      const stillDaysAheadChanged = latestCache.daysAhead !== daysAhead;

      if (latestCache.events.length > 0 && !isStillStale && !stillLeaguesChanged && !stillDaysAheadChanged) {
        console.log('[UpcomingSports] Cache populated by another instance, using cached data');
        return;
      }
      fetchData();
    }, 100);

    return () => clearTimeout(timer);
  }, [fetchData, isCacheStale, normalizedLeagues, daysAhead, enabled]);

  // Visibility change handler - refresh when tab becomes visible only if cache is stale
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        const cache = getUpcomingCache();
        if (!cache.lastUpdated) {
          console.log('[UpcomingSports] Tab visible, no cache exists, fetching...');
          fetchData();
          return;
        }

        const isStale = isCacheStale();

        if (isStale) {
          console.log('[UpcomingSports] Tab visible, cache stale, refreshing...');
          fetchData();
        } else {
          const age = Date.now() - cache.lastUpdated.getTime();
          console.log('[UpcomingSports] Tab visible, cache fresh (age: ' + Math.round(age/1000) + 's), skipping fetch');
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchData, isCacheStale]);

  return {
    events,
    loading,
    error,
    lastUpdated,
    refresh,
  };
}
