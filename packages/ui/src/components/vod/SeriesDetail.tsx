/**
 * SeriesDetail - Full page series detail view with season/episode picker
 *
 * Shows series information with backdrop, metadata, season dropdown,
 * and episode list. Slides in as a full page, not a modal.
 */

import { useState, useEffect, useCallback } from 'react';
import { getTmdbImageUrl, TMDB_POSTER_SIZES } from '../../services/tmdb';
import { useLazyBackdrop } from '../../hooks/useLazyBackdrop';
import { useLazyPlot } from '../../hooks/useLazyPlot';
import { useLazyCredits } from '../../hooks/useLazyCredits';
import { useSeriesDetails, useSeriesEpisodeProgress } from '../../hooks/useVod';
import { useRpdbSettings } from '../../hooks/useRpdbSettings';
import { getRpdbPosterUrl } from '../../services/rpdb';
import type { StoredSeries, StoredEpisode } from '../../db';
import { recordVodWatch, recordEpisodeWatch } from '../../db';
import type { VodPlayInfo } from '../../types/media';
import './SeriesDetail.css';

export interface SeriesDetailProps {
  series: StoredSeries;
  onClose: () => void;
  onPlayEpisode?: (info: VodPlayInfo) => void;
  apiKey?: string | null; // TMDB API key for lazy backdrop loading
  initialSeason?: number; // Initial season to show (for Recently Watched navigation)
}

