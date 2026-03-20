import type { SportsEvent } from '@ynotv/core';
import { formatEventTime } from '../../services/sports';
import './styles/GameCard.css';

// Generic tokens that are too common to be meaningful search terms on their own.
// We prefer to skip these when a team name has other words available.
const GENERIC_TEAM_TOKENS = new Set([
  'fc', 'afc', 'sc', 'cf', 'ac', 'as', 'rc', 'bfc', 'utd',
  'united', 'city', 'town', 'rovers', 'wanderers', 'athletic', 'albion',
  'hotspur', 'county', 'vale', 'orient', 'palace', 'wednesday',
  'rangers', 'united', 'real', 'club', 'sporting', 'dynamo', 'lokomotiv',
]);

/**
 * Build the best possible AND-style search query for the two teams.
 * Strategy:
 *   1. Split each team name into words.
 *   2. From each team, pick the most distinctive word (longest non-generic token).
 *   3. Join them with a space so the multi-word AND search finds both.
 * Example: "Manchester United" + "AFC Bournemouth" → "Manchester Bournemouth"
 */
function buildTeamSearchQuery(homeTeam: string, awayTeam: string): string {
  function bestWord(name: string): string {
    const words = name
      .replace(/[()&.]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1);

    // Prefer words that are NOT in the generic set, sorted longest-first
    const significant = words.filter(w => !GENERIC_TEAM_TOKENS.has(w.toLowerCase()));
    const candidates = significant.length > 0 ? significant : words;
    return candidates.sort((a, b) => b.length - a.length)[0] ?? name;
  }

  const homeWord = bestWord(homeTeam);
  const awayWord = bestWord(awayTeam);
  return `${homeWord} ${awayWord}`;
}

interface GameCardProps {
  event: SportsEvent;
  onClick?: () => void;
  onChannelClick?: (channelName: string) => void;
  onSearchTeams?: (query: string) => void;
  compact?: boolean;
}

