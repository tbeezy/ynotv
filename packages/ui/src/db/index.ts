import { SqliteDatabase, SqliteTable, dbEvents } from './sqlite-adapter';
import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';
import type { Channel, Category, Movie, Series, Episode } from '@ynotv/core';

// Extended channel with local metadata
export interface StoredChannel extends Omit<Channel, 'stream_icon' | 'epg_channel_id' | 'tv_archive'> {
  name: string;
  channel_num?: number;
  is_favorite?: boolean;    // For favorites feature
  fav_order?: number;       // Custom ordering for favorites
  display_order?: number;   // Custom ordering for channels within a category
  provider_order?: number;  // Position in provider response / M3U file (0-based)
  enabled?: boolean;        // For showing/hiding channels
  alias?: string;           // User-defined display name override


  // For quick lookups
  source_category_key?: string; // `${source_id}_${category_id}` for compound index

  // SQLite specific fields that might need explicit typing if not in base Channel
  added?: string;
  stream_type?: string;
  stream_icon?: string;
  epg_channel_id?: string;
  custom_sid?: string;
  tv_archive?: number;
  tv_archive_duration?: number;    // Hours of catch-up archive (Stalker)
  direct_source?: string;
  xmltv_id?: string;
  series_no?: number;
  live?: number;
  xtream_stream_id?: string; // Xtream stream_id for building catchup URLs on M3U sources

  // Optional source name (populated during search for display purposes)
  source_name?: string;
  // Optional source → category display string (populated during search)
  source_category_display?: string;
  // Manual logo tile background override ('auto' | 'light' | 'dark') applied from epg_channel_overrides
  logo_background?: string;
  // Manual logo padding override ('default' | 'none') applied from epg_channel_overrides
  logo_padding?: string;
  // Per-source logo display override ('square' | 'rectangle') applied from sourceLogoDisplayOverrides
  logo_display?: 'square' | 'rectangle';
  // Filter words that were applied to this channel's name/alias for the current
  // view (used to explain trimmed names on hover).
  applied_filter_words?: string[];
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
  alias?: string;           // User-defined display name override
  folder_id?: string | null; // Category Folder assignment
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
  display_order?: number;        // Custom ordering for sources
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
  category_id?: string; // Singular category ID (Xtream mainly)
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
  category_id?: string; // Singular category ID
  direct_url?: string;
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
  enabled?: boolean;
  display_order?: number;
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
  subtitle?: string;
  description: string;
  start: Date | string;
  raw_start?: string;
  end: Date | string;
  source_id: string;
}

// EPG channel entry (from XMLTV for fallback matching)
export interface StoredEpgChannel {
  id: string;           // Channel ID from XMLTV (e.g., "bbc1")
  display_name: string; // Human-readable name (e.g., "BBC One")
  icon_url?: string;    // Optional channel logo
  source_id: string;    // Which source this EPG came from
}

// Channel metadata (video properties)
export interface ChannelMetadata {
  stream_id: string;          // Primary key (FK to channels)
  source_id: string;           // FK to sources
  resolution_width: number;     // e.g., 1920
  resolution_height: number;    // e.g., 1080
  fps: number;                 // e.g., 30
  audio_channels: string;      // e.g., "Stereo", "5.1"
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
  recurrence?: string;

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
  progress_seconds?: number;
  last_watched_at?: number;
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

// Custom Group
export interface CustomGroup {
  group_id: string; // UUID
  name: string;
  display_order: number;
  created_at: number;
}

// Custom Group Channel Mapping
export interface CustomGroupChannel {
  id?: number; // Auto-increment
  group_id: string;
  stream_id: string;
  display_order: number;
  added_at: number;
}

// Failover Group — ordered set of channels representing the same logical stream
export interface FailoverGroup {
  group_id: string;      // UUID
  name: string;          // User-facing label
  created_at: number;    // Unix timestamp ms
}

// Failover Group Member — channel within a failover group
export interface FailoverGroupMember {
  id?: number;           // Auto-increment PK
  group_id: string;      // FK → failover_groups.group_id
  stream_id: string;     // FK → channels.stream_id
  priority: number;      // 0 = primary, 1 = first backup, etc.
}

// Custom Playlist — appears as a source-like entry in the sidebar
export interface CustomPlaylist {
  playlist_id: string;   // UUID primary key
  name: string;          // User-defined playlist name (shown as the "source" name)
  display_order: number; // Ordering among playlists in the sidebar
  created_at: number;    // Unix timestamp ms
}

// Playlist Category Link — a live reference to a source category
export interface PlaylistCategoryLink {
  id?: number;           // Auto-increment PK
  playlist_id: string;   // FK → custom_playlists.playlist_id ON DELETE CASCADE
  source_id: string;     // FK → sources (Tauri Store)
  category_id: string;   // FK → categories.category_id (soft reference)
  custom_name?: string;  // Optional user override for the category display name
  display_order: number; // Ordering of category blocks within the playlist
  added_at: number;      // Unix timestamp ms
  folder_id?: string | null; // Category Folder assignment
}

// Category Folder — container for grouping categories within a source or custom playlist
export interface CategoryFolder {
  folder_id: string;     // UUID primary key
  playlist_id: string;   // FK → custom_playlists.playlist_id OR source_id
  name: string;          // User-defined folder name (e.g., "USA", "Sports")
  display_order: number; // Ordering of folders within the source/playlist
  created_at: number;    // Unix timestamp ms
}

// Team Channel Link — maps a sports team to a provider channel so a game can be
// watched with one tap without searching. A team can have multiple links (priority 0 = primary, 1+ = backups).
export interface TeamChannelLink {
  id: string;            // `${league_id}:${team_id}:${stream_id}` (or `${league_id}:${team_id}` legacy) primary key
  league_id: string;     // e.g. 'nfl', 'soccer-eng.1'
  team_id: string;       // ESPN team id
  stream_id: string;     // FK → channels.stream_id (soft reference)
  channel_name: string;  // Snapshot of the channel name for display
  source_id?: string;    // Source the channel belongs to
  priority?: number;     // 0 = primary, 1+ = backups
  auto: number;          // 0/1 — was this auto-linked by the matcher
  confidence: number;    // 0..1 match confidence at link time
  updated_at: number;    // Unix timestamp ms
}

// Playlist Individual Channel — a single channel added to the playlist's "Individual Channels" section
export interface PlaylistIndividualChannel {
  id?: number;           // Auto-increment PK
  playlist_id: string;   // FK → custom_playlists.playlist_id ON DELETE CASCADE
  stream_id: string;     // FK → channels.stream_id ON DELETE CASCADE
  parent_category_id?: string; // ID of the category block this channel is added to (if any)
  display_order: number; // Ordering within the section/category block
  added_at: number;      // Unix timestamp ms
}

// EPG Channel Override — persistent overrides for a channel's EPG identity
export interface EpgChannelOverride {
  stream_id: string;          // PK – FK to channels.stream_id
  epg_channel_id?: string;    // Override tvg-id (NULL = keep original)
  stream_icon?: string;       // Override logo URL
  logo_background?: string;   // Manual logo tile background override: 'auto' | 'light' | 'dark' (NULL = keep auto)
  logo_padding?: string;      // Manual logo padding override: 'default' | 'none' (NULL = keep default)
  timeshift_hours?: number;   // Per-channel EPG time offset (NULL = use source default)
}

// EPG Program Override — overrides or tombstones for synced programs, plus user-created programs
export interface EpgProgramOverride {
  id: string;           // Same compound key as programs.id  OR a uuid for custom programs
  stream_id: string;
  title?: string;
  subtitle?: string;
  description?: string;
  start?: string;       // ISO8601
  end?: string;         // ISO8601
  is_deleted?: number;  // 1 = tombstone (hide in guide, show struck-through in editor)
  is_custom?: number;   // 1 = user-created (not from sync)
}

// VOD Watch History - tracks recently watched movies and series
export interface VodWatchHistory {
  id?: number;                    // Auto-increment primary key
  media_id: string;               // stream_id for movies, series_id for series
  media_type: 'movie' | 'series'; // Type discriminator
  source_id: string;              // Source ID for the media
  title: string;                  // Title for display
  watched_at: number;             // Unix timestamp (milliseconds)
  progress_seconds?: number;      // Playback progress in seconds (optional, for resume)
  total_duration?: number;        // Total duration in seconds (optional)
  poster_url?: string;            // Cached poster URL for quick display
  season_num?: number;            // For series: season number (optional)
  episode_num?: number;           // For series: episode number (optional)
  episode_title?: string;         // For series: episode title (optional)
}

// Episode Watch History - tracks progress for individual episodes
export interface EpisodeWatchHistory {
  id?: number;                    // Auto-increment primary key
  episode_id: string;             // episode.stream_id - unique identifier
  series_id: string;              // series_id for grouping
  source_id: string;              // Source ID
  season_num: number;             // Season number
  episode_num: number;            // Episode number
  title?: string;                 // Episode title
  watched_at: number;             // Unix timestamp (milliseconds)
  progress_seconds?: number;      // Playback progress in seconds
  total_duration?: number;        // Total duration in seconds
  completed: number;              // 1 if fully watched (>95%), 0 otherwise
}


class YnotvDatabase extends SqliteDatabase {
  channels: SqliteTable<StoredChannel, string>;
  categories: SqliteTable<StoredCategory, string>;
  sourcesMeta: SqliteTable<SourceMeta, string>;
  prefs: SqliteTable<UserPrefs, string>;
  programs: SqliteTable<StoredProgram, string>;
  epgChannels: SqliteTable<StoredEpgChannel, string>;
  vodMovies: SqliteTable<StoredMovie, string>;
  vodSeries: SqliteTable<StoredSeries, string>;
  vodEpisodes: SqliteTable<StoredEpisode, string>;
  vodCategories: SqliteTable<VodCategory, string>;
  channelMetadata: SqliteTable<ChannelMetadata, string>;
  dvrSchedules: SqliteTable<DvrSchedule, number>;
  dvrRecordings: SqliteTable<DvrRecording, number>;
  dvrSettings: SqliteTable<DvrSettings, string>;
  watchlist: SqliteTable<WatchlistItem, number>;
  customGroups: SqliteTable<CustomGroup, string>;
  customGroupChannels: SqliteTable<CustomGroupChannel, number>;
  epgChannelOverrides: SqliteTable<EpgChannelOverride, string>;
  epgProgramOverrides: SqliteTable<EpgProgramOverride, string>;
  vodHistory: SqliteTable<VodWatchHistory, number>;
  episodeHistory: SqliteTable<EpisodeWatchHistory, number>;
  failoverGroups: SqliteTable<FailoverGroup, string>;
  failoverGroupMembers: SqliteTable<FailoverGroupMember, number>;
  customPlaylists: SqliteTable<CustomPlaylist, string>;
  playlistCategoryLinks: SqliteTable<PlaylistCategoryLink, number>;
  playlistIndividualChannels: SqliteTable<PlaylistIndividualChannel, number>;
  categoryFolders: SqliteTable<CategoryFolder, string>;
  /** Generic key/value store for UI state (Stremio library/watch-history). */
  appKv: SqliteTable<{ key: string; value: string }, string>;
  /** Sports team → channel links (one-tap playback from match cards). */
  teamChannelLinks: SqliteTable<TeamChannelLink, string>;


