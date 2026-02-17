/**
 * TMDB-enhanced list hooks
 *
 * These hooks provide Netflix-style curated lists by matching
 * TMDB trending/popular lists against local Xtream content.
 *
 * Uses WithCache functions that:
 * - Use direct API when access token is available
 * - Fall back to GitHub-cached lists when no token
 *
 * PERFORMANCE: Uses indexed tmdb_id lookups instead of full table scans.
 */

import { useState, useEffect, useMemo } from 'react';
import { useLiveQuery } from './useSqliteLiveQuery';
import { db, type StoredMovie, type StoredSeries } from '../db';
import {
  // WithCache functions (work with or without token)
  getTrendingMoviesWithCache,
  getTrendingTvShowsWithCache,
  getPopularMoviesWithCache,
  getPopularTvShowsWithCache,
  getTopRatedMoviesWithCache,
  getTopRatedTvShowsWithCache,
  getNowPlayingMoviesWithCache,
  getUpcomingMoviesWithCache,
  getOnTheAirTvShowsWithCache,
  getAiringTodayTvShowsWithCache,
  getMovieGenresWithCache,
  getTvGenresWithCache,
  discoverMoviesByGenreWithCache,
  discoverTvShowsByGenreWithCache,
  getCachedMovieGenreCounts,
  getCachedTvGenreCounts,
  type TmdbMovieResult,
  type TmdbTvResult,
  type TmdbGenre,
} from '../services/tmdb';

// ===========================================================================
// Settings Hook
// ===========================================================================

/**
 * Get TMDB access token from settings
 * Note: This is the "API Read Access Token" from TMDB, not the API key
 */
export function useTmdbAccessToken(): string | null {
  const [accessToken, setAccessToken] = useState<string | null>(null);

  useEffect(() => {
    async function loadToken() {
      if (!window.storage) return;
      const result = await window.storage.getSettings();
      if (result.data && 'tmdbApiKey' in result.data) {
        // Still stored as tmdbApiKey in settings for backwards compat
        setAccessToken((result.data as { tmdbApiKey?: string }).tmdbApiKey ?? null);
      }
    }
    loadToken();
  }, []);

  return accessToken;
}

// Alias for backwards compatibility
export const useTmdbApiKey = useTmdbAccessToken;

/**
 * Get enabled movie genres from settings
 * Returns undefined if not yet loaded, or array of genre IDs
 */
export function useEnabledMovieGenres(): number[] | undefined {
  const [enabledGenres, setEnabledGenres] = useState<number[] | undefined>(undefined);

  useEffect(() => {
    async function loadSettings() {
      if (!window.storage) return;
      const result = await window.storage.getSettings();
      if (result.data && 'movieGenresEnabled' in result.data) {
        setEnabledGenres((result.data as { movieGenresEnabled?: number[] }).movieGenresEnabled);
      }
    }
    loadSettings();
  }, []);

  return enabledGenres;
}

/**
 * Get enabled series genres from settings
 * Returns undefined if not yet loaded, or array of genre IDs
 */
export function useEnabledSeriesGenres(): number[] | undefined {
  const [enabledGenres, setEnabledGenres] = useState<number[] | undefined>(undefined);

  useEffect(() => {
    async function loadSettings() {
      if (!window.storage) return;
      const result = await window.storage.getSettings();
      if (result.data && 'seriesGenresEnabled' in result.data) {
        setEnabledGenres((result.data as { seriesGenresEnabled?: number[] }).seriesGenresEnabled);
      }
    }
    loadSettings();
  }, []);

  return enabledGenres;
}

// ===========================================================================
// Helper: Match TMDB list to local content using index
// ===========================================================================

/**
 * Query local movies by TMDB IDs using the tmdb_id index
 * Much faster than filtering all movies!
 */
function useMoviesByTmdbIds(tmdbIds: number[]) {
  return useLiveQuery(async () => {
    if (tmdbIds.length === 0) return [];
    // Use indexed lookup - O(log n) per ID instead of O(n) full scan
    const results = await db.vodMovies.where('tmdb_id').anyOf(tmdbIds).toArray();
    console.log(`[DEBUG useMoviesByTmdbIds] Queried ${tmdbIds.length} TMDB IDs, found ${results.length} movies`);
    if (results.length > 0) {
      console.log(`[DEBUG useMoviesByTmdbIds] First result:`, { 
        name: results[0].name, 
        tmdb_id: results[0].tmdb_id 
      });
    }
    return results;
  }, [tmdbIds.join(',')]);
}

