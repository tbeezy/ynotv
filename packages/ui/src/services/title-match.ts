/**
 * Title-Based TMDB Matching Service
 *
 * Matches TMDB list results (Trending, Popular, etc.) to local VOD content
 * by title and year - no bulk export download required.
 *
 * Benefits:
 * - No 100MB GitHub download
 * - Instant home page content
 * - Progressive enhancement (caches tmdb_id after match)
 */

import { db } from '../db';
import type { StoredMovie, StoredSeries } from '../db';
import type { TmdbMovieResult, TmdbTvResult } from './tmdb';
import { dbEvents } from '../db/sqlite-adapter';

// ===========================================================================
// Title Normalization
// ===========================================================================

/**
 * Normalize title for matching
 * Removes year patterns, quality markers, and special characters
 */
export function normalizeTitleForMatch(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*\(\d{4}\)\s*/g, ' ')
    .replace(/\s*\[\d{4}\]\s*/g, ' ')
    .replace(/\s+\d{4}$/g, '')
    .replace(/\s*(4k|uhd|hd|sd|1080p|720p|480p|bluray|web-dl|hdrip|dvdrip)\s*/gi, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract year from TMDB result
 */
function getYearFromTmdbMovie(result: TmdbMovieResult): number | undefined {
  if (result.release_date) {
    const year = parseInt(result.release_date.substring(0, 4), 10);
    return isNaN(year) ? undefined : year;
  }
  return undefined;
}

function getYearFromTmdbTv(result: TmdbTvResult): number | undefined {
  if (result.first_air_date) {
    const year = parseInt(result.first_air_date.substring(0, 4), 10);
    return isNaN(year) ? undefined : year;
  }
  return undefined;
}

// ===========================================================================
// Local DB Title Matching
// ===========================================================================

interface TitleMatchResult<T> {
  item: T;
  tmdbId: number;
  popularity: number;
  backdropPath?: string;
}

/**
 * Find local movies matching TMDB results by title/year
 * Updates matched movies with tmdb_id, popularity, backdrop_path
 */
export async function matchMoviesByTitle(
  tmdbResults: TmdbMovieResult[]
): Promise<StoredMovie[]> {
  if (tmdbResults.length === 0) return [];

  const dbInstance = await (db as any).dbPromise;
  const matchedMovies: StoredMovie[] = [];
  const updates: Array<{ stream_id: string; tmdb_id: number; popularity: number; backdrop_path: string | null }> = [];

  for (const tmdb of tmdbResults) {
    const normalizedTitle = normalizeTitleForMatch(tmdb.title);
    const year = getYearFromTmdbMovie(tmdb);

    if (!normalizedTitle) continue;

    let query: string;
    let params: any[];

    if (year) {
      query = `
        SELECT * FROM vodMovies 
        WHERE (tmdb_id IS NULL OR tmdb_id = 0)
        AND (
          LOWER(title) = LOWER(?) 
          OR LOWER(name) LIKE LOWER(?)
          OR LOWER(name) LIKE LOWER(?)
        )
        AND (
          year = ? 
          OR year IS NULL
        )
        LIMIT 5
      `;
      params = [normalizedTitle, `%${normalizedTitle}%`, `${normalizedTitle}%`, year.toString()];
    } else {
      query = `
        SELECT * FROM vodMovies 
        WHERE (tmdb_id IS NULL OR tmdb_id = 0)
        AND (
          LOWER(title) = LOWER(?)
          OR LOWER(name) LIKE LOWER(?)
          OR LOWER(name) LIKE LOWER(?)
        )
        LIMIT 5
      `;
      params = [normalizedTitle, `%${normalizedTitle}%`, `${normalizedTitle}%`];
    }

    try {
      const candidates = await dbInstance.select(query, params);

      if (candidates && candidates.length > 0) {
        let bestMatch = candidates[0];

        if (year && candidates.length > 1) {
          const yearMatch = candidates.find((m: StoredMovie) => m.year === year.toString());
          if (yearMatch) bestMatch = yearMatch;
        }

        matchedMovies.push(bestMatch);
        updates.push({
          stream_id: bestMatch.stream_id,
          tmdb_id: tmdb.id,
          popularity: tmdb.popularity,
          backdrop_path: tmdb.backdrop_path,
        });
      }
    } catch (err) {
      console.warn('[TitleMatch] Query failed for:', tmdb.title, err);
    }
  }

  if (updates.length > 0) {
    await bulkUpdateMovieMetadata(updates);
    console.log(`[TitleMatch] Matched ${updates.length} movies from ${tmdbResults.length} TMDB results`);
  }

  return matchedMovies;
}

/**
 * Find local series matching TMDB results by title/year
 * Updates matched series with tmdb_id, popularity, backdrop_path
 */
export async function matchSeriesByTitle(
  tmdbResults: TmdbTvResult[]
): Promise<StoredSeries[]> {
  if (tmdbResults.length === 0) return [];

  const dbInstance = await (db as any).dbPromise;
  const matchedSeries: StoredSeries[] = [];
  const updates: Array<{ series_id: string; tmdb_id: number; popularity: number; backdrop_path: string | null }> = [];

  for (const tmdb of tmdbResults) {
    const normalizedTitle = normalizeTitleForMatch(tmdb.name);
    const year = getYearFromTmdbTv(tmdb);

    if (!normalizedTitle) continue;

    let query: string;
    let params: any[];

    if (year) {
      query = `
        SELECT * FROM vodSeries 
        WHERE (tmdb_id IS NULL OR tmdb_id = 0)
        AND (
          LOWER(title) = LOWER(?)
          OR LOWER(name) LIKE LOWER(?)
          OR LOWER(name) LIKE LOWER(?)
        )
        AND (
          year = ?
          OR year IS NULL
        )
        LIMIT 5
      `;
      params = [normalizedTitle, `%${normalizedTitle}%`, `${normalizedTitle}%`, year.toString()];
    } else {
      query = `
        SELECT * FROM vodSeries 
        WHERE (tmdb_id IS NULL OR tmdb_id = 0)
        AND (
          LOWER(title) = LOWER(?)
          OR LOWER(name) LIKE LOWER(?)
          OR LOWER(name) LIKE LOWER(?)
        )
        LIMIT 5
      `;
      params = [normalizedTitle, `%${normalizedTitle}%`, `${normalizedTitle}%`];
    }

    try {
      const candidates = await dbInstance.select(query, params);

      if (candidates && candidates.length > 0) {
        let bestMatch = candidates[0];

        if (year && candidates.length > 1) {
          const yearMatch = candidates.find((s: StoredSeries) => s.year === year.toString());
          if (yearMatch) bestMatch = yearMatch;
        }

        matchedSeries.push(bestMatch);
        updates.push({
          series_id: bestMatch.series_id,
          tmdb_id: tmdb.id,
          popularity: tmdb.popularity,
          backdrop_path: tmdb.backdrop_path,
        });
      }
    } catch (err) {
      console.warn('[TitleMatch] Query failed for:', tmdb.name, err);
    }
  }

  if (updates.length > 0) {
    await bulkUpdateSeriesMetadata(updates);
    console.log(`[TitleMatch] Matched ${updates.length} series from ${tmdbResults.length} TMDB results`);
  }

  return matchedSeries;
}

// ===========================================================================
// Bulk Update Helpers
// ===========================================================================

async function bulkUpdateMovieMetadata(
  updates: Array<{ stream_id: string; tmdb_id: number; popularity: number; backdrop_path: string | null }>
): Promise<void> {
  const dbInstance = await (db as any).dbPromise;

  for (const update of updates) {
    await dbInstance.execute(
      `UPDATE vodMovies SET tmdb_id = ?, popularity = ?, backdrop_path = ? WHERE stream_id = ?`,
      [update.tmdb_id, update.popularity, update.backdrop_path, update.stream_id]
    );
  }

  if (updates.length > 0) {
    dbEvents.notify('vodMovies', 'update');
  }
}

async function bulkUpdateSeriesMetadata(
  updates: Array<{ series_id: string; tmdb_id: number; popularity: number; backdrop_path: string | null }>
): Promise<void> {
  const dbInstance = await (db as any).dbPromise;

  for (const update of updates) {
    await dbInstance.execute(
      `UPDATE vodSeries SET tmdb_id = ?, popularity = ?, backdrop_path = ? WHERE series_id = ?`,
      [update.tmdb_id, update.popularity, update.backdrop_path, update.series_id]
    );
  }

  if (updates.length > 0) {
    dbEvents.notify('vodSeries', 'update');
  }
}

// ===========================================================================
// Combined Match with Already-Matched Content
// ===========================================================================

interface MovieMatchResult {
  movies: StoredMovie[];
  newlyMatched: number;
}

/**
 * Get movies for TMDB list, combining:
 * 1. Already matched movies (by tmdb_id)
 * 2. Newly matched movies (by title)
 *
 * Returns movies in TMDB list order
 */
export async function getOrMatchMoviesByTmdbList(
  tmdbResults: TmdbMovieResult[]
): Promise<MovieMatchResult> {
  if (tmdbResults.length === 0) return { movies: [], newlyMatched: 0 };

  const tmdbIds = tmdbResults.map(m => m.id);
  const tmdbOrder = new Map(tmdbResults.map((m, i) => [m.id, i]));

  const alreadyMatched = await db.vodMovies
    .where('tmdb_id')
    .anyOf(tmdbIds)
    .toArray();

  const matchedIds = new Set(alreadyMatched.map(m => m.tmdb_id));

  const unmatchedResults = tmdbResults.filter(m => !matchedIds.has(m.id));

  const newlyMatched = unmatchedResults.length > 0
    ? await matchMoviesByTitle(unmatchedResults)
    : [];

  const allMatched = [...alreadyMatched, ...newlyMatched];

  const sorted = allMatched
    .filter(m => m.tmdb_id && tmdbOrder.has(m.tmdb_id))
    .sort((a, b) => (tmdbOrder.get(a.tmdb_id!) ?? 0) - (tmdbOrder.get(b.tmdb_id!) ?? 0));

  return {
    movies: sorted,
    newlyMatched: newlyMatched.length,
  };
}

interface SeriesMatchResult {
  series: StoredSeries[];
  newlyMatched: number;
}

/**
 * Get series for TMDB list, combining:
 * 1. Already matched series (by tmdb_id)
 * 2. Newly matched series (by title)
 *
 * Returns series in TMDB list order
 */
export async function getOrMatchSeriesByTmdbList(
  tmdbResults: TmdbTvResult[]
): Promise<SeriesMatchResult> {
  if (tmdbResults.length === 0) return { series: [], newlyMatched: 0 };

  const tmdbIds = tmdbResults.map(s => s.id);
  const tmdbOrder = new Map(tmdbResults.map((s, i) => [s.id, i]));

  const alreadyMatched = await db.vodSeries
    .where('tmdb_id')
    .anyOf(tmdbIds)
    .toArray();

  const matchedIds = new Set(alreadyMatched.map(s => s.tmdb_id));

  const unmatchedResults = tmdbResults.filter(s => !matchedIds.has(s.id));

  const newlyMatched = unmatchedResults.length > 0
    ? await matchSeriesByTitle(unmatchedResults)
    : [];

  const allMatched = [...alreadyMatched, ...newlyMatched];

  const sorted = allMatched
    .filter(s => s.tmdb_id && tmdbOrder.has(s.tmdb_id))
    .sort((a, b) => (tmdbOrder.get(a.tmdb_id!) ?? 0) - (tmdbOrder.get(b.tmdb_id!) ?? 0));

  return {
    series: sorted,
    newlyMatched: newlyMatched.length,
  };
}

// ===========================================================================
// Lazy Bulk Matching (for "Match All" button in settings)
// ===========================================================================

import {
  getTrendingMoviesWithCache,
  getPopularMoviesWithCache,
  getTopRatedMoviesWithCache,
  getTrendingTvShowsWithCache,
  getPopularTvShowsWithCache,
  getTopRatedTvShowsWithCache,
} from './tmdb';

/**
 * Match all unmatched movies using TMDB lists (Trending, Popular, Top Rated)
 * No bulk export download required - uses small API responses
 */
export async function matchAllMoviesLazy(): Promise<number> {
  console.log('[Lazy Match] Starting movie matching...');
  
  const lists = await Promise.all([
    getTrendingMoviesWithCache(null, 'week'),
    getPopularMoviesWithCache(null),
    getTopRatedMoviesWithCache(null),
  ]);

  const allResults = lists.flat();
  const uniqueResults = Array.from(
    new Map(allResults.map(m => [m.id, m])).values()
  );

  console.log(`[Lazy Match] Found ${uniqueResults.length} unique TMDB movies to match against`);

  const { newlyMatched } = await getOrMatchMoviesByTmdbList(uniqueResults);
  
  console.log(`[Lazy Match] Matched ${newlyMatched} movies`);
  return newlyMatched;
}

/**
 * Match all unmatched series using TMDB lists (Trending, Popular, Top Rated)
 * No bulk export download required - uses small API responses
 */
export async function matchAllSeriesLazy(): Promise<number> {
  console.log('[Lazy Match] Starting series matching...');
  
  const lists = await Promise.all([
    getTrendingTvShowsWithCache(null, 'week'),
    getPopularTvShowsWithCache(null),
    getTopRatedTvShowsWithCache(null),
  ]);

  const allResults = lists.flat();
  const uniqueResults = Array.from(
    new Map(allResults.map(s => [s.id, s])).values()
  );

  console.log(`[Lazy Match] Found ${uniqueResults.length} unique TMDB series to match against`);

  const { newlyMatched } = await getOrMatchSeriesByTmdbList(uniqueResults);
  
  console.log(`[Lazy Match] Matched ${newlyMatched} series`);
  return newlyMatched;
}
