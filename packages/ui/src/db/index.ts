import { SqliteDatabase, SqliteTable, dbEvents } from './sqlite-adapter';
import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';
import type { Channel, Category, Movie, Series, Episode } from '@ynotv/core';

// Extended channel with local metadata
export interface StoredChannel extends Omit<Channel, 'stream_icon' | 'epg_channel_id' | 'tv_archive'> {
  name: string;
  channel_num?: number;
  is_favorite?: boolean;    // For favorites feature
  enabled?: boolean;        // For showing/hiding channels
  // For quick lookups
  source_category_key?: string; // `${source_id}_${category_id}` for compound index

  // SQLite specific fields that might need explicit typing if not in base Channel
  added?: string;
  stream_type?: string;
  stream_icon?: string;
  epg_channel_id?: string;
  custom_sid?: string;
  tv_archive?: number;
  direct_source?: string;
  xmltv_id?: string;
  series_no?: number;
  live?: number;
}

// Extended category with channel count
export interface StoredCategory extends Category {
  source_id: string;
  category_name: string;
  channel_count?: number;
  enabled?: boolean;        // For hiding/showing categories
  display_order?: number;   // For manual ordering
  parent_id?: number;
  filter_words?: string[];  // Words to filter out from channel names
}

// Source sync metadata
export interface SourceMeta {
  source_id: string;
  epg_url?: string;
  last_synced?: Date | string; // Dates are strings in SQLite
  vod_last_synced?: Date | string;
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
export interface StoredMovie extends Omit<Movie, 'category_ids'> {
  tmdb_id?: number;
  imdb_id?: string;
  added?: Date | string;
  backdrop_path?: string;
  popularity?: number;
  match_attempted?: Date | string; // When TMDB matching was last attempted (even if no match found)
  category_ids?: string; // stored as JSON/string in SQLite
}

// VOD Series with TMDB enrichment
export interface StoredSeries extends Series {
  tmdb_id?: number;
  imdb_id?: string;
  added?: Date | string;
  backdrop_path?: string;
  popularity?: number;
  match_attempted?: Date | string; // When TMDB matching was last attempted (even if no match found)
  _stalker_category?: string; // Stalker: store parent category for episode fetching
  _stalker_raw_id?: string; // Stalker: store raw ID for episode/season fetching
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
  start: Date | string;
  end: Date | string;
  source_id: string;
}

// Channel metadata (video properties)
export interface ChannelMetadata {
  stream_id: string;          // Primary key (FK to channels)
  source_id: string;           // FK to sources
  resolution_width: number;     // e.g., 1920
  resolution_height: number;    // e.g., 1080
  fps: number;                 // e.g., 30
  audio_channels: string;      // e.g., "STEREO", "5.1"
  quality_label: string;       // e.g., "4K", "1080p", "720p", "SD"
  last_updated: Date | string;
}

// DVR Schedule (planned recording)
export interface DvrSchedule {
  id?: number;
  source_id: string;
  channel_id: string;
  channel_name: string;
  program_title: string;

  scheduled_start: number;        // Unix timestamp (seconds)
  scheduled_end: number;          // Unix timestamp (seconds)
  start_padding_sec: number;      // Default: 60
  end_padding_sec: number;        // Default: 300

  status: 'scheduled' | 'recording' | 'completed' | 'failed' | 'canceled';

  series_match_title?: string;    // For future series recording
  recurrence?: 'once' | 'daily' | 'weekly';

  created_at: number;
  started_at?: number;

  // Optional pre-resolved stream URL (for sources that need URL regeneration like Stalker)
  stream_url?: string;
}

// DVR Recording (completed/in-progress)
export interface DvrRecording {
  id?: number;
  schedule_id?: number;

  file_path: string;
  filename: string;
  size_bytes?: number;

  channel_name: string;
  program_title: string;
  scheduled_start?: number;
  scheduled_end?: number;
  actual_start: number;
  actual_end?: number;
  duration_sec?: number;

  status: 'recording' | 'completed' | 'partial' | 'failed';
  error_message?: string;

  keep_until?: number;               // Unix timestamp (NULL = forever)
  auto_delete_policy: 'keep_forever' | 'keep_days' | 'space_needed';

  created_at: number;

  thumbnail_path?: string;           // Path to thumbnail image
}

// DVR Settings
export interface DvrSettings {
  key: string;
  value: string;
}

// Watchlist Item (saved EPG programs)
export interface WatchlistItem {
  id?: number;
  program_id: string;           // EPG program ID
  channel_id: string;           // Channel stream_id
  channel_name: string;         // Channel name for display
  program_title: string;        // Program title
  description?: string;         // Program description
  start_time: number;           // Program start timestamp
  end_time: number;             // Program end timestamp
  source_id: string;            // Source ID
  added_at: number;             // When added to watchlist
  // Reminder and autoswitch settings
  reminder_enabled: boolean;    // Whether to show reminder notification
  reminder_minutes: number;     // Minutes before start to show reminder (0 = at start time)
  autoswitch_enabled: boolean;  // Whether to auto-switch to channel when program starts
  autoswitch_seconds_before: number; // Seconds before program start to auto-switch (default: 0)
  reminder_shown: boolean;      // Whether reminder has been shown (to avoid duplicates)
  autoswitch_triggered: boolean; // Whether autoswitch has been triggered
}


class YnotvDatabase extends SqliteDatabase {
  channels: SqliteTable<StoredChannel, string>;
  categories: SqliteTable<StoredCategory, string>;
  sourcesMeta: SqliteTable<SourceMeta, string>;
  prefs: SqliteTable<UserPrefs, string>;
  programs: SqliteTable<StoredProgram, string>;
  vodMovies: SqliteTable<StoredMovie, string>;
  vodSeries: SqliteTable<StoredSeries, string>;
  vodEpisodes: SqliteTable<StoredEpisode, string>;
  vodCategories: SqliteTable<VodCategory, string>;
  channelMetadata: SqliteTable<ChannelMetadata, string>;
  dvrSchedules: SqliteTable<DvrSchedule, number>;
  dvrRecordings: SqliteTable<DvrRecording, number>;
  dvrSettings: SqliteTable<DvrSettings, string>;
  watchlist: SqliteTable<WatchlistItem, number>;


