import { useState, useEffect, useRef } from 'react';
import type { Source } from '@ynotv/core';
import { useEpgView, useSetEpgView, useSetEpgVisibleHours, useSetEpgClockFormat, useSetEpgShowDate, useUIStore, useIncludeAllChannelsToPlaylist, useSetIncludeAllChannelsToPlaylist } from '../stores/uiStore';
import { SettingsSidebar, SETTINGS_TAB_LABEL_KEYS, type SettingsTabId } from './settings/SettingsSidebar';
import { searchSettings, type SettingsSearchResult } from './settings/SettingsSearchIndex';
import { SourcesTab } from './settings/SourcesTab';
import { SecurityTab } from './settings/SecurityTab';
import { DebugTab } from './settings/DebugTab';
import { ShortcutsTab } from './settings/ShortcutsTab';
import { ImportExportTab } from './settings/ImportExportTab';
import { UITab } from './settings/UITab';
import { ThemeTab } from './settings/ThemeTab';
import { OptimizationTab } from './settings/OptimizationTab';
import { StartupTab, type SavedLayoutState } from './settings/StartupTab';
import { NavigationTab } from './settings/NavigationTab';
import { PlaybackTab } from './settings/PlaybackTab';
import { CacheTab } from './settings/CacheTab';
import { AboutTab } from './settings/AboutTab';
import { LiveTVTab } from './settings/LiveTVTab';
import { SubtitlesTab, type SubtitleSettings } from './settings/SubtitlesTab';
import { ScrobblingTab } from './settings/ScrobblingTab';
import { SimklTab } from './settings/SimklTab';
import { StremTab } from './settings/StremTab';
import { NuvioTab } from './settings/NuvioTab';
import { ProxyTab } from './settings/ProxyTab';
import { DiscordTab } from './settings/DiscordTab';
import { useModal } from './Modal';
import { TmdbTab } from './settings/TmdbTab';
import { useSettingsStore, DEFAULT_MAX_SEARCH_RESULTS, clampMaxSearchResults } from '../stores/settingsStore';
import type { ShortcutsMap, ThemeId, CustomThemeConfig } from '../types/app';
import type { StremioStreamPickerMode, BadgeSource, StreamAutoPlayMode, StreamAutoPlaySourceScope } from '../types/stremio';
import { DEFAULT_BADGE_SOURCES, mergeDefaultBadgeSources } from '../utils/streamBadges';
import { useTranslation } from 'react-i18next';
import i18n, { SUPPORTED_LOCALES } from '../i18n';
import './Settings.css';

interface SettingsProps {
  // ── i18n entry point ────────────────────────────────────────────────
  // `language` is the active BCP-47 code (src/i18n SUPPORTED_LOCALES);
  // `onLanguageChange` persists AND applies it live via i18next.changeLanguage().
  language: string;
  onLanguageChange: (lang: string) => void | Promise<void>;
  onClose: () => void;
  onShortcutsChange?: (shortcuts: ShortcutsMap) => void;
  theme?: ThemeId;
  onThemeChange?: (theme: ThemeId) => void;
  customThemeConfig?: CustomThemeConfig;
  onCustomThemeConfigChange?: (config: Partial<CustomThemeConfig>) => void;
  initialTab?: SettingsTabId;
  editSourceId?: string | null;
  pendingSubTabFromParent?: string | null;
  onConsumePendingSubTab?: () => void;
  channelInfoOverlayEnabled?: boolean;
  onChannelInfoOverlayChange?: (enabled: boolean) => void;
  channelInfoOverlayFontSize?: number;
  onChannelInfoOverlayFontSizeChange?: (size: number) => void;
  channelInfoOverlayLogoSize?: number;
  onChannelInfoOverlayLogoSizeChange?: (size: number) => void;
  channelInfoOverlayBoxWidth?: number;
  onChannelInfoOverlayBoxWidthChange?: (width: number) => void;
  channelInfoOverlayOpacity?: number;
  onChannelInfoOverlayOpacityChange?: (opacity: number) => void;
  channelInfoOverlayHideDescription?: boolean;
  onChannelInfoOverlayHideDescriptionChange?: (hide: boolean) => void;
  channelInfoOverlayHideMetaBadge?: boolean;
  onChannelInfoOverlayHideMetaBadgeChange?: (hide: boolean) => void;
  channelInfoOverlayHideLogo?: boolean;
  onChannelInfoOverlayHideLogoChange?: (hide: boolean) => void;
  channelInfoOverlayHideTimer?: boolean;
  onChannelInfoOverlayHideTimerChange?: (hide: boolean) => void;
  channelInfoOverlayPosition?: 'left' | 'right';
  onChannelInfoOverlayPositionChange?: (pos: 'left' | 'right') => void;
  channelInfoOverlayLogoShape?: 'square' | 'horizontal';
  onChannelInfoOverlayLogoShapeChange?: (shape: 'square' | 'horizontal') => void;
  playerControlDesign?: 'default' | 'clean';
  onPlayerControlDesignChange?: (design: 'default' | 'clean') => void;
  showVolumePercent?: boolean;
  onShowVolumePercentChange?: (enabled: boolean) => void;
  overlayAutohideTimer?: number;
  onOverlayAutohideTimerChange?: (seconds: number) => void;
  overlayOnClickOnly?: boolean;
  onOverlayOnClickOnlyChange?: (enabled: boolean) => void;
  transparentGuideOnZap?: boolean;
  onTransparentGuideOnZapChange?: (enabled: boolean) => void;
  castEnabled?: boolean;
  onCastEnabledChange?: (enabled: boolean) => void;
  castRewriteTs?: boolean;
  onCastRewriteTsChange?: (enabled: boolean) => void;
  stremioStreamPickerMode?: StremioStreamPickerMode;
  onStremioStreamPickerModeChange?: (mode: StremioStreamPickerMode) => void;
  showStremioStreamBadges?: boolean;
  onShowStremioStreamBadgesChange?: (show: boolean) => void;
  badgeSources?: BadgeSource[];
  onBadgeSourcesChange?: (sources: BadgeSource[]) => void;
  stremioBadgeSize?: number;
  onStremioBadgeSizeChange?: (size: number) => void;
  showHoverDetails?: boolean;
  onShowHoverDetailsChange?: (show: boolean) => void;
  showFileSizeBadges?: boolean;
  onShowFileSizeBadgesChange?: (enabled: boolean) => void;
  streamBadgePlacement?: 'top' | 'bottom';
  onStreamBadgePlacementChange?: (placement: 'top' | 'bottom') => void;
  stremioCacheFetchResults?: boolean;
  onStremioCacheFetchResultsChange?: (enabled: boolean) => void;
  stremioCacheFetchTimeout?: number;
  onStremioCacheFetchTimeoutChange?: (timeout: number) => void;
  showNuvioStreamBadges?: boolean;
  onShowNuvioStreamBadgesChange?: (show: boolean) => void;
  nuvioBadgeSources?: BadgeSource[];
  onNuvioBadgeSourcesChange?: (sources: BadgeSource[]) => void;
  nuvioBadgeSize?: number;
  onNuvioBadgeSizeChange?: (size: number) => void;
  nuvioShowFileSizeBadges?: boolean;
  onNuvioShowFileSizeBadgesChange?: (enabled: boolean) => void;
  nuvioStreamBadgePlacement?: 'top' | 'bottom';
  onNuvioStreamBadgePlacementChange?: (placement: 'top' | 'bottom') => void;
  showNuvioHoverDetails?: boolean;
  onShowNuvioHoverDetailsChange?: (show: boolean) => void;
  nuvioCacheFetchResults?: boolean;
  onNuvioCacheFetchResultsChange?: (enabled: boolean) => void;
  nuvioCacheFetchTimeout?: number;
  onNuvioCacheFetchTimeoutChange?: (timeout: number) => void;
  liveTvDesign?: 'v1' | 'v2' | 'v3';
  epgMetadataBadgeResolution?: boolean;
  onEpgMetadataBadgeResolutionChange?: (enabled: boolean) => void;
  epgMetadataBadgeFps?: boolean;
  onEpgMetadataBadgeFpsChange?: (enabled: boolean) => void;
  epgMetadataBadgeFpsSuffix?: boolean;
  onEpgMetadataBadgeFpsSuffixChange?: (enabled: boolean) => void;
  epgMetadataBadgeSound?: boolean;
  onEpgMetadataBadgeSoundChange?: (enabled: boolean) => void;
  vodAutoPlayNextEpisode?: boolean;
  onVodAutoPlayNextEpisodeChange?: (enabled: boolean) => void;
  vodShowSourceBadge?: boolean;
  onVodShowSourceBadgeChange?: (enabled: boolean) => void;
  failoverGroupShowSource?: boolean;
  onFailoverGroupShowSourceChange?: (enabled: boolean) => void;
  discordRichPresence?: boolean;
  onDiscordRichPresenceChange?: (enabled: boolean) => void;
  discordHideTitle?: boolean;
  onDiscordHideTitleChange?: (hide: boolean) => void;
  discordShowWhenPaused?: boolean;
  onDiscordShowWhenPausedChange?: (show: boolean) => void;
  discordShowWhenBrowsing?: boolean;
  onDiscordShowWhenBrowsingChange?: (show: boolean) => void;
  discordShowPoster?: boolean;
  onDiscordShowPosterChange?: (show: boolean) => void;
  discordShowTimestamp?: boolean;
  onDiscordShowTimestampChange?: (show: boolean) => void;
}

