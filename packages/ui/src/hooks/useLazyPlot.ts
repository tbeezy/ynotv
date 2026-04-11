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
  rating: number | null;
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
    rating: null,
  });
  const lastItemIdRef = useRef<string | null>(null);
  const fetchingRef = useRef(false);

  // Get item ID for tracking
  const itemId = item ? (isMovie(item) ? item.stream_id : item.series_id) : null;

  // Reset fetched details when item changes
  if (itemId !== lastItemIdRef.current) {
    lastItemIdRef.current = itemId;
    if (fetchedDetails.plot !== null || fetchedDetails.genre !== null || fetchedDetails.rating !== null) {
      setFetchedDetails({ plot: null, genre: null, rating: null });
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
        let ratingValue: number | null = null;
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
              ratingValue = metadata.rating;
              console.log('[useLazyPlot] TVMaze found metadata:', { title: metadata.title, rating: ratingValue, hasPlot: !!overview, hasGenre: !!genreStr, imdbId: metadata.imdbId });

              // Check if we have a valid existing rating (handle JSON-encoded strings like '"7"')
              const rawExistingRating = item.rating;
              let existingRatingStr = rawExistingRating && typeof rawExistingRating === 'string' ? rawExistingRating.trim() : null;
              if (existingRatingStr && existingRatingStr.startsWith('"') && existingRatingStr.endsWith('"')) {
                existingRatingStr = existingRatingStr.slice(1, -1);
              }
              const existingRating = existingRatingStr ? parseFloat(existingRatingStr) : NaN;
              const hasValidExistingRating = !isNaN(existingRating) && existingRating > 0;

              // Cache to DB (note: TVMaze doesn't provide tmdb_id but may have imdb_id)
              const updates: Partial<StoredSeries> = {};
              if (overview && !existingPlot) updates.plot = overview;
              if (genreStr && !existingGenre) updates.genre = genreStr;
              if (ratingValue && !hasValidExistingRating) {
                updates.rating = ratingValue.toString();
                console.log('[useLazyPlot] Saving TVMaze rating:', ratingValue);
              }
              if (metadata.imdbId && !item.imdb_id) updates.imdb_id = metadata.imdbId;

              if (Object.keys(updates).length > 0) {
                console.log('[useLazyPlot] Updating series DB with:', Object.keys(updates));
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
              rating: ratingValue,
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
              ratingValue = metadata.rating;
              console.log('[useLazyPlot] TVMaze fallback found metadata:', { hasPlot: !!overview, hasGenre: !!genreStr, hasRating: !!ratingValue, imdbId: metadata.imdbId });

              // Check if we have a valid existing rating (handle JSON-encoded strings like '"7"')
              const rawExistingRating = item.rating;
              let existingRatingStr = rawExistingRating && typeof rawExistingRating === 'string' ? rawExistingRating.trim() : null;
              if (existingRatingStr && existingRatingStr.startsWith('"') && existingRatingStr.endsWith('"')) {
                existingRatingStr = existingRatingStr.slice(1, -1);
              }
              const existingRating = existingRatingStr ? parseFloat(existingRatingStr) : NaN;
              const hasValidExistingRating = !isNaN(existingRating) && existingRating > 0;

              // Cache to DB
              const updates: Partial<StoredSeries> = {};
              if (overview && !existingPlot) updates.plot = overview;
              if (genreStr && !existingGenre) updates.genre = genreStr;
              if (ratingValue && !hasValidExistingRating) updates.rating = ratingValue.toString();
              if (metadata.imdbId && !item.imdb_id) updates.imdb_id = metadata.imdbId;

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
              rating: ratingValue,
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
          ratingValue = details.vote_average || null;
          if (details.genres && details.genres.length > 0) {
            genreStr = details.genres.map((g) => g.name).join(', ');
          }

          // Check if we have a valid existing rating (handle JSON-encoded strings like '"7"')
          const rawExistingRating = item.rating;
          let existingRatingStr = rawExistingRating && typeof rawExistingRating === 'string' ? rawExistingRating.trim() : null;
          if (existingRatingStr && existingRatingStr.startsWith('"') && existingRatingStr.endsWith('"')) {
            existingRatingStr = existingRatingStr.slice(1, -1);
          }
          const existingRating = existingRatingStr ? parseFloat(existingRatingStr) : NaN;
          const hasValidExistingRating = !isNaN(existingRating) && existingRating > 0;

          // Cache to DB
          const updates: Partial<StoredMovie> = {};
          if (!item.tmdb_id) updates.tmdb_id = foundTmdbId;
          if (overview && !existingPlot) updates.plot = overview;
          if (genreStr && !existingGenre) updates.genre = genreStr;
          if (ratingValue && !hasValidExistingRating) updates.rating = ratingValue.toString();

          if (Object.keys(updates).length > 0) {
            await db.vodMovies.update(item.stream_id, updates);
          }
        } else {
          const details = await getTvShowDetails(apiKey, foundTmdbId);
          if (cancelled) return;

          overview = details.overview || null;
          ratingValue = details.vote_average || null;
          if (details.genres && details.genres.length > 0) {
            genreStr = details.genres.map((g) => g.name).join(', ');
          }

          // Check if we have a valid existing rating (handle JSON-encoded strings like '"7"')
          const rawExistingRating = item.rating;
          let existingRatingStr = rawExistingRating && typeof rawExistingRating === 'string' ? rawExistingRating.trim() : null;
          if (existingRatingStr && existingRatingStr.startsWith('"') && existingRatingStr.endsWith('"')) {
            existingRatingStr = existingRatingStr.slice(1, -1);
          }
          const existingRating = existingRatingStr ? parseFloat(existingRatingStr) : NaN;
          const hasValidExistingRating = !isNaN(existingRating) && existingRating > 0;

          // Cache to DB
          const updates: Partial<StoredSeries> = {};
          if (!item.tmdb_id) updates.tmdb_id = foundTmdbId;
          if (overview && !existingPlot) updates.plot = overview;
          if (genreStr && !existingGenre) updates.genre = genreStr;
          if (ratingValue && !hasValidExistingRating) updates.rating = ratingValue.toString();

          if (Object.keys(updates).length > 0) {
            await db.vodSeries.update(item.series_id, updates);
          }
        }

        if (!cancelled) {
          console.log('[useLazyPlot] Fetched TMDB details:', { hasPlot: !!overview, hasGenre: !!genreStr, hasRating: !!ratingValue });
          setFetchedDetails({
            plot: overview,
            genre: genreStr,
            rating: ratingValue,
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
  // Handle empty strings by treating them as null
  // Rating is stored as string but could be empty or undefined
  // Also handle JSON-encoded strings like '"7"' (with quotes)
  const rawRating = item?.rating;
  let ratingString = rawRating && typeof rawRating === 'string' ? rawRating.trim() : null;
  // Remove surrounding quotes if present (e.g., "7" -> 7)
  if (ratingString && ratingString.startsWith('"') && ratingString.endsWith('"')) {
    ratingString = ratingString.slice(1, -1);
  }
  const storedRatingValue = ratingString ? parseFloat(ratingString) : NaN;
  const hasValidStoredRating = !isNaN(storedRatingValue) && storedRatingValue > 0;

  return {
    plot: existingPlot || fetchedDetails.plot,
    genre: existingGenre || fetchedDetails.genre,
    rating: hasValidStoredRating ? storedRatingValue : fetchedDetails.rating,
  };
}

export default useLazyPlot;
