import { create } from 'zustand';
import type { SavedLayoutState } from '../hooks/useLayoutPersistence';
import type { ThemeId, CustomThemeConfig, ShortcutsMap, GlobalEpgLink } from '../types/app';
import type { SubtitleSettings } from '../components/settings/SubtitlesTab';
import type { AutoBackupSettings } from '../services/autoBackup';
import type { TrailerSource, VodPlayerMode } from '../components/vod/SplitPlayButton';
import i18n, { isSupportedLocale } from '../i18n';

/* ---------------------------------------------------------------------------
   Settings store — single source of truth for application settings.

   Phase 1+2 of the settings-store migration (docs/settings-store-migration.md):
   replaces the per-instance React state the old useAppSettings hook spawned
   (~20 copies of ~100 settings plus ~20 queued IPC loads) with ONE zustand
   store.   Setters are optimistic state writes + persistence through
   window.storage.updateSettings / debouncedUpdateSettings — which already route
   through the serialized write queue in tauri-bridge.ts and mirror every patch
   to localStorage for synchronous first-paint seeding. The single boot-time
   load lives in settingsStoreHydration.ts.

   Setters are PURE — no DOM writes. Every documentElement side effect derived
   from settings is owned by the single idempotent applier in
   settingsDomApplier.ts (Phase 3), subscribed to this store.
   --------------------------------------------------------------------------- */

function getInitialSettingsFromStorage(): Record<string, any> | null {
  try {
    const localData = typeof localStorage !== 'undefined' ? localStorage.getItem('app-settings') : null;
    if (localData) {
      return JSON.parse(localData);
    }
  } catch (e) {}
  return null;
}

// Synchronous localStorage seed — every consumer's first paint is correct
// without waiting on the async store read.
const cachedSettings = getInitialSettingsFromStorage();

/* ---------------------------------------------------------------------------
   OLED true-black is owned by the DOM applier (settingsDomApplier.ts): the
   data-oled attribute is derived purely from store state.oledBlack and synced
   by the single applier subscription — no module-global, no per-instance
   effects, so no mount-time race (the old module-global existed because ~20
   per-instance effects fought over the attribute; that class of bug is gone
   with the store + applier).
   --------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   Persistence — every write goes through the serialized queue.
   --------------------------------------------------------------------------- */
function persistSettings(patch: Record<string, any>, debounced = false): void {
  if (typeof window === 'undefined' || !window.storage) return;
  if (debounced) {
    try {
      window.storage.debouncedUpdateSettings(patch);
    } catch (e) {
      console.error('[settingsStore] Failed to save (debounced):', e);
    }
    return;
  }
  window.storage.updateSettings(patch).catch((e) => {
    console.error('[settingsStore] Failed to save:', e);
  });
}

export function dispatchAppEvent(name: string, detail: Record<string, any>) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/* ---------------------------------------------------------------------------
   Trakt / Simkl / category-visibility settings (service-shaped partials).
   --------------------------------------------------------------------------- */

export interface TraktSettings {
  traktEnabled: boolean;
  traktAccessToken: string | null;
  traktRefreshToken: string | null;
  traktTokenExpiresAt: number | null;
  traktScrobbleEnabled: boolean;
  traktSyncEnabled: boolean;
  traktCatalogsEnabled: Record<string, boolean>;
  traktCatalogOrder: string[];
  traktCatalogsBeforeAddon: boolean;
  traktEnabledLists: { id: string; name: string }[];
  traktNuvioCatalogsEnabled: Record<string, boolean>;
  traktNuvioCatalogOrder: string[];
  traktNuvioCatalogsBeforeAddon: boolean;
  traktNuvioEnabledLists: { id: string; name: string }[];
}

export interface SimklSettings {
  simklEnabled: boolean;
  simklAccessToken: string | null;
  simklScrobbleEnabled: boolean;
}

export interface CategorySettings {
  showAllChannels: boolean;
  showFavorites: boolean;
  showWatchlist: boolean;
  showRecentlyViewed: boolean;
  favoritesMode: 'global' | 'perSource' | 'both';
}

export interface RetrySettings {
  streamMaxRetries: number;
  streamWatchdogSeconds: number;
  useEventBasedReconnect: boolean;
  stallDetectionEnabled: boolean;
  showLoadingScreen: boolean;
}

/* ---------------------------------------------------------------------------
   State shape.
   --------------------------------------------------------------------------- */

export interface SettingsState {
  // i18n / language
  language: string;
  setLanguage: (lang: string) => Promise<void>;

  // Layout persistence
  rememberLastChannels: boolean;
  reopenLastOnStartup: boolean;
  savedLayoutState: SavedLayoutState | null;
  layoutSettingsLoaded: boolean;

  // Timeshift
  timeshiftEnabled: boolean;
  timeshiftCacheBytes: number;
  liveBufferOffset: number;

  // Search
  includeSourceInSearch: boolean;
  includeSourceInVodSearch: boolean;
  maxSearchResults: number;
  searchResultsOrder: 'default' | 'alphabetical';
  sourceFontSize: number;
  setSourceFontSize: (size: number) => void;

  // UI font sizes (CSS vars owned by the DOM applier)
  channelFontSize: number;
  setChannelFontSize: (size: number) => void;
  categoryFontSize: number;
  setCategoryFontSize: (size: number) => void;
  epgTitleFontSize: number;
  setEpgTitleFontSize: (size: number) => void;
  epgBodyFontSize: number;
  setEpgBodyFontSize: (size: number) => void;

  // UI scale (--app-zoom)
  uiScale: number;
  setUiScale: (scale: number) => void;

  // Transparent guide overlay (CSS vars owned by the DOM applier)
  transparentGuideHeight: number;
  setTransparentGuideHeight: (height: number) => void;
  transparentGuideHideHeader: boolean;
  setTransparentGuideHideHeader: (hide: boolean) => void;
  transparentGuideOverlayOpacity: number;
  setTransparentGuideOverlayOpacity: (opacity: number) => void;
  transparentGuideSidebarOpacity: number;
  setTransparentGuideSidebarOpacity: (opacity: number) => void;

  // LAN source security gate (SourcesTab save-time check)
  allowLanSources: boolean;
  setAllowLanSources: (allowed: boolean) => void;

  // UI design version — the v3-default migration latches in hydration
  modernUiEnabled: 'v1' | 'v2' | 'v3' | false;
  setModernUiEnabled: (value: 'v1' | 'v2' | 'v3' | false) => void;
  v3DefaultMigrated: boolean;

  // Category display
  categorySortOrder: 'default' | 'alphabetical';
  setCategorySortOrder: (order: 'default' | 'alphabetical') => void;
  includeAllChannelsToPlaylist: boolean;
  setIncludeAllChannelsToPlaylist: (enabled: boolean) => void;
  hideDisabledSources: boolean;
  setHideDisabledSources: (hidden: boolean) => void;

  // Advanced search
  advancedSearchScope: 'channels' | 'epg' | 'both';
  advancedSearchSourceIds: string[];
  advancedSearchCategoryIds: string[];
  useAdvancedSearchForRegular: boolean;
  searchCustomPlaylists: boolean;
  setAdvancedSearchScope: (scope: 'channels' | 'epg' | 'both') => void;
  setAdvancedSearchSourceIds: (ids: string[]) => void;
  setAdvancedSearchCategoryIds: (ids: string[]) => void;
  setUseAdvancedSearchForRegular: (use: boolean) => void;
  setSearchCustomPlaylists: (enabled: boolean) => void;

