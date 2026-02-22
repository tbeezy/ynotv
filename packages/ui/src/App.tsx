import { useState, useEffect, useCallback, useRef } from 'react';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './services/tauri-bridge'; // Initialize Tauri bridge and polyfills
import type { ShortcutsMap, ShortcutAction } from './types/app';
import { Settings } from './components/Settings';
import { Sidebar, type View } from './components/Sidebar';
import { NowPlayingBar } from './components/NowPlayingBar';
import { TrackSelectionModal } from './components/TrackSelectionModal';
import { CategoryStrip } from './components/CategoryStrip';
import { ChannelPanel } from './components/ChannelPanel';
import { MoviesPage } from './components/MoviesPage';
import { SeriesPage } from './components/SeriesPage';
import { DvrDashboard } from './components/DvrDashboard';
import { SportsHub } from './components/sports/SportsHub';
import { useActiveRecordings } from './hooks/useActiveRecordings';
import { RecordingIndicator } from './components/RecordingIndicator';
import { Logo } from './components/Logo';
import { useSelectedCategory, useChannelSearch, useProgramSearch } from './hooks/useChannels';
import {
  useChannelSyncing,
  useVodSyncing,
  useTmdbMatching,
  useSetChannelSyncing,
  useSetVodSyncing,
  useSetChannelSortOrder,
  useSyncStatusMessage,
  useSetSyncStatusMessage
} from './stores/uiStore';
import { bulkOps } from './services/bulk-ops';
import type { StoredChannel, WatchlistItem } from './db';
import { getWatchlist, db } from './db';
import type { VodPlayInfo } from './types/media';
import { StalkerClient } from '@ynotv/local-adapter';
import { VideoErrorOverlay } from './components/VideoErrorOverlay';
import { Bridge } from './services/tauri-bridge';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { addToRecentChannels } from './utils/recentChannels';
import type { ThemeId } from './types/app';
import { WatchlistNotificationContainer, type WatchlistNotificationItem } from './components/WatchlistNotification';
import { useLayoutPersistence } from './hooks/useLayoutPersistence';
import { MultiviewLayout } from './components/MultiviewLayout/MultiviewLayout';
import { LayoutPicker } from './components/LayoutPicker/LayoutPicker';
import type { LayoutMode, SavedLayoutState } from './hooks/useLayoutPersistence';
import './themes.css';
import { DEFAULT_SHORTCUTS } from './constants/shortcuts';
import { useMpvListeners } from './hooks/useMpvListeners';
import { useAutoSync } from './hooks/useAutoSync';

// Helper to check stream status if mpv fails

// Auto-hide controls after this many milliseconds of inactivity
const CONTROLS_AUTO_HIDE_MS = 3000;



// Debug logging helper for UI playback
function debugLog(message: string, category = 'play'): void {
  // Check if debug logging is enabled via global flag
  if (!(window as any).__debugLoggingEnabled) {
    return;
  }
  const logMsg = `[${category}] ${message}`;
  console.log(logMsg);
  if (window.debug?.logFromRenderer) {
    window.debug.logFromRenderer(logMsg).catch(() => { });
  }
}

/**
 * Generate fallback stream URLs when primary fails.
 * Live TV: .ts → .m3u8 → .m3u
 * VOD: provider extension → .m3u8 → .ts
 */
function getStreamFallbacks(url: string, isLive: boolean): string[] {
  try {
    // Parse URL properly to preserve query params (often used for auth tokens)
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;

    const extMatch = pathname.match(/\.([a-z0-9]+)$/i);
    if (!extMatch) return []; // No extension, can't generate fallbacks

    const currentExt = extMatch[1].toLowerCase();
    const basePathname = pathname.slice(0, -currentExt.length - 1);

    const generateUrl = (ext: string): string => {
      const newUrl = new URL(url);
      newUrl.pathname = `${basePathname}.${ext}`;
      return newUrl.toString();
    };

    if (isLive) {
      // Live TV fallback order: .ts → .m3u8 → .m3u
      const fallbacks: string[] = [];
      if (currentExt !== 'm3u8') fallbacks.push(generateUrl('m3u8'));
      if (currentExt !== 'm3u') fallbacks.push(generateUrl('m3u'));
      return fallbacks;
    } else {
      // VOD fallback order: provider ext → .m3u8 → .ts
      const fallbacks: string[] = [];
      if (currentExt !== 'm3u8') fallbacks.push(generateUrl('m3u8'));
      if (currentExt !== 'ts') fallbacks.push(generateUrl('ts'));
      return fallbacks;
    }
  } catch {
    // Invalid URL, can't generate fallbacks
    return [];
  }
}

/**
 * Try loading a stream URL with fallbacks on failure.
 * Returns the successful URL or null if all failed.
 */
async function tryLoadWithFallbacks(
  primaryUrl: string,
  isLive: boolean,
  userAgent?: string,
  onError?: (msg: string) => void
): Promise<{ success: boolean; url: string; error?: string }> {
  debugLog(`Attempting to load: ${primaryUrl} (isLive: ${isLive})`);

  if (userAgent) {
    try {
      await Bridge.setProperty('user-agent', userAgent);
    } catch (e) {
      console.warn('Failed to set user-agent:', e);
    }
  }

  // 1. Force Play FIRST (User Request)
  // We launch MPV immediately. If it works, great.
  const result = await Bridge.loadVideo(primaryUrl);



  if (result.success) {
    debugLog(`Primary URL loaded successfully`);
    return { success: true, url: primaryUrl };
  }

  const errorMsg = (result as any).error || 'Unknown error';
  debugLog(`Primary URL failed: ${errorMsg}`);

  // Try fallbacks
  const fallbacks = getStreamFallbacks(primaryUrl, isLive);
  debugLog(`Trying ${fallbacks.length} fallback URLs...`);
  for (const fallbackUrl of fallbacks) {
    debugLog(`Trying fallback: ${fallbackUrl}`);
    const fallbackResult = await Bridge.loadVideo(fallbackUrl);
    if (fallbackResult.success) {
      debugLog(`Fallback succeeded: ${fallbackUrl}`);
      return { success: true, url: fallbackUrl };
    }
    debugLog(`Fallback failed: ${(fallbackResult as any).error}`);
  }

  // All failed - return original error
  debugLog(`All URLs failed, returning error: ${errorMsg}`);
  return { success: false, url: primaryUrl, error: errorMsg };
}

