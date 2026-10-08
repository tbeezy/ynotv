import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { formatTime, formatDate } from '../../utils/dateTime';
import { useEpgClockFormat } from '../../stores/uiStore';
import type { SportsEvent, SportsTeam } from '@ynotv/core';
import { 
  getTeamSchedule, 
  getTeamDetails, 
  getTeamDepthChart,
  getTeamInjuries,
  getTeamLeaders,
  getTeamNews,
  formatEventTime, 
  formatEventDate,
  inferTeamLeague,
  type TeamDetails,
  type TeamAthlete,
  type DepthChartGroup,
  type TeamInjury,
  type TeamLeaderCategory,
  type TeamNewsArticle,
} from '../../services/sports';
import { useAddFavorite, useRemoveFavorite, useIsFavorite } from '../../stores/sportsFavoritesStore';
import { GameDetail } from './GameDetail';
import { AthleteDetailModal } from './AthleteDetailModal';

export interface BreadcrumbItem {
  label: string;
  onClick?: () => void;
}

interface TeamDetailProps {
  team: SportsTeam;
  onClose: () => void;
  onChannelClick?: (channelName: string) => void;
  onPlayChannel?: (channel: import('../../db').StoredChannel) => void;
  breadcrumbs?: BreadcrumbItem[];
  fromTab?: string;
  onRootClick?: () => void;
}

const LEAGUE_INFO_MAP: Record<string, { sportName: string; leagueName: string }> = {
  nfl: { sportName: 'Football', leagueName: 'NFL' },
  cfb: { sportName: 'Football', leagueName: 'NCAA Football' },
  mlb: { sportName: 'Baseball', leagueName: 'MLB' },
  nba: { sportName: 'Basketball', leagueName: 'NBA' },
  cbb: { sportName: 'Basketball', leagueName: 'NCAA Basketball' },
  wnba: { sportName: 'Basketball', leagueName: 'WNBA' },
  nhl: { sportName: 'Hockey', leagueName: 'NHL' },
  ufc: { sportName: 'MMA', leagueName: 'UFC' },
  f1: { sportName: 'Racing', leagueName: 'Formula 1' },
  nascar: { sportName: 'Racing', leagueName: 'NASCAR' },
  pga: { sportName: 'Golf', leagueName: 'PGA Tour' },
  atp: { sportName: 'Tennis', leagueName: 'ATP Tennis' },
  wta: { sportName: 'Tennis', leagueName: 'WTA Tennis' },
  'premier-league': { sportName: 'Soccer', leagueName: 'Premier League' },
  'la-liga': { sportName: 'Soccer', leagueName: 'La Liga' },
  'serie-a': { sportName: 'Soccer', leagueName: 'Serie A' },
  'bundesliga': { sportName: 'Soccer', leagueName: 'Bundesliga' },
  'ligue-1': { sportName: 'Soccer', leagueName: 'Ligue 1' },
  'champions-league': { sportName: 'Soccer', leagueName: 'UEFA Champions League' },
  'europa-league': { sportName: 'Soccer', leagueName: 'UEFA Europa League' },
  'conference-league': { sportName: 'Soccer', leagueName: 'UEFA Conference League' },
  'soccer-uefa.europa.conf': { sportName: 'Soccer', leagueName: 'UEFA Conference League' },
  'soccer-uefa.nations': { sportName: 'Soccer', leagueName: 'UEFA Nations League' },
  'uefa.europa.conf': { sportName: 'Soccer', leagueName: 'UEFA Conference League' },
  mls: { sportName: 'Soccer', leagueName: 'MLS' },
  'world-cup': { sportName: 'Soccer', leagueName: 'FIFA World Cup' },
  afl: { sportName: 'Australian Football', leagueName: 'AFL' },
  nrl: { sportName: 'Rugby League', leagueName: 'NRL' },
};

const LEAGUES_WITH_DEPTH_CHART = new Set(['nfl', 'nba', 'mlb']);

type TabId = 'schedule' | 'roster' | 'depth' | 'injuries' | 'leaders' | 'news';

export interface SeriesGroup {
  id: string;
  opponent: {
    id: string;
    name: string;
    shortName?: string;
    logo?: string;
  };
  isHome: boolean;
  events: SportsEvent[];
  startDate: Date;
  endDate: Date;
  wins: number;
  losses: number;
  draws: number;
}

