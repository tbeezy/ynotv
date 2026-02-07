import { useState, useEffect, useCallback, useRef } from 'react';
import type { MpvStatus, ShortcutsMap, ShortcutAction } from './types/electron';
import { Settings } from './components/Settings';
import { Sidebar, type View } from './components/Sidebar';
import { NowPlayingBar } from './components/NowPlayingBar';
import { CategoryStrip } from './components/CategoryStrip';
import { ChannelPanel } from './components/ChannelPanel';
import { MoviesPage } from './components/MoviesPage';
import { SeriesPage } from './components/SeriesPage';
import { Logo } from './components/Logo';
import { useSelectedCategory } from './hooks/useChannels';
import { useChannelSyncing, useVodSyncing, useTmdbMatching, useSetChannelSyncing, useSetVodSyncing, useSetChannelSortOrder } from './stores/uiStore';
import { syncVodForSource, isVodStale, isEpgStale, syncSource, enrichSourceMetadata } from './db/sync';
import type { StoredChannel } from './db';
import type { VodPlayInfo } from './types/media';
import { StalkerClient } from '@sbtltv/local-adapter';
import { VideoErrorOverlay } from './components/VideoErrorOverlay';

// Helper to check stream status if mpv fails
async function checkStreamStatus(url: string, userAgent?: string): Promise<string | null> {
  if (!window.fetchProxy) return null;
  try {
    // Use GET with Range header to peek at the content without downloading full stream
    // This helps detect "soft" authentication errors where server returns 200 OK but an HTML login/error page
    const options: any = {
      method: 'GET',
      headers: {
        'Range': 'bytes=0-999',
        'Cache-Control': 'no-cache'
      }
    };

    if (userAgent) {
      options.headers['User-Agent'] = userAgent;
    }

    console.log('[checkStreamStatus] Checking:', url);
    const result = await window.fetchProxy.fetch(url, options);
    console.log('[checkStreamStatus] Result Status:', result.data?.status);

    if (!result.success) {
      return result.error || 'Network connection failed';
    }

    if (result.data) {
      // Hard HTTP errors
      if (result.data.status >= 400) {
        return `HTTP Error ${result.data.status}: ${result.data.statusText}`;
      }

      // "Soft" errors: Status is 200, but content is HTML (unauthorized page) instead of video
      const text = result.data.text || '';

      // Check for common error signatures in the first 1kb
      const isHtml = text.trim().toLowerCase().startsWith('<!doctype html') || text.trim().toLowerCase().startsWith('<html');

      if (isHtml) {
        // If it's HTML, it's likely NOT a video stream (unless it's an HLS master playlist, which is text, but usually starts with #EXTM3U)
        if (!text.includes('#EXTM3U')) {
          // It's HTML and not an M3U playlist -> Probable error page
          console.log('[checkStreamStatus] Detected HTML response for stream url:', text.substring(0, 100));

          if (text.includes('Forbidden') || text.includes('Unauthorized') || text.includes('Access denied') || text.includes('Error')) {
            return 'Stream Access Denied (Auth Failed)';
          }
          return 'Invalid Stream Format (HTML response)';
        }
      }
    }

    return null;
  } catch (e) {
    console.error('[checkStreamStatus] Exception:', e);
    return 'Connection failed';
  }
}

// Auto-hide controls after this many milliseconds of inactivity
const CONTROLS_AUTO_HIDE_MS = 3000;

const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  togglePlay: ' ',
  toggleMute: 'm',
  cycleSubtitle: 'j',
  cycleAudio: 'a',
  toggleStats: 'i',
  toggleGuide: 'g',
  toggleCategories: 'c',
  close: 'Escape',
  seekForward: 'ArrowRight',
  seekBackward: 'ArrowLeft'
};

