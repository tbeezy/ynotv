/**
 * TMDB Service
 *
 * Wrapper around tmdb-ts for fetching movie/series metadata,
 * trending lists, and search functionality.
 *
 * Uses "accessToken" (TMDB API Read Access Token) for authentication,
 * with GitHub-cached fallback for users without their own token.
 */

import { TMDB } from 'tmdb-ts';

// TMDB image base URLs
export const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
export const TMDB_POSTER_SIZES = {
  small: 'w185',
  medium: 'w342',
  large: 'w500',
  original: 'original',
} as const;
export const TMDB_BACKDROP_SIZES = {
  small: 'w300',
  medium: 'w780',
  large: 'w1280',
  original: 'original',
} as const;

// Helper to build full image URL
export function getTmdbImageUrl(
  path: string | null | undefined,
  size: string = TMDB_POSTER_SIZES.medium
): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

// Singleton instance
let tmdbInstance: TMDB | null = null;
let currentAccessToken: string | null = null;

/**
 * Initialize or get TMDB client
 */
export function getTmdb(accessToken: string): TMDB {
  if (!tmdbInstance || currentAccessToken !== accessToken) {
    tmdbInstance = new TMDB(accessToken);
    currentAccessToken = accessToken;
  }
  return tmdbInstance;
}

/**
 * Check if TMDB is configured
 */
export function isTmdbConfigured(): boolean {
  return tmdbInstance !== null && currentAccessToken !== null;
}

/**
 * Clear TMDB instance (for logout/key change)
 */
export function clearTmdb(): void {
  tmdbInstance = null;
  currentAccessToken = null;
}

// ===========================================================================
// Type definitions
// ===========================================================================

export interface TmdbMovieResult {
  id: number;
  title: string;
  original_title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string;
  vote_average: number;
  vote_count: number;
  popularity: number;
  genre_ids: number[];
  adult: boolean;
}

export interface TmdbMovieDetails extends TmdbMovieResult {
  imdb_id: string | null;
  runtime: number;
  genres: Array<{ id: number; name: string }>;
  tagline: string;
  status: string;
  budget: number;
  revenue: number;
}

export interface TmdbCastMember {
  id: number;
  name: string;
  character: string;
  profile_path: string | null;
  order: number;
}

export interface TmdbCrewMember {
  id: number;
  name: string;
  job: string;
  department: string;
  profile_path: string | null;
}

export interface TmdbCredits {
  cast: TmdbCastMember[];
  crew: TmdbCrewMember[];
}

export interface TmdbTvResult {
  id: number;
  name: string;
  original_name: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  first_air_date: string;
  vote_average: number;
  vote_count: number;
  popularity: number;
  genre_ids: number[];
}

export interface TmdbTvDetails extends TmdbTvResult {
  number_of_seasons: number;
  number_of_episodes: number;
  genres: Array<{ id: number; name: string }>;
  status: string;
  tagline: string;
  episode_run_time: number[];
  external_ids?: {
    imdb_id: string | null;
  };
}

export interface TmdbGenre {
  id: number;
  name: string;
}

// ===========================================================================
// Movie endpoints (direct API)
// ===========================================================================

export async function getTrendingMovies(
  accessToken: string,
  timeWindow: 'day' | 'week' = 'week'
): Promise<TmdbMovieResult[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.trending.trending('movie', timeWindow);
  return response.results as unknown as TmdbMovieResult[];
}

export async function getPopularMovies(
  accessToken: string,
  page = 1
): Promise<TmdbMovieResult[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.movies.popular({ page });
  return response.results as TmdbMovieResult[];
}

export async function getTopRatedMovies(
  accessToken: string,
  page = 1
): Promise<TmdbMovieResult[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.movies.topRated({ page });
  return response.results as TmdbMovieResult[];
}

export async function getNowPlayingMovies(
  accessToken: string,
  page = 1
): Promise<TmdbMovieResult[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.movies.nowPlaying({ page });
  return response.results as TmdbMovieResult[];
}

export async function getUpcomingMovies(
  accessToken: string,
  page = 1
): Promise<TmdbMovieResult[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.movies.upcoming({ page });
  return response.results as TmdbMovieResult[];
}

export async function searchMovies(
  accessToken: string,
  query: string,
  year?: number
): Promise<TmdbMovieResult[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.search.movies({ query, year });
  return response.results as TmdbMovieResult[];
}

