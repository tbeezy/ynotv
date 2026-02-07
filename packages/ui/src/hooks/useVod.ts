import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type StoredMovie, type StoredSeries, type StoredEpisode, type VodCategory } from '../db';
import { syncSeriesEpisodes, syncAllVod, type VodSyncResult } from '../db/sync';
import type { Source } from '../types/electron';
import { useEnabledSources } from './useChannels';

// ===========================================================================
// Movies Hooks
// ===========================================================================

/**
 * Query movies with optional category filter and search
 * Filters out movies from disabled sources
 */
export function useMovies(categoryId?: string | null, search?: string) {
  const enabledSourceIds = useEnabledSources();
  const movies = useLiveQuery(async () => {
    let query = db.vodMovies.toCollection();

    if (categoryId) {
      // Filter by category
      const allMovies = await db.vodMovies.where('category_ids').equals(categoryId).toArray();
      // Only filter by enabled sources if they've loaded
      const filtered = enabledSourceIds ? allMovies.filter(m => enabledSourceIds.has(m.source_id)) : allMovies;
      if (search) {
        const searchLower = search.toLowerCase();
        return filtered.filter(m => m.name.toLowerCase().includes(searchLower));
      }
      return filtered;
    }

    // No category filter
    let allMovies = await query.toArray();
    // Only filter by enabled sources if they've loaded
    if (enabledSourceIds) {
      allMovies = allMovies.filter(m => enabledSourceIds.has(m.source_id));
    }

    if (search) {
      const searchLower = search.toLowerCase();
      allMovies = allMovies.filter(m => m.name.toLowerCase().includes(searchLower));
    }

    return allMovies;
  }, [categoryId, search, enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading']);

  return {
    movies: movies ?? [],
    loading: movies === undefined,
  };
}

/**
 * Get a single movie by ID
 */
export function useMovie(movieId: string | null) {
  const movie = useLiveQuery(
    async () => {
      if (!movieId) return null;
      return db.vodMovies.get(movieId);
    },
    [movieId]
  );

  return {
    movie: movie ?? null,
    loading: movie === undefined,
  };
}

/**
 * Get recently added movies
 */
export function useRecentMovies(limit = 20) {
  const movies = useLiveQuery(async () => {
    return db.vodMovies
      .orderBy('added')
      .reverse()
      .limit(limit)
      .toArray();
  }, [limit]);

  return {
    movies: movies ?? [],
    loading: movies === undefined,
  };
}

// ===========================================================================
// Series Hooks
// ===========================================================================

/**
 * Query series with optional category filter and search
 * Filters out series from disabled sources
 */
export function useSeries(categoryId?: string | null, search?: string) {
  const enabledSourceIds = useEnabledSources();
  const series = useLiveQuery(async () => {
    let query = db.vodSeries.toCollection();

    if (categoryId) {
      // Filter by category
      const allSeries = await db.vodSeries.where('category_ids').equals(categoryId).toArray();
      // Only filter by enabled sources if they've loaded
      const filtered = enabledSourceIds ? allSeries.filter(s => enabledSourceIds.has(s.source_id)) : allSeries;
      if (search) {
        const searchLower = search.toLowerCase();
        return filtered.filter(s => s.name.toLowerCase().includes(searchLower));
      }
      return filtered;
    }

    // No category filter
    let allSeries = await query.toArray();
    // Only filter by enabled sources if they've loaded
    if (enabledSourceIds) {
      allSeries = allSeries.filter(s => enabledSourceIds.has(s.source_id));
    }

    if (search) {
      const searchLower = search.toLowerCase();
      allSeries = allSeries.filter(s => s.name.toLowerCase().includes(searchLower));
    }

    return allSeries;
  }, [categoryId, search, enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading']);

  return {
    series: series ?? [],
    loading: series === undefined,
  };
}

/**
 * Get a single series by ID
 */
export function useSeriesById(seriesId: string | null) {
  const series = useLiveQuery(
    async () => {
      if (!seriesId) return null;
      return db.vodSeries.get(seriesId);
    },
    [seriesId]
  );

  return {
    series: series ?? null,
    loading: series === undefined,
  };
}

/**
 * Get recently added series
 */
export function useRecentSeries(limit = 20) {
  const series = useLiveQuery(async () => {
    return db.vodSeries
      .orderBy('added')
      .reverse()
      .limit(limit)
      .toArray();
  }, [limit]);

  return {
    series: series ?? [],
    loading: series === undefined,
  };
}

// ===========================================================================
// Episodes Hooks
// ===========================================================================

/**
 * Get episodes for a series, grouped by season
 * Fetches from Xtream if not cached locally
 */
export function useSeriesDetails(seriesId: string | null) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get cached episodes from DB
  const episodes = useLiveQuery(
    async () => {
      if (!seriesId) return [];
      return db.vodEpisodes.where('series_id').equals(seriesId).toArray();
    },
    [seriesId]
  );

  // Fetch episodes if not cached
  const fetchEpisodes = useCallback(async () => {
    console.log('[useSeriesDetails] fetchEpisodes called for:', seriesId);
    if (!seriesId || !window.storage) {
      console.log('[useSeriesDetails] Skipping: Missing ID or storage');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Get the source for this series
      const series = await db.vodSeries.get(seriesId);
      if (!series) {
        console.error('[useSeriesDetails] Series not found in DB:', seriesId);
        setError('Series not found');
        return;
      }

      console.log('[useSeriesDetails] Found series in DB, looking for source:', series.source_id);
      const sourcesResult = await window.storage.getSources();
      const source = sourcesResult.data?.find(s => s.id === series.source_id);

      if (!source) {
        console.error('[useSeriesDetails] Source not found:', series.source_id);
        setError('Source not found');
        return;
      }

      console.log('[useSeriesDetails] Found source, syncing episodes...');
      await syncSeriesEpisodes(source, seriesId);
      console.log('[useSeriesDetails] Sync complete');
    } catch (err) {
      console.error('[useSeriesDetails] Error:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch episodes');
    } finally {
      setLoading(false);
    }
  }, [seriesId]);

  // Fetch on mount if no episodes cached
  const fetchAttempted = useRef(false);

  useEffect(() => {
    // Only fetch if we have a valid ID, no episodes, and haven't tried yet
    // This prevents infinite loops if the series truly has 0 episodes
    if (seriesId && episodes && episodes.length === 0 && !loading && !fetchAttempted.current) {
      fetchAttempted.current = true;
      fetchEpisodes();
    }
  }, [episodes, seriesId, fetchEpisodes, loading]);

  // Group episodes by season
  const seasons = episodes?.reduce((acc, ep) => {
    const seasonNum = ep.season_num;
    if (!acc[seasonNum]) {
      acc[seasonNum] = [];
    }
    acc[seasonNum].push(ep);
    return acc;
  }, {} as Record<number, StoredEpisode[]>) ?? {};

  // Sort episodes within each season
  for (const seasonNum in seasons) {
    seasons[seasonNum].sort((a, b) => a.episode_num - b.episode_num);
  }

  return {
    episodes: episodes ?? [],
    seasons,
    loading: loading || episodes === undefined,
    error,
    refetch: fetchEpisodes,
  };
}

// ===========================================================================
// Category Hooks
// ===========================================================================

/**
 * Get VOD categories by type (excludes empty categories)
 */
export function useVodCategories(type: 'movie' | 'series') {
  const categories = useLiveQuery(async () => {
    const allCategories = await db.vodCategories.where('type').equals(type).toArray();

    // Lazy Load Support: We MUST show empty categories for Stalker Lazy Mode to work.
    // The previous logic filtered out count > 0, which hid all Stalker categories.
    // For now, we return ALL categories.
    // If we want to hide truly empty Non-Stalker categories, we'd need to check source type,
    // but simplified behavior is better for now.

    return allCategories;
  }, [type]);

  return {
    categories: categories ?? [],
    loading: categories === undefined,
  };
}

/**
 * Get all VOD categories
 */
export function useAllVodCategories() {
  const categories = useLiveQuery(async () => {
    return db.vodCategories.toArray();
  });

  return {
    categories: categories ?? [],
    loading: categories === undefined,
  };
}

// ===========================================================================
// Sync Hooks
// ===========================================================================

/**
 * Hook for syncing VOD content
 */
export function useVodSync() {
  const [syncing, setSyncing] = useState(false);
  const [results, setResults] = useState<Map<string, VodSyncResult>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const sync = useCallback(async () => {
    setSyncing(true);
    setError(null);

    try {
      const syncResults = await syncAllVod();
      setResults(syncResults);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, []);

  return {
    sync,
    syncing,
    results,
    error,
  };
}

// ===========================================================================
// Count Hooks
// ===========================================================================

/**
 * Get total counts of movies and series
 */
export function useVodCounts() {
  const counts = useLiveQuery(async () => {
    const [movieCount, seriesCount] = await Promise.all([
      db.vodMovies.count(),
      db.vodSeries.count(),
    ]);
    return { movieCount, seriesCount };
  });

  return {
    movieCount: counts?.movieCount ?? 0,
    seriesCount: counts?.seriesCount ?? 0,
    loading: counts === undefined,
  };
}

// ===========================================================================
// Browse Hooks (for gallery view with Virtuoso)
// ===========================================================================

/**
 * All movies for browse view (optionally filtered by category)
 * Returns items sorted alphabetically - Virtuoso handles virtualization
 * Pass null for categoryId to get ALL movies
 */
export function usePaginatedMovies(categoryId: string | null, search?: string) {
  const items = useLiveQuery(async () => {
    let result: StoredMovie[] = [];

    if (categoryId) {
      // Filter by category
      result = await db.vodMovies.where('category_ids').equals(categoryId).toArray();
    } else {
      // All movies
      result = await db.vodMovies.toArray();
    }

    // Apply search filter
    if (search) {
      const searchLower = search.toLowerCase();
      result = result.filter(m => m.name.toLowerCase().includes(searchLower));
    }

    // Sort alphabetically
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }, [categoryId, search]);

  return {
    items: items ?? [],
    loading: items === undefined,
    hasMore: false,
    loadMore: () => { },
  };
}

/**
 * All series for browse view (optionally filtered by category)
 * Returns items sorted alphabetically - Virtuoso handles virtualization
 * Pass null for categoryId to get ALL series
 */
export function usePaginatedSeries(categoryId: string | null, search?: string) {
  const items = useLiveQuery(async () => {
    let result: StoredSeries[] = [];

    if (categoryId) {
      // Filter by category
      result = await db.vodSeries.where('category_ids').equals(categoryId).toArray();
    } else {
      // All series
      result = await db.vodSeries.toArray();
    }

    // Apply search filter
    if (search) {
      const searchLower = search.toLowerCase();
      result = result.filter(s => s.name.toLowerCase().includes(searchLower));
    }

    // Sort alphabetically
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }, [categoryId, search]);

  return {
    items: items ?? [],
    loading: items === undefined,
    hasMore: false,
    loadMore: () => { },
  };
}

/**
 * Get alphabet index for A-Z rail
 * Returns map of letter -> first item index for that letter
 * Uses useMemo to derive value directly from items, preventing render loops
 */
export function useAlphabetIndex(items: Array<{ name: string }>) {
  return useMemo(() => {
    const newIndex = new Map<string, number>();
    items.forEach((item, i) => {
      if (!item || !item.name) return;
      const firstChar = item.name.charAt(0).toUpperCase();
      const letter = /[A-Z]/.test(firstChar) ? firstChar : '#';
      if (!newIndex.has(letter)) {
        newIndex.set(letter, i);
      }
    });
    return newIndex;
  }, [items]);
}

/**
 * Get current letter based on scroll position
 */
export function useCurrentLetter(
  items: Array<{ name: string }>,
  visibleStartIndex: number
): string {
  if (!items || items.length === 0 || visibleStartIndex < 0) return 'A';

  const currentItem = items[Math.min(visibleStartIndex, items.length - 1)];
  if (!currentItem || !currentItem.name) return 'A';

  const firstChar = currentItem.name.charAt(0).toUpperCase();
  return /[A-Z]/.test(firstChar) ? firstChar : '#';
}
/**
 * Lazy loading hook for Stalker categories
 * Triggers a fetch if a Stalker category is empty in the local DB
 */
export function useLazyStalkerLoader(type: 'movies' | 'series', categoryId: string | null) {
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!categoryId) return;

    const checkAndSync = async () => {
      // 1. Get category to find source_id
      const category = await db.vodCategories.get(categoryId);
      if (!category) return;

      // 2. Check if source is Stalker
      // We need window.storage to check source type
      if (!window.storage) return;
      const sourceRes = await window.storage.getSource(category.source_id);
      const source = sourceRes.data;

      if (!source || source.type !== 'stalker') return;

      // 3. Check if we already have items for this category
      const table = type === 'movies' ? db.vodMovies : db.vodSeries;
      const count = await table.where('category_ids').equals(categoryId).count();

      if (count === 0) {
        setSyncing(true);
        setMessage('Starting sync...');
        try {
          // Import dynamically to avoid circular dependencies if any? 
          // No, sync.ts imports from index.ts, useVod imports from index.ts. 
          // We need to import syncStalkerCategory from '../db/sync'
          const { syncStalkerCategory } = await import('../db/sync');
          await syncStalkerCategory(source.id, categoryId, type, (pct, msg) => {
            setProgress(pct);
            setMessage(msg);
          });
        } catch (e) {
          console.error('[useLazyStalkerLoader] Sync failed:', e);
          setMessage('Failed');
        } finally {
          setSyncing(false);
          setProgress(0);
          setMessage('');
        }
      }
    };

    checkAndSync();
  }, [categoryId, type]);

  return { syncing, progress, message };
}
