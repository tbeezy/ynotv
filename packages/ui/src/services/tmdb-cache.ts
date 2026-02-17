/**
 * TMDB Metadata Cache API
 *
 * Provides fast local caching of TMDB export data for movie/TV series matching.
 * Caches TMDB exports locally and provides fast lookups without repeated downloads.
 *
 * Expected improvement: Reduces VOD sync time from 5-10s to <500ms after initial cache
 *
 * Features:
 * - Automatic cache updates (weekly by default)
 * - Fast title-based lookups
 * - Memory-efficient storage
 * - Cache statistics and management
 *
 * @example
 * ```typescript
 * // Get cache stats
 * const stats = await getTmdbCacheStats();
 * console.log(`Cache has ${stats.movies_count} movies`);
 *
 * // Find movies by title
 * const matches = await findTmdbMovies('Inception');
 * console.log(`Found ${matches.length} matches`);
 * ```
 */

import { invoke } from '@tauri-apps/api/core';

/// Cache statistics
export interface CacheStats {
  movies_cached: boolean;
  movies_count: number;
  movies_cached_at: string | null; // ISO 8601 timestamp
  movies_age_hours: number;
  series_cached: boolean;
  series_count: number;
  series_cached_at: string | null; // ISO 8601 timestamp
  series_age_hours: number;
}

/// Match result from TMDB lookup
export interface MatchResult {
  tmdb_id: number;
  title: string;
  year: number | null;
  score: number; // 0.0-1.0 match confidence
}

/// TMDB Movie entry
export interface TmdbMovie {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  year?: number;
  overview?: string;
  poster_path?: string;
  backdrop_path?: string;
  vote_average?: number;
  genre_ids?: number[];
  popularity?: number;
}

/// TMDB TV Series entry
export interface TmdbSeries {
  id: number;
  name: string;
  original_name?: string;
  first_air_date?: string;
  year?: number;
  overview?: string;
  poster_path?: string;
  backdrop_path?: string;
  vote_average?: number;
  genre_ids?: number[];
  popularity?: number;
}

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Get TMDB cache statistics
 *
 * @returns Cache statistics including counts, ages, and freshness
 */
export async function getTmdbCacheStats(): Promise<CacheStats> {
  const stats = await invoke<CacheStats>('get_tmdb_cache_stats');

  // Convert timestamp strings to ISO format if present
  return {
    ...stats,
    movies_cached_at: stats.movies_cached_at
      ? new Date(stats.movies_cached_at).toISOString()
      : null,
    series_cached_at: stats.series_cached_at
      ? new Date(stats.series_cached_at).toISOString()
      : null,
  };
}

/**
 * Update TMDB movies cache
 * Downloads and indexes the latest TMDB movies export
 *
 * @returns Number of movies indexed
 */
export async function updateTmdbMoviesCache(): Promise<number> {
  console.time('update-tmdb-movies-cache');
  console.log('[TMDB Cache] Updating movies cache...');

  try {
    const count = await invoke<number>('update_tmdb_movies_cache');
    console.timeEnd('update-tmdb-movies-cache');
    console.log(`[TMDB Cache] Indexed ${count} movies`);
    return count;
  } catch (error) {
    console.error('[TMDB Cache] Failed to update movies cache:', error);
    throw error;
  }
}

/**
 * Update TMDB series cache
 * Downloads and indexes the latest TMDB TV series export
 *
 * @returns Number of series indexed
 */
export async function updateTmdbSeriesCache(): Promise<number> {
  console.time('update-tmdb-series-cache');
  console.log('[TMDB Cache] Updating series cache...');

  try {
    const count = await invoke<number>('update_tmdb_series_cache');
    console.timeEnd('update-tmdb-series-cache');
    console.log(`[TMDB Cache] Indexed ${count} series`);
    return count;
  } catch (error) {
    console.error('[TMDB Cache] Failed to update series cache:', error);
    throw error;
  }
}

