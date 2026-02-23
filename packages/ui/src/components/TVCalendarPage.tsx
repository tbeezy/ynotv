import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import './TVCalendarPage.css';
import { ShowDetailsModal } from './ShowDetailsModal';
import { db, addTvEpisodeToWatchlist, clearAutoAddedEpisodesForShow, type StoredChannel, type AutoAddEpisode } from '../db';

// Cache storage key for localStorage
const CACHE_STORAGE_KEY = 'tvmaze_episode_cache';

// Load cache from localStorage
const loadCacheFromStorage = (): Record<number, EpisodeCache> => {
  try {
    const stored = localStorage.getItem(CACHE_STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('[TVCalendarPage] Failed to load cache from storage:', e);
  }
  return {};
};

// Save cache to localStorage
const saveCacheToStorage = (cache: Record<number, EpisodeCache>) => {
  try {
    localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch (e) {
    console.error('[TVCalendarPage] Failed to save cache to storage:', e);
  }
};

// Global cache for TVMaze API responses - persists across component unmounts
interface EpisodeCache {
  episodes: any[];
  nextAirDate: string | null;
  lastFetched: number;
}
const globalEpisodeCache: Record<number, EpisodeCache> = loadCacheFromStorage();

// Rate limiting state - global to persist across unmounts
const apiCallQueue: (() => Promise<void>)[] = [];
const apiCallTimes: number[] = [];
let processingQueue = false;

// Types
interface CalendarEpisode {
  tvmaze_episode_id: number | null;
  airdate: string | null;
  airtime: string | null;
  airstamp: string | null;
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
  auto_add_to_watchlist: boolean;
  watchlist_reminder_enabled: boolean;
  watchlist_reminder_minutes: number;
  watchlist_autoswitch_enabled: boolean;
  watchlist_autoswitch_seconds: number;
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
  airstamp?: string;
  runtime?: number;
  summary?: string;
  image?: {
    medium?: string;
    original?: string;
  };
  // /schedule endpoint has show directly
  show?: {
    id: number;
    name: string;
    type?: string;
    language?: string;
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
  // /schedule/web endpoint has it in _embedded
  _embedded?: {
    show: {
      id: number;
      name: string;
      type?: string;
      language?: string;
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

  // Delete confirmation modal state
  const [deleteModalShow, setDeleteModalShow] = useState<TrackedShow | null>(null);

  // Episode details modal state
  const [selectedEpisode, setSelectedEpisode] = useState<CalendarEpisode | null>(null);
  const [episodeDetails, setEpisodeDetails] = useState<any | null>(null);
  const [episodeDetailsLoading, setEpisodeDetailsLoading] = useState(false);

  // Sync success modal state
  const [syncModalMessage, setSyncModalMessage] = useState<string | null>(null);

  // Upcoming episodes for tracked shows
  const [showEpisodes, setShowEpisodes] = useState<Record<number, UpcomingEpisode[]>>({});
  const [loadingEpisodes, setLoadingEpisodes] = useState<Set<number>>(new Set());

  // Use global cache and rate limiting (defined outside component)
  const episodeCache = useRef(globalEpisodeCache);

  const processApiQueue = async () => {
    if (processingQueue) return;
    processingQueue = true;

    while (apiCallQueue.length > 0) {
      // Clean up old call times (older than 10 seconds)
      const now = Date.now();
      for (let i = apiCallTimes.length - 1; i >= 0; i--) {
        if (now - apiCallTimes[i] >= 10000) {
          apiCallTimes.splice(i, 1);
        }
      }

      // Check if we can make a call (under 20 calls in last 10 seconds)
      if (apiCallTimes.length >= 20) {
        // Wait until we can make a call
        const oldestCall = apiCallTimes[0];
        const waitTime = 10000 - (now - oldestCall) + 50; // 50ms buffer
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      // Make the call
      const call = apiCallQueue.shift();
      if (call) {
        apiCallTimes.push(Date.now());
        await call();
      }
    }

    processingQueue = false;
  };

  const queueApiCall = (call: () => Promise<void>) => {
    apiCallQueue.push(call);
    processApiQueue();
  };

  // Check if cache is stale
  const isCacheStale = (cache: EpisodeCache): boolean => {
    const now = new Date();
    const lastFetched = new Date(cache.lastFetched);

    // Stale if 24 hours have passed
    const hoursSinceFetch = (now.getTime() - lastFetched.getTime()) / (1000 * 60 * 60);
    if (hoursSinceFetch >= 24) return true;

    // Stale if current date is past the next episode air date
    if (cache.nextAirDate) {
      const nextAir = new Date(cache.nextAirDate);
      // Add 1 day to next air date to consider it "past"
      nextAir.setDate(nextAir.getDate() + 1);
      if (now > nextAir) return true;
    }

    return false;
  };

  // Upcoming shows state
  const [upcomingEpisodes, setUpcomingEpisodes] = useState<UpcomingEpisode[]>([]);
  const [upcomingLoading, setUpcomingLoading] = useState(true);
  const [upcomingError, setUpcomingError] = useState<string | null>(null);
  const [upcomingDate, setUpcomingDate] = useState<string>(() => {
    return new Date().toISOString().split('T')[0];
  });

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

  // Load episodes for tracked shows
  useEffect(() => {
    if (activeTab !== 'myshows' || shows.length === 0) return;
    loadEpisodesForShows();
  }, [activeTab, shows]);

  // Load upcoming shows
  useEffect(() => {
    if (activeTab !== 'upcoming') return;
    loadUpcomingShows();
  }, [activeTab, upcomingDate]);

  // Group upcoming episodes by date
  const groupedUpcomingEpisodes = useMemo(() => {
    const groups: Record<string, UpcomingEpisode[]> = {};
    upcomingEpisodes.forEach(ep => {
      const date = ep.airdate || 'Unknown';
      if (!groups[date]) groups[date] = [];
      groups[date].push(ep);
    });
    return groups;
  }, [upcomingEpisodes]);

  // Navigation helpers for date
  const goToPreviousDay = () => {
    const date = new Date(upcomingDate);
    date.setDate(date.getDate() - 1);
    setUpcomingDate(date.toISOString().split('T')[0]);
  };

  const goToNextDay = () => {
    const date = new Date(upcomingDate);
    date.setDate(date.getDate() + 1);
    setUpcomingDate(date.toISOString().split('T')[0]);
  };

  const goToToday = () => {
    setUpcomingDate(new Date().toISOString().split('T')[0]);
  };

  // Show types to filter out from Upcoming Shows
  const EXCLUDED_TYPES = ['Talk Show', 'News', 'Game Show', 'Sports', 'Variety'];

  async function loadUpcomingShows() {
    setUpcomingLoading(true);
    setUpcomingError(null);
    try {
      const response = await fetch(
        `https://api.tvmaze.com/schedule?country=US&date=${upcomingDate}`
      );
      if (!response.ok) throw new Error(`Failed to fetch schedule for ${upcomingDate}`);

      const episodes: UpcomingEpisode[] = await response.json();

      // Filter out news, talk shows, and other bloat; keep only English shows
      const filteredEpisodes = episodes.filter(ep => {
        const show = ep.show || ep._embedded?.show;
        if (!show) return false;

        // Filter out excluded show types
        if (show.type && EXCLUDED_TYPES.includes(show.type)) return false;

        // Filter for English language only
        if (show.language && show.language !== 'English') return false;

        return true;
      });

      setUpcomingEpisodes(filteredEpisodes);
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

  async function loadEpisodesForShows() {
    const now = new Date();
    const episodeMap: Record<number, UpcomingEpisode[]> = {};
    const loadingSet = new Set<number>();

    // Check cache first
    for (const show of shows) {
      const cache = episodeCache.current[show.tvmaze_id];
      if (cache && !isCacheStale(cache)) {
        // Use cached data
        episodeMap[show.tvmaze_id] = cache.episodes;
      } else {
        // Need to fetch
        loadingSet.add(show.tvmaze_id);
      }
    }

    // If all shows are cached, just update state and return
    if (loadingSet.size === 0) {
      const cachedEpisodes: Record<number, UpcomingEpisode[]> = {};
      for (const show of shows) {
        const cache = episodeCache.current[show.tvmaze_id];
        if (cache) {
          cachedEpisodes[show.tvmaze_id] = cache.episodes;
        }
      }
      setShowEpisodes(cachedEpisodes);
      return;
    }

    setLoadingEpisodes(loadingSet);

    // Fetch uncached shows with rate limiting
    const fetchPromises = shows
      .filter(show => loadingSet.has(show.tvmaze_id))
      .map(show => {
        return new Promise<void>((resolve) => {
          queueApiCall(async () => {
            try {
              const result = await invoke<{ episodes: UpcomingEpisode[] }>('get_show_details_with_episodes', {
                tvmazeId: show.tvmaze_id,
              });

              // Filter future episodes and sort by date
              const futureEpisodes = result.episodes
                .filter((ep) => ep.airdate && new Date(ep.airdate) >= now)
                .sort((a, b) => {
                  const dateA = a.airdate ? new Date(a.airdate).getTime() : 0;
                  const dateB = b.airdate ? new Date(b.airdate).getTime() : 0;
                  return dateA - dateB;
                });

              // Get next air date
              const nextAirDate = futureEpisodes.length > 0 ? futureEpisodes[0].airdate || null : null;

              // Update cache
              episodeCache.current[show.tvmaze_id] = {
                episodes: futureEpisodes,
                nextAirDate,
                lastFetched: Date.now(),
              };

              episodeMap[show.tvmaze_id] = futureEpisodes;
            } catch (e) {
              console.error(`[TVCalendarPage] Failed to load episodes for ${show.show_name}:`, e);
              // Keep cached data if available, otherwise empty
              const cached = episodeCache.current[show.tvmaze_id];
              episodeMap[show.tvmaze_id] = cached?.episodes || [];
            }
            resolve();
          });
        });
      });

    await Promise.all(fetchPromises);

    // Wait for queue to finish processing
    while (apiCallQueue.length > 0 || processingQueue) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Save cache to localStorage
    saveCacheToStorage(episodeCache.current);

    setShowEpisodes(prev => ({ ...prev, ...episodeMap }));
    setLoadingEpisodes(new Set());
  }

  // Helper function to strip HTML tags
  function stripHtml(html: string): string {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, '');
  }

  // Handle episode click - show episode details
  async function handleEpisodeClick(episode: CalendarEpisode) {
    if (!episode.tvmaze_episode_id) {
      console.log('[TVCalendarPage] No tvmaze_episode_id available for this episode');
      return;
    }
    setSelectedEpisode(episode);
    setEpisodeDetailsLoading(true);
    setEpisodeDetails(null);
    try {
      const details = await invoke('get_episode_details', { tvmazeEpisodeId: episode.tvmaze_episode_id });
      setEpisodeDetails(details);
    } catch (e) {
      console.error('[TVCalendarPage] Failed to load episode details:', e);
    } finally {
      setEpisodeDetailsLoading(false);
    }
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

  async function addShow(show: TVMazeShow, networkName?: string) {
    setAddingShowId(show.id);
    try {
      await invoke('add_tv_favorite', {
        tvmazeId: show.id,
        showName: show.name,
        showImage: show.image?.medium ?? null,
        channelName: networkName ?? show.network?.name ?? null,
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

  function confirmRemoveShow(show: TrackedShow) {
    setDeleteModalShow(show);
  }

  async function executeRemoveShow() {
    if (!deleteModalShow) return;
    const { tvmaze_id, show_name } = deleteModalShow;
    setRemovingId(tvmaze_id);
    try {
      await invoke('remove_tv_favorite', { tvmazeId: tvmaze_id });
      setShows(prev => prev.filter(s => s.tvmaze_id !== tvmaze_id));
      setDeleteModalShow(null);
    } catch (e: any) {
      alert('Failed to remove show: ' + e);
    } finally {
      setRemovingId(null);
    }
  }

  async function manualSync() {
    setSyncing(true);
    try {
      const result = await invoke<{
        synced_count: number;
        watchlist_added_count: number;
        episodes_to_add: AutoAddEpisode[];
      }>('sync_tvmaze_shows');

      // Add auto-added episodes to watchlist
      if (result.episodes_to_add && result.episodes_to_add.length > 0) {
        // Group episodes by show to clear each show's old entries before adding new ones
        const episodesByShow = new Map<number, AutoAddEpisode[]>();
        for (const ep of result.episodes_to_add) {
          const existing = episodesByShow.get(ep.tvmaze_id) || [];
          existing.push(ep);
          episodesByShow.set(ep.tvmaze_id, existing);
        }

        let addedCount = 0;
        for (const [tvmazeId, episodes] of episodesByShow) {
          // Clear existing auto-added episodes for this show
          await clearAutoAddedEpisodesForShow(tvmazeId);

          // Add new episodes
          for (const ep of episodes) {
            if (ep.channel_id) {
              const channel = await db.channels.get(ep.channel_id);
              if (channel) {
                const added = await addTvEpisodeToWatchlist(ep, channel);
                if (added) addedCount++;
              } else {
                console.warn('[TVCalendarPage] Channel not found for auto-add:', ep.channel_id);
              }
            }
          }
        }

        if (addedCount > 0) {
          setSyncModalMessage(`Added ${addedCount} episode${addedCount !== 1 ? 's' : ''} to your watchlist`);
        }
      }

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
                          onClick={() => handleEpisodeClick(ep)}
                          style={{ cursor: 'pointer' }}
                          title={`${ep.show_name} S${ep.season ?? '?'}E${ep.episode ?? '?'}${ep.channel_name ? ` on ${ep.channel_name}` : ''} - Click for details`}
                        >
                          <span className="tvcp-ep-time">
                            {/* Use airstamp for accurate local timezone conversion */}
                            {ep.airstamp
                              ? new Date(ep.airstamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
                              : ep.airtime ?? 'TBA'}
                          </span>
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
    const dateObj = new Date(upcomingDate);
    const isToday = dateObj.toDateString() === new Date().toDateString();
    const episodes = upcomingEpisodes;

    return (
      <div className="tvcp-upcoming-tab">
        <div className="tvcp-upcoming-header">
          <h2>Upcoming Shows</h2>
          <p>TV Schedule for Web Channels</p>
        </div>

        {/* Date Picker */}
        <div className="tvcp-upcoming-date-picker">
          <button
            className="tvcp-date-nav-btn"
            onClick={goToPreviousDay}
            title="Previous day"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div className="tvcp-date-picker-center">
            <input
              type="date"
              value={upcomingDate}
              onChange={(e) => setUpcomingDate(e.target.value)}
              className="tvcp-date-input"
            />
            {!isToday && (
              <button className="tvcp-today-btn" onClick={goToToday}>
                Today
              </button>
            )}
          </div>
          <button
            className="tvcp-date-nav-btn"
            onClick={goToNextDay}
            title="Next day"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>

        <div className="tvcp-upcoming-date-display">
          <div className={`tvcp-date-badge ${isToday ? 'today' : ''}`}>
            <span className="tvcp-date-day">
              {dateObj.toLocaleDateString(undefined, { weekday: 'short' })}
            </span>
            <span className="tvcp-date-num">{dateObj.getDate()}</span>
          </div>
          <span className="tvcp-date-full">
            {dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </span>
          <span className="tvcp-date-count">{episodes.length} episodes</span>
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
        ) : episodes.length === 0 ? (
          <div className="tvcp-upcoming-empty">
            <UpcomingIcon />
            <p>No episodes found for this date</p>
          </div>
        ) : (
          <div className="tvcp-upcoming-content">
            <div className="tvcp-upcoming-day">
              <div className="tvcp-upcoming-episodes">
                {episodes.map(episode => {
                      const show = episode.show || episode._embedded?.show;
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
                              auto_add_to_watchlist: false,
                              watchlist_reminder_enabled: true,
                              watchlist_reminder_minutes: 5,
                              watchlist_autoswitch_enabled: false,
                              watchlist_autoswitch_seconds: 30,
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
                                {/* Use airstamp for accurate local timezone conversion */}
                                {(episode.airstamp || episode.airtime) && (
                                  <span>
                                    {episode.airstamp
                                      ? new Date(episode.airstamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
                                      : episode.airtime}
                                  </span>
                                )}
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
                              {(show?.network?.name || show?.webChannel?.name) && (
                                <div className="tvcp-upcoming-network">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polygon points="5 3 19 12 5 21 5 3" />
                                  </svg>
                                  <span>{show.network?.name || show.webChannel?.name}</span>
                                </div>
                              )}
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
                                addShow(show, show.network?.name || show.webChannel?.name);
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
                {(() => {
                  const nextEp = showEpisodes[show.tvmaze_id]?.[0];
                  const isLoading = loadingEpisodes.has(show.tvmaze_id);
                  return (
                    <>
                      {show.channel_name && (
                        <div className="tvcp-myshow-channel">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="5 3 19 12 5 21 5 3" />
                          </svg>
                          {show.channel_name}
                        </div>
                      )}
                      {isLoading ? (
                        <div className="tvcp-myshow-upcoming tvcp-myshow-upcoming--loading">
                          <div className="tvcp-spinner-tiny" />
                          <span>Loading episodes...</span>
                        </div>
                      ) : nextEp ? (
                        <div className="tvcp-myshow-upcoming">
                          <div className="tvcp-myshow-upcoming-label">Next Episode</div>
                          <div className="tvcp-myshow-upcoming-title">
                            {nextEp.name}
                            {nextEp.season && nextEp.number && (
                              <span className="tvcp-myshow-se-num">S{nextEp.season}E{nextEp.number}</span>
                            )}
                          </div>
                          {nextEp.airdate && (
                            <div className="tvcp-myshow-upcoming-date">
                              {new Date(nextEp.airdate).toLocaleDateString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                weekday: 'short'
                              })}
                              {/* Use airstamp for accurate local timezone conversion */}
                              {nextEp.airstamp ? (
                                <span className="tvcp-myshow-upcoming-time">
                                  {' '}at {new Date(nextEp.airstamp).toLocaleTimeString(undefined, {
                                    hour: '2-digit',
                                    minute: '2-digit'
                                  })}
                                </span>
                              ) : nextEp.airtime ? (
                                <span className="tvcp-myshow-upcoming-time"> at {nextEp.airtime}</span>
                              ) : null}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="tvcp-myshow-upcoming tvcp-myshow-upcoming--none">
                          <span>No upcoming episodes</span>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
              <div className="tvcp-myshow-actions">
                <button
                  className="tvcp-action-btn tvcp-remove-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    confirmRemoveShow(show);
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
          isOpen={true}
          tvmazeId={selectedShow.tvmaze_id}
          showName={selectedShow.show_name}
          channelName={selectedShow.channel_name}
          onClose={() => setSelectedShow(null)}
          onPlayChannel={onPlayChannel}
          onChannelSet={(newChannelName) => {
            // Update the selected show
            setSelectedShow({ ...selectedShow, channel_name: newChannelName });
            // Update the shows list so the grid reflects the change
            setShows(prev => prev.map(s =>
              s.tvmaze_id === selectedShow.tvmaze_id
                ? { ...s, channel_name: newChannelName }
                : s
            ));
          }}
        />
      )}

      {/* Delete Confirmation Modal */}
      {deleteModalShow && (
        <div className="tvcp-delete-modal-overlay" onClick={() => setDeleteModalShow(null)}>
          <div className="tvcp-delete-modal" onClick={e => e.stopPropagation()}>
            <div className="tvcp-delete-modal-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </div>
            <h3>Remove Show</h3>
            <p>Are you sure you want to remove <strong>"{deleteModalShow.show_name}"</strong> from your tracked shows?</p>
            <div className="tvcp-delete-modal-actions">
              <button
                className="tvcp-delete-modal-cancel"
                onClick={() => setDeleteModalShow(null)}
                disabled={removingId === deleteModalShow.tvmaze_id}
              >
                Cancel
              </button>
              <button
                className="tvcp-delete-modal-confirm"
                onClick={executeRemoveShow}
                disabled={removingId === deleteModalShow.tvmaze_id}
              >
                {removingId === deleteModalShow.tvmaze_id ? (
                  <>
                    <div className="tvcp-spinner-small" />
                    Removing...
                  </>
                ) : (
                  'Remove'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Episode Details Modal */}
      {selectedEpisode && (
        <div className="tvcp-episode-modal-overlay" onClick={() => { setSelectedEpisode(null); setEpisodeDetails(null); }}>
          <div className="tvcp-episode-modal" onClick={e => e.stopPropagation()}>
            <button className="tvcp-episode-modal-close" onClick={() => { setSelectedEpisode(null); setEpisodeDetails(null); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>

            {episodeDetailsLoading ? (
              <div className="tvcp-episode-modal-loading">
                <div className="tvcp-spinner" />
                <span>Loading episode details...</span>
              </div>
            ) : episodeDetails ? (
              <div className="tvcp-episode-modal-content">
                {/* Episode Image */}
                {episodeDetails.image?.original && (
                  <div className="tvcp-episode-modal-image">
                    <img src={episodeDetails.image.original} alt={episodeDetails.name} />
                  </div>
                )}

                <div className="tvcp-episode-modal-info">
                  <h2>{episodeDetails.name}</h2>

                  <div className="tvcp-episode-modal-meta">
                    {episodeDetails.season && episodeDetails.number && (
                      <span className="tvcp-episode-modal-se-num">S{episodeDetails.season}E{episodeDetails.number}</span>
                    )}
                    {episodeDetails.airdate && (
                      <span>{new Date(episodeDetails.airdate).toLocaleDateString(undefined, {
                        weekday: 'long',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                      })}</span>
                    )}
                    {episodeDetails.airtime && (
                      <span className="tvcp-episode-modal-time">{episodeDetails.airtime}</span>
                    )}
                    {episodeDetails.runtime && (
                      <span>{episodeDetails.runtime} min</span>
                    )}
                  </div>

                  {episodeDetails.summary && (
                    <div className="tvcp-episode-modal-summary">
                      {stripHtml(episodeDetails.summary)}
                    </div>
                  )}

                  {/* Show Name */}
                  {episodeDetails._embedded?.show?.name && (
                    <div className="tvcp-episode-modal-show">
                      <span>From:</span>
                      <strong>{episodeDetails._embedded.show.name}</strong>
                    </div>
                  )}

                  {/* Play Channel Button */}
                  {selectedEpisode.channel_name && onPlayChannel && (
                    <button
                      className="tvcp-episode-modal-play"
                      onClick={() => {
                        onPlayChannel(selectedEpisode.channel_name!);
                        setSelectedEpisode(null);
                        setEpisodeDetails(null);
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      Watch on {selectedEpisode.channel_name}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="tvcp-episode-modal-error">
                <p>Failed to load episode details</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Sync Success Modal */}
      {syncModalMessage && (
        <div className="tvcp-delete-modal-overlay" onClick={() => setSyncModalMessage(null)}>
          <div className="tvcp-delete-modal" onClick={e => e.stopPropagation()}>
            <div className="tvcp-delete-modal-icon" style={{ color: '#4ade80' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>
            <h3>Sync Complete</h3>
            <p>{syncModalMessage}</p>
            <div className="tvcp-delete-modal-actions">
              <button
                className="tvcp-delete-modal-confirm"
                onClick={() => setSyncModalMessage(null)}
                style={{ background: '#4ade80' }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