function groupEventsIntoSeries(events: SportsEvent[], teamId: string): (SportsEvent | SeriesGroup)[] {
  if (events.length === 0) return [];

  const result: (SportsEvent | SeriesGroup)[] = [];
  let currentSeries: SportsEvent[] = [];

  const flushSeries = () => {
    if (currentSeries.length === 0) return;
    if (currentSeries.length === 1) {
      result.push(currentSeries[0]);
    } else {
      const first = currentSeries[0];
      const last = currentSeries[currentSeries.length - 1];
      const isHome = first.homeTeam.id === teamId;
      const opponent = isHome ? first.awayTeam : first.homeTeam;

      let wins = 0;
      let losses = 0;
      let draws = 0;

      for (const ev of currentSeries) {
        if (ev.homeScore !== undefined && ev.awayScore !== undefined) {
          const tScore = isHome ? ev.homeScore : ev.awayScore;
          const oScore = isHome ? ev.awayScore : ev.homeScore;
          if (tScore > oScore) wins++;
          else if (tScore < oScore) losses++;
          else draws++;
        }
      }

      result.push({
        id: `series-${first.id}-${last.id}`,
        opponent,
        isHome,
        events: [...currentSeries],
        startDate: first.startTime,
        endDate: last.startTime,
        wins,
        losses,
        draws,
      });
    }
    currentSeries = [];
  };

  for (const event of events) {
    if (currentSeries.length === 0) {
      currentSeries.push(event);
    } else {
      const prev = currentSeries[currentSeries.length - 1];
      const prevHome = prev.homeTeam.id === teamId;
      const prevOpponentId = prevHome ? prev.awayTeam.id : prev.homeTeam.id;

      const currHome = event.homeTeam.id === teamId;
      const currOpponentId = currHome ? event.awayTeam.id : event.homeTeam.id;

      if (prevOpponentId === currOpponentId && prevHome === currHome) {
        currentSeries.push(event);
      } else {
        flushSeries();
        currentSeries.push(event);
      }
    }
  }

  flushSeries();
  return result;
}

function groupEventsByMonth(events: SportsEvent[]): Map<string, SportsEvent[]> {
  const map = new Map<string, SportsEvent[]>();
  for (const event of events) {
    const monthKey = formatDate(event.startTime, { month: 'long', year: 'numeric' });
    if (!map.has(monthKey)) {
      map.set(monthKey, []);
    }
    map.get(monthKey)!.push(event);
  }
  return map;
}

