/**
 * useRpdbSettings - Hook for accessing RPDB (RatingPosterDB) settings
 *
 * Loads RPDB API key and settings from storage, provides helper functions
 * for generating RPDB image URLs.
 */

import {
  getRpdbPosterUrl,
  getRpdbBackdropUrl,
  rpdbSupportsBackdrops,
} from '../services/rpdb';
import { useSettingsStore } from '../stores/settingsStore';

interface RpdbSettings {
  apiKey: string | null;
  backdropsEnabled: boolean;
  loading: boolean;
}

/**
 * Load RPDB settings from the settings store (hydrated at boot and kept
 * current by the setters — no IPC read). `loading` is always false because
 * the store seeds synchronously.
 */
export function useRpdbSettings(): RpdbSettings {
  const apiKey = useSettingsStore((s) => s.posterDbApiKey) || null;
  const backdropsEnabled = useSettingsStore((s) => s.rpdbBackdropsEnabled);
  return { apiKey, backdropsEnabled, loading: false };
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