  // LiveTV channel-info overlay
  channelInfoOverlayEnabled: boolean;
  setChannelInfoOverlayEnabled: (enabled: boolean) => void;
  channelInfoOverlayFontSize: number;
  setChannelInfoOverlayFontSize: (size: number) => void;
  channelInfoOverlayLogoSize: number;
  setChannelInfoOverlayLogoSize: (size: number) => void;
  channelInfoOverlayBoxWidth: number;
  setChannelInfoOverlayBoxWidth: (width: number) => void;
  channelInfoOverlayOpacity: number;
  setChannelInfoOverlayOpacity: (opacity: number) => void;
  channelInfoOverlayHideDescription: boolean;
  setChannelInfoOverlayHideDescription: (hide: boolean) => void;
  channelInfoOverlayHideMetaBadge: boolean;
  setChannelInfoOverlayHideMetaBadge: (hide: boolean) => void;
  channelInfoOverlayHideLogo: boolean;
  setChannelInfoOverlayHideLogo: (hide: boolean) => void;
  channelInfoOverlayHideTimer: boolean;
  setChannelInfoOverlayHideTimer: (hide: boolean) => void;
  channelInfoOverlayPosition: 'left' | 'right';
  setChannelInfoOverlayPosition: (pos: 'left' | 'right') => void;
  channelInfoOverlayLogoShape: 'square' | 'horizontal';
  setChannelInfoOverlayLogoShape: (shape: 'square' | 'horizontal') => void;
  transparentGuideOnZap: boolean;
  setTransparentGuideOnZap: (enabled: boolean) => void;

  // Popout
  popoutStopMain: boolean;
  setPopoutStopMain: (stop: boolean) => void;
  popoutAlwaysOnTop: boolean;
  setPopoutAlwaysOnTop: (onTop: boolean) => void;
  popoutHwdecEnabled: boolean;
  setPopoutHwdecEnabled: (enabled: boolean) => void;
  popoutMpvParamsEnabled: boolean;
  setPopoutMpvParamsEnabled: (enabled: boolean) => void;
  popoutMpvParams: string;
  setPopoutMpvParams: (params: string) => void;

  // Theme
  theme: ThemeId;
  customThemeConfig: CustomThemeConfig;
  savedCustomThemes: CustomThemeConfig[];
  setSavedCustomThemes: (themes: CustomThemeConfig[]) => void;
  setTheme: (theme: ThemeId) => void;
  updateCustomThemeConfig: (config: Partial<CustomThemeConfig>) => void;

  // Global fonts
  appFontFamily: string;
  appCustomFontBase64: string;
  appCustomFontFormat: string;
  appCustomFontName: string;
  updateAppFont: (family: string, base64?: string, format?: string, name?: string) => Promise<void> | void;

  // Shortcuts
  shortcuts: ShortcutsMap;
  setShortcuts: (shortcuts: ShortcutsMap) => void;

  // Subtitle settings
  subtitleSettings: SubtitleSettings;
  setSubtitleSettings: (partial: Partial<SubtitleSettings>) => void;

  // Global EPG links (cache EPGs that overlay provider EPG data)
  globalEpgLinks: GlobalEpgLink[];
  setGlobalEpgLinks: (links: GlobalEpgLink[]) => void;

  // Automated backups (flat storage keys for backward compat with existing exports)
  autoBackupEnabled: boolean;
  autoBackupIntervalHours: number;
  autoBackupMaxBackups: number;
  autoBackupDirectory: string;
  setAutoBackupSettings: (partial: Partial<AutoBackupSettings>) => void;

  // Streaming catalogs (TMDB-powered Netflix-style rows)
  streamingCatalogsEnabled: boolean;
  setStreamingCatalogsEnabled: (enabled: boolean) => void;
  streamingNuvioCatalogsEnabled: boolean;
  setStreamingNuvioCatalogsEnabled: (enabled: boolean) => void;
  enabledStreamingServices: string[];
  setEnabledStreamingServices: (services: string[]) => void;

  // VOD trailer preferences (per-session pick persists app-wide)
  trailerSource: TrailerSource;
  setTrailerSource: (source: TrailerSource) => void;
  trailerPlayerMode: VodPlayerMode;
  setTrailerPlayerMode: (mode: VodPlayerMode) => void;

  // Metadata APIs
  tmdbApiKey: string;
  setTmdbApiKey: (key: string) => void;
  posterDbApiKey: string;
  setPosterDbApiKey: (key: string) => void;
  rpdbBackdropsEnabled: boolean;
  setRpdbBackdropsEnabled: (enabled: boolean) => void;

  // Downloads default directory (empty = prompt every time)
  downloadsPath: string;
  setDownloadsPath: (path: string) => void;

  // TMDB genre carousel enablement (movie + series)
  movieGenresEnabled: number[];
  setMovieGenresEnabled: (genres: number[]) => void;
  seriesGenresEnabled: number[];
  setSeriesGenresEnabled: (genres: number[]) => void;

  // Trakt integration (flat storage keys for backward compat with exports)
  traktEnabled: boolean;
  traktAccessToken: string | null;
  traktRefreshToken: string | null;
  traktTokenExpiresAt: number | null;
  traktScrobbleEnabled: boolean;
  traktSyncEnabled: boolean;
  traktCatalogsEnabled: Record<string, boolean>;
  traktCatalogOrder: string[];
  traktCatalogsBeforeAddon: boolean;
  traktEnabledLists: { id: string; name: string }[];
  traktNuvioCatalogsEnabled: Record<string, boolean>;
  traktNuvioCatalogOrder: string[];
  traktNuvioCatalogsBeforeAddon: boolean;
  traktNuvioEnabledLists: { id: string; name: string }[];
  setTraktSettings: (partial: Partial<TraktSettings>) => void;

  // Simkl integration
  simklEnabled: boolean;
  simklAccessToken: string | null;
  simklScrobbleEnabled: boolean;
  setSimklSettings: (partial: Partial<SimklSettings>) => void;

  // TV calendar auto-sync
  tvCalendarAutoSync: boolean;
  setTvCalendarAutoSync: (enabled: boolean) => void;

  // Category sidebar visibility (LiveTV sidebar top rows + folders)
  showAllChannels: boolean;
  showFavorites: boolean;
  showWatchlist: boolean;
  showRecentlyViewed: boolean;
  favoritesMode: 'global' | 'perSource' | 'both';
  collapseSourceCategoriesOnStartup: boolean;
  setCategorySettings: (partial: Partial<CategorySettings>) => void;
  setCollapseSourceCategoriesOnStartup: (enabled: boolean) => void;

  // Playback retry / stream-tuning knobs (read once at usePlayback mount)
  streamMaxRetries: number;
  streamWatchdogSeconds: number;
  useEventBasedReconnect: boolean;
  stallDetectionEnabled: boolean;
  showLoadingScreen: boolean;
  setRetrySettings: (partial: Partial<RetrySettings>) => void;

  // Per-channel audio delay map (key: `${source_id}_${stream_id}`)
  channelAudioDelays: Record<string, number>;
  setChannelAudioDelays: (delays: Record<string, number>) => void;

  // Navigation tab visibility
  navHiddenTabs: string[];
  setNavHiddenTabs: (tabs: string[]) => void;

  // EPG button visibility
  epgHiddenButtons: string[];
  setEpgHiddenButtons: (buttons: string[]) => void;

