/**
 * Optimized Bulk Sync Operations API
 *
 * This module provides high-performance bulk insert/update/delete operations
 * that bypass the slow individual row-by-row IPC calls.
 *
 * Performance improvement: ~10-100x faster for large datasets
 *
 * @example
 * // Before: ~5000ms for 1000 channels (individual IPC calls)
 * await db.channels.bulkPut(channels)
 * 
 * // After: ~50ms for 1000 channels (single IPC call)
 * await bulkOps.upsertChannels(channels)
 */

import { invoke } from '@tauri-apps/api/core';
import { dbEvents } from '../db/sqlite-adapter';

// Health check - verifies backend bulk operations are ready
export async function healthCheck(): Promise<boolean> {
  try {
    await invoke('health_check');
    return true;
  } catch (e) {
    console.error('[BulkOps] Health check failed:', e);
    return false;
  }
}

// Type definitions matching Rust structures
export interface BulkChannel {
  stream_id: string;
  source_id: string;
  category_ids?: string; // JSON array as string
  name: string;
  channel_num?: number;
  is_favorite?: boolean;
  enabled?: boolean;
  stream_type?: string;
  stream_icon?: string;
  epg_channel_id?: string;
  added?: string;
  custom_sid?: string;
  tv_archive?: number;
  direct_source?: string;
  direct_url?: string;
  xmltv_id?: string;
  series_no?: number;
  live?: number;
}

export interface BulkCategory {
  category_id: string;
  source_id: string;
  category_name: string;
  parent_id?: number;
  enabled?: boolean;
  display_order?: number;
  channel_count?: number;
  filter_words?: string; // JSON array as string
}

export interface BulkProgram {
  id: string;
  stream_id: string;
  title: string;
  description?: string;
  start: string; // ISO 8601 datetime
  end: string;
  source_id: string;
}

export interface BulkMovie {
  stream_id: string;
  source_id: string;
  category_ids?: string;
  name: string;
  tmdb_id?: number;
  imdb_id?: string;
  added?: string;
  backdrop_path?: string;
  popularity?: number;
  match_attempted?: string;
  container_extension?: string;
  rating?: string;
  director?: string;
  year?: number;
  cast?: string;
  plot?: string;
  genre?: string;
  duration_secs?: number;
  duration?: string;
  stream_icon?: string;
  direct_url?: string;
  release_date?: string;
  title?: string;
}

export interface BulkSeries {
  series_id: string;
  source_id: string;
  category_ids?: string;
  name: string;
  tmdb_id?: number;
  imdb_id?: string;
  added?: string;
  backdrop_path?: string;
  popularity?: number;
  match_attempted?: string;
  _stalker_category?: string;
  cover?: string;
  plot?: string;
  cast?: string;
  director?: string;
  genre?: string;
  release_date?: string;
  rating?: string;
  youtube_trailer?: string;
  episode_run_time?: string;
  title?: string;
  last_modified?: string;
  year?: string;
  stream_type?: string;
  stream_icon?: string;
  direct_url?: string;
  rating_5based?: number;
  category_id?: string;
  _stalker_raw_id?: string;
}

export interface BulkResult {
  inserted: number;
  updated: number;
  deleted: number;
  duration_ms: number;
}

export interface SourceMetaUpdate {
  source_id: string;
  epg_url?: string;
  last_synced?: string;
  vod_last_synced?: string;
  channel_count?: number;
  category_count?: number;
  vod_movie_count?: number;
  vod_series_count?: number;
  expiry_date?: string;
  active_cons?: string;
  max_connections?: string;
  error?: string;
}

// ============================================================================
// Optimized Bulk Operations
// ============================================================================

/**
 * Upsert channels in bulk
 * Uses a single IPC call for all channels
 */
export async function upsertChannels(channels: BulkChannel[]): Promise<BulkResult> {
  if (channels.length === 0) {
    return { inserted: 0, updated: 0, deleted: 0, duration_ms: 0 };
  }

  const timerName = `bulk-upsert-channels-${Date.now()}`;
  console.time(timerName);

  try {
    // Serialize category_ids arrays to JSON strings
    const serializedChannels = channels.map(ch => ({
      ...ch,
      category_ids: Array.isArray(ch.category_ids)
        ? JSON.stringify(ch.category_ids)
        : ch.category_ids,
      // Ensure boolean fields are sent as booleans
      is_favorite: ch.is_favorite ?? false,
      enabled: ch.enabled ?? true,
    }));

    const result = await invoke<BulkResult>('bulk_upsert_channels', {
      channels: serializedChannels
    });

    console.timeEnd(timerName);
    console.log(`[BulkOps] Channels: ${result.inserted} inserted, ${result.updated} updated in ${result.duration_ms}ms`);

    // Notify UI of changes
    if (result.inserted > 0) {
      dbEvents.notify('channels', 'add');
    }
    if (result.updated > 0) {
      dbEvents.notify('channels', 'update');
    }

    return result;
  } catch (error) {
    console.timeEnd(timerName);
    console.error('[BulkOps] upsertChannels failed:', error);
    throw error;
  }
}

