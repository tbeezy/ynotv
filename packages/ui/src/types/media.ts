/**
 * Shared media types and type guards for VOD content.
 *
 * Consolidates the MediaItem union and type guards that were previously
 * duplicated across VodPage, GenreCarousel, and the lazy loading hooks.
 */

import type { StoredMovie, StoredSeries } from '../db';

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
}
