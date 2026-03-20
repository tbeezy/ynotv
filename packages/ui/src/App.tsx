import { useState, useEffect, useCallback, useRef } from 'react';

// Auto-sync check interval: 10 minutes
const AUTO_SYNC_CHECK_INTERVAL_MS = 10 * 60 * 1000;
import { invoke } from '@tauri-apps/api/core';
import './services/tauri-bridge'; // Initialize Tauri bridge and polyfills
import { checkForUpdates, checkForUpdatesSilent } from './services/updater';
import { Settings } from './components/Settings';
import type { SettingsTabId } from './components/settings/SettingsSidebar';
import { Sidebar, type View } from './components/Sidebar';
import { NowPlayingBar } from './components/NowPlayingBar';
import { TrackSelectionModal } from './components/TrackSelectionModal';
import { CategoryStrip } from './components/CategoryStrip';
import { ChannelPanel } from './components/ChannelPanel';
import { MoviesPage } from './components/MoviesPage';
import { SeriesPage } from './components/SeriesPage';
import { DvrDashboard } from './components/DvrDashboard';
import { SportsHub } from './components/sports/SportsHub';
import { TVCalendarPage } from './components/TVCalendarPage';
import { useActiveRecordings } from './hooks/useActiveRecordings';
import { RecordingIndicator } from './components/RecordingIndicator';
import { Logo } from './components/Logo';
import { useSelectedCategory, useChannelSearch, useProgramSearch, useChannels } from './hooks/useChannels';
import {
  useChannelSyncing,
  useVodSyncing,
  useTmdbMatching,
  useSyncStatusMessage,
  useChannelSortOrder,
  useSetChannelSyncing,
  useSetVodSyncing,
  useSetSyncStatusMessage,
  useSetChannelSortOrder
} from './stores/uiStore';
import type { StoredChannel } from './db';
import { db } from './db';
import { VideoErrorOverlay } from './components/VideoErrorOverlay';
import { syncSource, syncVodForSource, isEpgStale, isVodStale } from './db/sync';
import { bulkOps } from './services/bulk-ops';
import { Bridge } from './services/tauri-bridge';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { addToRecentChannels } from './utils/recentChannels';
import { WatchlistNotificationContainer } from './components/WatchlistNotification';
import { MultiviewLayout } from './components/MultiviewLayout/MultiviewLayout';
import { LayoutPicker } from './components/LayoutPicker/LayoutPicker';
import './themes.css';
import { useTimeshift } from './hooks/useTimeshift';
import { useDvrEvents } from './hooks/useDvrEvents';
import { useDvrUrlResolver } from './hooks/useDvrUrlResolver';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { UpdateModal } from './components/UpdateModal';
import { registerUpdateModal } from './services/updater';
import { useLayoutPersistence, type LayoutMode } from './hooks/useLayoutPersistence';
import { useMpvListeners } from './hooks/useMpvListeners';

// NEW: Extracted hooks
import { useAppSettings } from './hooks/useAppSettings';
import { usePlayback } from './hooks/usePlayback';
import { useNavigation } from './hooks/useNavigation';
import { useWatchlist } from './hooks/useWatchlist';
import { useWindowManager } from './hooks/useWindowManager';

// ============================================================================
// App Component
// ============================================================================

