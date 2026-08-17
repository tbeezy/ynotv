import { useState, useCallback, useRef, useEffect, memo, useMemo } from 'react';
import { getTmdbImageUrl, TMDB_POSTER_SIZES } from '../../services/tmdb';
import { useRpdbSettings } from '../../hooks/useRpdbSettings';
import { getRpdbPosterUrl } from '../../services/rpdb';
import type { StoredMovie, StoredSeries } from '../../db';
import { getVodDisplayYear } from './vodYear';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import {
  useVodMetadataOverridesStore,
  overrideKey,
  applyVodMetadataOverride,
} from '../../stores/vodMetadataOverridesStore';
import './MediaCard.css';

export interface MediaCardProps {
  item: StoredMovie | StoredSeries;
  type: 'movie' | 'series';
  onClick?: (item: StoredMovie | StoredSeries) => void;
  onRemove?: (item: StoredMovie | StoredSeries) => void;
  size?: 'small' | 'medium' | 'large';
  progressPercent?: number; // Optional: show progress bar (0-100)
  isRecentlyWatched?: boolean; // If true, show remove button
  // For series only - episode info
  seasonNum?: number;
  episodeNum?: number;
  episodeTitle?: string;
  // Favorite toggle on poster
  isFavorited?: boolean;
  onToggleFavorite?: (item: StoredMovie | StoredSeries) => void;
  // Optional style for dynamic sizing (e.g., marquee animation)
  style?: React.CSSProperties;
  sourceName?: string;
  onPlayDirect?: (item: StoredMovie | StoredSeries) => void;
}

export const MediaCard = memo(function MediaCard({ item, type, onClick, onRemove, size = 'medium', progressPercent, isRecentlyWatched, seasonNum, episodeNum, episodeTitle, isFavorited, onToggleFavorite, style, sourceName, onPlayDirect }: MediaCardProps) {
  useTranslation();
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [titleOverflows, setTitleOverflows] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Merge user-corrected metadata (title/year/poster/plot/tmdb_id) on top of
  // the provider row. Overrides live in a table sync never writes, so edits
  // survive provider refreshes.
  const mediaId = type === 'movie'
    ? (item as StoredMovie).stream_id
    : (item as StoredSeries).series_id;
  const metadataOverride = useVodMetadataOverridesStore((s) => s.overrides[overrideKey(mediaId, type)]);
  const effItem = useMemo(() => applyVodMetadataOverride(item, metadataOverride), [item, metadataOverride]);

  // Check if title overflows (triggers marquee animation on hover)
  useEffect(() => {
    const el = titleRef.current;
    if (el) {
      setTitleOverflows(el.scrollWidth > el.clientWidth);
    }
  }, [effItem.title, effItem.name]);

  // Load RPDB settings
  const { apiKey: rpdbApiKey } = useRpdbSettings();

  // Get the appropriate image URL
  // Note: Use 'type' prop to determine which field to use, NOT 'stream_icon' in item
  // because series objects may have stream_icon property (set to null)
  const posterUrl = type === 'movie'
    ? (effItem as StoredMovie).stream_icon
    : (effItem as StoredSeries).cover;

  // Use RPDB poster if we have an API key and tmdb_id
  const rpdbPosterUrl = rpdbApiKey && effItem.tmdb_id
    ? getRpdbPosterUrl(rpdbApiKey, effItem.tmdb_id, type)
    : null;

  // Try TMDB image if we have tmdb_id but no local poster
  const tmdbPosterPath = (effItem as StoredMovie | StoredSeries).backdrop_path;

  // Priority: RPDB (if available) > local poster > TMDB fallback
  const displayUrl = rpdbPosterUrl || posterUrl || getTmdbImageUrl(tmdbPosterPath, TMDB_POSTER_SIZES.medium);

  // Resolve the year the same way sorting does (year column with quoted-value
  // tolerance, release_date/releaseDate, or a trailing year in the name).
  const year = getVodDisplayYear(effItem, type);

  // Use clean title if available, otherwise fall back to name
  const displayTitle = effItem.title || effItem.name;

  // Rating - only show if it's a meaningful value (not 0, not NaN)
  const parsedRating = effItem.rating ? parseFloat(effItem.rating) : NaN;
  const rating = !isNaN(parsedRating) && parsedRating > 0 ? parsedRating : null;

  // Pass the RAW item on click (not the merged one) — the detail views apply
  // the metadata override themselves, so basing them on already-merged data
  // would make "Reset to provider metadata" unable to recover the original.
  const handleClick = useCallback(() => {
    onClick?.(item);
  }, [item, onClick]);

  const handleDirectPlay = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onPlayDirect?.(effItem);
  }, [effItem, onPlayDirect]);

  const handleRemove = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent card click
    e.preventDefault();
    onRemove?.(item);
  }, [item, onRemove]);

  const handleToggleFav = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onToggleFavorite?.(effItem);
  }, [effItem, onToggleFavorite]);

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
      aria-label={`${effItem.name}${year ? ` (${year})` : ''}`}
      style={style}
    >
      <div className="media-card__poster" title={displayTitle || undefined}>
        {displayUrl && !imageError ? (
          <img
            src={displayUrl}
            alt={effItem.name}
            onLoad={() => setImageLoaded(true)}
            onError={() => setImageError(true)}
            className={imageLoaded ? 'loaded' : ''}
          />
        ) : (
          <div className="media-card__placeholder">
            <span>{effItem.name.charAt(0).toUpperCase()}</span>
          </div>
        )}

        {/* Episode info badge for series */}
        {type === 'series' && seasonNum !== undefined && episodeNum !== undefined && (
          <div className="media-card__episode-badge">
            S{seasonNum} E{episodeNum}
          </div>
        )}

        {/* Source name badge */}
        {sourceName && (
          <div
            className={`media-card__source-badge${type === 'series' && seasonNum !== undefined && episodeNum !== undefined ? ' media-card__source-badge--right' : ''}`}
            title={sourceName}
          >
            {sourceName}
          </div>
        )}

        {/* Hover overlay */}
        <div className="media-card__overlay">
          <div
            className={`media-card__play-icon${onPlayDirect ? ' media-card__play-icon--playable' : ''}`}
            onClick={onPlayDirect ? handleDirectPlay : undefined}
            title={onPlayDirect ? i18n.t('vod:play') : undefined}
            role={onPlayDirect ? 'button' : undefined}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
        
        {/* Remove button for recently watched */}
        {isRecentlyWatched && onRemove && (
          <button
            className="media-card__remove-btn"
            onClick={handleRemove}
            aria-label={i18n.t('vod:removeFromRecent')}
            title={i18n.t('vod:removeFromRecent')}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        )}

        {/* Favorite button on poster */}
        {onToggleFavorite && (
          <button
            className={`media-card__fav-btn ${isFavorited ? 'favorited' : ''}`}
            onClick={handleToggleFav}
            aria-label={isFavorited ? i18n.t('vod:removeFavorite') : i18n.t('vod:addFavorite')}
            title={isFavorited ? i18n.t('vod:removeFavorite') : i18n.t('vod:addFavorite')}
          >
            <svg viewBox="0 0 24 24" fill={isFavorited ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        
        {/* Progress bar */}
        {progressPercent !== undefined && progressPercent > 0 && progressPercent < 100 && (
          <div className="media-card__progress-container">
            <div 
              className="media-card__progress-bar" 
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        )}
      </div>

      <div className="media-card__info">
        <h3
          ref={titleRef}
          className={`media-card__title${titleOverflows ? ' media-card__title--overflow' : ''}`}
          title={displayTitle || undefined}
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
