import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useVodPlaylistStore, type Playlist, type PlaylistItem } from '../../stores/vodPlaylistStore';
import { useEnabledSources, useSourceNameMap } from '../../hooks/useChannels';
import { usePlaylistItemsProgress, type PlaylistItemProgress } from '../../hooks/usePlaylistProgress';
import { findLastWatchedItem, isPlaylistItemHidden, sortPlaylistsByLastPlayed } from '../../utils/playlistPlayback';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useModal } from '../Modal';
import './PlaylistsView.css';

/** Format seconds as m:ss for resume hints. */
function formatSeconds(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Up to 4 unique poster URLs from a playlist, for the overview card collage. */
function getCardPosters(items: PlaylistItem[]): string[] {
  const seen = new Set<string>();
  const posters: string[] = [];
  for (const item of items) {
    const p = item.poster;
    if (p && !seen.has(p)) {
      seen.add(p);
      posters.push(p);
      if (posters.length >= 4) break;
    }
  }
  return posters;
}

/**
 * One playlist item row in the detail view — dnd-kit sortable with
 * full-surface drag; the arrows/play/remove controls stay click-only.
 */
function SortablePlaylistItem({
  item,
  index,
  playlist,
  showSourceName,
  progress,
  dropEdge,
  sourceNameMap,
  onPlay,
  onMove,
  onRemove,
}: {
  item: PlaylistItem;
  index: number;
  playlist: Playlist;
  showSourceName: boolean;
  /** Saved playback progress (resume hint / progress bar / completed state). */
  progress?: PlaylistItemProgress | null;
  dropEdge?: 'before' | 'after' | null;
  sourceNameMap: Map<string, string> | null;
  onPlay: (item: PlaylistItem, playlist: Playlist, shuffle?: boolean) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onRemove: (itemId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });

  const sortableStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 99 : 1,
    touchAction: 'none',
  };

  const sourceName = (showSourceName && (item.sourceName || sourceNameMap?.get(item.sourceId || ''))) || null;

  return (
    <div
      ref={setNodeRef}
      style={sortableStyle}
      className={`playlist-item-card ${isDragging ? 'dragging' : ''} ${dropEdge === 'before' ? 'drop-before' : ''} ${dropEdge === 'after' ? 'drop-after' : ''}`}
      {...attributes}
      {...listeners}
    >
      <div className="playlist-item-card__left">
        <div className="playlist-item-card__reorder" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="playlist-item-card__reorder-btn"
            disabled={index === 0}
            onClick={() => onMove(index, index - 1)}
            title={i18n.t('vod:moveUp')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button
            className="playlist-item-card__reorder-btn"
            disabled={index === playlist.items.length - 1}
            onClick={() => onMove(index, index + 1)}
            title={i18n.t('vod:moveDown')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>

        {item.poster ? (
          <img src={item.poster} alt="" className="playlist-item-card__poster" />
        ) : (
          <div className="playlist-item-card__poster" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.5)', fontWeight: 'bold' }}>
            {item.title.charAt(0)}
          </div>
        )}

        <div className="playlist-item-card__details">
          <span className="playlist-item-card__title">
            {item.title}
            {progress?.completed && (
              <span className="playlist-item-card__watched" title={i18n.t('vod:watched')}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {i18n.t('vod:watched')}
              </span>
            )}
          </span>
          <div className="playlist-item-card__sub">
            <span>{item.itemType === 'movie' ? i18n.t('vod:movie') : i18n.t('vod:series')}</span>
            {sourceName && <span className="playlist-item-card__sourcename">{sourceName}</span>}
          </div>
          {progress && progress.percent > 0 && !progress.completed && (
            <div className="playlist-item-card__progress" title={`${Math.round(progress.percent)}%`}>
              <div className="playlist-item-card__progress-fill" style={{ width: `${progress.percent}%` }} />
            </div>
          )}
        </div>
      </div>

      <div className="playlist-item-card__right">
        {progress && progress.progressSeconds > 10 && !progress.completed && (
          <button
            type="button"
            className="playlist-item-card__resume"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onPlay(item, playlist, false)}
            title={i18n.t('vod:resumeFrom', { time: formatSeconds(progress.progressSeconds) })}
          >
            {i18n.t('vod:resumeFrom', { time: formatSeconds(progress.progressSeconds) })}
          </button>
        )}
        <button
          className="playlist-item-card__play-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onPlay(item, playlist, false)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          {i18n.t('vod:play')}
        </button>
        <button
          className="playlist-item-card__remove-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onRemove(item.id)}
          title={i18n.t('vod:removeFromPlaylist')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * Static row for a playlist item whose source was removed or disabled — no
 * play/reorder controls, just a remove button. Rendered outside the sortable
 * list so it can't be dragged into the playable items.
 */
function HiddenPlaylistItemRow({ item, onRemove }: { item: PlaylistItem; onRemove: (itemId: string) => void }) {
  return (
    <div className="playlist-item-card playlist-item-card--hidden">
      <div className="playlist-item-card__left">
        {item.poster ? (
          <img src={item.poster} alt="" className="playlist-item-card__poster" />
        ) : (
          <div
            className="playlist-item-card__poster"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.4)', fontWeight: 'bold' }}
          >
            {item.title.charAt(0)}
          </div>
        )}
        <div className="playlist-item-card__details">
          <span className="playlist-item-card__title">
            {item.title}
            <span className="playlist-item-card__hidden-badge">{i18n.t('vod:hiddenUnavailable')}</span>
          </span>
          <div className="playlist-item-card__sub">
            <span>{item.itemType === 'movie' ? i18n.t('vod:movie') : i18n.t('vod:series')}</span>
            {item.sourceName && <span className="playlist-item-card__sourcename">{item.sourceName}</span>}
          </div>
        </div>
      </div>
      <div className="playlist-item-card__right">
        <button
          className="playlist-item-card__remove-btn"
          onClick={() => onRemove(item.id)}
          title={i18n.t('vod:removeFromPlaylist')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export interface PlaylistsViewProps {
  onPlayPlaylistItem?: (item: PlaylistItem, playlist: Playlist, isShuffle?: boolean) => void;
}

export function PlaylistsView({ onPlayPlaylistItem }: PlaylistsViewProps) {
  useTranslation();
  const sourceNameMap = useSourceNameMap();
  const enabledSources = useEnabledSources();
  const { showPrompt, showConfirm, ModalComponent } = useModal();
  const {
    playlists,
    createPlaylist,
    deletePlaylist,
    renamePlaylist,
    removeItemFromPlaylist,
    removeItemsFromPlaylist,
    reorderPlaylistItems,
    randomizePlaylistItems,
    undoRandomizePlaylistItems,
    randomizeHistory,
    toggleRemoveAfterWatching,
    toggleAutoplayNext,
    toggleShowSourceName,
  } = useVodPlaylistStore();

  const [showHiddenItems, setShowHiddenItems] = useState(false);

  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editingNameValue, setEditingNameValue] = useState('');

  const selectedPlaylist = playlists.find((p) => p.id === selectedPlaylistId);
  // How many shuffles can be undone for the currently open playlist
  const undoDepth = selectedPlaylist ? (randomizeHistory[selectedPlaylist.id]?.length || 0) : 0;

  // Items whose source was removed or disabled can't be played; they're hidden
  // from the list (with a banner + bulk-remove) until the source returns.
  const hiddenItems = React.useMemo(() => {
    if (!selectedPlaylist) return [];
    return selectedPlaylist.items.filter((i) => isPlaylistItemHidden(i, enabledSources));
  }, [selectedPlaylist, enabledSources]);

  const visibleItems = React.useMemo(() => {
    if (!selectedPlaylist) return [];
    if (hiddenItems.length === 0) return selectedPlaylist.items;
    const hiddenIds = new Set(hiddenItems.map((i) => i.id));
    return selectedPlaylist.items.filter((i) => !hiddenIds.has(i.id));
  }, [selectedPlaylist, hiddenItems]);

  // The view's scroll container. Focused on mount / playlist change so arrow and
  // Page keys scroll it (same pattern as SeriesDetail / the nuvio homepage).
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, [selectedPlaylistId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Scroll only when the view container itself has focus — inner controls
    // (dnd-kit reorder rows, buttons, the rename input) handle their own keys.
    if (e.target !== containerRef.current) return;
    if (e.key === 'ArrowDown' || e.key === 'PageDown') {
      e.preventDefault();
      containerRef.current?.scrollBy({ top: e.key === 'PageDown' ? 500 : 200, behavior: 'smooth' });
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault();
      containerRef.current?.scrollBy({ top: e.key === 'PageUp' ? -500 : -200, behavior: 'smooth' });
    }
  }, []);

  // Saved playback progress for every playlist's items — one shared map keyed
  // by item id (batched: 2 queries regardless of playlist size), used by both
  // the overview cards' watched counts and the open playlist's rows.
  const allPlaylistItems = React.useMemo(() => {
    const seen = new Set<string>();
    const items: PlaylistItem[] = [];
    for (const pl of playlists) {
      for (const item of pl.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          items.push(item);
        }
      }
    }
    return items;
  }, [playlists]);

  const itemProgress = usePlaylistItemsProgress(allPlaylistItems);

  // Overview grid order: most recently played playlists float to the front
  // (never-played ones keep their original relative order at the bottom).
  const sortedPlaylists = React.useMemo(
    () => sortPlaylistsByLastPlayed(playlists, itemProgress),
    [playlists, itemProgress]
  );

  // dnd-kit drag-to-reorder state for the playlist detail items.
  const reorderSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [overDragId, setOverDragId] = useState<string | null>(null);

  const handleReorderStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
    setOverDragId(String(event.active.id));
  };
  const handleReorderOver = (event: DragOverEvent) => {
    setOverDragId(event.over ? String(event.over.id) : null);
  };
  const handleReorderCancel = (event: DragCancelEvent) => {
    setActiveDragId(null);
    setOverDragId(null);
  };
  const handleReorderEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    setOverDragId(null);
    if (!selectedPlaylist) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = selectedPlaylist.items.findIndex((i) => i.id === active.id);
    const newIndex = selectedPlaylist.items.findIndex((i) => i.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    reorderPlaylistItems(selectedPlaylist.id, oldIndex, newIndex);
  };

  const activeIndex = activeDragId && selectedPlaylist ? selectedPlaylist.items.findIndex((i) => i.id === activeDragId) : -1;
  const overIndex = overDragId && selectedPlaylist ? selectedPlaylist.items.findIndex((i) => i.id === overDragId) : -1;
  const dropEdgeFor = (id: string): 'before' | 'after' | null => {
    if (!activeDragId || !overDragId || activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) return null;
    if (id !== overDragId) return null;
    return activeIndex < overIndex ? 'after' : 'before';
  };

  const handleCreateNew = () => {
    const defaultTitle = `${i18n.t('vod:playlists')} ${playlists.length + 1}`;
    showPrompt(
      i18n.t('vod:createNewPlaylist'),
      i18n.t('vod:playlistNamePlaceholder'),
      (name) => {
        if (name && name.trim()) {
          const newPl = createPlaylist(name.trim());
          setSelectedPlaylistId(newPl.id);
        }
      },
      undefined,
      i18n.t('vod:playlistNamePlaceholder'),
      defaultTitle,
      i18n.t('common:create'),
      i18n.t('common:cancel')
    );
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    showConfirm(
      i18n.t('vod:deletePlaylist'),
      i18n.t('vod:deletePlaylistConfirm'),
      () => {
        deletePlaylist(id);
        if (selectedPlaylistId === id) {
          setSelectedPlaylistId(null);
        }
      }
    );
  };

  const handleStartRename = (playlist: Playlist, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingNameId(playlist.id);
    setEditingNameValue(playlist.name);
  };

  const handleSaveRename = (id: string) => {
    if (editingNameValue.trim()) {
      renamePlaylist(id, editingNameValue.trim());
    }
    setEditingNameId(null);
  };

  const handlePlaySequential = (playlist: Playlist) => {
    // Only start from visible (playable) items — hidden ones have no source.
    const playable = playlist.items.filter((i) => !isPlaylistItemHidden(i, enabledSources));
    if (!playable.length) return;
    const startItem = playable[0];
    onPlayPlaylistItem?.(startItem, playlist, false);
  };

  const handlePlayRandom = (playlist: Playlist) => {
    const playable = playlist.items.filter((i) => !isPlaylistItemHidden(i, enabledSources));
    if (!playable.length) return;
    const randomIndex = Math.floor(Math.random() * playable.length);
    const startItem = playable[randomIndex];
    onPlayPlaylistItem?.(startItem, playlist, true);
  };

  const handleRemoveAllHidden = () => {
    if (!selectedPlaylist || hiddenItems.length === 0) return;
    showConfirm(
      i18n.t('vod:removeAllHidden'),
      i18n.t('vod:removeAllHiddenConfirm', { count: hiddenItems.length }),
      () => removeItemsFromPlaylist(selectedPlaylist.id, hiddenItems.map((i) => i.id))
    );
  };

  return (
    <div
      className="playlists-view"
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{ outline: 'none' }}
    >
      {/* View Header */}
      <div className="playlists-view__header">
        <div className="playlists-view__title-area">
          {selectedPlaylist && (
            <button
              className="playlists-view__back-btn"
              onClick={() => setSelectedPlaylistId(null)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
              {i18n.t('vod:back')}
            </button>
          )}
          <h1 className="playlists-view__title">
            {selectedPlaylist ? selectedPlaylist.name : i18n.t('vod:playlists')}
          </h1>
        </div>

        {!selectedPlaylist && (
          <button className="playlists-view__create-btn" onClick={handleCreateNew}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {i18n.t('vod:createPlaylist')}
          </button>
        )}
      </div>

      {/* Overview Grid mode */}
      {!selectedPlaylist ? (
        playlists.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'rgba(255,255,255,0.6)' }}>
            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto 16px', display: 'block', opacity: 0.5 }}>
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            <h3 style={{ margin: '0 0 8px 0', fontSize: '1.2rem', color: '#fff' }}>
              {i18n.t('vod:noPlaylistsFound')}
            </h3>
            <p style={{ margin: 0, fontSize: '0.95rem' }}>{i18n.t('vod:createFirstPlaylist')}</p>
          </div>
        ) : (
          <div className="playlists-grid">
            {sortedPlaylists.map((pl) => {
              const posters = getCardPosters(pl.items);
              const watchedCount = pl.items.filter((i) => itemProgress.get(i.id)?.completed).length;
              const lastWatched = findLastWatchedItem(pl.items, itemProgress);
              const lastWatchedProgress = lastWatched ? itemProgress.get(lastWatched.id) : null;
              const canResume =
                !!lastWatchedProgress && lastWatchedProgress.progressSeconds > 10 && !lastWatchedProgress.completed;
              const resumeTime = canResume && lastWatchedProgress ? formatSeconds(lastWatchedProgress.progressSeconds) : null;
              return (
                <div key={pl.id} className="playlist-card" onClick={() => setSelectedPlaylistId(pl.id)}>
                  <div className="playlist-card__posters">
                    {pl.items.length > 0 && (
                      <span
                        className={`playlist-card__watched-badge${watchedCount === 0 ? ' playlist-card__watched-badge--empty' : ''}`}
                        title={i18n.t('vod:watchedCount', { count: watchedCount, total: pl.items.length })}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        {watchedCount}/{pl.items.length}
                      </span>
                    )}
                    {posters.length === 0 ? (
                      <div className="playlist-card__poster-placeholder">
                        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <line x1="8" y1="6" x2="21" y2="6" />
                          <line x1="8" y1="12" x2="21" y2="12" />
                          <line x1="8" y1="18" x2="21" y2="18" />
                          <line x1="3" y1="6" x2="3.01" y2="6" />
                          <line x1="3" y1="12" x2="3.01" y2="12" />
                          <line x1="3" y1="18" x2="3.01" y2="18" />
                        </svg>
                      </div>
                    ) : posters.length === 1 ? (
                      <img className="playlist-card__poster-single" src={posters[0]} alt="" />
                    ) : (
                      <div className="playlist-card__poster-grid">
                        {posters.map((p, i) => (
                          <img key={i} className="playlist-card__poster-tile" src={p} alt="" />
                        ))}
                        {Array.from({ length: Math.max(0, 4 - posters.length) }).map((_, i) => (
                          <div key={`ph-${i}`} className="playlist-card__poster-tile playlist-card__poster-tile--empty" />
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="playlist-card__info">
                    {editingNameId === pl.id ? (
                      <input
                        type="text"
                        value={editingNameValue}
                        onChange={(e) => setEditingNameValue(e.target.value)}
                        onBlur={() => handleSaveRename(pl.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveRename(pl.id);
                        }}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid #3b82f6', color: '#fff', padding: '4px 8px', borderRadius: '4px', width: '100%', boxSizing: 'border-box' }}
                      />
                    ) : (
                      <h3 className="playlist-card__name">{pl.name}</h3>
                    )}
                    <span className="playlist-card__count">
                      {i18n.t('vod:itemCount', { count: pl.items.length })}
                    </span>
                  </div>

                  {lastWatched && (
                    <div className="playlist-card__resume" onClick={(e) => e.stopPropagation()}>
                      {canResume && resumeTime && (
                        <button
                          type="button"
                          className="playlist-card__resume-btn"
                          onClick={() => onPlayPlaylistItem?.(lastWatched, pl, false)}
                          title={i18n.t('vod:resumeFrom', { time: resumeTime })}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                            <polygon points="5 3 19 12 5 21 5 3" />
                          </svg>
                          {i18n.t('vod:resumeFrom', { time: resumeTime })}
                        </button>
                      )}
                      <span
                        className="playlist-card__last-watched"
                        title={`${i18n.t('vod:lastWatched')}: ${lastWatched.title}`}
                      >
                        {i18n.t('vod:lastWatched')}: {lastWatched.title}
                      </span>
                    </div>
                  )}

                  <div className="playlist-card__actions">
                    <button
                      className="playlist-card__action-btn"
                      onClick={(e) => handleStartRename(pl, e)}
                      title={i18n.t('vod:renamePlaylist')}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                      </svg>
                    </button>
                    <button
                      className="playlist-card__action-btn playlist-card__action-btn--delete"
                      onClick={(e) => handleDelete(pl.id, e)}
                      title={i18n.t('vod:deletePlaylist')}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        /* Playlist Detail View */
        <div className="playlist-detail">
          <div className="playlist-detail__header-banner">
            <div className="playlist-detail__title-row">
              <div>
                <h2 className="playlist-detail__title">{selectedPlaylist.name}</h2>
                <div className="playlist-detail__meta">
                  {i18n.t('vod:itemCount', { count: selectedPlaylist.items.length })}
                </div>
              </div>
            </div>

            {/* Controls Toolbar */}
            <div className="playlist-detail__toolbar">
              <button
                className="playlist-btn playlist-btn--primary"
                disabled={selectedPlaylist.items.length === 0}
                onClick={() => handlePlaySequential(selectedPlaylist)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                {i18n.t('vod:playSequential')}
              </button>

              <button
                className="playlist-btn playlist-btn--secondary"
                disabled={selectedPlaylist.items.length === 0}
                onClick={() => handlePlayRandom(selectedPlaylist)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="16 3 21 3 21 8" />
                  <line x1="4" y1="20" x2="21" y2="3" />
                  <polyline points="21 16 21 21 16 21" />
                  <line x1="15" y1="15" x2="21" y2="21" />
                  <line x1="4" y1="4" x2="9" y2="9" />
                </svg>
                {i18n.t('vod:playRandom')}
              </button>

              <button
                className="playlist-btn playlist-btn--secondary"
                disabled={selectedPlaylist.items.length === 0}
                onClick={() => randomizePlaylistItems(selectedPlaylist.id)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                </svg>
                {i18n.t('vod:randomizePlaylist')}
              </button>

              {undoDepth > 0 && (
                <button
                  className="playlist-btn playlist-btn--secondary"
                  onClick={() => undoRandomizePlaylistItems(selectedPlaylist.id)}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="1 4 1 10 7 10" />
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                  </svg>
                  {i18n.t('vod:undoRandomize')} ({undoDepth})
                </button>
              )}
            </div>

            {/* Options Toggles */}
            <div className="playlist-toggles-row">
              <label className="playlist-toggle-label">
                <input
                  type="checkbox"
                  className="playlist-toggle-input"
                  checked={selectedPlaylist.removeAfterWatching ?? false}
                  onChange={() => toggleRemoveAfterWatching(selectedPlaylist.id)}
                />
                {i18n.t('vod:removeAfterWatching')}
              </label>

              <label className="playlist-toggle-label">
                <input
                  type="checkbox"
                  className="playlist-toggle-input"
                  checked={selectedPlaylist.autoplayNext ?? true}
                  onChange={() => toggleAutoplayNext(selectedPlaylist.id)}
                />
                {i18n.t('vod:autoplayNext')}
              </label>

              <label className="playlist-toggle-label">
                <input
                  type="checkbox"
                  className="playlist-toggle-input"
                  checked={selectedPlaylist.showSourceName ?? true}
                  onChange={() => toggleShowSourceName(selectedPlaylist.id)}
                />
                {i18n.t('vod:showSourceName')}
              </label>
            </div>
          </div>

          {/* Items List — dnd-kit drag to reorder, arrows kept for fine moves.
              Hidden (source removed/disabled) items are excluded from the sortable
              list and shown below the banner instead. */}
          <div className="playlist-items-list">
            {selectedPlaylist.items.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'rgba(255,255,255,0.5)' }}>
                {i18n.t('vod:noContent')}
              </div>
            ) : (
              <>
                {visibleItems.length > 0 ? (
                  <DndContext
                    sensors={reorderSensors}
                    collisionDetection={closestCenter}
                    onDragStart={handleReorderStart}
                    onDragOver={handleReorderOver}
                    onDragCancel={handleReorderCancel}
                    onDragEnd={handleReorderEnd}
                  >
                    <SortableContext
                      items={visibleItems.map((i) => i.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {visibleItems.map((item) => {
                        // Real index within the playlist so reorder arrows and
                        // dnd moves stay consistent even with hidden items in between.
                        const realIdx = selectedPlaylist.items.findIndex((i) => i.id === item.id);
                        return (
                          <SortablePlaylistItem
                            key={item.id}
                            item={item}
                            index={realIdx}
                            playlist={selectedPlaylist}
                            showSourceName={selectedPlaylist.showSourceName ?? true}
                            progress={itemProgress.get(item.id) ?? null}
                            dropEdge={dropEdgeFor(item.id)}
                            sourceNameMap={sourceNameMap}
                            onPlay={(it, pl) => onPlayPlaylistItem?.(it, pl, false)}
                            onMove={(fromIndex, toIndex) => reorderPlaylistItems(selectedPlaylist.id, fromIndex, toIndex)}
                            onRemove={(itemId) => removeItemFromPlaylist(selectedPlaylist.id, itemId)}
                          />
                        );
                      })}
                    </SortableContext>
                  </DndContext>
                ) : (
                  <div className="playlist-hidden-empty">{i18n.t('vod:allItemsHidden')}</div>
                )}

                {hiddenItems.length > 0 && (
                  <div className="playlist-hidden-section">
                    <div className="playlist-hidden-banner">
                      <span className="playlist-hidden-banner__text">
                        {i18n.t('vod:playlistHiddenCount', { count: hiddenItems.length })}
                      </span>
                      <button
                        className="playlist-hidden-banner__btn"
                        onClick={() => setShowHiddenItems((v) => !v)}
                      >
                        {showHiddenItems ? i18n.t('vod:hideHiddenItems') : i18n.t('vod:showHiddenItems')}
                      </button>
                      <button
                        className="playlist-hidden-banner__btn playlist-hidden-banner__btn--danger"
                        onClick={handleRemoveAllHidden}
                      >
                        {i18n.t('vod:removeAllHidden')}
                      </button>
                    </div>

                    {showHiddenItems &&
                      hiddenItems.map((item) => (
                        <HiddenPlaylistItemRow
                          key={item.id}
                          item={item}
                          onRemove={(itemId) => removeItemFromPlaylist(selectedPlaylist.id, itemId)}
                        />
                      ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <ModalComponent />
    </div>
  );
}
