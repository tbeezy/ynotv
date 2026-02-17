/**
 * useLazyPlot - Lazy-load plot/overview and genre from TMDB on demand
 *
 * Fetches details from TMDB API when:
 * - Item has tmdb_id (from export matching)
 * - Item is missing plot or genre
 * - User has TMDB API key configured
 *
 * Caches result to DB so we don't refetch.
 */

import { useState, useEffect, useRef } from 'react';
import { db, type StoredMovie, type StoredSeries } from '../db';
import { getMovieDetails, getTvShowDetails, searchMovies, searchTvShows } from '../services/tmdb';
import { type MediaItem, isMovie } from '../types/media';

interface LazyDetails {
  plot: string | null;
  genre: string | null;
}

/**
 * Lazy-load plot and genre for a movie or series from TMDB
 *
 * @param item - Movie or series to get details for
 * @param apiKey - TMDB API key (if not provided, returns nulls)
 * @returns Object with plot and genre strings
 */
export function useLazyPlot(
  item: MediaItem | null | undefined,
  apiKey: string | null | undefined
): LazyDetails {
  // Check what we already have
  const existingPlot = item?.plot || null;
  const existingGenre = item?.genre || null;

  const [fetchedDetails, setFetchedDetails] = useState<LazyDetails>({
    plot: null,
    genre: null,
  });
  const lastItemIdRef = useRef<string | null>(null);
  const fetchingRef = useRef(false);

  // Get item ID for tracking
  const itemId = item ? (isMovie(item) ? item.stream_id : item.series_id) : null;

  // Reset fetched details when item changes
  if (itemId !== lastItemIdRef.current) {
    lastItemIdRef.current = itemId;
    if (fetchedDetails.plot !== null || fetchedDetails.genre !== null) {
      setFetchedDetails({ plot: null, genre: null });
    }
  }

  useEffect(() => {
    if (!item) {
      console.log('[useLazyPlot] No item provided');
      return;
    }

    console.log('[useLazyPlot] Starting fetch for:', item.name || item.title, { hasTmdbId: !!item.tmdb_id, apiKey: !!apiKey });

    // If we already have both plot and genre, no need to fetch
    if (existingPlot && existingGenre) {
      console.log('[useLazyPlot] Already have plot and genre, skipping');
      return;
    }

    // No API key - can't fetch
    if (!apiKey) {
      console.log('[useLazyPlot] No API key, skipping');
      return;
    }

    // Don't double-fetch
    if (fetchingRef.current) return;

    let cancelled = false;

    const fetchDetails = async () => {
      fetchingRef.current = true;
      try {
        let overview: string | null = null;
        let genreStr: string | null = null;
        let foundTmdbId: number | null = item.tmdb_id || null;

        // If no tmdb_id but we have a title, search TMDB
        if (!foundTmdbId && (item.title || item.name)) {
          const searchQuery = (item.title || item.name || '').trim();
          const year = item.year || item.release_date?.slice(0, 4);

          console.log('[useLazyPlot] Searching TMDB for:', searchQuery, year ? `(${year})` : '');

          if (searchQuery) {
            try {
              if (isMovie(item)) {
                const results = await searchMovies(apiKey, searchQuery, year ? parseInt(year) : undefined);
                if (cancelled) return;
                console.log('[useLazyPlot] Search results:', results.length);
                if (results.length > 0) {
                  foundTmdbId = results[0].id;
                  console.log('[useLazyPlot] Found TMDB ID:', foundTmdbId, results[0].title);
                }
              } else {
                const results = await searchTvShows(apiKey, searchQuery, year ? parseInt(year) : undefined);
                if (cancelled) return;
                console.log('[useLazyPlot] Search results:', results.length);
                if (results.length > 0) {
                  foundTmdbId = results[0].id;
                  console.log('[useLazyPlot] Found TMDB ID:', foundTmdbId, results[0].name);
                }
              }
            } catch (searchErr) {
              console.warn('[useLazyPlot] TMDB search failed:', searchErr);
            }
          }
        }

        // If still no tmdb_id, can't fetch details
        if (!foundTmdbId) {
          console.log('[useLazyPlot] No TMDB ID found, skipping');
          fetchingRef.current = false;
          return;
        }

        if (isMovie(item)) {
          const details = await getMovieDetails(apiKey, foundTmdbId);
          if (cancelled) return;

          overview = details.overview || null;
          // Get all genre names, comma-separated
          if (details.genres && details.genres.length > 0) {
            genreStr = details.genres.map((g) => g.name).join(', ');
          }

          // Cache to DB - only update fields we're missing, also save tmdb_id if found via search
          const updates: Partial<StoredMovie> = {};
          if (!item.tmdb_id) updates.tmdb_id = foundTmdbId;
          if (overview && !existingPlot) updates.plot = overview;
          if (genreStr && !existingGenre) updates.genre = genreStr;

          if (Object.keys(updates).length > 0) {
            await db.vodMovies.update(item.stream_id, updates);
          }
        } else {
          const details = await getTvShowDetails(apiKey, foundTmdbId);
          if (cancelled) return;

          overview = details.overview || null;
          // Get all genre names, comma-separated
          if (details.genres && details.genres.length > 0) {
            genreStr = details.genres.map((g) => g.name).join(', ');
          }

          // Cache to DB
          const updates: Partial<StoredSeries> = {};
          if (!item.tmdb_id) updates.tmdb_id = foundTmdbId;
          if (overview && !existingPlot) updates.plot = overview;
          if (genreStr && !existingGenre) updates.genre = genreStr;

          if (Object.keys(updates).length > 0) {
            await db.vodSeries.update(item.series_id, updates);
          }
        }

        if (!cancelled) {
          console.log('[useLazyPlot] Fetched details:', { hasPlot: !!overview, hasGenre: !!genreStr });
          setFetchedDetails({
            plot: overview,
            genre: genreStr,
          });
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('[useLazyPlot] Failed to fetch TMDB details:', err);
        }
      } finally {
        fetchingRef.current = false;
      }
    };

    fetchDetails();

    return () => {
      cancelled = true;
      fetchingRef.current = false;
    };
  }, [item?.tmdb_id, item?.title, item?.name, existingPlot, existingGenre, apiKey]);

  // Return existing data or fetched data
  return {
    plot: existingPlot || fetchedDetails.plot,
    genre: existingGenre || fetchedDetails.genre,
  };
}

export default useLazyPlot;