/**
 * Query local series by TMDB IDs using the tmdb_id index
 */
function useSeriesByTmdbIds(tmdbIds: number[]) {
  return useLiveQuery(async () => {
    if (tmdbIds.length === 0) return [];
    return db.vodSeries.where('tmdb_id').anyOf(tmdbIds).toArray();
  }, [tmdbIds.join(',')]);
}

/**
 * Filter to items in TMDB order map, then sort by that order
 */
function sortByTmdbOrder<T extends { tmdb_id?: number }>(
  items: T[],
  tmdbOrder: Map<number, number>
): T[] {
  return items
    .filter((item) => item.tmdb_id !== undefined && tmdbOrder.has(item.tmdb_id))
    .sort(
      (a, b) =>
        (tmdbOrder.get(a.tmdb_id!) ?? 0) - (tmdbOrder.get(b.tmdb_id!) ?? 0)
    );
}

// ===========================================================================
// Generic hook factory for TMDB movie lists
// ===========================================================================

function useMovieList(
  fetchFn: (token?: string | null) => Promise<TmdbMovieResult[]>,
  accessToken: string | null
) {
  const [tmdbMovies, setTmdbMovies] = useState<TmdbMovieResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    fetchFn(accessToken)
      .then((results) => {
        console.log(`[DEBUG useMovieList] Fetched ${results.length} movies from TMDB`);
        if (results.length > 0) {
          console.log(`[DEBUG useMovieList] First TMDB result:`, { 
            id: results[0].id, 
            title: results[0].title 
          });
        }
        setTmdbMovies(results);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [accessToken]);

  const tmdbIds = useMemo(() => {
    console.log(`[DEBUG useMovieList] Extracting ${tmdbMovies.length} TMDB IDs`);
    return tmdbMovies.map((m) => m.id);
  }, [tmdbMovies]);
  
  const localMovies = useMoviesByTmdbIds(tmdbIds);

  const movies = useMemo(() => {
    console.log(`[DEBUG useMovieList] Combining ${tmdbMovies.length} TMDB entries with ${localMovies?.length || 0} local movies`);
    if (!localMovies || tmdbMovies.length === 0) return [];
    const tmdbOrder = new Map(tmdbMovies.map((m, i) => [m.id, i]));
    const sorted = sortByTmdbOrder(localMovies, tmdbOrder);
    console.log(`[DEBUG useMovieList] Final sorted movies: ${sorted.length}`);
    return sorted;
  }, [localMovies, tmdbMovies]);

  return {
    movies,
    loading: loading || localMovies === undefined,
    error,
  };
}

// ===========================================================================
// Generic hook factory for TMDB series lists
// ===========================================================================

function useSeriesList(
  fetchFn: (token?: string | null) => Promise<TmdbTvResult[]>,
  accessToken: string | null
) {
  const [tmdbSeries, setTmdbSeries] = useState<TmdbTvResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    fetchFn(accessToken)
      .then(setTmdbSeries)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [accessToken]);

  const tmdbIds = useMemo(() => tmdbSeries.map((s) => s.id), [tmdbSeries]);
  const localSeries = useSeriesByTmdbIds(tmdbIds);

  const series = useMemo(() => {
    if (!localSeries || tmdbSeries.length === 0) return [];
    const tmdbOrder = new Map(tmdbSeries.map((s, i) => [s.id, i]));
    return sortByTmdbOrder(localSeries, tmdbOrder);
  }, [localSeries, tmdbSeries]);

  return {
    series,
    loading: loading || localSeries === undefined,
    error,
  };
}

// ===========================================================================
// Movie List Hooks
// ===========================================================================

export function useTrendingMovies(accessToken: string | null) {
  return useMovieList(
    (token) => getTrendingMoviesWithCache(token, 'week'),
    accessToken
  );
}

export function usePopularMovies(accessToken: string | null) {
  return useMovieList(getPopularMoviesWithCache, accessToken);
}

export function useTopRatedMovies(accessToken: string | null) {
  return useMovieList(getTopRatedMoviesWithCache, accessToken);
}

export function useNowPlayingMovies(accessToken: string | null) {
  return useMovieList(getNowPlayingMoviesWithCache, accessToken);
}

export function useUpcomingMovies(accessToken: string | null) {
  return useMovieList(getUpcomingMoviesWithCache, accessToken);
}

