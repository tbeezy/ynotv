import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState } from 'react';
import './ShowDetailsModal.css';

interface Episode {
  id: number;
  name?: string;
  season?: number;
  number?: number;
  airdate?: string;
  airtime?: string;
  runtime?: number;
  summary?: string;
  airstamp?: string;
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
  tvmazeId: number;
  showName: string;
  channelName: string | null;
  onClose: () => void;
  onPlayChannel?: (channelName: string) => void;
}

export function ShowDetailsModal({ tvmazeId, showName, channelName, onClose, onPlayChannel }: Props) {
  const [data, setData] = useState<ShowDetailsWithEpisodes | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          <button className="sdm-close-btn" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
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

                {onPlayChannel && channelName && (
                  <button
                    className="sdm-play-btn"
                    onClick={() => {
                      onPlayChannel(channelName);
                      onClose();
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    Watch on {channelName}
                  </button>
                )}
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
                      {nextEpisode.airtime && (
                        <span className="sdm-dot">•</span>
                      )}
                      {nextEpisode.airtime && (
                        <span>{formatTime(nextEpisode.airtime)}</span>
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
                          {episode.airtime && (
                            <span className="sdm-dot">•</span>
                          )}
                          {episode.airtime && (
                            <span>{formatTime(episode.airtime)}</span>
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
                          onClick={() => openUrl(`https://www.imdb.com/title/${details.externals.imdb}`)}
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
      </div>
    </div>
  );
}
