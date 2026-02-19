import { useState, useEffect, useCallback } from 'react';
import type { SportsEvent, SportsLeague, SportsTeam } from '@ynotv/core';
import {
  getAvailableLeagues,
  getLeagueEvents,
  getLeagueTeams,
  getLeagueStandings,
  getLeagueStandingsGrouped,
  getUFCRankings,
  type StandingTeam,
  type StandingGroup,
  type UFCWeightClassRanking,
  formatEventTime,
} from '../../services/sports';
import { TeamDetail } from './TeamDetail';
import { GameDetail } from './GameDetail';

interface LeaguesTabProps {
  onSearchChannels?: (channelName: string) => void;
}

type LeagueView = 'teams' | 'schedule' | 'standings';

// Sports that are individual (no teams)
const INDIVIDUAL_SPORTS = ['ufc', 'pga', 'lpga', 'atp', 'wta', 'f1', 'nascar', 'indycar'];

export function LeaguesTab({ onSearchChannels }: LeaguesTabProps) {
  const [leagues, setLeagues] = useState<SportsLeague[]>([]);
  const [selectedLeague, setSelectedLeague] = useState<SportsLeague | null>(null);
  const [leagueEvents, setLeagueEvents] = useState<SportsEvent[]>([]);
  const [leagueTeams, setLeagueTeams] = useState<SportsTeam[]>([]);
  const [leagueStandings, setLeagueStandings] = useState<StandingTeam[]>([]);
  const [leagueStandingsGroups, setLeagueStandingsGroups] = useState<StandingGroup[]>([]);
  const [ufcRankings, setUfcRankings] = useState<UFCWeightClassRanking[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeView, setActiveView] = useState<LeagueView>('teams');
  const [selectedTeam, setSelectedTeam] = useState<SportsTeam | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<SportsEvent | null>(null);

  const isUFC = selectedLeague?.id === 'ufc';
  const isIndividualSport = selectedLeague ? INDIVIDUAL_SPORTS.includes(selectedLeague.id) : false;

  useEffect(() => {
    const allLeagues = getAvailableLeagues();
    setLeagues(allLeagues);
  }, []);

  useEffect(() => {
    if (selectedLeague) {
      setLoading(true);
      // For individual sports, default to schedule (events)
      setActiveView(isIndividualSport ? 'schedule' : 'teams');
      
      if (isIndividualSport) {
        // Load events for individual sports
        getLeagueEvents(selectedLeague.id)
          .then(setLeagueEvents)
          .finally(() => setLoading(false));
      } else {
        getLeagueTeams(selectedLeague.id)
          .then(setLeagueTeams)
          .finally(() => setLoading(false));
      }
    }
  }, [selectedLeague, isIndividualSport]);

  const handleViewChange = useCallback(async (view: LeagueView) => {
    if (!selectedLeague) return;
    
    setActiveView(view);
    setLoading(true);

    try {
      if (view === 'schedule') {
        const events = await getLeagueEvents(selectedLeague.id);
        setLeagueEvents(events);
      } else if (view === 'standings') {
        if (isIndividualSport) {
          // For individual sports, load rankings instead of standings
          const rankings = await getUFCRankings();
          setUfcRankings(rankings);
        } else {
          const groups = await getLeagueStandingsGrouped(selectedLeague.id);
          setLeagueStandingsGroups(groups);
          setLeagueStandings(groups.flatMap(g => g.teams));
        }
      }
    } finally {
      setLoading(false);
    }
  }, [selectedLeague, isIndividualSport]);

  const handleChannelClick = (channelName: string) => {
    if (onSearchChannels) {
      onSearchChannels(channelName);
    }
  };

  if (selectedTeam) {
    return (
      <TeamDetail
        team={selectedTeam}
        onClose={() => setSelectedTeam(null)}
        onChannelClick={handleChannelClick}
      />
    );
  }

  if (selectedEvent) {
    return (
      <>
        <LeagueDetail
          league={selectedLeague!}
          teams={leagueTeams}
          events={leagueEvents}
          standings={leagueStandings}
          standingsGroups={leagueStandingsGroups}
          ufcRankings={ufcRankings}
          loading={loading}
          activeView={activeView}
          onViewChange={handleViewChange}
          onClose={() => {
            setSelectedLeague(null);
            setLeagueTeams([]);
            setLeagueEvents([]);
            setLeagueStandings([]);
            setLeagueStandingsGroups([]);
            setUfcRankings([]);
          }}
          onTeamSelect={setSelectedTeam}
          onChannelClick={handleChannelClick}
          onEventSelect={setSelectedEvent}
        />
        <GameDetail
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
          onChannelClick={handleChannelClick}
        />
      </>
    );
  }

  if (selectedLeague) {
    return (
      <LeagueDetail
        league={selectedLeague}
        teams={leagueTeams}
        events={leagueEvents}
        standings={leagueStandings}
        standingsGroups={leagueStandingsGroups}
        ufcRankings={ufcRankings}
        loading={loading}
        activeView={activeView}
        onViewChange={handleViewChange}
        onClose={() => {
          setSelectedLeague(null);
          setLeagueTeams([]);
          setLeagueEvents([]);
          setLeagueStandings([]);
          setLeagueStandingsGroups([]);
          setUfcRankings([]);
        }}
        onTeamSelect={setSelectedTeam}
        onChannelClick={handleChannelClick}
        onEventSelect={setSelectedEvent}
      />
    );
  }

  const groupedLeagues = leagues.reduce((acc, league) => {
    const sport = league.sport || 'Other';
    if (!acc[sport]) acc[sport] = [];
    acc[sport].push(league);
    return acc;
  }, {} as Record<string, SportsLeague[]>);

  const sportOrder = ['football', 'basketball', 'baseball', 'hockey', 'soccer'];

  return (
    <div className="sports-tab-content">
      {Object.entries(groupedLeagues)
        .sort(([a], [b]) => {
          const aIdx = sportOrder.indexOf(a);
          const bIdx = sportOrder.indexOf(b);
          return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
        })
        .map(([sport, sportLeagues]) => (
          <section key={sport} className="sports-section">
            <h2 className="sports-section-title">
              {sport.charAt(0).toUpperCase() + sport.slice(1)}
            </h2>
            <div className="sports-leagues-grid">
              {sportLeagues.map((league) => (
                <button
                  key={league.id}
                  className="sports-league-card"
                  onClick={() => setSelectedLeague(league)}
                >
                  <div className="sports-league-card-info">
                    <span className="sports-league-card-name">{league.name}</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}

interface LeagueDetailProps {
  league: SportsLeague;
  teams: SportsTeam[];
  events: SportsEvent[];
  standings: StandingTeam[];
  standingsGroups: StandingGroup[];
  ufcRankings: UFCWeightClassRanking[];
  loading: boolean;
  activeView: LeagueView;
  onViewChange: (view: LeagueView) => void;
  onClose: () => void;
  onTeamSelect: (team: SportsTeam) => void;
  onChannelClick?: (channelName: string) => void;
  onEventSelect?: (event: SportsEvent) => void;
}

function LeagueDetail({
  league,
  teams,
  events,
  standings,
  standingsGroups,
  ufcRankings,
  loading,
  activeView,
  onViewChange,
  onClose,
  onTeamSelect,
  onChannelClick,
  onEventSelect,
}: LeagueDetailProps) {
  const isUFC = league.id === 'ufc';
  const isIndividualSport = INDIVIDUAL_SPORTS.includes(league.id);

  return (
    <div className="sports-tab-content">
      <div className="sports-league-header">
        <button className="sports-back-link" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Back to Leagues
        </button>
        <div className="sports-league-info">
          <div>
            <h2 className="sports-league-detail-name">{league.name}</h2>
            <span className="sports-league-detail-sport">{league.sport}</span>
          </div>
        </div>
      </div>

      <div className="sports-league-nav">
        {!isIndividualSport && (
          <button
            className={`sports-league-nav-btn ${activeView === 'teams' ? 'active' : ''}`}
            onClick={() => onViewChange('teams')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            Teams
          </button>
        )}
        <button
          className={`sports-league-nav-btn ${activeView === 'schedule' ? 'active' : ''}`}
          onClick={() => onViewChange('schedule')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          {isIndividualSport ? 'Events' : 'Schedule'}
        </button>
        <button
          className={`sports-league-nav-btn ${activeView === 'standings' ? 'active' : ''}`}
          onClick={() => onViewChange('standings')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
          {isIndividualSport ? 'Rankings' : 'Standings'}
        </button>
      </div>

      {loading ? (
        <div className="sports-loading">
          <div className="sports-spinner" />
          <span>Loading...</span>
        </div>
      ) : (
        <>
          {activeView === 'teams' && (
            <section className="sports-section">
              <h3 className="sports-section-title">All Teams ({teams.length})</h3>
              <div className="sports-teams-grid">
                {teams.map((team) => (
                  <button
                    key={team.id}
                    className="sports-team-card"
                    onClick={() => onTeamSelect(team)}
                  >
                    {team.logo && (
                      <img src={team.logo} alt={team.name} className="sports-team-card-logo" />
                    )}
                    <div className="sports-team-card-info">
                      <span className="sports-team-card-name">{team.name}</span>
                      {team.shortName && (
                        <span className="sports-team-card-country">{team.shortName}</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {activeView === 'schedule' && (
            <section className="sports-section">
              <h3 className="sports-section-title">
                {isIndividualSport ? 'Tournaments & Events' : 'Games'}
              </h3>
              {events.length > 0 ? (
                <div className="sports-events-list">
                  {events.slice(0, 20).map(event => (
                    <LeagueEventRow
                      key={event.id}
                      event={event}
                      onChannelClick={onChannelClick}
                      onClick={() => onEventSelect?.(event)}
                    />
                  ))}
                </div>
              ) : (
                <div className="sports-empty">
                  <p>No events scheduled</p>
                </div>
              )}
            </section>
          )}

          {activeView === 'standings' && !isIndividualSport && (
            <section className="sports-section">
              <h3 className="sports-section-title">Standings</h3>
              {standingsGroups.length > 0 ? (
                <div className="sports-standings-groups">
                  {standingsGroups.map((group) => (
                    <div key={group.name} className="sports-standings-group">
                      {group.isConference && (
                        <h4 className="sports-standings-conference">{group.name}</h4>
                      )}
                      <div className="sports-standings-table">
                        <div className="sports-standings-header">
                          <span>#</span>
                          <span>Team</span>
                          <span>W</span>
                          <span>L</span>
                          <span>PCT</span>
                        </div>
                        {group.teams.map((team) => (
                          <div key={team.id} className="sports-standings-row">
                            <span>{team.rank}</span>
                            <span className="sports-standings-team">
                              {team.logo && (
                                <img src={team.logo} alt="" className="sports-standings-logo" />
                              )}
                              {team.name}
                            </span>
                            <span>{team.wins}</span>
                            <span>{team.losses}</span>
                            <span>{team.winPercent}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : standings.length > 0 ? (
                <div className="sports-standings-table">
                  <div className="sports-standings-header">
                    <span>#</span>
                    <span>Team</span>
                    <span>W</span>
                    <span>L</span>
                    <span>PCT</span>
                  </div>
                  {standings.map((team, idx) => (
                    <div key={team.id} className="sports-standings-row">
                      <span>{idx + 1}</span>
                      <span className="sports-standings-team">
                        {team.logo && (
                          <img src={team.logo} alt="" className="sports-standings-logo" />
                        )}
                        {team.name}
                      </span>
                      <span>{team.wins}</span>
                      <span>{team.losses}</span>
                      <span>{team.winPercent}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="sports-empty">
                  <p>Standings not available</p>
                </div>
              )}
            </section>
          )}

          {activeView === 'standings' && isIndividualSport && (
            <section className="sports-section">
              <h3 className="sports-section-title">
                {isUFC ? 'Weight Class Rankings' : 'Rankings'}
              </h3>
              {ufcRankings.length > 0 ? (
                <div className="ufc-rankings-grid">
                  {ufcRankings.map((division) => (
                    <div key={division.weightClass} className="ufc-ranking-card">
                      <h4 className="ufc-ranking-division">{division.weightClass}</h4>
                      {division.champion && (
                        <div className="ufc-ranking-champion">
                          <span className="ufc-ranking-champion-label">Champion</span>
                          <div className="ufc-ranking-fighter">
                            {division.champion.headshot && (
                              <img src={division.champion.headshot} alt={division.champion.name} className="ufc-ranking-headshot" />
                            )}
                            <div className="ufc-ranking-fighter-info">
                              <span className="ufc-ranking-fighter-name">{division.champion.name}</span>
                              {division.champion.record && (
                                <span className="ufc-ranking-fighter-record">{division.champion.record}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                      {division.rankedFighters.length > 0 && (
                        <div className="ufc-ranking-list">
                          {division.rankedFighters.slice(0, 5).map((fighter) => (
                            <div key={fighter.id} className="ufc-ranking-row">
                              <span className="ufc-ranking-rank">#{fighter.rank}</span>
                              {fighter.headshot && (
                                <img src={fighter.headshot} alt={fighter.name} className="ufc-ranking-headshot-small" />
                              )}
                              <span className="ufc-ranking-fighter-name">{fighter.name}</span>
                              {fighter.record && (
                                <span className="ufc-ranking-fighter-record">{fighter.record}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {division.rankedFighters.length === 0 && !division.champion && (
                        <div className="ufc-ranking-empty">
                          <span>No rankings available</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="sports-empty">
                  <p>Rankings not available</p>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

interface LeagueEventRowProps {
  event: SportsEvent;
  onChannelClick?: (channelName: string) => void;
  onClick?: () => void;
}

function LeagueEventRow({ event, onChannelClick, onClick }: LeagueEventRowProps) {
  const isLive = event.status === 'live';
  const isFinished = event.status === 'finished';
  const homeWinning = (event.homeScore ?? 0) > (event.awayScore ?? 0);
  const awayWinning = (event.awayScore ?? 0) > (event.homeScore ?? 0);

  return (
    <div className="sports-event-row" onClick={onClick}>
      <div className="sports-event-row-time">
        <span className="sports-event-date">
          {event.startTime.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
        </span>
        <span className="sports-event-time">
          {event.startTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      <div className="sports-event-row-match">
        <div className={`sports-event-team away ${isFinished && awayWinning ? 'winner' : ''}`}>
          {event.awayTeam.logo && (
            <img src={event.awayTeam.logo} alt="" className="sports-team-logo-small" />
          )}
          <span className="sports-event-team-name">{event.awayTeam.shortName || event.awayTeam.name}</span>
          {event.awayScore !== undefined && (
            <span className="sports-score-inline">{event.awayScore}</span>
          )}
        </div>
        <div className="sports-event-row-divider">
          {isLive ? (
            <span className="sports-event-live-badge">
              <span className="sports-event-live-dot" />
              {event.period || event.timeElapsed || 'LIVE'}
            </span>
          ) : (
            <span className="sports-event-vs">vs</span>
          )}
        </div>
        <div className={`sports-event-team home ${isFinished && homeWinning ? 'winner' : ''}`}>
          {event.homeTeam.logo && (
            <img src={event.homeTeam.logo} alt="" className="sports-team-logo-small" />
          )}
          <span className="sports-event-team-name">{event.homeTeam.shortName || event.homeTeam.name}</span>
          {event.homeScore !== undefined && (
            <span className="sports-score-inline">{event.homeScore}</span>
          )}
        </div>
      </div>

      <div className="sports-event-row-status">
        {isLive && (
          <span className="sports-event-status-live">Live</span>
        )}
        {isFinished && (
          <span className="sports-event-status-final">Final</span>
        )}
      </div>

      <div className="sports-event-row-channels">
        {event.channels.length > 0 ? (
          <button
            className="sports-channel-btn-small"
            onClick={(e) => {
              e.stopPropagation();
              onChannelClick?.(event.channels[0].name);
            }}
          >
            {event.channels[0].name}
          </button>
        ) : (
          <span className="sports-no-channel">-</span>
        )}
      </div>
    </div>
  );
}

export default LeaguesTab;