  constructor() {
    super('ynotv');

    // Initialize tables with Primary Keys
    // Note: The promise is handled internally by the Table wrapper
    this.channels = new SqliteTable('channels', 'stream_id', this.dbPromise);
    this.categories = new SqliteTable('categories', 'category_id', this.dbPromise);
    this.sourcesMeta = new SqliteTable('sourcesMeta', 'source_id', this.dbPromise);
    this.prefs = new SqliteTable('prefs', 'key', this.dbPromise);
    this.programs = new SqliteTable('programs', 'id', this.dbPromise);
    this.vodMovies = new SqliteTable('vodMovies', 'stream_id', this.dbPromise);
    this.vodSeries = new SqliteTable('vodSeries', 'series_id', this.dbPromise);
    this.vodEpisodes = new SqliteTable('vodEpisodes', 'id', this.dbPromise);
    this.vodCategories = new SqliteTable('vodCategories', 'category_id', this.dbPromise);
    this.channelMetadata = new SqliteTable('channelMetadata', 'stream_id', this.dbPromise);
    this.dvrSchedules = new SqliteTable('dvr_schedules', 'id', this.dbPromise);
    this.dvrRecordings = new SqliteTable('dvr_recordings', 'id', this.dbPromise);
    this.dvrSettings = new SqliteTable('dvr_settings', 'key', this.dbPromise);
    this.watchlist = new SqliteTable('watchlist', 'id', this.dbPromise);

    // Initialize Schema (Async) - Chain to DB promise to ensure tables exist before usage
    const rawPromise = this.dbPromise;
    this.dbPromise = rawPromise.then(async (db) => {
      await this.initSchema(db);
      return db;
    });

    // Update all tables to use the new promise that includes schema initialization
    this.channels.updateDbPromise(this.dbPromise);
    this.categories.updateDbPromise(this.dbPromise);
    this.sourcesMeta.updateDbPromise(this.dbPromise);
    this.prefs.updateDbPromise(this.dbPromise);
    this.programs.updateDbPromise(this.dbPromise);
    this.vodMovies.updateDbPromise(this.dbPromise);
    this.vodSeries.updateDbPromise(this.dbPromise);
    this.vodEpisodes.updateDbPromise(this.dbPromise);
    this.vodCategories.updateDbPromise(this.dbPromise);
    this.channelMetadata.updateDbPromise(this.dbPromise);
    this.dvrSchedules.updateDbPromise(this.dbPromise);
    this.dvrRecordings.updateDbPromise(this.dbPromise);
    this.dvrSettings.updateDbPromise(this.dbPromise);
    this.watchlist.updateDbPromise(this.dbPromise);
  }

