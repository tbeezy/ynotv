import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import i18n, { translateNativeError } from '../i18n';
import { dbEvents } from '../db/sqlite-adapter';
import { useLiveQuery } from './useSqliteLiveQuery';
import { db, type StoredMovie, type StoredSeries, type StoredEpisode, type VodCategory, type VodWatchHistory, type EpisodeWatchHistory, getRecentlyWatchedByType } from '../db';
import { syncSeriesEpisodes, syncAllVod, type VodSyncResult } from '../db/sync';
import type { Source } from '@ynotv/core';
import { useEnabledSources } from './useChannels';
import { useSettingsStore } from '../stores/settingsStore';
import { useToastStore } from '../stores/toastStore';
import { useVodHiddenItemsStore } from '../stores/vodHiddenItemsStore';
import { getTmdbImageUrl, TMDB_POSTER_SIZES } from '../services/tmdb';
import { getSearchVariants, matchesSearch } from '../utils/searchNormalization';
import {
  readStalkerCategoryCacheMarker,
  writeStalkerCategoryCacheMarker,
  isLikelyTruncatedStalkerCache,
} from '../utils/stalkerCategoryCache';
import {
  readLocalLibrary,
  groupLocal,
  localEntryToStoredMovie,
  localGroupToStoredSeries,
  localEntryToStoredEpisode,
  useLocalLibrary,
  ensureLocalLibraryLoaded,
} from '../services/local-library/local-library';
import type { LocalEntry } from '../services/local-library/types';

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
        const searchWords = search.trim().split(/\s+/).filter(Boolean);
        const wordSqlParts: string[] = [];
        for (const word of searchWords) {
          const variants = getSearchVariants(word);
          const fieldClauses: string[] = [];
          for (const v of variants) {
            fieldClauses.push(`name LIKE ?`, `title LIKE ?`);
            params.push(`%${v}%`, `%${v}%`);
          }
          wordSqlParts.push(`(${fieldClauses.join(' OR ')})`);
        }
        const searchClauses = wordSqlParts.join(' AND ');
        if (searchClauses) {
          queryStr += ` AND (${searchClauses})`;
        }
      }

      queryStr += ` ORDER BY name LIMIT ${limit}`;
      allMovies = await dbInstance.select(queryStr, params);
    } else {
      // No enabled sources - return empty results
      return [];
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
        const searchWords = search.trim().split(/\s+/).filter(Boolean);
        const wordSqlParts: string[] = [];
        for (const word of searchWords) {
          const variants = getSearchVariants(word);
          const fieldClauses: string[] = [];
          for (const v of variants) {
            fieldClauses.push(`name LIKE ?`, `title LIKE ?`);
            params.push(`%${v}%`, `%${v}%`);
          }
          wordSqlParts.push(`(${fieldClauses.join(' OR ')})`);
        }
        const searchClauses = wordSqlParts.join(' AND ');
        if (searchClauses) {
          queryStr += ` AND (${searchClauses})`;
        }
      }

      queryStr += ` ORDER BY name LIMIT ${limit}`;
      allSeries = await dbInstance.select(queryStr, params);
    } else {
      // No enabled sources - return empty results
      return [];
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

  // Get cached episodes from DB (or local library for local series)
  const episodes = useLiveQuery(
    async () => {
      if (!seriesId) return [];
      if (seriesId.startsWith('local_')) {
        const localEntries = readLocalLibrary();
        const groups = groupLocal(localEntries);
        const targetKey = seriesId.replace(/^local_/, '').toLowerCase();
        const matchingGroup = groups.find(
          (g) => g.kind === 'show' && g.key.toLowerCase() === targetKey
        );
        if (matchingGroup && matchingGroup.kind === 'show') {
          return matchingGroup.episodes
            .filter((ep) => !ep.unavailable)
            .map((ep) =>
              localEntryToStoredEpisode(ep, seriesId, matchingGroup.head.title)
            );
        }
        return [];
      }
      return db.vodEpisodes.where('series_id').equals(seriesId).toArray();
    },
    [seriesId]
  );

  // Fetch episodes if not cached
  const fetchEpisodes = useCallback(async () => {
    console.log('[useSeriesDetails] fetchEpisodes called for:', seriesId);
    if (!seriesId || !window.storage || seriesId.startsWith('local_')) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Get the source for this series
      const series = await db.vodSeries.get(seriesId);
      if (!series) {
        console.error('[useSeriesDetails] Series not found in DB:', seriesId);
        setError(i18n.t('vod:seriesNotFound'));
        return;
      }

      console.log('[useSeriesDetails] Found series in DB, looking for source:', series.source_id);
      const sourcesResult = await window.storage.getSources();
      const source = sourcesResult.data?.find(s => String(s.id) === String(series.source_id));

      if (!source) {
        console.error('[useSeriesDetails] Source not found:', series.source_id);
        setError(i18n.t('vod:sourceNotFound'));
        return;
      }

      console.log('[useSeriesDetails] Found source, syncing episodes...');
      await syncSeriesEpisodes(source, seriesId);
      console.log('[useSeriesDetails] Sync complete');
    } catch (err) {
      console.error('[useSeriesDetails] Error:', err);
      setError(translateNativeError(err instanceof Error ? err.message : undefined) || i18n.t('vod:failedToFetchEpisodes'));
    } finally {
      setLoading(false);
    }
  }, [seriesId]);

  // Fetch fresh episodes from the provider once per series whenever the
  // details view opens. Episodes are NOT part of the playlist sync (only
  // series metadata is), and previously this fetched only when the DB had
  // zero episodes for the series — so once cached, new episodes added by the
  // provider never showed up until the user cleared the VOD cache.
  // The Set tracks which series this mount has already tried so a series that
  // genuinely has 0 episodes doesn't cause an infinite fetch loop.
  const fetchAttempted = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (seriesId && !seriesId.startsWith('local_') && !loading && !fetchAttempted.current.has(seriesId)) {
      fetchAttempted.current.add(seriesId);
      fetchEpisodes();
    }
  }, [seriesId, fetchEpisodes, loading]);

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
 * Get VOD categories by type (excludes empty categories and disabled sources)
 */
