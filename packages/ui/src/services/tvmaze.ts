/**
 * TVMaze Service
 *
 * Free API for TV series metadata - no API key required.
 * Used as fallback when TMDB key is not available.
 *
 * API Documentation: https://www.tvmaze.com/api
 */

// TVMaze API base URL
const TVMAZE_API_BASE = 'https://api.tvmaze.com';

// ===========================================================================
// Type definitions
// ===========================================================================

export interface TvMazeShow {
  id: number;
  url: string;
  name: string;
  type: string;
  language: string | null;
  genres: string[];
  status: string;
  runtime: number | null;
  averageRuntime: number | null;
  premiered: string | null;
  ended: string | null;
  officialSite: string | null;
  schedule: {
    time: string;
    days: string[];
  };
  rating: {
    average: number | null;
  };
  weight: number;
  network: {
    id: number;
    name: string;
    country: {
      name: string;
      code: string;
      timezone: string;
    } | null;
    officialSite: string | null;
  } | null;
  webChannel: {
    id: number;
    name: string;
    country: {
      name: string;
      code: string;
      timezone: string;
    } | null;
    officialSite: string | null;
  } | null;
  dvdCountry: string | null;
  externals: {
    tvrage: number | null;
    thetvdb: number | null;
    imdb: string | null;
  };
  image: {
    medium: string | null;
    original: string | null;
  } | null;
  summary: string | null;
  updated: number;
  links: {
    self: {
      href: string;
    };
    previousepisode?: {
      href: string;
    };
    nextepisode?: {
      href: string;
    };
  };
  // Embedded data when requested with embed parameter
  _embedded?: {
    cast?: TvMazeCastMember[];
    episodes?: TvMazeEpisode[];
  };
}

export interface TvMazeSearchResult {
  score: number;
  show: TvMazeShow;
}

export interface TvMazeCastMember {
  person: {
    id: number;
    url: string;
    name: string;
    country: {
      name: string;
      code: string;
      timezone: string;
    } | null;
    birthday: string | null;
    deathday: string | null;
    gender: string | null;
    image: {
      medium: string | null;
      original: string | null;
    } | null;
    updated: number;
    links: {
      self: {
        href: string;
      };
    };
  };
  character: {
    id: number;
    url: string;
    name: string;
    image: {
      medium: string | null;
      original: string | null;
    } | null;
    links: {
      self: {
        href: string;
      };
    };
  };
  self: boolean;
  voice: boolean;
}

export interface TvMazeEpisode {
  id: number;
  url: string;
  name: string;
  season: number;
  number: number;
  type: string;
  airdate: string | null;
  airtime: string;
  airstamp: string | null;
  runtime: number | null;
  rating: {
    average: number | null;
  };
  image: {
    medium: string | null;
    original: string | null;
  } | null;
  summary: string | null;
  links: {
    self: {
      href: string;
    };
  };
}

// ===========================================================================
// Memory cache for API responses
// ===========================================================================

const apiCache = new Map<string, { data: any; timestamp: number }>();
const API_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function withApiCache<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const cached = apiCache.get(key);
  if (cached && Date.now() - cached.timestamp < API_CACHE_TTL) {
    return cached.data as T;
  }
  const data = await fetcher();
  apiCache.set(key, { data, timestamp: Date.now() });
  return data;
}

// ===========================================================================
// Search endpoints
// ===========================================================================

/**
 * Search for TV shows by name
 * Returns array of search results with relevance scores
 */
export async function searchTvShows(query: string): Promise<TvMazeSearchResult[]> {
  if (!query.trim()) return [];

  const encodedQuery = encodeURIComponent(query.trim());
  const url = `${TVMAZE_API_BASE}/search/shows?q=${encodedQuery}`;

  return withApiCache(`search_${encodedQuery}`, async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`TVMaze search failed: ${response.status}`);
    }
    return response.json() as Promise<TvMazeSearchResult[]>;
  });
}

/**
 * Search for a single TV show by name
 * Returns the best match or null if no results
 */
