/**
 * Core data types for sbtlTV
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
  user_agent?: string;    // Custom User-Agent for requests
  epg_timeshift_hours?: number; // EPG time offset in hours (e.g., -1, 0, +1)
  backup_macs?: string[];  // Stalker backup MAC addresses
  backup_credentials?: Array<{  // Xtream backup credentials
    username: string;
    password: string;
  }>;
  enabled: boolean;
}

export interface XtreamSource extends Source {
  type: 'xtream';
  username: string;
  password: string;
}

export interface M3USource extends Source {
  type: 'm3u';
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
  tv_archive?: boolean;   // Has catchup/timeshift
  is_adult?: boolean;
  channel_num?: number;   // Channel order (Xtream num / M3U tvg-chno)
}

// =============================================================================
// EPG Types
// =============================================================================

export interface Program {
  id?: string;            // Optional unique ID
  channel_id: string;     // Matches Channel.epg_channel_id
  title: string;
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
// Connection Mode (standalone vs server)
// =============================================================================

export type ConnectionMode = 'standalone' | 'server';

export interface ServerConnection {
  url: string;
  username: string;
  token?: string;
}
