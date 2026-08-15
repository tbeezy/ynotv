import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

// Auto-sync check interval: 10 minutes
const AUTO_SYNC_CHECK_INTERVAL_MS = 10 * 60 * 1000;
let hasStartupAutoSyncTriggered = false;
import { invoke } from '@tauri-apps/api/core';
import i18n, { translateNativeError } from './i18n';
import type { StremioStream, StremioStreamPickerMode, StremioMeta, StremioVideo, BadgeSource, StreamAutoPlayMode, StreamAutoPlaySourceScope } from './types/stremio';
import { checkForUpdates, checkForUpdatesSilent } from './services/updater';
import { getCachedSettings } from './services/settings-cache';
import { Settings } from './components/Settings';
import type { SettingsTabId } from './components/settings/SettingsSidebar';
import { useModal } from './components/Modal';

import { NowPlayingBar } from './components/NowPlayingBar';
import { PiPMediaBar } from './components/PiPMediaBar';
import { ChannelInfoOverlay } from './components/ChannelInfoOverlay';
import { FailoverGroupOverlay } from './components/FailoverGroupOverlay';
import { TrackSelectionModal } from './components/TrackSelectionModal';
import { SubtitleControlModal } from './components/SubtitleControlModal';
import { StalkerSubtitleModal } from './components/StalkerSubtitleModal';
import { CategoryStrip } from './components/CategoryStrip';
import { ChannelPanel } from './components/ChannelPanel';
import { MoviesPage } from './components/MoviesPage';
import { SeriesPage } from './components/SeriesPage';
import { DvrDashboard } from './components/DvrDashboard';
import { SportsHub } from './components/sports/SportsHub';
import { TVCalendarPage } from './components/TVCalendarPage';
import { LiveSportsOverlay } from './components/LiveSportsOverlay';
import { RecentChannelsWidget } from './components/RecentChannelsWidget';
import { FavoritesWidget } from './components/FavoritesWidget';
import { WidgetBar } from './components/WidgetBar';
import { BackgroundContextMenu } from './components/BackgroundContextMenu';
import { CustomGroupWidget } from './components/CustomGroupWidget';
import { WhatsNextWidget } from './components/WhatsNextWidget';
import { GroupPickerModal } from './components/GroupPickerModal';
import { HeroWidgetsPanel } from './components/HeroWidgetsPanel';
import { useActiveRecordings } from './hooks/useActiveRecordings';
import { useSearchHistory } from './hooks/useSearchHistory';
import { RecordingIndicator } from './components/RecordingIndicator';
import { DownloadIndicator } from './components/DownloadIndicator';
import { Logo } from './components/Logo';
import { useSelectedCategory, useChannelSearch, useProgramSearch, useChannels, useCurrentProgram, useSourceNameMap, parseCategoryIds } from './hooks/useChannels';
import { useActiveTmdbToken } from './hooks/useTmdbLists';
import { getTmdbImageUrl, searchMovies, searchTvShows, getMovieDetails, getTvShowDetails } from './services/tmdb';
import { cleanTitleForSearch } from './utils/cleanTitle';
import { clearLiveQueryCache } from './hooks/useSqliteLiveQuery';
import {
  useChannelSyncing,
  useVodSyncing,
  useTmdbMatching,
  useSyncStatusMessage,
  useChannelSortOrder,
  useCategorySortOrder,
  useSetChannelSyncing,
  useSetVodSyncing,
  useSetSyncStatusMessage,
  useSetChannelSortOrder,
  useSetChannelSortOrderMigrated,
  useChannelSortOrderMigrated,
  useSetCategorySortOrder,
  useSetEpgView,
  useSetEpgVisibleHours,
  useSetEpgClockFormat,
  useSetEpgShowDate,
  useSetIncludeAllChannelsToPlaylist
} from './stores/uiStore';
import { getAdjacentEpisode, recordVodWatch, recordEpisodeWatch, getEpisodeProgress } from './db';
import { useVodPlaylistStore } from './stores/vodPlaylistStore';
import { useActivePlaylistStore, isActivePlaylistItem } from './stores/activePlaylistStore';
import { PlaylistQueueModal } from './components/vod/PlaylistQueueModal';
import { playlistItemToVodInfo, recordPlaylistItemWatch, snapshotPlaylistProgress } from './utils/playlistPlayback';
import type { StoredChannel } from './db';
import { db } from './db';
import { VideoErrorOverlay } from './components/VideoErrorOverlay';
import { AudioVisualizer, type VisualizerMode } from './components/AudioVisualizer';
import { StreamRetryOverlay } from './components/StreamRetryOverlay';
import { FailoverOverlay } from './components/FailoverOverlay';
import { ChannelLoadingOverlay } from './components/ChannelLoadingOverlay';
import { CastButton } from './components/CastButton';
import { CastOverlay } from './components/CastOverlay';
import { syncSource, syncVodForSource, isEpgStale, isVodStale, syncAllStaleGlobalEpgLinks, fetchVodProviderTmdbId } from './db/sync';
import { bulkOps } from './services/bulk-ops';
import { Bridge, type AspectRatioMode, applyAspectRatio, rewriteTsToM3u8 } from './services/tauri-bridge';
import { resolvePlayUrl } from './services/stream-resolver';
import { currentMonitor, getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { addToRecentChannels } from './utils/recentChannels';
import { WatchlistNotificationContainer } from './components/WatchlistNotification';
import { ToastContainer } from './components/Toast';
import { useToastStore } from './stores/toastStore';
import { MultiviewLayout } from './components/MultiviewLayout/MultiviewLayout';
import { LayoutPicker } from './components/LayoutPicker/LayoutPicker';
import './styles/themes.css';
import './styles/ModernThemeBase.css'; // Modern UI shared base (fonts, keyframes, unscoped rules)
// ModernV2.css / ModernV3.css / light-theme-overrides.css are loaded at runtime by applyUiDesign()
// so each UI design version only downloads the CSS it needs.
import { useTimeshift } from './hooks/useTimeshift';
import { useDvrEvents } from './hooks/useDvrEvents';
import { useDvrUrlResolver } from './hooks/useDvrUrlResolver';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { KeyboardShortcutsModal } from './components/KeyboardShortcutsModal';
import { UpdateModal } from './components/UpdateModal';
import { registerUpdateModal } from './services/updater';
import { WhatsNewModal } from './components/WhatsNewModal/WhatsNewModal';
import { getVersion } from '@tauri-apps/api/app';
import { useLayoutPersistence, type LayoutMode } from './hooks/useLayoutPersistence';
import { useMpvListeners } from './hooks/useMpvListeners';
import { AdvancedSearchModal, type AdvancedSearchConfig } from './components/AdvancedSearchModal';
import { StremioPage } from './components/stremio/StremioPage';
import { NuvioPage } from './components/nuvio/NuvioPage';
import { useStremioAddonStore } from './stores/stremioAddonStore';
import { useStremioWatchStore } from './stores/stremioWatchStore';
import { useStremioAuthStore } from './stores/stremioAuthStore';
import { useNuvioAuthStore } from './stores/nuvioAuthStore';
import { useUIStore } from './stores/uiStore';
import { fetchSubtitles } from './services/stremio-addon';
import { toSubSourceLang, fromSubSourceLang } from './services/subsource';
import { scrobbler } from './services/scrobbler';
import { pushNuvioWatchProgress } from './services/nuvio-api';
import { SkipIntroButton } from './components/SkipIntroButton';
import { useSkipIntro } from './hooks/useSkipIntro';
import { BackButtonOverlay } from './components/BackButtonOverlay';
import { PlaybackDetailsModal } from './components/PlaybackDetailsModal';
import { SourcePickerModal } from './components/SourcePickerModal';
import type { RecommendationItem } from './hooks/useLazyStremioRecommendations';
import { DEFAULT_BADGE_SOURCES, mergeDefaultBadgeSources, compileBadgeSources } from './utils/streamBadges';
import { applyUiDesign, initUiDesign } from './utils/uiDesign';

// Apply the persisted UI design (v1/v2/v3) before first paint — the sync effect
// below re-applies it authoritatively once settings finish loading.
initUiDesign();

// NEW: Extracted hooks
import { useAppSettings } from './hooks/useAppSettings';
import { usePlayback } from './hooks/usePlayback';
import { useNavigation } from './hooks/useNavigation';
import { useWatchlist } from './hooks/useWatchlist';
import { useWindowManager } from './hooks/useWindowManager';
import { usePopoutPlayer } from './hooks/usePopoutPlayer';
import { usePipMode } from './hooks/usePipMode';
import { useDiscordPresence } from './hooks/useDiscordPresence';
import { usePlaybackPresence } from './hooks/usePlaybackPresence';

// ============================================================================
// TransitionView Component
// ============================================================================

interface TransitionViewProps {
  visible: boolean;
  children: React.ReactNode;
}

function TransitionView({ visible, children }: TransitionViewProps) {
  const [shouldRender, setShouldRender] = useState(visible);
  const [animationClass, setAnimationClass] = useState(visible ? 'view-enter-active' : 'view-exit');

  useEffect(() => {
    if (visible) {
      setShouldRender(true);
      const timer = setTimeout(() => {
        setAnimationClass('view-enter-active');
      }, 10);
      return () => clearTimeout(timer);
    } else {
      setAnimationClass('view-exit-active');
      const timer = setTimeout(() => {
        setShouldRender(false);
      }, 220); // Match CSS transition duration
      return () => clearTimeout(timer);
    }
  }, [visible]);

  if (!shouldRender) return null;

  return (
    <div className={`view-transition-container ${animationClass}`}>
      {children}
    </div>
  );
}

// ============================================================================
// App Component
// ============================================================================

function App() {
  const [layoutPickerOpen, setLayoutPickerOpen] = useState(false);
  // ==========================================================================
  // Settings & Configuration (from useAppSettings)
  // ==========================================================================
  const {
    rememberLastChannels,
    reopenLastOnStartup,
    savedLayoutState,
    layoutSettingsLoaded,
    timeshiftEnabled,
    timeshiftCacheBytes,
    liveBufferOffset,
    includeSourceInSearch,
    maxSearchResults,
    searchResultsOrder,
    advancedSearchScope,
    advancedSearchSourceIds,
    advancedSearchCategoryIds,
    useAdvancedSearchForRegular,
    searchCustomPlaylists: searchCustomPlaylistsSetting,
    channelInfoOverlayEnabled,
    channelInfoOverlayFontSize,
    channelInfoOverlayLogoSize,
    channelInfoOverlayBoxWidth,
    channelInfoOverlayOpacity,
    theme,
    customThemeConfig,
    shortcuts,
    categoriesHidden,
    categoriesHiddenTransparent,
    setTheme,
    updateCustomThemeConfig,
    setShortcuts,
    setCategoriesHidden,
    setCategoriesHiddenTransparent,
    setAdvancedSearchScope,
    setAdvancedSearchSourceIds,
    setAdvancedSearchCategoryIds,
    setUseAdvancedSearchForRegular,
    setSearchCustomPlaylists: setSearchCustomPlaylistsSetting,
    setChannelInfoOverlayEnabled,
    setChannelInfoOverlayFontSize,
    setChannelInfoOverlayLogoSize,
    setChannelInfoOverlayBoxWidth,
    setChannelInfoOverlayOpacity,
    channelInfoOverlayHideDescription,
    channelInfoOverlayHideMetaBadge,
    channelInfoOverlayHideLogo,
    channelInfoOverlayHideTimer,
    channelInfoOverlayPosition,
    channelInfoOverlayLogoShape,
    setChannelInfoOverlayHideMetaBadge,
    setChannelInfoOverlayHideLogo,
    setChannelInfoOverlayHideTimer,
    setChannelInfoOverlayPosition,
    setChannelInfoOverlayLogoShape,
    setChannelInfoOverlayHideDescription,
    transparentGuideOnZap,
    setTransparentGuideOnZap,
    overlayAutohideTimer,
    setOverlayAutohideTimer,
    overlayOnClickOnly,
    setOverlayOnClickOnly,
    popoutStopMain,
    popoutAlwaysOnTop,
    setPopoutAlwaysOnTop,
    navHiddenTabs: settingsNavHiddenTabs,
    epgHiddenButtons: settingsEpgHiddenButtons,
    startupView,
    castEnabled,
    setCastEnabled,
    castRewriteTs,
    setCastRewriteTs,
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
    vodAutoPlayNextEpisode,
    setVodAutoPlayNextEpisode,
    vodShowSourceBadge,
    setVodShowSourceBadge,
    failoverGroupShowSource,
    setFailoverGroupShowSource,
    playerControlDesign,
    setPlayerControlDesign,
    showVolumePercent,
    setShowVolumePercent,
    epgMetadataBadgeResolution,
    setEpgMetadataBadgeResolution,
    epgMetadataBadgeFps,
    setEpgMetadataBadgeFps,
    epgMetadataBadgeFpsSuffix,
    setEpgMetadataBadgeFpsSuffix,
    epgMetadataBadgeSound,
    setEpgMetadataBadgeSound,
    language,
    setLanguage,
  } = useAppSettings();
  const navHiddenTabs = useUIStore((s) => s.navHiddenTabs);
  const setNavHiddenStore = useUIStore((s) => s.setNavHiddenTabs);

  const setEpgHiddenStore = useUIStore((s) => s.setEpgHiddenButtons);

  // Stremio stream picker mode
  const [stremioStreamPickerMode, setStremioStreamPickerMode] = useState<StremioStreamPickerMode>('modal');
  const handleStremioStreamPickerModeChange = useCallback(async (mode: StremioStreamPickerMode) => {
    setStremioStreamPickerMode(mode);
    if (window.storage) {
      await window.storage.updateSettings({ stremioStreamPickerMode: mode });
    }
  }, []);

  // Stremio stream badges
  const [showStremioStreamBadges, setShowStremioStreamBadges] = useState(true);
  const handleShowStremioStreamBadgesChange = useCallback(async (show: boolean) => {
    setShowStremioStreamBadges(show);
    if (window.storage) {
      await window.storage.updateSettings({ showStremioStreamBadges: show });
    }
  }, []);

  const [badgeSources, setBadgeSources] = useState<BadgeSource[]>(DEFAULT_BADGE_SOURCES);
  const handleBadgeSourcesChange = useCallback(async (sources: BadgeSource[]) => {
    setBadgeSources(sources);
    if (window.storage) {
      await window.storage.updateSettings({ badgeSources: sources });
    }
  }, []);

  const compiledBadgeRules = useMemo(() => compileBadgeSources(badgeSources), [badgeSources]);

  // Stremio badge size
  const [stremioBadgeSize, setStremioBadgeSize] = useState(100);
  const handleStremioBadgeSizeChange = useCallback(async (size: number) => {
    setStremioBadgeSize(size);
    document.documentElement.style.setProperty('--stremio-badge-scale', String(size / 100));
    if (window.storage) {
      await window.storage.updateSettings({ stremioBadgeSize: size });
    }
  }, []);

  // Stremio hover details
  const [showHoverDetails, setShowHoverDetails] = useState(true);
  const handleShowHoverDetailsChange = useCallback(async (show: boolean) => {
    setShowHoverDetails(show);
    document.documentElement.toggleAttribute('data-hover-details-disabled', !show);
    if (window.storage) {
      await window.storage.updateSettings({ showHoverDetails: show });
    }
  }, []);

  // File size badges and placement
  const [showFileSizeBadges, setShowFileSizeBadges] = useState(true);
  const handleShowFileSizeBadgesChange = useCallback(async (enabled: boolean) => {
    setShowFileSizeBadges(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ showFileSizeBadges: enabled });
    }
  }, []);

  const [streamBadgePlacement, setStreamBadgePlacement] = useState<'top' | 'bottom'>('bottom');
  const handleStreamBadgePlacementChange = useCallback(async (placement: 'top' | 'bottom') => {
    setStreamBadgePlacement(placement);
    if (window.storage) {
      await window.storage.updateSettings({ streamBadgePlacement: placement });
    }
  }, []);

  // Nuvio independent badges configuration
  const [showNuvioStreamBadges, setShowNuvioStreamBadges] = useState(true);
  const handleShowNuvioStreamBadgesChange = useCallback(async (enabled: boolean) => {
    setShowNuvioStreamBadges(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ showNuvioStreamBadges: enabled });
    }
  }, []);

  const [nuvioBadgeSources, setNuvioBadgeSources] = useState<BadgeSource[]>(DEFAULT_BADGE_SOURCES);
  const handleNuvioBadgeSourcesChange = useCallback(async (sources: BadgeSource[]) => {
    setNuvioBadgeSources(sources);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioBadgeSources: sources });
    }
  }, []);

  const compiledNuvioBadgeRules = useMemo(() => compileBadgeSources(nuvioBadgeSources), [nuvioBadgeSources]);

  const [nuvioBadgeSize, setNuvioBadgeSize] = useState(100);
  const handleNuvioBadgeSizeChange = useCallback(async (size: number) => {
    setNuvioBadgeSize(size);
    document.documentElement.style.setProperty('--nuvio-badge-scale', String(size / 100));
    if (window.storage) {
      await window.storage.updateSettings({ nuvioBadgeSize: size });
    }
  }, []);

  const [nuvioShowFileSizeBadges, setNuvioShowFileSizeBadges] = useState(true);
  const handleNuvioShowFileSizeBadgesChange = useCallback(async (enabled: boolean) => {
    setNuvioShowFileSizeBadges(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioShowFileSizeBadges: enabled });
    }
  }, []);

  const [nuvioStreamBadgePlacement, setNuvioStreamBadgePlacement] = useState<'top' | 'bottom'>('bottom');
  const handleNuvioStreamBadgePlacementChange = useCallback(async (placement: 'top' | 'bottom') => {
    setNuvioStreamBadgePlacement(placement);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioStreamBadgePlacement: placement });
    }
  }, []);

  const [showNuvioHoverDetails, setShowNuvioHoverDetails] = useState(true);
  const handleShowNuvioHoverDetailsChange = useCallback(async (enabled: boolean) => {
    setShowNuvioHoverDetails(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ showNuvioHoverDetails: enabled });
    }
  }, []);

  const [nuvioAutoPlayMode, setNuvioAutoPlayMode] = useState<StreamAutoPlayMode>('manual');
  const handleNuvioAutoPlayModeChange = useCallback(async (mode: StreamAutoPlayMode) => {
    setNuvioAutoPlayMode(mode);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioAutoPlayMode: mode });
    }
  }, []);

  const [nuvioAutoPlayTimeout, setNuvioAutoPlayTimeout] = useState(0);
  const handleNuvioAutoPlayTimeoutChange = useCallback(async (timeout: number) => {
    setNuvioAutoPlayTimeout(timeout);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioAutoPlayTimeout: timeout });
    }
  }, []);

  const [nuvioAutoPlaySourceScope, setNuvioAutoPlaySourceScope] = useState<StreamAutoPlaySourceScope>('all');
  const handleNuvioAutoPlaySourceScopeChange = useCallback(async (scope: StreamAutoPlaySourceScope) => {
    setNuvioAutoPlaySourceScope(scope);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioAutoPlaySourceScope: scope });
    }
  }, []);

  const [nuvioAutoPlayAllowedAddons, setNuvioAutoPlayAllowedAddons] = useState<string[]>([]);
  const handleNuvioAutoPlayAllowedAddonsChange = useCallback(async (addonIds: string[]) => {
    setNuvioAutoPlayAllowedAddons(addonIds);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioAutoPlayAllowedAddons: addonIds });
    }
  }, []);

  const [nuvioAutoPlayAllowedPlugins, setNuvioAutoPlayAllowedPlugins] = useState<string[]>([]);
  const handleNuvioAutoPlayAllowedPluginsChange = useCallback(async (pluginIds: string[]) => {
    setNuvioAutoPlayAllowedPlugins(pluginIds);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioAutoPlayAllowedPlugins: pluginIds });
    }
  }, []);

  const [nuvioAutoPlayRegex, setNuvioAutoPlayRegex] = useState<string>('');
  const handleNuvioAutoPlayRegexChange = useCallback(async (regex: string) => {
    setNuvioAutoPlayRegex(regex);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioAutoPlayRegex: regex });
    }
  }, []);

  const [nuvioCacheFetchResults, setNuvioCacheFetchResults] = useState<boolean>(false);
  const handleNuvioCacheFetchResultsChange = useCallback(async (enabled: boolean) => {
    setNuvioCacheFetchResults(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioCacheFetchResults: enabled });
    }
  }, []);

  const [nuvioCacheFetchTimeout, setNuvioCacheFetchTimeout] = useState<number>(5);
  const handleNuvioCacheFetchTimeoutChange = useCallback(async (timeout: number) => {
    setNuvioCacheFetchTimeout(timeout);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioCacheFetchTimeout: timeout });
    }
  }, []);

  const [stremioCacheFetchResults, setStremioCacheFetchResults] = useState<boolean>(false);
  const handleStremioCacheFetchResultsChange = useCallback(async (enabled: boolean) => {
    setStremioCacheFetchResults(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ stremioCacheFetchResults: enabled });
    }
  }, []);

  const [stremioCacheFetchTimeout, setStremioCacheFetchTimeout] = useState<number>(5);
  const handleStremioCacheFetchTimeoutChange = useCallback(async (timeout: number) => {
    setStremioCacheFetchTimeout(timeout);
    if (window.storage) {
      await window.storage.updateSettings({ stremioCacheFetchTimeout: timeout });
    }
  }, []);

  // Global listener to add/remove 'is-resizing' class to body during window resizing to optimize painting/backdrop filters
  useEffect(() => {
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const handleResize = () => {
      document.body.classList.add('is-resizing');

      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        document.body.classList.remove('is-resizing');
      }, 150);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (resizeTimeout) clearTimeout(resizeTimeout);
    };
  }, []);

  // Load stremioStreamPickerMode from storage
  useEffect(() => {
    if (!layoutSettingsLoaded) return;
    const loadStremioMode = async () => {
      try {
        const res = await getCachedSettings();
        if (res.data?.stremioStreamPickerMode) {
          setStremioStreamPickerMode(res.data.stremioStreamPickerMode as StremioStreamPickerMode);
        }
        if (res.data?.showStremioStreamBadges !== undefined) {
          setShowStremioStreamBadges(res.data.showStremioStreamBadges as boolean);
        }
        setBadgeSources(mergeDefaultBadgeSources(res.data?.badgeSources as BadgeSource[] | undefined));
        if (res.data?.stremioBadgeSize !== undefined) {
          const size = res.data.stremioBadgeSize as number;
          setStremioBadgeSize(size);
          document.documentElement.style.setProperty('--stremio-badge-scale', String(size / 100));
        } else {
          document.documentElement.style.setProperty('--stremio-badge-scale', '1');
        }
        if (res.data?.showHoverDetails !== undefined) {
          setShowHoverDetails(res.data.showHoverDetails as boolean);
          document.documentElement.toggleAttribute('data-hover-details-disabled', !res.data.showHoverDetails);
        }
        if (res.data?.showFileSizeBadges !== undefined) {
          setShowFileSizeBadges(res.data.showFileSizeBadges as boolean);
        }
        if (res.data?.streamBadgePlacement) {
          setStreamBadgePlacement(res.data.streamBadgePlacement as 'top' | 'bottom');
        }
        if (res.data?.showNuvioStreamBadges !== undefined) {
          setShowNuvioStreamBadges(res.data.showNuvioStreamBadges as boolean);
        }
        if (res.data?.nuvioBadgeSources !== undefined) {
          setNuvioBadgeSources(mergeDefaultBadgeSources(res.data.nuvioBadgeSources as BadgeSource[] | undefined));
        }
        if (res.data?.nuvioBadgeSize !== undefined) {
          const size = res.data.nuvioBadgeSize as number;
          setNuvioBadgeSize(size);
          document.documentElement.style.setProperty('--nuvio-badge-scale', String(size / 100));
        } else {
          document.documentElement.style.setProperty('--nuvio-badge-scale', '1');
        }
        if (res.data?.nuvioShowFileSizeBadges !== undefined) {
          setNuvioShowFileSizeBadges(res.data.nuvioShowFileSizeBadges as boolean);
        }
        if (res.data?.nuvioStreamBadgePlacement) {
          setNuvioStreamBadgePlacement(res.data.nuvioStreamBadgePlacement as 'top' | 'bottom');
        }
        if (res.data?.showNuvioHoverDetails !== undefined) {
          setShowNuvioHoverDetails(res.data.showNuvioHoverDetails as boolean);
        }
        if (res.data?.nuvioAutoPlayMode) {
          setNuvioAutoPlayMode(res.data.nuvioAutoPlayMode as StreamAutoPlayMode);
        }
        if (res.data?.nuvioAutoPlayTimeout !== undefined) {
          setNuvioAutoPlayTimeout(res.data.nuvioAutoPlayTimeout as number);
        }
        if (res.data?.nuvioAutoPlaySourceScope) {
          setNuvioAutoPlaySourceScope(res.data.nuvioAutoPlaySourceScope as StreamAutoPlaySourceScope);
        }
        if (res.data?.nuvioAutoPlayAllowedAddons !== undefined) {
          setNuvioAutoPlayAllowedAddons(res.data.nuvioAutoPlayAllowedAddons as string[]);
        }
        if (res.data?.nuvioAutoPlayAllowedPlugins !== undefined) {
          setNuvioAutoPlayAllowedPlugins(res.data.nuvioAutoPlayAllowedPlugins as string[]);
        }
        if (res.data?.nuvioAutoPlayRegex !== undefined) {
          setNuvioAutoPlayRegex(res.data.nuvioAutoPlayRegex as string);
        }
        if (res.data?.nuvioCacheFetchResults !== undefined) {
          setNuvioCacheFetchResults(res.data.nuvioCacheFetchResults as boolean);
        }
        if (res.data?.nuvioCacheFetchTimeout !== undefined) {
          setNuvioCacheFetchTimeout(res.data.nuvioCacheFetchTimeout as number);
        }
        if (res.data?.stremioCacheFetchResults !== undefined) {
          setStremioCacheFetchResults(res.data.stremioCacheFetchResults as boolean);
        }
        if (res.data?.stremioCacheFetchTimeout !== undefined) {
          setStremioCacheFetchTimeout(res.data.stremioCacheFetchTimeout as number);
        }
        if (res.data?.popoutMode) {
          setPopoutMode(res.data.popoutMode as 'off' | 'popout' | 'external');
        }
        if (res.data?.vodPlayerMode) {
          setVodPlayerModeState(res.data.vodPlayerMode as 'embedded' | 'popout' | 'external');
        }
      } catch {}
      finally {
        isPopoutModeLoadedRef.current = true;
      }
    };
    loadStremioMode();
  }, [layoutSettingsLoaded]);

  // ==========================================================================
  // Clear Live Query Cache on App Start
  // ==========================================================================
  useEffect(() => {
    // Clear any stale cached data from previous sessions
    clearLiveQueryCache();
    console.log('[App] Live query cache cleared on startup');
  }, []);

  // Apply channel info overlay CSS variables on mount
  useEffect(() => {
    document.documentElement.style.setProperty('--cio-font-size', `${channelInfoOverlayFontSize}px`);
    document.documentElement.style.setProperty('--cio-logo-size', `${channelInfoOverlayLogoSize}px`);
    document.documentElement.style.setProperty('--cio-box-width', `${channelInfoOverlayBoxWidth}px`);
    document.documentElement.style.setProperty('--cio-bg-opacity', `${channelInfoOverlayOpacity / 100}`);
  }, [channelInfoOverlayFontSize, channelInfoOverlayLogoSize, channelInfoOverlayBoxWidth, channelInfoOverlayOpacity]);

  // ==========================================================================
  // MPV Listeners (must be before useLayoutPersistence for mpvReady)
  // ==========================================================================
  // Carries mpv's end-file event (with reason) into React state so the series
  // auto-play effect can trigger on a genuine EOF instead of a playing->paused
  // transition (which also happens on user pause). The position/duration are
  // snapshotted at end-of-file time on the Rust side, because mpv resets
  // time-pos to 0 after unloading an ended file.
  const [vodEndFileSignal, setVodEndFileSignal] = useState<{
    reason?: string;
    ts: number;
    positionAtEnd: number;
    durationAtEnd: number;
  } | null>(null);
  const mpv = useMpvListeners({
    timeshiftEnabled,
    timeshiftCacheBytes,
    settingsLoaded: layoutSettingsLoaded,
    onEndFile: (payload) => setVodEndFileSignal({
      reason: payload.reason,
      ts: Date.now(),
      positionAtEnd: payload.position ?? 0,
      durationAtEnd: payload.duration ?? 0,
    }),
  });

  const {
    mpvReady,
    playing,
    volume,
    muted,
    position,
    duration,
    error,
    isAudioOnly,
    volumeDraggingRef,
    seekingRef,
    setError,
    setPlaying,
    setPosition,
    setVolume,
    setDuration,
    setMuted,
  } = mpv;

  const [audioVisualizerMode, setAudioVisualizerMode] = useState<VisualizerMode>(() => {
    try {
      return (localStorage.getItem('ynotv_audio_visualizer_mode') as VisualizerMode) || 'spectrum';
    } catch {
      return 'spectrum';
    }
  });

  const handleSetAudioVisualizerMode = useCallback((mode: VisualizerMode) => {
    setAudioVisualizerMode(mode);
    try {
      localStorage.setItem('ynotv_audio_visualizer_mode', mode);
    } catch {}
  }, []);

  const positionRef = useRef(position);
  const durationRef = useRef(duration);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => { durationRef.current = duration; }, [duration]);

  // ==========================================================================
  // Multiview / Layout Persistence (needs mpvReady from useMpvListeners)
  // ==========================================================================
  const multiview = useLayoutPersistence({
    enabled: rememberLastChannels,
    reopenLastOnStartup,
    initialSavedState: savedLayoutState,
    settingsLoaded: layoutSettingsLoaded,
    mpvReady: mpvReady,
    onLoadMainChannel: (channelName, channelUrl, sourceName) => {
      // Update currentChannel when swap or restore happens - need to find the channel in db
      // This is async so we can't block, but we should update the UI
      if (channelUrl) {
        db.channels.where('direct_url').equals(channelUrl).first().then(channel => {
          if (channel) {
            setCurrentChannel(channel);
            // Also load the stream in MPV (for restore and swap scenarios)
            // Use the ref to avoid stale closure issues
            handlePlayChannelRef.current?.(channel, true); // true = autoSwitched (don't add to recent)
          } else {
            // Channel not found in db, create a minimal channel object
            const minimalChannel: StoredChannel = {
              stream_id: `swap_${Date.now()}`,
              name: channelName || 'Unknown',
              stream_icon: '',
              epg_channel_id: '',
              category_ids: [],
              direct_url: channelUrl,
              source_id: sourceName || 'unknown',
            };
            setCurrentChannel(minimalChannel);
            handlePlayChannelRef.current?.(minimalChannel, true);
          }
        });
      }
    },
  });

  const {
    layout: multiviewLayout,
    slots: multiviewSlots,
    switchLayout: rawSwitchLayout,
    sendToSlot,
    swapWithMain,
    stopSlot,
    reloadSlot,
    setSlotProperty,
    repositionSecondarySlots,
    enterTabMode,
    exitTabMode,
    notifyMainLoaded,
    syncMpvGeometry,
    isRestoring,
    engineMode: multiviewEngineMode,
    setEngineMode: setMultiviewEngineMode,
  } = multiview;

  // Refs for multiview (used by keyboard shortcuts)
  const multiviewLayoutRef = useRef<LayoutMode>('main');
  const handlePlayChannelRef = useRef<((channel: StoredChannel, autoSwitched?: boolean) => void) | null>(null);
  const lastPlayedChannelRef = useRef<StoredChannel | null>(null);
  useEffect(() => { multiviewLayoutRef.current = multiviewLayout; }, [multiviewLayout]);

  // ==========================================================================
  // Playback (needs callbacks from useLayoutPersistence)
  // ==========================================================================
  const playback = usePlayback({
    rememberLastChannels,
    reopenLastOnStartup,
    savedLayoutState,
    mpvReadyState: mpvReady,
    syncMpvGeometry,
    notifyMainLoaded,
    mpvListeners: mpv, // Pass shared MPV listeners to avoid duplicate state
  });

  const {
    currentChannel,
    vodInfo,
    vodLoadingInfo,
    loadingState,
    catchupInfo,
    isCatchup,
    retryState,
    failoverState,
    setCurrentChannel,
    handlePlayChannel,
    handlePlayCatchup,
    handleCatchupSeek,
    handlePlayVod,
    handlePlayRecording,
    handleStop: handleStopRaw,
    handleSeek,
    handleTogglePlay,
    handleVolumeChange,
    handleToggleMute,
    handleCycleSubtitle,
    handleCycleAudio,
    handleToggleStats,
    handleToggleFullscreen,
    autoSelectSubtitle,
    userPausedRef,
  } = playback;

  // Keep handlePlayChannel ref updated for onLoadMainChannel callback
  useEffect(() => {
    handlePlayChannelRef.current = handlePlayChannel;
  }, [handlePlayChannel]);

  // Track last played channel for replay shortcut
  useEffect(() => {
    if (currentChannel) {
      lastPlayedChannelRef.current = currentChannel;
    }
  }, [currentChannel]);

  // ==========================================================================
  // Popout Player
  // ==========================================================================
  const popout = usePopoutPlayer();
  const {
    isOpen: popoutIsOpen,
    swapChannel: popoutSwapChannel,
    swapVod: popoutSwapVod,
    closePopout,
    togglePause: popoutTogglePause,
    stopPlayback: popoutStopPlayback,
    toggleFullscreen: popoutToggleFullscreen,
    setPopoutVolume,
    setPopoutMuted,
    seekPopout,
  } = popout;

  const handleTogglePopoutAlwaysOnTop = useCallback(async () => {
    const nextVal = !popoutAlwaysOnTop;
    setPopoutAlwaysOnTop(nextVal);
    try {
      await Bridge.popoutSetAlwaysOnTop(nextVal);
    } catch (e) {
      console.error('[Popout] Failed to toggle always-on-top:', e);
    }
  }, [popoutAlwaysOnTop, setPopoutAlwaysOnTop]);

  const [showPopoutControls, setShowPopoutControls] = useState(true);
  const popoutControlsHoveredRef = useRef(false);
  const [popoutLastActivity, setPopoutLastActivity] = useState(Date.now());

  // Auto-hide popout controls after inactivity (2 seconds)
  useEffect(() => {
    if (!popoutIsOpen) return;

    const timer = setTimeout(() => {
      if (!popoutControlsHoveredRef.current) {
        setShowPopoutControls(false);
      }
    }, 2000);

    return () => clearTimeout(timer);
  }, [popoutLastActivity, popoutIsOpen]);

  // Show controls when popout player is opened
  useEffect(() => {
    if (popoutIsOpen) {
      setShowPopoutControls(true);
      setPopoutLastActivity(Date.now());
    }
  }, [popoutIsOpen]);

  const [popoutPosition, setPopoutPosition] = useState<{ x: number; y: number } | null>(null);
  const isDraggingPopoutRef = useRef(false);
  const dragStartOffsetRef = useRef({ x: 0, y: 0 });

  // Reset popout control bar position when it closes
  useEffect(() => {
    if (!popoutIsOpen) {
      setPopoutPosition(null);
    }
  }, [popoutIsOpen]);

  const handlePopoutDragStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // Only left click

    // Don't drag if clicking interactive elements (buttons, inputs, sliders, svgs)
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('input') || target.closest('svg')) {
      return;
    }

    e.preventDefault();
    isDraggingPopoutRef.current = true;

    const bar = e.currentTarget;
    const rect = bar.getBoundingClientRect();

    dragStartOffsetRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };

    const handleMouseMoveDrag = (moveEvent: MouseEvent) => {
      if (!isDraggingPopoutRef.current) return;

      let newX = moveEvent.clientX - dragStartOffsetRef.current.x;
      let newY = moveEvent.clientY - dragStartOffsetRef.current.y;

      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;

      // Clamp to screen bounds with a 10px margin
      if (newX < 10) newX = 10;
      if (newX > windowWidth - rect.width - 10) newX = windowWidth - rect.width - 10;

      if (newY < 10) newY = 10;
      if (newY > windowHeight - rect.height - 10) newY = windowHeight - rect.height - 10;

      setPopoutPosition({ x: newX, y: newY });
    };

    const handleMouseUpDrag = () => {
      isDraggingPopoutRef.current = false;
      document.removeEventListener('mousemove', handleMouseMoveDrag);
      document.removeEventListener('mouseup', handleMouseUpDrag);
    };

    document.addEventListener('mousemove', handleMouseMoveDrag);
    document.addEventListener('mouseup', handleMouseUpDrag);
  }, []);

  // Popout mode state: 'off' | 'popout' | 'external'
  const [popoutMode, setPopoutMode] = useState<'off' | 'popout' | 'external'>('off');
  const popoutModeRef = useRef(popoutMode);
  useEffect(() => {
    popoutModeRef.current = popoutMode;
  }, [popoutMode]);

  // Dedicated VOD player mode state: 'embedded' | 'popout' | 'external'
  const [vodPlayerMode, setVodPlayerModeState] = useState<'embedded' | 'popout' | 'external'>('embedded');
  const vodPlayerModeRef = useRef(vodPlayerMode);
  useEffect(() => {
    vodPlayerModeRef.current = vodPlayerMode;
  }, [vodPlayerMode]);

  const setVodPlayerMode = useCallback((mode: 'embedded' | 'popout' | 'external') => {
    setVodPlayerModeState(mode);
    if (window.storage) {
      window.storage.updateSettings({ vodPlayerMode: mode }).catch(console.error);
    }
  }, []);

  // Playback source view state to know where to go back when stopped
  const [playbackSourceView, setPlaybackSourceView] = useState<'movies' | 'series' | 'dvr' | 'stremio' | 'nuvio' | null>(null);
  const [showPlaybackDetailsModal, setShowPlaybackDetailsModal] = useState(false);
  const [sourcePickerParams, setSourcePickerParams] = useState<{
    source: 'stremio' | 'nuvio';
    type: string;
    id: string;
    meta: StremioMeta;
    video?: StremioVideo;
  } | null>(null);
  const [activeStremioMeta, setActiveStremioMeta] = useState<StremioMeta | null>(null);
  const [activeStremioEpisode, setActiveStremioEpisode] = useState<StremioVideo | null>(null);
  const isPopoutModeLoadedRef = useRef(false);

  const cyclePopoutMode = useCallback(() => {
    setPopoutMode(prev => {
      if (prev === 'off') return 'popout';
      if (prev === 'popout') return 'external';
      return 'off';
    });
  }, []);

  // Persist popoutMode to settings whenever it changes
  useEffect(() => {
    if (!isPopoutModeLoadedRef.current) return;
    if (window.storage) {
      window.storage.updateSettings({ popoutMode }).catch(console.error);
    }
  }, [popoutMode]);

  // ==========================================================================
  // Google Cast (Chromecast) Integration
  // ==========================================================================
  const [isCasting, setIsCasting] = useState(false);
  const [castDeviceName, setCastDeviceName] = useState('');
  const [castMetadataState, setCastMetadataState] = useState({ title: '', subtitle: '' });

  // Stable refs so the cast-status listener never needs to re-register when channel/playing change.
  // Without this, the listener effect re-runs on every channel switch, re-creating the listener with
  // previouslyCasting=false which incorrectly re-triggers castCurrentMedia.
  const _castCurrentChannelRef = useRef(currentChannel);
  const _castPlayingRef = useRef(playing);
  const _castVodInfoRef = useRef(vodInfo);
  const _castCatchupInfoRef = useRef(catchupInfo);
  useEffect(() => { _castCurrentChannelRef.current = currentChannel; }, [currentChannel]);
  useEffect(() => { _castPlayingRef.current = playing; }, [playing]);
  useEffect(() => { _castVodInfoRef.current = vodInfo; }, [vodInfo]);
  useEffect(() => { _castCatchupInfoRef.current = catchupInfo; }, [catchupInfo]);

  // Guard: prevents two concurrent cast_load_media invocations
  const _castLoadingRef = useRef(false);

  const castCurrentMedia = useCallback(async () => {
    // Read all live values from refs — callback is intentionally stable (empty deps).
    const channel = _castCurrentChannelRef.current;
    const catchup = _castCatchupInfoRef.current;
    const vod = _castVodInfoRef.current;

    if (!channel) return;

    // Fast-fail if already in progress (secondary guard; the primary is in Bridge.loadVideo).
    if (_castLoadingRef.current) {
      console.log('[Cast] castCurrentMedia already in progress, skipping duplicate call');
      return;
    }

    const isRecording = channel.stream_id?.startsWith('recording_');
    const isLocalFile = channel.direct_url?.startsWith('file://') || (!channel.direct_url?.startsWith('http://') && !channel.direct_url?.startsWith('https://'));

    if (isRecording || isLocalFile) {
      alert(i18n.t('cast:cannotCastLocalFile'));
      return;
    }

    _castLoadingRef.current = true;
    try {
      // Resolve the actual play URL before casting (crucial for Stalker channels)
      let url = '';
      let userAgent: string | undefined;
      try {
        if (catchup) {
          const rawStreamId = channel.stream_id.replace(`${channel.source_id}_`, '');
          const resolved = await resolvePlayUrl(channel.source_id, channel.direct_url, {
            rawStreamId,
            startTimeMs: catchup.startTime,
            durationMinutes: catchup.duration,
          });
          url = resolved.url;
          userAgent = resolved.userAgent;
        } else {
          const resolved = await resolvePlayUrl(channel.source_id, channel.direct_url);
          url = resolved.url;
          userAgent = resolved.userAgent;
        }
      } catch (e) {
        console.error('[Cast] Failed to resolve play URL:', e);
        url = channel.direct_url || '';
      }

      const title = channel.stream_id === 'vod' && vod ? vod.title : channel.name;
      const subtitle = channel.stream_id === 'vod' && vod ? 'VOD' : 'Live TV';

      console.log('[Cast] Casting URL:', url, 'Title:', title);

      // Set metadata BEFORE calling Bridge.loadVideo so Bridge picks up the correct title/subtitle.
      Bridge.setCastMetadata(title, subtitle);

      // Stop local video BEFORE loading to avoid multiple active streams on the provider side
      await Bridge.stopLocalVideo().catch(() => {});

      // Route through Bridge.loadVideo so the castLoadInFlight serialization guard
      // in tauri-bridge.ts coordinates with any concurrent handleLoadStream call,
      // preventing two simultaneous cast_load_media calls that cause INVALID_MEDIA_SESSION_ID.
      const result = await Bridge.loadVideo(url, userAgent);
      if (!result.success) {
        throw new Error(translateNativeError(result.error) || i18n.t('player:failedToCastMedia'));
      }
    } catch (e: any) {
      alert(i18n.t('player:failedToCastMedia') + ': ' + (translateNativeError(e?.message) || e));
    } finally {
      _castLoadingRef.current = false;
    }
  }, []); // intentionally stable — reads all live values through refs

  // Dynamically start/stop discovery based on setting
  useEffect(() => {
    if (castEnabled) {
      invoke('cast_start_discovery').catch((e) => {
        console.error('[Cast] Failed to start discovery:', e);
      });
    } else {
      invoke('cast_stop_discovery').catch((e) => {
        console.error('[Cast] Failed to stop discovery:', e);
      });
      if (Bridge.getIsCasting?.()) {
        Bridge.setIsCasting(false);
        setIsCasting(false);
        invoke('cast_disconnect').catch((e) => {
          console.error('[Cast] Failed to disconnect on disable:', e);
        });
      }
    }
    return () => {
      invoke('cast_stop_discovery').catch(() => {});
    };
  }, [castEnabled]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    import('@tauri-apps/api/event').then(({ listen }) => {
      if (disposed) return;
      listen<any>('cast-status', (event) => {
        const status = event.payload;
        console.log('[Cast] Status event:', status);

        const previouslyCasting = Bridge.getIsCasting ? Bridge.getIsCasting() : false;

        setIsCasting(status.connected);
        setCastDeviceName(status.deviceName);
        if (Bridge.setIsCasting) {
          Bridge.setIsCasting(status.connected);
        }

        if (status.connected) {
          if (!previouslyCasting) {
            console.log('[Cast] Casting started, loading media on Chromecast');
            // Read playing/channel from refs — avoids stale closure.
            // Do NOT call Bridge.stop() here: cast_load_media hasn't returned yet so
            // there is no valid media_session_id yet; cast_pause → INVALID_MEDIA_SESSION_ID.
            // stopLocalVideo() is called inside castCurrentMedia() after load succeeds.
            if (_castPlayingRef.current && _castCurrentChannelRef.current) {
              castCurrentMedia();
            }
          }

          // Feed Cast playback status back into the UI states to enable the seekbar & controls
          if (status.playerState) {
            setPlaying(status.playerState === 'PLAYING' || status.playerState === 'BUFFERING');
          }
          if (status.currentTime !== undefined && !seekingRef.current) {
            setPosition(status.currentTime);
          }
          if (status.duration !== undefined) {
            setDuration(status.duration);
          }
          if (status.volume !== undefined && !volumeDraggingRef.current) {
            setVolume(Math.round(status.volume * 100));
          }
          if (status.muted !== undefined) {
            setMuted(status.muted);
          }
        }

        // Update local metadata states
        if (Bridge.getCastMetadata) {
          setCastMetadataState(Bridge.getCastMetadata());
        }
      }).then((unsub) => {
        if (disposed) {
          unsub();
        } else {
          unlisten = unsub;
        }
      });
    });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []); // intentionally empty — uses refs for all live values

  const handleDisconnectCast = useCallback(async () => {
    try {
      await invoke('cast_disconnect');
    } catch (e) {
      console.error('[Cast] Failed to disconnect:', e);
    }
  }, []);

  // ==========================================================================
  // Navigation State (from useNavigation)
  // ==========================================================================
  const {
    categoryId,
    setCategoryId,
    loading: categoryLoading
  } = useSelectedCategory();

  const nav = useNavigation({
    playing,
    multiviewLayout,
    multiviewExitTabMode: exitTabMode,
    setCategoryId,
    overlayAutohideTimer,
    overlayOnClickOnly,
  });

  const {
    activeView,
    settingsTab,
    editSourceId,
    showSettingsPopup,
    pendingSettingsSubTab,
    setPendingSettingsSubTab,
    categoriesOpen,
    searchQuery,
    debouncedSearchQuery,
    isSearchMode,
    isWatchlistMode,
    showControls,
    controlsHoveredRef,
    titleBarSearchRef,
    activeViewRef,
    categoriesOpenRef,
    setActiveView: rawSetActiveView,
    setSettingsTab,
    setEditSourceId,
    setShowSettingsPopup: rawSetShowSettingsPopup,
    setCategoriesOpen,
    setSearchQuery,
    setIsWatchlistMode,
    setShowControls,
    handleSelectCategory,
    handleMouseMove,
  } = nav;