export function SeriesDetail({ series, onClose, onPlayEpisode, apiKey, initialSeason }: SeriesDetailProps) {
  // console.log('[SeriesDetail] Rendered for:', series.series_id, series);
  const [selectedSeason, setSelectedSeason] = useState<number>(initialSeason ?? 1);

  // Fetch episodes
  const { seasons, loading, error, refetch } = useSeriesDetails(series.series_id);
  
  // Fetch episode progress
  const { episodeProgress, loading: progressLoading } = useSeriesEpisodeProgress(series.series_id);

  // Get sorted season numbers
  const seasonNumbers = Object.keys(seasons)
    .map(Number)
    .sort((a, b) => a - b);

  // Set first season as default when loaded
  useEffect(() => {
    if (seasonNumbers.length > 0 && !seasonNumbers.includes(selectedSeason)) {
      setSelectedSeason(seasonNumbers[0]);
    }
  }, [seasonNumbers, selectedSeason]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Lazy-load backdrop, plot, genre, and credits from TMDB if available
  const tmdbBackdropUrl = useLazyBackdrop(series, apiKey);
  const { plot: lazyPlot, genre: lazyGenre } = useLazyPlot(series, apiKey);
  const lazyCredits = useLazyCredits(series, apiKey);

  const handlePlayEpisode = useCallback(
    (episode: StoredEpisode) => {
      // Get current progress for this episode
      const progress = episodeProgress.get(episode.id);
      console.log('[SeriesDetail] Episode progress lookup:', episode.id, progress);
      const resumePosition = progress && progress.progressSeconds > 10 ? progress.progressSeconds : 0;
      console.log('[SeriesDetail] Resume position:', resumePosition);
      
      // Record series watch for Recently Watched with episode info
      void recordVodWatch(
        series.series_id,
        'series',
        series.source_id,
        series.title || series.name || 'Unknown',
        series.cover || (series as any).stream_icon,
        episode.season_num,
        episode.episode_num,
        episode.title || `Episode ${episode.episode_num}`
      );
      
      // Record episode progress for tracking
      // Calculate duration carefully to avoid NaN
      let episodeDuration = episode.duration ?? 0;
      if (!episodeDuration && episode.info?.duration) {
        const parsedDuration = Number(episode.info.duration);
        episodeDuration = isNaN(parsedDuration) ? 0 : parsedDuration;
      }
      console.log('[SeriesDetail] Episode duration:', episodeDuration, '(from duration:', episode.duration, ', info.duration:', episode.info?.duration + ')');
      
      void recordEpisodeWatch(
        episode.id,
        series.series_id,
        series.source_id,
        episode.season_num,
        episode.episode_num,
        episode.title || `Episode ${episode.episode_num}`,
        resumePosition, // Will be updated when stopped
        episodeDuration
      );
      
      onPlayEpisode?.({
        url: episode.direct_url,
        title: series.title || series.name,
        year: series.year || series.release_date?.slice(0, 4),
        plot: lazyPlot || series.plot,
        type: 'series',
        episodeInfo: `S${episode.season_num} E${episode.episode_num}${episode.title ? ` · ${episode.title}` : ''}`,
        source_id: series.source_id,
        mediaId: `${series.series_id}_ep_${episode.id}`,  // Episode-specific media ID
        // Series navigation fields
        seriesId: series.series_id,
        seasonNum: episode.season_num,
        episodeNum: episode.episode_num,
        episodeId: episode.id,
      });
    },
    [series, onPlayEpisode, lazyPlot, episodeProgress]
  );

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const handleCopy = useCallback((episode: StoredEpisode, e: React.MouseEvent) => {
    e.stopPropagation();
    if (episode.direct_url) {
      navigator.clipboard.writeText(episode.direct_url);
      setCopiedId(episode.id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  }, []);

  // Load RPDB settings for poster
  const { apiKey: rpdbApiKey } = useRpdbSettings();
  const rpdbPosterUrl = rpdbApiKey && series.tmdb_id
    ? getRpdbPosterUrl(rpdbApiKey, series.tmdb_id, 'series')
    : null;

  // Get images - use TMDB backdrop if available, fallback to cover
  const backdropUrl = tmdbBackdropUrl || series.cover;

  // Priority: RPDB poster > local cover > TMDB/TVMaze fallback
  // Note: backdrop_path could be TMDB path (e.g., "/abc.jpg") or TVMaze full URL
  const posterUrl = rpdbPosterUrl || series.cover ||
    (series.backdrop_path
      ? series.backdrop_path.startsWith('http')
        ? series.backdrop_path  // TVMaze full URL
        : getTmdbImageUrl(series.backdrop_path, TMDB_POSTER_SIZES.medium)  // TMDB path
      : null);

  // Use clean title if available, otherwise fall back to name
  const displayTitle = series.title || series.name;

  // Use year field if available, otherwise extract from release_date
  const year = series.year || series.release_date?.slice(0, 4);

  // Rating - only show if it's a meaningful value (not 0, not NaN)
  const parsedRating = series.rating ? parseFloat(series.rating) : NaN;
  const rating = !isNaN(parsedRating) && parsedRating > 0 ? parsedRating : null;
  const genreSource = series.genre || lazyGenre;
  const genres = genreSource?.split(',').map((g) => g.trim()).filter(Boolean) ?? [];

  // Current season episodes
  const currentEpisodes = seasons[selectedSeason] ?? [];

  return (
    <div className="series-detail">
      {/* Backdrop */}
      <div className="series-detail__backdrop">
        {backdropUrl && <img src={backdropUrl} alt="" aria-hidden="true" />}
        <div className="series-detail__backdrop-gradient" />
      </div>

      {/* Header with back button */}
      <header className="series-detail__header">
        <button
          className="series-detail__back"
          onClick={onClose}
          aria-label="Go back"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back
        </button>
      </header>

      {/* Content */}
      <div className="series-detail__content">
        <div className="series-detail__main">
          {/* Poster */}
          <div className="series-detail__poster">
            {posterUrl ? (
              <img src={posterUrl} alt={series.name} />
            ) : (
              <div className="series-detail__poster-placeholder">
                <span>{series.name.charAt(0).toUpperCase()}</span>
              </div>
            )}
          </div>

          {/* Info */}
          <div className="series-detail__info">
            <h1 className="series-detail__title">{displayTitle}</h1>

            <div className="series-detail__meta">
              {year && <span className="series-detail__year">{year}</span>}
              {rating && (
                <span className="series-detail__rating">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                  </svg>
                  {rating.toFixed(1)}
                </span>
              )}
              {seasonNumbers.length > 0 && (
                <span className="series-detail__seasons-count">
                  {seasonNumbers.length} Season{seasonNumbers.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {genres.length > 0 && (
              <div className="series-detail__genres">
                {genres.map((genre) => (
                  <span key={genre} className="series-detail__genre">
                    {genre}
                  </span>
                ))}
              </div>
            )}

            {(series.plot || lazyPlot) && (
              <p className="series-detail__description">{series.plot || lazyPlot}</p>
            )}

            {/* Credits */}
            {lazyCredits.cast && (
              <div className="series-detail__credits">
                <span className="series-detail__credit-label">Cast</span>
                <span className="series-detail__credit-value">{lazyCredits.cast}</span>
              </div>
            )}
          </div>
        </div>

        {/* Episodes section */}
        <div className="series-detail__episodes-section">
          {/* Season selector */}
          <div className="series-detail__season-selector">
            <label htmlFor="season-select">Season</label>
            <div className="series-detail__select-wrapper">
              <select
                id="season-select"
                value={selectedSeason}
                onChange={(e) => setSelectedSeason(Number(e.target.value))}
              >
                {seasonNumbers.map((num) => (
                  <option key={num} value={num}>
                    Season {num}
                  </option>
                ))}
              </select>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </div>
          </div>

          {/* Episode list */}
          <div className="series-detail__episodes">
            {loading ? (
              <div className="series-detail__loading">
                <div className="series-detail__spinner" />
                <span>Loading episodes...</span>
              </div>
            ) : error ? (
              <div className="series-detail__error">
                <p>{error}</p>
                <button onClick={refetch}>Try Again</button>
              </div>
            ) : currentEpisodes.length === 0 ? (
              <div className="series-detail__empty">
                <p>No episodes found for Season {selectedSeason}</p>
              </div>
            ) : (
              <div className="series-detail__episode-list">
                {currentEpisodes.map((episode) => {
                  const progress = episodeProgress.get(episode.id);
                  const hasProgress = progress && progress.progressPercent > 0 && !progress.completed;
                  const isCompleted = progress?.completed || false;
                  
                  return (
                    <div 
                      key={episode.id} 
                      className={`series-detail__episode-row ${hasProgress ? 'has-progress' : ''} ${isCompleted ? 'completed' : ''}`}
                    >
                      <button
                        className="series-detail__episode"
                        onClick={() => handlePlayEpisode(episode)}
                      >
                        <span className="series-detail__episode-number">
                          {isCompleted ? (
                            <svg className="series-detail__episode-checkmark" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                            </svg>
                          ) : (
                            episode.episode_num
                          )}
                        </span>
                        <div className="series-detail__episode-info">
                          <span className="series-detail__episode-title">
                            {episode.title || `Episode ${episode.episode_num}`}
                          </span>
                          <div className="series-detail__episode-meta">
                            {(episode.duration ?? (episode.info?.duration as number | undefined)) ? (
                              <span className="series-detail__episode-duration">
                                {Math.round((episode.duration ?? Number(episode.info?.duration) ?? 0) / 60)}m
                              </span>
                            ) : null}
                            {hasProgress && (
                              <div className="series-detail__episode-progress-bar">
                                <div 
                                  className="series-detail__episode-progress-fill"
                                  style={{ width: `${progress.progressPercent}%` }}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                        <svg
                          className="series-detail__episode-play"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                        >
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </button>
                      {episode.direct_url && (
                        <button
                          className={`series-detail__episode-copy ${copiedId === episode.id ? 'copied' : ''}`}
                          onClick={(e) => handleCopy(episode, e)}
                          title="Copy Stream URL"
                        >
                          {copiedId === episode.id ? (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SeriesDetail;
