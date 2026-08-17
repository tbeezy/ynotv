import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { SportsEvent, SportsTeam, SportsLeague, SportsTabId } from '@ynotv/core';
import { Bridge, type AspectRatioMode, getAspectRatioLabel } from '../../services/tauri-bridge';
import {
  getLeaguesBySport,
  getAvailableSports,
} from '../../services/sports';
import { useSportsSelectedTab, useSetSportsSelectedTab } from '../../stores/uiStore';
import { useSportsSettingsStore } from '../../stores/sportsSettingsStore';
import { SportsErrorBoundary } from './shared/SportsErrorBoundary';
import { LiveScoresTab } from './LiveScoresTab';
import { UpcomingTab } from './UpcomingTab';
import { LeaguesTab } from './LeaguesTab';
import { FavoritesTab } from './FavoritesTab';
import { NewsTab } from './NewsTab';
import { LeadersTab } from './LeadersTab';
import { SettingsTab } from './SettingsTab';
import { WorldCupTab } from './WorldCupTab';
import { SportsScoresOverlay } from './SportsScoresOverlay';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import './SportsHub.css';

interface SportsHubProps {
  visible?: boolean;
  onClose: () => void;
  onSearchChannels?: (query: string) => void;
  previewEnabled?: boolean;
  onTogglePreview?: () => void;
  onPlayChannel?: (channel: import('../../db').StoredChannel) => void;
  // Playback controls for mini media bar
  onTogglePlay?: () => void;
  isPlaying?: boolean;
  onStop?: () => void;
  onChannelUp?: () => void;
  onChannelDown?: () => void;
  aspectRatio?: AspectRatioMode;
  onSetAspectRatio?: (mode: AspectRatioMode) => void;
  onPreviewVideoRectChange?: (rect: { left: number; top: number; width: number; height: number } | null) => void;
  sportsOverlayWidget?: 'autohide' | 'persistent' | null;
  onSportsOverlayWidgetChange?: (mode: 'autohide' | 'persistent' | null) => void;
  sportsLiveSidebarWidget?: boolean;
  onSportsLiveSidebarWidgetChange?: (enabled: boolean) => void;
}