  constructor() {
    super('ynotv');

    // Initialize tables with Primary Keys
    // Note: The promise is handled internally by the Table wrapper
    this.channels = new SqliteTable('channels', 'stream_id', this.dbPromise);
    this.categories = new SqliteTable('categories', 'category_id', this.dbPromise);
    this.sourcesMeta = new SqliteTable('sourcesMeta', 'source_id', this.dbPromise);
    this.prefs = new SqliteTable('prefs', 'key', this.dbPromise);
    this.programs = new SqliteTable('programs', 'id', this.dbPromise);
    this.epgChannels = new SqliteTable('epg_channels', 'id', this.dbPromise);
    this.vodMovies = new SqliteTable('vodMovies', 'stream_id', this.dbPromise);
    this.vodSeries = new SqliteTable('vodSeries', 'series_id', this.dbPromise);
    this.vodEpisodes = new SqliteTable('vodEpisodes', 'id', this.dbPromise);
    this.vodCategories = new SqliteTable('vodCategories', 'category_id', this.dbPromise);
    this.channelMetadata = new SqliteTable('channelMetadata', 'stream_id', this.dbPromise);
    this.dvrSchedules = new SqliteTable('dvr_schedules', 'id', this.dbPromise);
    this.dvrRecordings = new SqliteTable('dvr_recordings', 'id', this.dbPromise);
    this.dvrSettings = new SqliteTable('dvr_settings', 'key', this.dbPromise);
    this.watchlist = new SqliteTable('watchlist', 'id', this.dbPromise);
    this.customGroups = new SqliteTable('custom_groups', 'group_id', this.dbPromise);
    this.customGroupChannels = new SqliteTable('custom_group_channels', 'id', this.dbPromise);
    this.epgChannelOverrides = new SqliteTable('epg_channel_overrides', 'stream_id', this.dbPromise);
    this.epgProgramOverrides = new SqliteTable('epg_program_overrides', 'id', this.dbPromise);
    this.vodHistory = new SqliteTable('vod_history', 'id', this.dbPromise);
    this.episodeHistory = new SqliteTable('episode_history', 'id', this.dbPromise);
    this.failoverGroups = new SqliteTable('failover_groups', 'group_id', this.dbPromise);
    this.failoverGroupMembers = new SqliteTable('failover_group_members', 'id', this.dbPromise);
    this.customPlaylists = new SqliteTable('custom_playlists', 'playlist_id', this.dbPromise);
    this.playlistCategoryLinks = new SqliteTable('playlist_category_links', 'id', this.dbPromise);
    this.playlistIndividualChannels = new SqliteTable('playlist_individual_channels', 'id', this.dbPromise);
    this.categoryFolders = new SqliteTable('category_folders', 'folder_id', this.dbPromise);
    this.appKv = new SqliteTable('app_kv', 'key', this.dbPromise);
    this.teamChannelLinks = new SqliteTable('team_channel_links', 'id', this.dbPromise);

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
    this.epgChannels.updateDbPromise(this.dbPromise);
    this.vodMovies.updateDbPromise(this.dbPromise);
    this.vodSeries.updateDbPromise(this.dbPromise);
    this.vodEpisodes.updateDbPromise(this.dbPromise);
    this.vodCategories.updateDbPromise(this.dbPromise);
    this.channelMetadata.updateDbPromise(this.dbPromise);
    this.dvrSchedules.updateDbPromise(this.dbPromise);
    this.dvrRecordings.updateDbPromise(this.dbPromise);
    this.dvrSettings.updateDbPromise(this.dbPromise);
    this.watchlist.updateDbPromise(this.dbPromise);
    this.customGroups.updateDbPromise(this.dbPromise);
    this.customGroupChannels.updateDbPromise(this.dbPromise);
    this.epgChannelOverrides.updateDbPromise(this.dbPromise);
    this.epgProgramOverrides.updateDbPromise(this.dbPromise);
    this.vodHistory.updateDbPromise(this.dbPromise);
    this.episodeHistory.updateDbPromise(this.dbPromise);
    this.failoverGroups.updateDbPromise(this.dbPromise);
    this.failoverGroupMembers.updateDbPromise(this.dbPromise);
    this.customPlaylists.updateDbPromise(this.dbPromise);
    this.playlistCategoryLinks.updateDbPromise(this.dbPromise);
    this.playlistIndividualChannels.updateDbPromise(this.dbPromise);
    this.categoryFolders.updateDbPromise(this.dbPromise);
    this.appKv.updateDbPromise(this.dbPromise);
    this.teamChannelLinks.updateDbPromise(this.dbPromise);
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
        provider_order INTEGER,
        stream_type TEXT,
        stream_icon TEXT,
        epg_channel_id TEXT,
        added TEXT,
        custom_sid TEXT,
        tv_archive INTEGER,
        tv_archive_duration INTEGER,
        direct_source TEXT,
        direct_url TEXT,
        xmltv_id TEXT,
        series_no INTEGER,
        live INTEGER,
        is_adult BOOLEAN,
        alias TEXT,
        xtream_stream_id TEXT,
        catchup_type TEXT,
        catchup_source TEXT,
        catchup_days INTEGER
      )`);

    // ─── Versioned migrations via PRAGMA user_version ─────────────────────────
    // Each version block runs exactly ONCE. To add new columns in the future,
    // increment DB_VERSION and add a new case (do NOT modify existing cases).
    // ─────────────────────────────────────────────────────────────────────────
    const DB_VERSION = 24;
    const versionResult = await db.select('PRAGMA user_version') as Array<{ user_version: number }>;
    const currentVersion = versionResult[0]?.user_version ?? 0;

    if (currentVersion < DB_VERSION) {
      console.log(`[DB] Migrating schema from v${currentVersion} to v${DB_VERSION}...`);

      if (currentVersion < 1) {
        // v1: Add columns that were not in the original CREATE TABLE definitions
        const addColumn = async (table: string, col: string, type: string) => {
          try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
        };
        await addColumn('channels', 'direct_url', 'TEXT');
        await addColumn('channels', 'enabled', 'BOOLEAN');
        await addColumn('channels', 'fav_order', 'INTEGER');
        await addColumn('channels', 'display_order', 'INTEGER');
        await addColumn('categories', 'filter_words', 'TEXT');
        await addColumn('sourcesMeta', 'display_order', 'INTEGER');
        await addColumn('vodSeries', 'title', 'TEXT');
        await addColumn('vodSeries', 'last_modified', 'TEXT');
        await addColumn('vodSeries', 'year', 'TEXT');
        await addColumn('vodSeries', 'stream_type', 'TEXT');
        await addColumn('vodSeries', 'stream_icon', 'TEXT');
        await addColumn('vodSeries', 'direct_url', 'TEXT');
        await addColumn('vodSeries', 'rating_5based', 'INTEGER');
        await addColumn('vodSeries', 'category_id', 'TEXT');
        await addColumn('vodSeries', '_stalker_raw_id', 'TEXT');
        await addColumn('vodMovies', 'genre', 'TEXT');
        await addColumn('vodMovies', 'title', 'TEXT');
        await addColumn('vodMovies', 'release_date', 'TEXT');
        await addColumn('vodMovies', 'direct_url', 'TEXT');
        await addColumn('vodEpisodes', 'direct_url', 'TEXT');
        await addColumn('vodEpisodes', 'plot', 'TEXT');
        await addColumn('vodEpisodes', 'duration', 'INTEGER');
        await addColumn('watchlist', 'reminder_enabled', 'BOOLEAN DEFAULT 1');
        await addColumn('watchlist', 'reminder_minutes', 'INTEGER DEFAULT 0');
        await addColumn('watchlist', 'autoswitch_enabled', 'BOOLEAN DEFAULT 0');
        await addColumn('watchlist', 'autoswitch_seconds_before', 'INTEGER DEFAULT 0');
        await addColumn('watchlist', 'reminder_shown', 'BOOLEAN DEFAULT 0');
        await addColumn('watchlist', 'autoswitch_triggered', 'BOOLEAN DEFAULT 0');
        await addColumn('dvr_recordings', 'keep_until', 'INTEGER');
        await addColumn('dvr_recordings', 'auto_delete_policy', 'TEXT DEFAULT "space_needed"');
        // One-time data migration: copy direct_source → direct_url
        try {
          await db.execute('UPDATE vodMovies SET direct_url = direct_source WHERE direct_url IS NULL AND direct_source IS NOT NULL');
          await db.execute('UPDATE vodEpisodes SET direct_url = direct_source WHERE direct_url IS NULL AND direct_source IS NOT NULL');
        } catch { /* columns may not exist on fresh installs */ }
      }

      // v6: Add epg_timeshift_hours to sourcesMeta for per-source EPG timeshift
      if (currentVersion < 6) {
        const addColumn = async (table: string, col: string, type: string) => {
          try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
        };
        await addColumn('sourcesMeta', 'epg_timeshift_hours', 'REAL DEFAULT 0');
      }

      if (currentVersion < 7) {
        // v7: Failover Groups — priority-ordered channel backup lists
        console.log('[DB] v7 migration: Adding failover_groups tables');
        // No ALTER TABLE needed — tables created below via CREATE TABLE IF NOT EXISTS
      }

      if (currentVersion < 8) {
        // v8: Category alias for user-defined display name overrides
        console.log('[DB] v8 migration: Adding alias column to categories');
        const addColumn = async (table: string, col: string, type: string) => {
          try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
        };
        await addColumn('categories', 'alias', 'TEXT');
      }

      if (currentVersion < 9) {
        // v9: Channel alias for user-defined display name overrides
        console.log('[DB] v9 migration: Adding alias column to channels');
        const addColumn = async (table: string, col: string, type: string) => {
          try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
        };
        await addColumn('channels', 'alias', 'TEXT');
      }

      if (currentVersion < 10) {
        // v10: provider_order for preserving M3U/provider channel order
        console.log('[DB] v10 migration: Adding provider_order column to channels');
        const addColumn = async (table: string, col: string, type: string) => {
          try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
        };
        await addColumn('channels', 'provider_order', 'INTEGER');
      }

      if (currentVersion < 11) {
        // v11: is_adult for Stalker portal censored/lock channel tracking
        console.log('[DB] v11 migration: Adding is_adult column to channels');
        const addColumn = async (table: string, col: string, type: string) => {
          try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
        };
        await addColumn('channels', 'is_adult', 'BOOLEAN');
      }

      if (currentVersion < 12) {
        // v12: xtream_stream_id for M3U sources with Xtream catchup support
        console.log('[DB] v12 migration: Adding xtream_stream_id column to channels');
        const addColumn = async (table: string, col: string, type: string) => {
          try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
        };
        await addColumn('channels', 'xtream_stream_id', 'TEXT');
      }

      if (currentVersion < 13) {
        // v13: Custom Playlists
        console.log('[DB] v13 migration: Adding custom_playlists tables');
      }

      if (currentVersion < 14) {
        // v14: Remove custom_playlists foreign key constraints on playlist_id to allow real sources to act as custom destination playlists
        console.log('[DB] v14 migration: Removing playlist_id foreign key constraint from playlist_category_links and playlist_individual_channels');
        try {
          await db.execute('ALTER TABLE playlist_category_links RENAME TO old_playlist_category_links');
          await db.execute(`CREATE TABLE playlist_category_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            playlist_id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            category_id TEXT NOT NULL,
            custom_name TEXT,
            display_order INTEGER DEFAULT 0,
            added_at INTEGER NOT NULL
          )`);
          await db.execute('INSERT INTO playlist_category_links (id, playlist_id, source_id, category_id, custom_name, display_order, added_at) SELECT id, playlist_id, source_id, category_id, custom_name, display_order, added_at FROM old_playlist_category_links');
          await db.execute('DROP TABLE old_playlist_category_links');
        } catch (e) {
          console.error('[DB] Failed to migrate playlist_category_links:', e);
        }

        try {
          await db.execute('ALTER TABLE playlist_individual_channels RENAME TO old_playlist_individual_channels');
          await db.execute(`CREATE TABLE playlist_individual_channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            playlist_id TEXT NOT NULL,
            stream_id TEXT NOT NULL,
            display_order INTEGER DEFAULT 0,
            added_at INTEGER NOT NULL,
            FOREIGN KEY (stream_id) REFERENCES channels(stream_id) ON DELETE CASCADE
          )`);
          await db.execute('INSERT INTO playlist_individual_channels (id, playlist_id, stream_id, display_order, added_at) SELECT id, playlist_id, stream_id, display_order, added_at FROM old_playlist_individual_channels');
          await db.execute('DROP TABLE old_playlist_individual_channels');
        } catch (e) {
          console.error('[DB] Failed to migrate playlist_individual_channels:', e);
        }

        // Recreate indexes
        try {
          await db.execute(`CREATE INDEX IF NOT EXISTS idx_playlist_category_links_playlist ON playlist_category_links(playlist_id)`);
          await db.execute(`CREATE INDEX IF NOT EXISTS idx_playlist_category_links_order ON playlist_category_links(playlist_id, display_order)`);
          await db.execute(`CREATE INDEX IF NOT EXISTS idx_playlist_individual_channels_playlist ON playlist_individual_channels(playlist_id)`);
          await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_individual_channels_unique ON playlist_individual_channels(playlist_id, stream_id)`);
        } catch (e) {
          console.error('[DB] Failed to recreate indexes:', e);
        }
      }

      if (currentVersion < 15) {
        // v15: Add parent_category_id column to playlist_individual_channels
        console.log('[DB] v15 migration: Adding parent_category_id column to playlist_individual_channels');
        try {
          await db.execute('ALTER TABLE playlist_individual_channels ADD COLUMN parent_category_id TEXT');
        } catch (e) {
          console.error('[DB] Failed to add parent_category_id column:', e);
        }
      }

      if (currentVersion < 16) {
        // v16: Remove FOREIGN KEY constraint on stream_id from playlist_individual_channels.
        // The FK is unreliable during import because PRAGMA foreign_keys is per-connection
        // and the Tauri SQL plugin uses connection pooling. Making it a soft reference is
        // consistent with how playlist_category_links works.
        console.log('[DB] v16 migration: Removing stream_id FK from playlist_individual_channels');
        try {
          await db.execute('ALTER TABLE playlist_individual_channels RENAME TO old_playlist_individual_channels_v16');
          await db.execute(`CREATE TABLE playlist_individual_channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            playlist_id TEXT NOT NULL,
            stream_id TEXT NOT NULL,
            parent_category_id TEXT,
            display_order INTEGER DEFAULT 0,
            added_at INTEGER NOT NULL
          )`);
          await db.execute('INSERT INTO playlist_individual_channels (id, playlist_id, stream_id, parent_category_id, display_order, added_at) SELECT id, playlist_id, stream_id, parent_category_id, display_order, added_at FROM old_playlist_individual_channels_v16');
          await db.execute('DROP TABLE old_playlist_individual_channels_v16');
          await db.execute(`CREATE INDEX IF NOT EXISTS idx_playlist_individual_channels_playlist ON playlist_individual_channels(playlist_id)`);
          await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_individual_channels_unique ON playlist_individual_channels(playlist_id, stream_id)`);
        } catch (e) {
          console.error('[DB] Failed to remove stream_id FK from playlist_individual_channels:', e);
        }
      }

      if (currentVersion < 17) {
        // v17: Remove FOREIGN KEY constraints from dvr_schedules, dvr_recordings,
        // custom_group_channels, and failover_group_members.
        //
        // Root cause: tauri-plugin-sql v2 uses sqlx 0.8 which enables
        // PRAGMA foreign_keys = ON by default on EVERY connection in the pool.
        // Import code calls PRAGMA foreign_keys = OFF, but that only affects
        // ONE pool connection — bulkAdd uses other connections that still have
        // FKs enforced, causing (code: 787) FOREIGN KEY constraint failed.
        //
        // Removing FKs from these tables is the reliable fix. ON DELETE CASCADE
        // is replaced by app-level cleanup (delete child rows when deleting parent).
        console.log('[DB] v17 migration: Removing FK constraints from import-affected tables');

        // dvr_schedules: remove FK on source_id → sourcesMeta, channel_id → channels
        try {
          await db.execute('ALTER TABLE dvr_schedules RENAME TO _old_dvr_schedules_v17');
          await db.execute(`CREATE TABLE dvr_schedules (
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
            stream_url TEXT
          )`);
          await db.execute('INSERT INTO dvr_schedules (id,source_id,channel_id,channel_name,program_title,scheduled_start,scheduled_end,start_padding_sec,end_padding_sec,status,series_match_title,recurrence,created_at,started_at,stream_url) SELECT id,source_id,channel_id,channel_name,program_title,scheduled_start,scheduled_end,start_padding_sec,end_padding_sec,status,series_match_title,recurrence,created_at,started_at,NULL FROM _old_dvr_schedules_v17');
          await db.execute('DROP TABLE _old_dvr_schedules_v17');
          await db.execute(`CREATE INDEX IF NOT EXISTS idx_dvr_schedules_status ON dvr_schedules(status)`);
          await db.execute(`CREATE INDEX IF NOT EXISTS idx_dvr_schedules_time ON dvr_schedules(scheduled_start, scheduled_end)`);
          await db.execute(`CREATE INDEX IF NOT EXISTS idx_dvr_schedules_source ON dvr_schedules(source_id)`);
        } catch (e) {
          console.error('[DB] v17: Failed to migrate dvr_schedules:', e);
        }

        // dvr_recordings: remove FK on schedule_id → dvr_schedules
        try {
          await db.execute('ALTER TABLE dvr_recordings RENAME TO _old_dvr_recordings_v17');
          await db.execute(`CREATE TABLE dvr_recordings (
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
            thumbnail_path TEXT
          )`);
          await db.execute('INSERT INTO dvr_recordings (id,schedule_id,file_path,filename,size_bytes,channel_name,program_title,scheduled_start,scheduled_end,actual_start,actual_end,duration_sec,status,error_message,keep_until,auto_delete_policy,created_at,thumbnail_path) SELECT id,schedule_id,file_path,filename,size_bytes,channel_name,program_title,scheduled_start,scheduled_end,actual_start,actual_end,duration_sec,status,error_message,keep_until,auto_delete_policy,created_at,NULL FROM _old_dvr_recordings_v17');
          await db.execute('DROP TABLE _old_dvr_recordings_v17');
          await db.execute(`CREATE INDEX IF NOT EXISTS idx_dvr_recordings_schedule ON dvr_recordings(schedule_id)`);
          await db.execute(`CREATE INDEX IF NOT EXISTS idx_dvr_recordings_status ON dvr_recordings(status)`);
          await db.execute(`CREATE INDEX IF NOT EXISTS idx_dvr_recordings_keep ON dvr_recordings(keep_until)`);
        } catch (e) {
          console.error('[DB] v17: Failed to migrate dvr_recordings:', e);
        }

        // custom_group_channels: remove FK on group_id → custom_groups, stream_id → channels
        try {
          await db.execute('ALTER TABLE custom_group_channels RENAME TO _old_custom_group_channels_v17');
          await db.execute(`CREATE TABLE custom_group_channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            stream_id TEXT NOT NULL,
            display_order INTEGER,
            added_at INTEGER
          )`);
          await db.execute('INSERT INTO custom_group_channels SELECT * FROM _old_custom_group_channels_v17');
          await db.execute('DROP TABLE _old_custom_group_channels_v17');
          await db.execute(`CREATE INDEX IF NOT EXISTS idx_custom_group_channels_group ON custom_group_channels(group_id)`);
          await db.execute(`CREATE INDEX IF NOT EXISTS idx_custom_group_channels_stream ON custom_group_channels(stream_id)`);
          await db.execute(`CREATE INDEX IF NOT EXISTS idx_custom_group_channels_order ON custom_group_channels(group_id, display_order)`);
        } catch (e) {
          console.error('[DB] v17: Failed to migrate custom_group_channels:', e);
        }

        // failover_group_members: remove FK on group_id → failover_groups, stream_id → channels
        try {
          await db.execute('ALTER TABLE failover_group_members RENAME TO _old_failover_group_members_v17');
          await db.execute(`CREATE TABLE failover_group_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            stream_id TEXT NOT NULL UNIQUE,
            priority INTEGER NOT NULL DEFAULT 0
          )`);
          await db.execute('INSERT INTO failover_group_members SELECT * FROM _old_failover_group_members_v17');
          await db.execute('DROP TABLE _old_failover_group_members_v17');
          await db.execute(`CREATE INDEX IF NOT EXISTS idx_failover_members_group ON failover_group_members(group_id, priority)`);
          await db.execute(`CREATE INDEX IF NOT EXISTS idx_failover_members_stream ON failover_group_members(stream_id)`);
        } catch (e) {
          console.error('[DB] v17: Failed to migrate failover_group_members:', e);
        }
      }

      if (currentVersion < 2) {
        // v2: EPG Editor — new override tables and views (safe to run on existing DBs)
        // Tables are created via CREATE TABLE IF NOT EXISTS below, so this block only
        // handles the view recreation (DROP + CREATE to pick up any definition changes).
        try { await db.execute('DROP VIEW IF EXISTS programs_effective'); } catch { /* */ }
        try { await db.execute('DROP VIEW IF EXISTS epg_channels_effective'); } catch { /* */ }
      }

      if (currentVersion < 3) {
        // v3: VOD Watch History — new table for tracking recently watched content
        // Table is created via CREATE TABLE IF NOT EXISTS below, so this block is minimal
        console.log('[DB] v3 migration: VOD Watch History table added');
      }

      if (currentVersion < 4) {
        // v4: Episode Watch History — new table for tracking episode-level progress
        // Table is created via CREATE TABLE IF NOT EXISTS below, so this block is minimal
        console.log('[DB] v4 migration: Episode Watch History table added');
      }

      if (currentVersion < 5) {
        // v5: Add season/episode columns to vod_history for series tracking
        const addColumn = async (table: string, col: string, type: string) => {
          try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
        };
        await addColumn('vod_history', 'season_num', 'INTEGER');
        await addColumn('vod_history', 'episode_num', 'INTEGER');
        await addColumn('vod_history', 'episode_title', 'TEXT');
        console.log('[DB] v5 migration: Added season/episode columns to vod_history');
      }

      if (currentVersion < 18) {
        // v18: Add progress_seconds and last_watched_at columns to dvr_recordings
        console.log('[DB] v18 migration: Adding watch progress columns to dvr_recordings');
        const addColumn = async (table: string, col: string, type: string) => {
          try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
        };
        await addColumn('dvr_recordings', 'progress_seconds', 'INTEGER DEFAULT 0');
        await addColumn('dvr_recordings', 'last_watched_at', 'INTEGER');
      }

      // v19: Add subtitle column to programs and epg_program_overrides
      if (currentVersion < 19) {
        console.log('[DB] v19 migration: Adding subtitle column to programs and epg_program_overrides');
        const addColumn = async (table: string, col: string, type: string) => {
          try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
        };
        await addColumn('programs', 'subtitle', 'TEXT');
        await addColumn('epg_program_overrides', 'subtitle', 'TEXT');
      }

      // v20: Add tv_archive_duration to channels (hours of Stalker catch-up archive)
      if (currentVersion < 20) {
        console.log('[DB] v20 migration: Adding tv_archive_duration column to channels');
        try { await db.execute('ALTER TABLE channels ADD COLUMN tv_archive_duration INTEGER'); } catch { /* already exists */ }
      }

      // v21: Reset tv_archive to 0 for standard Stalker channels (direct_url LIKE 'stalker_ch:%')
      if (currentVersion < 21) {
        console.log('[DB] v21 migration: Clearing tv_archive flag for standard Stalker STB channels');
        try {
          await db.execute(`UPDATE channels SET tv_archive = 0, tv_archive_duration = NULL WHERE direct_url LIKE 'stalker_ch:%'`);
        } catch (e) {
          console.warn('[DB] v21 migration failed:', e);
        }
      }

      // v22: Add catchup_type, catchup_source, catchup_days to channels
      if (currentVersion < 22) {
        console.log('[DB] v22 migration: Adding M3U catchup columns to channels');
        const addColumn = async (table: string, col: string, type: string) => {
          try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
        };
        await addColumn('channels', 'catchup_type', 'TEXT');
        await addColumn('channels', 'catchup_source', 'TEXT');
        await addColumn('channels', 'catchup_days', 'INTEGER');
      }

      // v23: Add per-channel logo background override (auto/light/dark) for the EPG editor
      if (currentVersion < 23) {
        console.log('[DB] v23 migration: Adding logo_background column to epg_channel_overrides');
        const addColumn = async (table: string, col: string, type: string) => {
          try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
        };
        await addColumn('epg_channel_overrides', 'logo_background', 'TEXT');
      }

      // v24: Add per-channel logo padding override (default/none) for the Logo editor
      if (currentVersion < 24) {
        console.log('[DB] v24 migration: Adding logo_padding column to epg_channel_overrides');
        const addColumn = async (table: string, col: string, type: string) => {
          try { await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
        };
        await addColumn('epg_channel_overrides', 'logo_padding', 'TEXT');
      }

      // Bump the stored version so these migrations never run again
      await db.execute(`PRAGMA user_version = ${DB_VERSION}`);
      console.log(`[DB] Migration to v${DB_VERSION} complete`);
    }
    // ──────────────────────────────────────────────────────────────────────────

    await db.execute(`CREATE INDEX IF NOT EXISTS idx_channels_source ON channels(source_id)`);
    // Index for fast name search (LIKE queries)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name COLLATE NOCASE)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_channels_epg ON channels(epg_channel_id)`);


    // Categories
    await db.execute(`CREATE TABLE IF NOT EXISTS categories (
        category_id TEXT PRIMARY KEY,
        source_id TEXT,
        category_name TEXT,
        parent_id INTEGER,
        enabled BOOLEAN,
        display_order INTEGER,
        channel_count INTEGER,
        filter_words TEXT,
        alias TEXT
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
        error TEXT,
        display_order INTEGER,
        epg_timeshift_hours REAL DEFAULT 0
      )`);

    // Prefs
    await db.execute(`CREATE TABLE IF NOT EXISTS prefs (
        key TEXT PRIMARY KEY,
        value TEXT
      )`);

    // app_kv - generic key/value store for UI state that used to live in
    // localStorage (e.g. the Stremio library/watch-history). Keeping it in
    // SQLite means it never competes for the WebView2 localStorage quota
    // (~10 MB) that some power users exhaust.
    await db.execute(`CREATE TABLE IF NOT EXISTS app_kv (
        key TEXT PRIMARY KEY,
        value TEXT
      )`);

    // Team channel links — maps a sports team to a provider channel so games
    // can be watched with one tap without searching.
    await db.execute(`CREATE TABLE IF NOT EXISTS team_channel_links (
        id TEXT PRIMARY KEY,
        league_id TEXT,
        team_id TEXT,
        stream_id TEXT,
        channel_name TEXT,
        source_id TEXT,
        auto INTEGER,
        confidence REAL,
        updated_at INTEGER
      )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_team_channel_links_league ON team_channel_links(league_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_team_channel_links_stream ON team_channel_links(stream_id)`);

    // Programs (EPG)
    await db.execute(`CREATE TABLE IF NOT EXISTS programs (
        id TEXT PRIMARY KEY,
        stream_id TEXT,
        title TEXT,
        subtitle TEXT,
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

    // EPG Channels (for fallback matching when tvg-id doesn't match)
    await db.execute(`CREATE TABLE IF NOT EXISTS epg_channels (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        icon_url TEXT,
        source_id TEXT
      )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_epg_channels_source ON epg_channels(source_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_epg_channels_name ON epg_channels(display_name COLLATE NOCASE)`);

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
        genre TEXT,
        duration_secs INTEGER,
        duration TEXT,
        stream_icon TEXT,
        direct_url TEXT,
        release_date TEXT,
        title TEXT
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
        year TEXT,
        stream_type TEXT,
        stream_icon TEXT,
        direct_url TEXT,
        rating_5based REAL,
        category_id TEXT,
        _stalker_raw_id TEXT
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

    // DVR Schedules (no FK constraints — see v17 migration note)
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
      stream_url TEXT
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_dvr_schedules_status ON dvr_schedules(status)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_dvr_schedules_time ON dvr_schedules(scheduled_start, scheduled_end)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_dvr_schedules_source ON dvr_schedules(source_id)`);

    // DVR Recordings (no FK constraints — see v17 migration note)
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
      thumbnail_path TEXT,
      progress_seconds INTEGER DEFAULT 0,
      last_watched_at INTEGER
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

    // Custom Groups
    await db.execute(`CREATE TABLE IF NOT EXISTS custom_groups (
        group_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        display_order INTEGER,
        created_at INTEGER
      )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_custom_groups_order ON custom_groups(display_order)`);

    // Custom Group Channels (no FK constraints — see v17 migration note)
    await db.execute(`CREATE TABLE IF NOT EXISTS custom_group_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        display_order INTEGER,
        added_at INTEGER
      )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_custom_group_channels_group ON custom_group_channels(group_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_custom_group_channels_stream ON custom_group_channels(stream_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_custom_group_channels_order ON custom_group_channels(group_id, display_order)`);

    // Failover Groups
    await db.execute(`CREATE TABLE IF NOT EXISTS failover_groups (
      group_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);

    // Failover Group Members (no FK constraints — see v17 migration note)
    await db.execute(`CREATE TABLE IF NOT EXISTS failover_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      stream_id TEXT NOT NULL UNIQUE,
      priority INTEGER NOT NULL DEFAULT 0
    )`);

    await db.execute(`CREATE INDEX IF NOT EXISTS idx_failover_members_group
      ON failover_group_members(group_id, priority)`);

    await db.execute(`CREATE INDEX IF NOT EXISTS idx_failover_members_stream
      ON failover_group_members(stream_id)`);

    // Custom Playlists
    await db.execute(`CREATE TABLE IF NOT EXISTS custom_playlists (
      playlist_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      display_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_custom_playlists_order ON custom_playlists(display_order)`);

    await db.execute(`CREATE TABLE IF NOT EXISTS playlist_category_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      custom_name TEXT,
      display_order INTEGER DEFAULT 0,
      added_at INTEGER NOT NULL
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_playlist_category_links_playlist ON playlist_category_links(playlist_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_playlist_category_links_order ON playlist_category_links(playlist_id, display_order)`);

    await db.execute(`CREATE TABLE IF NOT EXISTS playlist_individual_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      parent_category_id TEXT,
      display_order INTEGER DEFAULT 0,
      added_at INTEGER NOT NULL
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_playlist_individual_channels_playlist ON playlist_individual_channels(playlist_id)`);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_individual_channels_unique ON playlist_individual_channels(playlist_id, stream_id)`);

    // Category Folders
    await db.execute(`CREATE TABLE IF NOT EXISTS category_folders (
      folder_id TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL,
      name TEXT NOT NULL,
      display_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_category_folders_playlist ON category_folders(playlist_id)`);
    try { await db.execute(`ALTER TABLE categories ADD COLUMN folder_id TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE playlist_category_links ADD COLUMN folder_id TEXT`); } catch (e) {}

    // Migration: Add missing columns for optimized bulk operations (VOD sync fix)
    // These columns were added after initial schema creation for faster bulk upserts
    try { await db.execute(`ALTER TABLE vodMovies ADD COLUMN genre TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE vodMovies ADD COLUMN release_date TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE vodMovies ADD COLUMN title TEXT`); } catch (e) {}

    try { await db.execute(`ALTER TABLE vodSeries ADD COLUMN year TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE vodSeries ADD COLUMN stream_icon TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE vodSeries ADD COLUMN direct_url TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE vodSeries ADD COLUMN rating_5based REAL`); } catch (e) {}
    try { await db.execute(`ALTER TABLE vodSeries ADD COLUMN category_id TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE vodSeries ADD COLUMN _stalker_raw_id TEXT`); } catch (e) {}

    // Add enabled and display_order columns to vodCategories
    try { await db.execute(`ALTER TABLE vodCategories ADD COLUMN enabled INTEGER DEFAULT 1`); } catch (e) {}
    try { await db.execute(`ALTER TABLE vodCategories ADD COLUMN display_order INTEGER`); } catch (e) {}

    // Self-healing: guarantee epg_channel_overrides.logo_background and logo_padding exist even if the
    // versioned migration ran on a stale schema (or the column is missing for any reason).
    try { await db.execute(`ALTER TABLE epg_channel_overrides ADD COLUMN logo_background TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE epg_channel_overrides ADD COLUMN logo_padding TEXT`); } catch (e) {}

    // Self-healing migrations: Ensure critical columns from standard migrations exist
    try { await db.execute(`ALTER TABLE categories ADD COLUMN alias TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE channels ADD COLUMN alias TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE channels ADD COLUMN xtream_stream_id TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE programs ADD COLUMN subtitle TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE epg_program_overrides ADD COLUMN subtitle TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE team_channel_links ADD COLUMN priority INTEGER DEFAULT 0`); } catch (e) {}

    // ── EPG Editor: Override Tables ───────────────────────────────────────────

    // Per-channel EPG identity overrides (tvg-id, logo, timeshift)
    await db.execute(`CREATE TABLE IF NOT EXISTS epg_channel_overrides (
      stream_id       TEXT PRIMARY KEY,
      epg_channel_id  TEXT,
      stream_icon     TEXT,
      logo_background TEXT,
      logo_padding    TEXT,
      timeshift_hours REAL
    )`);

    // Per-program overrides (edited fields) + custom programs + tombstones
    await db.execute(`CREATE TABLE IF NOT EXISTS epg_program_overrides (
      id          TEXT PRIMARY KEY,
      stream_id   TEXT NOT NULL,
      title       TEXT,
      subtitle    TEXT,
      description TEXT,
      start       TEXT,
      end         TEXT,
      is_deleted  INTEGER DEFAULT 0,
      is_custom   INTEGER DEFAULT 0
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_epg_prog_override_stream ON epg_program_overrides(stream_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_epg_prog_override_custom ON epg_program_overrides(stream_id, is_custom)`);

    // VOD Watch History - tracks recently watched movies and series
    await db.execute(`CREATE TABLE IF NOT EXISTS vod_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'series')),
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      watched_at INTEGER NOT NULL,
      progress_seconds INTEGER,
      total_duration INTEGER,
      poster_url TEXT,
      season_num INTEGER,
      episode_num INTEGER,
      episode_title TEXT
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_vod_history_watched_at ON vod_history(watched_at DESC)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_vod_history_media ON vod_history(media_id, media_type)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_vod_history_source ON vod_history(source_id)`);

    // Episode Watch History - tracks progress for individual episodes
    await db.execute(`CREATE TABLE IF NOT EXISTS episode_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id TEXT NOT NULL UNIQUE,
      series_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      season_num INTEGER NOT NULL,
      episode_num INTEGER NOT NULL,
      title TEXT,
      watched_at INTEGER NOT NULL,
      progress_seconds INTEGER,
      total_duration INTEGER,
      completed INTEGER DEFAULT 0
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_episode_history_series ON episode_history(series_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_episode_history_episode ON episode_history(episode_id)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_episode_history_watched ON episode_history(watched_at DESC)`);

    // ── programs_effective VIEW ───────────────────────────────────────────────
    // Always DROP + CREATE so the definition is guaranteed to be current,
    // even on DBs that had a previous (possibly stale) version of the view.
    // View DDL is essentially free so this is safe to do every startup.
    //
    // TIMESHIFT DESIGN:
    // - sm.epg_timeshift_hours (source-level, set in Source settings) shifts all
    //   channels for that source uniformly. Updated immediately on save.
    // - co.timeshift_hours (per-channel, set via EPG Editor) shifts a single
    //   channel. Updated immediately on save.
    // - Both are applied combined in one strftime() call to avoid chained shifts.
    // - When the combined shift is 0 we return p.start RAW so the UTC 'Z' suffix
    //   is preserved and JavaScript parses it correctly as UTC.
    //   (strftime/datetime strip the Z, causing JS to misread the time as local.)
    await db.execute(`DROP VIEW IF EXISTS programs_effective`);
    await db.execute(`CREATE VIEW programs_effective AS
      SELECT
        p.id,
        p.stream_id,
        COALESCE(o.title,       p.title)       AS title,
        COALESCE(o.subtitle,    p.subtitle)    AS subtitle,
        COALESCE(o.description, p.description) AS description,
        COALESCE(o.start,
          CASE WHEN IFNULL(sm.epg_timeshift_hours, 0) + IFNULL(co.timeshift_hours, 0) = 0
            THEN p.start
            ELSE strftime('%Y-%m-%dT%H:%M:%SZ', p.start,
                   CAST((IFNULL(sm.epg_timeshift_hours, 0) + IFNULL(co.timeshift_hours, 0)) * 60 AS INTEGER) || ' minutes')
          END
        ) AS start,
        COALESCE(o.end,
          CASE WHEN IFNULL(sm.epg_timeshift_hours, 0) + IFNULL(co.timeshift_hours, 0) = 0
            THEN p.end
            ELSE strftime('%Y-%m-%dT%H:%M:%SZ', p.end,
                   CAST((IFNULL(sm.epg_timeshift_hours, 0) + IFNULL(co.timeshift_hours, 0)) * 60 AS INTEGER) || ' minutes')
          END
        ) AS end,
        p.start AS raw_start,
        p.source_id,
        0 AS is_custom
      FROM programs p
      LEFT JOIN sourcesMeta sm ON sm.source_id = p.source_id
      LEFT JOIN epg_channel_overrides co ON co.stream_id = p.stream_id
      LEFT JOIN epg_program_overrides o ON o.id = p.id AND o.is_custom = 0
      WHERE COALESCE(o.is_deleted, 0) = 0
      UNION ALL
      SELECT
        id,
        stream_id,
        title,
        subtitle,
        description,
        start,
        end,
        NULL AS raw_start,
        '' AS source_id,
        1  AS is_custom
      FROM epg_program_overrides
      WHERE is_custom = 1 AND is_deleted = 0
    `);

    // ── channels_effective VIEW ───────────────────────────────────────────────
    // Merges the raw channel with logo/epg_channel_id overrides from the editor.
    // Always DROP + CREATE so the definition is current on every startup.
    await db.execute(`DROP VIEW IF EXISTS channels_effective`);
    await db.execute(`CREATE VIEW channels_effective AS
      SELECT
        c.stream_id,
        c.source_id,
        c.name,
        COALESCE(o.stream_icon,      c.stream_icon)      AS stream_icon,
        o.logo_background                                  AS logo_background,
        COALESCE(o.epg_channel_id,   c.epg_channel_id)   AS epg_channel_id,
        c.channel_num,
        c.is_favorite,
        c.enabled,
        c.category_ids,
        c.tv_archive,
        c.tv_archive_duration,
        c.direct_source,
        c.direct_url,
        c.added,
        c.xtream_stream_id
      FROM channels c
      LEFT JOIN epg_channel_overrides o ON o.stream_id = c.stream_id
    `);

    // ──────────────────────────────────────────────────────────────────────────
    // Clean up any old backup tables from failed migrations to prevent FOREIGN KEY constraint issues on delete/clear.
    const oldBackupTables = [
      '_old_dvr_schedules_v17',
      '_old_dvr_recordings_v17',
      '_old_custom_group_channels_v17',
      '_old_failover_group_members_v17',
      'old_playlist_individual_channels_v16',
      'old_playlist_individual_channels',
      'old_playlist_category_links'
    ];
    for (const table of oldBackupTables) {
      try {
        await db.execute(`DROP TABLE IF EXISTS ${table}`);
      } catch (e) {
        console.warn(`[DB] Failed to drop clean-up table ${table}:`, e);
      }
    }

    // Self-healing: Clean up orphaned failover group members and custom group channels
    try {
      await db.execute(`
        DELETE FROM failover_group_members 
        WHERE group_id NOT IN (SELECT group_id FROM failover_groups)
           OR stream_id NOT IN (SELECT stream_id FROM channels)
      `);
      console.log('[DB] Cleaned up orphaned/invalid failover group members');
    } catch (e) {
      console.warn('[DB] Failed to clean up orphaned failover group members:', e);
    }

    try {
      await db.execute(`
        DELETE FROM custom_group_channels 
        WHERE group_id NOT IN (SELECT group_id FROM custom_groups)
           OR stream_id NOT IN (SELECT stream_id FROM channels)
      `);
      console.log('[DB] Cleaned up orphaned/invalid custom group channels');
    } catch (e) {
      console.warn('[DB] Failed to clean up orphaned custom group channels:', e);
    }

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
// Also clears dvr_schedules/recordings since they reference channels (stale after source clear).
// Keeps: prefs, Tauri Store settings, source configs, dvr_settings, custom_groups, watchlist,
// and localStorage user data (VOD favorites, VOD playlists, UI layout) — never clear those here.
export async function clearAllCachedData(): Promise<void> {
  // Use the adapter's .clear() rather than raw SQL transactions — Tauri's connection pool
  // means BEGIN/COMMIT may run on different connections, causing "no transaction active" errors.
  // .clear() uses the writeLock mutex so each DELETE runs safely and notifies reactive queries.

  // 0. Backup user customizations first (enabled/disabled states, favorites, aliases, display order, etc.)
  await backupUserCustomizations();

  // IMPORTANT: Delete in order of foreign key dependencies (children first, parents last)
  // dvr_recordings -> dvr_schedules (FK on schedule_id)
  // dvr_schedules -> channels, sourcesMeta (FK on source_id, channel_id)
  // programs -> channels (implicit FK on stream_id)
  // custom_group_channels -> channels, custom_groups

  // 1. Delete child tables with FK dependencies first
  await db.dvrRecordings.clear();      // Has FK to dvr_schedules

  // 2. Delete parent tables that are referenced by others
  await db.dvrSchedules.clear();       // Referenced by dvr_recordings, refs channels/sourcesMeta
  await db.programs.clear();           // References channels

  // 3. Delete main entity tables (no incoming FKs)
  await db.channels.clear();
  await db.categories.clear();
  await db.sourcesMeta.clear();
  await db.epgChannels.clear();

  // 4. Delete VOD tables
  await db.vodEpisodes.clear();        // Has FK to vodSeries
  await db.vodMovies.clear();
  await db.vodSeries.clear();
  await db.vodCategories.clear();

  // 5. Checkpoint WAL to main database and truncate WAL file
  // TRUNCATE = copy all WAL pages to main DB, then reset WAL to 0 bytes
  await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');

  // 6. Vacuum the database to reclaim disk space
  // VACUUM rebuilds the database file, repacking it into a minimal amount of disk space
  await db.execute('VACUUM');
}

interface CustomizationBackup {
  channels: Array<{
    stream_id: string;
    enabled?: boolean;
    is_favorite?: boolean;
    alias?: string;
    fav_order?: number;
    display_order?: number;
  }>;
  categories: Array<{
    category_id: string;
    enabled?: boolean;
    alias?: string;
    display_order?: number;
    filter_words?: any;
    folder_id?: string | null;
  }>;
  vodCategories: Array<{
    category_id: string;
    enabled?: boolean;
    display_order?: number;
  }>;
}

/** Backup user customizations to prefs table */
export async function backupUserCustomizations(): Promise<void> {
  try {
    // 1. Get customized channels: enabled=false, is_favorite=true, or customized alias/display_order/fav_order
    const customizedChannels = await db.channels
      .whereRaw("(enabled = 0 OR enabled = 'false' OR is_favorite = 1 OR is_favorite = 'true' OR alias IS NOT NULL OR display_order IS NOT NULL OR fav_order IS NOT NULL)")
      .toArray();

    // 2. Get customized categories: enabled=false, or customized alias/display_order/filter_words/folder_id
    const customizedCategories = await db.categories
      .whereRaw("(enabled = 0 OR enabled = 'false' OR alias IS NOT NULL OR display_order IS NOT NULL OR filter_words IS NOT NULL OR folder_id IS NOT NULL)")
      .toArray();

    // 3. Get customized VOD categories: enabled=false, or customized display_order
    const customizedVodCategories = await db.vodCategories
      .whereRaw("(enabled = 0 OR enabled = 'false' OR display_order IS NOT NULL)")
      .toArray();

    const backup: CustomizationBackup = {
      channels: customizedChannels.map(c => ({
        stream_id: c.stream_id,
        enabled: c.enabled,
        is_favorite: c.is_favorite,
        alias: c.alias,
        fav_order: c.fav_order,
        display_order: c.display_order
      })),
      categories: customizedCategories.map(c => ({
        category_id: c.category_id,
        enabled: c.enabled,
        alias: c.alias,
        display_order: c.display_order,
        filter_words: c.filter_words,
        folder_id: c.folder_id
      })),
      vodCategories: customizedVodCategories.map(c => ({
        category_id: c.category_id,
        enabled: c.enabled,
        display_order: c.display_order
      }))
    };

    console.log(`[Backup] Backing up customizations: ${backup.channels.length} channels, ${backup.categories.length} categories, ${backup.vodCategories.length} VOD categories`);
    await db.prefs.put({ key: 'clear_cache_user_customizations_backup', value: JSON.stringify(backup) });
  } catch (err) {
    console.error('[Backup] Failed to backup user customizations:', err);
  }
}

/** Restore user customizations incrementally from prefs table */
export async function restoreUserCustomizations(): Promise<void> {
  try {
    const backupPref = await db.prefs.get('clear_cache_user_customizations_backup');
    if (!backupPref || !backupPref.value) return;

    const backup: CustomizationBackup = JSON.parse(backupPref.value);
    let changed = false;

    // 1. Restore categories
    if (backup.categories && backup.categories.length > 0) {
      const remainingCategories: any[] = [];
      for (const cat of backup.categories) {
        const dbCat = await db.categories.get(cat.category_id);
        if (dbCat) {
          const updates: any = {};
          if (cat.enabled !== undefined) updates.enabled = cat.enabled;
          if (cat.alias !== undefined) updates.alias = cat.alias;
          if (cat.display_order !== undefined) updates.display_order = cat.display_order;
          if (cat.filter_words !== undefined) updates.filter_words = cat.filter_words;
          if (cat.folder_id !== undefined) updates.folder_id = cat.folder_id;

          await db.categories.update(cat.category_id, updates);
          changed = true;
        } else {
          remainingCategories.push(cat);
        }
      }
      backup.categories = remainingCategories;
    }

    // 2. Restore channels
    if (backup.channels && backup.channels.length > 0) {
      const remainingChannels: any[] = [];
      const channelsToRestore = [];
      for (const ch of backup.channels) {
        const dbCh = await db.channels.get(ch.stream_id);
        if (dbCh) {
          channelsToRestore.push(ch);
        } else {
          remainingChannels.push(ch);
        }
      }

      if (channelsToRestore.length > 0) {
        console.log(`[Restore] Restoring customizations for ${channelsToRestore.length} channels`);
        await Promise.all(channelsToRestore.map(ch => {
          const updates: any = {};
          if (ch.enabled !== undefined) updates.enabled = ch.enabled;
          if (ch.is_favorite !== undefined) updates.is_favorite = ch.is_favorite;
          if (ch.alias !== undefined) updates.alias = ch.alias;
          if (ch.fav_order !== undefined) updates.fav_order = ch.fav_order;
          if (ch.display_order !== undefined) updates.display_order = ch.display_order;
          return db.channels.update(ch.stream_id, updates);
        }));
        changed = true;
      }
      backup.channels = remainingChannels;
    }

    // 3. Restore VOD categories
    if (backup.vodCategories && backup.vodCategories.length > 0) {
      const remainingVodCategories: any[] = [];
      for (const cat of backup.vodCategories) {
        const dbCat = await db.vodCategories.get(cat.category_id);
        if (dbCat) {
          const updates: any = {};
          if (cat.enabled !== undefined) updates.enabled = cat.enabled;
          if (cat.display_order !== undefined) updates.display_order = cat.display_order;
          await db.vodCategories.update(cat.category_id, updates);
          changed = true;
        } else {
          remainingVodCategories.push(cat);
        }
      }
      backup.vodCategories = remainingVodCategories;
    }

    // 4. Save remaining backup or delete if empty
    const totalRemaining = (backup.channels?.length || 0) + (backup.categories?.length || 0) + (backup.vodCategories?.length || 0);
    if (totalRemaining > 0) {
      if (changed) {
        await db.prefs.put({ key: 'clear_cache_user_customizations_backup', value: JSON.stringify(backup) });
        console.log(`[Restore] Restored some customizations. Remaining: ${totalRemaining} items in backup.`);
      }
    } else {
      await db.prefs.delete('clear_cache_user_customizations_backup');
      console.log(`[Restore] All customizations successfully restored and backup cleared!`);
    }
  } catch (err) {
    console.error('[Restore] Failed to restore user customizations:', err);
  }
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

/** Update category alias (user-defined display name override) */
export async function updateCategoryAlias(categoryId: string, alias: string | undefined) {
  await db.categories.update(categoryId, { alias: alias || undefined });
}

/** Update channel alias (user-defined display name override) */
export async function updateChannelAlias(channelId: string, alias: string | undefined) {
  await db.channels.update(channelId, { alias: alias || undefined });
}

/** Update multiple categories' order */
export async function updateCategoriesOrder(updates: { categoryId: string; displayOrder: number }[]) {
  await updateCategoriesBatch(updates.map(u => ({ categoryId: u.categoryId, displayOrder: u.displayOrder })));
}

/** Batch update channels (enabled state, display order, and/or fav order) in a single SQL statement */
export async function updateChannelsBatch(
  updates: Array<{ streamId: string; enabled?: boolean; displayOrder?: number; favOrder?: number }>
): Promise<number> {
  if (updates.length === 0) return 0;

  const dbInstance = await (db as any).dbPromise;
  let totalUpdated = 0;
  const CHUNK_SIZE = 120; // 3 columns max, stay well under SQLite 999 param limit

  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE);
    const caseParts: string[] = [];
    const params: any[] = [];

    if (chunk.some(u => u.enabled !== undefined)) {
      const cases = chunk
        .filter(u => u.enabled !== undefined)
        .map(u => {
          params.push(u.streamId, u.enabled ? 1 : 0);
          return `WHEN $${params.length - 1} THEN $${params.length}`;
        })
        .join(' ');
      caseParts.push(`enabled = CASE stream_id ${cases} ELSE enabled END`);
    }

    if (chunk.some(u => u.displayOrder !== undefined)) {
      const cases = chunk
        .filter(u => u.displayOrder !== undefined)
        .map(u => {
          params.push(u.streamId, u.displayOrder);
          return `WHEN $${params.length - 1} THEN $${params.length}`;
        })
        .join(' ');
      caseParts.push(`display_order = CASE stream_id ${cases} ELSE display_order END`);
    }

    if (chunk.some(u => u.favOrder !== undefined)) {
      const cases = chunk
        .filter(u => u.favOrder !== undefined)
        .map(u => {
          params.push(u.streamId, u.favOrder);
          return `WHEN $${params.length - 1} THEN $${params.length}`;
        })
        .join(' ');
      caseParts.push(`fav_order = CASE stream_id ${cases} ELSE fav_order END`);
    }

    if (caseParts.length === 0) continue;

    const idParams = chunk.map((_, idx) => `$${params.length + idx + 1}`).join(',');
    chunk.forEach(u => params.push(u.streamId));

    const sql = `UPDATE channels SET ${caseParts.join(', ')} WHERE stream_id IN (${idParams})`;
    const result = await dbInstance.execute(sql, params);
    totalUpdated += result.rowsAffected ?? chunk.length;
  }

  const { dbEvents } = await import('./sqlite-adapter');
  dbEvents.notify('channels', 'update');
  return totalUpdated;
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

/** Batch update categories (enabled state and/or display order) in a single SQL statement */
export async function updateCategoriesBatch(
  updates: Array<{ categoryId: string; enabled?: boolean; displayOrder?: number; folderId?: string | null }>
): Promise<number> {
  if (updates.length === 0) return 0;

  const dbInstance = await (db as any).dbPromise;
  let totalUpdated = 0;

  // SQLite default param limit is 999. Each update uses ~5 params max (2 per CASE column + 1 IN).
  // Chunk to stay well under the limit.
  const CHUNK_SIZE = 150;

  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE);
    const hasEnabled = chunk.some(u => u.enabled !== undefined);
    const hasOrder = chunk.some(u => u.displayOrder !== undefined);
    const hasFolder = chunk.some(u => u.folderId !== undefined);

    // Build CASE statements for each column being updated
    const caseParts: string[] = [];
    const params: any[] = [];

    if (hasEnabled) {
      const enabledCases = chunk
        .filter(u => u.enabled !== undefined)
        .map(u => {
          params.push(u.categoryId, u.enabled ? 1 : 0);
          return `WHEN $${params.length - 1} THEN $${params.length}`;
        })
        .join(' ');
      caseParts.push(`enabled = CASE category_id ${enabledCases} ELSE enabled END`);
    }

    if (hasOrder) {
      const orderCases = chunk
        .filter(u => u.displayOrder !== undefined)
        .map(u => {
          params.push(u.categoryId, u.displayOrder);
          return `WHEN $${params.length - 1} THEN $${params.length}`;
        })
        .join(' ');
      caseParts.push(`display_order = CASE category_id ${orderCases} ELSE display_order END`);
    }

    if (hasFolder) {
      const folderCases = chunk
        .filter(u => u.folderId !== undefined)
        .map(u => {
          params.push(u.categoryId, u.folderId || null);
          return `WHEN $${params.length - 1} THEN $${params.length}`;
        })
        .join(' ');
      caseParts.push(`folder_id = CASE category_id ${folderCases} ELSE folder_id END`);
    }

    if (caseParts.length === 0) continue;

    // Build IN clause for WHERE
    const idParams = chunk.map((_, idx) => `$${params.length + idx + 1}`).join(',');
    chunk.forEach(u => params.push(u.categoryId));

    const sql = `UPDATE categories SET ${caseParts.join(', ')} WHERE category_id IN (${idParams})`;
    const result = await dbInstance.execute(sql, params);
    totalUpdated += result.rowsAffected ?? chunk.length;
  }

  // Single notification for the bulk change
  const { dbEvents } = await import('./sqlite-adapter');
  dbEvents.notify('categories', 'update');

  return totalUpdated;
}

