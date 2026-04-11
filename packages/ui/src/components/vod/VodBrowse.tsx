/**
 * VodBrowse - Virtualized gallery grid with A-Z navigation
 *
 * Shows category-filtered content in a grid with infinite scroll
 * and alphabet quick-nav rail.
 */

import { useState, useCallback, useMemo, useRef, forwardRef, useEffect } from 'react';
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

// Debounce hook - delays value updates to avoid expensive operations on every keystroke
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

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

  // Grid item renderer - receives item from data prop, no items dependency
  const ItemContent = useCallback(
    (_index: number, item: StoredMovie | StoredSeries) => {
      if (!item) return null;

      return (
        <MediaCard
          item={item}
          type={type === 'movies' ? 'movie' : 'series'}
          onClick={onItemClick}
          size="medium"
        />
      );
    },
    [type, onItemClick]
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

  return (
    <div className="vod-browse">
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