export async function getMovieDetails(
  accessToken: string,
  movieId: number
): Promise<TmdbMovieDetails> {
  const tmdb = getTmdb(accessToken);
  const details = await tmdb.movies.details(movieId);
  return details as unknown as TmdbMovieDetails;
}

export async function getMovieCredits(
  accessToken: string,
  movieId: number
): Promise<TmdbCredits> {
  const tmdb = getTmdb(accessToken);
  const credits = await tmdb.movies.credits(movieId);
  return credits as unknown as TmdbCredits;
}

// ===========================================================================
// TV Show endpoints (direct API)
// ===========================================================================

export async function getTrendingTvShows(
  accessToken: string,
  timeWindow: 'day' | 'week' = 'week'
): Promise<TmdbTvResult[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.trending.trending('tv', timeWindow);
  return response.results as unknown as TmdbTvResult[];
}

export async function getPopularTvShows(
  accessToken: string,
  page = 1
): Promise<TmdbTvResult[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.tvShows.popular({ page });
  return response.results as TmdbTvResult[];
}

export async function getTopRatedTvShows(
  accessToken: string,
  page = 1
): Promise<TmdbTvResult[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.tvShows.topRated({ page });
  return response.results as TmdbTvResult[];
}

export async function getOnTheAirTvShows(
  accessToken: string,
  page = 1
): Promise<TmdbTvResult[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.tvShows.onTheAir({ page });
  return response.results as TmdbTvResult[];
}

export async function getAiringTodayTvShows(
  accessToken: string,
  page = 1
): Promise<TmdbTvResult[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.tvShows.airingToday({ page });
  return response.results as TmdbTvResult[];
}

export async function searchTvShows(
  accessToken: string,
  query: string,
  firstAirDateYear?: number
): Promise<TmdbTvResult[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.search.tvShows({ query, first_air_date_year: firstAirDateYear });
  return response.results as TmdbTvResult[];
}

export async function getTvShowDetails(
  accessToken: string,
  tvId: number
): Promise<TmdbTvDetails> {
  const tmdb = getTmdb(accessToken);
  const details = await tmdb.tvShows.details(tvId);
  return details as unknown as TmdbTvDetails;
}

export async function getTvShowCredits(
  accessToken: string,
  tvId: number
): Promise<TmdbCredits> {
  const tmdb = getTmdb(accessToken);
  const credits = await tmdb.tvShows.credits(tvId);
  return credits as unknown as TmdbCredits;
}

// ===========================================================================
// Genre endpoints (direct API)
// ===========================================================================

export async function getMovieGenres(accessToken: string): Promise<TmdbGenre[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.genres.movies();
  return response.genres;
}

export async function getTvGenres(accessToken: string): Promise<TmdbGenre[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.genres.tvShows();
  return response.genres;
}

// ===========================================================================
// Discovery endpoints (direct API)
// ===========================================================================

export async function discoverMoviesByGenre(
  accessToken: string,
  genreId: number,
  page = 1
): Promise<TmdbMovieResult[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.discover.movie({
    with_genres: String(genreId),
    sort_by: 'popularity.desc',
    page,
  });
  return response.results as TmdbMovieResult[];
}

export async function discoverTvShowsByGenre(
  accessToken: string,
  genreId: number,
  page = 1
): Promise<TmdbTvResult[]> {
  const tmdb = getTmdb(accessToken);
  const response = await tmdb.discover.tvShow({
    with_genres: String(genreId),
    sort_by: 'popularity.desc',
    page,
  });
  return response.results as TmdbTvResult[];
}

// ===========================================================================
// API key validation
// ===========================================================================

export async function validateAccessToken(accessToken: string): Promise<boolean> {
  try {
    const tmdb = new TMDB(accessToken);
    await tmdb.configuration.getApiConfiguration();
    return true;
  } catch {
    return false;
  }
}

// ===========================================================================
// GitHub Cache (fallback for users without access token)
// ===========================================================================

// URL to the raw cached TMDB data from GitHub (updated daily by GitHub Actions)
const GITHUB_CACHE_URL = 'https://raw.githubusercontent.com/thesubtleties/sbtlTV-tmdb-cache/main/data/tmdb-cache.json';

// Cache the fetched data in memory
let cachedTmdbData: TmdbCacheData | null = null;
let cacheLastFetched: number = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour in-memory cache

