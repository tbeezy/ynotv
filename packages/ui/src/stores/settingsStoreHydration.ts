import { useSettingsStore, DEFAULT_SUBTITLE_SETTINGS, DEFAULT_MAX_SEARCH_RESULTS, clampMaxSearchResults } from './settingsStore';
import type { SettingsState } from './settingsStore';
import type { SavedLayoutState } from '../hooks/useLayoutPersistence';
import type { ThemeId } from '../types/app';
import i18n, { isSupportedLocale } from '../i18n';

/* ---------------------------------------------------------------------------
   Shape sanitization for the hydrated settings blob.

   Mirrors the `sanitize` contract in persistToKv.ts: a stored value whose
   shape does not match the schema must be rejected/coerced, never applied as
  -is — a mismatched blob (an old export, a corrupted file, a hand-edited
   localStorage) can otherwise hydrate nonsense into the store (e.g. a theme
   object, a string where a boolean belongs). Only the type-sensitive fields
   are guarded here; the `?? default` fallbacks in the setState below cover
   missing values.
   --------------------------------------------------------------------------- */

// The theme picker's id set is the source of truth; keep a copy here so the
// store layer validates without importing a component (ThemeTab renders THEMES).
const THEME_IDS: ReadonlySet<string> = new Set([
  'dark', 'light', 'midnight', 'forest', 'ocean', 'sunset',
  'glass-ocean', 'glass-neon', 'glass-galaxy', 'glass-autumn', 'glass-berry', 'glass-forest',
  'glass-sunset', 'glass-rose', 'glass-midnight', 'glass-amber', 'glass-mint', 'glass-coral',
  'glass-lavender', 'glass-slate', 'glass-cherry', 'glass-gold', 'glass-miami', 'glass-electric',
  'glass-hotpink', 'glass-lime', 'glass-orange', 'glass-red', 'glass-yellow', 'glass-violet',
  'glass-coral-neon', 'glass-turquoise', 'glass-magenta', 'glass-chartreuse', 'glass-indigo',
  'solid-midnight', 'solid-ocean', 'solid-forest', 'solid-sunset', 'solid-berry', 'solid-rose',
  'solid-amber', 'solid-mint', 'solid-coral', 'solid-lavender', 'solid-slate', 'solid-cherry',
  'solid-gold', 'solid-emerald', 'solid-sapphire', 'solid-ruby', 'solid-amethyst', 'solid-cosmic',
  'solid-tropical', 'solid-aurora', 'solid-tropicana', 'solid-nebula', 'solid-monochrome',
  'solid-neon', 'solid-horizon', 'solid-dragonfruit', 'solid-arctic', 'solid-volcano',
  'solid-zengarden', 'solid-galaxy', 'solid-miami', 'solid-cyberpunk', 'solid-deepocean',
  'solid-blossom', 'solid-northern', 'solid-rainbow', 'solid-copper', 'solid-midnightrose',
  'solid-enchanted',
  'dark-crimson', 'dark-cyan', 'dark-purple', 'dark-emerald', 'dark-orange', 'dark-pink',
  'dark-blue', 'dark-gold', 'dark-lime', 'dark-indigo', 'dark-slate', 'dark-warmgrey',
  'dark-steel', 'custom',
]);

