import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState, useCallback } from 'react';
import './TVCalendarPage.css';
import { ShowDetailsModal } from './ShowDetailsModal';

// Types
interface CalendarEpisode {
  airdate: string | null;
  airtime: string | null;
  episode_name: string | null;
  season: number | null;
  episode: number | null;
  show_name: string;
  channel_name: string | null;
  show_image: string | null;
}

interface TrackedShow {
  tvmaze_id: number;
  show_name: string;
  show_image: string | null;
  channel_name: string | null;
  channel_id: string | null;
  status: string | null;
  last_synced: string | null;
}

interface TVMazeShow {
  id: number;
  name: string;
  status?: string;
  image?: { medium?: string };
  network?: { name?: string };
  summary?: string;
}

interface TVMazeSearchResult {
  score: number;
  show: TVMazeShow;
}

type TVCalendarTab = 'search' | 'calendar' | 'upcoming' | 'myshows';

// Types for upcoming shows
interface UpcomingEpisode {
  id: number;
  name?: string;
  season?: number;
  number?: number;
  airdate?: string;
  airtime?: string;
  runtime?: number;
  summary?: string;
  image?: {
    medium?: string;
    original?: string;
  };
  _embedded?: {
    show: {
      id: number;
      name: string;
      type?: string;
      genres?: string[];
      status?: string;
      image?: {
        medium?: string;
        original?: string;
      };
      network?: {
        name?: string;
      };
      webChannel?: {
        name?: string;
      };
    };
  };
}

interface Props {
  onClose: () => void;
  onPlayChannel?: (channelName: string) => void;
}

// Tab Icons
const SearchIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const CalendarIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);

const ShowsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="2" y="2" width="20" height="20" rx="2.18" />
    <line x1="7" y1="2" x2="7" y2="22" />
    <line x1="17" y1="2" x2="17" y2="22" />
    <line x1="2" y1="12" x2="22" y2="12" />
  </svg>
);

const UpcomingIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

