/**
 * useLazyBackdrop - Lazy-load TMDB backdrop images on demand
 *
 * Fetches backdrop from TMDB API when:
 * - Item has tmdb_id (from export matching)
 * - Item is missing backdrop_path
 * - User has TMDB API key configured
 *
 * Caches result to DB so we don't refetch.
 */

import { useState, useEffect, useRef } from 'react';
import { db } from '../db';
import {
  getMovieDetails,
  getTvShowDetails,
  getTmdbImageUrl,
  TMDB_BACKDROP_SIZES,
  searchMovies,
  searchTvShows,
} from '../services/tmdb';
import { getRpdbBackdropUrl } from '../services/rpdb';
import { useRpdbSettings } from './useRpdbSettings';
import { type MediaItem, isMovie } from '../types/media';

/**
 * Lazy-load backdrop for a movie or series
 *
 * @param item - Movie or series to get backdrop for
 * @param apiKey - TMDB API key (if not provided, returns null)
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

    // No API key - can't fetch
    if (!apiKey) {
      return;
    }

    // Don't double-fetch - ref is synchronously checked, no race condition
    if (fetchingRef.current) return;

    // Track if this effect instance is still active (for cleanup)
    let cancelled = false;

    // Fetch backdrop from TMDB
    const fetchBackdrop = async () => {
      fetchingRef.current = true;
      try {
        let backdropPath: string | null = null;
        let foundTmdbId: number | null = item.tmdb_id || null;

        // If no tmdb_id but we have a title, search TMDB
        if (!foundTmdbId && (item.title || item.name)) {
          const searchQuery = (item.title || item.name || '').trim();
          const year = item.year || item.release_date?.slice(0, 4);

          if (searchQuery) {
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
        }

        // If still no tmdb_id, can't fetch backdrop
        if (!foundTmdbId) {
          fetchingRef.current = false;
          return;
        }

        if (isMovie(item)) {
          const details = await getMovieDetails(apiKey, foundTmdbId);
          if (cancelled) return;
          backdropPath = details.backdrop_path;

          // Cache to DB - also save tmdb_id if found via search
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
