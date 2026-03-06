import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState, useRef } from 'react';
import { ChannelSelectorModal } from './ChannelSelectorModal';
import { ShowNotificationsModal } from './ShowNotificationsModal';
import { db, addTvEpisodeToWatchlist, clearAutoAddedEpisodesForShow, type AutoAddEpisode, type StoredChannel } from '../db';
import './ShowDetailsModal.css';

interface Episode {
  id: number;
  name?: string;
  season?: number;
  number?: number;
  airdate?: string;
  airtime?: string;
  airstamp?: string;
  runtime?: number;
  summary?: string;
}

interface ShowDetails {
  id: number;
  name: string;
  url?: string;
  type?: string;
  language?: string;
  genres?: string[];
  status?: string;
  runtime?: number;
  average_runtime?: number;
  premiered?: string;
  ended?: string;
  official_site?: string;
  schedule?: {
    time?: string;
    days?: string[];
  };
  rating?: {
    average?: number;
  };
  weight?: number;
  network?: {
    name?: string;
    country?: {
      name?: string;
      code?: string;
    };
    official_site?: string;
  };
  web_channel?: {
    name?: string;
    country?: {
      name?: string;
      code?: string;
    };
    official_site?: string;
  };
  externals?: {
    tvrage?: number;
    thetvdb?: number;
    imdb?: string;
  };
  image?: {
    medium?: string;
    original?: string;
  };
  summary?: string;
  updated?: number;
  _links?: {
    self?: { href?: string };
    previousepisode?: { href?: string };
    nextepisode?: { href?: string };
  };
}

interface ShowDetailsWithEpisodes {
  details: ShowDetails;
  episodes: Episode[];
}

interface Props {
  isOpen: boolean;
  tvmazeId: number;
  showName: string;
  channelName: string | null;
  onClose: () => void;
  onPlayChannel?: (channelName: string) => void;
  onChannelSet?: (channelName: string | null) => void;
}

