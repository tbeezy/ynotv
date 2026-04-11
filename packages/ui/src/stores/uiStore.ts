/**
 * UI State Store - Zustand store for transient UI state
 *
 * Stores UI state that should persist during the session but reset on app restart.
 * Designed to be easily extended with backend persistence middleware later.
 */

import { create } from 'zustand';
import type { SportsTabId } from '@ynotv/core';
import type { MediaItem } from '../types/media';

interface UIState {
  // Movies page
  moviesSelectedCategory: string | null;  // null = home, 'all' = all, string = category id
  setMoviesSelectedCategory: (id: string | null) => void;
  moviesSelectedItem: MediaItem | null;  // Currently selected movie detail
  setMoviesSelectedItem: (item: MediaItem | null) => void;
  moviesSearchQuery: string;  // Current search query
  setMoviesSearchQuery: (query: string) => void;

  // Series page
  seriesSelectedCategory: string | null;
  setSeriesSelectedCategory: (id: string | null) => void;
  seriesSelectedItem: MediaItem | null;  // Currently selected series detail
  setSeriesSelectedItem: (item: MediaItem | null) => void;
  seriesSearchQuery: string;  // Current search query
  setSeriesSearchQuery: (query: string) => void;
  seriesSelectedSeason: number | undefined;  // Selected season for series detail
  setSeriesSelectedSeason: (season: number | undefined) => void;

  // Sports Hub
  sportsSelectedTab: SportsTabId;
  setSportsSelectedTab: (tab: SportsTabId) => void;
  sportsSelectedLeague: string | null;
  setSportsSelectedLeague: (id: string | null) => void;

  // Sync state - persists across Settings open/close
  channelSyncing: boolean;
  vodSyncing: boolean;
  tmdbMatching: boolean;
  cacheClearing: boolean;
  syncStatusMessage: string | null;
  setChannelSyncing: (value: boolean) => void;
  setVodSyncing: (value: boolean) => void;
  setTmdbMatching: (value: boolean) => void;
  setCacheClearing: (value: boolean) => void;
  setSyncStatusMessage: (msg: string | null) => void;

  // Channel display settings
  channelSortOrder: 'alphabetical' | 'number';
  setChannelSortOrder: (value: 'alphabetical' | 'number') => void;
  epgView: 'traditional' | 'alternate';
  setEpgView: (value: 'traditional' | 'alternate') => void;
}

export const useUIStore = create<UIState>((set) => ({
  // Movies
  moviesSelectedCategory: null,
  setMoviesSelectedCategory: (id) => set({ moviesSelectedCategory: id }),
  moviesSelectedItem: null,
  setMoviesSelectedItem: (item) => set({ moviesSelectedItem: item }),
  moviesSearchQuery: '',
  setMoviesSearchQuery: (query) => set({ moviesSearchQuery: query }),

  // Series
  seriesSelectedCategory: null,
  setSeriesSelectedCategory: (id) => set({ seriesSelectedCategory: id }),
  seriesSelectedItem: null,
  setSeriesSelectedItem: (item) => set({ seriesSelectedItem: item }),
  seriesSearchQuery: '',
  setSeriesSearchQuery: (query) => set({ seriesSearchQuery: query }),
  seriesSelectedSeason: undefined,
  setSeriesSelectedSeason: (season) => set({ seriesSelectedSeason: season }),

  // Sports Hub
  sportsSelectedTab: 'live',
  setSportsSelectedTab: (tab) => set({ sportsSelectedTab: tab }),
  sportsSelectedLeague: null,
  setSportsSelectedLeague: (id) => set({ sportsSelectedLeague: id }),

  // Sync state
  channelSyncing: false,
  vodSyncing: false,
  tmdbMatching: false,
  cacheClearing: false,
  syncStatusMessage: null,
  setChannelSyncing: (value) => set({ channelSyncing: value }),
  setVodSyncing: (value) => set({ vodSyncing: value }),
  setTmdbMatching: (value) => set({ tmdbMatching: value }),
  setCacheClearing: (value) => set({ cacheClearing: value }),
  setSyncStatusMessage: (msg) => set({ syncStatusMessage: msg }),

  // Channel display settings
  channelSortOrder: 'number',
  setChannelSortOrder: (value) => set({ channelSortOrder: value }),
  epgView: 'traditional',
  setEpgView: (value) => set({ epgView: value }),

}));

// Selectors for cleaner component code
export const useMoviesCategory = () => useUIStore((s) => s.moviesSelectedCategory);
export const useSetMoviesCategory = () => useUIStore((s) => s.setMoviesSelectedCategory);
export const useMoviesSelectedItem = () => useUIStore((s) => s.moviesSelectedItem);
export const useSetMoviesSelectedItem = () => useUIStore((s) => s.setMoviesSelectedItem);
export const useMoviesSearchQuery = () => useUIStore((s) => s.moviesSearchQuery);
export const useSetMoviesSearchQuery = () => useUIStore((s) => s.setMoviesSearchQuery);

export const useSeriesCategory = () => useUIStore((s) => s.seriesSelectedCategory);
export const useSetSeriesCategory = () => useUIStore((s) => s.setSeriesSelectedCategory);
export const useSeriesSelectedItem = () => useUIStore((s) => s.seriesSelectedItem);
export const useSetSeriesSelectedItem = () => useUIStore((s) => s.setSeriesSelectedItem);
export const useSeriesSearchQuery = () => useUIStore((s) => s.seriesSearchQuery);
export const useSetSeriesSearchQuery = () => useUIStore((s) => s.setSeriesSearchQuery);
export const useSeriesSelectedSeason = () => useUIStore((s) => s.seriesSelectedSeason);
export const useSetSeriesSelectedSeason = () => useUIStore((s) => s.setSeriesSelectedSeason);

// Sync state selectors
export const useChannelSyncing = () => useUIStore((s) => s.channelSyncing);
export const useSetChannelSyncing = () => useUIStore((s) => s.setChannelSyncing);
export const useVodSyncing = () => useUIStore((s) => s.vodSyncing);
export const useSetVodSyncing = () => useUIStore((s) => s.setVodSyncing);
export const useTmdbMatching = () => useUIStore((s) => s.tmdbMatching);
export const useSetTmdbMatching = () => useUIStore((s) => s.setTmdbMatching);
export const useCacheClearing = () => useUIStore((s) => s.cacheClearing);
export const useSetCacheClearing = () => useUIStore((s) => s.setCacheClearing);
export const useSyncStatusMessage = () => useUIStore((s) => s.syncStatusMessage);
export const useSetSyncStatusMessage = () => useUIStore((s) => s.setSyncStatusMessage);

// Channel display settings selectors
export const useChannelSortOrder = () => useUIStore((s) => s.channelSortOrder);
export const useSetChannelSortOrder = () => useUIStore((s) => s.setChannelSortOrder);
export const useEpgView = () => useUIStore((s) => s.epgView);
export const useSetEpgView = () => useUIStore((s) => s.setEpgView);

// Sports Hub selectors
export const useSportsSelectedTab = () => useUIStore((s) => s.sportsSelectedTab);
export const useSetSportsSelectedTab = () => useUIStore((s) => s.setSportsSelectedTab);
export const useSportsSelectedLeague = () => useUIStore((s) => s.sportsSelectedLeague);
export const useSetSportsSelectedLeague = () => useUIStore((s) => s.setSportsSelectedLeague);
