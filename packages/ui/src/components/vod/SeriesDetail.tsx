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
import { useSeriesDetails } from '../../hooks/useVod';
import { useRpdbSettings } from '../../hooks/useRpdbSettings';
import { getRpdbPosterUrl } from '../../services/rpdb';
import type { StoredSeries, StoredEpisode } from '../../db';
import type { VodPlayInfo } from '../../types/media';
import './SeriesDetail.css';

export interface SeriesDetailProps {
  series: StoredSeries;
  onClose: () => void;
  onPlayEpisode?: (info: VodPlayInfo) => void;
  apiKey?: string | null; // TMDB API key for lazy backdrop loading
}

export function SeriesDetail({ series, onClose, onPlayEpisode, apiKey }: SeriesDetailProps) {
  // console.log('[SeriesDetail] Rendered for:', series.series_id, series);
  const [selectedSeason, setSelectedSeason] = useState<number>(1);

  // Fetch episodes
  const { seasons, loading, error, refetch } = useSeriesDetails(series.series_id);

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
      onPlayEpisode?.({
        url: episode.direct_url,
        title: series.title || series.name,
        year: series.year || series.release_date?.slice(0, 4),
        plot: lazyPlot || series.plot,
        type: 'series',
        episodeInfo: `S${episode.season_num} E${episode.episode_num}${episode.title ? ` · ${episode.title}` : ''}`,
        source_id: series.source_id,
      });
    },
    [series, onPlayEpisode, lazyPlot]
  );

  // Load RPDB settings for poster
  const { apiKey: rpdbApiKey } = useRpdbSettings();
  const rpdbPosterUrl = rpdbApiKey && series.tmdb_id
    ? getRpdbPosterUrl(rpdbApiKey, series.tmdb_id, 'series')
    : null;

  // Get images - use TMDB backdrop if available, fallback to cover
  const backdropUrl = tmdbBackdropUrl || series.cover;

  // Priority: RPDB poster > local cover > TMDB fallback
  const posterUrl = rpdbPosterUrl || series.cover ||
    (series.backdrop_path
      ? getTmdbImageUrl(series.backdrop_path, TMDB_POSTER_SIZES.medium)
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
                {currentEpisodes.map((episode) => (
                  <button
                    key={episode.id}
                    className="series-detail__episode"
                    onClick={() => handlePlayEpisode(episode)}
                  >
                    <span className="series-detail__episode-number">
                      {episode.episode_num}
                    </span>
                    <div className="series-detail__episode-info">
                      <span className="series-detail__episode-title">
                        {episode.title || `Episode ${episode.episode_num}`}
                      </span>
                      {(episode.duration ?? (episode.info?.duration as number | undefined)) ? (
                        <span className="series-detail__episode-duration">
                          {Math.round((episode.duration ?? Number(episode.info?.duration) ?? 0) / 60)}m
                        </span>
                      ) : null}
                    </div>
                    <svg
                      className="series-detail__episode-play"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SeriesDetail;