export function GameCard({ event, onClick, onChannelClick, onSearchTeams, compact = false }: GameCardProps) {
  const isLive = event.status === 'live';
  const isFinished = event.status === 'finished';
  const sport = event.league.sport.toLowerCase();

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.();
    }
  };

  const renderSportSpecificInfo = () => {
    if (!isLive && !isFinished) return null;

    switch (sport) {
      case 'football':
        return <FootballStatus event={event} isLive={isLive} />;
      case 'basketball':
        return <BasketballStatus event={event} isLive={isLive} />;
      case 'baseball':
        return <BaseballStatus event={event} isLive={isLive} />;
      case 'hockey':
        return <HockeyStatus event={event} isLive={isLive} />;
      case 'soccer':
        return <SoccerStatus event={event} isLive={isLive} />;
      case 'mma':
        return <MMAStatus event={event} isLive={isLive} />;
      case 'tennis':
        return <TennisStatus event={event} isLive={isLive} />;
      default:
        return <DefaultStatus event={event} isLive={isLive} />;
    }
  };

  const getStatusBadge = () => {
    if (isLive) {
      return (
        <span className="game-status-badge live">
          <span className="game-status-pulse" />
          {event.timeElapsed || 'LIVE'}
        </span>
      );
    }
    if (isFinished) {
      return <span className="game-status-badge final">FINAL</span>;
    }
    return (
      <span className="game-status-badge scheduled">
        {formatEventTime(event.startTime)}
      </span>
    );
  };

  const homeWinning = isLive || isFinished
    ? (event.homeScore ?? 0) > (event.awayScore ?? 0)
    : false;
  const awayWinning = isLive || isFinished
    ? (event.awayScore ?? 0) > (event.homeScore ?? 0)
    : false;

  if (compact) {
    return (
      <div
        className={`game-card compact ${event.status}`}
        onClick={onClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="button"
        aria-label={`${event.awayTeam.name} vs ${event.homeTeam.name}`}
      >
        <div className="game-card-compact-row">
          <span className="game-card-team-name">
            {event.awayTeam.shortName || event.awayTeam.name}
          </span>
          <span className={`game-card-score ${awayWinning ? 'winning' : ''}`}>
            {event.awayScore ?? '-'}
          </span>
        </div>
        <div className="game-card-compact-row">
          <span className="game-card-team-name">
            {event.homeTeam.shortName || event.homeTeam.name}
          </span>
          <span className={`game-card-score ${homeWinning ? 'winning' : ''}`}>
            {event.homeScore ?? '-'}
          </span>
        </div>
        {isLive && <span className="game-card-live-indicator" />}
      </div>
    );
  }

  return (
    <div
      className={`game-card ${event.status} ${isLive ? 'has-status' : ''}`}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-label={`${event.awayTeam.name} vs ${event.homeTeam.name}, ${isLive ? 'Live' : isFinished ? 'Final' : 'Scheduled'}`}
    >
      <div className="game-card-header">
        <span className="game-card-league">{event.league.name}</span>
        {getStatusBadge()}
      </div>

      <div className="game-card-body">
        <div className="game-card-team away">
          <div className="game-card-team-info">
            {event.awayTeam.logo && (
              <img
                src={event.awayTeam.logo}
                alt={event.awayTeam.name}
                className="game-card-team-logo"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            )}
            <div className="game-card-team-name-group">
              <span className="game-card-team-location">{event.awayTeam.shortName || ''}</span>
              <span className="game-card-team-name">{event.awayTeam.name}</span>
            </div>
          </div>
          <span className={`game-card-score ${awayWinning ? 'winning' : ''}`}>
            {event.awayScore ?? '-'}
          </span>
        </div>

        <div className="game-card-team home">
          <div className="game-card-team-info">
            {event.homeTeam.logo && (
              <img
                src={event.homeTeam.logo}
                alt={event.homeTeam.name}
                className="game-card-team-logo"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            )}
            <div className="game-card-team-name-group">
              <span className="game-card-team-location">{event.homeTeam.shortName || ''}</span>
              <span className="game-card-team-name">{event.homeTeam.name}</span>
            </div>
          </div>
          <span className={`game-card-score ${homeWinning ? 'winning' : ''}`}>
            {event.homeScore ?? '-'}
          </span>
        </div>

        {renderSportSpecificInfo()}
      </div>

      {(event.channels.length > 0 || onSearchTeams) && (
        <div className="game-card-footer">
          {event.channels.length > 0 && (
            <div className="game-card-channels">
              {event.channels.map((channel, idx) => (
                <button
                  key={idx}
                  className="game-card-channel-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onChannelClick?.(channel.name);
                  }}
                >
                  {channel.name}
                </button>
              ))}
            </div>
          )}
          {onSearchTeams && (
            <button
              className="game-card-search-teams-btn"
              title={`Search channels & EPG for ${event.homeTeam.name} vs ${event.awayTeam.name}`}
              onClick={(e) => {
                e.stopPropagation();
                const query = buildTeamSearchQuery(event.homeTeam.name, event.awayTeam.name);
                onSearchTeams(query);
              }}
            >
              🔍 Search Teams
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FootballStatus({ event, isLive }: { event: SportsEvent; isLive: boolean }) {
  const period = event.period ? parseInt(event.period, 10) : 0;
  const quarterLabel = period <= 4 ? `Q${period}` : `OT${period - 4}`;

  if (!isLive) {
    return event.period ? (
      <div className="game-card-status football">
        <span className="game-card-period">{quarterLabel}</span>
        <span className="game-card-clock">{event.timeElapsed}</span>
      </div>
    ) : null;
  }

  return (
    <div className="game-card-status football live">
      <span className="game-card-period">{quarterLabel}</span>
      <span className="game-card-clock">{event.timeElapsed}</span>
    </div>
  );
}

function BasketballStatus({ event, isLive }: { event: SportsEvent; isLive: boolean }) {
  const period = event.period ? parseInt(event.period, 10) : 0;
  const periodLabel = period <= 4 ? `Q${period}` : `OT${period - 4}`;

  if (!isLive && !event.period) return null;

  return (
    <div className="game-card-status basketball">
      <span className="game-card-period">{periodLabel}</span>
      {isLive && <span className="game-card-clock">{event.timeElapsed}</span>}
    </div>
  );
}

function BaseballStatus({ event, isLive }: { event: SportsEvent; isLive: boolean }) {
  const period = event.period ? parseInt(event.period, 10) : 0;
  const inningLabel = period > 9 ? `${period}th` :
    period === 1 ? '1st' :
      period === 2 ? '2nd' :
        period === 3 ? '3rd' :
          period ? `${period}th` : '';

  if (!isLive && !event.period) return null;

  return (
    <div className="game-card-status baseball">
      <span className="game-card-period">
        {isLive && <span className="game-card-half">▲</span>}
        {inningLabel}
      </span>
      {isLive && <span className="game-card-clock">{event.timeElapsed}</span>}
    </div>
  );
}

function HockeyStatus({ event, isLive }: { event: SportsEvent; isLive: boolean }) {
  const period = event.period ? parseInt(event.period, 10) : 0;
  const periodLabel = period <= 3 ? `${period}${period === 1 ? 'st' : period === 2 ? 'nd' : period === 3 ? 'rd' : 'th'}` :
    period === 4 ? 'OT' :
      period === 5 ? 'SO' : `${period - 3}OT`;

  if (!isLive && !event.period) return null;

  return (
    <div className="game-card-status hockey">
      <span className="game-card-period">{periodLabel}</span>
      {isLive && <span className="game-card-clock">{event.timeElapsed}</span>}
    </div>
  );
}

function SoccerStatus({ event, isLive }: { event: SportsEvent; isLive: boolean }) {
  if (!isLive && !event.timeElapsed) return null;

  return (
    <div className="game-card-status soccer">
      <span className="game-card-minute">{event.timeElapsed}</span>
    </div>
  );
}

function MMAStatus({ event, isLive }: { event: SportsEvent; isLive: boolean }) {
  if (!isLive) return null;

  return (
    <div className="game-card-status mma">
      <span className="game-card-round">Round {event.period || 1}</span>
    </div>
  );
}

function TennisStatus({ event, isLive }: { event: SportsEvent; isLive: boolean }) {
  if (!isLive) return null;

  return (
    <div className="game-card-status tennis">
      <span className="game-card-set">Set {event.period || 1}</span>
    </div>
  );
}

function DefaultStatus({ event, isLive }: { event: SportsEvent; isLive: boolean }) {
  if (!isLive) return null;

  return (
    <div className="game-card-status default">
      <span className="game-card-clock">{event.timeElapsed || 'In Progress'}</span>
    </div>
  );
}
