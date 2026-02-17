/**
 * Service interfaces for sbtlTV
 *
 * These interfaces define the contract between the UI layer and the data layer.
 * Different adapters can implement these:
 * - LocalAdapter: Parses M3U/Xtream locally
 * - ServerAdapter: Fetches from backend API
 */

import type {
  Source,
  Category,
  Channel,
  Program,
  GuideRow,
  Movie,
  Series,
  Season,
  UserSettings,
  WatchPosition,
} from './types';

// =============================================================================
// Channel Service - Manages sources and channel data
// =============================================================================

export interface IChannelService {
  // Source management
  getSources(): Promise<Source[]>;
  addSource(source: Omit<Source, 'id'>): Promise<Source>;
  updateSource(id: string, updates: Partial<Source>): Promise<Source>;
  removeSource(id: string): Promise<void>;
  testSource(source: Omit<Source, 'id'>): Promise<{ success: boolean; error?: string; channelCount?: number }>;

  // Channel data
  getCategories(sourceIds?: string[]): Promise<Category[]>;
  getChannels(options?: {
    categoryIds?: string[];
    sourceIds?: string[];
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<Channel[]>;
  getChannelById(id: string): Promise<Channel | null>;
  getChannelCount(categoryIds?: string[]): Promise<number>;

  // Refresh
  refreshData(sourceIds?: string[]): Promise<void>;
  isRefreshing(): boolean;

  // Events
  onDataChanged(callback: () => void): () => void;
}

// =============================================================================
// EPG Service - Electronic Program Guide
// =============================================================================

export interface IEPGService {
  // Query programs
  getPrograms(
    channelIds: string[],
    start: Date,
    end: Date
  ): Promise<Map<string, Program[]>>;

  getProgramsForChannel(
    channelId: string,
    start: Date,
    end: Date
  ): Promise<Program[]>;

  getCurrentProgram(channelId: string): Promise<Program | null>;
  getNextProgram(channelId: string): Promise<Program | null>;

  // Guide grid data (optimized for virtual scroll)
  getGuideRows(options: {
    startIndex: number;
    count: number;
    categoryIds?: string[];
    timeOffsetHours?: number;  // Hours from now
    hoursToShow?: number;      // Default 3
  }): Promise<{
    rows: GuideRow[];
    total: number;
  }>;

  // Refresh
  refreshEPG(sourceIds?: string[]): Promise<void>;
  isRefreshingEPG(): boolean;
  getLastEPGUpdate(): Date | null;

  // Events
  onEPGChanged(callback: () => void): () => void;
}

// =============================================================================
// VOD Service - Movies and Series (optional)
// =============================================================================

export interface IVODService {
  // Movies
  getMovieCategories(): Promise<Category[]>;
  getMovies(options?: {
    categoryIds?: string[];
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<Movie[]>;
  getMovieById(id: string): Promise<Movie | null>;

  // Series
  getSeriesCategories(): Promise<Category[]>;
  getSeries(options?: {
    categoryIds?: string[];
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<Series[]>;
  getSeriesById(id: string): Promise<Series | null>;
  getSeasons(seriesId: string): Promise<Season[]>;

  // Refresh
  refreshVOD(): Promise<void>;
}

// =============================================================================
// Settings Service - User preferences and settings
// =============================================================================

export interface ISettingsService {
  getSettings(): Promise<UserSettings>;
  saveSettings(settings: Partial<UserSettings>): Promise<void>;

  // Watch position tracking
  getWatchPosition(url: string): Promise<WatchPosition | null>;
  saveWatchPosition(url: string, position: number, duration: number): Promise<void>;

  // Favorites
  addFavorite(type: 'channels' | 'movies' | 'series', id: string): Promise<void>;
  removeFavorite(type: 'channels' | 'movies' | 'series', id: string): Promise<void>;
  isFavorite(type: 'channels' | 'movies' | 'series', id: string): Promise<boolean>;

  // Events
  onSettingsChanged(callback: (settings: UserSettings) => void): () => void;
}

// =============================================================================
// Player Service - Control mpv (Electron only)
// =============================================================================

export interface IPlayerService {
  // Playback control
  load(url: string): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  togglePause(): Promise<void>;
  stop(): Promise<void>;
  seek(seconds: number, relative?: boolean): Promise<void>;

  // Volume
  setVolume(volume: number): Promise<void>;
  getVolume(): Promise<number>;
  setMute(muted: boolean): Promise<void>;
  isMuted(): Promise<boolean>;

  // State
  isPlaying(): boolean;
  getCurrentPosition(): Promise<number>;
  getDuration(): Promise<number>;

  // Events
  onStateChange(callback: (state: PlayerState) => void): () => void;
  onError(callback: (error: string) => void): () => void;
}

export interface PlayerState {
  playing: boolean;
  volume: number;
  muted: boolean;
  position: number;
  duration: number;
  buffering: boolean;
}

// =============================================================================
// Combined Service Provider
// =============================================================================

export interface IServiceProvider {
  channels: IChannelService;
  epg: IEPGService;
  settings: ISettingsService;
  player: IPlayerService;
  vod?: IVODService;  // Optional VOD support

  // Initialize/cleanup
  initialize(): Promise<void>;
  dispose(): Promise<void>;
}