/** Enable all categories for a source */
export async function enableAllSourceCategories(sourceId: string) {
  const dbInstance = await (db as any).dbPromise;
  await dbInstance.execute(
    'UPDATE categories SET enabled = 1 WHERE source_id = ?',
    [sourceId]
  );
  dbEvents.notify('categories', 'update');
}

/** Disable all categories for a source */
export async function disableAllSourceCategories(sourceId: string) {
  const dbInstance = await (db as any).dbPromise;
  await dbInstance.execute(
    'UPDATE categories SET enabled = 0 WHERE source_id = ?',
    [sourceId]
  );
  dbEvents.notify('categories', 'update');
}

/** Batch update failover group member priorities in a single SQL statement */
export async function updateFailoverMembersBatch(
  updates: Array<{ id: number; priority: number }>
): Promise<number> {
  if (updates.length === 0) return 0;

  const dbInstance = await (db as any).dbPromise;
  let totalUpdated = 0;
  const CHUNK_SIZE = 300; // 3 params per row (2 CASE + 1 IN), 300*3=900 < 999

  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE);
    const params: any[] = [];

    const cases = chunk.map(u => {
      params.push(u.id, u.priority);
      return `WHEN $${params.length - 1} THEN $${params.length}`;
    }).join(' ');

    const idParams = chunk.map((_, idx) => `$${params.length + idx + 1}`).join(',');
    chunk.forEach(u => params.push(u.id));

    const sql = `UPDATE failover_group_members SET priority = CASE id ${cases} ELSE priority END WHERE id IN (${idParams})`;
    const result = await dbInstance.execute(sql, params);
    totalUpdated += result.rowsAffected ?? chunk.length;
  }

  const { dbEvents } = await import('./sqlite-adapter');
  dbEvents.notify('failover_group_members', 'update');
  return totalUpdated;
}

