/**
 * Core data types for ynoTV
 * Types based on Xtream Codes API standard
 */

// =============================================================================
// Source Types - How we connect to IPTV providers
// =============================================================================

export type SourceType = 'xtream' | 'm3u' | 'stalker' | 'epg';

export interface Source {
  id: string;
  name: string;
  type: SourceType;
  url: string;
  username?: string;      // Xtream only
  password?: string;      // Xtream only
  mac?: string;           // Stalker only
  epg_url?: string;       // Auto-detected or manual override
  auto_load_epg?: boolean; // Auto-fetch EPG from source (default: true for xtream)
  additional_epg_urls?: string[]; // Additional EPG URLs for waterfall filling
  vod_only?: boolean;     // Only sync VOD/Series, skip channels (default: false)
  live_tv_only?: boolean;  // Only sync LiveTV, skip VOD/Series (default: false)
  user_agent?: string;    // Custom User-Agent for requests
  epg_timeshift_hours?: number; // EPG time offset in hours (e.g., -1, 0, +1)
  disable_short_epg?: boolean;  // Disable Stalker short EPG fetching
  backup_macs?: string[];  // Stalker backup MAC addresses
  backup_credentials?: Array<{  // Xtream backup credentials
    username: string;
    password: string;
  }>;
  backup_urls?: string[];  // Backup server URLs for connection failover
  display_order?: number;
  enabled: boolean;
  advanced_epg_matching?: boolean; // Enable display name-based EPG matching for external EPGs (default: false)
  custom_refresh_interval?: number; // Custom EPG/channel refresh interval in hours
  custom_vod_refresh_interval?: number; // Custom VOD refresh interval in hours
  max_connections?: number; // Max concurrent connections (manual override or provider limit)
}

export interface XtreamSource extends Source {
  type: 'xtream';
  username: string;
  password: string;
}

export interface M3uCatchupConfig {
  url: string;        // Xtream server domain (e.g. http://provider.com:8080)
  username: string;
  password: string;
}

export interface M3USource extends Source {
  type: 'm3u';
  xtream_catchup?: M3uCatchupConfig; // Optional Xtream credentials for catchup
}

export interface EPGSource extends Source {
  type: 'epg';
}

// =============================================================================
// Channel/Stream Types
// =============================================================================

export interface Category {
  category_id: string;
  category_name: string;
  source_id: string;
  parent_id?: number;     // For hierarchical categories (rare)
  display_order?: number;
}

export interface Channel {
  stream_id: string;
  name: string;
  stream_icon: string;    // Logo URL
  epg_channel_id: string; // tvg-id for EPG matching
  category_ids: string[];
  direct_url: string;     // The actual playable stream URL
  source_id: string;

  // Optional metadata
  tv_archive?: boolean | number;   // Has catchup/timeshift
  tv_archive_duration?: number;    // Hours of catch-up archive available (Stalker)
  is_adult?: boolean;
  channel_num?: number;   // Channel order (Xtream num / M3U tvg-chno)
  provider_order?: number; // Position in provider response / M3U file (0-based)
  xtream_stream_id?: string; // Xtream stream_id extracted from M3U URL (for catchup)
  catchup_type?: string;     // M3U catchup type (e.g. "default", "append", "flussonic", "shift")
  catchup_source?: string;   // M3U catchup source template URL (e.g. "http://.../replay.m3u8&start=${start}")
  catchup_days?: number;     // Number of catchup days available
}

// =============================================================================
// EPG Types
// =============================================================================

export interface Program {
  id?: string;            // Optional unique ID
  channel_id: string;     // Matches Channel.epg_channel_id
  title: string;
  subtitle?: string;      // XMLTV <sub-title> element
  start: Date;
  stop: Date;
  desc?: string;
  source_id?: string;

  // For guide grid rendering
  left_pct?: number;      // Position on timeline (0-100)
  width_pct?: number;     // Width on timeline (0-100)
}

export interface GuideRow {
  channel: Channel;
  programs: Program[];
  index: number;
}

// =============================================================================
// VOD Types (for movies/series support)
// =============================================================================