  // UI visibility
  categoriesHidden: boolean;
  setCategoriesHidden: (hidden: boolean) => void;
  categoriesHiddenTransparent: boolean;
  setCategoriesHiddenTransparent: (hidden: boolean) => void;
  overlayAutohideTimer: number;
  setOverlayAutohideTimer: (seconds: number) => void;
  overlayOnClickOnly: boolean;
  setOverlayOnClickOnly: (enabled: boolean) => void;
  playerControlDesign: 'default' | 'clean';
  setPlayerControlDesign: (design: 'default' | 'clean') => void;
  showVolumePercent: boolean;
  setShowVolumePercent: (enabled: boolean) => void;

  // Widget scale
  widgetScale: number;
  setWidgetScale: (scale: number) => void;
  widgetBgOpacity: number;
  setWidgetBgOpacity: (opacity: number) => void;

  // Sports overlay
  sportsScale: number;
  setSportsScale: (scale: number) => void;
  sportsBgOpacity: number;
  setSportsBgOpacity: (opacity: number) => void;

  // Startup view
  startupView: 'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'sports' | 'calendar' | 'stremio' | 'nuvio';
  setStartupView: (view: 'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'sports' | 'calendar' | 'stremio' | 'nuvio') => void;

  // Google Cast
  castEnabled: boolean;
  setCastEnabled: (enabled: boolean) => void;
  castRewriteTs: boolean;
  setCastRewriteTs: (enabled: boolean) => void;

  // External player
  externalPlayerPath: string;
  setExternalPlayerPath: (path: string) => void;
  externalPlayerArgs: string;
  setExternalPlayerArgs: (args: string) => void;
  externalPlayerReuse: boolean;
  setExternalPlayerReuse: (reuse: boolean) => void;

  // Discord Rich Presence
  discordRichPresence: boolean;
  setDiscordRichPresence: (enabled: boolean) => void;
  discordHideTitle: boolean;
  setDiscordHideTitle: (hide: boolean) => void;
  discordShowWhenPaused: boolean;
  setDiscordShowWhenPaused: (show: boolean) => void;
  discordShowWhenBrowsing: boolean;
  setDiscordShowWhenBrowsing: (show: boolean) => void;
  discordShowPoster: boolean;
  setDiscordShowPoster: (show: boolean) => void;
  discordShowTimestamp: boolean;
  setDiscordShowTimestamp: (show: boolean) => void;

  // Theme Optimization
  hardwareAcceleration: boolean;
  setHardwareAcceleration: (enabled: boolean) => void;
  disableThemeBackdropBlur: boolean;
  setDisableThemeBackdropBlur: (disabled: boolean) => void;
  oledBlack: boolean;
  setOledBlack: (enabled: boolean) => void;
  epgLazyLoadingEnabled: boolean;
  setEpgLazyLoadingEnabled: (enabled: boolean) => void;
  disableEpgTransitions: boolean;
  setDisableEpgTransitions: (disabled: boolean) => void;
  epgReduceGpuLayers: boolean;
  setEpgReduceGpuLayers: (enabled: boolean) => void;
  epgDisableChannelFade: boolean;
  setEpgDisableChannelFade: (enabled: boolean) => void;
  epgPreferEpgLogos: boolean;
  setEpgPreferEpgLogos: (enabled: boolean) => void;
  epgLogoDisplay: 'square' | 'rectangle';
  setEpgLogoDisplay: (display: 'square' | 'rectangle') => void;

  // Logo / EPG metadata
  channelLogoSize: number;
  setChannelLogoSize: (size: number) => void;
  channelLogoRoundEdges: boolean;
  setChannelLogoRoundEdges: (enabled: boolean) => void;
  channelLogoPadding: 'none' | 'padded';
  setChannelLogoPadding: (padding: 'none' | 'padded') => void;
  logoSmartTrim: boolean;
  setLogoSmartTrim: (enabled: boolean) => void;
  logoLightBackgroundDetection: boolean;
  setLogoLightBackgroundDetection: (enabled: boolean) => void;
  sourceLogoDisplayOverrides: Record<string, 'square' | 'rectangle'>;
  setSourceLogoDisplayOverride: (sourceId: string, display: 'square' | 'rectangle' | 'default') => void;
  epgMetadataBadgeResolution: boolean;
  setEpgMetadataBadgeResolution: (enabled: boolean) => void;
  epgMetadataBadgeFps: boolean;
  setEpgMetadataBadgeFps: (enabled: boolean) => void;
  epgMetadataBadgeFpsSuffix: boolean;
  setEpgMetadataBadgeFpsSuffix: (enabled: boolean) => void;
  epgMetadataBadgeSound: boolean;
  setEpgMetadataBadgeSound: (enabled: boolean) => void;
  logoCacheEnabled: boolean;
  setLogoCacheEnabled: (enabled: boolean) => void;
  logoCacheMaxMb: number;
  setLogoCacheMaxMb: (mb: number) => void;
  logoCacheTtlDays: number;
  setLogoCacheTtlDays: (days: number) => void;
  logoCachePrefetch: boolean;
  setLogoCachePrefetch: (enabled: boolean) => void;

  // Catch-up
  catchupStartPadding: number;
  setCatchupStartPadding: (padding: number) => void;
  catchupEndPadding: number;
  setCatchupEndPadding: (padding: number) => void;
  catchupContinuePlaying: boolean;
  setCatchupContinuePlaying: (continuePlaying: boolean) => void;

  // VOD
  vodAutoPlayNextEpisode: boolean;
  setVodAutoPlayNextEpisode: (enabled: boolean) => void;
  vodShowSourceBadge: boolean;
  setVodShowSourceBadge: (enabled: boolean) => void;
  failoverGroupShowSource: boolean;
  setFailoverGroupShowSource: (enabled: boolean) => void;

  // Custom scrollbar
  enableCustomScrollbarWidth: boolean;
  setEnableCustomScrollbarWidth: (enabled: boolean) => void;
  customScrollbarWidth: number;
  setCustomScrollbarWidth: (width: number) => void;

  // Misc
  globalLiveTvUserAgent: string;
  setGlobalLiveTvUserAgent: (ua: string) => void;

  // EPG cosmetic classes (load-time only — hydrated, no setters)
  epgDarkenCurrent: boolean;
  epgHighlightBorderCurrent: boolean;
  epgBoldChannelNames: boolean;
  epgBoldTopCategories: boolean;
  epgBoldSourceCategories: boolean;
}

const DEFAULT_CUSTOM_THEME_CONFIG: CustomThemeConfig = {
  backgroundType: 'solid',
  backgroundColor: '#1a1a1a',
  gradientStart: '#1a0b2e',
  gradientMiddle: '#4a1a6b',
  gradientEnd: '#2d1b4e',
  gradientColor4: '#1a0b2e',
  gradientColor5: '#2d1b4e',
  accentColor: '#00d4ff',
  textColor: '#ffffff',
  textSecondaryColor: 'rgba(255,255,255,0.7)',
  surfaceColor: '#282828',
  surfaceOpacity: 0.85,
  surfaceBorderColor: '#ffffff',
  surfaceBorderOpacity: 0.1,
  glassBlur: 20,
  glassSaturation: 150,
  customBlob1: '#00bbf5',
  customBlob2: '#ff1493',
  customBlob3: '#ffd700',
  customBlob4: '#76ff03',
  customBlob1Opacity: 0.55,
  customBlob2Opacity: 0.45,
  customBlob3Opacity: 0.35,
  customBlob4Opacity: 0.3,
  showGlassBlobs: true,
  fontFamily: 'inter',
};

// Single source of truth for the subtitle defaults — SubtitlesTab merges its
// incoming settings over this, and hydration fills gaps with it, so a partial
// stored blob (old export, fresh install) never leaves required fields missing.
export const DEFAULT_SUBTITLE_SETTINGS: SubtitleSettings = {
  subsourceApiKey: '',
  openSubtitlesToken: '',
  openSubtitlesUser: undefined,
  openSubtitlesUsername: '',
  openSubtitlesPassword: '',
  preferredProvider: 'subsource',
  defaultLanguage: 'en',
  defaultAudioLanguage: 'default',
  defaultSize: 35,
  subColor: '#FFFFFF',
  subBackgroundColor: '#000000',
  subBackgroundEnabled: false,
  subBackgroundOpacity: 80,
  subOutlineColor: '#000000',
  subDelay: 0,
  subVerticalOffset: 90,
  subAssOverride: 'yes',
  subAlign: 'center',
  audioDevice: 'auto',
};

function getInitialTheme(): ThemeId {
  if (cachedSettings?.theme) return cachedSettings.theme as ThemeId;
  if (typeof document !== 'undefined') {
    const activeDomTheme = document.documentElement.getAttribute('data-theme');
    if (activeDomTheme) return activeDomTheme as ThemeId;
  }
  return 'dark-cyan';
}

function getInitialCustomThemeConfig(): CustomThemeConfig {
  if (cachedSettings?.customThemeConfig) {
    return cachedSettings.customThemeConfig;
  }
  try {
    const existing = typeof localStorage !== 'undefined' ? localStorage.getItem('app-settings') : null;
    if (existing) {
      const parsed = JSON.parse(existing);
      if (parsed.customThemeConfig) {
        return parsed.customThemeConfig;
      }
    }
  } catch (e) {}
  return DEFAULT_CUSTOM_THEME_CONFIG;
}

function getInitialLanguage(): string {
  if (typeof cachedSettings?.language === 'string' && isSupportedLocale(cachedSettings.language)) {
    return cachedSettings.language;
  }
  return i18n.language || 'en';
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  // i18n / language
  language: getInitialLanguage(),
  setLanguage: async (lang: string) => {
    set({ language: lang });
    persistSettings({ language: lang });
    await i18n.changeLanguage(lang);
  },

  // Layout persistence
  rememberLastChannels: false,
  reopenLastOnStartup: false,
  savedLayoutState: null,
  layoutSettingsLoaded: false,

  // Timeshift
  timeshiftEnabled: true,
  timeshiftCacheBytes: 268_435_456, // Default 256MB
  liveBufferOffset: 0,

  // Search
  includeSourceInSearch: false,
  includeSourceInVodSearch: false,
  maxSearchResults: 200,
  searchResultsOrder: 'default',
  sourceFontSize: 12,
  setSourceFontSize: (size) => {
    set({ sourceFontSize: size });
    persistSettings({ sourceFontSize: size }, true);
  },

  // UI font sizes (CSS vars owned by the DOM applier)
  channelFontSize: (cachedSettings?.channelFontSize as number) ?? 12,
  setChannelFontSize: (size) => {
    set({ channelFontSize: size });
    persistSettings({ channelFontSize: size }, true);
  },
  categoryFontSize: (cachedSettings?.categoryFontSize as number) ?? 13,
  setCategoryFontSize: (size) => {
    set({ categoryFontSize: size });
    persistSettings({ categoryFontSize: size }, true);
  },
  epgTitleFontSize: (cachedSettings?.epgTitleFontSize as number) ?? 32,
  setEpgTitleFontSize: (size) => {
    set({ epgTitleFontSize: size });
    persistSettings({ epgTitleFontSize: size }, true);
  },
  epgBodyFontSize: (cachedSettings?.epgBodyFontSize as number) ?? 16,
  setEpgBodyFontSize: (size) => {
    set({ epgBodyFontSize: size });
    persistSettings({ epgBodyFontSize: size }, true);
  },

  // UI scale (--app-zoom)
  uiScale: (cachedSettings?.uiScale as number) ?? 100,
  setUiScale: (scale) => {
    set({ uiScale: scale });
    persistSettings({ uiScale: scale }, true);
  },

  // Transparent guide overlay (CSS vars owned by the DOM applier)
  transparentGuideHeight: (cachedSettings?.transparentGuideHeight as number) ?? 40,
  setTransparentGuideHeight: (height) => {
    set({ transparentGuideHeight: height });
    persistSettings({ transparentGuideHeight: height });
  },
  transparentGuideHideHeader: (cachedSettings?.transparentGuideHideHeader as boolean) ?? false,
  setTransparentGuideHideHeader: (hide) => {
    set({ transparentGuideHideHeader: hide });
    persistSettings({ transparentGuideHideHeader: hide });
  },
  transparentGuideOverlayOpacity: (cachedSettings?.transparentGuideOverlayOpacity as number) ?? 55,
  setTransparentGuideOverlayOpacity: (opacity) => {
    set({ transparentGuideOverlayOpacity: opacity });
    persistSettings({ transparentGuideOverlayOpacity: opacity });
  },
  transparentGuideSidebarOpacity: (cachedSettings?.transparentGuideSidebarOpacity as number) ?? 55,
  setTransparentGuideSidebarOpacity: (opacity) => {
    set({ transparentGuideSidebarOpacity: opacity });
    persistSettings({ transparentGuideSidebarOpacity: opacity });
  },

  // LAN source security gate
  allowLanSources: (cachedSettings?.allowLanSources as boolean) ?? false,
  setAllowLanSources: (allowed) => {
    set({ allowLanSources: allowed });
    persistSettings({ allowLanSources: allowed });
  },

  // UI design version — the v3-default migration latches in hydration
  modernUiEnabled: (cachedSettings?.modernUiEnabled as 'v1' | 'v2' | 'v3' | false | undefined) ?? 'v3',
  setModernUiEnabled: (value) => {
    set({ modernUiEnabled: value });
    persistSettings({ modernUiEnabled: value });
  },
  v3DefaultMigrated: (cachedSettings?.v3DefaultMigrated as boolean) ?? false,

  // Category display
  categorySortOrder: 'default',
  setCategorySortOrder: (order) => {
    set({ categorySortOrder: order });
    persistSettings({ categorySortOrder: order });
  },
  includeAllChannelsToPlaylist: false,
  setIncludeAllChannelsToPlaylist: (enabled) => {
    set({ includeAllChannelsToPlaylist: enabled });
    persistSettings({ includeAllChannelsToPlaylist: enabled });
  },
  hideDisabledSources: false,
  setHideDisabledSources: (hidden) => {
    set({ hideDisabledSources: hidden });
    persistSettings({ hideDisabledSources: hidden });
  },

  // Advanced search
  advancedSearchScope: 'both',
  advancedSearchSourceIds: [],
  advancedSearchCategoryIds: [],
  useAdvancedSearchForRegular: false,
  searchCustomPlaylists: false,
  setAdvancedSearchScope: (scope) => {
    set({ advancedSearchScope: scope });
    persistSettings({ advancedSearchScope: scope });
  },
  setAdvancedSearchSourceIds: (ids) => {
    set({ advancedSearchSourceIds: ids });
    persistSettings({ advancedSearchSourceIds: ids });
  },
  setAdvancedSearchCategoryIds: (ids) => {
    set({ advancedSearchCategoryIds: ids });
    persistSettings({ advancedSearchCategoryIds: ids });
  },
  setUseAdvancedSearchForRegular: (use) => {
    set({ useAdvancedSearchForRegular: use });
    persistSettings({ useAdvancedSearchForRegular: use });
  },
  setSearchCustomPlaylists: (enabled) => {
    set({ searchCustomPlaylists: enabled });
    persistSettings({ searchCustomPlaylists: enabled });
  },

  // LiveTV channel-info overlay
  channelInfoOverlayEnabled: false,
  setChannelInfoOverlayEnabled: (enabled) => {
    set({ channelInfoOverlayEnabled: enabled });
    persistSettings({ channelInfoOverlayEnabled: enabled });
  },
  channelInfoOverlayFontSize: 16,
  setChannelInfoOverlayFontSize: (size) => {
    set({ channelInfoOverlayFontSize: size });
    persistSettings({ channelInfoOverlayFontSize: size }, true);
  },
  channelInfoOverlayLogoSize: 42,
  setChannelInfoOverlayLogoSize: (size) => {
    set({ channelInfoOverlayLogoSize: size });
    persistSettings({ channelInfoOverlayLogoSize: size }, true);
  },
  channelInfoOverlayBoxWidth: 380,
  setChannelInfoOverlayBoxWidth: (width) => {
    set({ channelInfoOverlayBoxWidth: width });
    persistSettings({ channelInfoOverlayBoxWidth: width }, true);
  },
  channelInfoOverlayOpacity: 55,
  setChannelInfoOverlayOpacity: (opacity) => {
    set({ channelInfoOverlayOpacity: opacity });
    persistSettings({ channelInfoOverlayOpacity: opacity }, true);
  },
  channelInfoOverlayHideDescription: false,
  setChannelInfoOverlayHideDescription: (hide) => {
    set({ channelInfoOverlayHideDescription: hide });
    persistSettings({ channelInfoOverlayHideDescription: hide });
  },
  channelInfoOverlayHideMetaBadge: false,
  setChannelInfoOverlayHideMetaBadge: (hide) => {
    set({ channelInfoOverlayHideMetaBadge: hide });
    persistSettings({ channelInfoOverlayHideMetaBadge: hide });
  },
  channelInfoOverlayHideLogo: false,
  setChannelInfoOverlayHideLogo: (hide) => {
    set({ channelInfoOverlayHideLogo: hide });
    persistSettings({ channelInfoOverlayHideLogo: hide });
  },
  channelInfoOverlayHideTimer: false,
  setChannelInfoOverlayHideTimer: (hide) => {
    set({ channelInfoOverlayHideTimer: hide });
    persistSettings({ channelInfoOverlayHideTimer: hide });
  },
  channelInfoOverlayPosition: 'left',
  setChannelInfoOverlayPosition: (pos) => {
    set({ channelInfoOverlayPosition: pos });
    persistSettings({ channelInfoOverlayPosition: pos });
  },
  channelInfoOverlayLogoShape: 'square',
  setChannelInfoOverlayLogoShape: (shape) => {
    set({ channelInfoOverlayLogoShape: shape });
    persistSettings({ channelInfoOverlayLogoShape: shape });
  },
  transparentGuideOnZap: false,
  setTransparentGuideOnZap: (enabled) => {
    set({ transparentGuideOnZap: enabled });
    persistSettings({ transparentGuideOnZap: enabled });
  },

  // Popout
  popoutStopMain: true,
  setPopoutStopMain: (stop) => {
    set({ popoutStopMain: stop });
    persistSettings({ popoutStopMain: stop });
  },
  popoutAlwaysOnTop: false,
  setPopoutAlwaysOnTop: (onTop) => {
    set({ popoutAlwaysOnTop: onTop });
    persistSettings({ popoutAlwaysOnTop: onTop });
  },
  popoutHwdecEnabled: true,
  setPopoutHwdecEnabled: (enabled) => {
    set({ popoutHwdecEnabled: enabled });
    persistSettings({ popoutHwdecEnabled: enabled });
  },
  popoutMpvParamsEnabled: false,
  setPopoutMpvParamsEnabled: (enabled) => {
    set({ popoutMpvParamsEnabled: enabled });
    persistSettings({ popoutMpvParamsEnabled: enabled });
  },
  popoutMpvParams: '',
  setPopoutMpvParams: (params) => {
    set({ popoutMpvParams: params });
    persistSettings({ popoutMpvParams: params }, true);
  },

  // Theme
  theme: getInitialTheme(),
  customThemeConfig: getInitialCustomThemeConfig(),
  savedCustomThemes: [],
  setSavedCustomThemes: (themes) => {
    set({ savedCustomThemes: themes });
    persistSettings({ savedCustomThemes: themes });
  },
  setTheme: (newTheme) => {
    set({ theme: newTheme });
    persistSettings({ theme: newTheme });
  },
  updateCustomThemeConfig: (newConfig) => {
    const updated = { ...get().customThemeConfig, ...newConfig };
    set({ customThemeConfig: updated });
    persistSettings({ customThemeConfig: updated });
  },

  // Global fonts
  appFontFamily: (cachedSettings?.appFontFamily as string) || 'inter',
  appCustomFontBase64: (cachedSettings?.appCustomFontBase64 as string) || '',
  appCustomFontFormat: (cachedSettings?.appCustomFontFormat as string) || '',
  appCustomFontName: (cachedSettings?.appCustomFontName as string) || '',
  updateAppFont: async (family, base64 = '', format = '', name = '') => {
    set({ appFontFamily: family, appCustomFontBase64: base64, appCustomFontFormat: format, appCustomFontName: name });
    persistSettings({ appFontFamily: family, appCustomFontBase64: base64, appCustomFontFormat: format, appCustomFontName: name });
  },

  // Shortcuts — previously `setShortcuts` never persisted (pre-existing bug:
  // changes died on restart). Fixed during the Phase 4 consumer conversion.
  shortcuts: {},
  setShortcuts: (newShortcuts) => {
    set({ shortcuts: newShortcuts });
    persistSettings({ shortcuts: newShortcuts });
  },

  // Navigation tab visibility
  navHiddenTabs: [],
  setNavHiddenTabs: (tabs) => {
    set({ navHiddenTabs: tabs });
    persistSettings({ navHiddenTabs: tabs });
  },

  // EPG button visibility
  epgHiddenButtons: [],
  setEpgHiddenButtons: (buttons) => {
    set({ epgHiddenButtons: buttons });
    persistSettings({ epgHiddenButtons: buttons });
  },

  // UI visibility
  categoriesHidden: false,
  setCategoriesHidden: (hidden) => {
    set({ categoriesHidden: hidden });
    persistSettings({ categoriesHidden: hidden });
  },
  categoriesHiddenTransparent: false,
  setCategoriesHiddenTransparent: (hidden) => {
    set({ categoriesHiddenTransparent: hidden });
    persistSettings({ categoriesHiddenTransparent: hidden });
  },
  overlayAutohideTimer: 3,
  setOverlayAutohideTimer: (seconds) => {
    set({ overlayAutohideTimer: seconds });
    persistSettings({ overlayAutohideTimer: seconds }, true);
  },
  overlayOnClickOnly: false,
  setOverlayOnClickOnly: (enabled) => {
    set({ overlayOnClickOnly: enabled });
    persistSettings({ overlayOnClickOnly: enabled });
  },
  playerControlDesign: 'clean',
  setPlayerControlDesign: (design) => {
    set({ playerControlDesign: design });
    persistSettings({ playerControlDesign: design });
  },
  showVolumePercent: false,
  setShowVolumePercent: (enabled) => {
    set({ showVolumePercent: enabled });
    persistSettings({ showVolumePercent: enabled });
  },

  // Widget scale
  widgetScale: 1,
  setWidgetScale: (scale) => {
    set({ widgetScale: scale });
    persistSettings({ widgetScale: scale }, true);
  },
  widgetBgOpacity: 0.55,
  setWidgetBgOpacity: (opacity) => {
    set({ widgetBgOpacity: opacity });
    persistSettings({ widgetBgOpacity: opacity }, true);
  },

  // Sports overlay
  sportsScale: 1,
  setSportsScale: (scale) => {
    set({ sportsScale: scale });
    persistSettings({ sportsScale: scale }, true);
  },
  sportsBgOpacity: 0.7,
  setSportsBgOpacity: (opacity) => {
    set({ sportsBgOpacity: opacity });
    persistSettings({ sportsBgOpacity: opacity }, true);
  },

  // Startup view
  startupView: 'none',
  setStartupView: (view) => {
    set({ startupView: view });
    persistSettings({ startupView: view });
  },

  // Google Cast
  castEnabled: false,
  setCastEnabled: (enabled) => {
    set({ castEnabled: enabled });
    persistSettings({ castEnabled: enabled });
  },
  castRewriteTs: true,
  setCastRewriteTs: (enabled) => {
    set({ castRewriteTs: enabled });
    persistSettings({ castRewriteTs: enabled });
  },

  // External player
  externalPlayerPath: '',
  setExternalPlayerPath: (path) => {
    set({ externalPlayerPath: path });
    persistSettings({ externalPlayerPath: path }, true);
  },
  externalPlayerArgs: '',
  setExternalPlayerArgs: (args) => {
    set({ externalPlayerArgs: args });
    persistSettings({ externalPlayerArgs: args }, true);
  },
  externalPlayerReuse: false,
  setExternalPlayerReuse: (reuse) => {
    set({ externalPlayerReuse: reuse });
    persistSettings({ externalPlayerReuse: reuse });
  },

  // Discord Rich Presence
  discordRichPresence: false,
  setDiscordRichPresence: (enabled) => {
    set({ discordRichPresence: enabled });
    persistSettings({ discordRichPresence: enabled });
  },
  discordHideTitle: false,
  setDiscordHideTitle: (hide) => {
    set({ discordHideTitle: hide });
    persistSettings({ discordHideTitle: hide });
  },
  discordShowWhenPaused: true,
  setDiscordShowWhenPaused: (show) => {
    set({ discordShowWhenPaused: show });
    persistSettings({ discordShowWhenPaused: show });
  },
  discordShowWhenBrowsing: true,
  setDiscordShowWhenBrowsing: (show) => {
    set({ discordShowWhenBrowsing: show });
    persistSettings({ discordShowWhenBrowsing: show });
  },
  discordShowPoster: true,
  setDiscordShowPoster: (show) => {
    set({ discordShowPoster: show });
    persistSettings({ discordShowPoster: show });
  },
  discordShowTimestamp: true,
  setDiscordShowTimestamp: (show) => {
    set({ discordShowTimestamp: show });
    persistSettings({ discordShowTimestamp: show });
  },

  // Theme Optimization
  hardwareAcceleration: true,
  setHardwareAcceleration: (enabled) => {
    set({ hardwareAcceleration: enabled });
    persistSettings({ hardwareAcceleration: enabled });
  },
  disableThemeBackdropBlur: false,
  setDisableThemeBackdropBlur: (disabled) => {
    set({ disableThemeBackdropBlur: disabled });
    persistSettings({ disableThemeBackdropBlur: disabled });
  },
  oledBlack: Boolean(cachedSettings?.oledBlack),
  setOledBlack: (enabled) => {
    set({ oledBlack: enabled });
    persistSettings({ oledBlack: enabled });
  },
  epgLazyLoadingEnabled: false,
  setEpgLazyLoadingEnabled: (enabled) => {
    set({ epgLazyLoadingEnabled: enabled });
    persistSettings({ epgLazyLoadingEnabled: enabled });
  },
  disableEpgTransitions: false,
  setDisableEpgTransitions: (disabled) => {
    set({ disableEpgTransitions: disabled });
    persistSettings({ disableEpgTransitions: disabled });
  },
  epgReduceGpuLayers: false,
  setEpgReduceGpuLayers: (enabled) => {
    set({ epgReduceGpuLayers: enabled });
    persistSettings({ epgReduceGpuLayers: enabled });
  },
  epgDisableChannelFade: false,
  setEpgDisableChannelFade: (enabled) => {
    set({ epgDisableChannelFade: enabled });
    persistSettings({ epgDisableChannelFade: enabled });
  },
  epgPreferEpgLogos: false,
  setEpgPreferEpgLogos: (enabled) => {
    set({ epgPreferEpgLogos: enabled });
    persistSettings({ epgPreferEpgLogos: enabled });
  },
  epgLogoDisplay: 'square',
  setEpgLogoDisplay: (display) => {
    set({ epgLogoDisplay: display });
    persistSettings({ epgLogoDisplay: display });
  },

  // Logo / EPG metadata
  channelLogoSize: (cachedSettings?.channelLogoSize as number) ?? 42,
  setChannelLogoSize: (size) => {
    set({ channelLogoSize: size });
    persistSettings({ channelLogoSize: size }, true);
  },
  channelLogoRoundEdges: (cachedSettings?.channelLogoRoundEdges as boolean) ?? true,
  setChannelLogoRoundEdges: (enabled) => {
    set({ channelLogoRoundEdges: enabled });
    persistSettings({ channelLogoRoundEdges: enabled });
  },
  channelLogoPadding: (cachedSettings?.channelLogoPadding as 'none' | 'padded') ?? 'none',
  setChannelLogoPadding: (padding) => {
    set({ channelLogoPadding: padding });
    persistSettings({ channelLogoPadding: padding });
  },
  logoSmartTrim: (cachedSettings?.logoSmartTrim as boolean) ?? false,
  setLogoSmartTrim: (enabled) => {
    set({ logoSmartTrim: enabled });
    persistSettings({ logoSmartTrim: enabled });
  },
  logoLightBackgroundDetection: (cachedSettings?.logoLightBackgroundDetection as boolean) ?? true,
  setLogoLightBackgroundDetection: (enabled) => {
    set({ logoLightBackgroundDetection: enabled });
    persistSettings({ logoLightBackgroundDetection: enabled });
  },
  sourceLogoDisplayOverrides: (cachedSettings?.sourceLogoDisplayOverrides as Record<string, 'square' | 'rectangle'>) ?? {},
  setSourceLogoDisplayOverride: (sourceId, display) => {
    const next = { ...get().sourceLogoDisplayOverrides };
    if (display === 'default') {
      delete next[sourceId];
    } else {
      next[sourceId] = display;
    }
    set({ sourceLogoDisplayOverrides: next });
    persistSettings({ sourceLogoDisplayOverrides: next });
  },
  epgMetadataBadgeResolution: (cachedSettings?.epgMetadataBadgeResolution as boolean) ?? true,
  setEpgMetadataBadgeResolution: (enabled) => {
    set({ epgMetadataBadgeResolution: enabled });
    persistSettings({ epgMetadataBadgeResolution: enabled });
  },
  epgMetadataBadgeFps: (cachedSettings?.epgMetadataBadgeFps as boolean) ?? true,
  setEpgMetadataBadgeFps: (enabled) => {
    set({ epgMetadataBadgeFps: enabled });
    persistSettings({ epgMetadataBadgeFps: enabled });
  },
  epgMetadataBadgeFpsSuffix: (cachedSettings?.epgMetadataBadgeFpsSuffix as boolean) ?? true,
  setEpgMetadataBadgeFpsSuffix: (enabled) => {
    set({ epgMetadataBadgeFpsSuffix: enabled });
    persistSettings({ epgMetadataBadgeFpsSuffix: enabled });
  },
  epgMetadataBadgeSound: (cachedSettings?.epgMetadataBadgeSound as boolean) ?? true,
  setEpgMetadataBadgeSound: (enabled) => {
    set({ epgMetadataBadgeSound: enabled });
    persistSettings({ epgMetadataBadgeSound: enabled });
  },
  logoCacheEnabled: (cachedSettings?.logoCacheEnabled as boolean) ?? false,
  setLogoCacheEnabled: (enabled) => {
    set({ logoCacheEnabled: enabled });
    persistSettings({ logoCacheEnabled: enabled });
  },
  logoCacheMaxMb: (cachedSettings?.logoCacheMaxMb as number) ?? 250,
  setLogoCacheMaxMb: (mb) => {
    set({ logoCacheMaxMb: mb });
    persistSettings({ logoCacheMaxMb: mb });
  },
  logoCacheTtlDays: (cachedSettings?.logoCacheTtlDays as number) ?? 30,
  setLogoCacheTtlDays: (days) => {
    set({ logoCacheTtlDays: days });
    persistSettings({ logoCacheTtlDays: days });
  },
  logoCachePrefetch: (cachedSettings?.logoCachePrefetch as boolean) ?? false,
  setLogoCachePrefetch: (enabled) => {
    set({ logoCachePrefetch: enabled });
    persistSettings({ logoCachePrefetch: enabled });
  },

  // Catch-up
  catchupStartPadding: 0,
  setCatchupStartPadding: (padding) => {
    set({ catchupStartPadding: padding });
    persistSettings({ catchupStartPadding: padding }, true);
    dispatchAppEvent('ynotv:catchup-settings-changed', { catchupStartPadding: padding });
  },
  catchupEndPadding: 0,
  setCatchupEndPadding: (padding) => {
    set({ catchupEndPadding: padding });
    persistSettings({ catchupEndPadding: padding }, true);
    dispatchAppEvent('ynotv:catchup-settings-changed', { catchupEndPadding: padding });
  },
  catchupContinuePlaying: false,
  setCatchupContinuePlaying: (continuePlaying) => {
    set({ catchupContinuePlaying: continuePlaying });
    persistSettings({ catchupContinuePlaying: continuePlaying });
    dispatchAppEvent('ynotv:catchup-settings-changed', { catchupContinuePlaying: continuePlaying });
  },

  // VOD
  vodAutoPlayNextEpisode: true,
  setVodAutoPlayNextEpisode: (enabled) => {
    set({ vodAutoPlayNextEpisode: enabled });
    persistSettings({ vodAutoPlayNextEpisode: enabled });
    dispatchAppEvent('ynotv:vod-settings-changed', { vodAutoPlayNextEpisode: enabled });
  },
  vodShowSourceBadge: false,
  setVodShowSourceBadge: (enabled) => {
    set({ vodShowSourceBadge: enabled });
    persistSettings({ vodShowSourceBadge: enabled });
    dispatchAppEvent('ynotv:vod-settings-changed', { vodShowSourceBadge: enabled });
  },
  failoverGroupShowSource: false,
  setFailoverGroupShowSource: (enabled) => {
    set({ failoverGroupShowSource: enabled });
    persistSettings({ failoverGroupShowSource: enabled });
    dispatchAppEvent('ynotv:livetv-settings-changed', { failoverGroupShowSource: enabled });
  },

  // Custom scrollbar
  enableCustomScrollbarWidth: false,
  setEnableCustomScrollbarWidth: (enabled) => {
    set({ enableCustomScrollbarWidth: enabled });
    persistSettings({ enableCustomScrollbarWidth: enabled });
  },
  customScrollbarWidth: 12,
  setCustomScrollbarWidth: (width) => {
    set({ customScrollbarWidth: width });
    persistSettings({ customScrollbarWidth: width }, true);
  },

  // Misc
  globalLiveTvUserAgent: '',
  setGlobalLiveTvUserAgent: (ua) => {
    set({ globalLiveTvUserAgent: ua });
    persistSettings({ globalLiveTvUserAgent: ua });
  },

  // Subtitle settings (debounced persist — mirrors the old Settings.tsx writer)
  subtitleSettings: DEFAULT_SUBTITLE_SETTINGS,
  setSubtitleSettings: (partial) => {
    const merged = { ...get().subtitleSettings, ...partial };
    set({ subtitleSettings: merged });
    persistSettings({ subtitleSettings: merged }, true);
  },

  // Global EPG links
  globalEpgLinks: [],
  setGlobalEpgLinks: (links) => {
    set({ globalEpgLinks: links });
    persistSettings({ globalEpgLinks: links });
  },

  // Streaming catalogs — setters dispatch the legacy event so any remaining
  // listener (or future code) still gets notified.
  streamingCatalogsEnabled: true,
  setStreamingCatalogsEnabled: (enabled) => {
    set({ streamingCatalogsEnabled: enabled });
    persistSettings({ streamingCatalogsEnabled: enabled });
    dispatchAppEvent('ynotv:streaming-catalogs-changed', {});
  },
  streamingNuvioCatalogsEnabled: true,
  setStreamingNuvioCatalogsEnabled: (enabled) => {
    set({ streamingNuvioCatalogsEnabled: enabled });
    persistSettings({ streamingNuvioCatalogsEnabled: enabled });
    dispatchAppEvent('ynotv:streaming-catalogs-changed', {});
  },
  enabledStreamingServices: ['netflix', 'disney', 'hulu', 'prime', 'apple', 'max', 'paramount', 'peacock'],
  setEnabledStreamingServices: (services) => {
    set({ enabledStreamingServices: services });
    persistSettings({ enabledStreamingServices: services });
    dispatchAppEvent('ynotv:streaming-catalogs-changed', {});
  },

  // VOD trailer preferences
  trailerSource: 'source',
  setTrailerSource: (source) => {
    set({ trailerSource: source });
    persistSettings({ trailerSource: source });
  },
  trailerPlayerMode: 'embedded',
  setTrailerPlayerMode: (mode) => {
    set({ trailerPlayerMode: mode });
    persistSettings({ trailerPlayerMode: mode });
  },

  // Metadata APIs — setTmdbApiKey dispatches the legacy event so Nuvio-sync
  // listeners and other consumers still get notified.
  tmdbApiKey: '',
  setTmdbApiKey: (key) => {
    set({ tmdbApiKey: key });
    persistSettings({ tmdbApiKey: key });
    dispatchAppEvent('ynotv:tmdb-key-changed', {});
  },
  posterDbApiKey: '',
  setPosterDbApiKey: (key) => {
    set({ posterDbApiKey: key });
    persistSettings({ posterDbApiKey: key });
  },
  rpdbBackdropsEnabled: false,
  setRpdbBackdropsEnabled: (enabled) => {
    set({ rpdbBackdropsEnabled: enabled });
    persistSettings({ rpdbBackdropsEnabled: enabled });
  },

  // Downloads default directory
  downloadsPath: '',
  setDownloadsPath: (path) => {
    set({ downloadsPath: path });
    persistSettings({ downloadsPath: path });
  },

  // TMDB genre carousel enablement
  movieGenresEnabled: [],
  setMovieGenresEnabled: (genres) => {
    set({ movieGenresEnabled: genres });
    persistSettings({ movieGenresEnabled: genres });
  },
  seriesGenresEnabled: [],
  setSeriesGenresEnabled: (genres) => {
    set({ seriesGenresEnabled: genres });
    persistSettings({ seriesGenresEnabled: genres });
  },

  // Trakt integration — the setter accepts a service-shaped partial and maps it
  // to the flat storage keys (backward compatible with existing exports).
  traktEnabled: false,
  traktAccessToken: null,
  traktRefreshToken: null,
  traktTokenExpiresAt: null,
  traktScrobbleEnabled: false,
  traktSyncEnabled: false,
  traktCatalogsEnabled: {},
  traktCatalogOrder: [],
  traktCatalogsBeforeAddon: false,
  traktEnabledLists: [],
  traktNuvioCatalogsEnabled: {},
  traktNuvioCatalogOrder: [],
  traktNuvioCatalogsBeforeAddon: false,
  traktNuvioEnabledLists: [],
  setTraktSettings: (partial) => {
    const patch: Record<string, any> = {};
    // `in` (not `!== undefined`) so an explicitly-passed undefined clears the
    // field — the scrobbler's logout writes undefined to wipe catalogs/lists.
    if ('traktEnabled' in partial) patch.traktEnabled = partial.traktEnabled ?? false;
    if ('traktAccessToken' in partial) patch.traktAccessToken = partial.traktAccessToken ?? null;
    if ('traktRefreshToken' in partial) patch.traktRefreshToken = partial.traktRefreshToken ?? null;
    if ('traktTokenExpiresAt' in partial) patch.traktTokenExpiresAt = partial.traktTokenExpiresAt ?? null;
    if ('traktScrobbleEnabled' in partial) patch.traktScrobbleEnabled = partial.traktScrobbleEnabled ?? false;
    if ('traktSyncEnabled' in partial) patch.traktSyncEnabled = partial.traktSyncEnabled ?? false;
    if ('traktCatalogsEnabled' in partial) patch.traktCatalogsEnabled = partial.traktCatalogsEnabled ?? {};
    if ('traktCatalogOrder' in partial) patch.traktCatalogOrder = partial.traktCatalogOrder ?? [];
    if ('traktCatalogsBeforeAddon' in partial) patch.traktCatalogsBeforeAddon = partial.traktCatalogsBeforeAddon ?? false;
    if ('traktEnabledLists' in partial) patch.traktEnabledLists = partial.traktEnabledLists ?? [];
    if ('traktNuvioCatalogsEnabled' in partial) patch.traktNuvioCatalogsEnabled = partial.traktNuvioCatalogsEnabled ?? {};
    if ('traktNuvioCatalogOrder' in partial) patch.traktNuvioCatalogOrder = partial.traktNuvioCatalogOrder ?? [];
    if ('traktNuvioCatalogsBeforeAddon' in partial) patch.traktNuvioCatalogsBeforeAddon = partial.traktNuvioCatalogsBeforeAddon ?? false;
    if ('traktNuvioEnabledLists' in partial) patch.traktNuvioEnabledLists = partial.traktNuvioEnabledLists ?? [];
    set(patch);
    persistSettings(patch);
  },

  // Simkl integration
  simklEnabled: false,
  simklAccessToken: null,
  simklScrobbleEnabled: false,
  setSimklSettings: (partial) => {
    const patch: Record<string, any> = {};
    if (partial.simklEnabled !== undefined) patch.simklEnabled = partial.simklEnabled;
    if (partial.simklAccessToken !== undefined) patch.simklAccessToken = partial.simklAccessToken;
    if (partial.simklScrobbleEnabled !== undefined) patch.simklScrobbleEnabled = partial.simklScrobbleEnabled;
    set(patch);
    persistSettings(patch);
  },

  // TV calendar auto-sync
  tvCalendarAutoSync: true,
  setTvCalendarAutoSync: (enabled) => {
    set({ tvCalendarAutoSync: enabled });
    persistSettings({ tvCalendarAutoSync: enabled });
  },

  // Category sidebar visibility — the setter dispatches the legacy event so
  // Settings.tsx's local-state listener stays in sync.
  showAllChannels: true,
  showFavorites: true,
  showWatchlist: true,
  showRecentlyViewed: true,
  favoritesMode: 'global',
  setCategorySettings: (partial) => {
    const patch: Record<string, any> = {};
    if (partial.showAllChannels !== undefined) patch.showAllChannels = partial.showAllChannels;
    if (partial.showFavorites !== undefined) patch.showFavorites = partial.showFavorites;
    if (partial.showWatchlist !== undefined) patch.showWatchlist = partial.showWatchlist;
    if (partial.showRecentlyViewed !== undefined) patch.showRecentlyViewed = partial.showRecentlyViewed;
    if (partial.favoritesMode !== undefined) patch.favoritesMode = partial.favoritesMode;
    set(patch);
    persistSettings(patch);
    if (Object.keys(patch).length > 0) {
      dispatchAppEvent('ynotv:category-settings-changed', patch);
    }
  },
  collapseSourceCategoriesOnStartup: false,
  setCollapseSourceCategoriesOnStartup: (enabled) => {
    set({ collapseSourceCategoriesOnStartup: enabled });
    persistSettings({ collapseSourceCategoriesOnStartup: enabled });
  },

  // Playback retry / stream-tuning knobs — the setter dispatches the legacy
  // event so usePlayback's live-ref listener still gets notified.
  streamMaxRetries: 20,
  streamWatchdogSeconds: 10,
  useEventBasedReconnect: false,
  stallDetectionEnabled: true,
  showLoadingScreen: false,
  setRetrySettings: (partial) => {
    const patch: Record<string, any> = {};
    if ('streamMaxRetries' in partial) patch.streamMaxRetries = partial.streamMaxRetries;
    if ('streamWatchdogSeconds' in partial) patch.streamWatchdogSeconds = partial.streamWatchdogSeconds;
    if ('useEventBasedReconnect' in partial) patch.useEventBasedReconnect = partial.useEventBasedReconnect;
    if ('stallDetectionEnabled' in partial) patch.stallDetectionEnabled = partial.stallDetectionEnabled;
    if ('showLoadingScreen' in partial) patch.showLoadingScreen = partial.showLoadingScreen;
    set(patch);
    persistSettings(patch, true); // debounced — the old Settings writers used debouncedUpdateSettings
    if (Object.keys(patch).length > 0) {
      dispatchAppEvent('ynotv:retry-settings-changed', patch);
    }
  },

  // Per-channel audio delay map (key: `${source_id}_${stream_id}`)
  channelAudioDelays: {},
  setChannelAudioDelays: (delays) => {
    set({ channelAudioDelays: delays });
    persistSettings({ channelAudioDelays: delays });
  },

  // Automated backups — the setter accepts the service-shaped partial and maps
  // it to the flat storage keys, persisting through the write queue and
  // notifying the scheduler so it reschedules immediately.
  autoBackupEnabled: true,
  autoBackupIntervalHours: 24,
  autoBackupMaxBackups: 5,
  autoBackupDirectory: '',
  setAutoBackupSettings: (partial) => {
    const patch: Record<string, any> = {};
    if (partial.enabled !== undefined) patch.autoBackupEnabled = partial.enabled;
    if (partial.intervalHours !== undefined) patch.autoBackupIntervalHours = partial.intervalHours;
    if (partial.maxBackups !== undefined) patch.autoBackupMaxBackups = partial.maxBackups;
    if (partial.directory !== undefined) patch.autoBackupDirectory = partial.directory;
    set(patch);
    persistSettings(patch);
    dispatchAppEvent('ynotv:auto-backup-settings-changed', {});
  },

  // EPG cosmetic classes (load-time only — hydrated from settings, no setters)
  epgDarkenCurrent: false,
  epgHighlightBorderCurrent: false,
  epgBoldChannelNames: false,
  epgBoldTopCategories: false,
  epgBoldSourceCategories: false,
}));
