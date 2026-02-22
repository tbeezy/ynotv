import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState, useMemo } from 'react';
import './TVShowsManager.css';
import { db, addTvEpisodeToWatchlist, type AutoAddEpisode } from '../db';

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

interface Props {
  onClose: () => void;
  onPlayChannel?: (channelName: string) => void;
}

type SortOption = 'name' | 'status' | 'channel' | 'recent';
type ViewMode = 'grid' | 'list';

export function TVShowsManager({ onClose, onPlayChannel }: Props) {
  const [shows, setShows] = useState<TrackedShow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('name');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [selectedShow, setSelectedShow] = useState<TrackedShow | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);

  useEffect(() => {
    loadShows();
  }, []);

  async function loadShows() {
    setLoading(true);
    try {
      const result = await invoke<TrackedShow[]>('get_tracked_shows');
      setShows(result);
    } catch (e) {
      console.error('[TVShowsManager] Failed to load shows:', e);
    } finally {
      setLoading(false);
    }
  }

  async function removeShow(tvmazeId: number, showName: string) {
    if (!confirm(`Remove "${showName}" from your tracked shows?`)) return;

    setRemovingId(tvmazeId);
    try {
      await invoke('remove_tv_favorite', { tvmazeId });
      setShows(prev => prev.filter(s => s.tvmaze_id !== tvmazeId));
      if (selectedShow?.tvmaze_id === tvmazeId) {
        setSelectedShow(null);
      }
    } catch (e: any) {
      alert('Failed to remove show: ' + e);
    } finally {
      setRemovingId(null);
    }
  }

  async function syncShow(tvmazeId: number) {
    try {
      const result = await invoke<{
        synced_count: number;
        watchlist_added_count: number;
        episodes_to_add: AutoAddEpisode[];
      }>('sync_tvmaze_shows');

      // Add auto-added episodes to watchlist
      if (result.episodes_to_add && result.episodes_to_add.length > 0) {
        let addedCount = 0;
        for (const ep of result.episodes_to_add) {
          if (ep.channel_id) {
            const channel = await db.channels.get(ep.channel_id);
            if (channel) {
              const added = await addTvEpisodeToWatchlist(ep, channel);
              if (added) addedCount++;
            }
          }
        }
        if (addedCount > 0) {
          console.log(`[TVShowsManager] Auto-added ${addedCount} episodes to watchlist`);
        }
      }

      await loadShows();
    } catch (e) {
      console.error('[TVShowsManager] Sync failed:', e);
    }
  }

  const filteredShows = useMemo(() => {
    let result = [...shows];

    // Filter by search
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(s =>
        s.show_name.toLowerCase().includes(query) ||
        (s.channel_name?.toLowerCase() || '').includes(query)
      );
    }

    // Sort
    result.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.show_name.localeCompare(b.show_name);
        case 'status':
          const statusA = a.status || 'Unknown';
          const statusB = b.status || 'Unknown';
          if (statusA !== statusB) return statusA.localeCompare(statusB);
          return a.show_name.localeCompare(b.show_name);
        case 'channel':
          const chanA = a.channel_name || 'Unknown';
          const chanB = b.channel_name || 'Unknown';
          if (chanA !== chanB) return chanA.localeCompare(chanB);
          return a.show_name.localeCompare(b.show_name);
        case 'recent':
          const dateA = a.last_synced || '';
          const dateB = b.last_synced || '';
          return dateB.localeCompare(dateA);
        default:
          return 0;
      }
    });

    return result;
  }, [shows, searchQuery, sortBy]);

  const getStatusColor = (status: string | null) => {
    switch (status?.toLowerCase()) {
      case 'running': return '#4ade80';
      case 'ended': return '#f87171';
      case 'to be determined': return '#fbbf24';
      case 'in development': return '#60a5fa';
      default: return '#9ca3af';
    }
  };

  const getStatusLabel = (status: string | null) => {
    if (!status) return 'Unknown';
    return status;
  };

  return (
    <div className="tvsm-overlay" onClick={onClose}>
      <div className="tvsm-panel" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="tvsm-header">
          <div className="tvsm-header-left">
            <div className="tvsm-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="2" width="20" height="20" rx="2.18" />
                <line x1="7" y1="2" x2="7" y2="22" />
                <line x1="17" y1="2" x2="17" y2="22" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <line x1="2" y1="7" x2="7" y2="7" />
                <line x1="2" y1="17" x2="7" y2="17" />
                <line x1="17" y1="17" x2="22" y2="17" />
                <line x1="17" y1="7" x2="22" y2="7" />
              </svg>
            </div>
            <div className="tvsm-title">
              <h2>My Shows</h2>
              <span className="tvsm-subtitle">{shows.length} tracked {shows.length === 1 ? 'show' : 'shows'}</span>
            </div>
          </div>

          <div className="tvsm-header-controls">
            {/* Search */}
            <div className="tvsm-search">
              <svg className="tvsm-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                placeholder="Search shows..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button className="tvsm-search-clear" onClick={() => setSearchQuery('')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>

            {/* Sort Dropdown */}
            <div className="tvsm-sort">
              <select value={sortBy} onChange={e => setSortBy(e.target.value as SortOption)}>
                <option value="name">Sort by Name</option>
                <option value="status">Sort by Status</option>
                <option value="channel">Sort by Channel</option>
                <option value="recent">Recently Synced</option>
              </select>
            </div>

            {/* View Toggle */}
            <div className="tvsm-view-toggle">
              <button
                className={viewMode === 'grid' ? 'active' : ''}
                onClick={() => setViewMode('grid')}
                title="Grid view"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                </svg>
              </button>
              <button
                className={viewMode === 'list' ? 'active' : ''}
                onClick={() => setViewMode('list')}
                title="List view"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" />
                  <line x1="3" y1="12" x2="3.01" y2="12" />
                  <line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
              </button>
            </div>

            <button className="tvsm-close" onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="tvsm-content">
          {loading ? (
            <div className="tvsm-loading">
              <div className="tvsm-spinner" />
              <span>Loading your shows...</span>
            </div>
          ) : filteredShows.length === 0 ? (
            <div className="tvsm-empty">
              <div className="tvsm-empty-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="2" width="20" height="20" rx="2.18" />
                  <line x1="7" y1="2" x2="7" y2="22" />
                  <line x1="17" y1="2" x2="17" y2="22" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                </svg>
              </div>
              <h3>No shows found</h3>
              <p>{searchQuery ? 'Try a different search term' : 'Start tracking shows from the TV Guide'}</p>
            </div>
          ) : (
            <div className={`tvsm-shows ${viewMode}`}>
              {filteredShows.map(show => (
                <div
                  key={show.tvmaze_id}
                  className={`tvsm-show-card ${selectedShow?.tvmaze_id === show.tvmaze_id ? 'selected' : ''}`}
                  onClick={() => setSelectedShow(selectedShow?.tvmaze_id === show.tvmaze_id ? null : show)}
                >
                  {/* Poster */}
                  <div className="tvsm-show-poster">
                    {show.show_image ? (
                      <img src={show.show_image} alt={show.show_name} loading="lazy" />
                    ) : (
                      <div className="tvsm-show-poster-placeholder">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <rect x="2" y="2" width="20" height="20" rx="2.18" />
                          <line x1="7" y1="2" x2="7" y2="22" />
                          <line x1="17" y1="2" x2="17" y2="22" />
                          <line x1="2" y1="12" x2="22" y2="12" />
                        </svg>
                      </div>
                    )}
                    <div
                      className="tvsm-show-status-badge"
                      style={{ backgroundColor: getStatusColor(show.status) }}
                    >
                      {getStatusLabel(show.status)}
                    </div>
                  </div>

                  {/* Info */}
                  <div className="tvsm-show-info">
                    <h3 className="tvsm-show-name" title={show.show_name}>
                      {show.show_name}
                    </h3>
                    {show.channel_name && (
                      <div className="tvsm-show-channel">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polygon points="5 3 19 12 5 21 5 3" />
                        </svg>
                        <span>{show.channel_name}</span>
                      </div>
                    )}
                    <div className="tvsm-show-meta">
                      {show.last_synced && (
                        <span>Synced {new Date(show.last_synced).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="tvsm-show-actions">
                    {show.channel_name && onPlayChannel && (
                      <button
                        className="tvsm-action-btn tvsm-play-btn"
                        onClick={e => {
                          e.stopPropagation();
                          onPlayChannel(show.channel_name!);
                          onClose();
                        }}
                        title={`Play ${show.channel_name}`}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <polygon points="5 3 19 12 5 21 5 3" />
                        </svg>
                      </button>
                    )}
                    <button
                      className="tvsm-action-btn tvsm-sync-btn"
                      onClick={e => {
                        e.stopPropagation();
                        syncShow(show.tvmaze_id);
                      }}
                      title="Sync episodes"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="23 4 23 10 17 10" />
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                      </svg>
                    </button>
                    <button
                      className="tvsm-action-btn tvsm-remove-btn"
                      onClick={e => {
                        e.stopPropagation();
                        removeShow(show.tvmaze_id, show.show_name);
                      }}
                      disabled={removingId === show.tvmaze_id}
                      title="Remove show"
                    >
                      {removingId === show.tvmaze_id ? (
                        <div className="tvsm-btn-spinner" />
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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

        {/* Footer */}
        <div className="tvsm-footer">
          <span className="tvsm-footer-text">
            {filteredShows.length !== shows.length
              ? `Showing ${filteredShows.length} of ${shows.length} shows`
              : `${shows.length} ${shows.length === 1 ? 'show' : 'shows'} tracked`}
          </span>
          <button className="tvsm-done-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