/** Batch update custom group channel display orders in a single SQL statement */
export async function updateCustomGroupChannelsBatch(
  updates: Array<{ id: number; displayOrder: number }>
): Promise<number> {
  if (updates.length === 0) return 0;

  const dbInstance = await (db as any).dbPromise;
  let totalUpdated = 0;
  const CHUNK_SIZE = 300; // 3 params per row (2 CASE + 1 IN), 300*3=900 < 999

  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE);
    const params: any[] = [];

    const cases = chunk.map(u => {
      params.push(u.id, u.displayOrder);
      return `WHEN $${params.length - 1} THEN $${params.length}`;
    }).join(' ');

    const idParams = chunk.map((_, idx) => `$${params.length + idx + 1}`).join(',');
    chunk.forEach(u => params.push(u.id));

    const sql = `UPDATE custom_group_channels SET display_order = CASE id ${cases} ELSE display_order END WHERE id IN (${idParams})`;
    const result = await dbInstance.execute(sql, params);
    totalUpdated += result.rowsAffected ?? chunk.length;
  }

  const { dbEvents } = await import('./sqlite-adapter');
  dbEvents.notify('custom_group_channels', 'update');
  return totalUpdated;
}

// ============================================================================
// Favorites Functions
// ============================================================================

/** Set a channel's favorite status explicitly (no read-before-write). */
export async function setChannelFavorite(streamId: string, isFavorite: boolean): Promise<boolean> {
  try {
    // Emit a dedicated 'favorites' event rather than the generic 'channels'
    // event so the heavy All-Channels live query and the category stream index
    // are not invalidated by a mere favorite toggle.
    const result = await db.channels.update(
      streamId,
      { is_favorite: isFavorite },
      { notifyTable: 'favorites' }
    );
    return result > 0;
  } catch (error) {
    console.error('[setChannelFavorite] Error setting favorite:', error);
    throw error;
  }
}

