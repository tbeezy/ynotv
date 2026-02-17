import { useRef, useState, useCallback, useEffect } from 'react';
import type { StoredMovie, StoredSeries } from '../../db';
import { MediaCard } from './MediaCard';
import './HorizontalCarousel.css';

export interface HorizontalCarouselProps {
  title: string;
  items: (StoredMovie | StoredSeries)[];
  type: 'movie' | 'series';
  onItemClick?: (item: StoredMovie | StoredSeries) => void;
  cardSize?: 'small' | 'medium' | 'large';
  loading?: boolean;
  maxItems?: number; // Limit items for performance
  hidden?: boolean; // Hide but maintain minimal height for Virtuoso
}

export function HorizontalCarousel({
  title,
  items,
  type,
  onItemClick,
  cardSize = 'medium',
  loading = false,
  maxItems = 20,
  hidden = false,
}: HorizontalCarouselProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Limit items for performance
  const displayItems = maxItems ? items.slice(0, maxItems) : items;

  // Update scroll button visibility
  const updateScrollButtons = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollLeft, scrollWidth, clientWidth } = container;
    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  useEffect(() => {
    updateScrollButtons();
    window.addEventListener('resize', updateScrollButtons);
    return () => window.removeEventListener('resize', updateScrollButtons);
  }, [updateScrollButtons, items.length]);

  // Scroll by amount
  const scroll = useCallback((direction: 'left' | 'right') => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const scrollAmount = container.clientWidth * 0.75;
    const targetScroll = direction === 'left'
      ? container.scrollLeft - scrollAmount
      : container.scrollLeft + scrollAmount;

    container.scrollTo({
      left: targetScroll,
      behavior: 'smooth',
    });
  }, []);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') {
      scroll('left');
    } else if (e.key === 'ArrowRight') {
      scroll('right');
    }
  }, [scroll]);

  // Hidden carousels render a minimal placeholder for Virtuoso
  if (hidden || (displayItems.length === 0 && !loading)) {
    return <div className="carousel carousel--empty" aria-hidden="true" />;
  }

  return (
    <section className="carousel" onKeyDown={handleKeyDown}>
      <div className="carousel__header">
        <h2 className="carousel__title">{title}</h2>
        <div className="carousel__nav">
          <button
            className="carousel__nav-btn"
            onClick={() => scroll('left')}
            disabled={!canScrollLeft}
            aria-label="Scroll left"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <button
            className="carousel__nav-btn"
            onClick={() => scroll('right')}
            disabled={!canScrollRight}
            aria-label="Scroll right"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </div>
      </div>

      <div
        className="carousel__scroll-container"
        ref={scrollContainerRef}
        onScroll={updateScrollButtons}
      >
        <div className="carousel__track">
          {loading ? (
            // Loading skeletons
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className={`media-card-skeleton media-card-skeleton--${cardSize}`} />
            ))
          ) : (
            displayItems.map((item) => (
              <MediaCard
                key={type === 'movie' ? (item as StoredMovie).stream_id : (item as StoredSeries).series_id}
                item={item}
                type={type}
                onClick={onItemClick}
                size={cardSize}
              />
            ))
          )}
        </div>
      </div>

      {/* Scroll fade indicators */}
      {canScrollLeft && <div className="carousel__fade carousel__fade--left" />}
      {canScrollRight && <div className="carousel__fade carousel__fade--right" />}
    </section>
  );
}

export default HorizontalCarousel;
