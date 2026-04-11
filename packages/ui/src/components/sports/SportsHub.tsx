import { useState, useEffect, useCallback, useRef } from 'react';
import type { SportsEvent, SportsTeam, SportsLeague, SportsTabId } from '@ynotv/core';
import { Bridge } from '../../services/tauri-bridge';
import {
  getLeaguesBySport,
  getAvailableSports,
} from '../../services/sports';
import { useSportsSelectedTab, useSetSportsSelectedTab } from '../../stores/uiStore';
import { SportsErrorBoundary } from './shared/SportsErrorBoundary';
import { LiveScoresTab } from './LiveScoresTab';
import { UpcomingTab } from './UpcomingTab';
import { LeaguesTab } from './LeaguesTab';
import { FavoritesTab } from './FavoritesTab';
import { NewsTab } from './NewsTab';
import { LeadersTab } from './LeadersTab';
import { SettingsTab } from './SettingsTab';
import './SportsHub.css';

interface SportsHubProps {
  onClose: () => void;
  onSearchChannels?: (query: string) => void;
  previewEnabled?: boolean;
  onTogglePreview?: () => void;
  onPlayChannel?: (channel: import('../../db').StoredChannel) => void;
  // Mini media bar for preview
  miniMediaBarForPreview?: boolean;
  // Playback controls for mini media bar
  onTogglePlay?: () => void;
  isPlaying?: boolean;
  onStop?: () => void;
  onChannelUp?: () => void;
  onChannelDown?: () => void;
}

