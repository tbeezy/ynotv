/**
 * VodBrowse - Virtualized gallery grid with A-Z navigation
 *
 * Shows category-filtered content in a grid with infinite scroll
 * and alphabet quick-nav rail.
 */

import { useState, useCallback, useMemo, useRef, forwardRef, useEffect } from 'react';
import { VirtuosoGrid, VirtuosoGridHandle } from 'react-virtuoso';
import { PosterSizeSlider, type PosterSizePreset } from '../PosterSizeSlider';
import { MediaCard } from './MediaCard';
import { AlphabetRail } from './AlphabetRail';
import type { StoredMovie, StoredSeries } from '../../db';
import {
  usePaginatedMovies,
  usePaginatedSeries,
  useAlphabetIndex,
  useCurrentLetter,
  useLazyStalkerLoader,
  useVodLastWatchedMap,
} from '../../hooks/useVod';
import { useVodFavoritesStore } from '../../stores/vodFavoritesStore';
import { useSourceNameMap } from '../../hooks/useChannels';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import {
  DEFAULT_SORT_DIRECTION,
  sortVodItems,
  type SortDirection,
  type VodSortKey,
} from './vodSort';
import './VodBrowse.css';

// Poster size presets (card width in pixels) — VodBrowse's historical list,
// passed to the shared PosterSizeSlider so saved/default sizes keep working
// unchanged (default 160px).
const VOD_POSTER_SIZE_PRESETS = [
  { value: 100, label: 'XS' },
  { value: 120, label: 'S' },
  { value: 140, label: 'M' },
  { value: 160, label: 'L' },
  { value: 180, label: 'XL' },
  { value: 200, label: '2XL' },
  { value: 240, label: '3XL' },
] as const satisfies readonly PosterSizePreset[];

type VodPosterSizeValue = (typeof VOD_POSTER_SIZE_PRESETS)[number]['value'];

// Sort options available in the browse view (in dropdown order)
const VOD_BROWSE_SORT_KEYS: VodSortKey[] = ['added', 'name', 'year', 'rating', 'lastWatched'];

