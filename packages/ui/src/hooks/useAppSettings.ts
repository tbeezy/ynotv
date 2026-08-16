import { useState, useEffect, useCallback } from 'react';
import type { SavedLayoutState } from './useLayoutPersistence';
import type { ThemeId, CustomThemeConfig, ShortcutsMap } from '../types/app';
import { applyCustomTheme, updateScrollbarHoverColor } from '../utils/themeHelper';
import i18n, { isSupportedLocale } from '../i18n';
import { useEpgView, useSetEpgView } from '../stores/uiStore';

function getInitialSettingsFromStorage(): Record<string, any> | null {
  try {
    const localData = typeof localStorage !== 'undefined' ? localStorage.getItem('app-settings') : null;
    if (localData) {
      return JSON.parse(localData);
    }
  } catch (e) {}
  return null;
}

let cachedSettings: Record<string, any> | null = getInitialSettingsFromStorage();

/* ---------------------------------------------------------------------------
   OLED true-black — single source of truth for the data-oled attribute.

   This MUST NOT be driven by a per-instance React effect: useAppSettings is
   called by ~20 components, and every instance mounts with oledBlack=false
   until its async storage load resolves. A per-instance effect therefore
   DELETES data-oled on every mount (blobs + grey surfaces flash back on),
   then re-sets it once the load lands — a constant race while navigating.

   Instead the attribute is synced from one module-level value that is:
    1. seeded synchronously from the localStorage cache at module load (so the
       very first paint is already OLED-correct — no startup flash), and
    2. re-synced only when the authoritative storage load resolves and when
       the user toggles the setting.
   All instances converge on the same storage value, so nothing fights.
   --------------------------------------------------------------------------- */
let oledBlackGlobal: boolean = Boolean(cachedSettings?.oledBlack);
let oledAttributeApplied: boolean | null = null;

function applyOledAttribute() {
  const enabled = oledBlackGlobal === true;
  if (oledAttributeApplied === enabled) return; // idempotent — no churn
  oledAttributeApplied = enabled;
  if (typeof document !== 'undefined') {
    if (enabled) {
      document.documentElement.dataset.oled = 'true';
    } else {
      delete document.documentElement.dataset.oled;
    }
  }
}

// Seed the attribute synchronously on first paint.
applyOledAttribute();

/* ---------------------------------------------------------------------------
   Stale-read guard for theme / custom-theme-accent settings.

   Several useAppSettings instances load settings asynchronously (one IPC round
   trip each). If a component mounts right after the user changes a setting and
   its load read storage BEFORE the save landed, the load would happily apply
   and merge the OLD value — reverting the user's change in the DOM and in the
   module cache ("setting reverts after exiting Settings").

   Setters stamp the key when the user changes it; a load that started before
   that stamp skips applying/merging the key, so a delayed read can never
   clobber a newer write.
   --------------------------------------------------------------------------- */
const settingsWriteStamps: Record<string, number> = {};
function stampSettingsWrite(key: string) {
  settingsWriteStamps[key] = Date.now();
}


export interface AppSettings {
  // i18n / language — the pinned i18n entry point. `language` is a BCP-47 code
  // from src/i18n (SUPPORTED_LOCALES); `setLanguage` persists via the dual-write
  // path AND applies the change live via i18next.changeLanguage().
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

  // Category display
  categorySortOrder: 'default' | 'alphabetical';
  includeAllChannelsToPlaylist: boolean;
  setIncludeAllChannelsToPlaylist: (enabled: boolean) => void;
  // Sources list
  hideDisabledSources: boolean;
  setHideDisabledSources: (hidden: boolean) => void;

  // Advanced Search
  advancedSearchScope: 'channels' | 'epg' | 'both';
  advancedSearchSourceIds: string[];
  advancedSearchCategoryIds: string[];
  useAdvancedSearchForRegular: boolean;
  searchCustomPlaylists: boolean;

  // LiveTV
  epgView: 'traditional' | 'alternate';
  setEpgView: (view: 'traditional' | 'alternate') => Promise<void>;
  channelInfoOverlayEnabled: boolean;
  channelInfoOverlayFontSize: number;
  channelInfoOverlayLogoSize: number;
  channelInfoOverlayBoxWidth: number;
  channelInfoOverlayOpacity: number;
  channelInfoOverlayHideDescription: boolean;
  channelInfoOverlayHideMetaBadge: boolean;
  channelInfoOverlayHideLogo: boolean;
  channelInfoOverlayHideTimer: boolean;
  channelInfoOverlayPosition: 'left' | 'right';
  channelInfoOverlayLogoShape: 'square' | 'horizontal';
  transparentGuideOnZap: boolean;

  // Popout
  popoutStopMain: boolean;
  popoutAlwaysOnTop: boolean;
  popoutHwdecEnabled: boolean;
  popoutMpvParamsEnabled: boolean;
  popoutMpvParams: string;

  // Theme
  theme: ThemeId;
  customThemeConfig: CustomThemeConfig;
  savedCustomThemes: CustomThemeConfig[];

  // Global Fonts
  appFontFamily: string;
  appCustomFontBase64: string;
  appCustomFontFormat: string;
  appCustomFontName: string;

  // Shortcuts
  shortcuts: ShortcutsMap;

  // Navigation tab visibility
  navHiddenTabs: string[];

  // EPG button visibility
  epgHiddenButtons: string[];

  // UI visibility
  categoriesHidden: boolean;
  categoriesHiddenTransparent: boolean;
  overlayAutohideTimer: number;
  overlayOnClickOnly: boolean;
  playerControlDesign: 'default' | 'clean';
  showVolumePercent: boolean;

  // Widget scale
  widgetScale: number;
  widgetBgOpacity: number; // 0–1

  // Sports overlay
  sportsScale: number;
  sportsBgOpacity: number; // 0–1

  // Theme Optimization
  hardwareAcceleration: boolean;
  disableThemeBackdropBlur: boolean;
  oledBlack: boolean;
  epgLazyLoadingEnabled: boolean;
  disableEpgTransitions: boolean;
  epgReduceGpuLayers: boolean;
  epgDisableChannelFade: boolean;
  epgPreferEpgLogos: boolean;
  epgLogoDisplay: 'square' | 'rectangle';
  channelLogoSize: number;
  channelLogoRoundEdges: boolean;
  channelLogoPadding: 'none' | 'padded';
  logoSmartTrim: boolean;
  logoLightBackgroundDetection: boolean;
  setChannelLogoSize: (size: number) => void;
  setChannelLogoRoundEdges: (enabled: boolean) => void;
  setChannelLogoPadding: (padding: 'none' | 'padded') => void;
  setLogoSmartTrim: (enabled: boolean) => void;
  setLogoLightBackgroundDetection: (enabled: boolean) => void;
  epgMetadataBadgeResolution: boolean;
  epgMetadataBadgeFps: boolean;
  epgMetadataBadgeFpsSuffix: boolean;
  epgMetadataBadgeSound: boolean;
  logoCacheEnabled: boolean;
  logoCacheMaxMb: number;
  logoCacheTtlDays: number;
  logoCachePrefetch: boolean;
  setLogoCacheEnabled: (enabled: boolean) => void;
  setLogoCacheMaxMb: (mb: number) => void;
  setLogoCacheTtlDays: (days: number) => void;
  setLogoCachePrefetch: (enabled: boolean) => void;

  // Startup view
  startupView: 'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'sports' | 'calendar' | 'stremio' | 'nuvio';

  // Discord Rich Presence
  discordRichPresence: boolean;
  discordHideTitle: boolean;
  discordShowWhenPaused: boolean;
  discordShowWhenBrowsing: boolean;
  discordShowPoster: boolean;
  discordShowTimestamp: boolean;
  setDiscordRichPresence: (enabled: boolean) => void;
  setDiscordHideTitle: (hide: boolean) => void;
  setDiscordShowWhenPaused: (show: boolean) => void;
  setDiscordShowWhenBrowsing: (show: boolean) => void;
  setDiscordShowPoster: (show: boolean) => void;
  setDiscordShowTimestamp: (show: boolean) => void;