  async initSchema(dbInstance?: Database) {
    console.log('[DB] Starting schema initialization...');
    const db = dbInstance || await this.dbPromise;
    // Basic Schema Creation
    // Real optimization: Add cleanup/migration logic here

    // Channels
    // Performance PRAGMAs
    try {
      await db.execute('PRAGMA journal_mode = WAL;');
      await db.execute('PRAGMA synchronous = NORMAL;');
      await db.execute('PRAGMA temp_store = MEMORY;');
      await db.execute('PRAGMA cache_size = -64000;');
    } catch (e) {
      console.warn('Failed to set PRAGMAs', e);
    }

    await db.execute(`CREATE TABLE IF NOT EXISTS channels (
        stream_id TEXT PRIMARY KEY, 
        source_id TEXT, 
        category_ids TEXT, 
        name TEXT, 
        channel_num INTEGER,
        is_favorite BOOLEAN,
        enabled BOOLEAN,
        num INTEGER,
        stream_type TEXT,
        stream_icon TEXT,
        epg_channel_id TEXT,
        added TEXT,
        custom_sid TEXT,
        tv_archive INTEGER,
        direct_source TEXT,
        direct_url TEXT,
        xmltv_id TEXT,
        series_no INTEGER,
        live INTEGER
      )`);

    // Migrations
    // Helper to safely add column
    const addColumn = async (table: string, col: string, type: string) => {
      try {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
      } catch (e) {
        // Ignore error if column exists (SQLite throws if column exists)
      }
    };

    await addColumn('channels', 'direct_url', 'TEXT');
    await addColumn('channels', 'enabled', 'BOOLEAN');
    await addColumn('categories', 'filter_words', 'TEXT');
    await addColumn('vodSeries', 'title', 'TEXT');
    await addColumn('vodSeries', 'last_modified', 'TEXT');
    await addColumn('vodSeries', 'year', 'TEXT');
    await addColumn('vodSeries', 'stream_type', 'TEXT');

    // Add missing columns to vodMovies for metadata
    await addColumn('vodMovies', 'genre', 'TEXT');
    await addColumn('vodMovies', 'title', 'TEXT');
    await addColumn('vodMovies', 'release_date', 'TEXT');

    // Add missing columns to vodSeries for metadata
    await addColumn('vodSeries', 'stream_icon', 'TEXT');
    await addColumn('vodSeries', 'year', 'TEXT');
    await addColumn('vodSeries', 'direct_url', 'TEXT');
    await addColumn('vodSeries', 'rating_5based', 'INTEGER');
    await addColumn('vodSeries', 'category_id', 'TEXT');
    await addColumn('vodSeries', '_stalker_raw_id', 'TEXT');

    // Add watchlist columns for reminder/autoswitch features
    await addColumn('watchlist', 'reminder_enabled', 'BOOLEAN DEFAULT 1');
    await addColumn('watchlist', 'reminder_minutes', 'INTEGER DEFAULT 0');
    await addColumn('watchlist', 'autoswitch_enabled', 'BOOLEAN DEFAULT 0');
    await addColumn('watchlist', 'autoswitch_seconds_before', 'INTEGER DEFAULT 0');
    await addColumn('watchlist', 'reminder_shown', 'BOOLEAN DEFAULT 0');
    await addColumn('watchlist', 'autoswitch_triggered', 'BOOLEAN DEFAULT 0');

    // Add missing columns to dvr_recordings
    await addColumn('dvr_recordings', 'keep_until', 'INTEGER');
    await addColumn('dvr_recordings', 'auto_delete_policy', 'TEXT DEFAULT "space_needed"');

    // Fix: Rename direct_source to direct_url in VOD tables (schema/type mismatch)
    await addColumn('vodMovies', 'direct_url', 'TEXT');
    await addColumn('vodEpisodes', 'direct_url', 'TEXT');
    await addColumn('vodEpisodes', 'plot', 'TEXT');
    await addColumn('vodEpisodes', 'duration', 'INTEGER');

    // Migration: Copy data from old columns
    try {
      await db.execute('UPDATE vodMovies SET direct_url = direct_source WHERE direct_url IS NULL AND direct_source IS NOT NULL');
      await db.execute('UPDATE vodEpisodes SET direct_url = direct_source WHERE direct_url IS NULL AND direct_source IS NOT NULL');
    } catch (e) {
      // Ignore errors if columns don't exist
    }

    // Indexes
    // Migration: Add direct_url if not exists (Primitive migration)
    try {
      await db.execute('ALTER TABLE channels ADD COLUMN direct_url TEXT');
    } catch (e) {
      // Ignore error if column exists
    }
    // Indexes? SQLite creates index on Primary Key automatically.
    // We might need index on source_id and category_ids for performance.
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_channels_source ON channels(source_id)`);
    // Index for fast name search (LIKE queries)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name COLLATE NOCASE)`);


    // Categories
    await db.execute(`CREATE TABLE IF NOT EXISTS categories (
        category_id TEXT PRIMARY KEY,
        source_id TEXT,
        category_name TEXT,
        parent_id INTEGER,
        enabled BOOLEAN,
        display_order INTEGER,
        channel_count INTEGER,
        filter_words TEXT
      )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_categories_source ON categories(source_id)`);

    // Source Meta
    await db.execute(`CREATE TABLE IF NOT EXISTS sourcesMeta (
        source_id TEXT PRIMARY KEY,
        epg_url TEXT,
        last_synced TEXT,
        vod_last_synced TEXT,
        channel_count INTEGER,
        category_count INTEGER,
        vod_movie_count INTEGER,
        vod_series_count INTEGER,
        expiry_date TEXT,
        active_cons TEXT,
        max_connections TEXT,
        error TEXT
      )`);

    // Prefs
    await db.execute(`CREATE TABLE IF NOT EXISTS prefs (
        key TEXT PRIMARY KEY,
        value TEXT
      )`);

    // Programs (EPG)
    await db.execute(`CREATE TABLE IF NOT EXISTS programs (
        id TEXT PRIMARY KEY,
        stream_id TEXT,
        title TEXT,
        description TEXT,
        start TEXT,
        end TEXT,
        source_id TEXT
      )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_programs_stream ON programs(stream_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_programs_time ON programs(start, end)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_programs_source ON programs(source_id)`);
    // Index for fast title search (LIKE queries)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_programs_title ON programs(title COLLATE NOCASE)`);

