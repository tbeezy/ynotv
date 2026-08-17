import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
import { searchGameStreams } from '../../services/sports/gameStreamSearcher';
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

  const bestLink: TeamChannelLink | undefined = homeLinks[0] || awayLinks[0];
  const isPlayingThisStream = bestLink && bestLink.stream_id === currentStreamId;

  const awayWinning = (event.awayScore ?? 0) > (event.homeScore ?? 0);
  const homeWinning = (event.homeScore ?? 0) > (event.awayScore ?? 0);
  const statusText = getStatusDisplay(event);

  const toggleLocalSearch = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (localSearchChannels && localSearchChannels.length > 0) {
      setLocalSearchChannels(null);
      return;
    }

    setIsSearching(true);
    try {
      const query = buildTeamSearchQuery(event.homeTeam.name, event.awayTeam.name, event.league.id, event.title);
      const results = await searchGameStreams(query, event.league.id, 15);
      setLocalSearchChannels(results);
    } catch (err) {
      console.error('[SportsLiveGameSidebar] Inline stream search failed:', err);
      setLocalSearchChannels([]);
    } finally {
      setIsSearching(false);
    }
  }, [event.homeTeam.name, event.awayTeam.name, event.league.id, event.title, localSearchChannels]);

  const handleWatch = useCallback(async (e: React.MouseEvent, link: TeamChannelLink) => {
    e.stopPropagation();
    if (isPlayingThisStream) return;

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
  }, [isPlayingThisStream, onPlayChannel]);

  return (
    <div className="slg-card" onClick={() => onOpenDetails(event)}>
      {/* Card Header: League & Live Clock */}
      <div className="slg-card-header">
        <span className="slg-card-league">{event.league.name}</span>
        <span className="slg-card-status">
          <span className="slg-live-dot" />
          {statusText || t('live', 'LIVE')}
        </span>
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
          </div>
          <span className={`slg-team-score ${homeWinning ? 'winning' : ''}`}>
            {event.homeScore ?? 0}
          </span>
        </div>
      </div>

      {/* Card Actions: Watch stream, Search Streams & Details button */}
      <div className="slg-card-actions">
        {bestLink ? (
          <button
            className={`slg-watch-btn ${isPlayingThisStream ? 'is-playing' : ''}`}
            onClick={(e) => handleWatch(e, bestLink)}
            disabled={isPlayingThisStream}
            title={isPlayingThisStream ? t('currentlyPlaying', 'Playing') : t('watchStream', 'Watch Stream')}
          >
            {isPlayingThisStream ? (
              <>
                <span>●</span>
                <span>{t('playing', 'Playing')}</span>
              </>
            ) : (
              <>
                <span>▶</span>
                <span>{bestLink.channel_name || t('watch', 'Watch')}</span>
              </>
            )}
          </button>
        ) : (
          <div style={{ flex: 1 }} />
        )}

        <button
          className={`slg-search-streams-btn ${localSearchChannels !== null ? 'active' : ''}`}
          onClick={toggleLocalSearch}
          title={localSearchChannels !== null ? t('hideSearchResults', 'Hide Streams') : t('listStreamsHere', 'Find Streams')}
        >
          {isSearching ? (
            <span className="slg-spin">⟳</span>
          ) : (
            <span>🔍</span>
          )}
          <span>{localSearchChannels !== null ? t('hide', 'Hide') : t('streams', 'Streams')}</span>
        </button>

        <button
          className="slg-detail-btn"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDetails(event);
          }}
          title={t('gameDetails', 'Game Details')}
        >
          <span>{t('stats', 'Stats')}</span>
          <span>→</span>
        </button>
      </div>

      {/* Inline Search Results */}
      {localSearchChannels !== null && (
        <div className="slg-inline-streams" onClick={(e) => e.stopPropagation()}>
          <div className="slg-inline-streams-header">{t('availableStreams', 'Available Streams')}:</div>
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
            <div className="slg-inline-no-streams">{t('noStreamsFound', 'No streams found')}</div>
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

  // Close with escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const isMainScreen = activeView === 'none';
  if (!isMainScreen) return null;

  return (
    <>
      {/* Middle Right Tab Trigger */}
      <div
        className={`slg-tab-trigger ${showControls ? '' : 'controls-hidden'} ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen((prev) => !prev)}
        title={t('liveGamesSidebar', 'Live Games Sidebar')}
      >
        <span className="slg-live-dot" />
        <span className="slg-tab-icon">⚡</span>
        <span className="slg-tab-label">{t('liveGames', 'Live Games')}</span>
        {liveEvents.length > 0 && (
          <span className="slg-tab-count">{liveEvents.length}</span>
        )}
      </div>

      {/* Backdrop overlay when open */}
      {isOpen && (
        <div
          className="slg-backdrop"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Sliding Sidebar Drawer */}
      <div
        className={`slg-drawer ${isOpen ? 'open' : ''}`}
        onMouseEnter={(e) => e.stopPropagation()}
        onMouseLeave={(e) => e.stopPropagation()}
      >
        {/* Drawer Header */}
        <div className="slg-header">
          <div className="slg-header-top">
            <div className="slg-title-row">
              <span className="slg-live-dot active-red" />
              <span className="slg-title">{t('liveGames', 'Live Games')}</span>
              <span className="slg-tab-count">{liveEvents.length}</span>
            </div>
            <button
              className="slg-close-btn"
              onClick={() => setIsOpen(false)}
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
