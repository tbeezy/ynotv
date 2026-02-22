import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState } from 'react';
import './TVCalendar.css';
import { TVShowsManager } from './TVShowsManager';

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

interface Props {
  onClose: () => void;
  onPlayChannel?: (channelName: string) => void;
}

export function TVCalendar({ onClose, onPlayChannel }: Props) {
  const [now, setNow] = useState(() => new Date());
  const [episodes, setEpisodes] = useState<CalendarEpisode[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [trackedShows, setTrackedShows] = useState<TrackedShow[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [debugInfo, setDebugInfo] = useState<string>('');
  const [showManager, setShowManager] = useState(false);

  const monthKey = useMemo(() => {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }, [now]);

  useEffect(() => {
    setLoading(true);
    invoke<CalendarEpisode[]>('get_calendar_episodes', { month: monthKey })
      .then(setEpisodes)
      .catch(console.error)
      .finally(() => setLoading(false));

    // Fetch tracked shows for debug panel
    invoke<TrackedShow[]>('get_tracked_shows')
      .then(shows => {
        console.log('[TVCalendar] Tracked shows:', shows);
        setTrackedShows(shows);
        setDebugInfo(`Loaded ${shows.length} tracked shows`);
      })
      .catch(e => {
        console.error('[TVCalendar] Failed to get tracked shows:', e);
        setDebugInfo(`Error: ${e}`);
      });
  }, [monthKey]);

  function changeMonth(delta: number) {
    setNow(prev => {
      const n = new Date(prev);
      n.setMonth(n.getMonth() + delta);
      return n;
    });
  }

  async function manualSync() {
    setSyncing(true);
    try {
      const count = await invoke<number>('sync_tvmaze_shows');
      alert(`Synced ${count} shows`);
      // Refresh current month
      const eps = await invoke<CalendarEpisode[]>('get_calendar_episodes', { month: monthKey });
      setEpisodes(eps);
      // Refresh tracked shows
      const shows = await invoke<TrackedShow[]>('get_tracked_shows');
      setTrackedShows(shows);
    } catch (e) {
      alert('Sync failed: ' + e);
    } finally {
      setSyncing(false);
    }
  }

  async function removeShow(tvmazeId: number, showName: string) {
    if (!confirm(`Remove "${showName}" from tracked shows?`)) return;
    try {
      await invoke('remove_tv_favorite', { tvmazeId });
      setTrackedShows(prev => prev.filter(s => s.tvmaze_id !== tvmazeId));
      setDebugInfo(`Removed ${showName}`);
      // Refresh episodes
      const eps = await invoke<CalendarEpisode[]>('get_calendar_episodes', { month: monthKey });
      setEpisodes(eps);
    } catch (e: any) {
      setDebugInfo(`Error removing: ${e}`);
    }
  }

  const daysInMonth = useMemo(() => {
    const year = now.getFullYear();
    const month = now.getMonth();
    const firstDay = new Date(year, month, 1);
    const days: Date[] = [];
    // Fill with some previous month days for alignment
    const startPadding = firstDay.getDay();
    for (let i = startPadding - 1; i >= 0; i--) {
      days.push(new Date(year, month, -i));
    }
    // Actual month days
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
    // Sort each day by airtime
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => (a.airtime ?? '').localeCompare(b.airtime ?? ''));
    }
    return map;
  }, [episodes]);

  const monthLabel = now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  // Debug: log all episodes with their channel names
  useEffect(() => {
    console.log('[TVCalendar] Episodes loaded:', episodes.length);
    console.log('[TVCalendar] Episodes with channels:', episodes.map(e => ({ show: e.show_name, channel: e.channel_name, airdate: e.airdate })));
  }, [episodes]);

  function handlePlay(ep: CalendarEpisode) {
    console.log('[TVCalendar] handlePlay called:', { channel_name: ep.channel_name, show_name: ep.show_name, onPlayChannelExists: !!onPlayChannel });
    if (ep.channel_name && onPlayChannel) {
      console.log('[TVCalendar] Calling onPlayChannel with:', ep.channel_name);
      onPlayChannel(ep.channel_name);
      onClose();
    } else {
      console.log('[TVCalendar] Cannot play - missing channel_name or onPlayChannel');
    }
  }

  function openSettings() {
    console.log('[TVCalendar] Opening settings...');
    // Dispatch custom event to open settings with TV Calendar tab
    const event = new CustomEvent('open-settings', { detail: { tab: 'tv-calendar' } });
    console.log('[TVCalendar] Dispatching event:', event);
    window.dispatchEvent(event);
    onClose();
  }

  return (
    <div className="tvcal-overlay" onClick={onClose}>
      <div className="tvcal-panel" onClick={e => e.stopPropagation()}>
        <div className="tvcal-header">
          <h2>📅 TV Calendar</h2>
          <div className="tvcal-controls">
            <button onClick={() => changeMonth(-1)}>← Prev</button>
            <span className="tvcal-month">{monthLabel}</span>
            <button onClick={() => changeMonth(1)}>Next →</button>
            <button
              onClick={() => setShowManager(true)}
              className="tvcal-manage-btn"
              title="Manage tracked shows"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16, marginRight: 6, verticalAlign: 'middle' }}>
                <rect x="2" y="2" width="20" height="20" rx="2.18" />
                <line x1="7" y1="2" x2="7" y2="22" />
                <line x1="17" y1="2" x2="17" y2="22" />
                <line x1="2" y1="12" x2="22" y2="12" />
              </svg>
              Manage Shows
            </button>
            <button onClick={manualSync} disabled={syncing} className="tvcal-sync">
              {syncing ? 'Syncing…' : '🔄 Sync'}
            </button>
            <button onClick={() => setShowDebug(!showDebug)} className="tvcal-debug-btn">
              {showDebug ? 'Hide Debug' : 'Debug'}
            </button>
            <button onClick={openSettings} className="tvcal-settings-btn" title="TV Calendar Settings">
              ⚙️
            </button>
          </div>
          <button className="tvcal-close" onClick={onClose}>✕</button>
        </div>

        {showDebug && (
          <div className="tvcal-debug-panel">
            <div className="tvcal-debug-section">
              <h4>Tracked Shows ({trackedShows.length})</h4>
              {trackedShows.length === 0 && <p>No tracked shows found</p>}
              {trackedShows.map(show => (
                <div key={show.tvmaze_id} className="tvcal-debug-show">
                  <strong>{show.show_name}</strong>
                  <span>ID: {show.tvmaze_id}</span>
                  <span>Status: {show.status || 'Unknown'}</span>
                  <span>Channel: {show.channel_name || 'N/A'}</span>
                  <span>Last Sync: {show.last_synced || 'Never'}</span>
                  <button
                    className="tvcal-remove-btn"
                    onClick={() => removeShow(show.tvmaze_id, show.show_name)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div className="tvcal-debug-section">
              <h4>Debug Info</h4>
              <pre>{debugInfo}</pre>
              <p>Current month key: {monthKey}</p>
              <p>Episodes loaded: {episodes.length}</p>
            </div>
          </div>
        )}

        <div className="tvcal-weekdays">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
            <div key={d} className="tvcal-weekday">{d}</div>
          ))}
        </div>

        {loading ? (
          <div className="tvcal-loading">Loading…</div>
        ) : (
          <div className="tvcal-grid">
            {daysInMonth.map(date => {
              const dateKey = date.toISOString().slice(0, 10);
              const dayEps = episodesByDay[dateKey] ?? [];
              const isCurrentMonth = date.getMonth() === now.getMonth();
              const isToday = new Date().toDateString() === date.toDateString();

              return (
                <div
                  key={dateKey}
                  className={`tvcal-day ${!isCurrentMonth ? 'other-month' : ''} ${isToday ? 'today' : ''}`}
                >
                  <div className="tvcal-daynum">{date.getDate()}</div>
                  <div className="tvcal-daycontent">
                    {dayEps.map((ep, i) => (
                      <div
                        key={i}
                        className="tvcal-episode"
                        onClick={() => handlePlay(ep)}
                        style={{ cursor: ep.channel_name ? 'pointer' : 'default' }}
                        title={`${ep.show_name} S${ep.season ?? '?'}E${ep.episode ?? '?'}${ep.channel_name ? ` on ${ep.channel_name}` : ''}`}
                      >
                        {ep.show_image && <img src={ep.show_image} alt="" className="tvcal-ep-img" />}
                        <div className="tvcal-ep-info">
                          <span className="tvcal-ep-time">{ep.airtime ?? 'TBA'}</span>
                          <span className="tvcal-ep-show">{ep.show_name}</span>
                          {ep.episode_name && (
                            <span className="tvcal-ep-title">{ep.episode_name}</span>
                          )}
                          {ep.channel_name && <span className="tvcal-ep-channel">📺 {ep.channel_name}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Manage Shows Modal */}
      {showManager && (
        <TVShowsManager
          onClose={() => setShowManager(false)}
          onPlayChannel={onPlayChannel}
        />
      )}
    </div>
  );
}
