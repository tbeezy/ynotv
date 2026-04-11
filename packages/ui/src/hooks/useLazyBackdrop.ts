/**
 * useLazyBackdrop - Lazy-load backdrop images from TMDB or TVMaze on demand
 *
 * Fetches backdrop from:
 * - TMDB API (if API key configured) - primary source
 * - TVMaze API (free, no key required) - fallback for TV series images
 *
 * Caches result to DB so we don't refetch.
 */

import { useState, useEffect, useRef } from 'react';
import { db, type StoredSeries } from '../db';
import {
  getMovieDetails,
  getTvShowDetails,
  getTmdbImageUrl,
  TMDB_BACKDROP_SIZES,
  searchMovies,
  searchTvShows,
} from '../services/tmdb';
import { getTvShowMetadata, getShowBackdropUrl } from '../services/tvmaze';
import { getRpdbBackdropUrl } from '../services/rpdb';
import { useRpdbSettings } from './useRpdbSettings';
import { type MediaItem, isMovie } from '../types/media';

/**
 * Lazy-load backdrop for a movie or series from TMDB or TVMaze
 *
 * @param item - Movie or series to get backdrop for
 * @param apiKey - TMDB API key (if not provided, uses TVMaze for series)
 * @param size - Backdrop size (default: large)
 * @returns Backdrop URL or null
 */
