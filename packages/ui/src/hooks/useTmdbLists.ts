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
 * MATCHING STRATEGY:
 * - First checks for already-matched content (by tmdb_id index)
 * - Then matches unmatched items by title/year
 * - Caches tmdb_id after match for future fast lookups
 *
 * This means NO bulk TMDB export download is required!
 */

import { useState, useEffect, useRef } from 'react';
import { useLiveQuery } from './useSqliteLiveQuery';
import { db, type StoredMovie, type StoredSeries } from '../db';
import {
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
import {
  getOrMatchMoviesByTmdbList,
  getOrMatchSeriesByTmdbList,
} from '../services/title-match';

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
// Helper: Match TMDB list to local content
// ===========================================================================

/**
 * Get local movies for a TMDB list using hybrid matching:
 * 1. Fast lookup by tmdb_id for already-matched items
 * 2. Title/year matching for unmatched items
 * 
 * This enables instant content display without bulk TMDB export download!
 */
function useMatchedMovies(tmdbMovies: TmdbMovieResult[], tmdbMoviesLoaded: boolean) {
  const [movies, setMovies] = useState<StoredMovie[]>([]);
  const [matching, setMatching] = useState(false);
  const matchVersionRef = useRef(0);

  useEffect(() => {
    if (!tmdbMoviesLoaded || tmdbMovies.length === 0) {
      setMovies([]);
      return;
    }

    const currentVersion = ++matchVersionRef.current;
    setMatching(true);

    getOrMatchMoviesByTmdbList(tmdbMovies)
      .then((result) => {
        if (currentVersion === matchVersionRef.current) {
          setMovies(result.movies);
          if (result.newlyMatched > 0) {
            console.log(`[TitleMatch] Newly matched ${result.newlyMatched} movies`);
          }
        }
      })
      .catch(console.error)
      .finally(() => {
        if (currentVersion === matchVersionRef.current) {
          setMatching(false);
        }
      });
  }, [tmdbMovies, tmdbMoviesLoaded]);

  return { movies, matching };
}

/**
 * Get local series for a TMDB list using hybrid matching:
 * 1. Fast lookup by tmdb_id for already-matched items
 * 2. Title/year matching for unmatched items
 */
function useMatchedSeries(tmdbSeries: TmdbTvResult[], tmdbSeriesLoaded: boolean) {
  const [series, setSeries] = useState<StoredSeries[]>([]);
  const [matching, setMatching] = useState(false);
  const matchVersionRef = useRef(0);

  useEffect(() => {
    if (!tmdbSeriesLoaded || tmdbSeries.length === 0) {
      setSeries([]);
      return;
    }

    const currentVersion = ++matchVersionRef.current;
    setMatching(true);

    getOrMatchSeriesByTmdbList(tmdbSeries)
      .then((result) => {
        if (currentVersion === matchVersionRef.current) {
          setSeries(result.series);
          if (result.newlyMatched > 0) {
            console.log(`[TitleMatch] Newly matched ${result.newlyMatched} series`);
          }
        }
      })
      .catch(console.error)
      .finally(() => {
        if (currentVersion === matchVersionRef.current) {
          setMatching(false);
        }
      });
  }, [tmdbSeries, tmdbSeriesLoaded]);

  return { series, matching };
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
        console.log(`[useMovieList] Fetched ${results.length} movies from TMDB`);
        setTmdbMovies(results);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [accessToken]);

  const { movies, matching } = useMatchedMovies(tmdbMovies, !loading);

  return {
    movies,
    loading: loading || matching,
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

  const { series, matching } = useMatchedSeries(tmdbSeries, !loading);

  return {
    series,
    loading: loading || matching,
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
 * Falls back to recent movies if no popularity data available
 */
export function useLocalPopularMovies(limit = 20) {
  const movies = useLiveQuery(async () => {
    const withPopularity = await db.vodMovies
      .orderBy('popularity')
      .reverse()
      .filter((m) => m.popularity !== undefined && m.popularity > 0)
      .limit(limit)
      .toArray();

    if (withPopularity.length > 0) {
      return withPopularity;
    }

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

/**
 * Get movies by genre (uses cache fallback when no access token)
 */
export function useMoviesByGenre(accessToken: string | null, genreId: number | null) {
  const [tmdbMovies, setTmdbMovies] = useState<TmdbMovieResult[]>([]);
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

  const { movies, matching } = useMatchedMovies(tmdbMovies, !loading);

  return {
    movies,
    loading: loading || matching,
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
 * Falls back to recent series if no popularity data available
 */
export function useLocalPopularSeries(limit = 20) {
  const series = useLiveQuery(async () => {
    const withPopularity = await db.vodSeries
      .orderBy('popularity')
      .reverse()
      .filter((s) => s.popularity !== undefined && s.popularity > 0)
      .limit(limit)
      .toArray();

    if (withPopularity.length > 0) {
      return withPopularity;
    }

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

/**
 * Get series by genre (uses cache fallback when no access token)
 */
export function useSeriesByGenre(accessToken: string | null, genreId: number | null) {
  const [tmdbSeries, setTmdbSeries] = useState<TmdbTvResult[]>([]);
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

  const { series, matching } = useMatchedSeries(tmdbSeries, !loading);

  return {
    series,
    loading: loading || matching,
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
  const [results, setResults] = useState<Map<number, { items: StoredMovie[]; loading: boolean }>>(new Map());
  const versionRef = useRef(0);

  const genreIdsKey = genreIds.join(',');

  useEffect(() => {
    if (genreIds.length === 0) {
      setResults(new Map());
      return;
    }

    const currentVersion = ++versionRef.current;

    const initialMap = new Map<number, { items: StoredMovie[]; loading: boolean }>();
    genreIds.forEach(id => initialMap.set(id, { items: [], loading: true }));
    setResults(initialMap);

    Promise.all(
      genreIds.map(async (genreId) => {
        try {
          const tmdbMovies = await discoverMoviesByGenreWithCache(accessToken, genreId);
          const { movies } = await getOrMatchMoviesByTmdbList(tmdbMovies);
          return { genreId, movies, error: null };
        } catch (err) {
          return { genreId, movies: [] as StoredMovie[], error: err };
        }
      })
    ).then((genreResults) => {
      if (currentVersion !== versionRef.current) return;

      const newResults = new Map<number, { items: StoredMovie[]; loading: boolean }>();
      genreResults.forEach(({ genreId, movies }) => {
        newResults.set(genreId, { items: movies, loading: false });
      });
      setResults(newResults);
    });
  }, [accessToken, genreIdsKey]);

  return results;
}

/**
 * Pre-fetch series for multiple genres at once
 * Returns a Map of genreId -> { items, loading }
 */
export function useMultipleSeriesByGenre(
  accessToken: string | null,
  genreIds: number[]
): Map<number, { items: StoredSeries[]; loading: boolean }> {
  const [results, setResults] = useState<Map<number, { items: StoredSeries[]; loading: boolean }>>(new Map());
  const versionRef = useRef(0);

  const genreIdsKey = genreIds.join(',');

  useEffect(() => {
    if (genreIds.length === 0) {
      setResults(new Map());
      return;
    }

    const currentVersion = ++versionRef.current;

    const initialMap = new Map<number, { items: StoredSeries[]; loading: boolean }>();
    genreIds.forEach(id => initialMap.set(id, { items: [], loading: true }));
    setResults(initialMap);

    Promise.all(
      genreIds.map(async (genreId) => {
        try {
          const tmdbSeries = await discoverTvShowsByGenreWithCache(accessToken, genreId);
          const { series } = await getOrMatchSeriesByTmdbList(tmdbSeries);
          return { genreId, series, error: null };
        } catch (err) {
          return { genreId, series: [] as StoredSeries[], error: err };
        }
      })
    ).then((genreResults) => {
      if (currentVersion !== versionRef.current) return;

      const newResults = new Map<number, { items: StoredSeries[]; loading: boolean }>();
      genreResults.forEach(({ genreId, series }) => {
        newResults.set(genreId, { items: series, loading: false });
      });
      setResults(newResults);
    });
  }, [accessToken, genreIdsKey]);

  return results;
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
