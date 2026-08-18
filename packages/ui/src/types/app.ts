export type ThemeId = 'dark' | 'light' | 'midnight' | 'forest' | 'ocean' | 'sunset' | 'glass-ocean' | 'glass-neon' | 'glass-galaxy' | 'glass-autumn' | 'glass-berry' | 'glass-forest' | 'glass-sunset' | 'glass-rose' | 'glass-midnight' | 'glass-amber' | 'glass-mint' | 'glass-coral' | 'glass-lavender' | 'glass-slate' | 'glass-cherry' | 'glass-gold' | 'glass-miami' | 'glass-electric' | 'glass-hotpink' | 'glass-lime' | 'glass-orange' | 'glass-red' | 'glass-yellow' | 'glass-violet' | 'glass-coral-neon' | 'glass-turquoise' | 'glass-magenta' | 'glass-chartreuse' | 'glass-indigo' | 'solid-midnight' | 'solid-ocean' | 'solid-forest' | 'solid-sunset' | 'solid-berry' | 'solid-rose' | 'solid-amber' | 'solid-mint' | 'solid-coral' | 'solid-lavender' | 'solid-slate' | 'solid-cherry' | 'solid-gold' | 'solid-emerald' | 'solid-sapphire' | 'solid-ruby' | 'solid-amethyst' | 'solid-cosmic' | 'solid-tropical' | 'solid-aurora' | 'solid-tropicana' | 'solid-nebula' | 'solid-monochrome' | 'solid-neon' | 'solid-horizon' | 'solid-dragonfruit' | 'solid-arctic' | 'solid-volcano' | 'solid-zengarden' | 'solid-galaxy' | 'solid-miami' | 'solid-cyberpunk' | 'solid-deepocean' | 'solid-blossom' | 'solid-northern' | 'solid-rainbow' | 'solid-copper' | 'solid-midnightrose' | 'solid-enchanted' | 'dark-crimson' | 'dark-cyan' | 'dark-purple' | 'dark-emerald' | 'dark-orange' | 'dark-pink' | 'dark-blue' | 'dark-gold' | 'dark-lime' | 'dark-indigo' | 'dark-slate' | 'dark-warmgrey' | 'dark-steel' | 'custom';

export interface CustomThemeConfig {
    backgroundType: 'solid' | 'gradient';
    backgroundColor: string;
    gradientStart: string;
    gradientMiddle: string;
    gradientEnd: string;
    gradientColor4?: string;
    gradientColor5?: string;
    accentColor: string;
    textColor: string;
    textSecondaryColor: string;
    surfaceColor: string;
    surfaceOpacity: number;
    surfaceBorderColor: string;
    surfaceBorderOpacity: number;
    glassBlur: number;
    glassSaturation: number;
    customBlob1?: string;
    customBlob2?: string;
    customBlob3?: string;
    customBlob4?: string;
    customBlob1Opacity?: number;
    customBlob2Opacity?: number;
    customBlob3Opacity?: number;
    customBlob4Opacity?: number;
    showGlassBlobs?: boolean;
    glassOverlayOpacity?: number;
    oledBlack?: boolean;
    fontFamily?: string;
    customFontBase64?: string;
    customFontFormat?: string;
    customFontName?: string;
    id?: string;
    themeName?: string;
}

export interface ShortcutsMap {
    [action: string]: string;
}

export type ShortcutAction =
    | 'togglePlay'
    | 'toggleMute'
    | 'cycleSubtitle'
    | 'cycleAudio'
    | 'selectSubtitle'
    | 'selectAudio'
    | 'toggleStats'
    | 'toggleFullscreen'
    | 'toggleGuide'
    | 'toggleCategories'
    | 'toggleLiveTV'
    | 'toggleDvr'
    | 'toggleSports'
    | 'toggleCalendar'
    | 'toggleSettings'
    | 'focusSearch'
    | 'close'
    | 'seekForward'
    | 'seekBackward'
    | 'layoutMain'
    | 'layoutPip'
    | 'layoutBigBottom'
    | 'layout2x2'
    | 'channelUp'
    | 'channelDown'
    | 'toggleEpgView'
    | 'replayLastStream'
    | 'toggleTransparentGuide'
    | 'toggleNuvio'
    | 'toggleStrem'
    | 'toggleShortcutsOverlay'
    | 'mouseBackNavigation';

export interface SavedChannelState {
    channelName: string | null;
    channelUrl: string | null;
    sourceName: string | null;
}

export interface SavedSlotState {
    id: 2 | 3 | 4;
    channelName: string | null;
    channelUrl: string | null;
    sourceName: string | null;
    active: boolean;
}

export interface SavedLayoutState {
    layout: 'main' | 'pip' | '2x2' | 'bigbottom' | 'sbs';
    mainChannel: SavedChannelState;
    slots: SavedSlotState[];
}

export interface GlobalEpgLink {
    id: string;
    name: string;
    url: string;
    sourceIds: string[];
    saveEntireEpg?: boolean;
    lastSynced?: number; // Unix timestamp ms
    display_order?: number; // Lower = higher priority in waterfall
    lastSyncResult?: {
        timestamp: number;
        totalInserted: number;
        perSource: Record<string, number>; // sourceId -> count
        channelsMatched?: number;
        perSourceChannels?: Record<string, number>; // sourceId -> count
        matchedStreamIds?: string[];
    };
}

