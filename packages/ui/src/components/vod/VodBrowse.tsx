/**
 * VodBrowse - Virtualized gallery grid with A-Z navigation
 *
 * Shows category-filtered content in a grid with infinite scroll
 * and alphabet quick-nav rail.
 */

import { useState, useCallback, useMemo, useRef, forwardRef, useEffect, memo } from 'react';
import { VirtuosoGrid, VirtuosoGridHandle } from 'react-virtuoso';
import { MediaCard } from './MediaCard';
import { AlphabetRail } from './AlphabetRail';
import type { StoredMovie, StoredSeries } from '../../db';
import {
  usePaginatedMovies,
  usePaginatedSeries,
  useAlphabetIndex,
  useCurrentLetter,
  useLazyStalkerLoader, // Import the new hook
} from '../../hooks/useVod';
import './VodBrowse.css';

// Poster size presets (card width in pixels)
const POSTER_SIZE_PRESETS = [
  { value: 100, label: 'XS', columns: 'Many' },
  { value: 120, label: 'S', columns: 'More' },
  { value: 140, label: 'M', columns: 'Medium' },
  { value: 160, label: 'L', columns: 'Default' },
  { value: 180, label: 'XL', columns: 'Bigger' },
  { value: 200, label: '2XL', columns: 'Big' },
  { value: 240, label: '3XL', columns: 'Huge' },
] as const;

type PosterSizeValue = typeof POSTER_SIZE_PRESETS[number]['value'];

// Hook to persist poster size preference
function usePosterSizePreference(): [PosterSizeValue, (value: PosterSizeValue) => void] {
  const [size, setSize] = useState<PosterSizeValue>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('vodPosterSize');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (POSTER_SIZE_PRESETS.some(p => p.value === parsed)) {
          return parsed as PosterSizeValue;
        }
      }
    }
    return 160; // Default size
  });

  const setSizeAndSave = useCallback((newSize: PosterSizeValue) => {
    setSize(newSize);
    if (typeof window !== 'undefined') {
      localStorage.setItem('vodPosterSize', String(newSize));
    }
  }, []);

  return [size, setSizeAndSave];
}

// Debounce hook - delays value updates to avoid expensive operations on every keystroke
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

// Poster Size Slider Component
interface PosterSizeSliderProps {
  value: PosterSizeValue;
  onChange: (value: PosterSizeValue) => void;
}

const PosterSizeSlider = memo(function PosterSizeSlider({ value, onChange }: PosterSizeSliderProps) {
  const currentIndex = POSTER_SIZE_PRESETS.findIndex(p => p.value === value);
  
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const index = parseInt(e.target.value, 10);
    onChange(POSTER_SIZE_PRESETS[index].value);
  }, [onChange]);

  return (
    <div className="poster-size-slider">
      <div className="poster-size-slider__icon poster-size-slider__icon--small">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <rect x="2" y="2" width="20" height="20" rx="2" />
        </svg>
      </div>
      <div className="poster-size-slider__track">
        <input
          type="range"
          min={0}
          max={POSTER_SIZE_PRESETS.length - 1}
          step={1}
          value={currentIndex}
          onChange={handleChange}
          className="poster-size-slider__input"
          aria-label="Poster size"
          title={`Poster size: ${POSTER_SIZE_PRESETS[currentIndex]?.label || 'Default'}`}
        />
        <div className="poster-size-slider__marks">
          {POSTER_SIZE_PRESETS.map((_, index) => (
            <div 
              key={index} 
              className={`poster-size-slider__mark ${index === currentIndex ? 'active' : ''}`}
            />
          ))}
        </div>
      </div>
      <div className="poster-size-slider__icon poster-size-slider__icon--large">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <rect x="2" y="2" width="20" height="20" rx="2" />
        </svg>
      </div>
    </div>
  );
});