/**
 * Upsert categories in bulk
 */
export async function upsertCategories(categories: BulkCategory[]): Promise<BulkResult> {
  if (categories.length === 0) {
    return { inserted: 0, updated: 0, deleted: 0, duration_ms: 0 };
  }

  const timerName = `bulk-upsert-categories-${Date.now()}`;
  console.time(timerName);

  try {
    const serializedCategories = categories.map(cat => ({
      ...cat,
      filter_words: Array.isArray(cat.filter_words)
        ? JSON.stringify(cat.filter_words)
        : cat.filter_words,
    }));

    const result = await invoke<BulkResult>('bulk_upsert_categories', {
      categories: serializedCategories
    });

    console.timeEnd(timerName);
    console.log(`[BulkOps] Categories: ${result.inserted} inserted, ${result.updated} updated in ${result.duration_ms}ms`);

    // Notify UI of changes
    if (result.inserted > 0) {
      dbEvents.notify('categories', 'add');
    }
    if (result.updated > 0) {
      dbEvents.notify('categories', 'update');
    }

    return result;
  } catch (error) {
    console.timeEnd(timerName);
    console.error('[BulkOps] upsertCategories failed:', error);
    throw error;
  }
}

/**
 * Replace all EPG programs for a source
 * Deletes existing programs and inserts new ones in a single transaction
 */
export async function replacePrograms(
  sourceId: string,
  programs: BulkProgram[]
): Promise<BulkResult> {
  if (programs.length === 0) {
    return { inserted: 0, updated: 0, deleted: 0, duration_ms: 0 };
  }

  const timerName = `bulk-replace-programs-${Date.now()}`;
  console.time(timerName);

  try {
    const result = await invoke<BulkResult>('bulk_replace_programs', {
      sourceId,
      programs
    });

    console.timeEnd(timerName);
    console.log(`[BulkOps] Programs: ${result.deleted} deleted, ${result.inserted} inserted in ${result.duration_ms}ms`);

    // Notify UI of changes
    dbEvents.notify('programs', 'clear');
    if (result.inserted > 0) {
      dbEvents.notify('programs', 'add');
    }

    return result;
  } catch (error) {
    console.timeEnd(timerName);
    console.error('[BulkOps] replacePrograms failed:', error);
    throw error;
  }
}

/**
 * Upsert VOD movies in bulk
 */
export async function upsertMovies(movies: BulkMovie[]): Promise<BulkResult> {
  if (movies.length === 0) {
    return { inserted: 0, updated: 0, deleted: 0, duration_ms: 0 };
  }

  const timerName = `bulk-upsert-movies-${Date.now()}`;
  console.time(timerName);

  try {
    const serializedMovies = movies.map(movie => ({
      ...movie,
      category_ids: Array.isArray(movie.category_ids)
        ? JSON.stringify(movie.category_ids)
        : movie.category_ids,
    }));

    const result = await invoke<BulkResult>('bulk_upsert_movies', {
      movies: serializedMovies
    });

    console.timeEnd(timerName);
    console.log(`[BulkOps] Movies: ${result.inserted} inserted, ${result.updated} updated in ${result.duration_ms}ms`);

    // Notify UI of changes
    if (result.inserted > 0) {
      dbEvents.notify('vodMovies', 'add');
    }
    if (result.updated > 0) {
      dbEvents.notify('vodMovies', 'update');
    }

    return result;
  } catch (error) {
    console.timeEnd(timerName);
    console.error('[BulkOps] upsertMovies failed:', error);
    throw error;
  }
}

/**
 * Upsert VOD series in bulk
 */