function formatEpisodeSubtitle(
  seasonNum?: number,
  episodeNum?: number,
  rawInfo?: string,
  seriesTitle?: string
): string {
  const sNum = seasonNum != null ? String(seasonNum).padStart(2, '0') : undefined;
  const eNum = episodeNum != null ? String(episodeNum).padStart(2, '0') : undefined;
  const code = sNum && eNum ? `S${sNum}E${eNum}` : seasonNum != null && episodeNum != null ? `S${seasonNum} E${episodeNum}` : undefined;

  if (!rawInfo) return code || 'Series';

  let text = rawInfo.trim();

  const parts = text.split(/\s*[-·:]\s*/);
  if (parts.length > 1) {
    const filtered = parts.filter((part) => {
      const p = part.trim().toLowerCase();
      if (seriesTitle && p === seriesTitle.trim().toLowerCase()) return false;
      if (/^s\d+e\d+$/i.test(p) || /^s\d+\s*e\d+$/i.test(p)) return false;
      if (/^episode\s+\d+$/i.test(p)) return false;
      return true;
    });
    if (filtered.length > 0) {
      text = filtered.join(' - ');
    }
  }

  const textLower = text.trim().toLowerCase();
  if (episodeNum != null && (textLower === `episode ${episodeNum}` || /^s\d+e\d+$/i.test(textLower))) {
    return code || text;
  }

  return code ? `${code} - ${text}` : text;
}

function cleanEpisodeName(
  rawInfo?: string | null,
  seriesTitle?: string | null,
  episodeNum?: number | null
): string {
  if (!rawInfo) return episodeNum ? `Episode ${episodeNum}` : 'Episode 1';

  let text = rawInfo.trim();

  const parts = text.split(/\s*[-·:]\s*/);
  if (parts.length > 1) {
    const filtered = parts.filter((part) => {
      const p = part.trim().toLowerCase();
      if (seriesTitle && p === seriesTitle.trim().toLowerCase()) return false;
      if (/^s\d+e\d+$/i.test(p) || /^s\d+\s*e\d+$/i.test(p) || /^\d+x\d+$/i.test(p)) return false;
      return true;
    });
    if (filtered.length > 0) {
      text = filtered.join(' - ');
    }
  }

  text = text.replace(/^(s\d+\s*e\d+|\d+x\d+)\s*[\-–—:\·]?\s*/i, '').trim();

  if (seriesTitle && text.toLowerCase().startsWith(seriesTitle.trim().toLowerCase())) {
    text = text.slice(seriesTitle.trim().length).replace(/^[\s\-–—:\·]+/, '').trim();
  }

  if (!text || text.match(/^[\d\s\-–—:]+$/)) {
    return episodeNum ? `Episode ${episodeNum}` : 'Episode 1';
  }

  return text;
}

const tmdbPresencePosterCache = new Map<string, string>();

