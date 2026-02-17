import { useState, useCallback, useRef, useEffect, memo } from 'react';
import { getTmdbImageUrl, TMDB_POSTER_SIZES } from '../../services/tmdb';
import { useRpdbSettings } from '../../hooks/useRpdbSettings';
import { getRpdbPosterUrl } from '../../services/rpdb';
import type { StoredMovie, StoredSeries } from '../../db';
import './MediaCard.css';

export interface MediaCardProps {
  item: StoredMovie | StoredSeries;
  type: 'movie' | 'series';
  onClick?: (item: StoredMovie | StoredSeries) => void;
  size?: 'small' | 'medium' | 'large';
}

export const MediaCard = memo(function MediaCard({ item, type, onClick, size = 'medium' }: MediaCardProps) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [titleOverflows, setTitleOverflows] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Check if title overflows (triggers marquee animation on hover)
  useEffect(() => {
    const el = titleRef.current;
    if (el) {
      setTitleOverflows(el.scrollWidth > el.clientWidth);
    }
  }, [item.title, item.name]);

  // Load RPDB settings
  const { apiKey: rpdbApiKey } = useRpdbSettings();

  // Get the appropriate image URL
  // Note: Use 'type' prop to determine which field to use, NOT 'stream_icon' in item
  // because series objects may have stream_icon property (set to null)
  const posterUrl = type === 'movie'
    ? (item as StoredMovie).stream_icon
    : (item as StoredSeries).cover;

  // Use RPDB poster if we have an API key and tmdb_id
  const rpdbPosterUrl = rpdbApiKey && item.tmdb_id
    ? getRpdbPosterUrl(rpdbApiKey, item.tmdb_id, type)
    : null;

  // Try TMDB image if we have tmdb_id but no local poster
  const tmdbPosterPath = (item as StoredMovie | StoredSeries).backdrop_path;

  // Priority: RPDB (if available) > local poster > TMDB fallback
  const displayUrl = rpdbPosterUrl || posterUrl || getTmdbImageUrl(tmdbPosterPath, TMDB_POSTER_SIZES.medium);

  // Use item.year if available, otherwise extract from release_date
  const year = item.year
    || (item.release_date ? item.release_date.slice(0, 4) : null);

  // Use clean title if available, otherwise fall back to name
  const displayTitle = item.title || item.name;

  // Rating - only show if it's a meaningful value (not 0, not NaN)
  const parsedRating = item.rating ? parseFloat(item.rating) : NaN;
  const rating = !isNaN(parsedRating) && parsedRating > 0 ? parsedRating : null;

  const handleClick = useCallback(() => {
    onClick?.(item);
  }, [item, onClick]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick?.(item);
      }
    },
    [item, onClick]
  );

  return (
    <div
      className={`media-card media-card--${size}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-label={`${item.name}${year ? ` (${year})` : ''}`}
    >
      <div className="media-card__poster">
        {displayUrl && !imageError ? (
          <img
            src={displayUrl}
            alt={item.name}
            onLoad={() => setImageLoaded(true)}
            onError={() => setImageError(true)}
            className={imageLoaded ? 'loaded' : ''}
          />
        ) : (
          <div className="media-card__placeholder">
            <span>{item.name.charAt(0).toUpperCase()}</span>
          </div>
        )}

        {/* Hover overlay */}
        <div className="media-card__overlay">
          <div className="media-card__play-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      </div>

      <div className="media-card__info">
        <h3
          ref={titleRef}
          className={`media-card__title${titleOverflows ? ' media-card__title--overflow' : ''}`}
        >
          <span className="media-card__title-inner">{displayTitle}</span>
        </h3>
        <div className="media-card__meta">
          {year && <span className="media-card__year">{year}</span>}
          {rating && (
            <span className="media-card__rating">
              <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              {rating.toFixed(1)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

export default MediaCard;
