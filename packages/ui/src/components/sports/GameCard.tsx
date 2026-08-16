import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import type { SportsEvent } from '@ynotv/core';
import { formatEventTime } from '../../services/sports';
import { db } from '../../db';
import type { StoredChannel, TeamChannelLink } from '../../db';
import { splitTeamName, buildTeamSearchQuery } from '../../services/sports/teamChannelMatcher';
import { searchGameStreams } from '../../services/sports/gameStreamSearcher';
import { useTeamChannelLinks, useTeamLinks } from '../../stores/teamChannelLinksStore';
import { useSportsSelectedChannels, useSetSportsSelectedChannel, useEpgClockFormat } from '../../stores/uiStore';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import './styles/GameCard.css';

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h} 60% 45%)`;
}

function TeamNameLabel({ name }: { name: string }) {
  const { city, nickname } = splitTeamName(name);
  return (
    <div className="gc-team-name-wrap">
      {city && <span className="gc-team-city">{city}</span>}
      <span className="gc-team-nickname">{nickname}</span>
    </div>
  );
}

function TeamLogo({ name, logo, size = 'md' }: { name: string; logo?: string; size?: 'sm' | 'md' | 'lg' }) {
  const [failed, setFailed] = useState(false);
  const sizeClass = size === 'lg' ? 'gc-logo-lg' : size === 'sm' ? 'gc-logo-sm' : 'gc-logo-md';

  if (logo && !failed) {
    return (
      <img
        src={logo}
        alt={name}
        className={`gc-logo-img ${sizeClass}`}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div className={`gc-logo-fallback ${sizeClass}`} style={{ background: stringToColor(name) }}>
      {getInitials(name)}
    </div>
  );
}

export function TeamPlayButton({
  links,
  onPlay,
}: {
  links: TeamChannelLink[];
  onPlay: (link: TeamChannelLink) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside the button group or the (portaled) menu.
  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (groupRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  // Position the portaled menu under the button, flipping above when there isn't
  // enough room below the viewport. Re-measures on resize/scroll.
  useEffect(() => {
    if (!menuOpen) return;
    const update = () => {
      const group = groupRef.current;
      if (!group) return;
      const rect = group.getBoundingClientRect();
      const menuW = menuRef.current?.offsetWidth ?? 200;
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

  if (links.length === 0) return null;

  const primary = links[0];
  const backups = links.slice(1);

  if (backups.length === 0) {
    return (
      <button
        className="gc-team-play-btn"
        title={`${i18n.t('sports:watchOn')}: ${primary.channel_name}`}
        aria-label={`${i18n.t('sports:watchOn')}: ${primary.channel_name}`}
        onClick={(e) => {
          e.stopPropagation();
          onPlay(primary);
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
      </button>
    );
  }

  return (
    <>
      <div className="gc-team-play-group" ref={groupRef} onClick={(e) => e.stopPropagation()}>
        <button
          className="gc-team-play-btn main"
          title={`${i18n.t('sports:watchOn')}: ${primary.channel_name}`}
          aria-label={`${i18n.t('sports:watchOn')}: ${primary.channel_name}`}
          onClick={(e) => {
            e.stopPropagation();
            onPlay(primary);
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </button>
        <button
          className={`gc-team-play-dropdown-btn ${menuOpen ? 'active' : ''}`}
          title={`${primary.channel_name} (+${backups.length} ${i18n.t('sports:backupChannels')})`}
          aria-label={`+${backups.length} ${i18n.t('sports:backupChannels')}`}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen(!menuOpen);
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {menuOpen &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            className="gc-team-play-menu"
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            <div className="gc-team-play-menu-header">
              {i18n.t('sports:backupStreams')} ({links.length})
            </div>
            {links.map((l, idx) => {
              const isPrimary = idx === 0;
              return (
                <button
                  key={l.stream_id}
                  className={`gc-team-play-menu-item ${isPrimary ? 'primary' : 'backup'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    onPlay(l);
                  }}
                >
                  <span className={`gc-menu-priority-badge ${isPrimary ? 'primary' : 'backup'}`}>
                    {isPrimary ? i18n.t('sports:primaryChannel') : i18n.t('sports:backupChannel', { num: idx })}
                  </span>
                  <span className="gc-menu-channel-name" title={l.channel_name}>{l.channel_name}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}

