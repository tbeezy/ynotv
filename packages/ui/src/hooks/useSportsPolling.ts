import { useState, useEffect, useCallback, useRef } from 'react';
import { formatTime } from '../utils/dateTime';
import i18n from '../i18n';
import type { SportsEvent } from '@ynotv/core';
import { getLiveScores, getLiveScoresForLeagues, isEventLiveOrPastStart } from '../services/sports';
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
  progress: { completed: number; total: number } | null;
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

// Global listeners to sync active hook instances
const getListeners = (): Set<(cache: SportsCache) => void> => {
  const w = window as unknown as { __sportsCacheListeners?: Set<(cache: SportsCache) => void> };
  if (!w.__sportsCacheListeners) {
    w.__sportsCacheListeners = new Set();
  }
  return w.__sportsCacheListeners;
};

const notifySportsCacheUpdate = (cache: SportsCache) => {
  const listeners = getListeners();
  listeners.forEach(listener => {
    try {
      listener(cache);
    } catch (err) {
      console.error('[SportsPolling] Listener error:', err);
    }
  });
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

// How long to cache non-live leagues (5 minutes)
const CACHE_FRESH_NON_LIVE_LEAGUE = 5 * 60 * 1000;

// Per-league cache to track when each league was last fetched
interface LeagueCacheEntry {
  lastFetched: number;
  hasLive: boolean;
}

const getLeaguesCache = (): Map<string, LeagueCacheEntry> => {
  const w = window as unknown as { __sportsLeaguesCache?: Map<string, LeagueCacheEntry> };
  if (!w.__sportsLeaguesCache) {
    w.__sportsLeaguesCache = new Map();
  }
  return w.__sportsLeaguesCache;
};

/**
 * Get the set of league IDs that have live games from the given events
 */
function getLeaguesWithLiveGames(events: SportsEvent[]): Set<string> {
  const liveLeagues = new Set<string>();
  for (const event of events) {
    if (isEventLiveOrPastStart(event)) {
      liveLeagues.add(event.league.id);
    }
  }
  return liveLeagues;
}

/**
 * Determine which leagues need to be fetched based on:
 * 1. Leagues with live games (always fetch these)
 * 2. Leagues not in cache or with stale cache
 */
function getLeaguesToFetch(
  allLeagues: string[],
  events: SportsEvent[],
  isPolling: boolean
): string[] {
  // If not polling (initial load or manual refresh), fetch all
  if (!isPolling) {
    return allLeagues;
  }

  const now = Date.now();
  const leaguesCache = getLeaguesCache();
  const liveLeagues = getLeaguesWithLiveGames(events);

  // Find leagues that need fetching
  const toFetch: string[] = [];

  for (const leagueId of allLeagues) {
    const cacheEntry = leaguesCache.get(leagueId);
    const hasLive = liveLeagues.has(leagueId);

    if (hasLive) {
      // Always fetch leagues with live games during polling
      toFetch.push(leagueId);
    } else if (!cacheEntry || (now - cacheEntry.lastFetched > CACHE_FRESH_NON_LIVE_LEAGUE)) {
      // Fetch non-live leagues only if cache is stale (>5 min)
      toFetch.push(leagueId);
    }
  }

  console.log('[SportsPolling] Selective fetch:', {
    total: allLeagues.length,
    toFetch: toFetch.length,
    liveLeagues: Array.from(liveLeagues),
    cached: allLeagues.filter(id => {
      const entry = leaguesCache.get(id);
      return entry && !liveLeagues.has(id) && (now - entry.lastFetched <= CACHE_FRESH_NON_LIVE_LEAGUE);
    }),
  });

  return toFetch;
}

/**
 * Update league cache after fetching
 */
function updateLeaguesCache(events: SportsEvent[], allLeagues: string[]): void {
  const now = Date.now();
  const leaguesCache = getLeaguesCache();
  const liveLeagues = getLeaguesWithLiveGames(events);

  // Update cache for all leagues that were fetched
  for (const leagueId of allLeagues) {
    const hasLive = liveLeagues.has(leagueId);
    leaguesCache.set(leagueId, {
      lastFetched: now,
      hasLive,
    });
  }
}

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
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);

  // Normalize leagues for comparison (undefined = default leagues)
  const normalizedLeagues = leagues ?? DEFAULT_LIVE_LEAGUES;

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRefreshingRef = useRef(false);

  // Use refs for values that fetchData needs, so fetchData can be stable
  const normalizedLeaguesRef = useRef(normalizedLeagues);
  normalizedLeaguesRef.current = normalizedLeagues;

  const eventsRef = useRef(events);
  eventsRef.current = events;

  const hasLiveGames = events.some(isEventLiveOrPastStart);

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

  // Listen to updates from other instances updating the cache
  useEffect(() => {
    const listener = (newCache: SportsCache) => {
      setEvents(newCache.events);
      setLastUpdated(newCache.lastUpdated);
    };
    getListeners().add(listener);
    return () => {
      getListeners().delete(listener);
    };
  }, []);

  const fetchData = useCallback(async (isManualRefresh = false, isPolling = false) => {
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

    // Use refs to get latest values without creating dependency churn
    const leagues = normalizedLeaguesRef.current;
    const currentEventsFromState = eventsRef.current;

    try {
      // Read the LATEST cache state directly from window (not the closure variable)
      // This ensures we see any updates from other instances
      const latestCache = (window as unknown as { __sportsCache?: SportsCache }).__sportsCache;
      const currentCacheEvents = latestCache?.events ?? [];

      // Get current events (either from state or cache) to determine which leagues have live games
      const currentEvents = currentEventsFromState.length > 0 ? currentEventsFromState : currentCacheEvents;

      // Determine which leagues to fetch
      const leaguesToFetch = getLeaguesToFetch(leagues, currentEvents, isPolling);

      // Set initial progress
      setProgress({ completed: 0, total: leaguesToFetch.length > 0 ? leaguesToFetch.length : leagues.length });

      // Track if we've received any data during batch fetching
      let hasReceivedData = false;

      // Progressive callback - update UI immediately as batches complete
      const onProgress = (
        batchEvents: SportsEvent[],
        batchIndex: number,
        totalBatches: number,
        completedApis: number,
        totalApis: number
      ) => {
        hasReceivedData = batchEvents.length > 0 || hasReceivedData;
        setProgress({ completed: completedApis, total: totalApis });

        // Only update React state and global cache if we have actual data or no prior cache.
        // This prevents temporarily wiping events to [] when an early batch returns empty.
        if (batchEvents.length > 0 || currentCacheEvents.length === 0) {
          // Update React state immediately with batch results
          setEvents(batchEvents);
          setLastUpdated(new Date());

          // Update global cache progressively if we have data
          // This allows other components/tabs to see results immediately
          const cache = getSportsCache();
          cache.events = batchEvents;
          cache.lastUpdated = new Date();
          cache.leagues = leagues;
          console.log(`[SportsPolling] Batch ${batchIndex + 1}/${totalBatches}: Updated cache with`,
            batchEvents.length, 'events,', batchEvents.filter(e => e.status === 'live').length, 'live');
          notifySportsCacheUpdate(cache);
        }
      };

      let data: SportsEvent[];

      if (isPolling && leaguesToFetch.length < leagues.length) {
        // Selective polling - only fetch leagues that need updates
        console.log(`[SportsPolling] Selective poll: fetching ${leaguesToFetch.length}/${leagues.length} leagues`);
        data = await getLiveScoresForLeagues(leaguesToFetch, currentEvents, onProgress);
      } else {
        // Full fetch - all leagues (initial load, manual refresh, or all leagues need updates)
        console.log(`[SportsPolling] Full fetch: all ${leagues.length} leagues`);
        data = await getLiveScores(leagues, onProgress, currentEvents);
      }

      // Update per-league cache
      updateLeaguesCache(data, leagues);

      // Final update after all batches complete
      // Don't update if we got empty data and cache already has data (unless manual refresh)
      if (data.length === 0 && currentCacheEvents.length > 0 && !isManualRefresh && !hasReceivedData) {
        console.log('[SportsPolling] Skipping empty response, keeping', currentCacheEvents.length, 'cached events');
        return;
      }

      // Final state update (already updated by onProgress, but ensure consistency)
      // Only update state/cache when we actually have data or it's a manual refresh / empty cache.
      if (data.length > 0 || isManualRefresh || currentCacheEvents.length === 0) {
        setEvents(data);
        setLastUpdated(new Date());

        // Final cache update
        const cache = getSportsCache();
        cache.events = data;
        cache.lastUpdated = new Date();
        cache.leagues = leagues;
        console.log('[SportsPolling] Final: Updated cache with', data.length, 'events,', data.filter(e => e.status === 'live').length, 'live');
        notifySportsCacheUpdate(cache);
      } else {
        console.log('[SportsPolling] NOT updating cache - empty data and existing cache has', currentCacheEvents.length, 'events');
      }
    } catch (err) {
      console.error('[SportsPolling] Failed to fetch:', err);
      setError(i18n.t('sports:failedToLoadScores'));
    } finally {
      setLoading(false);
      setProgress(null);
      isRefreshingRef.current = false;
      setGlobalFetching(false);
    }
  }, []); // Stable callback - reads latest values from refs

  // Keep a ref to the latest fetchData so the interval always calls the current version
  const fetchDataRef = useRef(fetchData);
  fetchDataRef.current = fetchData;

  const refresh = useCallback(async () => {
    await fetchDataRef.current(true);
  }, []);

