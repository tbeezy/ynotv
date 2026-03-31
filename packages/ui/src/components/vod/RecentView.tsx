/**
 * RecentView - Grid view of recently watched movies/series
 *
 * Shows recently watched items with progress bars and episode info
 */

import { useState, useCallback, useMemo, useRef, forwardRef } from 'react';
import { VirtuosoGrid, VirtuosoGridHandle } from 'react-virtuoso';
import { MediaCard } from './MediaCard';
import type { StoredMovie, StoredSeries } from '../../db';
import type { RecentlyWatchedItem } from '../../hooks/useVod';
import './VodBrowse.css'; // Reuse VodBrowse styles for consistent grid

// Custom Scroller - force scrollbar always visible
const GridScroller = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  (props, ref) => (
    <div
      ref={ref}
      {...props}
      style={{ ...props.style, overflowY: 'scroll' }}
    />
  )
);

export interface RecentViewProps {
  type: 'movie' | 'series';
  items: RecentlyWatchedItem<StoredMovie | StoredSeries>[];
  loading: boolean;
  onItemClick: (item: StoredMovie | StoredSeries, seasonNum?: number, episodeNum?: number, episodeTitle?: string) => void;
  onRemove?: (item: StoredMovie | StoredSeries) => void;
}

export function RecentView({
  type,
  items,
  loading,
  onItemClick,
  onRemove,
}: RecentViewProps) {
  const virtuosoRef = useRef<VirtuosoGridHandle>(null);
  const [visibleRange, setVisibleRange] = useState({ startIndex: 0, endIndex: 0 });

  // Debug logging
  console.log('[RecentView] Props:', { type, itemsCount: items.length, loading, items });

  // Extract raw items for the grid
  const rawItems = useMemo(() => {
    console.log('[RecentView] Extracting raw items from:', items);
    return items.map(i => i.item);
  }, [items]);

  // Create maps for quick lookup
  const progressMap = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach(item => {
      const id = type === 'movie' 
        ? (item.item as StoredMovie).stream_id 
        : (item.item as StoredSeries).series_id;
      map.set(id, item.progress_percent);
    });
    return map;
  }, [items, type]);

  const episodeDataMap = useMemo(() => {
    if (type !== 'series') return undefined;
    const map = new Map<string, { seasonNum?: number; episodeNum?: number; episodeTitle?: string }>();
    items.forEach(item => {
      const seriesItem = item as RecentlyWatchedItem<StoredSeries>;
      const id = seriesItem.item.series_id;
      map.set(id, {
        seasonNum: seriesItem.season_num,
        episodeNum: seriesItem.episode_num,
        episodeTitle: seriesItem.episode_title,
      });
    });
    return map;
  }, [items, type]);

  // Grid item renderer
  const itemContent = useCallback((index: number) => {
    console.log('[RecentView] Rendering item at index:', index, 'rawItems length:', rawItems.length);
    const item = rawItems[index];
    if (!item) {
      console.log('[RecentView] No item at index:', index);
      return null;
    }

    const itemId = type === 'movie' 
      ? (item as StoredMovie).stream_id 
      : (item as StoredSeries).series_id;
    
    const progress = progressMap.get(itemId);
    const episodeData = episodeDataMap?.get(itemId);

    return (
      <MediaCard
        item={item}
        type={type}
        onClick={(clickedItem) => {
          onItemClick(
            clickedItem,
            episodeData?.seasonNum,
            episodeData?.episodeNum,
            episodeData?.episodeTitle
          );
        }}
        onRemove={onRemove ? () => onRemove(item) : undefined}
        progressPercent={progress}
        isRecentlyWatched={true}
        seasonNum={episodeData?.seasonNum}
        episodeNum={episodeData?.episodeNum}
        episodeTitle={episodeData?.episodeTitle}
      />
    );
  }, [rawItems, type, progressMap, episodeDataMap, onItemClick, onRemove]);

  console.log('[RecentView] Render check:', { loading, itemsLength: items.length, rawItemsLength: rawItems.length });

  if (loading) {
    return (
      <div className="vod-browse">
        <div className="vod-browse__loading-container">
          <div className="vod-browse__spinner" />
          <span>Loading recent items...</span>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="vod-browse">
        <div className="vod-browse__empty">
          <h2>No Recent Items</h2>
          <p>You haven't watched anything yet. Start watching movies or series to see them here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="vod-browse">
      <VirtuosoGrid
        ref={virtuosoRef}
        className="vod-browse__grid"
        data={rawItems}
        totalCount={rawItems.length}
        itemContent={itemContent}
        components={{
          Scroller: GridScroller,
        }}
        listClassName="vod-browse__grid-list"
        itemClassName="vod-browse__grid-item"
        rangeChanged={setVisibleRange}
      />
    </div>
  );
}

export default RecentView;