const BOOLEAN_KEYS = new Set([
  'rememberLastChannels', 'reopenLastOnStartup', 'timeshiftEnabled', 'includeSourceInSearch',
  'includeSourceInVodSearch', 'includeAllChannelsToPlaylist', 'hideDisabledSources',
  'useAdvancedSearchForRegular', 'searchCustomPlaylists', 'channelInfoOverlayEnabled',
  'channelInfoOverlayHideDescription', 'channelInfoOverlayHideMetaBadge', 'channelInfoOverlayHideLogo',
  'channelInfoOverlayHideTimer', 'transparentGuideOnZap', 'categoriesHidden', 'categoriesHiddenTransparent',
  'overlayOnClickOnly', 'showVolumePercent', 'popoutStopMain', 'popoutAlwaysOnTop', 'popoutHwdecEnabled',
  'popoutMpvParamsEnabled', 'externalPlayerReuse', 'catchupContinuePlaying', 'vodAutoPlayNextEpisode',
  'vodShowSourceBadge', 'failoverGroupShowSource', 'castEnabled', 'castRewriteTs', 'discordRichPresence',
  'discordHideTitle', 'discordShowWhenPaused', 'discordShowWhenBrowsing', 'discordShowPoster',
  'discordShowTimestamp', 'enableCustomScrollbarWidth', 'hardwareAcceleration', 'disableThemeBackdropBlur',
  'reduceEffectsWhileScrolling', 'oledBlack', 'epgLazyLoadingEnabled', 'disableEpgTransitions', 'epgReduceGpuLayers',
  'epgDisableChannelFade', 'flatChrome', 'epgPreferEpgLogos', 'logoSmartTrim', 'logoLightBackgroundDetection',
  'epgMetadataBadgeResolution', 'epgMetadataBadgeFps', 'epgMetadataBadgeFpsSuffix', 'epgMetadataBadgeSound',
  'logoCacheEnabled', 'logoCachePrefetch', 'epgDarkenCurrent', 'epgHighlightBorderCurrent',
  'epgBoldChannelNames', 'epgBoldTopCategories', 'epgBoldSourceCategories',
  'autoBackupEnabled', 'streamingCatalogsEnabled', 'streamingNuvioCatalogsEnabled',
  'rpdbBackdropsEnabled', 'traktEnabled', 'traktScrobbleEnabled', 'traktSyncEnabled',
  'traktCatalogsBeforeAddon', 'traktNuvioCatalogsBeforeAddon', 'simklEnabled',
  'simklScrobbleEnabled', 'tvCalendarAutoSync', 'showAllChannels', 'showFavorites',
  'showWatchlist', 'showRecentlyViewed', 'collapseSourceCategoriesOnStartup',
  'useEventBasedReconnect', 'stallDetectionEnabled', 'showLoadingScreen',
  'transparentGuideHideHeader', 'allowLanSources', 'v3DefaultMigrated',
] as const);

const NUMBER_KEYS = new Set([
  'timeshiftCacheBytes', 'liveBufferOffset', 'maxSearchResults', 'sourceFontSize',
  'channelInfoOverlayFontSize', 'channelInfoOverlayLogoSize', 'channelInfoOverlayBoxWidth',
  'channelInfoOverlayOpacity', 'overlayAutohideTimer', 'customScrollbarWidth',
  'channelLogoSize', 'epgVisibleHours', 'catchupStartPadding', 'catchupEndPadding',
  'autoBackupIntervalHours', 'autoBackupMaxBackups', 'traktTokenExpiresAt',
  'streamMaxRetries', 'streamWatchdogSeconds', 'channelFontSize', 'categoryFontSize',
  'epgTitleFontSize', 'epgBodyFontSize', 'uiScale', 'transparentGuideHeight',
  'transparentGuideOverlayOpacity', 'transparentGuideSidebarOpacity',
  'stremioBadgeSize', 'nuvioBadgeSize',
]);

/** Coerce type-sensitive stored values; leave everything else untouched. */
function sanitizeSettingData(data: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...data };
  for (const key of BOOLEAN_KEYS) {
    if (typeof out[key] === 'boolean') continue;
    if (out[key] === undefined || out[key] === null) continue;
    out[key] = false; // reject any non-boolean shape (old exports, corrupt files)
  }
  for (const key of NUMBER_KEYS) {
    if (typeof out[key] === 'number' && Number.isFinite(out[key])) continue;
    if (out[key] === undefined || out[key] === null) continue;
    const n = Number(out[key]);
    out[key] = Number.isFinite(n) ? n : undefined; // undefined → the `?? default` below wins
  }
  // Reject any non-valid theme shape (an object, or a string that isn't a
  // known theme id) → the mirror / default below wins.
  if (out.theme !== undefined && (typeof out.theme !== 'string' || !THEME_IDS.has(out.theme))) {
    delete out.theme;
  }
  if (out.language !== undefined && (typeof out.language !== 'string' || !isSupportedLocale(out.language))) {
    delete out.language;
  }
  // Enum-valued string fields — reject anything outside the known ids so a
  // corrupt value can't break the trailer picker.
  if (out.trailerSource !== undefined && out.trailerSource !== 'source' && out.trailerSource !== 'tmdb') {
    delete out.trailerSource;
  }
  if (
    out.trailerPlayerMode !== undefined &&
    out.trailerPlayerMode !== 'embedded' &&
    out.trailerPlayerMode !== 'popout' &&
    out.trailerPlayerMode !== 'external'
  ) {
    delete out.trailerPlayerMode;
  }
  return out;
}

