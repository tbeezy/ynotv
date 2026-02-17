/**
 * useRpdbSettings - Hook for accessing RPDB (RatingPosterDB) settings
 *
 * Loads RPDB API key and settings from storage, provides helper functions
 * for generating RPDB image URLs.
 */

import { useState, useEffect } from 'react';
import {
  getRpdbPosterUrl,
  getRpdbBackdropUrl,
  rpdbSupportsBackdrops,
} from '../services/rpdb';

interface RpdbSettings {
  apiKey: string | null;
  backdropsEnabled: boolean;
  loading: boolean;
}

/**
 * Load RPDB settings from storage
 */
export function useRpdbSettings(): RpdbSettings {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [backdropsEnabled, setBackdropsEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadSettings() {
      if (!window.storage) {
        setLoading(false);
        return;
      }

      const result = await window.storage.getSettings();
      if (result.data) {
        setApiKey(result.data.posterDbApiKey || null);
        setBackdropsEnabled(result.data.rpdbBackdropsEnabled ?? false);
      }
      setLoading(false);
    }

    loadSettings();
  }, []);

  return { apiKey, backdropsEnabled, loading };
}

/**
 * Get RPDB poster URL if available, otherwise return null
 *
 * @param rpdbApiKey - RPDB API key (from useRpdbSettings)
 * @param tmdbId - TMDB ID of the movie or series
 * @param type - 'movie' or 'series'
 * @returns RPDB poster URL or null
 */
export function useRpdbPosterUrl(
  rpdbApiKey: string | null,
  tmdbId: number | null | undefined,
  type: 'movie' | 'series'
): string | null {
  if (!rpdbApiKey || !tmdbId) {
    return null;
  }
  return getRpdbPosterUrl(rpdbApiKey, tmdbId, type);
}

/**
 * Get RPDB backdrop URL if available and enabled, otherwise return null
 *
 * @param rpdbApiKey - RPDB API key (from useRpdbSettings)
 * @param tmdbId - TMDB ID of the movie or series
 * @param type - 'movie' or 'series'
 * @param backdropsEnabled - Whether user has enabled RPDB backdrops
 * @returns RPDB backdrop URL or null
 */
export function useRpdbBackdropUrl(
  rpdbApiKey: string | null,
  tmdbId: number | null | undefined,
  type: 'movie' | 'series',
  backdropsEnabled: boolean
): string | null {
  if (!rpdbApiKey || !tmdbId || !backdropsEnabled) {
    return null;
  }

  // Check if tier supports backdrops
  if (!rpdbSupportsBackdrops(rpdbApiKey)) {
    return null;
  }

  return getRpdbBackdropUrl(rpdbApiKey, tmdbId, type);
}

export default useRpdbSettings;
