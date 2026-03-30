import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useLiveQuery } from './useSqliteLiveQuery';
import { db, type StoredMovie, type StoredSeries, type StoredEpisode, type VodCategory, type VodWatchHistory, getRecentlyWatchedByType } from '../db';
import { syncSeriesEpisodes, syncAllVod, type VodSyncResult } from '../db/sync';
import type { Source } from '@ynotv/core';
import { useEnabledSources } from './useChannels';
import { getTmdbImageUrl, TMDB_POSTER_SIZES } from '../services/tmdb';

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
        const searchTerms = search.toLowerCase().split(/\s+/).filter(Boolean);
        return filtered.filter(m => {
          const title = (m.name || m.title || '').toLowerCase();
          return searchTerms.every(term => title.includes(term));
        });
      }
      return filtered;
    }

    // No category filter - use SQL LIMIT to prevent memory issues
    // Filter by enabled categories in SQL to avoid over-fetching
    const enabledCategories = await db.vodCategories.where('type').equals('movie').toArray();
    const enabledCatIds = enabledCategories
      .filter(c => c.enabled !== false)
      .map(c => c.category_id);
    
    // Early return if no enabled categories
    if (enabledCatIds.length === 0) {
      return [];
    }
    
    let allMovies: StoredMovie[];

    if (enabledSourceIds && enabledSourceIds.size > 0) {
      // Filter by enabled sources and enabled categories
      const idsList = Array.from(enabledSourceIds);
      if (idsList.length === 0) return [];

      const sourcePlaceholders = idsList.map(() => '?').join(',');
      const categoryPlaceholders = enabledCatIds.map(() => '?').join(',');
      const dbInstance = await (db as any).dbPromise;
      
      let queryStr = `SELECT * FROM vodMovies WHERE source_id IN (${sourcePlaceholders})`;
      const params: any[] = [...idsList];

      // Filter by enabled categories using json_each
      queryStr += ` AND EXISTS (
        SELECT 1 FROM json_each(category_ids) 
        WHERE value IN (${categoryPlaceholders})
      )`;
      params.push(...enabledCatIds);

      if (search) {
        const searchTerms = search.toLowerCase().split(/\s+/).filter(Boolean);
        const searchClauses = searchTerms.map(() => `(name LIKE ? OR title LIKE ?)`).join(' AND ');
        if (searchClauses) {
          queryStr += ` AND (${searchClauses})`;
          searchTerms.forEach(term => {
            params.push(`%${term}%`, `%${term}%`);
          });
        }
      }

      queryStr += ` ORDER BY name LIMIT ${limit}`;
      allMovies = await dbInstance.select(queryStr, params);
    } else {
      // No source filter - just filter by enabled categories
      const categoryPlaceholders = enabledCatIds.map(() => '?').join(',');
      const dbInstance = await (db as any).dbPromise;
      
      if (search) {
        const searchTerms = search.toLowerCase().split(/\s+/).filter(Boolean);
        const searchClauses = searchTerms.map(() => `(name LIKE ? OR title LIKE ?)`).join(' AND ');
        const params: any[] = [];
        searchTerms.forEach(term => {
          params.push(`%${term}%`, `%${term}%`);
        });
        
        allMovies = await dbInstance.select(
          `SELECT * FROM vodMovies 
           WHERE EXISTS (
             SELECT 1 FROM json_each(category_ids) 
             WHERE value IN (${categoryPlaceholders})
           )
           AND (${searchClauses})
           ORDER BY name LIMIT ${limit}`,
          [...enabledCatIds, ...params]
        );
      } else {
        allMovies = await dbInstance.select(
          `SELECT * FROM vodMovies 
           WHERE EXISTS (
             SELECT 1 FROM json_each(category_ids) 
             WHERE value IN (${categoryPlaceholders})
           )
           ORDER BY name LIMIT ${limit}`,
          enabledCatIds
        );
      }
    }

    // No need to filter by categories again - already done in SQL
    return allMovies;
  }, [categoryId, search, limit, enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading'],
  undefined, // defaultResult
  0, // staleTime: 0 - category/search changes need fresh data
  'vodMovies' // tableName: only re-run when vodMovies table changes
  );

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
        const searchTerms = search.toLowerCase().split(/\s+/).filter(Boolean);
        return filtered.filter(s => {
          const title = (s.name || s.title || '').toLowerCase();
          return searchTerms.every(term => title.includes(term));
        });
      }
      return filtered;
    }

    // No category filter - use SQL LIMIT to prevent memory issues
    // Filter by enabled categories in SQL to avoid over-fetching
    const enabledCategories = await db.vodCategories.where('type').equals('series').toArray();
    const enabledCatIds = enabledCategories
      .filter(c => c.enabled !== false)
      .map(c => c.category_id);
    
    // Early return if no enabled categories
    if (enabledCatIds.length === 0) {
      return [];
    }
    
    let allSeries: StoredSeries[];

    if (enabledSourceIds && enabledSourceIds.size > 0) {
      // Filter by enabled sources and enabled categories
      const idsList = Array.from(enabledSourceIds);
      if (idsList.length === 0) return [];

      const sourcePlaceholders = idsList.map(() => '?').join(',');
      const categoryPlaceholders = enabledCatIds.map(() => '?').join(',');
      const dbInstance = await (db as any).dbPromise;
      
      let queryStr = `SELECT * FROM vodSeries WHERE source_id IN (${sourcePlaceholders})`;
      const params: any[] = [...idsList];

      // Filter by enabled categories using json_each
      queryStr += ` AND EXISTS (
        SELECT 1 FROM json_each(category_ids) 
        WHERE value IN (${categoryPlaceholders})
      )`;
      params.push(...enabledCatIds);

      if (search) {
        const searchTerms = search.toLowerCase().split(/\s+/).filter(Boolean);
        const searchClauses = searchTerms.map(() => `(name LIKE ? OR title LIKE ?)`).join(' AND ');
        if (searchClauses) {
          queryStr += ` AND (${searchClauses})`;
          searchTerms.forEach(term => {
            params.push(`%${term}%`, `%${term}%`);
          });
        }
      }

      queryStr += ` ORDER BY name LIMIT ${limit}`;
      allSeries = await dbInstance.select(queryStr, params);
    } else {
      // No source filter - just filter by enabled categories
      const categoryPlaceholders = enabledCatIds.map(() => '?').join(',');
      const dbInstance = await (db as any).dbPromise;
      
      if (search) {
        const searchTerms = search.toLowerCase().split(/\s+/).filter(Boolean);
        const searchClauses = searchTerms.map(() => `(name LIKE ? OR title LIKE ?)`).join(' AND ');
        const params: any[] = [];
        searchTerms.forEach(term => {
          params.push(`%${term}%`, `%${term}%`);
        });
        
        allSeries = await dbInstance.select(
          `SELECT * FROM vodSeries 
           WHERE EXISTS (
             SELECT 1 FROM json_each(category_ids) 
             WHERE value IN (${categoryPlaceholders})
           )
           AND (${searchClauses})
           ORDER BY name LIMIT ${limit}`,
          [...enabledCatIds, ...params]
        );
      } else {
        allSeries = await dbInstance.select(
          `SELECT * FROM vodSeries 
           WHERE EXISTS (
             SELECT 1 FROM json_each(category_ids) 
             WHERE value IN (${categoryPlaceholders})
           )
           ORDER BY name LIMIT ${limit}`,
          enabledCatIds
        );
      }
    }

    // No need to filter by categories again - already done in SQL
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

    // Only return enabled categories, ordered by display_order
    return allCategories
      .filter(cat => cat.enabled !== false)
      .sort((a, b) => {
        if (a.display_order !== undefined && b.display_order !== undefined) {
           return a.display_order - b.display_order;
        }
        if (a.display_order !== undefined) return -1;
        if (b.display_order !== undefined) return 1;
        return a.name.localeCompare(b.name);
      });
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