export function useVodCategories(type: 'movie' | 'series') {
  const enabledSourceIds = useEnabledSources();
  
  // Create a stable key for enabled sources to prevent unnecessary re-renders
  const enabledSourceKey = useMemo(
    () => (enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading'),
    [enabledSourceIds]
  );
  
  const categories = useLiveQuery(async () => {
    const allCategories = await db.vodCategories.where('type').equals(type).toArray();

    // Only return enabled categories from enabled sources, ordered by display_order
    return allCategories
      .filter(cat => cat.enabled !== false && enabledSourceIds?.has(cat.source_id))
      .sort((a, b) => {
        if (a.display_order !== undefined && b.display_order !== undefined) {
           return a.display_order - b.display_order;
        }
        if (a.display_order !== undefined) return -1;
        if (b.display_order !== undefined) return 1;
        return a.name.localeCompare(b.name);
      });
  }, [type, enabledSourceKey]);

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
      setError(translateNativeError(err instanceof Error ? err.message : undefined) || i18n.t('vod:syncFailed'));
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
  // Start as true so the initial render (before the first useEffect fires)
  // never shows the empty state — it shows a spinner instead.
  const [loading, setLoading] = useState(true);
  const enabledSourceIds = useEnabledSources();
  // Reload the list whenever the user hides/unhides a title.
  const hiddenVersion = useVodHiddenItemsStore((s) => s.version);
  
  // Create a stable key for enabled sources to prevent unnecessary re-renders
  const enabledSourceKey = useMemo(
    () => (enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading'),
    [enabledSourceIds]
  );

  // Increment to force a data reload (used by dbEvents subscription)
  const [reloadToken, setReloadToken] = useState(0);

  // Track previous refreshTrigger to only reload when it transitions false->true
  const prevRefreshTrigger = useRef(refreshTrigger);
  const shouldRefresh = useMemo(() => {
    // Only refresh when refreshTrigger changes from falsy to truthy
    // (indicating lazy loading actually completed, not just initial false state)
    const should = !prevRefreshTrigger.current && !!refreshTrigger;
    prevRefreshTrigger.current = refreshTrigger;
    return should;
  }, [refreshTrigger]);

  // Subscribe to vodMovies / vodCategories DB events so native-Rust sync
  // (which bypasses useLiveQuery) still triggers a UI refresh.
  useEffect(() => {
    const unsub1 = dbEvents.subscribe('vodMovies', () => setReloadToken(t => t + 1));
    const unsub2 = dbEvents.subscribe('vodCategories', () => setReloadToken(t => t + 1));
    return () => { unsub1(); unsub2(); };
  }, []);

  // Load all items at once.
  // IMPORTANT: setAllItems([]) and setLoading(true) are called together inside loadAll
  // so React 18 batches them into a single render—preventing the "No results found"
  // flash that occurred when a separate reset effect ran with loading still false.
  useEffect(() => {
    const loadAll = async () => {
      // Reset items AND set loading in the same async call so React batches the
      // state updates together, avoiding the empty-state flash.
      setAllItems([]);
      setLoading(true);

      // GUARD: If sources are still loading (enabledSourceIds === null), bail out BEFORE
      // the try/finally block so setLoading(false) does NOT fire from finally{}.
      // loading stays true — the effect re-runs once enabledSourceKey changes from 'loading'.
      if (enabledSourceIds === null) {
        return;
      }

      try {
        const dbInstance = await (db as any).dbPromise;

        // Build WHERE clause
        // 1. Filter out disabled categories and disabled sources
        const allCategories = await db.vodCategories.where('type').equals('movie').toArray();
        const enabledCategories = allCategories.filter(c =>
          c.enabled !== false && enabledSourceIds?.has(c.source_id)
        );
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
          
          // Use json_each to efficiently match category_ids JSON array.
          // Movies with empty/null category_ids are also included via the orphan condition below.
          whereClause = `source_id IN (${sourcePlaceholders}) AND (cat.value IN (${categoryPlaceholders}) OR cat.value IS NULL)`;
          params.push(...sourceIds, ...allEnabledCategoryIds);
        }

        // Always include orphaned movies (no category) from enabled sources
        const sourceList = Object.keys(enabledBySource);
        const orphanCondition = sourceList.length > 0
          ? `(source_id IN (${sourceList.map(() => '?').join(',')}) AND (category_ids IS NULL OR category_ids = '[]' OR NOT json_valid(category_ids)))`
          : `(category_ids IS NULL OR category_ids = '[]' OR NOT json_valid(category_ids))`;
        const orphanParams = sourceList.length > 0 ? [...sourceList] : [];

        let finalWhere: string;
        let finalParams: any[];
        if (whereClause) {
          finalWhere = `(${orphanCondition} OR (${whereClause}))`;
          finalParams = [...orphanParams, ...params];
        } else {
          finalWhere = orphanCondition;
          finalParams = orphanParams;
        }

        if (categoryId) {
          // Use JSON-style matching with quotes to avoid substring matches
          finalWhere += ' AND category_ids LIKE ?';
          finalParams.push(`%"${categoryId}"%`);
        }

        if (search) {
          const searchWords = search.trim().split(/\s+/).filter(Boolean);
          const wordSqlParts: string[] = [];
          for (const word of searchWords) {
            const variants = getSearchVariants(word);
            const fieldClauses: string[] = [];
            for (const v of variants) {
              fieldClauses.push(`name LIKE ?`, `title LIKE ?`);
              finalParams.push(`%${v}%`, `%${v}%`);
            }
            wordSqlParts.push(`(${fieldClauses.join(' OR ')})`);
          }
          const searchClauses = wordSqlParts.join(' AND ');
          if (searchClauses) {
            finalWhere += ` AND (${searchClauses})`;
          }
        }

        // Exclude titles the user chose to hide (see vodHiddenItemsStore).
        finalWhere += ` AND m.stream_id NOT IN (SELECT media_id FROM vod_hidden_items WHERE media_type = 'movie')`;

        // Load all items (no LIMIT)
        // Use LEFT JOIN json_each so movies with empty/null category_ids are not excluded
        const orderColumn = sortBy === 'added' ? 'added' : sortBy === 'popularity' ? 'popularity' : 'name';
        const orderDir = sortBy === 'added' ? 'DESC' : 'ASC';

        const items = await dbInstance.select(
          `SELECT DISTINCT m.* 
           FROM vodMovies m 
           LEFT JOIN json_each(m.category_ids) AS cat ON json_valid(m.category_ids) AND m.category_ids != '[]'
           WHERE ${finalWhere} 
           ORDER BY ${orderColumn} ${orderDir}`,
          finalParams
        );

        let mergedItems = items;
        if (search && search.trim().length > 0 && (categoryId === null || categoryId === 'local')) {
          try {
            const localEntries = readLocalLibrary();
            const matchingLocalMovies = localEntries
              .filter((e) => e.type !== 'show' && !e.unavailable && (matchesSearch(e.title, search) || matchesSearch(e.filename, search)))
              .map(localEntryToStoredMovie);

            if (matchingLocalMovies.length > 0) {
              mergedItems = [...items, ...matchingLocalMovies];
              if (sortBy === 'added') {
                mergedItems.sort((a: StoredMovie, b: StoredMovie) => {
                  const tA = a.added ? (typeof a.added === 'number' ? a.added : new Date(a.added).getTime()) : 0;
                  const tB = b.added ? (typeof b.added === 'number' ? b.added : new Date(b.added).getTime()) : 0;
                  return tB - tA;
                });
              } else if (sortBy === 'popularity') {
                mergedItems.sort((a: StoredMovie, b: StoredMovie) => (b.popularity || 0) - (a.popularity || 0));
              } else {
                mergedItems.sort((a: StoredMovie, b: StoredMovie) => (a.title || a.name || '').localeCompare(b.title || b.name || ''));
              }
            }
          } catch (localErr) {
            console.error('[useWindowedMovies] Error loading matching local movies:', localErr);
          }
        }

        setAllItems(mergedItems);
        setTotalCount(mergedItems.length);
      } catch (error) {
        console.error('[useWindowedMovies] Error loading movies:', error);
      } finally {
        setLoading(false);
      }
    };

    loadAll();
  }, [categoryId, search, sortBy, reloadToken, shouldRefresh, enabledSourceKey, hiddenVersion]);

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
  // Start as true so the initial render (before the first useEffect fires)
  // never shows the empty state — it shows a spinner instead.
  const [loading, setLoading] = useState(true);
  const enabledSourceIds = useEnabledSources();
  // Reload the list whenever the user hides/unhides a title.
  const hiddenVersion = useVodHiddenItemsStore((s) => s.version);
  
  // Create a stable key for enabled sources to prevent unnecessary re-renders
  const enabledSourceKey = useMemo(
    () => (enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading'),
    [enabledSourceIds]
  );

  // Track previous refreshTrigger to only reload when it transitions false->true
  const prevRefreshTriggerRef = useRef(refreshTrigger);
  const shouldRefreshSeries = useMemo(() => {
    // Only refresh when refreshTrigger changes from falsy to truthy
    const should = !prevRefreshTriggerRef.current && !!refreshTrigger;
    prevRefreshTriggerRef.current = refreshTrigger;
    return should;
  }, [refreshTrigger]);

  // Load all items at once.
  // IMPORTANT: setAllItems([]) and setLoading(true) are called together inside loadAll
  // so React 18 batches them into a single render—preventing the "No results found"
  // flash that occurred when a separate reset effect ran with loading still false.
  useEffect(() => {
    const loadAll = async () => {
      // Reset items AND set loading in the same async call so React batches the
      // state updates together, avoiding the empty-state flash.
      setAllItems([]);
      setLoading(true);

      // GUARD: If sources are still loading (enabledSourceIds === null), bail out BEFORE
      // the try/finally block so setLoading(false) does NOT fire from finally{}.
      // loading stays true — the effect re-runs once enabledSourceKey changes from 'loading'.
      if (enabledSourceIds === null) {
        return;
      }

      try {
        const dbInstance = await (db as any).dbPromise;

        // Build WHERE clause
        // Filter out disabled categories and disabled sources
        const allCategories = await db.vodCategories.where('type').equals('series').toArray();
        const enabledCategories = allCategories.filter(c =>
          c.enabled !== false && enabledSourceIds?.has(c.source_id)
        );
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
          const searchWords = search.trim().split(/\s+/).filter(Boolean);
          const wordSqlParts: string[] = [];
          for (const word of searchWords) {
            const variants = getSearchVariants(word);
            const fieldClauses: string[] = [];
            for (const v of variants) {
              fieldClauses.push(`name LIKE ?`, `title LIKE ?`);
              params.push(`%${v}%`, `%${v}%`);
            }
            wordSqlParts.push(`(${fieldClauses.join(' OR ')})`);
          }
          const searchClauses = wordSqlParts.join(' AND ');
          if (searchClauses) {
            whereClause += ` AND (${searchClauses})`;
          }
        }

        // Exclude titles the user chose to hide (see vodHiddenItemsStore).
        whereClause += ` AND s.series_id NOT IN (SELECT media_id FROM vod_hidden_items WHERE media_type = 'series')`;

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

        let mergedItems = items;
        if (search && search.trim().length > 0 && (categoryId === null || categoryId === 'local')) {
          try {
            const localEntries = readLocalLibrary();
            const groups = groupLocal(localEntries);
            const matchingLocalSeries = groups
              .filter((g): g is { kind: 'show'; key: string; head: LocalEntry; episodes: LocalEntry[] } => {
                if (g.kind !== 'show') return false;
                if (g.episodes.length > 0 && g.episodes.every((ep) => ep.unavailable)) return false;
                return (
                  matchesSearch(g.head.title, search) ||
                  matchesSearch(g.head.filename, search) ||
                  g.episodes.some((ep) => !ep.unavailable && (matchesSearch(ep.title, search) || matchesSearch(ep.filename, search)))
                );
              })
              .map(localGroupToStoredSeries);

            if (matchingLocalSeries.length > 0) {
              mergedItems = [...items, ...matchingLocalSeries];
              if (sortBy === 'added') {
                mergedItems.sort((a: StoredSeries, b: StoredSeries) => {
                  const tA = a.added ? (typeof a.added === 'number' ? a.added : new Date(a.added).getTime()) : 0;
                  const tB = b.added ? (typeof b.added === 'number' ? b.added : new Date(b.added).getTime()) : 0;
                  return tB - tA;
                });
              } else if (sortBy === 'popularity') {
                mergedItems.sort((a: StoredSeries, b: StoredSeries) => (b.popularity || 0) - (a.popularity || 0));
              } else {
                mergedItems.sort((a: StoredSeries, b: StoredSeries) => (a.title || a.name || '').localeCompare(b.title || b.name || ''));
              }
            }
          } catch (localErr) {
            console.error('[useWindowedSeries] Error loading matching local series:', localErr);
          }
        }

        setAllItems(mergedItems);
        setTotalCount(mergedItems.length);
      } catch (error) {
        console.error('[useWindowedSeries] Error loading series:', error);
      } finally {
        setLoading(false);
      }
    };

    loadAll();
  }, [categoryId, search, sortBy, shouldRefreshSeries, enabledSourceKey, hiddenVersion]);

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
 * All movies for browse view (optionally filtered by category)
 * Returns items sorted alphabetically - Virtuoso handles virtualization
 * Pass null for categoryId to get ALL movies
 * Supports infinite scrolling with windowed loading
 * 
 * @param refreshTrigger - Optional trigger to force re-query (e.g., when lazy loading completes)
 */
export function usePaginatedMovies(
  categoryId: string | null,
  search?: string,
  sortBy: 'name' | 'added' = 'name',
  refreshTrigger?: boolean
) {
  // Use windowed query for proper infinite scroll
  return useWindowedMovies(categoryId, search, sortBy, refreshTrigger);
}

/**
 * All series for browse view (optionally filtered by category)
 * Returns items sorted alphabetically - Virtuoso handles virtualization
 * Pass null for categoryId to get ALL series
 * Supports infinite scrolling with windowed loading
 * 
 * @param refreshTrigger - Optional trigger to force re-query (e.g., when lazy loading completes)
 */
export function usePaginatedSeries(
  categoryId: string | null,
  search?: string,
  sortBy: 'name' | 'added' = 'name',
  refreshTrigger?: boolean
) {
  // Use windowed query for proper infinite scroll
  return useWindowedSeries(categoryId, search, sortBy, refreshTrigger);
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
 * - Implements timestamp-based caching (TTL configurable via Settings ->
 *   Sources -> Stalker Preferences; 5 minute default)
 */
export function useLazyStalkerLoader(type: 'movies' | 'series', categoryId: string | null) {
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [completed, setCompleted] = useState(false);
  const [hasCache, setHasCache] = useState(false);

  // Storage key for last-sync timestamp (keyed per category + type)
  const syncTimestampKey = categoryId ? `stalker_sync_ts_${type}_${categoryId}` : null;

  useEffect(() => {
    // cancelled guards against a sync started for a previous category writing
    // state after the user has navigated away (e.g. back to "All").
    let cancelled = false;

    // Category cache TTL comes from Settings -> Sources -> Stalker Preferences
    // (default 5 min). 0 disables caching — every open of a category refetches
    // its items in the background while the cached items stay visible.
    const stalkerCacheMinutes = useSettingsStore.getState().stalkerCategoryCacheMinutes;
    const stalkerCacheTtlMs = stalkerCacheMinutes > 0 ? stalkerCacheMinutes * 60 * 1000 : 0;

    if (!categoryId) {
      // Leaving a category (e.g. switching to "All"): reset ALL lazy-load
      // state. Previously only completed/hasCache were cleared, so a stalker
      // sync started in a category kept `syncing=true` and the "All" view
      // showed the full-page stalker loading screen.
      setCompleted(false);
      setHasCache(false);
      setSyncing(false);
      setProgress(0);
      setMessage('');
      return () => { cancelled = true; };
    }

    const checkAndSync = async () => {
      // Reset completion state when category changes
      setCompleted(false);

      // 1. Get category to find source_id
      const category = await db.vodCategories.get(categoryId);
      if (cancelled) return;
      if (!category) return;

      // 2. Check if source is Stalker
      // We need window.storage to check source type
      if (!window.storage) return;
      const sourceRes = await window.storage.getSource(category.source_id);
      if (cancelled) return;
      const source = sourceRes.data;

      // Non-stalker category: nothing to lazy-load. Clear any state left over
      // from a previous stalker category so it can't keep showing that
      // category's full-page loading screen.
      if (!source || source.type !== 'stalker') {
        setSyncing(false);
        setProgress(0);
        setMessage('');
        setHasCache(false);
        return;
      }

      // 3. Check if we already have items for this category
      const table = type === 'movies' ? db.vodMovies : db.vodSeries;
      const existingItems = await table
        .where('category_ids')
        .equals(categoryId)
        .limit(1)
        .toArray();
      if (cancelled) return;

      const count = existingItems.length;

      // Check cache freshness using a localStorage marker keyed per category+type.
      // NOTE: We intentionally do NOT use item.added for this check — that field reflects
      // the content's original publish date (e.g. "2019-01-01"), not when WE last synced it.
      let cacheIsFresh = false;
      let cacheLooksTruncated = false;
      if (count > 0) {
        // We have cached data - show it immediately
        setHasCache(true);

        if (syncTimestampKey) {
          const marker = readStalkerCategoryCacheMarker(localStorage.getItem(syncTimestampKey));
          if (marker.syncedAt != null) {
            cacheIsFresh = (Date.now() - marker.syncedAt) < stalkerCacheTtlMs;
          }

          // Markers written before the Stalker page-offset fix can't prove their rows came from
          // offset-correct pagination, and a category cached as a single page (14 items) is the
          // signature of that truncation. Refetch it now rather than waiting out the cache TTL.
          //
          // The forced refetch happens once per marker. It records the attempt while keeping the
          // "may be truncated" flag, so a refetch that fails or is deferred leaves the suspicion
          // in place (the count check above still applies to the next marker) but does not force
          // a sync — and an error toast — on every single open; the cache timer takes over.
          if (marker.legacy && marker.healAttemptedAt == null) {
            const storedItemCount = await table.where('category_ids').equals(categoryId).count();
            if (cancelled) return;
            if (isLikelyTruncatedStalkerCache(marker, storedItemCount)) {
              cacheLooksTruncated = true;
              console.log(`[useLazyStalkerLoader] ${type} cache for ${categoryId} looks truncated (${storedItemCount} items); refetching now`);
              localStorage.setItem(syncTimestampKey, writeStalkerCategoryCacheMarker({
                syncedAt: marker.syncedAt ?? undefined,
                legacy: true,
                healAttemptedAt: Date.now(),
              }));
            }
          }
        }
        console.log(`[useLazyStalkerLoader] ${type} cache found for ${categoryId}: ${count} items, fresh: ${cacheIsFresh}${cacheLooksTruncated ? ', truncated' : ''}`);
      }

      // Only sync if there is no cache, the cache is stale, or the cached rows look truncated
      if (count === 0 || !cacheIsFresh || cacheLooksTruncated) {
        // Don't start a background sync while a stream URL is being resolved
        // (e.g. during playback or download initiation) to avoid racing token refresh
        // with the get_ordered_list batch fetches.
        if ((window as any).isPlaybackResolving) {
          console.log(`[useLazyStalkerLoader] Deferring ${type} sync for ${categoryId} - stream resolution in progress`);
          if (!cancelled) setCompleted(true);
          return;
        }

        setSyncing(true);
        // message stays empty until real progress arrives — VodBrowse renders
        // its own localized "Loading..." heading, so mirroring it here made
        // the loading status appear twice on screen.
        try {
          const { syncStalkerCategory } = await import('../db/sync');
          await syncStalkerCategory(source.id, categoryId, type, (pct, msg) => {
            if (cancelled) return;
            setProgress(pct);
            setMessage(msg);
          });
          if (cancelled) return;
          // Record a successful sync so the cache check works next time. This writes a clean
          // marker, which also clears any leftover "rows may be truncated" suspicion.
          if (syncTimestampKey) {
            localStorage.setItem(syncTimestampKey, writeStalkerCategoryCacheMarker());
          }
          console.log(`[useLazyStalkerLoader] ${type} sync completed for ${categoryId}`);
        } catch (e) {
          if (cancelled) return;
          console.error('[useLazyStalkerLoader] Sync failed:', e);
          setMessage(i18n.t('vod:syncFailed'));
          // Surface the underlying fetch failure (e.g. an HTTP error from one
          // of the concurrent Stalker page requests) as a bottom-right toast,
          // so it remains visible even after the category loading overlay
          // dismisses. The category name (if any) gives context.
          const detail = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
          if (detail) {
            const friendly = translateNativeError(detail) || detail;
            const label = category?.name || '';
            useToastStore.getState().addToast(
              label ? `${label}: ${friendly}` : friendly,
              'error'
            );
          }
        } finally {
          if (!cancelled) {
            setSyncing(false);
            setProgress(0);
            setMessage('');
            setCompleted(true); // Signal that sync completed (success or failure)
          }
        }
      } else {
        // Cache is fresh, no need to sync
        console.log(`[useLazyStalkerLoader] ${type} using fresh cache for ${categoryId}`);
        setCompleted(true);
      }
    };

    checkAndSync();

    return () => { cancelled = true; };
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
  const enabledSourceIds = useEnabledSources();
  const localEntries = useLocalLibrary();
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

      // Separate local and remote media IDs
      const localMediaIds = new Set(mediaIds.filter(id => id.startsWith('local_')));
      const remoteMediaIds = mediaIds.filter(id => !id.startsWith('local_'));

      let remoteMoviesData: StoredMovie[] = [];
      if (remoteMediaIds.length > 0) {
        const placeholders = remoteMediaIds.map(() => '?').join(',');
        remoteMoviesData = await dbInstance.select(
          `SELECT * FROM vodMovies WHERE stream_id IN (${placeholders})`,
          remoteMediaIds
        );
      }

      // Create a map for quick lookup
      const movieMap = new Map(remoteMoviesData.map(m => [m.stream_id, m]));

      // Populate local movies
      if (localMediaIds.size > 0) {
        for (const entry of localEntries) {
          if (entry.unavailable) continue;
          if (entry.type === 'movie' || !entry.type) {
            const streamId = `local_${entry.id}`;
            if (localMediaIds.has(streamId)) {
              movieMap.set(streamId, localEntryToStoredMovie(entry));
            }
          }
        }
      }

      // Order movies according to watch history order with progress
      const orderedMovies = history
        .map(h => {
          const movie = movieMap.get(h.media_id);
          if (!movie) return null;
          if (enabledSourceIds && movie.source_id !== 'local' && !enabledSourceIds.has(movie.source_id)) return null;
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
  }, [limit, enabledSourceIds, localEntries]);

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
  const enabledSourceIds = useEnabledSources();
  const localEntries = useLocalLibrary();
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

      // Separate local series IDs from remote series IDs
      const localMediaIds = new Set(mediaIds.filter(id => id.startsWith('local_')));
      const remoteMediaIds = mediaIds.filter(id => !id.startsWith('local_'));

      let remoteSeriesData: StoredSeries[] = [];
      if (remoteMediaIds.length > 0) {
        const placeholders = remoteMediaIds.map(() => '?').join(',');
        remoteSeriesData = await dbInstance.select(
          `SELECT * FROM vodSeries WHERE series_id IN (${placeholders})`,
          remoteMediaIds
        );
      }

      // Create a map for quick lookup
      const seriesMap = new Map(remoteSeriesData.map(s => [s.series_id, s]));

      // For local series, group them and populate seriesMap & localSeriesEpisodesMap
      const localSeriesEpisodesMap = new Map<string, StoredEpisode[]>();
      if (localMediaIds.size > 0) {
        const groups = groupLocal(localEntries);
        for (const g of groups) {
          if (g.kind === 'show') {
            if (g.episodes.length > 0 && g.episodes.every((e) => e.unavailable)) continue;
            const seriesId = `local_${g.key}`;
            const matchingMediaIds = Array.from(localMediaIds).filter(
              id => id.toLowerCase() === seriesId.toLowerCase() ||
                    id.toLowerCase().replace(/[^a-z0-9]+/g, '_') === seriesId.toLowerCase().replace(/[^a-z0-9]+/g, '_')
            );

            const storedSeries = localGroupToStoredSeries(g);
            seriesMap.set(seriesId, storedSeries);
            for (const mid of matchingMediaIds) {
              seriesMap.set(mid, storedSeries);
            }

            const storedEpisodes: StoredEpisode[] = g.episodes
              .filter((ep) => !ep.unavailable)
              .slice()
              .sort((a, b) => (a.season ?? 1) - (b.season ?? 1) || (a.episode ?? 1) - (b.episode ?? 1))
              .map(ep => localEntryToStoredEpisode(ep, seriesId, g.head.title));
            
            localSeriesEpisodesMap.set(seriesId, storedEpisodes);
            for (const mid of matchingMediaIds) {
              localSeriesEpisodesMap.set(mid, storedEpisodes);
            }
          }
        }
      }

      // Order series according to watch history order with dynamic next-episode resolution
      const resolvedSeries = await Promise.all(
        history.map(async (h) => {
          const seriesItem = seriesMap.get(h.media_id);
          if (!seriesItem) return null;
          if (enabledSourceIds && seriesItem.source_id !== 'local' && !enabledSourceIds.has(seriesItem.source_id)) return null;

          let displaySeason = h.season_num;
          let displayEpisode = h.episode_num;
          let displayTitle = h.episode_title;
          let displayProgressSeconds = h.progress_seconds ?? 0;
          let displayTotalDuration = h.total_duration ?? 0;

          try {
            let episodes: StoredEpisode[] = [];
            if (h.media_id.startsWith('local_')) {
              episodes = localSeriesEpisodesMap.get(h.media_id) || [];
            } else {
              // Get all episodes for this series ordered by season and episode
              episodes = await dbInstance.select(
                'SELECT * FROM vodEpisodes WHERE series_id = ? ORDER BY season_num, episode_num',
                [h.media_id]
              );
            }

            // Get episode progress for this series (match series_id flexibly)
            const episodeHistory: EpisodeWatchHistory[] = await dbInstance.select(
              'SELECT * FROM episode_history WHERE LOWER(series_id) = LOWER(?) OR LOWER(series_id) = LOWER(?)',
              [h.media_id, `local_${h.media_id.replace(/^local_/, '').replace(/[^a-z0-9]+/g, '_')}`]
            );

            if (episodes && episodes.length > 0) {
              const epHistMap = new Map(episodeHistory.map(eh => [eh.episode_id, eh]));

              // Prefer the exact episode saved in vod_history (e.g. S2 E7) so "Continue
              // watching" resumes where the user actually left off, even when earlier
              // episodes were skipped and have no completion record.
              let targetEp: StoredEpisode | null = null;
              let targetHist: EpisodeWatchHistory | null = null;

              if (h.season_num && h.season_num > 0 && h.episode_num && h.episode_num > 0) {
                const savedEp = episodes.find(
                  ep => ep.season_num === h.season_num && ep.episode_num === h.episode_num
                );
                if (savedEp) {
                  targetEp = savedEp;
                  targetHist = epHistMap.get(savedEp.id) || null;
                }
              }

              // Fallback (only when the episode saved in vod_history is no longer in the
              // catalog): find the first uncompleted episode (or the last episode if all
              // are completed). Must NOT override the saved episode - that is what made
              // "Recent" jump to S1E1 or an earlier skipped episode.
              if (!targetEp) {
                for (const ep of episodes) {
                  const eh = epHistMap.get(ep.id);
                  const dur = eh?.total_duration ?? ep.duration ?? 0;
                  const pos = eh?.progress_seconds ?? 0;
                  const isEpCompleted = eh ? (
                    eh.completed === 1 || 
                    (dur > 0 && (pos / dur) >= 0.90)
                  ) : false;

                  if (!isEpCompleted) {
                    targetEp = ep;
                    targetHist = eh || null;
                    break;
                  }
                }
              }

              if (targetEp) {
                displaySeason = targetEp.season_num;
                displayEpisode = targetEp.episode_num;
                displayTitle = targetEp.title || `Episode ${targetEp.episode_num}`;
                displayProgressSeconds = targetHist?.progress_seconds ?? 0;
                displayTotalDuration = targetHist?.total_duration || targetEp.duration || 0;
              } else {
                // All episodes completed - show final episode with 100% progress
                const lastEp = episodes[episodes.length - 1];
                const lastHist = epHistMap.get(lastEp.id);
                displaySeason = lastEp.season_num;
                displayEpisode = lastEp.episode_num;
                displayTitle = lastEp.title || `Episode ${lastEp.episode_num}`;
                displayProgressSeconds = lastHist?.progress_seconds || 1;
                displayTotalDuration = lastHist?.total_duration || lastEp.duration || 1;
              }
            }
          } catch (e) {
            console.warn('[useRecentlyWatchedSeries] Failed to resolve next episode:', e);
          }

          const progressPercent = displayTotalDuration > 0
            ? Math.min(100, Math.round((displayProgressSeconds / displayTotalDuration) * 100))
            : 0;

          return {
            item: seriesItem,
            progress_seconds: displayProgressSeconds,
            total_duration: displayTotalDuration,
            progress_percent: progressPercent,
            watched_at: h.watched_at,
            season_num: displaySeason,
            episode_num: displayEpisode,
            episode_title: displayTitle,
          };
        })
      );

      const orderedSeries = resolvedSeries.filter((item): item is NonNullable<typeof item> => item !== null) as RecentlyWatchedItem<StoredSeries>[];

      setSeries(orderedSeries);
    } catch (error) {
      console.error('[useRecentlyWatchedSeries] Error:', error);
      setSeries([]);
    } finally {
      setLoading(false);
    }
  }, [limit, enabledSourceIds, localEntries]);

  // Initial load and reactive updates
  const historySignature = useLiveQuery(async () => {
    // Fetch count and latest timestamp from both vod_history and episode_history to trigger updates
    const dbInstance = await (db as any).dbPromise;
    const result = await dbInstance.select(
      'SELECT COUNT(*) as count, MAX(watched_at) as latest FROM vod_history WHERE media_type = ?',
      ['series']
    );
    const epResult = await dbInstance.select(
      'SELECT COUNT(*) as count, MAX(watched_at) as latest FROM episode_history'
    );
    return `${result?.[0]?.count || 0}-${result?.[0]?.latest || 0}-${epResult?.[0]?.count || 0}-${epResult?.[0]?.latest || 0}`;
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

import { getSeriesEpisodeProgress } from '../db';

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
  const watchedSignature = useLiveQuery(async () => {
    if (!seriesId) return '0-0';
    const dbInstance = await (db as any).dbPromise;
    const result = await dbInstance.select(
      'SELECT COUNT(*) as count, MAX(watched_at) as latest FROM episode_history WHERE series_id = ?',
      [seriesId]
    );
    return `${result?.[0]?.count || 0}-${result?.[0]?.latest || 0}`;
  }, [seriesId]);

  useEffect(() => {
    refresh();
  }, [refresh, watchedSignature]);

  return {
    episodeProgress,
    loading,
    refresh,
  };
}

/**
 * Map of media_id -> last watched timestamp (watched_at) for a VOD type.
 * Used for the "Last Watched" sort in browse and favorites views.
 */
export function useVodLastWatchedMap(type: 'movie' | 'series'): Map<string, number> {
  return useLiveQuery<Map<string, number>>(
    async () => {
      const dbInstance = await (db as any).dbPromise;
      const result = await dbInstance.select(
        'SELECT media_id, MAX(watched_at) AS watched_at FROM vod_history WHERE media_type = ? GROUP BY media_id',
        [type]
      );
      return new Map<string, number>(
        (result || []).map((r: any) => [String(r.media_id), Number(r.watched_at) || 0])
      );
    },
    [type],
    new Map<string, number>()
  ) ?? new Map<string, number>();
}
