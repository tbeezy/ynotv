import Dexie, { type Table } from 'dexie';
import type { Channel, Category, Movie, Series, Episode } from '@sbtltv/core';

// Extended channel with local metadata
export interface StoredChannel extends Channel {
  name: string;
  channel_num?: number;
  is_favorite?: boolean;    // For favorites feature
  // For quick lookups
  source_category_key?: string; // `${source_id}_${category_id}` for compound index
}

// Extended category with channel count
export interface StoredCategory extends Category {
  source_id: string;
  category_name: string;
  channel_count?: number;
  enabled?: boolean;        // For hiding/showing categories
  display_order?: number;   // For manual ordering
}

// Source sync metadata
export interface SourceMeta {
  source_id: string;
  epg_url?: string;
  last_synced?: Date;
  vod_last_synced?: Date;
  channel_count: number;
  category_count: number;
  vod_movie_count?: number;
  vod_series_count?: number;
  expiry_date?: string;         // Account expiry date (Stalker & Xtream)
  active_cons?: string;          // Active connections (Xtream only)
  max_connections?: string;      // Max connections (Xtream only)
  error?: string;
}

// VOD Movie with TMDB enrichment
export interface StoredMovie extends Movie {
  tmdb_id?: number;
  imdb_id?: string;
  added?: Date;
  backdrop_path?: string;
  popularity?: number;
  match_attempted?: Date; // When TMDB matching was last attempted (even if no match found)
}

// VOD Series with TMDB enrichment
export interface StoredSeries extends Series {
  tmdb_id?: number;
  imdb_id?: string;
  added?: Date;
  backdrop_path?: string;
  popularity?: number;
  match_attempted?: Date; // When TMDB matching was last attempted (even if no match found)
  _stalker_category?: string; // Stalker: store parent category for episode fetching
}

// VOD Episode
export interface StoredEpisode extends Episode {
  series_id: string;
}

// VOD Category (movies or series)
export interface VodCategory {
  category_id: string;
  source_id: string;
  name: string;
  type: 'movie' | 'series';
}

// User preferences (last selected category, etc.)
export interface UserPrefs {
  key: string;
  value: string;
}

// EPG program entry
export interface StoredProgram {
  id: string; // `${stream_id}_${start}` compound key
  stream_id: string;
  title: string;
  description: string;
  start: Date;
  end: Date;
  source_id: string;
}

class SbtltvDatabase extends Dexie {
  channels!: Table<StoredChannel, string>;
  categories!: Table<StoredCategory, string>;
  sourcesMeta!: Table<SourceMeta, string>;
  prefs!: Table<UserPrefs, string>;
  programs!: Table<StoredProgram, string>;
  vodMovies!: Table<StoredMovie, string>;
  vodSeries!: Table<StoredSeries, string>;
  vodEpisodes!: Table<StoredEpisode, string>;
  vodCategories!: Table<VodCategory, string>;