// Hook to persist poster size preference
function usePosterSizePreference(): [VodPosterSizeValue, (value: VodPosterSizeValue) => void] {
  const [size, setSize] = useState<VodPosterSizeValue>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('vodPosterSize');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (VOD_POSTER_SIZE_PRESETS.some(p => p.value === parsed)) {
          return parsed as VodPosterSizeValue;
        }
      }
    }
    return 160; // Default size
  });

  const setSizeAndSave = useCallback((newSize: VodPosterSizeValue) => {
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

// Footer component - defined OUTSIDE to prevent remounting on scroll
// Must be stable reference for Virtuoso
const GridFooter = ({ context }: { context?: { loading: boolean } }) => {
  if (!context?.loading) return null;
  return (
    <div className="vod-browse__loading">
      <div className="vod-browse__spinner" />
      <span>{i18n.t('vod:loadingMore')}</span>
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
  useTranslation();
  const virtuosoRef = useRef<VirtuosoGridHandle>(null);
  const [visibleRange, setVisibleRange] = useState({ startIndex: 0, endIndex: 0 });
  
  // Poster size preference
  const [posterSize, setPosterSize] = usePosterSizePreference();

  // Sort preference (persisted)
  const [sortBy, setSortBy] = useState<VodSortKey>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('vodSortBy');
      if (saved && (VOD_BROWSE_SORT_KEYS as string[]).includes(saved)) {
        return saved as VodSortKey;
      }
    }
    return 'name';
  });

  const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
    if (typeof window !== 'undefined') {
      const savedDir = localStorage.getItem('vodSortDir');
      if (savedDir === 'asc' || savedDir === 'desc') {
        return savedDir;
      }
      const savedBy = localStorage.getItem('vodSortBy');
      if (savedBy && (VOD_BROWSE_SORT_KEYS as string[]).includes(savedBy)) {
        return DEFAULT_SORT_DIRECTION[savedBy as VodSortKey];
      }
    }
    return DEFAULT_SORT_DIRECTION.name;
  });

  const setSortAndSave = useCallback((val: VodSortKey) => {
    setSortBy(val);
    setSortDirection(DEFAULT_SORT_DIRECTION[val]);
    if (typeof window !== 'undefined') {
      localStorage.setItem('vodSortBy', val);
      localStorage.setItem('vodSortDir', DEFAULT_SORT_DIRECTION[val]);
    }
  }, []);

  const toggleSortDirection = useCallback(() => {
    setSortDirection((prev) => {
      const next = prev === 'asc' ? 'desc' : 'asc';
      if (typeof window !== 'undefined') {
        localStorage.setItem('vodSortDir', next);
      }
      return next;
    });
  }, []);

  // Handle selecting the same sort key again: toggle direction instead
  const handleSortSelect = useCallback((val: VodSortKey) => {
    if (val === sortBy) {
      toggleSortDirection();
      return;
    }
    setSortAndSave(val);
  }, [sortBy, setSortAndSave, toggleSortDirection]);

  const includeSourceInVodSearch = useSettingsStore((s) => s.includeSourceInVodSearch);
  const vodShowSourceBadge = useSettingsStore((s) => s.vodShowSourceBadge);
  const sourceNameMap = useSourceNameMap();

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
  // The hooks only understand 'name'/'added' SQL ordering; year/rating/lastWatched
  // are applied on top via sortedItems below.
  const hookSort = sortBy === 'added' ? 'added' : 'name';
  const moviesData = usePaginatedMovies(type === 'movies' ? categoryId : null, debouncedSearch, hookSort, completed);
  const seriesData = usePaginatedSeries(type === 'series' ? categoryId : null, debouncedSearch, hookSort, completed);

  const { items, loading: dataLoading, hasMore, loadMore } = type === 'movies' ? moviesData : seriesData;

  // Combine loading states
  const loading = dataLoading || lazyLoading;

  // Last watched timestamps from vod_history (media_id -> watched_at)
  const lastWatchedMap = useVodLastWatchedMap(type === 'movies' ? 'movie' : 'series');

  // Sorted items based on the active sort preference + direction
  const sortedItems = useMemo(
    () => sortVodItems(items, type === 'movies' ? 'movie' : 'series', sortBy, sortDirection, { lastWatchedMap }),
    [items, type, sortBy, sortDirection, lastWatchedMap]
  );

  // Favorites - single store subscription, compute Set of IDs for current type
  const allFavorites = useVodFavoritesStore((s) => s.favorites);
  const favoritedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const f of allFavorites) {
      if ((type === 'movies' && f.type === 'movie') || (type === 'series' && f.type === 'series')) {
        ids.add(f.id);
      }
    }
    return ids;
  }, [allFavorites, type]);
  const addFavorite = useVodFavoritesStore((s) => s.addFavorite);
  const removeFavorite = useVodFavoritesStore((s) => s.removeFavorite);


  // Alphabet navigation (only meaningful when sorted A-Z)
  const alphabetIndex = useAlphabetIndex(sortedItems);
  const currentLetter = useCurrentLetter(sortedItems, visibleRange.startIndex);

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

      const itemId = type === 'movies'
        ? (item as StoredMovie).stream_id
        : (item as StoredSeries).series_id;
      const isFav = favoritedIds.has(itemId);

      // Determine size label based on poster size
      let sizeLabel: 'small' | 'medium' | 'large' = 'medium';
      if (posterSize <= 120) sizeLabel = 'small';
      else if (posterSize >= 180) sizeLabel = 'large';

      // Pass card width as CSS variable for marquee animation
      const cardStyle = {
        '--marquee-visible-width': `${cardDimensions.cardWidth}px`,
      } as React.CSSProperties;

      const showBadge = vodShowSourceBadge || (includeSourceInVodSearch && search && search.trim());
      const sourceName = (showBadge && sourceNameMap)
        ? sourceNameMap.get(item.source_id)
        : undefined;

      return (
        <MediaCard
          item={item}
          type={type === 'movies' ? 'movie' : 'series'}
          onClick={onItemClick}
          size={sizeLabel}
          style={cardStyle}
          isFavorited={isFav}
          sourceName={sourceName}
          onToggleFavorite={(clickedItem) => {
            const clickedId = type === 'movies'
              ? (clickedItem as StoredMovie).stream_id
              : (clickedItem as StoredSeries).series_id;
            if (favoritedIds.has(clickedId)) {
              removeFavorite(clickedId, type === 'movies' ? 'movie' : 'series');
            } else {
              addFavorite({
                id: clickedId,
                type: type === 'movies' ? 'movie' : 'series',
                title: clickedItem.title || clickedItem.name,
                poster: type === 'movies'
                  ? (clickedItem as StoredMovie).stream_icon
                  : (clickedItem as StoredSeries).cover,
                year: clickedItem.year || clickedItem.release_date?.slice(0, 4),
              });
            }
          }}
        />
      );
    },
    [type, onItemClick, posterSize, cardDimensions, favoritedIds, addFavorite, removeFavorite, includeSourceInVodSearch, vodShowSourceBadge, search, sourceNameMap]
  );

  // CSS custom properties for dynamic sizing - MUST be before any early returns
  const gridStyle = useMemo(() => ({
    '--vod-card-width': `${cardDimensions.cardWidth}px`,
    '--vod-card-height': `${cardDimensions.cardHeight}px`,
    '--vod-item-width': `${cardDimensions.itemWidth}px`,
    '--vod-item-height': `${cardDimensions.itemHeight}px`,
    '--vod-poster-height': `${cardDimensions.posterHeight}px`,
  } as React.CSSProperties), [cardDimensions]);

  // Custom Loading Status Indicator for Stalker Sync
  // If we have cached data, show it immediately even while syncing
  if (lazyLoading && !hasCache) {
    return (
      <div className="vod-browse vod-browse--loading-state">
        <div className="vod-browse__spinner"></div>
        <h3>{i18n.t('vod:loading')}</h3>
        {/* Only show a detail line when the sync reports real progress — the
            heading already says "Loading...", so a duplicate message (or the
            old hardcoded 'Loading...' status) made it appear twice. */}
        {message && <p>{message}</p>}
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
          <h3>{i18n.t('vod:noItemsFound', { type: type === 'movies' ? i18n.t('vod:movies') : i18n.t('vod:series') })}</h3>
          <p>
            {search
              ? i18n.t('vod:noResultsInCategory', { search, category: categoryName })
              : i18n.t('vod:noItemsInCategory', { type: type === 'movies' ? i18n.t('vod:movies') : i18n.t('vod:series'), category: categoryName })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="vod-browse" style={gridStyle}>
      {/* Header with poster size slider and sort */}
      <div className="vod-browse__toolbar">
        <div className="vod-browse__toolbar-left">
          <span className="vod-browse__category-name">{categoryName}</span>
          <span className="vod-browse__item-count">{i18n.t('vod:itemCount', { count: sortedItems.length })}</span>
        </div>
        <div className="vod-browse__toolbar-right">
          <div className="vod-browse__sort-container">
            <span className="vod-browse__sort-label">{i18n.t('vod:sort')}</span>
            <select
              className="vod-browse__sort-select"
              value={sortBy}
              onChange={(e) => handleSortSelect(e.target.value as VodSortKey)}
              aria-label={i18n.t('vod:sort')}
            >
              <option value="added">{i18n.t('vod:sortAdded')}</option>
              <option value="name">{i18n.t('vod:sortName')}</option>
              <option value="year">{i18n.t('vod:sortYear')}</option>
              <option value="rating">{i18n.t('vod:sortRating')}</option>
              <option value="lastWatched">{i18n.t('vod:sortLastWatched')}</option>
            </select>
            <button
              className={`vod-sort-dir-btn ${sortDirection === 'desc' ? 'active' : ''}`}
              onClick={toggleSortDirection}
              title={sortDirection === 'asc' ? i18n.t('vod:sortAscending') : i18n.t('vod:sortDescending')}
              aria-label={sortDirection === 'asc' ? i18n.t('vod:sortAscending') : i18n.t('vod:sortDescending')}
              type="button"
            >
              {sortDirection === 'asc' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M12 19V5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                  <path d="M12 5v14" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M19 12l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
          <PosterSizeSlider value={posterSize} presets={VOD_POSTER_SIZE_PRESETS} onChange={(v) => setPosterSize(v as VodPosterSizeValue)} />
        </div>
      </div>

      <VirtuosoGrid
        ref={virtuosoRef}
        className="vod-browse__grid"
        data={sortedItems}
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

      {/* Alphabet rail only makes sense in A-Z order */}
      {sortedItems.length > 0 && sortBy === 'name' && (
        <AlphabetRail
          currentLetter={currentLetter}
          availableLetters={availableLetters}
          onLetterSelect={handleLetterSelect}
          count={sortedItems.length}
        />
      )}
    </div>
  );
}

export default VodBrowse;