export interface Movie {
  stream_id: string;
  name: string;
  title?: string;         // Clean title without year (e.g., "40 Pounds of Trouble")
  year?: string;          // Release year (e.g., "1962")
  stream_icon: string;
  category_ids: string[];
  direct_url: string;
  source_id: string;

  // Metadata
  plot?: string;
  cast?: string;
  director?: string;
  genre?: string;
  release_date?: string;
  duration?: number;      // In seconds
  rating?: string;

  // External IDs (if provider includes them)
  tmdb_id?: number;
  added?: Date | string;
  container_extension?: string;
}

export interface Series {
  series_id: string;
  name: string;
  title?: string;         // Clean title without year
  year?: string;          // First air year
  cover: string;
  category_ids: string[];
  source_id: string;

  // Metadata
  plot?: string;
  cast?: string;
  genre?: string;
  release_date?: string;
  rating?: string;

  // External IDs (if provider includes them)
  tmdb_id?: number;
  added?: Date | string;
  last_modified?: Date | string;
}

export interface Season {
  season_number: number;
  episodes: Episode[];
}

export interface Episode {
  id: string;
  title: string;
  episode_num: number;
  season_num: number;
  direct_url: string;

  // Metadata
  plot?: string;
  duration?: number;
  info?: Record<string, unknown>;
  container_extension?: string;
}

// =============================================================================
// Settings Types
// =============================================================================

export interface UserSettings {
  sources: Source[];
  selected_categories: string[];
  volume: number;
  muted: boolean;

  // Player preferences
  preferred_stream_type: 'ts' | 'm3u8' | 'auto';
  hardware_decoding: boolean;

  // UI preferences
  guide_hours_visible: number;  // How many hours to show in EPG
  theme: 'dark' | 'light' | 'system';

  // Watch history
  watch_positions: Record<string, WatchPosition>;
  favorites: {
    channels: string[];
    movies: string[];
    series: string[];
  };
}

export interface WatchPosition {
  position: number;   // Seconds
  duration: number;   // Total duration
  updated_at: Date;
}

// =============================================================================
// App State Types
// =============================================================================

export interface AppState {
  // Data
  sources: Source[];
  categories: Category[];
  channels: Channel[];

  // UI state
  selectedCategoryIds: string[];
  currentChannel: Channel | null;
  isPlaying: boolean;

  // Loading states
  isLoadingChannels: boolean;
  isLoadingEPG: boolean;
  error: string | null;
}

// =============================================================================
// Sports Hub Types
// =============================================================================

export interface SportsMatch {
  id: string;
  awayName: string;
  homeName: string;
  awayLogo?: string;
  homeLogo?: string;
  awayRecord?: string;
  homeRecord?: string;
  subtitle?: string;
  status?: 'scheduled' | 'live' | 'finished';
  position?: number;
  points?: number;
  roundScores?: string[];
  groupName?: string;
}

export interface SportsEvent {
  id: string;
  title: string;
  homeTeam: SportsTeam;
  awayTeam: SportsTeam;
  league: SportsLeague;
  startTime: Date;
  status: 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled';
  homeScore?: number;
  awayScore?: number;
  period?: string;
  timeElapsed?: string;
  channels: SportsBroadcastChannel[];
  venue?: string;
  matches?: SportsMatch[];
}

export interface SportsTeam {
  id: string;
  name: string;
  shortName?: string;
  logo?: string;
  country?: string;
  leagueId?: string;
}

export interface SportsLeague {
  id: string;
  name: string;
  sport: string;
  country?: string;
  logo?: string;
}

export interface SportsBroadcastChannel {
  name: string;
  country?: string;
  logo?: string;
}

export type SportsTabId = 'live' | 'upcoming' | 'worldcup' | 'leagues' | 'favorites' | 'news' | 'leaders' | 'settings';

// =============================================================================
// Connection Mode (standalone vs server)
// =============================================================================

export type ConnectionMode = 'standalone' | 'server';

export interface ServerConnection {
  url: string;
  username: string;
  token?: string;
}