/** True when the stored blob is empty (fresh install) — use the mirror. */
function isEmptyData(data: Record<string, any>): boolean {
  return Object.keys(data).length === 0;
}

/* ---------------------------------------------------------------------------
   Settings store hydration — the ONE boot-time settings load.

   Phase 1 of the settings-store migration: the old useAppSettings hook ran one
   async getSettings() per instance (~20 queued IPC round-trips at startup).
   Now a single load reconciles the shared zustand store, and every consumer
   subscribes to it. First paint is already correct because the store seeds
   synchronously from the localStorage mirror at module load.

   PURE state reconciliation: this module performs NO documentElement writes.
   All settings-driven DOM side effects are applied by the single idempotent
   applier in settingsDomApplier.ts (Phase 3), which reacts to the store
   changes this module makes.
   --------------------------------------------------------------------------- */

let hydrationStarted = false;

/** Kick off the single boot load once (idempotent, race-free). */
export function ensureSettingsHydration(): void {
  if (hydrationStarted) return;
  hydrationStarted = true;
  void hydrateSettingsStore();
}

async function hydrateSettingsStore(): Promise<void> {
  const store = useSettingsStore;

  if (!window.storage) {
    store.setState({ layoutSettingsLoaded: true });
    return;
  }

  try {
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
      console.warn('[settingsHydration] Failed to read from localStorage:', e);
    }

    // An empty stored blob means no settings have ever been written (fresh
    // install) — prefer the localStorage mirror wholesale instead of treating
    // the empty object as authoritative and discarding the seeded defaults.
    if (result.data && !isEmptyData(result.data)) {
      const data = sanitizeSettingData(result.data);

      // v3-default migration — was owned by App's autosync boot block. Latch it
      // here once per install: a missing flag means this install predates v3 as
      // the default, so force v3 and persist the migration so it never re-runs.
      if (!data.v3DefaultMigrated) {
        data.modernUiEnabled = 'v3';
        data.v3DefaultMigrated = true;
        try {
          window.storage.updateSettings({ modernUiEnabled: 'v3', v3DefaultMigrated: true }).catch(() => {});
        } catch (e) {
          console.warn('[settingsHydration] Failed to persist v3-default migration:', e);
        }
      }

      if (data.savedVolume !== undefined) {
        try {
          if (localStorage.getItem('ynotv_volume') === null) {
            localStorage.setItem('ynotv_volume', String(data.savedVolume));
          }
        } catch {}
      }

      store.setState({
        rememberLastChannels: data.rememberLastChannels ?? false,
        reopenLastOnStartup: data.reopenLastOnStartup ?? false,
        timeshiftEnabled: data.timeshiftEnabled ?? true,
        timeshiftCacheBytes: data.timeshiftCacheBytes ?? 268_435_456,
        liveBufferOffset: data.liveBufferOffset ?? 0,
        includeSourceInSearch: data.includeSourceInSearch ?? false,
        includeSourceInVodSearch: data.includeSourceInVodSearch ?? false,
        maxSearchResults: clampMaxSearchResults(data.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS),
        searchResultsOrder: data.searchResultsOrder ?? 'default',
        sourceFontSize: data.sourceFontSize ?? 12,
        stremioBadgeSize: data.stremioBadgeSize ?? 100,
        nuvioBadgeSize: data.nuvioBadgeSize ?? 100,
        // channelFontSize defaults to 14 on v1/v2 designs (matches the old
        // autosync boot default), 12 on v3.
        channelFontSize: data.channelFontSize ?? (data.modernUiEnabled !== undefined && data.modernUiEnabled !== 'v3' ? 14 : 12),
        categoryFontSize: data.categoryFontSize ?? 13,
        epgTitleFontSize: data.epgTitleFontSize ?? 32,
        epgBodyFontSize: data.epgBodyFontSize ?? 16,
        uiScale: data.uiScale ?? 100,
        transparentGuideHeight: data.transparentGuideHeight ?? 40,
        transparentGuideHideHeader: data.transparentGuideHideHeader ?? false,
        transparentGuideOverlayOpacity: data.transparentGuideOverlayOpacity ?? 55,
        transparentGuideSidebarOpacity: data.transparentGuideSidebarOpacity ?? 55,
        allowLanSources: data.allowLanSources ?? false,
        modernUiEnabled: data.modernUiEnabled ?? 'v3',
        v3DefaultMigrated: data.v3DefaultMigrated ?? false,
        categorySortOrder: data.categorySortOrder ?? 'default',
        includeAllChannelsToPlaylist: data.includeAllChannelsToPlaylist ?? false,
        hideDisabledSources: data.hideDisabledSources ?? false,
        advancedSearchScope: data.advancedSearchScope ?? 'both',
        advancedSearchSourceIds: data.advancedSearchSourceIds ?? [],
        advancedSearchCategoryIds: data.advancedSearchCategoryIds ?? [],
        useAdvancedSearchForRegular: data.useAdvancedSearchForRegular ?? false,
        searchCustomPlaylists: data.searchCustomPlaylists ?? false,
        channelInfoOverlayEnabled: data.channelInfoOverlayEnabled ?? false,
        channelInfoOverlayFontSize: data.channelInfoOverlayFontSize ?? 16,
        channelInfoOverlayLogoSize: data.channelInfoOverlayLogoSize ?? 42,
        channelInfoOverlayBoxWidth: data.channelInfoOverlayBoxWidth ?? 380,
        channelInfoOverlayOpacity: data.channelInfoOverlayOpacity ?? 55,
        channelInfoOverlayHideDescription: data.channelInfoOverlayHideDescription ?? false,
        channelInfoOverlayHideMetaBadge: data.channelInfoOverlayHideMetaBadge ?? false,
        channelInfoOverlayHideLogo: data.channelInfoOverlayHideLogo ?? false,
        channelInfoOverlayHideTimer: data.channelInfoOverlayHideTimer ?? false,
        channelInfoOverlayPosition: data.channelInfoOverlayPosition ?? 'left',
        channelInfoOverlayLogoShape: data.channelInfoOverlayLogoShape ?? 'square',
        transparentGuideOnZap: data.transparentGuideOnZap ?? false,
        categoriesHidden: data.categoriesHidden ?? false,
        categoriesHiddenTransparent: data.categoriesHiddenTransparent ?? false,
        overlayAutohideTimer: data.overlayAutohideTimer ?? 3,
        overlayOnClickOnly: data.overlayOnClickOnly ?? false,
        playerControlDesign: data.playerControlDesign ?? 'clean',
        showVolumePercent: data.showVolumePercent ?? false,
        popoutStopMain: data.popoutStopMain ?? true,
        popoutAlwaysOnTop: data.popoutAlwaysOnTop ?? false,
        popoutHwdecEnabled: data.popoutHwdecEnabled ?? true,
        popoutMpvParamsEnabled: data.popoutMpvParamsEnabled ?? false,
        popoutMpvParams: data.popoutMpvParams ?? '',
        externalPlayerPath: data.externalPlayerPath ?? '',
        externalPlayerArgs: data.externalPlayerArgs ?? '',
        externalPlayerReuse: data.externalPlayerReuse ?? false,
        catchupStartPadding: data.catchupStartPadding ?? 0,
        catchupEndPadding: data.catchupEndPadding ?? 0,
        catchupContinuePlaying: data.catchupContinuePlaying ?? false,
        vodAutoPlayNextEpisode: data.vodAutoPlayNextEpisode ?? true,
        vodShowSourceBadge: data.vodShowSourceBadge ?? false,
        failoverGroupShowSource: data.failoverGroupShowSource ?? false,
        navHiddenTabs: data.navHiddenTabs ?? [],
        epgHiddenButtons: data.epgHiddenButtons ?? [],
        shortcuts: data.shortcuts ?? {},
        subtitleSettings: { ...DEFAULT_SUBTITLE_SETTINGS, ...(data.subtitleSettings ?? {}) },
        globalEpgLinks: data.globalEpgLinks ?? [],
        autoBackupEnabled: data.autoBackupEnabled ?? true,
        autoBackupIntervalHours: data.autoBackupIntervalHours ?? 24,
        autoBackupMaxBackups: data.autoBackupMaxBackups ?? 5,
        autoBackupDirectory: typeof data.autoBackupDirectory === 'string' ? data.autoBackupDirectory : '',
        streamingCatalogsEnabled: data.streamingCatalogsEnabled ?? true,
        streamingNuvioCatalogsEnabled: data.streamingNuvioCatalogsEnabled ?? true,
        enabledStreamingServices: data.enabledStreamingServices ?? ['netflix', 'disney', 'hulu', 'prime', 'apple', 'max', 'paramount', 'peacock'],
        trailerSource: data.trailerSource ?? 'source',
        trailerPlayerMode: data.trailerPlayerMode ?? 'embedded',
        tmdbApiKey: typeof data.tmdbApiKey === 'string' ? data.tmdbApiKey : '',
        posterDbApiKey: typeof data.posterDbApiKey === 'string' ? data.posterDbApiKey : '',
        rpdbBackdropsEnabled: data.rpdbBackdropsEnabled ?? false,
        downloadsPath: typeof data.downloadsPath === 'string' ? data.downloadsPath : '',
        movieGenresEnabled: Array.isArray(data.movieGenresEnabled) ? data.movieGenresEnabled : [],
        seriesGenresEnabled: Array.isArray(data.seriesGenresEnabled) ? data.seriesGenresEnabled : [],
        traktEnabled: data.traktEnabled ?? false,
        traktAccessToken: typeof data.traktAccessToken === 'string' ? data.traktAccessToken : null,
        traktRefreshToken: typeof data.traktRefreshToken === 'string' ? data.traktRefreshToken : null,
        traktTokenExpiresAt: typeof data.traktTokenExpiresAt === 'number' ? data.traktTokenExpiresAt : null,
        traktScrobbleEnabled: data.traktScrobbleEnabled ?? false,
        traktSyncEnabled: data.traktSyncEnabled ?? false,
        traktCatalogsEnabled: data.traktCatalogsEnabled && typeof data.traktCatalogsEnabled === 'object'
          ? data.traktCatalogsEnabled
          : (data.traktWatchlistEnabled !== undefined ? { watchlist: data.traktWatchlistEnabled !== false } : {}),
        traktCatalogOrder: Array.isArray(data.traktCatalogOrder) ? data.traktCatalogOrder : [],
        traktCatalogsBeforeAddon: data.traktCatalogsBeforeAddon ?? false,
        traktEnabledLists: Array.isArray(data.traktEnabledLists) ? data.traktEnabledLists : [],
        traktNuvioCatalogsEnabled: data.traktNuvioCatalogsEnabled && typeof data.traktNuvioCatalogsEnabled === 'object' ? data.traktNuvioCatalogsEnabled : {},
        traktNuvioCatalogOrder: Array.isArray(data.traktNuvioCatalogOrder) ? data.traktNuvioCatalogOrder : [],
        traktNuvioCatalogsBeforeAddon: data.traktNuvioCatalogsBeforeAddon ?? false,
        traktNuvioEnabledLists: Array.isArray(data.traktNuvioEnabledLists) ? data.traktNuvioEnabledLists : [],
        simklEnabled: data.simklEnabled ?? false,
        simklAccessToken: typeof data.simklAccessToken === 'string' ? data.simklAccessToken : null,
        simklScrobbleEnabled: data.simklScrobbleEnabled ?? false,
        tvCalendarAutoSync: data.tvCalendarAutoSync ?? true,
        showAllChannels: data.showAllChannels ?? true,
        showFavorites: data.showFavorites ?? true,
        showWatchlist: data.showWatchlist ?? true,
        showRecentlyViewed: data.showRecentlyViewed ?? true,
        favoritesMode: data.favoritesMode === 'perSource' || data.favoritesMode === 'both' || data.favoritesMode === 'global' ? data.favoritesMode : 'global',
        collapseSourceCategoriesOnStartup: data.collapseSourceCategoriesOnStartup ?? false,
        streamMaxRetries: typeof data.streamMaxRetries === 'number' ? data.streamMaxRetries : 20,
        streamWatchdogSeconds: typeof data.streamWatchdogSeconds === 'number' ? data.streamWatchdogSeconds : 10,
        useEventBasedReconnect: data.useEventBasedReconnect ?? false,
        stallDetectionEnabled: data.stallDetectionEnabled ?? true,
        showLoadingScreen: data.showLoadingScreen ?? false,
        channelAudioDelays: data.channelAudioDelays && typeof data.channelAudioDelays === 'object' ? data.channelAudioDelays : {},
        startupView: data.startupView ?? 'none',
        castEnabled: data.castEnabled ?? false,
        castRewriteTs: data.castRewriteTs ?? true,
        discordRichPresence: data.discordRichPresence ?? false,
        discordHideTitle: data.discordHideTitle ?? false,
        discordShowWhenPaused: data.discordShowWhenPaused ?? true,
        discordShowWhenBrowsing: data.discordShowWhenBrowsing ?? true,
        discordShowPoster: data.discordShowPoster ?? true,
        discordShowTimestamp: data.discordShowTimestamp ?? true,
        enableCustomScrollbarWidth: data.enableCustomScrollbarWidth ?? false,
        customScrollbarWidth: data.customScrollbarWidth ?? 12,
        hardwareAcceleration: data.hardwareAcceleration ?? true,
        disableThemeBackdropBlur: data.disableThemeBackdropBlur ?? false,
        reduceEffectsWhileScrolling: data.reduceEffectsWhileScrolling ?? false,
        oledBlack: data.oledBlack ?? false,
        epgLazyLoadingEnabled: data.epgLazyLoadingEnabled ?? false,
        disableEpgTransitions: data.disableEpgTransitions ?? false,
        epgReduceGpuLayers: data.epgReduceGpuLayers ?? false,
        epgDisableChannelFade: data.epgDisableChannelFade ?? false,
        flatChrome: data.flatChrome ?? false,
        epgPreferEpgLogos: data.epgPreferEpgLogos ?? false,
        epgLogoDisplay: data.epgLogoDisplay ?? 'square',
        channelLogoSize: data.channelLogoSize ?? 42,
        channelLogoRoundEdges: data.channelLogoRoundEdges ?? true,
        channelLogoPadding: data.channelLogoPadding ?? 'none',
        logoSmartTrim: data.logoSmartTrim ?? false,
        logoLightBackgroundDetection: data.logoLightBackgroundDetection ?? true,
        sourceLogoDisplayOverrides: data.sourceLogoDisplayOverrides ?? {},
        epgMetadataBadgeResolution: data.epgMetadataBadgeResolution ?? true,
        epgMetadataBadgeFps: data.epgMetadataBadgeFps ?? true,
        epgMetadataBadgeFpsSuffix: data.epgMetadataBadgeFpsSuffix ?? true,
        epgMetadataBadgeSound: data.epgMetadataBadgeSound ?? true,
        logoCacheEnabled: data.logoCacheEnabled ?? false,
        logoCacheMaxMb: data.logoCacheMaxMb ?? 250,
        logoCacheTtlDays: data.logoCacheTtlDays ?? 30,
        logoCachePrefetch: data.logoCachePrefetch ?? false,
        globalLiveTvUserAgent: data.globalLiveTvUserAgent ?? '',
        epgDarkenCurrent: data.epgDarkenCurrent ?? false,
        epgHighlightBorderCurrent: data.epgHighlightBorderCurrent ?? false,
        epgBoldChannelNames: data.epgBoldChannelNames ?? false,
        epgBoldTopCategories: data.epgBoldTopCategories ?? false,
        epgBoldSourceCategories: data.epgBoldSourceCategories ?? false,
      });

      // Load language (i18n) and apply it if it differs from the current runtime locale
      const loadedLanguage = data.language;
      if (typeof loadedLanguage === 'string' && isSupportedLocale(loadedLanguage)) {
        store.setState({ language: loadedLanguage });
        if (i18n.language !== loadedLanguage) {
          i18n.changeLanguage(loadedLanguage);
        }
      }

      // Widget scale / sports overlay / scrollbar / logo / OLED / EPG cosmetic
      // values are set below purely as STATE — the DOM applier (Phase 3)
      // applies them from the store.

      // Use localStorage state if available (more recent), otherwise use Tauri storage
      store.setState({ savedLayoutState: localStorageState || data.savedLayoutState || null });

      // Load active custom theme config FIRST so the theme never applies with
      // an uninitialized config. Tauri storage is authoritative; fall back to
      // the localStorage mirror only when the store has none (e.g. a fresh
      // install where the mirror was the only writer).
      let loadedCustomConfig = data.customThemeConfig;
      if (!loadedCustomConfig) {
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
        store.setState({ customThemeConfig: loadedCustomConfig });
      }

      // Global font settings
      store.setState({
        appFontFamily: data.appFontFamily || 'inter',
        appCustomFontBase64: data.appCustomFontBase64 || '',
        appCustomFontFormat: data.appCustomFontFormat || '',
        appCustomFontName: data.appCustomFontName || '',
      });

      // Custom themes list
      store.setState({ savedCustomThemes: data.savedCustomThemes || [] });

      // Theme — Tauri storage is authoritative; localStorage mirror is the
      // fallback (the mirror is seeded at module load for first paint, so a
      // fresh install without a stored theme resolves to the default below).
      const savedTheme: ThemeId = (data.theme as ThemeId) || (localStorageTheme as ThemeId) || 'dark-cyan';
      store.setState({ theme: savedTheme });

      // Propagate Tauri values to localStorage
      try {
        const existing = localStorage.getItem('app-settings');
        const parsed = existing ? JSON.parse(existing) : {};
        const updated = {
          ...parsed,
          customThemeConfig: data.customThemeConfig || parsed.customThemeConfig,
          savedCustomThemes: data.savedCustomThemes || [],
          appFontFamily: data.appFontFamily || 'inter',
          appCustomFontBase64: data.appCustomFontBase64 || '',
          appCustomFontFormat: data.appCustomFontFormat || '',
          appCustomFontName: data.appCustomFontName || '',
        };
        localStorage.setItem('app-settings', JSON.stringify(updated));
      } catch (e) {}

      // One-time migration: check if timeshiftMigrationCheck is not set
      if (data.timeshiftMigrationCheck !== true) {
        const hasTimeshift = data.timeshiftEnabled === true;
        if (!hasTimeshift) {
          store.setState({ timeshiftEnabled: true, timeshiftCacheBytes: 268_435_456 }); // 256MB
          window.storage
            .updateSettings({
              timeshiftEnabled: true,
              timeshiftCacheBytes: 268_435_456,
              timeshiftMigrationCheck: true,
            })
            .catch((err) => console.warn('[settingsHydration] Failed to run timeshift migration:', err));
        } else {
          window.storage
            .updateSettings({ timeshiftMigrationCheck: true })
            .catch((err) => console.warn('[settingsHydration] Failed to save timeshift migration flag:', err));
        }
      }
    } else if (localStorageState) {
      // Fallback to localStorage if Tauri storage is empty
      store.setState({ savedLayoutState: localStorageState });
      console.log('[settingsHydration] Loaded saved layout state from localStorage:', localStorageState);

      if (localStorageTheme) {
        store.setState({ theme: localStorageTheme as ThemeId });
      }

      try {
        const existing = localStorage.getItem('app-settings');
        if (existing) {
          const parsed = JSON.parse(existing);
          const patch: Partial<SettingsState> = {};
          if (parsed.customThemeConfig) patch.customThemeConfig = parsed.customThemeConfig;
          if (parsed.savedCustomThemes) patch.savedCustomThemes = parsed.savedCustomThemes;
          if (parsed.appFontFamily) patch.appFontFamily = parsed.appFontFamily;
          if (parsed.appCustomFontBase64) patch.appCustomFontBase64 = parsed.appCustomFontBase64;
          if (parsed.appCustomFontFormat) patch.appCustomFontFormat = parsed.appCustomFontFormat;
          if (parsed.appCustomFontName) patch.appCustomFontName = parsed.appCustomFontName;
          store.setState(patch);
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error('[settingsHydration] Failed to load settings:', e);
  }

  store.setState({ layoutSettingsLoaded: true });
}
