/**
 * useLazyCredits - Lazy-load cast and director from TMDB or TVMaze
 *
 * Fetches credits from:
 * - TMDB API (if API key configured) - primary source
 * - TVMaze API (free, no key required) - fallback for TV series cast
 *
 * Caches result to DB so we don't refetch.
 */

import { useState, useEffect, useRef } from 'react';
import { db, type StoredMovie, type StoredSeries } from '../db';
import { getMovieCredits, getTvShowCredits, searchMovies, searchTvShows } from '../services/tmdb';
import { getTvShowMetadataWithCast } from '../services/tvmaze';
import { type MediaItem, isMovie } from '../types/media';

interface Credits {
  cast: string | null;
  director: string | null;
}

/**
 * Lazy-load credits (cast and director) for a movie or series from TMDB or TVMaze
 *
 * @param item - Movie or series to get credits for
 * @param apiKey - TMDB API key (if not provided, uses TVMaze for series)
 * @returns Credits object with cast and director strings
 */
export function useLazyCredits(
  item: MediaItem | null | undefined,
  apiKey: string | null | undefined
): Credits {
  // Return existing credits if already have them
  const hasCast = item?.cast && item.cast.trim().length > 0;
  const hasDirector = item && isMovie(item) && !!item.director?.trim();

  const [fetchedCredits, setFetchedCredits] = useState<Credits>({
    cast: null,
    director: null,
  });
  const lastItemIdRef = useRef<string | null>(null);
  const fetchingRef = useRef(false);

  // Get item ID for tracking
  const itemId = item ? (isMovie(item) ? item.stream_id : item.series_id) : null;

  // Reset fetched credits when item changes
  if (itemId !== lastItemIdRef.current) {
    lastItemIdRef.current = itemId;
    if (fetchedCredits.cast !== null || fetchedCredits.director !== null) {
      setFetchedCredits({ cast: null, director: null });
    }
  }

  useEffect(() => {
    if (!item) return;

    // If we already have both cast and director (for movies), no need to fetch
    if (hasCast && (hasDirector || !isMovie(item))) {
      return;
    }

    // For movies, we need TMDB API key (no free fallback with cast data)
    // For series, we can use TVMaze as fallback (no API key needed)
    if (!apiKey && isMovie(item)) {
      return;
    }

    // Don't double-fetch
    if (fetchingRef.current) return;

    let cancelled = false;

    const fetchCredits = async () => {
      fetchingRef.current = true;
      try {
        let castString: string | null = null;
        let directorString: string | null = null;
        let foundTmdbId: number | null = item.tmdb_id || null;

        // Get search query
        const searchQuery = (item.title || item.name || '').trim();

        if (!searchQuery) {
          fetchingRef.current = false;
          return;
        }

        // For series without TMDB key, use TVMaze directly for cast
        if (!apiKey && !isMovie(item)) {
          console.log('[useLazyCredits] No TMDB key, using TVMaze for series cast:', searchQuery);
          try {
            const metadata = await getTvShowMetadataWithCast(searchQuery);
            if (cancelled) return;

            if (metadata.found && metadata.cast) {
              castString = metadata.cast;
              console.log('[useLazyCredits] TVMaze found cast:', castString, 'imdbId:', metadata.imdbId);

              // Cache to DB
              const updates: Partial<StoredSeries> = {};
              if (!hasCast) updates.cast = castString;
              if (metadata.imdbId && !item.imdb_id) updates.imdb_id = metadata.imdbId;

              if (Object.keys(updates).length > 0) {
                await db.vodSeries.update(item.series_id, updates);
              }
            }
          } catch (tvmazeErr) {
            console.warn('[useLazyCredits] TVMaze cast fetch failed:', tvmazeErr);
          }

          if (!cancelled) {
            setFetchedCredits({ cast: castString, director: null });
          }
          fetchingRef.current = false;
          return;
        }

        // TMDB path (requires API key)
        if (!apiKey) {
          fetchingRef.current = false;
          return;
        }

        // If no tmdb_id but we have a title, search TMDB
        if (!foundTmdbId) {
          const year = item.year || item.release_date?.slice(0, 4);

          try {
            if (isMovie(item)) {
              const results = await searchMovies(apiKey, searchQuery, year ? parseInt(year) : undefined);
              if (cancelled) return;
              if (results.length > 0) {
                foundTmdbId = results[0].id;
              }
            } else {
              const results = await searchTvShows(apiKey, searchQuery, year ? parseInt(year) : undefined);
              if (cancelled) return;
              if (results.length > 0) {
                foundTmdbId = results[0].id;
              }
            }
          } catch (searchErr) {
            console.warn('TMDB search failed:', searchErr);
          }
        }

        // If still no tmdb_id, try TVMaze fallback for series cast
        if (!foundTmdbId && !isMovie(item)) {
          console.log('[useLazyCredits] No TMDB ID found, trying TVMaze fallback for series cast:', searchQuery);
          try {
            const metadata = await getTvShowMetadataWithCast(searchQuery);
            if (cancelled) return;

            if (metadata.found && metadata.cast) {
              castString = metadata.cast;
              console.log('[useLazyCredits] TVMaze fallback found cast:', castString, 'imdbId:', metadata.imdbId);

              // Cache to DB
              const updates: Partial<StoredSeries> = {};
              if (!hasCast) updates.cast = castString;
              if (metadata.imdbId && !item.imdb_id) updates.imdb_id = metadata.imdbId;

              if (Object.keys(updates).length > 0) {
                await db.vodSeries.update(item.series_id, updates);
              }
            }
          } catch (tvmazeErr) {
            console.warn('[useLazyCredits] TVMaze fallback failed:', tvmazeErr);
          }

          if (!cancelled) {
            setFetchedCredits({ cast: castString, director: null });
          }
          fetchingRef.current = false;
          return;
        }

        // If still no tmdb_id, can't fetch credits from TMDB
        if (!foundTmdbId) {
          fetchingRef.current = false;
          return;
        }

        // Fetch credits from TMDB
        if (isMovie(item)) {
          const credits = await getMovieCredits(apiKey, foundTmdbId);
          if (cancelled) return;

          // Get top 5 cast members
          const topCast = credits.cast
            .slice(0, 5)
            .map((c) => c.name)
            .join(', ');
          if (topCast) castString = topCast;

          // Get director(s) from crew
          const directors = credits.crew
            .filter((c) => c.job === 'Director')
            .map((c) => c.name)
            .join(', ');
          if (directors) directorString = directors;

          // Cache to DB
          const updates: Partial<StoredMovie> = {};
          if (!item.tmdb_id) updates.tmdb_id = foundTmdbId;
          if (castString && !hasCast) updates.cast = castString;
          if (directorString && !hasDirector) updates.director = directorString;

          if (Object.keys(updates).length > 0) {
            await db.vodMovies.update(item.stream_id, updates);
          }
        } else {
          const credits = await getTvShowCredits(apiKey, foundTmdbId);
          if (cancelled) return;

          // Get top 5 cast members
          const topCast = credits.cast
            .slice(0, 5)
            .map((c) => c.name)
            .join(', ');
          if (topCast) castString = topCast;

          // Cache to DB
          const updates: Partial<{ cast: string; tmdb_id: number }> = {};
          if (!item.tmdb_id) updates.tmdb_id = foundTmdbId;
          if (castString && !hasCast) updates.cast = castString;

          if (Object.keys(updates).length > 0) {
            await db.vodSeries.update(item.series_id, updates);
          }
        }

        if (!cancelled) {
          setFetchedCredits({
            cast: castString,
            director: directorString,
          });
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('Failed to fetch TMDB credits:', err);
        }
      } finally {
        fetchingRef.current = false;
      }
    };

    fetchCredits();

    return () => {
      cancelled = true;
      fetchingRef.current = false;
    };
  }, [item?.tmdb_id, item?.title, item?.name, apiKey, hasCast, hasDirector]);

  // Return existing credits or fetched credits
  return {
    cast: (hasCast ? item?.cast : fetchedCredits.cast) ?? null,
    director: (hasDirector && item && isMovie(item) ? item.director : fetchedCredits.director) ?? null,
  };
}

export default useLazyCredits;
