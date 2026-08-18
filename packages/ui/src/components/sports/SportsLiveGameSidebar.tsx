import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { SportsEvent } from '@ynotv/core';
import type { StoredChannel, TeamChannelLink } from '../../db';
import { db } from '../../db';
import { useSportsPolling } from '../../hooks/useSportsPolling';
import { useSportsSettingsStore } from '../../stores/sportsSettingsStore';
import { useTeamChannelLinks, useTeamLinks } from '../../stores/teamChannelLinksStore';
import { isEventLiveOrPastStart } from '../../services/sports';
import { getStatusDisplay } from '../../services/sports/utils';
import { buildTeamSearchQuery } from '../../services/sports/teamChannelMatcher';
import {
  searchGameStreams,
  getCachedGameStreams,
  setCachedGameStreams,
  queuePrefetchGameStreams,
} from '../../services/sports/gameStreamSearcher';
import { useUIStore } from '../../stores/uiStore';
import { GameDetail } from './GameDetail';
import './SportsLiveGameSidebar.css';

interface SportsLiveGameSidebarProps {
  showControls: boolean;
  activeView: string;
  onChannelClick: (channel: StoredChannel) => void;
  currentChannel?: StoredChannel | null;
}

function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h} 60% 45%)`;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function MiniTeamLogo({ name, logo }: { name: string; logo?: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [logo]);

  if (logo && !failed) {
    return (
      <img
        src={logo}
        alt={name}
        className="slg-team-logo"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div className="slg-team-logo-fallback" style={{ background: stringToColor(name) }}>
      {getInitials(name)}
    </div>
  );
}

interface SidebarTeamPlayButtonProps {
  teamName: string;
  links: TeamChannelLink[];
  onPlay: (link: TeamChannelLink) => void;
  onSearchOtherStreams?: () => void;
  currentStreamId?: string;
}

function SidebarTeamPlayButton({
  teamName,
  links,
  onPlay,
  onSearchOtherStreams,
  currentStreamId,
}: SidebarTeamPlayButtonProps) {
  const { t } = useTranslation('sports');
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const controlRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (controlRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  // Position portaled menu under the control
  useEffect(() => {
    if (!menuOpen) return;
    const update = () => {
      const el = controlRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const menuW = menuRef.current?.offsetWidth ?? 210;
      const menuH = menuRef.current?.offsetHeight ?? 0;
      const gap = 6;
      let top = rect.bottom + gap;
      if (menuH > 0 && top + menuH > window.innerHeight - 8) {
        top = rect.top - menuH - gap;
      }
      if (top < 8) top = 8;
      let left = rect.left + rect.width / 2;
      left = Math.min(Math.max(left, menuW / 2 + 8), window.innerWidth - menuW / 2 - 8);
      setMenuPos({ top, left });
    };
    update();
    const raf = requestAnimationFrame(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [menuOpen]);

  if (links.length === 0) {
    if (!onSearchOtherStreams) return null;
    return (
      <button
        className="slg-team-unlinked-btn"
        title={t('findStreams', 'Find Streams')}
        aria-label={t('findStreams', 'Find Streams')}
        onClick={(e) => {
          e.stopPropagation();
          onSearchOtherStreams();
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
      </button>
    );
  }

  const primary = links[0];
  const hasBackups = links.length > 1;
  const isPlayingPrimary = primary.stream_id === currentStreamId;

  return (
    <>
      <div
        ref={controlRef}
        className={`slg-team-play-control ${hasBackups ? 'has-backups' : ''} ${menuOpen ? 'menu-open' : ''} ${isPlayingPrimary ? 'is-playing' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Main play action */}
        <button
          className="slg-team-play-main"
          title={`${t('watchOn', 'Watch on')}: ${primary.channel_name}`}
          aria-label={`${t('watchOn', 'Watch on')}: ${primary.channel_name}`}
          onClick={(e) => {
            e.stopPropagation();
            onPlay(primary);
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>

        {/* Integrated caret for backups & search dropdown */}
        {hasBackups ? (
          <button
            className={`slg-team-play-caret ${menuOpen ? 'active' : ''}`}
            title={`${primary.channel_name} (+${links.length - 1} ${t('backupChannels', 'backup channels')})`}
            aria-label={`${links.length - 1} ${t('backupChannels', 'backup channels')}`}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((prev) => !prev);
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        ) : onSearchOtherStreams ? (
          <button
            className={`slg-team-play-caret ${menuOpen ? 'active' : ''}`}
            title={t('findStreams', 'Find Streams')}
            aria-label={t('findStreams', 'Find Streams')}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((prev) => !prev);
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        ) : null}
      </div>

      {menuOpen &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            className="slg-team-play-menu"
            style={{ top: menuPos.top, left: menuPos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="slg-team-play-menu-header">
              {teamName} {t('streams', 'Streams')} ({links.length})
            </div>

            {links.map((l, idx) => {
              const isPrimary = idx === 0;
              const isPlaying = l.stream_id === currentStreamId;
              return (
                <button
                  key={l.stream_id}
                  className={`slg-team-play-menu-item ${isPrimary ? 'primary' : 'backup'} ${isPlaying ? 'active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    onPlay(l);
                  }}
                >
                  <span className={`slg-menu-priority-badge ${isPrimary ? 'primary' : 'backup'}`}>
                    {isPrimary ? t('primaryChannel', 'Primary') : t('backupChannel', { num: idx, defaultValue: `Backup ${idx}` })}
                  </span>
                  <span className="slg-menu-channel-name" title={l.channel_name}>
                    {l.channel_name}
                  </span>
                  {isPlaying ? (
                    <span className="slg-stream-playing">●</span>
                  ) : (
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
              );
            })}

            {onSearchOtherStreams && (
              <>
                <div className="slg-menu-separator" />
                <button
                  className="slg-team-play-menu-item search-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    onSearchOtherStreams();
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="slg-menu-search-icon">
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.35-4.35" />
                  </svg>
                  <span className="slg-menu-channel-name">
                    {t('findStreams', 'Search for other streams')}
                  </span>
                </button>
              </>
            )}
          </div>,
          document.body
        )}
    </>
  );
}

interface MiniGameCardProps {
  event: SportsEvent;
  onPlayChannel: (channel: StoredChannel) => void;
  onOpenDetails: (event: SportsEvent) => void;
  currentStreamId?: string;
}

function MiniGameCard({
  event,
  onPlayChannel,
  onOpenDetails,
  currentStreamId,
}: MiniGameCardProps) {
  const { t } = useTranslation('sports');
  const homeLinks = useTeamLinks(event.league.id, event.homeTeam.id);
  const awayLinks = useTeamLinks(event.league.id, event.awayTeam.id);

  const [isSearching, setIsSearching] = useState(false);
  const [localSearchChannels, setLocalSearchChannels] = useState<StoredChannel[] | null>(null);

  const awayWinning = (event.awayScore ?? 0) > (event.homeScore ?? 0);
  const homeWinning = (event.homeScore ?? 0) > (event.awayScore ?? 0);
  const statusText = getStatusDisplay(event);

  const toggleLocalSearch = useCallback(async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (localSearchChannels && localSearchChannels.length > 0) {
      setLocalSearchChannels(null);
      return;
    }

    setIsSearching(true);
    try {
      const query = buildTeamSearchQuery(event.homeTeam.name, event.awayTeam.name, event.league.id, event.title);
      const cacheKey = `${event.id}_${query}_${event.league.id}`;
      const cached = getCachedGameStreams(cacheKey) || getCachedGameStreams(`${query}_${event.league.id}_15`);
      if (cached) {
        setLocalSearchChannels(cached);
        setIsSearching(false);
        return;
      }

      const results = await searchGameStreams(query, event.league.id, 15);
      setCachedGameStreams(cacheKey, results);
      setLocalSearchChannels(results);
    } catch (err) {
      console.error('[SportsLiveGameSidebar] Inline stream search failed:', err);
      setLocalSearchChannels([]);
    } finally {
      setIsSearching(false);
    }
  }, [event.id, event.homeTeam.name, event.awayTeam.name, event.league.id, event.title, localSearchChannels]);

  const handlePlayLinked = useCallback(async (link: TeamChannelLink) => {
    try {
      const channel = await db.channels.get(link.stream_id);
      if (channel) {
        onPlayChannel(channel);
      } else {
        const fallback: StoredChannel = {
          stream_id: link.stream_id,
          name: link.channel_name,
          source_id: link.source_id || '',
          stream_icon: '',
          epg_channel_id: '',
          category_ids: [],
          direct_url: '',
          stream_type: 'live',
        };
        onPlayChannel(fallback);
      }
    } catch (err) {
      console.error('[SportsLiveGameSidebar] Failed to resolve channel:', err);
    }
  }, [onPlayChannel]);

  return (
    <div className="slg-card" onClick={() => onOpenDetails(event)}>
      {/* Card Header: League & Live Clock with Hover Search */}
      <div className="slg-card-header">
        <span className="slg-card-league">{event.league.name}</span>
        <div className="slg-card-header-right">
          <button
            className={`slg-card-hover-search ${localSearchChannels !== null ? 'active' : ''}`}
            onClick={toggleLocalSearch}
            title={localSearchChannels !== null ? t('hideSearchResults', 'Hide Streams') : t('findStreams', 'Find Streams')}
          >
            {isSearching ? (
              <span className="slg-spin">⟳</span>
            ) : (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
            )}
            <span>{localSearchChannels !== null ? t('hide', 'Hide') : t('findStreams', 'Find Streams')}</span>
          </button>
          <span className="slg-card-status">
            <span className="slg-live-dot" />
            {statusText || t('live', 'LIVE')}
          </span>
        </div>
      </div>

      {/* Teams and live scores */}
      <div className="slg-card-matchup">
        {/* Away team */}
        <div className="slg-team-row">
          <div className="slg-team-info">
            <MiniTeamLogo name={event.awayTeam.name} logo={event.awayTeam.logo} />
            <span className={`slg-team-name ${awayWinning ? 'winning' : ''}`} title={event.awayTeam.name}>
              {event.awayTeam.shortName || event.awayTeam.name}
            </span>
            <SidebarTeamPlayButton
              teamName={event.awayTeam.shortName || event.awayTeam.name}
              links={awayLinks}
              onPlay={handlePlayLinked}
              onSearchOtherStreams={toggleLocalSearch}
              currentStreamId={currentStreamId}
            />
          </div>
          <span className={`slg-team-score ${awayWinning ? 'winning' : ''}`}>
            {event.awayScore ?? 0}
          </span>
        </div>

        {/* Home team */}
        <div className="slg-team-row">
          <div className="slg-team-info">
            <MiniTeamLogo name={event.homeTeam.name} logo={event.homeTeam.logo} />
            <span className={`slg-team-name ${homeWinning ? 'winning' : ''}`} title={event.homeTeam.name}>
              {event.homeTeam.shortName || event.homeTeam.name}
            </span>
            <SidebarTeamPlayButton
              teamName={event.homeTeam.shortName || event.homeTeam.name}
              links={homeLinks}
              onPlay={handlePlayLinked}
              onSearchOtherStreams={toggleLocalSearch}
              currentStreamId={currentStreamId}
            />
          </div>
          <span className={`slg-team-score ${homeWinning ? 'winning' : ''}`}>
            {event.homeScore ?? 0}
          </span>
        </div>
      </div>

      {/* Inline Search Results */}
      {localSearchChannels !== null && (
        <div className="slg-inline-streams" onClick={(e) => e.stopPropagation()}>
          <div className="slg-inline-streams-header">
            <span>{t('availableStreams', 'Available Streams')}:</span>
            <button
              className="slg-inline-close-btn"
              onClick={toggleLocalSearch}
              title={t('hide', 'Hide')}
            >
              ✕
            </button>
          </div>
          {localSearchChannels.length > 0 ? (
            <div className="slg-inline-streams-list">
              {localSearchChannels.map((channel, idx) => {
                const isActive = channel.stream_id === currentStreamId;
                return (
                  <button
                    key={`stream-${idx}-${channel.stream_id}`}
                    className={`slg-stream-pill ${isActive ? 'active' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onPlayChannel(channel);
                    }}
                    title={channel.name}
                  >
                    <span className="slg-stream-icon">📺</span>
                    <span className="slg-stream-name">{channel.alias || channel.name}</span>
                    {isActive && <span className="slg-stream-playing">●</span>}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="slg-inline-no-streams">
              {isSearching ? (
                <span className="slg-searching-text">
                  <span className="slg-spin">⟳</span> {t('searchingStreams', 'Searching streams...')}
                </span>
              ) : (
                t('noStreamsFound', 'No streams found')
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SportsLiveGameSidebar({
  showControls,
  activeView,
  onChannelClick,
  currentChannel,
}: SportsLiveGameSidebarProps) {
  const { t } = useTranslation('sports');
  const [isOpen, setIsOpen] = useState(false);
  const [selectedLeague, setSelectedLeague] = useState<string>('all');
  const [selectedEventForDetail, setSelectedEventForDetail] = useState<SportsEvent | null>(null);

  const { liveLeagues, loaded, loadSettings } = useSportsSettingsStore();
  const { ensureLoaded: ensureTeamLinksLoaded } = useTeamChannelLinks();

  useEffect(() => {
    if (!loaded) {
      loadSettings();
    }
  }, [loaded, loadSettings]);

  useEffect(() => {
    ensureTeamLinksLoaded();
  }, [ensureTeamLinksLoaded]);

  // Shared polling hook — guarantees no duplicate requests
  const { events, loading } = useSportsPolling({
    pollingInterval: 30000,
    enabled: loaded,
    leagues: loaded ? liveLeagues : undefined,
  });

  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnterTrigger = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsOpen(true);
  }, []);

  const handleMouseEnterDrawer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 200);
  }, []);

  const handleClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsOpen(false);
  }, []);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  // Filter to active live events only
  const liveEvents = useMemo(() => {
    return events.filter(isEventLiveOrPastStart);
  }, [events]);

  // Unique leagues with live games
  const leaguesWithGames = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const e of liveEvents) {
      const existing = map.get(e.league.id);
      if (existing) {
        existing.count++;
      } else {
        map.set(e.league.id, { id: e.league.id, name: e.league.name, count: 1 });
      }
    }
    return Array.from(map.values());
  }, [liveEvents]);

  // Filtered by selected league
  const filteredEvents = useMemo(() => {
    if (selectedLeague === 'all') return liveEvents;
    return liveEvents.filter((e) => e.league.id === selectedLeague);
  }, [liveEvents, selectedLeague]);

  const appStartedAt = useRef(Date.now());
  const [startupReady, setStartupReady] = useState(false);

  // Initial startup delay (15s) + wait for auto-sync to be idle
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsub: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const checkReady = () => {
      const isSyncing = useUIStore.getState().channelSyncing;
      if (!isSyncing) {
        setStartupReady(true);
        if (pollTimer) clearInterval(pollTimer);
      }
    };

    const remainingMs = Math.max(0, 15000 - (Date.now() - appStartedAt.current));
    timer = setTimeout(() => {
      const isSyncing = useUIStore.getState().channelSyncing;
      if (!isSyncing) {
        setStartupReady(true);
      } else {
        // Wait for sync to complete
        unsub = useUIStore.subscribe((state, prev) => {
          if (prev.channelSyncing && !state.channelSyncing) {
            setStartupReady(true);
          }
        });
        // Safety poll every 2s in case event is missed
        pollTimer = setInterval(checkReady, 2000);
      }
    }, remainingMs);

    return () => {
      if (timer) clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      if (unsub) unsub();
    };
  }, []);

  // Background pre-fetch streams for all currently live games sequentially (1 by 1)
  // Only runs after 15s startup delay and once auto-sync is completely idle
  useEffect(() => {
    if (!startupReady || liveEvents.length === 0) return;
    for (const e of liveEvents) {
      const query = buildTeamSearchQuery(e.homeTeam.name, e.awayTeam.name, e.league.id, e.title);
      queuePrefetchGameStreams(e.id, query, e.league.id, 15);
    }
  }, [startupReady, liveEvents]);

  // Close with escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  const isMainScreen = activeView === 'none';
  if (!isMainScreen) return null;

  return (
    <>
      {/* Middle Right Tab Trigger */}
      <div
        className={`slg-tab-trigger ${showControls ? '' : 'controls-hidden'} ${isOpen ? 'open' : ''}`}
        onMouseEnter={handleMouseEnterTrigger}
        onMouseLeave={handleMouseLeave}
        onClick={() => setIsOpen((prev) => !prev)}
        title={t('liveGamesSidebar', 'Live Games Sidebar')}
      >
        <span className={`slg-live-dot ${liveEvents.length > 0 ? 'pulsing' : 'idle'}`} />
        <span className="slg-tab-label">{t('liveGames', 'Live Games')}</span>
        {liveEvents.length > 0 && (
          <span className="slg-tab-count">{liveEvents.length}</span>
        )}
      </div>

      {/* Backdrop overlay when open */}
      {isOpen && (
        <div
          className="slg-backdrop"
          onClick={handleClose}
        />
      )}

      {/* Sliding Sidebar Drawer */}
      <div
        className={`slg-drawer ${isOpen ? 'open' : ''}`}
        onMouseEnter={handleMouseEnterDrawer}
        onMouseLeave={handleMouseLeave}
      >
        {/* Drawer Header */}
        <div className="slg-header">
          <div className="slg-header-top">
            <div className="slg-title-row">
              <span className={`slg-live-dot active-red ${liveEvents.length > 0 ? 'pulsing' : 'idle'}`} />
              <span className="slg-title">{t('liveGames', 'Live Games')}</span>
              <span className="slg-tab-count">{liveEvents.length}</span>
            </div>
            <button
              className="slg-close-btn"
              onClick={handleClose}
              title={t('close', 'Close')}
            >
              ✕
            </button>
          </div>

          {/* League filter bar */}
          {leaguesWithGames.length > 1 && (
            <div className="slg-leagues-bar">
              <button
                className={`slg-league-pill ${selectedLeague === 'all' ? 'active' : ''}`}
                onClick={() => setSelectedLeague('all')}
              >
                <span>{t('all', 'All')}</span>
                <span className="slg-league-pill-count">({liveEvents.length})</span>
              </button>
              {leaguesWithGames.map((l) => (
                <button
                  key={l.id}
                  className={`slg-league-pill ${selectedLeague === l.id ? 'active' : ''}`}
                  onClick={() => setSelectedLeague(l.id)}
                >
                  <span>{l.name}</span>
                  <span className="slg-league-pill-count">({l.count})</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Drawer Body */}
        <div className="slg-body">
          {filteredEvents.length > 0 ? (
            filteredEvents.map((event) => (
              <MiniGameCard
                key={event.id}
                event={event}
                onPlayChannel={onChannelClick}
                onOpenDetails={setSelectedEventForDetail}
                currentStreamId={currentChannel?.stream_id}
              />
            ))
          ) : (
            <div className="slg-empty">
              <span className="slg-empty-icon">🏆</span>
              <span className="slg-empty-title">{t('noLiveGamesTitle', 'No Live Games Right Now')}</span>
              <span className="slg-empty-subtitle">
                {loading
                  ? t('loadingLiveScores', 'Loading live scores...')
                  : t('noLiveGamesSubtitle', 'Check back later for active matchups and live scores.')}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Game Details Modal */}
      {selectedEventForDetail && (
        <GameDetail
          event={selectedEventForDetail}
          onClose={() => setSelectedEventForDetail(null)}
          variant="glass"
          onPlayChannel={onChannelClick}
        />
      )}
    </>
  );
}