function App() {
  // Layout persistence state - must be declared before useEffect that uses them
  const [rememberLastChannels, setRememberLastChannels] = useState(false);
  const [savedLayoutState, setSavedLayoutState] = useState<SavedLayoutState | null>(null);
  const [layoutSettingsLoaded, setLayoutSettingsLoaded] = useState(false);

  // Load layout persistence settings on mount
  useEffect(() => {
    const loadLayoutSettings = async () => {
      if (!window.storage) {
        setLayoutSettingsLoaded(true);
        return;
      }

      try {
        // Try Tauri storage first
        const result = await window.storage.getSettings();

        // Also check localStorage for saved layout state (saved on app close)
        let localStorageState: SavedLayoutState | null = null;
        try {
          const localData = localStorage.getItem('app-settings');
          if (localData) {
            const parsed = JSON.parse(localData);
            localStorageState = parsed.savedLayoutState ?? null;
          }
        } catch (e) {
          console.warn('[App] Failed to read from localStorage:', e);
        }

        // Use the most recent state (prefer localStorage for layout state since it's saved on close)
        if (result.data) {
          setRememberLastChannels(result.data.rememberLastChannels ?? false);

          // Use localStorage state if available (more recent), otherwise use Tauri storage
          const layoutState = localStorageState || result.data.savedLayoutState || null;
          setSavedLayoutState(layoutState);
          console.log('[App] Loaded saved layout state:', layoutState);
        } else if (localStorageState) {
          // Fallback to localStorage if Tauri storage is empty
          setSavedLayoutState(localStorageState);
          console.log('[App] Loaded saved layout state from localStorage:', localStorageState);
        }
      } catch (e) {
        console.error('[App] Failed to load layout settings:', e);
      }
      setLayoutSettingsLoaded(true);
    };
    loadLayoutSettings();
  }, []);

  // ── MPV state (via extracted hook) - MUST be before multiview to get mpvReady ───────────────────────────────────────
  const syncMpvGeometryRef = useRef<() => Promise<void>>(async () => { });
  const [mpvReadyState, setMpvReadyState] = useState(false);

  const mpv = useMpvListeners({
    onReady: () => {
      setMpvReadyState(true);
      syncMpvGeometryRef.current();
    },
  });
  const {
    mpvReady, playing, volume, muted, position, duration, error,
    volumeDraggingRef, seekingRef,
    setError, setPlaying, setPosition, setVolume,
  } = mpv;

  // Ref for the restore callback (avoid circular dependency)
  const onLoadMainChannelRef = useRef<(name: string, url: string) => void>(() => { });

  // Multiview with persistence
  const multiview = useLayoutPersistence({
    enabled: rememberLastChannels,
    initialSavedState: savedLayoutState,
    settingsLoaded: layoutSettingsLoaded,
    mpvReady: mpvReadyState,
    onLoadMainChannel: (name, url) => onLoadMainChannelRef.current(name, url),
  });

  // Update the ref so onReady can call the latest syncMpvGeometry
  useEffect(() => {
    syncMpvGeometryRef.current = () => multiview.syncMpvGeometry();
  }, [multiview]);

  // Set up the restore callback now that multiview is initialized
  onLoadMainChannelRef.current = (channelName: string, channelUrl: string) => {
    // Create a minimal channel object for UI state
    const restoredChannel: StoredChannel = {
      stream_id: `restored_${Date.now()}`,
      source_id: 'restored',
      name: channelName,
      direct_url: channelUrl,
      stream_icon: '',
      epg_channel_id: '',
      category_ids: [],
    };

    // Load the stream directly
    invoke('mpv_load', { url: channelUrl }).catch((e) =>
      console.warn('[App] Failed to restore main channel:', e)
    );

    // Set UI state
    setCurrentChannel(restoredChannel);
    setPlaying(true);
    setActiveView('none');

    // Also notify multiview so swap logic works
    multiview.notifyMainLoaded(channelName, channelUrl);
  };

  const [currentChannel, setCurrentChannel] = useState<StoredChannel | null>(null);
  const [vodInfo, setVodInfo] = useState<VodPlayInfo | null>(null);

  // Debug: Log error state changes
  useEffect(() => {
    if (error) {
      console.log('[(Renderer) Error State Changed]', error);
    }
  }, [error]);

  // Multiview state
  const multiviewLayoutRef = useRef<LayoutMode>('main');
  const switchLayoutRef = useRef(multiview.switchLayout);
  useEffect(() => { multiviewLayoutRef.current = multiview.layout; }, [multiview.layout]);
  useEffect(() => { switchLayoutRef.current = multiview.switchLayout; }, [multiview.switchLayout]);

  const [showControls, setShowControls] = useState(true);
  const [lastActivity, setLastActivity] = useState(Date.now());
  const [activeView, setActiveView] = useState<View>('none');
  const [sportsPreviewEnabled, setSportsPreviewEnabled] = useState(true);

  // Tab Mode: enter when EPG, Sports, or DVR opens; exit when they close
  useEffect(() => {
    if (activeView === 'guide' || activeView === 'sports' || activeView === 'dvr' || activeView === 'settings') {
      multiview.enterTabMode(activeView);
    } else {
      multiview.exitTabMode();
    }
  }, [activeView, multiview]);

  // Sports Preview Pane Geometry Sync
  useEffect(() => {
    let observer: ResizeObserver;
    let fallbackTimer: ReturnType<typeof setTimeout>;

    if (activeView === 'sports' && sportsPreviewEnabled) {
      const syncPane = async (pane: Element) => {
        const rect = pane.getBoundingClientRect();
        // Don't sync if the pane hasn't actually rendered a size yet
        if (rect.width === 0 || rect.height === 0) return;

        const d = window.devicePixelRatio || 1;
        const { invoke } = await import('@tauri-apps/api/core');
        try {
          await invoke('mpv_set_geometry', {
            x: Math.round(rect.left * d),
            y: Math.round(rect.top * d),
            width: Math.round(rect.width * d),
            height: Math.round(rect.height * d),
          });
          const { Bridge } = await import('./services/tauri-bridge');
          await Bridge.setProperty('video-zoom', 0);
          await Bridge.setProperty('video-align-x', 0);
          await Bridge.setProperty('video-align-y', 0);
        } catch (e) {
          console.warn('[SportsPreview] Geometry Sync Failed', e);
        }
      };

      // Mutation observer to catch the element as soon as React mounts it
      const mutObserver = new MutationObserver(() => {
        const pane = document.querySelector('.sports-preview-pane');
        if (pane) {
          mutObserver.disconnect();
          syncPane(pane);
          observer = new ResizeObserver(() => syncPane(pane));
          observer.observe(pane);
        }
      });

      mutObserver.observe(document.body, { childList: true, subtree: true });

      // Fallback in case it's already in the DOM somehow
      fallbackTimer = setTimeout(() => {
        const pane = document.querySelector('.sports-preview-pane');
        if (pane) {
          mutObserver.disconnect();
          syncPane(pane);
          if (!observer) {
            observer = new ResizeObserver(() => syncPane(pane));
            observer.observe(pane);
          }
        }
      }, 100);

      const onResize = () => {
        const pane = document.querySelector('.sports-preview-pane');
        if (pane) syncPane(pane);
      };

      window.addEventListener('resize', onResize);
      return () => {
        window.removeEventListener('resize', onResize);
        mutObserver.disconnect();
        if (observer) observer.disconnect();
        clearTimeout(fallbackTimer);
        // Release the geometry lock so Live TV / Guide Software Scaling can start from a clean 100% natively
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('mpv_set_geometry', { x: 0, y: 0, width: 0, height: 0 }).catch(() => { });
        });
      };
    } else if (activeView === 'sports' && !sportsPreviewEnabled) {
      // If toggled off while sports is still open, force the video completely offscreen
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('mpv_set_geometry', { x: -10000, y: -10000, width: 1, height: 1 }).catch(() => { });
      });
      return () => {
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('mpv_set_geometry', { x: 0, y: 0, width: 0, height: 0 }).catch(() => { });
        });
      };
    }
  }, [activeView, sportsPreviewEnabled]);

  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false); // Default to hidden

  // Channel/category state (persisted)
  const { categoryId, setCategoryId, loading: categoryLoading } = useSelectedCategory();

  // Active recordings for title bar indicator
  const { recordings: activeRecordings, isRecording: hasActiveRecording } = useActiveRecordings(5000);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [isSearchMode, setIsSearchMode] = useState(false);

  // Watchlist state
  const [isWatchlistMode, setIsWatchlistMode] = useState(false);
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([]);
  const [watchlistRefreshTrigger, setWatchlistRefreshTrigger] = useState(0);

  // Watchlist notifications state
  const [watchlistNotifications, setWatchlistNotifications] = useState<WatchlistNotificationItem[]>([]);

  // Debounce search query for performance
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
      setIsSearchMode(searchQuery.length >= 2);
    }, 150); // 150ms debounce for smooth typing
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch search results
  const searchChannels = useChannelSearch(debouncedSearchQuery, 200);
  const searchPrograms = useProgramSearch(debouncedSearchQuery, 200);

  // Fetch watchlist when in watchlist mode or when refresh is triggered
  useEffect(() => {
    if (isWatchlistMode) {
      const loadWatchlist = async () => {
        const { getWatchlist } = await import('./db');
        const items = await getWatchlist();
        setWatchlistItems(items);
      };
      loadWatchlist();
    } else {
      setWatchlistItems([]);
    }
  }, [isWatchlistMode, watchlistRefreshTrigger]);

  // Handle watchlist notification switch
  const handleWatchlistSwitch = useCallback(async (notification: WatchlistNotificationItem) => {
    try {
      const channel = await db.channels.get(notification.channelId);
      if (channel) {
        handlePlayChannel(channel);
      }
    } catch (error) {
      console.error('Failed to switch to watchlist channel:', error);
    }
  }, []);

  // Handle watchlist notification dismiss
  const handleWatchlistDismiss = useCallback((id: number) => {
    setWatchlistNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  // Global sync state (from Settings)
  const channelSyncing = useChannelSyncing();
  const vodSyncing = useVodSyncing();
  const tmdbMatching = useTmdbMatching();
  const setChannelSyncing = useSetChannelSyncing();
  const setVodSyncing = useSetVodSyncing();
  const setChannelSortOrder = useSetChannelSortOrder();
  const syncStatusMessage = useSyncStatusMessage();
  const setSyncStatusMessage = useSetSyncStatusMessage();

  const [shortcuts, setShortcuts] = useState<ShortcutsMap>({});

  // Theme state
  const [theme, setTheme] = useState<ThemeId>('glass-neon');

  // Apply theme effect
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const playingRef = useRef(playing);
  const positionRef = useRef(position);
  const shortcutsRef = useRef(shortcuts);
  const activeViewRef = useRef(activeView);
  const categoriesOpenRef = useRef(categoriesOpen);

  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => { shortcutsRef.current = shortcuts; }, [shortcuts]);
  useEffect(() => { activeViewRef.current = activeView; }, [activeView]);
  useEffect(() => { categoriesOpenRef.current = categoriesOpen; }, [categoriesOpen]);

  const currentChannelRef = useRef(currentChannel);
  useEffect(() => { currentChannelRef.current = currentChannel; }, [currentChannel]);

  // Ref for title bar search input
  const titleBarSearchRef = useRef<HTMLInputElement>(null);


  // Initialize window size on startup
  useEffect(() => {
    const initWindowSize = async () => {
      try {
        const stored = localStorage.getItem('app-settings');
        if (stored) {
          const settings = JSON.parse(stored);
          const width = settings.startupWidth || 1920;
          const height = settings.startupHeight || 1080;

          // Apply startup size immediately
          try {
            const appWindow = getCurrentWindow();

            // If maximized, unmaximize first
            const isMaximized = await appWindow.isMaximized();
            if (isMaximized) {
              await appWindow.unmaximize();
            }

            await appWindow.setSize(new LogicalSize(width, height));
            await appWindow.center();
          } catch (innerErr) {
            console.error('[App] Resize error:', innerErr);
          }
        }
      } catch (err) {
        console.error('[App] Failed to resize window on startup:', err);
      }
    };

    initWindowSize();
  }, []);

  // Initialize DVR on app load
  useEffect(() => {
    const initDvr = async () => {
      try {
        console.log('[App] Initializing DVR...');
        await invoke('init_dvr');
        console.log('[App] DVR initialized');
      } catch (error) {
        console.error('[App] Failed to initialize DVR:', error);
      }
    };

    initDvr();
  }, []);

  // Listen for DVR events
  useEffect(() => {
    const setupDvrListener = async () => {
      try {
        const unlisten = await listen('dvr:event', (event) => {
          const data = event.payload as {
            event_type: string;
            schedule_id: number;
            recording_id?: number;
            channel_name: string;
            program_title: string;
            message?: string;
          };
          console.log('[DVR Event]', data.event_type, data);

          // Show toast notification for recording events
          if (data.event_type === 'started') {
            console.log(`[DVR] Started recording: ${data.program_title}`);
          } else if (data.event_type === 'completed') {
            console.log(`[DVR] Completed recording: ${data.program_title}`);
          } else if (data.event_type === 'failed') {
            console.error(`[DVR] Failed recording: ${data.program_title}`, data.message);
          }
        });

        return unlisten;
      } catch (error) {
        console.error('[App] Failed to setup DVR listener:', error);
      }
    };

    let unlistenFn: (() => void) | undefined;
    setupDvrListener().then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

  // Listen for DVR URL resolution requests (always active, even when not on player page)
  useEffect(() => {
    const setupUrlResolver = async () => {
      try {
        const unlisten = await listen('dvr:resolve_url_now', async (event: any) => {
          const { schedule_id, channel_id, source_id } = event.payload;
          console.log('[DVR URL Resolver] Received request for schedule:', schedule_id, 'channel:', channel_id, 'source:', source_id);

          try {
            // Get channel info from database
            const { db } = await import('./db');
            const channel = await db.channels.get(channel_id);
            console.log('[DVR URL Resolver] Found channel:', channel?.name, 'direct_url:', channel?.direct_url);

            if (!channel?.direct_url?.startsWith('stalker_')) {
              console.log('[DVR URL Resolver] Not a Stalker channel, skipping');
              return;
            }

            // Get source config
            if (!window.storage) {
              console.error('[DVR URL Resolver] Storage API not available');
              return;
            }

            const sourceRes = await window.storage.getSource(source_id);
            console.log('[DVR URL Resolver] Source type:', sourceRes.data?.type, 'has MAC:', !!sourceRes.data?.mac);

            if (sourceRes.data?.type !== 'stalker' || !sourceRes.data.mac) {
              console.error('[DVR URL Resolver] Stalker source not found or missing MAC');
              return;
            }

            // Resolve URL immediately
            console.log('[DVR URL Resolver] Resolving Stalker URL...');
            const client = new StalkerClient({
              baseUrl: sourceRes.data.url,
              mac: sourceRes.data.mac,
              userAgent: sourceRes.data.user_agent
            }, source_id);

            const resolvedUrl = await client.resolveStreamUrl(channel.direct_url);
            console.log('[DVR URL Resolver] Resolved to:', resolvedUrl);

            // Update the schedule with the resolved URL
            console.log('[DVR URL Resolver] Updating database...');
            await invoke('update_dvr_stream_url', {
              scheduleId: schedule_id,
              streamUrl: resolvedUrl
            });
            console.log('[DVR URL Resolver] URL updated successfully for schedule:', schedule_id);
          } catch (error) {
            console.error('[DVR URL Resolver] Failed to resolve URL:', error);
          }
        });

        return unlisten;
      } catch (error) {
        console.error('[App] Failed to setup URL resolver listener:', error);
      }
    };

    let unlistenFn: (() => void) | undefined;
    setupUrlResolver().then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

  // Track if mouse is hovering over controls (prevents auto-hide)
  const controlsHoveredRef = useRef(false);

  // Auto-hide controls after 3 seconds of no activity
  useEffect(() => {
    // Don't auto-hide if not playing or if panels are open
    if (!playing || activeView !== 'none' || categoriesOpen) return;

    const timer = setTimeout(() => {
      // Don't hide if mouse is hovering over controls
      if (!controlsHoveredRef.current) {
        setShowControls(false);
      }
    }, CONTROLS_AUTO_HIDE_MS);

    return () => clearTimeout(timer);
  }, [lastActivity, playing, activeView, categoriesOpen]);

  // Show controls on mouse move and reset hide timer
  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    setLastActivity(Date.now()); // Always new value = resets timer
  }, []);

  // Play a recording file in MPV
  const handlePlayRecording = async (recording: import('./db').DvrRecording) => {
    console.log('[App] handlePlayRecording called with:', recording.file_path);
    debugLog(`handlePlayRecording: ${recording.file_path}`);
    setError(null);

    try {
      // Use file:// protocol for local files
      const url = recording.file_path.startsWith('file://') ? recording.file_path : `file://${recording.file_path}`;
      const result = await Bridge.loadVideo(url);

      if (result.success) {
        debugLog('Recording playback started');
        // Set current channel so NowPlayingBar shows full controls
        setCurrentChannel({
          stream_id: `recording_${recording.id}`,
          name: recording.program_title,
          stream_icon: '',
          epg_channel_id: '',
          category_ids: [],
          direct_url: url,
          source_id: 'dvr',
        });
        setVodInfo({
          title: recording.program_title,
          url: url,
          type: 'recording',
          source_id: 'dvr',
        });
        setPlaying(true);
        // Close DVR dashboard when playing
        setActiveView('none');
      } else {
        const errMsg = (result as any).error || 'Failed to load recording';
        debugLog(`Recording playback failed: ${errMsg}`, 'error');
        setError(errMsg);
      }
    } catch (error: any) {
      debugLog(`Recording playback error: ${error?.message}`, 'error');
      setError(error?.message || 'Failed to play recording');
    }
  };

  const handleLoadStream = async (channel: StoredChannel) => {
    debugLog(`handleLoadStream: ${channel.name} (${channel.stream_id})`);
    debugLog(`  URL: ${channel.direct_url}`);

    // Fetch source to get User Agent and Source Config for Stalker
    let userAgent: string | undefined;
    let sourceData: any | undefined;

    if (window.storage && channel.source_id) {
      try {
        const sourceRes = await window.storage.getSource(channel.source_id);
        if (sourceRes.data) {
          sourceData = sourceRes.data;
          if (sourceRes.data.user_agent) {
            userAgent = sourceRes.data.user_agent;
            debugLog(`  UserAgent: ${userAgent}`);
          }
        }
      } catch (e) {
        console.error('Failed to fetch source:', e);
      }
    }

    let playUrl = channel.direct_url;

    // Resolve Stalker URLs (stalker_ch:, stalker_vod:, /media/)
    if (sourceData?.type === 'stalker' && (
      playUrl.startsWith('stalker_') ||
      playUrl.startsWith('/media/')
    )) {
      try {
        debugLog(`Resolving Stalker URL: ${playUrl}`);
        const client = new StalkerClient({
          baseUrl: sourceData.url,
          mac: sourceData.mac || '',
          userAgent: sourceData.user_agent
        }, sourceData.id);

        playUrl = await client.resolveStreamUrl(playUrl);
        debugLog(`Resolved to: ${playUrl}`);
      } catch (e) {
        console.error('Stalker resolution failed:', e);
        setError('Failed to resolve Stalker link');
        return;
      }
    }

    setError(null);
    const result = await tryLoadWithFallbacks(
      playUrl,
      true, // isLive
      userAgent,
      (msg) => setError(msg) // Pass callback for background errors
    );
    if (!result.success) {
      const errMsg = result.error ?? 'Failed to load stream';
      console.error('[(Renderer) handleLoadStream] Load Failed:', errMsg);
      debugLog(`  FAILED: ${errMsg}`, 'error');
      console.log('[App] Setting error state:', errMsg);
      setError(errMsg);
    } else {
      debugLog(`  SUCCESS: playing`);
      // Update channel with working URL if fallback was used
      const resolvedChannel = result.url !== playUrl
        ? { ...channel, direct_url: result.url }
        : channel;
      setCurrentChannel(resolvedChannel);
      setPlaying(true);
      // Notify multiview hook what's now in MPV (needed for swap logic)
      multiview.notifyMainLoaded(channel.name, result.url);

      // Capture video metadata after successful load
      import('./services/video-metadata').then(({ captureAndSaveMetadata }) => {
        captureAndSaveMetadata(channel.stream_id, channel.source_id).catch(console.error);
      });
    }
  };



  const handleTogglePlay = async () => {
    // Toggle based on current state (Ref ensures fresh state in callbacks)
    if (playingRef.current) {
      await Bridge.pause();
    } else {
      await Bridge.resume();
    }
  };


  const handleVolumeChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseInt(e.target.value);
    setVolume(newVolume);
    await Bridge.setVolume(newVolume);
  };

  const handleToggleMute = async () => {
    await Bridge.toggleMute();
    // UI state updated via mpv status callback
  };

  const handleStop = async () => {
    debugLog('handleStop called');
    await Bridge.stop();
    debugLog('handleStop: Bridge.stop() completed');
    setPlaying(false);
    setCurrentChannel(null);
  };

  const handleSeek = async (seconds: number) => {
    seekingRef.current = true;
    setPosition(seconds); // Optimistic update
    await Bridge.seek(seconds);
    // Brief delay before accepting mpv updates again
    setTimeout(() => { seekingRef.current = false; }, 200);
  };

  const handleCycleSubtitle = async () => {
    await Bridge.cycleSubtitle();
  };

  const handleCycleAudio = async () => {
    await Bridge.cycleAudio();
  };

  const handleToggleStats = async () => {
    // Toggle MPV's built-in stats overlay
    await Bridge.toggleStats();
  };

  const handleToggleFullscreen = async () => {
    console.log('[App] Toggle fullscreen called');
    try {
      await Bridge.toggleFullscreen();
    } catch (e) {
      console.error('[App] Fullscreen error:', e);
    }
  };

  // Modal state for track selection
  const [showSubtitleModal, setShowSubtitleModal] = useState(false);
  const [showAudioModal, setShowAudioModal] = useState(false);

  const handleShowSubtitleModal = () => {
    setShowSubtitleModal(true);
  };

  const handleShowAudioModal = () => {
    setShowAudioModal(true);
  };

  // Play a channel
  const handlePlayChannel = (channel: StoredChannel) => {
    // Add to recently viewed
    addToRecentChannels(channel);
    handleLoadStream(channel);
  };

  // Background timer for watchlist reminders and autoswitch
  useEffect(() => {
    const checkWatchlist = async () => {
      // Clear expired items first (programs that have ended)
      const { clearExpiredWatchlist } = await import('./db');
      await clearExpiredWatchlist();

      const now = Date.now();
      const { getWatchlist } = await import('./db');
      const items = await getWatchlist();

      for (const item of items) {
        const startTime = item.start_time;
        const reminderTime = startTime - (item.reminder_minutes * 60 * 1000);

        // Check if reminder should be shown
        if (item.reminder_enabled && !item.reminder_shown && now >= reminderTime && now < startTime + 30000) {
          console.log('[Watchlist] Reminder:', item.program_title);
          const notification: WatchlistNotificationItem = {
            id: Date.now() + (item.id || 0),
            watchlistId: item.id || 0,
            programTitle: item.program_title,
            channelName: item.channel_name,
            channelId: item.channel_id,
            sourceId: item.source_id,
            startTime: item.start_time,
            type: 'reminder',
          };
          setWatchlistNotifications(prev => [...prev, notification]);

          const { markReminderShown } = await import('./db');
          await markReminderShown(item.id!);
        }

        // Check if autoswitch should trigger (respecting autoswitch_seconds_before setting)
        const secondsBefore = item.autoswitch_seconds_before ?? 0;
        const autoswitchTime = startTime - (secondsBefore * 1000);
        if (item.autoswitch_enabled && !item.autoswitch_triggered && now >= autoswitchTime && now < startTime + 60000) {
          console.log('[Watchlist] Auto-switching to:', item.program_title, `( ${secondsBefore}s before start)`);

          try {
            const channel = await db.channels.get(item.channel_id);
            if (channel) {
              // Auto-switch without calling handlePlayChannel (to avoid dependency issues)
              addToRecentChannels(channel);
              handleLoadStream(channel);

              const notification: WatchlistNotificationItem = {
                id: Date.now() + (item.id || 0) + 1000,
                watchlistId: item.id || 0,
                programTitle: item.program_title,
                channelName: item.channel_name,
                channelId: item.channel_id,
                sourceId: item.source_id,
                startTime: item.start_time,
                type: 'autoswitch',
              };
              setWatchlistNotifications(prev => [...prev, notification]);
            }
          } catch (error) {
            console.error('[Watchlist] Auto-switch failed:', error);
          }

          const { markAutoswitchTriggered } = await import('./db');
          await markAutoswitchTriggered(item.id!);
        }
      }
    };

    checkWatchlist();
    const interval = setInterval(checkWatchlist, 10000);
    return () => clearInterval(interval);
  }, []); // Empty dependency array - runs once on mount

  // Play VOD content (movies/series)
  const handlePlayVod = async (info: VodPlayInfo) => {
    debugLog(`handlePlayVod: ${info.title} (${info.type})`);
    debugLog(`  URL: ${info.url}`);

    setError(null);

    // RESOLVE URL for Stalker Sources
    let urlToPlay = info.url;
    let userAgent: string | undefined;

    if (window.storage && info.source_id) {
      try {
        const sourceRes = await window.storage.getSource(info.source_id);
        const source = sourceRes.data;
        if (source) {
          userAgent = source.user_agent;
          if (userAgent) debugLog(`  UserAgent: ${userAgent}`);

          if (source.type === 'stalker') {
            debugLog(`Stalker Source detected, resolving URL for cmd: ${urlToPlay}`);
            const { StalkerClient } = await import('@ynotv/local-adapter');

            const client = new StalkerClient({
              baseUrl: source.url,
              mac: source.mac || '',
              userAgent: source.user_agent
            }, source.id);

            urlToPlay = await client.resolveStreamUrl(urlToPlay);
            debugLog(`Resolved Stalker URL: ${urlToPlay}`);
          }
        }
      } catch (err) {
        console.error('Failed to resolve Source info:', err);
      }
    }

    const result = await tryLoadWithFallbacks(urlToPlay, false, userAgent);
    if (!result.success) {
      debugLog(`  FAILED: ${result.error}`);
      setError(result.error ?? 'Failed to load stream');
    } else {
      debugLog(`  SUCCESS: playing`);
      // Create a pseudo-channel for the now playing bar
      const workingUrl = result.url;
      setCurrentChannel({
        stream_id: 'vod',
        name: info.title,
        stream_icon: '',
        epg_channel_id: '',
        category_ids: [],
        direct_url: workingUrl,
        source_id: 'vod',
      });
      setVodInfo({ ...info, url: workingUrl });
      setPlaying(true);
      // Close VOD pages when playing
      setActiveView('none');
    }
  };

  // Handle category selection - opens guide if closed
  const handleSelectCategory = (catId: string | null) => {
    setCategoryId(catId);

    // Handle special categories
    if (catId === '__watchlist__') {
      setIsWatchlistMode(true);
      setIsSearchMode(false);
      setSearchQuery('');
    } else {
      setIsWatchlistMode(false);
    }

    // Open guide if it's not already open
    if (activeView !== 'guide') {
      setActiveView('guide');
    }
  };

  // ── Auto-sync on startup (via extracted hook) ────────────────────────────
  useAutoSync({
    onShortcutsLoaded: (s) => setShortcuts(s as ShortcutsMap),
    onThemeLoaded: (t) => setTheme(t as ThemeId),
    onSidebarVisibilityLoaded: (v) => setShowSidebar(v),
    onFontSizeLoaded: (ch, cat) => {
      if (ch) document.documentElement.style.setProperty('--channel-font-size', `${ch}px`);
      if (cat) document.documentElement.style.setProperty('--category-font-size', `${cat}px`);
    },
  });

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      const currentShortcuts = shortcutsRef.current;

      // Helper to match keys case-insensitively for letters, but sensitive for others if needed
      const matches = (action: ShortcutAction, eventKey: string) => {
        const storedKey = currentShortcuts[action] || DEFAULT_SHORTCUTS[action];
        if (!storedKey) return false;

        // precise match first
        if (eventKey === storedKey) return true;

        // case-insensitive match for single letters
        if (eventKey.length === 1 && storedKey.length === 1) {
          return eventKey.toLowerCase() === storedKey.toLowerCase();
        }

        return false;
      };

      if (matches('togglePlay', e.key)) {
        e.preventDefault();
        handleTogglePlay();
      } else if (matches('toggleMute', e.key)) {
        handleToggleMute();
      } else if (matches('toggleStats', e.key)) {
        e.preventDefault();
        handleToggleStats();
      } else if (matches('toggleFullscreen', e.key)) {
        e.preventDefault();
        handleToggleFullscreen();
      } else if (matches('selectSubtitle', e.key)) {
        e.preventDefault();
        handleShowSubtitleModal();
      } else if (matches('selectAudio', e.key)) {
        e.preventDefault();
        handleShowAudioModal();
      } else if (matches('toggleGuide', e.key)) {
        // Toggle guide
        setActiveView((v) => (v === 'guide' ? 'none' : 'guide'));
      } else if (matches('toggleCategories', e.key)) {
        // Toggle categories
        setCategoriesOpen((open) => !open);
      } else if (matches('toggleLiveTV', e.key)) {
        e.preventDefault();
        // Toggle both Guide and Categories simultaneously
        // Use refs to get fresh state in event listener
        const currentActiveView = activeViewRef.current;
        const currentCategoriesOpen = categoriesOpenRef.current;

        // Always show controls when using Live TV hotkey
        setShowControls(true);

        const newLiveTVState = !(currentActiveView === 'guide' && currentCategoriesOpen);
        if (newLiveTVState) {
          setActiveView('guide');
          setCategoriesOpen(true);
        } else {
          setActiveView('none');
          setCategoriesOpen(false);
        }
      } else if (matches('toggleSettings', e.key)) {
        e.preventDefault();
        // Toggle Settings
        const currentActiveView = activeViewRef.current;
        setActiveView(currentActiveView === 'settings' ? 'none' : 'settings');
      } else if (matches('toggleSports', e.key)) {
        e.preventDefault();
        // Toggle Sports
        const currentActiveView = activeViewRef.current;
        setCategoriesOpen(false);
        setActiveView(currentActiveView === 'sports' ? 'none' : 'sports');
      } else if (matches('toggleDvr', e.key)) {
        e.preventDefault();
        // Toggle DVR
        const currentActiveView = activeViewRef.current;
        setCategoriesOpen(false);
        setActiveView(currentActiveView === 'dvr' ? 'none' : 'dvr');
      } else if (matches('focusSearch', e.key)) {
        e.preventDefault();
        // Always show controls when using Search hotkey
        setShowControls(true);
        // Open guide if not open
        if (activeViewRef.current !== 'guide') {
          setActiveView('guide');
        }
        // Open categories panel
        setCategoriesOpen(true);
        // Focus title bar search input
        if (titleBarSearchRef.current) {
          titleBarSearchRef.current.focus();
        }
      } else if (matches('close', e.key)) {
        setActiveView('none');
        setCategoriesOpen(false);
        setSidebarExpanded(false);
        setShowControls(false);
      } else if (matches('seekForward', e.key)) {
        e.preventDefault();
        handleSeek(positionRef.current + 10);
      } else if (matches('seekBackward', e.key)) {
        e.preventDefault();
        handleSeek(positionRef.current - 10);
      } else if (matches('layoutMain', e.key)) {
        e.preventDefault();
        if (switchLayoutRef.current) switchLayoutRef.current('main');
      } else if (matches('layoutPip', e.key)) {
        e.preventDefault();
        if (switchLayoutRef.current) switchLayoutRef.current('pip');
      } else if (matches('layoutBigBottom', e.key)) {
        e.preventDefault();
        if (switchLayoutRef.current) switchLayoutRef.current('bigbottom');
      } else if (matches('layout2x2', e.key)) {
        e.preventDefault();
        if (switchLayoutRef.current) switchLayoutRef.current('2x2');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []); // Empty dependency array = attached once, uses refs for state


  // Window controls
  const handleMinimize = () => {
    Bridge.minimize();
  };

  const handleMaximize = () => {
    Bridge.toggleMaximize();
  };

  const handleClose = () => {
    Bridge.close();
  };
  return (
    <div className={`app${showControls ? '' : ' controls-hidden'}`} onMouseMove={handleMouseMove}>
      {/* Custom title bar for frameless window */}
      <div className={`title-bar${showControls ? ' visible' : ''}`} data-tauri-drag-region>
        <div className="title-bar-left-group" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Logo className="title-bar-logo" />
          <LayoutPicker
            currentLayout={multiview.layout}
            onSelect={multiview.switchLayout}
          />
        </div>

        {/* Spacer for left side */}
        <div className="title-bar-spacer"></div>

        {/* Center Section: Unified Navigation Bar */}
        <div className="title-bar-content">
          {/* Unified Control Bar with Segmented Buttons + Integrated Search */}
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

            {/* Divider between segmented buttons and search */}
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
                  // Auto-open categories and guide when searching
                  if (e.target.value.length >= 1) {
                    setCategoriesOpen(true);
                    if (activeView !== 'guide') {
                      setActiveView('guide');
                    }
                  }
                }}
                onFocus={() => {
                  // Auto-open guide when searching
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

        {/* Right Spacer to balance the left spacer */}
        <div className="title-bar-spacer" style={{ position: 'relative' }}>
          {/* Recording Indicator - shown when actively recording, positioned absolutely so it doesn't affect layout */}
          {hasActiveRecording && (
            <div className="title-bar-recording-indicator">
              <RecordingIndicator size="small" variant="recording" />
            </div>
          )}
        </div>


        {/* Settings Button */}
        <button
          className={`title-bar-settings-btn ${activeView === 'settings' ? 'active' : ''}`}
          onClick={() => {
            setCategoriesOpen(false);
            setActiveView(activeView === 'settings' ? 'none' : 'settings');
          }}
          title="Settings"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        </button>

        <div className="window-controls">
          <button onClick={handleMinimize} title="Minimize">
            ─
          </button>
          <button onClick={handleMaximize} title="Maximize">
            □
          </button>
          <button onClick={handleClose} className="close" title="Close">
            ✕
          </button>
        </div>
      </div>


      {/* Background - transparent over mpv */}
      <div className="video-background">
        {!currentChannel && !error && !multiview.isRestoring && (
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

        {/* Error Overlay for Fullscreen */}
        {error && activeView !== 'guide' && (
          <VideoErrorOverlay
            error={error}
            onDismiss={() => setError(null)}
          />
        )}
      </div>

      {/* Multiview HLS cell grid (rendered on top of MPV, which renders behind) */}
      {/* Hide when in tab mode (guide/sports/dvr/settings) so secondaries don't block preview */}
      {multiview.layout !== 'main' && activeView === 'none' && (
        <MultiviewLayout
          layout={multiview.layout}
          slots={multiview.slots}
          onSwapWithMain={(slotId) => multiview.swapWithMain(slotId, multiview.slots)}
          onStop={multiview.stopSlot}
          onSetProperty={multiview.setSlotProperty}
          onReposition={() => multiview.repositionSecondarySlots()}
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
      />

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

      {/* Sidebar Navigation - stays visible when any panel is open */}
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

      {/* Category Strip - slides out from sidebar */}
      <CategoryStrip
        selectedCategoryId={categoryId}
        onSelectCategory={(catId) => {
          // Exit search mode when selecting a category
          if (isSearchMode) {
            setSearchQuery('');
            setIsSearchMode(false);
          }
          // Exit watchlist mode when selecting a regular category
          if (catId !== '__watchlist__') {
            setIsWatchlistMode(false);
          }
          handleSelectCategory(catId);
        }}
        visible={categoriesOpen}
        sidebarExpanded={sidebarExpanded}
        showSidebar={showSidebar}
      />

      {/* Channel Panel - slides out (shifts right if categories open) */}
      <ChannelPanel
        categoryId={isSearchMode || isWatchlistMode ? null : categoryId}
        visible={activeView === 'guide'}
        categoryStripOpen={categoriesOpen}
        sidebarExpanded={sidebarExpanded}
        showSidebar={showSidebar}
        onPlayChannel={handlePlayChannel}
        onClose={() => {
          setActiveView('none');
          setCategoriesOpen(false);
          setSidebarExpanded(false);
          // Exit tab mode: restore multiview state if it was active
          multiview.exitTabMode();
          // EPG guard: only reset MPV geometry if multiview is NOT active
          // (if multiview is active, MPV stays in its grid quadrant)
          if (multiviewLayoutRef.current === 'main') {
            Bridge.syncWindow();
          }
        }}
        error={error}
        isSearchMode={isSearchMode}
        searchQuery={debouncedSearchQuery}
        searchChannels={searchChannels}
        searchPrograms={searchPrograms}
        isWatchlistMode={isWatchlistMode}
        watchlistItems={watchlistItems}
        onWatchlistRefresh={() => setWatchlistRefreshTrigger(v => v + 1)}
        currentLayout={multiview.layout}
        onSendToSlot={multiview.sendToSlot}
      />

      {/* Settings Panel */}
      {activeView === 'settings' && (
        <Settings
          onClose={() => setActiveView('none')}
          onShortcutsChange={setShortcuts}
          theme={theme}
          onThemeChange={setTheme}
        />
      )}

      {/* Movies Page */}
      {activeView === 'movies' && (
        <MoviesPage
          onPlay={handlePlayVod}
          onClose={() => setActiveView('none')}
        />
      )}

      {/* Series Page */}
      {activeView === 'series' && (
        <SeriesPage
          onPlay={handlePlayVod}
          onClose={() => setActiveView('none')}
        />
      )}

      {/* DVR Dashboard */}
      {activeView === 'dvr' && (
        <DvrDashboard
          onPlay={handlePlayRecording}
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
            // Focus the search input after the view transition
            setTimeout(() => {
              if (titleBarSearchRef.current) {
                titleBarSearchRef.current.focus();
              }
            }, 50);
          }}
          previewEnabled={sportsPreviewEnabled}
          onTogglePreview={() => setSportsPreviewEnabled(prev => !prev)}
        />
      )}

      {/* Watchlist Notifications */}
      <WatchlistNotificationContainer
        notifications={watchlistNotifications}
        onSwitch={handleWatchlistSwitch}
        onDismiss={handleWatchlistDismiss}
      />

    </div>
  );
}

export default App;