export async function searchSingleShow(query: string): Promise<TvMazeShow | null> {
  if (!query.trim()) return null;

  const encodedQuery = encodeURIComponent(query.trim());
  const url = `${TVMAZE_API_BASE}/singlesearch/shows?q=${encodedQuery}`;

  return withApiCache(`single_search_${encodedQuery}`, async () => {
    const response = await fetch(url);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`TVMaze single search failed: ${response.status}`);
    }
    return response.json() as Promise<TvMazeShow>;
  }).catch(() => null);
}

/**
 * Search for shows with embedded episodes
 */
export async function searchShowsWithEpisodes(query: string): Promise<TvMazeSearchResult[]> {
  if (!query.trim()) return [];

  const encodedQuery = encodeURIComponent(query.trim());
  const url = `${TVMAZE_API_BASE}/search/shows?q=${encodedQuery}&embed=episodes`;

  return withApiCache(`search_episodes_${encodedQuery}`, async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`TVMaze search failed: ${response.status}`);
    }
    return response.json() as Promise<TvMazeSearchResult[]>;
  });
}

// ===========================================================================
// Show details endpoints
// ===========================================================================

/**
 * Get show details by TVMaze ID
 */
export async function getShowDetails(showId: number): Promise<TvMazeShow | null> {
  const url = `${TVMAZE_API_BASE}/shows/${showId}`;

  return withApiCache(`show_${showId}`, async () => {
    const response = await fetch(url);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`TVMaze show details failed: ${response.status}`);
    }
    return response.json() as Promise<TvMazeShow>;
  }).catch(() => null);
}

/**
 * Get show cast by TVMaze show ID
 */
export async function getShowCast(showId: number): Promise<TvMazeCastMember[]> {
  const url = `${TVMAZE_API_BASE}/shows/${showId}/cast`;

  return withApiCache(`cast_${showId}`, async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`TVMaze cast fetch failed: ${response.status}`);
    }
    return response.json() as Promise<TvMazeCastMember[]>;
  }).catch(() => []);
}

/**
 * Get show episodes by TVMaze show ID
 */
export async function getShowEpisodes(showId: number): Promise<TvMazeEpisode[]> {
  const url = `${TVMAZE_API_BASE}/shows/${showId}/episodes`;

  return withApiCache(`episodes_${showId}`, async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`TVMaze episodes fetch failed: ${response.status}`);
    }
    return response.json() as Promise<TvMazeEpisode[]>;
  }).catch(() => []);
}

/**
 * Get show by IMDB ID
 */
export async function getShowByImdbId(imdbId: string): Promise<TvMazeShow | null> {
  const url = `${TVMAZE_API_BASE}/lookup/shows?imdb=${imdbId}`;

  return withApiCache(`imdb_${imdbId}`, async () => {
    const response = await fetch(url);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`TVMaze IMDB lookup failed: ${response.status}`);
    }
    return response.json() as Promise<TvMazeShow>;
  }).catch(() => null);
}

/**
 * Get show by TVDB ID
 */
export async function getShowByTvdbId(tvdbId: number): Promise<TvMazeShow | null> {
  const url = `${TVMAZE_API_BASE}/lookup/shows?thetvdb=${tvdbId}`;

  return withApiCache(`tvdb_${tvdbId}`, async () => {
    const response = await fetch(url);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`TVMaze TVDB lookup failed: ${response.status}`);
    }
    return response.json() as Promise<TvMazeShow>;
  }).catch(() => null);
}

// ===========================================================================
// Image helpers
// ===========================================================================

/**
 * Get the best available image URL for a show
 * Returns null if no images available
 */
export function getShowImageUrl(show: TvMazeShow, size: 'medium' | 'original' = 'original'): string | null {
  if (!show.image) return null;
  return show.image[size] || show.image.original || show.image.medium || null;
}

/**
 * Get backdrop/banner image URL for a show
 * TVMaze uses 'original' size for best quality
 */
export function getShowBackdropUrl(show: TvMazeShow): string | null {
  return getShowImageUrl(show, 'original');
}

/**
 * Get poster image URL for a show
 */
export function getShowPosterUrl(show: TvMazeShow): string | null {
  return getShowImageUrl(show, 'original');
}