/**
 * Get local movies sorted by popularity (no TMDB required)
 */
export function useLocalPopularMovies(limit = 20) {
  const movies = useLiveQuery(async () => {
    return db.vodMovies
      .orderBy('popularity')
      .reverse()
      .filter((m) => m.popularity !== undefined && m.popularity > 0)
      .limit(limit)
      .toArray();
  }, [limit]);

  return {
    movies: movies ?? [],
    loading: movies === undefined,
  };
}

/**
 * Get movies by genre (uses cache fallback when no access token)
 */
export function useMoviesByGenre(accessToken: string | null, genreId: number | null) {
  const [tmdbMovies, setTmdbMovies] = useState<TmdbMovieResult[]>([]);
  // Start loading=true if we have genreId - prevents brief "empty" flash before useEffect
  const [loading, setLoading] = useState(!!genreId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!genreId) return;

    setLoading(true);
    setError(null);

    discoverMoviesByGenreWithCache(accessToken, genreId)
      .then(setTmdbMovies)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [accessToken, genreId]);

  const tmdbIds = useMemo(() => tmdbMovies.map((m) => m.id), [tmdbMovies]);
  const localMovies = useMoviesByTmdbIds(tmdbIds);

  const movies = useMemo(() => {
    if (!localMovies || tmdbMovies.length === 0) return [];
    const tmdbOrder = new Map(tmdbMovies.map((m, i) => [m.id, i]));
    return sortByTmdbOrder(localMovies, tmdbOrder);
  }, [localMovies, tmdbMovies]);

  return {
    movies,
    loading: loading || localMovies === undefined,
    error,
  };
}

// ===========================================================================
// TV Series List Hooks
// ===========================================================================

export function useTrendingSeries(accessToken: string | null) {
  return useSeriesList(
    (token) => getTrendingTvShowsWithCache(token, 'week'),
    accessToken
  );
}

export function usePopularSeries(accessToken: string | null) {
  return useSeriesList(getPopularTvShowsWithCache, accessToken);
}

export function useTopRatedSeries(accessToken: string | null) {
  return useSeriesList(getTopRatedTvShowsWithCache, accessToken);
}

export function useOnTheAirSeries(accessToken: string | null) {
  return useSeriesList(getOnTheAirTvShowsWithCache, accessToken);
}

export function useAiringTodaySeries(accessToken: string | null) {
  return useSeriesList(getAiringTodayTvShowsWithCache, accessToken);
}

/**
 * Get local series sorted by popularity (no TMDB required)
 */
export function useLocalPopularSeries(limit = 20) {
  const series = useLiveQuery(async () => {
    return db.vodSeries
      .orderBy('popularity')
      .reverse()
      .filter((s) => s.popularity !== undefined && s.popularity > 0)
      .limit(limit)
      .toArray();
  }, [limit]);

  return {
    series: series ?? [],
    loading: series === undefined,
  };
}

/**
 * Get series by genre (uses cache fallback when no access token)
 */
export function useSeriesByGenre(accessToken: string | null, genreId: number | null) {
  const [tmdbSeries, setTmdbSeries] = useState<TmdbTvResult[]>([]);
  // Start loading=true if we have genreId - prevents brief "empty" flash before useEffect
  const [loading, setLoading] = useState(!!genreId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!genreId) return;

    setLoading(true);
    setError(null);

    discoverTvShowsByGenreWithCache(accessToken, genreId)
      .then(setTmdbSeries)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [accessToken, genreId]);

  const tmdbIds = useMemo(() => tmdbSeries.map((s) => s.id), [tmdbSeries]);
  const localSeries = useSeriesByTmdbIds(tmdbIds);

  const series = useMemo(() => {
    if (!localSeries || tmdbSeries.length === 0) return [];
    const tmdbOrder = new Map(tmdbSeries.map((s, i) => [s.id, i]));
    return sortByTmdbOrder(localSeries, tmdbOrder);
  }, [localSeries, tmdbSeries]);

  return {
    series,
    loading: loading || localSeries === undefined,
    error,
  };
}

// ===========================================================================
// Genre Hooks
// ===========================================================================

export function useMovieGenres(accessToken: string | null) {
  const [genres, setGenres] = useState<TmdbGenre[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getMovieGenresWithCache(accessToken)
      .then(setGenres)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [accessToken]);

  return { genres, loading };
}