function useTmdbPresencePoster(
  vodInfo: import('./types/media').VodPlayInfo | null | undefined,
  tmdbToken: string | null
): string | undefined {
  const [resolvedPoster, setResolvedPoster] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!vodInfo || !tmdbToken || !tmdbToken.trim()) {
      setResolvedPoster(undefined);
      return;
    }

    let cancelled = false;
    const token = tmdbToken.trim();

    if (vodInfo.posterUrl && vodInfo.posterUrl.includes('image.tmdb.org')) {
      setResolvedPoster(vodInfo.posterUrl);
      return;
    }

    const rawTmdbId = vodInfo.tmdbId || (vodInfo as any)?.tmdb_id;
    const cacheKey = `${vodInfo.type}_${rawTmdbId || vodInfo.title}_${vodInfo.year || ''}`;

    if (tmdbPresencePosterCache.has(cacheKey)) {
      setResolvedPoster(tmdbPresencePosterCache.get(cacheKey));
      return;
    }

    const resolvePoster = async () => {
      try {
        const yearNum = vodInfo.year ? parseInt(String(vodInfo.year), 10) : undefined;
        let posterPath: string | null = null;

        if (rawTmdbId) {
          try {
            if (vodInfo.type === 'movie') {
              const details = await getMovieDetails(token, Number(rawTmdbId));
              posterPath = details.poster_path;
            } else {
              const details = await getTvShowDetails(token, Number(rawTmdbId));
              posterPath = details.poster_path;
            }
          } catch (err) {
            console.warn('[TMDB Presence] Direct details fetch failed, falling back to search:', err);
          }
        }

        if (!posterPath && vodInfo.title) {
          const query = cleanTitleForSearch(vodInfo.title);
          if (query) {
            if (vodInfo.type === 'movie') {
              const results = await searchMovies(token, query, isNaN(yearNum!) ? undefined : yearNum);
              if (results && results.length > 0 && results[0].poster_path) {
                posterPath = results[0].poster_path;
              }
            } else {
              const results = await searchTvShows(token, query, isNaN(yearNum!) ? undefined : yearNum);
              if (results && results.length > 0 && results[0].poster_path) {
                posterPath = results[0].poster_path;
              }
            }
          }
        }

        if (posterPath && !cancelled) {
          const fullUrl = getTmdbImageUrl(posterPath, 'w500') || undefined;
          if (fullUrl) {
            tmdbPresencePosterCache.set(cacheKey, fullUrl);
            setResolvedPoster(fullUrl);
            return;
          }
        }
      } catch (err) {
        console.warn('[TMDB Presence] Failed to resolve TMDB poster for Discord:', err);
      }

      if (!cancelled) {
        setResolvedPoster(undefined);
      }
    };

    resolvePoster();

    return () => {
      cancelled = true;
    };
  }, [vodInfo?.title, vodInfo?.type, vodInfo?.year, vodInfo?.tmdbId, (vodInfo as any)?.tmdb_id, vodInfo?.posterUrl, tmdbToken]);

  return resolvedPoster;
}

  const currentProgram = useCurrentProgram(
    currentChannel && currentChannel.stream_id !== 'vod' && !currentChannel.stream_id?.startsWith('recording_')
      ? currentChannel.stream_id
      : null
  );

  const activeTmdbToken = useActiveTmdbToken();
  const tmdbPresencePoster = useTmdbPresencePoster(vodInfo, activeTmdbToken);

  // Discord Rich Presence integration
  const playbackPresenceState = useMemo(() => {
    let title: string | null = null;
    let subtitle: string | undefined = undefined;
    let posterUrl: string | undefined = undefined;

    const isVodPlayback = vodInfo != null || currentChannel?.stream_id === 'vod' || currentChannel?.stream_id?.startsWith('recording_');

    if (isVodPlayback && vodInfo) {
      title = vodInfo.title || 'VOD';

      if (vodInfo.type === 'series' || vodInfo.seasonNum != null || vodInfo.episodeInfo) {
        subtitle = formatEpisodeSubtitle(
          vodInfo.seasonNum,
          vodInfo.episodeNum,
          vodInfo.episodeInfo,
          vodInfo.title
        );
      } else if (vodInfo.type === 'movie') {
        subtitle = vodInfo.year ? `Movie · ${vodInfo.year}` : 'Movie';
      } else {
        subtitle = vodInfo.episodeInfo || (vodInfo.year ? String(vodInfo.year) : undefined);
      }

      posterUrl = tmdbPresencePoster || vodInfo.posterUrl || vodInfo.logoUrl || vodInfo.backdropUrl || undefined;
    } else if (currentChannel) {
      const activeProgramTitle = isCatchup && catchupInfo?.programTitle ? catchupInfo.programTitle : currentProgram?.title;

      if (activeProgramTitle) {
        title = activeProgramTitle;
        subtitle = currentChannel.name;
      } else {
        title = currentChannel.name;
        subtitle = 'Live TV';
      }
      // Use default App Icon from Discord Dev Portal for Live TV
      posterUrl = undefined;
    }

    return {
      playing,
      paused: !playing,
      title,
      subtitle,
      posterUrl,
      positionSec: position,
      durationSec: duration,
    };
  }, [currentChannel, currentProgram, isCatchup, catchupInfo, vodInfo, tmdbPresencePoster, playing, position, duration]);

  useDiscordPresence(
    {
      discordRichPresence,
      discordHideTitle,
      discordShowWhenPaused,
      discordShowWhenBrowsing,
      discordShowPoster,
      discordShowTimestamp,
    },
    activeView
  );

  usePlaybackPresence(playbackPresenceState);

  // ==========================================================================
  // PiP (Picture-in-Picture) Mode
  // ==========================================================================
  const [pipAspectRatio, setPipAspectRatio] = useState<AspectRatioMode>(() => {
    try {
      const v = localStorage.getItem('ynotv_pip_aspect_ratio');
      return (v as AspectRatioMode) || 'fit';
    } catch { return 'fit'; }
  });
  const pip = usePipMode(pipAspectRatio);
  const { pipMode, pipControlsVisible, togglePip, showPipControls } = pip;
  const pipFromPreviewRef = useRef<{ categoriesOpen: boolean } | null>(null);

  // Wrapper used by all exit paths (PiPMediaBar, drag overlay, etc.)
  // Reopens the guide + restores category sidebar when PiP was entered from preview.
  const handleTogglePip = useCallback(async () => {
    const wasInPip = pipMode;
    await togglePip();
    if (wasInPip && pipFromPreviewRef.current) {
      const prev = pipFromPreviewRef.current;
      pipFromPreviewRef.current = null;
      setActiveView('guide');
      setCategoriesOpen(prev.categoriesOpen);
    }
  }, [pipMode, togglePip]);

  // Used by the PiP button inside the EPG preview video
  const handlePipFromPreview = useCallback(async () => {
    pipFromPreviewRef.current = { categoriesOpen };
    setActiveView('none');
    setCategoriesOpen(false);
    await togglePip();
  }, [togglePip, categoriesOpen, setCategoriesOpen]);

  const handleMouseMovePip = useCallback(() => {
    handleMouseMove();
    if (pipMode) showPipControls();
    if (popoutIsOpen) {
      setShowPopoutControls(true);
      setPopoutLastActivity(Date.now());
    }
  }, [handleMouseMove, pipMode, showPipControls, popoutIsOpen]);

  const { showConfirm, ModalComponent } = useModal();
  const nuvioHasUnsavedHomeLayout = useUIStore((s) => s.nuvioHasUnsavedHomeLayout);
  const nuvioTabSaveFn = useUIStore((s) => s.nuvioTabSaveFn);

  const setActiveView = useCallback((newView: any) => {
    const nextView = typeof newView === 'function' ? newView(activeView) : newView;
    const isCurrentlyNuvioSettings = (activeView === 'nuvio' && useUIStore.getState().nuvioView === 'settings') || (showSettingsPopup && settingsTab === 'nuvio');
    
    const updateTabMode = (view: any) => {
      if (view === 'guide' || view === 'sports' || view === 'dvr' ||
          view === 'settings' || view === 'movies' || view === 'series' ||
          view === 'calendar' || view === 'stremio' || view === 'nuvio') {
        enterTabMode(view);
      } else {
        exitTabMode();
      }
    };

    if (isCurrentlyNuvioSettings && nuvioHasUnsavedHomeLayout) {
      showConfirm(
        'Unsaved Changes',
        "Changes aren't saved, would you like to save homepage layout?",
        async () => {
          try {
            await nuvioTabSaveFn?.();
            useUIStore.setState({ nuvioHasUnsavedHomeLayout: false });
            updateTabMode(nextView);
            rawSetActiveView(nextView);
          } catch (err) {
            // Error was already alerted inside child component
          }
        },
        () => {
          useUIStore.setState({ nuvioHasUnsavedHomeLayout: false });
          updateTabMode(nextView);
          rawSetActiveView(nextView);
        },
        'Save',
        'Discard Changes'
      );
    } else {
      updateTabMode(nextView);
      rawSetActiveView(nextView);
    }
  }, [activeView, showSettingsPopup, settingsTab, nuvioHasUnsavedHomeLayout, nuvioTabSaveFn, rawSetActiveView, showConfirm, enterTabMode, exitTabMode]);

  // Wrapped switchLayout to toggle EPG visibility when entering HLS or MPV multiview
  // to force the native MPV window geometry to correctly sync with EPG cell bounds.
  const switchLayout = useCallback(async (newLayout: LayoutMode) => {
    const isEpgOpen = activeView === 'guide';
    const isTargetMultiview = newLayout === '2x2' || newLayout === 'bigbottom';

    if (isEpgOpen && isTargetMultiview) {
      setActiveView('none');
      await rawSwitchLayout(newLayout);
      setTimeout(() => {
        setActiveView('guide');
      }, 100);
    } else {
      await rawSwitchLayout(newLayout);
    }
  }, [activeView, rawSwitchLayout, setActiveView]);

  const switchLayoutRef = useRef(switchLayout);
  useEffect(() => { switchLayoutRef.current = switchLayout; }, [switchLayout]);

  // Reposition secondary slots on the Hero page when the layout picker is toggled
  useEffect(() => {
    if (multiviewEngineMode === 'mpv' && multiviewLayout !== 'main') {
      if (layoutPickerOpen) {
        // Push secondary slots off-screen so they don't cover the dropdown menu on the Hero page
        const secondaryIds = [2, 3, 4];
        secondaryIds.forEach(async (slotId) => {
          const { invoke } = await import('@tauri-apps/api/core');
          invoke('multiview_reposition_slot', { slotId, x: -10000, y: -10000, width: 1, height: 1 }).catch(() => {});
        });
      } else {
        // Reposition them back to their layout slots
        repositionSecondarySlots(multiviewLayout);
      }
    }
  }, [layoutPickerOpen, multiviewEngineMode, multiviewLayout, repositionSecondarySlots]);

  const setShowSettingsPopup = useCallback((val: boolean | ((prev: boolean) => boolean)) => {
    const nextVal = typeof val === 'function' ? val(showSettingsPopup) : val;
    const isCurrentlyNuvioSettings = showSettingsPopup && settingsTab === 'nuvio';
    if (isCurrentlyNuvioSettings && !nextVal && nuvioHasUnsavedHomeLayout) {
      showConfirm(
        'Unsaved Changes',
        "Changes aren't saved, would you like to save homepage layout?",
        async () => {
          try {
            await nuvioTabSaveFn?.();
            useUIStore.setState({ nuvioHasUnsavedHomeLayout: false });
            rawSetShowSettingsPopup(nextVal);
          } catch (err) {
            // Error was already alerted inside child component
          }
        },
        () => {
          useUIStore.setState({ nuvioHasUnsavedHomeLayout: false });
          rawSetShowSettingsPopup(nextVal);
        },
        'Save',
        'Discard Changes'
      );
    } else {
      rawSetShowSettingsPopup(nextVal);
    }
  }, [showSettingsPopup, settingsTab, nuvioHasUnsavedHomeLayout, nuvioTabSaveFn, rawSetShowSettingsPopup, showConfirm]);

  const [showShortcutsOverlay, setShowShortcutsOverlay] = useState(false);

  // Wrap handleStop to restore Stremio/Nuvio page if stopped from a media context
  const handleStop = useCallback(async () => {
    const isStremio = vodInfo?.source_id === 'stremio' || vodInfo?.source_id === 'trailer';
    const isNuvio = vodInfo?.source_id === 'nuvio';
    
    // Save final progress before stopping
    if (isStremio || isNuvio) {
      const pos = positionRef.current;
      const dur = durationRef.current;
      if (dur > 0 && pos > 0) {
        const fraction = Math.min(1, pos / dur);
        const watchStore = useStremioWatchStore.getState();
        const epInfo = stremioEpisodeRef.current;
        const movieInfo = stremioMovieRef.current;
        
        if (epInfo) {
          if (!isNuvio) {
            watchStore.updateEpisodeProgress(
              epInfo.metaId,
              epInfo.videoId,
              fraction,
              epInfo.season,
              epInfo.episode,
              epInfo.nextVideoId,
              epInfo.nextSeason,
              epInfo.nextEpisode
            );
          }

          if (isStremio) {
            // Sync to Stremio cloud
            const auth = useStremioAuthStore.getState();
            if (auth.authKey && auth.syncProgress) {
              auth.syncPlaybackProgress(
                epInfo.metaId,
                epInfo.videoId,
                pos,
                dur,
                'series',
                epInfo.name,
                epInfo.poster
              ).catch(() => {});
            }
          } else if (isNuvio) {
            // Sync to Nuvio cloud
            const nuvioAuth = useNuvioAuthStore.getState();
            const nuvioToken = nuvioAuth.token;
            const nuvioProfile = nuvioAuth.activeProfile;
            if (nuvioToken && nuvioProfile) {
              pushNuvioWatchProgress(nuvioToken, nuvioProfile.profile_index, [{
                content_id: epInfo.metaId,
                content_type: 'series',
                video_id: epInfo.videoId,
                season: epInfo.season,
                episode: epInfo.episode,
                position: Math.floor(pos * 1000),
                duration: Math.floor(dur * 1000),
                last_watched: Date.now(),
                progress_key: `${epInfo.metaId}_s${epInfo.season}e${epInfo.episode}`,
              }]).then(() => {
                window.dispatchEvent(new CustomEvent('ynotv:nuvio-sync-required'));
              }).catch((err) => console.error('[NuvioProgress] Failed to sync progress:', err));
            }
          }
        } else if (movieInfo) {
          if (!isNuvio) {
            watchStore.updateMovieProgress(movieInfo.metaId, fraction);
          }

          if (isStremio) {
            // Sync to Stremio cloud
            const auth = useStremioAuthStore.getState();
            if (auth.authKey && auth.syncProgress) {
              auth.syncPlaybackProgress(
                movieInfo.metaId,
                movieInfo.metaId,
                pos,
                dur,
                'movie',
                movieInfo.name,
                movieInfo.poster
              ).catch(() => {});
            }
          } else if (isNuvio) {
            // Sync to Nuvio cloud
            const nuvioAuth = useNuvioAuthStore.getState();
            const nuvioToken = nuvioAuth.token;
            const nuvioProfile = nuvioAuth.activeProfile;
            if (nuvioToken && nuvioProfile) {
              pushNuvioWatchProgress(nuvioToken, nuvioProfile.profile_index, [{
                content_id: movieInfo.metaId,
                content_type: 'movie',
                video_id: movieInfo.metaId,
                season: null,
                episode: null,
                position: Math.floor(pos * 1000),
                duration: Math.floor(dur * 1000),
                last_watched: Date.now(),
                progress_key: `${movieInfo.metaId}`,
              }]).then(() => {
                window.dispatchEvent(new CustomEvent('ynotv:nuvio-sync-required'));
              }).catch((err) => console.error('[NuvioProgress] Failed to sync progress:', err));
            }
          }
        }
      }
    }

    await handleStopRaw();
    setShowPlaybackDetailsModal(false);
    setActiveStremioMeta(null);
    setActiveStremioEpisode(null);
    if (playbackSourceView) {
      setActiveView(playbackSourceView);
      setPlaybackSourceView(null);
    } else if (isStremio) {
      setActiveView('stremio');
    } else if (isNuvio) {
      setActiveView('nuvio');
    }
  }, [vodInfo, handleStopRaw, setActiveView, playbackSourceView]);

  // Built-in "back" navigation triggered by the configured mouse back button
  // (or any key/button the user rebinds `mouseBackNavigation` to). Matching is
  // handled by useKeyboardShortcuts; this callback owns the actual behaviour.
  const handleMouseBackNavigation = useCallback(() => {
    // Let sub-pages handle their internal back navigation
    if (
      activeView === 'movies' ||
      activeView === 'series' ||
      activeView === 'stremio' ||
      activeView === 'nuvio'
    ) {
      return;
    }

    // 1. If settings popup or settings view is active, close it
    if (showSettingsPopup) {
      setShowSettingsPopup(false);
      return;
    }

    // 2. If a video is playing, stop it and return
    if (activeView === 'none' && playbackSourceView) {
      handleStop();
      return;
    }

    // 3. Handle other active views that have onClose / exit logic
    if (
      activeView === 'settings' ||
      activeView === 'dvr' ||
      activeView === 'sports' ||
      activeView === 'calendar'
    ) {
      setActiveView('none');
      return;
    }
  }, [activeView, playbackSourceView, showSettingsPopup, handleStop, setShowSettingsPopup, setActiveView]);

  // Prevent the browser/webview from performing history back/forward when the
  // mouse side buttons are pressed. Actual back navigation is dispatched
  // through the shortcut system (see handleMouseBackNavigation above).
  useEffect(() => {
    const preventDefaultMouseNav = (e: MouseEvent) => {
      // button 3 is back, button 4 is forward
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
      }
    };

    window.addEventListener('mousedown', preventDefaultMouseNav);
    window.addEventListener('mouseup', preventDefaultMouseNav);
    window.addEventListener('click', preventDefaultMouseNav);

    return () => {
      window.removeEventListener('mousedown', preventDefaultMouseNav);
      window.removeEventListener('mouseup', preventDefaultMouseNav);
      window.removeEventListener('click', preventDefaultMouseNav);
    };
  }, []);

  // Control volume up / down with mouse scroll wheel on the hero page
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      // Only active on the hero page (activeView === 'none')
      if (activeView !== 'none') return;

      const target = e.target as HTMLElement | null;
      if (!target) return;

      // 1. Don't intercept scroll if user is typing in text input, textarea, or editable element
      const tagName = target.tagName;
      if (
        tagName === 'INPUT' ||
        tagName === 'TEXTAREA' ||
        tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }

      // 2. Don't intercept scroll inside open modals, context menus, or dropdown popups
      if (
        target.closest(
          '.modal, .modal-backdrop, .settings-modal, .playback-details-modal, .context-menu, .dropdown-menu, .layout-picker-dropdown, .keyboard-shortcuts-modal, .epg-editor-modal, .failover-manager-modal'
        )
      ) {
        return;
      }

      // 3. Don't intercept scroll if an ancestor element is scrollable and has content to scroll vertically
      let el: HTMLElement | null = target;
      while (el && el !== document.body && el !== document.documentElement) {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        const isScrollableStyle = overflowY === 'auto' || overflowY === 'scroll';
        if (isScrollableStyle && el.scrollHeight > el.clientHeight) {
          // Allow normal container scroll
          return;
        }
        el = el.parentElement;
      }

      // Intercept scroll wheel on hero page
      e.preventDefault();

      // e.deltaY < 0 means scroll wheel up (increase volume)
      // e.deltaY > 0 means scroll wheel down (decrease volume)
      const step = e.deltaY < 0 ? 5 : -5;

      setVolume((prevVol) => {
        const newVol = Math.min(100, Math.max(0, prevVol + step));
        if (newVol !== prevVol) {
          Bridge.setVolume(newVol).catch(console.error);
        }
        return newVol;
      });

      // Show volume controls / now playing bar on mouse wheel adjustment
      handleMouseMove();
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      window.removeEventListener('wheel', handleWheel);
    };
  }, [activeView, setVolume, handleMouseMove]);

  // ==========================================================================
  // Aspect Ratio — tracked separately for the hero screen
  // ==========================================================================
  const [heroAspectRatio, setHeroAspectRatio] = useState<AspectRatioMode>('fit');

  const handleSetAspectRatio = useCallback(async (mode: AspectRatioMode) => {
    setHeroAspectRatio(mode);
    if (mpvReady && activeView === 'none') {
      await applyAspectRatio(mode).catch(() => {});
    }
  }, [mpvReady, activeView]);

  // Re-apply aspect ratio when a new video is loaded while on hero screen
  useEffect(() => {
    if (mpvReady && currentChannel && activeView === 'none') {
      applyAspectRatio(heroAspectRatio).catch(() => {});
    }
  }, [currentChannel, mpvReady, heroAspectRatio, activeView]);

  // Switch to fit when leaving hero screen, restore hero ratio when returning
  useEffect(() => {
    if (!mpvReady) return;
    if (activeView === 'none') {
      applyAspectRatio(heroAspectRatio).catch(() => {});
    } else {
      applyAspectRatio('fit').catch(() => {});
    }
  }, [activeView, mpvReady, heroAspectRatio]);

  // ==========================================================================
  // PiP Aspect Ratio (independent from main / hero aspect ratio)
  // ==========================================================================
  // Persist & apply PiP aspect ratio
  const handleSetPipAspectRatio = useCallback(async (mode: AspectRatioMode) => {
    setPipAspectRatio(mode);
    try { localStorage.setItem('ynotv_pip_aspect_ratio', mode); } catch {}
    if (mpvReady && pipMode) {
      await applyAspectRatio(mode).catch(() => {});
    }
  }, [mpvReady, pipMode]);

  // Apply PiP ratio on enter, restore hero ratio on exit
  useEffect(() => {
    if (!mpvReady) return;
    if (pipMode) {
      applyAspectRatio(pipAspectRatio).catch(() => {});
    } else {
      applyAspectRatio(activeView === 'none' ? heroAspectRatio : 'fit').catch(() => {});
    }
  }, [pipMode, mpvReady, pipAspectRatio, heroAspectRatio, activeView]);

  // ==========================================================================
  // Apply Startup View
  // ==========================================================================
  const startupAppliedRef = useRef(false);

  useEffect(() => {
    if (!layoutSettingsLoaded || startupAppliedRef.current) return;
    startupAppliedRef.current = true;

    if (startupView && startupView !== 'none') {
      setActiveView(startupView);
      if (startupView === 'guide') {
        setCategoriesOpen(!categoriesHidden);
      }
    }
  }, [layoutSettingsLoaded, startupView, setActiveView, setCategoriesOpen, categoriesHidden]);

  // Initialize navHiddenTabs and epgHiddenButtons in the shared store once settings are loaded
  const navStoreInitRef = useRef(false);
  useEffect(() => {
    if (!layoutSettingsLoaded || navStoreInitRef.current) return;
    navStoreInitRef.current = true;
    setNavHiddenStore(settingsNavHiddenTabs);
    setEpgHiddenStore(settingsEpgHiddenButtons);
  }, [layoutSettingsLoaded, settingsNavHiddenTabs, settingsEpgHiddenButtons, setNavHiddenStore, setEpgHiddenStore]);

  // ==========================================================================
  // Initialize Stremio addons
  // ==========================================================================
  const initializeStremioAddons = useStremioAddonStore((s) => s.initializeDefaults);
  const initializeStremioSync = useStremioAuthStore((s) => s.syncNow);

  useEffect(() => {
    if (layoutSettingsLoaded) {
      initializeStremioAddons();
      // Defer cloud sync by 3 s so the initial render and DB queries complete first
      setTimeout(() => initializeStremioSync(), 3000);
    }
  }, [layoutSettingsLoaded, initializeStremioAddons, initializeStremioSync]);

  // ==========================================================================
  // Initialize Nuvio sync
  // ==========================================================================
  const initializeNuvioSync = useNuvioAuthStore((s) => s.syncNow);

  useEffect(() => {
    if (layoutSettingsLoaded) {
      // Defer cloud sync by 3 s so the initial render and DB queries complete first
      setTimeout(() => initializeNuvioSync(), 3000);
    }
  }, [layoutSettingsLoaded, initializeNuvioSync]);

  // ==========================================================================
  // Channel Info Overlay
  // ==========================================================================
  // The overlay follows the titlebar/nowplaying bar visibility (showControls).
  // Exception: it flashes briefly on keyboard channel up/down outside guide/sports.
  const [channelChangeFlash, setChannelChangeFlash] = useState(false);
  const channelChangeFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transparentGuideFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [guideTransparent, setGuideTransparent] = useState(false);
  const [isTransparentGuideZapActive, setIsTransparentGuideZapActive] = useState(false);
  const [liveTvDesign, setLiveTvDesign] = useState<'v1' | 'v2' | 'v3'>('v3');
  const [randomScheme, setRandomScheme] = useState<string>('scheme-apple');
  const [previewVideoRect, setPreviewVideoRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  useEffect(() => {
    if (activeView === 'guide' || activeView === 'movies' || activeView === 'series' || activeView === 'dvr' || activeView === 'sports' || activeView === 'stremio' || activeView === 'nuvio' || activeView === 'calendar') {
      const schemes = ['scheme-apple', 'scheme-sunset', 'scheme-aurora', 'scheme-forest'];
      const chosen = schemes[Math.floor(Math.random() * schemes.length)];
      setRandomScheme(chosen);
    } else {
      setPreviewVideoRect(null);
    }
  }, [activeView]);

  // Reset video scale and alignment to fullscreen globally when no preview pane is active
  useEffect(() => {
    if (!previewVideoRect) {
      Bridge.setProperties({
        'video-zoom': 0,
        'video-align-x': 0,
        'video-align-y': 0,
        'video-aspect-override': -1,
        'keepaspect': true,
      }).catch(() => { });
      invoke('mpv_set_geometry', { x: 0, y: 0, width: 0, height: 0 }).catch(() => { });
    }
  }, [previewVideoRect]);

  const triggerChannelChangeFlash = useCallback(() => {
    if (!channelInfoOverlayEnabled) return;
    setChannelChangeFlash(true);
    if (channelChangeFlashTimerRef.current) {
      clearTimeout(channelChangeFlashTimerRef.current);
    }
    channelChangeFlashTimerRef.current = setTimeout(() => {
      setChannelChangeFlash(false);
    }, 4000);
  }, [channelInfoOverlayEnabled]);

  const triggerTransparentGuideZapFlash = useCallback(() => {
    if (!transparentGuideOnZap) return;
    if (transparentGuideFlashTimerRef.current) {
      clearTimeout(transparentGuideFlashTimerRef.current);
    }
    setGuideTransparent(true);
    setActiveView('guide');
    setCategoriesOpen(false); // Categories sidebar doesn't show on zap
    setIsTransparentGuideZapActive(true);
    transparentGuideFlashTimerRef.current = setTimeout(() => {
      setGuideTransparent(false);
      setActiveView('none');
      setCategoriesOpen(false);
      setIsTransparentGuideZapActive(false);
    }, (overlayAutohideTimer + 1) * 1000);
  }, [transparentGuideOnZap, overlayAutohideTimer]);

  const handleToggleTransparentGuide = useCallback(() => {
    setShowControls(true);
    if (activeView === 'guide' && guideTransparent) {
      setActiveView('none');
      setCategoriesOpen(false);
    } else {
      setGuideTransparent(true);
      setActiveView('guide');
      setCategoriesOpen(!categoriesHiddenTransparent);
    }
  }, [activeView, guideTransparent, categoriesHiddenTransparent]);

  const isChannelInfoOverlayVisible = useMemo(() => {
    if (!channelInfoOverlayEnabled || !currentChannel || pipMode) return false;
    const isVod = currentChannel.stream_id === 'vod' || currentChannel.stream_id?.startsWith('recording_');
    if (isVod) return false;
    // Don't show when in LiveTV guide (unless transparent guide is active and triggered by zapping) or Sports views
    if ((activeView === 'guide' && (!guideTransparent || !isTransparentGuideZapActive)) || activeView === 'sports') return false;
    return showControls || channelChangeFlash;
  }, [channelInfoOverlayEnabled, currentChannel, pipMode, showControls, channelChangeFlash, activeView, guideTransparent, isTransparentGuideZapActive]);

  // Failover group overlay visibility: same conditions as NowPlayingBar
  const isFailoverGroupOverlayVisible = useMemo(() => {
    if (!currentChannel) return false;
    const isVod = currentChannel.stream_id === 'vod' || currentChannel.stream_id?.startsWith('recording_');
    if (isVod) return false;
    // Don't show when in LiveTV guide or Sports views
    if (activeView === 'guide' || activeView === 'sports') return false;
    return showControls;
  }, [currentChannel, showControls, activeView]);

  // ==========================================================================
  // Watchlist State (from useWatchlist)
  // ==========================================================================
  const {
    watchlistItems,
    watchlistRefreshTrigger,
    watchlistNotifications,
    setWatchlistNotifications,
    refreshWatchlist,
    handleWatchlistSwitch,
    handleWatchlistDismiss,
  } = useWatchlist({
    onAutoswitch: (channel) => {
      addToRecentChannels(channel);
      handlePlayChannel(channel, true); // true = autoSwitched
    },
  });

  // ==========================================================================
  // Window Manager (from useWindowManager)
  // ==========================================================================
  const { handleMinimize, handleMaximize, handleClose, isMaximized, isFullscreen } = useWindowManager();

  // ==========================================================================
  // Update Modal State
  // ==========================================================================
  const [updateModalOpen, setUpdateModalOpen] = useState(false);

  useEffect(() => {
    registerUpdateModal(setUpdateModalOpen);
  }, []);

  // ==========================================================================
  // What's New Modal State
  // ==========================================================================
  const [whatsNewModalOpen, setWhatsNewModalOpen] = useState(false);
  const [appVersion, setAppVersion] = useState('');

  // ==========================================================================
  // Sports Preview State
  // ==========================================================================
  const [sportsPreviewEnabled, setSportsPreviewEnabled] = useState(true);

  // ==========================================================================
  // Live Sports Overlay Widget State
  // ==========================================================================
  const [sportsOverlayWidget, setSportsOverlayWidget] = useState<'autohide' | 'persistent' | null>(() => {
    const saved = localStorage.getItem('sportsOverlayWidget');
    return saved === 'autohide' || saved === 'persistent' ? saved : null;
  });

  // ==========================================================================
  // Recent Channels Overlay Widget State
  // ==========================================================================
  const [recentOverlayWidget, setRecentOverlayWidget] = useState<'5' | '10' | null>(() => {
    const saved = localStorage.getItem('recentOverlayWidget');
    if (saved === 'true') return '5';
    return (saved === '5' || saved === '10') ? saved : null;
  });

  const [bgContextMenu, setBgContextMenu] = useState<{ x: number; y: number } | null>(null);

  // ==========================================================================
  // Transparent Guide Mode (Z key)
  // ==========================================================================

  // Reset transparent mode when leaving guide view
  useEffect(() => {
    if (activeView !== 'guide') {
      setGuideTransparent(false);
      setIsTransparentGuideZapActive(false);
      // Clear any pending flash timer when leaving guide view
      if (transparentGuideFlashTimerRef.current) {
        clearTimeout(transparentGuideFlashTimerRef.current);
        transparentGuideFlashTimerRef.current = null;
      }
    }
  }, [activeView]);

  const handleAddSportsOverlay = useCallback((mode: 'autohide' | 'persistent') => {
    setSportsOverlayWidget(mode);
    localStorage.setItem('sportsOverlayWidget', mode);
  }, []);

  const handleRemoveSportsOverlay = useCallback(() => {
    setSportsOverlayWidget(null);
    localStorage.removeItem('sportsOverlayWidget');
  }, []);

  const handleAddRecent5Overlay = useCallback(() => {
    setRecentOverlayWidget('5');
    localStorage.setItem('recentOverlayWidget', '5');
  }, []);

  const handleAddRecent10Overlay = useCallback(() => {
    setRecentOverlayWidget('10');
    localStorage.setItem('recentOverlayWidget', '10');
  }, []);

  const handleRemoveRecentOverlay = useCallback(() => {
    setRecentOverlayWidget(null);
    localStorage.removeItem('recentOverlayWidget');
  }, []);

  // ==========================================================================
  // Favorites Overlay Widget State
  // ==========================================================================
  const [favoritesOverlayWidget, setFavoritesOverlayWidget] = useState<boolean>(() => {
    const saved = localStorage.getItem('favoritesOverlayWidget');
    return saved === 'true';
  });

  const handleAddFavoritesOverlay = useCallback(() => {
    setFavoritesOverlayWidget(true);
    localStorage.setItem('favoritesOverlayWidget', 'true');
  }, []);

  const handleRemoveFavoritesOverlay = useCallback(() => {
    setFavoritesOverlayWidget(false);
    localStorage.removeItem('favoritesOverlayWidget');
  }, []);

  // ==========================================================================
  // What's Next Overlay Widget State
  // ==========================================================================
  const [whatsNextOverlayWidget, setWhatsNextOverlayWidget] = useState<boolean>(() => {
    const saved = localStorage.getItem('whatsNextOverlayWidget');
    return saved === 'true';
  });

  const handleAddWhatsNextOverlay = useCallback(() => {
    setWhatsNextOverlayWidget(true);
    localStorage.setItem('whatsNextOverlayWidget', 'true');
  }, []);

  const handleRemoveWhatsNextOverlay = useCallback(() => {
    setWhatsNextOverlayWidget(false);
    localStorage.removeItem('whatsNextOverlayWidget');
  }, []);

  // ==========================================================================
  // Custom Group Overlay Widgets State
  // Stored as a JSON array of group_id strings in localStorage.
  // Multiple groups can be active simultaneously — each renders its own widget.
  // ==========================================================================
  const [customGroupWidgetIds, setCustomGroupWidgetIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('customGroupWidgetIds');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [groupPickerOpen, setGroupPickerOpen] = useState(false);

  const handleAddCustomGroupWidget = useCallback((group: { group_id: string; name: string }) => {
    setCustomGroupWidgetIds((prev) => {
      if (prev.includes(group.group_id)) return prev;
      const next = [...prev, group.group_id];
      localStorage.setItem('customGroupWidgetIds', JSON.stringify(next));
      return next;
    });
  }, []);

  const handleRemoveCustomGroupWidget = useCallback((groupId: string) => {
    setCustomGroupWidgetIds((prev) => {
      const next = prev.filter((id) => id !== groupId);
      if (next.length === 0) {
        localStorage.removeItem('customGroupWidgetIds');
      } else {
        localStorage.setItem('customGroupWidgetIds', JSON.stringify(next));
      }
      return next;
    });
  }, []);

  // ==========================================================================
  // Widget Sorting State
  // ==========================================================================
  const [widgetOrder, setWidgetOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('widgetOrder');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const handleMoveWidget = useCallback((widgetId: string, direction: -1 | 1) => {
    setWidgetOrder((prev) => {
      const activeWidgets: string[] = [];
      if (recentOverlayWidget) activeWidgets.push('recent');
      if (favoritesOverlayWidget) activeWidgets.push('favorites');
      if (whatsNextOverlayWidget) activeWidgets.push('whats-next');
      customGroupWidgetIds.forEach((id) => activeWidgets.push(`custom-${id}`));

      const sortedActive = [...activeWidgets].sort((a, b) => {
        let idxA = prev.indexOf(a);
        let idxB = prev.indexOf(b);
        if (idxA === -1) idxA = 999;
        if (idxB === -1) idxB = 999;
        return idxA - idxB;
      });

      const currentIndex = sortedActive.indexOf(widgetId);
      if (currentIndex === -1) return prev;

      const newIndex = currentIndex + direction;
      if (newIndex < 0 || newIndex >= sortedActive.length) return prev;

      const temp = sortedActive[currentIndex];
      sortedActive[currentIndex] = sortedActive[newIndex];
      sortedActive[newIndex] = temp;

      localStorage.setItem('widgetOrder', JSON.stringify(sortedActive));
      return sortedActive;
    });
  }, [recentOverlayWidget, favoritesOverlayWidget, whatsNextOverlayWidget, customGroupWidgetIds]);

  // ==========================================================================
  // Sync State from Store
  // ==========================================================================
  const channelSyncing = useChannelSyncing();
  const vodSyncing = useVodSyncing();
  const tmdbMatching = useTmdbMatching();
  const syncStatusMessage = useSyncStatusMessage();
  const channelSortOrder = useChannelSortOrder();

  // Setter functions for auto-sync
  const setChannelSyncing = useSetChannelSyncing();
  const setVodSyncing = useSetVodSyncing();
  const setSyncStatusMessage = useSetSyncStatusMessage();
  const setChannelSortOrder = useSetChannelSortOrder();
  const setChannelSortOrderMigrated = useSetChannelSortOrderMigrated();
  const channelSortOrderMigrated = useChannelSortOrderMigrated();
  const setCategorySortOrder = useSetCategorySortOrder();
  const setEpgView = useSetEpgView();
  const setEpgVisibleHours = useSetEpgVisibleHours();
  const setEpgClockFormat = useSetEpgClockFormat();
  const setEpgShowDate = useSetEpgShowDate();
  const setIncludeAllChannelsToPlaylist = useSetIncludeAllChannelsToPlaylist();

  const handleToggleEpgView = useCallback(() => {
    const current = useUIStore.getState().epgView;
    const nextView = current === 'traditional' ? 'alternate' : 'traditional';
    setEpgView(nextView);
    if (window.storage) {
      window.storage.updateSettings({ epgView: nextView }).catch((err: any) => {
        console.error('Failed to save epg view shortcut preference:', err);
      });
    }
  }, [setEpgView]);

  // ==========================================================================
  // TimeShift State
  // ==========================================================================
  const timeshiftState = useTimeshift(timeshiftEnabled);

  // ==========================================================================
  // DVR Events & URL Resolver
  // ==========================================================================
  useDvrEvents();
  useDvrUrlResolver();

  // Skip loading channels until we know which category the user last had selected
  // (categoryLoading=true while getLastCategory() is in-flight). Without this guard,
  // a race exists for LiveTV-startup users: setActiveView('guide') can fire before
  // getLastCategory() resolves → activeView='guide' + categoryId=null clears the
  // skip, triggering a full all-channels table scan (50k+ rows) while the EPG
  // simultaneously issues program queries for every channel — causing the 1.4 GB
  // WebView2 memory spike. Also keeps the skip while on the hero with nothing
  // selected; channels load on-demand once a view or category is chosen.
  const currentChannels = useChannels(categoryId, channelSortOrder, {
    skip: categoryLoading || (activeView === 'none' && categoryId === null),
  });
  const currentChannelsRef = useRef(currentChannels);
  useEffect(() => { currentChannelsRef.current = currentChannels; }, [currentChannels]);

  // ==========================================================================
  // Active Recordings
  // ==========================================================================
  const { recordings: activeRecordings, isRecording: hasActiveRecording } = useActiveRecordings(5000);

  // ==========================================================================
  // Advanced Search State
  // ==========================================================================
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [advancedSearchConfig, setAdvancedSearchConfig] = useState<AdvancedSearchConfig>({
    query: '',
    scope: advancedSearchScope,
    sourceIds: advancedSearchSourceIds,
    categoryIds: advancedSearchCategoryIds,
    useForRegular: useAdvancedSearchForRegular,
  });

  // Force advanced filters for the current search when triggered from the modal,
  // even if "use for regular" is disabled. Cleared when user manually edits the title bar query.
  const [forceAdvancedFilters, setForceAdvancedFilters] = useState(false);

  // Search history for titlebar
  const titlebarSearchHistory = useSearchHistory('titlebar');
  const [showTitlebarHistory, setShowTitlebarHistory] = useState(false);
  const titlebarHistoryRef = useRef<HTMLDivElement | null>(null);

  // Determine active filters for search
  const activeSearchSourceIds = useMemo(() => {
    if (!useAdvancedSearchForRegular && !forceAdvancedFilters) return undefined;
    return advancedSearchConfig.sourceIds.length > 0 ? advancedSearchConfig.sourceIds : undefined;
  }, [useAdvancedSearchForRegular, forceAdvancedFilters, advancedSearchConfig.sourceIds]);

  const activeSearchCategoryIds = useMemo(() => {
    if (!useAdvancedSearchForRegular && !forceAdvancedFilters) return undefined;
    return advancedSearchConfig.categoryIds.length > 0 ? advancedSearchConfig.categoryIds : undefined;
  }, [useAdvancedSearchForRegular, forceAdvancedFilters, advancedSearchConfig.categoryIds]);

  // ==========================================================================
  // Search Results
  // ==========================================================================
  const searchChannels = useChannelSearch(
    debouncedSearchQuery,
    maxSearchResults,
    includeSourceInSearch,
    searchResultsOrder,
    activeSearchSourceIds,
    activeSearchCategoryIds
  );
  const searchPrograms = useProgramSearch(
    debouncedSearchQuery,
    maxSearchResults,
    searchResultsOrder,
    activeSearchSourceIds,
    activeSearchCategoryIds
  );

  // Click outside to close titlebar search history
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (titlebarHistoryRef.current && !titlebarHistoryRef.current.contains(e.target as Node)) {
        setShowTitlebarHistory(false);
      }
    };
    if (showTitlebarHistory) {
      document.addEventListener('mousedown', handleClick);
    }
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showTitlebarHistory]);

  // ==========================================================================
  // Track Selection Modal State
  // ==========================================================================
  const [showSubtitleModal, setShowSubtitleModal] = useState(false);
  const [showAudioModal, setShowAudioModal] = useState(false);
  const [hasAudioDelay, setHasAudioDelay] = useState(false);

  useEffect(() => {
    if (currentChannel && window.storage) {
      window.storage.getSettings().then((result: any) => {
        const delays = result.data?.channelAudioDelays || {};
        const key = `${currentChannel.source_id}_${currentChannel.stream_id}`;
        setHasAudioDelay(Boolean(delays[key]));
      }).catch(() => {
        setHasAudioDelay(false);
      });
    } else {
      setHasAudioDelay(false);
    }
  }, [currentChannel]);

  const handleShowSubtitleModal = useCallback(() => {
    controlsHoveredRef.current = false;
    setShowSubtitleModal(true);
  }, [controlsHoveredRef]);
  const handleShowAudioModal = useCallback(() => {
    controlsHoveredRef.current = false;
    setShowAudioModal(true);
  }, [controlsHoveredRef]);

  // ==========================================================================
  // Popout-aware channel/VOD play wrappers
  // ==========================================================================
  const handlePlayInExternal = useCallback(async (channel: StoredChannel) => {
    try {
      const resolved = await resolvePlayUrl(channel.source_id, channel.direct_url);
      const result = await window.storage?.getSettings();
      let playerPath = result?.data?.externalPlayerPath || '';
      const playerReuse = result?.data?.externalPlayerReuse ?? false;
      const playerArgs = result?.data?.externalPlayerArgs || '';
      if (!playerPath) {
        console.warn('[App] External player path not configured');
        return;
      }
      playerPath = playerPath.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      const url = resolved.url;

      if (playerReuse) {
        await invoke('spawn_external_player_reuse', { playerPath, url });
      } else       if (playerArgs.includes('{url}')) {
        const argsStr = playerArgs.replace(/\{url\}/g, url);
        const args = (argsStr.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((a: string) => a.replace(/^"(.*)"$/, '$1'));
        await invoke('spawn_external_player_with_args', { playerPath, args });
      } else if (playerArgs.trim()) {
        const baseArgs = (playerArgs.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((a: string) => a.replace(/^"(.*)"$/, '$1'));
        const args = [...baseArgs, url];
        await invoke('spawn_external_player_with_args', { playerPath, args });
      } else {
        await invoke('spawn_external_player', { playerPath, url });
      }
      addToRecentChannels(channel);
    } catch (e) {
      console.error('[App] Failed to launch external player:', e);
    }
  }, []);

  const handlePlayChannelWrapper = useCallback(async (channel: StoredChannel, autoSwitched?: boolean) => {
    setPlaybackSourceView(null);
    const currentMode = popoutModeRef.current;
    if (currentMode === 'external') {
      await handlePlayInExternal(channel);
    } else if (currentMode === 'popout') {
      popoutSwapChannel(channel);
    } else {
      handlePlayChannel(channel, autoSwitched);
    }
  }, [handlePlayChannel, popoutSwapChannel, handlePlayInExternal]);

  const handlePlayVodInExternal = useCallback(async (info: import('./types/media').VodPlayInfo) => {
    try {
      const resolved = await resolvePlayUrl(info.source_id, info.url);
      const result = await window.storage?.getSettings();
      let playerPath = result?.data?.externalPlayerPath || '';
      const playerReuse = result?.data?.externalPlayerReuse ?? false;
      const playerArgs = result?.data?.externalPlayerArgs || '';
      if (!playerPath) {
        if (info.url.startsWith('http://') || info.url.startsWith('https://')) {
          window.open(info.url, '_blank');
          return;
        }
        console.warn('[App] External player path not configured');
        return;
      }
      playerPath = playerPath.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      const url = resolved.url;

      if (playerReuse) {
        await invoke('spawn_external_player_reuse', { playerPath, url });
      } else if (playerArgs.includes('{url}')) {
        const argsStr = playerArgs.replace(/\{url\}/g, url);
        const args = (argsStr.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((a: string) => a.replace(/^"(.*)"$/, '$1'));
        await invoke('spawn_external_player_with_args', { playerPath, args });
      } else if (playerArgs.trim()) {
        const baseArgs = (playerArgs.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((a: string) => a.replace(/^"(.*)"$/, '$1'));
        const args = [...baseArgs, url];
        await invoke('spawn_external_player_with_args', { playerPath, args });
      } else {
        await invoke('spawn_external_player', { playerPath, url });
      }
    } catch (e) {
      console.error('[App] Failed to launch external player for VOD:', e);
    }
  }, []);

  const handlePlayVodWrapper = useCallback((info: import('./types/media').VodPlayInfo, onCloseView?: () => void, targetMode?: 'embedded' | 'popout' | 'external') => {
    if (info.source_id !== 'stremio' && info.source_id !== 'nuvio') {
      stremioMetaRef.current = null;
      stremioEpisodeVideoRef.current = null;
      stremioMovieRef.current = null;
      stremioEpisodeRef.current = null;
      setActiveStremioMeta(null);
      setActiveStremioEpisode(null);
    }
    const effectiveMode = targetMode || info.preferredMode || vodPlayerModeRef.current;
    if (effectiveMode === 'external') {
      handlePlayVodInExternal(info);
    } else if (effectiveMode === 'popout') {
      popoutSwapVod(info);
    } else {
      handlePlayVod(info, onCloseView);
    }
  }, [handlePlayVod, popoutSwapVod, handlePlayVodInExternal]);

  // ==========================================================================
  // Handle Watchlist Switch (needs access to handlePlayChannel)
  // ==========================================================================
  const handleWatchlistSwitchWrapper = useCallback(async (notification: import('./components/WatchlistNotification').WatchlistNotificationItem) => {
    const channel = await db.channels.get(notification.channelId);
    if (channel) {
      addToRecentChannels(channel);
      handlePlayChannelWrapper(channel);
    }
  }, [handlePlayChannelWrapper]);

  // ==========================================================================
  // Stremio Playback Handler (listens for ynotv:stremio-play events)
  // ==========================================================================
  const handlePlayVodRef = useRef(handlePlayVod);
  useEffect(() => { handlePlayVodRef.current = handlePlayVod; }, [handlePlayVod]);
  const handlePlayVodWrapperRef = useRef(handlePlayVodWrapper);
  useEffect(() => { handlePlayVodWrapperRef.current = handlePlayVodWrapper; }, [handlePlayVodWrapper]);
  const setActiveViewRef = useRef(setActiveView);
  useEffect(() => { setActiveViewRef.current = setActiveView; }, [setActiveView]);
  const setDurationRef = useRef(setDuration);
  useEffect(() => { setDurationRef.current = setDuration; }, [setDuration]);
  const setPositionRef = useRef(setPosition);
  useEffect(() => { setPositionRef.current = setPosition; }, [setPosition]);
  const autoSelectSubtitleRef = useRef(autoSelectSubtitle);
  useEffect(() => { autoSelectSubtitleRef.current = autoSelectSubtitle; }, [autoSelectSubtitle]);

  // Ref to hold current stremio episode info for the progress updater
  const stremioEpisodeRef = useRef<{
    metaId: string;
    name: string;
    poster?: string;
    videoId: string;
    season: number;
    episode: number;
    nextVideoId?: string;
    nextSeason?: number;
    nextEpisode?: number;
  } | null>(null);
  const stremioMovieRef = useRef<{ metaId: string; name: string; poster?: string } | null>(null);
  const stremioMetaRef = useRef<StremioMeta | null>(null);
  const stremioEpisodeVideoRef = useRef<any>(null);
  const stremioIsNuvioRef = useRef(false);
  useEffect(() => {
    const handler = async (e: Event) => {
      try {
        const detail = (e as CustomEvent).detail;
        if (!detail?.stream || !detail?.meta) return;

        const { stream, meta, episodeVideo } = detail;
        const url = stream.url || (stream.infoHash ? `infoHash:${stream.infoHash}${stream.fileIdx !== undefined ? `:${stream.fileIdx}` : ''}` : null);
        if (!url) return;

        // Reset duration and position state/ref to avoid stale values during calculations
        if (setDurationRef.current) setDurationRef.current(0);
        if (setPositionRef.current) setPositionRef.current(0);
        durationRef.current = 0;
        positionRef.current = 0;

        const isNuvio = !!detail.isNuvio;
        stremioMetaRef.current = meta;
        setActiveStremioMeta(meta);
        stremioEpisodeVideoRef.current = episodeVideo || null;
        setActiveStremioEpisode(episodeVideo || null);
        stremioIsNuvioRef.current = isNuvio;
        const watchStore = useStremioWatchStore.getState();

        if (meta.type === 'series' && episodeVideo) {
          // Compute next episode: iterate videos sorted by season/episode
          let nextVideoId: string | undefined;
          let nextSeason: number | undefined;
          let nextEpisode: number | undefined;
          if (meta.videos && Array.isArray(meta.videos)) {
            const sorted = [...meta.videos].sort((a: any, b: any) => {
              if ((a.season ?? 0) !== (b.season ?? 0)) return (a.season ?? 0) - (b.season ?? 0);
              return (a.episode ?? 0) - (b.episode ?? 0);
            });
            const idx = sorted.findIndex((v: any) => v.id === episodeVideo.id);
            if (idx >= 0 && idx < sorted.length - 1) {
              const nxt = sorted[idx + 1];
              nextVideoId = nxt.id;
              nextSeason = nxt.season;
              nextEpisode = nxt.episode;
            }
          }
          if (!isNuvio) {
            watchStore.recordEpisodeStart(
              meta.id, meta.name, meta.poster,
              episodeVideo.id, episodeVideo.season ?? 0, episodeVideo.episode ?? 0,
              nextVideoId, nextSeason, nextEpisode,
              stream
            );
          }
          stremioEpisodeRef.current = {
            metaId: meta.id,
            name: meta.name,
            poster: meta.poster,
            videoId: episodeVideo.id,
            season: episodeVideo.season ?? 0,
            episode: episodeVideo.episode ?? 0,
            nextVideoId,
            nextSeason,
            nextEpisode,
          };
          stremioMovieRef.current = null;
        } else {
          if (!isNuvio) {
            watchStore.recordMovieWatch(meta.id, meta.name, meta.poster, stream);
          }
          stremioMovieRef.current = { metaId: meta.id, name: meta.name, poster: meta.poster };
          stremioEpisodeRef.current = null;
        }
        setPlaybackSourceView(isNuvio ? 'nuvio' : 'stremio');
        setActiveViewRef.current('none');
        const isSeries = meta.type === 'series' && episodeVideo;

        // Record watch in local DB vod_history to make it show up in Continue Watching on home page
        void recordVodWatch(
          meta.id,
          isSeries ? 'series' : 'movie',
          isNuvio ? 'nuvio' : 'stremio',
          meta.name,
          meta.poster,
          isSeries ? (episodeVideo.season ?? undefined) : undefined,
          isSeries ? (episodeVideo.episode ?? undefined) : undefined,
          isSeries ? (episodeVideo.title || `Episode ${episodeVideo.episode}`) : undefined
        ).catch((err) => {
          console.error(isNuvio ? '[Nuvio] Failed to record VOD watch in history:' : '[Stremio] Failed to record VOD watch in history:', err);
        });

        await handlePlayVodRef.current({
          url,
          title: meta.name,
          year: meta.year ? String(meta.year) : undefined,
          plot: isSeries
            ? (episodeVideo.description || episodeVideo.overview || meta.description)
            : meta.description,
          type: isSeries ? 'series' : 'movie',
          episodeInfo: isSeries
            ? `S${episodeVideo.season} E${episodeVideo.episode}${episodeVideo.title ? ` · ${episodeVideo.title}` : ''}`
            : undefined,
          source_id: isNuvio ? 'nuvio' : 'stremio',
          mediaId: isSeries ? `${meta.id}_ep_${episodeVideo.id}` : meta.id,
          seriesId: isSeries ? meta.id : undefined,
          seasonNum: episodeVideo?.season,
          episodeNum: episodeVideo?.episode,
          episodeId: episodeVideo?.id,
          posterUrl: meta.poster || undefined,
          backdropUrl: meta.background,
          logoUrl: meta.logo,
          addonName: stream.addonName,
          stremioType: isSeries ? 'series' : 'movie',
          stremioId: isSeries ? episodeVideo.id : meta.id,
        });


        if (stream.infoHash) {
          console.log('[Stremio] Playing torrent stream:', stream.infoHash);
        }

        try {
          let defaultLanguage = 'en';
          if (window.storage) {
            const settingsRes = await window.storage.getSettings();
            if (settingsRes.data?.subtitleSettings?.defaultLanguage) {
              defaultLanguage = settingsRes.data.subtitleSettings.defaultLanguage;
            }
          }

          if (defaultLanguage === 'off') {
            console.log('[Stremio] Subtitle default language is off. Skipping external subtitles fetch.');
          } else {
            const addons = useStremioAddonStore.getState().enabledAddons;
            const subtitleId = isSeries && episodeVideo?.id ? episodeVideo.id : meta.id;
            const subtitleExtra: Record<string, string> = {};
            if (stream.behaviorHints?.videoHash) subtitleExtra.videoHash = stream.behaviorHints.videoHash;
            if (stream.behaviorHints?.videoSize) subtitleExtra.videoSize = String(stream.behaviorHints.videoSize);
            if (stream.behaviorHints?.filename) subtitleExtra.filename = stream.behaviorHints.filename;
            const subs = await fetchSubtitles(addons, meta.type, subtitleId, Object.keys(subtitleExtra).length > 0 ? subtitleExtra : undefined);
            
            const normalizeLangCode = (code?: string): string => {
              if (!code) return '';
              try {
                return fromSubSourceLang(toSubSourceLang(code));
              } catch {
                return code.toLowerCase().slice(0, 2);
              }
            };
            const targetLang = normalizeLangCode(defaultLanguage);
            const filteredSubs = subs.filter(sub => {
              if (!sub.lang) return false;
              return normalizeLangCode(sub.lang) === targetLang;
            });

            if (filteredSubs.length > 0 && window.mpv?.addSubtitleFile) {
              const { writeTextFile, mkdir, BaseDirectory } = await import('@tauri-apps/plugin-fs');
              const { appLocalDataDir, join } = await import('@tauri-apps/api/path');
              const appDir = await appLocalDataDir();

              await mkdir('subtitles', { baseDir: BaseDirectory.AppLocalData, recursive: true }).catch(() => {});

              for (let i = 0; i < filteredSubs.length; i++) {
                const sub = filteredSubs[i];
                try {
                  const safeUrl = sub.url ? (sub.url.includes('%') ? encodeURI(decodeURI(sub.url)) : encodeURI(sub.url)) : '';
                  const res = await window.fetchProxy.fetch(safeUrl);
                  if (res.data?.ok) {
                    const text = res.data.text;
                    const isVtt = sub.url.toLowerCase().includes('.vtt') || text.includes('WEBVTT');
                    const ext = isVtt ? 'vtt' : 'srt';
                    const sanitizePart = (val?: string) => {
                      if (!val) return 'unknown';
                      return val.replace(/__/g, '_').replace(/ /g, '_').replace(/[^a-zA-Z0-9_]/g, '');
                    };
                    const cleanAddon = sanitizePart(sub.addonName || 'Addon').slice(0, 30);
                    const cleanLabel = sanitizePart(sub.label || sub.lang.toUpperCase()).slice(0, 40);
                    const cleanMetaId = sanitizePart(meta.id).slice(0, 30);
                    const cleanLang = sanitizePart(sub.lang).slice(0, 10);
                    const relPath = `subtitles/stremio__${cleanAddon}__${cleanLabel}__${cleanMetaId}__${cleanLang}__${i}.${ext}`;
                    const filePath = await join(appDir, relPath);

                    await writeTextFile(relPath, text, { baseDir: BaseDirectory.AppLocalData });
                    window.mpv.addSubtitleFile(filePath, 'cached').catch(() => {});
                  }
                } catch (err) {
                  console.error('[Stremio] Failed to load or save subtitle:', sub.url, err);
                }
              }
            }
          }
        } catch (err) {
          console.error('[Stremio] Error processing subtitles:', err);
        }
      } catch (err) {
        console.error('[Stremio] Playback handler error:', err);
      }
    };
    window.addEventListener('ynotv:stremio-play', handler);
    return () => window.removeEventListener('ynotv:stremio-play', handler);
  }, []);

  // Stream switch handler for SourcePickerModal
  const handleSwitchStream = useCallback((stream: StremioStream) => {
    const meta = stremioMetaRef.current;
    const episodeVideo = stremioEpisodeVideoRef.current;
    const isNuvio = stremioIsNuvioRef.current;
    if (!meta) return;
    window.dispatchEvent(new CustomEvent('ynotv:stremio-play', {
      detail: { stream, meta, episodeVideo, isNuvio },
    }));
  }, []);

  // ==========================================================================
  // Direct URL Playback Handler (used by Trailer button etc.)
  // ==========================================================================
  useEffect(() => {
    const handler = async (e: Event) => {
      const { url, title, backdropUrl, logoUrl, targetMode } = (e as CustomEvent).detail;
      if (!url) return;
      const currentView = activeViewRef.current;
      if (currentView === 'movies' || currentView === 'series' || currentView === 'stremio' || currentView === 'dvr' || currentView === 'nuvio') {
        setPlaybackSourceView(currentView);
      }
      const effectiveMode = targetMode || vodPlayerModeRef.current;
      if (effectiveMode === 'embedded') {
        setActiveViewRef.current?.('none');
      }
      await handlePlayVodWrapperRef.current?.({
        url,
        title: title || '',
        type: 'movie',
        source_id: 'trailer',
        backdropUrl,
        logoUrl,
      }, undefined, targetMode);
    };
    window.addEventListener('ynotv:play-url', handler);
    return () => window.removeEventListener('ynotv:play-url', handler);
  }, []);

  // ==========================================================================
  // VOD Cast Page & Search Routing Handlers
  // ==========================================================================
  useEffect(() => {
    const navigateHandler = (e: Event) => {
      const { personId } = (e as CustomEvent).detail;
      if (!personId) return;
      setActiveViewRef.current?.('stremio');
      useUIStore.getState().stremioNavigate({ view: 'person', personId });
    };
    window.addEventListener('ynotv:navigate-to-person', navigateHandler);
    return () => window.removeEventListener('ynotv:navigate-to-person', navigateHandler);
  }, []);

  useEffect(() => {
    const searchHandler = (e: Event) => {
      const { type, title } = (e as CustomEvent).detail;
      if (!title) return;
      const store = useUIStore.getState();
      if (type === 'movie') {
        store.setMoviesSearchQuery(title);
        store.setMoviesSelectedItem(null);
        setActiveViewRef.current?.('movies');
      } else {
        store.setSeriesSearchQuery(title);
        store.setSeriesSelectedItem(null);
        setActiveViewRef.current?.('series');
      }
    };
    window.addEventListener('ynotv:search-vod', searchHandler);
    return () => window.removeEventListener('ynotv:search-vod', searchHandler);
  }, []);

  // ==========================================================================
  // Stremio & Nuvio Progress Updater — saves watch progress every 10 seconds
  // ==========================================================================
  useEffect(() => {
    const isStremio = vodInfo?.source_id === 'stremio';
    const isNuvio = vodInfo?.source_id === 'nuvio';
    if ((!isStremio && !isNuvio) || !playing || duration <= 0) return;

    const saveProgress = () => {
      const pos = positionRef.current;
      const dur = durationRef.current;
      if (dur <= 0 || pos <= 0) return;
      const fraction = Math.min(1, pos / dur);
      const watchStore = useStremioWatchStore.getState();

      const epInfo = stremioEpisodeRef.current;
      const movieInfo = stremioMovieRef.current;

      if (epInfo) {
        if (!isNuvio) {
          watchStore.updateEpisodeProgress(
            epInfo.metaId,
            epInfo.videoId,
            fraction,
            epInfo.season,
            epInfo.episode,
            epInfo.nextVideoId,
            epInfo.nextSeason,
            epInfo.nextEpisode
          );
        }
        recordEpisodeWatch(
          epInfo.videoId,
          epInfo.metaId,
          isNuvio ? 'nuvio' : 'stremio',
          epInfo.season,
          epInfo.episode,
          '',
          Math.floor(pos),
          Math.floor(dur)
        ).catch(() => {});

        if (isStremio) {
          // Sync to Stremio Cloud
          const auth = useStremioAuthStore.getState();
          if (auth.authKey && auth.syncProgress) {
            auth.syncPlaybackProgress(
              epInfo.metaId,
              epInfo.videoId,
              pos,
              dur,
              'series',
              epInfo.name,
              epInfo.poster
            ).catch(() => {});
          }
        } else if (isNuvio) {
          // Sync to Nuvio Cloud
          const nuvioAuth = useNuvioAuthStore.getState();
          const nuvioToken = nuvioAuth.token;
          const nuvioProfile = nuvioAuth.activeProfile;
          if (nuvioToken && nuvioProfile) {
            pushNuvioWatchProgress(nuvioToken, nuvioProfile.profile_index, [{
              content_id: epInfo.metaId,
              content_type: 'series',
              video_id: epInfo.videoId,
              season: epInfo.season,
              episode: epInfo.episode,
              position: Math.floor(pos * 1000),
              duration: Math.floor(dur * 1000),
              last_watched: Date.now(),
              progress_key: `${epInfo.metaId}_s${epInfo.season}e${epInfo.episode}`,
            }]).then(() => {
              window.dispatchEvent(new CustomEvent('ynotv:nuvio-sync-required'));
            }).catch(() => {});
          }
        }
      } else if (movieInfo) {
        if (!isNuvio) {
          watchStore.updateMovieProgress(movieInfo.metaId, fraction);
        }

        if (isStremio) {
          // Sync to Stremio Cloud
          const auth = useStremioAuthStore.getState();
          if (auth.authKey && auth.syncProgress) {
            auth.syncPlaybackProgress(
              movieInfo.metaId,
              movieInfo.metaId,
              pos,
              dur,
              'movie',
              movieInfo.name,
              movieInfo.poster
            ).catch(() => {});
          }
        } else if (isNuvio) {
          // Sync to Nuvio Cloud
          const nuvioAuth = useNuvioAuthStore.getState();
          const nuvioToken = nuvioAuth.token;
          const nuvioProfile = nuvioAuth.activeProfile;
          if (nuvioToken && nuvioProfile) {
            pushNuvioWatchProgress(nuvioToken, nuvioProfile.profile_index, [{
              content_id: movieInfo.metaId,
              content_type: 'movie',
              video_id: movieInfo.metaId,
              season: null,
              episode: null,
              position: Math.floor(pos * 1000),
              duration: Math.floor(dur * 1000),
              last_watched: Date.now(),
              progress_key: `${movieInfo.metaId}`,
            }]).then(() => {
              window.dispatchEvent(new CustomEvent('ynotv:nuvio-sync-required'));
            }).catch(() => {});
          }
        }
      }
    };

    // Save immediately and then every 10 seconds
    saveProgress();
    const interval = setInterval(saveProgress, 10_000);
    return () => clearInterval(interval);
  }, [vodInfo, playing, duration]);

  // Drop any pending end-of-stream signal when switching to a different stream,
  // so a stale EOF from a previous file can't auto-play the next episode. Must
  // be declared before the auto-play effect below so it runs first on stream
  // changes.
  useEffect(() => {
    setVodEndFileSignal(null);
  }, [vodInfo?.url]);

  // ==========================================================================
  // VOD Series Auto-Play Next Episode
  // ==========================================================================
  // Dedup: the playing->paused transition and the mpv end-file event can both
  // fire for the same EOF within milliseconds, which would double-run auto-play.
  const lastAutoAdvanceRef = useRef<{ key: string; ts: number } | null>(null);
  const prevPlayingRef = useRef(playing);
  useEffect(() => {
    const prevPlaying = prevPlayingRef.current;
    prevPlayingRef.current = playing;

    if (!vodInfo) return;

    // Natural-end signals:
    // 1) mpv end-file reason "eof" — position/duration are snapshotted at
    //    end-file time on the Rust side (live position resets to 0 once mpv
    //    unloads an ended file).
    // 2) playing flipped true -> false while at/after the end of the file
    //    (mpv pauses at EOF). A user pause ALSO flips playing, so both paths
    //    are gated on !userPausedRef below — that gate is the actual fix for
    //    the pause-near-the-end skipping bug.
    const endDur = vodEndFileSignal ? vodEndFileSignal.durationAtEnd : duration;
    const endPos = vodEndFileSignal ? vodEndFileSignal.positionAtEnd : position;
    const eofSignal =
      !!vodEndFileSignal &&
      vodEndFileSignal.reason === 'eof' &&
      endDur > 0 &&
      (endPos >= endDur - 5 || endPos / endDur >= 0.90 || endPos <= 1);
    const playStopEnd =
      prevPlaying && !playing && duration > 0 && (position >= duration - 5 || position / duration >= 0.90);

    if (!eofSignal && !playStopEnd) return;

    // A user-initiated pause must never be treated as the episode ending.
    if (userPausedRef.current) return;

    // Consume the signal so a re-render can't re-trigger auto-play.
    if (vodEndFileSignal) setVodEndFileSignal(null);

    // Only advance once per stream within a short window (see dedup comment).
    const streamKey = vodInfo.mediaId || vodInfo.url || '';
    const now = Date.now();
    if (lastAutoAdvanceRef.current && lastAutoAdvanceRef.current.key === streamKey && now - lastAutoAdvanceRef.current.ts < 10_000) {
      return;
    }
    lastAutoAdvanceRef.current = { key: streamKey, ts: now };

    console.log('[AutoPlay] Natural end detected:', { eofSignal, playStopEnd, endPos, endDur });

    {
      const activeState = useActivePlaylistStore.getState();
      if (activeState.activePlaylistId && activeState.currentIndex >= 0 && activeState.items.length > 0) {
        const { activePlaylistId, currentIndex, items } = activeState;
        const currentItem = items[currentIndex];

        // Only advance/remove when the video that finished is actually the
        // playlist's current item. If the user played something else, the
        // playlist session is stale — drop it so it can't hijack playback.
        if (currentItem && isActivePlaylistItem(vodInfo, currentItem)) {
          // Freeze the finished item's progress into the localStorage snapshot
          // so playlists keep "last watched" and resume info after a cache clear.
          snapshotPlaylistProgress(vodInfo, endPos > 1 ? endPos : endDur, endDur);

          const plStore = useVodPlaylistStore.getState();
          const playlist = plStore.playlists.find((p) => p.id === activePlaylistId);

          // Mark a finished playlist episode as completed, mirroring normal
          // series playback, so watch history stays consistent.
          if (currentItem.itemType === 'episode' && currentItem.seriesId) {
            const currentEpId = vodInfo.episodeId || (vodInfo.mediaId && vodInfo.mediaId.includes('_ep_') ? vodInfo.mediaId.split('_ep_')[1] : null);
            if (currentEpId) {
              void recordEpisodeWatch(
                currentEpId,
                currentItem.seriesId,
                vodInfo.source_id || '',
                currentItem.seasonNum ?? 0,
                currentItem.episodeNum ?? 0,
                '',
                Math.floor(endDur),
                Math.floor(endDur)
              );
            }
          }

          const shouldAutoplay = playlist?.autoplayNext ?? true;

          if (playlist?.removeAfterWatching) {
            console.log('[Playlist] Removing played item from playlist after watching:', currentItem.title);
            plStore.removeItemFromPlaylist(activePlaylistId, currentItem.id);
            useToastStore.getState().addToast(
              i18n.t('vod:removedAfterWatchingToast', { title: currentItem.title }),
              'success'
            );

            // Mirror the removal into the live queue so the overlay matches
            // the playlist; the next item slides into the current slot and is
            // returned when autoplay should continue.
            const nextItem = activeState.removeCurrentAndAdvance(shouldAutoplay);
            if (nextItem && nextItem.directUrl) {
              console.log('[Playlist] Autoplaying next playlist item:', nextItem.title);
              void recordPlaylistItemWatch(nextItem);
              void handlePlayVod(playlistItemToVodInfo(nextItem));
              return;
            }
            return;
          }

          if (shouldAutoplay) {
            const nextItem = activeState.advanceToNext();
            if (nextItem && nextItem.directUrl) {
              console.log('[Playlist] Autoplaying next playlist item:', nextItem.title);
              void recordPlaylistItemWatch(nextItem);
              void handlePlayVod(playlistItemToVodInfo(nextItem));
              return;
            }
          }
          // While a playlist item is playing, the queue owns progression —
          // don't fall through to the series next-episode auto-play.
          return;
        }

        // The finished video isn't the playlist's current item — clear the
        // stale session so it can't affect (or hijack) future playback.
        useActivePlaylistStore.getState().stopPlayback();
      }
    }

    if (vodInfo?.type === 'series') {
      const { seriesId, seasonNum, episodeNum, episodeId, title, source_id, year, plot, backdropUrl, logoUrl, mediaId, tmdbId, imdbId } = vodInfo;
      
      // Always mark the ended episode as completed (100% watched)
      const currentEpId = episodeId || (mediaId && mediaId.includes('_ep_') ? mediaId.split('_ep_')[1] : null);
      if (currentEpId && seriesId) {
        console.log('[AutoPlay] Marking ended episode as completed:', currentEpId);
        void recordEpisodeWatch(
          currentEpId,
          seriesId,
          source_id || '',
          seasonNum ?? 0,
          episodeNum ?? 0,
          '',
          Math.floor(endDur),
          Math.floor(endDur)
        );
      }

      if (stremioEpisodeRef.current) {
        const watchStore = useStremioWatchStore.getState();
        watchStore.updateEpisodeProgress(
          stremioEpisodeRef.current.metaId,
          stremioEpisodeRef.current.videoId,
          1.0,
          stremioEpisodeRef.current.season,
          stremioEpisodeRef.current.episode,
          stremioEpisodeRef.current.nextVideoId,
          stremioEpisodeRef.current.nextSeason,
          stremioEpisodeRef.current.nextEpisode
        );
      }

      if (vodAutoPlayNextEpisode && seriesId && seasonNum !== undefined && episodeNum !== undefined && title) {
        console.log('[AutoPlay] VOD Series ended naturally, triggering auto-play next episode');
        
        (async () => {
          try {
            const nextEpisode = await getAdjacentEpisode(
              seriesId,
              seasonNum,
              episodeNum,
              'next'
            );

            if (nextEpisode && nextEpisode.direct_url) {
              console.log(`[AutoPlay] Found next episode: S${nextEpisode.season_num}E${nextEpisode.episode_num}`);
              
              const progress = await getEpisodeProgress(nextEpisode.id);
              const resumePosition = progress?.progress_seconds && progress.progress_seconds > 10 ? progress.progress_seconds : 0;
              
              const series = await db.vodSeries.get(seriesId);
              const coverUrl = series ? (series.cover || (series as any).stream_icon) : undefined;

              void recordVodWatch(
                seriesId,
                'series',
                source_id || '',
                title,
                coverUrl,
                nextEpisode.season_num,
                nextEpisode.episode_num,
                nextEpisode.title || `Episode ${nextEpisode.episode_num}`
              );
              
              void recordEpisodeWatch(
                nextEpisode.id,
                seriesId,
                source_id || '',
                nextEpisode.season_num,
                nextEpisode.episode_num,
                nextEpisode.title || `Episode ${nextEpisode.episode_num}`,
                resumePosition,
                nextEpisode.duration ?? Number(nextEpisode.info?.duration) ?? 0
              );
              
              await handlePlayVod({
                url: nextEpisode.direct_url,
                title,
                year,
                plot: nextEpisode.plot || plot,
                type: 'series',
                episodeInfo: `S${nextEpisode.season_num} E${nextEpisode.episode_num}${nextEpisode.title ? ` · ${nextEpisode.title}` : ''}`,
                source_id,
                mediaId: `${seriesId}_ep_${nextEpisode.id}`,
                seriesId,
                seasonNum: nextEpisode.season_num,
                episodeNum: nextEpisode.episode_num,
                episodeId: nextEpisode.id,
                backdropUrl,
                logoUrl,
                tmdbId,
                imdbId,
              });
            } else {
              console.log('[AutoPlay] No next episode found (reached end of series)');
            }
          } catch (err) {
            console.error('[AutoPlay] Error playing next episode:', err);
          }
        })();
      }
    }
  }, [playing, vodEndFileSignal, vodInfo, duration, position, vodAutoPlayNextEpisode, handlePlayVod, userPausedRef]);

  // ==========================================================================
  // Active playlist queue controls (indicator click + prev/next buttons)
  // ==========================================================================
  const [playlistQueueOpen, setPlaylistQueueOpen] = useState(false);

  // Jump playback to a queue index (used by the queue overlay and prev/next).
  const playPlaylistItemAt = useCallback((index: number) => {
    const { items } = useActivePlaylistStore.getState();
    const item = items[index];
    if (!item || !item.directUrl) return;
    useActivePlaylistStore.getState().setCurrentIndex(index);
    void recordPlaylistItemWatch(item);
    void handlePlayVod(playlistItemToVodInfo(item));
  }, [handlePlayVod]);

  const handlePlaylistPrevious = useCallback(() => {
    const store = useActivePlaylistStore.getState();
    // previousItem() mutates the store, so re-read the index after it returns.
    if (store.previousItem()) {
      playPlaylistItemAt(useActivePlaylistStore.getState().currentIndex);
    }
  }, [playPlaylistItemAt]);

  const handlePlaylistNext = useCallback(() => {
    const store = useActivePlaylistStore.getState();
    // advanceToNext() mutates the store, so re-read the index after it returns.
    if (store.advanceToNext()) {
      playPlaylistItemAt(useActivePlaylistStore.getState().currentIndex);
    }
  }, [playPlaylistItemAt]);

  const lastKnownProgressPercentRef = useRef(0);
  const scrobblingMediaRef = useRef<any>(null);
  const scrobbleTimerRef = useRef<any>(null);

  // Refresh Trakt tokens on mount. Playback progress sync is manual from Settings.
  useEffect(() => {
    scrobbler.refreshTraktToken().catch(console.error);
  }, []);

  // Update last known progress percent continuously
  useEffect(() => {
    if (duration > 0) {
      lastKnownProgressPercentRef.current = (position / duration) * 100;
    }
  }, [position, duration]);

  useEffect(() => {
    if (!vodInfo) {
      // Playback stopped/closed
      if (scrobblingMediaRef.current) {
        const finalPercent = lastKnownProgressPercentRef.current;
        console.log('[Scrobbler] Playback ended, stopping scrobble at percent:', finalPercent);
        scrobbler.stopScrobble(finalPercent).catch(console.error);
        scrobblingMediaRef.current = null;
      }
      if (scrobbleTimerRef.current) {
        clearInterval(scrobbleTimerRef.current);
        scrobbleTimerRef.current = null;
      }
      return;
    }

    if (vodInfo?.type === 'recording') {
      if (scrobblingMediaRef.current) {
        const finalPercent = lastKnownProgressPercentRef.current;
        console.log('[Scrobbler] Playback ended, stopping scrobble at percent:', finalPercent);
        scrobbler.stopScrobble(finalPercent).catch(console.error);
        scrobblingMediaRef.current = null;
      }
      if (scrobbleTimerRef.current) {
        clearInterval(scrobbleTimerRef.current);
        scrobbleTimerRef.current = null;
      }
      return;
    }

    if (playing && duration > 0) {
      // Playback active (either starting or resuming)
      // Resolve media ids before scrobbling so we can prefer the exact TMDb id
      // (now fetched from the provider via get_vod_info) when an IMDb id is absent.
      (async () => {
        const currentPercent = (position / duration) * 100;

        // Determine media details
        let title = vodInfo.title || 'Unknown Video';
      let year = vodInfo.year;
      let imdbId: string | undefined = undefined;
      let tmdbId: number | undefined = vodInfo.tmdbId ? parseInt(String(vodInfo.tmdbId).replace(/[^0-9]/g, ''), 10) : undefined;
      let type: 'movie' | 'series' = vodInfo.type === 'series' ? 'series' : 'movie';
      let season: number | undefined = undefined;
      let episode: number | undefined = undefined;

      // Extract IMDb and episode metadata
      if (vodInfo.source_id === 'stremio') {
        const epInfo = stremioEpisodeRef.current;
        const movieInfo = stremioMovieRef.current;
        if (epInfo) {
          imdbId = epInfo.metaId;
          title = epInfo.name;
          season = epInfo.season;
          episode = epInfo.episode;
          type = 'series';
        } else if (movieInfo) {
          imdbId = movieInfo.metaId;
          title = movieInfo.name;
          type = 'movie';
        }
      } else {
        // Native VOD
        imdbId = vodInfo.mediaId && vodInfo.mediaId.startsWith('tt') ? vodInfo.mediaId : undefined;
        if (vodInfo.type === 'series') {
          type = 'series';
          season = vodInfo.seasonNum;
          episode = vodInfo.episodeNum;
          
          // If mediaId is structured like "imdb_ep_id", extract the first part if it's an imdb id
          if (vodInfo.mediaId && vodInfo.mediaId.includes('_ep_')) {
            const parts = vodInfo.mediaId.split('_ep_');
            if (parts[0] && parts[0].startsWith('tt')) {
              imdbId = parts[0];
            }
          }
        }
      }

      // Resolve the TMDb id for native VOD when the playback session didn't carry one.
      // The provider's get_vod_info tmdb_id is an exact match and gets cached to DB
      // on the detail page, so prefer the DB record, falling back to the provider.
      if (!tmdbId) {
        try {
          if (type === 'movie' && vodInfo.mediaId && vodInfo.source_id) {
            const movie = await db.vodMovies.get(vodInfo.mediaId);
            if (movie?.tmdb_id) {
              tmdbId = movie.tmdb_id;
            } else {
              const sourcesResult = await window.storage?.getSources();
              const source = sourcesResult?.data?.find((s) => String(s.id) === String(vodInfo.source_id));
              if (source) {
                const providerTmdb = await fetchVodProviderTmdbId(source, vodInfo.mediaId);
                if (providerTmdb) tmdbId = providerTmdb;
              }
            }
          } else if (type === 'series' && vodInfo.seriesId) {
            const series = await db.vodSeries.get(vodInfo.seriesId);
            if (series?.tmdb_id) tmdbId = series.tmdb_id;
          }
        } catch (e) {
          console.warn('[Scrobbler] Failed to resolve TMDb id:', e);
        }
      }

      const mediaInfo = {
        title,
        year,
        imdbId,
        tmdbId,
        type,
        season,
        episode,
        progressPercent: currentPercent
      };

      scrobblingMediaRef.current = mediaInfo;
      console.log('[Scrobbler] Starting/Resuming scrobble session:', mediaInfo);
      scrobbler.startScrobble(mediaInfo).catch(console.error);

      // Clear any existing timer
      if (scrobbleTimerRef.current) {
        clearInterval(scrobbleTimerRef.current);
      }

      // Set up periodic 30-second progress updater
      scrobbleTimerRef.current = setInterval(() => {
        const progress = lastKnownProgressPercentRef.current;
        console.log('[Scrobbler] 30s scrobble update interval firing at progress:', progress);
        scrobbler.updateScrobble(progress).catch(console.error);
      }, 30000);

    })();

    } else if (!playing && scrobblingMediaRef.current) {
      // Playback paused, or the media ended naturally (e.g. autoplay advancing to
      // the next episode). If it ran to completion, send a stop so Trakt/Simkl mark
      // it watched instead of a pause (which only saves a resume point).
      const completed = duration > 0 && (position >= duration - 5 || position / duration >= 0.9);
      if (completed) {
        const finalPercent = Math.min(100, (position / duration) * 100);
        console.log('[Scrobbler] Playback completed, stopping scrobble at percent:', finalPercent);
        scrobbler.stopScrobble(finalPercent).catch(console.error);
      } else {
        console.log('[Scrobbler] Playback paused, pausing scrobble...');
        scrobbler.pauseScrobble().catch(console.error);
      }
      if (scrobbleTimerRef.current) {
        clearInterval(scrobbleTimerRef.current);
        scrobbleTimerRef.current = null;
      }
    }

    return () => {
      // Clean up timer on change of playback states
      if (scrobbleTimerRef.current) {
        clearInterval(scrobbleTimerRef.current);
        scrobbleTimerRef.current = null;
      }
    };
  }, [vodInfo, playing, duration]);

  // ==========================================================================
  // Skip Intro (IntroDB integration)
  // ==========================================================================
  const skipIntro = useSkipIntro({
    vodInfo,
    playing,
    position,
    duration,
    stremioEpisodeRef,
  });

  // ==========================================================================
  // Handle Channel Navigation (Up/Down) - with Series Episode Support
  // ==========================================================================
  const handleChannelUp = useCallback(async () => {
    // Check if we're watching a series with episode info
    if (vodInfo?.type === 'series' && vodInfo.seriesId && vodInfo.seasonNum && vodInfo.episodeNum) {
      // Stremio series: navigate through videos stored in meta
      if (vodInfo.source_id === 'stremio') {
        const meta = stremioMetaRef.current;
        if (meta?.videos) {
          const sorted = [...meta.videos].sort((a: any, b: any) => {
            if ((a.season ?? 0) !== (b.season ?? 0)) return (a.season ?? 0) - (b.season ?? 0);
            return (a.episode ?? 0) - (b.episode ?? 0);
          });
          const currentIdx = sorted.findIndex((v: any) => v.id === vodInfo.episodeId);
          if (currentIdx > 0) {
            const prevVideo = sorted[currentIdx - 1];
            const store = useUIStore.getState();
            store.setStremioActiveMeta(meta);
            store.setStremioSelectedSeason(prevVideo.season);
            store.setStremioPreselectVideoId(prevVideo.id);
            await handleStop();
            return;
          }
        }
        // Fall through to channel nav if no prev episode found
      } else if (vodInfo.source_id === 'nuvio') {
        const meta = stremioMetaRef.current;
        if (meta?.videos) {
          const sorted = [...meta.videos].sort((a: any, b: any) => {
            if ((a.season ?? 0) !== (b.season ?? 0)) return (a.season ?? 0) - (b.season ?? 0);
            return (a.episode ?? 0) - (b.episode ?? 0);
          });
          const currentIdx = sorted.findIndex((v: any) => v.id === vodInfo.episodeId);
          if (currentIdx > 0) {
            const prevVideo = sorted[currentIdx - 1];
            const store = useUIStore.getState();
            store.setNuvioPreselectVideoId(prevVideo.id);
            store.nuvioNavigate({
              view: 'detail',
              meta: {
                id: meta.id,
                type: 'series',
                name: meta.name,
                poster: meta.poster ?? null,
                background: meta.background ?? meta.poster ?? null,
              }
            });
            await handleStop();
            return;
          }
        }
      } else {
        // VOD series: navigate via DB episodes
        const prevEpisode = await getAdjacentEpisode(
          vodInfo.seriesId,
          vodInfo.seasonNum,
          vodInfo.episodeNum,
          'prev'
        );
        
        if (prevEpisode) {
          // Get progress for resume
          const progress = await getEpisodeProgress(prevEpisode.id);
          const resumePosition = progress?.progress_seconds && progress.progress_seconds > 10 ? progress.progress_seconds : 0;
          
          // Record watch history
          void recordVodWatch(
            vodInfo.seriesId,
            'series',
            vodInfo.source_id || '',
            vodInfo.title,
            undefined,
            prevEpisode.season_num,
            prevEpisode.episode_num,
            prevEpisode.title || `Episode ${prevEpisode.episode_num}`
          );
          
          void recordEpisodeWatch(
            prevEpisode.id,
            vodInfo.seriesId,
            vodInfo.source_id || '',
            prevEpisode.season_num,
            prevEpisode.episode_num,
            prevEpisode.title || `Episode ${prevEpisode.episode_num}`,
            resumePosition,
            prevEpisode.duration ?? Number(prevEpisode.info?.duration) ?? 0
          );
          
          // Play the previous episode
          await handlePlayVod({
            url: prevEpisode.direct_url,
            title: vodInfo.title,
            year: vodInfo.year,
            plot: prevEpisode.plot || vodInfo.plot,
            type: 'series',
            episodeInfo: `S${prevEpisode.season_num} E${prevEpisode.episode_num}${prevEpisode.title ? ` · ${prevEpisode.title}` : ''}`,
            source_id: vodInfo.source_id,
            mediaId: `${vodInfo.seriesId}_ep_${prevEpisode.id}`,
            seriesId: vodInfo.seriesId,
            seasonNum: prevEpisode.season_num,
            episodeNum: prevEpisode.episode_num,
            episodeId: prevEpisode.id,
            tmdbId: vodInfo.tmdbId,
            imdbId: vodInfo.imdbId,
          });
          return;
        }
      }
    }
    
    // Default: navigate channels
    if (currentChannels.length > 0 && currentChannel) {
      const currentIndex = currentChannels.findIndex((ch) => ch.stream_id === currentChannel.stream_id);
      if (currentIndex > 0) {
        handlePlayChannel(currentChannels[currentIndex - 1]);
      } else if (currentIndex === 0) {
        // Wrap to last channel
        handlePlayChannel(currentChannels[currentChannels.length - 1]);
      }
    }
  }, [currentChannels, currentChannel, handlePlayChannel, vodInfo, handlePlayVod, handleStop]);

  const handleChannelDown = useCallback(async () => {
    // Check if we're watching a series with episode info
    if (vodInfo?.type === 'series' && vodInfo.seriesId && vodInfo.seasonNum && vodInfo.episodeNum) {
      // Stremio series: navigate through videos stored in meta
      if (vodInfo.source_id === 'stremio') {
        const meta = stremioMetaRef.current;
        if (meta?.videos) {
          const sorted = [...meta.videos].sort((a: any, b: any) => {
            if ((a.season ?? 0) !== (b.season ?? 0)) return (a.season ?? 0) - (b.season ?? 0);
            return (a.episode ?? 0) - (b.episode ?? 0);
          });
          const currentIdx = sorted.findIndex((v: any) => v.id === vodInfo.episodeId);
          if (currentIdx >= 0 && currentIdx < sorted.length - 1) {
            const nextVideo = sorted[currentIdx + 1];
            const store = useUIStore.getState();
            store.setStremioActiveMeta(meta);
            store.setStremioSelectedSeason(nextVideo.season);
            store.setStremioPreselectVideoId(nextVideo.id);
            await handleStop();
            return;
          }
        }
        // Fall through to channel nav if no next episode found
      } else if (vodInfo.source_id === 'nuvio') {
        const meta = stremioMetaRef.current;
        if (meta?.videos) {
          const sorted = [...meta.videos].sort((a: any, b: any) => {
            if ((a.season ?? 0) !== (b.season ?? 0)) return (a.season ?? 0) - (b.season ?? 0);
            return (a.episode ?? 0) - (b.episode ?? 0);
          });
          const currentIdx = sorted.findIndex((v: any) => v.id === vodInfo.episodeId);
          if (currentIdx >= 0 && currentIdx < sorted.length - 1) {
            const nextVideo = sorted[currentIdx + 1];
            const store = useUIStore.getState();
            store.setNuvioPreselectVideoId(nextVideo.id);
            store.nuvioNavigate({
              view: 'detail',
              meta: {
                id: meta.id,
                type: 'series',
                name: meta.name,
                poster: meta.poster ?? null,
                background: meta.background ?? meta.poster ?? null,
              }
            });
            await handleStop();
            return;
          }
        }
      } else {
        // VOD series: navigate via DB episodes
        const nextEpisode = await getAdjacentEpisode(
          vodInfo.seriesId,
          vodInfo.seasonNum,
          vodInfo.episodeNum,
          'next'
        );
        
        if (nextEpisode) {
          // Get progress for resume
          const progress = await getEpisodeProgress(nextEpisode.id);
          const resumePosition = progress?.progress_seconds && progress.progress_seconds > 10 ? progress.progress_seconds : 0;

          // Stop scrobbling the current episode at its current progress so it is
          // saved as resumable playback (or watched if already >=80%) on Trakt/Simkl
          // before switching to the next episode.
          const curDur = durationRef.current;
          const curPos = positionRef.current;
          const curPercent = curDur > 0 ? Math.min(100, (curPos / curDur) * 100) : lastKnownProgressPercentRef.current;
          console.log('[Scrobbler] Skipping to next episode, stopping scrobble at percent:', curPercent);
          scrobbler.stopScrobble(curPercent).catch(console.error);
          
          // Record watch history
          void recordVodWatch(
            vodInfo.seriesId,
            'series',
            vodInfo.source_id || '',
            vodInfo.title,
            undefined,
            nextEpisode.season_num,
            nextEpisode.episode_num,
            nextEpisode.title || `Episode ${nextEpisode.episode_num}`
          );
          
          void recordEpisodeWatch(
            nextEpisode.id,
            vodInfo.seriesId,
            vodInfo.source_id || '',
            nextEpisode.season_num,
            nextEpisode.episode_num,
            nextEpisode.title || `Episode ${nextEpisode.episode_num}`,
            resumePosition,
            nextEpisode.duration ?? Number(nextEpisode.info?.duration) ?? 0
          );
          
          // Play the next episode
          await handlePlayVod({
            url: nextEpisode.direct_url,
            title: vodInfo.title,
            year: vodInfo.year,
            plot: nextEpisode.plot || vodInfo.plot,
            type: 'series',
            episodeInfo: `S${nextEpisode.season_num} E${nextEpisode.episode_num}${nextEpisode.title ? ` · ${nextEpisode.title}` : ''}`,
            source_id: vodInfo.source_id,
            mediaId: `${vodInfo.seriesId}_ep_${nextEpisode.id}`,
            seriesId: vodInfo.seriesId,
            seasonNum: nextEpisode.season_num,
            episodeNum: nextEpisode.episode_num,
            episodeId: nextEpisode.id,
            tmdbId: vodInfo.tmdbId,
            imdbId: vodInfo.imdbId,
          });
          return;
        }
      }
    }
    
    // Default: navigate channels
    if (currentChannels.length > 0 && currentChannel) {
      const currentIndex = currentChannels.findIndex((ch) => ch.stream_id === currentChannel.stream_id);
      if (currentIndex >= 0 && currentIndex < currentChannels.length - 1) {
        handlePlayChannel(currentChannels[currentIndex + 1]);
      } else if (currentIndex === currentChannels.length - 1) {
        // Wrap to first channel
        handlePlayChannel(currentChannels[0]);
      }
    }
  }, [currentChannels, currentChannel, handlePlayChannel, vodInfo, handlePlayVod, handleStop]);

  // ==========================================================================
  // Keyboard Shortcuts (using latest ref pattern)
  // ==========================================================================
  useKeyboardShortcuts({
    shortcuts,
    activeView,
    showSettingsPopup,
    showShortcutsOverlay,
    setShowShortcutsOverlay,
    categoriesOpen,
    categoriesHidden,
    categoriesHiddenTransparent,
    position,
    currentChannels,
    currentChannel,
    switchLayout,
    titleBarSearchRef,
    handlePlayChannel,
    lastPlayedChannel: lastPlayedChannelRef.current,
    handleTogglePlay,
    handleToggleMute,
    handleToggleStats,
    handleToggleFullscreen,
    handleShowSubtitleModal,
    handleShowAudioModal,
    handleSeek,
    handleToggleEpgView,
    setActiveView,
    setShowSettingsPopup,
    setCategoriesOpen,
    setShowControls,
    guideTransparent,
    setGuideTransparent,
    isTransparentGuideZapActive,
    onChannelChangeFlash: triggerChannelChangeFlash,
    onTransparentGuideZapFlash: triggerTransparentGuideZapFlash,
    handleMouseBackNavigation,
  });

  // ==========================================================================
  // Auto-Sync on Startup & Periodic Checking
  // ==========================================================================
  const isAutoSyncingRef = useRef(false);

  useEffect(() => {
    // Helper to perform sync check and sync stale sources
    const performSyncCheck = async (isPeriodic = false) => {
      if (!window.storage) return;

      if (!isPeriodic) {
        if (hasStartupAutoSyncTriggered) {
          console.log('[AutoSync] Startup sync already triggered, skipping duplicate execution');
          return;
        }
        hasStartupAutoSyncTriggered = true;
      }

      // Skip if already syncing (for periodic checks)
      if (isPeriodic && isAutoSyncingRef.current) {
        console.log('[AutoSync] Periodic check skipped - sync already in progress');
        return;
      }

      // Health check — ensure backend bulk-ops plugin is ready
      const healthy = await bulkOps.healthCheck();
      if (!healthy) {
        console.error('[AutoSync] Backend health check failed — sync may not work');
      }

      try {
        // Load settings and sources in parallel
        const [settingsResult, sourcesResult] = await Promise.all([
          window.storage.getSettings(),
          window.storage.getSources()
        ]);
        
        if (!isPeriodic && settingsResult.data) {
          // Apply font sizes (only on initial sync)
          const loadedModernUi = settingsResult.data.modernUiEnabled ?? 'v3';
          const chSize = settingsResult.data.channelFontSize ?? (loadedModernUi === 'v3' ? 12 : 14);
          const catSize = settingsResult.data.categoryFontSize ?? 13;
          const srcSize = settingsResult.data.sourceFontSize ?? 12;
          document.documentElement.style.setProperty('--channel-font-size', `${chSize}px`);
          document.documentElement.style.setProperty('--category-font-size', `${catSize}px`);
          document.documentElement.style.setProperty('--source-font-size', `${srcSize}px`);
          if (settingsResult.data.epgTitleFontSize) {
            document.documentElement.style.setProperty('--epg-title-font-size', `${settingsResult.data.epgTitleFontSize}px`);
          }
          if (settingsResult.data.epgBodyFontSize) {
            document.documentElement.style.setProperty('--epg-body-font-size', `${settingsResult.data.epgBodyFontSize}px`);
          }
          const loadedAppLogoSize = settingsResult.data.channelLogoSize ?? 42;
          document.documentElement.style.setProperty('--channel-logo-size', `${loadedAppLogoSize}px`);
          if (settingsResult.data.channelLogoRoundEdges === false) {
            document.documentElement.style.setProperty('--channel-logo-radius', '0px');
            document.documentElement.classList.add('logo-sharp-edges');
          } else {
            document.documentElement.style.removeProperty('--channel-logo-radius');
            document.documentElement.classList.remove('logo-sharp-edges');
          }
          if (settingsResult.data.channelLogoPadding === 'padded') {
            document.documentElement.classList.add('logo-padded-tiles');
          } else {
            document.documentElement.classList.remove('logo-padded-tiles');
          }
          if (settingsResult.data.uiScale) {
            document.documentElement.style.setProperty('--app-zoom', String(settingsResult.data.uiScale / 100));
            // Trigger EPG to re-measure availableWidth now that zoom is set.
            // ChannelPanel's useEffect runs before this settings load completes,
            // so it initially measures at zoom=1. This corrects it.
            window.dispatchEvent(new Event('resize'));
          }
          // Load transparent guide overlay settings
          const loadedGuideHeight = settingsResult.data.transparentGuideHeight ?? 40;
          document.documentElement.style.setProperty('--transparent-guide-height', `${loadedGuideHeight}%`);
          const loadedHideHeader = settingsResult.data.transparentGuideHideHeader ?? false;
          document.documentElement.classList.toggle('transparent-guide-hide-header', loadedHideHeader);
          const loadedOverlayOpacity = settingsResult.data.transparentGuideOverlayOpacity ?? 55;
          document.documentElement.style.setProperty('--transparent-guide-overlay-opacity', String(loadedOverlayOpacity / 100));
          const loadedSidebarOpacity = settingsResult.data.transparentGuideSidebarOpacity ?? 55;
          document.documentElement.style.setProperty('--transparent-guide-sidebar-opacity', String(loadedSidebarOpacity / 100));
          // Apply other settings
          if (settingsResult.data.channelSortOrder) {
            setChannelSortOrder(settingsResult.data.channelSortOrder as 'alphabetical' | 'number' | 'provider');
          } else if (!channelSortOrderMigrated) {
            // Migrate users who never explicitly chose a sort order to the new default
            setChannelSortOrder('provider');
            await window.storage.updateSettings({ channelSortOrder: 'provider' });
            setChannelSortOrderMigrated(true);
          }
          if (settingsResult.data.categorySortOrder) {
            setCategorySortOrder(settingsResult.data.categorySortOrder as 'default' | 'alphabetical');
          }
          if (settingsResult.data.epgView) {
            setEpgView(settingsResult.data.epgView as 'traditional' | 'alternate');
          }
          if (settingsResult.data.epgVisibleHours) {
            const rawHours = settingsResult.data.epgVisibleHours;
            setEpgVisibleHours(rawHours === 'auto' ? 'auto' : Number(rawHours));
          }
          if (settingsResult.data.epgClockFormat) {
            setEpgClockFormat(settingsResult.data.epgClockFormat as '12h' | '24h');
          }
          if (settingsResult.data.epgShowDate !== undefined) {
            setEpgShowDate(settingsResult.data.epgShowDate);
          }
          if (settingsResult.data.includeAllChannelsToPlaylist !== undefined) {
            setIncludeAllChannelsToPlaylist(settingsResult.data.includeAllChannelsToPlaylist);
          }
          // Apply modern UI setting (default to v3 if never set or migrating to v3 default)
          let modernUiVal = settingsResult.data.modernUiEnabled;
          let design: 'v1' | 'v2' | 'v3' = 'v3';

          if (!settingsResult.data.v3DefaultMigrated) {
            // First time running with V3 as default. Migrate new and old users.
            modernUiVal = 'v3';
            design = 'v3';
            setLiveTvDesign('v3');
            await window.storage.updateSettings({
              modernUiEnabled: 'v3',
              v3DefaultMigrated: true
            });
          } else {
            design = modernUiVal === 'v3' ? 'v3' : (modernUiVal === false || modernUiVal === 'v1' ? 'v1' : 'v2');
            setLiveTvDesign(design);
          }

          applyUiDesign(design);
        }

        const epgRefreshHours = settingsResult.data?.epgRefreshHours ?? 6;
        const vodRefreshHours = settingsResult.data?.vodRefreshHours ?? 24;
        // 0 = all at once (default), positive int = max parallel syncs
        const epgSyncConcurrency: number = settingsResult.data?.epgSyncConcurrency ?? 0;

        // Use sources from parallel load
        if (!sourcesResult.data || sourcesResult.data.length === 0) return;

        // Filter out VOD-only sources from channel sync
        const enabledSources = sourcesResult.data.filter((s: any) => s.enabled && !s.vod_only);
        // VOD sources eligible for auto-sync (Xtream & Stalker, not Live-TV-only)
        const vodSources = sourcesResult.data.filter((s: any) => (s.type === 'xtream' || s.type === 'stalker') && s.enabled && !s.live_tv_only);

        const hasCustomEpgRefresh = enabledSources.some((s: any) => s.custom_refresh_interval !== undefined && s.custom_refresh_interval !== null && s.custom_refresh_interval > 0);
        const hasCustomVodRefresh = vodSources.some((s: any) => s.custom_vod_refresh_interval !== undefined && s.custom_vod_refresh_interval !== null && s.custom_vod_refresh_interval > 0);

        const epgActive = epgRefreshHours > 0 || hasCustomEpgRefresh;
        const vodActive = vodRefreshHours > 0 || hasCustomVodRefresh;

        // Skip periodic check if no auto-refresh is active
        if (isPeriodic && !epgActive && !vodActive) {
          return;
        }

        let didSync = false;
        const syncedSourceIds: string[] = [];

        // ── Channel / EPG sync ──────────────────────────────────────────────
        if (epgActive) {
          const staleSources: any[] = [];
          for (const source of enabledSources) {
            if (await isEpgStale(source.id, epgRefreshHours)) staleSources.push(source);
          }

          if (staleSources.length > 0) {
            didSync = true;
            isAutoSyncingRef.current = true;
            setChannelSyncing(true);
            // 0 = run all at once; positive = batch size
            const CONCURRENCY = epgSyncConcurrency > 0 ? epgSyncConcurrency : staleSources.length || 1;
            const total = staleSources.length;
            const statusPrefix = isPeriodic ? i18n.t('common:autoSyncing') : i18n.t('common:syncing');
            for (let i = 0; i < total; i += CONCURRENCY) {
              const batch = staleSources.slice(i, i + CONCURRENCY);
              const batchNum = Math.floor(i / CONCURRENCY) + 1;
              const totalBatches = Math.ceil(total / CONCURRENCY);
              setSyncStatusMessage(i18n.t('common:syncingBatchWithPrefix', { prefix: statusPrefix, batch: batchNum, total: totalBatches, names: batch.map((s: any) => s.name).join(', ') }));
              await Promise.all(
                batch.map(async (source: any, idx: number) => {
                  const prefix = `[${i + idx + 1}/${total}] ${source.name}`;
                  const result = await syncSource(source, (msg) => setSyncStatusMessage(`${prefix}: ${msg}`));
                  if (result.success) {
                    syncedSourceIds.push(source.id);
                  } else {
                    useToastStore.getState().addToast(i18n.t('common:autoSyncFailed', { name: source.name, error: result.error }), 'error');
                  }
                })
              );
            }
            if (syncedSourceIds.length > 0) {
              setSyncStatusMessage(i18n.t('common:updatingGlobalEpgLinks'));
              await syncAllStaleGlobalEpgLinks((msg) => setSyncStatusMessage(msg), syncedSourceIds);
            }
            setSyncStatusMessage(null);
          }
        }

        // ── VOD sync (Xtream & Stalker) ─────────────────────────────────────
        if (vodActive) {
          if (vodSources.length > 0) {
            const staleVod: any[] = [];
            for (const source of vodSources) {
              if (await isVodStale(source.id, vodRefreshHours)) staleVod.push(source);
            }
            if (staleVod.length > 0) {
              didSync = true;
              isAutoSyncingRef.current = true;
              setVodSyncing(true);
              // VOD sync also uses epgSyncConcurrency (0 = all at once)
              const CONCURRENCY = epgSyncConcurrency > 0 ? epgSyncConcurrency : staleVod.length || 1;
              const total = staleVod.length;
              const statusPrefix = isPeriodic ? i18n.t('common:autoSyncing') : i18n.t('common:syncing');
              for (let i = 0; i < total; i += CONCURRENCY) {
                const batch = staleVod.slice(i, i + CONCURRENCY);
                const batchNum = Math.floor(i / CONCURRENCY) + 1;
                const totalBatches = Math.ceil(total / CONCURRENCY);
                setSyncStatusMessage(i18n.t('common:syncingVodBatchWithPrefix', { prefix: statusPrefix, batch: batchNum, total: totalBatches, names: batch.map((s: any) => s.name).join(', ') }));
                await Promise.all(batch.map((source: any) => syncVodForSource(source)));
              }
              setSyncStatusMessage(null);
            }
          }
        }

        if (isPeriodic && didSync) {
          console.log('[AutoSync] Periodic sync completed');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : i18n.t('common:autoSyncFailedGeneric');
        console.error('[AutoSync] Sync failed:', err);
        useToastStore.getState().addToast(msg, 'error');
      } finally {
        isAutoSyncingRef.current = false;
        setChannelSyncing(false);
        setVodSyncing(false);
      }
    };

    // Run initial sync
    performSyncCheck(false);

    // Set up periodic checking every 10 minutes
    const intervalId = setInterval(() => {
      performSyncCheck(true);
    }, AUTO_SYNC_CHECK_INTERVAL_MS);

    // Cleanup interval on unmount
    return () => clearInterval(intervalId);
  }, [setChannelSortOrder, setChannelSyncing, setVodSyncing, setSyncStatusMessage]);

  // ==========================================================================
  // Window Size Initialization
  // ==========================================================================
  useEffect(() => {
    const initWindowSize = async () => {
      try {
        if (!window.storage) return;
        const result = await window.storage.getSettings();
        const settings = result.data || {};

        // Seed the Rust minimize-to-tray flag so close-to-tray works before the
        // user ever opens Settings in this session.
        if (typeof settings.minimizeToTray === 'boolean') {
          invoke('set_minimize_to_tray', { enabled: settings.minimizeToTray }).catch(() => {});
        }

        const requestedWidth = settings.startupWidth || 1920;
        const requestedHeight = settings.startupHeight || 1080;

        const appWindow = getCurrentWindow();
        const [isMaximized, isFullscreen, monitor, scaleFactor] = await Promise.all([
          appWindow.isMaximized(),
          appWindow.isFullscreen(),
          currentMonitor(),
          appWindow.scaleFactor(),
        ]);

        let width = requestedWidth;
        let height = requestedHeight;

        if (monitor) {
          const maxWidth = monitor.size.width / scaleFactor;
          const maxHeight = monitor.size.height / scaleFactor;
          const fitScale = Math.min(maxWidth / requestedWidth, maxHeight / requestedHeight, 1);
          width = Math.min(maxWidth, Math.max(400, Math.floor(requestedWidth * fitScale)));
          height = Math.min(maxHeight, Math.max(300, Math.floor(requestedHeight * fitScale)));
        }

        console.log('[Startup Diagnostics]', {
          monitorSize: monitor ? `${monitor.size.width}x${monitor.size.height}` : 'null',
          scaleFactor,
          requestedSize: `${requestedWidth}x${requestedHeight}`,
          isMaximized,
          isFullscreen,
          resolvedSize: `${width}x${height}`,
        });

        if (isMaximized || isFullscreen) {
          // If the window starts up maximized or fullscreen, keep the state and bypass size/unmaximize updates.
          return;
        }
        await appWindow.setSize(new LogicalSize(width, height));
      } catch (err) {
        console.error('[App] Failed to resize window on startup:', err);
      }
    };
    initWindowSize();
  }, []);

  // ==========================================================================
  // DVR Initialization
  // ==========================================================================
  useEffect(() => {
    const initDvr = async () => {
      try {
        await invoke('init_dvr');
      } catch (error) {
        console.error('[App] Failed to initialize DVR:', error);
      }
    };
    initDvr();
  }, []);

  // ==========================================================================
  // Check for Updates
  // ==========================================================================
  useEffect(() => {
    const checkUpdates = async () => {
      await new Promise(resolve => setTimeout(resolve, 5000));
      await checkForUpdatesSilent();
    };
    checkUpdates();
  }, []);

  // ==========================================================================
  // Check for What's New (First launch / update)
  // ==========================================================================
  useEffect(() => {
    const checkWhatsNew = async () => {
      try {
        const currentVersion = await getVersion();
        setAppVersion(currentVersion);
        const lastVersion = localStorage.getItem('ynotv_last_version');
        if (!lastVersion || lastVersion !== currentVersion) {
          setWhatsNewModalOpen(true);
          localStorage.setItem('ynotv_last_version', currentVersion);
        }
      } catch (err) {
        console.error('[App] Failed to check for What\'s New:', err);
      }
    };
    checkWhatsNew();
  }, []);

  // ==========================================================================
  // Render
  // ==========================================================================
  const isStremioOrNuvio = playbackSourceView === 'stremio' || playbackSourceView === 'nuvio';
  const currentStremioMeta = isStremioOrNuvio ? (activeStremioMeta || stremioMetaRef.current) : null;
  const currentStremioEpisode = isStremioOrNuvio ? (activeStremioEpisode || stremioEpisodeVideoRef.current) : null;
  const isSeriesPlayback = isStremioOrNuvio ? currentStremioMeta?.type === 'series' : vodInfo?.type === 'series';

  const sourceNameMap = useSourceNameMap();
  const headerSourceName = useMemo(() => {
    if (!vodShowSourceBadge) return null;
    if (isStremioOrNuvio) {
      if (playbackSourceView === 'nuvio') return 'Nuvio';
      if (playbackSourceView === 'stremio') return 'Stremio';
      return null;
    }
    if (vodInfo?.source_id && sourceNameMap) {
      const found = sourceNameMap.get(vodInfo.source_id);
      if (found) return found;
    }
    if (vodInfo?.addonName) return vodInfo.addonName;
    return null;
  }, [vodShowSourceBadge, isStremioOrNuvio, vodInfo, sourceNameMap, playbackSourceView]);

  return (
    <div className={`app${showControls ? '' : ' controls-hidden'}${pipMode ? ' pip-mode' : ''}${!pipMode && sportsOverlayWidget === 'autohide' ? ' has-live-sports-autohide' : ''}${!pipMode && sportsOverlayWidget === 'persistent' ? ' has-live-sports-persistent' : ''}${!pipMode && recentOverlayWidget !== null ? ' has-recent-widget' : ''}${!pipMode && favoritesOverlayWidget ? ' has-favorites-widget' : ''} active-view-${activeView}${guideTransparent ? ' guide-transparent' : ''}`} onMouseMove={handleMouseMovePip}>
      <BackButtonOverlay
        visible={showControls && activeView === 'none' && !pipMode}
        sourceView={playbackSourceView}
        onBack={handleStop}
        title={
          isSeriesPlayback
            ? (isStremioOrNuvio
                ? cleanEpisodeName(currentStremioEpisode?.title, currentStremioMeta?.name, currentStremioEpisode?.episode)
                : cleanEpisodeName(vodInfo?.episodeInfo, vodInfo?.title, vodInfo?.episodeNum))
            : (isStremioOrNuvio ? (currentStremioMeta?.name || i18n.t('player:nowPlaying')) : (vodInfo?.title || i18n.t('player:nowPlaying')))
        }
        subtitle={
          isSeriesPlayback
            ? (isStremioOrNuvio
                ? `${currentStremioMeta?.name || 'Series'} · S${currentStremioEpisode?.season || 1} · E${currentStremioEpisode?.episode || 1}`
                : `${vodInfo?.title || 'Series'} · S${vodInfo?.seasonNum || 1} · E${vodInfo?.episodeNum || 1}`)
            : (isStremioOrNuvio
                ? `${currentStremioMeta?.name || ''}${currentStremioMeta?.year ? ` · ${currentStremioMeta.year}` : ''}`
                : `${vodInfo?.title || ''}${vodInfo?.year ? ` · ${vodInfo.year}` : ''}`)
        }
        quality={null}
        sourceName={headerSourceName}
        onOpenDetails={() => setShowPlaybackDetailsModal(true)}
      />
      <PlaybackDetailsModal
        open={showPlaybackDetailsModal}
        onClose={() => setShowPlaybackDetailsModal(false)}
        playbackSourceView={playbackSourceView}
        stremioMeta={currentStremioMeta}
        vodInfo={vodInfo}
        currentEpisode={currentStremioEpisode}
        onOpenAppDetails={() => {
          setShowPlaybackDetailsModal(false);
          handleStop();
        }}
        onPlayEpisode={(video) => {
          const meta = currentStremioMeta;
          if (!meta) return;
          setShowPlaybackDetailsModal(false);
          setSourcePickerParams({
            source: playbackSourceView === 'nuvio' ? 'nuvio' : 'stremio',
            type: 'series',
            id: video.id,
            meta: meta,
            video: video,
          });
        }}
        onPlayVodInfo={(info) => {
          setShowPlaybackDetailsModal(false);
          handlePlayVodWrapper(info, () => setActiveView('none'));
        }}
        onSelectRecommendation={(item: RecommendationItem) => {
          setShowPlaybackDetailsModal(false);
          handleStop();
          const isStremio = playbackSourceView === 'stremio';
          const isNuvio = playbackSourceView === 'nuvio';

          if (isStremio || isNuvio) {
            const isSeries = (currentStremioMeta?.type || vodInfo?.type) === 'series';
            const newMeta: StremioMeta = {
              id: `tmdb:${item.id}`,
              type: isSeries ? 'series' : 'movie',
              name: item.title,
              poster: item.posterUrl ?? undefined,
              year: item.year ? parseInt(item.year, 10) : undefined,
              imdbRating: item.rating > 0 ? String(item.rating.toFixed(1)) : undefined,
            };
            const store = useUIStore.getState();
            if (isNuvio) {
              store.nuvioNavigate({ view: 'detail', meta: newMeta as any } as any);
              setActiveView('nuvio');
            } else {
              store.setStremioActiveMeta(newMeta);
              store.setStremioView('detail');
              setActiveView('stremio');
            }
          } else {
            const isSeries = vodInfo?.type === 'series' || playbackSourceView === 'series';
            const store = useUIStore.getState();
            if (isSeries) {
              store.setSeriesSearchQuery(item.title);
              store.setSeriesSelectedItem(null);
              setActiveView('series');
            } else {
              store.setMoviesSearchQuery(item.title);
              store.setMoviesSelectedItem(null);
              setActiveView('movies');
            }
          }
        }}
      />
      {/* Premium VOD & Stremio Loading Overlay */}
      {vodLoadingInfo && (
        <div className="vod-loading-overlay">
          {vodLoadingInfo.backdropUrl && (
            <img
              className="vod-loading-overlay__backdrop"
              src={vodLoadingInfo.backdropUrl}
              alt=""
              aria-hidden="true"
            />
          )}
          <div className="vod-loading-overlay__content">
            {vodLoadingInfo.logoUrl ? (
              <img
                className="vod-loading-overlay__logo"
                src={vodLoadingInfo.logoUrl}
                alt={vodLoadingInfo.title}
              />
            ) : (
              <div className="vod-loading-overlay__title">
                {vodLoadingInfo.title}
              </div>
            )}
            {vodLoadingInfo.episodeInfo ? (
              <div className="vod-loading-overlay__subtitle">
                {vodLoadingInfo.episodeInfo}
              </div>
            ) : vodLoadingInfo.year ? (
              <div className="vod-loading-overlay__subtitle">
                {vodLoadingInfo.year}
              </div>
            ) : null}
          </div>
        </div>
      )}
      {/* Custom title bar for frameless window */}
      <div className={`title-bar${showControls ? ' visible' : ''}${pipMode ? ' pip-mode' : ''}${(currentChannel && activeView === 'none') ? ' video-active' : ''} active-view-${activeView}`} data-tauri-drag-region>
        <div className="title-bar-left-group" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        </div>

        <div className="title-bar-spacer"></div>

        {/* Center Section: Unified Navigation Bar */}
        <div className="title-bar-content">
          <div className="title-bar-unified">
            {/* Segmented Control for View Switching */}
            <div className="title-bar-segmented">
              <button
                className={`segmented-btn ${activeView === 'guide' || (activeView === 'none' && categoriesOpen) ? 'active' : ''}`}
                onClick={() => {
                  if (activeView === 'guide') {
                    if (guideTransparent) {
                      setGuideTransparent(false);
                      setCategoriesOpen(!categoriesHidden);
                    } else {
                      // LiveTV is open, close it entirely
                      setActiveView('none');
                      setCategoriesOpen(false);
                    }
                  } else {
                    // Open LiveTV, respect user's category hidden preference
                    setActiveView('guide');
                    setCategoriesOpen(!categoriesHidden);
                  }
                }}
                title={i18n.t('nav:items.liveTv')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
                  <polyline points="17 2 12 7 7 2"></polyline>
                </svg>
                <span>{i18n.t('nav:items.liveTv')}</span>
              </button>

              {!navHiddenTabs.includes('movies') && (
                <button
                  className={`segmented-btn ${activeView === 'movies' ? 'active' : ''}`}
                  onClick={() => {
                    setCategoriesOpen(false);
                    setActiveView(activeView === 'movies' ? 'none' : 'movies');
                  }}
                  title={i18n.t('nav:items.movies')}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12"></path>
                    <path d="M8 4l0 16"></path>
                    <path d="M16 4l0 16"></path>
                    <path d="M4 8l4 0"></path>
                    <path d="M4 16l4 0"></path>
                    <path d="M4 12l16 0"></path>
                    <path d="M16 8l4 0"></path>
                    <path d="M16 16l4 0"></path>
                  </svg>
                  <span>{i18n.t('nav:items.movies')}</span>
                </button>
              )}

              {!navHiddenTabs.includes('series') && (
                <button
                  className={`segmented-btn ${activeView === 'series' ? 'active' : ''}`}
                  onClick={() => {
                    setCategoriesOpen(false);
                    setActiveView(activeView === 'series' ? 'none' : 'series');
                  }}
                  title={i18n.t('nav:items.series')}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 9a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -9"></path>
                    <path d="M16 3l-4 4l-4 -4"></path>
                  </svg>
                  <span>{i18n.t('nav:items.series')}</span>
                </button>
              )}

              {!navHiddenTabs.includes('dvr') && (
                <button
                  className={`segmented-btn ${activeView === 'dvr' ? 'active' : ''}`}
                  onClick={() => {
                    setCategoriesOpen(false);
                    setActiveView(activeView === 'dvr' ? 'none' : 'dvr');
                  }}
                  title={i18n.t('nav:items.dvr')}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 10l4.553-2.276A1 1 0 0 1 21 8.618v6.764a1 1 0 0 1-1.447.894L15 14M5 18h8a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2z"></path>
                  </svg>
                  <span>{i18n.t('nav:items.dvr')}</span>
                </button>
              )}

              {!navHiddenTabs.includes('sports') && (
                <button
                  className={`segmented-btn ${activeView === 'sports' ? 'active' : ''}`}
                  onClick={() => {
                    setCategoriesOpen(false);
                    setActiveView(activeView === 'sports' ? 'none' : 'sports');
                  }}
                  title={i18n.t('nav:items.sports')}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 21h8"></path>
                    <path d="M12 17v4"></path>
                    <path d="M7 4h10"></path>
                    <path d="M17 4v8a5 5 0 0 1-10 0V4"></path>
                    <path d="M5 9c-1.5 0-3 .6-3 2 0 1.4 1.5 2 3 2"></path>
                    <path d="M19 9c1.5 0 3 .6 3 2 0 1.4-1.5 2-3 2"></path>
                  </svg>
                  <span>{i18n.t('nav:items.sports')}</span>
                </button>
              )}

              {!navHiddenTabs.includes('stremio') && (
                <button
                  className={`segmented-btn ${activeView === 'stremio' ? 'active' : ''}`}
                  onClick={() => {
                    setCategoriesOpen(false);
                    setActiveView(activeView === 'stremio' ? 'none' : 'stremio');
                  }}
                  title={i18n.t('nav:items.stremioAddons')}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 4h16v16H4z" />
                    <path d="M8 8h8v8H8z" />
                    <path d="M8 12h8" />
                    <path d="M12 8v8" />
                  </svg>
                  <span>{i18n.t('nav:items.stremio')}</span>
                </button>
              )}

              {!navHiddenTabs.includes('nuvio') && (
                <button
                  className={`segmented-btn ${activeView === 'nuvio' ? 'active' : ''}`}
                  onClick={() => {
                    setCategoriesOpen(false);
                    setActiveView(activeView === 'nuvio' ? 'none' : 'nuvio');
                  }}
                  title={i18n.t('nav:items.nuvio')}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                  </svg>
                  <span>{i18n.t('nav:items.nuvio')}</span>
                </button>
              )}
            </div>

            <div className="unified-divider"></div>

            {/* Integrated Search */}
            <div className="title-bar-search-integrated">
              <svg className="title-bar-search-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"></circle>
                <path d="m21 21-4.3-4.3"></path>
              </svg>
              <input
                ref={titleBarSearchRef}
                type="text"
                className="title-bar-search-input"
                placeholder={i18n.t('common:searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => {
                  const value = e.target.value;
                  setSearchQuery(value);
                  // If user manually changes the query (not from the modal), clear forced filters
                  if (value !== advancedSearchConfig.query) {
                    setForceAdvancedFilters(false);
                  }
                  if (value.length >= 1) {
                    setCategoriesOpen(true);
                    if (activeView !== 'guide') {
                      setActiveView('guide');
                    }
                  }
                }}
                onFocus={() => {
                  setShowTitlebarHistory(true);
                  if (!isSearchMode && activeView !== 'guide') {
                    setCategoriesOpen(true);
                    setActiveView('guide');
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const val = searchQuery.trim();
                    if (val) {
                      titlebarSearchHistory.addToHistory(val);
                    }
                    setShowTitlebarHistory(false);
                  }
                }}
              />
              {searchQuery && (
                <button
                  className="title-bar-search-clear"
                  onClick={() => {
                    setSearchQuery('');
                    setForceAdvancedFilters(false);
                  }}
                  title={i18n.t('common:clearSearch')}
                >
                  ✕
                </button>
              )}
              <button
                className="title-bar-advanced-search-btn"
                onClick={() => setShowAdvancedSearch(true)}
                title={i18n.t('epg:advancedSearch')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"></circle>
                  <path d="m21 21-4.3-4.3"></path>
                  <line x1="21" y1="3" x2="21" y2="7"></line>
                  <line x1="19" y1="5" x2="23" y2="5"></line>
                </svg>
              </button>
              {showTitlebarHistory && titlebarSearchHistory.history.length > 0 && (
                <div className="title-bar-search-history" ref={titlebarHistoryRef}>
                  {titlebarSearchHistory.history.map((item) => (
                    <div
                      key={item}
                      className="title-bar-search-history-item"
                      onMouseDown={() => {
                        setSearchQuery(item);
                        setShowTitlebarHistory(false);
                        setCategoriesOpen(true);
                        if (activeView !== 'guide') {
                          setActiveView('guide');
                        }
                      }}
                    >
                      <svg className="title-bar-search-history-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                      <span className="title-bar-search-history-text">{item}</span>
                      <button
                        className="title-bar-search-history-remove"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          titlebarSearchHistory.removeFromHistory(item);
                        }}
                        title={i18n.t('common:remove')}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <div
                    className="title-bar-search-history-clear-all"
                    onMouseDown={() => {
                      titlebarSearchHistory.clearHistory();
                      setShowTitlebarHistory(false);
                    }}
                  >
                    Clear search history
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="title-bar-right-indicators" style={{ display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'flex-end' }}>
          {hasActiveRecording && (
            <div className="title-bar-recording-indicator">
              <RecordingIndicator size="small" variant="recording" />
            </div>
          )}
          <DownloadIndicator size="small" />
        </div>

        {/* Multiview Layout Picker */}
        {!(activeView === 'none' && playbackSourceView) && (
          <LayoutPicker
            currentLayout={multiviewLayout}
            onSelect={switchLayout}
            engineMode={multiviewEngineMode}
            onEngineChange={setMultiviewEngineMode}
            isHeroPage={activeView === 'none'}
            onOpenChange={setLayoutPickerOpen}
          />
        )}

        {/* Calendar Button */}
        {!navHiddenTabs.includes('calendar') && (
          <button
            className={`title-bar-calendar-btn ${activeView === 'calendar' ? 'active' : ''}`}
            onClick={() => {
              setCategoriesOpen(false);
              setActiveView(activeView === 'calendar' ? 'none' : 'calendar');
            }}
            title={i18n.t('settings:tvcalendar.title')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12z" />
              <path d="M16 3v4" />
              <path d="M8 3v4" />
              <path d="M4 11h16" />
            </svg>
          </button>
        )}

        {/* Google Cast Button */}
        {!navHiddenTabs.includes('cast') && (
          <CastButton castEnabled={castEnabled} onCastCurrentStream={castCurrentMedia} onCastEnabledChange={setCastEnabled} />
        )}

        {/* Settings Button */}
        <button
          className={`title-bar-settings-btn ${(showSettingsPopup || activeView === 'settings') ? 'active' : ''}`}
          onClick={() => {
            // In multiview (not main), use full view mode; otherwise use popup
            if (multiviewLayout !== 'main') {
              setCategoriesOpen(false);
              setActiveView(activeView === 'settings' ? 'none' : 'settings');
            } else {
              // In main layout, settings is a popup - don't close categories
              setShowSettingsPopup(!showSettingsPopup);
            }
            setSettingsTab('sources');
            setEditSourceId(null);
          }}
          title={i18n.t('nav:items.settings')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        </button>

        <div className="window-controls">
          <button onClick={handleMinimize} title={i18n.t('common:minimize')} aria-label={i18n.t('common:minimize')}>
            <svg className="window-control-icon" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M1 6.5h10" />
            </svg>
          </button>
          <button
            onClick={handleMaximize}
            title={isMaximized || isFullscreen ? i18n.t('common:restoreDown') : i18n.t('common:maximize')}
            aria-label={isMaximized || isFullscreen ? i18n.t('common:restoreDown') : i18n.t('common:maximize')}
          >
            {isMaximized || isFullscreen ? (
              <svg className="window-control-icon" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3.5 3.5h7v7h-7zM1.5 8.5v-7h7" />
              </svg>
            ) : (
              <svg className="window-control-icon" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="1.5" y="1.5" width="9" height="9" />
              </svg>
            )}
          </button>
          <button onClick={handleClose} className="close" title={i18n.t('common:close')} aria-label={i18n.t('common:close')}>
            <svg className="window-control-icon" viewBox="0 0 12 12" aria-hidden="true">
              <path d="m1.5 1.5 9 9m0-9-9 9" />
            </svg>
          </button>
        </div>
      </div>

      {/* Background - transparent over mpv */}
      <div className="video-background">
        {/* Fullscreen Audio Visualizer for Audio-Only Channels - ONLY when playing audio-only stream */}
        {currentChannel && playing && activeView === 'none' && isAudioOnly && audioVisualizerMode !== 'off' && (
          <AudioVisualizer
            mode={audioVisualizerMode}
            channel={currentChannel}
            playing={playing}
            programTitle={currentProgram?.title}
            onModeChange={handleSetAudioVisualizerMode}
          />
        )}

        {!currentChannel && !error && !isRestoring && activeView !== 'guide' && activeView !== 'sports' && (
          <div className="placeholder">
            <Logo className="placeholder__logo" />
            {(channelSyncing || vodSyncing || tmdbMatching) ? (
              <div className="sync-status">
                <div className="sync-status__spinner" />
                <span className="sync-status__text">
                  {syncStatusMessage || (channelSyncing && vodSyncing
                    ? i18n.t('common:syncingChannelsAndVod')
                    : channelSyncing
                      ? i18n.t('common:syncingChannels')
                      : vodSyncing
                        ? i18n.t('common:syncingVod')
                        : i18n.t('common:matchingTmdb'))}
                </span>
              </div>
            ) : (
              <div className="placeholder__spacer" />
            )}
          </div>
        )}

        {error && activeView !== 'guide' && (
          <VideoErrorOverlay
            error={error}
            onDismiss={() => setError(null)}
          />
        )}

        {/* Stream retry overlay — shown in fullscreen/main view (not when LiveTV guide is open) */}
        {retryState?.isRetrying && activeView !== 'guide' && (
          <StreamRetryOverlay retryState={retryState} />
        )}

        {/* Failover overlay — shown when switching to backup stream */}
        {failoverState?.isFailingOver && activeView !== 'guide' && (
          <FailoverOverlay state={failoverState} />
        )}

        {/* Channel loading & buffering overlay */}
        {loadingState !== 'idle' && !retryState?.isRetrying && !failoverState?.isFailingOver && activeView !== 'guide' && (
          <ChannelLoadingOverlay
            channelName={currentChannel?.name || 'Channel'}
            loadingState={loadingState}
          />
        )}

        {/* Commented out so it is not shown, per user request. Kept here to add back later if needed.
        isCasting && (
          <CastOverlay
            deviceName={castDeviceName}
            mediaTitle={castMetadataState.title}
            mediaSubtitle={castMetadataState.subtitle}
            onDisconnect={handleDisconnectCast}
          />
        )
        */}
      </div>

      {/* Video double-click overlay - captures double-clicks on video area to toggle fullscreen */}
      {activeView === 'none' && multiviewLayout === 'main' && (
        <div
          className="video-doubleclick-overlay"
          onClick={(e) => {
            if (e.button === 0 && overlayOnClickOnly && playing) {
              setShowControls((prev) => !prev);
            }
          }}
          onDoubleClick={() => {
            handleToggleFullscreen();
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setBgContextMenu({ x: e.clientX, y: e.clientY });
          }}
        />
      )}

      {/* Live Sports Overlay Widget */}
      {sportsOverlayWidget && !pipMode && !(currentChannel?.stream_id === 'vod' || currentChannel?.stream_id?.startsWith('recording_')) && multiviewLayout !== 'sbs' && multiviewLayout !== 'bigbottom' && multiviewLayout !== '2x2' && (
        <LiveSportsOverlay
          mode={sportsOverlayWidget}
          showControls={showControls}
          activeView={activeView}
        />
      )}

      {/* Overlay Widgets — all sit inside a shared WidgetBar flex container.
           The bar owns positioning and scale; widgets are just flex children.
           Adding more widgets here is trivial — they automatically line up. */}
      {(recentOverlayWidget || favoritesOverlayWidget || whatsNextOverlayWidget || customGroupWidgetIds.length > 0) &&
        !pipMode &&
        !(currentChannel?.stream_id === 'vod' || currentChannel?.stream_id?.startsWith('recording_')) &&
        multiviewLayout !== 'sbs' &&
        multiviewLayout !== 'bigbottom' &&
        multiviewLayout !== '2x2' && (
        <WidgetBar cioEnabled={channelInfoOverlayEnabled} playerControlDesign={playerControlDesign}>
          {(() => {
            const activeWidgets: string[] = [];
            if (recentOverlayWidget) activeWidgets.push('recent');
            if (favoritesOverlayWidget) activeWidgets.push('favorites');
            if (whatsNextOverlayWidget) activeWidgets.push('whats-next');
            customGroupWidgetIds.forEach((id) => activeWidgets.push(`custom-${id}`));

            const sortedActive = [...activeWidgets].sort((a, b) => {
              let idxA = widgetOrder.indexOf(a);
              let idxB = widgetOrder.indexOf(b);
              if (idxA === -1) idxA = 999;
              if (idxB === -1) idxB = 999;
              return idxA - idxB;
            });

            return sortedActive.map((widgetId, index) => {
              const isFirst = index === 0;
              const isLast = index === sortedActive.length - 1;
              const moveLeft = !isFirst ? () => handleMoveWidget(widgetId, -1) : undefined;
              const moveRight = !isLast ? () => handleMoveWidget(widgetId, 1) : undefined;

              if (widgetId === 'recent') {
                return (
                  <RecentChannelsWidget
                    key={widgetId}
                    showControls={showControls}
                    activeView={activeView}
                    onChannelClick={handlePlayChannelWrapper}
                    limit={recentOverlayWidget === '10' ? 10 : 5}
                    isVod={Boolean(currentChannel?.stream_id === 'vod' || currentChannel?.stream_id?.startsWith('recording_'))}
                    onMoveLeft={moveLeft}
                    onMoveRight={moveRight}
                  />
                );
              }
              if (widgetId === 'favorites') {
                return (
                  <FavoritesWidget
                    key={widgetId}
                    showControls={showControls}
                    activeView={activeView}
                    onChannelClick={handlePlayChannelWrapper}
                    isVod={Boolean(currentChannel?.stream_id === 'vod' || currentChannel?.stream_id?.startsWith('recording_'))}
                    onMoveLeft={moveLeft}
                    onMoveRight={moveRight}
                  />
                );
              }
              if (widgetId === 'whats-next') {
                return (
                  <WhatsNextWidget
                    key={widgetId}
                    channel={currentChannel}
                    showControls={showControls}
                    activeView={activeView}
                    isVod={Boolean(currentChannel?.stream_id === 'vod' || currentChannel?.stream_id?.startsWith('recording_'))}
                    onMoveLeft={moveLeft}
                    onMoveRight={moveRight}
                  />
                );
              }
              if (widgetId.startsWith('custom-')) {
                const groupId = widgetId.replace('custom-', '');
                return (
                  <CustomGroupWidget
                    key={widgetId}
                    groupId={groupId}
                    showControls={showControls}
                    activeView={activeView}
                    onChannelClick={handlePlayChannelWrapper}
                    isVod={Boolean(currentChannel?.stream_id === 'vod' || currentChannel?.stream_id?.startsWith('recording_'))}
                    onMoveLeft={moveLeft}
                    onMoveRight={moveRight}
                  />
                );
              }
              return null;
            });
          })()}
        </WidgetBar>
      )}

      {/* Background Context Menu */}
      {bgContextMenu && (
        <BackgroundContextMenu
          position={bgContextMenu}
          sportsWidget={sportsOverlayWidget}
          recentWidget={recentOverlayWidget}
          favoritesWidget={favoritesOverlayWidget}
          whatsNextWidget={whatsNextOverlayWidget}
          customGroupIds={customGroupWidgetIds}
          onAddSportsAutohide={() => handleAddSportsOverlay('autohide')}
          onAddSportsPersistent={() => handleAddSportsOverlay('persistent')}
          onRemoveSports={handleRemoveSportsOverlay}
          onAddRecent5={handleAddRecent5Overlay}
          onAddRecent10={handleAddRecent10Overlay}
          onRemoveRecent={handleRemoveRecentOverlay}
          onAddFavorites={handleAddFavoritesOverlay}
          onRemoveFavorites={handleRemoveFavoritesOverlay}
          onAddWhatsNext={handleAddWhatsNextOverlay}
          onRemoveWhatsNext={handleRemoveWhatsNextOverlay}
          onRemoveCustomGroup={handleRemoveCustomGroupWidget}
          onAddCustomGroup={() => setGroupPickerOpen(true)}
          onClose={() => setBgContextMenu(null)}
        />
      )}

      {/* Hero Screen Widgets Sidebar Panel */}
      {activeView === 'none' && !currentChannel && !error && !isRestoring && multiviewLayout !== 'sbs' && multiviewLayout !== 'bigbottom' && multiviewLayout !== '2x2' && (
        <HeroWidgetsPanel
          sportsWidget={sportsOverlayWidget}
          recentWidget={recentOverlayWidget}
          favoritesWidget={favoritesOverlayWidget}
          whatsNextWidget={whatsNextOverlayWidget}
          customGroupIds={customGroupWidgetIds}
          onAddSportsAutohide={() => handleAddSportsOverlay('autohide')}
          onAddSportsPersistent={() => handleAddSportsOverlay('persistent')}
          onRemoveSports={handleRemoveSportsOverlay}
          onAddRecent5={handleAddRecent5Overlay}
          onAddRecent10={handleAddRecent10Overlay}
          onRemoveRecent={handleRemoveRecentOverlay}
          onAddFavorites={handleAddFavoritesOverlay}
          onRemoveFavorites={handleRemoveFavoritesOverlay}
          onAddWhatsNext={handleAddWhatsNextOverlay}
          onRemoveWhatsNext={handleRemoveWhatsNextOverlay}
          onRemoveCustomGroup={handleRemoveCustomGroupWidget}
          onAddCustomGroup={() => setGroupPickerOpen(true)}
          liveTvDesign={liveTvDesign}
        />
      )}

      {/* Custom Group Picker Modal */}
      {groupPickerOpen && (
        <GroupPickerModal
          activeGroupIds={customGroupWidgetIds}
          onAdd={handleAddCustomGroupWidget}
          onRemove={handleRemoveCustomGroupWidget}
          onClose={() => setGroupPickerOpen(false)}
        />
      )}

      {/* Skip Intro Button */}
      <SkipIntroButton
        visible={skipIntro.showButton}
        countdown={skipIntro.countdown}
        onSkip={skipIntro.handleSkip}
      />

      {/* Active playlist queue overlay */}
      <PlaylistQueueModal
        isOpen={playlistQueueOpen}
        onClose={() => setPlaylistQueueOpen(false)}
        onPlayItem={(index) => {
          setPlaylistQueueOpen(false);
          playPlaylistItemAt(index);
        }}
      />

      {/* Now Playing Bar (hidden in PiP mode) */}
      <NowPlayingBar
        visible={
          showControls &&
          !pipMode &&
          activeView !== 'guide' &&
          !categoriesOpen &&
          multiviewLayout !== '2x2' &&
          multiviewLayout !== 'bigbottom'
        }
        channel={currentChannel}
        playing={playing}
        muted={muted}
        volume={volume}
        hasAudioDelay={hasAudioDelay}
        mpvReady={mpvReady}
        position={position}
        duration={duration}
        isVod={currentChannel?.stream_id === 'vod' || currentChannel?.stream_id?.startsWith('recording_')}
        vodInfo={vodInfo}
        isCatchup={isCatchup}
        catchupInfo={catchupInfo}
        channelInfoOverlayEnabled={channelInfoOverlayEnabled}
        playerControlDesign={playerControlDesign}
        showVolumePercent={showVolumePercent}
        onToggleTransparentGuide={
          playbackSourceView === 'movies' ||
          playbackSourceView === 'series' ||
          playbackSourceView === 'stremio' ||
          playbackSourceView === 'nuvio' ||
          vodInfo != null
            ? undefined
            : handleToggleTransparentGuide
        }
        guideTransparent={guideTransparent}
        isAudioOnly={isAudioOnly}
        audioVisualizerMode={audioVisualizerMode}
        onSetAudioVisualizerMode={handleSetAudioVisualizerMode}
        onTogglePlay={handleTogglePlay}
        onStop={handleStop}
        onToggleMute={handleToggleMute}
        onVolumeChange={handleVolumeChange}
        onSeek={handleSeek}
        onVolumeDragStart={() => { volumeDraggingRef.current = true; }}
        onVolumeDragEnd={() => { volumeDraggingRef.current = false; }}
        onMouseEnter={() => { controlsHoveredRef.current = true; }}
        onMouseLeave={() => { controlsHoveredRef.current = false; }}
        onCycleSubtitle={handleCycleSubtitle}
        onCycleAudio={handleCycleAudio}
        onToggleStats={handleToggleStats}
        onToggleFullscreen={handleToggleFullscreen}
        onShowSubtitleModal={handleShowSubtitleModal}
        onShowAudioModal={handleShowAudioModal}
        onGoToLive={() => currentChannel && handlePlayChannelWrapper(currentChannel)}
        onCatchupSeek={handleCatchupSeek}
        timeshiftEnabled={timeshiftEnabled}
        timeshiftState={timeshiftState}
        onTimeshiftCatchUp={() => {
          if (timeshiftState) {
            handleSeek(Math.max(0, timeshiftState.cacheEnd - liveBufferOffset));
          }
        }}
        onChannelUp={handleChannelUp}
        onChannelDown={handleChannelDown}
        onPlaylistQueueClick={() => setPlaylistQueueOpen(true)}
        onPlaylistPreviousItem={handlePlaylistPrevious}
        onPlaylistNextItem={handlePlaylistNext}
        aspectRatio={heroAspectRatio}
        onSetAspectRatio={handleSetAspectRatio}
        onNavigateDvr={() => setActiveView('dvr')}
        onReplayStream={currentChannel ? () => handlePlayChannelWrapper(currentChannel) : undefined}
        onSwitchStream={handleSwitchStream}
        compiledBadgeRules={compiledBadgeRules}
        compiledNuvioBadgeRules={compiledNuvioBadgeRules}
        pipMode={pipMode}
        onTogglePip={togglePip}
        overlay={
          <FailoverGroupOverlay
            currentChannel={currentChannel}
            visible={isFailoverGroupOverlayVisible}
            onChannelClick={handlePlayChannelWrapper}
            showSource={failoverGroupShowSource}
          />
        }
      />

      {/* PiP drag overlay + media bar */}
      {pipMode && (
        <>
          <div
            className="pip-drag-overlay"
            onMouseDown={(e) => {
              getCurrentWindow().startDragging().catch(() => {});
            }}
            onDoubleClick={() => handleTogglePip()}
          />
          <PiPMediaBar
            visible={pipControlsVisible}
            playing={playing}
            muted={muted}
            volume={volume}
            position={position}
            duration={duration}
            isVod={currentChannel?.stream_id === 'vod' || currentChannel?.stream_id?.startsWith('recording_')}
            timeshiftState={timeshiftState}
            aspectRatio={pipAspectRatio}
            onTogglePlay={handleTogglePlay}
            onToggleMute={handleToggleMute}
            onVolumeChange={handleVolumeChange}
            onSeek={handleSeek}
            onExitPip={handleTogglePip}
            onSetAspectRatio={handleSetPipAspectRatio}
          />
        </>
      )}

      {/* Channel Info Overlay */}
      <ChannelInfoOverlay
        channel={currentChannel}
        visible={isChannelInfoOverlayVisible}
        hideDescription={channelInfoOverlayHideDescription}
        hideMetaBadge={channelInfoOverlayHideMetaBadge}
        hideLogo={channelInfoOverlayHideLogo}
        hideTimer={channelInfoOverlayHideTimer}
        overlayPosition={channelInfoOverlayPosition}
        logoShape={channelInfoOverlayLogoShape}
        isCatchup={isCatchup}
        catchupInfo={catchupInfo}
        position={position}
        duration={duration}
      />

      {/* Multiview Layout */}
      {multiviewLayout !== 'main' && (
        <MultiviewLayout
          hidden={activeView !== 'none'}
          layout={multiviewLayout}
          slots={multiviewSlots}
          engineMode={multiviewEngineMode}
          mainChannelName={currentChannel?.name || null}
          mainPlaying={playing}
          mainMuted={muted}
          mainVolume={volume}
          onMainTogglePlayPause={handleTogglePlay}
          onMainToggleMute={handleToggleMute}
          onMainSetVolume={(vol) => handleVolumeChange({ target: { value: vol.toString() } } as any)}
          onSwapWithMain={(slotId) => swapWithMain(slotId, multiviewSlots)}
          onMainStop={handleStop}
          onMainReload={currentChannel ? () => handlePlayChannelWrapper(currentChannel) : () => {}}
          onStop={stopSlot}
          onReload={reloadSlot}
          onSetProperty={setSlotProperty}
          onReposition={repositionSecondarySlots}
          onSwitchLayout={switchLayout}
          activeView={activeView}
          syncMpvGeometry={syncMpvGeometry}
        />
      )}

      {/* Track Selection Modals */}
      {currentChannel?.stream_id === 'vod' || currentChannel?.stream_id?.startsWith('recording_') ? (
        <SubtitleControlModal
          isOpen={showSubtitleModal}
          onClose={() => {
            controlsHoveredRef.current = false;
            setShowSubtitleModal(false);
            handleMouseMove();
          }}
          vodTitle={vodInfo?.title}
          vodYear={vodInfo?.year}
          seasonNum={vodInfo?.seasonNum}
          episodeNum={vodInfo?.episodeNum}
          tmdbId={vodInfo?.tmdbId || (vodInfo as any)?.tmdb_id}
          imdbId={
            vodInfo?.imdbId ||
            (vodInfo as any)?.imdb_id ||
            (vodInfo?.stremioId && vodInfo.stremioId.startsWith('tt') ? vodInfo.stremioId.split(/[:_]/)[0] : undefined) ||
            (vodInfo?.mediaId && vodInfo.mediaId.startsWith('tt') ? vodInfo.mediaId.split(/[:_]/)[0] : undefined)
          }
          vodSourceId={vodInfo?.source_id}
          vodMediaId={vodInfo?.mediaId}
        />
      ) : (
        <TrackSelectionModal
          isOpen={showSubtitleModal}
          type="subtitle"
          onClose={() => {
            controlsHoveredRef.current = false;
            setShowSubtitleModal(false);
            handleMouseMove();
          }}
        />
      )}
      <StalkerSubtitleModal />

      <TrackSelectionModal
        isOpen={showAudioModal}
        type="audio"
        channel={currentChannel}
        onAudioDelayChanged={setHasAudioDelay}
        onClose={() => {
          controlsHoveredRef.current = false;
          setShowAudioModal(false);
          handleMouseMove();
        }}
      />

      {/* Advanced Search Modal */}
      <AdvancedSearchModal
        isOpen={showAdvancedSearch}
        initialConfig={advancedSearchConfig}
        onSearch={(config) => {
          setAdvancedSearchConfig(config);
          // Persist settings
          if (window.storage) {
            window.storage.updateSettings({
              advancedSearchScope: config.scope,
              advancedSearchSourceIds: config.sourceIds,
              advancedSearchCategoryIds: config.categoryIds,
              useAdvancedSearchForRegular: config.useForRegular,
            }).catch((err: any) => console.error('Failed to save advanced search settings:', err));
          }
          // Update local state setters
          setAdvancedSearchScope(config.scope);
          setAdvancedSearchSourceIds(config.sourceIds);
          setAdvancedSearchCategoryIds(config.categoryIds);
          setUseAdvancedSearchForRegular(config.useForRegular);
          // Force advanced filters for this search (even if useForRegular is off)
          setForceAdvancedFilters(true);
          // Set the search query and activate search
          setSearchQuery(config.query);
          setCategoriesOpen(true);
          if (activeView !== 'guide') {
            setActiveView('guide');
          }
          setShowAdvancedSearch(false);
          // Focus the search input
          setTimeout(() => {
            if (titleBarSearchRef.current) {
              titleBarSearchRef.current.focus();
            }
          }, 50);
        }}
        onClose={() => setShowAdvancedSearch(false)}
      />

      {/* V3 Liquid Glass Background */}
      {(() => {
        const isPreviewView = activeView === 'guide' || activeView === 'sports';
        const isPageOverlayView = activeView !== 'guide' && activeView !== 'sports' && activeView !== 'none';
        const hasPreviewRect = !!previewVideoRect;
        const shouldRenderGlassBg = liveTvDesign === 'v3' && (
          isPageOverlayView ||
          (isPreviewView && !guideTransparent && (!currentChannel || hasPreviewRect)) ||
          (activeView === 'none' && !currentChannel)
        );

        if (!shouldRenderGlassBg) return null;

        return (
          <div 
            className={`livetv-liquid-glass-bg ${randomScheme}`}
            style={
              previewVideoRect && currentChannel
                ? (() => {
                    // Build a clip-path using SVG path() so we can use arc commands
                    // for the rounded corners (20px radius, matching the CSS border-radius).
                    // Technique: draw the full-screen rect (outer) then the rounded-rect
                    // video cutout (inner) as a sub-path. The browser's evenodd fill rule
                    // makes the inner shape a transparent hole in the background.
                    //
                    // Zoom correction: .livetv-liquid-glass-bg lives inside .app which has
                    // `zoom: var(--app-zoom)` applied. That makes the element's local coordinate
                    // space equal to (viewport / zoom). getBoundingClientRect() always returns
                    // viewport CSS pixels, so we divide every coordinate by zoom to map into the
                    // element's local space. r stays as 20 because:
                    //   CSS border-radius 20px × zoom → 20*zoom visual px
                    //   → 20*zoom / zoom = 20 local px  ✓
                    const zoom = parseFloat(
                      getComputedStyle(document.documentElement).getPropertyValue('--app-zoom').trim()
                    ) || 1;
                    const r = 20; // border-radius in local px (zoom-invariant, see above)
                    const { left: vx, top: vy, width: vw, height: vh } = previewVideoRect;
                    // Convert viewport coords → element local coords
                    const x = vx / zoom;
                    const y = vy / zoom;
                    const w = vw / zoom;
                    const h = vh / zoom;
                    const W = window.innerWidth  / zoom;
                    const H = window.innerHeight / zoom;
                    // Outer rectangle (full screen in local space, clockwise)
                    const outer = `M 0 0 L ${W} 0 L ${W} ${H} L 0 ${H} Z`;
                    // Inner rounded rectangle (video cutout, clockwise — evenodd makes it a hole)
                    const inner = [
                      `M ${x + r} ${y}`,
                      `L ${x + w - r} ${y}`,                            // top edge
                      `A ${r} ${r} 0 0 1 ${x + w} ${y + r}`,           // top-right arc
                      `L ${x + w} ${y + h - r}`,                        // right edge
                      `A ${r} ${r} 0 0 1 ${x + w - r} ${y + h}`,       // bottom-right arc
                      `L ${x + r} ${y + h}`,                             // bottom edge
                      `A ${r} ${r} 0 0 1 ${x} ${y + h - r}`,           // bottom-left arc
                      `L ${x} ${y + r}`,                                 // left edge
                      `A ${r} ${r} 0 0 1 ${x + r} ${y}`,               // top-left arc
                      `Z`,
                    ].join(' ');
                    return { clipPath: `path(evenodd, '${outer} ${inner}')` };
                  })()
                : undefined
            }
          >
            <div className="glass-blob blob-1" />
            <div className="glass-blob blob-2" />
            <div className="glass-blob blob-3" />
            <div className="glass-blob blob-4" />
          </div>
        );
      })()}

      {/* Category Strip */}
      <CategoryStrip
        selectedCategoryId={categoryId}
        onSelectCategory={(catId) => {
          if (isSearchMode) {
            setSearchQuery('');
          }
          if (catId !== '__watchlist__') {
            setIsWatchlistMode(false);
          }
          handleSelectCategory(catId);
        }}
        visible={categoriesOpen}
        onEditSource={(sourceId) => {
          setSettingsTab('sources');
          setEditSourceId(sourceId);
          setActiveView('settings');
          setCategoriesOpen(false);
        }}
        onClose={() => {
          setCategoriesOpen(false);
          if (guideTransparent) {
            setCategoriesHiddenTransparent(true);
          } else {
            setCategoriesHidden(true);
          }
        }}
        onShow={() => {
          setCategoriesOpen(true);
          if (guideTransparent) {
            setCategoriesHiddenTransparent(false);
          } else {
            setCategoriesHidden(false);
          }
        }}
        isLiveTV={activeView === 'guide'}
      />

      {/* Channel Panel */}
      <ChannelPanel
        categoryId={isSearchMode || isWatchlistMode ? null : categoryId}
        visible={activeView === 'guide'}
        categoryStripOpen={categoriesOpen}
        onPlayChannel={handlePlayChannelWrapper}
        popoutMode={popoutMode}
        onTogglePopoutMode={cyclePopoutMode}
        onPlayInPopout={popoutSwapChannel}
        onPlayInExternal={handlePlayInExternal}
        popoutIsOpen={popoutIsOpen}
        onPlayCatchup={handlePlayCatchup}
        onPreviewVideoRectChange={setPreviewVideoRect}
        onClose={() => {
          setActiveView('none');
          setCategoriesOpen(false);
          Bridge.syncWindow();
        }}
        error={error}
        isSearchMode={isSearchMode}
        searchQuery={debouncedSearchQuery}
        searchChannels={searchChannels}
        searchPrograms={searchPrograms}
        searchScope={advancedSearchConfig.scope}
        isWatchlistMode={isWatchlistMode}
        watchlistItems={watchlistItems}
        onWatchlistRefresh={refreshWatchlist}
        currentLayout={multiviewLayout}
        multiviewEngineMode={multiviewEngineMode}
        onSendToSlot={sendToSlot}
        multiviewSlots={multiviewSlots}
        onSwapWithMain={(slotId) => swapWithMain(slotId, multiviewSlots)}
        onStopSlot={stopSlot}
        onReloadSlot={reloadSlot}
        showSettingsPopup={showSettingsPopup || layoutPickerOpen}
        includeSourceInSearch={includeSourceInSearch}
        searchResultsOrder={searchResultsOrder}
        epgMetadataBadgeResolution={epgMetadataBadgeResolution}
        epgMetadataBadgeFps={epgMetadataBadgeFps}
        epgMetadataBadgeSound={epgMetadataBadgeSound}
        currentChannel={currentChannel}
        onTogglePlay={handleTogglePlay}
        isPlaying={playing}
        onChannelUp={handleChannelUp}
        onChannelDown={handleChannelDown}
        guideTransparent={guideTransparent}
        isAudioOnly={isAudioOnly}
        audioVisualizerMode={audioVisualizerMode}
        onSetAudioVisualizerMode={handleSetAudioVisualizerMode}

        // Playback state & controls for Alternate View NowPlayingBar overlay
        mpvReady={mpvReady}
        duration={duration}
        position={position}
        muted={muted}
        volume={volume}
        isVod={currentChannel?.stream_id === 'vod' || currentChannel?.stream_id?.startsWith('recording_')}
        vodInfo={vodInfo}
        isCatchup={isCatchup}
        catchupInfo={catchupInfo}
        onStop={handleStop}
        onToggleMute={handleToggleMute}
        onVolumeChange={handleVolumeChange}
        onSeek={handleSeek}
        onCycleSubtitle={handleCycleSubtitle}
        onCycleAudio={handleCycleAudio}
        onToggleStats={handleToggleStats}
        onToggleFullscreen={handleToggleFullscreen}
        onShowSubtitleModal={handleShowSubtitleModal}
        onShowAudioModal={handleShowAudioModal}
        retryState={retryState}
        failoverState={failoverState}
        loadingState={loadingState}
        onCatchupSeek={handleCatchupSeek}
        timeshiftEnabled={timeshiftEnabled}
        timeshiftState={timeshiftState}
        onTimeshiftCatchUp={timeshiftState ? () => handleSeek(timeshiftState.cacheEnd - 1) : undefined}
        pipMode={pipMode}
        onTogglePip={handlePipFromPreview}
        playerControlDesign={playerControlDesign}
        showVolumePercent={showVolumePercent}
        onToggleTransparentGuide={
          playbackSourceView === 'movies' ||
          playbackSourceView === 'series' ||
          playbackSourceView === 'stremio' ||
          playbackSourceView === 'nuvio' ||
          vodInfo != null
            ? undefined
            : handleToggleTransparentGuide
        }
      />

      {/* Settings Panel - as popup overlay in main layout, or full view in multiview */}
      {(showSettingsPopup || activeView === 'settings') && (
        <Settings
          language={language}
          onLanguageChange={setLanguage}
          discordRichPresence={discordRichPresence}
          onDiscordRichPresenceChange={setDiscordRichPresence}
          discordHideTitle={discordHideTitle}
          onDiscordHideTitleChange={setDiscordHideTitle}
          discordShowWhenPaused={discordShowWhenPaused}
          onDiscordShowWhenPausedChange={setDiscordShowWhenPaused}
          discordShowWhenBrowsing={discordShowWhenBrowsing}
          onDiscordShowWhenBrowsingChange={setDiscordShowWhenBrowsing}
          discordShowPoster={discordShowPoster}
          onDiscordShowPosterChange={setDiscordShowPoster}
          discordShowTimestamp={discordShowTimestamp}
          onDiscordShowTimestampChange={setDiscordShowTimestamp}
          castEnabled={castEnabled}
          onCastEnabledChange={setCastEnabled}
          castRewriteTs={castRewriteTs}
          onCastRewriteTsChange={setCastRewriteTs}
          vodAutoPlayNextEpisode={vodAutoPlayNextEpisode}
          onVodAutoPlayNextEpisodeChange={setVodAutoPlayNextEpisode}
          vodShowSourceBadge={vodShowSourceBadge}
          onVodShowSourceBadgeChange={setVodShowSourceBadge}
          failoverGroupShowSource={failoverGroupShowSource}
          onFailoverGroupShowSourceChange={setFailoverGroupShowSource}
          playerControlDesign={playerControlDesign}
          onPlayerControlDesignChange={setPlayerControlDesign}
          showVolumePercent={showVolumePercent}
          onShowVolumePercentChange={setShowVolumePercent}
          stremioStreamPickerMode={stremioStreamPickerMode}
          onStremioStreamPickerModeChange={handleStremioStreamPickerModeChange}
          showStremioStreamBadges={showStremioStreamBadges}
          onShowStremioStreamBadgesChange={handleShowStremioStreamBadgesChange}
          badgeSources={badgeSources}
          onBadgeSourcesChange={handleBadgeSourcesChange}
          stremioBadgeSize={stremioBadgeSize}
          onStremioBadgeSizeChange={handleStremioBadgeSizeChange}
          showHoverDetails={showHoverDetails}
          onShowHoverDetailsChange={handleShowHoverDetailsChange}
          showFileSizeBadges={showFileSizeBadges}
          onShowFileSizeBadgesChange={handleShowFileSizeBadgesChange}
          streamBadgePlacement={streamBadgePlacement}
          onStreamBadgePlacementChange={handleStreamBadgePlacementChange}
          stremioCacheFetchResults={stremioCacheFetchResults}
          onStremioCacheFetchResultsChange={handleStremioCacheFetchResultsChange}
          stremioCacheFetchTimeout={stremioCacheFetchTimeout}
          onStremioCacheFetchTimeoutChange={handleStremioCacheFetchTimeoutChange}
          showNuvioStreamBadges={showNuvioStreamBadges}
          onShowNuvioStreamBadgesChange={handleShowNuvioStreamBadgesChange}
          nuvioBadgeSources={nuvioBadgeSources}
          onNuvioBadgeSourcesChange={handleNuvioBadgeSourcesChange}
          nuvioBadgeSize={nuvioBadgeSize}
          onNuvioBadgeSizeChange={handleNuvioBadgeSizeChange}
          nuvioShowFileSizeBadges={nuvioShowFileSizeBadges}
          onNuvioShowFileSizeBadgesChange={handleNuvioShowFileSizeBadgesChange}
          nuvioStreamBadgePlacement={nuvioStreamBadgePlacement}
          onNuvioStreamBadgePlacementChange={handleNuvioStreamBadgePlacementChange}
          nuvioCacheFetchResults={nuvioCacheFetchResults}
          onNuvioCacheFetchResultsChange={handleNuvioCacheFetchResultsChange}
          nuvioCacheFetchTimeout={nuvioCacheFetchTimeout}
          onNuvioCacheFetchTimeoutChange={handleNuvioCacheFetchTimeoutChange}
          initialTab={settingsTab}
          pendingSubTabFromParent={pendingSettingsSubTab}
          onConsumePendingSubTab={() => setPendingSettingsSubTab(null)}
          editSourceId={editSourceId}
          onClose={() => {
            if (showSettingsPopup) {
              setShowSettingsPopup(false);
            } else {
              setActiveView('none');
            }
            setEditSourceId(null);
          }}
          onShortcutsChange={setShortcuts}
          theme={theme}
          onThemeChange={setTheme}
          customThemeConfig={customThemeConfig}
          onCustomThemeConfigChange={updateCustomThemeConfig}
          channelInfoOverlayEnabled={channelInfoOverlayEnabled}
          onChannelInfoOverlayChange={setChannelInfoOverlayEnabled}
          channelInfoOverlayFontSize={channelInfoOverlayFontSize}
          onChannelInfoOverlayFontSizeChange={setChannelInfoOverlayFontSize}
          channelInfoOverlayLogoSize={channelInfoOverlayLogoSize}
          onChannelInfoOverlayLogoSizeChange={setChannelInfoOverlayLogoSize}
          channelInfoOverlayBoxWidth={channelInfoOverlayBoxWidth}
          onChannelInfoOverlayBoxWidthChange={setChannelInfoOverlayBoxWidth}
          channelInfoOverlayOpacity={channelInfoOverlayOpacity}
          onChannelInfoOverlayOpacityChange={setChannelInfoOverlayOpacity}
          channelInfoOverlayHideDescription={channelInfoOverlayHideDescription}
          onChannelInfoOverlayHideDescriptionChange={setChannelInfoOverlayHideDescription}
          channelInfoOverlayHideMetaBadge={channelInfoOverlayHideMetaBadge}
          onChannelInfoOverlayHideMetaBadgeChange={setChannelInfoOverlayHideMetaBadge}
          channelInfoOverlayHideLogo={channelInfoOverlayHideLogo}
          onChannelInfoOverlayHideLogoChange={setChannelInfoOverlayHideLogo}
          channelInfoOverlayHideTimer={channelInfoOverlayHideTimer}
          onChannelInfoOverlayHideTimerChange={setChannelInfoOverlayHideTimer}
          channelInfoOverlayPosition={channelInfoOverlayPosition}
          onChannelInfoOverlayPositionChange={setChannelInfoOverlayPosition}
          channelInfoOverlayLogoShape={channelInfoOverlayLogoShape}
          onChannelInfoOverlayLogoShapeChange={setChannelInfoOverlayLogoShape}
          transparentGuideOnZap={transparentGuideOnZap}
          onTransparentGuideOnZapChange={setTransparentGuideOnZap}
          overlayAutohideTimer={overlayAutohideTimer}
          onOverlayAutohideTimerChange={setOverlayAutohideTimer}
          overlayOnClickOnly={overlayOnClickOnly}
          onOverlayOnClickOnlyChange={setOverlayOnClickOnly}
          liveTvDesign={liveTvDesign}
          onLiveTvDesignChange={setLiveTvDesign}
          epgMetadataBadgeResolution={epgMetadataBadgeResolution}
          onEpgMetadataBadgeResolutionChange={setEpgMetadataBadgeResolution}
          epgMetadataBadgeFps={epgMetadataBadgeFps}
          onEpgMetadataBadgeFpsChange={setEpgMetadataBadgeFps}
          epgMetadataBadgeFpsSuffix={epgMetadataBadgeFpsSuffix}
          onEpgMetadataBadgeFpsSuffixChange={setEpgMetadataBadgeFpsSuffix}
          epgMetadataBadgeSound={epgMetadataBadgeSound}
          onEpgMetadataBadgeSoundChange={setEpgMetadataBadgeSound}
        />
      )}

      {/* Movies Page */}
      <TransitionView visible={activeView === 'movies'}>
        <MoviesPage
          vodPlayerMode={vodPlayerMode}
          onSelectVodPlayerMode={setVodPlayerMode}
          onPlay={(info, targetMode) => {
            setPlaybackSourceView('movies');
            handlePlayVodWrapper(info, () => setActiveView('none'), targetMode);
          }}
          onClose={() => setActiveView('none')}
        />
      </TransitionView>

      {/* Series Page */}
      <TransitionView visible={activeView === 'series'}>
        <SeriesPage
          vodPlayerMode={vodPlayerMode}
          onSelectVodPlayerMode={setVodPlayerMode}
          onPlay={(info, targetMode) => {
            setPlaybackSourceView('series');
            handlePlayVodWrapper(info, () => setActiveView('none'), targetMode);
          }}
          onClose={() => setActiveView('none')}
        />
      </TransitionView>

      {/* DVR Dashboard */}
      <TransitionView visible={activeView === 'dvr'}>
        <DvrDashboard
          onPlay={(recording) => {
            setPlaybackSourceView('dvr');
            handlePlayRecording(recording, () => setActiveView('none'));
          }}
          onClose={() => setActiveView('none')}
        />
      </TransitionView>

      {/* Sports Hub */}
      <TransitionView visible={activeView === 'sports'}>
        <SportsHub
          visible={activeView === 'sports'}
          onClose={() => setActiveView('none')}
          onSearchChannels={(query) => {
            setSearchQuery(query);
            setActiveView('guide');
            setCategoriesOpen(true);
            setTimeout(() => {
              if (titleBarSearchRef.current) {
                titleBarSearchRef.current.focus();
              }
            }, 50);
          }}
          previewEnabled={sportsPreviewEnabled}
          onTogglePreview={() => setSportsPreviewEnabled(v => !v)}
          onPlayChannel={handlePlayChannelWrapper}
          onTogglePlay={handleTogglePlay}
          isPlaying={playing}
          onStop={handleStop}
          onChannelUp={handleChannelUp}
          onChannelDown={handleChannelDown}
          onPreviewVideoRectChange={setPreviewVideoRect}
          sportsOverlayWidget={sportsOverlayWidget}
          onSportsOverlayWidgetChange={(mode) => {
            if (mode === null) {
              handleRemoveSportsOverlay();
            } else {
              handleAddSportsOverlay(mode);
            }
          }}
        />
      </TransitionView>

      {/* Stremio Page */}
      <TransitionView visible={activeView === 'stremio'}>
        <StremioPage
          onClose={() => setActiveView('none')}
          stremioStreamPickerMode={stremioStreamPickerMode}
          onStreamPickerModeChange={handleStremioStreamPickerModeChange}
          showStremioStreamBadges={showStremioStreamBadges}
          onShowStremioStreamBadgesChange={handleShowStremioStreamBadgesChange}
          badgeSources={badgeSources}
          onBadgeSourcesChange={handleBadgeSourcesChange}
          stremioBadgeSize={stremioBadgeSize}
          onStremioBadgeSizeChange={handleStremioBadgeSizeChange}
          showHoverDetails={showHoverDetails}
          onShowHoverDetailsChange={handleShowHoverDetailsChange}
          showFileSizeBadges={showFileSizeBadges}
          onShowFileSizeBadgesChange={handleShowFileSizeBadgesChange}
          streamBadgePlacement={streamBadgePlacement}
          onStreamBadgePlacementChange={handleStreamBadgePlacementChange}
          stremioCacheFetchResults={stremioCacheFetchResults}
          onStremioCacheFetchResultsChange={handleStremioCacheFetchResultsChange}
          stremioCacheFetchTimeout={stremioCacheFetchTimeout}
          onStremioCacheFetchTimeoutChange={handleStremioCacheFetchTimeoutChange}
        />
      </TransitionView>

      {/* Nuvio Page */}
      <TransitionView visible={activeView === 'nuvio'}>
        <NuvioPage
          onClose={() => setActiveView('none')}
          showNuvioStreamBadges={showNuvioStreamBadges}
          onShowNuvioStreamBadgesChange={handleShowNuvioStreamBadgesChange}
          nuvioBadgeSources={nuvioBadgeSources}
          onNuvioBadgeSourcesChange={handleNuvioBadgeSourcesChange}
          nuvioBadgeSize={nuvioBadgeSize}
          onNuvioBadgeSizeChange={handleNuvioBadgeSizeChange}
          nuvioShowFileSizeBadges={nuvioShowFileSizeBadges}
          onNuvioShowFileSizeBadgesChange={handleNuvioShowFileSizeBadgesChange}
          nuvioStreamBadgePlacement={nuvioStreamBadgePlacement}
          onNuvioStreamBadgePlacementChange={handleNuvioStreamBadgePlacementChange}
          showNuvioHoverDetails={showNuvioHoverDetails}
          onShowNuvioHoverDetailsChange={handleShowNuvioHoverDetailsChange}
          nuvioAutoPlayMode={nuvioAutoPlayMode}
          onNuvioAutoPlayModeChange={handleNuvioAutoPlayModeChange}
          nuvioAutoPlayTimeout={nuvioAutoPlayTimeout}
          onNuvioAutoPlayTimeoutChange={handleNuvioAutoPlayTimeoutChange}
          nuvioAutoPlaySourceScope={nuvioAutoPlaySourceScope}
          onNuvioAutoPlaySourceScopeChange={handleNuvioAutoPlaySourceScopeChange}
          nuvioAutoPlayAllowedAddons={nuvioAutoPlayAllowedAddons}
          onNuvioAutoPlayAllowedAddonsChange={handleNuvioAutoPlayAllowedAddonsChange}
          nuvioAutoPlayAllowedPlugins={nuvioAutoPlayAllowedPlugins}
          onNuvioAutoPlayAllowedPluginsChange={handleNuvioAutoPlayAllowedPluginsChange}
          nuvioAutoPlayRegex={nuvioAutoPlayRegex}
          onNuvioAutoPlayRegexChange={handleNuvioAutoPlayRegexChange}
          nuvioCacheFetchResults={nuvioCacheFetchResults}
          onNuvioCacheFetchResultsChange={handleNuvioCacheFetchResultsChange}
          nuvioCacheFetchTimeout={nuvioCacheFetchTimeout}
          onNuvioCacheFetchTimeoutChange={handleNuvioCacheFetchTimeoutChange}
          onNavigateToSettingsTab={(tab) => {
            setSettingsTab(tab as any);
            setShowSettingsPopup(true);
          }}
        />
      </TransitionView>

      {/* TV Calendar */}
      <TransitionView visible={activeView === 'calendar'}>
        <TVCalendarPage
          onClose={() => setActiveView('none')}
          onPlayChannel={async (channelName) => {
            let channel = currentChannels.find(c => c.name === channelName);
            if (!channel) {
              const channels = await db.channels.whereRaw('name = ?', [channelName]).toArray();
              if (channels.length > 0) {
                channel = channels[0];
              }
            }
            if (channel) {
              handlePlayChannelWrapper(channel);
            }
          }}
        />
      </TransitionView>

      {/* Watchlist Notifications */}
      <WatchlistNotificationContainer
        notifications={watchlistNotifications}
        onSwitch={handleWatchlistSwitchWrapper}
        onDismiss={handleWatchlistDismiss}
      />

      {/* Sync Toast Notifications */}
      <ToastContainer />

      {/* Popout Player Control Bar */}
      {popoutIsOpen && (
        <div
          onMouseEnter={() => {
            popoutControlsHoveredRef.current = true;
          }}
          onMouseLeave={() => {
            popoutControlsHoveredRef.current = false;
            setPopoutLastActivity(Date.now());
          }}
          onMouseDown={handlePopoutDragStart}
          style={{
            position: 'fixed',
            bottom: popoutPosition ? undefined : '20px',
            right: popoutPosition ? undefined : '20px',
            left: popoutPosition ? `${popoutPosition.x}px` : undefined,
            top: popoutPosition ? `${popoutPosition.y}px` : undefined,
            zIndex: 9999,
            background: 'rgba(0,0,0,0.9)',
            backdropFilter: 'blur(12px)',
            borderRadius: '14px',
            padding: '10px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            border: '1px solid rgba(255,255,255,0.12)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            fontSize: '13px',
            color: '#fff',
            cursor: 'grab',
            userSelect: 'none',
            minWidth: '240px',
            transition: 'opacity 0.2s ease, transform 0.2s ease, visibility 0.2s',
            opacity: showPopoutControls ? 1 : 0,
            transform: showPopoutControls ? 'translateY(0)' : 'translateY(10px)',
            pointerEvents: showPopoutControls ? 'auto' : 'none',
          }}
        >
          {/* Title row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 500 }}>
            <span style={{ color: 'var(--accent, #00d4ff)', fontSize: '15px' }}>🖥️</span>
            <span style={{ opacity: 0.95, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '180px' }}>
              {popout.content?.type === 'channel'
                ? popout.content.channel.name
                : popout.content?.type === 'vod'
                  ? popout.content.info.title
                  : i18n.t('player:popoutActive')}
            </span>
          </div>

          {/* Controls row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }}>
            <button
              onClick={() => popoutTogglePause()}
              title={i18n.t('player:playPause')}
              style={{
                background: 'rgba(255,255,255,0.1)',
                border: 'none',
                borderRadius: '8px',
                color: '#fff',
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>
            </button>
            <button
              onClick={() => popoutStopPlayback()}
              title={i18n.t('player:stop')}
              style={{
                background: 'rgba(255,255,255,0.1)',
                border: 'none',
                borderRadius: '8px',
                color: '#fff',
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
            </button>
            <button
              onClick={() => popoutToggleFullscreen()}
              title={i18n.t('common:fullscreen')}
              style={{
                background: 'rgba(255,255,255,0.1)',
                border: 'none',
                borderRadius: '8px',
                color: '#fff',
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
            </button>
            <button
              onClick={handleTogglePopoutAlwaysOnTop}
              title={popoutAlwaysOnTop ? i18n.t('player:disableAlwaysOnTop') : i18n.t('player:enableAlwaysOnTop')}
              style={{
                background: popoutAlwaysOnTop ? 'rgba(0, 212, 255, 0.25)' : 'rgba(255,255,255,0.1)',
                border: 'none',
                borderRadius: '8px',
                color: popoutAlwaysOnTop ? 'var(--accent, #00d4ff)' : '#fff',
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                fontSize: '14px',
                transition: 'all 0.2s ease',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill={popoutAlwaysOnTop ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="17" x2="12" y2="22"></line>
                <path d="M5 17h14v-1.76a2 2 0 0 0-.44-1.24l-2.78-3.5A2 2 0 0 1 15 9.26V5a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4.26a2 2 0 0 1-.78 1.24l-2.78 3.5a2 2 0 0 0-.44 1.24Z"></path>
              </svg>
            </button>
            <div style={{ width: '1px', height: '20px', background: 'rgba(255,255,255,0.15)', margin: '0 4px' }} />
            <button
              onClick={() => closePopout()}
              title={i18n.t('player:closePopout')}
              style={{
                background: 'rgba(255,80,80,0.2)',
                border: 'none',
                borderRadius: '8px',
                color: '#ff8080',
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>

          {/* Volume row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={() => setPopoutMuted(true)}
              title={i18n.t('player:mute')}
              style={{
                background: 'none',
                border: 'none',
                color: 'rgba(255,255,255,0.6)',
                cursor: 'pointer',
                padding: '2px',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
            </button>
            <input
              type="range"
              min="0"
              max="100"
              defaultValue="100"
              onChange={(e) => setPopoutVolume(parseInt(e.target.value, 10))}
              style={{
                flex: 1,
                accentColor: 'var(--accent, #00d4ff)',
                height: '4px',
              }}
            />
          </div>
        </div>
      )}

      {/* Update Modal */}
      <UpdateModal
        isOpen={updateModalOpen}
        onClose={() => setUpdateModalOpen(false)}
      />

      {/* What's New Modal */}
      <WhatsNewModal
        isOpen={whatsNewModalOpen}
        onClose={() => setWhatsNewModalOpen(false)}
        version={appVersion}
      />
      {/* Keyboard Shortcuts Modal Overlay */}
      <KeyboardShortcutsModal
        isOpen={showShortcutsOverlay}
        onClose={() => setShowShortcutsOverlay(false)}
        shortcuts={shortcuts}
      />
      {/* Source Selector Modal when episode selected from PlaybackDetailsModal */}
      {sourcePickerParams && (
        <SourcePickerModal
          source={sourcePickerParams.source}
          type={sourcePickerParams.type}
          id={sourcePickerParams.id}
          currentAddonName={vodInfo?.addonName}
          currentUrl={vodInfo?.url}
          compiledBadgeRules={sourcePickerParams.source === 'nuvio' ? compiledNuvioBadgeRules : compiledBadgeRules}
          onSelect={(stream) => {
            const params = sourcePickerParams;
            setSourcePickerParams(null);
            window.dispatchEvent(
              new CustomEvent('ynotv:stremio-play', {
                detail: {
                  meta: params.meta,
                  episodeVideo: params.video,
                  stream: stream,
                  isNuvio: params.source === 'nuvio',
                },
              })
            );
          }}
          onClose={() => setSourcePickerParams(null)}
        />
      )}
      <ModalComponent />
      <div id="hls-fallback-container" style={{ display: 'none' }} />
    </div>
  );
}

export default App;