interface TmdbCacheData {
  generated_at: string;
  movies: {
    trending_day?: TmdbMovieResult[];
    trending_week?: TmdbMovieResult[];
    popular?: TmdbMovieResult[];
    top_rated?: TmdbMovieResult[];
    now_playing?: TmdbMovieResult[];
    upcoming?: TmdbMovieResult[];
    genres?: TmdbGenre[];
  };
  tv: {
    trending_day?: TmdbTvResult[];
    trending_week?: TmdbTvResult[];
    popular?: TmdbTvResult[];
    top_rated?: TmdbTvResult[];
    on_the_air?: TmdbTvResult[];
    airing_today?: TmdbTvResult[];
    genres?: TmdbGenre[];
  };
}

/**
 * Fetch cached TMDB data from GitHub
 * Returns null if cache is unavailable
 */
async function fetchCachedTmdbData(): Promise<TmdbCacheData | null> {
  // Return in-memory cache if still valid
  if (cachedTmdbData && Date.now() - cacheLastFetched < CACHE_TTL_MS) {
    return cachedTmdbData;
  }

  try {
    const response = await fetch(GITHUB_CACHE_URL);
    if (!response.ok) {
      console.warn('[TMDB Cache] GitHub cache not available:', response.status);
      return null;
    }
    cachedTmdbData = await response.json();
    cacheLastFetched = Date.now();
    console.log('[TMDB Cache] Loaded from GitHub, generated:', cachedTmdbData?.generated_at);
    return cachedTmdbData;
  } catch (err) {
    console.warn('[TMDB Cache] Failed to fetch from GitHub:', err);
    return null;
  }
}

// ===========================================================================
// Factory for cache-fallback functions
// ===========================================================================

/**
 * Creates a function that tries the cache first (if no access token),
 * then falls back to the direct API.
 */
function createCacheFallback<T>(
  cacheGetter: (cache: TmdbCacheData | null) => T[] | undefined,
  apiFn: (accessToken: string) => Promise<T[]>
): (accessToken?: string | null) => Promise<T[]> {
  return async (accessToken?: string | null): Promise<T[]> => {
    if (!accessToken) {
      const cache = await fetchCachedTmdbData();
      return cacheGetter(cache) ?? [];
    }
    return apiFn(accessToken);
  };
}

// ===========================================================================
// Cache-enabled endpoints (use these in hooks)
// ===========================================================================

// Movies
export const getTrendingMoviesWithCache = (accessToken?: string | null, timeWindow: 'day' | 'week' = 'week') =>
  createCacheFallback(
    (c) => timeWindow === 'day' ? c?.movies.trending_day : c?.movies.trending_week,
    (token) => getTrendingMovies(token, timeWindow)
  )(accessToken);

export const getPopularMoviesWithCache = createCacheFallback(
  (c) => c?.movies.popular,
  getPopularMovies
);

export const getTopRatedMoviesWithCache = createCacheFallback(
  (c) => c?.movies.top_rated,
  getTopRatedMovies
);

export const getNowPlayingMoviesWithCache = createCacheFallback(
  (c) => c?.movies.now_playing,
  getNowPlayingMovies
);

export const getUpcomingMoviesWithCache = createCacheFallback(
  (c) => c?.movies.upcoming,
  getUpcomingMovies
);

export const getMovieGenresWithCache = createCacheFallback(
  (c) => c?.movies.genres,
  getMovieGenres
);

// TV Shows
export const getTrendingTvShowsWithCache = (accessToken?: string | null, timeWindow: 'day' | 'week' = 'week') =>
  createCacheFallback(
    (c) => timeWindow === 'day' ? c?.tv.trending_day : c?.tv.trending_week,
    (token) => getTrendingTvShows(token, timeWindow)
  )(accessToken);

export const getPopularTvShowsWithCache = createCacheFallback(
  (c) => c?.tv.popular,
  getPopularTvShows
);

export const getTopRatedTvShowsWithCache = createCacheFallback(
  (c) => c?.tv.top_rated,
  getTopRatedTvShows
);

export const getOnTheAirTvShowsWithCache = createCacheFallback(
  (c) => c?.tv.on_the_air,
  getOnTheAirTvShows
);

export const getAiringTodayTvShowsWithCache = createCacheFallback(
  (c) => c?.tv.airing_today,
  getAiringTodayTvShows
);

