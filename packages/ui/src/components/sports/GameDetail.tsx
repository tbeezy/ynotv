import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { SportsEvent } from '@ynotv/core';
import {
  getGameSummary,
  formatEventDateTime,
  type GameSummary,
  type PlayerStatCategory,
} from '../../services/sports';
import { useEpgClockFormat } from '../../stores/uiStore';
import { useTranslation } from 'react-i18next';
import { activeLocale } from '../../utils/dateTime';
import i18n from '../../i18n';

interface GameDetailProps {
  event: SportsEvent;
  onClose: () => void;
  onChannelClick?: (channelName: string) => void;
  onPlayChannel?: (channel: import('../../db').StoredChannel) => void;
  variant?: 'default' | 'glass';
}

type TabId = 'stats' | 'players' | 'scoring' | 'info';

export function GameDetail({ event, onClose, onChannelClick, onPlayChannel, variant = 'default' }: GameDetailProps) {
  const epgClockFormat = useEpgClockFormat();
  useTranslation();
  const [summary, setSummary] = useState<GameSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>('stats');
  const [playerTeamTab, setPlayerTeamTab] = useState<'away' | 'home'>('away');
  const contentRef = useRef<HTMLDivElement>(null);

  const handleSelectPlayerTeam = (team: 'away' | 'home') => {
    setPlayerTeamTab(team);
    if (contentRef.current) {
      contentRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const isLive = event.status === 'live';
  const homeWinning = (event.homeScore ?? 0) > (event.awayScore ?? 0);
  const awayWinning = (event.awayScore ?? 0) > (event.homeScore ?? 0);
  const isUFC = event.league.id === 'ufc' && !!event.matches;
  const isRacing = (event.league.id === 'f1' || event.league.id === 'nascar' || event.league.id === 'indycar') && !!event.matches;
  const isGolf = (event.league.id === 'pga' || event.league.id === 'lpga') && !!event.matches;
  const isTennis = (event.league.id === 'atp' || event.league.id === 'wta') && !!event.matches;
  const isRugby = event.league.sport === 'rugby';

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
          <span>{i18n.t('sports:teamStatsUnavailable')}</span>
        </div>
      );
    }

    return (
      <div className="game-detail-stats">
        <table className="game-detail-stats-table">
          <thead>
            <tr>
              <th>{event.awayTeam.shortName || event.awayTeam.name}</th>
              <th>{i18n.t('sports:stat')}</th>
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

  // Auto-select team with stats if one team has none
  const getEffectivePlayerTeamTab = (): 'away' | 'home' => {
    if (!summary) return playerTeamTab;
    const homePlayerStats = summary.homeTeam.playerStats || [];
    const awayPlayerStats = summary.awayTeam.playerStats || [];
    if (playerTeamTab === 'away' && awayPlayerStats.length === 0 && homePlayerStats.length > 0) return 'home';
    if (playerTeamTab === 'home' && homePlayerStats.length === 0 && awayPlayerStats.length > 0) return 'away';
    return playerTeamTab;
  };

  // Team sub-tab bar — rendered OUTSIDE the scrollable content area (like the
  // main tab row) so it spans the full modal width and stays pinned above the
  // tables while they scroll, instead of being overlapped by them.
  const renderPlayerTeamTabs = () => {
    if (!summary) return null;
    const homePlayerStats = summary.homeTeam.playerStats || [];
    const awayPlayerStats = summary.awayTeam.playerStats || [];
    if (homePlayerStats.length === 0 && awayPlayerStats.length === 0) return null;

    const effectiveTeamTab = getEffectivePlayerTeamTab();

    return (
      <div className="game-detail-players-team-tabs">
        <button
          className={`game-detail-players-tab-btn ${effectiveTeamTab === 'away' ? 'active' : ''} ${awayPlayerStats.length === 0 ? 'disabled' : ''}`}
          onClick={() => handleSelectPlayerTeam('away')}
          disabled={awayPlayerStats.length === 0}
        >
          {event.awayTeam.logo ? (
            <img
              src={event.awayTeam.logo}
              alt=""
              className="game-detail-players-tab-logo"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          ) : (
            <div className="game-detail-players-tab-logo-placeholder">
              {event.awayTeam.name.slice(0, 2).toUpperCase()}
            </div>
          )}
          <span className="game-detail-players-tab-name">
            {event.awayTeam.name}
          </span>
        </button>

        <button
          className={`game-detail-players-tab-btn ${effectiveTeamTab === 'home' ? 'active' : ''} ${homePlayerStats.length === 0 ? 'disabled' : ''}`}
          onClick={() => handleSelectPlayerTeam('home')}
          disabled={homePlayerStats.length === 0}
        >
          {event.homeTeam.logo ? (
            <img
              src={event.homeTeam.logo}
              alt=""
              className="game-detail-players-tab-logo"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          ) : (
            <div className="game-detail-players-tab-logo-placeholder">
              {event.homeTeam.name.slice(0, 2).toUpperCase()}
            </div>
          )}
          <span className="game-detail-players-tab-name">
            {event.homeTeam.name}
          </span>
        </button>
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
          <span>{i18n.t('sports:playerStatsUnavailable')}</span>
        </div>
      );
    }

    const effectiveTeamTab = getEffectivePlayerTeamTab();

    const renderPlayerTable = (stats: PlayerStatCategory[], teamName: string, teamLogo?: string) => {
      if (stats.length === 0) {
        return (
          <div className="game-detail-no-data">
            <span>{i18n.t('sports:playerStatsUnavailable')}</span>
          </div>
        );
      }

      return (
        <div className="game-detail-players-team">
          {stats.map((category, catIdx) => (
            <div key={catIdx} className="game-detail-players-category">
              <h4 className="game-detail-players-category-title">{category.text}</h4>
              <div className="game-detail-players-table-wrapper">
                <table className="game-detail-players-table">
                  <thead>
                    <tr>
                      <th>{i18n.t('sports:player')}</th>
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
        <div className="game-detail-players-content">
          {effectiveTeamTab === 'away' && (
            renderPlayerTable(awayPlayerStats, event.awayTeam.name, event.awayTeam.logo)
          )}
          {effectiveTeamTab === 'home' && (
            renderPlayerTable(homePlayerStats, event.homeTeam.name, event.homeTeam.logo)
          )}
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
          <span>{i18n.t('sports:noScoringPlays')}</span>
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
            <h4>{i18n.t('sports:venue')}</h4>
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
            <h4>{i18n.t('sports:attendance')}</h4>
            <span className="game-detail-info-attendance">
              {summary.attendance.toLocaleString(activeLocale())}
            </span>
          </div>
        )}

        {summary.officials && summary.officials.length > 0 && (
          <div className="game-detail-info-section">
            <h4>{i18n.t('sports:officials')}</h4>
            <div className="game-detail-info-officials">
              {summary.officials.map((official, idx) => (
                <span key={idx} className="game-detail-info-official">{official}</span>
              ))}
            </div>
          </div>
        )}

        {summary.broadcasts && summary.broadcasts.length > 0 && (
          <div className="game-detail-info-section">
            <h4>{i18n.t('sports:broadcast')}</h4>
            <div className="game-detail-info-broadcasts">
              {summary.broadcasts.map((broadcast, idx) => (
                <span key={idx} className="game-detail-info-broadcast">{broadcast}</span>
              ))}
            </div>
          </div>
        )}

        {event.channels.length > 0 && (
          <div className="game-detail-info-section">
            <h4>{i18n.t('sports:watchOn')}</h4>
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

  const renderRugbyDetail = () => {
    const [rugbyTab, setRugbyTab] = useState<'timeline' | 'lineups' | 'info'>('timeline');
    const matchEvents = summary?.matchEvents || [];

    const getEventIcon = (type: string) => {
      const t = type.toLowerCase();
      if (t.includes('try')) return '🏉';
      if (t.includes('conversion')) return '✓';
      if (t.includes('penalty')) return '🥅';
      if (t.includes('drop')) return '⬇️';
      if (t.includes('yellow')) return '🟨';
      if (t.includes('red')) return '🟥';
      if (t.includes('substitut')) return '↔️';
      return '•';
    };

    const getEventClass = (type: string) => {
      const t = type.toLowerCase();
      if (t.includes('try')) return 'rugby-event-try';
      if (t.includes('conversion')) return 'rugby-event-conversion';
      if (t.includes('penalty')) return 'rugby-event-penalty';
      if (t.includes('drop')) return 'rugby-event-drop';
      if (t.includes('yellow')) return 'rugby-event-yellow';
      if (t.includes('red')) return 'rugby-event-red';
      if (t.includes('substitut')) return 'rugby-event-sub';
      return 'rugby-event-other';
    };

    const renderTimeline = () => {
      if (matchEvents.length === 0) {
        return (
          <div className="game-detail-no-data">
            <span>{i18n.t('sports:matchEventsUnavailable')}</span>
          </div>
        );
      }

      return (
        <div className="rugby-timeline">
          {matchEvents.map((ev) => {
            const isHome = ev.teamId === event.homeTeam.id;
            const teamName = isHome ? event.homeTeam.name : event.awayTeam.name;
            const teamLogo = isHome ? event.homeTeam.logo : event.awayTeam.logo;

            return (
              <div key={ev.id} className={`rugby-timeline-event ${getEventClass(ev.type)} ${isHome ? 'home' : 'away'}`}>
                <div className="rugby-timeline-left">
                  <span className="rugby-timeline-clock">{ev.clock}</span>
                  {ev.period && <span className="rugby-timeline-period">{ev.period}</span>}
                </div>
                <div className="rugby-timeline-marker">
                  <span className="rugby-timeline-icon">{getEventIcon(ev.type)}</span>
                </div>
                <div className="rugby-timeline-body">
                  <div className="rugby-timeline-text">
                    {teamLogo && (
                      <img src={teamLogo} alt={teamName} className="rugby-timeline-logo" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                    )}
                    <span className="rugby-timeline-desc">{ev.text}</span>
                  </div>
                </div>
                <div className="rugby-timeline-score">
                  <span>{ev.awayScore}</span>
                  <span className="rugby-timeline-score-div">-</span>
                  <span>{ev.homeScore}</span>
                </div>
              </div>
            );
          })}
        </div>
      );
    };

    const renderLineups = () => {
      const homeStats = summary?.homeTeam.playerStats || [];
      const awayStats = summary?.awayTeam.playerStats || [];

      if (homeStats.length === 0 && awayStats.length === 0) {
        return (
          <div className="game-detail-no-data">
            <span>{i18n.t('sports:lineupsUnavailable')}</span>
          </div>
        );
      }

      const renderTeamLineup = (categories: typeof homeStats, teamName: string, teamLogo?: string) => {
        if (categories.length === 0) return null;
        return (
          <div className="rugby-lineup-team">
            <div className="rugby-lineup-header">
              {teamLogo && <img src={teamLogo} alt={teamName} className="rugby-lineup-logo" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
              <span className="rugby-lineup-name">{teamName}</span>
            </div>
            {categories.map((cat, idx) => (
              <div key={idx} className="rugby-lineup-category">
                <h4 className="rugby-lineup-category-title">{cat.text}</h4>
                <div className="rugby-lineup-players">
                  {cat.athletes.map((a, aIdx) => (
                    <div key={aIdx} className="rugby-lineup-player">
                      {a.headshot && <img src={a.headshot} alt={a.name} className="rugby-lineup-headshot" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                      <span className="rugby-lineup-player-name">{a.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        );
      };

      return (
        <div className="rugby-lineups">
          {renderTeamLineup(awayStats, event.awayTeam.name, event.awayTeam.logo)}
          {renderTeamLineup(homeStats, event.homeTeam.name, event.homeTeam.logo)}
        </div>
      );
    };

    const renderRugbyInfo = () => {
      return (
        <div className="game-detail-info">
          {summary?.venue && (
            <div className="game-detail-info-section">
              <h4>{i18n.t('sports:venue')}</h4>
              <div className="game-detail-info-content">
                <span className="game-detail-info-venue-name">{summary.venue.name}</span>
                {summary.venue.city && <span className="game-detail-info-venue-city">{summary.venue.city}</span>}
              </div>
            </div>
          )}
          {summary?.attendance !== undefined && summary.attendance > 0 && (
            <div className="game-detail-info-section">
              <h4>{i18n.t('sports:attendance')}</h4>
              <span className="game-detail-info-attendance">{summary.attendance.toLocaleString(activeLocale())}</span>
            </div>
          )}
          {summary?.officials && summary.officials.length > 0 && (
            <div className="game-detail-info-section">
              <h4>{i18n.t('sports:officials')}</h4>
              <div className="game-detail-info-officials">
                {summary.officials.map((o, i) => <span key={i} className="game-detail-info-official">{o}</span>)}
              </div>
            </div>
          )}
          {event.channels.length > 0 && (
            <div className="game-detail-info-section">
              <h4>{i18n.t('sports:watchOn')}</h4>
              <div className="game-detail-channels">
                {event.channels.map((ch, i) => (
                  <button key={i} className="game-detail-channel-btn" onClick={() => onChannelClick?.(ch.name)}>
                    {ch.name}
                    {ch.country && <span className="game-detail-channel-country">{ch.country}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    };

    return (
      <div className={`game-detail-overlay${variant === 'glass' ? ' glass' : ''}`} onClick={handleOverlayClick} onKeyDown={handleKeyDown}>
        <div className={`game-detail-modal rugby-detail-modal${variant === 'glass' ? ' glass' : ''}`}>
          {/* Header */}
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

          {/* Scoreboard */}
          <div className="game-detail-scoreboard">
            <div className="game-detail-team away">
              {event.awayTeam.logo && (
                <img src={event.awayTeam.logo} alt={event.awayTeam.name} className="game-detail-team-logo" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
              )}
              <div className="game-detail-team-info">
                <span className="game-detail-team-name">{event.awayTeam.name}</span>
              </div>
              <span className={`game-detail-score ${awayWinning ? 'winning' : ''}`}>{event.awayScore ?? 0}</span>
            </div>
            <div className="game-detail-status">
              {isLive ? (
                <div className="game-detail-live">
                  <span className="game-detail-live-dot" />
                  <span className="game-detail-live-text">{event.timeElapsed || i18n.t('sports:statusLive')}</span>
                </div>
              ) : (
                <span className="game-detail-datetime">{formatEventDateTime(event.startTime, epgClockFormat !== '24h')}</span>
              )}
              {event.venue && <span className="game-detail-venue">{event.venue}</span>}
            </div>
            <div className="game-detail-team home">
              {event.homeTeam.logo && (
                <img src={event.homeTeam.logo} alt={event.homeTeam.name} className="game-detail-team-logo" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
              )}
              <div className="game-detail-team-info">
                <span className="game-detail-team-name">{event.homeTeam.name}</span>
              </div>
              <span className={`game-detail-score ${homeWinning ? 'winning' : ''}`}>{event.homeScore ?? 0}</span>
            </div>
          </div>

          {/* Tabs */}
          <div className="game-detail-tabs">
            <button className={`game-detail-tab ${rugbyTab === 'timeline' ? 'active' : ''}`} onClick={() => setRugbyTab('timeline')}>
              Timeline
            </button>
            <button className={`game-detail-tab ${rugbyTab === 'lineups' ? 'active' : ''}`} onClick={() => setRugbyTab('lineups')}>
              Lineups
            </button>
            <button className={`game-detail-tab ${rugbyTab === 'info' ? 'active' : ''}`} onClick={() => setRugbyTab('info')}>
              Info
            </button>
          </div>

          <div className="game-detail-content">
            {loading ? (
              <div className="game-detail-loading"><div className="game-detail-spinner" /></div>
            ) : rugbyTab === 'timeline' ? (
              renderTimeline()
            ) : rugbyTab === 'lineups' ? (
              renderLineups()
            ) : (
              renderRugbyInfo()
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderUFCDetail = () => {
    const mainEvent = event.matches?.[event.matches.length - 1];

    return (
      <div className={`game-detail-overlay${variant === 'glass' ? ' glass' : ''}`} onClick={handleOverlayClick} onKeyDown={handleKeyDown}>
        <div className={`game-detail-modal ufc-detail-modal${variant === 'glass' ? ' glass' : ''}`}>
          {/* Header */}
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

          {/* Event Title */}
          <div className="ufc-detail-title-bar">
            <h2 className="ufc-detail-event-title">{event.title}</h2>
            <div className="ufc-detail-meta">
              {isLive && (
                <span className="ufc-detail-live-badge">
                  <span className="ufc-detail-live-dot" />
                  LIVE
                </span>
              )}
              <span className="ufc-detail-datetime">{formatEventDateTime(event.startTime, epgClockFormat !== '24h')}</span>
              {event.venue && <span className="ufc-detail-venue">{event.venue}</span>}
            </div>
          </div>

          {/* Main Event */}
          {mainEvent && (
            <div className="ufc-detail-main-event">
              <div className="ufc-detail-fighter away">
                {event.awayTeam.logo && (
                  <img src={event.awayTeam.logo} alt={event.awayTeam.name} className="ufc-detail-fighter-img" />
                )}
                <span className="ufc-detail-fighter-name">{event.awayTeam.name}</span>
                {mainEvent.awayRecord && (
                  <span className="ufc-detail-fighter-record">{mainEvent.awayRecord}</span>
                )}
              </div>
              <div className="ufc-detail-main-vs">
                <span className="ufc-detail-vs-text">VS</span>
                {mainEvent.subtitle && (
                  <span className="ufc-detail-weight-class">{mainEvent.subtitle}</span>
                )}
              </div>
              <div className="ufc-detail-fighter home">
                {event.homeTeam.logo && (
                  <img src={event.homeTeam.logo} alt={event.homeTeam.name} className="ufc-detail-fighter-img" />
                )}
                <span className="ufc-detail-fighter-name">{event.homeTeam.name}</span>
                {mainEvent.homeRecord && (
                  <span className="ufc-detail-fighter-record">{mainEvent.homeRecord}</span>
                )}
              </div>
            </div>
          )}

          {/* Fight Card */}
          <div className="ufc-detail-content">
            <h3 className="ufc-detail-section-title">{i18n.t('sports:fightCard')}</h3>
            <div className="ufc-detail-card-list">
              {event.matches?.map((match, idx) => {
                const isMainEvent = idx === (event.matches?.length || 0) - 1;
                return (
                  <div key={match.id} className={`ufc-detail-fight ${match.status === 'live' ? 'live' : ''} ${isMainEvent ? 'main-event' : ''}`}>
                    <div className="ufc-detail-fight-order">{idx + 1}</div>
                    <div className="ufc-detail-fight-info">
                      <div className="ufc-detail-fight-matchup">
                        <span className="ufc-detail-fight-away">{match.awayName}</span>
                        <span className="ufc-detail-fight-vs">{i18n.t('sports:vs')}</span>
                        <span className="ufc-detail-fight-home">{match.homeName}</span>
                      </div>
                      <div className="ufc-detail-fight-records">
                        {match.awayRecord && <span>{match.awayRecord}</span>}
                        {match.homeRecord && <span>{match.homeRecord}</span>}
                      </div>
                    </div>
                    <div className="ufc-detail-fight-badges">
                      {match.subtitle && (
                        <span className="ufc-detail-fight-weight">{match.subtitle}</span>
                      )}
                      {match.status === 'live' && (
                        <span className="ufc-detail-fight-live-badge">{i18n.t('sports:statusLive')}</span>
                      )}
                      {isMainEvent && (
                        <span className="ufc-detail-fight-main-badge">{i18n.t('sports:mainEvent')}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Broadcast */}
          {event.channels.length > 0 && (
            <div className="ufc-detail-broadcast">
              <h3 className="ufc-detail-section-title">{i18n.t('sports:watchOn')}</h3>
              <div className="game-detail-channels">
                {event.channels.map((channel, idx) => (
                  <button
                    key={idx}
                    className="game-detail-channel-btn"
                    onClick={() => onChannelClick?.(channel.name)}
                  >
                    {channel.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderRacingDetail = () => {
    const results = event.matches || [];
    const hasResults = results.length > 0;

    return (
      <div className={`game-detail-overlay${variant === 'glass' ? ' glass' : ''}`} onClick={handleOverlayClick} onKeyDown={handleKeyDown}>
        <div className={`game-detail-modal racing-detail-modal${variant === 'glass' ? ' glass' : ''}`}>
          {/* Header */}
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

          {/* Race Title */}
          <div className="racing-detail-title-bar">
            <h2 className="racing-detail-event-title">{event.title}</h2>
            <div className="racing-detail-meta">
              {isLive && (
                <span className="racing-detail-live-badge">
                  <span className="racing-detail-live-dot" />
                  LIVE
                </span>
              )}
              <span className="racing-detail-datetime">{formatEventDateTime(event.startTime, epgClockFormat !== '24h')}</span>
              {event.venue && <span className="racing-detail-venue">{event.venue}</span>}
            </div>
          </div>

          {/* Results Grid */}
          {hasResults ? (
            <div className="racing-detail-content">
              {/* Podium */}
              <div className="racing-detail-podium">
                {results.slice(0, 3).map((result, idx) => {
                  const posClass = idx === 0 ? 'gold' : idx === 1 ? 'silver' : 'bronze';
                  return (
                    <div key={result.id} className={`racing-podium-item ${posClass}`}>
                      <span className="racing-podium-position">{idx + 1}</span>
                      {result.awayLogo && (
                        <img src={result.awayLogo} alt={result.awayName} className="racing-podium-driver-img" />
                      )}
                      <span className="racing-podium-driver-name">{result.awayName}</span>
                      <span className="racing-podium-team-name">{result.homeName}</span>
                      {result.subtitle && (
                        <span className="racing-podium-time">{result.subtitle}</span>
                      )}
                      {result.points !== undefined && (
                        <span className="racing-podium-points">{result.points} pts</span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Full Results Table */}
              <h3 className="racing-detail-section-title">{i18n.t('sports:raceResults')}</h3>
              <div className="racing-detail-results-table">
                <div className="racing-results-header">
                  <span className="racing-results-col pos">{i18n.t('sports:pos')}</span>
                  <span className="racing-results-col driver">{i18n.t('sports:driver')}</span>
                  <span className="racing-results-col team">{i18n.t('sports:team')}</span>
                  <span className="racing-results-col time">{i18n.t('sports:timeInterval')}</span>
                  <span className="racing-results-col pts">{i18n.t('sports:pts')}</span>
                </div>
                {results.map((result) => (
                  <div key={result.id} className={`racing-results-row ${result.position && result.position <= 3 ? 'podium' : ''}`}>
                    <span className="racing-results-col pos">{result.position || '-'}</span>
                    <span className="racing-results-col driver">
                      {result.awayLogo && (
                        <img src={result.awayLogo} alt="" className="racing-results-driver-img" />
                      )}
                      {result.awayName}
                    </span>
                    <span className="racing-results-col team">{result.homeName}</span>
                    <span className="racing-results-col time">{result.subtitle || '-'}</span>
                    <span className="racing-results-col pts">{result.points ?? '-'}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="racing-detail-content">
              <div className="game-detail-no-data">
                <span>{i18n.t('sports:raceResultsUnavailable')}</span>
              </div>
            </div>
          )}

          {/* Broadcast */}
          {event.channels.length > 0 && (
            <div className="racing-detail-broadcast">
              <h3 className="racing-detail-section-title">{i18n.t('sports:watchOn')}</h3>
              <div className="game-detail-channels">
                {event.channels.map((channel, idx) => (
                  <button
                    key={idx}
                    className="game-detail-channel-btn"
                    onClick={() => onChannelClick?.(channel.name)}
                  >
                    {channel.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderGolfDetail = () => {
    const leaderboard = event.matches || [];
    const hasLeaderboard = leaderboard.length > 0;
    const roundCount = leaderboard[0]?.roundScores?.length || 0;

    return (
      <div className={`game-detail-overlay${variant === 'glass' ? ' glass' : ''}`} onClick={handleOverlayClick} onKeyDown={handleKeyDown}>
        <div className={`game-detail-modal golf-detail-modal${variant === 'glass' ? ' glass' : ''}`}>
          {/* Header */}
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

          {/* Tournament Title */}
          <div className="golf-detail-title-bar">
            <h2 className="golf-detail-event-title">{event.title}</h2>
            <div className="golf-detail-meta">
              {isLive && (
                <span className="golf-detail-live-badge">
                  <span className="golf-detail-live-dot" />
                  LIVE
                </span>
              )}
              <span className="golf-detail-datetime">{formatEventDateTime(event.startTime, epgClockFormat !== '24h')}</span>
              {event.venue && <span className="golf-detail-venue">{event.venue}</span>}
            </div>
          </div>

          {/* Leaderboard */}
          {hasLeaderboard ? (
            <div className="golf-detail-content">
              <div className="golf-detail-leaderboard">
                <div className="golf-lb-header">
                  <span className="golf-lb-col pos">{i18n.t('sports:pos')}</span>
                  <span className="golf-lb-col player">{i18n.t('sports:player')}</span>
                  {Array.from({ length: roundCount }, (_, i) => (
                    <span key={i} className="golf-lb-col round">R{i + 1}</span>
                  ))}
                  <span className="golf-lb-col total">{i18n.t('sports:total')}</span>
                </div>
                {leaderboard.map((entry) => (
                  <div
                    key={entry.id}
                    className={`golf-lb-row ${entry.position === 1 ? 'leader' : ''}`}
                  >
                    <span className="golf-lb-col pos">{entry.position || '-'}</span>
                    <span className="golf-lb-col player">
                      {entry.awayLogo && (
                        <img src={entry.awayLogo} alt="" className="golf-lb-flag" />
                      )}
                      {entry.awayName}
                    </span>
                    {entry.roundScores?.map((score, idx) => (
                      <span key={idx} className="golf-lb-col round">{score}</span>
                    ))}
                    <span className={`golf-lb-col total ${entry.subtitle?.startsWith('-') ? 'under' : entry.subtitle?.startsWith('+') ? 'over' : 'even'}`}>
                      {entry.subtitle || 'E'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="golf-detail-content">
              <div className="game-detail-no-data">
                <span>{i18n.t('sports:leaderboardUnavailable')}</span>
              </div>
            </div>
          )}

          {/* Broadcast */}
          {event.channels.length > 0 && (
            <div className="golf-detail-broadcast">
              <h3 className="golf-detail-section-title">{i18n.t('sports:watchOn')}</h3>
              <div className="game-detail-channels">
                {event.channels.map((channel, idx) => (
                  <button
                    key={idx}
                    className="game-detail-channel-btn"
                    onClick={() => onChannelClick?.(channel.name)}
                  >
                    {channel.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  if (isUFC) {
    return createPortal(renderUFCDetail(), document.body);
  }

  if (isRacing) {
    return createPortal(renderRacingDetail(), document.body);
  }

  if (isGolf) {
    return createPortal(renderGolfDetail(), document.body);
  }

  const renderTennisDetail = () => {
    const matches = event.matches || [];
    const hasMatches = matches.length > 0;

    // Group matches by draw type
    const grouped = matches.reduce((acc, match) => {
      const group = match.groupName || i18n.t('sports:matches');
      if (!acc[group]) acc[group] = [];
      acc[group].push(match);
      return acc;
    }, {} as Record<string, typeof matches>);

    return (
      <div className={`game-detail-overlay${variant === 'glass' ? ' glass' : ''}`} onClick={handleOverlayClick} onKeyDown={handleKeyDown}>
        <div className={`game-detail-modal tennis-detail-modal${variant === 'glass' ? ' glass' : ''}`}>
          {/* Header */}
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

          {/* Tournament Title */}
          <div className="tennis-detail-title-bar">
            <h2 className="tennis-detail-event-title">{event.title}</h2>
            <div className="tennis-detail-meta">
              {isLive && (
                <span className="tennis-detail-live-badge">
                  <span className="tennis-detail-live-dot" />
                  LIVE
                </span>
              )}
              <span className="tennis-detail-datetime">{formatEventDateTime(event.startTime, epgClockFormat !== '24h')}</span>
              {event.venue && <span className="tennis-detail-venue">{event.venue}</span>}
            </div>
          </div>

          {/* Matches by group */}
          {hasMatches ? (
            <div className="tennis-detail-content">
              {Object.entries(grouped).map(([groupName, groupMatches]) => (
                <div key={groupName} className="tennis-detail-group">
                  <h3 className="tennis-detail-section-title">{groupName}</h3>
                  <div className="tennis-detail-matches">
                    {groupMatches.map((match) => (
                      <div key={match.id} className={`tennis-match-row ${match.status === 'live' ? 'live' : ''}`}>
                        <div className="tennis-match-players">
                          <div className="tennis-match-player">
                            {match.awayLogo && (
                              <img src={match.awayLogo} alt="" className="tennis-match-flag" />
                            )}
                            <span className="tennis-match-name">{match.awayName}</span>
                          </div>
                          <div className="tennis-match-vs">{i18n.t('sports:vs')}</div>
                          <div className="tennis-match-player">
                            {match.homeLogo && (
                              <img src={match.homeLogo} alt="" className="tennis-match-flag" />
                            )}
                            <span className="tennis-match-name">{match.homeName}</span>
                          </div>
                        </div>
                        <div className="tennis-match-info">
                          {match.roundScores && match.roundScores.length > 0 && (
                            <div className="tennis-match-sets">
                              {match.roundScores.map((set, idx) => (
                                <span key={idx} className="tennis-match-set">{set}</span>
                              ))}
                            </div>
                          )}
                          {match.status === 'live' && (
                            <span className="tennis-match-live-badge">{i18n.t('sports:statusLive')}</span>
                          )}
                          {match.subtitle && (
                            <span className="tennis-match-status">{match.subtitle}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="tennis-detail-content">
              <div className="game-detail-no-data">
                <span>{i18n.t('sports:matchesUnavailable')}</span>
              </div>
            </div>
          )}

          {/* Broadcast */}
          {event.channels.length > 0 && (
            <div className="tennis-detail-broadcast">
              <h3 className="tennis-detail-section-title">{i18n.t('sports:watchOn')}</h3>
              <div className="game-detail-channels">
                {event.channels.map((channel, idx) => (
                  <button
                    key={idx}
                    className="game-detail-channel-btn"
                    onClick={() => onChannelClick?.(channel.name)}
                  >
                    {channel.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  if (isTennis) {
    return createPortal(renderTennisDetail(), document.body);
  }

  if (isRugby) {
    return createPortal(renderRugbyDetail(), document.body);
  }

  return createPortal(
    <div className={`game-detail-overlay${variant === 'glass' ? ' glass' : ''}`} onClick={handleOverlayClick} onKeyDown={handleKeyDown}>
      <div className={`game-detail-modal${variant === 'glass' ? ' glass' : ''}`}>
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
                <span className="game-detail-live-text">{event.timeElapsed || i18n.t('sports:statusLive')}</span>
                {event.period && <span className="game-detail-period">{event.period}</span>}
              </div>
            ) : (
              <div className="game-detail-scheduled">
                <span className="game-detail-datetime">{formatEventDateTime(event.startTime, epgClockFormat !== '24h')}</span>
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
            onClick={() => { setActiveTab('stats'); contentRef.current?.scrollTo({ top: 0, behavior: 'auto' }); }}
          >
            Team Stats
          </button>
          <button
            className={`game-detail-tab ${activeTab === 'players' ? 'active' : ''}`}
            onClick={() => { setActiveTab('players'); contentRef.current?.scrollTo({ top: 0, behavior: 'auto' }); }}
          >
            Players
          </button>
          <button
            className={`game-detail-tab ${activeTab === 'scoring' ? 'active' : ''}`}
            onClick={() => { setActiveTab('scoring'); contentRef.current?.scrollTo({ top: 0, behavior: 'auto' }); }}
          >
            Scoring Plays
          </button>
          <button
            className={`game-detail-tab ${activeTab === 'info' ? 'active' : ''}`}
            onClick={() => { setActiveTab('info'); contentRef.current?.scrollTo({ top: 0, behavior: 'auto' }); }}
          >
            Game Info
          </button>
        </div>

        {activeTab === 'players' && renderPlayerTeamTabs()}

        <div className="game-detail-content" ref={contentRef}>
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
    </div>,
    document.body
  );
}