export async function upsertSeries(series: BulkSeries[]): Promise<BulkResult> {
  if (series.length === 0) {
    return { inserted: 0, updated: 0, deleted: 0, duration_ms: 0 };
  }

  const timerName = `bulk-upsert-series-${Date.now()}`;
  console.time(timerName);

  try {
    const serializedSeries = series.map(s => ({
      ...s,
      category_ids: Array.isArray(s.category_ids)
        ? JSON.stringify(s.category_ids)
        : s.category_ids,
    }));

    const result = await invoke<BulkResult>('bulk_upsert_series', {
      series: serializedSeries
    });

    console.timeEnd(timerName);
    console.log(`[BulkOps] Series: ${result.inserted} inserted, ${result.updated} updated in ${result.duration_ms}ms`);

    // Notify UI of changes
    if (result.inserted > 0) {
      dbEvents.notify('vodSeries', 'add');
    }
    if (result.updated > 0) {
      dbEvents.notify('vodSeries', 'update');
    }

    return result;
  } catch (error) {
    console.timeEnd(timerName);
    console.error('[BulkOps] upsertSeries failed:', error);
    throw error;
  }
}

/**
 * Delete channels by stream_id
 */
export async function deleteChannels(streamIds: string[]): Promise<number> {
  if (streamIds.length === 0) return 0;

  const deleted = await invoke<number>('bulk_delete_channels', { streamIds });
  console.log(`[BulkOps] Deleted ${deleted} channels`);

  // Notify UI of changes
  if (deleted > 0) {
    dbEvents.notify('channels', 'delete');
  }

  return deleted;
}

/**
 * Delete categories by category_id
 */
export async function deleteCategories(categoryIds: string[]): Promise<number> {
  if (categoryIds.length === 0) return 0;

  const deleted = await invoke<number>('bulk_delete_categories', { categoryIds });
  console.log(`[BulkOps] Deleted ${deleted} categories`);

  // Notify UI of changes
  if (deleted > 0) {
    dbEvents.notify('categories', 'delete');
  }

  return deleted;
}

/**
 * Update source metadata
 * Uses COALESCE on the Rust side to preserve existing values when fields are null
 */
export async function updateSourceMeta(meta: SourceMetaUpdate): Promise<void> {
  await invoke('update_source_meta', { meta });
}

// ============================================================================
// High-Level Sync Helpers
// ============================================================================

export interface SyncChanges {
  channelsToAdd: BulkChannel[];
  channelsToUpdate: BulkChannel[];
  channelsToDelete: string[];
  categoriesToAdd: BulkCategory[];
  categoriesToUpdate: BulkCategory[];
  categoriesToDelete: string[];
}

/**
 * Apply all sync changes in an optimized batch
 * This replaces the multiple individual bulkPut/bulkDelete calls
 */
export async function applySyncChanges(
  sourceId: string,
  changes: SyncChanges,
  sourceMeta?: SourceMetaUpdate
): Promise<void> {
  console.time('apply-sync-changes');

  // Combine add and update operations (upsert handles both)
  const allChannels = [
    ...changes.channelsToAdd,
    ...changes.channelsToUpdate
  ];

  const allCategories = [
    ...changes.categoriesToAdd,
    ...changes.categoriesToUpdate
  ];

  // Execute all operations
  const promises: Promise<any>[] = [];

  if (allChannels.length > 0) {
    promises.push(upsertChannels(allChannels));
  }

  if (allCategories.length > 0) {
    promises.push(upsertCategories(allCategories));
  }

  if (changes.channelsToDelete.length > 0) {
    promises.push(deleteChannels(changes.channelsToDelete));
  }

  if (changes.categoriesToDelete.length > 0) {
    promises.push(deleteCategories(changes.categoriesToDelete));
  }

  if (sourceMeta) {
    promises.push(updateSourceMeta(sourceMeta));
  }

  await Promise.all(promises);

  console.timeEnd('apply-sync-changes');
}

// ============================================================================
// Performance Monitoring
// ============================================================================

interface PerformanceStats {
  operation: string;
  count: number;
  durationMs: number;
  rowsPerSecond: number;
}

export function logPerformance(stats: PerformanceStats): void {
  console.log(
    `[BulkOps Performance] ${stats.operation}: ` +
    `${stats.count} rows in ${stats.durationMs}ms ` +
    `(${Math.round(stats.rowsPerSecond)} rows/sec)`
  );
}

// Export all functions as a namespace
export const bulkOps = {
  upsertChannels,
  upsertCategories,
  replacePrograms,
  upsertMovies,
  upsertSeries,
  deleteChannels,
  deleteCategories,
  updateSourceMeta,
  applySyncChanges,
  logPerformance,
  healthCheck,
};

export default bulkOps;
