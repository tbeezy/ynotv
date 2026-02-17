/**
 * RPDB Service (Rating Poster Database)
 *
 * Provides movie/series posters with rating overlays from IMDB, Rotten Tomatoes, etc.
 * Users configure their poster preferences at https://manager.ratingposterdb.com/
 *
 * API Documentation: https://ratingposterdb.com/api-doc/
 *
 * Tier limits:
 * - Tier 1 (t1-): 50,000 requests/month, posters only
 * - Tier 2 (t2-): 100,000 requests/month, posters + backdrops
 * - Tier 3 (t3-): 150,000 requests/month, posters + backdrops
 * - Tier 4 (t4-): 750,000 requests/month, posters + backdrops
 */

// RPDB API base URL
export const RPDB_API_BASE = 'https://api.ratingposterdb.com';

/**
 * Get the tier of an API key from its prefix
 * Tier 1: t1-..., Tier 2: t2-..., etc.
 */
export function getRpdbTier(apiKey: string): number | null {
  if (!apiKey || apiKey.length < 3) return null;

  const prefix = apiKey.substring(0, 2);
  const tierMatch = prefix.match(/^t(\d)$/);

  if (tierMatch) {
    return parseInt(tierMatch[1], 10);
  }

  return null;
}

/**
 * Check if an API key supports backdrops (tier 2+)
 */
export function rpdbSupportsBackdrops(apiKey: string): boolean {
  const tier = getRpdbTier(apiKey);
  return tier !== null && tier >= 2;
}

/**
 * Validate an RPDB API key
 * @returns true if valid, false otherwise
 */
export async function validateRpdbApiKey(apiKey: string): Promise<boolean> {
  if (!apiKey) return false;

  try {
    const response = await fetch(`${RPDB_API_BASE}/${apiKey}/isValid`);

    if (response.status === 200) {
      const data = await response.json();
      return data.valid === true;
    }

    return false;
  } catch (err) {
    console.warn('[RPDB] API key validation failed:', err);
    return false;
  }
}

/**
 * Get RPDB request count and limit for an API key
 * Useful for showing users their usage
 */
export async function getRpdbRequestCount(
  apiKey: string
): Promise<{ current: number; limit: number } | null> {
  if (!apiKey) return null;

  try {
    const response = await fetch(`${RPDB_API_BASE}/${apiKey}/requests`);

    if (response.ok) {
      const data = await response.json();
      return {
        current: data.req ?? 0,
        limit: data.limit ?? 0,
      };
    }

    return null;
  } catch (err) {
    console.warn('[RPDB] Failed to get request count:', err);
    return null;
  }
}

/**
 * Build RPDB poster URL for a movie or series
 *
 * Uses TMDB ID format: movie-{id} or series-{id}
 *
 * @param apiKey - User's RPDB API key
 * @param tmdbId - TMDB ID of the movie or series
 * @param type - 'movie' or 'series'
 * @returns Full poster URL
 */
export function getRpdbPosterUrl(
  apiKey: string,
  tmdbId: number,
  type: 'movie' | 'series'
): string {
  const mediaId = `${type === 'movie' ? 'movie' : 'series'}-${tmdbId}`;
  return `${RPDB_API_BASE}/${apiKey}/tmdb/poster-default/${mediaId}.jpg`;
}

/**
 * Build RPDB backdrop URL for a movie or series
 *
 * NOTE: Backdrops require Tier 2+ API key
 *
 * @param apiKey - User's RPDB API key (must be tier 2+)
 * @param tmdbId - TMDB ID of the movie or series
 * @param type - 'movie' or 'series'
 * @returns Full backdrop URL, or null if tier doesn't support backdrops
 */
export function getRpdbBackdropUrl(
  apiKey: string,
  tmdbId: number,
  type: 'movie' | 'series'
): string | null {
  if (!rpdbSupportsBackdrops(apiKey)) {
    return null;
  }

  const mediaId = `${type === 'movie' ? 'movie' : 'series'}-${tmdbId}`;
  return `${RPDB_API_BASE}/${apiKey}/tmdb/backdrop-default/${mediaId}.jpg`;
}

/**
 * Build RPDB logo URL for a movie or series
 *
 * @param apiKey - User's RPDB API key
 * @param tmdbId - TMDB ID of the movie or series
 * @param type - 'movie' or 'series'
 * @returns Full logo URL (PNG)
 */
export function getRpdbLogoUrl(
  apiKey: string,
  tmdbId: number,
  type: 'movie' | 'series'
): string {
  const mediaId = `${type === 'movie' ? 'movie' : 'series'}-${tmdbId}`;
  return `${RPDB_API_BASE}/${apiKey}/tmdb/logo-default/${mediaId}.png`;
}