interface GameCardProps {
  event: SportsEvent;
  onClick?: () => void;
  onChannelClick?: (channelName: string) => void;
  onSearchTeams?: (query: string) => void;
  onPlayChannel?: (channel: StoredChannel) => void;
  compact?: boolean;
}

const inlineSearchCache = new Map<string, StoredChannel[]>();

// Signature of everything GameCard renders — used by the memo comparator so a
// poll that didn't change a card's displayed data skips re-rendering it.
function gameCardSignature(event: SportsEvent): string {
  return [
    event.id,
    event.status,
    event.homeScore ?? '',
    event.awayScore ?? '',
    event.period ?? '',
    event.timeElapsed ?? '',
    event.league?.id ?? '',
    event.league?.name ?? '',
    event.homeTeam?.name ?? '',
    event.homeTeam?.shortName ?? '',
    event.homeTeam?.logo ?? '',
    event.awayTeam?.name ?? '',
    event.awayTeam?.shortName ?? '',
    event.awayTeam?.logo ?? '',
    event.startTime ? new Date(event.startTime).getTime() : '',
    event.title ?? '',
    event.venue ?? '',
    (event.channels || []).map((c) => c.name).join(','),
    event.matches ? JSON.stringify(event.matches) : '',
  ].join('|');
}

export const GameCard = memo(
  function GameCard({ event, onClick, onChannelClick, onSearchTeams, onPlayChannel, compact = false }: GameCardProps) {
  const epgClockFormat = useEpgClockFormat();
  useTranslation();
  const isLive = event.status === 'live';
  const isFinished = event.status === 'finished';
  const isScheduled = event.status === 'scheduled';
  const sport = event.league.sport.toLowerCase();

  const [isSearching, setIsSearching] = useState(false);
  const [localSearchChannels, setLocalSearchChannels] = useState<StoredChannel[] | null>(() => inlineSearchCache.get(event.id) || null);

  const sportsSelectedChannels = useSportsSelectedChannels();
  const setSportsSelectedChannel = useSetSportsSelectedChannel();
  const selectedChannelKey = sportsSelectedChannels[event.id] || null;

  // Team → channel links (configured in Sports settings or auto-linked).
  // Indexed lookups: O(1) per team, stable references, no per-render filter/sort.
  const { ensureLoaded: ensureTeamLinksLoaded } = useTeamChannelLinks();
  useEffect(() => { ensureTeamLinksLoaded(); }, [ensureTeamLinksLoaded]);
  const homeLinks = useTeamLinks(event.league.id, event.homeTeam.id);
  const awayLinks = useTeamLinks(event.league.id, event.awayTeam.id);

  const handlePlayLinked = useCallback(async (link: TeamChannelLink) => {
    try {
      const channel = await db.channels.get(link.stream_id);
      if (channel) {
        onPlayChannel?.(channel);
      } else {
        // Channel no longer in the database — fall back to a guide search by name.
        onChannelClick?.(link.channel_name);
      }
    } catch (err) {
      console.error('[GameCard] Failed to resolve linked channel:', err);
    }
  }, [onPlayChannel, onChannelClick]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.();
    }
  };

  const homeWinning = isLive || isFinished ? (event.homeScore ?? 0) > (event.awayScore ?? 0) : false;
  const awayWinning = isLive || isFinished ? (event.awayScore ?? 0) > (event.homeScore ?? 0) : false;

  const toggleLocalSearch = useCallback(async () => {
    if (localSearchChannels && localSearchChannels.length > 0) {
      setLocalSearchChannels(null);
      inlineSearchCache.delete(event.id);
      return;
    }

    setIsSearching(true);
    try {
      const query = buildTeamSearchQuery(event.homeTeam.name, event.awayTeam.name, event.league.id);
      const results = await searchGameStreams(query, event.league.id, 15);
      inlineSearchCache.set(event.id, results);
      setLocalSearchChannels(results);
    } catch (err) {
      console.error('Inline local search failed:', err);
      setLocalSearchChannels([]);
      inlineSearchCache.set(event.id, []);
    } finally {
      setIsSearching(false);
    }
  }, [event.id, event.homeTeam.name, event.awayTeam.name, event.league.id, localSearchChannels]);

  const getStatusBelow = (): string => {
    if (isScheduled) return '';
    const period = event.period ? parseInt(event.period, 10) : 0;
    switch (sport) {
      case 'football':
        return `Q${event.period || '-'}${event.timeElapsed ? ' · ' + event.timeElapsed : ''}`;
      case 'basketball':
        return `Q${event.period || '-'}${event.timeElapsed ? ' · ' + event.timeElapsed : ''}`;
      case 'baseball': {
        const inningLabel = period > 9 ? `${period}th` :
          period === 1 ? '1st' :
            period === 2 ? '2nd' :
              period === 3 ? '3rd' :
                period ? `${period}th` : '';
        return `${inningLabel || '-'}${event.timeElapsed ? ' · ' + event.timeElapsed : ''}`;
      }
      case 'hockey': {
        const periodLabel = period <= 3 ? `${period}${period === 1 ? 'st' : period === 2 ? 'nd' : period === 3 ? 'rd' : 'th'}` :
          period === 4 ? 'OT' :
            period === 5 ? 'SO' : `${period - 3}OT`;
        return `${periodLabel || '-'}${event.timeElapsed ? ' · ' + event.timeElapsed : ''}`;
      }
      case 'soccer':
        return event.timeElapsed || '';
      default:
        return event.timeElapsed || (isLive ? i18n.t('sports:statusLive') : i18n.t('sports:statusFinal'));
    }
  };

  const statusBelow = getStatusBelow();

  const compactView = (
    <div
      className={`game-card compact ${event.status}`}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-label={`${event.awayTeam.name} vs ${event.homeTeam.name}`}
    >
      <div className="gc-compact-grid">
        <div className="gc-compact-team away">
          <TeamLogo name={event.awayTeam.name} logo={event.awayTeam.logo} size="sm" />
          <TeamNameLabel name={event.awayTeam.name} />
        </div>
        <div className="gc-compact-center">
          {isScheduled ? (
            <>
              <span className="gc-compact-vs">VS</span>
              <span className="gc-compact-time">{formatEventTime(event.startTime, epgClockFormat !== '24h')}</span>
            </>
          ) : (
            <>
              <div className="gc-compact-score-pair">
                <span className={`gc-compact-score ${awayWinning ? 'winning' : ''}`}>{event.awayScore ?? '-'}</span>
                <span className="gc-compact-divider">:</span>
                <span className={`gc-compact-score ${homeWinning ? 'winning' : ''}`}>{event.homeScore ?? '-'}</span>
              </div>
              {statusBelow && <span className="gc-compact-status">{statusBelow}</span>}
            </>
          )}
        </div>
        <div className="gc-compact-team home">
          <TeamLogo name={event.homeTeam.name} logo={event.homeTeam.logo} size="sm" />
          <TeamNameLabel name={event.homeTeam.name} />
        </div>
      </div>
      {isLive && <span className="gc-live-pulse" />}
    </div>
  );

  const isUFC = event.league.id === 'ufc' && !!event.matches;
  const isRacing = (event.league.id === 'f1' || event.league.id === 'nascar' || event.league.id === 'indycar') && !!event.matches;
  const isGolf = (event.league.id === 'pga' || event.league.id === 'lpga') && !!event.matches;
  const isTennis = (event.league.id === 'atp' || event.league.id === 'wta') && !!event.matches;

  const fullView = (
    <div
      className={`game-card ${event.status} ${isUFC ? 'ufc-card' : ''} ${isRacing ? 'racing-card' : ''} ${isGolf ? 'golf-card' : ''} ${isTennis ? 'tennis-card' : ''}`}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-label={i18n.t('sports:gameCardAria', { away: event.awayTeam.name, home: event.homeTeam.name, status: isLive ? i18n.t('sports:statusLive') : isFinished ? i18n.t('sports:statusFinal') : i18n.t('sports:statusScheduled') })}
    >
      {/* Top Bar */}
      <div className="gc-top-bar">
        <span className="gc-league-pill">{event.league.name}</span>
        <div className="gc-status-group">
          {isLive && (
            <span className="gc-status-live">
              <span className="gc-live-dot" />
              {i18n.t('sports:statusLive')}
            </span>
          )}
          {isFinished && <span className="gc-status-final">{i18n.t('sports:statusFinal')}</span>}
          {isScheduled && <span className="gc-status-scheduled">{formatEventTime(event.startTime, epgClockFormat !== '24h')}</span>}
        </div>
      </div>

      {isUFC ? (
        /* ─── UFC Event Card Layout ─── */
        <>
          {/* Event Title */}
          <div className="gc-ufc-title">{event.title}</div>

          {/* Main Event Fighters */}
          <div className="gc-ufc-main">
            <div className="gc-ufc-fighter">
              <TeamLogo name={event.awayTeam.name} logo={event.awayTeam.logo} size="lg" />
              <span className="gc-ufc-fighter-name">{event.awayTeam.name}</span>
            </div>
            <div className="gc-ufc-vs">VS</div>
            <div className="gc-ufc-fighter">
              <TeamLogo name={event.homeTeam.name} logo={event.homeTeam.logo} size="lg" />
              <span className="gc-ufc-fighter-name">{event.homeTeam.name}</span>
            </div>
          </div>

          {/* Fight Card List */}
          {event.matches && event.matches.length > 0 && (
            <div className="gc-ufc-card">
              <div className="gc-ufc-card-header">{i18n.t('sports:fightCard')}</div>
              <div className="gc-ufc-card-list">
                {event.matches.map((match) => (
                  <div key={match.id} className={`gc-ufc-match ${match.status === 'live' ? 'live' : ''}`}>
                    <div className="gc-ufc-match-names">
                      <span className="gc-ufc-match-away">{match.awayName}</span>
                      <span className="gc-ufc-match-vs">{i18n.t('sports:vs')}</span>
                      <span className="gc-ufc-match-home">{match.homeName}</span>
                    </div>
                    {match.subtitle && (
                      <span className="gc-ufc-match-weight">{match.subtitle}</span>
                    )}
                    {match.status === 'live' && (
                      <span className="gc-ufc-match-live-dot" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : isRacing ? (
        /* ─── Racing Event Card Layout ─── */
        <>
          {/* Race Title */}
          <div className="gc-racing-title">{event.title}</div>
          {event.venue && <div className="gc-racing-circuit">{event.venue}</div>}

          {/* Podium Preview */}
          {event.matches && event.matches.length > 0 ? (
            <div className="gc-racing-podium">
              {event.matches.slice(0, 3).map((match, idx) => {
                const posLabels = ['1st', '2nd', '3rd'];
                return (
                  <div key={match.id} className={`gc-racing-podium-pos pos-${idx + 1}`}>
                    <span className="gc-racing-podium-label">{posLabels[idx]}</span>
                    {match.awayLogo && (
                      <img src={match.awayLogo} alt={match.awayName} className="gc-racing-podium-img" />
                    )}
                    <span className="gc-racing-podium-driver">{match.awayName}</span>
                    <span className="gc-racing-podium-team">{match.homeName}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="gc-racing-scheduled-info">
              <span className="gc-racing-scheduled-date">{formatEventTime(event.startTime, epgClockFormat !== '24h')}</span>
            </div>
          )}
        </>
      ) : isGolf ? (
        /* ─── Golf Tournament Card Layout ─── */
        <>
          {/* Tournament Title */}
          <div className="gc-golf-title">{event.title}</div>
          {event.venue && <div className="gc-golf-venue">{event.venue}</div>}

          {/* Leaderboard Preview */}
          {event.matches && event.matches.length > 0 ? (
            <div className="gc-golf-leaderboard">
              <div className="gc-golf-lb-header">
                <span>{i18n.t('sports:pos')}</span>
                <span>{i18n.t('sports:player')}</span>
                <span>{i18n.t('sports:score')}</span>
              </div>
              {event.matches.slice(0, 5).map((match) => (
                <div key={match.id} className={`gc-golf-lb-row ${match.position === 1 ? 'leader' : ''}`}>
                  <span className="gc-golf-lb-pos">{match.position || '-'}</span>
                  <span className="gc-golf-lb-player">
                    {match.awayLogo && (
                      <img src={match.awayLogo} alt="" className="gc-golf-lb-flag" />
                    )}
                    {match.awayName}
                  </span>
                  <span className={`gc-golf-lb-score ${match.subtitle?.startsWith('-') ? 'under' : match.subtitle?.startsWith('+') ? 'over' : 'even'}`}>
                    {match.subtitle || 'E'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="gc-golf-scheduled-info">
              <span className="gc-golf-scheduled-date">{formatEventTime(event.startTime, epgClockFormat !== '24h')}</span>
            </div>
          )}
        </>
      ) : isTennis ? (
        /* ─── Tennis Tournament Card Layout ─── */
        <>
          {/* Tournament Title */}
          <div className="gc-tennis-title">{event.title}</div>
          {event.venue && <div className="gc-tennis-venue">{event.venue}</div>}

          {/* Featured Match */}
          {event.matches && event.matches.length > 0 ? (
            <div className="gc-tennis-featured">
              {event.matches.slice(0, 1).map((match) => (
                <div key={match.id} className={`gc-tennis-match ${match.status === 'live' ? 'live' : ''}`}>
                  <div className="gc-tennis-match-header">
                    {match.groupName && <span className="gc-tennis-group">{match.groupName}</span>}
                    {match.status === 'live' && <span className="gc-tennis-live-badge">{i18n.t('sports:statusLive')}</span>}
                  </div>
                  <div className="gc-tennis-players">
                    <div className="gc-tennis-player">
                      {match.awayLogo && (
                        <img src={match.awayLogo} alt="" className="gc-tennis-flag" />
                      )}
                      <span className="gc-tennis-player-name">{match.awayName}</span>
                    </div>
                    <div className="gc-tennis-vs">VS</div>
                    <div className="gc-tennis-player">
                      {match.homeLogo && (
                        <img src={match.homeLogo} alt="" className="gc-tennis-flag" />
                      )}
                      <span className="gc-tennis-player-name">{match.homeName}</span>
                    </div>
                  </div>
                  {match.roundScores && match.roundScores.length > 0 && (
                    <div className="gc-tennis-sets">
                      {match.roundScores.map((set, idx) => (
                        <span key={idx} className="gc-tennis-set">{set}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="gc-tennis-scheduled-info">
              <span className="gc-tennis-scheduled-date">{formatEventTime(event.startTime, epgClockFormat !== '24h')}</span>
            </div>
          )}
        </>
      ) : (
        /* ─── Standard Sport Card Layout ─── */
        <>
          {/* Main Content */}
          <div className="gc-body">
            {/* Away Team */}
            <div className="gc-team-col away">
              <TeamLogo name={event.awayTeam.name} logo={event.awayTeam.logo} size="lg" />
              <TeamNameLabel name={event.awayTeam.name} />
              {onPlayChannel && (
                <TeamPlayButton links={awayLinks} onPlay={handlePlayLinked} />
              )}
            </div>

            {/* Center Scores */}
            <div className="gc-score-col">
              {isScheduled ? (
                <>
                  <span className="gc-vs-big">VS</span>
                  <span className="gc-start-time">{formatEventTime(event.startTime, epgClockFormat !== '24h')}</span>
                </>
              ) : (
                <>
                  <div className="gc-score-pair">
                    <span className={`gc-score-big ${awayWinning ? 'winning' : ''}`}>{event.awayScore ?? '-'}</span>
                    <span className="gc-score-sep">:</span>
                    <span className={`gc-score-big ${homeWinning ? 'winning' : ''}`}>{event.homeScore ?? '-'}</span>
                  </div>
                  {statusBelow && <span className="gc-status-below">{statusBelow}</span>}
                </>
              )}
            </div>

            {/* Home Team */}
            <div className="gc-team-col home">
              <TeamLogo name={event.homeTeam.name} logo={event.homeTeam.logo} size="lg" />
              <TeamNameLabel name={event.homeTeam.name} />
              {onPlayChannel && (
                <TeamPlayButton links={homeLinks} onPlay={handlePlayLinked} />
              )}
            </div>
          </div>
        </>
      )}

      {/* Footer */}
      {/* Channels */}
      {event.channels.length > 0 && (
        <div className="gc-footer">
          <div className="gc-channels">
            {event.channels.slice(0, 3).map((channel, idx) => (
              <button
                key={`api-ch-${idx}`}
                className={`gc-channel-pill ${selectedChannelKey === `api:${channel.name}` ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setSportsSelectedChannel(event.id, `api:${channel.name}`);
                  onChannelClick?.(channel.name);
                }}
                title={channel.name}
              >
                {channel.name}
              </button>
            ))}
            {event.channels.length > 3 && (
              <span className="gc-channel-more">+{event.channels.length - 3}</span>
            )}
          </div>
        </div>
      )}

      {/* Action buttons row */}
      {onSearchTeams && (
        <div className="gc-action-row">
          <button
            className="gc-action-text-btn"
            title={i18n.t('sports:searchEpgForTeam', { home: event.homeTeam.name, away: event.awayTeam.name })}
            onClick={(e) => {
              e.stopPropagation();
      const query = buildTeamSearchQuery(event.homeTeam.name, event.awayTeam.name, event.league.id, event.title);
              onSearchTeams(query);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            {i18n.t('sports:search')}
          </button>
          {onChannelClick && (
            <button
              className={`gc-action-text-btn ${localSearchChannels && localSearchChannels.length > 0 ? 'active' : ''}`}
              title={localSearchChannels && localSearchChannels.length > 0 ? i18n.t('sports:hideSearchResults') : i18n.t('sports:findStreams')}
              onClick={(e) => {
                e.stopPropagation();
                toggleLocalSearch();
              }}
            >
              {isSearching ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="gc-spin">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2v4" />
                  <path d="m5 5 2.8 2.8" />
                  <path d="m19 5-2.8 2.8" />
                  <path d="M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z" />
                </svg>
              )}
              {i18n.t('sports:listStreamsHere')}
            </button>
          )}
        </div>
      )}

      {/* Inline search results */}
      {localSearchChannels && localSearchChannels.length > 0 && (
        <div className="gc-inline-results">
          {localSearchChannels.map((channel, idx) => (
            <button
              key={`local-ch-${idx}`}
              className={`gc-channel-pill ${selectedChannelKey === `local:${channel.stream_id}` ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setSportsSelectedChannel(event.id, `local:${channel.stream_id}`);
                if (onPlayChannel && channel) {
                  onPlayChannel(channel);
                } else {
                  onChannelClick?.(channel.name);
                }
              }}
            >
              {channel.name}
            </button>
          ))}
        </div>
      )}
      {localSearchChannels && localSearchChannels.length === 0 && !isSearching && (
        <div className="gc-no-results">{i18n.t('sports:noStreamsFound')}</div>
      )}
    </div>
  );

    return compact ? compactView : fullView;
  },
  (prev, next) => {
    if (prev.compact !== next.compact) return false;
    // Handler truthiness controls whether whole UI regions render (e.g. the
    // play-button column and the search/streams action row) — re-render if any
    // of them appear or disappear, but ignore the identities themselves.
    if (Boolean(prev.onClick) !== Boolean(next.onClick)) return false;
    if (Boolean(prev.onChannelClick) !== Boolean(next.onChannelClick)) return false;
    if (Boolean(prev.onSearchTeams) !== Boolean(next.onSearchTeams)) return false;
    if (Boolean(prev.onPlayChannel) !== Boolean(next.onPlayChannel)) return false;
    return gameCardSignature(prev.event) === gameCardSignature(next.event);
  }
);