  // Actions
  setNavHiddenTabs: (tabs: string[]) => void;
  setEpgHiddenButtons: (buttons: string[]) => void;
  setTheme: (theme: ThemeId) => void;
  updateCustomThemeConfig: (config: Partial<CustomThemeConfig>) => void;
  setShortcuts: (shortcuts: ShortcutsMap) => void;
  setCategoriesHidden: (hidden: boolean) => void;
  setCategoriesHiddenTransparent: (hidden: boolean) => void;
  setOverlayAutohideTimer: (seconds: number) => void;
  setOverlayOnClickOnly: (enabled: boolean) => void;
  setPlayerControlDesign: (design: 'default' | 'clean') => void;
  setShowVolumePercent: (enabled: boolean) => void;
  setAdvancedSearchScope: (scope: 'channels' | 'epg' | 'both') => void;
  setAdvancedSearchSourceIds: (ids: string[]) => void;
  setAdvancedSearchCategoryIds: (ids: string[]) => void;
  setUseAdvancedSearchForRegular: (use: boolean) => void;
  setSearchCustomPlaylists: (enabled: boolean) => void;
  setCategorySortOrder: (order: 'default' | 'alphabetical') => void;
  setChannelInfoOverlayEnabled: (enabled: boolean) => void;
  setChannelInfoOverlayFontSize: (size: number) => void;
  setChannelInfoOverlayLogoSize: (size: number) => void;
    setChannelInfoOverlayBoxWidth: (width: number) => void;
    setChannelInfoOverlayOpacity: (opacity: number) => void;
    setChannelInfoOverlayHideDescription: (hide: boolean) => void;
    setChannelInfoOverlayHideMetaBadge: (hide: boolean) => void;
    setChannelInfoOverlayHideLogo: (hide: boolean) => void;
    setChannelInfoOverlayHideTimer: (hide: boolean) => void;
    setChannelInfoOverlayPosition: (pos: 'left' | 'right') => void;
    setChannelInfoOverlayLogoShape: (shape: 'square' | 'horizontal') => void;
    setTransparentGuideOnZap: (enabled: boolean) => void;
    setPopoutStopMain: (stop: boolean) => void;
    setPopoutAlwaysOnTop: (onTop: boolean) => void;
    setPopoutHwdecEnabled: (enabled: boolean) => void;
    setPopoutMpvParamsEnabled: (enabled: boolean) => void;
    setPopoutMpvParams: (params: string) => void;
    setWidgetScale: (scale: number) => void;
    setWidgetBgOpacity: (opacity: number) => void;
    setSportsScale: (scale: number) => void;
    setSportsBgOpacity: (opacity: number) => void;
    setStartupView: (view: 'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'sports' | 'calendar' | 'stremio' | 'nuvio') => void;
    castEnabled: boolean;
    setCastEnabled: (enabled: boolean) => void;
    castRewriteTs: boolean;
    setCastRewriteTs: (enabled: boolean) => void;
    externalPlayerPath: string;
    setExternalPlayerPath: (path: string) => void;
    externalPlayerArgs: string;
    setExternalPlayerArgs: (args: string) => void;
    externalPlayerReuse: boolean;
    setExternalPlayerReuse: (reuse: boolean) => void;
    updateAppFont: (family: string, base64?: string, format?: string, name?: string) => Promise<void> | void;
    setSavedCustomThemes: (themes: CustomThemeConfig[]) => void;
    setHardwareAcceleration: (enabled: boolean) => void;
    setDisableThemeBackdropBlur: (disabled: boolean) => void;
    setOledBlack: (enabled: boolean) => void;
    setEpgLazyLoadingEnabled: (enabled: boolean) => void;
    setDisableEpgTransitions: (disabled: boolean) => void;
    setEpgReduceGpuLayers: (enabled: boolean) => void;
    setEpgDisableChannelFade: (enabled: boolean) => void;
    setEpgPreferEpgLogos: (enabled: boolean) => void;
    setEpgLogoDisplay: (display: 'square' | 'rectangle') => void;
    sourceLogoDisplayOverrides: Record<string, 'square' | 'rectangle'>;
    setSourceLogoDisplayOverride: (sourceId: string, display: 'square' | 'rectangle' | 'default') => void;
    setEpgMetadataBadgeResolution: (enabled: boolean) => void;
    setEpgMetadataBadgeFps: (enabled: boolean) => void;
    setEpgMetadataBadgeFpsSuffix: (enabled: boolean) => void;
    setEpgMetadataBadgeSound: (enabled: boolean) => void;
    globalLiveTvUserAgent: string;
    setGlobalLiveTvUserAgent: (ua: string) => void;
    catchupStartPadding: number;
    setCatchupStartPadding: (padding: number) => void;
    catchupEndPadding: number;
    setCatchupEndPadding: (padding: number) => void;
    catchupContinuePlaying: boolean;
    setCatchupContinuePlaying: (continuePlaying: boolean) => void;
    vodAutoPlayNextEpisode: boolean;
    setVodAutoPlayNextEpisode: (enabled: boolean) => void;
    vodShowSourceBadge: boolean;
    setVodShowSourceBadge: (enabled: boolean) => void;
    failoverGroupShowSource: boolean;
    setFailoverGroupShowSource: (enabled: boolean) => void;
    enableCustomScrollbarWidth: boolean;
    setEnableCustomScrollbarWidth: (enabled: boolean) => void;
    customScrollbarWidth: number;
    setCustomScrollbarWidth: (width: number) => void;
}

/**
 * Hook to manage all application settings loaded from storage
 * Includes layout persistence, timeshift, search, theme, and shortcut settings
 */
export function useAppSettings(): AppSettings {
  // Layout persistence state
  const [rememberLastChannels, setRememberLastChannels] = useState(false);
  const [reopenLastOnStartup, setReopenLastOnStartup] = useState(false);
  const [savedLayoutState, setSavedLayoutState] = useState<SavedLayoutState | null>(null);
  const [layoutSettingsLoaded, setLayoutSettingsLoaded] = useState(false);

  // Timeshift settings (loaded from store)
  const [timeshiftEnabled, setTimeshiftEnabled] = useState(true);
  const [timeshiftCacheBytes, setTimeshiftCacheBytes] = useState(268_435_456); // Default 256MB
  const [liveBufferOffset, setLiveBufferOffset] = useState(0); // Default 0 seconds behind live

  // Search settings
  const [includeSourceInSearch, setIncludeSourceInSearch] = useState(false);
  const [includeSourceInVodSearch, setIncludeSourceInVodSearch] = useState(false);
  const [maxSearchResults, setMaxSearchResults] = useState(200);
  const [searchResultsOrder, setSearchResultsOrder] = useState<'default' | 'alphabetical'>('default');
  const [sourceFontSize, setSourceFontSize] = useState(12);

  // Category display settings
  const [categorySortOrder, setCategorySortOrder] = useState<'default' | 'alphabetical'>('default');
  const [includeAllChannelsToPlaylist, setIncludeAllChannelsToPlaylist] = useState(false);
  const [hideDisabledSources, setHideDisabledSourcesState] = useState(false);

  // Advanced search settings
  const [advancedSearchScope, setAdvancedSearchScope] = useState<'channels' | 'epg' | 'both'>('both');
  const [advancedSearchSourceIds, setAdvancedSearchSourceIds] = useState<string[]>([]);
  const [advancedSearchCategoryIds, setAdvancedSearchCategoryIds] = useState<string[]>([]);
  const [useAdvancedSearchForRegular, setUseAdvancedSearchForRegular] = useState(false);
  const [searchCustomPlaylists, setSearchCustomPlaylists] = useState(false);

  // UI visibility
  const [playerControlDesign, setPlayerControlDesignState] = useState<'default' | 'clean'>('clean');
  const [showVolumePercent, setShowVolumePercentState] = useState<boolean>(false);

  // LiveTV settings
  const epgView = useEpgView();
  const setEpgViewStore = useSetEpgView();
  const setEpgView = useCallback(async (view: 'traditional' | 'alternate') => {
    setEpgViewStore(view);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ epgView: view });
      } catch (e) {
        console.error('[useAppSettings] Failed to save epgView:', e);
      }
    }
  }, [setEpgViewStore]);
  const [channelInfoOverlayEnabled, setChannelInfoOverlayEnabledState] = useState(false);
  const [channelInfoOverlayFontSize, setChannelInfoOverlayFontSizeState] = useState(16);
  const [channelInfoOverlayLogoSize, setChannelInfoOverlayLogoSizeState] = useState(42);
  const [channelInfoOverlayBoxWidth, setChannelInfoOverlayBoxWidthState] = useState(380);
  const [channelInfoOverlayOpacity, setChannelInfoOverlayOpacityState] = useState(55);
  const [channelInfoOverlayHideDescription, setChannelInfoOverlayHideDescriptionState] = useState(false);
  const [channelInfoOverlayHideMetaBadge, setChannelInfoOverlayHideMetaBadgeState] = useState(false);
  const [channelInfoOverlayHideLogo, setChannelInfoOverlayHideLogoState] = useState(false);
  const [channelInfoOverlayHideTimer, setChannelInfoOverlayHideTimerState] = useState(false);
  const [channelInfoOverlayPosition, setChannelInfoOverlayPositionState] = useState<'left' | 'right'>('left');
  const [channelInfoOverlayLogoShape, setChannelInfoOverlayLogoShapeState] = useState<'square' | 'horizontal'>('square');
  const [transparentGuideOnZap, setTransparentGuideOnZapState] = useState(false);

  // Popout settings
  const [popoutStopMain, setPopoutStopMainState] = useState(true);
  const [popoutAlwaysOnTop, setPopoutAlwaysOnTopState] = useState(false);
  const [popoutHwdecEnabled, setPopoutHwdecEnabledState] = useState(true);
  const [popoutMpvParamsEnabled, setPopoutMpvParamsEnabledState] = useState(false);
  const [popoutMpvParams, setPopoutMpvParamsState] = useState('');

  // External player settings
  const [externalPlayerPath, setExternalPlayerPathState] = useState('');
  const [externalPlayerArgs, setExternalPlayerArgsState] = useState('');
  const [externalPlayerReuse, setExternalPlayerReuseState] = useState(false);

  // Catch-up settings state
  const [catchupStartPadding, setCatchupStartPaddingState] = useState(0);
  const [catchupEndPadding, setCatchupEndPaddingState] = useState(0);
  const [catchupContinuePlaying, setCatchupContinuePlayingState] = useState(false);

  // VOD settings state
  const [vodAutoPlayNextEpisode, setVodAutoPlayNextEpisodeState] = useState(true);
  const [vodShowSourceBadge, setVodShowSourceBadgeState] = useState(false);
  const [failoverGroupShowSource, setFailoverGroupShowSourceState] = useState(false);

  // Custom scrollbar width settings
  const [enableCustomScrollbarWidth, setEnableCustomScrollbarWidthState] = useState(false);
  const [customScrollbarWidth, setCustomScrollbarWidthState] = useState(12);

  // Language setting (i18n). Initialized synchronously from the cached settings
  // that were read from localStorage at module load.
  const [language, setLanguageState] = useState<string>(() => {
    if (typeof cachedSettings?.language === 'string' && isSupportedLocale(cachedSettings.language)) {
      return cachedSettings.language;
    }
    return i18n.language || 'en';
  });

  // Theme state
  const [theme, setThemeState] = useState<ThemeId>(() => {
    if (cachedSettings?.theme) return cachedSettings.theme as ThemeId;
    if (typeof document !== 'undefined') {
      const activeDomTheme = document.documentElement.getAttribute('data-theme');
      if (activeDomTheme) return activeDomTheme as ThemeId;
    }
    return 'dark-cyan';
  });

  // Custom theme state
  const [customThemeConfig, setCustomThemeConfigState] = useState<CustomThemeConfig>(() => {
    if (cachedSettings?.customThemeConfig) {
      return cachedSettings.customThemeConfig;
    }
    try {
      const existing = typeof localStorage !== 'undefined' ? localStorage.getItem('app-settings') : null;
      if (existing) {
        const parsed = JSON.parse(existing);
        if (parsed.customThemeConfig) {
          cachedSettings = { ...cachedSettings, customThemeConfig: parsed.customThemeConfig };
          return parsed.customThemeConfig;
        }
      }
    } catch (e) {}
    return {
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
      fontFamily: 'inter'
    };
  });

  // Saved Custom Themes List
  const [savedCustomThemes, setSavedCustomThemesState] = useState<CustomThemeConfig[]>([]);

  // Shortcuts state
  const [shortcuts, setShortcutsState] = useState<ShortcutsMap>({});

  // Navigation tab visibility — hidden tabs start empty (all visible)
  const [navHiddenTabs, setNavHiddenTabsState] = useState<string[]>([]);

  // EPG button visibility — hidden buttons start empty (all visible)
  const [epgHiddenButtons, setEpgHiddenButtonsState] = useState<string[]>([]);

  // UI visibility
  const [categoriesHidden, setCategoriesHiddenState] = useState(false);
  const [categoriesHiddenTransparent, setCategoriesHiddenTransparentState] = useState(false);
  const [overlayAutohideTimer, setOverlayAutohideTimerState] = useState(3);
  const [overlayOnClickOnly, setOverlayOnClickOnlyState] = useState(false);

  // Widget scale (1 = 100%)
  const [widgetScale, setWidgetScaleState] = useState(1);
  const [widgetBgOpacity, setWidgetBgOpacityState] = useState(0.55);

  // Sports overlay
  const [sportsScale, setSportsScaleState] = useState(1);
  const [sportsBgOpacity, setSportsBgOpacityState] = useState(0.7);

  // Startup view
  const [startupView, setStartupViewState] = useState<'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'sports' | 'calendar' | 'stremio' | 'nuvio'>('none');

  // Google Cast setting
  const [castEnabled, setCastEnabledState] = useState(false);
  const [castRewriteTs, setCastRewriteTsState] = useState(true);

  // Discord Rich Presence settings
  const [discordRichPresence, setDiscordRichPresenceState] = useState(false);
  const [discordHideTitle, setDiscordHideTitleState] = useState(false);
  const [discordShowWhenPaused, setDiscordShowWhenPausedState] = useState(true);
  const [discordShowWhenBrowsing, setDiscordShowWhenBrowsingState] = useState(true);
  const [discordShowPoster, setDiscordShowPosterState] = useState(true);
  const [discordShowTimestamp, setDiscordShowTimestampState] = useState(true);

  // Theme Optimization settings
  const [hardwareAcceleration, setHardwareAccelerationState] = useState(true);
  const [disableThemeBackdropBlur, setDisableThemeBackdropBlurState] = useState(false);
  const [oledBlack, setOledBlackState] = useState(false);
  const [epgLazyLoadingEnabled, setEpgLazyLoadingEnabledState] = useState(false);
  const [disableEpgTransitions, setDisableEpgTransitionsState] = useState(false);
  const [epgReduceGpuLayers, setEpgReduceGpuLayersState] = useState(false);
  const [epgDisableChannelFade, setEpgDisableChannelFadeState] = useState(false);
  const [epgPreferEpgLogos, setEpgPreferEpgLogosState] = useState(false);
  const [epgLogoDisplay, setEpgLogoDisplayState] = useState<'square' | 'rectangle'>('square');
  const [channelLogoSize, setChannelLogoSizeState] = useState<number>(cachedSettings?.channelLogoSize ?? 42);
  const [channelLogoRoundEdges, setChannelLogoRoundEdgesState] = useState<boolean>(cachedSettings?.channelLogoRoundEdges ?? true);
  const [channelLogoPadding, setChannelLogoPaddingState] = useState<'none' | 'padded'>(cachedSettings?.channelLogoPadding ?? 'none');
  const [logoSmartTrim, setLogoSmartTrimState] = useState<boolean>(cachedSettings?.logoSmartTrim ?? false);
  const [logoLightBackgroundDetection, setLogoLightBackgroundDetectionState] = useState<boolean>(cachedSettings?.logoLightBackgroundDetection ?? true);
  const [sourceLogoDisplayOverrides, setSourceLogoDisplayOverridesState] = useState<Record<string, 'square' | 'rectangle'>>(
    cachedSettings?.sourceLogoDisplayOverrides ?? {}
  );
  const [epgMetadataBadgeResolution, setEpgMetadataBadgeResolutionState] = useState(cachedSettings?.epgMetadataBadgeResolution ?? true);
  const [epgMetadataBadgeFps, setEpgMetadataBadgeFpsState] = useState(cachedSettings?.epgMetadataBadgeFps ?? true);
  const [epgMetadataBadgeFpsSuffix, setEpgMetadataBadgeFpsSuffixState] = useState(cachedSettings?.epgMetadataBadgeFpsSuffix ?? true);
  const [epgMetadataBadgeSound, setEpgMetadataBadgeSoundState] = useState(cachedSettings?.epgMetadataBadgeSound ?? true);
  const [logoCacheEnabled, setLogoCacheEnabledState] = useState(cachedSettings?.logoCacheEnabled ?? false);
  const [logoCacheMaxMb, setLogoCacheMaxMbState] = useState(cachedSettings?.logoCacheMaxMb ?? 250);
  const [logoCacheTtlDays, setLogoCacheTtlDaysState] = useState(cachedSettings?.logoCacheTtlDays ?? 30);
  const [logoCachePrefetch, setLogoCachePrefetchState] = useState(cachedSettings?.logoCachePrefetch ?? false);
  const [globalLiveTvUserAgent, setGlobalLiveTvUserAgentState] = useState('');

  // Global Font selection states
  // Initialize from cachedSettings so all hook instances (ChannelLogo, MetadataBadge,
  // etc.) start with the correct value synchronously. This prevents them from ever
  // computing a different fontValue than the owner and inadvertently resetting the DOM.
  const [appFontFamily, setAppFontFamilyState] = useState<string>(cachedSettings?.appFontFamily || 'inter');
  const [appCustomFontBase64, setAppCustomFontBase64State] = useState<string>(cachedSettings?.appCustomFontBase64 || '');
  const [appCustomFontFormat, setAppCustomFontFormatState] = useState<string>(cachedSettings?.appCustomFontFormat || '');
  const [appCustomFontName, setAppCustomFontNameState] = useState<string>(cachedSettings?.appCustomFontName || '');

  // Global Font apply effect.
  // Multiple hook instances run this (ChannelLogo, MetadataBadge, App, etc.), but that
  // is safe because:
  // 1. All instances initialize appFontFamily from cachedSettings — they compute the
  //    same fontValue on mount, so the DOM guard below prevents redundant writes.
  // 2. Only the App-level instance ever calls setAppFontFamilyState with a NEW value
  //    (via updateAppFont), so only that instance re-runs with a changed fontValue.
  // 3. We compare against the current DOM value and bail out early if there's no change,
  //    which eliminates the mid-scroll flip-flop without needing ownership tracking.
  useEffect(() => {
    const root = document.documentElement;
    if (!root) return;

    let fontValue = "'Inter', system-ui, sans-serif";
    let fontFaceName: string | null = null;
    if (appFontFamily === 'switzer') {
      fontValue = "'Switzer', sans-serif";
      fontFaceName = 'Switzer';
    } else if (appFontFamily === 'sentient') {
      fontValue = "'Sentient', serif";
      fontFaceName = 'Sentient';
    } else if (appFontFamily === 'fraunces') {
      fontValue = "'Fraunces', serif";
      fontFaceName = 'Fraunces';
    } else if (appFontFamily === 'cabinet-grotesk') {
      fontValue = "'Cabinet Grotesk', sans-serif";
      fontFaceName = 'Cabinet Grotesk';
    } else if (appFontFamily === 'custom' && appCustomFontBase64) {
      fontValue = "'custom-uploaded-font', sans-serif";
    }

    // CJK font fallback: Chinese locales (zh-CN / zh-TW) need a CJK-capable font for
    // glyphs the latin UI fonts don't cover. Append the platform CJK stack to whatever
    // UI font is selected so Chinese text always renders (latin keeps the chosen face).
    const activeLng = i18n.language || i18n.resolvedLanguage || 'en';
    if (activeLng.startsWith('zh')) {
      const cjkStack =
        activeLng === 'zh-TW'
          ? "'Microsoft JhengHei', 'PingFang TC', 'Noto Sans CJK TC', 'Heiti TC', sans-serif"
          : "'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', 'Source Han Sans SC', sans-serif";
      const primary = fontValue.split(',')[0];
      fontValue = `${primary}, ${cjkStack}`;
    }

    // Guard: if the DOM already has this exact value, no work needed.
    // This prevents secondary instances (ChannelLogo, MetadataBadge mounted in Virtuoso
    // rows during EPG scroll) from redundantly re-applying the same font or, on the first
    // render cycle before cachedSettings was available, writing 'Inter' over the real font.
    const currentDomValue = root.style.getPropertyValue('--font-family');
    const needsFontWrite = currentDomValue !== fontValue;

    let styleEl = document.getElementById('custom-theme-font-face') as HTMLStyleElement;
    if (appFontFamily === 'custom' && appCustomFontBase64) {
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'custom-theme-font-face';
        document.head.appendChild(styleEl);
      }
      const format = appCustomFontFormat || 'woff2';
      const newFace = `@font-face{font-family:'custom-uploaded-font';src:url('${appCustomFontBase64}')format('${format}');font-weight:100 900;font-style:normal;font-display:block;}`;
      if (styleEl.innerHTML !== newFace) {
        styleEl.innerHTML = newFace;
      }
    } else {
      if (styleEl) styleEl.remove();
    }

    if (!needsFontWrite) return;

    // Pre-load the selected font before applying it to avoid any remaining FOUT.
    if (fontFaceName && document.fonts) {
      document.fonts.load(`400 1em '${fontFaceName}'`).then(() => {
        root.style.setProperty('--font-family', fontValue);
      }).catch(() => {
        root.style.setProperty('--font-family', fontValue);
      });
    } else {
      root.style.setProperty('--font-family', fontValue);
    }
  }, [appFontFamily, appCustomFontBase64, appCustomFontFormat, i18n.language]);

  // Apply theme effect
  useEffect(() => {
    const currentDomTheme = document.documentElement.getAttribute('data-theme');
    if (currentDomTheme !== theme) {
      document.documentElement.setAttribute('data-theme', theme);
    }
    if (theme === 'custom' && customThemeConfig) {
      applyCustomTheme(customThemeConfig);
    } else {
      const customKeys = [
        '--bg-primary',
        '--bg-secondary',
        '--bg-tertiary',
        '--surface-color',
        '--surface-hover',
        '--surface-active',
        '--surface-border',
        '--surface-glow',
        '--text-primary',
        '--text-secondary',
        '--text-muted',
        '--text-accent',
        '--accent-primary',
        '--accent-secondary',
        '--accent-glow',
        '--glass-blur',
        '--glass-saturation',
        '--glass-border',
        '--glass-shadow',
        '--bg-gradient-1',
        '--bg-gradient-2',
        '--bg-gradient-3',
        '--bg-gradient-4',
        '--bg-gradient-5',
        '--custom-blob-1',
        '--custom-blob-2',
        '--custom-blob-3',
        '--custom-blob-4',
        '--glass-blob-opacity',
        '--glass-blob-visibility',
        '--glass-blob-will-change'
      ];
      customKeys.forEach(key => {
        document.documentElement.style.removeProperty(key);
      });
    }
    // Keep the scrollbar hover color readable: if the theme's accent is too
    // dark against the background (e.g. a black accent on a dark theme) it
    // would make hover-highlighted scrollbars invisible. See themeHelper.
    updateScrollbarHoverColor();
  }, [theme, customThemeConfig]);

  // Apply optimization settings
  useEffect(() => {
    if (disableThemeBackdropBlur) {
      document.documentElement.classList.add('disable-theme-backdrop-blur');
    } else {
      document.documentElement.classList.remove('disable-theme-backdrop-blur');
    }
  }, [disableThemeBackdropBlur]);

  // OLED true-black is synced globally (module-level) from the settings load
  // and the setter — deliberately NOT from a per-instance effect here, so
  // component mounts never delete the attribute while their load is pending.

  useEffect(() => {
    if (disableEpgTransitions) {
      document.documentElement.classList.add('disable-epg-transitions');
    } else {
      document.documentElement.classList.remove('disable-epg-transitions');
    }
  }, [disableEpgTransitions]);

  useEffect(() => {
    if (epgReduceGpuLayers) {
      document.documentElement.classList.add('epg-reduce-gpu-layers');
    } else {
      document.documentElement.classList.remove('epg-reduce-gpu-layers');
    }
  }, [epgReduceGpuLayers]);

  useEffect(() => {
    if (epgDisableChannelFade) {
      document.documentElement.classList.add('epg-disable-channel-fade');
    } else {
      document.documentElement.classList.remove('epg-disable-channel-fade');
    }
  }, [epgDisableChannelFade]);

  // Load layout persistence settings on mount
  useEffect(() => {
    const loadLayoutSettings = async () => {
      if (!window.storage) {
        setLayoutSettingsLoaded(true);
        return;
      }

      try {
        // Try Tauri storage first
        // Capture when this load began so a slow read that started before a
        // user change can be detected and skipped (see settingsWriteStamps).
        const loadStartedAt = Date.now();
        const result = await window.storage.getSettings();

        // Also check localStorage for saved layout state and theme (saved on app close)
        let localStorageState: SavedLayoutState | null = null;
        let localStorageTheme: string | null = null;
        try {
          const localData = localStorage.getItem('app-settings');
          if (localData) {
            const parsed = JSON.parse(localData);
            localStorageState = parsed.savedLayoutState ?? null;
            localStorageTheme = parsed.theme ?? null;
          }
        } catch (e) {
          console.warn('[useAppSettings] Failed to read from localStorage:', e);
        }

        // Use the most recent state (prefer localStorage for layout state since it's saved on close)
        if (result.data) {
          if (result.data.savedVolume !== undefined) {
            try {
              if (localStorage.getItem('ynotv_volume') === null) {
                localStorage.setItem('ynotv_volume', String(result.data.savedVolume));
              }
            } catch {}
          }
          setRememberLastChannels(result.data.rememberLastChannels ?? false);
          setReopenLastOnStartup(result.data.reopenLastOnStartup ?? false);
          setTimeshiftEnabled(result.data.timeshiftEnabled ?? true);
          setTimeshiftCacheBytes(result.data.timeshiftCacheBytes ?? 268_435_456);
          setLiveBufferOffset(result.data.liveBufferOffset ?? 0);
          setIncludeSourceInSearch(result.data.includeSourceInSearch ?? false);
          setIncludeSourceInVodSearch(result.data.includeSourceInVodSearch ?? false);
          setMaxSearchResults(result.data.maxSearchResults ?? 200);
          setSearchResultsOrder(result.data.searchResultsOrder ?? 'default');
          setSourceFontSize(result.data.sourceFontSize ?? 12);
          setCategorySortOrder(result.data.categorySortOrder ?? 'default');
          setIncludeAllChannelsToPlaylist(result.data.includeAllChannelsToPlaylist ?? false);
          setHideDisabledSourcesState(result.data.hideDisabledSources ?? false);
          setAdvancedSearchScope(result.data.advancedSearchScope ?? 'both');
          setAdvancedSearchSourceIds(result.data.advancedSearchSourceIds ?? []);
          setAdvancedSearchCategoryIds(result.data.advancedSearchCategoryIds ?? []);
          setUseAdvancedSearchForRegular(result.data.useAdvancedSearchForRegular ?? false);
          setSearchCustomPlaylists(result.data.searchCustomPlaylists ?? false);
          setChannelInfoOverlayEnabled(result.data.channelInfoOverlayEnabled ?? false);
          setChannelInfoOverlayFontSizeState(result.data.channelInfoOverlayFontSize ?? 16);
          setChannelInfoOverlayLogoSizeState(result.data.channelInfoOverlayLogoSize ?? 42);
          setChannelInfoOverlayBoxWidthState(result.data.channelInfoOverlayBoxWidth ?? 380);
          setChannelInfoOverlayOpacityState(result.data.channelInfoOverlayOpacity ?? 55);
          setChannelInfoOverlayHideDescriptionState(result.data.channelInfoOverlayHideDescription ?? false);
          setChannelInfoOverlayHideMetaBadgeState(result.data.channelInfoOverlayHideMetaBadge ?? false);
          setChannelInfoOverlayHideLogoState(result.data.channelInfoOverlayHideLogo ?? false);
          setChannelInfoOverlayHideTimerState(result.data.channelInfoOverlayHideTimer ?? false);
          setChannelInfoOverlayPositionState(result.data.channelInfoOverlayPosition ?? 'left');
          setChannelInfoOverlayLogoShapeState(result.data.channelInfoOverlayLogoShape ?? 'square');
          setTransparentGuideOnZapState(result.data.transparentGuideOnZap ?? false);
          setCategoriesHiddenState(result.data.categoriesHidden ?? false);
          setCategoriesHiddenTransparentState(result.data.categoriesHiddenTransparent ?? false);
          setOverlayAutohideTimerState(result.data.overlayAutohideTimer ?? 3);
          setOverlayOnClickOnlyState(result.data.overlayOnClickOnly ?? false);
          setPlayerControlDesignState(result.data.playerControlDesign ?? 'clean');
          setShowVolumePercentState(result.data.showVolumePercent ?? false);
          setPopoutStopMainState(result.data.popoutStopMain ?? true);
          setPopoutAlwaysOnTopState(result.data.popoutAlwaysOnTop ?? false);
          setPopoutHwdecEnabledState(result.data.popoutHwdecEnabled ?? true);
          setPopoutMpvParamsEnabledState(result.data.popoutMpvParamsEnabled ?? false);
          setPopoutMpvParamsState(result.data.popoutMpvParams ?? '');
          setExternalPlayerPathState(result.data.externalPlayerPath ?? '');
          setExternalPlayerArgsState(result.data.externalPlayerArgs ?? '');
          setExternalPlayerReuseState(result.data.externalPlayerReuse ?? false);
          setCatchupStartPaddingState(result.data.catchupStartPadding ?? 0);
          setCatchupEndPaddingState(result.data.catchupEndPadding ?? 0);
          setCatchupContinuePlayingState(result.data.catchupContinuePlaying ?? false);
          setVodAutoPlayNextEpisodeState(result.data.vodAutoPlayNextEpisode ?? true);
          setVodShowSourceBadgeState(result.data.vodShowSourceBadge ?? false);
          setFailoverGroupShowSourceState(result.data.failoverGroupShowSource ?? false);

          // Load language (i18n) and apply it if it differs from the current runtime locale
          const loadedLanguage = result.data.language;
          if (typeof loadedLanguage === 'string' && isSupportedLocale(loadedLanguage)) {
            setLanguageState(loadedLanguage);
            if (i18n.language !== loadedLanguage) {
              i18n.changeLanguage(loadedLanguage);
            }
          }

          // Load widget scale and apply CSS variable
          const savedScale = result.data.widgetScale ?? 1;
          setWidgetScaleState(savedScale);
          document.documentElement.style.setProperty('--widget-scale', String(savedScale));

          const savedBgOpacity = result.data.widgetBgOpacity ?? 0.55;
          setWidgetBgOpacityState(savedBgOpacity);
          document.documentElement.style.setProperty('--widget-bg-opacity', String(savedBgOpacity));
          document.documentElement.style.setProperty('--cio-bg-opacity', String(savedBgOpacity));

          const savedSportsScale = result.data.sportsScale ?? 1;
          setSportsScaleState(savedSportsScale);
          document.documentElement.style.setProperty('--sports-scale', String(savedSportsScale));

          const savedSportsBgOpacity = result.data.sportsBgOpacity ?? 0.7;
          setSportsBgOpacityState(savedSportsBgOpacity);
          document.documentElement.style.setProperty('--sports-bg-opacity', String(savedSportsBgOpacity));

          // Load navigation hidden tabs
          setNavHiddenTabsState(result.data.navHiddenTabs ?? []);

          // Load EPG hidden buttons
          setEpgHiddenButtonsState(result.data.epgHiddenButtons ?? []);

          // Load shortcuts (rebinds like mouse buttons must be hydrated at startup —
          // otherwise the runtime uses DEFAULT_SHORTCUTS until the user re-applies
          // them in Settings)
          setShortcutsState(result.data.shortcuts ?? {});

          // Load startup view
          setStartupViewState(result.data.startupView ?? 'none');

          // Load Google Cast setting
          setCastEnabledState(result.data.castEnabled ?? false);
          setCastRewriteTsState(result.data.castRewriteTs ?? true);

          // Load Discord settings
          setDiscordRichPresenceState(result.data.discordRichPresence ?? false);
          setDiscordHideTitleState(result.data.discordHideTitle ?? false);
          setDiscordShowWhenPausedState(result.data.discordShowWhenPaused ?? true);
          setDiscordShowWhenBrowsingState(result.data.discordShowWhenBrowsing ?? true);
          setDiscordShowPosterState(result.data.discordShowPoster ?? true);
          setDiscordShowTimestampState(result.data.discordShowTimestamp ?? true);

          // Load Custom Scrollbar settings
          const savedEnableCustomScrollbarWidth = result.data.enableCustomScrollbarWidth ?? false;
          const savedCustomScrollbarWidth = result.data.customScrollbarWidth ?? 12;
          setEnableCustomScrollbarWidthState(savedEnableCustomScrollbarWidth);
          setCustomScrollbarWidthState(savedCustomScrollbarWidth);
          if (savedEnableCustomScrollbarWidth) {
            document.documentElement.dataset.customScrollbar = 'true';
            document.documentElement.style.setProperty('--app-scrollbar-width', `${savedCustomScrollbarWidth}px`);
          } else {
            delete document.documentElement.dataset.customScrollbar;
            document.documentElement.style.removeProperty('--app-scrollbar-width');
          }

          // Load Optimization settings
          setHardwareAccelerationState(result.data.hardwareAcceleration ?? true);
          setDisableThemeBackdropBlurState(result.data.disableThemeBackdropBlur ?? false);
          setOledBlackState(result.data.oledBlack ?? false);
          oledBlackGlobal = result.data.oledBlack ?? false;
          applyOledAttribute();
          setEpgLazyLoadingEnabledState(result.data.epgLazyLoadingEnabled ?? false);
          setDisableEpgTransitionsState(result.data.disableEpgTransitions ?? false);
          setEpgReduceGpuLayersState(result.data.epgReduceGpuLayers ?? false);
          setEpgDisableChannelFadeState(result.data.epgDisableChannelFade ?? false);
          setEpgPreferEpgLogosState(result.data.epgPreferEpgLogos ?? false);
          setEpgLogoDisplayState(result.data.epgLogoDisplay ?? 'square');
          const loadedLogoSize = result.data.channelLogoSize ?? 42;
          setChannelLogoSizeState(loadedLogoSize);
          document.documentElement.style.setProperty('--channel-logo-size', `${loadedLogoSize}px`);
          if (result.data.channelLogoRoundEdges === false) {
            document.documentElement.style.setProperty('--channel-logo-radius', '0px');
            document.documentElement.classList.add('logo-sharp-edges');
          } else {
            document.documentElement.style.removeProperty('--channel-logo-radius');
            document.documentElement.classList.remove('logo-sharp-edges');
          }
          if (result.data.channelLogoPadding === 'padded') {
            document.documentElement.classList.add('logo-padded-tiles');
          } else {
            document.documentElement.classList.remove('logo-padded-tiles');
          }
          setChannelLogoPaddingState(result.data.channelLogoPadding ?? 'none');
          setLogoSmartTrimState(result.data.logoSmartTrim ?? false);
          setLogoLightBackgroundDetectionState(result.data.logoLightBackgroundDetection ?? true);
          setSourceLogoDisplayOverridesState(result.data.sourceLogoDisplayOverrides ?? {});
          setEpgMetadataBadgeResolutionState(result.data.epgMetadataBadgeResolution ?? true);
          setEpgMetadataBadgeFpsState(result.data.epgMetadataBadgeFps ?? true);
          setEpgMetadataBadgeFpsSuffixState(result.data.epgMetadataBadgeFpsSuffix ?? true);
          setEpgMetadataBadgeSoundState(result.data.epgMetadataBadgeSound ?? true);
          setLogoCacheEnabledState(result.data.logoCacheEnabled ?? false);
          setLogoCacheMaxMbState(result.data.logoCacheMaxMb ?? 250);
          setLogoCacheTtlDaysState(result.data.logoCacheTtlDays ?? 30);
          setLogoCachePrefetchState(result.data.logoCachePrefetch ?? false);
          if (result.data.epgLogoDisplay === 'rectangle') {
            document.documentElement.classList.add('epg-rectangle-logos');
          }
          setGlobalLiveTvUserAgentState(result.data.globalLiveTvUserAgent ?? '');

          // Apply EPG darken current setting on load
          if (result.data.epgDarkenCurrent) {
            document.documentElement.classList.add('epg-darken-current');
          }

          // Apply EPG highlight border current setting on load
          if (result.data.epgHighlightBorderCurrent) {
            document.documentElement.classList.add('epg-highlight-border-current');
          }

          // Apply EPG bold channel names setting on load
          if (result.data.epgBoldChannelNames) {
            document.documentElement.classList.add('epg-bold-channel-names');
          }

          // Apply EPG bold top categories setting on load
          if (result.data.epgBoldTopCategories) {
            document.documentElement.classList.add('epg-bold-top-categories');
          }

          // Apply EPG bold source categories setting on load
          if (result.data.epgBoldSourceCategories) {
            document.documentElement.classList.add('epg-bold-source-categories');
          }

          // Use localStorage state if available (more recent), otherwise use Tauri storage
          const layoutState = localStorageState || result.data.savedLayoutState || null;
          setSavedLayoutState(layoutState);

          // Load active custom theme config FIRST so themeState doesn't trigger effect with uninitialized config
          let loadedCustomConfig = result.data.customThemeConfig;
          if (settingsWriteStamps['customThemeConfig'] > loadStartedAt) {
            // The user changed the accent config while this load was in flight —
            // keep the newer in-memory config instead of the stale snapshot.
            loadedCustomConfig = undefined;
          } else if (!loadedCustomConfig) {
            try {
              const existing = localStorage.getItem('app-settings');
              if (existing) {
                const parsed = JSON.parse(existing);
                if (parsed.customThemeConfig) {
                  loadedCustomConfig = parsed.customThemeConfig;
                }
              }
            } catch (e) {}
          }
          if (loadedCustomConfig) {
            setCustomThemeConfigState(loadedCustomConfig);
          }

          // Load global font settings
          const fFamily = result.data.appFontFamily || 'inter';
          const fBase64 = result.data.appCustomFontBase64 || '';
          const fFormat = result.data.appCustomFontFormat || '';
          const fName = result.data.appCustomFontName || '';
          setAppFontFamilyState(fFamily);
          setAppCustomFontBase64State(fBase64);
          setAppCustomFontFormatState(fFormat);
          setAppCustomFontNameState(fName);

          // Load custom themes list
          const savedThemesList = result.data.savedCustomThemes || [];
          setSavedCustomThemesState(savedThemesList);

          // Load theme
          const savedTheme =
            settingsWriteStamps['theme'] > loadStartedAt
              ? (cachedSettings?.theme as ThemeId | undefined) || (localStorageTheme as ThemeId) || 'dark-cyan'
              : (result.data.theme as ThemeId) || (localStorageTheme as ThemeId) || 'dark-cyan';
          cachedSettings = { ...cachedSettings, ...result.data, theme: savedTheme, customThemeConfig: loadedCustomConfig || cachedSettings?.customThemeConfig };
          setThemeState(savedTheme as ThemeId);

          // Propagate Tauri values to localStorage
          try {
            const existing = localStorage.getItem('app-settings');
            const parsed = existing ? JSON.parse(existing) : {};
            const updated = {
              ...parsed,
              customThemeConfig: result.data.customThemeConfig || parsed.customThemeConfig,
              savedCustomThemes: savedThemesList,
              appFontFamily: fFamily,
              appCustomFontBase64: fBase64,
              appCustomFontFormat: fFormat,
              appCustomFontName: fName
            };
            localStorage.setItem('app-settings', JSON.stringify(updated));
          } catch (e) {}

          // One-time migration: check if timeshiftMigrationCheck is not set
          if (result.data.timeshiftMigrationCheck !== true) {
            const hasTimeshift = result.data.timeshiftEnabled === true;
            if (!hasTimeshift) {
              setTimeshiftEnabled(true);
              setTimeshiftCacheBytes(268_435_456); // 256MB
              window.storage.updateSettings({
                timeshiftEnabled: true,
                timeshiftCacheBytes: 268_435_456,
                timeshiftMigrationCheck: true,
              }).catch((err) => console.warn('[useAppSettings] Failed to run timeshift migration:', err));
            } else {
              window.storage.updateSettings({
                timeshiftMigrationCheck: true,
              }).catch((err) => console.warn('[useAppSettings] Failed to save timeshift migration flag:', err));
            }
          }
        } else if (localStorageState) {
          // Fallback to localStorage if Tauri storage is empty
          setSavedLayoutState(localStorageState);
          console.log('[useAppSettings] Loaded saved layout state from localStorage:', localStorageState);

          // Load theme from localStorage
          if (localStorageTheme) {
            setThemeState(localStorageTheme as ThemeId);
          }

          try {
            const existing = localStorage.getItem('app-settings');
            if (existing) {
              const parsed = JSON.parse(existing);
              if (parsed.customThemeConfig) {
                setCustomThemeConfigState(parsed.customThemeConfig);
              }
              if (parsed.savedCustomThemes) setSavedCustomThemesState(parsed.savedCustomThemes);
              if (parsed.appFontFamily) setAppFontFamilyState(parsed.appFontFamily);
              if (parsed.appCustomFontBase64) setAppCustomFontBase64State(parsed.appCustomFontBase64);
              if (parsed.appCustomFontFormat) setAppCustomFontFormatState(parsed.appCustomFontFormat);
              if (parsed.appCustomFontName) setAppCustomFontNameState(parsed.appCustomFontName);
            }
          } catch (e) {}
        }
      } catch (e) {
        console.error('[useAppSettings] Failed to load layout settings:', e);
      }
      setLayoutSettingsLoaded(true);
    };
    loadLayoutSettings();
  }, []);

  const updateCustomThemeConfig = useCallback(async (newConfig: Partial<CustomThemeConfig>) => {
    setCustomThemeConfigState((prev) => {
      const updated = { ...prev, ...newConfig };
      // Keep the module cache fresh so instances that mount afterwards seed the
      // new accent config instead of a stale one (mirrors setTheme).
      cachedSettings = { ...cachedSettings, customThemeConfig: updated };
      stampSettingsWrite('customThemeConfig');
      // Persist to storage
      if (window.storage) {
        window.storage.updateSettings({ customThemeConfig: updated }).catch((e) => {
          console.error('[useAppSettings] Failed to save custom theme:', e);
        });
      }
      try {
        const existing = localStorage.getItem('app-settings');
        const parsed = existing ? JSON.parse(existing) : {};
        localStorage.setItem('app-settings', JSON.stringify({ ...parsed, customThemeConfig: updated }));
      } catch (e) {
        console.warn('[useAppSettings] Failed to save custom theme to localStorage:', e);
      }
      return updated;
    });
  }, []);

  const setTheme = useCallback(async (newTheme: ThemeId) => {
    cachedSettings = { ...cachedSettings, theme: newTheme };
    stampSettingsWrite('theme');
    setThemeState(newTheme);
    // Persist to storage
    if (window.storage) {
      try {
        await window.storage.updateSettings({ theme: newTheme });
      } catch (e) {
        console.error('[useAppSettings] Failed to save theme:', e);
      }
    }
    // Also save to localStorage as backup
    try {
      const existing = localStorage.getItem('app-settings');
      const parsed = existing ? JSON.parse(existing) : {};
      localStorage.setItem('app-settings', JSON.stringify({ ...parsed, theme: newTheme }));
    } catch (e) {
      console.warn('[useAppSettings] Failed to save theme to localStorage:', e);
    }
  }, []);

  const setShortcuts = useCallback((newShortcuts: ShortcutsMap) => {
    setShortcutsState(newShortcuts);
  }, []);

  const setCategoriesHidden = useCallback(async (hidden: boolean) => {
    setCategoriesHiddenState(hidden);
    // Persist to storage
    if (window.storage) {
      try {
        await window.storage.updateSettings({ categoriesHidden: hidden });
      } catch (e) {
        console.error('[useAppSettings] Failed to save categoriesHidden:', e);
      }
    }
  }, []);

  const setCategoriesHiddenTransparent = useCallback(async (hidden: boolean) => {
    setCategoriesHiddenTransparentState(hidden);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ categoriesHiddenTransparent: hidden });
      } catch (e) {
        console.error('[useAppSettings] Failed to save categoriesHiddenTransparent:', e);
      }
    }
  }, []);

  const setOverlayAutohideTimer = useCallback(async (seconds: number) => {
    setOverlayAutohideTimerState(seconds);
    if (window.storage) {
      try {
        window.storage.debouncedUpdateSettings({ overlayAutohideTimer: seconds });
      } catch (e) {
        console.error('[useAppSettings] Failed to save overlayAutohideTimer:', e);
      }
    }
  }, []);

  const setOverlayOnClickOnly = useCallback(async (enabled: boolean) => {
    setOverlayOnClickOnlyState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ overlayOnClickOnly: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save overlayOnClickOnly:', e);
      }
    }
  }, []);

  const setChannelInfoOverlayFontSize = useCallback(async (size: number) => {
    setChannelInfoOverlayFontSizeState(size);
    document.documentElement.style.setProperty('--cio-font-size', `${size}px`);
    if (window.storage) {
      try {
        window.storage.debouncedUpdateSettings({ channelInfoOverlayFontSize: size });
      } catch (e) {
        console.error('[useAppSettings] Failed to save channelInfoOverlayFontSize:', e);
      }
    }
  }, []);

  const setChannelInfoOverlayLogoSize = useCallback(async (size: number) => {
    setChannelInfoOverlayLogoSizeState(size);
    document.documentElement.style.setProperty('--cio-logo-size', `${size}px`);
    if (window.storage) {
      try {
        window.storage.debouncedUpdateSettings({ channelInfoOverlayLogoSize: size });
      } catch (e) {
        console.error('[useAppSettings] Failed to save channelInfoOverlayLogoSize:', e);
      }
    }
  }, []);

  const setChannelInfoOverlayBoxWidth = useCallback(async (width: number) => {
    setChannelInfoOverlayBoxWidthState(width);
    document.documentElement.style.setProperty('--cio-box-width', `${width}px`);
    if (window.storage) {
      try {
        window.storage.debouncedUpdateSettings({ channelInfoOverlayBoxWidth: width });
      } catch (e) {
        console.error('[useAppSettings] Failed to save channelInfoOverlayBoxWidth:', e);
      }
    }
  }, []);

  const setChannelInfoOverlayOpacity = useCallback(async (opacity: number) => {
    setChannelInfoOverlayOpacityState(opacity);
    document.documentElement.style.setProperty('--cio-bg-opacity', `${opacity / 100}`);
    if (window.storage) {
      try {
        window.storage.debouncedUpdateSettings({ channelInfoOverlayOpacity: opacity });
      } catch (e) {
        console.error('[useAppSettings] Failed to save channelInfoOverlayOpacity:', e);
      }
    }
  }, []);

  const setChannelInfoOverlayHideDescription = useCallback(async (hide: boolean) => {
    setChannelInfoOverlayHideDescriptionState(hide);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ channelInfoOverlayHideDescription: hide });
      } catch (e) {
        console.error('[useAppSettings] Failed to save channelInfoOverlayHideDescription:', e);
      }
    }
  }, []);

  const setTransparentGuideOnZap = useCallback(async (enabled: boolean) => {
    setTransparentGuideOnZapState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ transparentGuideOnZap: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save transparentGuideOnZap:', e);
      }
    }
  }, []);

  const setPlayerControlDesign = useCallback(async (design: 'default' | 'clean') => {
    setPlayerControlDesignState(design);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ playerControlDesign: design });
      } catch (e) {
        console.error('[useAppSettings] Failed to save playerControlDesign:', e);
      }
    }
  }, []);

  const setShowVolumePercent = useCallback(async (enabled: boolean) => {
    setShowVolumePercentState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ showVolumePercent: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save showVolumePercent:', e);
      }
    }
  }, []);

  const setChannelInfoOverlayEnabled = useCallback(async (enabled: boolean) => {
    setChannelInfoOverlayEnabledState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ channelInfoOverlayEnabled: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save channelInfoOverlayEnabled:', e);
      }
    }
  }, []);

  const setCategorySortOrderSetting = useCallback(async (order: 'default' | 'alphabetical') => {
    setCategorySortOrder(order);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ categorySortOrder: order });
      } catch (e) {
        console.error('[useAppSettings] Failed to save categorySortOrder:', e);
      }
    }
  }, []);

  const setIncludeAllChannelsToPlaylistSetting = useCallback(async (enabled: boolean) => {
    setIncludeAllChannelsToPlaylist(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ includeAllChannelsToPlaylist: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save includeAllChannelsToPlaylist:', e);
      }
    }
  }, []);

  const setHideDisabledSourcesSetting = useCallback(async (hidden: boolean) => {
    setHideDisabledSourcesState(hidden);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ hideDisabledSources: hidden });
      } catch (e) {
        console.error('[useAppSettings] Failed to save hideDisabledSources:', e);
      }
    }
  }, []);

  const setChannelInfoOverlayHideMetaBadge = useCallback(async (hide: boolean) => {
    setChannelInfoOverlayHideMetaBadgeState(hide);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ channelInfoOverlayHideMetaBadge: hide });
      } catch (e) {
        console.error('[useAppSettings] Failed to save channelInfoOverlayHideMetaBadge:', e);
      }
    }
  }, []);

  const setChannelInfoOverlayHideLogo = useCallback(async (hide: boolean) => {
    setChannelInfoOverlayHideLogoState(hide);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ channelInfoOverlayHideLogo: hide });
      } catch (e) {
        console.error('[useAppSettings] Failed to save channelInfoOverlayHideLogo:', e);
      }
    }
  }, []);

  const setChannelInfoOverlayHideTimer = useCallback(async (hide: boolean) => {
    setChannelInfoOverlayHideTimerState(hide);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ channelInfoOverlayHideTimer: hide });
      } catch (e) {
        console.error('[useAppSettings] Failed to save channelInfoOverlayHideTimer:', e);
      }
    }
  }, []);

  const setChannelInfoOverlayPosition = useCallback(async (pos: 'left' | 'right') => {
    setChannelInfoOverlayPositionState(pos);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ channelInfoOverlayPosition: pos });
      } catch (e) {
        console.error('[useAppSettings] Failed to save channelInfoOverlayPosition:', e);
      }
    }
  }, []);

  const setChannelInfoOverlayLogoShape = useCallback(async (shape: 'square' | 'horizontal') => {
    setChannelInfoOverlayLogoShapeState(shape);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ channelInfoOverlayLogoShape: shape });
      } catch (e) {
        console.error('[useAppSettings] Failed to save channelInfoOverlayLogoShape:', e);
      }
    }
  }, []);

  const setPopoutStopMain = useCallback(async (stop: boolean) => {
    setPopoutStopMainState(stop);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ popoutStopMain: stop });
      } catch (e) {
        console.error('[useAppSettings] Failed to save popoutStopMain:', e);
      }
    }
  }, []);

  const setPopoutAlwaysOnTop = useCallback(async (onTop: boolean) => {
    setPopoutAlwaysOnTopState(onTop);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ popoutAlwaysOnTop: onTop });
      } catch (e) {
        console.error('[useAppSettings] Failed to save popoutAlwaysOnTop:', e);
      }
    }
  }, []);

  const setPopoutHwdecEnabled = useCallback(async (enabled: boolean) => {
    setPopoutHwdecEnabledState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ popoutHwdecEnabled: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save popoutHwdecEnabled:', e);
      }
    }
  }, []);

  const setPopoutMpvParamsEnabled = useCallback(async (enabled: boolean) => {
    setPopoutMpvParamsEnabledState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ popoutMpvParamsEnabled: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save popoutMpvParamsEnabled:', e);
      }
    }
  }, []);

  const setPopoutMpvParams = useCallback(async (params: string) => {
    setPopoutMpvParamsState(params);
    if (window.storage) {
      try {
        window.storage.debouncedUpdateSettings({ popoutMpvParams: params });
      } catch (e) {
        console.error('[useAppSettings] Failed to save popoutMpvParams:', e);
      }
    }
  }, []);

  const setWidgetScale = useCallback(async (scale: number) => {
    setWidgetScaleState(scale);
    document.documentElement.style.setProperty('--widget-scale', String(scale));
    if (window.storage) {
      try {
        window.storage.debouncedUpdateSettings({ widgetScale: scale });
      } catch (e) {
        console.error('[useAppSettings] Failed to save widgetScale:', e);
      }
    }
  }, []);

  const setWidgetBgOpacity = useCallback(async (opacity: number) => {
    setWidgetBgOpacityState(opacity);
    document.documentElement.style.setProperty('--widget-bg-opacity', String(opacity));
    document.documentElement.style.setProperty('--cio-bg-opacity', String(opacity));
    if (window.storage) {
      try {
        window.storage.debouncedUpdateSettings({ widgetBgOpacity: opacity });
      } catch (e) {
        console.error('[useAppSettings] Failed to save widgetBgOpacity:', e);
      }
    }
  }, []);

  const setSportsScale = useCallback(async (scale: number) => {
    setSportsScaleState(scale);
    document.documentElement.style.setProperty('--sports-scale', String(scale));
    if (window.storage) {
      try {
        window.storage.debouncedUpdateSettings({ sportsScale: scale });
      } catch (e) {
        console.error('[useAppSettings] Failed to save sportsScale:', e);
      }
    }
  }, []);

  const setSportsBgOpacity = useCallback(async (opacity: number) => {
    setSportsBgOpacityState(opacity);
    document.documentElement.style.setProperty('--sports-bg-opacity', String(opacity));
    if (window.storage) {
      try {
        window.storage.debouncedUpdateSettings({ sportsBgOpacity: opacity });
      } catch (e) {
        console.error('[useAppSettings] Failed to save sportsBgOpacity:', e);
      }
    }
  }, []);

  const setNavHiddenTabs = useCallback(async (tabs: string[]) => {
    setNavHiddenTabsState(tabs);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ navHiddenTabs: tabs });
      } catch (e) {
        console.error('[useAppSettings] Failed to save navHiddenTabs:', e);
      }
    }
  }, []);

  const setEpgHiddenButtons = useCallback(async (buttons: string[]) => {
    setEpgHiddenButtonsState(buttons);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ epgHiddenButtons: buttons });
      } catch (e) {
        console.error('[useAppSettings] Failed to save epgHiddenButtons:', e);
      }
    }
  }, []);

  const setStartupView = useCallback(async (view: 'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'sports' | 'calendar' | 'stremio' | 'nuvio') => {
    setStartupViewState(view);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ startupView: view });
      } catch (e) {
        console.error('[useAppSettings] Failed to save startupView:', e);
      }
    }
  }, []);

  const setExternalPlayerPath = useCallback(async (path: string) => {
    setExternalPlayerPathState(path);
    if (window.storage) {
      try {
        window.storage.debouncedUpdateSettings({ externalPlayerPath: path });
      } catch (e) {
        console.error('[useAppSettings] Failed to save externalPlayerPath:', e);
      }
    }
  }, []);

  const setExternalPlayerArgs = useCallback(async (args: string) => {
    setExternalPlayerArgsState(args);
    if (window.storage) {
      try {
        window.storage.debouncedUpdateSettings({ externalPlayerArgs: args });
      } catch (e) {
        console.error('[useAppSettings] Failed to save externalPlayerArgs:', e);
      }
    }
  }, []);

  const setExternalPlayerReuse = useCallback(async (reuse: boolean) => {
    setExternalPlayerReuseState(reuse);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ externalPlayerReuse: reuse });
      } catch (e) {
        console.error('[useAppSettings] Failed to save externalPlayerReuse:', e);
      }
    }
  }, []);

  const setDiscordRichPresence = useCallback(async (enabled: boolean) => {
    setDiscordRichPresenceState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ discordRichPresence: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save discordRichPresence:', e);
      }
    }
  }, []);

  const setDiscordHideTitle = useCallback(async (hide: boolean) => {
    setDiscordHideTitleState(hide);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ discordHideTitle: hide });
      } catch (e) {
        console.error('[useAppSettings] Failed to save discordHideTitle:', e);
      }
    }
  }, []);

  const setDiscordShowWhenPaused = useCallback(async (show: boolean) => {
    setDiscordShowWhenPausedState(show);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ discordShowWhenPaused: show });
      } catch (e) {
        console.error('[useAppSettings] Failed to save discordShowWhenPaused:', e);
      }
    }
  }, []);

  const setDiscordShowWhenBrowsing = useCallback(async (show: boolean) => {
    setDiscordShowWhenBrowsingState(show);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ discordShowWhenBrowsing: show });
      } catch (e) {
        console.error('[useAppSettings] Failed to save discordShowWhenBrowsing:', e);
      }
    }
  }, []);

  const setDiscordShowPoster = useCallback(async (show: boolean) => {
    setDiscordShowPosterState(show);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ discordShowPoster: show });
      } catch (e) {
        console.error('[useAppSettings] Failed to save discordShowPoster:', e);
      }
    }
  }, []);

  const setDiscordShowTimestamp = useCallback(async (show: boolean) => {
    setDiscordShowTimestampState(show);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ discordShowTimestamp: show });
      } catch (e) {
        console.error('[useAppSettings] Failed to save discordShowTimestamp:', e);
      }
    }
  }, []);

  const setCatchupStartPadding = useCallback(async (padding: number) => {
    setCatchupStartPaddingState(padding);
    if (window.storage) {
      try {
        window.storage.debouncedUpdateSettings({ catchupStartPadding: padding });
      } catch (e) {
        console.error('[useAppSettings] Failed to save catchupStartPadding:', e);
      }
    }
    window.dispatchEvent(
      new CustomEvent('ynotv:catchup-settings-changed', {
        detail: { catchupStartPadding: padding },
      })
    );
  }, []);

  const setCatchupEndPadding = useCallback(async (padding: number) => {
    setCatchupEndPaddingState(padding);
    if (window.storage) {
      try {
        window.storage.debouncedUpdateSettings({ catchupEndPadding: padding });
      } catch (e) {
        console.error('[useAppSettings] Failed to save catchupEndPadding:', e);
      }
    }
    window.dispatchEvent(
      new CustomEvent('ynotv:catchup-settings-changed', {
        detail: { catchupEndPadding: padding },
      })
    );
  }, []);

  const setCatchupContinuePlaying = useCallback(async (continuePlaying: boolean) => {
    setCatchupContinuePlayingState(continuePlaying);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ catchupContinuePlaying: continuePlaying });
      } catch (e) {
        console.error('[useAppSettings] Failed to save catchupContinuePlaying:', e);
      }
    }
    window.dispatchEvent(
      new CustomEvent('ynotv:catchup-settings-changed', {
        detail: { catchupContinuePlaying: continuePlaying },
      })
    );
  }, []);

  const setVodAutoPlayNextEpisode = useCallback(async (enabled: boolean) => {
    setVodAutoPlayNextEpisodeState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ vodAutoPlayNextEpisode: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save vodAutoPlayNextEpisode:', e);
      }
    }
    window.dispatchEvent(
      new CustomEvent('ynotv:vod-settings-changed', {
        detail: { vodAutoPlayNextEpisode: enabled },
      })
    );
  }, []);

  const setVodShowSourceBadge = useCallback(async (enabled: boolean) => {
    setVodShowSourceBadgeState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ vodShowSourceBadge: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save vodShowSourceBadge:', e);
      }
    }
    window.dispatchEvent(
      new CustomEvent('ynotv:vod-settings-changed', {
        detail: { vodShowSourceBadge: enabled },
      })
    );
  }, []);

  const setFailoverGroupShowSource = useCallback(async (enabled: boolean) => {
    setFailoverGroupShowSourceState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ failoverGroupShowSource: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save failoverGroupShowSource:', e);
      }
    }
    window.dispatchEvent(
      new CustomEvent('ynotv:livetv-settings-changed', {
        detail: { failoverGroupShowSource: enabled },
      })
    );
  }, []);

  const setLanguage = useCallback(async (lang: string) => {
    setLanguageState(lang);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ language: lang });
      } catch (e) {
        console.error('[useAppSettings] Failed to save language:', e);
      }
    }
    try {
      const existing = localStorage.getItem('app-settings');
      const parsed = existing ? JSON.parse(existing) : {};
      localStorage.setItem('app-settings', JSON.stringify({ ...parsed, language: lang }));
    } catch (e) {
      console.warn('[useAppSettings] Failed to save language to localStorage:', e);
    }
    await i18n.changeLanguage(lang);
  }, []);

  const setCastEnabled = useCallback(async (enabled: boolean) => {
    setCastEnabledState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ castEnabled: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save castEnabled:', e);
      }
    }
  }, []);

  const setCastRewriteTs = useCallback(async (enabled: boolean) => {
    setCastRewriteTsState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ castRewriteTs: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save castRewriteTs:', e);
      }
    }
  }, []);

  const updateAppFont = useCallback(async (family: string, base64 = '', format = '', name = '') => {
    setAppFontFamilyState(family);
    setAppCustomFontBase64State(base64);
    setAppCustomFontFormatState(format);
    setAppCustomFontNameState(name);

    const updateObj = {
      appFontFamily: family,
      appCustomFontBase64: base64,
      appCustomFontFormat: format,
      appCustomFontName: name
    };

    if (window.storage) {
      window.storage.updateSettings(updateObj).catch((e) => {
        console.error('[useAppSettings] Failed to save app font settings to Tauri:', e);
      });
    }

    try {
      const existing = localStorage.getItem('app-settings');
      const parsed = existing ? JSON.parse(existing) : {};
      localStorage.setItem('app-settings', JSON.stringify({ ...parsed, ...updateObj }));
    } catch (e) {
      console.warn('[useAppSettings] Failed to save app font settings to localStorage:', e);
    }
  }, []);

  const setHardwareAcceleration = useCallback(async (enabled: boolean) => {
    setHardwareAccelerationState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ hardwareAcceleration: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save hardwareAcceleration:', e);
      }
    }
  }, []);

  const setDisableThemeBackdropBlur = useCallback(async (disabled: boolean) => {
    setDisableThemeBackdropBlurState(disabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ disableThemeBackdropBlur: disabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save disableThemeBackdropBlur:', e);
      }
    }
  }, []);

  const setOledBlack = useCallback(async (enabled: boolean) => {
    setOledBlackState(enabled);
    oledBlackGlobal = enabled;
    applyOledAttribute();
    if (window.storage) {
      try {
        await window.storage.updateSettings({ oledBlack: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save oledBlack:', e);
      }
    }
  }, []);

  const setEpgLazyLoadingEnabled = useCallback(async (enabled: boolean) => {
    setEpgLazyLoadingEnabledState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ epgLazyLoadingEnabled: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save epgLazyLoadingEnabled:', e);
      }
    }
  }, []);

  const setDisableEpgTransitions = useCallback(async (disabled: boolean) => {
    setDisableEpgTransitionsState(disabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ disableEpgTransitions: disabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save disableEpgTransitions:', e);
      }
    }
  }, []);

  const setEpgReduceGpuLayers = useCallback(async (enabled: boolean) => {
    setEpgReduceGpuLayersState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ epgReduceGpuLayers: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save epgReduceGpuLayers:', e);
      }
    }
  }, []);

  const setEpgDisableChannelFade = useCallback(async (enabled: boolean) => {
    setEpgDisableChannelFadeState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ epgDisableChannelFade: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save epgDisableChannelFade:', e);
      }
    }
  }, []);

  const setEpgPreferEpgLogos = useCallback(async (enabled: boolean) => {
    setEpgPreferEpgLogosState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ epgPreferEpgLogos: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save epgPreferEpgLogos:', e);
      }
    }
  }, []);

  const setEpgMetadataBadgeResolution = useCallback(async (enabled: boolean) => {
    setEpgMetadataBadgeResolutionState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ epgMetadataBadgeResolution: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save epgMetadataBadgeResolution:', e);
      }
    }
  }, []);

  const setEpgMetadataBadgeFps = useCallback(async (enabled: boolean) => {
    setEpgMetadataBadgeFpsState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ epgMetadataBadgeFps: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save epgMetadataBadgeFps:', e);
      }
    }
  }, []);

  const setEpgMetadataBadgeSound = useCallback(async (enabled: boolean) => {
    setEpgMetadataBadgeSoundState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ epgMetadataBadgeSound: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save epgMetadataBadgeSound:', e);
      }
    }
  }, []);

  const setLogoCacheEnabled = useCallback(async (enabled: boolean) => {
    setLogoCacheEnabledState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ logoCacheEnabled: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save logoCacheEnabled:', e);
      }
    }
  }, []);

  const setLogoCacheMaxMb = useCallback(async (mb: number) => {
    setLogoCacheMaxMbState(mb);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ logoCacheMaxMb: mb });
      } catch (e) {
        console.error('[useAppSettings] Failed to save logoCacheMaxMb:', e);
      }
    }
  }, []);

  const setLogoCacheTtlDays = useCallback(async (days: number) => {
    setLogoCacheTtlDaysState(days);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ logoCacheTtlDays: days });
      } catch (e) {
        console.error('[useAppSettings] Failed to save logoCacheTtlDays:', e);
      }
    }
  }, []);

  const setLogoCachePrefetch = useCallback(async (enabled: boolean) => {
    setLogoCachePrefetchState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ logoCachePrefetch: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save logoCachePrefetch:', e);
      }
    }
  }, []);

  const setEpgMetadataBadgeFpsSuffix = useCallback(async (enabled: boolean) => {
    setEpgMetadataBadgeFpsSuffixState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ epgMetadataBadgeFpsSuffix: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save epgMetadataBadgeFpsSuffix:', e);
      }
    }
  }, []);

  const setEpgLogoDisplay = useCallback(async (display: 'square' | 'rectangle') => {
    setEpgLogoDisplayState(display);
    if (display === 'rectangle') {
      document.documentElement.classList.add('epg-rectangle-logos');
    } else {
      document.documentElement.classList.remove('epg-rectangle-logos');
    }
    if (window.storage) {
      try {
        await window.storage.updateSettings({ epgLogoDisplay: display });
      } catch (e) {
        console.error('[useAppSettings] Failed to save epgLogoDisplay:', e);
      }
    }
  }, []);

  const setChannelLogoSize = useCallback((size: number) => {
    setChannelLogoSizeState(size);
    document.documentElement.style.setProperty('--channel-logo-size', `${size}px`);
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ channelLogoSize: size });
    }
  }, []);

  const setChannelLogoRoundEdges = useCallback(async (enabled: boolean) => {
    setChannelLogoRoundEdgesState(enabled);
    if (!enabled) {
      document.documentElement.style.setProperty('--channel-logo-radius', '0px');
      document.documentElement.classList.add('logo-sharp-edges');
    } else {
      document.documentElement.style.removeProperty('--channel-logo-radius');
      document.documentElement.classList.remove('logo-sharp-edges');
    }
    if (window.storage) {
      try {
        await window.storage.updateSettings({ channelLogoRoundEdges: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save channelLogoRoundEdges:', e);
      }
    }
  }, []);

  const setChannelLogoPadding = useCallback(async (padding: 'none' | 'padded') => {
    setChannelLogoPaddingState(padding);
    if (padding === 'padded') {
      document.documentElement.classList.add('logo-padded-tiles');
    } else {
      document.documentElement.classList.remove('logo-padded-tiles');
    }
    if (window.storage) {
      try {
        await window.storage.updateSettings({ channelLogoPadding: padding });
      } catch (e) {
        console.error('[useAppSettings] Failed to save channelLogoPadding:', e);
      }
    }
  }, []);

  const setLogoLightBackgroundDetection = useCallback(async (enabled: boolean) => {
    setLogoLightBackgroundDetectionState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ logoLightBackgroundDetection: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save logoLightBackgroundDetection:', e);
      }
    }
  }, []);

  const setLogoSmartTrim = useCallback(async (enabled: boolean) => {
    setLogoSmartTrimState(enabled);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ logoSmartTrim: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save logoSmartTrim:', e);
      }
    }
  }, []);

  const setSourceLogoDisplayOverride = useCallback(async (sourceId: string, display: 'square' | 'rectangle' | 'default') => {
    setSourceLogoDisplayOverridesState((prev) => {
      const next = { ...prev };
      if (display === 'default') {
        delete next[sourceId];
      } else {
        next[sourceId] = display;
      }
      if (window.storage) {
        window.storage.updateSettings({ sourceLogoDisplayOverrides: next }).catch(e => {
          console.error('[useAppSettings] Failed to save sourceLogoDisplayOverrides:', e);
        });
      }
      return next;
    });
  }, []);

  const setGlobalLiveTvUserAgent = useCallback(async (ua: string) => {
    setGlobalLiveTvUserAgentState(ua);
    if (window.storage) {
      try {
        await window.storage.updateSettings({ globalLiveTvUserAgent: ua });
      } catch (e) {
        console.error('[useAppSettings] Failed to save globalLiveTvUserAgent:', e);
      }
    }
  }, []);

  const setSavedCustomThemes = useCallback(async (themes: CustomThemeConfig[]) => {
    setSavedCustomThemesState(themes);
    if (window.storage) {
      window.storage.updateSettings({ savedCustomThemes: themes }).catch((e) => {
        console.error('[useAppSettings] Failed to save savedCustomThemes:', e);
      });
    }
    try {
      const existing = localStorage.getItem('app-settings');
      const parsed = existing ? JSON.parse(existing) : {};
      localStorage.setItem('app-settings', JSON.stringify({ ...parsed, savedCustomThemes: themes }));
    } catch (e) {
      console.warn('[useAppSettings] Failed to save savedCustomThemes to localStorage:', e);
    }
  }, []);

  const setEnableCustomScrollbarWidth = useCallback(async (enabled: boolean) => {
    setEnableCustomScrollbarWidthState(enabled);
    if (enabled) {
      document.documentElement.dataset.customScrollbar = 'true';
      document.documentElement.style.setProperty('--app-scrollbar-width', `${customScrollbarWidth}px`);
    } else {
      delete document.documentElement.dataset.customScrollbar;
      document.documentElement.style.removeProperty('--app-scrollbar-width');
    }
    if (window.storage) {
      try {
        await window.storage.updateSettings({ enableCustomScrollbarWidth: enabled });
      } catch (e) {
        console.error('[useAppSettings] Failed to save enableCustomScrollbarWidth:', e);
      }
    }
  }, [customScrollbarWidth]);

  const setCustomScrollbarWidth = useCallback(async (width: number) => {
    setCustomScrollbarWidthState(width);
    if (enableCustomScrollbarWidth) {
      document.documentElement.dataset.customScrollbar = 'true';
      document.documentElement.style.setProperty('--app-scrollbar-width', `${width}px`);
    }
    if (window.storage) {
      try {
        window.storage.debouncedUpdateSettings({ customScrollbarWidth: width });
      } catch (e) {
        console.error('[useAppSettings] Failed to save customScrollbarWidth:', e);
      }
    }
  }, [enableCustomScrollbarWidth]);

  return {
    language,
    setLanguage,
    savedCustomThemes,
    setSavedCustomThemes,
    appFontFamily,
    appCustomFontBase64,
    appCustomFontFormat,
    appCustomFontName,
    updateAppFont,
    rememberLastChannels,
    reopenLastOnStartup,
    savedLayoutState,
    layoutSettingsLoaded,
    timeshiftEnabled,
    timeshiftCacheBytes,
    liveBufferOffset,
    includeSourceInSearch,
    includeSourceInVodSearch,
    maxSearchResults,
    searchResultsOrder,
    sourceFontSize,
    categorySortOrder,
    includeAllChannelsToPlaylist,
    hideDisabledSources,
    advancedSearchScope,
    advancedSearchSourceIds,
    advancedSearchCategoryIds,
    useAdvancedSearchForRegular,
    searchCustomPlaylists,
    epgView,
    channelInfoOverlayEnabled,
    channelInfoOverlayFontSize,
    channelInfoOverlayLogoSize,
    channelInfoOverlayBoxWidth,
    channelInfoOverlayOpacity,
    channelInfoOverlayHideDescription,
    channelInfoOverlayHideMetaBadge,
    channelInfoOverlayHideLogo,
    channelInfoOverlayHideTimer,
    channelInfoOverlayPosition,
    channelInfoOverlayLogoShape,
    setChannelInfoOverlayLogoShape,
    transparentGuideOnZap,
    popoutStopMain,
    setPopoutStopMain,
    popoutAlwaysOnTop,
    setPopoutAlwaysOnTop,
    popoutHwdecEnabled,
    setPopoutHwdecEnabled,
    popoutMpvParamsEnabled,
    setPopoutMpvParamsEnabled,
    popoutMpvParams,
    setPopoutMpvParams,
    theme,
    customThemeConfig,
    shortcuts,
    categoriesHidden,
    categoriesHiddenTransparent,
    navHiddenTabs,
    epgHiddenButtons,
    overlayAutohideTimer,
    overlayOnClickOnly,
    playerControlDesign,
    setPlayerControlDesign,
    showVolumePercent,
    setShowVolumePercent,
    widgetScale,
    widgetBgOpacity,
    sportsScale,
    sportsBgOpacity,
    setNavHiddenTabs,
    setEpgHiddenButtons,
    setTheme,
    updateCustomThemeConfig,
    setShortcuts,
    setCategoriesHidden,
    setCategoriesHiddenTransparent,
    setOverlayAutohideTimer,
    setOverlayOnClickOnly,
    setAdvancedSearchScope,
    setAdvancedSearchSourceIds,
    setAdvancedSearchCategoryIds,
    setUseAdvancedSearchForRegular,
    setSearchCustomPlaylists,
    setChannelInfoOverlayEnabled,
    setChannelInfoOverlayFontSize,
    setChannelInfoOverlayLogoSize,
    setChannelInfoOverlayBoxWidth,
    setChannelInfoOverlayOpacity,
    setChannelInfoOverlayHideDescription,
    setChannelInfoOverlayHideMetaBadge,
    setChannelInfoOverlayHideLogo,
    setChannelInfoOverlayHideTimer,
    setChannelInfoOverlayPosition,
    setTransparentGuideOnZap,
    setCategorySortOrder: setCategorySortOrderSetting,
    setIncludeAllChannelsToPlaylist: setIncludeAllChannelsToPlaylistSetting,
    setHideDisabledSources: setHideDisabledSourcesSetting,
    setEpgView,
    setWidgetScale,
    setWidgetBgOpacity,
    setSportsScale,
    setSportsBgOpacity,
    startupView,
    setStartupView,
    castEnabled,
    setCastEnabled,
    castRewriteTs,
    setCastRewriteTs,
    externalPlayerPath,
    setExternalPlayerPath,
    externalPlayerArgs,
    setExternalPlayerArgs,
    externalPlayerReuse,
    setExternalPlayerReuse,
    disableThemeBackdropBlur,
    setDisableThemeBackdropBlur,
    oledBlack,
    setOledBlack,
    hardwareAcceleration,
    setHardwareAcceleration,
    epgLazyLoadingEnabled,
    setEpgLazyLoadingEnabled,
    disableEpgTransitions,
    setDisableEpgTransitions,
    epgReduceGpuLayers,
    setEpgReduceGpuLayers,
    epgDisableChannelFade,
    setEpgDisableChannelFade,
    epgPreferEpgLogos,
    setEpgPreferEpgLogos,
    epgLogoDisplay,
    setEpgLogoDisplay,
    channelLogoSize,
    setChannelLogoSize,
    channelLogoRoundEdges,
    setChannelLogoRoundEdges,
    channelLogoPadding,
    setChannelLogoPadding,
    logoSmartTrim,
    setLogoSmartTrim,
    logoLightBackgroundDetection,
    setLogoLightBackgroundDetection,
    sourceLogoDisplayOverrides,
    setSourceLogoDisplayOverride,
    epgMetadataBadgeResolution,
    setEpgMetadataBadgeResolution,
    epgMetadataBadgeFps,
    setEpgMetadataBadgeFps,
    epgMetadataBadgeFpsSuffix,
    setEpgMetadataBadgeFpsSuffix,
    epgMetadataBadgeSound,
    setEpgMetadataBadgeSound,
    logoCacheEnabled,
    setLogoCacheEnabled,
    logoCacheMaxMb,
    setLogoCacheMaxMb,
    logoCacheTtlDays,
    setLogoCacheTtlDays,
    logoCachePrefetch,
    setLogoCachePrefetch,
    globalLiveTvUserAgent,
    setGlobalLiveTvUserAgent,
    catchupStartPadding,
    setCatchupStartPadding,
    catchupEndPadding,
    setCatchupEndPadding,
    catchupContinuePlaying,
    setCatchupContinuePlaying,
    vodAutoPlayNextEpisode,
    setVodAutoPlayNextEpisode,
    vodShowSourceBadge,
    setVodShowSourceBadge,
    failoverGroupShowSource,
    setFailoverGroupShowSource,
    enableCustomScrollbarWidth,
    setEnableCustomScrollbarWidth,
    customScrollbarWidth,
    setCustomScrollbarWidth,
    discordRichPresence,
    setDiscordRichPresence,
    discordHideTitle,
    setDiscordHideTitle,
    discordShowWhenPaused,
    setDiscordShowWhenPaused,
    discordShowWhenBrowsing,
    setDiscordShowWhenBrowsing,
    discordShowPoster,
    setDiscordShowPoster,
    discordShowTimestamp,
    setDiscordShowTimestamp,
  };
}
