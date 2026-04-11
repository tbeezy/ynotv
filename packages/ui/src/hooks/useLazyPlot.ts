/**
 * useLazyPlot - Lazy-load plot/overview and genre from TMDB or TVMaze on demand
 *
 * Fetches details from:
 * - TMDB API (if API key configured) - primary source
 * - TVMaze API (free, no key required) - fallback for TV series only
 *
 * Caches result to DB so we don't refetch.
 */

import { useState, useEffect, useRef } from 'react';
import { db, type StoredMovie, type StoredSeries } from '../db';
import { getMovieDetails, getTvShowDetails, searchMovies, searchTvShows } from '../services/tmdb';
import { getTvShowMetadataWithCast } from '../services/tvmaze';
import { type MediaItem, isMovie } from '../types/media';

interface LazyDetails {
  plot: string | null;
  genre: string | null;
}

/**
 * Lazy-load plot and genre for a movie or series from TMDB or TVMaze
 *
 * @param item - Movie or series to get details for
 * @param apiKey - TMDB API key (if not provided, uses TVMaze for series)
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

    console.log('[useLazyPlot] Starting fetch for:', item.name || item.title, { hasTmdbId: !!item.tmdb_id, apiKey: !!apiKey, isMovie: isMovie(item) });

    // If we already have both plot and genre, no need to fetch
    if (existingPlot && existingGenre) {
      console.log('[useLazyPlot] Already have plot and genre, skipping');
      return;
    }

    // For movies, we need TMDB API key (no free fallback with images)
    // For series, we can use TVMaze as fallback (no API key needed)
    if (!apiKey && isMovie(item)) {
      console.log('[useLazyPlot] No API key and item is movie, skipping (TMDB key required for movies)');
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

        // Get search query
        const searchQuery = (item.title || item.name || '').trim();
        const year = item.year || item.release_date?.slice(0, 4);

        if (!searchQuery) {
          console.log('[useLazyPlot] No title/name available for search, skipping');
          fetchingRef.current = false;
          return;
        }

        // For series without TMDB key, use TVMaze directly
        if (!apiKey && !isMovie(item)) {
          console.log('[useLazyPlot] No TMDB key, using TVMaze for series:', searchQuery);
          try {
            const metadata = await getTvShowMetadataWithCast(searchQuery);
            if (cancelled) return;

            if (metadata.found) {
              overview = metadata.overview;
              genreStr = metadata.genres;
              console.log('[useLazyPlot] TVMaze found metadata:', { hasPlot: !!overview, hasGenre: !!genreStr });

              // Cache to DB (note: TVMaze doesn't provide tmdb_id)
              const updates: Partial<StoredSeries> = {};
              if (overview && !existingPlot) updates.plot = overview;
              if (genreStr && !existingGenre) updates.genre = genreStr;

              if (Object.keys(updates).length > 0) {
                await db.vodSeries.update(item.series_id, updates);
              }
            } else {
              console.log('[useLazyPlot] TVMaze found no results for:', searchQuery);
            }
          } catch (tvmazeErr) {
            console.warn('[useLazyPlot] TVMaze fetch failed:', tvmazeErr);
          }

          if (!cancelled) {
            setFetchedDetails({
              plot: overview,
              genre: genreStr,
            });
          }
          fetchingRef.current = false;
          return;
        }

        // TMDB path (requires API key)
        if (!apiKey) {
          console.log('[useLazyPlot] No API key available');
          fetchingRef.current = false;
          return;
        }

        // If no tmdb_id but we have a title, search TMDB
        if (!foundTmdbId) {
          console.log('[useLazyPlot] Searching TMDB for:', searchQuery, year ? `(${year})` : '');

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

        // If still no tmdb_id, try TVMaze fallback for series
        if (!foundTmdbId && !isMovie(item)) {
          console.log('[useLazyPlot] No TMDB ID found, trying TVMaze fallback for series:', searchQuery);
          try {
            const metadata = await getTvShowMetadataWithCast(searchQuery);
            if (cancelled) return;

            if (metadata.found) {
              overview = metadata.overview;
              genreStr = metadata.genres;
              console.log('[useLazyPlot] TVMaze fallback found metadata:', { hasPlot: !!overview, hasGenre: !!genreStr });

              // Cache to DB
              const updates: Partial<StoredSeries> = {};
              if (overview && !existingPlot) updates.plot = overview;
              if (genreStr && !existingGenre) updates.genre = genreStr;

              if (Object.keys(updates).length > 0) {
                await db.vodSeries.update(item.series_id, updates);
              }
            }
          } catch (tvmazeErr) {
            console.warn('[useLazyPlot] TVMaze fallback failed:', tvmazeErr);
          }

          if (!cancelled) {
            setFetchedDetails({
              plot: overview,
              genre: genreStr,
            });
          }
          fetchingRef.current = false;
          return;
        }

        // If still no tmdb_id, can't fetch details from TMDB
        if (!foundTmdbId) {
          console.log('[useLazyPlot] No TMDB ID found, skipping');
          fetchingRef.current = false;
          return;
        }

        // Fetch from TMDB using found ID
        if (isMovie(item)) {
          const details = await getMovieDetails(apiKey, foundTmdbId);
          if (cancelled) return;

          overview = details.overview || null;
          if (details.genres && details.genres.length > 0) {
            genreStr = details.genres.map((g) => g.name).join(', ');
          }

          // Cache to DB
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
          console.log('[useLazyPlot] Fetched TMDB details:', { hasPlot: !!overview, hasGenre: !!genreStr });
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