export function TeamDetail({ team, onClose, onChannelClick, onPlayChannel, breadcrumbs, fromTab, onRootClick }: TeamDetailProps) {
  const { t } = useTranslation('sports');
  const epgClockFormat = useEpgClockFormat();
  const [details, setDetails] = useState<TeamDetails | null>(null);
  const [upcoming, setUpcoming] = useState<SportsEvent[]>([]);
  const [past, setPast] = useState<SportsEvent[]>([]);
  const [depthChart, setDepthChart] = useState<DepthChartGroup[]>([]);
  const [injuries, setInjuries] = useState<TeamInjury[]>([]);
  const [leaders, setLeaders] = useState<TeamLeaderCategory[]>([]);
  const [news, setNews] = useState<TeamNewsArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<SportsEvent | null>(null);
  const [selectedAthleteId, setSelectedAthleteId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('schedule');

  // Schedule view options
  const [showFullSchedule, setShowFullSchedule] = useState(false);
  const [chunkBySeries, setChunkBySeries] = useState(true);

  const [loadingTab, setLoadingTab] = useState(false);

  const resolvedLeague = team.leagueId || inferTeamLeague(team);
  const leagueId = (resolvedLeague || '').toLowerCase();
  const hasDepthChart = Boolean(resolvedLeague && LEAGUES_WITH_DEPTH_CHART.has(leagueId));

  const isFavorite = useIsFavorite(team.id, resolvedLeague);
  const addFavorite = useAddFavorite();
  const removeFavorite = useRemoveFavorite();

  useEffect(() => {
    if (!hasDepthChart && activeTab === 'depth') {
      setActiveTab('schedule');
    }
  }, [hasDepthChart, activeTab]);

  const activeBreadcrumbs = useMemo<BreadcrumbItem[]>(() => {
    if (breadcrumbs && breadcrumbs.length > 0) return breadcrumbs;

    const info = (leagueId && LEAGUE_INFO_MAP[leagueId]) || { sportName: 'Sports', leagueName: (leagueId || 'SPORTS').toUpperCase() };
    const rootLabel = fromTab || i18n.t('sports:tabs.leagues');

    return [
      { label: rootLabel, onClick: onRootClick || onClose },
      { label: info.leagueName, onClick: onClose },
      { label: details?.name || team.name },
    ];
  }, [breadcrumbs, leagueId, team.name, fromTab, details?.name, onClose, onRootClick]);

  useEffect(() => {
    if (!resolvedLeague) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const currentLeagueId = resolvedLeague;
    
    Promise.all([
      getTeamDetails(team.id, currentLeagueId),
      getTeamSchedule(team.id, currentLeagueId),
    ])
      .then(([detailsResult, scheduleResult]) => {
        setDetails(detailsResult);
        setUpcoming(scheduleResult.upcoming);
        setPast(scheduleResult.past);
      })
      .finally(() => setLoading(false));
  }, [team.id, team.leagueId, resolvedLeague]);

  useEffect(() => {
    if (!resolvedLeague) return;
    const currentLeagueId = resolvedLeague;
    if (hasDepthChart && activeTab === 'depth' && depthChart.length === 0) {
      setLoadingTab(true);
      getTeamDepthChart(team.id, currentLeagueId)
        .then(res => setDepthChart(res))
        .finally(() => setLoadingTab(false));
    }
    if (activeTab === 'injuries' && injuries.length === 0) {
      setLoadingTab(true);
      getTeamInjuries(team.id, currentLeagueId)
        .then(res => setInjuries(res))
        .finally(() => setLoadingTab(false));
    }
    if (activeTab === 'leaders' && leaders.length === 0) {
      setLoadingTab(true);
      getTeamLeaders(team.id, currentLeagueId)
        .then(res => setLeaders(res))
        .finally(() => setLoadingTab(false));
    }
    if (activeTab === 'news' && news.length === 0) {
      setLoadingTab(true);
      getTeamNews(team.id, currentLeagueId)
        .then(res => setNews(res))
        .finally(() => setLoadingTab(false));
    }
  }, [hasDepthChart, activeTab, team.id, team.leagueId, resolvedLeague, depthChart.length, injuries.length, leaders.length, news.length]);

  const handleToggleFavorite = useCallback(() => {
    if (!resolvedLeague) return;
    if (isFavorite) {
      removeFavorite(team.id, resolvedLeague);
    } else {
      addFavorite({ ...team, leagueId: resolvedLeague });
    }
  }, [isFavorite, team, resolvedLeague, addFavorite, removeFavorite]);

  const teamColor = details?.color || '00338d';
  const teamColorStyle = `#${teamColor}`;

  const allEvents = useMemo(() => {
    return [...past, ...upcoming].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  }, [past, upcoming]);

  const monthlyEvents = useMemo(() => {
    return groupEventsByMonth(allEvents);
  }, [allEvents]);

  if (selectedEvent) {
    return (
      <GameDetail
        event={selectedEvent}
        onClose={() => setSelectedEvent(null)}
        onChannelClick={onChannelClick}
        onPlayChannel={onPlayChannel}
      />
    );
  }

  return (
    <div className="sports-tab-content">
      <nav className="sports-breadcrumbs" aria-label={i18n.t('sports:breadcrumbs')}>
        {activeBreadcrumbs.map((item, idx) => {
          const isLast = idx === activeBreadcrumbs.length - 1;
          return (
            <Fragment key={idx}>
              {idx > 0 && (
                <span className="sports-breadcrumb-separator">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </span>
              )}
              {item.onClick && !isLast ? (
                <button className="sports-breadcrumb-link" onClick={item.onClick}>
                  {idx === 0 && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ marginRight: '2px' }}>
                      <path d="M19 12H5M12 19l-7-7 7-7" />
                    </svg>
                  )}
                  {item.label}
                </button>
              ) : (
                <span className={`sports-breadcrumb-item ${isLast ? 'active' : ''}`}>
                  {item.label}
                </span>
              )}
            </Fragment>
          );
        })}
      </nav>

      {!resolvedLeague ? (
        <div className="sports-loading" style={{ minHeight: '260px', flexDirection: 'column', gap: '12px' }}>
          <p style={{ color: 'var(--text-secondary, #aaa)', fontSize: '15px' }}>
            {t('leagueUnavailable', { defaultValue: 'Unable to determine the league for this team.' })}
          </p>
          <button className="sports-btn-secondary" onClick={onClose}>
            {t('close', { defaultValue: 'Close' })}
          </button>
        </div>
      ) : loading ? (
        <div className="sports-loading">
          <div className="sports-spinner" />
          <span>{t('loadingTeamInfo')}</span>
        </div>
      ) : (
        <>
          <div className="team-header" style={{ '--team-color': teamColorStyle } as React.CSSProperties}>
            <div className="team-header-banner" style={{ background: `linear-gradient(135deg, #${details?.color || '333'} 0%, #${details?.alternateColor || '111'} 100%)` }}>
              <div className="team-header-content">
                {details?.logo && (
                  <img 
                    src={details.logo} 
                    alt={details.name} 
                    className="team-header-logo"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                )}
                <div className="team-header-info">
                  <span className="team-header-location">{details?.location}</span>
                  <h1 className="team-header-name">{details?.name || team.name}</h1>
                  {details?.standingSummary && (
                    <span className="team-header-standing">{details.standingSummary}</span>
                  )}
                </div>
                <button
                  className={`team-favorite-btn ${isFavorite ? 'is-favorite' : ''}`}
                  onClick={handleToggleFavorite}
                  title={isFavorite ? i18n.t('sports:removeFromFavorites') : i18n.t('sports:addToFavorites')}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill={isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          {details?.record && (
            <div className="team-record-section">
              <div className="team-record-cards">
                <div className="team-record-card overall">
                  <span className="team-record-label">{i18n.t('sports:overall')}</span>
                  <span className="team-record-value">{details.record.overall}</span>
                </div>
                {details.record.home && (
                  <div className="team-record-card">
                    <span className="team-record-label">{i18n.t('sports:home')}</span>
                    <span className="team-record-value">{details.record.home}</span>
                  </div>
                )}
                {details.record.away && (
                  <div className="team-record-card">
                    <span className="team-record-label">{i18n.t('sports:away')}</span>
                    <span className="team-record-value">{details.record.away}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {(() => {
            const nextGame = upcoming[0];
            if (!nextGame) return null;

            return (
              <div className="team-next-game" onClick={() => setSelectedEvent(nextGame)}>
                <span className="team-next-label">{i18n.t('sports:nextGame')}</span>
                <div className="team-next-content">
                  <span className="team-next-opponent">
                    {nextGame.homeTeam.id === team.id ? `${i18n.t('sports:vs')} ` : '@ '}
                    {nextGame.homeTeam.id === team.id 
                      ? nextGame.awayTeam.name 
                      : nextGame.homeTeam.name}
                  </span>
                  <span className="team-next-date">
                    {formatEventDate(nextGame.startTime)} at {formatEventTime(nextGame.startTime, epgClockFormat !== '24h')}
                  </span>
                </div>
              </div>
            );
          })()}

          <div className="team-tabs">
            <button 
              className={`team-tab ${activeTab === 'schedule' ? 'active' : ''}`}
              onClick={() => setActiveTab('schedule')}
            >
              Schedule ({upcoming.length + past.length})
            </button>
            <button 
              className={`team-tab ${activeTab === 'roster' ? 'active' : ''}`}
              onClick={() => setActiveTab('roster')}
            >
              Roster ({details?.athletes.length || 0})
            </button>
            {hasDepthChart && (
              <button
                className={`team-tab ${activeTab === 'depth' ? 'active' : ''}`}
                onClick={() => setActiveTab('depth')}
              >
                Depth Chart
              </button>
            )}
            <button 
              className={`team-tab ${activeTab === 'injuries' ? 'active' : ''}`}
              onClick={() => setActiveTab('injuries')}
            >
              Injuries {injuries.length > 0 ? `(${injuries.length})` : ''}
            </button>
            <button 
              className={`team-tab ${activeTab === 'leaders' ? 'active' : ''}`}
              onClick={() => setActiveTab('leaders')}
            >
              Leaders
            </button>
            <button 
              className={`team-tab ${activeTab === 'news' ? 'active' : ''}`}
              onClick={() => setActiveTab('news')}
            >
              News {news.length > 0 ? `(${news.length})` : ''}
            </button>
          </div>

          <div className="team-tab-content">
            {loadingTab ? (
              <div className="sports-loading" style={{ minHeight: '200px' }}>
                <div className="sports-spinner" />
                <span>{t('loadingInfo')}</span>
              </div>
            ) : (
              <>
            {activeTab === 'schedule' && (
              <>
                {!showFullSchedule ? (
                  <>
                    {upcoming.length > 1 && (
                      <section className="sports-section">
                        <h3 className="sports-section-title">{i18n.t('sports:upcomingSchedule')}</h3>
                        <div className="team-schedule-grid">
                          {upcoming.slice(1, 6).map(event => (
                            <TeamEventCard
                              key={event.id}
                              event={event}
                              teamId={team.id}
                              onClick={() => setSelectedEvent(event)}
                              onChannelClick={onChannelClick}
                            />
                          ))}
                        </div>
                      </section>
                    )}

                    {past.length > 0 && (
                      <section className="sports-section">
                        <h3 className="sports-section-title">{i18n.t('sports:recentResults')}</h3>
                        <div className="team-schedule-grid">
                          {past.slice(0, 5).map(event => (
                            <TeamEventCard
                              key={event.id}
                              event={event}
                              teamId={team.id}
                              onClick={() => setSelectedEvent(event)}
                              onChannelClick={onChannelClick}
                            />
                          ))}
                        </div>
                      </section>
                    )}

                    <div className="team-schedule-expand-bar">
                      <button
                        className="team-schedule-expand-btn"
                        onClick={() => setShowFullSchedule(true)}
                      >
                        <span>View Full Schedule ({upcoming.length + past.length} Games)</span>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="team-schedule-top-controls">
                      <h3 className="sports-section-title" style={{ margin: 0 }}>{i18n.t('sports:fullSeasonSchedule')}</h3>
                      <div className="team-schedule-toggle-group">
                        <button
                          className={`team-schedule-toggle-btn${chunkBySeries ? ' active' : ''}`}
                          onClick={() => setChunkBySeries(true)}
                        >
                          {i18n.t('sports:groupBySeries')}
                        </button>
                        <button
                          className={`team-schedule-toggle-btn${!chunkBySeries ? ' active' : ''}`}
                          onClick={() => setChunkBySeries(false)}
                        >
                          All Games
                        </button>
                      </div>
                    </div>

                    {Array.from(monthlyEvents.entries()).map(([monthName, events]) => {
                      const items = chunkBySeries
                        ? groupEventsIntoSeries(events, team.id)
                        : events;

                      return (
                        <div key={monthName} className="team-schedule-month-group">
                          <h4 className="team-schedule-month-title">{monthName} ({events.length} Games)</h4>
                          <div className="team-schedule-grid">
                            {items.map((item) => {
                              if ('events' in item) {
                                return (
                                  <SeriesCard
                                    key={item.id}
                                    series={item}
                                    teamId={team.id}
                                    onClick={(ev) => setSelectedEvent(ev)}
                                    onChannelClick={onChannelClick}
                                  />
                                );
                              }
                              return (
                                <TeamEventCard
                                  key={item.id}
                                  event={item}
                                  teamId={team.id}
                                  onClick={() => setSelectedEvent(item)}
                                  onChannelClick={onChannelClick}
                                />
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}

                    <div className="team-schedule-expand-bar">
                      <button
                        className="team-schedule-expand-btn"
                        onClick={() => setShowFullSchedule(false)}
                      >
                        <span>{t('collapseToSummary')}</span>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M18 15l-6-6-6 6" />
                        </svg>
                      </button>
                    </div>
                  </>
                )}

                {upcoming.length === 0 && past.length === 0 && (
                  <div className="sports-empty">
                    <p>{t('noScheduleAvailable')}</p>
                  </div>
                )}
              </>
            )}

            {activeTab === 'roster' && (
              <TeamRoster
                athletes={details?.athletes || []}
                onAthleteClick={(id) => setSelectedAthleteId(id)}
              />
            )}

            {hasDepthChart && activeTab === 'depth' && (
              <TeamDepthChart
                depthChart={depthChart}
                roster={details?.athletes}
                onAthleteClick={(id) => setSelectedAthleteId(id)}
              />
            )}

            {activeTab === 'injuries' && (
              <TeamInjuries
                injuries={injuries}
                onAthleteClick={(id) => setSelectedAthleteId(id)}
              />
            )}

            {activeTab === 'leaders' && (
              <TeamLeaders
                leaders={leaders}
                onAthleteClick={(id) => setSelectedAthleteId(id)}
              />
            )}

            {activeTab === 'news' && (
              <TeamNews news={news} />
            )}
            </>
            )}
          </div>
        </>
      )}

      {selectedAthleteId && resolvedLeague && (
        <AthleteDetailModal
          athleteId={selectedAthleteId}
          leagueId={resolvedLeague}
          onClose={() => setSelectedAthleteId(null)}
        />
      )}
    </div>
  );
}

function SeriesCard({
  series,
  teamId,
  onClick,
  onChannelClick,
}: {
  series: SeriesGroup;
  teamId: string;
  onClick?: (event: SportsEvent) => void;
  onChannelClick?: (channelName: string) => void;
}) {
  useTranslation();
  const [expanded, setExpanded] = useState(false);

  const startFormatted = formatDate(series.startDate, { month: 'short', day: 'numeric' });
  const endFormatted = formatDate(series.endDate, { month: 'short', day: 'numeric' });
  const dateRangeStr = startFormatted === endFormatted ? startFormatted : `${startFormatted} – ${endFormatted}`;

  const totalFinished = series.wins + series.losses + series.draws;
  const isFinished = totalFinished === series.events.length;
  const seriesWon = series.wins > series.losses;
  const seriesLost = series.losses > series.wins;

  const seriesStatusClass = isFinished ? (seriesWon ? 'win' : seriesLost ? 'loss' : 'draw') : '';

  return (
    <div className={`team-series-card ${seriesStatusClass}`}>
      <div className="series-card-header" onClick={() => setExpanded(!expanded)}>
        <div className="series-card-header-left">
          {series.opponent.logo && (
            <img src={series.opponent.logo} alt="" className="series-opponent-logo" />
          )}
          <div className="series-opponent-info">
            <span className="series-opponent-title">
              {series.isHome ? 'vs' : '@'} {series.opponent.shortName || series.opponent.name}
            </span>
            <span className="series-date-range">
              {dateRangeStr} • {series.events.length} Games
            </span>
          </div>
        </div>

        <div className="series-card-header-right">
          {isFinished && (
            <span className={`series-record-pill ${seriesStatusClass}`}>
              {series.wins}-{series.losses}{series.draws > 0 ? `-${series.draws}` : ''}
            </span>
          )}
          <button className="series-expand-btn">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>

      {expanded && (
        <div className="series-games-list">
          {series.events.map((event) => (
            <SeriesGameRow
              key={event.id}
              event={event}
              teamId={teamId}
              onClick={() => onClick?.(event)}
              onChannelClick={onChannelClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SeriesGameRow({
  event,
  teamId,
  onClick,
  onChannelClick,
}: {
  event: SportsEvent;
  teamId: string;
  onClick?: () => void;
  onChannelClick?: (channelName: string) => void;
}) {
  useTranslation();
  const epgClockFormat = useEpgClockFormat();
  const isHome = event.homeTeam.id === teamId;
  const teamScore = isHome ? event.homeScore : event.awayScore;
  const opponentScore = isHome ? event.awayScore : event.homeScore;
  const isPast = event.startTime.getTime() < Date.now();
  const isLive = event.status === 'live';

  const getResultClass = () => {
    if (teamScore === undefined || opponentScore === undefined) return '';
    if (teamScore > opponentScore) return 'win';
    if (teamScore < opponentScore) return 'loss';
    return 'draw';
  };

  const resultClass = isPast ? getResultClass() : '';

  return (
    <div className={`series-game-row ${resultClass}`} onClick={onClick}>
      <div className="series-game-row-date">
        <span className="series-game-date">
          {formatDate(event.startTime, { weekday: 'short', month: 'short', day: 'numeric' })}
        </span>
        <span className="series-game-time">
          {formatTime(event.startTime, { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' })}
        </span>
      </div>

      <div className="series-game-row-center">
        {isPast && teamScore !== undefined && opponentScore !== undefined ? (
          <span className="series-game-score">
            {teamScore} - {opponentScore}
          </span>
        ) : (
          <span className="series-game-vs">{isHome ? 'vs' : '@'}</span>
        )}
      </div>

      <div className="series-game-row-right">
        {isLive ? (
          <span className="team-schedule-live">{i18n.t('sports:statusLive')}</span>
        ) : isPast && teamScore !== undefined && opponentScore !== undefined ? (
          <span className={`team-schedule-card-result ${resultClass}`}>
            {teamScore > opponentScore ? 'W' : teamScore < opponentScore ? 'L' : 'T'}
          </span>
        ) : null}
        {event.channels && event.channels.length > 0 && (
          <button
            className="team-schedule-card-channel"
            onClick={(e) => {
              e.stopPropagation();
              onChannelClick?.(event.channels[0].name);
            }}
          >
            {event.channels[0].name}
          </button>
        )}
      </div>
    </div>
  );
}

interface TeamEventCardProps {
  event: SportsEvent;
  teamId: string;
  onClick?: () => void;
  onChannelClick?: (channelName: string) => void;
}

function TeamEventCard({ event, teamId, onClick, onChannelClick }: TeamEventCardProps) {
  useTranslation();
  const epgClockFormat = useEpgClockFormat();
  const isHome = event.homeTeam.id === teamId;
  const opponent = isHome ? event.awayTeam : event.homeTeam;
  const teamScore = isHome ? event.homeScore : event.awayScore;
  const opponentScore = isHome ? event.awayScore : event.homeScore;
  const isPast = event.startTime.getTime() < Date.now();
  const isLive = event.status === 'live';

  const getResultClass = () => {
    if (teamScore === undefined || opponentScore === undefined) return '';
    if (teamScore > opponentScore) return 'win';
    if (teamScore < opponentScore) return 'loss';
    return 'draw';
  };

  return (
    <div className={`team-schedule-card ${isPast ? getResultClass() : ''}`} onClick={onClick}>
      <div className="team-schedule-card-header">
        <span className="team-schedule-card-date">
          {formatDate(event.startTime, { weekday: 'short', month: 'short', day: 'numeric' })}
        </span>
        <span className="team-schedule-card-time">
          {formatTime(event.startTime, { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' })}
        </span>
        {isLive && <span className="team-schedule-live">{i18n.t('sports:statusLive')}</span>}
      </div>
      
      <div className="team-schedule-card-match">
        <div className="team-schedule-card-opponent">
          {opponent.logo && (
            <img src={opponent.logo} alt="" className="team-schedule-card-logo" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          )}
          <div className="team-schedule-card-opponent-info">
            <span className="team-schedule-card-vs">{isHome ? 'vs' : '@'}</span>
            <span className="team-schedule-card-opponent-name">{opponent.shortName || opponent.name}</span>
          </div>
        </div>
        
        {isPast && teamScore !== undefined && opponentScore !== undefined && (
          <div className={`team-schedule-card-score ${getResultClass()}`}>
            <span className="team-schedule-card-score-team">{teamScore}</span>
            <span className="team-schedule-card-score-sep">-</span>
            <span className="team-schedule-card-score-opp">{opponentScore}</span>
          </div>
        )}
      </div>
      
      <div className="team-schedule-card-footer">
        {isPast && teamScore !== undefined && opponentScore !== undefined && (
          <span className={`team-schedule-card-result ${getResultClass()}`}>
            {teamScore > opponentScore ? 'W' : teamScore < opponentScore ? 'L' : 'T'}
          </span>
        )}
        {event.channels && event.channels.length > 0 && (
          <button
            className="team-schedule-card-channel"
            onClick={(e) => {
              e.stopPropagation();
              onChannelClick?.(event.channels[0].name);
            }}
          >
            {event.channels[0].name}
          </button>
        )}
      </div>
    </div>
  );
}

function AthleteAvatar({ src, name, className = 'team-roster-headshot' }: { src?: string; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const initials = name && name !== 'Athlete' ? name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() : '?';

  if (!src || failed) {
    return <div className={`${className}-placeholder`}>{initials}</div>;
  }

  return (
    <img
      src={src}
      alt={name}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}

interface TeamRosterProps {
  athletes: TeamAthlete[];
  onAthleteClick?: (athleteId: string) => void;
}

function TeamRoster({ athletes, onAthleteClick }: TeamRosterProps) {
  const [selectedPosition, setSelectedPosition] = useState<string>('all');

  const uniqueAthletes = useMemo(() => {
    const seen = new Set<string>();
    const result: TeamAthlete[] = [];
    for (const a of athletes) {
      if (!a.id || seen.has(a.id)) continue;
      seen.add(a.id);
      result.push(a);
    }
    return result;
  }, [athletes]);

  const positions = useMemo(() => [...new Set(uniqueAthletes.map(a => a.position))].filter(Boolean).sort(), [uniqueAthletes]);

  const filteredAthletes = useMemo(() => {
    return selectedPosition === 'all'
      ? uniqueAthletes
      : uniqueAthletes.filter(a => a.position === selectedPosition);
  }, [uniqueAthletes, selectedPosition]);

  const groupedByPosition = useMemo(() => {
    return filteredAthletes.reduce((acc, athlete) => {
      const pos = athlete.position || 'Other';
      if (!acc[pos]) acc[pos] = [];
      acc[pos].push(athlete);
      return acc;
    }, {} as Record<string, TeamAthlete[]>);
  }, [filteredAthletes]);

  return (
    <div className="team-roster">
      <div className="team-roster-filters">
        <button 
          className={`team-roster-filter-btn ${selectedPosition === 'all' ? 'active' : ''}`}
          onClick={() => setSelectedPosition('all')}
        >
          All ({uniqueAthletes.length})
        </button>
        {positions.map(pos => (
          <button 
            key={pos}
            className={`team-roster-filter-btn ${selectedPosition === pos ? 'active' : ''}`}
            onClick={() => setSelectedPosition(pos)}
          >
            {pos}
          </button>
        ))}
      </div>

      {Object.entries(groupedByPosition).map(([pos, posAthletes]) => (
        <div key={pos} className="team-roster-group">
          <h4 className="team-roster-group-title">{pos}</h4>
          <div className="team-roster-list">
            {posAthletes.map(athlete => (
              <div 
                key={athlete.id} 
                className="team-roster-player clickable"
                onClick={() => onAthleteClick?.(athlete.id)}
              >
                <AthleteAvatar src={athlete.headshot} name={athlete.name} className="team-roster-headshot" />
                <div className="team-roster-player-info">
                  <div className="team-roster-name-row">
                    <span className="team-roster-name">{athlete.name}</span>
                    {athlete.jersey && <span className="team-roster-jersey"> #{athlete.jersey}</span>}
                  </div>
                  <span className="team-roster-details">{athlete.position}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

interface TeamDepthChartProps {
  depthChart: DepthChartGroup[];
  roster?: TeamAthlete[];
  onAthleteClick?: (athleteId: string) => void;
}

function TeamDepthChart({ depthChart, roster, onAthleteClick }: TeamDepthChartProps) {
  const groupNames = depthChart.map(g => g.name);
  const [selectedGroup, setSelectedGroup] = useState<string>('all');

  const rosterHeadshotMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const ath of roster || []) {
      if (ath.headshot) {
        map.set(ath.id, ath.headshot);
      }
    }
    return map;
  }, [roster]);

  const visibleGroups = selectedGroup === 'all'
    ? depthChart
    : depthChart.filter(g => g.name === selectedGroup);

  if (depthChart.length === 0) {
    return (
      <div className="sports-no-data" style={{ padding: '32px 16px', textAlign: 'center' }}>
        <span>{i18n.t('sports:noDepthChart', 'No depth chart available for this team.')}</span>
      </div>
    );
  }

  return (
    <div className="team-depth-chart">
      {groupNames.length > 1 && (
        <div className="team-roster-filters" style={{ marginBottom: '16px' }}>
          <button
            className={`team-roster-filter-btn ${selectedGroup === 'all' ? 'active' : ''}`}
            onClick={() => setSelectedGroup('all')}
          >
            All Units
          </button>
          {groupNames.map(name => (
            <button
              key={name}
              className={`team-roster-filter-btn ${selectedGroup === name ? 'active' : ''}`}
              onClick={() => setSelectedGroup(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {visibleGroups.map(group => (
        <div key={group.name} className="team-depth-group">
          <h3 className="sports-section-title">{group.name}</h3>
          <div className="team-depth-grid">
            {group.positions.map(pos => (
              <div key={pos.name} className="team-depth-pos-card">
                <div className="team-depth-pos-header">
                  <span className="team-depth-pos-title">{pos.name}</span>
                </div>
                <div className="team-depth-players">
                  {pos.athletes.map((athlete, idx) => {
                    const headshotSrc = athlete.headshot || rosterHeadshotMap.get(athlete.id);
                    return (
                      <button
                        key={athlete.id} 
                        className="team-depth-player-btn"
                        onClick={() => onAthleteClick?.(athlete.id)}
                      >
                        <span className={`team-depth-rank ${idx === 0 ? 'starter' : ''}`}>{idx + 1}</span>
                        <AthleteAvatar src={headshotSrc} name={athlete.name} className="team-depth-avatar" />
                        <span className="team-depth-name">{athlete.name}</span>
                        {athlete.jersey && <span className="team-depth-player-jersey">#{athlete.jersey}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

interface TeamInjuriesProps {
  injuries: TeamInjury[];
  onAthleteClick?: (athleteId: string) => void;
}

function TeamInjuries({ injuries, onAthleteClick }: TeamInjuriesProps) {
  const getStatusClass = (status: string) => {
    const s = status.toLowerCase();
    if (s.includes('out') || s.includes('ir') || s.includes('disabled')) return 'out';
    if (s.includes('questionable') || s.includes('day-to-day')) return 'questionable';
    return 'probable';
  };

  return (
    <div className="team-injuries-list">
      {injuries.map(injury => (
        <div 
          key={injury.athleteId} 
          className="team-injury-card clickable"
          onClick={() => onAthleteClick?.(injury.athleteId)}
        >
          <AthleteAvatar src={injury.headshot} name={injury.athleteName} className="team-injury-headshot" />
          <div className="team-injury-info">
            <div className="team-injury-header-line">
              <span className="team-injury-name">{injury.athleteName}</span>
              {injury.jersey && <span className="team-injury-jersey">#{injury.jersey}</span>}
              {injury.position && <span className="team-injury-pos">{injury.position}</span>}
              <span className={`team-injury-badge ${getStatusClass(injury.status)}`}>
                {injury.status}
              </span>
            </div>
            {(injury.comment || injury.shortComment) && (
              <p className="team-injury-comment">{injury.comment || injury.shortComment}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

interface TeamLeadersProps {
  leaders: TeamLeaderCategory[];
  onAthleteClick?: (athleteId: string) => void;
}

function TeamLeaderCategoryCard({
  category,
  onAthleteClick,
}: {
  category: TeamLeaderCategory;
  onAthleteClick?: (athleteId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleLeaders = expanded ? category.leaders : category.leaders.slice(0, 5);

  return (
    <div className="team-leader-card">
      <h4 className="team-leader-title">{category.displayName}</h4>
      <div className="team-leader-players">
        {visibleLeaders.map((leader, idx) => (
          <button
            key={leader.athleteId} 
            className="team-leader-player-row"
            onClick={() => onAthleteClick?.(leader.athleteId)}
          >
            <span className="team-leader-rank">{idx + 1}</span>
            <AthleteAvatar src={leader.headshot} name={leader.name} className="team-leader-avatar" />
            <div className="team-leader-player-info">
              <span className="team-leader-player-name">{leader.name}</span>
              {leader.jersey && <span className="team-leader-jersey">#{leader.jersey}</span>}
            </div>
            <span className="team-leader-stat-val">{leader.valueDisplay}</span>
          </button>
        ))}
      </div>

      {category.leaders.length > 5 && (
        <button
          className="team-schedule-toggle-btn"
          style={{ marginTop: '8px', alignSelf: 'center', width: '100%', border: '1px solid rgba(255, 255, 255, 0.1)' }}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? i18n.t('sports:showTop5') : i18n.t('sports:showAllCount', { count: category.leaders.length })}
        </button>
      )}
    </div>
  );
}

function TeamLeaders({ leaders, onAthleteClick }: TeamLeadersProps) {
  return (
    <div className="team-leaders-grid">
      {leaders.map(cat => (
        <TeamLeaderCategoryCard key={cat.name} category={cat} onAthleteClick={onAthleteClick} />
      ))}
    </div>
  );
}

interface TeamNewsProps {
  news: TeamNewsArticle[];
}

function TeamNews({ news }: TeamNewsProps) {
  return (
    <div className="team-news-grid">
      {news.map(article => (
        <a 
          key={article.id} 
          href={article.link} 
          target="_blank" 
          rel="noopener noreferrer"
          className="team-news-card"
        >
          {article.imageUrl && (
            <img src={article.imageUrl} alt="" className="team-news-image" />
          )}
          <div className="team-news-content">
            <h4 className="team-news-headline">{article.headline}</h4>
            {article.description && (
              <p className="team-news-desc">{article.description}</p>
            )}
            <span className="team-news-published">{article.published}</span>
          </div>
        </a>
      ))}
    </div>
  );
}