export function Settings({
  language,
  onLanguageChange,
  onClose,
  onShortcutsChange,
  theme,
  onThemeChange,
  customThemeConfig,
  onCustomThemeConfigChange,
  initialTab = 'sources',
  editSourceId = null,
  pendingSubTabFromParent,
  onConsumePendingSubTab,
  channelInfoOverlayEnabled: channelInfoOverlayEnabledProp,
  onChannelInfoOverlayChange,
  channelInfoOverlayFontSize: channelInfoOverlayFontSizeProp,
  onChannelInfoOverlayFontSizeChange,
  channelInfoOverlayLogoSize: channelInfoOverlayLogoSizeProp,
  onChannelInfoOverlayLogoSizeChange,
  channelInfoOverlayBoxWidth: channelInfoOverlayBoxWidthProp,
  onChannelInfoOverlayBoxWidthChange,
  channelInfoOverlayOpacity: channelInfoOverlayOpacityProp,
  onChannelInfoOverlayOpacityChange,
  channelInfoOverlayHideDescription: channelInfoOverlayHideDescriptionProp,
  onChannelInfoOverlayHideDescriptionChange,
  channelInfoOverlayHideMetaBadge: channelInfoOverlayHideMetaBadgeProp,
  onChannelInfoOverlayHideMetaBadgeChange,
  channelInfoOverlayHideLogo: channelInfoOverlayHideLogoProp,
  onChannelInfoOverlayHideLogoChange,
  channelInfoOverlayHideTimer: channelInfoOverlayHideTimerProp,
  onChannelInfoOverlayHideTimerChange,
  channelInfoOverlayPosition: channelInfoOverlayPositionProp,
  onChannelInfoOverlayPositionChange,
  channelInfoOverlayLogoShape: channelInfoOverlayLogoShapeProp,
  onChannelInfoOverlayLogoShapeChange,
  playerControlDesign: playerControlDesignProp,
  onPlayerControlDesignChange,
  showVolumePercent: showVolumePercentProp,
  onShowVolumePercentChange,
  overlayAutohideTimer: overlayAutohideTimerProp,
  onOverlayAutohideTimerChange,
  overlayOnClickOnly: overlayOnClickOnlyProp,
  onOverlayOnClickOnlyChange,
  transparentGuideOnZap: transparentGuideOnZapProp,
  onTransparentGuideOnZapChange,
  castEnabled: castEnabledProp,
  onCastEnabledChange,
  castRewriteTs: castRewriteTsProp,
  onCastRewriteTsChange,
  stremioStreamPickerMode: stremioStreamPickerModeProp,
  onStremioStreamPickerModeChange,
  showStremioStreamBadges: showStremioStreamBadgesProp,
  onShowStremioStreamBadgesChange,
  badgeSources: badgeSourcesProp,
  onBadgeSourcesChange,
  stremioBadgeSize: stremioBadgeSizeProp,
  onStremioBadgeSizeChange,
  showHoverDetails: showHoverDetailsProp,
  onShowHoverDetailsChange,
  showFileSizeBadges: showFileSizeBadgesProp,
  onShowFileSizeBadgesChange,
  streamBadgePlacement: streamBadgePlacementProp,
  onStreamBadgePlacementChange,
  stremioCacheFetchResults: stremioCacheFetchResultsProp,
  onStremioCacheFetchResultsChange,
  stremioCacheFetchTimeout: stremioCacheFetchTimeoutProp,
  onStremioCacheFetchTimeoutChange,
  showNuvioStreamBadges: showNuvioStreamBadgesProp,
  onShowNuvioStreamBadgesChange,
  nuvioBadgeSources: nuvioBadgeSourcesProp,
  onNuvioBadgeSourcesChange,
  nuvioBadgeSize: nuvioBadgeSizeProp,
  onNuvioBadgeSizeChange,
  nuvioShowFileSizeBadges: nuvioShowFileSizeBadgesProp,
  onNuvioShowFileSizeBadgesChange,
  nuvioStreamBadgePlacement: nuvioStreamBadgePlacementProp,
  onNuvioStreamBadgePlacementChange,
  showNuvioHoverDetails: showNuvioHoverDetailsProp,
  onShowNuvioHoverDetailsChange,
  nuvioCacheFetchResults: nuvioCacheFetchResultsProp,
  onNuvioCacheFetchResultsChange,
  nuvioCacheFetchTimeout: nuvioCacheFetchTimeoutProp,
  onNuvioCacheFetchTimeoutChange,
  liveTvDesign,
  epgMetadataBadgeResolution: epgMetadataBadgeResolutionProp,
  onEpgMetadataBadgeResolutionChange,
  epgMetadataBadgeFps: epgMetadataBadgeFpsProp,
  onEpgMetadataBadgeFpsChange,
  epgMetadataBadgeFpsSuffix: epgMetadataBadgeFpsSuffixProp,
  onEpgMetadataBadgeFpsSuffixChange,
  epgMetadataBadgeSound: epgMetadataBadgeSoundProp,
  onEpgMetadataBadgeSoundChange,
  vodAutoPlayNextEpisode: vodAutoPlayNextEpisodeProp,
  onVodAutoPlayNextEpisodeChange,
  vodShowSourceBadge: vodShowSourceBadgeProp,
  onVodShowSourceBadgeChange,
  failoverGroupShowSource: failoverGroupShowSourceProp,
  onFailoverGroupShowSourceChange,
  discordRichPresence: discordRichPresenceProp,
  onDiscordRichPresenceChange,
  discordHideTitle: discordHideTitleProp,
  onDiscordHideTitleChange,
  discordShowWhenPaused: discordShowWhenPausedProp,
  onDiscordShowWhenPausedChange,
  discordShowWhenBrowsing: discordShowWhenBrowsingProp,
  onDiscordShowWhenBrowsingChange,
  discordShowPoster: discordShowPosterProp,
  onDiscordShowPosterChange,
  discordShowTimestamp: discordShowTimestampProp,
  onDiscordShowTimestampChange,
}: SettingsProps) {
  useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialTab);
  const { showConfirm, ModalComponent } = useModal();
  const nuvioHasUnsavedHomeLayout = useUIStore((s) => s.nuvioHasUnsavedHomeLayout);
  const nuvioTabSaveFn = useUIStore((s) => s.nuvioTabSaveFn);

  const handleTabChange = (newTab: SettingsTabId) => {
    if (activeTab === 'nuvio' && nuvioHasUnsavedHomeLayout) {
      showConfirm(
        i18n.t('settings:unsavedChanges'),
        i18n.t('settings:unsavedHomeLayoutConfirm'),
        async () => {
          try {
            await nuvioTabSaveFn?.();
            useUIStore.setState({ nuvioHasUnsavedHomeLayout: false });
            setActiveTab(newTab);
          } catch (err) {
            // Error was already alerted inside child component
          }
        },
        () => {
          useUIStore.setState({ nuvioHasUnsavedHomeLayout: false });
          setActiveTab(newTab);
        },
        i18n.t('common:save'),
        i18n.t('settings:discardChanges')
      );
    } else {
      setActiveTab(newTab);
    }
  };

  const handleClose = () => {
    if (activeTab === 'nuvio' && nuvioHasUnsavedHomeLayout) {
      showConfirm(
        i18n.t('settings:unsavedChanges'),
        i18n.t('settings:unsavedHomeLayoutConfirm'),
        async () => {
          try {
            await nuvioTabSaveFn?.();
            useUIStore.setState({ nuvioHasUnsavedHomeLayout: false });
            onClose();
          } catch (err) {
            // Error was already alerted inside child component
          }
        },
        () => {
          useUIStore.setState({ nuvioHasUnsavedHomeLayout: false });
          onClose();
        },
        i18n.t('common:save'),
        i18n.t('settings:discardChanges')
      );
    } else {
      onClose();
    }
  };
  const [isFullScreen, setIsFullScreen] = useState<boolean>(() => {
    return localStorage.getItem('settings_fullscreen') === 'true';
  });

  const toggleFullScreen = () => {
    const nextVal = !isFullScreen;
    setIsFullScreen(nextVal);
    localStorage.setItem('settings_fullscreen', String(nextVal));
  };

  const [pendingSubTab, setPendingSubTab] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const { t } = useTranslation('settings');

  // Sync pending sub-tab from parent (e.g., navigating from Cast button)
  useEffect(() => {
    if (pendingSubTabFromParent) {
      setPendingSubTab(pendingSubTabFromParent);
      onConsumePendingSubTab?.();
    }
  }, [pendingSubTabFromParent, onConsumePendingSubTab]);
  const [searchResults, setSearchResults] = useState<SettingsSearchResult[]>([]);
  const searchRef = useRef<HTMLDivElement>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [isEncryptionAvailable, setIsEncryptionAvailable] = useState(true);

  // Metadata + streaming-catalog settings — settings-store backed
  const tmdbApiKey = useSettingsStore((s) => s.tmdbApiKey);
  const setTmdbApiKey = useSettingsStore((s) => s.setTmdbApiKey);
  const streamingCatalogsEnabled = useSettingsStore((s) => s.streamingCatalogsEnabled);
  const setStreamingCatalogsEnabled = useSettingsStore((s) => s.setStreamingCatalogsEnabled);
  const streamingNuvioCatalogsEnabled = useSettingsStore((s) => s.streamingNuvioCatalogsEnabled);
  const setStreamingNuvioCatalogsEnabled = useSettingsStore((s) => s.setStreamingNuvioCatalogsEnabled);
  const enabledStreamingServices = useSettingsStore((s) => s.enabledStreamingServices);
  const setEnabledStreamingServices = useSettingsStore((s) => s.setEnabledStreamingServices);
  const posterDbApiKey = useSettingsStore((s) => s.posterDbApiKey);
  const setPosterDbApiKey = useSettingsStore((s) => s.setPosterDbApiKey);
  const rpdbBackdropsEnabled = useSettingsStore((s) => s.rpdbBackdropsEnabled);
  const setRpdbBackdropsEnabled = useSettingsStore((s) => s.setRpdbBackdropsEnabled);
  const [tmdbKeyValid, setTmdbKeyValid] = useState<boolean | null>(null);
  const [posterDbKeyValid, setPosterDbKeyValid] = useState<boolean | null>(null);

  // Refresh settings state
  const [vodRefreshHours, setVodRefreshHours] = useState(24);
  const [epgRefreshHours, setEpgRefreshHours] = useState(6);
  const [epgSyncConcurrency, setEpgSyncConcurrency] = useState(0);

  // Security state
  const [allowLanSources, setAllowLanSources] = useState(false);

  // Proxy state
  const [socks5ProxyEnabled, setSocks5ProxyEnabled] = useState(false);
  const [socks5ProxyServer, setSocks5ProxyServer] = useState('');
  const [socks5ProxyUsername, setSocks5ProxyUsername] = useState('');
  const [socks5ProxyPassword, setSocks5ProxyPassword] = useState('');

  // Discord Rich Presence state
  const [discordRichPresenceState, setDiscordRichPresenceState] = useState(false);
  const discordRichPresence = discordRichPresenceProp ?? discordRichPresenceState;
  const [discordHideTitleState, setDiscordHideTitleState] = useState(false);
  const discordHideTitle = discordHideTitleProp ?? discordHideTitleState;
  const [discordShowWhenPausedState, setDiscordShowWhenPausedState] = useState(true);
  const discordShowWhenPaused = discordShowWhenPausedProp ?? discordShowWhenPausedState;
  const [discordShowWhenBrowsingState, setDiscordShowWhenBrowsingState] = useState(true);
  const discordShowWhenBrowsing = discordShowWhenBrowsingProp ?? discordShowWhenBrowsingState;
  const [discordShowPosterState, setDiscordShowPosterState] = useState(true);
  const discordShowPoster = discordShowPosterProp ?? discordShowPosterState;
  const [discordShowTimestampState, setDiscordShowTimestampState] = useState(true);
  const discordShowTimestamp = discordShowTimestampProp ?? discordShowTimestampState;

  // Debug state
  const [debugLoggingEnabled, setDebugLoggingEnabled] = useState(false);
  const [logRetentionDays, setLogRetentionDays] = useState(7);

  // Channel display state
  const [channelSortOrder, setChannelSortOrder] = useState<'alphabetical' | 'number' | 'provider'>('provider');
  const [categorySortOrder, setCategorySortOrder] = useState<'default' | 'alphabetical'>('default');
  const [includeSourceInSearch, setIncludeSourceInSearch] = useState(false);
  const [includeSourceInVodSearch, setIncludeSourceInVodSearch] = useState(false);
  const [maxSearchResults, setMaxSearchResults] = useState(DEFAULT_MAX_SEARCH_RESULTS);
  const [searchResultsOrder, setSearchResultsOrder] = useState<'default' | 'alphabetical'>('default');

  // Shortcuts state
  const [shortcuts, setShortcuts] = useState<ShortcutsMap>({});

  // UI state
  const [uiSettings, setUiSettings] = useState<{
    startupWidth?: number;
    startupHeight?: number;
    dontSaveWindowSizeOnClose?: boolean;
    minimizeToTray?: boolean;
    modernUiEnabled?: boolean | string;
    collapseSourceCategoriesOnStartup?: boolean;
    overlayAutohideTimer?: number;
    overlayOnClickOnly?: boolean;
    uiScale?: number;
    playerControlDesign?: 'default' | 'clean';
    showVolumePercent?: boolean;
  }>({
    modernUiEnabled: 'v3',
    minimizeToTray: false,
    collapseSourceCategoriesOnStartup: false,
    overlayAutohideTimer: 3,
    overlayOnClickOnly: false,
    uiScale: 100,
    playerControlDesign: 'clean',
    showVolumePercent: false,
  });

  // Font size state (moved to LiveTV tab)
  const [channelFontSize, setChannelFontSize] = useState(14);
  const [categoryFontSize, setCategoryFontSize] = useState(13);
  const [sourceFontSize, setSourceFontSize] = useState(12);

  // Startup settings state
  const [rememberLastChannels, setRememberLastChannels] = useState(false);
  const [reopenLastOnStartup, setReopenLastOnStartup] = useState(false);
  const [savedLayoutState, setSavedLayoutState] = useState<SavedLayoutState | null>(null);
  const [startupView, setStartupView] = useState<'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'sports' | 'calendar' | 'stremio' | 'nuvio'>('none');
  const navHiddenTabs = useUIStore((s) => s.navHiddenTabs);
  const navHiddenTabsStore = useUIStore((s) => s.setNavHiddenTabs);
  const epgHiddenButtons = useUIStore((s) => s.epgHiddenButtons);
  const epgHiddenButtonsStore = useUIStore((s) => s.setEpgHiddenButtons);

  // Playback settings state
  const [mpvParams, setMpvParams] = useState<string>('');
  const [mpvHwdecEnabled, setMpvHwdecEnabled] = useState(true);
  const [timeshiftEnabled, setTimeshiftEnabled] = useState(true);
  const [timeshiftCacheBytes, setTimeshiftCacheBytes] = useState(268_435_456);
  const [liveBufferOffset, setLiveBufferOffset] = useState(0);
  // Stream retry settings
  const [streamWatchdogSeconds, setStreamWatchdogSeconds] = useState(10);
  const [streamMaxRetries, setStreamMaxRetries] = useState(20);
  const [useEventBasedReconnect, setUseEventBasedReconnect] = useState(false);
  const [stallDetectionEnabled, setStallDetectionEnabled] = useState(true);
  const [showLoadingScreen, setShowLoadingScreen] = useState(false);
  // Catch-up settings state
  const [catchupStartPadding, setCatchupStartPadding] = useState(0);
  const [catchupEndPadding, setCatchupEndPadding] = useState(0);
  const [catchupContinuePlaying, setCatchupContinuePlaying] = useState(false);
  const [vodAutoPlayNextEpisode, setVodAutoPlayNextEpisode] = useState(true);
  const [vodShowSourceBadge, setVodShowSourceBadge] = useState(false);
  const [failoverGroupShowSource, setFailoverGroupShowSource] = useState(false);
  // Stremio settings
  const [stremioStreamPickerMode, setStremioStreamPickerMode] = useState<StremioStreamPickerMode>('modal');
  const [showStremioStreamBadges, setShowStremioStreamBadges] = useState(true);
  const [badgeSources, setBadgeSources] = useState<BadgeSource[]>(DEFAULT_BADGE_SOURCES);
  const [stremioBadgeSize, setStremioBadgeSize] = useState(100);
  const [showHoverDetails, setShowHoverDetails] = useState(true);
  const [showFileSizeBadges, setShowFileSizeBadges] = useState(true);
  const [streamBadgePlacement, setStreamBadgePlacement] = useState<'top' | 'bottom'>('bottom');
  const [stremioCacheFetchResults, setStremioCacheFetchResults] = useState(false);
  const [stremioCacheFetchTimeout, setStremioCacheFetchTimeout] = useState(5);
  const [showNuvioStreamBadges, setShowNuvioStreamBadges] = useState(true);
  const [nuvioBadgeSources, setNuvioBadgeSources] = useState<BadgeSource[]>(DEFAULT_BADGE_SOURCES);
  const [nuvioBadgeSize, setNuvioBadgeSize] = useState(100);
  const [nuvioShowFileSizeBadges, setNuvioShowFileSizeBadges] = useState(true);
  const [nuvioStreamBadgePlacement, setNuvioStreamBadgePlacement] = useState<'top' | 'bottom'>('bottom');
  const [showNuvioHoverDetails, setShowNuvioHoverDetails] = useState(true);
  const [nuvioCacheFetchResults, setNuvioCacheFetchResults] = useState(false);
  const [nuvioCacheFetchTimeout, setNuvioCacheFetchTimeout] = useState(5);
  const [nuvioAutoPlayMode, setNuvioAutoPlayMode] = useState<StreamAutoPlayMode>('manual');
  const [nuvioAutoPlayTimeout, setNuvioAutoPlayTimeout] = useState(0);
  const [nuvioAutoPlaySourceScope, setNuvioAutoPlaySourceScope] = useState<StreamAutoPlaySourceScope>('all');
  const [nuvioAutoPlayAllowedAddons, setNuvioAutoPlayAllowedAddons] = useState<string[]>([]);
  const [nuvioAutoPlayAllowedPlugins, setNuvioAutoPlayAllowedPlugins] = useState<string[]>([]);
  const [nuvioAutoPlayRegex, setNuvioAutoPlayRegex] = useState<string>('');

  useEffect(() => {
    if (stremioStreamPickerModeProp !== undefined) {
      setStremioStreamPickerMode(stremioStreamPickerModeProp);
    }
  }, [stremioStreamPickerModeProp]);

  useEffect(() => {
    if (showStremioStreamBadgesProp !== undefined) {
      setShowStremioStreamBadges(showStremioStreamBadgesProp);
    }
  }, [showStremioStreamBadgesProp]);

  useEffect(() => {
    if (badgeSourcesProp !== undefined) {
      setBadgeSources(mergeDefaultBadgeSources(badgeSourcesProp));
    }
  }, [badgeSourcesProp]);

  useEffect(() => {
    if (stremioBadgeSizeProp !== undefined) {
      setStremioBadgeSize(stremioBadgeSizeProp);
    }
  }, [stremioBadgeSizeProp]);

  useEffect(() => {
    if (showHoverDetailsProp !== undefined) {
      setShowHoverDetails(showHoverDetailsProp);
    }
  }, [showHoverDetailsProp]);

  useEffect(() => {
    if (showFileSizeBadgesProp !== undefined) {
      setShowFileSizeBadges(showFileSizeBadgesProp);
    }
  }, [showFileSizeBadgesProp]);

  useEffect(() => {
    if (streamBadgePlacementProp !== undefined) {
      setStreamBadgePlacement(streamBadgePlacementProp);
    }
  }, [streamBadgePlacementProp]);

  useEffect(() => {
    if (stremioCacheFetchResultsProp !== undefined) {
      setStremioCacheFetchResults(stremioCacheFetchResultsProp);
    }
  }, [stremioCacheFetchResultsProp]);

  useEffect(() => {
    if (stremioCacheFetchTimeoutProp !== undefined) {
      setStremioCacheFetchTimeout(stremioCacheFetchTimeoutProp);
    }
  }, [stremioCacheFetchTimeoutProp]);

  useEffect(() => {
    if (showNuvioStreamBadgesProp !== undefined) {
      setShowNuvioStreamBadges(showNuvioStreamBadgesProp);
    }
  }, [showNuvioStreamBadgesProp]);

  useEffect(() => {
    if (nuvioBadgeSourcesProp !== undefined) {
      setNuvioBadgeSources(mergeDefaultBadgeSources(nuvioBadgeSourcesProp));
    }
  }, [nuvioBadgeSourcesProp]);

  useEffect(() => {
    if (nuvioBadgeSizeProp !== undefined) {
      setNuvioBadgeSize(nuvioBadgeSizeProp);
    }
  }, [nuvioBadgeSizeProp]);

  useEffect(() => {
    if (nuvioShowFileSizeBadgesProp !== undefined) {
      setNuvioShowFileSizeBadges(nuvioShowFileSizeBadgesProp);
    }
  }, [nuvioShowFileSizeBadgesProp]);

  useEffect(() => {
    if (nuvioStreamBadgePlacementProp !== undefined) {
      setNuvioStreamBadgePlacement(nuvioStreamBadgePlacementProp);
    }
  }, [nuvioStreamBadgePlacementProp]);

  useEffect(() => {
    if (showNuvioHoverDetailsProp !== undefined) {
      setShowNuvioHoverDetails(showNuvioHoverDetailsProp);
    }
  }, [showNuvioHoverDetailsProp]);

  useEffect(() => {
    if (nuvioCacheFetchResultsProp !== undefined) {
      setNuvioCacheFetchResults(nuvioCacheFetchResultsProp);
    }
  }, [nuvioCacheFetchResultsProp]);

  useEffect(() => {
    if (nuvioCacheFetchTimeoutProp !== undefined) {
      setNuvioCacheFetchTimeout(nuvioCacheFetchTimeoutProp);
    }
  }, [nuvioCacheFetchTimeoutProp]);

  const subtitleSettings = useSettingsStore((s) => s.subtitleSettings);
  const setSubtitleSettings = useSettingsStore((s) => s.setSubtitleSettings);
  const logoCacheEnabled = useSettingsStore((s) => s.logoCacheEnabled);
  const setLogoCacheEnabled = useSettingsStore((s) => s.setLogoCacheEnabled);
  const logoCacheMaxMb = useSettingsStore((s) => s.logoCacheMaxMb);
  const setLogoCacheMaxMb = useSettingsStore((s) => s.setLogoCacheMaxMb);
  const logoCacheTtlDays = useSettingsStore((s) => s.logoCacheTtlDays);
  const setLogoCacheTtlDays = useSettingsStore((s) => s.setLogoCacheTtlDays);
  const logoCachePrefetch = useSettingsStore((s) => s.logoCachePrefetch);
  const setLogoCachePrefetch = useSettingsStore((s) => s.setLogoCachePrefetch);
  const sourceLogoDisplayOverrides = useSettingsStore((s) => s.sourceLogoDisplayOverrides);
  const setSourceLogoDisplayOverride = useSettingsStore((s) => s.setSourceLogoDisplayOverride);
  const channelLogoSize = useSettingsStore((s) => s.channelLogoSize);
  const setChannelLogoSize = useSettingsStore((s) => s.setChannelLogoSize);
  const channelLogoRoundEdges = useSettingsStore((s) => s.channelLogoRoundEdges);
  const setChannelLogoRoundEdges = useSettingsStore((s) => s.setChannelLogoRoundEdges);
  const channelLogoPadding = useSettingsStore((s) => s.channelLogoPadding);
  const setChannelLogoPadding = useSettingsStore((s) => s.setChannelLogoPadding);
  const logoSmartTrim = useSettingsStore((s) => s.logoSmartTrim);
  const setLogoSmartTrim = useSettingsStore((s) => s.setLogoSmartTrim);
  const logoLightBackgroundDetection = useSettingsStore((s) => s.logoLightBackgroundDetection);
  const setLogoLightBackgroundDetection = useSettingsStore((s) => s.setLogoLightBackgroundDetection);
  const oledBlack = useSettingsStore((s) => s.oledBlack);
  const setOledBlack = useSettingsStore((s) => s.setOledBlack);

  // Category settings state
  const [showAllChannels, setShowAllChannels] = useState(true);
  const [showFavorites, setShowFavorites] = useState(true);
  const [showWatchlist, setShowWatchlist] = useState(true);
  const [showRecentlyViewed, setShowRecentlyViewed] = useState(true);
  const [favoritesMode, setFavoritesMode] = useState<'global' | 'perSource' | 'both'>('global');

  // LiveTV settings state
  const [epgDarkenCurrent, setEpgDarkenCurrent] = useState(false);
  const [epgHighlightBorderCurrent, setEpgHighlightBorderCurrent] = useState(false);
  const [epgBoldChannelNames, setEpgBoldChannelNames] = useState(false);
  const [epgBoldTopCategories, setEpgBoldTopCategories] = useState(false);
  const [epgBoldSourceCategories, setEpgBoldSourceCategories] = useState(false);
  const [epgPreferEpgLogos, setEpgPreferEpgLogos] = useState(false);
  const [epgLogoDisplay, setEpgLogoDisplay] = useState<'square' | 'rectangle'>('square');
  const [epgMetadataBadgeResolution, setEpgMetadataBadgeResolution] = useState(epgMetadataBadgeResolutionProp ?? true);
  const [epgMetadataBadgeFps, setEpgMetadataBadgeFps] = useState(epgMetadataBadgeFpsProp ?? true);
  const [epgMetadataBadgeFpsSuffix, setEpgMetadataBadgeFpsSuffix] = useState(epgMetadataBadgeFpsSuffixProp ?? true);
  const [epgMetadataBadgeSound, setEpgMetadataBadgeSound] = useState(epgMetadataBadgeSoundProp ?? true);
  const [epgTitleFontSize, setEpgTitleFontSize] = useState(32);
  const [epgBodyFontSize, setEpgBodyFontSize] = useState(16);
  const epgView = useEpgView();
  const setEpgView = useSetEpgView();
  const setEpgVisibleHours = useSetEpgVisibleHours();
  const [epgVisibleHours, setEpgVisibleHoursState] = useState<'auto' | number>('auto');
  const setEpgClockFormat = useSetEpgClockFormat();
  const [epgClockFormat, setEpgClockFormatState] = useState<'12h' | '24h'>('12h');
  const setEpgShowDate = useSetEpgShowDate();
  const [epgShowDate, setEpgShowDateState] = useState<boolean>(false);
  const [transparentGuideHeight, setTransparentGuideHeight] = useState(40);
  const [transparentGuideHideHeader, setTransparentGuideHideHeader] = useState(false);
  const [transparentGuideOverlayOpacity, setTransparentGuideOverlayOpacity] = useState(55);
  const [transparentGuideSidebarOpacity, setTransparentGuideSidebarOpacity] = useState(55);
  const [includeAllChannelsToPlaylist, setIncludeAllChannelsToPlaylistState] = useState(false);
  const setIncludeAllChannelsToPlaylist = useSetIncludeAllChannelsToPlaylist();

  // Live View settings state
  const [channelInfoOverlayEnabled, setChannelInfoOverlayEnabled] = useState(channelInfoOverlayEnabledProp ?? false);
  const [channelInfoOverlayFontSize, setChannelInfoOverlayFontSize] = useState(channelInfoOverlayFontSizeProp ?? 16);
  const [channelInfoOverlayLogoSize, setChannelInfoOverlayLogoSize] = useState(channelInfoOverlayLogoSizeProp ?? 42);
  const [channelInfoOverlayBoxWidth, setChannelInfoOverlayBoxWidth] = useState(channelInfoOverlayBoxWidthProp ?? 380);
  const [channelInfoOverlayOpacity, setChannelInfoOverlayOpacity] = useState(channelInfoOverlayOpacityProp ?? 55);
  const [channelInfoOverlayHideDescription, setChannelInfoOverlayHideDescription] = useState(channelInfoOverlayHideDescriptionProp ?? false);
  const [channelInfoOverlayHideMetaBadge, setChannelInfoOverlayHideMetaBadge] = useState(channelInfoOverlayHideMetaBadgeProp ?? false);
  const [channelInfoOverlayHideLogo, setChannelInfoOverlayHideLogo] = useState(channelInfoOverlayHideLogoProp ?? false);
  const [channelInfoOverlayHideTimer, setChannelInfoOverlayHideTimer] = useState(channelInfoOverlayHideTimerProp ?? false);
  const [channelInfoOverlayPosition, setChannelInfoOverlayPosition] = useState(channelInfoOverlayPositionProp ?? 'left');
  const [channelInfoOverlayLogoShape, setChannelInfoOverlayLogoShape] = useState<'square' | 'horizontal'>(channelInfoOverlayLogoShapeProp ?? 'square');

  // Popout settings state
  const [popoutStopMain, setPopoutStopMain] = useState(true);
  const [popoutAlwaysOnTop, setPopoutAlwaysOnTop] = useState(false);
  const [popoutHwdecEnabled, setPopoutHwdecEnabled] = useState(true);
  const [popoutMpvParamsEnabled, setPopoutMpvParamsEnabled] = useState(false);
  const [popoutMpvParams, setPopoutMpvParams] = useState('');
  // External player settings state
  const [externalPlayerPath, setExternalPlayerPath] = useState('');
  const [externalPlayerReuse, setExternalPlayerReuse] = useState(false);
  // Skip Intro settings state
  const [skipIntroTimerSeconds, setSkipIntroTimerSeconds] = useState(10);
  const [skipIntroAutoSkip, setSkipIntroAutoSkip] = useState(false);
  const [castEnabled, setCastEnabled] = useState(false);
  const [castRewriteTs, setCastRewriteTs] = useState(true);

  // Widget scale state
  const [widgetScale, setWidgetScaleState] = useState(1);
  const [widgetBgOpacity, setWidgetBgOpacityState] = useState(0.55);

  // Sports overlay state
  const [sportsScale, setSportsScaleState] = useState(1);
  const [sportsBgOpacity, setSportsBgOpacityState] = useState(0.7);

  // Sync prop values to internal state so changes from App.tsx take effect immediately
  useEffect(() => { setChannelInfoOverlayEnabled(channelInfoOverlayEnabledProp ?? false); }, [channelInfoOverlayEnabledProp]);
  useEffect(() => { setChannelInfoOverlayFontSize(channelInfoOverlayFontSizeProp ?? 16); }, [channelInfoOverlayFontSizeProp]);
  useEffect(() => { setChannelInfoOverlayLogoSize(channelInfoOverlayLogoSizeProp ?? 42); }, [channelInfoOverlayLogoSizeProp]);
  useEffect(() => { setChannelInfoOverlayBoxWidth(channelInfoOverlayBoxWidthProp ?? 380); }, [channelInfoOverlayBoxWidthProp]);
  useEffect(() => { setChannelInfoOverlayOpacity(channelInfoOverlayOpacityProp ?? 55); }, [channelInfoOverlayOpacityProp]);
  useEffect(() => { setChannelInfoOverlayHideDescription(channelInfoOverlayHideDescriptionProp ?? false); }, [channelInfoOverlayHideDescriptionProp]);
  useEffect(() => { setChannelInfoOverlayHideMetaBadge(channelInfoOverlayHideMetaBadgeProp ?? false); }, [channelInfoOverlayHideMetaBadgeProp]);
  useEffect(() => { setChannelInfoOverlayHideLogo(channelInfoOverlayHideLogoProp ?? false); }, [channelInfoOverlayHideLogoProp]);
  useEffect(() => { setChannelInfoOverlayHideTimer(channelInfoOverlayHideTimerProp ?? false); }, [channelInfoOverlayHideTimerProp]);
  useEffect(() => { setChannelInfoOverlayPosition(channelInfoOverlayPositionProp ?? 'left'); }, [channelInfoOverlayPositionProp]);
  useEffect(() => { setChannelInfoOverlayLogoShape(channelInfoOverlayLogoShapeProp ?? 'square'); }, [channelInfoOverlayLogoShapeProp]);
  useEffect(() => { setEpgMetadataBadgeResolution(epgMetadataBadgeResolutionProp ?? true); }, [epgMetadataBadgeResolutionProp]);
  useEffect(() => { setEpgMetadataBadgeFps(epgMetadataBadgeFpsProp ?? true); }, [epgMetadataBadgeFpsProp]);
  useEffect(() => { setEpgMetadataBadgeFpsSuffix(epgMetadataBadgeFpsSuffixProp ?? true); }, [epgMetadataBadgeFpsSuffixProp]);
  useEffect(() => { setEpgMetadataBadgeSound(epgMetadataBadgeSoundProp ?? true); }, [epgMetadataBadgeSoundProp]);
  useEffect(() => { setCastEnabled(castEnabledProp ?? false); }, [castEnabledProp]);
  useEffect(() => { setCastRewriteTs(castRewriteTsProp ?? true); }, [castRewriteTsProp]);
  
  // Sync overlay autohide timer prop to uiSettings if needed, though uiSettings has it
  useEffect(() => { 
    if (overlayAutohideTimerProp !== undefined && overlayAutohideTimerProp !== uiSettings.overlayAutohideTimer) {
      setUiSettings(prev => ({ ...prev, overlayAutohideTimer: overlayAutohideTimerProp }));
    }
  }, [overlayAutohideTimerProp]);

  useEffect(() => { 
    if (overlayOnClickOnlyProp !== undefined && overlayOnClickOnlyProp !== uiSettings.overlayOnClickOnly) {
      setUiSettings(prev => ({ ...prev, overlayOnClickOnly: overlayOnClickOnlyProp }));
    }
  }, [overlayOnClickOnlyProp]);

  // Loading state for settings
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Load sources and check encryption on mount
  useEffect(() => {
    loadSources();
    checkEncryption();
    loadSettings();
  }, []);

  // Listen for category settings changes from context menu hide actions
  useEffect(() => {
    const handleCategorySettingsChange = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail) {
        if (customEvent.detail.showAllChannels !== undefined) {
          setShowAllChannels(customEvent.detail.showAllChannels);
        }
        if (customEvent.detail.showFavorites !== undefined) {
          setShowFavorites(customEvent.detail.showFavorites);
        }
        if (customEvent.detail.showWatchlist !== undefined) {
          setShowWatchlist(customEvent.detail.showWatchlist);
        }
        if (customEvent.detail.showRecentlyViewed !== undefined) {
          setShowRecentlyViewed(customEvent.detail.showRecentlyViewed);
        }
      }
    };
    window.addEventListener('ynotv:category-settings-changed', handleCategorySettingsChange);
    return () => {
      window.removeEventListener('ynotv:category-settings-changed', handleCategorySettingsChange);
    };
  }, []);

  // Listen for transparent guide height changes from dragging the EPG overlay
  useEffect(() => {
    const handleTransparentGuideHeightChangeCustom = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (customEvent.detail && typeof customEvent.detail.height === 'number') {
        setTransparentGuideHeight(customEvent.detail.height);
      }
    };
    window.addEventListener('ynotv:transparent-guide-height-changed', handleTransparentGuideHeightChangeCustom);
    return () => {
      window.removeEventListener('ynotv:transparent-guide-height-changed', handleTransparentGuideHeightChangeCustom);
    };
  }, []);

  async function loadSources() {
    // window.storage is the Tauri storage bridge - if missing, app is broken
    if (!window.storage) {
      console.error('[Settings] window.storage unavailable - Tauri storage bridge missing');
      return;
    }
    const result = await window.storage.getSources();
    if (result.data) {
      // Debug: Check for duplicated EPG URLs
      result.data.forEach((source: Source) => {
        if (source.epg_url && source.epg_url.length > 100) {
          console.log(`[Settings] Source ${source.name} has long epg_url (${source.epg_url.length} chars):`, source.epg_url.substring(0, 100) + '...');
        }
      });
      setSources(result.data);
    }
  }

  async function checkEncryption() {
    if (!window.storage) {
      console.error('[Settings] window.storage unavailable - Tauri storage bridge missing');
      return;
    }
    const result = await window.storage.isEncryptionAvailable();
    if (result.data !== undefined) {
      setIsEncryptionAvailable(result.data);
    }
  }

  async function loadSettings() {
    if (!window.storage) {
      console.error('[Settings] window.storage unavailable - Tauri storage bridge missing');
      return;
    }
    const result = await window.storage.getSettings();
    if (result.data) {
      const settings = result.data as {
        tmdbApiKey?: string;
        vodRefreshHours?: number;
        epgRefreshHours?: number;
        epgSyncConcurrency?: number;
        posterDbApiKey?: string;
        rpdbBackdropsEnabled?: boolean;
        allowLanSources?: boolean;
        socks5ProxyEnabled?: boolean;
        socks5ProxyServer?: string;
        socks5ProxyUsername?: string;
        socks5ProxyPassword?: string;
        discordRichPresence?: boolean;
        discordHideTitle?: boolean;
        discordShowWhenPaused?: boolean;
        discordShowWhenBrowsing?: boolean;
        discordShowPoster?: boolean;
        discordShowTimestamp?: boolean;
        streamingCatalogsEnabled?: boolean;
        streamingNuvioCatalogsEnabled?: boolean;
        enabledStreamingServices?: string[];
        debugLoggingEnabled?: boolean;
        logRetentionDays?: number;
        channelSortOrder?: 'alphabetical' | 'number' | 'provider';
        categorySortOrder?: 'default' | 'alphabetical';
        includeSourceInSearch?: boolean;
        includeSourceInVodSearch?: boolean;
        maxSearchResults?: number;
        searchResultsOrder?: 'default' | 'alphabetical';
        shortcuts?: ShortcutsMap;
        channelFontSize?: number;
        categoryFontSize?: number;
        sourceFontSize?: number;
        startupWidth?: number;
        startupHeight?: number;
        dontSaveWindowSizeOnClose?: boolean;
        minimizeToTray?: boolean;
        rememberLastChannels?: boolean;
        reopenLastOnStartup?: boolean;
        savedLayoutState?: SavedLayoutState;
        startupView?: 'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'sports' | 'calendar' | 'stremio' | 'nuvio';
        mpvParams?: string;
        mpvHwdecEnabled?: boolean;
        timeshiftEnabled?: boolean;
        timeshiftCacheBytes?: number;
        liveBufferOffset?: number;
        streamWatchdogSeconds?: number;
        streamMaxRetries?: number;
        useEventBasedReconnect?: boolean;
        stallDetectionEnabled?: boolean;
        showLoadingScreen?: boolean;
        catchupStartPadding?: number;
        catchupEndPadding?: number;
        catchupContinuePlaying?: boolean;
        epgDarkenCurrent?: boolean;
        epgHighlightBorderCurrent?: boolean;
        epgBoldChannelNames?: boolean;
        epgBoldTopCategories?: boolean;
        epgBoldSourceCategories?: boolean;
        epgPreferEpgLogos?: boolean;
        epgLogoDisplay?: 'square' | 'rectangle';
        epgMetadataBadgeResolution?: boolean;
        epgMetadataBadgeFps?: boolean;
        epgMetadataBadgeFpsSuffix?: boolean;
        epgMetadataBadgeSound?: boolean;
        epgView?: 'traditional' | 'alternate';
        collapseSourceCategoriesOnStartup?: boolean;
        modernUiEnabled?: boolean | string;
        v3DefaultMigrated?: boolean;
        overlayAutohideTimer?: number;
        overlayOnClickOnly?: boolean;
        uiScale?: number;
        playerControlDesign?: 'default' | 'clean';
        showVolumePercent?: boolean;
        epgVisibleHours?: 'auto' | number;
        epgClockFormat?: '12h' | '24h';
        epgShowDate?: boolean;
        epgTitleFontSize?: number;
        epgBodyFontSize?: number;
        channelInfoOverlayEnabled?: boolean;
        channelInfoOverlayFontSize?: number;
        channelInfoOverlayLogoSize?: number;
        channelInfoOverlayBoxWidth?: number;
        channelInfoOverlayOpacity?: number;
        channelInfoOverlayHideDescription?: boolean;
        popoutStopMain?: boolean;
        popoutAlwaysOnTop?: boolean;
        popoutHwdecEnabled?: boolean;
        popoutMpvParamsEnabled?: boolean;
        popoutMpvParams?: string;
        externalPlayerPath?: string;
        externalPlayerReuse?: boolean;
        skipIntroTimerSeconds?: number;
        skipIntroAutoSkip?: boolean;
        subtitleSettings?: SubtitleSettings;
        widgetScale?: number;
        widgetBgOpacity?: number;
        sportsScale?: number;
        sportsBgOpacity?: number;
        stremioStreamPickerMode?: 'modal' | 'autoplay';
        showStremioStreamBadges?: boolean;
        stremioCacheFetchResults?: boolean;
        stremioCacheFetchTimeout?: number;
        badgeSources?: BadgeSource[];
        stremioBadgeSize?: number;
        showFileSizeBadges?: boolean;
        streamBadgePlacement?: 'top' | 'bottom';
        showNuvioStreamBadges?: boolean;
        nuvioBadgeSources?: BadgeSource[];
        nuvioBadgeSize?: number;
        nuvioShowFileSizeBadges?: boolean;
        nuvioStreamBadgePlacement?: 'top' | 'bottom';
        navHiddenTabs?: string[];
        epgHiddenButtons?: string[];
        castEnabled?: boolean;
        castRewriteTs?: boolean;
        transparentGuideHeight?: number;
        transparentGuideHideHeader?: boolean;
        transparentGuideOnZap?: boolean;
        transparentGuideOverlayOpacity?: number;
        transparentGuideSidebarOpacity?: number;
        showAllChannels?: boolean;
        showFavorites?: boolean;
        showWatchlist?: boolean;
        showRecentlyViewed?: boolean;
        favoritesMode?: 'global' | 'perSource' | 'both';
        showNuvioHoverDetails?: boolean;
        nuvioAutoPlayMode?: StreamAutoPlayMode;
        nuvioAutoPlayTimeout?: number;
        nuvioAutoPlaySourceScope?: StreamAutoPlaySourceScope;
        nuvioAutoPlayAllowedAddons?: string[];
        nuvioAutoPlayAllowedPlugins?: string[];
        nuvioAutoPlayRegex?: string;
        nuvioCacheFetchResults?: boolean;
        nuvioCacheFetchTimeout?: number;
        includeAllChannelsToPlaylist?: boolean;
        vodAutoPlayNextEpisode?: boolean;
        vodShowSourceBadge?: boolean;
        failoverGroupShowSource?: boolean;
      };

      setShowAllChannels(settings.showAllChannels ?? true);
      setShowFavorites(settings.showFavorites ?? true);
      setShowWatchlist(settings.showWatchlist ?? true);
      setShowRecentlyViewed(settings.showRecentlyViewed ?? true);
      const favMode = settings.favoritesMode;
      setFavoritesMode(favMode === 'perSource' || favMode === 'both' || favMode === 'global' ? favMode : 'global');

      if (settings.castEnabled !== undefined) {
        setCastEnabled(settings.castEnabled);
      }
      if (settings.castRewriteTs !== undefined) {
        setCastRewriteTs(settings.castRewriteTs);
      }

      // TMDB key + streaming-catalog settings hydrate through the settings
      // store (setters keep them current). Only the validation flags are local.
      if (settings.tmdbApiKey) {
        setTmdbKeyValid(true); // Assume valid if previously saved
      }

      // Load refresh settings
      if (settings.vodRefreshHours !== undefined) {
        setVodRefreshHours(settings.vodRefreshHours);
      }
      if (settings.epgRefreshHours !== undefined) {
        setEpgRefreshHours(settings.epgRefreshHours);
      }
      if (settings.epgSyncConcurrency !== undefined) {
        setEpgSyncConcurrency(settings.epgSyncConcurrency);
      }

      // PosterDB key + backdrops hydrate through the settings store; only the
      // validation flag is local.
      if (settings.posterDbApiKey) {
        setPosterDbKeyValid(true); // Assume valid if previously saved
      }

      // Load security settings
      setAllowLanSources(settings.allowLanSources ?? false);

      // Load proxy settings
      setSocks5ProxyEnabled(result.data.socks5ProxyEnabled ?? false);
      setSocks5ProxyServer(result.data.socks5ProxyServer ?? '');
      setSocks5ProxyUsername(result.data.socks5ProxyUsername ?? '');
      setSocks5ProxyPassword(result.data.socks5ProxyPassword ?? '');
      setDiscordRichPresenceState(result.data.discordRichPresence ?? false);
      setDiscordHideTitleState(result.data.discordHideTitle ?? false);
      setDiscordShowWhenPausedState(result.data.discordShowWhenPaused ?? true);
      setDiscordShowWhenBrowsingState(result.data.discordShowWhenBrowsing ?? true);
      setDiscordShowPosterState(result.data.discordShowPoster ?? true);
      setDiscordShowTimestampState(result.data.discordShowTimestamp ?? true);

      // Load debug settings
      setDebugLoggingEnabled(settings.debugLoggingEnabled ?? false);
      setLogRetentionDays(settings.logRetentionDays ?? 7);

      // Load channel display settings
      setChannelSortOrder(settings.channelSortOrder ?? 'provider');
      setCategorySortOrder(settings.categorySortOrder ?? 'default');
      setIncludeSourceInSearch(settings.includeSourceInSearch ?? false);
      setIncludeSourceInVodSearch(settings.includeSourceInVodSearch ?? false);
      setMaxSearchResults(clampMaxSearchResults(settings.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS));
      setSearchResultsOrder(settings.searchResultsOrder ?? 'default');

      // Load shortcuts
      if (settings.shortcuts) {
        setShortcuts(settings.shortcuts);
      }

      // Load UI settings
      let loadedModernUi = settings.modernUiEnabled;
      if (!settings.v3DefaultMigrated) {
        loadedModernUi = 'v3';
        window.storage.updateSettings({
          modernUiEnabled: 'v3',
          v3DefaultMigrated: true
        });
      }
      const loadedUiSettings = {
        startupWidth: settings.startupWidth,
        startupHeight: settings.startupHeight,
        dontSaveWindowSizeOnClose: settings.dontSaveWindowSizeOnClose ?? false,
        minimizeToTray: settings.minimizeToTray ?? false,
        modernUiEnabled: loadedModernUi,
        collapseSourceCategoriesOnStartup: settings.collapseSourceCategoriesOnStartup ?? false,
        overlayAutohideTimer: settings.overlayAutohideTimer ?? 3,
        overlayOnClickOnly: settings.overlayOnClickOnly ?? false,
        uiScale: settings.uiScale ?? 100,
        playerControlDesign: settings.playerControlDesign ?? 'clean',
        showVolumePercent: settings.showVolumePercent ?? showVolumePercentProp ?? false,
      };
      setUiSettings(loadedUiSettings);

      // Load font size settings (moved to LiveTV tab)
      const loadedChannelFontSize = settings.channelFontSize ?? (loadedModernUi === 'v3' ? 12 : 14);
      const loadedCategoryFontSize = settings.categoryFontSize ?? 13;
      const loadedSourceFontSize = settings.sourceFontSize ?? 12;
      setChannelFontSize(loadedChannelFontSize);
      setCategoryFontSize(loadedCategoryFontSize);
      setSourceFontSize(loadedSourceFontSize);
      // Font-size CSS vars + design classes are owned by the DOM applier
      // (settings store), which already applied them at boot/hydration.

      // Load startup settings
      setRememberLastChannels(settings.rememberLastChannels ?? false);
      setReopenLastOnStartup(settings.reopenLastOnStartup ?? false);
      setSavedLayoutState(settings.savedLayoutState ?? null);
      setStartupView(settings.startupView ?? 'none');
      navHiddenTabsStore(settings.navHiddenTabs ?? []);
      epgHiddenButtonsStore(settings.epgHiddenButtons ?? []);

      // Load playback settings
      setMpvParams(settings.mpvParams ?? '');
      setMpvHwdecEnabled(settings.mpvHwdecEnabled ?? true);
      setTimeshiftEnabled(settings.timeshiftEnabled ?? true);
      setTimeshiftCacheBytes(settings.timeshiftCacheBytes ?? 268_435_456);
      setLiveBufferOffset(settings.liveBufferOffset ?? 0);
      setStreamWatchdogSeconds(settings.streamWatchdogSeconds ?? 10);
      setStreamMaxRetries(settings.streamMaxRetries ?? 20);
      setUseEventBasedReconnect(settings.useEventBasedReconnect ?? false);
      setStallDetectionEnabled(settings.stallDetectionEnabled ?? true);
      setShowLoadingScreen(settings.showLoadingScreen ?? false);
      setCatchupStartPadding(settings.catchupStartPadding ?? 0);
      setCatchupEndPadding(settings.catchupEndPadding ?? 0);
      setCatchupContinuePlaying(settings.catchupContinuePlaying ?? false);
      setVodAutoPlayNextEpisode(settings.vodAutoPlayNextEpisode ?? true);
      setVodShowSourceBadge(settings.vodShowSourceBadge ?? false);
      setFailoverGroupShowSource(settings.failoverGroupShowSource ?? false);
      setStremioStreamPickerMode(settings.stremioStreamPickerMode ?? 'modal');
      setShowStremioStreamBadges(settings.showStremioStreamBadges ?? true);
      setBadgeSources(mergeDefaultBadgeSources(settings.badgeSources as BadgeSource[] | undefined));
      setStremioBadgeSize(settings.stremioBadgeSize ?? 100);
      if (settings.showFileSizeBadges !== undefined) {
        setShowFileSizeBadges(settings.showFileSizeBadges);
      }
      if (settings.stremioCacheFetchResults !== undefined) {
        setStremioCacheFetchResults(settings.stremioCacheFetchResults as boolean);
      }
      if (settings.stremioCacheFetchTimeout !== undefined) {
        setStremioCacheFetchTimeout(settings.stremioCacheFetchTimeout as number);
      }
      if (settings.streamBadgePlacement !== undefined) {
        setStreamBadgePlacement(settings.streamBadgePlacement as 'top' | 'bottom');
      }
      setShowNuvioStreamBadges(settings.showNuvioStreamBadges ?? true);
      setNuvioBadgeSources(mergeDefaultBadgeSources(settings.nuvioBadgeSources as BadgeSource[] | undefined));
      setNuvioBadgeSize(settings.nuvioBadgeSize ?? 100);
      if (settings.nuvioShowFileSizeBadges !== undefined) {
        setNuvioShowFileSizeBadges(settings.nuvioShowFileSizeBadges);
      }
      if (settings.nuvioStreamBadgePlacement !== undefined) {
        setNuvioStreamBadgePlacement(settings.nuvioStreamBadgePlacement as 'top' | 'bottom');
      }
      if (settings.showNuvioHoverDetails !== undefined) {
        setShowNuvioHoverDetails(settings.showNuvioHoverDetails);
      }
      if (settings.nuvioAutoPlayMode !== undefined) {
        setNuvioAutoPlayMode(settings.nuvioAutoPlayMode as StreamAutoPlayMode);
      }
      if (settings.nuvioAutoPlayTimeout !== undefined) {
        setNuvioAutoPlayTimeout(settings.nuvioAutoPlayTimeout as number);
      }
      if (settings.nuvioAutoPlaySourceScope !== undefined) {
        setNuvioAutoPlaySourceScope(settings.nuvioAutoPlaySourceScope as StreamAutoPlaySourceScope);
      }
      if (settings.nuvioAutoPlayAllowedAddons !== undefined) {
        setNuvioAutoPlayAllowedAddons(settings.nuvioAutoPlayAllowedAddons as string[]);
      }
      if (settings.nuvioAutoPlayAllowedPlugins !== undefined) {
        setNuvioAutoPlayAllowedPlugins(settings.nuvioAutoPlayAllowedPlugins as string[]);
      }
      if (settings.nuvioAutoPlayRegex !== undefined) {
        setNuvioAutoPlayRegex(settings.nuvioAutoPlayRegex as string);
      }
      if (settings.nuvioCacheFetchResults !== undefined) {
        setNuvioCacheFetchResults(settings.nuvioCacheFetchResults as boolean);
      }
      if (settings.nuvioCacheFetchTimeout !== undefined) {
        setNuvioCacheFetchTimeout(settings.nuvioCacheFetchTimeout as number);
      }

      // Load LiveTV settings. The epg-* CSS classes are owned by the DOM
      // applier (settings store) — already applied at boot/hydration; only
      // seed the editor's local form state here.
      setEpgDarkenCurrent(settings.epgDarkenCurrent ?? false);
      setEpgHighlightBorderCurrent(settings.epgHighlightBorderCurrent ?? false);
      setEpgBoldChannelNames(settings.epgBoldChannelNames ?? false);
      setEpgBoldTopCategories(settings.epgBoldTopCategories ?? false);
      setEpgBoldSourceCategories(settings.epgBoldSourceCategories ?? false);
      setEpgPreferEpgLogos(settings.epgPreferEpgLogos ?? false);
      setEpgLogoDisplay(settings.epgLogoDisplay ?? 'square');

      // Load EPG visible hours setting
      const rawEpgVisibleHours = settings.epgVisibleHours ?? 'auto';
      const loadedEpgVisibleHours = rawEpgVisibleHours === 'auto' ? 'auto' : Number(rawEpgVisibleHours);
      setEpgVisibleHoursState(loadedEpgVisibleHours);
      setEpgVisibleHours(loadedEpgVisibleHours);

      // Load EPG clock format setting
      const loadedClockFormat = (settings.epgClockFormat as '12h' | '24h') ?? '12h';
      setEpgClockFormatState(loadedClockFormat);
      setEpgClockFormat(loadedClockFormat);

      // Load EPG show date setting
      const loadedShowDate = (settings.epgShowDate as boolean) ?? false;
      setEpgShowDateState(loadedShowDate);
      setEpgShowDate(loadedShowDate);

      // Load transparent guide overlay settings (CSS vars owned by the DOM
      // applier — already applied at boot/hydration).
      setTransparentGuideHeight(settings.transparentGuideHeight ?? 40);
      setTransparentGuideHideHeader(settings.transparentGuideHideHeader ?? false);
      setTransparentGuideOverlayOpacity(settings.transparentGuideOverlayOpacity ?? 55);
      setTransparentGuideSidebarOpacity(settings.transparentGuideSidebarOpacity ?? 55);

      // Load include all channels to playlist setting
      const loadedIncludeAllChannels = settings.includeAllChannelsToPlaylist ?? false;
      setIncludeAllChannelsToPlaylistState(loadedIncludeAllChannels);
      setIncludeAllChannelsToPlaylist(loadedIncludeAllChannels);

      // Load EPG font size settings
      const loadedEpgTitleFontSize = settings.epgTitleFontSize ?? 32;
      const loadedEpgBodyFontSize = settings.epgBodyFontSize ?? 16;
      // EPG font-size CSS vars are owned by the DOM applier — already applied
      // at boot/hydration.
      setEpgTitleFontSize(loadedEpgTitleFontSize);
      setEpgBodyFontSize(loadedEpgBodyFontSize);

      // Load Live View settings
      setChannelInfoOverlayEnabled(settings.channelInfoOverlayEnabled ?? false);
      setChannelInfoOverlayFontSize(settings.channelInfoOverlayFontSize ?? 16);
      setChannelInfoOverlayLogoSize(settings.channelInfoOverlayLogoSize ?? 42);
      setChannelInfoOverlayBoxWidth(settings.channelInfoOverlayBoxWidth ?? 380);
      setChannelInfoOverlayOpacity(settings.channelInfoOverlayOpacity ?? 55);
      setChannelInfoOverlayHideDescription(settings.channelInfoOverlayHideDescription ?? false);

      // Load Popout settings
      setPopoutStopMain(settings.popoutStopMain ?? true);
      setPopoutAlwaysOnTop(settings.popoutAlwaysOnTop ?? false);
      setPopoutHwdecEnabled(settings.popoutHwdecEnabled ?? true);
      setPopoutMpvParamsEnabled(settings.popoutMpvParamsEnabled ?? false);
      setPopoutMpvParams(settings.popoutMpvParams ?? '');

      // Load External Player settings
      setExternalPlayerPath(settings.externalPlayerPath ?? '');
      setExternalPlayerReuse(settings.externalPlayerReuse ?? false);

      // Load Skip Intro settings
      setSkipIntroTimerSeconds(settings.skipIntroTimerSeconds ?? 10);
      setSkipIntroAutoSkip(settings.skipIntroAutoSkip ?? false);

      // Widget/sports scale + opacity vars are owned by the DOM applier
      // (settings store) — already applied at boot/hydration; only seed the
      // editor's local form state here.
      setWidgetScaleState(settings.widgetScale ?? 1);
      setWidgetBgOpacityState(settings.widgetBgOpacity ?? 0.55);
      setSportsScaleState(settings.sportsScale ?? 1);
      setSportsBgOpacityState(settings.sportsBgOpacity ?? 0.7);
    }
    setSettingsLoaded(true);
  }

  // Search functionality
  useEffect(() => {
    setSearchResults(searchSettings(searchQuery));
  }, [searchQuery]);

  useEffect(() => {
    setPendingSubTab(null);
  }, [activeTab]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchResults([]);
        setSearchQuery('');
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape' && searchQuery) {
        setSearchResults([]);
        setSearchQuery('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [searchQuery]);

  function handleSearchResultClick(result: SettingsSearchResult) {
    handleTabChange(result.tabId);
    if (result.subTabId) {
      setPendingSubTab(result.subTabId);
    }
    setSearchQuery('');
    setSearchResults([]);
  }

  function groupByTab(results: SettingsSearchResult[]) {
    const map = new Map<SettingsTabId, { tabId: SettingsTabId; tabLabel: string; items: SettingsSearchResult[] }>();
    for (const r of results) {
      if (!map.has(r.tabId)) {
        map.set(r.tabId, { tabId: r.tabId, tabLabel: r.tabLabel, items: [] });
      }
      map.get(r.tabId)!.items.push(r);
    }
    return Array.from(map.values());
  }

  function highlightMatch(text: string, query: string) {
    if (!query.trim()) return text;
    const q = query.toLowerCase();
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="settings-search-highlight">{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    );
  }

  // Check if any VOD source exists (Xtream or Stalker) for showing tabs
  const hasVodSource = sources.some(s => s.type === 'xtream' || s.type === 'stalker');

  const handleSocks5ProxyEnabledChange = (enabled: boolean) => {
    setSocks5ProxyEnabled(enabled);
  };

  const handleSocks5ProxyServerChange = (server: string) => {
    setSocks5ProxyServer(server);
  };

  const handleSocks5ProxyUsernameChange = (user: string) => {
    setSocks5ProxyUsername(user);
  };

  const handleSocks5ProxyPasswordChange = (pass: string) => {
    setSocks5ProxyPassword(pass);
  };

  const handleMpvParamsChange = async (params: string) => {
    setMpvParams(params);
    if (window.storage) {
      await window.storage.updateSettings({ mpvParams: params });
    }
  };


  const handleMpvHwdecEnabledChange = async (enabled: boolean) => {
    setMpvHwdecEnabled(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ mpvHwdecEnabled: enabled });
    }
  };

  const handleCastEnabledChange = async (enabled: boolean) => {
    setCastEnabled(enabled);
    if (onCastEnabledChange) {
      onCastEnabledChange(enabled);
    }
    if (window.storage) {
      await window.storage.updateSettings({ castEnabled: enabled });
    }
  };

  const handleCastRewriteTsChange = async (enabled: boolean) => {
    setCastRewriteTs(enabled);
    if (onCastRewriteTsChange) {
      onCastRewriteTsChange(enabled);
    }
    if (window.storage) {
      await window.storage.updateSettings({ castRewriteTs: enabled });
    }
  };

  const handleStreamWatchdogSecondsChange = async (seconds: number) => {
    setStreamWatchdogSeconds(seconds);
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ streamWatchdogSeconds: seconds });
    }
    window.dispatchEvent(new CustomEvent('ynotv:retry-settings-changed', {
      detail: { streamWatchdogSeconds: seconds }
    }));
  };

  const handleStreamMaxRetriesChange = async (retries: number) => {
    setStreamMaxRetries(retries);
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ streamMaxRetries: retries });
    }
    window.dispatchEvent(new CustomEvent('ynotv:retry-settings-changed', {
      detail: { streamMaxRetries: retries }
    }));
  };

  const handleUseEventBasedReconnectChange = async (enabled: boolean) => {
    setUseEventBasedReconnect(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ useEventBasedReconnect: enabled });
    }
    window.dispatchEvent(new CustomEvent('ynotv:retry-settings-changed', {
      detail: { useEventBasedReconnect: enabled }
    }));
  };

  const handleStallDetectionEnabledChange = async (enabled: boolean) => {
    setStallDetectionEnabled(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ stallDetectionEnabled: enabled });
    }
    window.dispatchEvent(new CustomEvent('ynotv:retry-settings-changed', {
      detail: { stallDetectionEnabled: enabled }
    }));
  };

  const handleShowLoadingScreenChange = async (enabled: boolean) => {
    setShowLoadingScreen(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ showLoadingScreen: enabled });
    }
    window.dispatchEvent(new CustomEvent('ynotv:retry-settings-changed', {
      detail: { showLoadingScreen: enabled }
    }));
  };

  const handleCatchupStartPaddingChange = async (padding: number) => {
    setCatchupStartPadding(padding);
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ catchupStartPadding: padding });
    }
    window.dispatchEvent(new CustomEvent('ynotv:catchup-settings-changed', {
      detail: { catchupStartPadding: padding }
    }));
  };

  const handleCatchupEndPaddingChange = async (padding: number) => {
    setCatchupEndPadding(padding);
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ catchupEndPadding: padding });
    }
    window.dispatchEvent(new CustomEvent('ynotv:catchup-settings-changed', {
      detail: { catchupEndPadding: padding }
    }));
  };

  const handleCatchupContinuePlayingChange = async (enabled: boolean) => {
    setCatchupContinuePlaying(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ catchupContinuePlaying: enabled });
    }
    window.dispatchEvent(new CustomEvent('ynotv:catchup-settings-changed', {
      detail: { catchupContinuePlaying: enabled }
    }));
  };

  const handleVodAutoPlayNextEpisodeChange = async (enabled: boolean) => {
    setVodAutoPlayNextEpisode(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ vodAutoPlayNextEpisode: enabled });
    }
    window.dispatchEvent(new CustomEvent('ynotv:vod-settings-changed', {
      detail: { vodAutoPlayNextEpisode: enabled }
    }));
    if (onVodAutoPlayNextEpisodeChange) {
      onVodAutoPlayNextEpisodeChange(enabled);
    }
  };

  const handleVodShowSourceBadgeChange = async (enabled: boolean) => {
    setVodShowSourceBadge(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ vodShowSourceBadge: enabled });
    }
    window.dispatchEvent(new CustomEvent('ynotv:vod-settings-changed', {
      detail: { vodShowSourceBadge: enabled }
    }));
    if (onVodShowSourceBadgeChange) {
      onVodShowSourceBadgeChange(enabled);
    }
  };

  const handleFailoverGroupShowSourceChange = async (enabled: boolean) => {
    setFailoverGroupShowSource(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ failoverGroupShowSource: enabled });
    }
    window.dispatchEvent(new CustomEvent('ynotv:livetv-settings-changed', {
      detail: { failoverGroupShowSource: enabled }
    }));
    if (onFailoverGroupShowSourceChange) {
      onFailoverGroupShowSourceChange(enabled);
    }
  };

  const handleStremioStreamPickerModeChange = async (mode: StremioStreamPickerMode) => {
    setStremioStreamPickerMode(mode);
    if (onStremioStreamPickerModeChange) {
      onStremioStreamPickerModeChange(mode);
    }
    if (window.storage) {
      await window.storage.updateSettings({ stremioStreamPickerMode: mode });
    }
  };

  const handleShowStremioStreamBadgesChange = async (show: boolean) => {
    setShowStremioStreamBadges(show);
    if (onShowStremioStreamBadgesChange) {
      onShowStremioStreamBadgesChange(show);
    }
    if (window.storage) {
      await window.storage.updateSettings({ showStremioStreamBadges: show });
    }
  };

  const handleBadgeSourcesChange = async (sources: BadgeSource[]) => {
    setBadgeSources(sources);
    if (onBadgeSourcesChange) {
      onBadgeSourcesChange(sources);
    }
    if (window.storage) {
      await window.storage.updateSettings({ badgeSources: sources });
    }
  };

  const handleStremioBadgeSizeChange = (size: number) => {
    setStremioBadgeSize(size);
    if (onStremioBadgeSizeChange) {
      onStremioBadgeSizeChange(size);
    }
  };

  const handleShowHoverDetailsChange = async (show: boolean) => {
    setShowHoverDetails(show);
    document.documentElement.toggleAttribute('data-hover-details-disabled', !show);
    if (onShowHoverDetailsChange) {
      onShowHoverDetailsChange(show);
    }
    if (window.storage) {
      await window.storage.updateSettings({ showHoverDetails: show });
    }
  };

  const handleShowFileSizeBadgesChange = async (show: boolean) => {
    setShowFileSizeBadges(show);
    if (onShowFileSizeBadgesChange) {
      onShowFileSizeBadgesChange(show);
    }
    if (window.storage) {
      await window.storage.updateSettings({ showFileSizeBadges: show });
    }
  };

  const handleStreamBadgePlacementChange = async (placement: 'top' | 'bottom') => {
    setStreamBadgePlacement(placement);
    if (onStreamBadgePlacementChange) {
      onStreamBadgePlacementChange(placement);
    }
    if (window.storage) {
      await window.storage.updateSettings({ streamBadgePlacement: placement });
    }
  };

  const handleStremioCacheFetchResultsChange = async (enabled: boolean) => {
    setStremioCacheFetchResults(enabled);
    if (onStremioCacheFetchResultsChange) {
      onStremioCacheFetchResultsChange(enabled);
    }
    if (window.storage) {
      await window.storage.updateSettings({ stremioCacheFetchResults: enabled });
    }
  };

  const handleStremioCacheFetchTimeoutChange = async (timeout: number) => {
    setStremioCacheFetchTimeout(timeout);
    if (onStremioCacheFetchTimeoutChange) {
      onStremioCacheFetchTimeoutChange(timeout);
    }
    if (window.storage) {
      await window.storage.updateSettings({ stremioCacheFetchTimeout: timeout });
    }
  };

  const handleShowNuvioStreamBadgesChange = async (show: boolean) => {
    setShowNuvioStreamBadges(show);
    if (onShowNuvioStreamBadgesChange) {
      onShowNuvioStreamBadgesChange(show);
    }
    if (window.storage) {
      await window.storage.updateSettings({ showNuvioStreamBadges: show });
    }
  };

  const handleNuvioBadgeSourcesChange = async (sources: BadgeSource[]) => {
    setNuvioBadgeSources(sources);
    if (onNuvioBadgeSourcesChange) {
      onNuvioBadgeSourcesChange(sources);
    }
    if (window.storage) {
      await window.storage.updateSettings({ nuvioBadgeSources: sources });
    }
  };

  const handleNuvioBadgeSizeChange = (size: number) => {
    setNuvioBadgeSize(size);
    if (onNuvioBadgeSizeChange) {
      onNuvioBadgeSizeChange(size);
    }
  };

  const handleNuvioShowFileSizeBadgesChange = async (show: boolean) => {
    setNuvioShowFileSizeBadges(show);
    if (onNuvioShowFileSizeBadgesChange) {
      onNuvioShowFileSizeBadgesChange(show);
    }
    if (window.storage) {
      await window.storage.updateSettings({ nuvioShowFileSizeBadges: show });
    }
  };

  const handleNuvioStreamBadgePlacementChange = async (placement: 'top' | 'bottom') => {
    setNuvioStreamBadgePlacement(placement);
    if (onNuvioStreamBadgePlacementChange) {
      onNuvioStreamBadgePlacementChange(placement);
    }
    if (window.storage) {
      await window.storage.updateSettings({ nuvioStreamBadgePlacement: placement });
    }
  };

  const handleShowNuvioHoverDetailsChange = async (show: boolean) => {
    setShowNuvioHoverDetails(show);
    if (onShowNuvioHoverDetailsChange) {
      onShowNuvioHoverDetailsChange(show);
    }
    if (window.storage) {
      await window.storage.updateSettings({ showNuvioHoverDetails: show });
    }
  };

  const handleNuvioAutoPlayModeChange = async (mode: StreamAutoPlayMode) => {
    setNuvioAutoPlayMode(mode);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioAutoPlayMode: mode });
    }
  };

  const handleNuvioAutoPlayTimeoutChange = async (timeout: number) => {
    setNuvioAutoPlayTimeout(timeout);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioAutoPlayTimeout: timeout });
    }
  };

  const handleNuvioAutoPlaySourceScopeChange = async (scope: StreamAutoPlaySourceScope) => {
    setNuvioAutoPlaySourceScope(scope);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioAutoPlaySourceScope: scope });
    }
  };

  const handleNuvioAutoPlayAllowedAddonsChange = async (addonIds: string[]) => {
    setNuvioAutoPlayAllowedAddons(addonIds);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioAutoPlayAllowedAddons: addonIds });
    }
  };

  const handleNuvioAutoPlayAllowedPluginsChange = async (pluginIds: string[]) => {
    setNuvioAutoPlayAllowedPlugins(pluginIds);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioAutoPlayAllowedPlugins: pluginIds });
    }
  };

  const handleNuvioAutoPlayRegexChange = async (regex: string) => {
    setNuvioAutoPlayRegex(regex);
    if (window.storage) {
      await window.storage.updateSettings({ nuvioAutoPlayRegex: regex });
    }
  };

  const handleNuvioCacheFetchResultsChange = async (enabled: boolean) => {
    setNuvioCacheFetchResults(enabled);
    if (onNuvioCacheFetchResultsChange) {
      onNuvioCacheFetchResultsChange(enabled);
    }
    if (window.storage) {
      await window.storage.updateSettings({ nuvioCacheFetchResults: enabled });
    }
  };

  const handleNuvioCacheFetchTimeoutChange = async (timeout: number) => {
    setNuvioCacheFetchTimeout(timeout);
    if (onNuvioCacheFetchTimeoutChange) {
      onNuvioCacheFetchTimeoutChange(timeout);
    }
    if (window.storage) {
      await window.storage.updateSettings({ nuvioCacheFetchTimeout: timeout });
    }
  };

  const handleTimeshiftChange = async (enabled: boolean, cacheBytes: number, bufferOffset?: number) => {
    setTimeshiftEnabled(enabled);
    setTimeshiftCacheBytes(cacheBytes);
    if (bufferOffset !== undefined) {
      setLiveBufferOffset(bufferOffset);
    }
    if (window.storage) {
      const settings: { timeshiftEnabled: boolean; timeshiftCacheBytes: number; liveBufferOffset?: number } = {
        timeshiftEnabled: enabled,
        timeshiftCacheBytes: cacheBytes,
      };
      if (bufferOffset !== undefined) {
        settings.liveBufferOffset = bufferOffset;
      }
      await window.storage.updateSettings(settings);
    }
  };

  const handleShowAllChannelsChange = async (enabled: boolean) => {
    setShowAllChannels(enabled);
    // The store setter persists + dispatches the legacy event (Settings.tsx's
    // own listener below keeps this component's local state in sync).
    useSettingsStore.getState().setCategorySettings({ showAllChannels: enabled });
  };

  const handleShowFavoritesChange = async (enabled: boolean) => {
    setShowFavorites(enabled);
    useSettingsStore.getState().setCategorySettings({ showFavorites: enabled });
  };

  const handleFavoritesModeChange = async (mode: 'global' | 'perSource' | 'both') => {
    setFavoritesMode(mode);
    useSettingsStore.getState().setCategorySettings({ favoritesMode: mode });
  };

  const handleShowWatchlistChange = async (enabled: boolean) => {
    setShowWatchlist(enabled);
    useSettingsStore.getState().setCategorySettings({ showWatchlist: enabled });
  };

  const handleShowRecentlyViewedChange = async (enabled: boolean) => {
    setShowRecentlyViewed(enabled);
    useSettingsStore.getState().setCategorySettings({ showRecentlyViewed: enabled });
  };

  const handleEpgDarkenCurrentChange = async (enabled: boolean) => {
    setEpgDarkenCurrent(enabled);
    // Apply CSS class to document for ProgramBlock to use
    if (enabled) {
      document.documentElement.classList.add('epg-darken-current');
    } else {
      document.documentElement.classList.remove('epg-darken-current');
    }
    if (window.storage) {
      await window.storage.updateSettings({ epgDarkenCurrent: enabled });
    }
  };

  const handleEpgHighlightBorderCurrentChange = async (enabled: boolean) => {
    setEpgHighlightBorderCurrent(enabled);
    if (enabled) {
      document.documentElement.classList.add('epg-highlight-border-current');
    } else {
      document.documentElement.classList.remove('epg-highlight-border-current');
    }
    if (window.storage) {
      await window.storage.updateSettings({ epgHighlightBorderCurrent: enabled });
    }
  };

  const handleEpgPreferEpgLogosChange = async (enabled: boolean) => {
    setEpgPreferEpgLogos(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ epgPreferEpgLogos: enabled });
    }
  };

  const handleEpgLogoDisplayChange = async (display: 'square' | 'rectangle') => {
    setEpgLogoDisplay(display);
    if (display === 'rectangle') {
      document.documentElement.classList.add('epg-rectangle-logos');
    } else {
      document.documentElement.classList.remove('epg-rectangle-logos');
    }
    if (window.storage) {
      await window.storage.updateSettings({ epgLogoDisplay: display });
    }
  };

  const handleEpgMetadataBadgeResolutionChange = async (enabled: boolean) => {
    setEpgMetadataBadgeResolution(enabled);
    if (onEpgMetadataBadgeResolutionChange) {
      onEpgMetadataBadgeResolutionChange(enabled);
    }
    if (window.storage) {
      await window.storage.updateSettings({ epgMetadataBadgeResolution: enabled });
    }
  };

  const handleEpgMetadataBadgeFpsChange = async (enabled: boolean) => {
    setEpgMetadataBadgeFps(enabled);
    if (onEpgMetadataBadgeFpsChange) {
      onEpgMetadataBadgeFpsChange(enabled);
    }
    if (window.storage) {
      await window.storage.updateSettings({ epgMetadataBadgeFps: enabled });
    }
  };

  const handleEpgMetadataBadgeFpsSuffixChange = async (enabled: boolean) => {
    setEpgMetadataBadgeFpsSuffix(enabled);
    if (onEpgMetadataBadgeFpsSuffixChange) {
      onEpgMetadataBadgeFpsSuffixChange(enabled);
    }
    if (window.storage) {
      await window.storage.updateSettings({ epgMetadataBadgeFpsSuffix: enabled });
    }
  };

  const handleEpgMetadataBadgeSoundChange = async (enabled: boolean) => {
    setEpgMetadataBadgeSound(enabled);
    if (onEpgMetadataBadgeSoundChange) {
      onEpgMetadataBadgeSoundChange(enabled);
    }
    if (window.storage) {
      await window.storage.updateSettings({ epgMetadataBadgeSound: enabled });
    }
  };

  const handleEpgBoldChannelNamesChange = async (enabled: boolean) => {
    setEpgBoldChannelNames(enabled);
    if (enabled) {
      document.documentElement.classList.add('epg-bold-channel-names');
    } else {
      document.documentElement.classList.remove('epg-bold-channel-names');
    }
    if (window.storage) {
      await window.storage.updateSettings({ epgBoldChannelNames: enabled });
    }
  };

  const handleEpgBoldTopCategoriesChange = async (enabled: boolean) => {
    setEpgBoldTopCategories(enabled);
    if (enabled) {
      document.documentElement.classList.add('epg-bold-top-categories');
    } else {
      document.documentElement.classList.remove('epg-bold-top-categories');
    }
    if (window.storage) {
      await window.storage.updateSettings({ epgBoldTopCategories: enabled });
    }
  };

  const handleEpgBoldSourceCategoriesChange = async (enabled: boolean) => {
    setEpgBoldSourceCategories(enabled);
    if (enabled) {
      document.documentElement.classList.add('epg-bold-source-categories');
    } else {
      document.documentElement.classList.remove('epg-bold-source-categories');
    }
    if (window.storage) {
      await window.storage.updateSettings({ epgBoldSourceCategories: enabled });
    }
  };

  const handleEpgViewChange = async (view: 'traditional' | 'alternate') => {
    setEpgView(view);
    if (window.storage) {
      await window.storage.updateSettings({ epgView: view });
    }
  };

  const handleEpgVisibleHoursChange = async (hours: 'auto' | number) => {
    setEpgVisibleHoursState(hours);
    setEpgVisibleHours(hours);
    if (window.storage) {
      await window.storage.updateSettings({ epgVisibleHours: hours });
    }
  };

  const handleEpgClockFormatChange = async (format: '12h' | '24h') => {
    setEpgClockFormatState(format);
    setEpgClockFormat(format);
    if (window.storage) {
      await window.storage.updateSettings({ epgClockFormat: format });
    }
  };

  const handleEpgShowDateChange = async (enabled: boolean) => {
    setEpgShowDateState(enabled);
    setEpgShowDate(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ epgShowDate: enabled });
    }
  };

  const handleEpgTitleFontSizeChange = (size: number) => {
    setEpgTitleFontSize(size);
    // epgTitleFontSize lives in the settings store — the DOM applier owns
    // --epg-title-font-size and the setter persists (debounced).
    useSettingsStore.getState().setEpgTitleFontSize(size);
  };

  const handleEpgBodyFontSizeChange = (size: number) => {
    setEpgBodyFontSize(size);
    useSettingsStore.getState().setEpgBodyFontSize(size);
  };

  const handleIncludeAllChannelsToPlaylistChange = async (enabled: boolean) => {
    setIncludeAllChannelsToPlaylistState(enabled);
    setIncludeAllChannelsToPlaylist(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ includeAllChannelsToPlaylist: enabled });
    }
  };

  const handleTransparentGuideHeightChange = async (height: number) => {
    const clamped = Math.max(25, Math.min(100, height));
    setTransparentGuideHeight(clamped);
    // Transparent-guide values live in the settings store — the DOM applier
    // owns the CSS vars/class and the setter persists.
    useSettingsStore.getState().setTransparentGuideHeight(clamped);
  };

  const handleTransparentGuideHideHeaderChange = async (hide: boolean) => {
    setTransparentGuideHideHeader(hide);
    useSettingsStore.getState().setTransparentGuideHideHeader(hide);
  };

  const handleTransparentGuideOverlayOpacityChange = async (opacity: number) => {
    const clamped = Math.max(0, Math.min(100, opacity));
    setTransparentGuideOverlayOpacity(clamped);
    useSettingsStore.getState().setTransparentGuideOverlayOpacity(clamped);
  };

  const handleTransparentGuideSidebarOpacityChange = async (opacity: number) => {
    const clamped = Math.max(0, Math.min(100, opacity));
    setTransparentGuideSidebarOpacity(clamped);
    useSettingsStore.getState().setTransparentGuideSidebarOpacity(clamped);
  };

  const handleChannelInfoOverlayChange = async (enabled: boolean) => {
    setChannelInfoOverlayEnabled(enabled);
    if (onChannelInfoOverlayChange) {
      onChannelInfoOverlayChange(enabled);
    }
    if (window.storage) {
      await window.storage.updateSettings({ channelInfoOverlayEnabled: enabled });
    }
  };

  const handleChannelInfoOverlayFontSizeChange = (size: number) => {
    setChannelInfoOverlayFontSize(size);
    if (onChannelInfoOverlayFontSizeChange) {
      onChannelInfoOverlayFontSizeChange(size);
    }
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ channelInfoOverlayFontSize: size });
    }
  };

  const handleChannelInfoOverlayLogoSizeChange = (size: number) => {
    setChannelInfoOverlayLogoSize(size);
    if (onChannelInfoOverlayLogoSizeChange) {
      onChannelInfoOverlayLogoSizeChange(size);
    }
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ channelInfoOverlayLogoSize: size });
    }
  };

  const handleChannelInfoOverlayBoxWidthChange = (width: number) => {
    setChannelInfoOverlayBoxWidth(width);
    if (onChannelInfoOverlayBoxWidthChange) {
      onChannelInfoOverlayBoxWidthChange(width);
    }
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ channelInfoOverlayBoxWidth: width });
    }
  };

  const handleChannelInfoOverlayOpacityChange = (opacity: number) => {
    setChannelInfoOverlayOpacity(opacity);
    if (onChannelInfoOverlayOpacityChange) {
      onChannelInfoOverlayOpacityChange(opacity);
    }
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ channelInfoOverlayOpacity: opacity });
    }
  };

  const handleChannelInfoOverlayHideDescriptionChange = async (hide: boolean) => {
    setChannelInfoOverlayHideDescription(hide);
    if (onChannelInfoOverlayHideDescriptionChange) {
      onChannelInfoOverlayHideDescriptionChange(hide);
    }
    if (window.storage) {
      await window.storage.updateSettings({ channelInfoOverlayHideDescription: hide });
    }
  };

  const handleChannelInfoOverlayHideMetaBadgeChange = async (hide: boolean) => {
    setChannelInfoOverlayHideMetaBadge(hide);
    if (onChannelInfoOverlayHideMetaBadgeChange) {
      onChannelInfoOverlayHideMetaBadgeChange(hide);
    }
    if (window.storage) {
      await window.storage.updateSettings({ channelInfoOverlayHideMetaBadge: hide });
    }
  };

  const handleChannelInfoOverlayHideLogoChange = async (hide: boolean) => {
    setChannelInfoOverlayHideLogo(hide);
    if (onChannelInfoOverlayHideLogoChange) {
      onChannelInfoOverlayHideLogoChange(hide);
    }
    if (window.storage) {
      await window.storage.updateSettings({ channelInfoOverlayHideLogo: hide });
    }
  };

  const handleChannelInfoOverlayHideTimerChange = async (hide: boolean) => {
    setChannelInfoOverlayHideTimer(hide);
    if (onChannelInfoOverlayHideTimerChange) {
      onChannelInfoOverlayHideTimerChange(hide);
    }
    if (window.storage) {
      await window.storage.updateSettings({ channelInfoOverlayHideTimer: hide });
    }
  };

  const handleChannelInfoOverlayPositionChange = async (pos: 'left' | 'right') => {
    setChannelInfoOverlayPosition(pos);
    if (onChannelInfoOverlayPositionChange) {
      onChannelInfoOverlayPositionChange(pos);
    }
    if (window.storage) {
      await window.storage.updateSettings({ channelInfoOverlayPosition: pos });
    }
  };

  const handleChannelInfoOverlayLogoShapeChange = async (shape: 'square' | 'horizontal') => {
    setChannelInfoOverlayLogoShape(shape);
    if (onChannelInfoOverlayLogoShapeChange) {
      onChannelInfoOverlayLogoShapeChange(shape);
    }
    if (window.storage) {
      await window.storage.updateSettings({ channelInfoOverlayLogoShape: shape });
    }
  };

  const handlePopoutStopMainChange = async (stop: boolean) => {
    setPopoutStopMain(stop);
    if (window.storage) {
      await window.storage.updateSettings({ popoutStopMain: stop });
    }
  };

  const handlePopoutAlwaysOnTopChange = async (onTop: boolean) => {
    setPopoutAlwaysOnTop(onTop);
    if (window.storage) {
      await window.storage.updateSettings({ popoutAlwaysOnTop: onTop });
    }
    // Apply immediately if a popout is currently open
    try {
      const { Bridge } = await import('../services/tauri-bridge');
      const isRunning = await Bridge.popoutIsRunning();
      if (isRunning) {
        await Bridge.popoutSetAlwaysOnTop(onTop);
      }
    } catch {
      // Ignore if bridge isn't ready or popout isn't running
    }
  };

  const handlePopoutHwdecEnabledChange = async (enabled: boolean) => {
    setPopoutHwdecEnabled(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ popoutHwdecEnabled: enabled });
    }
  };

  const handlePopoutMpvParamsEnabledChange = async (enabled: boolean) => {
    setPopoutMpvParamsEnabled(enabled);
    if (window.storage) {
      await window.storage.updateSettings({ popoutMpvParamsEnabled: enabled });
    }
  };

  const handlePopoutMpvParamsChange = (params: string) => {
    setPopoutMpvParams(params);
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ popoutMpvParams: params });
    }
  };

  const handleExternalPlayerPathChange = (path: string) => {
    setExternalPlayerPath(path);
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ externalPlayerPath: path });
    }
  };

  const handleExternalPlayerReuseChange = async (reuse: boolean) => {
    setExternalPlayerReuse(reuse);
    if (window.storage) {
      await window.storage.updateSettings({ externalPlayerReuse: reuse });
    }
  };

  const handleSkipIntroTimerSecondsChange = (seconds: number) => {
    setSkipIntroTimerSeconds(seconds);
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ skipIntroTimerSeconds: seconds });
    }
    window.dispatchEvent(new CustomEvent('ynotv:skip-intro-settings-changed', {
      detail: { skipIntroTimerSeconds: seconds }
    }));
  };

  const handleSkipIntroAutoSkipChange = async (auto: boolean) => {
    setSkipIntroAutoSkip(auto);
    if (window.storage) {
      await window.storage.updateSettings({ skipIntroAutoSkip: auto });
    }
    window.dispatchEvent(new CustomEvent('ynotv:skip-intro-settings-changed', {
      detail: { skipIntroAutoSkip: auto }
    }));
  };


  const handleWidgetScaleChange = (scale: number) => {
    setWidgetScaleState(scale);
    document.documentElement.style.setProperty('--widget-scale', String(scale));
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ widgetScale: scale });
    }
  };

  const handleWidgetBgOpacityChange = (opacity: number) => {
    setWidgetBgOpacityState(opacity);
    document.documentElement.style.setProperty('--widget-bg-opacity', String(opacity));
    document.documentElement.style.setProperty('--cio-bg-opacity', String(opacity));
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ widgetBgOpacity: opacity });
    }
  };

  const handleSportsScaleChange = (scale: number) => {
    setSportsScaleState(scale);
    document.documentElement.style.setProperty('--sports-scale', String(scale));
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ sportsScale: scale });
    }
  };

  const handleSportsBgOpacityChange = (opacity: number) => {
    setSportsBgOpacityState(opacity);
    document.documentElement.style.setProperty('--sports-bg-opacity', String(opacity));
    if (window.storage) {
      window.storage.debouncedUpdateSettings({ sportsBgOpacity: opacity });
    }
  };

  const handleShortcutsChange = async (newShortcuts: ShortcutsMap) => {
    setShortcuts(newShortcuts);
    if (onShortcutsChange) {
      onShortcutsChange(newShortcuts);
    }
    if (window.storage) {
      await window.storage.updateSettings({ shortcuts: newShortcuts });
    }
  };

  const handleUiSettingsChange = async (newSettings: {
    startupWidth?: number;
    startupHeight?: number;
    dontSaveWindowSizeOnClose?: boolean;
    minimizeToTray?: boolean;
    modernUiEnabled?: boolean | string;
    collapseSourceCategoriesOnStartup?: boolean;
    overlayAutohideTimer?: number;
    overlayOnClickOnly?: boolean;
    uiScale?: number;
    playerControlDesign?: 'default' | 'clean';
    showVolumePercent?: boolean;
    channelInfoOverlayEnabled?: boolean;
    channelInfoOverlayFontSize?: number;
    channelInfoOverlayLogoSize?: number;
    channelInfoOverlayBoxWidth?: number;
    channelInfoOverlayOpacity?: number;
    channelInfoOverlayHideDescription?: boolean;
    channelInfoOverlayHideMetaBadge?: boolean;
    channelInfoOverlayHideLogo?: boolean;
    channelInfoOverlayHideTimer?: boolean;
    channelInfoOverlayPosition?: 'left' | 'right';
  }) => {
    const updated = { ...uiSettings, ...newSettings };
    setUiSettings(updated);

    // collapseSourceCategoriesOnStartup lives in the settings store (CategoryStrip
    // and VerticalSidebar read it via getState) — route the write through the
    // setter so the store never goes stale.
    if (newSettings.collapseSourceCategoriesOnStartup !== undefined) {
      useSettingsStore.getState().setCollapseSourceCategoriesOnStartup(newSettings.collapseSourceCategoriesOnStartup);
    }

    if (newSettings.channelInfoOverlayEnabled !== undefined) {
      setChannelInfoOverlayEnabled(newSettings.channelInfoOverlayEnabled);
      onChannelInfoOverlayChange?.(newSettings.channelInfoOverlayEnabled);
    }
    if (newSettings.channelInfoOverlayFontSize !== undefined) {
      setChannelInfoOverlayFontSize(newSettings.channelInfoOverlayFontSize);
      onChannelInfoOverlayFontSizeChange?.(newSettings.channelInfoOverlayFontSize);
    }
    if (newSettings.channelInfoOverlayLogoSize !== undefined) {
      setChannelInfoOverlayLogoSize(newSettings.channelInfoOverlayLogoSize);
      onChannelInfoOverlayLogoSizeChange?.(newSettings.channelInfoOverlayLogoSize);
    }
    if (newSettings.channelInfoOverlayBoxWidth !== undefined) {
      setChannelInfoOverlayBoxWidth(newSettings.channelInfoOverlayBoxWidth);
      onChannelInfoOverlayBoxWidthChange?.(newSettings.channelInfoOverlayBoxWidth);
    }
    if (newSettings.channelInfoOverlayOpacity !== undefined) {
      setChannelInfoOverlayOpacity(newSettings.channelInfoOverlayOpacity);
      onChannelInfoOverlayOpacityChange?.(newSettings.channelInfoOverlayOpacity);
    }
    if (newSettings.channelInfoOverlayHideDescription !== undefined) {
      setChannelInfoOverlayHideDescription(newSettings.channelInfoOverlayHideDescription);
      onChannelInfoOverlayHideDescriptionChange?.(newSettings.channelInfoOverlayHideDescription);
    }
    if (newSettings.channelInfoOverlayHideMetaBadge !== undefined) {
      setChannelInfoOverlayHideMetaBadge(newSettings.channelInfoOverlayHideMetaBadge);
      onChannelInfoOverlayHideMetaBadgeChange?.(newSettings.channelInfoOverlayHideMetaBadge);
    }
    if (newSettings.channelInfoOverlayHideLogo !== undefined) {
      setChannelInfoOverlayHideLogo(newSettings.channelInfoOverlayHideLogo);
      onChannelInfoOverlayHideLogoChange?.(newSettings.channelInfoOverlayHideLogo);
    }
    if (newSettings.channelInfoOverlayHideTimer !== undefined) {
      setChannelInfoOverlayHideTimer(newSettings.channelInfoOverlayHideTimer);
      onChannelInfoOverlayHideTimerChange?.(newSettings.channelInfoOverlayHideTimer);
    }
    if (newSettings.channelInfoOverlayPosition !== undefined) {
      setChannelInfoOverlayPosition(newSettings.channelInfoOverlayPosition);
      onChannelInfoOverlayPositionChange?.(newSettings.channelInfoOverlayPosition);
    }
    if (newSettings.playerControlDesign !== undefined) {
      onPlayerControlDesignChange?.(newSettings.playerControlDesign);
    }
    if (newSettings.showVolumePercent !== undefined) {
      onShowVolumePercentChange?.(newSettings.showVolumePercent);
    }

    // modernUiEnabled lives in the settings store — the DOM applier owns the
    // design classes/stylesheet application and App derives liveTvDesign from
    // the store, so just route the write through the setter.
    if (newSettings.modernUiEnabled !== undefined) {
      useSettingsStore.getState().setModernUiEnabled(newSettings.modernUiEnabled === 'v3' || newSettings.modernUiEnabled === 'v2'
        ? newSettings.modernUiEnabled
        : (newSettings.modernUiEnabled === false || newSettings.modernUiEnabled === 'v1' ? false : 'v3'));
    }

    if (newSettings.uiScale !== undefined) {
      // uiScale lives in the settings store — the DOM applier owns --app-zoom
      // and dispatches the EPG re-measure resize.
      useSettingsStore.getState().setUiScale(newSettings.uiScale);
    }

    if (newSettings.overlayAutohideTimer !== undefined && onOverlayAutohideTimerChange) {
      onOverlayAutohideTimerChange(newSettings.overlayAutohideTimer);
    }

    if (newSettings.overlayOnClickOnly !== undefined && onOverlayOnClickOnlyChange) {
      onOverlayOnClickOnlyChange(newSettings.overlayOnClickOnly);
    }

    if (window.storage) {
      await window.storage.updateSettings(newSettings);

      // Also save to localStorage for App.tsx startup logic
      // We retrieve current settings from localStorage to merge, or just create new
      try {
        const existing = localStorage.getItem('app-settings');
        const parsed = existing ? JSON.parse(existing) : {};
        localStorage.setItem('app-settings', JSON.stringify({ ...parsed, ...newSettings }));
      } catch (e) {
        console.error('Failed to save settings to localStorage', e);
      }
    }
  };

  const handleChannelFontSizeChange = (size: number) => {
    setChannelFontSize(size);
    // channelFontSize lives in the settings store — the DOM applier owns
    // --channel-font-size and the setter persists (debounced).
    useSettingsStore.getState().setChannelFontSize(size);
  };

  const handleCategoryFontSizeChange = (size: number) => {
    setCategoryFontSize(size);
    useSettingsStore.getState().setCategoryFontSize(size);
  };

  const handleSourceFontSizeChange = (size: number) => {
    setSourceFontSize(size);
    // sourceFontSize lives in the settings store (already migrated) — keep the
    // write routed through the setter so the store never goes stale.
    useSettingsStore.getState().setSourceFontSize(size);
  };

  const handleAllowLanSourcesChange = (enabled: boolean) => {
    setAllowLanSources(enabled);
    // allowLanSources lives in the settings store (SourcesTab reads it via
    // getState on the save path) — route the write through the setter.
    useSettingsStore.getState().setAllowLanSources(enabled);
  };

  const handleRememberLastChannelsChange = async (value: boolean) => {
    setRememberLastChannels(value);

    // Automatically turn off Reopen when Remember is turned off
    let updatePayload: any = { rememberLastChannels: value };
    if (!value) {
      setReopenLastOnStartup(false);
      updatePayload.reopenLastOnStartup = false;
    }

    if (window.storage) {
      await window.storage.updateSettings(updatePayload);
    }
  };

  const handleReopenLastOnStartupChange = async (value: boolean) => {
    setReopenLastOnStartup(value);
    if (window.storage) {
      await window.storage.updateSettings({ reopenLastOnStartup: value });
    }
  };

  const handleNavHiddenTabsChange = async (tabs: string[]) => {
    navHiddenTabsStore(tabs);
    if (window.storage) {
      await window.storage.updateSettings({ navHiddenTabs: tabs });
    }
  };

  const handleEpgHiddenButtonsChange = async (buttons: string[]) => {
    epgHiddenButtonsStore(buttons);
    if (window.storage) {
      await window.storage.updateSettings({ epgHiddenButtons: buttons });
    }
  };

  const handleStartupViewChange = async (value: 'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'sports' | 'calendar' | 'stremio' | 'nuvio') => {
    setStartupView(value);
    if (window.storage) {
      await window.storage.updateSettings({ startupView: value });
    }
  };

  const handleIncludeSourceInSearchChange = async (value: boolean) => {
    setIncludeSourceInSearch(value);
    if (window.storage) {
      await window.storage.updateSettings({ includeSourceInSearch: value });
    }
  };
  
  const handleIncludeSourceInVodSearchChange = async (value: boolean) => {
    setIncludeSourceInVodSearch(value);
    if (window.storage) {
      await window.storage.updateSettings({ includeSourceInVodSearch: value });
    }
  };

  const handleMaxSearchResultsChange = async (value: number) => {
    const clamped = clampMaxSearchResults(value);
    setMaxSearchResults(clamped);
    if (window.storage) {
      await window.storage.updateSettings({ maxSearchResults: clamped });
    }
  };

  const handleSearchResultsOrderChange = async (order: 'default' | 'alphabetical') => {
    setSearchResultsOrder(order);
    if (window.storage) {
      await window.storage.updateSettings({ searchResultsOrder: order });
    }
  };

  const handleCategorySortOrderChange = async (order: 'default' | 'alphabetical') => {
    setCategorySortOrder(order);
    if (window.storage) {
      await window.storage.updateSettings({ categorySortOrder: order });
    }
  };

  // Streaming-catalog setters persist through the store and dispatch
  // `ynotv:streaming-catalogs-changed` for any remaining listeners.
  const handleStreamingCatalogsEnabledChange = (enabled: boolean) => {
    setStreamingCatalogsEnabled(enabled);
  };

  const handleStreamingNuvioCatalogsEnabledChange = (enabled: boolean) => {
    setStreamingNuvioCatalogsEnabled(enabled);
  };

  const handleEnabledStreamingServicesChange = (services: string[]) => {
    setEnabledStreamingServices(services);
  };

  function renderTabContent() {
    switch (activeTab) {
      case 'sources':
        return (
          <SourcesTab
            initialSubTab={pendingSubTab as 'source' | 'epg' | 'refresh' | 'global_ua' | undefined}
            sources={sources}
            isEncryptionAvailable={isEncryptionAvailable}
            onSourcesChange={loadSources}
            editSourceId={editSourceId}
            epgSyncConcurrency={epgSyncConcurrency}
            vodRefreshHours={vodRefreshHours}
            epgRefreshHours={epgRefreshHours}
            onVodRefreshChange={setVodRefreshHours}
            onEpgRefreshChange={setEpgRefreshHours}
            onEpgSyncConcurrencyChange={setEpgSyncConcurrency}
          />
        );
      case 'subtitles':
        return (
          <SubtitlesTab
            initialSubTab={pendingSubTab as 'subtitles' | 'audio' | undefined}
            settings={subtitleSettings}
            onSettingsChange={setSubtitleSettings}
          />
        );
      case 'strem':
        return (
          <StremTab
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
          />
        );
      case 'nuvio':
        return (
          <NuvioTab
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
          />
        );
      case 'security':
        return (
          <SecurityTab
            allowLanSources={allowLanSources}
            onAllowLanSourcesChange={handleAllowLanSourcesChange}
          />
        );
      case 'proxy':
        return (
          <ProxyTab
            socks5ProxyEnabled={socks5ProxyEnabled}
            onSocks5ProxyEnabledChange={handleSocks5ProxyEnabledChange}
            socks5ProxyServer={socks5ProxyServer}
            onSocks5ProxyServerChange={handleSocks5ProxyServerChange}
            socks5ProxyUsername={socks5ProxyUsername}
            onSocks5ProxyUsernameChange={handleSocks5ProxyUsernameChange}
            socks5ProxyPassword={socks5ProxyPassword}
            onSocks5ProxyPasswordChange={handleSocks5ProxyPasswordChange}
          />
        );
      case 'discord':
        return (
          <DiscordTab
            discordRichPresence={discordRichPresence}
            onDiscordRichPresenceChange={(val) => {
              setDiscordRichPresenceState(val);
              onDiscordRichPresenceChange?.(val);
              if (window.storage) window.storage.updateSettings({ discordRichPresence: val });
            }}
            discordHideTitle={discordHideTitle}
            onDiscordHideTitleChange={(val) => {
              setDiscordHideTitleState(val);
              onDiscordHideTitleChange?.(val);
              if (window.storage) window.storage.updateSettings({ discordHideTitle: val });
            }}
            discordShowWhenPaused={discordShowWhenPaused}
            onDiscordShowWhenPausedChange={(val) => {
              setDiscordShowWhenPausedState(val);
              onDiscordShowWhenPausedChange?.(val);
              if (window.storage) window.storage.updateSettings({ discordShowWhenPaused: val });
            }}
            discordShowWhenBrowsing={discordShowWhenBrowsing}
            onDiscordShowWhenBrowsingChange={(val) => {
              setDiscordShowWhenBrowsingState(val);
              onDiscordShowWhenBrowsingChange?.(val);
              if (window.storage) window.storage.updateSettings({ discordShowWhenBrowsing: val });
            }}
            discordShowPoster={discordShowPoster}
            onDiscordShowPosterChange={(val) => {
              setDiscordShowPosterState(val);
              onDiscordShowPosterChange?.(val);
              if (window.storage) window.storage.updateSettings({ discordShowPoster: val });
            }}
            discordShowTimestamp={discordShowTimestamp}
            onDiscordShowTimestampChange={(val) => {
              setDiscordShowTimestampState(val);
              onDiscordShowTimestampChange?.(val);
              if (window.storage) window.storage.updateSettings({ discordShowTimestamp: val });
            }}
          />
        );
      case 'debug':
        return (
          <DebugTab
            debugLoggingEnabled={debugLoggingEnabled}
            onDebugLoggingChange={setDebugLoggingEnabled}
            logRetentionDays={logRetentionDays}
            onLogRetentionChange={(val) => {
              setLogRetentionDays(val);
              if (window.storage) window.storage.updateSettings({ logRetentionDays: val });
            }}
          />
        );
      case 'shortcuts':
        return (
          <ShortcutsTab
            shortcuts={shortcuts}
            onShortcutsChange={handleShortcutsChange}
          />
        );
      case 'export-import':
        return <ImportExportTab />;
      case 'ui':
        return (
          <UITab
            settings={{
              ...uiSettings,
              playerControlDesign: playerControlDesignProp ?? uiSettings.playerControlDesign,
              showVolumePercent: showVolumePercentProp ?? uiSettings.showVolumePercent,
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
            }}
            onSettingsChange={handleUiSettingsChange}
          />
        );
      case 'optimization':
        return <OptimizationTab />;
      case 'navigation':
        return (
          <NavigationTab
            navHiddenTabs={navHiddenTabs}
            onNavHiddenTabsChange={handleNavHiddenTabsChange}
            epgHiddenButtons={epgHiddenButtons}
            onEpgHiddenButtonsChange={handleEpgHiddenButtonsChange}
            showAllChannels={showAllChannels}
            onShowAllChannelsChange={handleShowAllChannelsChange}
            showFavorites={showFavorites}
            onShowFavoritesChange={handleShowFavoritesChange}
            showWatchlist={showWatchlist}
            onShowWatchlistChange={handleShowWatchlistChange}
            showRecentlyViewed={showRecentlyViewed}
            onShowRecentlyViewedChange={handleShowRecentlyViewedChange}
          />
        );
      case 'theme':
        return (
          <ThemeTab
            theme={theme || 'dark-cyan'}
            onThemeChange={onThemeChange || (() => { })}
            customThemeConfig={customThemeConfig}
            onCustomThemeConfigChange={onCustomThemeConfigChange || (() => { })}
            oledBlack={oledBlack}
            setOledBlack={setOledBlack}
            modernUiEnabled={uiSettings.modernUiEnabled}
          />
        );
      case 'startup':
        return (
          <StartupTab
            rememberLastChannels={rememberLastChannels}
            reopenLastOnStartup={reopenLastOnStartup}
            savedLayoutState={savedLayoutState}
            startupView={startupView}
            onRememberLastChannelsChange={handleRememberLastChannelsChange}
            onReopenLastOnStartupChange={handleReopenLastOnStartupChange}
            onStartupViewChange={handleStartupViewChange}
          />
        );
      case 'playback':
        return (
          <PlaybackTab
            initialSubTab={(pendingSubTabFromParent || pendingSubTab) as 'mpv' | 'reconnect' | 'cast' | 'popout' | 'skipintro' | 'catchup' | undefined}
            mpvParams={mpvParams}
            mpvHwdecEnabled={mpvHwdecEnabled}
            onMpvHwdecEnabledChange={handleMpvHwdecEnabledChange}
            onMpvParamsChange={handleMpvParamsChange}
            streamWatchdogSeconds={streamWatchdogSeconds}
            streamMaxRetries={streamMaxRetries}
            onStreamWatchdogSecondsChange={handleStreamWatchdogSecondsChange}
            onStreamMaxRetriesChange={handleStreamMaxRetriesChange}
            castEnabled={castEnabled}
            onCastEnabledChange={handleCastEnabledChange}
            castRewriteTs={castRewriteTs}
            onCastRewriteTsChange={handleCastRewriteTsChange}
            useEventBasedReconnect={useEventBasedReconnect}
            onUseEventBasedReconnectChange={handleUseEventBasedReconnectChange}
            stallDetectionEnabled={stallDetectionEnabled}
            onStallDetectionEnabledChange={handleStallDetectionEnabledChange}
            showLoadingScreen={showLoadingScreen}
            onShowLoadingScreenChange={handleShowLoadingScreenChange}
            popoutStopMain={popoutStopMain}
            onPopoutStopMainChange={handlePopoutStopMainChange}
            popoutAlwaysOnTop={popoutAlwaysOnTop}
            onPopoutAlwaysOnTopChange={handlePopoutAlwaysOnTopChange}
            popoutHwdecEnabled={popoutHwdecEnabled}
            onPopoutHwdecEnabledChange={handlePopoutHwdecEnabledChange}
            popoutMpvParamsEnabled={popoutMpvParamsEnabled}
            onPopoutMpvParamsEnabledChange={handlePopoutMpvParamsEnabledChange}
            popoutMpvParams={popoutMpvParams}
            onPopoutMpvParamsChange={handlePopoutMpvParamsChange}
            externalPlayerPath={externalPlayerPath}
            onExternalPlayerPathChange={handleExternalPlayerPathChange}
            externalPlayerReuse={externalPlayerReuse}
            onExternalPlayerReuseChange={handleExternalPlayerReuseChange}
            skipIntroTimerSeconds={skipIntroTimerSeconds}
            onSkipIntroTimerSecondsChange={handleSkipIntroTimerSecondsChange}
            skipIntroAutoSkip={skipIntroAutoSkip}
            onSkipIntroAutoSkipChange={handleSkipIntroAutoSkipChange}
            catchupStartPadding={catchupStartPadding}
            catchupEndPadding={catchupEndPadding}
            catchupContinuePlaying={catchupContinuePlaying}
            onCatchupStartPaddingChange={handleCatchupStartPaddingChange}
            onCatchupEndPaddingChange={handleCatchupEndPaddingChange}
            onCatchupContinuePlayingChange={handleCatchupContinuePlayingChange}
            vodAutoPlayNextEpisode={vodAutoPlayNextEpisode}
            onVodAutoPlayNextEpisodeChange={handleVodAutoPlayNextEpisodeChange}
            vodShowSourceBadge={vodShowSourceBadge}
            onVodShowSourceBadgeChange={handleVodShowSourceBadgeChange}
          />
        );
      case 'metadata':
        return (
          <TmdbTab
            initialSubTab={pendingSubTab as 'tmdb' | 'rpdb' | undefined}
            tmdbApiKey={tmdbApiKey}
            tmdbKeyValid={tmdbKeyValid}
            onApiKeyChange={setTmdbApiKey}
            onApiKeyValidChange={setTmdbKeyValid}
            rpdbApiKey={posterDbApiKey}
            rpdbKeyValid={posterDbKeyValid}
            onRpdbApiKeyChange={setPosterDbApiKey}
            onRpdbKeyValidChange={setPosterDbKeyValid}
            rpdbBackdropsEnabled={rpdbBackdropsEnabled}
            onRpdbBackdropsEnabledChange={setRpdbBackdropsEnabled}
            streamingCatalogsEnabled={streamingCatalogsEnabled}
            onStreamingCatalogsEnabledChange={handleStreamingCatalogsEnabledChange}
            streamingNuvioCatalogsEnabled={streamingNuvioCatalogsEnabled}
            onStreamingNuvioCatalogsEnabledChange={handleStreamingNuvioCatalogsEnabledChange}
            enabledStreamingServices={enabledStreamingServices}
            onEnabledStreamingServicesChange={handleEnabledStreamingServicesChange}
          />
        );
      case 'cache':
        return (
          <CacheTab
            timeshiftEnabled={timeshiftEnabled}
            timeshiftCacheBytes={timeshiftCacheBytes}
            liveBufferOffset={liveBufferOffset}
            onTimeshiftChange={handleTimeshiftChange}
          />
        );
      case 'livetv':
        return (
           <LiveTVTab
            initialSubTab={pendingSubTab as any}
            logoCacheEnabled={logoCacheEnabled}
            onLogoCacheEnabledChange={setLogoCacheEnabled}
            logoCacheMaxMb={logoCacheMaxMb}
            onLogoCacheMaxMbChange={setLogoCacheMaxMb}
            logoCacheTtlDays={logoCacheTtlDays}
            onLogoCacheTtlDaysChange={setLogoCacheTtlDays}
            logoCachePrefetch={logoCachePrefetch}
            onLogoCachePrefetchChange={setLogoCachePrefetch}
            epgDarkenCurrent={epgDarkenCurrent}
            onEpgDarkenCurrentChange={handleEpgDarkenCurrentChange}
            epgHighlightBorderCurrent={epgHighlightBorderCurrent}
            onEpgHighlightBorderCurrentChange={handleEpgHighlightBorderCurrentChange}
            epgVisibleHours={epgVisibleHours}
            onEpgVisibleHoursChange={handleEpgVisibleHoursChange}
            epgClockFormat={epgClockFormat}
            onEpgClockFormatChange={handleEpgClockFormatChange}
            epgShowDate={epgShowDate}
            onEpgShowDateChange={handleEpgShowDateChange}
            epgBoldChannelNames={epgBoldChannelNames}
            onEpgBoldChannelNamesChange={handleEpgBoldChannelNamesChange}
            epgBoldTopCategories={epgBoldTopCategories}
            onEpgBoldTopCategoriesChange={handleEpgBoldTopCategoriesChange}
            epgBoldSourceCategories={epgBoldSourceCategories}
            onEpgBoldSourceCategoriesChange={handleEpgBoldSourceCategoriesChange}
            epgPreferEpgLogos={epgPreferEpgLogos}
            onEpgPreferEpgLogosChange={handleEpgPreferEpgLogosChange}
            epgLogoDisplay={epgLogoDisplay}
            onEpgLogoDisplayChange={handleEpgLogoDisplayChange}
            channelLogoSize={channelLogoSize}
            onChannelLogoSizeChange={setChannelLogoSize}
            channelLogoRoundEdges={channelLogoRoundEdges}
            onChannelLogoRoundEdgesChange={setChannelLogoRoundEdges}
            channelLogoPadding={channelLogoPadding}
            onChannelLogoPaddingChange={setChannelLogoPadding}
            logoSmartTrim={logoSmartTrim}
            onLogoSmartTrimChange={setLogoSmartTrim}
            logoLightBackgroundDetection={logoLightBackgroundDetection}
            onLogoLightBackgroundDetectionChange={setLogoLightBackgroundDetection}
            sourceLogoDisplayOverrides={sourceLogoDisplayOverrides}
            onSetSourceLogoDisplayOverride={setSourceLogoDisplayOverride}
            epgMetadataBadgeResolution={epgMetadataBadgeResolution}
            onEpgMetadataBadgeResolutionChange={handleEpgMetadataBadgeResolutionChange}
            epgMetadataBadgeFps={epgMetadataBadgeFps}
            onEpgMetadataBadgeFpsChange={handleEpgMetadataBadgeFpsChange}
            epgMetadataBadgeFpsSuffix={epgMetadataBadgeFpsSuffix}
            onEpgMetadataBadgeFpsSuffixChange={handleEpgMetadataBadgeFpsSuffixChange}
            epgMetadataBadgeSound={epgMetadataBadgeSound}
            onEpgMetadataBadgeSoundChange={handleEpgMetadataBadgeSoundChange}
            epgView={epgView}
            onEpgViewChange={handleEpgViewChange}
            epgTitleFontSize={epgTitleFontSize}
            onEpgTitleFontSizeChange={handleEpgTitleFontSizeChange}
            epgBodyFontSize={epgBodyFontSize}
            onEpgBodyFontSizeChange={handleEpgBodyFontSizeChange}
            transparentGuideHeight={transparentGuideHeight}
            onTransparentGuideHeightChange={handleTransparentGuideHeightChange}
            transparentGuideHideHeader={transparentGuideHideHeader}
            onTransparentGuideHideHeaderChange={handleTransparentGuideHideHeaderChange}
            transparentGuideOnZap={transparentGuideOnZapProp ?? false}
            onTransparentGuideOnZapChange={onTransparentGuideOnZapChange || (() => {})}
            transparentGuideOverlayOpacity={transparentGuideOverlayOpacity}
            onTransparentGuideOverlayOpacityChange={handleTransparentGuideOverlayOpacityChange}
            transparentGuideSidebarOpacity={transparentGuideSidebarOpacity}
            onTransparentGuideSidebarOpacityChange={handleTransparentGuideSidebarOpacityChange}
            channelFontSize={channelFontSize}
            onChannelFontSizeChange={handleChannelFontSizeChange}
            categoryFontSize={categoryFontSize}
            onCategoryFontSizeChange={handleCategoryFontSizeChange}
            sourceFontSize={sourceFontSize}
            onSourceFontSizeChange={handleSourceFontSizeChange}
            channelSortOrder={channelSortOrder}
            onChannelSortOrderChange={setChannelSortOrder}
            categorySortOrder={categorySortOrder}
            onCategorySortOrderChange={handleCategorySortOrderChange}
            includeAllChannelsToPlaylist={includeAllChannelsToPlaylist}
            onIncludeAllChannelsToPlaylistChange={handleIncludeAllChannelsToPlaylistChange}
            includeSourceInSearch={includeSourceInSearch}
            onIncludeSourceInSearchChange={handleIncludeSourceInSearchChange}
            includeSourceInVodSearch={includeSourceInVodSearch}
            onIncludeSourceInVodSearchChange={handleIncludeSourceInVodSearchChange}
            maxSearchResults={maxSearchResults}
            onMaxSearchResultsChange={handleMaxSearchResultsChange}
            searchResultsOrder={searchResultsOrder}
            onSearchResultsOrderChange={handleSearchResultsOrderChange}
            channelInfoOverlayEnabled={channelInfoOverlayEnabled}
            onChannelInfoOverlayChange={handleChannelInfoOverlayChange}
            channelInfoOverlayFontSize={channelInfoOverlayFontSize}
            onChannelInfoOverlayFontSizeChange={handleChannelInfoOverlayFontSizeChange}
            channelInfoOverlayLogoSize={channelInfoOverlayLogoSize}
            onChannelInfoOverlayLogoSizeChange={handleChannelInfoOverlayLogoSizeChange}
            channelInfoOverlayBoxWidth={channelInfoOverlayBoxWidth}
            onChannelInfoOverlayBoxWidthChange={handleChannelInfoOverlayBoxWidthChange}
            channelInfoOverlayOpacity={channelInfoOverlayOpacity}
            onChannelInfoOverlayOpacityChange={handleChannelInfoOverlayOpacityChange}
            channelInfoOverlayHideDescription={channelInfoOverlayHideDescription}
            onChannelInfoOverlayHideDescriptionChange={handleChannelInfoOverlayHideDescriptionChange}
            channelInfoOverlayHideMetaBadge={channelInfoOverlayHideMetaBadge}
            onChannelInfoOverlayHideMetaBadgeChange={handleChannelInfoOverlayHideMetaBadgeChange}
            channelInfoOverlayHideLogo={channelInfoOverlayHideLogo}
            onChannelInfoOverlayHideLogoChange={handleChannelInfoOverlayHideLogoChange}
            channelInfoOverlayHideTimer={channelInfoOverlayHideTimer}
            onChannelInfoOverlayHideTimerChange={handleChannelInfoOverlayHideTimerChange}
            channelInfoOverlayPosition={channelInfoOverlayPosition}
            onChannelInfoOverlayPositionChange={handleChannelInfoOverlayPositionChange}
            channelInfoOverlayLogoShape={channelInfoOverlayLogoShape}
            onChannelInfoOverlayLogoShapeChange={handleChannelInfoOverlayLogoShapeChange}
            failoverGroupShowSource={failoverGroupShowSource}
            onFailoverGroupShowSourceChange={handleFailoverGroupShowSourceChange}
            widgetScale={widgetScale}
            onWidgetScaleChange={handleWidgetScaleChange}
            widgetBgOpacity={widgetBgOpacity}
            onWidgetBgOpacityChange={handleWidgetBgOpacityChange}
            sportsScale={sportsScale}
            onSportsScaleChange={handleSportsScaleChange}
            sportsBgOpacity={sportsBgOpacity}
            onSportsBgOpacityChange={handleSportsBgOpacityChange}
            favoritesMode={favoritesMode}
            onFavoritesModeChange={handleFavoritesModeChange}
            modernUiEnabled={uiSettings.modernUiEnabled}
          />
        );
      case 'about':
        return <AboutTab />;
      case 'scrobbling':
        return <ScrobblingTab />;
      case 'simkl':
        return <SimklTab />;
      default:
        return null;
    }
  }

  return (
    <div className={`settings-overlay${isFullScreen ? ' settings-overlay--fullscreen' : ''}${activeTab === 'theme' ? ' settings-overlay--no-blur' : ''}`}>
      <div className={`settings-panel settings-panel--sidebar${isFullScreen ? ' settings-panel--fullscreen' : ''}`}>
        <div className="settings-header">
          <div className="settings-header-left">
            <h2>{t('title')}</h2>
            <div className="settings-language">
              <span className="settings-language-label">{t('languageLabel')}</span>
              <select
                className="settings-language-select"
                value={language}
                onChange={(e) => onLanguageChange(e.target.value)}
                title={t('languageDescription')}
              >
                {SUPPORTED_LOCALES.map((locale) => (
                  <option key={locale.code} value={locale.code}>{locale.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="settings-search" ref={searchRef}>
            <div className="settings-search-input-wrapper">
            <svg className="settings-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="text"
              className="settings-search-input"
              placeholder={t('searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="settings-search-clear" onClick={() => { setSearchQuery(''); setSearchResults([]); }}>
                ✕
              </button>
            )}
          </div>
          {searchResults.length > 0 && (
            <div className="settings-search-results">
              {groupByTab(searchResults).map((group) => (
                <div key={group.tabId} className="settings-search-group">
                  <div className="settings-search-group-label">{t(SETTINGS_TAB_LABEL_KEYS[group.tabId])}</div>
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      className="settings-search-item"
                      onClick={() => handleSearchResultClick(item)}
                    >
                      <div className="settings-search-item-label">{highlightMatch(item.labelKey ? t(item.labelKey) : item.label, searchQuery)}</div>
                      {item.section && (
                        <div className="settings-search-item-section">{item.section}</div>
                      )}
                      {item.description && (
                        <div className="settings-search-item-desc">{item.description}</div>
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          </div>
          <div className="settings-header-actions">
            <button
              className="settings-fullscreen-btn"
              type="button"
              onClick={toggleFullScreen}
              title={isFullScreen ? i18n.t('common:exitFullscreen') : i18n.t('common:fullscreen')}
            >
              {isFullScreen ? (
                <svg className="settings-fullscreen-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="10" y1="14" x2="3" y2="21" />
                </svg>
              ) : (
                <svg className="settings-fullscreen-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              )}
            </button>
            <button className="close-btn" onClick={handleClose}>✕</button>
          </div>
        </div>

        {/* Encryption Warning */}
        {!isEncryptionAvailable && (
          <div className="encryption-warning">
            <span className="warning-icon">Warning:</span>
            <span>
              Secure storage unavailable. Credentials will be stored without encryption.
              <br />
              <small>Install a keyring (gnome-keyring, kwallet) for secure storage.</small>
            </span>
          </div>
        )}

        <div className="settings-body">
          {/* Sidebar Navigation */}
          <SettingsSidebar
            activeTab={activeTab}
            onTabChange={handleTabChange}
            hasVodSource={hasVodSource}
          />

          {/* Tab Content */}
          <div className="settings-content">
            {renderTabContent()}
          </div>
        </div>
      </div>
      <ModalComponent />
    </div>
  );
}