// ===========================================================================
// Cast helpers
// ===========================================================================

/**
 * Get top cast members as a comma-separated string
 * Useful for displaying in UI
 */
export function getTopCastString(cast: TvMazeCastMember[], limit: number = 5): string {
  return cast
    .slice(0, limit)
    .map((member) => member.person.name)
    .join(', ');
}

/**
 * Get main cast as character mapping
 */
export function getCastWithCharacters(cast: TvMazeCastMember[], limit: number = 5): Array<{ actor: string; character: string }> {
  return cast
    .slice(0, limit)
    .map((member) => ({
      actor: member.person.name,
      character: member.character.name,
    }));
}

// ===========================================================================
// Genre helpers
// ===========================================================================

/**
 * Get genres as a comma-separated string
 */
export function getGenresString(show: TvMazeShow): string | null {
  if (!show.genres || show.genres.length === 0) return null;
  return show.genres.join(', ');
}

// ===========================================================================
// Search with fallback - Main entry point for metadata fetching
// ===========================================================================

export interface TvMazeMetadataResult {
  found: boolean;
  showId: number | null;
  title: string | null;
  overview: string | null;
  genres: string | null;
  backdropUrl: string | null;
  posterUrl: string | null;
  rating: number | null;
  year: number | null;
  status: string | null;
  cast: string | null;
  imdbId: string | null;
  tvdbId: number | null;
}

/**
 * Main entry point: Search for a TV show and get all metadata
 * Returns comprehensive metadata in a single call
 */
export async function getTvShowMetadata(query: string): Promise<TvMazeMetadataResult> {
  // First try single search for exact match
  const show = await searchSingleShow(query);

  if (!show) {
    // Fall back to regular search and take best result
    const results = await searchTvShows(query);
    if (results.length === 0) {
      return {
        found: false,
        showId: null,
        title: null,
        overview: null,
        genres: null,
        backdropUrl: null,
        posterUrl: null,
        rating: null,
        year: null,
        status: null,
        cast: null,
        imdbId: null,
        tvdbId: null,
      };
    }
    // Use best match (highest score)
    const bestMatch = results.sort((a, b) => b.score - a.score)[0].show;
    return extractMetadata(bestMatch);
  }

  return extractMetadata(show);
}

/**
 * Extract all relevant metadata from a TVMaze show
 */
function extractMetadata(show: TvMazeShow): TvMazeMetadataResult {
  // Extract year from premiered date
  const year = show.premiered ? parseInt(show.premiered.split('-')[0]) : null;

  // Get cast if available
  const cast = show._embedded?.cast ? getTopCastString(show._embedded.cast) : null;

  return {
    found: true,
    showId: show.id,
    title: show.name,
    overview: show.summary ? stripHtmlTags(show.summary) : null,
    genres: getGenresString(show),
    backdropUrl: getShowBackdropUrl(show),
    posterUrl: getShowPosterUrl(show),
    rating: show.rating?.average,
    year,
    status: show.status,
    cast,
    imdbId: show.externals?.imdb || null,
    tvdbId: show.externals?.thetvdb || null,
  };
}

/**
 * Get full metadata with cast (requires additional API call)
 */
export async function getTvShowMetadataWithCast(query: string): Promise<TvMazeMetadataResult> {
  const metadata = await getTvShowMetadata(query);

  if (!metadata.found || !metadata.showId) {
    return metadata;
  }

  // Fetch cast separately
  const cast = await getShowCast(metadata.showId);
  if (cast.length > 0) {
    metadata.cast = getTopCastString(cast);
  }

  return metadata;
}

// ===========================================================================
// Utility functions
// ===========================================================================

/**
 * Strip HTML tags from summary text
 */
function stripHtmlTags(html: string): string {
  if (!html) return '';
  // Remove HTML tags
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * Clear the API cache
 * Useful for testing or when memory needs to be freed
 */
export function clearCache(): void {
  apiCache.clear();
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { size: number; keys: string[] } {
  return {
    size: apiCache.size,
    keys: Array.from(apiCache.keys()),
  };
}
