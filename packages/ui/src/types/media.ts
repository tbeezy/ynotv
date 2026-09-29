/**
 * Shared media types and type guards for VOD content.
 *
 * Consolidates the MediaItem union and type guards that were previously
 * duplicated across VodPage, GenreCarousel, and the lazy loading hooks.
 */

import type { StoredMovie, StoredSeries } from '../db';

/**
 * One entry of the Jellyfin web client's own play queue (playlist, album, or a
 * "play next" queue) as captured by the embedded-page bridge. `id` is the
 * dash-stripped Jellyfin item id, which is what direct-play URLs are built
 * from; the rest is best-effort display metadata.
 */
export interface JellyfinQueueItem {
  id: string;
  rawId?: string;
  playlistItemId?: string;
  name?: string;
  /** Jellyfin item Type: 'Episode', 'Movie', 'Audio', ... */
  type?: string;
  mediaType?: string;
  seriesId?: string;
  seriesName?: string;
  indexNumber?: number | null;
  parentIndexNumber?: number | null;
  runTimeTicks?: number | null;
}

/** Union type for movie or series items */
export type MediaItem = StoredMovie | StoredSeries;

/** VOD content type discriminator */
export type VodType = 'movie' | 'series';

/**
 * Type guard to check if a media item is a movie.
 * Uses structural check: movies have stream_id, series have series_id.
 */
export function isMovie(item: MediaItem): item is StoredMovie {
  return 'stream_id' in item && !('series_id' in item);
}

/**
 * Type guard to check if a media item is a series.
 */
export function isSeries(item: MediaItem): item is StoredSeries {
  return 'series_id' in item;
}

/**
 * Get the unique identifier for a media item.
 */
export function getMediaId(item: MediaItem): string {
  return isMovie(item) ? item.stream_id : item.series_id;
}

/**
 * VOD playback info passed to the NowPlayingBar.
 * Provides structured data for display instead of a raw title string.
 */
export interface VodPlayInfo {
  url: string;
  title: string;          // Clean title (without year)
  year?: string;          // Release year
  plot?: string;          // Description/overview
  type: 'movie' | 'series' | 'recording';
  episodeInfo?: string;   // For series: "S1 E3" or "S1 E3 · Episode Title"
  source_id?: string;
  mediaId?: string;       // Unique media ID (stream_id for movies, series_id for series) for tracking
  // Series episode navigation fields
  seriesId?: string;      // Series ID for episode navigation
  seasonNum?: number;     // Current season number
  episodeNum?: number;    // Current episode number
  episodeId?: string;     // Current episode ID
  recordingStart?: number; // Unix timestamp in seconds of when recording actually started
  recordingStatus?: string; // e.g. 'recording' or 'completed'
  recordingId?: number;     // DVR recording database ID
  posterUrl?: string;     // Movie/series poster image URL
  backdropUrl?: string;   // Backdrop/banner image URL from details page
  logoUrl?: string;       // Movie/series name picture/logo URL from details page
  addonName?: string;     // Current stream addon name (Stremio/Nuvio source)
  stremioType?: string;   // 'movie' or 'series' for Stremio/Nuvio stream lookup
  stremioId?: string;     // Meta ID (movie) or episode ID (series) for stream lookup
  tmdbId?: number | string; // TMDB ID if available
  imdbId?: string;        // IMDb ID if available
  preferredMode?: 'embedded' | 'popout' | 'external'; // Optional target player mode override
  // Jellyfin playback metadata used to load its external subtitle streams.
  jellyfinServerUrl?: string;
  jellyfinApiKey?: string;
  jellyfinItemId?: string;
  jellyfinMediaSourceId?: string;
  jellyfinSubtitleStreamId?: number;
  jellyfinSubtitleTracks?: Array<{
    index: number;
    title?: string;
    lang?: string;
    codec?: string;
    isExternal: boolean;
    deliveryUrl?: string;
    selected?: boolean;
    default?: boolean;
  }>;
  // Audio stream list from the Jellyfin PlaybackInfo response (jellyfin-desktop style).
  jellyfinAudioTracks?: Array<{
    index: number;
    title?: string;
    lang?: string;
    codec?: string;
    isDefault?: boolean;
  }>;
  jellyfinAudioStreamId?: number;
  // Chapter markers from the Jellyfin item DTO (Fields=Chapters), rendered as
  // ticks on the seek bar. startPositionTicks are 100ns units (div by 1e7 = secs).
  jellyfinChapters?: Array<{
    startPositionTicks?: number;
    name?: string;
  }>;
  // Jellyfin series/episode context (header pill S/E info + prev/next episode
  // navigation). Episodes are the compact list captured from the series page;
  // the frontend rebuilds direct-play URLs for adjacent episodes.
  jellyfinSeriesId?: string;
  jellyfinSeriesName?: string;
  jellyfinEpisodeIndexNumber?: number;
  jellyfinEpisodeParentIndexNumber?: number;
  jellyfinEpisodes?: Array<{
    id: string;
    rawId?: string;
    indexNumber?: number | null;
    parentIndexNumber?: number | null;
    name?: string;
    positionTicks?: number;
    overview?: string;
    communityRating?: number | null;
    premiereDate?: string;
  }>;
  // Remembered subtitle stream index per Jellyfin item id (captured from the
  // web client), so prev/next episodes start with the user's subtitle.
  jellyfinSubtitlePrefs?: Record<string, number>;
  // Current Jellyfin user id (from the bridge), used to resolve item details
  // for queue entries the page never opened.
  jellyfinUserId?: string;
  // The web client's own play queue at handoff. When present, the player's
  // prev/next and auto-play follow THIS order (a playlist can mix series,
  // movies and episodes) instead of the series' episode list above.
  jellyfinQueue?: JellyfinQueueItem[];
  jellyfinQueueIndex?: number;
  // Name of the playlist the queue came from, when the page loaded it.
  jellyfinQueueName?: string;
}