export const getTvGenresWithCache = createCacheFallback(
  (c) => c?.tv.genres,
  getTvGenres
);

// ===========================================================================
// Genre Discovery with Cache Fallback
// ===========================================================================

/**
 * Get movies by genre, with cache fallback.
 * - With API key: uses TMDB discover API (more results)
 * - Without API key: filters cached movies by genre_ids
 */
export async function discoverMoviesByGenreWithCache(
  accessToken: string | null | undefined,
  genreId: number
): Promise<TmdbMovieResult[]> {
  if (accessToken) {
    return discoverMoviesByGenre(accessToken, genreId);
  }

  // Fallback: filter cached movies by genre
  const cache = await fetchCachedTmdbData();
  if (!cache) return [];

  // Collect all movies from cache lists, dedupe by ID
  const allMovies = [
    ...(cache.movies.trending_day || []),
    ...(cache.movies.trending_week || []),
    ...(cache.movies.popular || []),
    ...(cache.movies.top_rated || []),
    ...(cache.movies.now_playing || []),
    ...(cache.movies.upcoming || []),
  ];

  const seen = new Set<number>();
  const uniqueMovies = allMovies.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  // Filter by genre and sort by popularity
  return uniqueMovies
    .filter((m) => m.genre_ids?.includes(genreId))
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
}

/**
 * Get TV shows by genre, with cache fallback.
 * - With API key: uses TMDB discover API (more results)
 * - Without API key: filters cached TV shows by genre_ids
 */
export async function discoverTvShowsByGenreWithCache(
  accessToken: string | null | undefined,
  genreId: number
): Promise<TmdbTvResult[]> {
  if (accessToken) {
    return discoverTvShowsByGenre(accessToken, genreId);
  }

  // Fallback: filter cached TV shows by genre
  const cache = await fetchCachedTmdbData();
  if (!cache) return [];

  // Collect all TV shows from cache lists, dedupe by ID
  const allTvShows = [
    ...(cache.tv.trending_day || []),
    ...(cache.tv.trending_week || []),
    ...(cache.tv.popular || []),
    ...(cache.tv.top_rated || []),
    ...(cache.tv.on_the_air || []),
    ...(cache.tv.airing_today || []),
  ];

  const seen = new Set<number>();
  const uniqueTvShows = allTvShows.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });

  // Filter by genre and sort by popularity
  return uniqueTvShows
    .filter((s) => s.genre_ids?.includes(genreId))
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
}

/**
 * Get count of cached movies per genre (for showing availability in settings)
 * Returns a Map of genreId -> count
 */
export async function getCachedMovieGenreCounts(): Promise<Map<number, number>> {
  const cache = await fetchCachedTmdbData();
  if (!cache) return new Map();

  // Collect all movies from cache lists, dedupe by ID
  const allMovies = [
    ...(cache.movies.trending_day || []),
    ...(cache.movies.trending_week || []),
    ...(cache.movies.popular || []),
    ...(cache.movies.top_rated || []),
    ...(cache.movies.now_playing || []),
    ...(cache.movies.upcoming || []),
  ];

  const seen = new Set<number>();
  const uniqueMovies = allMovies.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  // Count movies per genre
  const counts = new Map<number, number>();
  uniqueMovies.forEach((m) => {
    m.genre_ids?.forEach((genreId) => {
      counts.set(genreId, (counts.get(genreId) || 0) + 1);
    });
  });

  return counts;
}

/**
 * Get count of cached TV shows per genre (for showing availability in settings)
 * Returns a Map of genreId -> count
 */
export async function getCachedTvGenreCounts(): Promise<Map<number, number>> {
  const cache = await fetchCachedTmdbData();
  if (!cache) return new Map();

  // Collect all TV shows from cache lists, dedupe by ID
  const allTvShows = [
    ...(cache.tv.trending_day || []),
    ...(cache.tv.trending_week || []),
    ...(cache.tv.popular || []),
    ...(cache.tv.top_rated || []),
    ...(cache.tv.on_the_air || []),
    ...(cache.tv.airing_today || []),
  ];

  const seen = new Set<number>();
  const uniqueTvShows = allTvShows.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });

  // Count TV shows per genre
  const counts = new Map<number, number>();
  uniqueTvShows.forEach((s) => {
    s.genre_ids?.forEach((genreId) => {
      counts.set(genreId, (counts.get(genreId) || 0) + 1);
    });
  });

  return counts;
}