export function TVCalendarPage({ onClose, onPlayChannel }: Props) {
  const [activeTab, setActiveTab] = useState<TVCalendarTab>('calendar');

  // Calendar state
  const [now, setNow] = useState(() => new Date());
  const [episodes, setEpisodes] = useState<CalendarEpisode[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  // My Shows state
  const [shows, setShows] = useState<TrackedShow[]>([]);
  const [showsLoading, setShowsLoading] = useState(true);
  const [showSearchQuery, setShowSearchQuery] = useState('');
  const [removingId, setRemovingId] = useState<number | null>(null);

  // Search tab state
  const [tvmazeQuery, setTvmazeQuery] = useState('');
  const [tvmazeResults, setTvmazeResults] = useState<TVMazeSearchResult[]>([]);
  const [tvmazeLoading, setTvmazeLoading] = useState(false);
  const [addingShowId, setAddingShowId] = useState<number | null>(null);

  // Selected show details
  const [selectedShow, setSelectedShow] = useState<TrackedShow | null>(null);

  // Upcoming shows state
  const [upcomingEpisodes, setUpcomingEpisodes] = useState<UpcomingEpisode[]>([]);
  const [upcomingLoading, setUpcomingLoading] = useState(true);
  const [upcomingError, setUpcomingError] = useState<string | null>(null);

  const monthKey = useMemo(() => {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }, [now]);

  // Load calendar episodes
  useEffect(() => {
    if (activeTab !== 'calendar') return;
    setCalendarLoading(true);
    invoke<CalendarEpisode[]>('get_calendar_episodes', { month: monthKey })
      .then(setEpisodes)
      .catch(console.error)
      .finally(() => setCalendarLoading(false));
  }, [monthKey, activeTab]);

  // Load tracked shows
  useEffect(() => {
    if (activeTab !== 'myshows') return;
    loadShows();
  }, [activeTab]);

  // Load upcoming shows
  useEffect(() => {
    if (activeTab !== 'upcoming') return;
    loadUpcomingShows();
  }, [activeTab]);

  // Group upcoming episodes by date - computed at top level to follow hooks rules
  const groupedUpcomingEpisodes = useMemo(() => {
    const groups: Record<string, UpcomingEpisode[]> = {};
    upcomingEpisodes.forEach(ep => {
      const date = ep.airdate || 'Unknown';
      if (!groups[date]) groups[date] = [];
      groups[date].push(ep);
    });
    return groups;
  }, [upcomingEpisodes]);

  async function loadUpcomingShows() {
    setUpcomingLoading(true);
    setUpcomingError(null);
    try {
      const allEpisodes: UpcomingEpisode[] = [];
      const today = new Date();

      // Fetch next 7 days
      for (let i = 0; i < 7; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);
        const dateStr = date.toISOString().split('T')[0];

        const response = await fetch(
          `https://api.tvmaze.com/schedule/web?date=${dateStr}&country=US`
        );
        if (!response.ok) throw new Error(`Failed to fetch schedule for ${dateStr}`);

        const episodes: UpcomingEpisode[] = await response.json();
        allEpisodes.push(...episodes);
      }

      setUpcomingEpisodes(allEpisodes);
    } catch (e: any) {
      console.error('[TVCalendarPage] Failed to load upcoming shows:', e);
      setUpcomingError(e.toString());
    } finally {
      setUpcomingLoading(false);
    }
  }

  async function loadShows() {
    setShowsLoading(true);
    try {
      const result = await invoke<TrackedShow[]>('get_tracked_shows');
      setShows(result);
    } catch (e) {
      console.error('[TVCalendarPage] Failed to load shows:', e);
    } finally {
      setShowsLoading(false);
    }
  }

  // Helper function to strip HTML tags
  function stripHtml(html: string): string {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, '');
  }

  // TVMaze search
  const searchTVMaze = useCallback(async () => {
    if (!tvmazeQuery.trim()) return;
    setTvmazeLoading(true);
    try {
      const results = await invoke<TVMazeSearchResult[]>('search_tvmaze', { query: tvmazeQuery.trim() });
      setTvmazeResults(results);
    } catch (e) {
      console.error('[TVCalendarPage] TVMaze search failed:', e);
    } finally {
      setTvmazeLoading(false);
    }
  }, [tvmazeQuery]);

  async function addShow(show: TVMazeShow) {
    setAddingShowId(show.id);
    try {
      await invoke('add_tv_favorite', {
        tvmazeId: show.id,
        showName: show.name,
        showImage: show.image?.medium ?? null,
        channelName: null,
        channelId: null,
        status: show.status ?? null,
      });
      // Refresh shows and switch to My Shows
      await loadShows();
      setActiveTab('myshows');
    } catch (e: any) {
      alert('Failed to add show: ' + e);
    } finally {
      setAddingShowId(null);
    }
  }

  async function removeShow(tvmazeId: number, showName: string) {
    if (!confirm(`Remove "${showName}" from your tracked shows?`)) return;
    setRemovingId(tvmazeId);
    try {
      await invoke('remove_tv_favorite', { tvmazeId });
      setShows(prev => prev.filter(s => s.tvmaze_id !== tvmazeId));
    } catch (e: any) {
      alert('Failed to remove show: ' + e);
    } finally {
      setRemovingId(null);
    }
  }

  async function manualSync() {
    setSyncing(true);
    try {
      await invoke<number>('sync_tvmaze_shows');
      // Refresh calendar
      const eps = await invoke<CalendarEpisode[]>('get_calendar_episodes', { month: monthKey });
      setEpisodes(eps);
    } catch (e) {
      alert('Sync failed: ' + e);
    } finally {
      setSyncing(false);
    }
  }

  // Calendar helpers
  function changeMonth(delta: number) {
    setNow(prev => {
      const n = new Date(prev);
      n.setMonth(n.getMonth() + delta);
      return n;
    });
  }

  const daysInMonth = useMemo(() => {
    const year = now.getFullYear();
    const month = now.getMonth();
    const firstDay = new Date(year, month, 1);
    const days: Date[] = [];
    const startPadding = firstDay.getDay();
    for (let i = startPadding - 1; i >= 0; i--) {
      days.push(new Date(year, month, -i));
    }
    const count = new Date(year, month + 1, 0).getDate();
    for (let d = 1; d <= count; d++) days.push(new Date(year, month, d));
    return days;
  }, [now]);

  const episodesByDay = useMemo(() => {
    const map: Record<string, CalendarEpisode[]> = {};
    for (const ep of episodes) {
      if (!ep.airdate) continue;
      const key = ep.airdate.slice(0, 10);
      if (!map[key]) map[key] = [];
      map[key].push(ep);
    }
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => (a.airtime ?? '').localeCompare(b.airtime ?? ''));
    }
    return map;
  }, [episodes]);

  // Filtered shows for My Shows tab
  const filteredShows = useMemo(() => {
    if (!showSearchQuery.trim()) return shows;
    const query = showSearchQuery.toLowerCase();
    return shows.filter(s =>
      s.show_name.toLowerCase().includes(query) ||
      (s.channel_name?.toLowerCase() || '').includes(query)
    );
  }, [shows, showSearchQuery]);

  // Status helpers
  const getStatusColor = (status: string | null) => {
    switch (status?.toLowerCase()) {
      case 'running': return '#4ade80';
      case 'ended': return '#f87171';
      case 'to be determined': return '#fbbf24';
      case 'in development': return '#60a5fa';
      default: return '#9ca3af';
    }
  };

  // Render Search Tab
  const renderSearchTab = () => (
    <div className="tvcp-search-tab">
      <div className="tvcp-search-header">
        <h2>Search TV Shows</h2>
        <p>Find and track shows from TVMaze</p>
      </div>

      <div className="tvcp-search-box">
        <input
          type="text"
          placeholder="Search for a TV show..."
          value={tvmazeQuery}
          onChange={e => setTvmazeQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && searchTVMaze()}
        />
        <button onClick={searchTVMaze} disabled={tvmazeLoading || !tvmazeQuery.trim()}>
          {tvmazeLoading ? (
            <div className="tvcp-spinner-small" />
          ) : (
            <SearchIcon />
          )}
          Search
        </button>
      </div>

      {tvmazeResults.length > 0 && (
        <div className="tvcp-search-results">
          <h3>Search Results</h3>
          <div className="tvcp-results-grid">
            {tvmazeResults.map(result => (
              <div key={result.show.id} className="tvcp-result-card">
                <div className="tvcp-result-poster">
                  {result.show.image?.medium ? (
                    <img src={result.show.image.medium} alt={result.show.name} />
                  ) : (
                    <div className="tvcp-result-placeholder">
                      <ShowsIcon />
                    </div>
                  )}
                </div>
                <div className="tvcp-result-info">
                  <h4>{result.show.name}</h4>
                  <span className="tvcp-result-network">{result.show.network?.name || 'Unknown Network'}</span>
                  {result.show.status && (
                    <span
                      className="tvcp-result-status"
                      style={{ backgroundColor: getStatusColor(result.show.status) }}
                    >
                      {result.show.status}
                    </span>
                  )}
                  {result.show.summary && (
                    <p className="tvcp-result-summary">
                      {result.show.summary.replace(/<[^>]*>/g, '').slice(0, 150)}...
                    </p>
                  )}
                  <button
                    className="tvcp-add-show-btn"
                    onClick={() => addShow(result.show)}
                    disabled={addingShowId === result.show.id}
                  >
                    {addingShowId === result.show.id ? (
                      <>
                        <div className="tvcp-spinner-small" />
                        Adding...
                      </>
                    ) : (
                      <>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        Track Show
                      </>
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tvmazeResults.length === 0 && tvmazeQuery && !tvmazeLoading && (
        <div className="tvcp-search-empty">
          <ShowsIcon />
          <p>No shows found. Try a different search term.</p>
        </div>
      )}
    </div>
  );

  // Render Calendar Tab
  const renderCalendarTab = () => {
    const monthLabel = now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    return (
      <div className="tvcp-calendar-tab">
        <div className="tvcp-calendar-header">
          <h2>TV Calendar</h2>
          <div className="tvcp-calendar-controls">
            <button onClick={() => changeMonth(-1)}>← Prev</button>
            <span className="tvcp-month-label">{monthLabel}</span>
            <button onClick={() => changeMonth(1)}>Next →</button>
            <button onClick={manualSync} disabled={syncing} className="tvcp-sync-btn">
              {syncing ? 'Syncing…' : '↻ Sync'}
            </button>
          </div>
        </div>

        <div className="tvcp-calendar-grid-container">
          <div className="tvcp-weekdays">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
              <div key={d} className="tvcp-weekday">{d}</div>
            ))}
          </div>

          {calendarLoading ? (
            <div className="tvcp-calendar-loading">
              <div className="tvcp-spinner" />
              <span>Loading episodes...</span>
            </div>
          ) : (
            <div className="tvcp-calendar-grid">
              {daysInMonth.map(date => {
                const dateKey = date.toISOString().slice(0, 10);
                const dayEps = episodesByDay[dateKey] ?? [];
                const isCurrentMonth = date.getMonth() === now.getMonth();
                const isToday = new Date().toDateString() === date.toDateString();

                return (
                  <div
                    key={dateKey}
                    className={`tvcp-day ${!isCurrentMonth ? 'other-month' : ''} ${isToday ? 'today' : ''}`}
                  >
                    <div className="tvcp-daynum">{date.getDate()}</div>
                    <div className="tvcp-daycontent">
                      {dayEps.slice(0, 3).map((ep, i) => (
                        <div
                          key={i}
                          className="tvcp-episode"
                          onClick={() => ep.channel_name && onPlayChannel?.(ep.channel_name)}
                          style={{ cursor: ep.channel_name ? 'pointer' : 'default' }}
                          title={`${ep.show_name} S${ep.season ?? '?'}E${ep.episode ?? '?'}${ep.channel_name ? ` on ${ep.channel_name}` : ''}`}
                        >
                          <span className="tvcp-ep-time">{ep.airtime ?? 'TBA'}</span>
                          <span className="tvcp-ep-show">{ep.show_name}</span>
                        </div>
                      ))}
                      {dayEps.length > 3 && (
                        <div className="tvcp-more-episodes">+{dayEps.length - 3} more</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  };

  // Render Upcoming Shows Tab
  const renderUpcomingTab = () => {
    const sortedDates = Object.keys(groupedUpcomingEpisodes).sort();

    return (
      <div className="tvcp-upcoming-tab">
        <div className="tvcp-upcoming-header">
          <h2>Upcoming Shows</h2>
          <p>TV Schedule for the next 7 days</p>
        </div>

        {upcomingLoading ? (
          <div className="tvcp-upcoming-loading">
            <div className="tvcp-spinner" />
            <span>Loading upcoming episodes...</span>
          </div>
        ) : upcomingError ? (
          <div className="tvcp-upcoming-error">
            <p>Failed to load upcoming shows</p>
            <span>{upcomingError}</span>
            <button onClick={loadUpcomingShows}>Retry</button>
          </div>
        ) : upcomingEpisodes.length === 0 ? (
          <div className="tvcp-upcoming-empty">
            <UpcomingIcon />
            <p>No upcoming episodes found</p>
          </div>
        ) : (
          <div className="tvcp-upcoming-content">
            {sortedDates.map(date => {
              const dateEpisodes = groupedUpcomingEpisodes[date];
              const dateObj = date !== 'Unknown' ? new Date(date) : null;
              const isToday = dateObj && dateObj.toDateString() === new Date().toDateString();

              return (
                <div key={date} className="tvcp-upcoming-day">
                  <div className="tvcp-upcoming-date-header">
                    <div className={`tvcp-date-badge ${isToday ? 'today' : ''}`}>
                      <span className="tvcp-date-day">
                        {dateObj ? dateObj.toLocaleDateString(undefined, { weekday: 'short' }) : '???'}
                      </span>
                      <span className="tvcp-date-num">
                        {dateObj ? dateObj.getDate() : '?'}
                      </span>
                    </div>
                    <span className="tvcp-date-full">
                      {dateObj ? dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : 'Unknown Date'}
                    </span>
                    <span className="tvcp-date-count">{dateEpisodes.length} episodes</span>
                  </div>

                  <div className="tvcp-upcoming-episodes">
                    {dateEpisodes.map(episode => {
                      const show = episode._embedded?.show;
                      const showImage = show?.image?.medium || episode.image?.medium;
                      const isAdding = addingShowId === show?.id;

                      // Check if show is already tracked
                      const isTracked = shows.some(s => s.tvmaze_id === show?.id);

                      return (
                        <div key={episode.id} className="tvcp-upcoming-card">
                          <div
                            className="tvcp-upcoming-card-content"
                            onClick={() => show && setSelectedShow({
                              tvmaze_id: show.id,
                              show_name: show.name,
                              show_image: show.image?.medium ?? null,
                              channel_name: show.network?.name || show.webChannel?.name || null,
                              channel_id: null,
                              status: show.status ?? null,
                              last_synced: null,
                            })}
                            style={{ cursor: show ? 'pointer' : 'default' }}
                          >
                            <div className="tvcp-upcoming-image">
                              {showImage ? (
                                <img src={showImage} alt={show?.name || 'Show'} />
                              ) : (
                                <div className="tvcp-upcoming-placeholder">
                                  <ShowsIcon />
                                </div>
                              )}
                            </div>
                            <div className="tvcp-upcoming-info">
                              <h4>{show?.name || 'Unknown Show'}</h4>
                              <div className="tvcp-upcoming-episode-title">
                                {episode.name || `Episode ${episode.number}`}
                                {episode.season && episode.number && (
                                  <span className="tvcp-se-num">S{episode.season}E{episode.number}</span>
                                )}
                              </div>
                              <div className="tvcp-upcoming-meta">
                                {episode.airtime && <span>{episode.airtime}</span>}
                                {episode.runtime && (
                                  <>
                                    <span className="tvcp-dot">•</span>
                                    <span>{episode.runtime} min</span>
                                  </>
                                )}
                                {show?.genres && show.genres.length > 0 && (
                                  <>
                                    <span className="tvcp-dot">•</span>
                                    <span className="tvcp-genre-tag">{show.genres[0]}</span>
                                  </>
                                )}
                              </div>
                              {episode.summary && (
                                <p className="tvcp-upcoming-summary">{stripHtml(episode.summary)}</p>
                              )}
                            </div>
                          </div>
                          {show && !isTracked && (
                            <button
                              className="tvcp-upcoming-add-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                addShow(show);
                              }}
                              disabled={isAdding}
                              title="Add to My Shows"
                            >
                              {isAdding ? (
                                <div className="tvcp-spinner-small" />
                              ) : (
                                <>
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <line x1="12" y1="5" x2="12" y2="19" />
                                    <line x1="5" y1="12" x2="19" y2="12" />
                                  </svg>
                                  My Shows
                                </>
                              )}
                            </button>
                          )}
                          {show && isTracked && (
                            <span className="tvcp-upcoming-tracked-badge">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                              Tracked
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // Render My Shows Tab
  const renderMyShowsTab = () => (
    <div className="tvcp-myshows-tab">
      <div className="tvcp-myshows-header">
        <h2>My Shows</h2>
        <div className="tvcp-myshows-search">
          <input
            type="text"
            placeholder="Search your shows..."
            value={showSearchQuery}
            onChange={e => setShowSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {showsLoading ? (
        <div className="tvcp-myshows-loading">
          <div className="tvcp-spinner" />
          <span>Loading your shows...</span>
        </div>
      ) : filteredShows.length === 0 ? (
        <div className="tvcp-myshows-empty">
          <ShowsIcon />
          <h3>{showSearchQuery ? 'No shows match your search' : 'No shows tracked yet'}</h3>
          <p>{showSearchQuery ? 'Try a different search term' : 'Go to the Search tab to find and track shows'}</p>
        </div>
      ) : (
        <div className="tvcp-myshows-grid">
          {filteredShows.map(show => (
            <div
              key={show.tvmaze_id}
              className="tvcp-myshow-card"
              onClick={() => setSelectedShow(show)}
              style={{ cursor: 'pointer' }}
            >
              <div className="tvcp-myshow-poster">
                {show.show_image ? (
                  <img src={show.show_image} alt={show.show_name} />
                ) : (
                  <div className="tvcp-myshow-placeholder">
                    <ShowsIcon />
                  </div>
                )}
                <span
                  className="tvcp-myshow-status"
                  style={{ backgroundColor: getStatusColor(show.status) }}
                >
                  {show.status || 'Unknown'}
                </span>
              </div>
              <div className="tvcp-myshow-info">
                <h4>{show.show_name}</h4>
                {show.channel_name && (
                  <div className="tvcp-myshow-channel">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    {show.channel_name}
                  </div>
                )}
                {show.last_synced && (
                  <span className="tvcp-myshow-synced">
                    Synced {new Date(show.last_synced).toLocaleDateString()}
                  </span>
                )}
              </div>
              <div className="tvcp-myshow-actions">
                {show.channel_name && onPlayChannel && (
                  <button
                    className="tvcp-action-btn tvcp-play-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPlayChannel(show.channel_name!);
                      onClose();
                    }}
                    title="Play channel"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  </button>
                )}
                <button
                  className="tvcp-action-btn tvcp-remove-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeShow(show.tvmaze_id, show.show_name);
                  }}
                  disabled={removingId === show.tvmaze_id}
                  title="Remove show"
                >
                  {removingId === show.tvmaze_id ? (
                    <div className="tvcp-spinner-small" />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderContent = () => {
    switch (activeTab) {
      case 'search':
        return renderSearchTab();
      case 'calendar':
        return renderCalendarTab();
      case 'upcoming':
        return renderUpcomingTab();
      case 'myshows':
        return renderMyShowsTab();
    }
  };

  return (
    <div className="tvcp-page">
      <aside className="tvcp-sidebar">
        <div className="tvcp-sidebar-header">
          <h2 className="tvcp-sidebar-title">TV Calendar</h2>
          <p className="tvcp-sidebar-subtitle">Track Shows & Episodes</p>
        </div>

        <nav className="tvcp-nav">
          <button
            className={`tvcp-nav-item ${activeTab === 'search' ? 'active' : ''}`}
            onClick={() => setActiveTab('search')}
          >
            <span className="tvcp-nav-icon"><SearchIcon /></span>
            <span className="tvcp-nav-label">Search Shows</span>
          </button>
          <button
            className={`tvcp-nav-item ${activeTab === 'calendar' ? 'active' : ''}`}
            onClick={() => setActiveTab('calendar')}
          >
            <span className="tvcp-nav-icon"><CalendarIcon /></span>
            <span className="tvcp-nav-label">Calendar</span>
          </button>
          <button
            className={`tvcp-nav-item ${activeTab === 'upcoming' ? 'active' : ''}`}
            onClick={() => setActiveTab('upcoming')}
          >
            <span className="tvcp-nav-icon"><UpcomingIcon /></span>
            <span className="tvcp-nav-label">Upcoming Shows</span>
          </button>
          <button
            className={`tvcp-nav-item ${activeTab === 'myshows' ? 'active' : ''}`}
            onClick={() => setActiveTab('myshows')}
          >
            <span className="tvcp-nav-icon"><ShowsIcon /></span>
            <span className="tvcp-nav-label">My Shows</span>
            {shows.length > 0 && <span className="tvcp-nav-badge">{shows.length}</span>}
          </button>
        </nav>

        <div className="tvcp-sidebar-footer">
          <button className="tvcp-back-btn" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back to TV
          </button>
        </div>
      </aside>

      <main className="tvcp-main">
        {renderContent()}
      </main>

      {/* Show Details Modal */}
      {selectedShow && (
        <ShowDetailsModal
          tvmazeId={selectedShow.tvmaze_id}
          showName={selectedShow.show_name}
          channelName={selectedShow.channel_name}
          onClose={() => setSelectedShow(null)}
          onPlayChannel={onPlayChannel}
        />
      )}
    </div>
  );
}