export function SportsHub({
  onClose,
  onSearchChannels,
  previewEnabled,
  onTogglePreview,
  onPlayChannel,
  miniMediaBarForPreview,
  onTogglePlay,
  isPlaying,
  onStop,
  onChannelUp,
  onChannelDown,
}: SportsHubProps) {
  const previewRef = useRef<HTMLDivElement>(null);
  const activeTab = useSportsSelectedTab();
  const setActiveTab = useSetSportsSelectedTab();
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

  // Compute mini bar visibility based on hover state (only when miniMediaBarForPreview is enabled)
  const isMiniBarVisible = miniMediaBarForPreview && (previewHovered || miniBarHovered);

  // Resize persistence state
  const [previewHeightPx, setPreviewHeightPx] = useState(() => {
    const saved = localStorage.getItem('sportsPreviewHeight');
    return saved ? parseInt(saved) : 400; // default 400px
  });

  const [isSidebarHidden, setIsSidebarHidden] = useState(() => {
    return localStorage.getItem('sportsSidebarHidden') === 'true';
  });

  const toggleSidebar = useCallback(() => {
    setIsSidebarHidden(prev => {
      const next = !prev;
      localStorage.setItem('sportsSidebarHidden', String(next));
      return next;
    });
  }, []);

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

    const updateVideoPosition = async () => {
      if (!previewRef.current || !previewEnabled) {
        if (!previewEnabled) {
          Bridge.setProperties({
            'video-zoom': 0,
            'video-align-x': 0,
            'video-align-y': 0
          }).catch(() => { });
        }
        return;
      }

      if (isSyncing) return;
      isSyncing = true;

      const rect = previewRef.current.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        isSyncing = false;
        return;
      }

      const windowW = window.innerWidth;
      const windowH = window.innerHeight;

      // MPV natively fits the 16:9 video inside the window.
      let videoNativeW = windowW;
      let videoNativeH = windowW * (9 / 16);

      if (videoNativeH > windowH) {
        // Window is wider than 16:9, so the video is constrained by window height
        videoNativeH = windowH;
        videoNativeW = windowH * (16 / 9);
      }

      // Find the scale that fits the video fully inside the rect
      const scaleX = rect.width / videoNativeW;
      const scaleY = rect.height / videoNativeH;
      const scale = Math.min(scaleX, scaleY);
      
      const zoom = Math.log2(scale);

      const actualVideoW = videoNativeW * scale;
      const actualVideoH = videoNativeH * scale;

      const targetCenterX = rect.left + (rect.width / 2);
      const targetCenterY = rect.top + (rect.height / 2);

      const shiftX = targetCenterX - (windowW / 2);
      const shiftY = targetCenterY - (windowH / 2);

      const availSpaceX = windowW - actualVideoW;
      const alignX = Math.abs(availSpaceX) < 1 ? 0 : (2 * shiftX) / availSpaceX;

      const availSpaceY = windowH - actualVideoH;
      const alignY = Math.abs(availSpaceY) < 1 ? 0 : (2 * shiftY) / availSpaceY;

      try {
        await Bridge.setProperties({
          'video-zoom': zoom,
          'video-align-x': alignX,
          'video-align-y': alignY
        });
      } catch (e) {
        console.warn('[SportsPreview] Geometry Sync Failed', e);
      } finally {
        isSyncing = false;
      }
    };

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(updateVideoPosition);
    });

    if (previewRef.current) {
      observer.observe(previewRef.current);
      updateVideoPosition();
    }

    window.addEventListener('resize', updateVideoPosition);

    let animationFrameId: number;
    const startTime = performance.now();
    const DURATION = 500;

    const animate = () => {
      updateVideoPosition();
      if (performance.now() - startTime < DURATION) {
        animationFrameId = requestAnimationFrame(animate);
      }
    };

    if (previewEnabled) {
      animate();
    }

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateVideoPosition);
      cancelAnimationFrame(animationFrameId);

      // Cleanup zoom when the entire SportsHub unmounts or preview toggles explicitly
      Bridge.setProperties({
        'video-zoom': 0,
        'video-align-x': 0,
        'video-align-y': 0
      }).catch(() => { });
    };
  }, [previewEnabled]);

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
        return 'Live Now';
      case 'upcoming':
        return 'Upcoming';
      case 'leagues':
        return 'Leagues';
      case 'favorites':
        return 'Favorites';
      case 'news':
        return 'News';
      case 'leaders':
        return 'Leaders';
      case 'settings':
        return 'Settings';
    }
  };

  const renderContent = () => {
    const tabContent = (() => {
      switch (activeTab) {
        case 'live':
          return <LiveScoresTab onSearchChannels={handleSearchChannels} onPlayChannel={onPlayChannel} />;
        case 'upcoming':
          return <UpcomingTab onSearchChannels={handleSearchChannels} onPlayChannel={onPlayChannel} />;
        case 'leagues':
          return <LeaguesTab onSearchChannels={handleSearchChannels} onPlayChannel={onPlayChannel} />;
        case 'favorites':
          return <FavoritesTab onSearchChannels={handleSearchChannels} onPlayChannel={onPlayChannel} />;
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
      {!isSidebarHidden ? (
        <aside className="sports-sidebar">
          <div className="sports-sidebar-header">
            <div className="sports-sidebar-title-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 className="sports-sidebar-title">Sports Hub</h2>
              <div style={{ display: 'flex', gap: '4px' }}>
                {onTogglePreview && (
                  <button
                    className={`sports-preview-toggle ${previewEnabled ? 'active' : ''}`}
                    onClick={onTogglePreview}
                    title={previewEnabled ? "Hide Video Preview" : "Show Video Preview"}
                    style={{ background: 'transparent', border: 'none', color: previewEnabled ? '#00d4ff' : 'rgba(255,255,255,0.5)', cursor: 'pointer', padding: '4px' }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                  </button>
                )}
                <button
                  className="sports-sidebar-collapse-btn"
                  onClick={toggleSidebar}
                  title="Hide Sidebar"
                  style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', padding: '4px' }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="15 18 9 12 15 6"></polyline>
                  </svg>
                </button>
              </div>
            </div>
            <p className="sports-sidebar-subtitle">Live Scores & TV Listings</p>
          </div>

          <nav className="sports-nav">
            {(['live', 'upcoming', 'leagues', 'favorites', 'news', 'leaders', 'settings'] as SportsTabId[]).map((tab) => (
              <button
                key={tab}
                className={`sports-nav-item ${activeTab === tab ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                <span className="sports-nav-icon">{getTabIcon(tab)}</span>
                <span className="sports-nav-label">{getTabLabel(tab)}</span>
              </button>
            ))}
          </nav>

          <div className="sports-sidebar-footer">
            <button className="sports-back-btn" onClick={onClose}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
              Back to TV
            </button>
          </div>
        </aside>
      ) : (
        <button 
          className="sports-sidebar-show-btn" 
          onClick={toggleSidebar}
          title="Show Sidebar"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      )}

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
              >
                {/* Resizer Handle */}
                <div
                  className="sports-preview-resizer"
                  onMouseDown={handleResizeMouseDown}
                  onContextMenu={handleResizeContextMenu}
                  title="Drag up/down to resize preview | Right-click to reset"
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
                        title={isPlaying ? 'Pause' : 'Play'}
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
                        title="Stop"
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
                        title="Previous Channel (Up)"
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
                        title="Next Channel (Down)"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                    )}
                    {/* Volume button with expandable slider */}
                    <div className="sports-minibar-volume" onDoubleClick={(e) => e.stopPropagation()}>
                      <button
                        className="sports-minibar-btn"
                        onClick={handlePreviewMuteToggle}
                        onDoubleClick={(e) => e.stopPropagation()}
                        title={previewMuted ? 'Unmute' : 'Mute'}
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
                        title="Volume"
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
