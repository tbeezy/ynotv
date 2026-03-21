import type { SportsEvent } from '@ynotv/core';
import { formatEventTime } from '../../services/sports';
import './styles/GameCard.css';

/**
 * Known city/location prefixes used in major sports team names.
 * Multi-word prefixes (e.g. "St. Louis", "New York") must be listed before
 * single-word ones so they match greedily.
 */
const TEAM_CITY_PREFIXES: string[] = [
  // Multi-word US/Canada cities (must come first)
  'St. Louis', 'St Louis', 'New York', 'Los Angeles', 'San Francisco', 'San Diego',
  'San Jose', 'Kansas City', 'Oklahoma City', 'Salt Lake', 'New Orleans',
  'Las Vegas', 'Green Bay', 'Tampa Bay', 'Bay Area', 'Golden State',
  'New England', 'Carolina', 'Rhode Island',
  'Fort Worth', 'Fort Lauderdale', 'El Paso', 'San Antonio', 'Little Rock',
  'Baton Rouge', 'West Ham', 'Crystal Palace', 'Brighton', 'Sheffield',
  'Nottingham', 'Wolverhampton', 'Aston', 'Porto Alegre',
  'Porto', 'Real Madrid', 'Real Sociedad', 'Real Betis', 'Real Valladolid',
  'Atletico', 'Athletic',
  // Single-word US/Canada cities
  'Atlanta', 'Baltimore', 'Boston', 'Buffalo', 'Charlotte', 'Chicago',
  'Cincinnati', 'Cleveland', 'Colorado', 'Columbus', 'Dallas', 'Denver',
  'Detroit', 'Edmonton', 'Florida', 'Houston', 'Indiana', 'Jacksonville',
  'Louisville', 'Memphis', 'Miami', 'Milwaukee', 'Minnesota', 'Montreal',
  'Nashville', 'Newark', 'Oakland', 'Orlando', 'Ottawa', 'Philadelphia',
  'Phoenix', 'Pittsburgh', 'Portland', 'Sacramento', 'Seattle', 'Toronto',
  'Utah', 'Vancouver', 'Washington', 'Winnipeg', 'Arizona', 'Cincinnati',
  'Jacksonville', 'Tennessee', 'Mississippi', 'Alabama', 'Georgia', 'Oregon',
  // Soccer — Premier League / La Liga / Bundesliga / Serie A / Ligue 1 / etc.
  'Arsenal', 'Chelsea', 'Everton', 'Leicester', 'Liverpool', 'Fulham',
  'Brentford', 'Bournemouth', 'Burnley', 'Watford', 'Sunderland', 'Middlesbrough',
  'Bayern', 'Dortmund', 'Leverkusen', 'Leipzig', 'Frankfurt', 'Stuttgart',
  'Bremen', 'Hamburg', 'Freiburg', 'Augsburg', 'Wolfsburg', 'Mainz', 'Bochum',
  'Barcelona', 'Sevilla', 'Valencia', 'Villarreal', 'Bilbao', 'Getafe',
  'Girona', 'Alaves', 'Mallorca', 'Celta', 'Rayo', 'Osasuna', 'Cadiz',
  'Juventus', 'Napoli', 'Milan', 'Roma', 'Lazio', 'Atalanta', 'Fiorentina',
  'Torino', 'Udine', 'Monza', 'Bologna', 'Genoa', 'Lecce', 'Frosinone',
  'Paris', 'Lyon', 'Marseille', 'Lens', 'Lille', 'Monaco', 'Montpellier',
  'Toulouse', 'Nantes', 'Strasbourg', 'Reims', 'Rennes', 'Brest', 'Clermont',
  'Ajax', 'Feyenoord', 'Eindhoven', 'Bruges', 'Anderlecht', 'Lisbon', 'Benfica',
  'Sporting', 'Porto', 'Amsterdam', 'Galatasaray', 'Fenerbahce', 'Besiktas',
  'Flamengo', 'Palmeiras', 'Santos', 'Corinthians', 'Botafogo', 'Fluminense',
  'Gremio', 'Internacional',
  // International / club prefix words
  'Inter', 'Internazionale', 'Manchester', 'Tottenham', 'Blackburn', 'Blackpool',
  'Newcastle', 'Swindon', 'Coventry', 'Luton', 'Cambridge',
  'Rangers', 'Celtic', 'Aberdeen', 'Hibernian', 'Hearts',
];

// Sort longest-first so multi-word prefixes match before single-word
TEAM_CITY_PREFIXES.sort((a, b) => b.length - a.length);

/**
 * Strip a known city/location prefix from a team name, returning only the nickname.
 * Example: "St. Louis Cardinals" → "Cardinals"
 *          "New York Mets"       → "Mets"
 *          "Twins"               → "Twins" (no prefix to remove)
 */
function stripCityPrefix(name: string): string {
  const trimmed = name.trim();
  for (const city of TEAM_CITY_PREFIXES) {
    // Match case-insensitively at the start, followed by a space
    if (trimmed.toLowerCase().startsWith(city.toLowerCase() + ' ')) {
      const nickname = trimmed.slice(city.length).trim();
      if (nickname.length > 0) return nickname;
    }
  }
  return trimmed; // No known prefix found — use the full name
}

/** League IDs that use college/NCAA naming conventions (school name, not mascot). */
const NCAA_LEAGUE_IDS = new Set([
  'mens-college-basketball',
  'womens-college-basketball',
  'college-football',
  'college-baseball',
  'college-softball',
]);

/**
 * For NCAA/college teams, EPG channels list games by SCHOOL name, not mascot.
 * This strips the mascot (last word) and any parenthetical state qualifier.
 *
 * Examples:
 *   "Miami (OH) Redhawks"     → "Miami"
 *   "Tennessee Volunteers"    → "Tennessee"
 *   "Santa Clara Broncos"     → "Santa Clara"
 *   "UCF Knights"             → "UCF"
 *   "UCLA Bruins"             → "UCLA"
 *   "Kentucky Wildcats"       → "Kentucky"
 *   "Troy Trojans"            → "Troy"
 */
function stripMascotForCollege(name: string): string {
  // Remove parenthetical state qualifiers like "(OH)", "(FL)"
  // e.g. "Miami (OH) Redhawks" → "Miami  Redhawks" → (after trim) "Miami Redhawks"
  let cleaned = name.replace(/\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim();

  // Drop the last word (the mascot/nickname)
  const words = cleaned.split(/\s+/);
  if (words.length <= 1) return cleaned; // Single-word school name like "Tennessee"
  return words.slice(0, -1).join(' ');
}

/**
 * Build a search query based on the league type:
 * - NCAA/college: search by school name (strip mascot)
 *   "Tennessee Volunteers" + "Santa Clara Broncos" → "Tennessee Santa Clara"
 * - Pro sports: search by team nickname (strip city prefix)
 *   "St. Louis Cardinals" + "New York Mets" → "Cardinals Mets"
 */
function buildTeamSearchQuery(homeTeam: string, awayTeam: string, leagueId?: string): string {
  if (leagueId && NCAA_LEAGUE_IDS.has(leagueId)) {
    return `${stripMascotForCollege(homeTeam)} ${stripMascotForCollege(awayTeam)}`;
  }
  return `${stripCityPrefix(homeTeam)} ${stripCityPrefix(awayTeam)}`;
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
                const query = buildTeamSearchQuery(
                  event.homeTeam.name,
                  event.awayTeam.name,
                  event.league.id,
                );
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