// Footer component - defined OUTSIDE to prevent remounting on scroll
// Must be stable reference for Virtuoso
const GridFooter = ({ context }: { context?: { loading: boolean } }) => {
  if (!context?.loading) return null;
  return (
    <div className="vod-browse__loading">
      <div className="vod-browse__spinner" />
      <span>Loading more...</span>
    </div>
  );
};

// Custom Scroller - force scrollbar always visible to prevent width recalculation
// See: https://github.com/petyosi/react-virtuoso/issues/1086
const GridScroller = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  (props, ref) => (
    <div
      ref={ref}
      {...props}
      style={{ ...props.style, overflowY: 'scroll' }}
    />
  )
);

export interface VodBrowseProps {
  type: 'movies' | 'series';
  categoryId: string | null;  // null = all items
  categoryName: string;
  search?: string;
  onItemClick: (item: StoredMovie | StoredSeries) => void;
}

export function VodBrowse({
  type,
  categoryId,
  categoryName,
  search,
  onItemClick,
}: VodBrowseProps) {
  const virtuosoRef = useRef<VirtuosoGridHandle>(null);
  const [visibleRange, setVisibleRange] = useState({ startIndex: 0, endIndex: 0 });
  
  // Poster size preference
  const [posterSize, setPosterSize] = usePosterSizePreference();

  // Debounce search to avoid expensive filtering on every keystroke
  const debouncedSearch = useDebouncedValue(search, 300);

  // Scroll to top when category changes
  useEffect(() => {
    if (virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index: 0, align: 'start' });
    }
  }, [categoryId]);

  // LAZY LOAD: Trigger stalker sync if needed
  // completed = true when sync finishes (or cache is fresh) - triggers data refresh
  // hasCache = true if cached data exists - allows showing stale data while loading
  const { syncing: lazyLoading, progress, message, completed, hasCache } = useLazyStalkerLoader(
    type === 'movies' ? 'movies' : 'series',
    categoryId
  );

  // Get paginated data (using debounced search)
  // Pass 'completed' as refreshTrigger so data reloads when lazy loading finishes
  const moviesData = usePaginatedMovies(type === 'movies' ? categoryId : null, debouncedSearch, completed);
  const seriesData = usePaginatedSeries(type === 'series' ? categoryId : null, debouncedSearch, completed);

  const { items, loading: dataLoading, hasMore, loadMore } = type === 'movies' ? moviesData : seriesData;

  // Combine loading states
  const loading = dataLoading || lazyLoading;


  // Alphabet navigation
  const alphabetIndex = useAlphabetIndex(items);
  const currentLetter = useCurrentLetter(items, visibleRange.startIndex);

  // Available letters (ones that have content)
  const availableLetters = useMemo(() => {
    return new Set(alphabetIndex.keys());
  }, [alphabetIndex]);

  // Handle letter selection from rail
  const handleLetterSelect = useCallback((letter: string) => {
    const index = alphabetIndex.get(letter);
    if (index !== undefined && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({
        index,
        align: 'start',
        // Instant scroll for letter jumps - smooth would load everything in between
      });
    }
  }, [alphabetIndex]);

  // Handle range change for current letter tracking
  const handleRangeChange = useCallback((range: { startIndex: number; endIndex: number }) => {
    setVisibleRange(range);
  }, []);

  // Handle end reached for infinite scroll
  const handleEndReached = useCallback(() => {
    if (hasMore && !loading) {
      loadMore();
    }
  }, [hasMore, loading, loadMore]);

  // Stable key for each item - receives item from data prop
  const computeItemKey = useCallback(
    (index: number, item: StoredMovie | StoredSeries) => {
      if (!item) return index;
      return type === 'movies'
        ? `movie-${(item as StoredMovie).stream_id}`
        : `series-${(item as StoredSeries).series_id}`;
    },
    [type]
  );

  // Calculate dynamic card dimensions based on poster size
  const cardDimensions = useMemo(() => {
    const cardWidth = posterSize;
    const posterHeight = Math.round(cardWidth * 1.5); // 2:3 aspect ratio
    const infoHeight = posterSize >= 180 ? 36 : posterSize >= 140 ? 32 : 30;
    const cardHeight = posterHeight + infoHeight + 4; // +4 for padding
    const itemWidth = cardWidth + 4; // +4 for padding
    const itemHeight = cardHeight + 4;
    
    return {
      cardWidth,
      cardHeight,
      posterHeight,
      infoHeight,
      itemWidth,
      itemHeight,
    };
  }, [posterSize]);

  // Grid item renderer - receives item from data prop, no items dependency
  const ItemContent = useCallback(
    (_index: number, item: StoredMovie | StoredSeries) => {
      if (!item) return null;

      // Determine size label based on poster size
      let sizeLabel: 'small' | 'medium' | 'large' = 'medium';
      if (posterSize <= 120) sizeLabel = 'small';
      else if (posterSize >= 180) sizeLabel = 'large';

      return (
        <MediaCard
          item={item}
          type={type === 'movies' ? 'movie' : 'series'}
          onClick={onItemClick}
          size={sizeLabel}
        />
      );
    },
    [type, onItemClick, posterSize]
  );

  // Custom Loading Status Indicator for Stalker Sync
  // If we have cached data, show it immediately even while syncing
  if (lazyLoading && !hasCache) {
    return (
      <div className="vod-browse vod-browse--loading-state">
        <div className="vod-browse__spinner"></div>
        <h3>Loading...</h3>
        <p>{message}</p>
        {progress > 0 && (
          <div className="vod-browse__progress-bar">
            <div className="vod-browse__progress-fill" style={{ width: `${progress}%` }}></div>
          </div>
        )}
      </div>
    );
  }

  // Empty state (only show if no data AND not loading from cache)
  if (!loading && !lazyLoading && items.length === 0) {
    return (
      <div className="vod-browse vod-browse--empty">
        <div className="vod-browse__empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <h3>No {type} found</h3>
          <p>
            {search
              ? `No results for "${search}" in ${categoryName}`
              : `No ${type} available in ${categoryName}`}
          </p>
        </div>
      </div>
    );
  }

  // CSS custom properties for dynamic sizing
  const gridStyle = useMemo(() => ({
    '--vod-card-width': `${cardDimensions.cardWidth}px`,
    '--vod-card-height': `${cardDimensions.cardHeight}px`,
    '--vod-item-width': `${cardDimensions.itemWidth}px`,
    '--vod-item-height': `${cardDimensions.itemHeight}px`,
    '--vod-poster-height': `${cardDimensions.posterHeight}px`,
  } as React.CSSProperties), [cardDimensions]);

  return (
    <div className="vod-browse" style={gridStyle}>
      {/* Header with poster size slider */}
      <div className="vod-browse__toolbar">
        <div className="vod-browse__toolbar-left">
          <span className="vod-browse__category-name">{categoryName}</span>
          <span className="vod-browse__item-count">{items.length.toLocaleString()} items</span>
        </div>
        <PosterSizeSlider value={posterSize} onChange={setPosterSize} />
      </div>

      <VirtuosoGrid
        ref={virtuosoRef}
        className="vod-browse__grid"
        data={items}
        context={{ loading }}
        computeItemKey={computeItemKey}
        itemContent={ItemContent}
        rangeChanged={handleRangeChange}
        endReached={handleEndReached}
        overscan={150}
        listClassName="vod-browse__grid-list"
        itemClassName="vod-browse__grid-item"
        components={{
          Scroller: GridScroller,
          Footer: GridFooter,
        }}
      />

      {items.length > 0 && (
        <AlphabetRail
          currentLetter={currentLetter}
          availableLetters={availableLetters}
          onLetterSelect={handleLetterSelect}
          count={items.length}
        />
      )}
    </div>
  );
}

export default VodBrowse;
