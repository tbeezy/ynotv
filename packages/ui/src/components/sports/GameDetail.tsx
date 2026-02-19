import { useState, useEffect } from 'react';
import type { SportsEvent } from '@ynotv/core';
import { 
  getGameSummary, 
  formatEventDateTime,
  type GameSummary,
  type PlayerStatCategory,
} from '../../services/sports';

interface GameDetailProps {
  event: SportsEvent;
  onClose: () => void;
  onChannelClick?: (channelName: string) => void;
}

type TabId = 'stats' | 'players' | 'scoring' | 'info';

export function GameDetail({ event, onClose, onChannelClick }: GameDetailProps) {
  const [summary, setSummary] = useState<GameSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>('stats');

  const isLive = event.status === 'live';
  const homeWinning = (event.homeScore ?? 0) > (event.awayScore ?? 0);
  const awayWinning = (event.awayScore ?? 0) > (event.homeScore ?? 0);

  useEffect(() => {
    const loadDetails = async () => {
      setLoading(true);
      try {
        const summaryData = await getGameSummary(event.id, event.league.id);
        setSummary(summaryData);
      } catch (err) {
        console.error('[GameDetail] Failed to load:', err);
      } finally {
        setLoading(false);
      }
    };

    loadDetails();
  }, [event.id, event.league.id]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  const renderStatsTab = () => {
    if (!summary) return null;

    const homeStats = summary.homeTeam.statistics || [];
    const awayStats = summary.awayTeam.statistics || [];

    if (homeStats.length === 0 && awayStats.length === 0) {
      return (
        <div className="game-detail-no-data">
          <span>Team statistics not available for this game.</span>
        </div>
      );
    }

    return (
      <div className="game-detail-stats">
        <table className="game-detail-stats-table">
          <thead>
            <tr>
              <th>{event.awayTeam.shortName || event.awayTeam.name}</th>
              <th>Stat</th>
              <th>{event.homeTeam.shortName || event.homeTeam.name}</th>
            </tr>
          </thead>
          <tbody>
            {homeStats.map((stat, idx) => {
              const awayStat = awayStats.find(s => s.label === stat.label);
              return (
                <tr key={idx}>
                  <td className="game-detail-stat-away">{awayStat?.displayValue || '-'}</td>
                  <td className="game-detail-stat-label">{stat.label}</td>
                  <td className="game-detail-stat-home">{stat.displayValue}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderPlayersTab = () => {
    if (!summary) return null;

    const homePlayerStats = summary.homeTeam.playerStats || [];
    const awayPlayerStats = summary.awayTeam.playerStats || [];

    if (homePlayerStats.length === 0 && awayPlayerStats.length === 0) {
      return (
        <div className="game-detail-no-data">
          <span>Player statistics not available for this game.</span>
        </div>
      );
    }

    const renderPlayerTable = (stats: PlayerStatCategory[], teamName: string, teamLogo?: string) => {
      if (stats.length === 0) return null;

      return (
        <div className="game-detail-players-team">
          <div className="game-detail-players-team-header">
            {teamLogo && (
              <img 
                src={teamLogo} 
                alt={teamName}
                className="game-detail-players-team-logo"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            )}
            <span className="game-detail-players-team-name">{teamName}</span>
          </div>
          {stats.map((category, catIdx) => (
            <div key={catIdx} className="game-detail-players-category">
              <h4 className="game-detail-players-category-title">{category.text}</h4>
              <div className="game-detail-players-table-wrapper">
                <table className="game-detail-players-table">
                  <thead>
                    <tr>
                      <th>Player</th>
                      {category.labels.map((label, idx) => (
                        <th key={idx} title={category.descriptions?.[idx]}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {category.athletes.map((athlete, aIdx) => (
                      <tr key={aIdx}>
                        <td className="game-detail-player-name">
                          {athlete.headshot && (
                            <img 
                              src={athlete.headshot} 
                              alt={athlete.name}
                              className="game-detail-player-headshot"
                              onError={(e) => { e.currentTarget.style.display = 'none'; }}
                            />
                          )}
                          <span>
                            {athlete.jersey && <span className="game-detail-player-jersey">#{athlete.jersey}</span>}
                            {athlete.name}
                          </span>
                        </td>
                        {athlete.stats.map((stat, sIdx) => (
                          <td key={sIdx}>{stat}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      );
    };

    return (
      <div className="game-detail-players">
        <div className="game-detail-players-grid">
          {renderPlayerTable(awayPlayerStats, event.awayTeam.name, event.awayTeam.logo)}
          {renderPlayerTable(homePlayerStats, event.homeTeam.name, event.homeTeam.logo)}
        </div>
      </div>
    );
  };

  const renderScoringTab = () => {
    if (!summary) return null;

    const scoringPlays = summary.scoringPlays || [];

    if (scoringPlays.length === 0) {
      return (
        <div className="game-detail-no-data">
          <span>No scoring plays available for this game.</span>
        </div>
      );
    }

    return (
      <div className="game-detail-scoring">
        {scoringPlays.map((play, idx) => {
          const isHomeScore = play.teamId === summary.homeTeam.id;
          const teamName = isHomeScore 
            ? (event.homeTeam.shortName || event.homeTeam.name)
            : (event.awayTeam.shortName || event.awayTeam.name);
          const teamLogo = isHomeScore ? event.homeTeam.logo : event.awayTeam.logo;

          return (
            <div key={play.id || idx} className={`game-detail-scoring-play ${isHomeScore ? 'home' : 'away'}`}>
              <div className="game-detail-scoring-header">
                <span className="game-detail-scoring-period">{play.period}</span>
                <span className="game-detail-scoring-clock">{play.clock}</span>
              </div>
              <div className="game-detail-scoring-content">
                {teamLogo && (
                  <img 
                    src={teamLogo} 
                    alt={teamName} 
                    className="game-detail-scoring-logo"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                )}
                <div className="game-detail-scoring-info">
                  <span className="game-detail-scoring-team">{teamName}</span>
                  <span className="game-detail-scoring-text">{play.text}</span>
                  {play.scoringType && (
                    <span className="game-detail-scoring-type">{play.scoringType}</span>
                  )}
                </div>
                <div className="game-detail-scoring-score">
                  <span className="game-detail-scoring-away-score">{play.awayScore}</span>
                  <span className="game-detail-scoring-score-divider">-</span>
                  <span className="game-detail-scoring-home-score">{play.homeScore}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderInfoTab = () => {
    if (!summary) return null;

    return (
      <div className="game-detail-info">
        {summary.venue && (
          <div className="game-detail-info-section">
            <h4>Venue</h4>
            <div className="game-detail-info-content">
              <span className="game-detail-info-venue-name">{summary.venue.name}</span>
              {summary.venue.city && (
                <span className="game-detail-info-venue-city">{summary.venue.city}</span>
              )}
            </div>
          </div>
        )}

        {summary.attendance && (
          <div className="game-detail-info-section">
            <h4>Attendance</h4>
            <span className="game-detail-info-attendance">
              {summary.attendance.toLocaleString()}
            </span>
          </div>
        )}

        {summary.officials && summary.officials.length > 0 && (
          <div className="game-detail-info-section">
            <h4>Officials</h4>
            <div className="game-detail-info-officials">
              {summary.officials.map((official, idx) => (
                <span key={idx} className="game-detail-info-official">{official}</span>
              ))}
            </div>
          </div>
        )}

        {summary.broadcasts && summary.broadcasts.length > 0 && (
          <div className="game-detail-info-section">
            <h4>Broadcast</h4>
            <div className="game-detail-info-broadcasts">
              {summary.broadcasts.map((broadcast, idx) => (
                <span key={idx} className="game-detail-info-broadcast">{broadcast}</span>
              ))}
            </div>
          </div>
        )}

        {event.channels.length > 0 && (
          <div className="game-detail-info-section">
            <h4>Watch On</h4>
            <div className="game-detail-channels">
              {event.channels.map((channel, idx) => (
                <button
                  key={idx}
                  className="game-detail-channel-btn"
                  onClick={() => onChannelClick?.(channel.name)}
                >
                  {channel.name}
                  {channel.country && <span className="game-detail-channel-country">{channel.country}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="game-detail-overlay" onClick={handleOverlayClick} onKeyDown={handleKeyDown}>
      <div className="game-detail-modal">
        <div className="game-detail-header">
          <div className="game-detail-header-info">
            <span className="game-detail-sport">{event.league.sport.toUpperCase()}</span>
            <span className="game-detail-league">{event.league.name}</span>
          </div>
          <button className="game-detail-close" onClick={onClose}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="game-detail-scoreboard">
          <div className="game-detail-team away">
            {event.awayTeam.logo && (
              <img 
                src={event.awayTeam.logo} 
                alt={event.awayTeam.name} 
                className="game-detail-team-logo"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            )}
            <div className="game-detail-team-info">
              <span className="game-detail-team-location">{event.awayTeam.shortName || ''}</span>
              <span className="game-detail-team-name">{event.awayTeam.name}</span>
              {summary?.awayTeam.record && (
                <span className="game-detail-team-record">{summary.awayTeam.record}</span>
              )}
            </div>
            <span className={`game-detail-score ${awayWinning ? 'winning' : ''}`}>
              {event.awayScore ?? 0}
            </span>
          </div>

          <div className="game-detail-status">
            {isLive ? (
              <div className="game-detail-live">
                <span className="game-detail-live-dot" />
                <span className="game-detail-live-text">{event.timeElapsed || 'LIVE'}</span>
                {event.period && <span className="game-detail-period">{event.period}</span>}
              </div>
            ) : (
              <div className="game-detail-scheduled">
                <span className="game-detail-datetime">{formatEventDateTime(event.startTime)}</span>
              </div>
            )}
            {event.venue && (
              <span className="game-detail-venue">{event.venue}</span>
            )}
          </div>

          <div className="game-detail-team home">
            {event.homeTeam.logo && (
              <img 
                src={event.homeTeam.logo} 
                alt={event.homeTeam.name} 
                className="game-detail-team-logo"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            )}
            <div className="game-detail-team-info">
              <span className="game-detail-team-location">{event.homeTeam.shortName || ''}</span>
              <span className="game-detail-team-name">{event.homeTeam.name}</span>
              {summary?.homeTeam.record && (
                <span className="game-detail-team-record">{summary.homeTeam.record}</span>
              )}
            </div>
            <span className={`game-detail-score ${homeWinning ? 'winning' : ''}`}>
              {event.homeScore ?? 0}
            </span>
          </div>
        </div>

        <div className="game-detail-tabs">
          <button 
            className={`game-detail-tab ${activeTab === 'stats' ? 'active' : ''}`}
            onClick={() => setActiveTab('stats')}
          >
            Team Stats
          </button>
          <button 
            className={`game-detail-tab ${activeTab === 'players' ? 'active' : ''}`}
            onClick={() => setActiveTab('players')}
          >
            Players
          </button>
          <button 
            className={`game-detail-tab ${activeTab === 'scoring' ? 'active' : ''}`}
            onClick={() => setActiveTab('scoring')}
          >
            Scoring Plays
          </button>
          <button 
            className={`game-detail-tab ${activeTab === 'info' ? 'active' : ''}`}
            onClick={() => setActiveTab('info')}
          >
            Game Info
          </button>
        </div>

        <div className="game-detail-content">
          {loading ? (
            <div className="game-detail-loading">
              <div className="game-detail-spinner" />
            </div>
          ) : activeTab === 'stats' ? (
            renderStatsTab()
          ) : activeTab === 'players' ? (
            renderPlayersTab()
          ) : activeTab === 'scoring' ? (
            renderScoringTab()
          ) : (
            renderInfoTab()
          )}
        </div>
      </div>
    </div>
  );
}