export interface AppSettings {
    theme?: ThemeId;
    customThemeConfig?: CustomThemeConfig;
    savedCustomThemes?: CustomThemeConfig[];
    appFontFamily?: string;
    appCustomFontBase64?: string;
    appCustomFontFormat?: string;
    appCustomFontName?: string;
    language?: string;
    debug?: boolean;
    epgRefreshHours?: number;
    vodRefreshHours?: number;
    channelSortOrder?: string;
    categorySortOrder?: 'default' | 'alphabetical';
    // Favorites placement in the LiveTV sidebar: 'global' (top-level), 'perSource' (nested under each source), or 'both'
    favoritesMode?: 'global' | 'perSource' | 'both';
    // Automated backups (same JSON format as Settings -> Export / Import)
    autoBackupEnabled?: boolean;
    autoBackupIntervalHours?: number;
    autoBackupMaxBackups?: number;
    autoBackupDirectory?: string;
    channelFontSize?: number;
    categoryFontSize?: number;
    epgTitleFontSize?: number;
    epgBodyFontSize?: number;
    epgDarkenCurrent?: boolean;
    epgHighlightBorderCurrent?: boolean;
    epgBoldChannelNames?: boolean;
    epgBoldTopCategories?: boolean;
    epgBoldSourceCategories?: boolean;
    epgPreferEpgLogos?: boolean;
    epgLogoDisplay?: 'square' | 'rectangle';
    sourceLogoDisplayOverrides?: Record<string, 'square' | 'rectangle'>;
    channelLogoSize?: number;
    channelLogoRoundEdges?: boolean;
    channelLogoPadding?: 'none' | 'padded';
    logoSmartTrim?: boolean;
    logoLightBackgroundDetection?: boolean;
    epgMetadataBadgeResolution?: boolean;
    epgMetadataBadgeFps?: boolean;
    epgMetadataBadgeFpsSuffix?: boolean;
    epgMetadataBadgeSound?: boolean;
    logoCacheEnabled?: boolean;
    logoCacheMaxMb?: number;
    logoCacheTtlDays?: number;
    disableThemeBackdropBlur?: boolean;
    // True-black (OLED) mode for the dark-family themes in the v3 UI: surfaces
    // render pure black while keeping the theme's accent color.
    oledBlack?: boolean;
    epgLazyLoadingEnabled?: boolean;
    disableEpgTransitions?: boolean;
    epgReduceGpuLayers?: boolean;
    epgDisableChannelFade?: boolean;
    shortcuts?: ShortcutsMap;
    startupWidth?: number;
    startupHeight?: number;
    dontSaveWindowSizeOnClose?: boolean;
    minimizeToTray?: boolean;
    playerControlDesign?: 'default' | 'clean';
    showVolumePercent?: boolean;
    overlayAutohideTimer?: number;
    uiScale?: number;
    epgVisibleHours?: 'auto' | number;
    epgClockFormat?: '12h' | '24h';
    epgShowDate?: boolean;
    rememberLastChannels?: boolean;
    savedLayoutState?: SavedLayoutState;
    startupView?: 'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'sports' | 'calendar' | 'stremio' | 'nuvio';
    searchResultsOrder?: 'default' | 'alphabetical';
    // Advanced search settings
    advancedSearchScope?: 'channels' | 'epg' | 'both';
    advancedSearchSourceIds?: string[];
    advancedSearchCategoryIds?: string[];
    useAdvancedSearchForRegular?: boolean;
    searchCustomPlaylists?: boolean;
    // Global EPG links that can be shared across multiple sources
    globalEpgLinks?: GlobalEpgLink[];
    // Navigation tab visibility — tabs hidden from titlebar
    navHiddenTabs?: string[];
    // EPG button visibility — buttons hidden from LiveTV EPG header
    epgHiddenButtons?: string[];
    // Trakt integration settings
    traktEnabled?: boolean;
    traktAccessToken?: string | null;
    traktRefreshToken?: string | null;
    traktTokenExpiresAt?: number | null;
    traktScrobbleEnabled?: boolean;
    traktSyncEnabled?: boolean;
    traktCatalogsEnabled?: Record<string, boolean>;
    traktCatalogOrder?: string[];
    traktCatalogsBeforeAddon?: boolean;
    traktEnabledLists?: { id: string; name: string }[];
    traktNuvioCatalogsEnabled?: Record<string, boolean>;
    traktNuvioCatalogOrder?: string[];
    traktNuvioCatalogsBeforeAddon?: boolean;
    traktNuvioEnabledLists?: { id: string; name: string }[];
    // Simkl integration settings
    simklEnabled?: boolean;
    simklAccessToken?: string | null;
    simklScrobbleEnabled?: boolean;
    globalLiveTvUserAgent?: string;
    catchupStartPadding?: number;
    catchupEndPadding?: number;
    catchupContinuePlaying?: boolean;
    vodAutoPlayNextEpisode?: boolean;
    vodShowSourceBadge?: boolean;
    failoverGroupShowSource?: boolean;
    [key: string]: any;
}

export interface MpvStatus {
    playing?: boolean;
    volume?: number;
    muted?: boolean;
    position?: number;
    duration?: number;
    pause?: boolean;
    Idle?: boolean;
    pausedForCache?: boolean;
    coreIdle?: boolean;
    videoFormat?: string | null;
    videoTrackId?: any;
}