    // VOD Movies
    await db.execute(`CREATE TABLE IF NOT EXISTS vodMovies (
        stream_id TEXT PRIMARY KEY,
        source_id TEXT,
        category_ids TEXT,
        name TEXT,
        tmdb_id INTEGER,
        added TEXT,
        popularity REAL,
        backdrop_path TEXT,
        imdb_id TEXT,
        match_attempted TEXT,
        container_extension TEXT,
        rating REAL,
        director TEXT,
        year TEXT,
        cast TEXT,
        plot TEXT,
        duration_secs INTEGER,
        duration TEXT,
        stream_icon TEXT, 
        direct_url TEXT
      )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_vodMovies_source ON vodMovies(source_id)`);
    // Add index on category_ids for faster category filtering (LIKE queries benefit from index)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_vodMovies_category ON vodMovies(category_ids)`);
    // Index for sorting/searching by name
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_vodMovies_name ON vodMovies(name)`);
    // Index for TMDB lookups and popularity sorting
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_vodMovies_tmdb_id ON vodMovies(tmdb_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_vodMovies_popularity ON vodMovies(popularity DESC)`);
    // Composite index for source+category queries
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_vodMovies_source_category ON vodMovies(source_id, category_ids)`);

    // VOD Series
    await db.execute(`CREATE TABLE IF NOT EXISTS vodSeries (
        series_id TEXT PRIMARY KEY,
        source_id TEXT,
        category_ids TEXT,
        name TEXT,
        tmdb_id INTEGER,
        added TEXT,
        popularity REAL,
        backdrop_path TEXT,
        imdb_id TEXT,
        match_attempted TEXT,
        _stalker_category TEXT,
        cover TEXT,
        plot TEXT,
        cast TEXT,
        director TEXT,
        genre TEXT,
        releaseDate TEXT,
        rating TEXT,
        youtube_trailer TEXT,
        episode_run_time TEXT,
        title TEXT,
        last_modified TEXT,
        stream_type TEXT
      )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_vodSeries_source ON vodSeries(source_id)`);
    // Add index on category_ids for faster category filtering
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_vodSeries_category ON vodSeries(category_ids)`);
    // Index for sorting/searching by name
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_vodSeries_name ON vodSeries(name)`);
    // Index for TMDB lookups and popularity sorting
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_vodSeries_tmdb_id ON vodSeries(tmdb_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_vodSeries_popularity ON vodSeries(popularity DESC)`);

    // VOD Episodes
    await db.execute(`CREATE TABLE IF NOT EXISTS vodEpisodes (
        id TEXT PRIMARY KEY,
        series_id TEXT,
        season_num INTEGER,
        episode_num INTEGER,
        title TEXT,
        container_extension TEXT,
        info TEXT,
        custom_sid TEXT,
        added TEXT,
        direct_url TEXT,
        plot TEXT,
        duration INTEGER
      )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_episodes_series ON vodEpisodes(series_id)`);
    // Episodes don't strictly need source_id index if we always query by series_id, 
    // but if we ever clear by source via join or denormalized field, it helps.
    // However, series_id is the main lookup.

    // VOD Categories
    await db.execute(`CREATE TABLE IF NOT EXISTS vodCategories (
        category_id TEXT PRIMARY KEY,
        source_id TEXT,
        name TEXT,
        type TEXT
      )`);

    // TMDB Export Cache - for persisting export data across restarts
    await db.execute(`CREATE TABLE IF NOT EXISTS tmdbExportCache (
        cache_key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_tmdb_cache_expires ON tmdbExportCache(expires_at)`);

    // Channel Metadata - for storing video properties
    await db.execute(`CREATE TABLE IF NOT EXISTS channelMetadata (
        stream_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        resolution_width INTEGER,
        resolution_height INTEGER,
        fps REAL,
        audio_channels TEXT,
        quality_label TEXT,
      last_updated TEXT
      )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_metadata_source ON channelMetadata(source_id)`);

    // DVR Schedules
    await db.execute(`CREATE TABLE IF NOT EXISTS dvr_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      program_title TEXT NOT NULL,
      scheduled_start INTEGER NOT NULL,
      scheduled_end INTEGER NOT NULL,
      start_padding_sec INTEGER DEFAULT 60,
      end_padding_sec INTEGER DEFAULT 300,
      status TEXT NOT NULL DEFAULT 'scheduled',
      series_match_title TEXT,
      recurrence TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      FOREIGN KEY (source_id) REFERENCES sourcesMeta(source_id),
      FOREIGN KEY (channel_id) REFERENCES channels(stream_id)
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_dvr_schedules_status ON dvr_schedules(status)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_dvr_schedules_time ON dvr_schedules(scheduled_start, scheduled_end)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_dvr_schedules_source ON dvr_schedules(source_id)`);

    // DVR Recordings
    await db.execute(`CREATE TABLE IF NOT EXISTS dvr_recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER,
      file_path TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      size_bytes INTEGER,
      channel_name TEXT NOT NULL,
      program_title TEXT NOT NULL,
      scheduled_start INTEGER,
      scheduled_end INTEGER,
      actual_start INTEGER NOT NULL,
      actual_end INTEGER,
      duration_sec INTEGER,
      status TEXT NOT NULL DEFAULT 'recording',
      error_message TEXT,
      keep_until INTEGER,
      auto_delete_policy TEXT DEFAULT 'space_needed',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (schedule_id) REFERENCES dvr_schedules(id) ON DELETE SET NULL
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_dvr_recordings_schedule ON dvr_recordings(schedule_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_dvr_recordings_status ON dvr_recordings(status)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_dvr_recordings_keep ON dvr_recordings(keep_until)`);

    // DVR Settings
    await db.execute(`CREATE TABLE IF NOT EXISTS dvr_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);

    // Watchlist - Saved EPG programs
    await db.execute(`CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      program_title TEXT NOT NULL,
      description TEXT,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      reminder_enabled BOOLEAN DEFAULT 1,
      reminder_minutes INTEGER DEFAULT 0,
      autoswitch_enabled BOOLEAN DEFAULT 0,
      autoswitch_seconds_before INTEGER DEFAULT 0,
      reminder_shown BOOLEAN DEFAULT 0,
      autoswitch_triggered BOOLEAN DEFAULT 0
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_watchlist_channel ON watchlist(channel_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_watchlist_time ON watchlist(start_time, end_time)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_watchlist_source ON watchlist(source_id)`);

    console.log('[DB] Schema initialization complete');
  }
}

export const db = new YnotvDatabase();

// Helper to clear all data for a source (before re-sync or on delete)
export async function clearSourceData(sourceId: string): Promise<void> {
  // Use raw SQL deletes for better performance and fewer events
  const dbInstance = await (db as any).dbPromise;

  // Delete DVR data first (recordings reference schedules, schedules reference source)
  await dbInstance.execute(
    'DELETE FROM dvr_recordings WHERE schedule_id IN (SELECT id FROM dvr_schedules WHERE source_id = $1)',
    [sourceId]
  );
  await dbInstance.execute('DELETE FROM dvr_schedules WHERE source_id = $1', [sourceId]);

  await dbInstance.execute('DELETE FROM channels WHERE source_id = $1', [sourceId]);
  await dbInstance.execute('DELETE FROM categories WHERE source_id = $1', [sourceId]);
  await dbInstance.execute('DELETE FROM sourcesMeta WHERE source_id = $1', [sourceId]);
  await dbInstance.execute('DELETE FROM programs WHERE source_id = $1', [sourceId]);

  // Fire single batch event for each table
  dbEvents.notify('dvr_recordings', 'delete');
  dbEvents.notify('dvr_schedules', 'delete');
  dbEvents.notify('channels', 'delete');
  dbEvents.notify('categories', 'delete');
  dbEvents.notify('sourcesMeta', 'delete');
  dbEvents.notify('programs', 'delete');
}

// Helper to clear VOD data for a source
export async function clearVodData(sourceId: string): Promise<void> {
  const dbInstance = await (db as any).dbPromise;

  // Get series IDs for episodes deletion
  const seriesResult = await dbInstance.select(
    'SELECT series_id FROM vodSeries WHERE source_id = $1',
    [sourceId]
  );
  const seriesIds = seriesResult.map((s: any) => s.series_id);

  // Use raw SQL deletes for better performance
  await dbInstance.execute('DELETE FROM vodMovies WHERE source_id = $1', [sourceId]);
  await dbInstance.execute('DELETE FROM vodSeries WHERE source_id = $1', [sourceId]);

  // Delete episodes for all series from this source
  if (seriesIds.length > 0) {
    const placeholders = seriesIds.map((_: any, i: number) => `$${i + 2}`).join(',');
    await dbInstance.execute(
      `DELETE FROM vodEpisodes WHERE series_id IN (${placeholders})`,
      [sourceId, ...seriesIds]
    );
  }

  await dbInstance.execute('DELETE FROM vodCategories WHERE source_id = $1', [sourceId]);

  // Fire single batch event for each table
  dbEvents.notify('vodMovies', 'delete');
  dbEvents.notify('vodSeries', 'delete');
  dbEvents.notify('vodEpisodes', 'delete');
  dbEvents.notify('vodCategories', 'delete');
}

// Helper to clear ALL cached data (channels, EPG, VOD, metadata)
// Keeps: prefs (user preferences), Tauri Store settings, source configs
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
  await db.transaction('rw', [db.categories], async () => {
    for (const { categoryId, displayOrder } of updates) {
      await db.categories.update(categoryId, { display_order: displayOrder });
    }
  });
}

// ============================================================================
// TMDB Export Cache Functions
// ============================================================================

const TMDB_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Save TMDB export data to persistent cache */
export async function saveTmdbExportCache(cacheKey: string, data: any): Promise<void> {
  const now = Date.now();
  const expiresAt = now + TMDB_CACHE_TTL_MS;

  const dbInstance = await (db as any).dbPromise;
  await dbInstance.execute(
    `INSERT OR REPLACE INTO tmdbExportCache (cache_key, data, created_at, expires_at) VALUES (?, ?, ?, ?)`,
    [cacheKey, JSON.stringify(data), now, expiresAt]
  );
}

/** Load TMDB export data from persistent cache */
export async function loadTmdbExportCache(cacheKey: string): Promise<any | null> {
  const dbInstance = await (db as any).dbPromise;
  const now = Date.now();

  const result = await dbInstance.select(
    `SELECT data, expires_at FROM tmdbExportCache WHERE cache_key = ? AND expires_at > ?`,
    [cacheKey, now]
  );

  if (result && result.length > 0) {
    try {
      return JSON.parse(result[0].data);
    } catch {
      return null;
    }
  }
  return null;
}

/** Clean up expired TMDB cache entries */
export async function cleanupTmdbExportCache(): Promise<void> {
  const dbInstance = await (db as any).dbPromise;
  const now = Date.now();
  await dbInstance.execute(
    `DELETE FROM tmdbExportCache WHERE expires_at <= ?`,
    [now]
  );
}

/** Batch update categories (enabled state and/or display order) */
export async function updateCategoriesBatch(
  updates: Array<{ categoryId: string; enabled?: boolean; displayOrder?: number }>
): Promise<number> {
  let totalUpdated = 0;

  try {
    await db.transaction('rw', [db.categories], async () => {
      // Bulk update approach is much faster than individual awaits
      const promises = updates.map(async u => {
        const changes: Partial<StoredCategory> = {};
        if (u.enabled !== undefined) changes.enabled = u.enabled;
        if (u.displayOrder !== undefined) changes.display_order = u.displayOrder;

        if (Object.keys(changes).length > 0) {
          const result = await db.categories.update(u.categoryId, changes);
          return result;
        }
        return 0;
      });

      const results = await Promise.all(promises);
      totalUpdated = results.reduce((sum, count) => sum + count, 0);
      // Explicitly notify after transaction completes
      const { dbEvents } = await import('./sqlite-adapter');
      dbEvents.notify('categories', 'update');
    });
  } catch (error) {
    throw error;
  }

  return totalUpdated;
}

/** Enable all categories for a source */
export async function enableAllSourceCategories(sourceId: string) {
  const categories = await db.categories.where('source_id').equals(sourceId).toArray();
  await db.transaction('rw', [db.categories], async () => {
    for (const cat of categories) {
      await db.categories.update(cat.category_id, { enabled: true });
    }
  });
}

/** Disable all categories for a source */
export async function disableAllSourceCategories(sourceId: string) {
  const categories = await db.categories.where('source_id').equals(sourceId).toArray();
  await db.transaction('rw', [db.categories], async () => {
    for (const cat of categories) {
      await db.categories.update(cat.category_id, { enabled: false });
    }
  });
}

// ============================================================================
// Favorites Functions
// ============================================================================

/** Toggle channel favorite status */
export async function toggleChannelFavorite(streamId: string): Promise<boolean> {
  try {
    const channel = await db.channels.get(streamId);
    if (channel) {
      const newValue = !channel.is_favorite;
      await db.channels.update(streamId, { is_favorite: newValue });
      // Explicitly notify that channels have been updated
      dbEvents.notify('channels', 'update');
      return newValue;
    }
    return false;
  } catch (error) {
    console.error('[toggleChannelFavorite] Error toggling favorite:', error);
    throw error;
  }
}

import { normalizeBoolean } from '../utils/db-helpers';

/** Get count of favorited channels */
export async function getFavoriteChannelCount(): Promise<number> {
  // Use SQL COUNT for optimal performance - handle both 0/1 and true/false
  return await db.channels.countWhere('(is_favorite = 1 OR is_favorite = true)');
}

// ============================================================================
// DVR Functions
// ============================================================================

/** Get DVR settings with defaults */
export async function getDvrSettings(): Promise<Record<string, any>> {
  const settings = await db.dvrSettings.toArray();
  const settingsMap: Record<string, any> = {
    storage_path: '',
    max_disk_usage_percent: 80,
    auto_cleanup_enabled: true,
    default_start_padding_sec: 60,
    default_end_padding_sec: 300,
  };

  settings.forEach(s => {
    try {
      settingsMap[s.key] = JSON.parse(s.value);
    } catch {
      settingsMap[s.key] = s.value;
    }
  });

  return settingsMap;
}

/** Save DVR setting */
export async function saveDvrSetting(key: string, value: any): Promise<void> {
  await db.dvrSettings.put({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value)
  });
  dbEvents.notify('dvr_settings', 'update');
}

/** Schedule a recording via Rust backend */
export async function scheduleRecording(schedule: Omit<DvrSchedule, 'id' | 'created_at' | 'status'>): Promise<number> {
  console.log('[DVR] Scheduling recording:', schedule.program_title, 'at', new Date(schedule.scheduled_start * 1000).toISOString());

  const settings = await getDvrSettings();

  // Call Rust backend to schedule recording
  const request = {
    source_id: schedule.source_id,
    channel_id: schedule.channel_id,
    channel_name: schedule.channel_name,
    program_title: schedule.program_title,
    scheduled_start: schedule.scheduled_start,
    scheduled_end: schedule.scheduled_end,
    start_padding_sec: schedule.start_padding_sec ?? settings.default_start_padding_sec,
    end_padding_sec: schedule.end_padding_sec ?? settings.default_end_padding_sec,
    series_match_title: schedule.series_match_title,
    recurrence: schedule.recurrence,
    stream_url: schedule.stream_url,
  };

  console.log('[DVR] Calling Rust command schedule_recording with:', request);

  try {
    const id = await invoke<number>('schedule_recording', { request });
    console.log('[DVR] Recording scheduled with ID:', id);

    // Refresh local cache
    dbEvents.notify('dvr_schedules', 'add');
    return id;
  } catch (error) {
    console.error('[DVR] Failed to schedule recording:', error);
    throw error;
  }
}

/** Cancel a scheduled recording */
export async function cancelRecording(scheduleId: number): Promise<void> {
  console.log('[DVR] Canceling recording:', scheduleId);

  // Call Rust backend to stop FFmpeg if recording is active
  try {
    await invoke('cancel_recording', { id: scheduleId });
    console.log('[DVR] Backend cancel completed for:', scheduleId);
  } catch (error) {
    console.error('[DVR] Backend cancel failed:', error);
    // Continue to update local DB even if backend fails
  }

  // Update local database
  await db.dvrSchedules.update(scheduleId, { status: 'canceled' });

  dbEvents.notify('dvr_schedules', 'update');
  console.log('[DVR] Recording canceled:', scheduleId);
}

/** Delete a recording file and DB entry */
export async function deleteRecording(recordingId: number): Promise<void> {
  await db.dvrRecordings.delete(recordingId);
  dbEvents.notify('dvr_recordings', 'delete');
}

/** Get upcoming scheduled recordings */
export async function getScheduledRecordings(): Promise<DvrSchedule[]> {
  const all = await db.dvrSchedules.toArray();
  return all
    .filter(s => s.status === 'scheduled' || s.status === 'recording')
    .sort((a, b) => a.scheduled_start - b.scheduled_start);
}

/** Get completed recordings */
export async function getCompletedRecordings(): Promise<DvrRecording[]> {
  const all = await db.dvrRecordings.toArray();
  return all
    .filter(r => r.status === 'completed' || r.status === 'partial')
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

/** Get active recordings with live progress from backend */
export interface RecordingProgress {
  schedule_id: number;
  recording_id: number;
  channel_name: string;
  program_title: string;
  elapsed_seconds: number;
  scheduled_duration: number;
}

export async function getActiveRecordings(): Promise<RecordingProgress[]> {
  try {
    const result = await invoke<RecordingProgress[]>('get_active_recordings');
    return result || [];
  } catch (error) {
    console.error('[DVR] Failed to get active recordings:', error);
    return [];
  }
}

/** Get thumbnail image data for a recording */
export async function getRecordingThumbnail(recordingId: number): Promise<Uint8Array | null> {
  try {
    const result = await invoke<number[] | null>('get_recording_thumbnail', { recordingId });
    // Tauri serializes binary data as a number array, convert back to Uint8Array
    return result ? new Uint8Array(result) : null;
  } catch (error) {
    console.error('[DVR] Failed to get thumbnail:', error);
    return null;
  }
}

/** Update schedule padding times */
export async function updateSchedulePaddings(
  scheduleId: number,
  startPaddingSec: number,
  endPaddingSec: number
): Promise<void> {
  console.log('[DVR] Updating schedule padding:', scheduleId, { startPaddingSec, endPaddingSec });

  // Call backend to update
  try {
    await invoke('update_schedule_paddings', {
      id: scheduleId,
      startPaddingSec: startPaddingSec,
      endPaddingSec: endPaddingSec,
    });
  } catch (error) {
    console.error('[DVR] Backend update failed:', error);
    throw error;
  }

  // Update local database
  await db.dvrSchedules.update(scheduleId, {
    start_padding_sec: startPaddingSec,
    end_padding_sec: endPaddingSec,
  });

  dbEvents.notify('dvr_schedules', 'update');
  console.log('[DVR] Schedule padding updated:', scheduleId);
}

/** Detect conflicts for a new schedule - uses backend for comprehensive checking */
export async function detectScheduleConflicts(schedule: Omit<DvrSchedule, 'id' | 'created_at' | 'status'>): Promise<{ hasConflict: boolean; conflicts: DvrSchedule[]; message?: string }> {
  try {
    // Use backend command for comprehensive conflict checking including viewing conflicts
    const result = await invoke('check_schedule_conflicts', {
      sourceId: schedule.source_id,
      channelId: schedule.channel_id,
      start: schedule.scheduled_start,
      end: schedule.scheduled_end,
    }) as { has_conflict: boolean; conflicts: DvrSchedule[]; message?: string };

    return {
      hasConflict: result.has_conflict,
      conflicts: result.conflicts || [],
      message: result.message
    };
  } catch (error) {
    console.error('[DVR] Failed to check conflicts via backend, falling back to local check:', error);

    // Fallback to local check if backend fails
    const sourceMeta = await db.sourcesMeta.get(schedule.source_id);
    const maxConnections = parseInt(sourceMeta?.max_connections || '1');

    const allSchedules = await db.dvrSchedules.toArray();
    const overlapping = allSchedules.filter(s => {
      if (s.source_id !== schedule.source_id) return false;
      if (s.status !== 'scheduled' && s.status !== 'recording') return false;
      const overlaps = !(s.scheduled_end <= schedule.scheduled_start || s.scheduled_start >= schedule.scheduled_end);
      return overlaps;
    });

    if (overlapping.length >= maxConnections) {
      return {
        hasConflict: true,
        conflicts: overlapping,
        message: `Source allows ${maxConnections} connection(s), but ${overlapping.length} recording(s) already scheduled.`
      };
    }

    return { hasConflict: false, conflicts: [] };
  }
}

/** Update currently playing stream information for DVR conflict detection */
export async function updatePlayingStream(
  sourceId: string | null,
  channelId: string | null,
  channelName: string | null,
  streamUrl: string | null,
  isPlaying: boolean
): Promise<void> {
  try {
    await invoke('update_playing_stream', {
      sourceId,
      channelId,
      channelName,
      streamUrl,
      isPlaying
    });
  } catch (error) {
    console.error('[DVR] Failed to update playing stream:', error);
  }
}

// ==========================================
// WATCHLIST FUNCTIONS
// ==========================================

export interface WatchlistOptions {
  reminder_enabled: boolean;
  reminder_minutes: number;
  autoswitch_enabled: boolean;
  autoswitch_seconds_before?: number; // Seconds before program start to auto-switch (default: 0)
}

/** Add a program to the watchlist with options */
export async function addToWatchlist(
  program: StoredProgram,
  channel: StoredChannel,
  options?: WatchlistOptions
): Promise<boolean> {
  try {
    // Check if already in watchlist
    const existing = await db.watchlist
      .where('program_id')
      .equals(program.id)
      .first();

    if (existing) {
      console.log('[Watchlist] Program already in watchlist:', program.title);
      return false;
    }

    const watchlistItem: WatchlistItem = {
      program_id: program.id,
      channel_id: channel.stream_id,
      channel_name: channel.name,
      program_title: program.title,
      description: program.description,
      start_time: new Date(program.start).getTime(),
      end_time: new Date(program.end).getTime(),
      source_id: channel.source_id,
      added_at: Date.now(),
      reminder_enabled: options?.reminder_enabled ?? true,
      reminder_minutes: options?.reminder_minutes ?? 0,
      autoswitch_enabled: options?.autoswitch_enabled ?? false,
      autoswitch_seconds_before: options?.autoswitch_seconds_before ?? 0,
      reminder_shown: false,
      autoswitch_triggered: false
    };

    await db.watchlist.add(watchlistItem);
    dbEvents.notify('watchlist', 'add');
    console.log('[Watchlist] Added:', program.title);
    return true;
  } catch (error) {
    console.error('[Watchlist] Failed to add:', error);
    return false;
  }
}

/** Update watchlist item options */
export async function updateWatchlistOptions(
  id: number,
  options: Partial<WatchlistOptions>
): Promise<void> {
  try {
    await db.watchlist.update(id, options);
    dbEvents.notify('watchlist', 'update');
  } catch (error) {
    console.error('[Watchlist] Failed to update options:', error);
  }
}

/** Get watchlist items that need reminders (not yet shown, time has come) */
export async function getPendingReminders(): Promise<WatchlistItem[]> {
  const now = Date.now();
  try {
    const all = await db.watchlist.toArray();
    return all.filter(item => {
      if (!item.reminder_enabled || item.reminder_shown) return false;
      const reminderTime = item.start_time - (item.reminder_minutes * 60 * 1000);
      return now >= reminderTime && now < item.end_time;
    });
  } catch (error) {
    console.error('[Watchlist] Failed to get pending reminders:', error);
    return [];
  }
}

/** Get watchlist items that need autoswitch (not yet triggered, program just started) */
export async function getPendingAutoswitches(): Promise<WatchlistItem[]> {
  const now = Date.now();
  try {
    const all = await db.watchlist.toArray();
    return all.filter(item => {
      if (!item.autoswitch_enabled || item.autoswitch_triggered) return false;
      // Only trigger if we're within 30 seconds of start time (to avoid switching to old programs)
      const timeSinceStart = now - item.start_time;
      return timeSinceStart >= 0 && timeSinceStart < 30000;
    });
  } catch (error) {
    console.error('[Watchlist] Failed to get pending autoswitches:', error);
    return [];
  }
}

/** Mark reminder as shown */
export async function markReminderShown(id: number): Promise<void> {
  try {
    await db.watchlist.update(id, { reminder_shown: true });
  } catch (error) {
    console.error('[Watchlist] Failed to mark reminder shown:', error);
  }
}

/** Mark autoswitch as triggered */
export async function markAutoswitchTriggered(id: number): Promise<void> {
  try {
    await db.watchlist.update(id, { autoswitch_triggered: true });
  } catch (error) {
    console.error('[Watchlist] Failed to mark autoswitch triggered:', error);
  }
}

/** Remove a program from the watchlist */
export async function removeFromWatchlist(watchlistId: number): Promise<void> {
  try {
    await db.watchlist.delete(watchlistId);
    dbEvents.notify('watchlist', 'delete');
  } catch (error) {
    console.error('[Watchlist] Failed to remove:', error);
  }
}

/** Get all watchlist items */
export async function getWatchlist(): Promise<WatchlistItem[]> {
  try {
    return await db.watchlist.toArray();
  } catch (error) {
    console.error('[Watchlist] Failed to get items:', error);
    return [];
  }
}

/** Get watchlist items that are currently live or upcoming */
export async function getActiveWatchlist(): Promise<WatchlistItem[]> {
  const now = Date.now();
  try {
    const all = await db.watchlist.toArray();
    return all.filter(item => item.end_time > now);
  } catch (error) {
    console.error('[Watchlist] Failed to get active items:', error);
    return [];
  }
}

/** Check if a program is in the watchlist */
export async function isInWatchlist(programId: string): Promise<boolean> {
  try {
    const item = await db.watchlist
      .where('program_id')
      .equals(programId)
      .first();
    return !!item;
  } catch (error) {
    console.error('[Watchlist] Failed to check:', error);
    return false;
  }
}

/** Get watchlist count */
export async function getWatchlistCount(): Promise<number> {
  try {
    return await db.watchlist.count();
  } catch (error) {
    console.error('[Watchlist] Failed to get count:', error);
    return 0;
  }
}

/** Clear expired watchlist items (programs that have ended) */
export async function clearExpiredWatchlist(): Promise<void> {
  const now = Date.now();
  try {
    const all = await db.watchlist.toArray();
    const expired = all.filter(item => item.end_time < now);

    for (const item of expired) {
      if (item.id) {
        await db.watchlist.delete(item.id);
      }
    }

    if (expired.length > 0) {
      dbEvents.notify('watchlist', 'delete');
      console.log('[Watchlist] Cleared', expired.length, 'expired items');
    }
  } catch (error) {
    console.error('[Watchlist] Failed to clear expired:', error);
  }
}

