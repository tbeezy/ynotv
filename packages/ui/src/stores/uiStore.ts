/**
 * UI State Store - Zustand store for transient UI state
 *
 * Stores UI state that should persist during the session but reset on app restart.
 * Designed to be easily extended with backend persistence middleware later.
 */

import { create } from 'zustand';
import type { SportsTabId } from '@ynotv/core';
import type { MediaItem } from '../types/media';
import type { StremioMetaPreview, StremioMeta } from '../types/stremio';
import type { NuvioCollectionFolder } from '../services/nuvio-api';

export interface NuvioMeta {
  id: string;
  type: string;
  name: string;
  poster: string | null;
  background?: string | null;
  logo?: string | null;
}

export type StremioView = 'home' | 'library' | 'detail' | 'search' | 'calendar' | 'settings' | 'person';

export type StremioHistoryFrame =
  | { view: 'home' | 'library' | 'search' | 'calendar' | 'settings' }
  | { view: 'detail'; meta: StremioMeta }
  | { view: 'person'; personId: number };

export type NuvioHistoryFrame =
  | { view: 'home' | 'library' | 'search' | 'collections' | 'addons' | 'scrapers' | 'settings'; catalogKey?: string | null }
  | { view: 'detail'; meta: NuvioMeta }
  | { view: 'person'; personId: number };

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
  sportsSelectedChannels: Record<string, string>;
  setSportsSelectedChannel: (eventId: string, channelKey: string) => void;

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
  channelSortOrder: 'alphabetical' | 'number' | 'provider';
  setChannelSortOrder: (value: 'alphabetical' | 'number' | 'provider') => void;
  channelSortOrderMigrated: boolean;
  setChannelSortOrderMigrated: (value: boolean) => void;
  categorySortOrder: 'default' | 'alphabetical';
  setCategorySortOrder: (value: 'default' | 'alphabetical') => void;
  epgView: 'traditional' | 'alternate';
  setEpgView: (value: 'traditional' | 'alternate') => void;
  epgVisibleHours: 'auto' | number;
  setEpgVisibleHours: (value: 'auto' | number) => void;
  epgClockFormat: '12h' | '24h';
  setEpgClockFormat: (value: '12h' | '24h') => void;
  epgShowDate: boolean;
  setEpgShowDate: (value: boolean) => void;
  includeAllChannelsToPlaylist: boolean;
  setIncludeAllChannelsToPlaylist: (value: boolean) => void;
  sidebarDragHotkey: 'Control' | 'Alt' | 'Shift' | 'Meta' | 'None';
  setSidebarDragHotkey: (value: 'Control' | 'Alt' | 'Shift' | 'Meta' | 'None') => void;

  // Navigation tab visibility (shared reactive state)
  navHiddenTabs: string[];
  setNavHiddenTabs: (tabs: string[]) => void;

  // EPG button visibility (shared reactive state)
  epgHiddenButtons: string[];
  setEpgHiddenButtons: (buttons: string[]) => void;

  // Stremio
  stremioView: StremioView;
  setStremioView: (view: StremioView) => void;
  stremioHistory: StremioHistoryFrame[];
  stremioActivePersonId: number | null;
  setStremioActivePersonId: (id: number | null) => void;
  stremioNavigate: (frame: StremioHistoryFrame) => void;
  stremioGoBack: () => void;
  stremioReset: (view: StremioView) => void;
  stremioSelectedAddonId: string | null;
  setStremioSelectedAddonId: (id: string | null) => void;
  stremioSelectedCatalogId: string | null;
  setStremioSelectedCatalogId: (id: string | null) => void;
  stremioSelectedCatalogType: string | null;
  setStremioSelectedCatalogType: (type: string | null) => void;
  stremioActiveMeta: StremioMeta | null;
  setStremioActiveMeta: (meta: StremioMeta | null) => void;
  stremioSearchQuery: string;
  setStremioSearchQuery: (query: string) => void;
  stremioSelectedSeason: number | undefined;
  setStremioSelectedSeason: (season: number | undefined) => void;
  stremioPreselectVideoId: string | null;
  setStremioPreselectVideoId: (id: string | null) => void;
  stremioCatalogScrollPositions: Record<string, number>;
  setStremioCatalogScrollPosition: (key: string, value: number) => void;

  // Trakt catalog hot-reload token
  traktCatalogRefreshToken: number;
  setTraktCatalogRefreshToken: (value: number) => void;

  // Cloud catalog selection (Trakt) for detail view
  stremioSelectedCloudCatalogKey: string | null;
  setStremioSelectedCloudCatalogKey: (key: string | null) => void;

  // Nuvio
  nuvioView: 'home' | 'library' | 'search' | 'collections' | 'addons' | 'scrapers' | 'settings' | 'person';
  setNuvioView: (view: 'home' | 'library' | 'search' | 'collections' | 'addons' | 'scrapers' | 'settings' | 'person') => void;
  nuvioActiveMeta: NuvioMeta | null;
  setNuvioActiveMeta: (meta: NuvioMeta | null) => void;
  nuvioHistory: NuvioHistoryFrame[];
  nuvioNavigate: (frame: NuvioHistoryFrame) => void;
  nuvioGoBack: () => void;
  nuvioSelectedFolder: NuvioCollectionFolder | null;
  setNuvioSelectedFolder: (folder: NuvioCollectionFolder | null) => void;
  nuvioSelectedFolderCollectionTitle: string;
  setNuvioSelectedFolderCollectionTitle: (title: string) => void;
  nuvioPreselectVideoId: string | null;
  setNuvioPreselectVideoId: (id: string | null) => void;
  nuvioActivePersonId: number | null;
  setNuvioActivePersonId: (id: number | null) => void;
  nuvioHasUnsavedHomeLayout: boolean;
  setNuvioHasUnsavedHomeLayout: (value: boolean) => void;
  nuvioTabSaveFn: (() => Promise<void>) | null;
  setNuvioTabSaveFn: (fn: (() => Promise<void>) | null) => void;

  // Poster sizes
  stremioPosterSize: number;
  setStremioPosterSize: (size: number) => void;
  nuvioPosterSize: number;
  setNuvioPosterSize: (size: number) => void;
}