export function SportsHub({
  visible,
  onClose,
  onSearchChannels,
  previewEnabled,
  onTogglePreview,
  onPlayChannel,
  onTogglePlay,
  isPlaying,
  onStop,
  onChannelUp,
  onChannelDown,
  aspectRatio = 'fit',
  onSetAspectRatio,
  onPreviewVideoRectChange,
  sportsOverlayWidget,
  onSportsOverlayWidgetChange,
  sportsLiveSidebarWidget,
  onSportsLiveSidebarWidgetChange,
}: SportsHubProps) {
  useTranslation();
  const [transitionCompleted, setTransitionCompleted] = useState(visible === undefined);

  useEffect(() => {
    if (visible === undefined) {
      setTransitionCompleted(true);
      return;
    }
    if (visible) {
      const timer = setTimeout(() => {
        setTransitionCompleted(true);
      }, 250);
      return () => clearTimeout(timer);
    } else {
      setTransitionCompleted(false);
    }
  }, [visible]);

  const previewRef = useRef<HTMLDivElement>(null);
  const fillerLeftRef = useRef<HTMLDivElement>(null);
  const fillerRightRef = useRef<HTMLDivElement>(null);
  const fillerTopRef = useRef<HTMLDivElement>(null);
  const fillerBottomRef = useRef<HTMLDivElement>(null);
  const activeTab = useSportsSelectedTab();
  const setActiveTab = useSetSportsSelectedTab();

  const { loaded, loadSettings, showWorldCupTab } = useSportsSettingsStore();

  useEffect(() => {
    if (!loaded) {
      loadSettings();
    }
  }, [loaded, loadSettings]);

  useEffect(() => {
    if (loaded && !showWorldCupTab && activeTab === 'worldcup') {
      setActiveTab('live');
    }
  }, [loaded, showWorldCupTab, activeTab, setActiveTab]);

  // Set scaling properties once when visible or aspectRatio changes
  useEffect(() => {
    if (visible) {
      Bridge.setProperties({
        'video-zoom': 0,
        'video-align-x': 0,
        'video-align-y': 0,
        'video-aspect-override': aspectRatio === '4:3' ? '4:3' : (aspectRatio === '16:9' ? '16:9' : -1),
        'keepaspect': aspectRatio !== 'stretch',
        'panscan': aspectRatio === 'fill' ? 1 : 0,
      }).catch(() => { });
    }
  }, [visible, aspectRatio]);
  const [selectedSport, setSelectedSport] = useState<string | null>(null);
  const [selectedLeague, setSelectedLeague] = useState<SportsLeague | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<SportsTeam | null>(null);
  const [leagues, setLeagues] = useState<SportsLeague[]>([]);
  const [loading, setLoading] = useState(false);

  // Mini media bar hover tracking
  const [miniBarHovered, setMiniBarHovered] = useState(false);
  const [previewHovered, setPreviewHovered] = useState(false);

  // Volume/mute state for mini media bar
  const [previewVolume, setPreviewVolume] = useState(100);
  const [previewMuted, setPreviewMuted] = useState(false);

  // Aspect ratio menu state for mini media bar
  const [showAspectMenu, setShowAspectMenu] = useState(false);
  const aspectMenuRef = useRef<HTMLDivElement>(null);

  // Close aspect ratio menu on outside click
  useEffect(() => {
    if (!showAspectMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (aspectMenuRef.current && !aspectMenuRef.current.contains(e.target as Node)) {
        setShowAspectMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showAspectMenu]);

  // Handle preview pane hover for mini media bar visibility
  const handlePreviewPaneMouseEnter = useCallback(() => {
    setPreviewHovered(true);
  }, []);

  const handlePreviewPaneMouseLeave = useCallback(() => {
    setPreviewHovered(false);
  }, []);

  // Handle volume change for preview mini bar
  const handlePreviewVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newVol = parseInt(e.target.value, 10);
    setPreviewVolume(newVol);
    Bridge.setProperty('volume', newVol).catch(console.error);
    if (newVol > 0 && previewMuted) {
      setPreviewMuted(false);
      Bridge.setProperty('mute', false).catch(console.error);
    }
  }, [previewMuted]);

  // Handle mute toggle for preview mini bar
  const handlePreviewMuteToggle = useCallback(() => {
    const newMuted = !previewMuted;
    setPreviewMuted(newMuted);
    Bridge.setProperty('mute', newMuted).catch(console.error);
    if (newMuted && previewVolume === 0) {
      setPreviewVolume(100);
      Bridge.setProperty('volume', 100).catch(console.error);
    }
  }, [previewMuted, previewVolume]);

  // Compute mini bar visibility based on hover state
  const isMiniBarVisible = previewHovered || miniBarHovered;

  // Resize persistence state
  const [previewHeightPx, setPreviewHeightPx] = useState(() => {
    const saved = localStorage.getItem('sportsPreviewHeight');
    return saved ? parseInt(saved) : 400; // default 400px
  });

  // Sidebar state and toggle removed since we transitioned to topbar navigation

  const sports = getAvailableSports();

  useEffect(() => {
    if (selectedSport) {
      setLoading(true);
      getLeaguesBySport(selectedSport)
        .then(setLeagues)
        .finally(() => setLoading(false));
    }
  }, [selectedSport]);

  // Handle Video Resizing for Preview Mode via ResizeObserver explicitly when component mounts
  useEffect(() => {
    let isSyncing = false;
    let queuedUpdate = false;
    let rafId: number | null = null;
    let lastGeometry = '';
    let forceNextUpdate = false;
    let isDragging = false;
    let dragSettleTimer: ReturnType<typeof setTimeout> | null = null;
    const isReady = visible === undefined ? true : (visible && transitionCompleted);

    const updateVideoPosition = async () => {
      if (!previewRef.current || !previewEnabled || !isReady) {
        onPreviewVideoRectChange?.(null);
        return;
      }

      if (isSyncing) return;
      isSyncing = true;

      const clientRect = previewRef.current.getBoundingClientRect();
      const rect = {
        left: clientRect.left,
        top: clientRect.top,
        right: clientRect.right,
        bottom: clientRect.bottom,
        width: clientRect.width,
        height: clientRect.height,
      };

      if (rect.width === 0 || rect.height === 0) {
        onPreviewVideoRectChange?.(null);
        isSyncing = false;
        return;
      }

      onPreviewVideoRectChange?.({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });

      // Reset empty space filler overlays (handled natively by MPV window bounding box now)
      if (fillerLeftRef.current) fillerLeftRef.current.style.width = '0px';
      if (fillerRightRef.current) fillerRightRef.current.style.width = '0px';
      if (fillerTopRef.current) fillerTopRef.current.style.height = '0px';
      if (fillerBottomRef.current) fillerBottomRef.current.style.height = '0px';

      const force = forceNextUpdate;
      forceNextUpdate = false;

      // Physically resize the main MPV window to match the preview container's screen coordinates
      const d = window.devicePixelRatio || 1;
      const sx = Math.round(rect.left * d);
      const sy = Math.round(rect.top * d);
      const sw = Math.round(rect.width * d);
      const sh = Math.round(rect.height * d);
      const nextGeometry = `${sx}:${sy}:${sw}:${sh}`;

      // Suppress geometry updates while the window is being dragged to avoid choppy
      // mid-drag resizing. The drag-settle handler fires one forced update when movement stops.
      if (isDragging || (!force && nextGeometry === lastGeometry)) {
        isSyncing = false;
        return;
      }

      lastGeometry = nextGeometry;

      invoke('mpv_set_geometry', { x: sx, y: sy, width: sw, height: sh })
        .catch((e) => {
          console.warn('[SportsPreview] Geometry Sync Failed', e);
        })
        .finally(() => {
          isSyncing = false;
          if (queuedUpdate) {
            queuedUpdate = false;
            updateVideoPosition();
          }
        });
    };

    const scheduleVideoPositionUpdate = () => {
      if (isSyncing) {
        queuedUpdate = true;
        return;
      }
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateVideoPosition();
      });
    };

    const observer = new ResizeObserver(() => {
      scheduleVideoPositionUpdate();
    });

    if (previewRef.current) {
      observer.observe(previewRef.current);
      updateVideoPosition();
    }

    // Listen for window resize events to keep the MPV window aligned when layout shifts
    const handleWindowResize = () => {
      scheduleVideoPositionUpdate();
    };
    window.addEventListener('resize', handleWindowResize);

    // Listen for window move events to keep the MPV window aligned during dragging
    let unlistenMove: (() => void) | null = null;
    let disposed = false;

    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const appWindow = getCurrentWindow();
      appWindow.onMoved(() => {
        // Mark drag in progress — suppresses mpv_set_geometry during movement
        isDragging = true;
        // Debounce: once onMoved stops firing for 100ms the window has settled.
        // Clear any pending settle timer and restart it.
        if (dragSettleTimer !== null) clearTimeout(dragSettleTimer);
        dragSettleTimer = setTimeout(() => {
          dragSettleTimer = null;
          isDragging = false;
          // Bypass geometry cache and reposition MPV exactly once after the drag ends.
          forceNextUpdate = true;
          lastGeometry = ''; // reset cache so the geometry call is never skipped
          scheduleVideoPositionUpdate();
        }, 100);
      }).then((unlisten) => {
        if (disposed) unlisten();
        else unlistenMove = unlisten;
      }).catch(() => {});
    }).catch(() => {});

    let animationFrameId: number;
    const startTime = performance.now();
    const DURATION = 500;

    const animate = () => {
      updateVideoPosition();
      if (performance.now() - startTime < DURATION) {
        animationFrameId = requestAnimationFrame(animate);
      }
    };

    if (previewEnabled && isReady) {
      animate();
    }

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      if (unlistenMove) unlistenMove();
      if (dragSettleTimer !== null) clearTimeout(dragSettleTimer);
      if (rafId !== null) cancelAnimationFrame(rafId);
      cancelAnimationFrame(animationFrameId);
      onPreviewVideoRectChange?.(null);
    };
  }, [previewEnabled, aspectRatio, visible, transitionCompleted]);

  const handleSearchChannels = useCallback((channelName: string) => {
    if (onSearchChannels) {
      onSearchChannels(channelName);
      // Note: do NOT call onClose() here — onSearchChannels already switches
      // activeView to 'guide', so calling onClose() would immediately undo that.
    }
  }, [onSearchChannels]);

  // Drag-to-resize logic for the video preview pane (Vertical)
  const isResizingRef = useRef(false);
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizingRef.current = true;

    const startY = e.clientY;
    
    let startHeight = previewHeightPx;
    if (previewRef.current) {
      const currentHeight = parseInt(previewRef.current.style.height);
      if (!isNaN(currentHeight)) {
        startHeight = currentHeight;
      } else {
        startHeight = previewRef.current.getBoundingClientRect().height;
      }
    }

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingRef.current || !previewRef.current) return;
      
      const dy = moveEvent.clientY - startY;
      let newHeight = startHeight + dy;
      
      // Clamp between 150px and windowHeight - 100px so we don't eat the entire app
      newHeight = Math.max(150, Math.min(newHeight, window.innerHeight - 100));

      previewRef.current.style.height = `${newHeight}px`;
    };

    const handleMouseUp = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      
      if (previewRef.current) {
        let finalHeight = parseInt(previewRef.current.style.height);
        if (isNaN(finalHeight)) {
           finalHeight = previewRef.current.getBoundingClientRect().height;
        }
        setPreviewHeightPx(finalHeight);
        localStorage.setItem('sportsPreviewHeight', String(finalHeight));
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [previewHeightPx]);

  const handleResizeContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPreviewHeightPx(400);
    localStorage.setItem('sportsPreviewHeight', '400');
    if (previewRef.current) {
      previewRef.current.style.height = `400px`;
    }
  }, []);

  const handleBack = useCallback(() => {
    if (selectedTeam) {
      setSelectedTeam(null);
    } else if (selectedLeague) {
      setSelectedLeague(null);
    } else if (selectedSport) {
      setSelectedSport(null);
    } else {
      onClose();
    }
  }, [selectedTeam, selectedLeague, selectedSport, onClose]);

  const getTabIcon = (tab: SportsTabId) => {
    switch (tab) {
      case 'live':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" />
          </svg>
        );
      case 'upcoming':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        );
      case 'worldcup':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
            <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
            <path d="M4 22h16" />
            <path d="M10 14.66V17c0 .55-.45 1-1 1H4v2h16v-2h-5c-.55 0-1-.45-1-1v-2.34" />
            <path d="M12 2a6 6 0 0 1 6 6v5a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8a6 6 0 0 1 6-6z" />
          </svg>
        );
      case 'leagues':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
            <line x1="4" y1="22" x2="4" y2="15" />
          </svg>
        );
      case 'favorites':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        );
      case 'news':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
        );
      case 'leaders':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        );
      case 'settings':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        );
    }
  };

  const getTabLabel = (tab: SportsTabId) => {
    switch (tab) {
      case 'live':
        return i18n.t('sports:tabs.live');
      case 'upcoming':
        return i18n.t('sports:tabs.upcoming');
      case 'worldcup':
        return i18n.t('sports:tabs.worldcup');
      case 'leagues':
        return i18n.t('sports:tabs.leagues');
      case 'favorites':
        return i18n.t('sports:tabs.favorites');
      case 'news':
        return i18n.t('sports:tabs.news');
      case 'leaders':
        return i18n.t('sports:tabs.leaders');
      case 'settings':
        return i18n.t('sports:tabs.settings');
    }
  };

  const renderContent = () => {
    const tabContent = (() => {
      switch (activeTab) {
        case 'live':
          return (
            <LiveScoresTab
              onSearchChannels={handleSearchChannels}
              onPlayChannel={onPlayChannel}
              sportsOverlayWidget={sportsOverlayWidget}
              onSportsOverlayWidgetChange={onSportsOverlayWidgetChange}
              sportsLiveSidebarWidget={sportsLiveSidebarWidget}
              onSportsLiveSidebarWidgetChange={onSportsLiveSidebarWidgetChange}
            />
          );
        case 'upcoming':
          return <UpcomingTab onSearchChannels={handleSearchChannels} onPlayChannel={onPlayChannel} />;
        case 'worldcup':
          return <WorldCupTab onSearchChannels={handleSearchChannels} onPlayChannel={onPlayChannel} />;
        case 'leagues':
          return <LeaguesTab onSearchChannels={handleSearchChannels} onPlayChannel={onPlayChannel} />;
        case 'favorites':
          return (
            <FavoritesTab
              onSearchChannels={handleSearchChannels}
              onPlayChannel={onPlayChannel}
              onSetTab={(tab) => setActiveTab(tab)}
            />
          );
        case 'news':
          return <NewsTab onSearchChannels={handleSearchChannels} />;
        case 'leaders':
          return <LeadersTab onSearchChannels={handleSearchChannels} />;
        case 'settings':
          return <SettingsTab />;
      }
    })();

    return (
      <SportsErrorBoundary>
        {tabContent}
      </SportsErrorBoundary>
    );
  };

  return (
    <div className={`sports-hub ${previewEnabled ? 'with-preview' : ''}`}>
      {/* Top Navigation */}
      <header className="sports-topbar">
        <div className="sports-topbar-left">
          <div className="sports-brand">
            <svg className="sports-brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
              <line x1="4" y1="22" x2="4" y2="15" />
            </svg>
            <span className="sports-brand-name">{i18n.t('sports:brandName')}</span>
          </div>
        </div>

        <div className="sports-topbar-center">
          {((['live', 'upcoming', 'worldcup', 'leagues', 'favorites', 'news', 'leaders', 'settings'] as SportsTabId[]))
            .filter((tab) => tab !== 'worldcup' || showWorldCupTab)
            .map((tab) => (
              <button
                key={tab}
                className={`sports-topbar-item ${activeTab === tab ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                <span className="sports-topbar-icon">{getTabIcon(tab)}</span>
                <span>{getTabLabel(tab)}</span>
              </button>
            ))}
        </div>

        <div className="sports-topbar-right">
          {onTogglePreview && (
            <button
              className={`sports-topbar-preview-toggle ${previewEnabled ? 'active' : ''}`}
              onClick={onTogglePreview}
              title={previewEnabled ? i18n.t('sports:hideVideoPreview') : i18n.t('sports:showVideoPreview')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </button>
          )}
        </div>
      </header>

      <main className="sports-main">
        {!previewEnabled && (
          <header className="sports-main-header">
            <h1 className="sports-main-title">{getTabLabel(activeTab)}</h1>
          </header>
        )}

        <div className="sports-content-wrapper">
          {previewEnabled && (
            <div className="sports-top-section">
              <div
                className="sports-preview-pane"
                ref={previewRef}
                style={{ height: `${previewHeightPx}px` }}
                onMouseEnter={handlePreviewPaneMouseEnter}
                onMouseLeave={handlePreviewPaneMouseLeave}
                onDoubleClick={() => {
                  // Double-click to close Sports Hub (fullscreen video)
                  onClose();
                }}
                title={i18n.t('sports:doubleClickFullscreen')}
              >
                {/* Opaque fillers that cover the empty space around the centered video */}
                <div ref={fillerLeftRef} className="sports-preview-filler sports-preview-filler-left" />
                <div ref={fillerRightRef} className="sports-preview-filler sports-preview-filler-right" />
                <div ref={fillerTopRef} className="sports-preview-filler sports-preview-filler-top" />
                <div ref={fillerBottomRef} className="sports-preview-filler sports-preview-filler-bottom" />

                {/* Resizer Handle */}
                <div
                  className="sports-preview-resizer"
                  onMouseDown={handleResizeMouseDown}
                  onContextMenu={handleResizeContextMenu}
                  title={i18n.t('sports:dragResizePreview')}
                >
                  <div className="sports-resizer-line"></div>
                </div>
                {/* Mini Media Bar for Sports Preview - transparent overlay in bottom right */}
                {isMiniBarVisible && (
                  <div
                    className="sports-preview-minibar"
                    onDoubleClick={(e) => e.stopPropagation()}
                    onMouseEnter={() => setMiniBarHovered(true)}
                    onMouseLeave={() => setMiniBarHovered(false)}
                  >
                    {/* Play/Pause button */}
                    {onTogglePlay && (
                      <button
                        className="sports-minibar-btn"
                        onClick={onTogglePlay}
                        onDoubleClick={(e) => e.stopPropagation()}
                        title={isPlaying ? i18n.t('player:pause') : i18n.t('player:play')}
                      >
                        {isPlaying ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="4" width="4" height="16" rx="1" />
                            <rect x="14" y="4" width="4" height="16" rx="1" />
                          </svg>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        )}
                      </button>
                    )}
                    {/* Stop button */}
                    {onStop && (
                      <button
                        className="sports-minibar-btn"
                        onClick={onStop}
                        onDoubleClick={(e) => e.stopPropagation()}
                        title={i18n.t('player:stop')}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="6" width="12" height="12" rx="1" />
                        </svg>
                      </button>
                    )}
                    {/* Up button */}
                    {onChannelUp && (
                      <button
                        className="sports-minibar-btn"
                        onClick={onChannelUp}
                        onDoubleClick={(e) => e.stopPropagation()}
                        title={i18n.t('player:previousChannelUp')}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 15l-6-6-6 6" />
                        </svg>
                      </button>
                    )}
                    {/* Down button */}
                    {onChannelDown && (
                      <button
                        className="sports-minibar-btn"
                        onClick={onChannelDown}
                        onDoubleClick={(e) => e.stopPropagation()}
                        title={i18n.t('player:nextChannelDown')}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                    )}
                    {/* Aspect Ratio button — hidden but kept for easy re-enable */}
                    {false && onSetAspectRatio && (
                      <div className="sports-minibar-aspect" ref={aspectMenuRef}>
                        <button
                          className="sports-minibar-btn"
                          onClick={() => setShowAspectMenu(v => !v)}
                          onDoubleClick={(e) => e.stopPropagation()}
                          title={i18n.t('player:aspectRatio')}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="2" y="5" width="20" height="14" rx="2" />
                            <path d="M7 9h2M7 15h2M15 9h2M15 15h2" strokeLinecap="round" />
                          </svg>
                        </button>
                        {showAspectMenu && (
                          <div className="sports-minibar-aspect-menu">
                            {(['fit', 'fill', 'stretch', '4:3', '16:9'] as AspectRatioMode[]).map((mode) => (
                              <button
                                key={mode}
                                className={`sports-minibar-aspect-item ${aspectRatio === mode ? 'active' : ''}`}
                                onClick={() => {
                                  onSetAspectRatio?.(mode);
                                  setShowAspectMenu(false);
                                }}
                              >
                                {getAspectRatioLabel(mode)}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {/* Volume button with expandable slider */}
                    <div className="sports-minibar-volume" onDoubleClick={(e) => e.stopPropagation()}>
                      <button
                        className="sports-minibar-btn"
                        onClick={handlePreviewMuteToggle}
                        onDoubleClick={(e) => e.stopPropagation()}
                        title={previewMuted ? i18n.t('player:unmute') : i18n.t('player:mute')}
                      >
                        {previewMuted || previewVolume === 0 ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                          </svg>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                          </svg>
                        )}
                      </button>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={previewMuted ? 0 : previewVolume}
                        onChange={handlePreviewVolumeChange}
                        onDoubleClick={(e) => e.stopPropagation()}
                        className="sports-minibar-volume-slider"
                        title={i18n.t('player:volume')}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="sports-content">
            {renderContent()}
          </div>
        </div>
      </main>
    </div>
  );
}