import { normalizeBoolean } from '../utils/db-helpers';

/** Get count of favorited channels */
export async function getFavoriteChannelCount(): Promise<number> {
  // Use SQL COUNT for optimal performance - handle both 0/1 and true/false
  return await db.channels.countWhere('(is_favorite = 1 OR is_favorite = true)');
}

/** Get the per-source custom favorite order (list of stream_ids) for a source. */
export async function getFavoriteSourceOrder(sourceId: string): Promise<string[]> {
  try {
    const pref = await db.prefs.get(`favorite_source_order:${sourceId}`);
    if (!pref?.value) return [];
    const parsed = JSON.parse(pref.value);
    return Array.isArray(parsed) ? parsed.filter((v: unknown) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Persist the per-source custom favorite order (list of stream_ids) for a source. */
export async function setFavoriteSourceOrder(sourceId: string, streamIds: string[]): Promise<void> {
  await db.prefs.put({ key: `favorite_source_order:${sourceId}`, value: JSON.stringify(streamIds) });
  // Per-source favorites are read through the channels query, so notify the channels
  // table so open guides re-run their `__favsrc_` query with the new order.
  dbEvents.notify('channels', 'update');
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
    auto_cleanup_enabled: false,
    keep_recordings_days: 30,
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

  // Try to get latest channel name/alias from the local DB
  let resolvedChannelName = schedule.channel_name;
  try {
    const channel = await db.channels.get(schedule.channel_id);
    if (channel?.alias) {
      resolvedChannelName = channel.alias;
    }
  } catch (err) {
    console.warn('[DVR] Failed to resolve channel alias:', err);
  }

  // Call Rust backend to schedule recording
  const request = {
    source_id: schedule.source_id,
    channel_id: schedule.channel_id,
    channel_name: resolvedChannelName,
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

/** Rename a recording entry */
export async function updateRecordingTitle(recordingId: number, programTitle: string): Promise<void> {
  try {
    await invoke('update_recording_title', { id: recordingId, programTitle });
  } catch (err) {
    console.warn('[DVR] Rust update_recording_title failed, fallback to local DB update:', err);
  }
  await db.dvrRecordings.update(recordingId, { program_title: programTitle });
  dbEvents.notify('dvr_recordings', 'update');
}

/**
 * Update watch progress and optional duration for a DVR recording
 */
export async function updateDvrRecordingProgress(
  recordingId: number,
  progressSeconds: number,
  durationSec?: number
): Promise<void> {
  try {
    const dbInstance = await (db as any).dbPromise;
    if (durationSec && durationSec > 0) {
      await dbInstance.execute(
        `UPDATE dvr_recordings SET progress_seconds = ?, duration_sec = ?, last_watched_at = ? WHERE id = ?`,
        [progressSeconds, durationSec, Date.now(), recordingId]
      );
    } else {
      await dbInstance.execute(
        `UPDATE dvr_recordings SET progress_seconds = ?, last_watched_at = ? WHERE id = ?`,
        [progressSeconds, Date.now(), recordingId]
      );
    }
    dbEvents.notify('dvr_recordings', 'update');
  } catch (error) {
    console.error('[DVR] Failed to update recording progress:', error);
    throw error;
  }
}

/** Manually convert a TS recording to MP4 or MKV */
export async function convertRecording(recordingId: number, targetFormat: string): Promise<void> {
  console.log('[DVR] Converting recording:', recordingId, 'to', targetFormat);
  try {
    await invoke('convert_recording', { recordingId, targetFormat });
    dbEvents.notify('dvr_recordings', 'update');
    console.log('[DVR] Conversion complete for recording:', recordingId);
  } catch (error) {
    console.error('[DVR] Failed to convert recording:', error);
    throw error;
  }
}


/** Get upcoming scheduled recordings */
export async function getScheduledRecordings(): Promise<DvrSchedule[]> {
  const all = await db.dvrSchedules.toArray();
  return all
    .filter(s => s.status === 'scheduled' || s.status === 'recording')
    .sort((a, b) => a.scheduled_start - b.scheduled_start);
}

/** Get completed and in-progress recordings */
export async function getCompletedRecordings(): Promise<DvrRecording[]> {
  const all = await db.dvrRecordings.toArray();
  return all
    .filter(r => r.status === 'completed' || r.status === 'partial' || r.status === 'recording')
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
  file_path: string;
  progress_seconds?: number;
  progress_bytes?: number;
  speed_bytes?: number;
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

/** Update schedule settings (paddings and recurrence) */
export async function updateScheduleSettings(
  scheduleId: number,
  startPaddingSec: number,
  endPaddingSec: number,
  recurrence?: string
): Promise<void> {
  console.log('[DVR] Updating schedule settings:', scheduleId, { startPaddingSec, endPaddingSec, recurrence });

  // Call backend to update
  try {
    await invoke('update_schedule_settings', {
      id: scheduleId,
      startPaddingSec: startPaddingSec,
      endPaddingSec: endPaddingSec,
      recurrence: recurrence || null,
    });
  } catch (error) {
    console.error('[DVR] Backend update failed:', error);
    throw error;
  }

  // Update local database
  await db.dvrSchedules.update(scheduleId, {
    start_padding_sec: startPaddingSec,
    end_padding_sec: endPaddingSec,
    recurrence: recurrence || undefined,
  });

  dbEvents.notify('dvr_schedules', 'update');
  console.log('[DVR] Schedule settings updated:', scheduleId);
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

/** Add a TV episode to the watchlist (used by auto-add feature) */
export interface AutoAddEpisode {
  tvmaze_id: number;
  episode_id: number;
  show_name: string;
  episode_name?: string;
  season?: number;
  episode?: number;
  airdate?: string;
  airtime?: string;
  airstamp?: string;
  runtime?: number;
  channel_id?: string;
  reminder_enabled: boolean;
  reminder_minutes: number;
  autoswitch_enabled: boolean;
  autoswitch_seconds: number;
}

export async function addTvEpisodeToWatchlist(
  ep: AutoAddEpisode,
  channel: StoredChannel,
  options?: {
    reminder_enabled?: boolean;
    reminder_minutes?: number;
    autoswitch_enabled?: boolean;
    autoswitch_seconds_before?: number;
  }
): Promise<boolean> {
  try {
    // Calculate start and end times
    const startTime = ep.airstamp
      ? new Date(ep.airstamp).getTime()
      : ep.airdate
        ? new Date(ep.airdate).getTime()
        : Date.now();

    const endTime = startTime + (ep.runtime || 60) * 60 * 1000;

    // Create synthetic program ID
    const programId = `tvmaze_${ep.tvmaze_id}_${ep.episode_id}_${ep.airdate || 'unknown'}`;

    // Construct title and description
    const episodeTitle = ep.episode_name || `Episode ${ep.episode}`;
    const fullTitle = `*NEW* ${ep.show_name} - ${episodeTitle}`;

    let description = '';
    if (ep.season && ep.episode) {
      description = `S${ep.season}E${ep.episode}`;
    }

    // Check if already in watchlist
    const existing = await db.watchlist
      .where('program_id')
      .equals(programId)
      .first();

    if (existing) {
      console.log('[Watchlist] Episode already in watchlist:', ep.episode_name);
      return false;
    }

    // Add new episode
    const watchlistItem: WatchlistItem = {
      program_id: programId,
      channel_id: channel.stream_id,
      channel_name: channel.name,
      program_title: fullTitle,
      description: description,
      start_time: startTime,
      end_time: endTime,
      source_id: channel.source_id,
      added_at: Date.now(),
      reminder_enabled: options?.reminder_enabled ?? ep.reminder_enabled,
      reminder_minutes: options?.reminder_minutes ?? ep.reminder_minutes,
      autoswitch_enabled: options?.autoswitch_enabled ?? ep.autoswitch_enabled,
      autoswitch_seconds_before: options?.autoswitch_seconds_before ?? ep.autoswitch_seconds,
      reminder_shown: false,
      autoswitch_triggered: false
    };

    await db.watchlist.add(watchlistItem);
    dbEvents.notify('watchlist', 'add');
    console.log('[Watchlist] Added TV episode:', fullTitle);
    return true;
  } catch (error) {
    console.error('[Watchlist] Failed to add TV episode:', error);
    return false;
  }
}

/** Clear all auto-added TV episodes for a show (called before sync to refresh data) */
export async function clearAutoAddedEpisodesForShow(tvmazeId: number): Promise<number> {
  try {
    // Find all watchlist items with program_id starting with tvmaze_{tvmazeId}_
    const all = await db.watchlist.toArray();
    const prefix = `tvmaze_${tvmazeId}_`;
    const toDelete = all.filter(item => item.program_id.startsWith(prefix));

    for (const item of toDelete) {
      if (item.id) {
        await db.watchlist.delete(item.id);
      }
    }

    if (toDelete.length > 0) {
      dbEvents.notify('watchlist', 'delete');
      console.log(`[Watchlist] Cleared ${toDelete.length} auto-added episodes for show ${tvmazeId}`);
    }

    // Also clear backend tracking so episodes can be re-added
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('clear_show_watchlist_tracking', { tvmazeId });
    } catch (e) {
      console.error('[Watchlist] Failed to clear backend tracking:', e);
    }

    return toDelete.length;
  } catch (error) {
    console.error('[Watchlist] Failed to clear auto-added episodes:', error);
    return 0;
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
export async function getWatchlistCount(enabledSourceIds?: Set<string>): Promise<number> {
  try {
    if (enabledSourceIds) {
      const idsList = Array.from(enabledSourceIds);
      if (idsList.length === 0) return 0;
      const placeholders = idsList.map(() => '?').join(',');
      return await db.watchlist.countWhere(`source_id IN (${placeholders})`, idsList);
    }
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

// ============================================================================
// VOD Watch History Functions
// ============================================================================

/**
 * Record that a movie or series was watched (first time or update timestamp)
 * Does NOT update progress - use updateVodWatchProgress for that
 */
export async function recordVodWatch(
  mediaId: string,
  mediaType: 'movie' | 'series',
  sourceId: string,
  title: string,
  posterUrl?: string,
  seasonNum?: number,
  episodeNum?: number,
  episodeTitle?: string
): Promise<void> {
  try {
    const watchedAt = Date.now();

    // Check if there's an existing entry for this media
    const dbInstance = await (db as any).dbPromise;
    const existing = await dbInstance.select(
      'SELECT * FROM vod_history WHERE media_id = ? AND media_type = ? LIMIT 1',
      [mediaId, mediaType]
    );
    const existingItem = existing && existing.length > 0 ? existing[0] : null;

    if (existingItem && existingItem.id) {
      // Update existing entry - update watched_at, title, poster, and episode info if provided
      const updates: string[] = ['watched_at = ?', 'poster_url = ?', 'title = ?'];
      const values: (string | number | null)[] = [watchedAt, posterUrl ?? null, title];
      
      // Add episode info if provided
      if (seasonNum !== undefined) {
        updates.push('season_num = ?');
        values.push(seasonNum);
      }
      if (episodeNum !== undefined) {
        updates.push('episode_num = ?');
        values.push(episodeNum);
      }
      if (episodeTitle !== undefined) {
        updates.push('episode_title = ?');
        values.push(episodeTitle);
      }
      
      values.push(existingItem.id);
      
      await dbInstance.execute(
        `UPDATE vod_history SET ${updates.join(', ')} WHERE id = ?`,
        values
      );
    } else {
      // Create new entry
      await dbInstance.execute(
        `INSERT INTO vod_history (media_id, media_type, source_id, title, watched_at, progress_seconds, total_duration, poster_url, season_num, episode_num, episode_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [mediaId, mediaType, sourceId, title, watchedAt, null, null, posterUrl ?? null, seasonNum ?? null, episodeNum ?? null, episodeTitle ?? null]
      );
    }

    dbEvents.notify('vod_history', 'add');
    console.log('[VOD History] Recorded watch:', title, `(${mediaType})`, seasonNum !== undefined ? `S${seasonNum}E${episodeNum}` : '');
  } catch (error) {
    console.error('[VOD History] Failed to record watch:', error);
    throw error;
  }
}

/**
 * Get recently watched movies and series
 * Returns items sorted by most recent first
 */
export async function getRecentlyWatched(limit = 20): Promise<VodWatchHistory[]> {
  try {
    const dbInstance = await (db as any).dbPromise;
    const result = await dbInstance.select(
      `SELECT * FROM vod_history ORDER BY watched_at DESC LIMIT ?`,
      [limit]
    );
    return result || [];
  } catch (error) {
    console.error('[VOD History] Failed to get recently watched:', error);
    return [];
  }
}

/**
 * Get recently watched items by type (movies or series)
 */
export async function getRecentlyWatchedByType(
  mediaType: 'movie' | 'series',
  limit = 20
): Promise<VodWatchHistory[]> {
  try {
    console.log('[VOD History] getRecentlyWatchedByType called:', { mediaType, limit });
    const dbInstance = await (db as any).dbPromise;
    const result = await dbInstance.select(
      `SELECT * FROM vod_history WHERE media_type = ? ORDER BY watched_at DESC LIMIT ?`,
      [mediaType, limit]
    );
    return result || [];
  } catch (error) {
    console.error('[VOD History] Failed to get recently watched by type:', error);
    return [];
  }
}

/**
 * Clear watch history for a specific media item
 */
export async function clearVodWatchHistory(mediaId: string, mediaType: 'movie' | 'series'): Promise<void> {
  try {
    const dbInstance = await (db as any).dbPromise;
    await dbInstance.execute(
      'DELETE FROM vod_history WHERE media_id = ? AND media_type = ?',
      [mediaId, mediaType]
    );
    dbEvents.notify('vod_history', 'delete');
  } catch (error) {
    console.error('[VOD History] Failed to clear watch history:', error);
  }
}

/**
 * Update progress for a watched item
 */
export async function updateVodWatchProgress(
  mediaId: string,
  mediaType: 'movie' | 'series',
  progressSeconds: number,
  totalDuration?: number
): Promise<void> {
  try {
    const dbInstance = await (db as any).dbPromise;
    
    // Get existing record to check current duration
    const existing = await dbInstance.select(
      'SELECT total_duration FROM vod_history WHERE media_id = ? AND media_type = ? LIMIT 1',
      [mediaId, mediaType]
    );
    
    // Use existing duration if new value is 0/invalid and we have a valid existing duration
    let effectiveDuration = totalDuration;
    if ((totalDuration === 0 || totalDuration === undefined || totalDuration === null) && 
        existing && existing.length > 0 && existing[0].total_duration > 0) {
      effectiveDuration = existing[0].total_duration;
      console.log('[VOD History] Preserving existing duration:', effectiveDuration, '(new value was:', totalDuration + ')');
    }
    
    await dbInstance.execute(
      `UPDATE vod_history SET progress_seconds = ?, total_duration = ?, watched_at = ? WHERE media_id = ? AND media_type = ?`,
      [progressSeconds, effectiveDuration, Date.now(), mediaId, mediaType]
    );
    dbEvents.notify('vod_history', 'update');
  } catch (error) {
    console.error('[VOD History] Failed to update progress:', error);
    throw error;
  }
}

/**
 * Get watch progress for a specific media item
 */
export async function getVodWatchProgress(
  mediaId: string,
  mediaType: 'movie' | 'series'
): Promise<{ progress_seconds: number; total_duration: number } | null> {
  try {
    const dbInstance = await (db as any).dbPromise;
    const result = await dbInstance.select(
      'SELECT progress_seconds, total_duration FROM vod_history WHERE media_id = ? AND media_type = ?',
      [mediaId, mediaType]
    );
    if (result && result.length > 0) {
      return {
        progress_seconds: result[0].progress_seconds || 0,
        total_duration: result[0].total_duration || 0,
      };
    }
    return null;
  } catch (error) {
    console.error('[VOD History] Failed to get progress:', error);
    return null;
  }
}

// ============================================================================
// Episode History Functions
// ============================================================================

/**
 * Record episode progress/completion
 */
export async function recordEpisodeWatch(
  episodeId: string,
  seriesId: string,
  sourceId: string,
  seasonNum: number,
  episodeNum: number,
  title: string,
  progressSeconds: number,
  totalDuration: number
): Promise<void> {
  try {
    const watchedAt = Date.now();
    // Mark as completed if watched >= 90%, within 5s of end, or explicitly marked (e.g. 1/1)
    const isCompletedCalc = (totalDuration > 0 && (progressSeconds / totalDuration) >= 0.90) ||
                           (totalDuration > 0 && progressSeconds >= totalDuration - 5) ||
                           (totalDuration === 1 && progressSeconds === 1);
    let completed = isCompletedCalc ? 1 : 0;

    console.log('[DB] recordEpisodeWatch called:', { episodeId, progressSeconds, totalDuration, completed });

    const dbInstance = await (db as any).dbPromise;
    
    // Check if entry exists
    const existingRecord = await dbInstance.select(
      'SELECT id, total_duration, completed FROM episode_history WHERE episode_id = ? LIMIT 1',
      [episodeId]
    );
    
    if (existingRecord && existingRecord.length > 0) {
      // Update existing entry - preserve duration if new value is 0 or invalid, and preserve completed state
      console.log('[DB] Updating existing episode record:', episodeId);
      
      let effectiveDuration = totalDuration;
      if ((totalDuration === 0 || totalDuration === undefined || totalDuration === null) && 
          existingRecord[0].total_duration > 0) {
        effectiveDuration = existingRecord[0].total_duration;
        console.log('[DB] Preserving existing duration:', effectiveDuration, '(new value was:', totalDuration + ')');
      }

      // If existing record was already completed, keep it completed when the user
      // scrubs back into a mostly-watched episode (progress >= 50%). This avoids
      // un-marking a finished episode on a brief rewatch of the ending, while still
      // letting a genuine re-watch restarting from the beginning clear the flag.
      const progressRatio = effectiveDuration > 0 ? progressSeconds / effectiveDuration : 0;
      if (
        existingRecord[0].completed === 1 &&
        progressSeconds > 0 &&
        progressRatio >= 0.5
      ) {
        completed = 1;
      }
      
      await dbInstance.execute(
        `UPDATE episode_history SET 
          watched_at = ?, 
          progress_seconds = ?, 
          total_duration = ?, 
          completed = ? 
         WHERE episode_id = ?`,
        [watchedAt, progressSeconds, effectiveDuration, completed, episodeId]
      );
    } else {
      // Create new entry
      console.log('[DB] Creating new episode record:', episodeId);
      await dbInstance.execute(
        `INSERT INTO episode_history (episode_id, series_id, source_id, season_num, episode_num, title, watched_at, progress_seconds, total_duration, completed) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [episodeId, seriesId, sourceId, seasonNum, episodeNum, title, watchedAt, progressSeconds, totalDuration, completed]
      );
    }
    
    dbEvents.notify('episode_history', 'update');
    console.log('[DB] Episode watch recorded successfully');

    // If this episode completed, advance series-level vod_history to the next episode if one exists
    if (completed === 1 && seriesId && seasonNum > 0 && episodeNum > 0) {
      try {
        const nextEp = await getAdjacentEpisode(seriesId, seasonNum, episodeNum, 'next');
        if (nextEp) {
          const nextProgress = await getEpisodeProgress(nextEp.id);
          const nextPos = nextProgress?.progress_seconds || 0;
          const nextDur = nextProgress?.total_duration || 0;

          // Fetch series title/poster if available in DB
          const seriesRecord = await dbInstance.select(
            'SELECT title, poster_url FROM vod_history WHERE media_id = ? AND media_type = ? LIMIT 1',
            [seriesId, 'series']
          );
          const sTitle = seriesRecord?.[0]?.title || '';
          const sPoster = seriesRecord?.[0]?.poster_url || undefined;

          await recordVodWatch(
            seriesId,
            'series',
            sourceId,
            sTitle,
            sPoster,
            nextEp.season_num,
            nextEp.episode_num,
            nextEp.title || `Episode ${nextEp.episode_num}`
          );

          await updateVodWatchProgress(
            seriesId,
            'series',
            nextPos,
            nextDur
          );
        }
      } catch (advErr) {
        console.warn('[DB] Failed to auto-advance series history to next episode:', advErr);
      }
    }
  } catch (error) {
    console.error('[Episode History] Failed to record episode watch:', error);
    throw error;
  }
}

/**
 * Get episode progress
 */
export async function getEpisodeProgress(episodeId: string): Promise<EpisodeWatchHistory | null> {
  try {
    const dbInstance = await (db as any).dbPromise;
    const result = await dbInstance.select(
      'SELECT * FROM episode_history WHERE episode_id = ?',
      [episodeId]
    );
    console.log('[DB] getEpisodeProgress raw result:', result);
    if (result && result.length > 0) {
      console.log('[DB] getEpisodeProgress found record:', result[0]);
      return result[0];
    }
    return null;
  } catch (error) {
    console.error('[Episode History] Failed to get episode progress:', error);
    return null;
  }
}

/**
 * Get all episode progress for a series
 */
export async function getSeriesEpisodeProgress(seriesId: string): Promise<EpisodeWatchHistory[]> {
  try {
    const dbInstance = await (db as any).dbPromise;
    const result = await dbInstance.select(
      'SELECT * FROM episode_history WHERE series_id = ? ORDER BY season_num, episode_num',
      [seriesId]
    );
    return result || [];
  } catch (error) {
    console.error('[Episode History] Failed to get series episode progress:', error);
    return [];
  }
}

/**
 * Get progress for many episodes in one query (keyed by episode_id).
 * Used by playlist views to render progress bars/resume hints without
 * issuing one query per item.
 */
export async function getBulkEpisodeProgress(
  episodeIds: string[]
): Promise<Record<string, { progress_seconds: number; total_duration: number; completed: boolean; watched_at: number }>> {
  const result: Record<string, { progress_seconds: number; total_duration: number; completed: boolean; watched_at: number }> = {};
  if (!episodeIds.length) return result;
  try {
    const dbInstance = await (db as any).dbPromise;
    const placeholders = episodeIds.map(() => '?').join(',');
    const rows = await dbInstance.select(
      `SELECT episode_id, progress_seconds, total_duration, completed, watched_at FROM episode_history WHERE episode_id IN (${placeholders})`,
      episodeIds
    );
    for (const row of rows || []) {
      result[row.episode_id] = {
        progress_seconds: row.progress_seconds || 0,
        total_duration: row.total_duration || 0,
        completed: !!row.completed,
        watched_at: row.watched_at || 0,
      };
    }
  } catch (error) {
    console.error('[Episode History] Failed to get bulk episode progress:', error);
  }
  return result;
}

/**
 * Get progress for many movies in one query (keyed by media_id).
 */
export async function getBulkMovieProgress(
  movieIds: string[]
): Promise<Record<string, { progress_seconds: number; total_duration: number; watched_at: number }>> {
  const result: Record<string, { progress_seconds: number; total_duration: number; watched_at: number }> = {};
  if (!movieIds.length) return result;
  try {
    const dbInstance = await (db as any).dbPromise;
    const placeholders = movieIds.map(() => '?').join(',');
    const rows = await dbInstance.select(
      `SELECT media_id, progress_seconds, total_duration, watched_at FROM vod_history WHERE media_type = 'movie' AND media_id IN (${placeholders})`,
      movieIds
    );
    for (const row of rows || []) {
      result[row.media_id] = {
        progress_seconds: row.progress_seconds || 0,
        total_duration: row.total_duration || 0,
        watched_at: row.watched_at || 0,
      };
    }
  } catch (error) {
    console.error('[VOD History] Failed to get bulk movie progress:', error);
  }
  return result;
}

/**
 * Mark episode as completed
 */
export async function markEpisodeCompleted(episodeId: string): Promise<void> {
  try {
    const dbInstance = await (db as any).dbPromise;
    await dbInstance.execute(
      'UPDATE episode_history SET completed = 1, watched_at = ? WHERE episode_id = ?',
      [Date.now(), episodeId]
    );
    dbEvents.notify('episode_history', 'update');
  } catch (error) {
    console.error('[Episode History] Failed to mark episode completed:', error);
  }
}

/**
 * Delete episode history
 */
export async function deleteEpisodeHistory(episodeId: string): Promise<void> {
  try {
    const dbInstance = await (db as any).dbPromise;
    await dbInstance.execute(
      'DELETE FROM episode_history WHERE episode_id = ?',
      [episodeId]
    );
    dbEvents.notify('episode_history', 'delete');
  } catch (error) {
    console.error('[Episode History] Failed to delete episode history:', error);
  }
}

/**
 * Remove item from Recently Watched and clear all associated progress
 */
export async function removeFromRecentlyWatched(
  mediaId: string,
  mediaType: 'movie' | 'series'
): Promise<void> {
  try {
    const dbInstance = await (db as any).dbPromise;
    
    // Remove from vod_history
    await dbInstance.execute(
      'DELETE FROM vod_history WHERE media_id = ? AND media_type = ?',
      [mediaId, mediaType]
    );
    
    // If it's a series, also remove all episode history
    if (mediaType === 'series') {
      await dbInstance.execute(
        'DELETE FROM episode_history WHERE series_id = ?',
        [mediaId]
      );
    }
    
    dbEvents.notify('vod_history', 'delete');
    console.log('[VOD History] Removed from Recently Watched:', mediaId, `(${mediaType})`);
  } catch (error) {
    console.error('[VOD History] Failed to remove from Recently Watched:', error);
    throw error;
  }
}

/**
 * Check if an episode is completed (watched > 95%)
 */
export async function isEpisodeCompleted(episodeId: string): Promise<boolean> {
  try {
    const progress = await getEpisodeProgress(episodeId);
    if (!progress) return false;
    return progress.completed === 1;
  } catch (error) {
    console.error('[Episode History] Failed to check if episode completed:', error);
    return false;
  }
}

/**
 * Get all episodes for a series, ordered by season and episode number
 */
export async function getSeriesEpisodes(seriesId: string): Promise<StoredEpisode[]> {
  try {
    const dbInstance = await (db as any).dbPromise;
    const result = await dbInstance.select(
      'SELECT * FROM vodEpisodes WHERE series_id = ? ORDER BY season_num, episode_num',
      [seriesId]
    );
    return result || [];
  } catch (error) {
    console.error('[DB] Failed to get series episodes:', error);
    return [];
  }
}

/**
 * Get next or previous episode for navigation
 * @param direction 'next' or 'prev'
 * @returns The adjacent episode or null if not found
 */
export async function getAdjacentEpisode(
  seriesId: string,
  currentSeasonNum: number,
  currentEpisodeNum: number,
  direction: 'next' | 'prev'
): Promise<StoredEpisode | null> {
  try {
    const episodes = await getSeriesEpisodes(seriesId);
    if (episodes.length === 0) return null;

    // Find current episode index
    const currentIndex = episodes.findIndex(
      ep => ep.season_num === currentSeasonNum && ep.episode_num === currentEpisodeNum
    );

    if (currentIndex === -1) return null;

    if (direction === 'next') {
      // Return next episode if exists, otherwise null (no wrap)
      return episodes[currentIndex + 1] || null;
    } else {
      // Return previous episode if exists, otherwise null (no wrap)
      return episodes[currentIndex - 1] || null;
    }
  } catch (error) {
    console.error('[DB] Failed to get adjacent episode:', error);
    return null;
  }
}

/**
 * Mark a VOD episode as watched or unwatched, and update the series' overall Continue Watching state
 */
export async function setVodEpisodeWatchedState(
  seriesId: string,
  episodeId: string,
  sourceId: string,
  seasonNum: number,
  episodeNum: number,
  episodeTitle: string,
  seriesTitle: string,
  seriesPoster: string | undefined,
  watched: boolean
): Promise<void> {
  try {
    if (watched) {
      // 1. Mark episode as watched (completed = 1, progress/duration = 1)
      await recordEpisodeWatch(
        episodeId,
        seriesId,
        sourceId,
        seasonNum,
        episodeNum,
        episodeTitle,
        1, // progressSeconds
        1  // totalDuration (progress/total = 100% -> completed)
      );

      // 2. Look for the next episode to display in Continue Watching
      const nextEp = await getAdjacentEpisode(seriesId, seasonNum, episodeNum, 'next');
      if (nextEp) {
        const nextProgress = await getEpisodeProgress(nextEp.id);
        const nextPos = nextProgress?.progress_seconds || 0;
        const nextDur = nextProgress?.total_duration || 0;

        await recordVodWatch(
          seriesId,
          'series',
          sourceId,
          seriesTitle,
          seriesPoster,
          nextEp.season_num,
          nextEp.episode_num,
          nextEp.title || `Episode ${nextEp.episode_num}`
        );

        await updateVodWatchProgress(
          seriesId,
          'series',
          nextPos,
          nextDur
        );
      } else {
        // Final episode of series completed
        await recordVodWatch(
          seriesId,
          'series',
          sourceId,
          seriesTitle,
          seriesPoster,
          seasonNum,
          episodeNum,
          episodeTitle
        );

        await updateVodWatchProgress(
          seriesId,
          'series',
          1,
          1
        );
      }
    } else {
      // 1. Delete episode watch history
      await deleteEpisodeHistory(episodeId);

      // 2. Query remaining episode progress for this series to find the next most recently watched
      const remainingProgress = await getSeriesEpisodeProgress(seriesId);
      
      if (remainingProgress && remainingProgress.length > 0) {
        // Find the one with the maximum watched_at timestamp
        let latestEp = remainingProgress[0];
        for (const ep of remainingProgress) {
          if (ep.watched_at > latestEp.watched_at) {
            latestEp = ep;
          }
        }
        
        // Update series-level watch history to point to the latest remaining episode
        await recordVodWatch(
          seriesId,
          'series',
          sourceId,
          seriesTitle,
          seriesPoster,
          latestEp.season_num,
          latestEp.episode_num,
          latestEp.title || `Episode ${latestEp.episode_num}`
        );
        
        // Update series progress to match the latest remaining episode
        await updateVodWatchProgress(
          seriesId,
          'series',
          latestEp.progress_seconds || 0,
          latestEp.total_duration || 0
        );
      } else {
        // No remaining episodes watched, so remove series from vod_history completely
        await clearVodWatchHistory(seriesId, 'series');
      }
    }
  } catch (error) {
    console.error('[VOD History] Failed to set episode watched state:', error);
    throw error;
  }
}


