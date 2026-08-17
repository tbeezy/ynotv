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
import { cleanTitleForSearch } from '../utils/cleanTitle';

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
  // Full identity of the item for fetch purposes. A metadata-edit save changes
  // title/name/tmdb_id/year, which changes this key and triggers a fresh fetch.
  const itemId = item ? (isMovie(item) ? item.stream_id : item.series_id) : null;
  const fetchKey = item
    ? `${itemId}|${item.title ?? ''}|${item.name ?? ''}|${item.tmdb_id ?? ''}|${item.year ?? ''}`
    : null;
  const lastFetchKeyRef = useRef<string | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);
  const fetchedKeyRef = useRef<string | null>(null);

  // Reset fetched credits when the item identity changes (new item, or the
  // user corrected the metadata) so the new fetch's result replaces the old.
  if (fetchKey !== lastFetchKeyRef.current) {
    lastFetchKeyRef.current = fetchKey;
    if (fetchedCredits.cast !== null || fetchedCredits.director !== null) {
      setFetchedCredits({ cast: null, director: null });
    }
  }

  useEffect(() => {
    if (!item) return;

    // Don't refetch while the exact same key is in flight or already fetched.
    // A metadata correction changes the key, so it is never blocked here — and
    // the old hasCast short-circuit is gone: a provider-supplied cast is a
    // fallback, not a reason to skip refreshing after the user fixes the title.
    if (inFlightKeyRef.current === fetchKey) return;
    if (fetchedKeyRef.current === fetchKey) return;

    // For movies, we need TMDB API key (no free fallback with cast data)
    // For series, we can use TVMaze as fallback (no API key needed)
    if (!apiKey && isMovie(item)) {
      return;
    }

    let cancelled = false;

    const fetchCredits = async () => {
      inFlightKeyRef.current = fetchKey;
      try {
        let castString: string | null = null;
        let directorString: string | null = null;
        let foundTmdbId: number | null = item.tmdb_id || null;

        // Get search query
        const searchQuery = cleanTitleForSearch(item.title || item.name);

        if (!searchQuery) {
          inFlightKeyRef.current = null;
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
            if (fetchKey !== null) fetchedKeyRef.current = fetchKey;
          }
          inFlightKeyRef.current = null;
          return;
        }

        // TMDB path (requires API key)
        if (!apiKey) {
          inFlightKeyRef.current = null;
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
            if (fetchKey !== null) fetchedKeyRef.current = fetchKey;
          }
          inFlightKeyRef.current = null;
          return;
        }

        // If still no tmdb_id, can't fetch credits from TMDB
        if (!foundTmdbId) {
          inFlightKeyRef.current = null;
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
          if (fetchKey !== null) fetchedKeyRef.current = fetchKey;
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('Failed to fetch TMDB credits:', err);
        }
      } finally {
        if (inFlightKeyRef.current === fetchKey) {
          inFlightKeyRef.current = null;
        }
      }
    };

    fetchCredits();

    return () => {
      cancelled = true;
      if (inFlightKeyRef.current === fetchKey) {
        inFlightKeyRef.current = null;
      }
    };
  }, [fetchKey, apiKey]);

  // Prefer freshly fetched credits once we have them; fall back to the
  // provider's cast/director only before a fetch completes (or if it failed).
  return {
    cast: (fetchedCredits.cast ?? (hasCast ? item?.cast : null)) ?? null,
    director: (fetchedCredits.director ?? (hasDirector && item && isMovie(item) ? item.director : null)) ?? null,
  };
}

export default useLazyCredits;
