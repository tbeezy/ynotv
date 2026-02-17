/**
 * MovieDetail - Full page movie detail view
 *
 * Shows movie information with backdrop, metadata, and play button.
 * Slides in as a full page, not a modal.
 */

import { useEffect, useCallback } from 'react';
import { getTmdbImageUrl, TMDB_POSTER_SIZES } from '../../services/tmdb';
import { useLazyBackdrop } from '../../hooks/useLazyBackdrop';
import { useLazyPlot } from '../../hooks/useLazyPlot';
import { useLazyCredits } from '../../hooks/useLazyCredits';
import { useRpdbSettings } from '../../hooks/useRpdbSettings';
import { getRpdbPosterUrl } from '../../services/rpdb';
import type { StoredMovie } from '../../db';
import './MovieDetail.css';

export interface MovieDetailProps {
  movie: StoredMovie;
  onClose: () => void;
  onPlay?: (movie: StoredMovie, plot?: string | null) => void;
  apiKey?: string | null; // TMDB API key for lazy backdrop loading
}

export function MovieDetail({ movie, onClose, onPlay, apiKey }: MovieDetailProps) {
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
  const tmdbBackdropUrl = useLazyBackdrop(movie, apiKey);
  const { plot: lazyPlot, genre: lazyGenre } = useLazyPlot(movie, apiKey);
  const lazyCredits = useLazyCredits(movie, apiKey);

  const handlePlay = useCallback(() => {
    onPlay?.(movie, lazyPlot || movie.plot);
  }, [movie, onPlay, lazyPlot]);

  // Load RPDB settings for poster
  const { apiKey: rpdbApiKey } = useRpdbSettings();
  const rpdbPosterUrl = rpdbApiKey && movie.tmdb_id
    ? getRpdbPosterUrl(rpdbApiKey, movie.tmdb_id, 'movie')
    : null;

  // Get images - use TMDB backdrop if available, fallback to stream_icon
  const backdropUrl = tmdbBackdropUrl || movie.stream_icon;

  // Priority: RPDB poster > local poster > TMDB fallback
  const posterUrl = rpdbPosterUrl || movie.stream_icon ||
    (movie.backdrop_path
      ? getTmdbImageUrl(movie.backdrop_path, TMDB_POSTER_SIZES.medium)
      : null);

  // Use clean title if available, otherwise fall back to name
  const displayTitle = movie.title || movie.name;

  // Use year field if available, otherwise extract from release_date
  const year = movie.year || movie.release_date?.slice(0, 4);

  // Rating - only show if it's a meaningful value (not 0, not NaN)
  const parsedRating = movie.rating ? parseFloat(movie.rating) : NaN;
  const rating = !isNaN(parsedRating) && parsedRating > 0 ? parsedRating : null;
  // Use provider metadata if available (even if empty string), otherwise fall back to TMDB
  const genreSource = movie.genre != null ? movie.genre : lazyGenre;
  const genres = genreSource?.split(',').map((g) => g.trim()).filter(Boolean) ?? [];
  const duration = movie.duration && movie.duration > 0
    ? `${Math.floor(movie.duration / 60)}h ${movie.duration % 60}m`
    : null;

  return (
    <div className="movie-detail">
      {/* Backdrop */}
      <div className="movie-detail__backdrop">
        {backdropUrl && <img src={backdropUrl} alt="" aria-hidden="true" />}
        <div className="movie-detail__backdrop-gradient" />
      </div>

      {/* Header with back button */}
      <header className="movie-detail__header">
        <button
          className="movie-detail__back"
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
      <div className="movie-detail__content">
        <div className="movie-detail__main">
          {/* Poster */}
          <div className="movie-detail__poster">
            {posterUrl ? (
              <img src={posterUrl} alt={movie.name} />
            ) : (
              <div className="movie-detail__poster-placeholder">
                <span>{movie.name.charAt(0).toUpperCase()}</span>
              </div>
            )}
          </div>

          {/* Info */}
          <div className="movie-detail__info">
            <h1 className="movie-detail__title">{displayTitle}</h1>

            <div className="movie-detail__meta">
              {year && <span className="movie-detail__year">{year}</span>}
              {rating && (
                <span className="movie-detail__rating">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                  </svg>
                  {rating.toFixed(1)}
                </span>
              )}
              {duration && (
                <span className="movie-detail__duration">{duration}</span>
              )}
            </div>

            {genres.length > 0 && (
              <div className="movie-detail__genres">
                {genres.map((genre) => (
                  <span key={genre} className="movie-detail__genre">
                    {genre}
                  </span>
                ))}
              </div>
            )}

            {/* Use provider plot if available (even if empty string), otherwise fall back to TMDB */}
            {(movie.plot != null ? movie.plot : lazyPlot) && (
              <p className="movie-detail__description">{movie.plot != null ? movie.plot : lazyPlot}</p>
            )}

            {/* Actions */}
            <div className="movie-detail__actions">
              <button
                className="movie-detail__btn movie-detail__btn--primary"
                onClick={handlePlay}
              >
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
                Play
              </button>
            </div>

            {/* Credits */}
            <div className="movie-detail__credits">
              {lazyCredits.cast && (
                <div className="movie-detail__credit-row">
                  <span className="movie-detail__credit-label">Cast</span>
                  <span className="movie-detail__credit-value">{lazyCredits.cast}</span>
                </div>
              )}
              {lazyCredits.director && (
                <div className="movie-detail__credit-row">
                  <span className="movie-detail__credit-label">Director</span>
                  <span className="movie-detail__credit-value">{lazyCredits.director}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default MovieDetail;