/**
 * Update both movies and series caches
 * Convenience function to update everything
 */
export async function updateTmdbCache(): Promise<{
  movies: number;
  series: number;
}> {
  console.time('update-tmdb-cache');
  console.log('[TMDB Cache] Updating full cache...');

  try {
    const [movies, series] = await Promise.all([
      updateTmdbMoviesCache(),
      updateTmdbSeriesCache(),
    ]);

    console.timeEnd('update-tmdb-cache');
    console.log(
      `[TMDB Cache] Updated: ${movies} movies, ${series} series`
    );

    return { movies, series };
  } catch (error) {
    console.error('[TMDB Cache] Failed to update cache:', error);
    throw error;
  }
}

/**
 * Clear all TMDB caches
 * Removes cached data from disk
 */
export async function clearTmdbCache(): Promise<void> {
  console.log('[TMDB Cache] Clearing cache...');
  await invoke('clear_tmdb_cache');
  console.log('[TMDB Cache] Cache cleared');
}

// ============================================================================
// Search Functions
// ============================================================================

/**
 * Find movies by title
 *
 * @param title - Movie title to search for
 * @returns Array of match results sorted by relevance
 */
export async function findTmdbMovies(title: string): Promise<MatchResult[]> {
  if (!title || title.trim().length === 0) {
    return [];
  }

  const results = await invoke<MatchResult[]>('find_tmdb_movies', {
    title: title.trim(),
  });

  // Sort by score (highest first)
  return results.sort((a, b) => b.score - a.score);
}

/**
 * Find TV series by title
 *
 * @param title - Series title to search for
 * @returns Array of match results sorted by relevance
 */
export async function findTmdbSeries(title: string): Promise<MatchResult[]> {
  if (!title || title.trim().length === 0) {
    return [];
  }

  const results = await invoke<MatchResult[]>('find_tmdb_series', {
    title: title.trim(),
  });

  // Sort by score (highest first)
  return results.sort((a, b) => b.score - a.score);
}

/**
 * Find best movie match
 * Returns the highest-scoring match or null if no matches
 *
 * @param title - Movie title to search for
 * @returns Best match or null
 */
export async function findBestMovieMatch(
  title: string
): Promise<MatchResult | null> {
  const matches = await findTmdbMovies(title);
  return matches.length > 0 ? matches[0] : null;
}

/**
 * Find best series match
 * Returns the highest-scoring match or null if no matches
 *
 * @param title - Series title to search for
 * @returns Best match or null
 */
