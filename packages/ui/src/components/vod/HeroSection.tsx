import { useState, useEffect, useCallback } from 'react';
import type { StoredMovie, StoredSeries } from '../../db';
import { useLazyBackdrop } from '../../hooks/useLazyBackdrop';
import { useLazyPlot } from '../../hooks/useLazyPlot';
import './HeroSection.css';

type MediaItem = StoredMovie | StoredSeries;

// Sub-component for each backdrop layer (hooks can't be in loops)
function HeroBackdropLayer({
  item,
  apiKey,
  isActive,
}: {
  item: MediaItem;
  apiKey?: string | null;
  isActive: boolean;
}) {
  const tmdbBackdropUrl = useLazyBackdrop(item, apiKey);

  // Fallback to cover/icon if no TMDB backdrop
  const fallbackUrl = 'stream_icon' in item
    ? item.stream_icon
    : (item as StoredSeries).cover;
  const backdropUrl = tmdbBackdropUrl || fallbackUrl;

  if (!backdropUrl) return null;

  return (
    <img
      src={backdropUrl}
      alt=""
      aria-hidden="true"
      className={`hero__backdrop-img ${isActive ? 'hero__backdrop-img--active' : ''}`}
    />
  );
}

export interface HeroSectionProps {
  items: (StoredMovie | StoredSeries)[];
  type: 'movie' | 'series';
  onPlay?: (item: StoredMovie | StoredSeries) => void;
  onMoreInfo?: (item: StoredMovie | StoredSeries) => void;
  autoRotate?: boolean;
  rotateInterval?: number;
  apiKey?: string | null;
  loading?: boolean;
}

export function HeroSection({
  items,
  type,
  onPlay,
  onMoreInfo,
  autoRotate = true,
  rotateInterval = 8000,
  apiKey,
  loading = false,
}: HeroSectionProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isContentTransitioning, setIsContentTransitioning] = useState(false);

  const currentItem = items[currentIndex];

  // Lazy-load plot and genre for current item
  const { plot: lazyPlot, genre: lazyGenre } = useLazyPlot(currentItem, apiKey);
  const displayGenre = currentItem?.genre || lazyGenre;

  // Auto-rotate through items
  useEffect(() => {
    if (!autoRotate || items.length <= 1) return;

    const timer = setInterval(() => {
      // Fade out content
      setIsContentTransitioning(true);
      setTimeout(() => {
        // Swap to next item (backdrop crossfades automatically via CSS)
        setCurrentIndex((prev) => (prev + 1) % items.length);
        setIsContentTransitioning(false);
      }, 300); // Content fade duration
    }, rotateInterval);

    return () => clearInterval(timer);
  }, [autoRotate, items.length, rotateInterval]);

  const handleDotClick = useCallback((index: number) => {
    if (index === currentIndex) return;
    setIsContentTransitioning(true);
    setTimeout(() => {
      setCurrentIndex(index);
      setIsContentTransitioning(false);
    }, 300);
  }, [currentIndex]);

  // Show loading state while data is being fetched
  if (loading || !currentItem) {
    return (
      <div className="hero hero--empty">
        <div className="hero__content">
          {loading ? (
            <>
              <div className="hero__spinner" />
              <p>Loading content...</p>
            </>
          ) : (
            <>
              <h1>No content available</h1>
              <p>Add an Xtream source in Settings to get started</p>
            </>
          )}
        </div>
      </div>
    );
  }

  // Use clean title if available, otherwise fall back to name
  const displayTitle = currentItem.title || currentItem.name;

  // Use year field if available, otherwise extract from release_date
  const year = currentItem.year || currentItem.release_date?.slice(0, 4);

  // Rating - only show if it's a meaningful value (not 0, not NaN)
  const parsedRating = currentItem.rating ? parseFloat(currentItem.rating) : NaN;
  const rating = !isNaN(parsedRating) && parsedRating > 0 ? parsedRating : null;

  return (
    <section className="hero">
      {/* Background images - all rendered, only current is visible */}
      <div className="hero__backdrop">
        {items.map((item, index) => (
          <HeroBackdropLayer
            key={'stream_id' in item ? item.stream_id : item.series_id}
            item={item}
            apiKey={apiKey}
            isActive={index === currentIndex}
          />
        ))}
        <div className="hero__gradient" />
      </div>

      {/* Content */}
      <div className={`hero__content ${isContentTransitioning ? 'hero__content--transitioning' : ''}`}>
        <div className="hero__info">
          <span className="hero__type">{type === 'movie' ? 'Movie' : 'Series'}</span>
          <h1 className="hero__title">{displayTitle}</h1>

          <div className="hero__meta">
            {year && <span className="hero__year">{year}</span>}
            {rating && (
              <span className="hero__rating">
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                {rating.toFixed(1)}
              </span>
            )}
            {displayGenre && (
              <span className="hero__genre">{displayGenre.split(',')[0]}</span>
            )}
          </div>

          {(currentItem.plot || lazyPlot) && (
            <p className="hero__description">{currentItem.plot || lazyPlot}</p>
          )}

          <div className="hero__actions">
            <button
              className="hero__btn hero__btn--primary"
              onClick={() => onPlay?.(currentItem)}
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              Play
            </button>
            <button
              className="hero__btn hero__btn--secondary"
              onClick={() => onMoreInfo?.(currentItem)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
              More Info
            </button>
          </div>
        </div>
      </div>

      {/* Navigation dots */}
      {items.length > 1 && (
        <div className="hero__dots">
          {items.map((item, index) => (
            <button
              key={index}
              className={`hero__dot ${index === currentIndex ? 'active' : ''}`}
              onClick={() => handleDotClick(index)}
              aria-label={`Go to slide ${index + 1}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default HeroSection;