  constructor() {
    super('sbtltv');

    this.version(1).stores({
      // Primary key is stream_id, indexed by source_id and category_ids
      channels: 'stream_id, source_id, *category_ids, name',
      // Primary key is category_id, indexed by source_id
      categories: 'category_id, source_id, category_name',
      // Source sync metadata
      sourcesMeta: 'source_id',
      // Simple key-value for user preferences
      prefs: 'key',
    });

    // Add EPG programs table
    this.version(2).stores({
      channels: 'stream_id, source_id, *category_ids, name',
      categories: 'category_id, source_id, category_name',
      sourcesMeta: 'source_id',
      prefs: 'key',
      programs: 'id, stream_id, source_id, start, end',
    });

    // Add VOD tables for movies and series
    this.version(3).stores({
      channels: 'stream_id, source_id, *category_ids, name',
      categories: 'category_id, source_id, category_name',
      sourcesMeta: 'source_id',
      prefs: 'key',
      programs: 'id, stream_id, source_id, start, end',
      vodMovies: 'stream_id, source_id, *category_ids, name, tmdb_id, added',
      vodSeries: 'series_id, source_id, *category_ids, name, tmdb_id, added',
      vodEpisodes: 'id, series_id, season_num, episode_num',
      vodCategories: 'category_id, source_id, name, type',
    });

    // Add popularity index for local popular content queries
    this.version(4).stores({
      channels: 'stream_id, source_id, *category_ids, name',
      categories: 'category_id, source_id, category_name',
      sourcesMeta: 'source_id',
      prefs: 'key',
      programs: 'id, stream_id, source_id, start, end',
      vodMovies: 'stream_id, source_id, *category_ids, name, tmdb_id, added, popularity',
      vodSeries: 'series_id, source_id, *category_ids, name, tmdb_id, added, popularity',
      vodEpisodes: 'id, series_id, season_num, episode_num',
      vodCategories: 'category_id, source_id, name, type',
    });

    // Add compound index for efficient unmatched item queries
    this.version(5).stores({
      channels: 'stream_id, source_id, *category_ids, name',
      categories: 'category_id, source_id, category_name',
      sourcesMeta: 'source_id',
      prefs: 'key',
      programs: 'id, stream_id, source_id, start, end',
      vodMovies: 'stream_id, source_id, *category_ids, name, tmdb_id, added, popularity, [source_id+tmdb_id]',
      vodSeries: 'series_id, source_id, *category_ids, name, tmdb_id, added, popularity, [source_id+tmdb_id]',
      vodEpisodes: 'id, series_id, season_num, episode_num',
      vodCategories: 'category_id, source_id, name, type',
    });

    // Add compound index for efficient EPG time-range queries
    this.version(6).stores({
      channels: 'stream_id, source_id, *category_ids, name',
      categories: 'category_id, source_id, category_name',
      sourcesMeta: 'source_id',
      prefs: 'key',
      programs: 'id, stream_id, source_id, start, end, [stream_id+start]',
      vodMovies: 'stream_id, source_id, *category_ids, name, tmdb_id, added, popularity, [source_id+tmdb_id]',
      vodSeries: 'series_id, source_id, *category_ids, name, tmdb_id, added, popularity, [source_id+tmdb_id]',
      vodEpisodes: 'id, series_id, season_num, episode_num',
      vodCategories: 'category_id, source_id, name, type',
    });

    // Add channel_num index for channel ordering (Xtream num / M3U tvg-chno)
    this.version(7).stores({
      channels: 'stream_id, source_id, *category_ids, name, channel_num',
      categories: 'category_id, source_id, category_name',
      sourcesMeta: 'source_id',
      prefs: 'key',
      programs: 'id, stream_id, source_id, start, end, [stream_id+start]',
      vodMovies: 'stream_id, source_id, *category_ids, name, tmdb_id, added, popularity, [source_id+tmdb_id]',
      vodSeries: 'series_id, source_id, *category_ids, name, tmdb_id, added, popularity, [source_id+tmdb_id]',
      vodEpisodes: 'id, series_id, season_num, episode_num',
      vodCategories: 'category_id, source_id, name, type',
    });
  }
}

export const db = new SbtltvDatabase();

// Helper to clear all data for a source (before re-sync or on delete)
export async function clearSourceData(sourceId: string): Promise<void> {
  await db.transaction('rw', [db.channels, db.categories, db.sourcesMeta, db.programs], async () => {
    await db.channels.where('source_id').equals(sourceId).delete();
    await db.categories.where('source_id').equals(sourceId).delete();
    await db.sourcesMeta.where('source_id').equals(sourceId).delete();
    await db.programs.where('source_id').equals(sourceId).delete();
  });
}