export function useLazyBackdrop(
  item: MediaItem | null | undefined,
  apiKey: string | null | undefined,
  size: keyof typeof TMDB_BACKDROP_SIZES = 'large'
): string | null {
  // Load RPDB settings
  const { apiKey: rpdbApiKey, backdropsEnabled: rpdbBackdropsEnabled } = useRpdbSettings();

  // State only for async-fetched backdrops (must be called before any early returns)
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null);
  const lastItemIdRef = useRef<string | null>(null);
  // useRef instead of useState - synchronously mutable, no stale closure issues
  const fetchingRef = useRef(false);

  // Get item ID for tracking
  const itemId = item ? (isMovie(item) ? item.stream_id : item.series_id) : null;

  // Check if we should use RPDB backdrop
  const itemType = item ? (isMovie(item) ? 'movie' : 'series') : null;
  const rpdbBackdropUrl = rpdbApiKey && rpdbBackdropsEnabled && item?.tmdb_id && itemType
    ? getRpdbBackdropUrl(rpdbApiKey, item.tmdb_id, itemType)
    : null;

  // Synchronously compute URL if item already has backdrop_path (no flash)
  const cachedUrl = item?.backdrop_path
    ? getTmdbImageUrl(item.backdrop_path, TMDB_BACKDROP_SIZES[size])
    : null;

  // Reset fetched URL when item changes
  if (itemId !== lastItemIdRef.current) {
    lastItemIdRef.current = itemId;
    if (fetchedUrl !== null) {
      setFetchedUrl(null);
    }
  }

  useEffect(() => {
    if (!item) {
      return;
    }

    // If we already have a backdrop_path, no need to fetch
    if (item.backdrop_path) {
      return;
    }

    // For movies, we need TMDB API key (TVMaze only has TV shows)
    // For series, we can use TVMaze as fallback (no API key needed)
    if (!apiKey && isMovie(item)) {
      return;
    }

    // Don't double-fetch - ref is synchronously checked, no race condition
    if (fetchingRef.current) return;

    // Track if this effect instance is still active (for cleanup)
    let cancelled = false;

    // Fetch backdrop from TMDB or TVMaze
    const fetchBackdrop = async () => {
      fetchingRef.current = true;
      try {
        let backdropUrl: string | null = null;
        let foundTmdbId: number | null = item.tmdb_id || null;

        // Get search query
        const searchQuery = (item.title || item.name || '').trim();

        if (!searchQuery) {
          fetchingRef.current = false;
          return;
        }

        // For series without TMDB key, use TVMaze directly
        if (!apiKey && !isMovie(item)) {
          console.log('[useLazyBackdrop] No TMDB key, using TVMaze for series backdrop:', searchQuery);
          try {
            const metadata = await getTvShowMetadata(searchQuery);
            if (cancelled) return;

            if (metadata.found && metadata.backdropUrl) {
              backdropUrl = metadata.backdropUrl;
              console.log('[useLazyBackdrop] TVMaze found backdrop:', backdropUrl, 'imdbId:', metadata.imdbId);

              // Cache to DB - store TVMaze image URL as backdrop_path and imdb_id if available
              const updates: Partial<StoredSeries> = {};
              if (backdropUrl) updates.backdrop_path = backdropUrl;
              if (metadata.imdbId && !item.imdb_id) updates.imdb_id = metadata.imdbId;

              if (Object.keys(updates).length > 0) {
                await db.vodSeries.update(item.series_id, updates);
              }
            }
          } catch (tvmazeErr) {
            console.warn('[useLazyBackdrop] TVMaze backdrop fetch failed:', tvmazeErr);
          }

          if (!cancelled && backdropUrl) {
            setFetchedUrl(backdropUrl);
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

        // If still no tmdb_id, try TVMaze fallback for series
        if (!foundTmdbId && !isMovie(item)) {
          console.log('[useLazyBackdrop] No TMDB ID found, trying TVMaze fallback for series:', searchQuery);
          try {
            const metadata = await getTvShowMetadata(searchQuery);
            if (cancelled) return;

            if (metadata.found && metadata.backdropUrl) {
              backdropUrl = metadata.backdropUrl;
              console.log('[useLazyBackdrop] TVMaze fallback found backdrop:', backdropUrl, 'imdbId:', metadata.imdbId);

              // Cache to DB
              const updates: Partial<StoredSeries> = {};
              if (backdropUrl) updates.backdrop_path = backdropUrl;
              if (metadata.imdbId && !item.imdb_id) updates.imdb_id = metadata.imdbId;

              if (Object.keys(updates).length > 0) {
                await db.vodSeries.update(item.series_id, updates);
              }
            }
          } catch (tvmazeErr) {
            console.warn('[useLazyBackdrop] TVMaze fallback failed:', tvmazeErr);
          }

          if (!cancelled && backdropUrl) {
            setFetchedUrl(backdropUrl);
          }
          fetchingRef.current = false;
          return;
        }

        // If still no tmdb_id, can't fetch backdrop from TMDB
        if (!foundTmdbId) {
          fetchingRef.current = false;
          return;
        }

        // Fetch from TMDB
        let backdropPath: string | null = null;

        if (isMovie(item)) {
          const details = await getMovieDetails(apiKey, foundTmdbId);
          if (cancelled) return;
          backdropPath = details.backdrop_path;

          // Cache to DB
          const updates: Partial<{ backdrop_path: string; tmdb_id: number }> = {};
          if (!item.tmdb_id) updates.tmdb_id = foundTmdbId;
          if (backdropPath) updates.backdrop_path = backdropPath;

          if (Object.keys(updates).length > 0) {
            await db.vodMovies.update(item.stream_id, updates);
          }
        } else {
          const details = await getTvShowDetails(apiKey, foundTmdbId);
          if (cancelled) return;
          backdropPath = details.backdrop_path;

          // Cache to DB
          const updates: Partial<{ backdrop_path: string; tmdb_id: number }> = {};
          if (!item.tmdb_id) updates.tmdb_id = foundTmdbId;
          if (backdropPath) updates.backdrop_path = backdropPath;

          if (Object.keys(updates).length > 0) {
            await db.vodSeries.update(item.series_id, updates);
          }
        }

        if (!cancelled && backdropPath) {
          setFetchedUrl(getTmdbImageUrl(backdropPath, TMDB_BACKDROP_SIZES[size]));
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('Failed to fetch TMDB backdrop:', err);
        }
        // Silently fail - fallback to cover image
      } finally {
        fetchingRef.current = false;
      }
    };

    fetchBackdrop();

    // Cleanup: mark as cancelled and reset fetching flag so next effect can fetch
    return () => {
      cancelled = true;
      fetchingRef.current = false;
    };
  }, [item?.tmdb_id, item?.title, item?.name, item?.backdrop_path, apiKey, size]);

  // Priority: RPDB backdrop > cached TMDB URL > fetched TMDB URL
  return rpdbBackdropUrl || cachedUrl || fetchedUrl;
}

export default useLazyBackdrop;