// Helper to compare leagues arrays (order-independent)
function leaguesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return JSON.stringify(sortedA) === JSON.stringify(sortedB);
}

  // Track the last leagues we actually fetched so we don't loop on stale effect re-runs
  const lastFetchedLeaguesRef = useRef<string[] | undefined>(undefined);

  // Check if cache is fresh enough to skip initial fetch
  const isCacheFresh = useCallback(() => {
    const cache = getSportsCache();
    if (!cache.lastUpdated) return false;
    const age = Date.now() - cache.lastUpdated.getTime();
    const hasLive = cache.events.some(isEventLiveOrPastStart);
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

  // Initial fetch - only if enabled, cache is empty/stale, or leagues changed
  useEffect(() => {
    if (!enabled) {
      console.log('[SportsPolling] Disabled, skipping initial fetch');
      return;
    }

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

    // If we already fetched for these exact leagues recently, don't refetch
    if (lastFetchedLeaguesRef.current && leaguesEqual(lastFetchedLeaguesRef.current, normalizedLeagues)) {
      console.log('[SportsPolling] Already fetched for these leagues, skipping');
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
      lastFetchedLeaguesRef.current = [...normalizedLeagues];
      fetchDataRef.current();
    }, 100);

    return () => clearTimeout(timer);
  }, [enabled, isCacheFresh, normalizedLeagues]);

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
        // Pass isPolling=true for selective fetching (only leagues with live games)
        fetchDataRef.current(false, true);
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
  }, [enabled, hasLiveGames, events.length, pollingInterval]);

  // Visibility change handler - refresh when tab becomes visible only if cache is stale
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        const cache = getSportsCache();
        // Check the GLOBAL CACHE directly, not React state
        // This ensures we don't refetch just because component remounted
        if (!cache.lastUpdated) {
          console.log('[SportsPolling] Tab visible, no cache exists, fetching...');
          fetchDataRef.current();
          return;
        }
        const age = Date.now() - cache.lastUpdated.getTime();
        const hasLive = cache.events.some(isEventLiveOrPastStart);
        const isFresh = age < (hasLive ? CACHE_FRESH_LIVE : CACHE_FRESH_NO_LIVE);

        if (!isFresh) {
          console.log('[SportsPolling] Tab visible, cache stale (age: ' + Math.round(age/1000) + 's), refreshing...');
          fetchDataRef.current();
        } else {
          console.log('[SportsPolling] Tab visible, cache fresh (age: ' + Math.round(age/1000) + 's), skipping fetch');
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return {
    events,
    loading,
    error,
    lastUpdated,
    refresh,
    isPolling,
    progress,
  };
}

// Helper to format the last updated time
export function formatLastUpdated(date: Date | null, hour12: boolean = true): string {
  if (!date) return '';

  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);

  if (seconds < 10) return i18n.t('time:justNow');
  if (seconds < 60) return i18n.t('time:secAgo', { count: seconds });
  if (minutes < 60) return i18n.t('time:mAgo', { count: minutes });

  return formatTime(date, {
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  });
}