// Debug logging helper for UI playback
function debugLog(message: string, category = 'play'): void {
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
  mpv: NonNullable<typeof window.mpv>,
  userAgent?: string
): Promise<{ success: boolean; url: string; error?: string }> {
  debugLog(`Attempting to load: ${primaryUrl} (isLive: ${isLive})`);
  const options = userAgent ? { userAgent } : undefined;

  // Try primary URL first
  const result = await mpv.load(primaryUrl, options);
  if (!result.error) {
    debugLog(`Primary URL loaded successfully`);
    return { success: true, url: primaryUrl };
  }
  debugLog(`Primary URL failed: ${result.error}`);

  // Try fallbacks
  const fallbacks = getStreamFallbacks(primaryUrl, isLive);
  debugLog(`Trying ${fallbacks.length} fallback URLs...`);
  for (const fallbackUrl of fallbacks) {
    debugLog(`Trying fallback: ${fallbackUrl}`);
    const fallbackResult = await mpv.load(fallbackUrl, options);
    if (!fallbackResult.error) {
      debugLog(`Fallback succeeded: ${fallbackUrl}`);
      return { success: true, url: fallbackUrl };
    }
    debugLog(`Fallback failed: ${fallbackResult.error}`);
  }

  // All failed - return original error
  debugLog(`All URLs failed, returning error: ${result.error}`);
  return { success: false, url: primaryUrl, error: result.error };
}

