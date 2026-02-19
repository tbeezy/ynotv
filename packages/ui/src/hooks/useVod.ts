import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useLiveQuery } from './useSqliteLiveQuery';
import { db, type StoredMovie, type StoredSeries, type StoredEpisode, type VodCategory } from '../db';
import { syncSeriesEpisodes, syncAllVod, type VodSyncResult } from '../db/sync';
import type { Source } from '@ynotv/core';
import { useEnabledSources } from './useChannels';

// ===========================================================================
// Movies Hooks
// ===========================================================================

/**
 * Query movies with optional category filter and search
 * Filters out movies from disabled sources
 * Uses LIMIT for 'All' view to prevent loading 10k+ movies into memory
 */
export function useMovies(categoryId?: string | null, search?: string, limit = 200) {
  const enabledSourceIds = useEnabledSources();
  const movies = useLiveQuery(async () => {
    if (categoryId) {
      // Filter by category - uses index with limit to prevent memory issues
      const allMovies = await db.vodMovies.where('category_ids').equals(categoryId).limit(limit).toArray();
      // Only filter by enabled sources if they've loaded
      const filtered = enabledSourceIds ? allMovies.filter(m => enabledSourceIds.has(m.source_id)) : allMovies;
      if (search) {
        const searchLower = search.toLowerCase();
        return filtered.filter(m => m.name.toLowerCase().includes(searchLower));
      }
      return filtered;
    }

    // No category filter - use SQL LIMIT to prevent memory issues
    // Sort by name for consistent results
    let allMovies: StoredMovie[];

    if (enabledSourceIds && enabledSourceIds.size > 0) {
      // Filter by enabled sources with limit
      const idsList = Array.from(enabledSourceIds);
      if (idsList.length === 0) return [];

      // Use raw SQL with IN clause and LIMIT
      const placeholders = idsList.map(() => '?').join(',');
      const dbInstance = await (db as any).dbPromise;
      allMovies = await dbInstance.select(
        `SELECT * FROM vodMovies WHERE source_id IN (${placeholders}) ORDER BY name LIMIT ${limit}`,
        idsList
      );
    } else {
      // No source filter - just limit
      allMovies = await db.vodMovies.orderBy('name').limit(limit).toArray();
    }

    if (search) {
      const searchLower = search.toLowerCase();
      allMovies = allMovies.filter(m => m.name.toLowerCase().includes(searchLower));
    }

    return allMovies;
  }, [categoryId, search, limit, enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading']);

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
 * Uses LIMIT for 'All' view to prevent loading 10k+ series into memory
 */
export function useSeries(categoryId?: string | null, search?: string, limit = 200) {
  const enabledSourceIds = useEnabledSources();
  const series = useLiveQuery(async () => {
    if (categoryId) {
      // Filter by category - uses index with limit to prevent memory issues
      const allSeries = await db.vodSeries.where('category_ids').equals(categoryId).limit(limit).toArray();
      // Only filter by enabled sources if they've loaded
      const filtered = enabledSourceIds ? allSeries.filter(s => enabledSourceIds.has(s.source_id)) : allSeries;
      if (search) {
        const searchLower = search.toLowerCase();
        return filtered.filter(s => s.name.toLowerCase().includes(searchLower));
      }
      return filtered;
    }

    // No category filter - use SQL LIMIT to prevent memory issues
    let allSeries: StoredSeries[];

    if (enabledSourceIds && enabledSourceIds.size > 0) {
      // Filter by enabled sources with limit
      const idsList = Array.from(enabledSourceIds);
      if (idsList.length === 0) return [];

      // Use raw SQL with IN clause and LIMIT
      const placeholders = idsList.map(() => '?').join(',');
      const dbInstance = await (db as any).dbPromise;
      allSeries = await dbInstance.select(
        `SELECT * FROM vodSeries WHERE source_id IN (${placeholders}) ORDER BY name LIMIT ${limit}`,
        idsList
      );
    } else {
      // No source filter - just limit
      allSeries = await db.vodSeries.orderBy('name').limit(limit).toArray();
    }

    if (search) {
      const searchLower = search.toLowerCase();
      allSeries = allSeries.filter(s => s.name.toLowerCase().includes(searchLower));
    }

    // Debug: Log first few series to check cover field
    if (allSeries.length > 0) {
      console.log('[useSeries] First 3 series from DB:', allSeries.slice(0, 3).map(s => {
        const raw = s as any;
        return {
          id: s.series_id,
          name: s.name,
          cover: s.cover,
          cover_present: 'cover' in raw,
          cover_type: typeof s.cover,
          cover_value: s.cover,
          all_keys: Object.keys(raw).filter(k => k.includes('cover') || k.includes('icon'))
        };
      }));
    }

    return allSeries;
  }, [categoryId, search, limit, enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading']);

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
      const source = sourcesResult.data?.find(s => String(s.id) === String(series.source_id));

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
// Windowed Query Hooks (for infinite scroll / virtual scrolling)
// ===========================================================================

interface WindowedResult<T> {
  items: T[];
  totalCount: number;
  hasMore: boolean;
  loading: boolean;
  loadMore: () => void;
  reset: () => void;
}

const WINDOW_SIZE = 100; // Load 100 items per batch for smoother infinite scrolling

/**
 * Windowed movie query for infinite scroll
 * Loads movies in chunks of 100 for smooth virtual scrolling
 * 
 * @param refreshTrigger - Optional trigger to force re-query (e.g., when lazy loading completes)
 */
export function useWindowedMovies(
  categoryId: string | null,
  search?: string,
  sortBy: 'name' | 'added' | 'popularity' = 'name',
  refreshTrigger?: boolean
): WindowedResult<StoredMovie> {
  const [offset, setOffset] = useState(0);
  const [allItems, setAllItems] = useState<StoredMovie[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);

  // Reset when filters change
  useEffect(() => {
    setOffset(0);
    setAllItems([]);
  }, [categoryId, search, sortBy, refreshTrigger]);

  // Load initial window and total count
  useEffect(() => {
    const loadInitial = async () => {
      setLoading(true);
      try {
        const dbInstance = await (db as any).dbPromise;

        // Build WHERE clause
        let whereClause = '1=1';
        const params: any[] = [];

        if (categoryId) {
          // Use JSON-style matching with quotes to avoid substring matches (e.g., "cat1" matching "cat10")
          whereClause += ' AND category_ids LIKE ?';
          params.push(`%"${categoryId}"%`);
        }

        if (search) {
          whereClause += ' AND name LIKE ?';
          params.push(`%${search}%`);
        }

        // Get total count
        const countResult = await dbInstance.select(
          `SELECT COUNT(*) as count FROM vodMovies WHERE ${whereClause}`,
          params
        );
        setTotalCount(countResult[0]?.count || 0);

        // Load first window
        const orderColumn = sortBy === 'added' ? 'added' : sortBy === 'popularity' ? 'popularity' : 'name';
        const orderDir = sortBy === 'added' ? 'DESC' : 'ASC';

        const items = await dbInstance.select(
          `SELECT * FROM vodMovies WHERE ${whereClause} ORDER BY ${orderColumn} ${orderDir} LIMIT ${WINDOW_SIZE}`,
          params
        );

        setAllItems(items);
        setOffset(items.length);
      } catch (error) {
        console.error('Error loading windowed movies:', error);
      } finally {
        setLoading(false);
      }
    };

    loadInitial();
  }, [categoryId, search, sortBy, refreshTrigger]);

  const loadMore = useCallback(async () => {
    if (loading || offset >= totalCount) return;

    setLoading(true);
    try {
      const dbInstance = await (db as any).dbPromise;

      // Build WHERE clause
      let whereClause = '1=1';
      const params: any[] = [];

      if (categoryId) {
        // Use JSON-style matching with quotes to avoid substring matches (e.g., "cat1" matching "cat10")
        whereClause += ' AND category_ids LIKE ?';
        params.push(`%"${categoryId}"%`);
      }

      if (search) {
        whereClause += ' AND name LIKE ?';
        params.push(`%${search}%`);
      }

      // Load next window
      const orderColumn = sortBy === 'added' ? 'added' : sortBy === 'popularity' ? 'popularity' : 'name';
      const orderDir = sortBy === 'added' ? 'DESC' : 'ASC';

      const items = await dbInstance.select(
        `SELECT * FROM vodMovies WHERE ${whereClause} ORDER BY ${orderColumn} ${orderDir} LIMIT ${WINDOW_SIZE} OFFSET ${offset}`,
        params
      );

      setAllItems(prev => [...prev, ...items]);
      setOffset(prev => prev + items.length);
    } catch (error) {
      console.error('Error loading more movies:', error);
    } finally {
      setLoading(false);
    }
  }, [categoryId, search, sortBy, offset, totalCount, loading]);

  const reset = useCallback(() => {
    setOffset(0);
    setAllItems([]);
    setTotalCount(0);
  }, []);

  return {
    items: allItems,
    totalCount,
    hasMore: offset < totalCount,
    loading,
    loadMore,
    reset,
  };
}

/**
 * Windowed series query for infinite scroll
 * Loads series in chunks of 100 for smooth virtual scrolling
 * 
 * @param refreshTrigger - Optional trigger to force re-query (e.g., when lazy loading completes)
 */
export function useWindowedSeries(
  categoryId: string | null,
  search?: string,
  sortBy: 'name' | 'added' | 'popularity' = 'name',
  refreshTrigger?: boolean
): WindowedResult<StoredSeries> {
  const [offset, setOffset] = useState(0);
  const [allItems, setAllItems] = useState<StoredSeries[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);

  // Reset when filters change
  useEffect(() => {
    setOffset(0);
    setAllItems([]);
  }, [categoryId, search, sortBy]);

  // Load initial window and total count
  useEffect(() => {
    const loadInitial = async () => {
      setLoading(true);
      try {
        const dbInstance = await (db as any).dbPromise;

        // Build WHERE clause
        let whereClause = '1=1';
        const params: any[] = [];

        if (categoryId) {
          // Use JSON-style matching with quotes to avoid substring matches (e.g., "cat1" matching "cat10")
          whereClause += ' AND category_ids LIKE ?';
          params.push(`%"${categoryId}"%`);
        }

        if (search) {
          whereClause += ' AND name LIKE ?';
          params.push(`%${search}%`);
        }

        // Get total count
        const countResult = await dbInstance.select(
          `SELECT COUNT(*) as count FROM vodSeries WHERE ${whereClause}`,
          params
        );
        setTotalCount(countResult[0]?.count || 0);

        // Load first window
        const orderColumn = sortBy === 'added' ? 'added' : sortBy === 'popularity' ? 'popularity' : 'name';
        const orderDir = sortBy === 'added' ? 'DESC' : 'ASC';

        const items = await dbInstance.select(
          `SELECT * FROM vodSeries WHERE ${whereClause} ORDER BY ${orderColumn} ${orderDir} LIMIT ${WINDOW_SIZE}`,
          params
        );

        setAllItems(items);
        setOffset(items.length);
      } catch (error) {
        console.error('Error loading windowed series:', error);
      } finally {
        setLoading(false);
      }
    };

    loadInitial();
  }, [categoryId, search, sortBy, refreshTrigger]);

  const loadMore = useCallback(async () => {
    if (loading || offset >= totalCount) return;

    setLoading(true);
    try {
      const dbInstance = await (db as any).dbPromise;

      // Build WHERE clause
      let whereClause = '1=1';
      const params: any[] = [];

      if (categoryId) {
        // Use JSON-style matching with quotes to avoid substring matches (e.g., "cat1" matching "cat10")
        whereClause += ' AND category_ids LIKE ?';
        params.push(`%"${categoryId}"%`);
      }

      if (search) {
        whereClause += ' AND name LIKE ?';
        params.push(`%${search}%`);
      }

      // Load next window
      const orderColumn = sortBy === 'added' ? 'added' : sortBy === 'popularity' ? 'popularity' : 'name';
      const orderDir = sortBy === 'added' ? 'DESC' : 'ASC';

      const items = await dbInstance.select(
        `SELECT * FROM vodSeries WHERE ${whereClause} ORDER BY ${orderColumn} ${orderDir} LIMIT ${WINDOW_SIZE} OFFSET ${offset}`,
        params
      );

      setAllItems(prev => [...prev, ...items]);
      setOffset(prev => prev + items.length);
    } catch (error) {
      console.error('Error loading more series:', error);
    } finally {
      setLoading(false);
    }
  }, [categoryId, search, sortBy, offset, totalCount, loading]);

  const reset = useCallback(() => {
    setOffset(0);
    setAllItems([]);
    setTotalCount(0);
  }, []);

  return {
    items: allItems,
    totalCount,
    hasMore: offset < totalCount,
    loading,
    loadMore,
    reset,
  };
}

// ===========================================================================
// Browse Hooks (for gallery view with Virtuoso)
// ===========================================================================

/**
 * All movies for browse view (optionally filtered by category)
 * Returns items sorted alphabetically - Virtuoso handles virtualization
 * Pass null for categoryId to get ALL movies
 * Supports infinite scrolling with windowed loading
 * 
 * @param refreshTrigger - Optional trigger to force re-query (e.g., when lazy loading completes)
 */
export function usePaginatedMovies(categoryId: string | null, search?: string, refreshTrigger?: boolean) {
  // Use windowed query for proper infinite scroll
  return useWindowedMovies(categoryId, search, 'name', refreshTrigger);
}

/**
 * All series for browse view (optionally filtered by category)
 * Returns items sorted alphabetically - Virtuoso handles virtualization
 * Pass null for categoryId to get ALL series
 * Supports infinite scrolling with windowed loading
 * 
 * @param refreshTrigger - Optional trigger to force re-query (e.g., when lazy loading completes)
 */
export function usePaginatedSeries(categoryId: string | null, search?: string, refreshTrigger?: boolean) {
  // Use windowed query for proper infinite scroll
  return useWindowedSeries(categoryId, search, 'name', refreshTrigger);
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
 * 
 * Features:
 * - Shows cached data immediately if available
 * - Lazy loads in background if cache is stale or missing
 * - Returns 'completed' flag when sync finishes to trigger UI refresh
 * - Implements timestamp-based caching (5 minute TTL)
 */
export function useLazyStalkerLoader(type: 'movies' | 'series', categoryId: string | null) {
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [completed, setCompleted] = useState(false);
  const [hasCache, setHasCache] = useState(false);

  // Cache TTL: 5 minutes for Stalker VOD (can be adjusted)
  const CACHE_TTL_MS = 5 * 60 * 1000;

  useEffect(() => {
    if (!categoryId) {
      setCompleted(false);
      setHasCache(false);
      return;
    }

    const checkAndSync = async () => {
      // Reset completion state when category changes
      setCompleted(false);

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
      const existingItems = await table
        .where('category_ids')
        .equals(categoryId)
        .limit(1)
        .toArray();

      const count = existingItems.length;

      // Check cache freshness (if items exist, check the newest one's 'added' timestamp)
      let cacheIsFresh = false;
      if (count > 0) {
        const newestItem = await table
          .where('category_ids')
          .equals(categoryId)
          .reverse()
          .sortBy('added')
          .then(items => items[0]);

        if (newestItem?.added) {
          const addedTime = new Date(newestItem.added).getTime();
          const now = Date.now();
          cacheIsFresh = (now - addedTime) < CACHE_TTL_MS;
        }

        // We have cached data - show it immediately
        setHasCache(true);
        console.log(`[useLazyStalkerLoader] ${type} cache found for ${categoryId}: ${count} items, fresh: ${cacheIsFresh}`);
      }

      // Only sync if no cache or cache is stale
      if (count === 0 || !cacheIsFresh) {
        setSyncing(true);
        setMessage(count === 0 ? 'Loading...' : 'Updating...');
        try {
          const { syncStalkerCategory } = await import('../db/sync');
          await syncStalkerCategory(source.id, categoryId, type, (pct, msg) => {
            setProgress(pct);
            setMessage(msg);
          });
          console.log(`[useLazyStalkerLoader] ${type} sync completed for ${categoryId}`);
        } catch (e) {
          console.error('[useLazyStalkerLoader] Sync failed:', e);
          setMessage('Failed');
        } finally {
          setSyncing(false);
          setProgress(0);
          setMessage('');
          setCompleted(true); // Signal that sync completed (success or failure)
        }
      } else {
        // Cache is fresh, no need to sync
        console.log(`[useLazyStalkerLoader] ${type} using fresh cache for ${categoryId}`);
        setCompleted(true);
      }
    };

    checkAndSync();
  }, [categoryId, type]);

  return { syncing, progress, message, completed, hasCache };
}