function getInitialEpgView(): 'traditional' | 'alternate' {
  try {
    if (typeof localStorage !== 'undefined') {
      const localData = localStorage.getItem('app-settings');
      if (localData) {
        const parsed = JSON.parse(localData);
        if (parsed.epgView === 'alternate' || parsed.epgView === 'traditional') {
          return parsed.epgView;
        }
      }
    }
  } catch {}
  return 'traditional';
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
  sportsSelectedChannels: {},
  setSportsSelectedChannel: (eventId, channelKey) =>
    set((state) => ({
      sportsSelectedChannels: {
        ...state.sportsSelectedChannels,
        [eventId]: channelKey,
      },
    })),

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
  channelSortOrder: 'provider',
  setChannelSortOrder: (value) => set({ channelSortOrder: value }),
  channelSortOrderMigrated: false,
  setChannelSortOrderMigrated: (value) => set({ channelSortOrderMigrated: value }),
  categorySortOrder: 'default',
  setCategorySortOrder: (value) => set({ categorySortOrder: value }),
  epgView: getInitialEpgView(),
  setEpgView: (value) => {
    try {
      if (typeof localStorage !== 'undefined') {
        const existing = localStorage.getItem('app-settings');
        const parsed = existing ? JSON.parse(existing) : {};
        localStorage.setItem('app-settings', JSON.stringify({ ...parsed, epgView: value }));
      }
    } catch {}
    set({ epgView: value });
  },
  epgVisibleHours: 'auto',
  setEpgVisibleHours: (value) => set({ epgVisibleHours: value }),
  epgClockFormat: '12h',
  setEpgClockFormat: (value) => set({ epgClockFormat: value }),
  epgShowDate: false,
  setEpgShowDate: (value) => set({ epgShowDate: value }),
  includeAllChannelsToPlaylist: false,
  setIncludeAllChannelsToPlaylist: (value) => set({ includeAllChannelsToPlaylist: value }),
  sidebarDragHotkey: (typeof window !== 'undefined' ? (localStorage.getItem('sidebar_drag_hotkey') as any) : null) || 'Control',
  setSidebarDragHotkey: (value) => {
    if (typeof window !== 'undefined') localStorage.setItem('sidebar_drag_hotkey', value);
    set({ sidebarDragHotkey: value });
  },

  // Navigation tab visibility
  navHiddenTabs: [],
  setNavHiddenTabs: (tabs) => set({ navHiddenTabs: tabs }),

  // EPG button visibility
  epgHiddenButtons: [],
  setEpgHiddenButtons: (buttons) => set({ epgHiddenButtons: buttons }),

  // Stremio
  stremioView: 'home',
  setStremioView: (view) => set((state) => {
    const mainViews = ['home', 'library', 'calendar', 'settings', 'search'];
    if (mainViews.includes(view)) {
      return {
        stremioView: view,
        stremioHistory: [{ view } as any],
        stremioActiveMeta: null,
        stremioActivePersonId: null,
      };
    }
    return { stremioView: view };
  }),
  stremioHistory: [{ view: 'home' }],
  stremioActivePersonId: null,
  setStremioActivePersonId: (id) => set({ stremioActivePersonId: id }),
  stremioNavigate: (frame) => set((state) => {
    const nextHistory = [...state.stremioHistory, frame];
    const updates: Partial<UIState> = { stremioHistory: nextHistory, stremioView: frame.view };
    if (frame.view === 'detail') {
      updates.stremioActiveMeta = frame.meta;
      updates.stremioActivePersonId = null;
    } else if (frame.view === 'person') {
      updates.stremioActiveMeta = null;
      updates.stremioActivePersonId = frame.personId;
    } else {
      updates.stremioActiveMeta = null;
      updates.stremioActivePersonId = null;
    }
    return updates;
  }),
  stremioGoBack: () => set((state) => {
    if (state.stremioHistory.length <= 1) return {};
    const nextHistory = state.stremioHistory.slice(0, -1);
    const top = nextHistory[nextHistory.length - 1];
    const updates: Partial<UIState> = { stremioHistory: nextHistory, stremioView: top.view };
    if (top.view === 'detail') {
      updates.stremioActiveMeta = top.meta;
      updates.stremioActivePersonId = null;
    } else if (top.view === 'person') {
      updates.stremioActiveMeta = null;
      updates.stremioActivePersonId = top.personId;
    } else {
      updates.stremioActiveMeta = null;
      updates.stremioActivePersonId = null;
    }
    return updates;
  }),
  stremioReset: (view) => set({
    stremioView: view,
    stremioHistory: [{ view } as any],
    stremioActiveMeta: null,
    stremioActivePersonId: null,
  }),
  stremioSelectedAddonId: null,
  setStremioSelectedAddonId: (id) => set({ stremioSelectedAddonId: id }),
  stremioSelectedCatalogId: null,
  setStremioSelectedCatalogId: (id) => set({ stremioSelectedCatalogId: id }),
  stremioSelectedCatalogType: null,
  setStremioSelectedCatalogType: (type) => set({ stremioSelectedCatalogType: type }),
  stremioActiveMeta: null,
  setStremioActiveMeta: (meta) => set({ stremioActiveMeta: meta }),
  stremioSearchQuery: '',
  setStremioSearchQuery: (query) => set({ stremioSearchQuery: query }),
  stremioSelectedSeason: undefined,
  setStremioSelectedSeason: (season) => set({ stremioSelectedSeason: season }),
  stremioPreselectVideoId: null,
  setStremioPreselectVideoId: (id) => set({ stremioPreselectVideoId: id }),
  stremioCatalogScrollPositions: {},
  setStremioCatalogScrollPosition: (key, value) => set((state) => ({
    stremioCatalogScrollPositions: { ...state.stremioCatalogScrollPositions, [key]: value },
  })),

  traktCatalogRefreshToken: 0,
  setTraktCatalogRefreshToken: (value) => set({ traktCatalogRefreshToken: value }),

  stremioSelectedCloudCatalogKey: null,
  setStremioSelectedCloudCatalogKey: (key) => set({ stremioSelectedCloudCatalogKey: key }),

  // Nuvio
  nuvioView: 'home',
  setNuvioView: (view) => set((state) => {
    const mainViews = ['home', 'library', 'collections', 'addons', 'scrapers', 'settings'];
    if (mainViews.includes(view)) {
      return {
        nuvioView: view,
        nuvioHistory: [{ view } as any],
        nuvioActiveMeta: null,
        nuvioActivePersonId: null,
      };
    }
    return { nuvioView: view };
  }),
  nuvioActiveMeta: null,
  setNuvioActiveMeta: (meta) => set({ nuvioActiveMeta: meta }),
  nuvioHistory: [{ view: 'home' } as any],
  nuvioNavigate: (frame) => set((state) => {
    const nextHistory = [...state.nuvioHistory, frame];
    const updates: Partial<UIState> = { nuvioHistory: nextHistory };
    if (frame.view === 'detail') {
      updates.nuvioActiveMeta = frame.meta;
      updates.nuvioActivePersonId = null;
    } else if (frame.view === 'person') {
      updates.nuvioActiveMeta = null;
      updates.nuvioActivePersonId = frame.personId;
      updates.nuvioView = 'person';
    } else {
      updates.nuvioActiveMeta = null;
      updates.nuvioActivePersonId = null;
      updates.nuvioView = frame.view;
    }
    return updates;
  }),
  nuvioGoBack: () => set((state) => {
    if (state.nuvioHistory.length <= 1) return {};
    const nextHistory = state.nuvioHistory.slice(0, -1);
    const top = nextHistory[nextHistory.length - 1];
    const updates: Partial<UIState> = { nuvioHistory: nextHistory };
    if (top.view === 'detail') {
      updates.nuvioActiveMeta = top.meta;
      updates.nuvioActivePersonId = null;
    } else if (top.view === 'person') {
      updates.nuvioActiveMeta = null;
      updates.nuvioActivePersonId = top.personId;
      updates.nuvioView = 'person';
    } else {
      updates.nuvioActiveMeta = null;
      updates.nuvioActivePersonId = null;
      updates.nuvioView = top.view;
    }
    return updates;
  }),
  nuvioSelectedFolder: null,
  setNuvioSelectedFolder: (folder) => set({ nuvioSelectedFolder: folder }),
  nuvioSelectedFolderCollectionTitle: '',
  setNuvioSelectedFolderCollectionTitle: (title) => set({ nuvioSelectedFolderCollectionTitle: title }),
  nuvioPreselectVideoId: null,
  setNuvioPreselectVideoId: (id) => set({ nuvioPreselectVideoId: id }),
  nuvioActivePersonId: null,
  setNuvioActivePersonId: (id) => set({ nuvioActivePersonId: id }),
  nuvioHasUnsavedHomeLayout: false,
  setNuvioHasUnsavedHomeLayout: (value) => set({ nuvioHasUnsavedHomeLayout: value }),
  nuvioTabSaveFn: null,
  setNuvioTabSaveFn: (fn) => set({ nuvioTabSaveFn: fn }),

  stremioPosterSize: typeof window !== 'undefined' ? parseInt(localStorage.getItem('stremioPosterSize') || '150', 10) : 150,
  setStremioPosterSize: (size) => {
    if (typeof window !== 'undefined') localStorage.setItem('stremioPosterSize', String(size));
    set({ stremioPosterSize: size });
  },
  nuvioPosterSize: typeof window !== 'undefined' ? parseInt(localStorage.getItem('nuvioPosterSize') || '150', 10) : 150,
  setNuvioPosterSize: (size) => {
    if (typeof window !== 'undefined') localStorage.setItem('nuvioPosterSize', String(size));
    set({ nuvioPosterSize: size });
  },
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
export const useChannelSortOrderMigrated = () => useUIStore((s) => s.channelSortOrderMigrated);
export const useSetChannelSortOrderMigrated = () => useUIStore((s) => s.setChannelSortOrderMigrated);
export const useCategorySortOrder = () => useUIStore((s) => s.categorySortOrder);
export const useSetCategorySortOrder = () => useUIStore((s) => s.setCategorySortOrder);
export const useEpgView = () => useUIStore((s) => s.epgView);
export const useSetEpgView = () => useUIStore((s) => s.setEpgView);
export const useEpgVisibleHours = () => useUIStore((s) => s.epgVisibleHours);
export const useSetEpgVisibleHours = () => useUIStore((s) => s.setEpgVisibleHours);
export const useEpgClockFormat = () => useUIStore((s) => s.epgClockFormat);
export const useSetEpgClockFormat = () => useUIStore((s) => s.setEpgClockFormat);
export const useEpgShowDate = () => useUIStore((s) => s.epgShowDate);
export const useSetEpgShowDate = () => useUIStore((s) => s.setEpgShowDate);
export const useIncludeAllChannelsToPlaylist = () => useUIStore((s) => s.includeAllChannelsToPlaylist);
export const useSetIncludeAllChannelsToPlaylist = () => useUIStore((s) => s.setIncludeAllChannelsToPlaylist);
export const useSidebarDragHotkey = () => useUIStore((s) => s.sidebarDragHotkey);
export const useSetSidebarDragHotkey = () => useUIStore((s) => s.setSidebarDragHotkey);

// Sports Hub selectors
export const useSportsSelectedTab = () => useUIStore((s) => s.sportsSelectedTab);
export const useSetSportsSelectedTab = () => useUIStore((s) => s.setSportsSelectedTab);
export const useSportsSelectedLeague = () => useUIStore((s) => s.sportsSelectedLeague);
export const useSetSportsSelectedLeague = () => useUIStore((s) => s.setSportsSelectedLeague);
export const useSportsSelectedChannels = () => useUIStore((s) => s.sportsSelectedChannels);
export const useSetSportsSelectedChannel = () => useUIStore((s) => s.setSportsSelectedChannel);

// Stremio selectors
export const useStremioView = () => useUIStore((s) => s.stremioView);
export const useSetStremioView = () => useUIStore((s) => s.setStremioView);
export const useStremioSelectedAddonId = () => useUIStore((s) => s.stremioSelectedAddonId);
export const useSetStremioSelectedAddonId = () => useUIStore((s) => s.setStremioSelectedAddonId);
export const useStremioSelectedCatalogId = () => useUIStore((s) => s.stremioSelectedCatalogId);
export const useSetStremioSelectedCatalogId = () => useUIStore((s) => s.setStremioSelectedCatalogId);
export const useStremioSelectedCatalogType = () => useUIStore((s) => s.stremioSelectedCatalogType);
export const useSetStremioSelectedCatalogType = () => useUIStore((s) => s.setStremioSelectedCatalogType);
export const useStremioActiveMeta = () => useUIStore((s) => s.stremioActiveMeta);
export const useSetStremioActiveMeta = () => useUIStore((s) => s.setStremioActiveMeta);
export const useStremioSearchQuery = () => useUIStore((s) => s.stremioSearchQuery);
export const useSetStremioSearchQuery = () => useUIStore((s) => s.setStremioSearchQuery);
export const useStremioSelectedSeason = () => useUIStore((s) => s.stremioSelectedSeason);
export const useSetStremioSelectedSeason = () => useUIStore((s) => s.setStremioSelectedSeason);
export const useStremioPreselectVideoId = () => useUIStore((s) => s.stremioPreselectVideoId);
export const useSetStremioPreselectVideoId = () => useUIStore((s) => s.setStremioPreselectVideoId);
export const useStremioCatalogScrollPositions = () => useUIStore((s) => s.stremioCatalogScrollPositions);
export const useSetStremioCatalogScrollPosition = () => useUIStore((s) => s.setStremioCatalogScrollPosition);

export const useTraktCatalogRefreshToken = () => useUIStore((s) => s.traktCatalogRefreshToken);
export const useSetTraktCatalogRefreshToken = () => useUIStore((s) => s.setTraktCatalogRefreshToken);

export const useStremioSelectedCloudCatalogKey = () => useUIStore((s) => s.stremioSelectedCloudCatalogKey);
export const useSetStremioSelectedCloudCatalogKey = () => useUIStore((s) => s.setStremioSelectedCloudCatalogKey);

export const useStremioHistory = () => useUIStore((s) => s.stremioHistory);
export const useStremioActivePersonId = () => useUIStore((s) => s.stremioActivePersonId);
export const useSetStremioActivePersonId = () => useUIStore((s) => s.setStremioActivePersonId);
export const useStremioNavigate = () => useUIStore((s) => s.stremioNavigate);
export const useStremioGoBack = () => useUIStore((s) => s.stremioGoBack);

// Nuvio selectors
export const useNuvioView = () => useUIStore((s) => s.nuvioView);
export const useSetNuvioView = () => useUIStore((s) => s.setNuvioView);
export const useNuvioActiveMeta = () => useUIStore((s) => s.nuvioActiveMeta);
export const useSetNuvioActiveMeta = () => useUIStore((s) => s.setNuvioActiveMeta);
export const useNuvioSelectedFolder = () => useUIStore((s) => s.nuvioSelectedFolder);
export const useSetNuvioSelectedFolder = () => useUIStore((s) => s.setNuvioSelectedFolder);
export const useNuvioSelectedFolderCollectionTitle = () => useUIStore((s) => s.nuvioSelectedFolderCollectionTitle);
export const useSetNuvioSelectedFolderCollectionTitle = () => useUIStore((s) => s.setNuvioSelectedFolderCollectionTitle);
export const useNuvioPreselectVideoId = () => useUIStore((s) => s.nuvioPreselectVideoId);
export const useSetNuvioPreselectVideoId = () => useUIStore((s) => s.setNuvioPreselectVideoId);
export const useNuvioActivePersonId = () => useUIStore((s) => s.nuvioActivePersonId);
export const useSetNuvioActivePersonId = () => useUIStore((s) => s.setNuvioActivePersonId);
export const useNuvioNavigate = () => useUIStore((s) => s.nuvioNavigate);
export const useNuvioGoBack = () => useUIStore((s) => s.nuvioGoBack);
export const useNuvioHistory = () => useUIStore((s) => s.nuvioHistory);
export const useNuvioHasUnsavedHomeLayout = () => useUIStore((s) => s.nuvioHasUnsavedHomeLayout);
export const useSetNuvioHasUnsavedHomeLayout = () => useUIStore((s) => s.setNuvioHasUnsavedHomeLayout);
export const useNuvioTabSaveFn = () => useUIStore((s) => s.nuvioTabSaveFn);
export const useSetNuvioTabSaveFn = () => useUIStore((s) => s.setNuvioTabSaveFn);