export function ShowDetailsModal({ isOpen, tvmazeId, showName, channelName, onClose, onPlayChannel, onChannelSet }: Props) {
  const [data, setData] = useState<ShowDetailsWithEpisodes | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showChannelSelector, setShowChannelSelector] = useState(false);
  const [showNotificationsModal, setShowNotificationsModal] = useState(false);
  const [currentChannel, setCurrentChannel] = useState<string | null>(channelName);
  const [notificationSuccess, setNotificationSuccess] = useState<string | null>(null);

  // Auto-add watchlist settings
  const [autoAddEnabled, setAutoAddEnabled] = useState(false);
  const [autoAddReminderEnabled, setAutoAddReminderEnabled] = useState(true);
  const [autoAddReminderMinutes, setAutoAddReminderMinutes] = useState(5);
  const [autoAddAutoswitchEnabled, setAutoAddAutoswitchEnabled] = useState(false);
  const [autoAddAutoswitchSeconds, setAutoAddAutoswitchSeconds] = useState(30);
  const [savingSettings, setSavingSettings] = useState(false);
  const [autoAddSuccess, setAutoAddSuccess] = useState<string | null>(null);
  const prevAutoAddEnabled = useRef(false);

  // Sync with prop when it changes (e.g., when reopening the modal)
  useEffect(() => {
    setCurrentChannel(channelName);
    setNotificationSuccess(null);
  }, [channelName]);

  // Load auto-add settings when modal opens
  useEffect(() => {
    if (isOpen && tvmazeId) {
      loadWatchlistSettings();
    }
  }, [isOpen, tvmazeId]);

  async function loadWatchlistSettings() {
    try {
      const settings = await invoke<{
        auto_add_to_watchlist: boolean;
        watchlist_reminder_enabled: boolean;
        watchlist_reminder_minutes: number;
        watchlist_autoswitch_enabled: boolean;
        watchlist_autoswitch_seconds: number;
      }>('get_show_watchlist_settings', { tvmazeId });

      setAutoAddEnabled(settings.auto_add_to_watchlist);
      setAutoAddReminderEnabled(settings.watchlist_reminder_enabled);
      setAutoAddReminderMinutes(settings.watchlist_reminder_minutes);
      setAutoAddAutoswitchEnabled(settings.watchlist_autoswitch_enabled);
      setAutoAddAutoswitchSeconds(settings.watchlist_autoswitch_seconds);
      prevAutoAddEnabled.current = settings.auto_add_to_watchlist;
    } catch (e) {
      console.error('[ShowDetails] Failed to load watchlist settings:', e);
    }
  }

  async function saveWatchlistSettings(
    autoAdd: boolean,
    reminderEnabled: boolean,
    reminderMinutes: number,
    autoswitchEnabled: boolean,
    autoswitchSeconds: number
  ) {
    setSavingSettings(true);
    try {
      await invoke('update_show_watchlist_settings', {
        tvmazeId,
        autoAddToWatchlist: autoAdd,
        watchlistReminderEnabled: reminderEnabled,
        watchlistReminderMinutes: reminderMinutes,
        watchlistAutoswitchEnabled: autoswitchEnabled,
        watchlistAutoswitchSeconds: autoswitchSeconds,
      });

      // If auto-add was just enabled, immediately add current upcoming episodes
      if (autoAdd && !prevAutoAddEnabled.current) {
        console.log('[ShowDetails] Auto-add enabled, fetching current episodes...');

        // Check if channel is set first
        if (!currentChannel) {
          setAutoAddSuccess('Please set a channel for this show first to enable auto-add');
          setTimeout(() => setAutoAddSuccess(null), 5000);
          // Disable auto-add since it can't work without a channel
          setAutoAddEnabled(false);
          prevAutoAddEnabled.current = false;
          await invoke('update_show_watchlist_settings', {
            tvmazeId,
            autoAddToWatchlist: false,
            watchlistReminderEnabled: reminderEnabled,
            watchlistReminderMinutes: reminderMinutes,
            watchlistAutoswitchEnabled: autoswitchEnabled,
            watchlistAutoswitchSeconds: autoswitchSeconds,
          });
          return;
        }

        const episodesToAdd = await invoke<AutoAddEpisode[]>('add_show_episodes_to_watchlist', { tvmazeId });
        console.log('[ShowDetails] Episodes to add:', episodesToAdd.length);

        if (episodesToAdd.length > 0) {
          // Clear existing auto-added episodes for this show to refresh with latest data
          await clearAutoAddedEpisodesForShow(tvmazeId);

          let addedCount = 0;
          for (const ep of episodesToAdd) {
            if (ep.channel_id) {
              const channel = await db.channels.get(ep.channel_id);
              if (channel) {
                const added = await addTvEpisodeToWatchlist(ep, channel);
                if (added) addedCount++;
              }
            }
          }

          if (addedCount > 0) {
            setAutoAddSuccess(`Added ${addedCount} upcoming episode${addedCount !== 1 ? 's' : ''} to your watchlist`);
            setTimeout(() => setAutoAddSuccess(null), 5000);
            // Dispatch event to refresh watchlist UI
            window.dispatchEvent(new CustomEvent('watchlist-updated'));
          } else {
            setAutoAddSuccess('No new episodes to add');
            setTimeout(() => setAutoAddSuccess(null), 3000);
          }
        } else {
          setAutoAddSuccess('No upcoming episodes found');
          setTimeout(() => setAutoAddSuccess(null), 3000);
        }
      }

      // Update the ref to track the new state
      prevAutoAddEnabled.current = autoAdd;
    } catch (e) {
      console.error('[ShowDetails] Failed to save watchlist settings:', e);
    } finally {
      setSavingSettings(false);
    }
  }

  useEffect(() => {
    loadShowDetails();
  }, [tvmazeId]);

  async function loadShowDetails() {
    setLoading(true);
    setError(null);
    try {
      console.log('[ShowDetails] Fetching details for tvmazeId:', tvmazeId);
      const result = await invoke<ShowDetailsWithEpisodes>('get_show_details_with_episodes', { tvmazeId });
      console.log('[ShowDetails] Received result:', result);
      setData(result);
    } catch (e: any) {
      console.error('[ShowDetails] Error fetching details:', e);
      setError(e.toString());
    } finally {
      setLoading(false);
    }
  }

  async function handleChannelSelect(channel: StoredChannel | null) {
    try {
      console.log('[ShowDetails] Setting channel:', { tvmazeId, channelId: channel?.stream_id, channelName: channel?.name });
      await invoke('set_show_channel', { tvmazeId, channelId: channel?.stream_id || null });
      console.log('[ShowDetails] Channel set successfully');
      setCurrentChannel(channel?.name || null);
      onChannelSet?.(channel?.name || null);
    } catch (e: any) {
      console.error('[ShowDetails] Error setting channel:', e);
    }
  }

  const details = data?.details;
  const episodes = data?.episodes || [];

  // Calculate next episode and upcoming episodes
  const { nextEpisode, upcomingEpisodes } = useMemo(() => {
    const now = new Date();
    const futureEpisodes = episodes
      .filter(ep => ep.airdate && new Date(ep.airdate) >= now)
      .sort((a, b) => {
        const dateA = a.airdate ? new Date(a.airdate).getTime() : 0;
        const dateB = b.airdate ? new Date(b.airdate).getTime() : 0;
        return dateA - dateB;
      });

    return {
      nextEpisode: futureEpisodes[0] || null,
      upcomingEpisodes: futureEpisodes.slice(1, 6) // Next 5 episodes after the next one
    };
  }, [episodes]);

  function stripHtml(html: string): string {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, '');
  }

  function formatDate(dateStr?: string): string {
    if (!dateStr) return 'TBA';
    return new Date(dateStr).toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }

  function formatTime(timeStr?: string): string {
    if (!timeStr) return '';
    return timeStr;
  }

  async function openUrl(url?: string) {
    if (!url) return;
    try {
      await invoke('open_external_url', { url });
    } catch (e) {
      console.error('[ShowDetails] Failed to open URL:', e);
      // Fallback: try opening in new tab
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  function getStatusColor(status?: string): string {
    switch (status?.toLowerCase()) {
      case 'running': return '#4ade80';
      case 'ended': return '#f87171';
      case 'to be determined': return '#fbbf24';
      case 'in development': return '#60a5fa';
      default: return '#9ca3af';
    }
  }

  const posterUrl = details?.image?.original || details?.image?.medium;

  // Build TVMaze URL
  const tvmazeUrl = details?.id ? `https://www.tvmaze.com/shows/${details.id}` : details?.url;

  return (
    <div className="sdm-overlay" onClick={onClose}>
      <div className="sdm-panel" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="sdm-header">
          <div className="sdm-header-actions">
            <button
              className="sdm-notifications-btn"
              onClick={() => setShowNotificationsModal(true)}
              title="Set up notifications for upcoming episodes"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              <span>Notifications</span>
            </button>
            <button className="sdm-close-btn" onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {loading ? (
          <div className="sdm-loading">
            <div className="sdm-spinner" />
            <span>Loading show details...</span>
          </div>
        ) : error ? (
          <div className="sdm-error">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <p>Failed to load show details</p>
            <span>{error}</span>
          </div>
        ) : details ? (
          <div className="sdm-content">
            {/* Hero Section */}
            <div className="sdm-hero">
              {posterUrl ? (
                <div className="sdm-poster">
                  <img src={posterUrl} alt={details.name} />
                </div>
              ) : (
                <div className="sdm-poster-placeholder">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="2" y="2" width="20" height="20" rx="2.18" />
                    <line x1="7" y1="2" x2="7" y2="22" />
                    <line x1="17" y1="2" x2="17" y2="22" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                  </svg>
                </div>
              )}

              <div className="sdm-info">
                <h1 className="sdm-title">{details.name}</h1>

                <div className="sdm-meta">
                  {details.status && (
                    <span
                      className="sdm-status"
                      style={{ backgroundColor: getStatusColor(details.status) }}
                    >
                      {details.status}
                    </span>
                  )}

                  {details.type && (
                    <span className="sdm-type">{details.type}</span>
                  )}

                  {details.rating?.average && (
                    <span className="sdm-rating">
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                      {details.rating.average.toFixed(1)}
                    </span>
                  )}

                  {details.runtime && (
                    <span className="sdm-runtime">{details.runtime} min</span>
                  )}
                </div>

                {details.genres && details.genres.length > 0 && (
                  <div className="sdm-genres">
                    {details.genres.map(genre => (
                      <span key={genre} className="sdm-genre">{genre}</span>
                    ))}
                  </div>
                )}

                {(channelName || details.network?.name || details.web_channel?.name) && (
                  <div className="sdm-network">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    <span>
                      {channelName || details.network?.name || details.web_channel?.name}
                      {details.network?.country?.name && ` (${details.network.country.name})`}
                    </span>
                  </div>
                )}

                {details.schedule?.days && details.schedule.days.length > 0 && (
                  <div className="sdm-schedule">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <span>
                      {details.schedule.days.join(', ')}
                      {details.schedule.time && ` at ${details.schedule.time}`}
                    </span>
                  </div>
                )}

                {onPlayChannel && currentChannel && (
                  <button
                    className="sdm-play-btn"
                    onClick={() => {
                      onPlayChannel(currentChannel);
                      onClose();
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    Watch on {currentChannel}
                  </button>
                )}

                <button
                  className="sdm-set-channel-btn"
                  onClick={() => setShowChannelSelector(true)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                  </svg>
                  {currentChannel ? 'Change Channel' : 'Set Channel'}
                </button>

                {/* Auto-add to Watchlist Settings */}
                <div className="sdm-auto-add-section">
                  <label className="sdm-auto-add-label">
                    <input
                      type="checkbox"
                      checked={autoAddEnabled}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        setAutoAddEnabled(enabled);
                        saveWatchlistSettings(
                          enabled,
                          autoAddReminderEnabled,
                          autoAddReminderMinutes,
                          autoAddAutoswitchEnabled,
                          autoAddAutoswitchSeconds
                        );
                      }}
                      disabled={savingSettings}
                    />
                    <span className="sdm-auto-add-text">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 2v20M2 12h20" />
                      </svg>
                      Auto-add new episodes to Watchlist
                    </span>
                  </label>

                  {autoAddEnabled && (
                    <div className="sdm-auto-add-options">
                      <label className="sdm-auto-add-option">
                        <input
                          type="checkbox"
                          checked={autoAddReminderEnabled}
                          onChange={(e) => {
                            const enabled = e.target.checked;
                            setAutoAddReminderEnabled(enabled);
                            saveWatchlistSettings(
                              autoAddEnabled,
                              enabled,
                              autoAddReminderMinutes,
                              autoAddAutoswitchEnabled,
                              autoAddAutoswitchSeconds
                            );
                          }}
                          disabled={savingSettings}
                        />
                        <span>Reminder {autoAddReminderMinutes} min before</span>
                      </label>

                      {autoAddReminderEnabled && (
                        <div className="sdm-auto-add-input-row">
                          <input
                            type="range"
                            min="0"
                            max="60"
                            value={autoAddReminderMinutes}
                            onChange={(e) => {
                              const minutes = parseInt(e.target.value);
                              setAutoAddReminderMinutes(minutes);
                            }}
                            onMouseUp={() => {
                              saveWatchlistSettings(
                                autoAddEnabled,
                                autoAddReminderEnabled,
                                autoAddReminderMinutes,
                                autoAddAutoswitchEnabled,
                                autoAddAutoswitchSeconds
                              );
                            }}
                            disabled={savingSettings}
                          />
                          <span>{autoAddReminderMinutes} min</span>
                        </div>
                      )}

                      <label className="sdm-auto-add-option">
                        <input
                          type="checkbox"
                          checked={autoAddAutoswitchEnabled}
                          onChange={(e) => {
                            const enabled = e.target.checked;
                            setAutoAddAutoswitchEnabled(enabled);
                            saveWatchlistSettings(
                              autoAddEnabled,
                              autoAddReminderEnabled,
                              autoAddReminderMinutes,
                              enabled,
                              autoAddAutoswitchSeconds
                            );
                          }}
                          disabled={savingSettings}
                        />
                        <span>Auto-switch {autoAddAutoswitchSeconds}s before</span>
                      </label>

                      {autoAddAutoswitchEnabled && (
                        <div className="sdm-auto-add-input-row">
                          <input
                            type="range"
                            min="0"
                            max="300"
                            step="10"
                            value={autoAddAutoswitchSeconds}
                            onChange={(e) => {
                              const seconds = parseInt(e.target.value);
                              setAutoAddAutoswitchSeconds(seconds);
                            }}
                            onMouseUp={() => {
                              saveWatchlistSettings(
                                autoAddEnabled,
                                autoAddReminderEnabled,
                                autoAddReminderMinutes,
                                autoAddAutoswitchEnabled,
                                autoAddAutoswitchSeconds
                              );
                            }}
                            disabled={savingSettings}
                          />
                          <span>{autoAddAutoswitchSeconds}s</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Next Episode Section */}
            {nextEpisode && (
              <div className="sdm-next-episode">
                <div className="sdm-section-header">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  <h3>Next Episode</h3>
                </div>
                <div className="sdm-episode-card sdm-next">
                  <div className="sdm-episode-date">
                    <span className="sdm-episode-day">
                      {nextEpisode.airdate ? new Date(nextEpisode.airdate).toLocaleDateString(undefined, { weekday: 'short' }) : 'TBA'}
                    </span>
                    <span className="sdm-episode-num">
                      {nextEpisode.airdate ? new Date(nextEpisode.airdate).getDate() : '?'}
                    </span>
                  </div>
                  <div className="sdm-episode-info">
                    <h4>
                      {nextEpisode.name || `Episode ${nextEpisode.number}`}
                      {nextEpisode.season && nextEpisode.number && (
                        <span className="sdm-episode-se-num">S{nextEpisode.season}E{nextEpisode.number}</span>
                      )}
                    </h4>
                    <div className="sdm-episode-meta">
                      {nextEpisode.airdate && (
                        <span>{formatDate(nextEpisode.airdate)}</span>
                      )}
                      {/* Use airstamp for accurate local timezone conversion */}
                      {(nextEpisode.airstamp || nextEpisode.airtime) && (
                        <span className="sdm-dot">•</span>
                      )}
                      {(nextEpisode.airstamp || nextEpisode.airtime) && (
                        <span>
                          {nextEpisode.airstamp
                            ? new Date(nextEpisode.airstamp).toLocaleTimeString(undefined, {
                                hour: '2-digit',
                                minute: '2-digit'
                              })
                            : formatTime(nextEpisode.airtime)}
                        </span>
                      )}
                      {nextEpisode.runtime && (
                        <span className="sdm-dot">•</span>
                      )}
                      {nextEpisode.runtime && (
                        <span>{nextEpisode.runtime} min</span>
                      )}
                    </div>
                    {nextEpisode.summary && (
                      <p className="sdm-episode-desc">{stripHtml(nextEpisode.summary)}</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Upcoming Episodes Section */}
            {upcomingEpisodes.length > 0 && (
              <div className="sdm-upcoming">
                <div className="sdm-section-header">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                  <h3>Upcoming Episodes</h3>
                </div>
                <div className="sdm-upcoming-list">
                  {upcomingEpisodes.map(episode => (
                    <div key={episode.id} className="sdm-episode-card">
                      <div className="sdm-episode-date">
                        <span className="sdm-episode-day">
                          {episode.airdate ? new Date(episode.airdate).toLocaleDateString(undefined, { weekday: 'short' }) : 'TBA'}
                        </span>
                        <span className="sdm-episode-num">
                          {episode.airdate ? new Date(episode.airdate).getDate() : '?'}
                        </span>
                      </div>
                      <div className="sdm-episode-info">
                        <h4>
                          {episode.name || `Episode ${episode.number}`}
                          {episode.season && episode.number && (
                            <span className="sdm-episode-se-num">S{episode.season}E{episode.number}</span>
                          )}
                        </h4>
                        <div className="sdm-episode-meta">
                          {episode.airdate && (
                            <span>{formatDate(episode.airdate)}</span>
                          )}
                          {/* Use airstamp for accurate local timezone conversion */}
                          {(episode.airstamp || episode.airtime) && (
                            <span className="sdm-dot">•</span>
                          )}
                          {(episode.airstamp || episode.airtime) && (
                            <span>
                              {episode.airstamp
                                ? new Date(episode.airstamp).toLocaleTimeString(undefined, {
                                    hour: '2-digit',
                                    minute: '2-digit'
                                  })
                                : formatTime(episode.airtime)}
                            </span>
                          )}
                          {episode.runtime && (
                            <span className="sdm-dot">•</span>
                          )}
                          {episode.runtime && (
                            <span>{episode.runtime} min</span>
                          )}
                        </div>
                        {episode.summary && (
                          <p className="sdm-episode-desc">{stripHtml(episode.summary)}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Details Grid */}
            <div className="sdm-details-grid">
              {details.summary && (
                <div className="sdm-section sdm-summary">
                  <h3>About</h3>
                  <p>{stripHtml(details.summary)}</p>
                </div>
              )}

              <div className="sdm-section sdm-facts">
                <h3>Show Info</h3>
                <dl>
                  {details.premiered && (
                    <>
                      <dt>Premiered</dt>
                      <dd>{formatDate(details.premiered)}</dd>
                    </>
                  )}

                  {details.ended && (
                    <>
                      <dt>Ended</dt>
                      <dd>{formatDate(details.ended)}</dd>
                    </>
                  )}

                  {details.language && (
                    <>
                      <dt>Language</dt>
                      <dd>{details.language}</dd>
                    </>
                  )
                  }

                  {details.official_site && (
                    <>
                      <dt>Official Site</dt>
                      <dd>
                        <button
                          className="sdm-link-btn"
                          onClick={() => openUrl(details.official_site)}
                        >
                          Visit Website
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                          </svg>
                        </button>
                      </dd>
                    </>
                  )}

                  {details.externals?.imdb && (
                    <>
                      <dt>IMDb</dt>
                      <dd>
                        <button
                          className="sdm-link-btn"
                          onClick={() => openUrl(`https://www.imdb.com/title/${details.externals?.imdb}`)}
                        >
                          {details.externals.imdb}
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                          </svg>
                        </button>
                      </dd>
                    </>
                  )}
                </dl>
              </div>
            </div>

            {/* External Links */}
            {tvmazeUrl && (
              <div className="sdm-external">
                <button
                  onClick={() => openUrl(tvmazeUrl)}
                  className="sdm-tvmaze-link"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="2" width="20" height="20" rx="2.18" />
                    <line x1="7" y1="2" x2="7" y2="22" />
                    <line x1="17" y1="2" x2="17" y2="22" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                  </svg>
                  View on TVMaze
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="sdm-link-icon">
                    <path d="M7 17L17 7" />
                    <path d="M7 7h10v10" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="sdm-error">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <p>No show details available</p>
            <button className="sdm-retry-btn" onClick={loadShowDetails}>Retry</button>
          </div>
        )}

        {showChannelSelector && (
          <ChannelSelectorModal
            currentChannelName={currentChannel}
            networkName={details?.network?.name || null}
            onSelect={handleChannelSelect}
            onClose={() => setShowChannelSelector(false)}
          />
        )}

        {showNotificationsModal && (
          <ShowNotificationsModal
            isOpen={showNotificationsModal}
            showName={showName}
            channelName={currentChannel}
            episodes={episodes}
            onConfirm={(addedCount) => {
              setShowNotificationsModal(false);
              setNotificationSuccess(`Added ${addedCount} episode${addedCount !== 1 ? 's' : ''} to your watchlist`);
              setTimeout(() => setNotificationSuccess(null), 3000);
              // Dispatch event to refresh watchlist UI
              window.dispatchEvent(new CustomEvent('watchlist-updated'));
            }}
            onCancel={() => setShowNotificationsModal(false)}
          />
        )}

        {/* Success Toast */}
        {notificationSuccess && (
          <div className="sdm-notification-toast">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            {notificationSuccess}
          </div>
        )}

        {/* Auto-add Success Toast */}
        {autoAddSuccess && (
          <div className="sdm-notification-toast">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v20M2 12h20" />
            </svg>
            {autoAddSuccess}
          </div>
        )}
      </div>
    </div>
  );
}