export function useTvGenres(accessToken: string | null) {
  const [genres, setGenres] = useState<TmdbGenre[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getTvGenresWithCache(accessToken)
      .then(setGenres)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [accessToken]);

  return { genres, loading };
}

/**
 * Get cached movie counts per genre (for settings UI)
 * Used to show which genres have content in cache when no API key
 */
export function useCachedMovieGenreCounts(hasApiKey: boolean) {
  const [counts, setCounts] = useState<Map<number, number>>(new Map());
  const [loading, setLoading] = useState(!hasApiKey);

  useEffect(() => {
    // Only fetch counts when no API key (cache mode)
    if (hasApiKey) {
      setCounts(new Map());
      setLoading(false);
      return;
    }

    setLoading(true);
    getCachedMovieGenreCounts()
      .then(setCounts)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [hasApiKey]);

  return { counts, loading };
}

/**
 * Get cached TV show counts per genre (for settings UI)
 * Used to show which genres have content in cache when no API key
 */
export function useCachedTvGenreCounts(hasApiKey: boolean) {
  const [counts, setCounts] = useState<Map<number, number>>(new Map());
  const [loading, setLoading] = useState(!hasApiKey);

  useEffect(() => {
    // Only fetch counts when no API key (cache mode)
    if (hasApiKey) {
      setCounts(new Map());
      setLoading(false);
      return;
    }

    setLoading(true);
    getCachedTvGenreCounts()
      .then(setCounts)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [hasApiKey]);

  return { counts, loading };
}

// ===========================================================================
// Multi-Genre Hooks (pre-fetch all genres at once)
// ===========================================================================

interface GenreData<T> {
  genreId: number;
  items: T[];
  loading: boolean;
}

/**
 * Pre-fetch movies for multiple genres at once
 * Returns a Map of genreId -> { items, loading }
 */
export function useMultipleMoviesByGenre(
  accessToken: string | null,
  genreIds: number[]
): Map<number, { items: StoredMovie[]; loading: boolean }> {
  const [tmdbData, setTmdbData] = useState<Map<number, TmdbMovieResult[]>>(new Map());
  const [fetchedGenreIds, setFetchedGenreIds] = useState<string>('');

  // Track which genreIds we've fetched (as string for easy comparison)
  const genreIdsKey = genreIds.join(',');

  // Fetch all genres in parallel (uses cache fallback when no access token)
  useEffect(() => {
    if (genreIds.length === 0) return;

    // Fetch each genre in parallel
    Promise.all(
      genreIds.map(async (genreId) => {
        try {
          const movies = await discoverMoviesByGenreWithCache(accessToken, genreId);
          return { genreId, movies };
        } catch {
          return { genreId, movies: [] };
        }
      })
    ).then((results) => {
      const newData = new Map<number, TmdbMovieResult[]>();
      results.forEach(({ genreId, movies }) => {
        newData.set(genreId, movies);
      });
      setTmdbData(newData);
      setFetchedGenreIds(genreIdsKey);
    });
  }, [accessToken, genreIdsKey]); // genreIdsKey for stable dependency

  // Collect all TMDB IDs for batch local lookup
  const allTmdbIds = useMemo(() => {
    const ids: number[] = [];
    tmdbData.forEach((movies) => {
      movies.forEach((m) => ids.push(m.id));
    });
    return ids;
  }, [tmdbData]);

  const localMovies = useMoviesByTmdbIds(allTmdbIds);

  // Build result map
  // Loading if: fetch not complete OR local lookup not complete
  const isFetching = fetchedGenreIds !== genreIdsKey;

  return useMemo(() => {
    const result = new Map<number, { items: StoredMovie[]; loading: boolean }>();

    genreIds.forEach((genreId) => {
      const tmdbMovies = tmdbData.get(genreId) || [];
      const isLoading = isFetching || localMovies === undefined;

      if (isLoading) {
        result.set(genreId, { items: [], loading: true });
      } else if (tmdbMovies.length === 0) {
        result.set(genreId, { items: [], loading: false });
      } else {
        const tmdbOrder = new Map(tmdbMovies.map((m, i) => [m.id, i]));
        const items = sortByTmdbOrder(localMovies || [], tmdbOrder);
        result.set(genreId, { items, loading: false });
      }
    });

    return result;
  }, [genreIds, tmdbData, isFetching, localMovies]);
}

/**
 * Pre-fetch series for multiple genres at once
 * Returns a Map of genreId -> { items, loading }
 */
export function useMultipleSeriesByGenre(
  accessToken: string | null,
  genreIds: number[]
): Map<number, { items: StoredSeries[]; loading: boolean }> {
  const [tmdbData, setTmdbData] = useState<Map<number, TmdbTvResult[]>>(new Map());
  const [fetchedGenreIds, setFetchedGenreIds] = useState<string>('');

  // Track which genreIds we've fetched (as string for easy comparison)
  const genreIdsKey = genreIds.join(',');

  // Fetch all genres in parallel (uses cache fallback when no access token)
  useEffect(() => {
    if (genreIds.length === 0) return;

    // Fetch each genre in parallel
    Promise.all(
      genreIds.map(async (genreId) => {
        try {
          const series = await discoverTvShowsByGenreWithCache(accessToken, genreId);
          return { genreId, series };
        } catch {
          return { genreId, series: [] };
        }
      })
    ).then((results) => {
      const newData = new Map<number, TmdbTvResult[]>();
      results.forEach(({ genreId, series }) => {
        newData.set(genreId, series);
      });
      setTmdbData(newData);
      setFetchedGenreIds(genreIdsKey);
    });
  }, [accessToken, genreIdsKey]); // genreIdsKey for stable dependency

  // Collect all TMDB IDs for batch local lookup
  const allTmdbIds = useMemo(() => {
    const ids: number[] = [];
    tmdbData.forEach((series) => {
      series.forEach((s) => ids.push(s.id));
    });
    return ids;
  }, [tmdbData]);

  const localSeries = useSeriesByTmdbIds(allTmdbIds);

  // Build result map
  // Loading if: fetch not complete OR local lookup not complete
  const isFetching = fetchedGenreIds !== genreIdsKey;

  return useMemo(() => {
    const result = new Map<number, { items: StoredSeries[]; loading: boolean }>();

    genreIds.forEach((genreId) => {
      const tmdbSeries = tmdbData.get(genreId) || [];
      const isLoading = isFetching || localSeries === undefined;

      if (isLoading) {
        result.set(genreId, { items: [], loading: true });
      } else if (tmdbSeries.length === 0) {
        result.set(genreId, { items: [], loading: false });
      } else {
        const tmdbOrder = new Map(tmdbSeries.map((s, i) => [s.id, i]));
        const items = sortByTmdbOrder(localSeries || [], tmdbOrder);
        result.set(genreId, { items, loading: false });
      }
    });

    return result;
  }, [genreIds, tmdbData, isFetching, localSeries]);
}

// ===========================================================================
// Featured Content Hook
// ===========================================================================

/**
 * Randomly sample n items from an array (Fisher-Yates shuffle)
 */
function randomSample<T>(array: T[], n: number): T[] {
  if (array.length <= n) return [...array];
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

/**
 * Get featured content for hero section
 * Returns random items from trending (with cache fallback)
 * Selection is stable - only re-randomizes when data source changes
 */
export function useFeaturedContent(accessToken: string | null, type: 'movies' | 'series', count = 5) {
  const { movies: trendingMovies } = useTrendingMovies(accessToken);
  const { series: trendingSeries } = useTrendingSeries(accessToken);
  const { movies: popularMovies } = useLocalPopularMovies(count);
  const { series: popularSeries } = useLocalPopularSeries(count);

  const [featured, setFeatured] = useState<(StoredMovie | StoredSeries)[]>([]);
  const [sourceKey, setSourceKey] = useState<string>('');

  useEffect(() => {
    // Determine which source to use
    let items: (StoredMovie | StoredSeries)[];
    let key: string;

    if (type === 'movies') {
      items = trendingMovies.length > 0 ? trendingMovies : popularMovies;
      key = `movies-${trendingMovies.length > 0 ? 'trending' : 'local'}-${items.length}`;
    } else {
      items = trendingSeries.length > 0 ? trendingSeries : popularSeries;
      key = `series-${trendingSeries.length > 0 ? 'trending' : 'local'}-${items.length}`;
    }

    // Only re-randomize if source actually changed
    if (key !== sourceKey && items.length > 0) {
      setSourceKey(key);
      setFeatured(randomSample(items, count));
    }
  }, [type, trendingMovies, trendingSeries, popularMovies, popularSeries, count, sourceKey]);

  return {
    items: featured,
    loading: false,
  };
}