function App() {
  // mpv state
  const [mpvReady, setMpvReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [currentChannel, setCurrentChannel] = useState<StoredChannel | null>(null);
  const [vodInfo, setVodInfo] = useState<VodPlayInfo | null>(null);

  // Debug: Log error state changes
  useEffect(() => {
    if (error) {
      console.log('[(Renderer) Error State Changed]', error);
    }
  }, [error]);

  // UI state
  const [showControls, setShowControls] = useState(true);
  const [lastActivity, setLastActivity] = useState(Date.now());
  const [activeView, setActiveView] = useState<View>('none');
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState(false);

  // Channel/category state (persisted)
  const { categoryId, setCategoryId, loading: categoryLoading } = useSelectedCategory();

  // Global sync state (from Settings)
  const channelSyncing = useChannelSyncing();
  const vodSyncing = useVodSyncing();
  const tmdbMatching = useTmdbMatching();
  const setChannelSyncing = useSetChannelSyncing();
  const setVodSyncing = useSetVodSyncing();
  const setChannelSortOrder = useSetChannelSortOrder();

  const [shortcuts, setShortcuts] = useState<ShortcutsMap>({});

  // Track volume slider dragging to ignore mpv updates during drag
  const volumeDraggingRef = useRef(false);

  // Track seeking to prevent position flickering during scrub
  const seekingRef = useRef(false);

  // Track if mouse is hovering over controls (prevents auto-hide)
  const controlsHoveredRef = useRef(false);

  // Set up mpv event listeners
  useEffect(() => {
    if (!window.mpv) {
      setError('mpv API not available - are you running in Electron?');
      return;
    }

    window.mpv.onReady((ready) => {
      console.log('mpv ready:', ready);
      setMpvReady(ready);
    });

    window.mpv.onStatus((status: MpvStatus) => {
      if (status.playing !== undefined) setPlaying(status.playing);
      // Skip volume updates while user is dragging the slider
      if (status.volume !== undefined && !volumeDraggingRef.current) {
        setVolume(status.volume);
      }
      if (status.muted !== undefined) setMuted(status.muted);
      // Skip position updates while user is seeking (prevents flickering)
      if (status.position !== undefined && !seekingRef.current) {
        setPosition(status.position);
      }
      if (status.duration !== undefined) {
        setDuration(status.duration);
      }
    });

    window.mpv.onError(async (err) => {
      console.error('[(Renderer) mpv.onError]', err);
      debugLog(`MPV Error Event: ${err}`, 'error');

      // If generic error, try to get more info
      if (err.includes('loading failed') || err === 'Playback error') {
        const urlToTest = currentChannel?.direct_url;
        if (urlToTest) {
          setError(`Checking stream status...`);

          // Try to get User-Agent from the source
          let userAgent: string | undefined;
          if (currentChannel?.source_id && window.storage) {
            try {
              const sourceResult = await window.storage.getSource(currentChannel.source_id);
              if (sourceResult.success && sourceResult.data) {
                userAgent = sourceResult.data.user_agent;
              }
            } catch (e) {
              console.warn('[App] Failed to fetch source for UA:', e);
            }
          }

          const statusError = await checkStreamStatus(urlToTest, userAgent);
          if (statusError) {
            setError(statusError);
            return;
          }
        }
      }

      setError(err);
    });

    return () => {
      window.mpv?.removeAllListeners();
    };
  }, [currentChannel]);

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

  // Control handlers
  const handleLoadStream = async (channel: StoredChannel) => {
    debugLog(`handleLoadStream: ${channel.name} (${channel.stream_id})`);
    debugLog(`  URL: ${channel.direct_url}`);
    if (!window.mpv) {
      debugLog('  ABORT: window.mpv not available');
      return;
    }

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
    const result = await tryLoadWithFallbacks(playUrl, true, window.mpv, userAgent);
    if (!result.success) {
      const errMsg = result.error ?? 'Failed to load stream';
      console.error('[(Renderer) handleLoadStream] Load Failed:', errMsg);
      debugLog(`  FAILED: ${errMsg}`, 'error');
      setError(errMsg);
    } else {
      debugLog(`  SUCCESS: playing`);
      // Update channel with working URL if fallback was used
      setCurrentChannel(result.url !== playUrl
        ? { ...channel, direct_url: result.url }
        : channel
      );
      setPlaying(true);
    }
  };

  const handleTogglePlay = async () => {
    if (!window.mpv) return;
    await window.mpv.togglePause();
  };

  const handleVolumeChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseInt(e.target.value);
    setVolume(newVolume);
    if (window.mpv) {
      await window.mpv.setVolume(newVolume);
    }
  };

  const handleToggleMute = async () => {
    if (!window.mpv) return;
    await window.mpv.toggleMute();
    // UI state updated via mpv status callback
  };

  const handleStop = async () => {
    debugLog('handleStop called');
    if (!window.mpv) return;
    await window.mpv.stop();
    debugLog('handleStop: mpv.stop() completed');
    setPlaying(false);
    setCurrentChannel(null);
  };

  const handleSeek = async (seconds: number) => {
    if (!window.mpv) return;
    seekingRef.current = true;
    setPosition(seconds); // Optimistic update
    await window.mpv.seek(seconds);
    // Brief delay before accepting mpv updates again
    setTimeout(() => { seekingRef.current = false; }, 200);
  };

  const handleCycleSubtitle = async () => {
    if (!window.mpv) return;
    await window.mpv.cycleSubtitle();
  };

  const handleCycleAudio = async () => {
    if (!window.mpv) return;
    await window.mpv.cycleAudio();
  };

  const handleToggleStats = async () => {
    if (!window.mpv) return;
    // Toggle MPV's built-in stats overlay
    await window.mpv.toggleStats();
  };


  // Play a channel
  const handlePlayChannel = (channel: StoredChannel) => {
    handleLoadStream(channel);
  };

  // Play VOD content (movies/series)
  const handlePlayVod = async (info: VodPlayInfo) => {
    debugLog(`handlePlayVod: ${info.title} (${info.type})`);
    debugLog(`  URL: ${info.url}`);
    if (!window.mpv) {
      debugLog('  ABORT: window.mpv not available');
      return;
    }
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
            const { StalkerClient } = await import('@sbtltv/local-adapter');

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

    const result = await tryLoadWithFallbacks(urlToPlay, false, window.mpv, userAgent);
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
    // Open guide if it's not already open
    if (activeView !== 'guide') {
      setActiveView('guide');
    }
  };

  // Sync sources on app load (if sources exist)
  useEffect(() => {
    const doInitialSync = async () => {
      if (!window.storage) return;
      try {
        const result = await window.storage.getSources();
        if (result.data && result.data.length > 0) {
          // Get user's configured refresh settings
          const settingsResult = await window.storage.getSettings();
          const epgRefreshHours = settingsResult.data?.epgRefreshHours ?? 6;
          const vodRefreshHours = settingsResult.data?.vodRefreshHours ?? 24;
          // Load channel sort order preference
          if (settingsResult.data?.channelSortOrder) {
            setChannelSortOrder(settingsResult.data.channelSortOrder);
          }
          // Load shortcuts
          if (settingsResult.data?.shortcuts) {
            setShortcuts(settingsResult.data.shortcuts);
          }

          // Sync channels/EPG only for stale sources
          const enabledSources = result.data.filter(s => s.enabled);
          const staleSources = [];
          for (const source of enabledSources) {
            const stale = await isEpgStale(source.id, epgRefreshHours);
            if (stale) {
              staleSources.push(source);
            } else {
              debugLog(`Source ${source.name} is fresh, skipping channel/EPG sync`, 'sync');
            }
          }

          if (staleSources.length > 0) {
            setChannelSyncing(true);
            for (const source of staleSources) {
              debugLog(`Source ${source.name} is stale, syncing...`, 'sync');
              await syncSource(source);
            }
          }

          // Sync VOD only for Xtream sources that are stale
          const xtreamSources = result.data.filter(s => s.type === 'xtream' && s.enabled);
          if (xtreamSources.length > 0) {
            const staleVodSources = [];
            for (const source of xtreamSources) {
              const stale = await isVodStale(source.id, vodRefreshHours);
              if (stale) {
                staleVodSources.push(source);
              } else {
                debugLog(`Source ${source.name} is fresh, skipping VOD sync but triggering TMDB match`, 'vod');
                // Even if fresh, we might have new exports available or unmatched content
                enrichSourceMetadata(source);
              }
            }

            if (staleVodSources.length > 0) {
              setVodSyncing(true);
              for (const source of staleVodSources) {
                debugLog(`Source ${source.name} is stale, syncing VOD...`, 'vod');
                await syncVodForSource(source);
              }
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        debugLog(`Initial sync failed: ${errMsg}`, 'sync');
        console.error('[App] Initial sync failed:', err);
      } finally {
        setChannelSyncing(false);
        setVodSyncing(false);
      }
    };
    doInitialSync();
  }, [setChannelSyncing, setVodSyncing]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      const getKey = (action: ShortcutAction) => shortcuts[action] || DEFAULT_SHORTCUTS[action];

      if (e.key === getKey('togglePlay')) {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.key === getKey('toggleMute')) {
        handleToggleMute();
      } else if (e.key === getKey('cycleSubtitle')) {
        e.preventDefault();
        handleCycleSubtitle();
      } else if (e.key === getKey('cycleAudio')) {
        e.preventDefault();
        handleCycleAudio();
      } else if (e.key === getKey('toggleStats')) {
        e.preventDefault();
        handleToggleStats();
      } else if (e.key === getKey('toggleGuide')) {
        // Toggle guide
        setActiveView((v) => (v === 'guide' ? 'none' : 'guide'));
      } else if (e.key === getKey('toggleCategories')) {
        // Toggle categories
        setCategoriesOpen((open) => !open);
      } else if (e.key === getKey('close')) {
        setActiveView('none');
        setCategoriesOpen(false);
        setSidebarExpanded(false);
        setShowControls(false);
      } else if (e.key === getKey('seekForward')) {
        e.preventDefault();
        handleSeek(position + 10);
      } else if (e.key === getKey('seekBackward')) {
        e.preventDefault();
        handleSeek(position - 10);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts]);

  // Window control handlers
  const handleMinimize = () => window.electronWindow?.minimize();
  const handleMaximize = () => window.electronWindow?.maximize();
  const handleClose = () => window.electronWindow?.close();

  return (
    <div className={`app${showControls ? '' : ' controls-hidden'}`} onMouseMove={handleMouseMove}>
      {/* Custom title bar for frameless window */}
      <div className={`title-bar${showControls ? ' visible' : ''}`}>
        <Logo className="title-bar-logo" />
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
        {!currentChannel && !error && (
          <div className="placeholder">
            <Logo className="placeholder__logo" />
            {(channelSyncing || vodSyncing || tmdbMatching) ? (
              <div className="sync-status">
                <div className="sync-status__spinner" />
                <span className="sync-status__text">
                  {channelSyncing && vodSyncing
                    ? 'Syncing channels & VOD...'
                    : channelSyncing
                      ? 'Syncing channels...'
                      : vodSyncing
                        ? 'Syncing VOD...'
                        : 'Matching with TMDB...'}
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

      {/* Now Playing Bar */}
      <NowPlayingBar
        visible={showControls}
        channel={currentChannel}
        playing={playing}
        muted={muted}
        volume={volume}
        mpvReady={mpvReady}
        position={position}
        duration={duration}
        isVod={currentChannel?.stream_id === 'vod'}
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
      />

      {/* Sidebar Navigation - stays visible when any panel is open */}
      <Sidebar
        activeView={activeView}
        onViewChange={setActiveView}
        visible={showControls || categoriesOpen || activeView !== 'none'}
        categoriesOpen={categoriesOpen}
        onCategoriesToggle={() => setCategoriesOpen((open) => !open)}
        onCategoriesClose={() => setCategoriesOpen(false)}
        expanded={sidebarExpanded}
        onExpandedToggle={() => setSidebarExpanded((exp) => !exp)}
      />

      {/* Category Strip - slides out from sidebar */}
      <CategoryStrip
        selectedCategoryId={categoryId}
        onSelectCategory={handleSelectCategory}
        visible={categoriesOpen}
        sidebarExpanded={sidebarExpanded}
      />

      {/* Channel Panel - slides out (shifts right if categories open) */}
      <ChannelPanel
        categoryId={categoryId}
        visible={activeView === 'guide'}
        categoryStripOpen={categoriesOpen}
        sidebarExpanded={sidebarExpanded}
        onPlayChannel={handlePlayChannel}
        onClose={() => {
          setActiveView('none');
          setCategoriesOpen(false);
          setSidebarExpanded(false);
        }}
        error={error}
      />

      {/* Settings Panel */}
      {activeView === 'settings' && (
        <Settings
          onClose={() => setActiveView('none')}
          onShortcutsChange={setShortcuts}
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

      {/* Resize grip for frameless window (Windows only - frameless windows lack native resize) */}
      {window.platform?.isWindows && (
        <div
          className={`resize-grip${showControls ? ' visible' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            if (!window.electronWindow) return;

            const startX = e.screenX;
            const startY = e.screenY;
            let startWidth = window.innerWidth;
            let startHeight = window.innerHeight;
            let rafId: number | null = null;
            let pendingWidth = startWidth;
            let pendingHeight = startHeight;

            window.electronWindow.getSize().then(([w, h]) => {
              startWidth = w;
              startHeight = h;
            });

            const onMouseMove = (moveEvent: MouseEvent) => {
              pendingWidth = startWidth + (moveEvent.screenX - startX);
              pendingHeight = startHeight + (moveEvent.screenY - startY);

              // Throttle with RAF for smoother resize
              if (rafId === null) {
                rafId = requestAnimationFrame(() => {
                  window.electronWindow?.setSize(pendingWidth, pendingHeight);
                  rafId = null;
                });
              }
            };

            const onMouseUp = () => {
              if (rafId !== null) cancelAnimationFrame(rafId);
              // Final update to ensure we hit the exact position
              window.electronWindow?.setSize(pendingWidth, pendingHeight);
              document.removeEventListener('mousemove', onMouseMove);
              document.removeEventListener('mouseup', onMouseUp);
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
          }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <path d="M11 21L21 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M15 21L21 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M19 21L21 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
      )}
    </div>
  );
}

export default App;
