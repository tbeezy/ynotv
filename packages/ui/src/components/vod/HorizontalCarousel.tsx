import { useRef, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import type { StoredMovie, StoredSeries } from '../../db';
import { MediaCard } from './MediaCard';
import { useSourceNameMap } from '../../hooks/useChannels';
import { useSettingsStore } from '../../stores/settingsStore';
import './HorizontalCarousel.css';

export interface HorizontalCarouselProps {
  title: string;
  items: (StoredMovie | StoredSeries)[];
  type: 'movie' | 'series';
  onItemClick?: (item: StoredMovie | StoredSeries) => void;
  onItemRemove?: (item: StoredMovie | StoredSeries) => void;
  cardSize?: 'small' | 'medium' | 'large';
  loading?: boolean;
  maxItems?: number; // Limit items for performance
  hidden?: boolean; // Hide but maintain minimal height for Virtuoso
  progressData?: Map<string, number>; // Optional: media_id -> progress percent
  isRecentlyWatched?: boolean;
  episodeData?: Map<string, { seasonNum?: number; episodeNum?: number; episodeTitle?: string }>; // For series only
  onPlayItem?: (item: StoredMovie | StoredSeries, seasonNum?: number, episodeNum?: number, episodeTitle?: string) => void;
}

export function HorizontalCarousel({
  title,
  items,
  type,
  onItemClick,
  onItemRemove,
  cardSize = 'medium',
  loading = false,
  maxItems = 20,
  hidden = false,
  progressData,
  isRecentlyWatched = false,
  episodeData,
  onPlayItem,
}: HorizontalCarouselProps) {
  useTranslation();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const vodShowSourceBadge = useSettingsStore((s) => s.vodShowSourceBadge);
  const sourceNameMap = useSourceNameMap();

  // Limit items for performance
  const displayItems = maxItems ? items.slice(0, maxItems) : items;

  // Check scroll bounds
  const updateScrollButtons = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      setCanScrollLeft(container.scrollLeft > 0);
      setCanScrollRight(
        container.scrollLeft < container.scrollWidth - container.clientWidth - 1
      );
    }
  }, []);

  // Update on items change or load
  useEffect(() => {
    updateScrollButtons();
  }, [items, loading, updateScrollButtons]);

  const scroll = (direction: 'left' | 'right') => {
    const container = scrollContainerRef.current;
    if (container) {
      const scrollAmount = container.clientWidth * 0.75;
      container.scrollBy({
        left: direction === 'left' ? -scrollAmount : scrollAmount,
        behavior: 'smooth',
      });
    }
  };

  // Don't render empty carousel (unless loading)
  if (!loading && items.length === 0) {
    return null;
  }

  return (
    <section className={`carousel${hidden ? ' carousel--hidden' : ''}`}>
      <div className="carousel__header">
        <h2 className="carousel__title">{title}</h2>
        <div className="carousel__controls">
          <button
            className="carousel__arrow carousel__arrow--left"
            onClick={() => scroll('left')}
            disabled={!canScrollLeft}
            aria-label={i18n.t('vod:scrollLeft')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <button
            className="carousel__arrow carousel__arrow--right"
            onClick={() => scroll('right')}
            disabled={!canScrollRight}
            aria-label={i18n.t('vod:scrollRight')}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" strokeWidth="2">
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
            displayItems.map((item) => {
              const itemId = type === 'movie' ? (item as StoredMovie).stream_id : (item as StoredSeries).series_id;
              const progress = progressData?.get(itemId);
              const episodeInfo = episodeData?.get(itemId);
              const sourceName = (isRecentlyWatched && vodShowSourceBadge && sourceNameMap && item.source_id)
                ? sourceNameMap.get(item.source_id)
                : undefined;
              return (
                <MediaCard
                  key={itemId}
                  item={item}
                  type={type}
                  onClick={onItemClick}
                  onRemove={onItemRemove}
                  size={cardSize}
                  progressPercent={progress}
                  isRecentlyWatched={isRecentlyWatched}
                  seasonNum={episodeInfo?.seasonNum}
                  episodeNum={episodeInfo?.episodeNum}
                  episodeTitle={episodeInfo?.episodeTitle}
                  sourceName={sourceName}
                  onPlayDirect={onPlayItem ? (clickedItem) => {
                    const epInfo = episodeData?.get(type === 'movie' ? (clickedItem as StoredMovie).stream_id : (clickedItem as StoredSeries).series_id);
                    onPlayItem(clickedItem, epInfo?.seasonNum, epInfo?.episodeNum, epInfo?.episodeTitle);
                  } : undefined}
                />
              );
            })
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