// Helper to clear VOD data for a source
export async function clearVodData(sourceId: string): Promise<void> {
  await db.transaction('rw', [db.vodMovies, db.vodSeries, db.vodEpisodes, db.vodCategories], async () => {
    // Get series IDs BEFORE deleting them (episodes don't have source_id directly)
    const series = await db.vodSeries.where('source_id').equals(sourceId).toArray();
    const seriesIds = series.map(s => s.series_id);

    await db.vodMovies.where('source_id').equals(sourceId).delete();
    await db.vodSeries.where('source_id').equals(sourceId).delete();

    // Delete episodes for all series from this source
    for (const seriesId of seriesIds) {
      await db.vodEpisodes.where('series_id').equals(seriesId).delete();
    }
    await db.vodCategories.where('source_id').equals(sourceId).delete();
  });
}

// Helper to clear ALL cached data (channels, EPG, VOD, metadata)
// Keeps: prefs (user preferences), electron-store settings, source configs
export async function clearAllCachedData(): Promise<void> {
  await db.transaction('rw', [
    db.channels,
    db.categories,
    db.sourcesMeta,
    db.programs,
    db.vodMovies,
    db.vodSeries,
    db.vodEpisodes,
    db.vodCategories,
  ], async () => {
    await db.channels.clear();
    await db.categories.clear();
    await db.sourcesMeta.clear();
    await db.programs.clear();
    await db.vodMovies.clear();
    await db.vodSeries.clear();
    await db.vodEpisodes.clear();
    await db.vodCategories.clear();
  });
}

// Helper to get last selected category
export async function getLastCategory(): Promise<string | null> {
  const pref = await db.prefs.get('lastCategory');
  return pref?.value ?? null;
}

// Helper to set last selected category
export async function setLastCategory(categoryId: string): Promise<void> {
  await db.prefs.put({ key: 'lastCategory', value: categoryId });
}

// ============================================================================
// Category Management Functions
// ============================================================================

/** Update category enabled/disabled state */
export async function updateCategoryEnabled(categoryId: string, enabled: boolean) {
  await db.categories.update(categoryId, { enabled });
}

/** Update multiple categories' order */
export async function updateCategoriesOrder(updates: { categoryId: string; displayOrder: number }[]) {
  await db.transaction('rw', db.categories, async () => {
    for (const { categoryId, displayOrder } of updates) {
      await db.categories.update(categoryId, { display_order: displayOrder });
    }
  });
}

/** Batch update categories (enabled state and/or display order) */
export async function updateCategoriesBatch(
  updates: Array<{ categoryId: string; enabled?: boolean; displayOrder?: number }>
) {
  await db.transaction('rw', db.categories, async () => {
    // Bulk update approach is much faster than individual awaits
    const promises = updates.map(u => {
      const changes: Partial<StoredCategory> = {};
      if (u.enabled !== undefined) changes.enabled = u.enabled;
      if (u.displayOrder !== undefined) changes.display_order = u.displayOrder;

      if (Object.keys(changes).length > 0) {
        return db.categories.update(u.categoryId, changes);
      }
      return Promise.resolve(0);
    });

    await Promise.all(promises);
  });
}

/** Enable all categories for a source */
export async function enableAllSourceCategories(sourceId: string) {
  const categories = await db.categories.where('source_id').equals(sourceId).toArray();
  await db.transaction('rw', db.categories, async () => {
    for (const cat of categories) {
      await db.categories.update(cat.category_id, { enabled: true });
    }
  });
}

/** Disable all categories for a source */
export async function disableAllSourceCategories(sourceId: string) {
  const categories = await db.categories.where('source_id').equals(sourceId).toArray();
  await db.transaction('rw', db.categories, async () => {
    for (const cat of categories) {
      await db.categories.update(cat.category_id, { enabled: false });
    }
  });
}

// ============================================================================
// Favorites Functions
// ============================================================================

/** Toggle channel favorite status */
export async function toggleChannelFavorite(streamId: string) {
  const channel = await db.channels.get(streamId);
  if (channel) {
    await db.channels.update(streamId, { is_favorite: !channel.is_favorite });
  }
}

/** Get count of favorited channels */
export async function getFavoriteChannelCount(): Promise<number> {
  return await db.channels.filter(ch => ch.is_favorite === true).count();
}

