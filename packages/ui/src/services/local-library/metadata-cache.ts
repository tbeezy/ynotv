/**
 * Metadata Cache for Local Library
 *
 * Caches TMDB cast credits, season episode lists, still photos, and overviews
 * in-memory and in localStorage so that network queries only run ONCE per show/movie/season.
 */

export interface CachedCastMember {
  id: number;
  name: string;
  character: string;
  profilePath: string | null;
}

export interface CachedSeasonEpisode {
  episode_number: number;
  name: string;
  overview: string;
  still_path: string | null;
  runtime?: number | null;
  vote_average?: number;
  air_date?: string;
}

const memoryCastCache = new Map<string, CachedCastMember[]>();
const memorySeasonCache = new Map<string, CachedSeasonEpisode[]>();

const CAST_STORAGE_PREFIX = 'ynotv.local.cache.cast.';
const SEASON_STORAGE_PREFIX = 'ynotv.local.cache.season.';

/**
 * Fetch and cache cast members for a movie or TV show.
 */
export async function getCachedCast(
  tmdbId: number,
  mediaType: 'movie' | 'tv',
  tmdbToken?: string | null,
): Promise<CachedCastMember[]> {
  if (!tmdbId) return [];

  const key = `${mediaType}_${tmdbId}`;

  // 1. Check memory cache
  if (memoryCastCache.has(key)) {
    return memoryCastCache.get(key)!;
  }

  // 2. Check localStorage
  try {
    const raw = localStorage.getItem(`${CAST_STORAGE_PREFIX}${key}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        memoryCastCache.set(key, parsed);
        return parsed;
      }
    }
  } catch {
    /* ignore storage errors */
  }

  if (!tmdbToken) return [];

  // 3. Fetch from TMDB API
  try {
    const isBearer = tmdbToken.length > 40 && tmdbToken.includes('.');
    const headers: Record<string, string> = isBearer
      ? { Authorization: `Bearer ${tmdbToken}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
    const url = isBearer
      ? `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/credits`
      : `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/credits?api_key=${tmdbToken}`;

    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data?.cast)) return [];

    const members: CachedCastMember[] = data.cast.slice(0, 20).map((c: any) => ({
      id: c.id,
      name: c.name,
      character: c.character || '',
      profilePath: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null,
    }));

    // Cache in memory and localStorage
    memoryCastCache.set(key, members);
    try {
      localStorage.setItem(`${CAST_STORAGE_PREFIX}${key}`, JSON.stringify(members));
    } catch {
      /* ignore storage quota errors */
    }

    return members;
  } catch (e) {
    console.warn('[MetadataCache] Failed to fetch cast:', e);
    return [];
  }
}

/**
 * Fetch and cache season episodes (titles, overviews, stills, runtime, ratings).
 */
export async function getCachedSeasonEpisodes(
  tmdbId: number,
  seasonNumber: number,
  tmdbToken?: string | null,
): Promise<CachedSeasonEpisode[]> {
  if (!tmdbId) return [];

  const key = `${tmdbId}_s${seasonNumber}`;

  // 1. Check memory cache
  if (memorySeasonCache.has(key)) {
    return memorySeasonCache.get(key)!;
  }

  // 2. Check localStorage
  try {
    const raw = localStorage.getItem(`${SEASON_STORAGE_PREFIX}${key}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        memorySeasonCache.set(key, parsed);
        return parsed;
      }
    }
  } catch {
    /* ignore storage errors */
  }

  if (!tmdbToken) return [];

  // 3. Fetch from TMDB API
  try {
    const isBearer = tmdbToken.length > 40 && tmdbToken.includes('.');
    const headers: Record<string, string> = isBearer
      ? { Authorization: `Bearer ${tmdbToken}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
    const url = isBearer
      ? `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}?language=en-US`
      : `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}?api_key=${tmdbToken}&language=en-US`;

    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data?.episodes)) return [];

    const episodes: CachedSeasonEpisode[] = data.episodes.map((ep: any) => ({
      episode_number: ep.episode_number,
      name: ep.name || '',
      overview: ep.overview || '',
      still_path: ep.still_path || null,
      runtime: ep.runtime || null,
      vote_average: ep.vote_average || 0,
      air_date: ep.air_date || undefined,
    }));

    // Cache in memory and localStorage
    memorySeasonCache.set(key, episodes);
    try {
      localStorage.setItem(`${SEASON_STORAGE_PREFIX}${key}`, JSON.stringify(episodes));
    } catch {
      /* ignore storage quota errors */
    }

    return episodes;
  } catch (e) {
    console.warn('[MetadataCache] Failed to fetch season episodes:', e);
    return [];
  }
}