/**
 * Windowed movie query - loads all items at once
 * 
 * @param refreshTrigger - Optional trigger to force re-query (e.g., when lazy loading completes)
 */
export function useWindowedMovies(
  categoryId: string | null,
  search?: string,
  sortBy: 'name' | 'added' | 'popularity' = 'name',
  refreshTrigger?: boolean
): WindowedResult<StoredMovie> {
  const [allItems, setAllItems] = useState<StoredMovie[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);

  // Reset when filters change
  useEffect(() => {
    setAllItems([]);
  }, [categoryId, search, sortBy, refreshTrigger]);

  // Load all items at once
  useEffect(() => {
    const loadAll = async () => {
      setLoading(true);
      try {
        const dbInstance = await (db as any).dbPromise;

        // Build WHERE clause
        // 1. Filter out disabled categories
        const enabledCategories = await db.vodCategories.filter(c => c.type === 'movie' && c.enabled !== false).toArray();
        const enabledBySource: Record<string, string[]> = {};
        enabledCategories.forEach(c => {
          if (!enabledBySource[c.source_id]) enabledBySource[c.source_id] = [];
          enabledBySource[c.source_id].push(c.category_id);
        });

        // Collect all enabled category IDs across all sources for json_each
        const allEnabledCategoryIds: string[] = [];
        Object.values(enabledBySource).forEach(catIds => {
          allEnabledCategoryIds.push(...catIds);
        });

        const params: any[] = [];
        let whereClause = '';

        // Build source conditions using json_each for efficient category matching
        const sourceIds = Object.keys(enabledBySource);
        if (sourceIds.length > 0 && allEnabledCategoryIds.length > 0) {
          const sourcePlaceholders = sourceIds.map(() => '?').join(',');
          const categoryPlaceholders = allEnabledCategoryIds.map(() => '?').join(',');
          
          // Use json_each to efficiently match category_ids JSON array
          whereClause = `source_id IN (${sourcePlaceholders}) AND cat.value IN (${categoryPlaceholders})`;
          params.push(...sourceIds, ...allEnabledCategoryIds);
        }

        const orphanCondition = `(category_ids IS NULL OR category_ids = '[]')`;
        if (whereClause) {
          whereClause = `(${orphanCondition} OR (${whereClause}))`;
        } else {
          whereClause = orphanCondition;
        }

        if (categoryId) {
          // Use JSON-style matching with quotes to avoid substring matches
          whereClause += ' AND category_ids LIKE ?';
          params.push(`%"${categoryId}"%`);
        }

        if (search) {
          const searchTerms = search.toLowerCase().split(/\s+/).filter(Boolean);
          const searchClauses = searchTerms.map(() => `(name LIKE ? OR title LIKE ?)`).join(' AND ');
          if (searchClauses) {
            whereClause += ` AND (${searchClauses})`;
            searchTerms.forEach(term => {
              params.push(`%${term}%`, `%${term}%`);
            });
          }
        }

        // Load all items (no LIMIT)
        const orderColumn = sortBy === 'added' ? 'added' : sortBy === 'popularity' ? 'popularity' : 'name';
        const orderDir = sortBy === 'added' ? 'DESC' : 'ASC';

        const items = await dbInstance.select(
          `SELECT DISTINCT m.* 
           FROM vodMovies m 
           CROSS JOIN json_each(m.category_ids) AS cat 
           WHERE ${whereClause} 
           ORDER BY ${orderColumn} ${orderDir}`,
          params
        );

        setAllItems(items);
        setTotalCount(items.length);
      } catch (error) {
        console.error('Error loading movies:', error);
      } finally {
        setLoading(false);
      }
    };

    loadAll();
  }, [categoryId, search, sortBy, refreshTrigger]);

  const reset = useCallback(() => {
    setAllItems([]);
    setTotalCount(0);
  }, []);

  return {
    items: allItems,
    totalCount,
    hasMore: false,
    loading,
    loadMore: () => {}, // No-op since we load all at once
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
  const [allItems, setAllItems] = useState<StoredSeries[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);

  // Reset when filters change
  useEffect(() => {
    setAllItems([]);
  }, [categoryId, search, sortBy]);

  // Load all items at once
  useEffect(() => {
    const loadAll = async () => {
      setLoading(true);
      try {
        const dbInstance = await (db as any).dbPromise;

        // Build WHERE clause
        const enabledCategories = await db.vodCategories.filter(c => c.type === 'series' && c.enabled !== false).toArray();
        const enabledBySource: Record<string, string[]> = {};
        enabledCategories.forEach(c => {
          if (!enabledBySource[c.source_id]) enabledBySource[c.source_id] = [];
          enabledBySource[c.source_id].push(c.category_id);
        });

        // Collect all enabled category IDs across all sources
        const allEnabledCategoryIds: string[] = [];
        Object.values(enabledBySource).forEach(catIds => {
          allEnabledCategoryIds.push(...catIds);
        });

        const params: any[] = [];
        let whereClause = '';

        // Build source conditions - series has additional category_id and _stalker_category fields
        const sourceIds = Object.keys(enabledBySource);
        if (sourceIds.length > 0 && allEnabledCategoryIds.length > 0) {
          const sourcePlaceholders = sourceIds.map(() => '?').join(',');
          const categoryPlaceholders = allEnabledCategoryIds.map(() => '?').join(',');
          
          // Match by source_id AND (category_id IN (...) OR _stalker_category IN (...) OR json_each match)
          whereClause = `source_id IN (${sourcePlaceholders}) AND (
            category_id IN (${categoryPlaceholders}) OR 
            _stalker_category IN (${categoryPlaceholders}) OR
            cat.value IN (${categoryPlaceholders})
          )`;
          params.push(...sourceIds, ...allEnabledCategoryIds, ...allEnabledCategoryIds, ...allEnabledCategoryIds);
        }

        const orphanCondition = `((category_ids IS NULL OR category_ids = '[]') AND category_id IS NULL AND _stalker_category IS NULL)`;
        if (whereClause) {
          whereClause = `(${orphanCondition} OR (${whereClause}))`;
        } else {
          whereClause = orphanCondition;
        }

        if (categoryId) {
          whereClause += ' AND category_ids LIKE ?';
          params.push(`%"${categoryId}"%`);
        }

        if (search) {
          const searchTerms = search.toLowerCase().split(/\s+/).filter(Boolean);
          const searchClauses = searchTerms.map(() => `(name LIKE ? OR title LIKE ?)`).join(' AND ');
          if (searchClauses) {
            whereClause += ` AND (${searchClauses})`;
            searchTerms.forEach(term => {
              params.push(`%${term}%`, `%${term}%`);
            });
          }
        }

        // Load all items (no LIMIT)
        const orderColumn = sortBy === 'added' ? 'added' : sortBy === 'popularity' ? 'popularity' : 'name';
        const orderDir = sortBy === 'added' ? 'DESC' : 'ASC';

        const items = await dbInstance.select(
          `SELECT DISTINCT s.* 
           FROM vodSeries s 
           LEFT JOIN json_each(s.category_ids) AS cat ON json_valid(s.category_ids)
           WHERE ${whereClause} 
           ORDER BY ${orderColumn} ${orderDir}`,
          params
        );

        setAllItems(items);
        setTotalCount(items.length);
      } catch (error) {
        console.error('Error loading series:', error);
      } finally {
        setLoading(false);
      }
    };

    loadAll();
  }, [categoryId, search, sortBy, refreshTrigger]);

  const reset = useCallback(() => {
    setAllItems([]);
    setTotalCount(0);
  }, []);

  return {
    items: allItems,
    totalCount,
    hasMore: false,
    loading,
    loadMore: () => {}, // No-op since we load all at once
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

// ============================================================================
// Recently Watched Hooks
// ============================================================================

export interface RecentlyWatchedItem<T> {
  item: T;
  progress_seconds: number;
  total_duration: number;
  progress_percent: number;
  watched_at: number;
  // For series only
  season_num?: number;
  episode_num?: number;
  episode_title?: string;
}

/**
 * Get recently watched movies with full movie data and progress
 * Joins watch history with movie data to get complete movie objects
 */
export function useRecentlyWatchedMovies(limit = 20) {
  const [movies, setMovies] = useState<RecentlyWatchedItem<StoredMovie>[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Get watch history
      const history = await getRecentlyWatchedByType('movie', limit);
      
      if (history.length === 0) {
        setMovies([]);
        setLoading(false);
        return;
      }

      // Fetch full movie data for each history entry
      const dbInstance = await (db as any).dbPromise;
      const mediaIds = history.map(h => h.media_id);
      
      if (mediaIds.length === 0) {
        setMovies([]);
        setLoading(false);
        return;
      }

      // Build placeholders for SQL IN clause
      const placeholders = mediaIds.map(() => '?').join(',');
      const moviesData: StoredMovie[] = await dbInstance.select(
        `SELECT * FROM vodMovies WHERE stream_id IN (${placeholders})`,
        mediaIds
      );

      // Create a map for quick lookup
      const movieMap = new Map(moviesData.map(m => [m.stream_id, m]));

      // Order movies according to watch history order with progress
      const orderedMovies = history
        .map(h => {
          const movie = movieMap.get(h.media_id);
          if (!movie) return null;
          const progressSeconds = h.progress_seconds ?? 0;
          const totalDuration = h.total_duration ?? 0;
          return {
            item: movie,
            progress_seconds: progressSeconds,
            total_duration: totalDuration,
            progress_percent: totalDuration > 0 
              ? Math.round((progressSeconds / totalDuration) * 100) 
              : 0,
            watched_at: h.watched_at,
          };
        })
        .filter((m): m is RecentlyWatchedItem<StoredMovie> => m !== null);

      setMovies(orderedMovies);
    } catch (error) {
      console.error('[useRecentlyWatchedMovies] Error:', error);
      setMovies([]);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  // Initial load and reactive updates
  const historySignature = useLiveQuery(async () => {
    // Fetch count and latest timestamp to trigger updates on any change (including deletes)
    const dbInstance = await (db as any).dbPromise;
    const result = await dbInstance.select(
      'SELECT COUNT(*) as count, MAX(watched_at) as latest FROM vod_history WHERE media_type = ?',
      ['movie']
    );
    // Combine count and latest into a signature that changes on any modification
    return `${result?.[0]?.count || 0}-${result?.[0]?.latest || 0}`;
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, historySignature]);

  return {
    movies,
    loading,
    refresh,
  };
}

/**
 * Get recently watched series with full series data and progress
 * Joins watch history with series data to get complete series objects
 */
export function useRecentlyWatchedSeries(limit = 20) {
  const [series, setSeries] = useState<RecentlyWatchedItem<StoredSeries>[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Get watch history
      const history = await getRecentlyWatchedByType('series', limit);
      
      if (history.length === 0) {
        setSeries([]);
        setLoading(false);
        return;
      }

      // Fetch full series data for each history entry
      const dbInstance = await (db as any).dbPromise;
      const mediaIds = history.map(h => h.media_id);
      
      if (mediaIds.length === 0) {
        setSeries([]);
        setLoading(false);
        return;
      }

      // Build placeholders for SQL IN clause
      const placeholders = mediaIds.map(() => '?').join(',');
      const seriesData: StoredSeries[] = await dbInstance.select(
        `SELECT * FROM vodSeries WHERE series_id IN (${placeholders})`,
        mediaIds
      );

      // Create a map for quick lookup
      const seriesMap = new Map(seriesData.map(s => [s.series_id, s]));

      // Order series according to watch history order with progress
      const orderedSeries: RecentlyWatchedItem<StoredSeries>[] = history
        .map(h => {
          const seriesItem = seriesMap.get(h.media_id);
          if (!seriesItem) return null;
          const progressSeconds = h.progress_seconds ?? 0;
          const totalDuration = h.total_duration ?? 0;
          return {
            item: seriesItem,
            progress_seconds: progressSeconds,
            total_duration: totalDuration,
            progress_percent: totalDuration > 0 
              ? Math.round((progressSeconds / totalDuration) * 100) 
              : 0,
            watched_at: h.watched_at,
            season_num: h.season_num,
            episode_num: h.episode_num,
            episode_title: h.episode_title,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null) as RecentlyWatchedItem<StoredSeries>[];

      setSeries(orderedSeries);
    } catch (error) {
      console.error('[useRecentlyWatchedSeries] Error:', error);
      setSeries([]);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  // Initial load and reactive updates
  const historySignature = useLiveQuery(async () => {
    // Fetch count and latest timestamp to trigger updates on any change (including deletes)
    const dbInstance = await (db as any).dbPromise;
    const result = await dbInstance.select(
      'SELECT COUNT(*) as count, MAX(watched_at) as latest FROM vod_history WHERE media_type = ?',
      ['series']
    );
    // Combine count and latest into a signature that changes on any modification
    return `${result?.[0]?.count || 0}-${result?.[0]?.latest || 0}`;
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, historySignature]);

  return {
    series,
    loading,
    refresh,
  };
}

// ============================================================================
// Episode Progress Hooks
// ============================================================================

import { getSeriesEpisodeProgress, type EpisodeWatchHistory } from '../db';

export interface EpisodeProgress {
  episodeId: string;
  progressSeconds: number;
  totalDuration: number;
  progressPercent: number;
  completed: boolean;
}

/**
 * Get progress for all episodes in a series
 */
export function useSeriesEpisodeProgress(seriesId: string | null) {
  const [episodeProgress, setEpisodeProgress] = useState<Map<string, EpisodeProgress>>(new Map());
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!seriesId) {
      setEpisodeProgress(new Map());
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const history = await getSeriesEpisodeProgress(seriesId);
      const progressMap = new Map<string, EpisodeProgress>();
      
      for (const item of history) {
        const totalDuration = item.total_duration ?? 0;
        const progressSeconds = item.progress_seconds ?? 0;
        progressMap.set(item.episode_id, {
          episodeId: item.episode_id,
          progressSeconds,
          totalDuration,
          progressPercent: totalDuration > 0 ? Math.round((progressSeconds / totalDuration) * 100) : 0,
          completed: item.completed === 1,
        });
      }
      
      setEpisodeProgress(progressMap);
    } catch (error) {
      console.error('[useSeriesEpisodeProgress] Error:', error);
      setEpisodeProgress(new Map());
    } finally {
      setLoading(false);
    }
  }, [seriesId]);

  // Initial load and reactive updates
  const watched = useLiveQuery(async () => {
    if (!seriesId) return 0;
    const dbInstance = await (db as any).dbPromise;
    const result = await dbInstance.select(
      'SELECT MAX(watched_at) as latest FROM episode_history WHERE series_id = ?',
      [seriesId]
    );
    return result?.[0]?.latest || 0;
  }, [seriesId]);

  useEffect(() => {
    refresh();
  }, [refresh, watched]);

  return {
    episodeProgress,
    loading,
    refresh,
  };
}
