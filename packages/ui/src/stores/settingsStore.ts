import { create } from 'zustand';
import type { SavedLayoutState } from '../hooks/useLayoutPersistence';
import type { ThemeId, CustomThemeConfig, ShortcutsMap, GlobalEpgLink } from '../types/app';
import type { SubtitleSettings } from '../components/settings/SubtitlesTab';
import type { AutoBackupSettings } from '../services/autoBackup';
import type { TrailerSource, VodPlayerMode } from '../components/vod/SplitPlayButton';
import type { PhoneRemoteConfig } from '../types/phoneRemote';
import { DEFAULT_PHONE_REMOTE_CONFIG } from '../types/phoneRemote';
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
function persistSettings(patch: Record<string, any>, debounced = false): Promise<void> | void {
  if (typeof window === 'undefined' || !window.storage) return;
  if (debounced) {
    try {
      window.storage.debouncedUpdateSettings(patch);
    } catch (e) {
      console.error('[settingsStore] Failed to save (debounced):', e);
    }
    return;
  }
  // Return the write promise so callers can await actual persistence — e.g.
  // the Optimization restart flow must not relaunch before the disk write
  // completes, or the user's toggle choice is lost.
  return window.storage.updateSettings(patch).then(
    () => undefined,
    (e) => {
      console.error('[settingsStore] Failed to save:', e);
    },
  );
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

export interface JellyfinSettings {
  jellyfinEnabled: boolean;
  jellyfinTraktScrobbleEnabled: boolean;
  jellyfinSimklScrobbleEnabled: boolean;
  jellyfinDebugLoggingEnabled: boolean;
}

export interface CategorySettings {
  showAllChannels: boolean;
  showFavorites: boolean;
  showWatchlist: boolean;
  showRecentlyViewed: boolean;
  favoritesMode: 'global' | 'perSource' | 'both';
  alwaysSortFavoritesAlphabetically: boolean;
}

export interface VodNavigationSettings {
  showVodAll: boolean;
  showVodFavorites: boolean;
  showVodPlaylists: boolean;
  showVodLocal: boolean;
  showVodRecent: boolean;
}

/** Any subset of the time-shift settings, applied together (see setTimeshiftSettings). */
export interface TimeshiftSettings {
  timeshiftEnabled: boolean;
  timeshiftCacheBytes: number;
  liveBufferOffset: number;
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
  setTimeshiftCacheBytes: (bytes: number) => void;
  liveBufferOffset: number;
  /**
   * Apply any of the time-shift settings together. The player reads these
   * values from the store, so this is what makes a change take effect on the
   * stream that is already playing instead of only on the next app launch.
   */
  setTimeshiftSettings: (partial: Partial<TimeshiftSettings>) => void;

  // Search
  includeSourceInSearch: boolean;
  includeSourceInVodSearch: boolean;
  maxSearchResults: number;
  searchResultsOrder: 'default' | 'alphabetical';
  sourceFontSize: number;
  setSourceFontSize: (size: number) => void;

  // Stremio/Nuvio detail badge scale (CSS vars owned by the DOM applier)
  stremioBadgeSize: number;
  setStremioBadgeSize: (size: number) => void;
  nuvioBadgeSize: number;
  setNuvioBadgeSize: (size: number) => void;

  // UI font sizes (CSS vars owned by the DOM applier)
  channelFontSize: number;
  setChannelFontSize: (size: number) => void;
  categoryFontSize: number;
  setCategoryFontSize: (size: number) => void;
  epgTitleFontSize: number;
  setEpgTitleFontSize: (size: number) => void;
  epgBodyFontSize: number;
  setEpgBodyFontSize: (size: number) => void;
  // Program text size in the EPG time grid (--prog-title-font-size / --prog-desc-font-size)
  epgProgramFontSize: number;
  setEpgProgramFontSize: (size: number) => void;

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

  // Auto-hide the category sidebar in LiveTV: hidden by default, pops open
  // over the guide on left-edge hover, and hides again after a category click
  // or when the mouse leaves it. When off, the classic persistent sidebar.
  categorySidebarAutohide: boolean;
  setCategorySidebarAutohide: (enabled: boolean) => void;

  // LAN source security gate (SourcesTab save-time check)
  allowLanSources: boolean;
  setAllowLanSources: (allowed: boolean) => void;

  // UI design version — the v3-default migration latches in hydration
  modernUiEnabled: 'v1' | 'v2' | 'v3' | false;
  setModernUiEnabled: (value: 'v1' | 'v2' | 'v3' | false) => void;
  v3DefaultMigrated: boolean;
  volumePercentDefaultMigrated: boolean;
  subAssOverrideDefaultMigrated: boolean;
  // One-time flag: first boot after EPG lazy loading became the default forces
  // it ON once, then never overrides the user's choice again.
  epgLazyLoadingDefaultMigrated: boolean;
  // One-time flag: first boot after "collapse source categories" became the
  // default forces it ON once, then never overrides the user's choice again.
  collapseSourceCategoriesOnStartupDefaultMigrated: boolean;

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
  tmdbLanguage: string;
  setTmdbLanguage: (language: string) => void;
  posterDbApiKey: string;
  setPosterDbApiKey: (key: string) => void;
  rpdbBackdropsEnabled: boolean;
  setRpdbBackdropsEnabled: (enabled: boolean) => void;

  // Downloads default directory (empty = prompt every time)
  downloadsPath: string;
  setDownloadsPath: (path: string) => void;
  separateDownloadFolders: boolean;
  setSeparateDownloadFolders: (enabled: boolean) => void;

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

  // Jellyfin integration (titlebar tab hidden until explicitly enabled)
  jellyfinEnabled: boolean;
  // Per-service Jellyfin scrobbling opt-ins — off by default so users running
  // server-side Trakt/Simkl Jellyfin plugins don't double-scrobble.
  jellyfinTraktScrobbleEnabled: boolean;
  jellyfinSimklScrobbleEnabled: boolean;
  jellyfinDebugLoggingEnabled: boolean;
  setJellyfinEnabled: (enabled: boolean) => void;
  setJellyfinSettings: (partial: Partial<JellyfinSettings>) => void;

  // TV calendar auto-sync
  tvCalendarAutoSync: boolean;
  setTvCalendarAutoSync: (enabled: boolean) => void;

  // Category sidebar visibility (LiveTV sidebar top rows + folders)
  showAllChannels: boolean;
  showFavorites: boolean;
  showWatchlist: boolean;
  showRecentlyViewed: boolean;
  favoritesMode: 'global' | 'perSource' | 'both';
  alwaysSortFavoritesAlphabetically: boolean;
  collapseSourceCategoriesOnStartup: boolean;
  setCategorySettings: (partial: Partial<CategorySettings>) => void;
  setCollapseSourceCategoriesOnStartup: (enabled: boolean) => void;

  // Default category opened when LiveTV loads: '__last__' (last opened, the
  // default behavior) or a concrete sidebar category id — '__all__' for All
  // Channels, '__favorites__', '__watchlist__', '__recent__', a 'custom:...'
  // group id, or a native category id.
  defaultCategory: string;
  setDefaultCategory: (mode: string) => void;

  // VOD category sidebar visibility (Movies and Series sidebar)
  showVodAll: boolean;
  showVodFavorites: boolean;
  showVodPlaylists: boolean;
  showVodLocal: boolean;
  showVodRecent: boolean;
  setVodNavigationSettings: (partial: Partial<VodNavigationSettings>) => void;

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

  // Video / MPV tuning
  playerEngine: 'libmpv' | 'sidecar';
  setPlayerEngine: (engine: 'libmpv' | 'sidecar') => Promise<void> | void;
  hdrTonemapToSdr: boolean;
  setHdrTonemapToSdr: (enabled: boolean) => void;
  showHdrQuickToggle: boolean;
  setShowHdrQuickToggle: (enabled: boolean) => void;
  mpvQuality: 'performance' | 'balanced' | 'quality';
  setMpvQuality: (quality: 'performance' | 'balanced' | 'quality') => Promise<void> | void;

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
  setHardwareAcceleration: (enabled: boolean) => Promise<void> | void;
  disableThemeBackdropBlur: boolean;
  setDisableThemeBackdropBlur: (disabled: boolean) => void;
  reduceEffectsWhileScrolling: boolean;
  setReduceEffectsWhileScrolling: (enabled: boolean) => void;
  flatChrome: boolean;
  setFlatChrome: (enabled: boolean) => void;
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
  // Opt-in cleaned-name matching for EPG Editor → Automatch Missing. Off by
  // default: stripping `|DE|`/quality tags is what lets Xtream and Stalker
  // channels match without a manual rename, but it can also merge channels that
  // only differ by their decorations, so the user opts in per run.
  epgAutomatchCleanNames: boolean;
  setEpgAutomatchCleanNames: (enabled: boolean) => void;
  /** Extra words to strip, in addition to the built-in quality/codec tags. */
  epgAutomatchStripTags: string[];
  setEpgAutomatchStripTags: (tags: string[]) => void;
  // On by default: only resolve channels the app actually shows (not disabled,
  // and not sitting solely in disabled categories). A user with 1,000 enabled
  // channels out of 50,000 shouldn't wait on the other 49,000.
  epgAutomatchEnabledOnly: boolean;
  setEpgAutomatchEnabledOnly: (enabled: boolean) => void;

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
  logoDefaultBackground: 'auto' | 'light' | 'dark';
  setLogoDefaultBackground: (background: 'auto' | 'light' | 'dark') => void;
  sourceLogoDisplayOverrides: Record<string, 'square' | 'rectangle'>;
  setSourceLogoDisplayOverride: (sourceId: string, display: 'square' | 'rectangle' | 'default') => void;
  sourceLogoBackgroundOverrides: Record<string, 'auto' | 'light' | 'dark'>;
  setSourceLogoBackgroundOverride: (sourceId: string, background: 'auto' | 'light' | 'dark' | 'default') => void;
  epgMetadataBadgeResolution: boolean;
  setEpgMetadataBadgeResolution: (enabled: boolean) => void;
  epgMetadataBadgeFps: boolean;
  setEpgMetadataBadgeFps: (enabled: boolean) => void;
  epgMetadataBadgeFpsSuffix: boolean;
  setEpgMetadataBadgeFpsSuffix: (enabled: boolean) => void;
  epgMetadataBadgeFhdLabels: boolean;
  setEpgMetadataBadgeFhdLabels: (enabled: boolean) => void;
  epgResolutionFilterEnabled: boolean;
  setEpgResolutionFilterEnabled: (enabled: boolean) => void;
  epgCatchupFilterEnabled: boolean;
  setEpgCatchupFilterEnabled: (enabled: boolean) => void;
  epgMetadataBadgeSound: boolean;
  setEpgMetadataBadgeSound: (enabled: boolean) => void;
  epgMetadataBadgeBitrate: boolean;
  setEpgMetadataBadgeBitrate: (enabled: boolean) => void;
  epgMetadataBadgeAudioBitrate: boolean;
  setEpgMetadataBadgeAudioBitrate: (enabled: boolean) => void;
  epgMetadataBadgeBitrateOverlay: boolean;
  setEpgMetadataBadgeBitrateOverlay: (enabled: boolean) => void;
  epgMetadataBadgeAudioBitrateOverlay: boolean;
  setEpgMetadataBadgeAudioBitrateOverlay: (enabled: boolean) => void;
  epgMetadataBadgeBitrateSearch: boolean;
  setEpgMetadataBadgeBitrateSearch: (enabled: boolean) => void;
  epgMetadataBadgeAudioBitrateSearch: boolean;
  setEpgMetadataBadgeAudioBitrateSearch: (enabled: boolean) => void;
  epgMetadataBadgeBitrateFailover: boolean;
  setEpgMetadataBadgeBitrateFailover: (enabled: boolean) => void;
  epgMetadataBadgeAudioBitrateFailover: boolean;
  setEpgMetadataBadgeAudioBitrateFailover: (enabled: boolean) => void;
  epgMetadataBadgeBitrateSports: boolean;
  setEpgMetadataBadgeBitrateSports: (enabled: boolean) => void;
  epgMetadataBadgeAudioBitrateSports: boolean;
  setEpgMetadataBadgeAudioBitrateSports: (enabled: boolean) => void;
  logoCacheEnabled: boolean;
  setLogoCacheEnabled: (enabled: boolean) => void;
  logoCacheMaxMb: number;
  setLogoCacheMaxMb: (mb: number) => void;
  logoCacheTtlDays: number;
  setLogoCacheTtlDays: (days: number) => void;

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
  blurUnwatchedEpisodes: boolean;
  setBlurUnwatchedEpisodes: (enabled: boolean) => void;
  useScrollwheelSeek: boolean;
  setUseScrollwheelSeek: (enabled: boolean) => void;
  useScrollwheelSeekInvert: boolean;
  setUseScrollwheelSeekInvert: (enabled: boolean) => void;
  // Stalker (MAC portal) VOD lazy-load preferences
  stalkerVodPageConcurrency: number;
  setStalkerVodPageConcurrency: (concurrency: number) => void;
  stalkerCategoryCacheMinutes: number;
  setStalkerCategoryCacheMinutes: (minutes: number) => void;
  stalkerServerSearchEnabled: boolean;
  setStalkerServerSearchEnabled: (enabled: boolean) => void;
  failoverGroupShowSource: boolean;
  setFailoverGroupShowSource: (enabled: boolean) => void;
  failoverAlwaysPlayPrimary: boolean;
  setFailoverAlwaysPlayPrimary: (enabled: boolean) => void;
  failoverKeepView: boolean;
  setFailoverKeepView: (enabled: boolean) => void;
  showFailoverLiveTvWidget: boolean;
  setShowFailoverLiveTvWidget: (enabled: boolean) => void;
  showFailoverMediaBarWidget: boolean;
  setShowFailoverMediaBarWidget: (enabled: boolean) => void;

  // Custom scrollbar
  enableCustomScrollbarWidth: boolean;
  setEnableCustomScrollbarWidth: (enabled: boolean) => void;
  customScrollbarWidth: number;
  setCustomScrollbarWidth: (width: number) => void;

  // Misc
  globalLiveTvUserAgent: string;
  setGlobalLiveTvUserAgent: (ua: string) => void;

  // Controller & Gamepad
  controllerEnabled: boolean;
  setControllerEnabled: (enabled: boolean) => void;
  controllerBackgroundListening: boolean;
  setControllerBackgroundListening: (enabled: boolean) => void;
  controllerDeadzone: number;
  setControllerDeadzone: (deadzone: number) => void;
  controllerRepeatDelayMs: number;
  setControllerRepeatDelayMs: (ms: number) => void;
  controllerRepeatIntervalMs: number;
  setControllerRepeatIntervalMs: (ms: number) => void;
  controllerMappings: Record<string, string>;
  setControllerMappings: (mappings: Record<string, string>) => void;
  resetControllerMappings: () => void;
  keyboardControllerEnabled: boolean;
  setKeyboardControllerEnabled: (enabled: boolean) => void;
  keyboardControllerMappings: Record<string, string>;
  setKeyboardControllerMappings: (mappings: Record<string, string>) => void;
  resetKeyboardControllerMappings: () => void;
  controllerChords: Record<string, string>;
  setControllerChords: (chords: Record<string, string>) => void;
  resetControllerChords: () => void;
  controllerVisualizerLayout: 'auto' | 'xbox' | 'playstation';
  setControllerVisualizerLayout: (layout: 'auto' | 'xbox' | 'playstation') => void;
  customGamepadProfiles: Record<string, Record<string, string>>;
  saveCustomGamepadProfile: (deviceId: string, mapping: Record<string, string>) => void;
  deleteCustomGamepadProfile: (deviceId: string) => void;

  // Phone Remote Server & Customization
  remoteControlEnabled: boolean;
  setRemoteControlEnabled: (enabled: boolean) => void;
  remoteControlPort: number;
  setRemoteControlPort: (port: number) => void;
  phoneRemoteConfig: PhoneRemoteConfig;
  setPhoneRemoteConfig: (config: Partial<PhoneRemoteConfig>) => void;
  resetPhoneRemoteConfig: () => void;

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
  glassOverlayOpacity: 0.85,
  oledBlack: false,
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
  audioNormalize: false,
  audioProfile: 'off',
  audioDownmixStereo: false,
  audioMaxVolume: 100,
};

export const DEFAULT_CONTROLLER_MAPPINGS: Record<string, string> = {
  south: 'select',
  east: 'back',
  north: 'search',
  west: 'subtitles',
  dpad_up: 'nav_up',
  dpad_down: 'nav_down',
  dpad_left: 'nav_left',
  dpad_right: 'nav_right',
  left_stick_up: 'nav_up',
  left_stick_down: 'nav_down',
  left_stick_left: 'nav_left',
  left_stick_right: 'nav_right',
  left_bumper: 'prev_channel',
  right_bumper: 'next_channel',
  left_trigger: 'seek_backward',
  right_trigger: 'seek_forward',
  left_stick_click: 'toggle_fullscreen',
  right_stick_click: 'toggle_mute',
  start: 'play_pause',
  select: 'toggle_livetv',
  guide: 'toggle_livetv',
};

// Keyboard-as-controller: physical keys (e.code) mapped to controller buttons.
// When keyboardControllerEnabled is on, a mapped key is translated into the
// controller button's action through the same pipeline as a gamepad press
// (controllerMappings + chords), so an HTPC wireless keyboard/remote can drive
// the controller UI. Keys use e.code (physical position) so layouts don't
// matter; the values are controller button ids (same vocabulary as
// DEFAULT_CONTROLLER_MAPPINGS).
export const DEFAULT_KEYBOARD_CONTROLLER_MAPPINGS: Record<string, string> = {
  ArrowUp: 'dpad_up',
  ArrowDown: 'dpad_down',
  ArrowLeft: 'dpad_left',
  ArrowRight: 'dpad_right',
  Enter: 'south',
  Escape: 'east',
};

// Button-combination chords: hold a modifier (shoulder/trigger) and press a
// base button to trigger a different action instead of the button's normal
// one. Keys are `${modifier}+${base}` and values are app actions (same
// vocabulary as DEFAULT_CONTROLLER_MAPPINGS / AVAILABLE_ACTIONS).
export const DEFAULT_CONTROLLER_CHORDS: Record<string, string> = {
  'left_bumper+west': 'toggle_overlay',
  'right_bumper+west': 'toggle_transparent_overlay',
  'left_bumper+east': 'open_movies',
  'left_bumper+north': 'open_series',
  'right_bumper+east': 'open_sports',
  'left_trigger+north': 'open_settings',
  'left_trigger+east': 'toggle_live_game_sidebar',
  'right_trigger+south': 'search',
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

// Search result cap — the search result lists are virtualized, so the UI stays
// smooth well past the old 200 default. 5000 is the hard upper bound.
export const DEFAULT_MAX_SEARCH_RESULTS = 1000;
export const MAX_SEARCH_RESULTS_LIMIT = 5000;
export function clampMaxSearchResults(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_SEARCH_RESULTS;
  return Math.min(MAX_SEARCH_RESULTS_LIMIT, Math.max(50, Math.round(value)));
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
  timeshiftCacheBytes: (cachedSettings?.timeshiftCacheBytes as number) ?? 268_435_456, // Default 256MB
  setTimeshiftCacheBytes: (bytes) => {
    set({ timeshiftCacheBytes: bytes });
    persistSettings({ timeshiftCacheBytes: bytes });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('mpv-cache-size-changed', { detail: { bytes } }));
    }
  },
  liveBufferOffset: 0,
  setTimeshiftSettings: (partial) => {
    const patch: Record<string, any> = {};
    if (partial.timeshiftEnabled !== undefined) patch.timeshiftEnabled = partial.timeshiftEnabled;
    if (partial.timeshiftCacheBytes !== undefined) patch.timeshiftCacheBytes = partial.timeshiftCacheBytes;
    if (partial.liveBufferOffset !== undefined) patch.liveBufferOffset = partial.liveBufferOffset;
    if (Object.keys(patch).length === 0) return;
    set(patch);
    // The buffer-offset slider calls this on every step, so coalesce the writes.
    persistSettings(patch, true);
  },

  // Search
  includeSourceInSearch: false,
  includeSourceInVodSearch: false,
  maxSearchResults: DEFAULT_MAX_SEARCH_RESULTS,
  searchResultsOrder: 'default',
  sourceFontSize: 12,
  setSourceFontSize: (size) => {
    set({ sourceFontSize: size });
    persistSettings({ sourceFontSize: size }, true);
  },

  // Stremio/Nuvio detail badge scale (CSS vars owned by the DOM applier)
  stremioBadgeSize: (cachedSettings?.stremioBadgeSize as number) ?? 100,
  setStremioBadgeSize: (size) => {
    set({ stremioBadgeSize: size });
    persistSettings({ stremioBadgeSize: size }, true);
  },
  nuvioBadgeSize: (cachedSettings?.nuvioBadgeSize as number) ?? 100,
  setNuvioBadgeSize: (size) => {
    set({ nuvioBadgeSize: size });
    persistSettings({ nuvioBadgeSize: size }, true);
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
  epgProgramFontSize: (cachedSettings?.epgProgramFontSize as number) ?? 14,
  setEpgProgramFontSize: (size) => {
    set({ epgProgramFontSize: size });
    persistSettings({ epgProgramFontSize: size }, true);
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

  categorySidebarAutohide: (cachedSettings?.categorySidebarAutohide as boolean) ?? false,
  setCategorySidebarAutohide: (enabled) => {
    set({ categorySidebarAutohide: enabled });
    persistSettings({ categorySidebarAutohide: enabled });
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
  volumePercentDefaultMigrated: (cachedSettings?.volumePercentDefaultMigrated as boolean) ?? false,
  subAssOverrideDefaultMigrated: (cachedSettings?.subAssOverrideDefaultMigrated as boolean) ?? false,
  epgLazyLoadingDefaultMigrated: (cachedSettings?.epgLazyLoadingDefaultMigrated as boolean) ?? false,
  collapseSourceCategoriesOnStartupDefaultMigrated: (cachedSettings?.collapseSourceCategoriesOnStartupDefaultMigrated as boolean) ?? false,

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
  showVolumePercent: (cachedSettings?.showVolumePercent as boolean) ?? true,
  setShowVolumePercent: (enabled) => {
    set({ showVolumePercent: enabled });
    persistSettings({ showVolumePercent: enabled });
  },
  // Video / MPV tuning
  playerEngine: (cachedSettings?.playerEngine as 'libmpv' | 'sidecar') || 'sidecar',
  setPlayerEngine: (engine) => {
    set({ playerEngine: engine });
    return persistSettings({ playerEngine: engine });
  },
  hdrTonemapToSdr: (cachedSettings?.hdrTonemapToSdr as boolean) ?? false,
  setHdrTonemapToSdr: (enabled) => {
    set({ hdrTonemapToSdr: enabled });
    persistSettings({ hdrTonemapToSdr: enabled });
  },
  showHdrQuickToggle: (cachedSettings?.showHdrQuickToggle as boolean) ?? false,
  setShowHdrQuickToggle: (enabled) => {
    set({ showHdrQuickToggle: enabled });
    persistSettings({ showHdrQuickToggle: enabled });
  },
  mpvQuality: (cachedSettings?.mpvQuality as 'performance' | 'balanced' | 'quality') || 'balanced',
  setMpvQuality: (quality) => {
    set({ mpvQuality: quality });
    return persistSettings({ mpvQuality: quality });
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
    return persistSettings({ hardwareAcceleration: enabled });
  },
  disableThemeBackdropBlur: false,
  setDisableThemeBackdropBlur: (disabled) => {
    set({ disableThemeBackdropBlur: disabled });
    persistSettings({ disableThemeBackdropBlur: disabled });
  },
  reduceEffectsWhileScrolling: false,
  setReduceEffectsWhileScrolling: (enabled) => {
    set({ reduceEffectsWhileScrolling: enabled });
    persistSettings({ reduceEffectsWhileScrolling: enabled });
  },
  flatChrome: false,
  setFlatChrome: (enabled) => {
    set({ flatChrome: enabled });
    persistSettings({ flatChrome: enabled });
  },
  oledBlack: Boolean(cachedSettings?.oledBlack),
  setOledBlack: (enabled) => {
    set({ oledBlack: enabled });
    persistSettings({ oledBlack: enabled });
  },
  // Default ON: load only the visible EPG window (visible channels x visible
  // time range) instead of every program for every channel — essential for
  // large libraries where the full EPG is hundreds of MB.
  epgLazyLoadingEnabled: true,
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
  epgAutomatchCleanNames: (cachedSettings?.epgAutomatchCleanNames as boolean) ?? false,
  setEpgAutomatchCleanNames: (enabled) => {
    set({ epgAutomatchCleanNames: enabled });
    persistSettings({ epgAutomatchCleanNames: enabled });
  },
  epgAutomatchStripTags: (cachedSettings?.epgAutomatchStripTags as string[]) ?? [],
  setEpgAutomatchStripTags: (tags) => {
    const prev = get().epgAutomatchStripTags;
    if (prev && prev.length === tags.length && prev.every((t, i) => t === tags[i])) {
      return;
    }
    set({ epgAutomatchStripTags: tags });
    persistSettings({ epgAutomatchStripTags: tags }, true);
  },
  // `?? true` rather than `?? false`: existing installs have no stored value and
  // should get the faster scope, which is the whole point of the option.
  epgAutomatchEnabledOnly: (cachedSettings?.epgAutomatchEnabledOnly as boolean) ?? true,
  setEpgAutomatchEnabledOnly: (enabled) => {
    set({ epgAutomatchEnabledOnly: enabled });
    persistSettings({ epgAutomatchEnabledOnly: enabled });
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
  /**
   * The Tile Layout setting (Settings → LiveTV → Logos).
   *
   * The fallback is the default for a user who has never opened the toggle; a
   * *stored* value is their own choice and is never rewritten — including 'none',
   * which was this setting's shipped default for a while and is therefore as
   * likely to be deliberate as any other value. Deliberately no migration: see the
   * note on `channelLogoPadding` in settingsStoreHydration.
   */
  channelLogoPadding: (cachedSettings?.channelLogoPadding as 'none' | 'padded') ?? 'padded',
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
  logoDefaultBackground: (cachedSettings?.logoDefaultBackground as 'auto' | 'light' | 'dark') ?? 'auto',
  setLogoDefaultBackground: (background) => {
    set({ logoDefaultBackground: background });
    persistSettings({ logoDefaultBackground: background });
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
  sourceLogoBackgroundOverrides: (cachedSettings?.sourceLogoBackgroundOverrides as Record<string, 'auto' | 'light' | 'dark'>) ?? {},
  setSourceLogoBackgroundOverride: (sourceId, background) => {
    const next = { ...get().sourceLogoBackgroundOverrides };
    if (background === 'default') {
      delete next[sourceId];
    } else {
      next[sourceId] = background;
    }
    set({ sourceLogoBackgroundOverrides: next });
    persistSettings({ sourceLogoBackgroundOverrides: next });
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
  epgMetadataBadgeFhdLabels: (cachedSettings?.epgMetadataBadgeFhdLabels as boolean) ?? false,
  setEpgMetadataBadgeFhdLabels: (enabled) => {
    set({ epgMetadataBadgeFhdLabels: enabled });
    persistSettings({ epgMetadataBadgeFhdLabels: enabled });
  },
  epgResolutionFilterEnabled: (cachedSettings?.epgResolutionFilterEnabled as boolean) ?? true,
  setEpgResolutionFilterEnabled: (enabled) => {
    set({ epgResolutionFilterEnabled: enabled });
    persistSettings({ epgResolutionFilterEnabled: enabled });
  },
  epgCatchupFilterEnabled: (cachedSettings?.epgCatchupFilterEnabled as boolean) ?? false,
  setEpgCatchupFilterEnabled: (enabled) => {
    set({ epgCatchupFilterEnabled: enabled });
    persistSettings({ epgCatchupFilterEnabled: enabled });
  },
  epgMetadataBadgeSound: (cachedSettings?.epgMetadataBadgeSound as boolean) ?? true,
  setEpgMetadataBadgeSound: (enabled) => {
    set({ epgMetadataBadgeSound: enabled });
    persistSettings({ epgMetadataBadgeSound: enabled });
  },
  epgMetadataBadgeBitrate: (cachedSettings?.epgMetadataBadgeBitrate as boolean) ?? false,
  setEpgMetadataBadgeBitrate: (enabled) => {
    set({ epgMetadataBadgeBitrate: enabled });
    persistSettings({ epgMetadataBadgeBitrate: enabled });
  },
  epgMetadataBadgeAudioBitrate: (cachedSettings?.epgMetadataBadgeAudioBitrate as boolean) ?? false,
  setEpgMetadataBadgeAudioBitrate: (enabled) => {
    set({ epgMetadataBadgeAudioBitrate: enabled });
    persistSettings({ epgMetadataBadgeAudioBitrate: enabled });
  },
  epgMetadataBadgeBitrateOverlay: (cachedSettings?.epgMetadataBadgeBitrateOverlay as boolean) ?? false,
  setEpgMetadataBadgeBitrateOverlay: (enabled) => {
    set({ epgMetadataBadgeBitrateOverlay: enabled });
    persistSettings({ epgMetadataBadgeBitrateOverlay: enabled });
  },
  epgMetadataBadgeAudioBitrateOverlay: (cachedSettings?.epgMetadataBadgeAudioBitrateOverlay as boolean) ?? false,
  setEpgMetadataBadgeAudioBitrateOverlay: (enabled) => {
    set({ epgMetadataBadgeAudioBitrateOverlay: enabled });
    persistSettings({ epgMetadataBadgeAudioBitrateOverlay: enabled });
  },
  epgMetadataBadgeBitrateSearch: (cachedSettings?.epgMetadataBadgeBitrateSearch as boolean) ?? false,
  setEpgMetadataBadgeBitrateSearch: (enabled) => {
    set({ epgMetadataBadgeBitrateSearch: enabled });
    persistSettings({ epgMetadataBadgeBitrateSearch: enabled });
  },
  epgMetadataBadgeAudioBitrateSearch: (cachedSettings?.epgMetadataBadgeAudioBitrateSearch as boolean) ?? false,
  setEpgMetadataBadgeAudioBitrateSearch: (enabled) => {
    set({ epgMetadataBadgeAudioBitrateSearch: enabled });
    persistSettings({ epgMetadataBadgeAudioBitrateSearch: enabled });
  },
  epgMetadataBadgeBitrateFailover: (cachedSettings?.epgMetadataBadgeBitrateFailover as boolean) ?? false,
  setEpgMetadataBadgeBitrateFailover: (enabled) => {
    set({ epgMetadataBadgeBitrateFailover: enabled });
    persistSettings({ epgMetadataBadgeBitrateFailover: enabled });
  },
  epgMetadataBadgeAudioBitrateFailover: (cachedSettings?.epgMetadataBadgeAudioBitrateFailover as boolean) ?? false,
  setEpgMetadataBadgeAudioBitrateFailover: (enabled) => {
    set({ epgMetadataBadgeAudioBitrateFailover: enabled });
    persistSettings({ epgMetadataBadgeAudioBitrateFailover: enabled });
  },
  epgMetadataBadgeBitrateSports: (cachedSettings?.epgMetadataBadgeBitrateSports as boolean) ?? false,
  setEpgMetadataBadgeBitrateSports: (enabled) => {
    set({ epgMetadataBadgeBitrateSports: enabled });
    persistSettings({ epgMetadataBadgeBitrateSports: enabled });
  },
  epgMetadataBadgeAudioBitrateSports: (cachedSettings?.epgMetadataBadgeAudioBitrateSports as boolean) ?? false,
  setEpgMetadataBadgeAudioBitrateSports: (enabled) => {
    set({ epgMetadataBadgeAudioBitrateSports: enabled });
    persistSettings({ epgMetadataBadgeAudioBitrateSports: enabled });
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
  blurUnwatchedEpisodes: false,
  setBlurUnwatchedEpisodes: (enabled) => {
    set({ blurUnwatchedEpisodes: enabled });
    persistSettings({ blurUnwatchedEpisodes: enabled });
    dispatchAppEvent('ynotv:vod-settings-changed', { blurUnwatchedEpisodes: enabled });
  },
  useScrollwheelSeek: false,
  setUseScrollwheelSeek: (enabled) => {
    set({ useScrollwheelSeek: enabled });
    persistSettings({ useScrollwheelSeek: enabled });
    dispatchAppEvent('ynotv:vod-settings-changed', { useScrollwheelSeek: enabled });
  },
  useScrollwheelSeekInvert: false,
  setUseScrollwheelSeekInvert: (enabled) => {
    set({ useScrollwheelSeekInvert: enabled });
    persistSettings({ useScrollwheelSeekInvert: enabled });
    dispatchAppEvent('ynotv:vod-settings-changed', { useScrollwheelSeekInvert: enabled });
  },
  // Stalker (MAC portal) VOD lazy-load preferences: how many pages are
  // fetched in parallel when a VOD category is opened (default 4), and how
  // long a loaded category's items stay cached before being refreshed.
  stalkerVodPageConcurrency: 4,
  setStalkerVodPageConcurrency: (concurrency) => {
    const clamped = Math.min(12, Math.max(1, Math.round(concurrency) || 4));
    set({ stalkerVodPageConcurrency: clamped });
    persistSettings({ stalkerVodPageConcurrency: clamped });
  },
  stalkerCategoryCacheMinutes: 5,
  setStalkerCategoryCacheMinutes: (minutes) => {
    // 0 disables caching — every open of a category refetches it.
    const clamped = Math.min(10080, Math.max(0, Math.round(minutes) || 0));
    set({ stalkerCategoryCacheMinutes: clamped });
    persistSettings({ stalkerCategoryCacheMinutes: clamped });
  },
  // Off by default: this only means anything on MAC portals, and it puts an extra
  // button on the Movies/Series pages, so it is opt-in per install.
  stalkerServerSearchEnabled: false,
  setStalkerServerSearchEnabled: (enabled) => {
    set({ stalkerServerSearchEnabled: enabled });
    persistSettings({ stalkerServerSearchEnabled: enabled });
  },
  failoverGroupShowSource: false,
  setFailoverGroupShowSource: (enabled) => {
    set({ failoverGroupShowSource: enabled });
    persistSettings({ failoverGroupShowSource: enabled });
    dispatchAppEvent('ynotv:livetv-settings-changed', { failoverGroupShowSource: enabled });
  },
  failoverAlwaysPlayPrimary: false,
  setFailoverAlwaysPlayPrimary: (enabled) => {
    set({ failoverAlwaysPlayPrimary: enabled });
    persistSettings({ failoverAlwaysPlayPrimary: enabled });
    dispatchAppEvent('ynotv:livetv-settings-changed', { failoverAlwaysPlayPrimary: enabled });
  },
  failoverKeepView: false,
  setFailoverKeepView: (enabled) => {
    set({ failoverKeepView: enabled });
    persistSettings({ failoverKeepView: enabled });
    dispatchAppEvent('ynotv:livetv-settings-changed', { failoverKeepView: enabled });
  },
  showFailoverLiveTvWidget: true,
  setShowFailoverLiveTvWidget: (enabled) => {
    set({ showFailoverLiveTvWidget: enabled });
    persistSettings({ showFailoverLiveTvWidget: enabled });
    dispatchAppEvent('ynotv:livetv-settings-changed', { showFailoverLiveTvWidget: enabled });
  },
  showFailoverMediaBarWidget: true,
  setShowFailoverMediaBarWidget: (enabled) => {
    set({ showFailoverMediaBarWidget: enabled });
    persistSettings({ showFailoverMediaBarWidget: enabled });
    dispatchAppEvent('ynotv:livetv-settings-changed', { showFailoverMediaBarWidget: enabled });
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
  tmdbLanguage: cachedSettings?.tmdbLanguage ?? 'en-US',
  setTmdbLanguage: (language) => {
    set({ tmdbLanguage: language });
    persistSettings({ tmdbLanguage: language });
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
  separateDownloadFolders: true,
  setSeparateDownloadFolders: (enabled) => {
    set({ separateDownloadFolders: enabled });
    persistSettings({ separateDownloadFolders: enabled });
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

  // Jellyfin integration
  jellyfinEnabled: false,
  jellyfinTraktScrobbleEnabled: false,
  jellyfinSimklScrobbleEnabled: false,
  jellyfinDebugLoggingEnabled: false,
  setJellyfinEnabled: (enabled) => {
    set({ jellyfinEnabled: enabled });
    persistSettings({ jellyfinEnabled: enabled });
  },
  setJellyfinSettings: (partial) => {
    const patch: Record<string, any> = {};
    if (partial.jellyfinEnabled !== undefined) patch.jellyfinEnabled = partial.jellyfinEnabled;
    if (partial.jellyfinTraktScrobbleEnabled !== undefined) patch.jellyfinTraktScrobbleEnabled = partial.jellyfinTraktScrobbleEnabled;
    if (partial.jellyfinSimklScrobbleEnabled !== undefined) patch.jellyfinSimklScrobbleEnabled = partial.jellyfinSimklScrobbleEnabled;
    if (partial.jellyfinDebugLoggingEnabled !== undefined) patch.jellyfinDebugLoggingEnabled = partial.jellyfinDebugLoggingEnabled;
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
  alwaysSortFavoritesAlphabetically: false,
  defaultCategory: (cachedSettings?.defaultCategory as string) ?? '__last__',
  setDefaultCategory: (mode) => {
    set({ defaultCategory: mode });
    persistSettings({ defaultCategory: mode }, true);
  },
  setCategorySettings: (partial) => {
    const patch: Record<string, any> = {};
    if (partial.showAllChannels !== undefined) patch.showAllChannels = partial.showAllChannels;
    if (partial.showFavorites !== undefined) patch.showFavorites = partial.showFavorites;
    if (partial.showWatchlist !== undefined) patch.showWatchlist = partial.showWatchlist;
    if (partial.showRecentlyViewed !== undefined) patch.showRecentlyViewed = partial.showRecentlyViewed;
    if (partial.favoritesMode !== undefined) patch.favoritesMode = partial.favoritesMode;
    if (partial.alwaysSortFavoritesAlphabetically !== undefined) patch.alwaysSortFavoritesAlphabetically = partial.alwaysSortFavoritesAlphabetically;
    set(patch);
    persistSettings(patch);
    if (Object.keys(patch).length > 0) {
      dispatchAppEvent('ynotv:category-settings-changed', patch);
    }
  },
  collapseSourceCategoriesOnStartup: true,
  setCollapseSourceCategoriesOnStartup: (enabled) => {
    set({ collapseSourceCategoriesOnStartup: enabled });
    persistSettings({ collapseSourceCategoriesOnStartup: enabled });
  },

  // VOD category sidebar visibility (Movies and Series sidebar)
  showVodAll: true,
  showVodFavorites: true,
  showVodPlaylists: true,
  showVodLocal: true,
  showVodRecent: true,
  setVodNavigationSettings: (partial) => {
    const patch: Record<string, any> = {};
    if (partial.showVodAll !== undefined) patch.showVodAll = partial.showVodAll;
    if (partial.showVodFavorites !== undefined) patch.showVodFavorites = partial.showVodFavorites;
    if (partial.showVodPlaylists !== undefined) patch.showVodPlaylists = partial.showVodPlaylists;
    if (partial.showVodLocal !== undefined) patch.showVodLocal = partial.showVodLocal;
    if (partial.showVodRecent !== undefined) patch.showVodRecent = partial.showVodRecent;
    set(patch);
    persistSettings(patch);
    if (Object.keys(patch).length > 0) {
      dispatchAppEvent('ynotv:vod-navigation-settings-changed', patch);
    }
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

  // Controller & Gamepad — controller support is opt-in, so it's OFF unless
  // the user explicitly enables it (previously it defaulted to on).
  controllerEnabled: cachedSettings?.controllerEnabled ?? false,
  setControllerEnabled: (enabled) => {
    set({ controllerEnabled: enabled });
    persistSettings({ controllerEnabled: enabled });
  },
  // Background listening is also opt-in — inputs are ignored while the app
  // window is not focused unless this is enabled.
  controllerBackgroundListening: cachedSettings?.controllerBackgroundListening ?? false,
  setControllerBackgroundListening: (enabled) => {
    set({ controllerBackgroundListening: enabled });
    persistSettings({ controllerBackgroundListening: enabled });
  },
  controllerDeadzone: cachedSettings?.controllerDeadzone ?? 0.45,
  setControllerDeadzone: (deadzone) => {
    set({ controllerDeadzone: deadzone });
    persistSettings({ controllerDeadzone: deadzone }, true);
  },
  // D-pad hold-to-repeat. Defaults mirror the phone remote's timings
  // (NAV_REPEAT_HOLD_MS / NAV_REPEAT_START_MS). controllerRepeatIntervalMs is
  // the base speed of the accelerating curve — the faster (interval) it is, the
  // quicker repeats fire.
  controllerRepeatDelayMs: cachedSettings?.controllerRepeatDelayMs ?? 350,
  setControllerRepeatDelayMs: (ms) => {
    set({ controllerRepeatDelayMs: ms });
    persistSettings({ controllerRepeatDelayMs: ms }, true);
  },
  controllerRepeatIntervalMs: cachedSettings?.controllerRepeatIntervalMs ?? 220,
  setControllerRepeatIntervalMs: (ms) => {
    set({ controllerRepeatIntervalMs: ms });
    persistSettings({ controllerRepeatIntervalMs: ms }, true);
  },
  controllerMappings: cachedSettings?.controllerMappings ?? DEFAULT_CONTROLLER_MAPPINGS,
  setControllerMappings: (mappings) => {
    set({ controllerMappings: mappings });
    persistSettings({ controllerMappings: mappings });
  },
  resetControllerMappings: () => {
    set({ controllerMappings: { ...DEFAULT_CONTROLLER_MAPPINGS } });
    persistSettings({ controllerMappings: { ...DEFAULT_CONTROLLER_MAPPINGS } });
  },
  // Keyboard-as-controller is opt-in and independent of physical controller
  // support — an HTPC remote can drive the controller UI on its own.
  keyboardControllerEnabled: cachedSettings?.keyboardControllerEnabled ?? false,
  setKeyboardControllerEnabled: (enabled) => {
    set({ keyboardControllerEnabled: enabled });
    persistSettings({ keyboardControllerEnabled: enabled });
  },
  keyboardControllerMappings: cachedSettings?.keyboardControllerMappings ?? DEFAULT_KEYBOARD_CONTROLLER_MAPPINGS,
  setKeyboardControllerMappings: (mappings) => {
    set({ keyboardControllerMappings: mappings });
    persistSettings({ keyboardControllerMappings: mappings });
  },
  resetKeyboardControllerMappings: () => {
    set({ keyboardControllerMappings: { ...DEFAULT_KEYBOARD_CONTROLLER_MAPPINGS } });
    persistSettings({ keyboardControllerMappings: { ...DEFAULT_KEYBOARD_CONTROLLER_MAPPINGS } });
  },
  controllerChords: cachedSettings?.controllerChords ?? DEFAULT_CONTROLLER_CHORDS,
  setControllerChords: (chords) => {
    set({ controllerChords: chords });
    persistSettings({ controllerChords: chords });
  },
  resetControllerChords: () => {
    set({ controllerChords: { ...DEFAULT_CONTROLLER_CHORDS } });
    persistSettings({ controllerChords: { ...DEFAULT_CONTROLLER_CHORDS } });
  },
  controllerVisualizerLayout: cachedSettings?.controllerVisualizerLayout ?? 'xbox',
  setControllerVisualizerLayout: (layout) => {
    set({ controllerVisualizerLayout: layout });
    persistSettings({ controllerVisualizerLayout: layout });
  },
  customGamepadProfiles: cachedSettings?.customGamepadProfiles ?? {},
  saveCustomGamepadProfile: (deviceId, mapping) => {
    set((state) => {
      const updated = { ...state.customGamepadProfiles, [deviceId]: mapping };
      persistSettings({ customGamepadProfiles: updated });
      return { customGamepadProfiles: updated };
    });
  },
  deleteCustomGamepadProfile: (deviceId) => {
    set((state) => {
      const updated = { ...state.customGamepadProfiles };
      delete updated[deviceId];
      persistSettings({ customGamepadProfiles: updated });
      return { customGamepadProfiles: updated };
    });
  },

  // Phone Remote Server (opt-in — off unless the user explicitly enables it)
  remoteControlEnabled: cachedSettings?.remoteControlEnabled ?? false,
  setRemoteControlEnabled: (enabled) => {
    set({ remoteControlEnabled: enabled });
    persistSettings({ remoteControlEnabled: enabled });
  },
  remoteControlPort: cachedSettings?.remoteControlPort ?? 11470,
  setRemoteControlPort: (port) => {
    set({ remoteControlPort: port });
    persistSettings({ remoteControlPort: port });
  },
  phoneRemoteConfig: cachedSettings?.phoneRemoteConfig
    ? {
        ...DEFAULT_PHONE_REMOTE_CONFIG,
        ...cachedSettings.phoneRemoteConfig,
        cornerButtons: {
          ...DEFAULT_PHONE_REMOTE_CONFIG.cornerButtons,
          ...(cachedSettings.phoneRemoteConfig.cornerButtons || {}),
        },
        layout: {
          ...DEFAULT_PHONE_REMOTE_CONFIG.layout,
          ...(cachedSettings.phoneRemoteConfig.layout || {}),
        },
      }
    : { ...DEFAULT_PHONE_REMOTE_CONFIG },
  setPhoneRemoteConfig: (config) => {
    set((state) => {
      const updated: PhoneRemoteConfig = {
        ...state.phoneRemoteConfig,
        ...config,
        cornerButtons: config.cornerButtons
          ? { ...state.phoneRemoteConfig.cornerButtons, ...config.cornerButtons }
          : state.phoneRemoteConfig.cornerButtons,
        centerButtons: config.centerButtons
          ? { ...state.phoneRemoteConfig.centerButtons, ...config.centerButtons }
          : state.phoneRemoteConfig.centerButtons,
        layout: config.layout
          ? { ...state.phoneRemoteConfig.layout, ...config.layout }
          : state.phoneRemoteConfig.layout,
      };
      persistSettings({ phoneRemoteConfig: updated });
      return { phoneRemoteConfig: updated };
    });
  },
  resetPhoneRemoteConfig: () => {
    set({ phoneRemoteConfig: { ...DEFAULT_PHONE_REMOTE_CONFIG } });
    persistSettings({ phoneRemoteConfig: { ...DEFAULT_PHONE_REMOTE_CONFIG } });
  },

  // EPG cosmetic classes (load-time only — hydrated from settings, no setters)
  epgDarkenCurrent: false,
  epgHighlightBorderCurrent: false,
  epgBoldChannelNames: false,
  epgBoldTopCategories: false,
  epgBoldSourceCategories: false,
}));