export async function findBestSeriesMatch(
  title: string
): Promise<MatchResult | null> {
  const matches = await findTmdbSeries(title);
  return matches.length > 0 ? matches[0] : null;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if cache needs updating
 *
 * @param stats - Cache statistics
 * @param maxAgeHours - Maximum age before refresh (default: 168 = 7 days)
 * @returns True if cache should be updated
 */
export function isCacheStale(
  stats: CacheStats,
  maxAgeHours: number = 168
): boolean {
  const moviesStale =
    !stats.movies_cached || stats.movies_age_hours > maxAgeHours;
  const seriesStale =
    !stats.series_cached || stats.series_age_hours > maxAgeHours;

  return moviesStale || seriesStale;
}

/**
 * Ensure cache is fresh
 * Updates cache if it's stale or missing
 *
 * @param maxAgeHours - Maximum age before refresh (default: 168 = 7 days)
 * @returns Cache statistics after ensuring freshness
 */
export async function ensureFreshCache(
  maxAgeHours: number = 168
): Promise<CacheStats> {
  const stats = await getTmdbCacheStats();

  if (isCacheStale(stats, maxAgeHours)) {
    console.log('[TMDB Cache] Cache is stale, updating...');
    await updateTmdbCache();
    return getTmdbCacheStats();
  }

  console.log('[TMDB Cache] Cache is fresh, no update needed');
  return stats;
}

/**
 * Format cache age for display
 *
 * @param hours - Age in hours
 * @returns Human-readable string (e.g., "2 days ago")
 */
export function formatCacheAge(hours: number): string {
  if (hours < 1) {
    return 'Just now';
  } else if (hours === 1) {
    return '1 hour ago';
  } else if (hours < 24) {
    return `${hours} hours ago`;
  } else if (hours < 48) {
    return '1 day ago';
  } else if (hours < 168) {
    return `${Math.floor(hours / 24)} days ago`;
  } else if (hours < 336) {
    return '1 week ago';
  } else {
    return `${Math.floor(hours / 168)} weeks ago`;
  }
}

/**
 * Format cache statistics for display
 *
 * @param stats - Cache statistics
 * @returns Human-readable summary
 */
export function formatCacheStats(stats: CacheStats): string {
  const parts: string[] = [];

  if (stats.movies_cached) {
    parts.push(
      `${stats.movies_count.toLocaleString()} movies (${formatCacheAge(
        stats.movies_age_hours
      )})`
    );
  } else {
    parts.push('Movies: Not cached');
  }

  if (stats.series_cached) {
    parts.push(
      `${stats.series_count.toLocaleString()} series (${formatCacheAge(
        stats.series_age_hours
      )})`
    );
  } else {
    parts.push('Series: Not cached');
  }

  return parts.join(' | ');
}

// ============================================================================
// Bulk Matching for VOD Sync
// ============================================================================

/**
 * Match movies in bulk
 * Efficiently matches multiple movie titles at once
 *
 * @param movies - Array of movie titles/years to match
 * @returns Map of title to best match
 */
export async function bulkMatchMovies(
  movies: Array<{ title: string; year?: number }>
): Promise<Map<string, MatchResult | null>> {
  const results = new Map<string, MatchResult | null>();

  // Ensure cache is loaded
  await ensureFreshCache();

  // Match each movie
  for (const movie of movies) {
    const matches = await findTmdbMovies(movie.title);

    // Filter by year if provided
    let bestMatch: MatchResult | null = null;
    if (movie.year && matches.length > 0) {
      const yearMatches = matches.filter(
        (m) => m.year && Math.abs(m.year - movie.year!) <= 1
      );
      bestMatch = yearMatches.length > 0 ? yearMatches[0] : matches[0];
    } else {
      bestMatch = matches.length > 0 ? matches[0] : null;
    }

    results.set(movie.title, bestMatch);
  }

  return results;
}

/**
 * Match series in bulk
 * Efficiently matches multiple series titles at once
 *
 * @param series - Array of series titles/years to match
 * @returns Map of title to best match
 */
export async function bulkMatchSeries(
  series: Array<{ title: string; year?: number }>
): Promise<Map<string, MatchResult | null>> {
  const results = new Map<string, MatchResult | null>();

  // Ensure cache is loaded
  await ensureFreshCache();

  // Match each series
  for (const s of series) {
    const matches = await findTmdbSeries(s.title);

    // Filter by year if provided
    let bestMatch: MatchResult | null = null;
    if (s.year && matches.length > 0) {
      const yearMatches = matches.filter(
        (m) => m.year && Math.abs(m.year - s.year!) <= 1
      );
      bestMatch = yearMatches.length > 0 ? yearMatches[0] : matches[0];
    } else {
      bestMatch = matches.length > 0 ? matches[0] : null;
    }

    results.set(s.title, bestMatch);
  }

  return results;
}

// Export all as namespace
export const tmdbCache = {
  getTmdbCacheStats,
  updateTmdbMoviesCache,
  updateTmdbSeriesCache,
  updateTmdbCache,
  clearTmdbCache,
  findTmdbMovies,
  findTmdbSeries,
  findBestMovieMatch,
  findBestSeriesMatch,
  isCacheStale,
  ensureFreshCache,
  formatCacheAge,
  formatCacheStats,
  bulkMatchMovies,
  bulkMatchSeries,
};

export default tmdbCache;