function App() {
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
    miniMediaBarForEpgPreview,
    theme,
    shortcuts,
    showSidebar: showSidebarFromSettings,
    setTheme,
    setShortcuts,
    setShowSidebar: setShowSidebarFromSettings,
  } = useAppSettings();

  // ==========================================================================
  // MPV Listeners (must be before useLayoutPersistence for mpvReady)
  // ==========================================================================
  const mpv = useMpvListeners({
    timeshiftEnabled,
    timeshiftCacheBytes,
    settingsLoaded: layoutSettingsLoaded,
  });

  const {
    mpvReady,
    playing,
    volume,
    muted,
    position,
    duration,
    error,
    volumeDraggingRef,
    seekingRef,
    setError,
    setPlaying,
    setPosition,
    setVolume,
  } = mpv;

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
    switchLayout,
    sendToSlot,
    swapWithMain,
    stopSlot,
    setSlotProperty,
    repositionSecondarySlots,
    enterTabMode,
    exitTabMode,
    notifyMainLoaded,
    syncMpvGeometry,
    isRestoring,
  } = multiview;

  // Refs for multiview (used by keyboard shortcuts)
  const multiviewLayoutRef = useRef<LayoutMode>('main');
  const switchLayoutRef = useRef(switchLayout);
  const handlePlayChannelRef = useRef<((channel: StoredChannel, autoSwitched?: boolean) => void) | null>(null);
  const lastPlayedChannelRef = useRef<StoredChannel | null>(null);
  useEffect(() => { multiviewLayoutRef.current = multiviewLayout; }, [multiviewLayout]);
  useEffect(() => { switchLayoutRef.current = switchLayout; }, [switchLayout]);

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
    catchupInfo,
    isCatchup,
    setCurrentChannel,
    handlePlayChannel,
    handlePlayCatchup,
    handleCatchupSeek,
    handlePlayVod,
    handlePlayRecording,
    handleStop,
    handleSeek,
    handleTogglePlay,
    handleVolumeChange,
    handleToggleMute,
    handleCycleSubtitle,
    handleCycleAudio,
    handleToggleStats,
    handleToggleFullscreen,
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
    initialShowSidebar: showSidebarFromSettings,
  });

  const {
    activeView,
    settingsTab,
    editSourceId,
    categoriesOpen,
    sidebarExpanded,
    showSidebar,
    searchQuery,
    debouncedSearchQuery,
    isSearchMode,
    isWatchlistMode,
    showControls,
    controlsHoveredRef,
    titleBarSearchRef,
    activeViewRef,
    categoriesOpenRef,
    setActiveView,
    setSettingsTab,
    setEditSourceId,
    setCategoriesOpen,
    setSidebarExpanded,
    setShowSidebar,
    setSearchQuery,
    setIsWatchlistMode,
    setShowControls,
    handleSelectCategory,
    handleMouseMove,
  } = nav;

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
  const { handleMinimize, handleMaximize, handleClose } = useWindowManager();

  // ==========================================================================
  // Update Modal State
  // ==========================================================================
  const [updateModalOpen, setUpdateModalOpen] = useState(false);

  useEffect(() => {
    registerUpdateModal(setUpdateModalOpen);
  }, []);

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

  // ==========================================================================
  // TimeShift State
  // ==========================================================================
  const timeshiftState = useTimeshift(timeshiftEnabled);

  // ==========================================================================
  // DVR Events & URL Resolver
  // ==========================================================================
  useDvrEvents();
  useDvrUrlResolver();

  // ==========================================================================
  // Category & Channel State
  // ==========================================================================
  const currentChannels = useChannels(categoryId, channelSortOrder);
  const currentChannelsRef = useRef(currentChannels);
  useEffect(() => { currentChannelsRef.current = currentChannels; }, [currentChannels]);

  // ==========================================================================
  // Active Recordings
  // ==========================================================================
  const { recordings: activeRecordings, isRecording: hasActiveRecording } = useActiveRecordings(5000);

  // ==========================================================================
  // Search Results
  // ==========================================================================
  const searchChannels = useChannelSearch(debouncedSearchQuery, maxSearchResults, includeSourceInSearch);
  const searchPrograms = useProgramSearch(debouncedSearchQuery, maxSearchResults);

  // ==========================================================================
  // Track Selection Modal State
  // ==========================================================================
  const [showSubtitleModal, setShowSubtitleModal] = useState(false);
  const [showAudioModal, setShowAudioModal] = useState(false);

  const handleShowSubtitleModal = useCallback(() => setShowSubtitleModal(true), []);
  const handleShowAudioModal = useCallback(() => setShowAudioModal(true), []);

  // ==========================================================================
  // Refs for Keyboard Shortcuts (to avoid stale closures)
  // ==========================================================================
  const playingRef = useRef(playing);
  const positionRef = useRef(position);
  const shortcutsRef = useRef(shortcuts);
  const currentChannelRef = useRef(currentChannel);
  const handleTogglePlayRef = useRef(handleTogglePlay);
  const handleToggleMuteRef = useRef(handleToggleMute);
  const handleToggleStatsRef = useRef(handleToggleStats);
  const handleToggleFullscreenRef = useRef(handleToggleFullscreen);
  const handleShowSubtitleModalRef = useRef(handleShowSubtitleModal);
  const handleShowAudioModalRef = useRef(handleShowAudioModal);
  const handleSeekRef = useRef(handleSeek);
  const setActiveViewRef = useRef(setActiveView);
  const setCategoriesOpenRef = useRef(setCategoriesOpen);
  const setSidebarExpandedRef = useRef(setSidebarExpanded);
  const setShowControlsRef = useRef(setShowControls);

  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => { shortcutsRef.current = shortcuts; }, [shortcuts]);
  useEffect(() => { currentChannelRef.current = currentChannel; }, [currentChannel]);
  useEffect(() => { handleTogglePlayRef.current = handleTogglePlay; }, [handleTogglePlay]);
  useEffect(() => { handleToggleMuteRef.current = handleToggleMute; }, [handleToggleMute]);
  useEffect(() => { handleToggleStatsRef.current = handleToggleStats; }, [handleToggleStats]);
  useEffect(() => { handleToggleFullscreenRef.current = handleToggleFullscreen; }, [handleToggleFullscreen]);
  useEffect(() => { handleShowSubtitleModalRef.current = handleShowSubtitleModal; }, [handleShowSubtitleModal]);
  useEffect(() => { handleShowAudioModalRef.current = handleShowAudioModal; }, [handleShowAudioModal]);
  useEffect(() => { handleSeekRef.current = handleSeek; }, [handleSeek]);
  useEffect(() => { setActiveViewRef.current = setActiveView; }, [setActiveView]);
  useEffect(() => { setCategoriesOpenRef.current = setCategoriesOpen; }, [setCategoriesOpen]);
  useEffect(() => { setSidebarExpandedRef.current = setSidebarExpanded; }, [setSidebarExpanded]);
  useEffect(() => { setShowControlsRef.current = setShowControls; }, [setShowControls]);

  // ==========================================================================
  // Tab Mode: enter when EPG, Sports, DVR, Settings, Movies, or Series opens
  // ==========================================================================
  useEffect(() => {
    if (activeView === 'guide' || activeView === 'sports' || activeView === 'dvr' ||
        activeView === 'settings' || activeView === 'movies' || activeView === 'series' ||
        activeView === 'calendar') {
      enterTabMode(activeView);
    } else {
      exitTabMode();
    }
  }, [activeView, enterTabMode, exitTabMode]);

  // ==========================================================================
  // Handle Watchlist Switch (needs access to handlePlayChannel)
  // ==========================================================================
  const handleWatchlistSwitchWrapper = useCallback(async (notification: import('./components/WatchlistNotification').WatchlistNotificationItem) => {
    const channel = await db.channels.get(notification.channelId);
    if (channel) {
      addToRecentChannels(channel);
      handlePlayChannel(channel);
    }
  }, [handlePlayChannel]);

  // ==========================================================================
  // Handle Channel Navigation (Up/Down)
  // ==========================================================================
  const handleChannelUp = useCallback(() => {
    const channels = currentChannelsRef.current;
    const currentCh = currentChannelRef.current;
    if (channels.length > 0 && currentCh) {
      const currentIndex = channels.findIndex((ch) => ch.stream_id === currentCh.stream_id);
      if (currentIndex > 0) {
        handlePlayChannel(channels[currentIndex - 1]);
      } else if (currentIndex === 0) {
        // Wrap to last channel
        handlePlayChannel(channels[channels.length - 1]);
      }
    }
  }, [handlePlayChannel]);

  const handleChannelDown = useCallback(() => {
    const channels = currentChannelsRef.current;
    const currentCh = currentChannelRef.current;
    if (channels.length > 0 && currentCh) {
      const currentIndex = channels.findIndex((ch) => ch.stream_id === currentCh.stream_id);
      if (currentIndex >= 0 && currentIndex < channels.length - 1) {
        handlePlayChannel(channels[currentIndex + 1]);
      } else if (currentIndex === channels.length - 1) {
        // Wrap to first channel
        handlePlayChannel(channels[0]);
      }
    }
  }, [handlePlayChannel]);

  // ==========================================================================
  // Keyboard Shortcuts
  // ==========================================================================
  useKeyboardShortcuts({
    shortcutsRef,
    activeViewRef,
    categoriesOpenRef,
    positionRef,
    currentChannelsRef,
    currentChannelRef,
    switchLayoutRef,
    titleBarSearchRef,
    handlePlayChannelRef: { current: handlePlayChannel },
    lastPlayedChannelRef,
    handleTogglePlayRef,
    handleToggleMuteRef,
    handleToggleStatsRef,
    handleToggleFullscreenRef,
    handleShowSubtitleModalRef,
    handleShowAudioModalRef,
    handleSeekRef,
    setActiveViewRef,
    setCategoriesOpenRef,
    setSidebarExpandedRef,
    setShowControlsRef,
  });

  // ==========================================================================
  // Auto-Sync on Startup & Periodic Checking
  // ==========================================================================
  const isAutoSyncingRef = useRef(false);

  useEffect(() => {
    // Helper to perform sync check and sync stale sources
    const performSyncCheck = async (isPeriodic = false) => {
      if (!window.storage) return;

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
        // Load settings first
        const settingsResult = await window.storage.getSettings();
        if (!isPeriodic && settingsResult.data) {
          // Apply font sizes (only on initial sync)
          if (settingsResult.data.channelFontSize) {
            document.documentElement.style.setProperty('--channel-font-size', `${settingsResult.data.channelFontSize}px`);
          }
          if (settingsResult.data.categoryFontSize) {
            document.documentElement.style.setProperty('--category-font-size', `${settingsResult.data.categoryFontSize}px`);
          }
          // Apply other settings
          if (settingsResult.data.channelSortOrder) {
            setChannelSortOrder(settingsResult.data.channelSortOrder as 'alphabetical' | 'number');
          }
        }

        const epgRefreshHours = settingsResult.data?.epgRefreshHours ?? 6;
        const vodRefreshHours = settingsResult.data?.vodRefreshHours ?? 24;

        // Skip periodic check if both are manual-only (0 = manual only)
        if (isPeriodic && epgRefreshHours === 0 && vodRefreshHours === 0) {
          return;
        }

        // Get sources
        const result = await window.storage.getSources();
        if (!result.data || result.data.length === 0) return;

        let didSync = false;

        // ── Channel / EPG sync ──────────────────────────────────────────────
        if (epgRefreshHours > 0) {
          // Filter out VOD-only sources from channel sync
          const enabledSources = result.data.filter((s: any) => s.enabled && !s.vod_only);
          const staleSources: any[] = [];
          for (const source of enabledSources) {
            if (await isEpgStale(source.id, epgRefreshHours)) staleSources.push(source);
          }

          if (staleSources.length > 0) {
            didSync = true;
            isAutoSyncingRef.current = true;
            setChannelSyncing(true);
            const CONCURRENCY = 10;
            const total = staleSources.length;
            const statusPrefix = isPeriodic ? 'Auto-syncing' : 'Syncing';
            for (let i = 0; i < total; i += CONCURRENCY) {
              const batch = staleSources.slice(i, i + CONCURRENCY);
              const batchNum = Math.floor(i / CONCURRENCY) + 1;
              const totalBatches = Math.ceil(total / CONCURRENCY);
              setSyncStatusMessage(`${statusPrefix} batch ${batchNum}/${totalBatches}: ${batch.map((s: any) => s.name).join(', ')}`);
              await Promise.all(
                batch.map(async (source: any, idx: number) => {
                  const prefix = `[${i + idx + 1}/${total}] ${source.name}`;
                  await syncSource(source, (msg) => setSyncStatusMessage(`${prefix}: ${msg}`));
                })
              );
            }
            setSyncStatusMessage(null);
          }
        }

        // ── VOD sync (Xtream only) ──────────────────────────────────────────
        if (vodRefreshHours > 0) {
          const xtreamSources = result.data.filter((s: any) => s.type === 'xtream' && s.enabled);
          if (xtreamSources.length > 0) {
            const staleVod: any[] = [];
            for (const source of xtreamSources) {
              if (await isVodStale(source.id, vodRefreshHours)) staleVod.push(source);
            }
            if (staleVod.length > 0) {
              didSync = true;
              isAutoSyncingRef.current = true;
              setVodSyncing(true);
              const CONCURRENCY = 10;
              const total = staleVod.length;
              const statusPrefix = isPeriodic ? 'Auto-syncing' : 'Syncing';
              for (let i = 0; i < total; i += CONCURRENCY) {
                const batch = staleVod.slice(i, i + CONCURRENCY);
                const batchNum = Math.floor(i / CONCURRENCY) + 1;
                const totalBatches = Math.ceil(total / CONCURRENCY);
                setSyncStatusMessage(`${statusPrefix} VOD batch ${batchNum}/${totalBatches}: ${batch.map((s: any) => s.name).join(', ')}`);
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
        console.error('[AutoSync] Sync failed:', err);
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
        const width = settings.startupWidth || 1920;
        const height = settings.startupHeight || 1080;

        const appWindow = getCurrentWindow();
        const isMaximized = await appWindow.isMaximized();
        if (isMaximized) {
          await appWindow.unmaximize();
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
  // Render
  // ==========================================================================
  return (
    <div className={`app${showControls ? '' : ' controls-hidden'}`} onMouseMove={handleMouseMove}>
      {/* Custom title bar for frameless window */}
      <div className={`title-bar${showControls ? ' visible' : ''}`} data-tauri-drag-region>
        <div className="title-bar-left-group" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Logo className="title-bar-logo" />
          <LayoutPicker
            currentLayout={multiviewLayout}
            onSelect={switchLayout}
          />
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
                  const newLiveTVState = !(activeView === 'guide' && categoriesOpen);
                  if (newLiveTVState) {
                    setActiveView('guide');
                    setCategoriesOpen(true);
                  } else {
                    setActiveView('none');
                    setCategoriesOpen(false);
                  }
                }}
                title="Live TV"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
                  <polyline points="17 2 12 7 7 2"></polyline>
                </svg>
                <span>Live TV</span>
              </button>

              <button
                className={`segmented-btn ${activeView === 'movies' ? 'active' : ''}`}
                onClick={() => {
                  setCategoriesOpen(false);
                  setActiveView(activeView === 'movies' ? 'none' : 'movies');
                }}
                title="Movies"
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
                <span>Movies</span>
              </button>

              <button
                className={`segmented-btn ${activeView === 'series' ? 'active' : ''}`}
                onClick={() => {
                  setCategoriesOpen(false);
                  setActiveView(activeView === 'series' ? 'none' : 'series');
                }}
                title="Series"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -9"></path>
                  <path d="M16 3l-4 4l-4 -4"></path>
                </svg>
                <span>Series</span>
              </button>

              <button
                className={`segmented-btn ${activeView === 'dvr' ? 'active' : ''}`}
                onClick={() => {
                  setCategoriesOpen(false);
                  setActiveView(activeView === 'dvr' ? 'none' : 'dvr');
                }}
                title="DVR"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 10l4.553-2.276A1 1 0 0 1 21 8.618v6.764a1 1 0 0 1-1.447.894L15 14M5 18h8a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2z"></path>
                </svg>
                <span>DVR</span>
              </button>

              <button
                className={`segmented-btn ${activeView === 'sports' ? 'active' : ''}`}
                onClick={() => {
                  setCategoriesOpen(false);
                  setActiveView(activeView === 'sports' ? 'none' : 'sports');
                }}
                title="Sports Hub"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 21h8"></path>
                  <path d="M12 17v4"></path>
                  <path d="M7 4h10"></path>
                  <path d="M17 4v8a5 5 0 0 1-10 0V4"></path>
                  <path d="M5 9c-1.5 0-3 .6-3 2 0 1.4 1.5 2 3 2"></path>
                  <path d="M19 9c1.5 0 3 .6 3 2 0 1.4-1.5 2-3 2"></path>
                </svg>
                <span>Sports</span>
              </button>
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
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (e.target.value.length >= 1) {
                    setCategoriesOpen(true);
                    if (activeView !== 'guide') {
                      setActiveView('guide');
                    }
                  }
                }}
                onFocus={() => {
                  if (!isSearchMode && activeView !== 'guide') {
                    setCategoriesOpen(true);
                    setActiveView('guide');
                  }
                }}
              />
              {searchQuery && (
                <button
                  className="title-bar-search-clear"
                  onClick={() => setSearchQuery('')}
                  title="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="title-bar-spacer" style={{ position: 'relative' }}>
          {hasActiveRecording && (
            <div className="title-bar-recording-indicator">
              <RecordingIndicator size="small" variant="recording" />
            </div>
          )}
        </div>

        {/* Calendar Button */}
        <button
          className={`title-bar-calendar-btn ${activeView === 'calendar' ? 'active' : ''}`}
          onClick={() => {
            setCategoriesOpen(false);
            setActiveView(activeView === 'calendar' ? 'none' : 'calendar');
          }}
          title="TV Calendar"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12z" />
            <path d="M16 3v4" />
            <path d="M8 3v4" />
            <path d="M4 11h16" />
          </svg>
        </button>

        {/* Settings Button */}
        <button
          className={`title-bar-settings-btn ${activeView === 'settings' ? 'active' : ''}`}
          onClick={() => {
            setCategoriesOpen(false);
            setActiveView(activeView === 'settings' ? 'none' : 'settings');
            setSettingsTab('sources');
            setEditSourceId(null);
          }}
          title="Settings"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        </button>

        <div className="window-controls">
          <button onClick={handleMinimize} title="Minimize">─</button>
          <button onClick={handleMaximize} title="Maximize">□</button>
          <button onClick={handleClose} className="close" title="Close">✕</button>
        </div>
      </div>

      {/* Background - transparent over mpv */}
      <div className="video-background">
        {!currentChannel && !error && !isRestoring && (
          <div className="placeholder">
            <Logo className="placeholder__logo" />
            {(channelSyncing || vodSyncing || tmdbMatching) ? (
              <div className="sync-status">
                <div className="sync-status__spinner" />
                <span className="sync-status__text">
                  {syncStatusMessage || (channelSyncing && vodSyncing
                    ? 'Syncing channels & VOD...'
                    : channelSyncing
                      ? 'Syncing channels...'
                      : vodSyncing
                        ? 'Syncing VOD...'
                        : 'Matching with TMDB...')}
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
      </div>

      {/* Video double-click overlay - captures double-clicks on video area to toggle fullscreen */}
      {activeView === 'none' && multiviewLayout === 'main' && (
        <div
          className="video-doubleclick-overlay"
          onDoubleClick={() => {
            handleToggleFullscreen();
          }}
        />
      )}

      {/* Now Playing Bar */}
      <NowPlayingBar
        visible={
          showControls &&
          activeView !== 'guide' &&
          !categoriesOpen &&
          !isSearchMode
        }
        channel={currentChannel}
        playing={playing}
        muted={muted}
        volume={volume}
        mpvReady={mpvReady}
        position={position}
        duration={duration}
        isVod={currentChannel?.stream_id === 'vod' || currentChannel?.stream_id?.startsWith('recording_')}
        vodInfo={vodInfo}
        isCatchup={isCatchup}
        catchupInfo={catchupInfo}
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
        onGoToLive={() => currentChannel && handlePlayChannel(currentChannel)}
        onCatchupSeek={handleCatchupSeek}
        timeshiftEnabled={timeshiftEnabled}
        timeshiftState={timeshiftState}
        onTimeshiftCatchUp={() => {
          if (timeshiftState) {
            handleSeek(Math.max(0, timeshiftState.cacheEnd - liveBufferOffset));
          }
        }}
      />

      {/* Multiview Layout */}
      {multiviewLayout !== 'main' && activeView === 'none' && (
        <MultiviewLayout
          layout={multiviewLayout}
          slots={multiviewSlots}
          onSwapWithMain={(slotId) => swapWithMain(slotId, multiviewSlots)}
          onStop={stopSlot}
          onSetProperty={setSlotProperty}
          onReposition={repositionSecondarySlots}
        />
      )}

      {/* Track Selection Modals */}
      <TrackSelectionModal
        isOpen={showSubtitleModal}
        type="subtitle"
        onClose={() => setShowSubtitleModal(false)}
      />
      <TrackSelectionModal
        isOpen={showAudioModal}
        type="audio"
        onClose={() => setShowAudioModal(false)}
      />

      {/* Sidebar Navigation */}
      <Sidebar
        activeView={activeView}
        onViewChange={setActiveView}
        visible={showSidebar && (showControls || categoriesOpen || activeView !== 'none')}
        categoriesOpen={categoriesOpen}
        onCategoriesToggle={() => setCategoriesOpen((open) => !open)}
        onCategoriesClose={() => setCategoriesOpen(false)}
        expanded={sidebarExpanded}
        onExpandedToggle={() => setSidebarExpanded((exp) => !exp)}
      />

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
        sidebarExpanded={sidebarExpanded}
        showSidebar={showSidebar}
        onEditSource={(sourceId) => {
          setSettingsTab('sources');
          setEditSourceId(sourceId);
          setActiveView('settings');
          setCategoriesOpen(false);
          setSidebarExpanded(false);
        }}
      />

      {/* Channel Panel */}
      <ChannelPanel
        categoryId={isSearchMode || isWatchlistMode ? null : categoryId}
        visible={activeView === 'guide'}
        categoryStripOpen={categoriesOpen}
        sidebarExpanded={sidebarExpanded}
        showSidebar={showSidebar}
        onPlayChannel={handlePlayChannel}
        onPlayCatchup={handlePlayCatchup}
        onClose={() => {
          setActiveView('none');
          setCategoriesOpen(false);
          setSidebarExpanded(false);
          Bridge.syncWindow();
        }}
        error={error}
        isSearchMode={isSearchMode}
        searchQuery={debouncedSearchQuery}
        searchChannels={searchChannels}
        searchPrograms={searchPrograms}
        isWatchlistMode={isWatchlistMode}
        watchlistItems={watchlistItems}
        onWatchlistRefresh={refreshWatchlist}
        currentLayout={multiviewLayout}
        onSendToSlot={sendToSlot}
        includeSourceInSearch={includeSourceInSearch}
        currentChannel={currentChannel}
        miniMediaBarForEpgPreview={miniMediaBarForEpgPreview}
        onTogglePlay={handleTogglePlay}
        isPlaying={playing}
        onChannelUp={handleChannelUp}
        onChannelDown={handleChannelDown}
      />

      {/* Settings Panel */}
      {activeView === 'settings' && (
        <Settings
          initialTab={settingsTab}
          editSourceId={editSourceId}
          onClose={() => { setActiveView('none'); setEditSourceId(null); }}
          onShortcutsChange={setShortcuts}
          theme={theme}
          onThemeChange={setTheme}
        />
      )}

      {/* Movies Page */}
      {activeView === 'movies' && (
        <MoviesPage
          onPlay={(info) => handlePlayVod(info, () => setActiveView('none'))}
          onClose={() => setActiveView('none')}
        />
      )}

      {/* Series Page */}
      {activeView === 'series' && (
        <SeriesPage
          onPlay={(info) => handlePlayVod(info, () => setActiveView('none'))}
          onClose={() => setActiveView('none')}
        />
      )}

      {/* DVR Dashboard */}
      {activeView === 'dvr' && (
        <DvrDashboard
          onPlay={(recording) => handlePlayRecording(recording, () => setActiveView('none'))}
          onClose={() => setActiveView('none')}
        />
      )}

      {/* Sports Hub */}
      {activeView === 'sports' && (
        <SportsHub
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
          previewEnabled={true}
          onTogglePreview={() => {}}
        />
      )}

      {/* TV Calendar */}
      {activeView === 'calendar' && (
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
              handlePlayChannel(channel);
            }
          }}
        />
      )}

      {/* Watchlist Notifications */}
      <WatchlistNotificationContainer
        notifications={watchlistNotifications}
        onSwitch={handleWatchlistSwitchWrapper}
        onDismiss={handleWatchlistDismiss}
      />

      {/* Update Modal */}
      <UpdateModal
        isOpen={updateModalOpen}
        onClose={() => setUpdateModalOpen(false)}
      />
    </div>
  );
}

export default App;
