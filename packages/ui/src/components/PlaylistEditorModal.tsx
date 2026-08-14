import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { createPortal } from 'react-dom';
import { useLiveQuery } from '../hooks/useSqliteLiveQuery';
import { db, type PlaylistCategoryLink, type PlaylistIndividualChannel, type StoredChannel, type StoredCategory, type CategoryFolder } from '../db';
import { buildSearchQueryClauses } from '../utils/searchNormalization';
import {
  addCategoryToPlaylist,
  removeCategoryFromPlaylist,
  renameCategoryLink,
  addIndividualChannelToPlaylist,
  removeIndividualChannelFromPlaylist,
  reorderPlaylistIndividualChannels,
  renamePlaylist,
  addMultipleIndividualChannelsToPlaylist,
  addChannelToCategory,
  removeChannelFromCategory,
  addCustomCategoryToPlaylist,
  addChannelsToCategory,
  createCategoryFolder,
  renameCategoryFolder,
  deleteCategoryFolder,
  assignCategoryToFolder,
} from '../services/playlist-editor';
import { useModal } from './Modal';
import './PlaylistEditorModal.css';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface PlaylistEditorModalProps {
  playlistId: string;
  playlistName: string;
  onClose: () => void;
}

function parseCategoryIds(raw: string | string[] | number[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch { /* not JSON */ }
  if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
  return [String(raw)];
}

interface BrowseSource {
  id: string;
  name: string;
  isCustomPlaylist?: boolean;
}

const EyeIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style={{ display: 'block' }}>
    <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
  </svg>
);

const PlaylistIcon = ({ size = 16 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10H7v-2h10v2zm0-4H7V7h10v2zm0 8H7v-2h10v2z"/>
  </svg>
);

const EditIcon = ({ size = 14 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
  </svg>
);

const FolderIcon = ({ size = 16 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>
    <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
  </svg>
);

const TargetIcon = ({ size = 14 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>
    <path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10 10-4.49 10-10S17.51 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-13c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm0 8c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z"/>
  </svg>
);

const LockIcon = ({ size = 12 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
  </svg>
);

const TvIcon = ({ size = 16, style }: { size?: number; style?: React.CSSProperties }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'block', ...style }}>
    <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/>
  </svg>
);

const PlusIcon = ({ size = 14 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
  </svg>
);

const ExportIcon = ({ size = 14 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>
    <path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6-4.67V17h-2V7.33L8.41 9.92 7 8.5l5-5 5 5-1.41 1.42L13 7.33z"/>
  </svg>
);

const MovieIcon = ({ size = 16 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>
    <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/>
  </svg>
);

const CloseIcon = ({ size = 12 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '4px' }}>
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
  </svg>
);

const EyeSlashIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style={{ display: 'block' }}>
    <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.82l2.92 2.92c1.51-1.39 2.7-3.13 3.44-5.04-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.47-2.3c-.22 0-.44.03-.65.08l1.65 1.65c.05-.21.08-.43.08-.65 0-1.66-1.34-3-3-3z"/>
  </svg>
);

interface CategoryBlockCardProps {
  playlistId: string;
  block: any;
  sources: BrowseSource[];
  folders?: CategoryFolder[];
  index: number;
  isDragging: boolean;
  isDragOver: boolean;
  isMarked: boolean;
  onMark: () => void;
  onPointerDown: (e: React.PointerEvent, index: number) => void;
  onRemove?: () => void;
  showHidden: boolean;
}

function CategoryBlockCard({
  playlistId,
  block,
  sources,
  folders,
  index,
  isDragging,
  isDragOver,
  isMarked,
  onMark,
  onPointerDown,
  onRemove,
  showHidden,
}: CategoryBlockCardProps) {
  const { t } = useTranslation('playlist');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renamingName, setRenamingName] = useState(block.name);
  const renameInputRef = useRef<HTMLInputElement>(null);



  // Toggle category enabled state in right panel
  const toggleCategoryEnabled = async () => {
    if (block.type !== 'native') return;
    const newEnabled = block.category.enabled === false;
    await db.categories.update(block.category.category_id, { enabled: newEnabled });
  };

  // Load dynamic channels reactively (without enabled query filter)
  const sourceId = block.type === 'native' ? block.category.source_id : block.link.source_id;
  const categoryId = block.type === 'native' ? block.category.category_id : block.link.category_id;

  const dynamicChannels = useLiveQuery(
    async () => {
      if (sourceId === 'custom') {
        return [];
      }
      const chans = await db.channels.whereRaw(
        `source_id = ? AND EXISTS (SELECT 1 FROM json_each(category_ids) WHERE value = ?)`,
        [sourceId, categoryId]
      ).toArray();

      // Legacy Sort Order fallback:
      chans.sort((a, b) => {
        if (a.display_order != null && b.display_order != null) return a.display_order - b.display_order;
        if (a.display_order != null) return -1;
        if (b.display_order != null) return 1;
        if (a.provider_order != null && b.provider_order != null) return a.provider_order - b.provider_order;
        if (a.provider_order != null) return -1;
        if (b.provider_order != null) return 1;
        return a.name.localeCompare(b.name);
      });
      return chans;
    },
    [sourceId, categoryId],
    []
  );

  // Load manual channels reactively
  const parentCategoryId = block.type === 'native' ? block.id : `link:${block.linkId}`;
  const manualMappings = useLiveQuery(
    async () => {
      const current = await db.playlistIndividualChannels
        .whereRaw('playlist_id = ? AND parent_category_id = ?', [playlistId, parentCategoryId])
        .sortBy('display_order');
      
      if (current && current.length > 0) {
        return current;
      }

      if (block.type === 'link' && block.link) {
        const targetPlaylist = block.link.source_id;
        const targetParent = block.link.category_id;
        return db.playlistIndividualChannels
          .whereRaw('playlist_id = ? AND parent_category_id = ?', [targetPlaylist, targetParent])
          .sortBy('display_order');
      }

      return [];
    },
    [playlistId, parentCategoryId, block],
    []
  );

  const manualChannels = useLiveQuery(
    async () => {
      if (!manualMappings || manualMappings.length === 0) {
        return [];
      }
      const ids = manualMappings.map(m => m.stream_id);
      const channels = await db.channels.where('stream_id').anyOf(ids).toArray();
      const channelMap = new Map(channels.map(ch => [ch.stream_id, ch]));
      return manualMappings
        .map(m => channelMap.get(m.stream_id))
        .filter((ch): ch is StoredChannel => ch !== undefined);
    },
    [manualMappings],
    []
  );

  // Merge dynamic and manual channels into a single integrated list
  const combinedChannels = React.useMemo(() => {
    const targetSourceId = block.type === 'native' ? block.category.source_id : block.link.source_id;
    const targetCategoryId = block.type === 'native' ? block.category.category_id : block.link.category_id;
    const dynamicStreamIds = new Set((dynamicChannels || []).map(ch => ch.stream_id));

    const manualStreamIds = new Set((manualMappings || []).map(m => m.stream_id));
    const resolvedManual = (manualMappings || [])
      .sort((a, b) => a.display_order - b.display_order)
      .map(m => {
        const ch = (manualChannels || []).find(c => c.stream_id === m.stream_id);
        if (!ch) return null;

        const isCustomCategory = targetSourceId === 'custom';
        const isNative = !isCustomCategory && ch.source_id === targetSourceId && parseCategoryIds(ch.category_ids).includes(targetCategoryId);
        return { ...ch, isManualAddition: !isNative };
      })
      .filter(Boolean) as Array<StoredChannel & { isManualAddition: boolean }>;

    const remainingDynamic = (dynamicChannels || [])
      .filter(ch => !manualStreamIds.has(ch.stream_id))
      .map(ch => ({ ...ch, isManualAddition: false }));

    return [...resolvedManual, ...remainingDynamic];
  }, [dynamicChannels, manualMappings, manualChannels, block]);

  const startRename = () => {
    if (block.type === 'link') {
      setRenamingName(block.link.custom_name || block.name);
    } else {
      setRenamingName(block.category.alias || block.category.category_name);
    }
    setIsRenaming(true);
    setTimeout(() => renameInputRef.current?.focus(), 50);
  };

  const handleSaveRename = async () => {
    const trimmed = renamingName.trim();
    if (block.type === 'link') {
      await renameCategoryLink(block.linkId, trimmed || null);
    } else {
      await db.categories.update(block.category.category_id, { alias: trimmed || undefined });
    }
    setIsRenaming(false);
  };

  // Drag and drop within integrated channel list
  const manualListRef = useRef<HTMLDivElement>(null);
  const dragFromIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const getManualIndexFromClientY = (clientY: number): number => {
    if (!manualListRef.current) return 0;
    const children = Array.from(manualListRef.current.children) as HTMLElement[];
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return parseInt(children[i].getAttribute('data-index') || '0', 10);
      }
    }
    if (children.length > 0) {
      const lastIdx = parseInt(children[children.length - 1].getAttribute('data-index') || '0', 10);
      return lastIdx + 1;
    }
    return 0;
  };

  const handleManualPointerDown = useCallback((e: React.PointerEvent, idx: number) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragFromIdx.current = idx;
    setDragOverIdx(idx);
  }, []);

  const handleManualPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragFromIdx.current === null) return;
    e.preventDefault();
    setDragOverIdx(getManualIndexFromClientY(e.clientY));
  }, []);

  const handleManualPointerUp = useCallback(async (e: React.PointerEvent) => {
    if (dragFromIdx.current === null) return;
    const from = dragFromIdx.current;
    const to = getManualIndexFromClientY(e.clientY);
    dragFromIdx.current = null;
    setDragOverIdx(null);
    if (from === to || !combinedChannels) return;

    const next = [...combinedChannels];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);

    try {
      // Clear existing order records for this category
      await db.playlistIndividualChannels
        .whereRaw('playlist_id = ? AND parent_category_id = ?', [playlistId, parentCategoryId])
        .delete();

      // Write records for all channels sequentially to define the custom order
      const now = Date.now();
      for (let i = 0; i < next.length; i++) {
        const ch = next[i];
        await db.playlistIndividualChannels.put({
          playlist_id: playlistId,
          stream_id: ch.stream_id,
          parent_category_id: parentCategoryId,
          display_order: i,
          added_at: now
        });
      }
    } catch (err) {
      console.error('Failed to reorder category channels:', err);
    }
  }, [combinedChannels, playlistId, parentCategoryId]);

  const handleManualPointerCancel = useCallback(() => {
    dragFromIdx.current = null;
    setDragOverIdx(null);
  }, []);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isSortableDragging,
  } = useSortable({ id: block.id });

  const sortableStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isSortableDragging || isDragging ? 0.4 : 1,
    zIndex: isSortableDragging || isDragging ? 99 : 1,
  };

  // Hide if not showing hidden and category is native + disabled.
  // NOTE: this early return MUST stay after every hook (useSortable above).
  // If it runs first, toggling "Show Hidden" changes this component's hook
  // count and React throws ("Rendered more hooks than during the previous
  // render"), unmounting the whole app -> black/invisible window.
  if (block.type === 'native' && block.category.enabled === false && !showHidden) {
    return null;
  }

  const srcName = block.type === 'link' 
    ? (block.link.source_id === 'custom' ? t('customCategory') : (sources.find(s => s.id === block.link.source_id)?.name || t('source'))) 
    : '';

  const visibleChannelsCount = combinedChannels.filter(c => showHidden || c.enabled !== false).length;

  return (
    <div 
      ref={setNodeRef}
      style={sortableStyle}
      className={`ple-block-card-wrapper${isSortableDragging || isDragging ? ' dragging' : ''}${isDragOver ? ' drag-over' : ''}${isMarked ? ' marked' : ''}${block.type === 'native' && block.category.enabled === false ? ' ple-hidden-item' : ''}`}
      data-index={index}
    >
      <div
        className="ple-block-card"
        style={{ touchAction: 'none' }}
        {...attributes}
        {...listeners}
      >
        <button
          className="ple-block-expand-btn"
          onClick={() => setIsExpanded(!isExpanded)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="ple-chevron-small">{isExpanded ? '▼' : '▶'}</span>
        </button>

        <div className="ple-block-info">
          {isRenaming ? (
            <div className="ple-inline-rename" onPointerDown={(e) => e.stopPropagation()}>
              <input
                ref={renameInputRef}
                className="ple-rename-input"
                value={renamingName}
                onChange={e => setRenamingName(e.target.value)}
                onBlur={handleSaveRename}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSaveRename();
                  if (e.key === 'Escape') setIsRenaming(false);
                }}
              />
            </div>
          ) : (
            <div className="ple-block-title-row">
              <span
                className="ple-block-title"
                onClick={startRename}
                onPointerDown={(e) => e.stopPropagation()}
                title={t('renameCategoryTooltip')}
              >
                <FolderIcon /> {block.name} <EditIcon />
              </span>
              {block.type === 'link' && block.link.custom_name && block.link.source_id !== 'custom' && (
                <span className="ple-original-title-hint">(orig: {block.link.category_id})</span>
              )}
              {block.type === 'native' && block.category.alias && (
                <span className="ple-original-title-hint">(orig: {block.category.category_name})</span>
              )}
            </div>
          )}
          <span className="ple-block-sub">
            {block.type === 'link' ? `${srcName} · ` : ''}
            {t('channelsCount', { count: visibleChannelsCount })}
          </span>
        </div>

        {block.type === 'native' && (
          <button
            className={`ple-visibility-btn${block.category.enabled === false ? ' hidden-item' : ''}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              toggleCategoryEnabled();
            }}
            title={block.category.enabled === false ? t('showCategory') : t('hideCategory')}
          >
            {block.category.enabled === false ? <EyeSlashIcon /> : <EyeIcon />}
          </button>
        )}

        {folders && folders.length > 0 && (
          <select
            className="ple-folder-select"
            value={(block.type === 'link' ? block.link.folder_id : block.category.folder_id) || ''}
            onChange={(e) => {
              const val = e.target.value || null;
              assignCategoryToFolder(
                block.type === 'link',
                block.type === 'link' ? block.linkId : block.category.category_id,
                val
              );
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            title={t('assignToFolder')}
          >
            <option value="">📁 {t('rootLevel')}</option>
            {folders.map(f => (
              <option key={f.folder_id} value={f.folder_id}>📁 {f.name}</option>
            ))}
          </select>
        )}

        <button
          className={`ple-block-target-btn${isMarked ? ' marked' : ''}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onMark();
          }}
          title={isMarked ? t('targetActiveTooltip') : t('markTargetTooltip')}
        >
          <TargetIcon size={12} /> {isMarked ? t('targetActive') : t('target')}
        </button>

        {block.type === 'link' && onRemove && (
          <button
            className="ple-remove-btn"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onRemove}
            title={t('removeCategoryLink')}
          >✕</button>
        )}
      </div>

      {isExpanded && (
        <div className="ple-block-expanded-content">

          <div className="ple-nested-section">
            {combinedChannels.length === 0 ? (
              <div className="ple-empty-hint">{t('categoryEmptyHint')}</div>
            ) : (
              <div
                className="ple-nested-channels-list reorderable"
                ref={manualListRef}
                onPointerMove={handleManualPointerMove}
                onPointerUp={handleManualPointerUp}
                onPointerCancel={handleManualPointerCancel}
              >
                {combinedChannels.map((ch, idx) => {
                  const isChDragging = dragFromIdx.current === idx;
                  const isChDragOver = dragOverIdx === idx && dragFromIdx.current !== null && dragFromIdx.current !== idx;
                  
                  if (ch.enabled === false && !showHidden) {
                    return null;
                  }

                  const toggleChannelEnabled = async () => {
                    const newEnabled = ch.enabled === false;
                    await db.channels.update(ch.stream_id, { enabled: newEnabled });
                  };

                  return (
                    <div
                      key={ch.stream_id}
                      style={{ touchAction: 'none' }}
                      onPointerDown={e => handleManualPointerDown(e, idx)}
                      className={`ple-nested-channel-row reorderable${isChDragging ? ' dragging' : ''}${isChDragOver ? ' drag-over' : ''}${ch.enabled === false ? ' ple-hidden-item' : ''}`}
                      data-index={idx}
                    >
                      {ch.stream_icon ? (
                        <img src={ch.stream_icon} className="ple-nested-ch-logo" alt="" />
                      ) : (
                        <span className="ple-nested-ch-logo-placeholder"><TvIcon size={14} style={{ opacity: 0.6 }} /></span>
                      )}
                      <span className="ple-nested-ch-name">
                        {ch.name} {!ch.isManualAddition && <span className="ple-dynamic-badge">{t('dynamic')}</span>}
                      </span>
                      
                      <button
                        className={`ple-visibility-btn${ch.enabled === false ? ' hidden-item' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleChannelEnabled();
                        }}
                        title={ch.enabled === false ? t('showChannel') : t('hideChannel')}
                      >
                        {ch.enabled === false ? <EyeSlashIcon /> : <EyeIcon />}
                      </button>

                      {ch.isManualAddition ? (
                        <button
                          className="ple-remove-btn"
                          onClick={() => removeChannelFromCategory(playlistId, parentCategoryId, ch.stream_id)}
                          title={t('removeCustomChannel')}
                        >✕</button>
                      ) : (
                        <span className="ple-read-only-badge" title={t('dynamicReadOnly')}><LockIcon /></span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SortableIndivChannelCard(props: {
  ch: StoredChannel;
  index: number;
  sources: BrowseSource[];
  playlistId: string;
  showHidden: boolean;
  toggleChannelEnabledGlobal: (streamId: string, currentEnabled: boolean) => void;
}) {
  const { t } = useTranslation('playlist');
  const { ch, index, sources, playlistId, showHidden, toggleChannelEnabledGlobal } = props;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: ch.stream_id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 99 : 1,
    touchAction: 'none',
  };

  const srcName = sources.find(s => s.id === ch.source_id)?.name || t('source');

  if (ch.enabled === false && !showHidden) return null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`ple-indiv-card${isDragging ? ' dragging' : ''}${ch.enabled === false ? ' ple-hidden-item' : ''}`}
      data-index={index}
    >
      <div className="ple-indiv-ch-info">
        {ch.stream_icon ? (
          <img src={ch.stream_icon} className="ple-indiv-ch-logo" alt="" />
        ) : (
          <span className="ple-indiv-ch-logo-placeholder"><TvIcon size={14} style={{ opacity: 0.6 }} /></span>
        )}
        <div className="ple-indiv-ch-meta">
          <span className="ple-indiv-ch-name">{ch.name}</span>
          <span className="ple-indiv-ch-sub">{srcName}</span>
        </div>
      </div>

      <button
        className={`ple-visibility-btn${ch.enabled === false ? ' hidden-item' : ''}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          toggleChannelEnabledGlobal(ch.stream_id, ch.enabled !== false);
        }}
        title={ch.enabled === false ? t('showChannel') : t('hideChannel')}
      >
        {ch.enabled === false ? <EyeSlashIcon /> : <EyeIcon />}
      </button>

      <button
        className="ple-remove-btn"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => removeIndividualChannelFromPlaylist(playlistId, ch.stream_id)}
        title={t('removeChannel')}
      >
        ✕
      </button>
    </div>
  );
}

async function sortChannelsLikeLiveTV(sourceId: string, categoryId: string, channels: StoredChannel[]): Promise<StoredChannel[]> {
  let targetPlaylistId = sourceId;
  let targetParentId = categoryId;
  
  if (sourceId.startsWith('playlist:')) {
    targetPlaylistId = sourceId.replace('playlist:', '');
    if (categoryId.startsWith('link:')) {
      const linkId = parseInt(categoryId.replace('link:', ''), 10);
      targetParentId = `link:${linkId}`;
    }
  }

  let manualMappings = await db.playlistIndividualChannels
    .whereRaw('playlist_id = ? AND parent_category_id = ?', [targetPlaylistId, targetParentId])
    .toArray();

  // Fallback inheritance for linked category if no custom mappings exist
  if (manualMappings.length === 0 && categoryId.startsWith('link:')) {
    const linkId = parseInt(categoryId.replace('link:', ''), 10);
    const categoryLink = await db.playlistCategoryLinks.get(linkId);
    if (categoryLink) {
      const targetPlaylist = categoryLink.source_id;
      const targetParent = categoryLink.category_id;
      manualMappings = await db.playlistIndividualChannels
        .whereRaw('playlist_id = ? AND parent_category_id = ?', [targetPlaylist, targetParent])
        .toArray();
    }
  }

  let resolvedChannels = [...channels];

  if (manualMappings.length > 0) {
    const manualStreamIds = new Set(manualMappings.map(m => m.stream_id));
    const existingStreamIds = new Set(channels.map(c => c.stream_id));

    // Resolve any manual channels that are missing from the input dynamic channels array
    const missingIds = Array.from(manualStreamIds).filter(id => !existingStreamIds.has(id));
    if (missingIds.length > 0) {
      const missingChans = await db.channels.where('stream_id').anyOf(missingIds).toArray();
      resolvedChannels.push(...missingChans);
    }

    const manualMap = new Map(manualMappings.map(m => [m.stream_id, m.display_order]));
    const orderedManual = resolvedChannels
      .filter(ch => manualStreamIds.has(ch.stream_id))
      .sort((a, b) => (manualMap.get(a.stream_id) ?? 0) - (manualMap.get(b.stream_id) ?? 0));
    
    const remaining = resolvedChannels.filter(ch => !manualStreamIds.has(ch.stream_id));
    remaining.sort((a, b) => {
      if (a.display_order != null && b.display_order != null) return a.display_order - b.display_order;
      if (a.display_order != null) return -1;
      if (b.display_order != null) return 1;
      if (a.provider_order != null && b.provider_order != null) return a.provider_order - b.provider_order;
      if (a.provider_order != null) return -1;
      if (b.provider_order != null) return 1;
      return a.name.localeCompare(b.name);
    });
    return [...orderedManual, ...remaining];
  }

  // No manual mappings - sort by display_order, then provider_order, then name
  const sorted = [...resolvedChannels];
  sorted.sort((a, b) => {
    if (a.display_order != null && b.display_order != null) return a.display_order - b.display_order;
    if (a.display_order != null) return -1;
    if (b.display_order != null) return 1;
    if (a.provider_order != null && b.provider_order != null) return a.provider_order - b.provider_order;
    if (a.provider_order != null) return -1;
    if (b.provider_order != null) return 1;
    return a.name.localeCompare(b.name);
  });
  return sorted;
}

export function PlaylistEditorModal({ playlistId, playlistName, onClose }: PlaylistEditorModalProps) {
  const { t } = useTranslation('playlist');
  const { showPrompt, showConfirm, showSuccess, showError, ModalComponent } = useModal();
  const [sources, setSources] = useState<BrowseSource[]>([]);
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  const [sourceCategories, setSourceCategories] = useState<Record<string, StoredCategory[]>>({});
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});
  const [categoryChannels, setCategoryChannels] = useState<Record<string, StoredChannel[]>>({});
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});

  // Load category folders for this playlist/source
  const categoryFolders = useLiveQuery(
    async () => {
      const folders = await db.categoryFolders.where('playlist_id').equals(playlistId).toArray();
      return folders.sort((a, b) => a.display_order - b.display_order);
    },
    [playlistId],
    []
  );

  const toggleFolderCollapse = (folderId: string) => {
    setCollapsedFolders(prev => ({
      ...prev,
      [folderId]: !prev[folderId]
    }));
  };

  // Target marking state
  const [markedCategoryId, setMarkedCategoryId] = useState<string | null>(null);

  // Global show hidden state
  const [showHidden, setShowHidden] = useState(false);

  // Live query all categories to construct names map for tree-view search
  const allCategories = useLiveQuery(
    () => db.categories.toArray(),
    [],
    []
  );

  const categoryNamesMap = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of allCategories || []) {
      map.set(`${cat.source_id}:${cat.category_id}`, cat.alias || cat.category_name);
    }
    return map;
  }, [allCategories]);

  // Global channel visibility toggle
  const toggleChannelEnabledGlobal = async (streamId: string, currentEnabled: boolean) => {
    const newEnabled = !currentEnabled;
    await db.channels.update(streamId, { enabled: newEnabled });
    // Update searchResults inline
    setSearchResults(prev => prev.map(ch => ch.stream_id === streamId ? { ...ch, enabled: newEnabled } : ch));
    // Update categoryChannels inline
    setCategoryChannels(prev => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (next[key].some(ch => ch.stream_id === streamId)) {
          next[key] = next[key].map(ch => ch.stream_id === streamId ? { ...ch, enabled: newEnabled } : ch);
        }
      }
      return next;
    });
  };

  // Global category visibility toggle
  const toggleCategoryEnabledGlobal = async (sourceId: string, categoryId: string, currentEnabled: boolean) => {
    const newEnabled = !currentEnabled;
    await db.categories.update(categoryId, { enabled: newEnabled });
    // Update sourceCategories inline
    setSourceCategories(prev => {
      const cats = prev[sourceId];
      if (!cats) return prev;
      return {
        ...prev,
        [sourceId]: cats.map(c => c.category_id === categoryId ? { ...c, enabled: newEnabled } : c)
      };
    });
  };

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<StoredChannel[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Playlist name editing
  const [currentName, setCurrentName] = useState(playlistName);
  const [isEditingName, setIsEditingName] = useState(false);
  const [isCustomPlaylist, setIsCustomPlaylist] = useState(false);
  const [sourceType, setSourceType] = useState<string | undefined>(undefined);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Drag-and-drop lists pointer refs
  const categoryListRef = useRef<HTMLDivElement>(null);
  const dragFromCatIdx = useRef<number | null>(null);
  const [dragOverCatIdx, setDragOverCatIdx] = useState<number | null>(null);

  const indivListRef = useRef<HTMLDivElement>(null);
  const dragFromIndivIdx = useRef<number | null>(null);
  const [dragOverIndivIdx, setDragOverIndivIdx] = useState<number | null>(null);

  // Live query native categories (for real sources)
  const nativeCategories = useLiveQuery(
    () => {
      if (!isCustomPlaylist) {
        return db.categories.where('source_id').equals(playlistId).toArray();
      }
      return Promise.resolve([] as StoredCategory[]);
    },
    [playlistId, isCustomPlaylist],
    []
  );

  // Live query playlist category links
  const categoryLinks = useLiveQuery(
    () => db.playlistCategoryLinks.where('playlist_id').equals(playlistId).sortBy('display_order'),
    [playlistId],
    []
  );

  // Live query playlist individual channels
  const individualMappings = useLiveQuery(
    () => db.playlistIndividualChannels.where('playlist_id').equals(playlistId).sortBy('display_order'),
    [playlistId],
    []
  );

  // Filter individual mappings to only those that are not in a category
  const flatIndividualMappings = React.useMemo(() => {
    return (individualMappings || []).filter(m => !m.parent_category_id);
  }, [individualMappings]);

  // Resolve flat individual channel metadata
  const [individualChannels, setIndividualChannels] = useState<StoredChannel[]>([]);
  useEffect(() => {
    if (!flatIndividualMappings || flatIndividualMappings.length === 0) {
      setIndividualChannels([]);
      return;
    }
    const ids = flatIndividualMappings.map(m => m.stream_id);
    db.channels.where('stream_id').anyOf(ids).toArray().then(channels => {
      const channelMap = new Map(channels.map(ch => [ch.stream_id, ch]));
      const resolved = flatIndividualMappings
        .map(m => channelMap.get(m.stream_id))
        .filter((ch): ch is StoredChannel => ch !== undefined);
      setIndividualChannels(resolved);
    });
  }, [flatIndividualMappings]);

  // Load enabled sources on mount
  useEffect(() => {
    const loadSources = async () => {
      let realSources: BrowseSource[] = [];
      let currentSourceType: string | undefined = undefined;
      if (window.storage) {
        const res = await window.storage.getSources();
        if (res.success && res.data) {
          realSources = res.data
            .filter(s => s.enabled !== false)
            .map(s => ({ id: s.id, name: s.name }));
          const currentSource = res.data.find(s => s.id === playlistId);
          if (currentSource) {
            currentSourceType = currentSource.type;
          }
        }
      }

      // Fetch all custom playlists except the current one
      const playlists = await db.customPlaylists.toArray();
      const isCustom = playlists.some(p => p.playlist_id === playlistId);
      setIsCustomPlaylist(isCustom);
      setSourceType(currentSourceType);

      const virtualSources: BrowseSource[] = playlists
        .filter(p => p.playlist_id !== playlistId)
        .map(p => ({
          id: `playlist:${p.playlist_id}`,
          name: p.name,
          isCustomPlaylist: true
        }));

      setSources([...realSources, ...virtualSources]);
    };

    loadSources();
  }, [playlistId]);

  // Handle category name resolves (for right panel blocks)
  const [dbCategories, setDbCategories] = useState<Record<string, StoredCategory>>({});
  useEffect(() => {
    if (!categoryLinks || categoryLinks.length === 0) return;
    const ids = categoryLinks.map(l => l.category_id);
    db.categories.where('category_id').anyOf(ids).toArray().then(cats => {
      const map = cats.reduce((acc: Record<string, StoredCategory>, cat) => {
        acc[cat.category_id] = cat;
        return acc;
      }, {});
      setDbCategories(prev => ({ ...prev, ...map }));
    });
  }, [categoryLinks]);

  // Compute unified list of blocks (native categories + custom links)
  const combinedBlocks = React.useMemo(() => {
    const list: Array<
      | { type: 'native'; id: string; name: string; displayOrder: number; category: StoredCategory }
      | { type: 'link'; id: string; linkId: number; name: string; displayOrder: number; link: PlaylistCategoryLink }
    > = [];

    // Add native categories
    for (const cat of nativeCategories || []) {
      list.push({
        type: 'native',
        id: cat.category_id,
        name: cat.alias || cat.category_name,
        displayOrder: cat.display_order ?? 0,
        category: cat,
      });
    }

    // Add category links
    for (const link of categoryLinks || []) {
      if (link.id === undefined) continue;
      const cat = dbCategories[link.category_id];
      const resolvedName = cat?.alias || cat?.category_name || link.category_id;
      list.push({
        type: 'link',
        id: `link:${link.id}`,
        linkId: link.id,
        name: link.custom_name || resolvedName,
        displayOrder: link.display_order ?? 0,
        link,
      });
    }

    // Sort by displayOrder, then alphabetically by name
    list.sort((a, b) => {
      if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
      return a.name.localeCompare(b.name);
    });

    return list;
  }, [nativeCategories, categoryLinks, dbCategories]);

  // Expand source -> load categories
  const handleToggleSource = async (sourceId: string) => {
    const isExpanded = !expandedSources[sourceId];
    setExpandedSources(prev => ({ ...prev, [sourceId]: isExpanded }));

    if (isExpanded && !sourceCategories[sourceId]) {
      if (sourceId.startsWith('playlist:')) {
        const plId = sourceId.replace('playlist:', '');

        const links = await db.playlistCategoryLinks
          .where('playlist_id')
          .equals(plId)
          .sortBy('display_order');

        const linkCategories = links.map(link => ({
          category_id: `link:${link.id}`,
          source_id: sourceId,
          category_name: link.custom_name || `Category: ${link.category_id}`,
          alias: undefined,
          enabled: true
        }));

        const indivCount = await db.playlistIndividualChannels
          .where('playlist_id')
          .equals(plId)
          .count();

        if (indivCount > 0) {
          linkCategories.push({
            category_id: `indiv:${plId}`,
            source_id: sourceId,
            category_name: t('individualChannels'),
            alias: undefined,
            enabled: true
          });
        }

        setSourceCategories(prev => ({ ...prev, [sourceId]: linkCategories }));
      } else {
        const cats = await db.categories
          .where('source_id')
          .equals(sourceId)
          .toArray();
        cats.sort((a, b) => {
          if (a.display_order != null && b.display_order != null) return a.display_order - b.display_order;
          if (a.display_order != null) return -1;
          if (b.display_order != null) return 1;
          return a.category_name.localeCompare(b.category_name);
        });
        setSourceCategories(prev => ({ ...prev, [sourceId]: cats }));
      }
    }
  };

  // Expand category -> load channels
  const handleToggleCategory = async (sourceId: string, categoryId: string) => {
    const key = `${sourceId}:${categoryId}`;
    const isExpanded = !expandedCategories[key];
    setExpandedCategories(prev => ({ ...prev, [key]: isExpanded }));

    if (isExpanded && !categoryChannels[key]) {
      if (sourceId.startsWith('playlist:')) {
        const plId = sourceId.replace('playlist:', '');
        let channels: StoredChannel[] = [];

        if (categoryId.startsWith('link:')) {
          const linkId = parseInt(categoryId.replace('link:', ''), 10);
          const link = await db.playlistCategoryLinks.get(linkId);
          if (link) {
            channels = await db.channels.whereRaw(
              `source_id = ? AND EXISTS (SELECT 1 FROM json_each(category_ids) WHERE value = ?)`,
              [link.source_id, link.category_id]
            ).toArray();
          }
        } else if (categoryId.startsWith('indiv:')) {
          const mappings = await db.playlistIndividualChannels
            .where('playlist_id')
            .equals(plId)
            .sortBy('display_order');
          const streamIds = mappings.map(m => m.stream_id);
          if (streamIds.length > 0) {
            channels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
            const chMap = new Map(channels.map(ch => [ch.stream_id, ch]));
            channels = streamIds
              .map(id => chMap.get(id))
              .filter((ch): ch is StoredChannel => ch !== undefined);
          }
        }

        const sorted = await sortChannelsLikeLiveTV(sourceId, categoryId, channels);
        setCategoryChannels(prev => ({ ...prev, [key]: sorted }));
      } else {
        const channels = await db.channels.whereRaw(
          `source_id = ? AND EXISTS (SELECT 1 FROM json_each(category_ids) WHERE value = ?)`,
          [sourceId, categoryId]
        ).toArray();
        const sorted = await sortChannelsLikeLiveTV(sourceId, categoryId, channels);
        setCategoryChannels(prev => ({ ...prev, [key]: sorted }));
      }
    }
  };

  // Debounced search channel by name
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const tid = setTimeout(async () => {
      const { sql: wordClauses, params: wordParams } = buildSearchQueryClauses('name', searchQuery);
      const results = showHidden
        ? await db.channels.whereRaw(`(${wordClauses})`, wordParams).toArray()
        : await db.channels.whereRaw(`(${wordClauses}) AND (enabled IS NULL OR enabled NOT IN (0, '0', 'false'))`, wordParams).toArray();
      
      const activeSourceIds = new Set(sources.filter(s => !s.isCustomPlaylist).map(s => s.id));
      const filtered = results.filter(ch => activeSourceIds.has(ch.source_id));
      filtered.sort((a, b) => a.name.localeCompare(b.name));
      setSearchResults(filtered.slice(0, 100));
      setSearchLoading(false);
    }, 400);

    return () => clearTimeout(tid);
  }, [searchQuery, sources, showHidden]);

  // Playlist name editing
  const handleSaveName = async () => {
    const trimmed = currentName.trim();
    if (trimmed && trimmed !== playlistName) {
      await renamePlaylist(playlistId, trimmed);
    }
    setIsEditingName(false);
  };

  useEffect(() => {
    if (isEditingName) {
      nameInputRef.current?.focus();
    }
  }, [isEditingName]);

  // Left panel actions
  const handleAddCategory = async (sourceId: string, categoryId: string) => {
    if (sourceId.startsWith('playlist:')) {
      if (categoryId.startsWith('link:')) {
        const linkId = parseInt(categoryId.replace('link:', ''), 10);
        const link = await db.playlistCategoryLinks.get(linkId);
        if (link) {
          await addCategoryToPlaylist(playlistId, link.source_id, link.category_id);
        }
      } else if (categoryId.startsWith('indiv:')) {
        const plId = sourceId.replace('playlist:', '');
        const mappings = await db.playlistIndividualChannels
          .where('playlist_id')
          .equals(plId)
          .sortBy('display_order');
        const streamIds = mappings.map(m => m.stream_id);
        if (streamIds.length > 0) {
          await addMultipleIndividualChannelsToPlaylist(playlistId, streamIds);
        }
      }
    } else {
      await addCategoryToPlaylist(playlistId, sourceId, categoryId);
    }
  };

  const handleAddChannel = async (streamId: string) => {
    if (!markedCategoryId) {
      showError(t('targetCategoryRequired'), t('selectTargetFirst'));
      return;
    }
    await addChannelToCategory(playlistId, markedCategoryId, streamId);
  };

  const handleCombineCategory = async (sourceId: string, categoryId: string) => {
    if (!markedCategoryId) {
      showError(t('targetCategoryRequired'), t('selectTargetFirst'));
      return;
    }

    try {
      let channels: StoredChannel[] = [];
      if (sourceId.startsWith('playlist:')) {
        const plId = sourceId.replace('playlist:', '');
        if (categoryId.startsWith('link:')) {
          const linkId = parseInt(categoryId.replace('link:', ''), 10);
          const link = await db.playlistCategoryLinks.get(linkId);
          if (link) {
            channels = await db.channels.whereRaw(
              `source_id = ? AND EXISTS (SELECT 1 FROM json_each(category_ids) WHERE value = ?)`,
              [link.source_id, link.category_id]
            ).toArray();
          }
        } else if (categoryId.startsWith('indiv:')) {
          const mappings = await db.playlistIndividualChannels
            .where('playlist_id')
            .equals(plId)
            .sortBy('display_order');
          const streamIds = mappings.map(m => m.stream_id);
          if (streamIds.length > 0) {
            channels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
            const chMap = new Map(channels.map(ch => [ch.stream_id, ch]));
            channels = streamIds
              .map(id => chMap.get(id))
              .filter((ch): ch is StoredChannel => ch !== undefined);
          }
        }
      } else {
        channels = await db.channels.whereRaw(
          `source_id = ? AND EXISTS (SELECT 1 FROM json_each(category_ids) WHERE value = ?)`,
          [sourceId, categoryId]
        ).toArray();
      }

      const sorted = await sortChannelsLikeLiveTV(sourceId, categoryId, channels);
      const streamIds = sorted.map(ch => ch.stream_id);

      if (streamIds.length > 0) {
        await addChannelsToCategory(playlistId, markedCategoryId, streamIds);
        showSuccess(t('categoryCombined'), t('combinedMsg', { count: streamIds.length }));
      } else {
        showError(t('noChannels'), t('noChannelsMsg'));
      }
    } catch (err) {
      console.error('Failed to combine category:', err);
      showError(t('combineError'), t('combineErrorMsg'));
    }
  };

  // --- @dnd-kit Drag and Drop Handlers for Playlist Editor ---
  const pleSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleCategoryDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !combinedBlocks) return;

    const oldIndex = combinedBlocks.findIndex((b) => b.id === active.id);
    const newIndex = combinedBlocks.findIndex((b) => b.id === over.id);

    if (oldIndex === -1 || newIndex === -1) return;

    const next = arrayMove(combinedBlocks, oldIndex, newIndex);

    try {
      for (let i = 0; i < next.length; i++) {
        const block = next[i];
        if (block.type === 'native') {
          await db.categories.update(block.id, { display_order: i });
        } else if (block.type === 'link') {
          await db.playlistCategoryLinks.update(block.linkId, { display_order: i });
        }
      }
    } catch (err) {
      console.error('Failed to reorder playlist categories:', err);
    }
  };

  const handleIndivDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !individualChannels) return;

    const oldIndex = individualChannels.findIndex((ch) => ch.stream_id === active.id);
    const newIndex = individualChannels.findIndex((ch) => ch.stream_id === over.id);

    if (oldIndex === -1 || newIndex === -1) return;

    const next = arrayMove(individualChannels, oldIndex, newIndex);
    try {
      await reorderPlaylistIndividualChannels(playlistId, next.map(ch => ch.stream_id));
    } catch (err) {
      console.error('Failed to reorder individual channels:', err);
    }
  };

  const handleExport = async () => {
    try {
      const { generateM3uForPlaylist } = await import('../services/playlist-export');
      const content = await generateM3uForPlaylist(playlistId);
      const result = await window.storage.saveM3UFile(content, currentName);
      if (result.success) {
        showSuccess(t('exportPlaylist'), t('playlistExported'));
      }
    } catch (e) {
      console.error('Failed to export playlist:', e);
      showError(t('exportPlaylist'), t('exportFailed', { error: String(e) }));
    }
  };

  const visibleIndivCount = individualChannels.filter(c => showHidden || c.enabled !== false).length;

  return createPortal(
    <div className="playlist-editor-backdrop" onClick={onClose}>
      <div className="playlist-editor-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="playlist-editor-header">
          <div className="ple-header-left">
            <span className="ple-header-icon"><PlaylistIcon size={20} /></span>
            {isEditingName && isCustomPlaylist ? (
              <input
                ref={nameInputRef}
                className="ple-name-input"
                value={currentName}
                onChange={e => setCurrentName(e.target.value)}
                onBlur={handleSaveName}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSaveName();
                  if (e.key === 'Escape') {
                    setCurrentName(playlistName);
                    setIsEditingName(false);
                  }
                }}
              />
            ) : (
              <h2
                className={`ple-name-title${!isCustomPlaylist ? ' readonly' : ''}`}
                onClick={() => isCustomPlaylist && setIsEditingName(true)}
                title={isCustomPlaylist ? t('clickToRename') : undefined}
              >
                {currentName} {isCustomPlaylist && <EditIcon />}
              </h2>
            )}
          </div>
          <div className="ple-header-right">
            <label className="ple-show-hidden-label">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={e => setShowHidden(e.target.checked)}
              />
              Show Hidden
            </label>
            {sourceType !== 'stalker' && (
              <button className="ple-export-btn" onClick={handleExport}><ExportIcon />{t('exportM3u')}</button>
            )}
            <button className="ple-close-btn" onClick={onClose}><CloseIcon />{i18n.t('common:close')}</button>
          </div>
        </div>

        {/* Workspace Panels */}
        <div className="playlist-editor-workspace">
          {/* Left Panel: Source Browser */}
          <div className="playlist-editor-left">
            <div className="ple-panel-header">
              <h3>{t('searchBrowseSources')}</h3>
              <div className="ple-search-wrapper">
                <input
                  type="text"
                  placeholder={t('searchPlaceholder')}
                  className="ple-search-input"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button className="ple-search-clear" onClick={() => setSearchQuery('')}>✕</button>
                )}
              </div>
            </div>

            <div className="ple-panel-content">
              {searchQuery.trim() ? (
                // Search View
                <div className="ple-search-results">
                  {searchLoading ? (
                    <div className="ple-loading-hint">{t('searching')}</div>
                  ) : searchResults.length === 0 ? (
                    <div className="ple-empty-hint">{t('noMatchingChannels')}</div>
                  ) : (() => {
                    // Group searchResults by source, then by category
                    const sourceMap = new Map<string, Map<string, StoredChannel[]>>();
                    for (const ch of searchResults) {
                      const sourceId = ch.source_id;
                      if (!sourceMap.has(sourceId)) {
                        sourceMap.set(sourceId, new Map<string, StoredChannel[]>());
                      }
                      const catMap = sourceMap.get(sourceId)!;

                      const catIds = parseCategoryIds(ch.category_ids);
                      if (catIds.length === 0) {
                        const uncategorizedKey = 'uncategorized';
                        if (!catMap.has(uncategorizedKey)) {
                          catMap.set(uncategorizedKey, []);
                        }
                        catMap.get(uncategorizedKey)!.push(ch);
                      } else {
                        for (const catId of catIds) {
                          if (!catMap.has(catId)) {
                            catMap.set(catId, []);
                          }
                          catMap.get(catId)!.push(ch);
                        }
                      }
                    }

                    return (
                      <div className="ple-tree-root">
                        {Array.from(sourceMap.entries()).map(([sourceId, categoriesMap]) => {
                          const sourceObj = sources.find(s => s.id === sourceId);
                          const sourceName = sourceObj ? sourceObj.name : t('unknownSource');

                          return (
                            <div key={sourceId} className="ple-tree-source-node">
                              <div className="ple-tree-source-header">
                                <span className="ple-tree-chevron">▼</span>
                                <span className="ple-tree-source-name">{sourceName}</span>
                              </div>
                              <div className="ple-tree-source-children">
                                {Array.from(categoriesMap.entries()).map(([catId, channels]) => {
                                  const categoryName = catId === 'uncategorized'
                                    ? t('uncategorized')
                                    : (categoryNamesMap.get(`${sourceId}:${catId}`) || catId);

                                  const visibleChans = channels.filter(ch => showHidden || ch.enabled !== false);
                                  if (visibleChans.length === 0) return null;

                                  return (
                                    <div key={catId} className="ple-tree-cat-node">
                                      <div className="ple-tree-cat-header">
                                        <span className="ple-tree-chevron-small">▼</span>
                                        <span className="ple-tree-cat-name">{categoryName}</span>
                                        <span className="ple-tree-cat-count">{visibleChans.length}</span>
                                      </div>
                                      <div className="ple-tree-cat-children">
                                        {visibleChans.map(ch => (
                                          <div key={`${catId}:${ch.stream_id}`} className={`ple-tree-channel-row${ch.enabled === false ? ' ple-hidden-item' : ''}`}>
                                            <div className="ple-tree-ch-info">
                                              {ch.stream_icon ? (
                                                <img src={ch.stream_icon} className="ple-tree-ch-logo" alt="" />
                                              ) : (
                                                <span className="ple-tree-ch-logo-placeholder"><TvIcon size={14} style={{ opacity: 0.6 }} /></span>
                                              )}
                                              <span className="ple-tree-ch-name">{ch.name}</span>
                                            </div>
                                            <div className="ple-tree-ch-actions">
                                              <button
                                                className={`ple-visibility-btn${ch.enabled === false ? ' hidden-item' : ''}`}
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  toggleChannelEnabledGlobal(ch.stream_id, ch.enabled !== false);
                                                }}
                                                title={ch.enabled === false ? t('showChannel') : t('hideChannel')}
                                              >
                                                {ch.enabled === false ? <EyeSlashIcon /> : <EyeIcon />}
                                              </button>
                                              <button
                                                className="ple-tree-add-btn"
                                                onClick={() => handleAddChannel(ch.stream_id)}
                                                disabled={!markedCategoryId}
                                                title={markedCategoryId ? t('addToTargetTooltip') : t('selectTargetTooltip')}
                                              >
                                                <PlusIcon size={14} />
                                              </button>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              ) : (
                // Browse View
                <div className="ple-sources-list">
                  {sources.map(source => {
                    const isExpanded = !!expandedSources[source.id];
                    const cats = sourceCategories[source.id] || [];

                    return (
                      <div key={source.id} className={`ple-source-block${isExpanded ? ' expanded' : ''}`}>
                        <button className="ple-source-header" onClick={() => handleToggleSource(source.id)}>
                          <span className="ple-chevron">{isExpanded ? '▼' : '▶'}</span>
                          {source.isCustomPlaylist ? <PlaylistIcon size={14} /> : <FolderIcon size={14} />}
                          <span className="ple-source-name" style={{ marginLeft: '6px' }}>{source.name}</span>
                        </button>

                        {isExpanded && (
                          <div className="ple-source-categories">
                            {cats.length === 0 ? (
                              <div className="ple-empty-hint">{t('noCategories')}</div>
                            ) : (
                              cats.map(cat => {
                                const catKey = `${source.id}:${cat.category_id}`;
                                const isCatExpanded = !!expandedCategories[catKey];
                                const channels = categoryChannels[catKey] || [];
                                const displayName = cat.alias || cat.category_name;

                                if (cat.enabled === false && !showHidden) {
                                  return null;
                                }

                                return (
                                  <div key={cat.category_id} className={`ple-cat-block${cat.enabled === false ? ' ple-hidden-item' : ''}`}>
                                    <div className="ple-cat-header">
                                      <button
                                        className="ple-cat-toggle"
                                        onClick={() => handleToggleCategory(source.id, cat.category_id)}
                                      >
                                        <span className="ple-chevron-small">{isCatExpanded ? '▼' : '▶'}</span>
                                        <span className="ple-cat-name">{displayName}</span>
                                      </button>
                                      <div className="ple-cat-ch-actions">
                                        {source.id !== 'custom' && !source.id.startsWith('playlist:') && (
                                          <button
                                            className={`ple-visibility-btn${cat.enabled === false ? ' hidden-item' : ''}`}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              toggleCategoryEnabledGlobal(source.id, cat.category_id, cat.enabled !== false);
                                            }}
                                            title={cat.enabled === false ? t('showCategory') : t('hideCategory')}
                                          >
                                            {cat.enabled === false ? <EyeSlashIcon /> : <EyeIcon />}
                                          </button>
                                        )}
                                        <button
                                          className="ple-add-btn"
                                          onClick={() => handleAddCategory(source.id, cat.category_id)}
                                          title={t('addCategoryLinkTooltip')}
                                        >
                                          <PlusIcon size={12} /> Category
                                        </button>
                                        <button
                                          className="ple-add-btn"
                                          onClick={() => handleCombineCategory(source.id, cat.category_id)}
                                          disabled={!markedCategoryId}
                                          title={markedCategoryId ? t('combineToTargetTooltip') : t('selectTargetTooltip')}
                                        >
                                          <PlusIcon size={12} /> Combine
                                        </button>
                                      </div>
                                    </div>

                                    {isCatExpanded && (
                                      <div className="ple-cat-channels">
                                        {channels.length === 0 ? (
                                          <div className="ple-empty-hint">{t('noChannels')}</div>
                                        ) : (
                                          channels.map(ch => {
                                            if (ch.enabled === false && !showHidden) {
                                              return null;
                                            }

                                            return (
                                              <div key={ch.stream_id} className={`ple-cat-channel-row${ch.enabled === false ? ' ple-hidden-item' : ''}`}>
                                                <span className="ple-cat-ch-name">{ch.name}</span>
                                                <div className="ple-cat-ch-actions">
                                                  <button
                                                    className={`ple-visibility-btn${ch.enabled === false ? ' hidden-item' : ''}`}
                                                    onClick={(e) => {
                                                      e.stopPropagation();
                                                      toggleChannelEnabledGlobal(ch.stream_id, ch.enabled !== false);
                                                    }}
                                                    title={ch.enabled === false ? t('showChannel') : t('hideChannel')}
                                                  >
                                                    {ch.enabled === false ? <EyeSlashIcon /> : <EyeIcon />}
                                                  </button>
                                                  <button
                                                    className="ple-add-indiv-btn"
                                                    onClick={() => handleAddChannel(ch.stream_id)}
                                                    disabled={!markedCategoryId}
                                                    title={markedCategoryId ? t('addToTargetTooltip') : t('selectTargetTooltip')}
                                                  >
                                                    <PlusIcon size={14} />
                                                  </button>
                                                </div>
                                              </div>
                                            );
                                          })
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right Panel: Playlist Contents */}
          <div className="playlist-editor-right">
            <div className="ple-panel-header ple-right-panel-header">
              <div className="ple-right-header-title-row">
                <h3>{t('playlistContents')}</h3>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    className="ple-add-folder-btn"
                    onClick={() => {
                      showPrompt(
                        t('createFolderTitle'),
                        t('createFolderMsg'),
                        async (name) => {
                          if (name && name.trim()) {
                            await createCategoryFolder(playlistId, name.trim());
                          }
                        },
                        undefined,
                        t('folderNamePlaceholder')
                      );
                    }}
                  >
                    <FolderIcon size={14} /> + {t('addFolder')}
                  </button>
                  <button
                    className="ple-add-custom-cat-btn"
                    onClick={() => {
                      showPrompt(
                        t('createCustomCategoryTitle'),
                        t('createCustomCategoryMsg'),
                        async (name) => {
                          if (name && name.trim()) {
                            await addCustomCategoryToPlaylist(playlistId, name.trim());
                          }
                        },
                        undefined,
                        t('categoryNamePlaceholder')
                      );
                    }}
                  >
                    <PlusIcon size={12} /> {t('customCategoryBtn')}
                  </button>
                </div>
              </div>
              <span className="ple-meta-hint">{t('dragHint')}</span>
            </div>

            <div className="ple-panel-content">
              {(!combinedBlocks || combinedBlocks.length === 0) && (!individualChannels || individualChannels.length === 0) ? (
                <div className="ple-right-empty">
                  <span className="ple-empty-icon"><PlaylistIcon size={48} /></span>
                  <h4>{t('playlistEmpty')}</h4>
                  <p>{t('playlistEmptyHint')}</p>
                </div>
              ) : (
                <div className="ple-contents-list">
                    <DndContext
                      sensors={pleSensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleCategoryDragEnd}
                    >
                      <SortableContext
                        items={(combinedBlocks || []).map((b) => b.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {categoryFolders && categoryFolders.length > 0 ? (
                          <>
                            {categoryFolders.map((folder: CategoryFolder) => {
                              const folderBlocks = (combinedBlocks || []).filter(b => {
                                const fId = b.type === 'link' ? b.link.folder_id : b.category.folder_id;
                                return fId === folder.folder_id;
                              });
                              const isCollapsed = !!collapsedFolders[folder.folder_id];

                              return (
                                <div key={folder.folder_id} className="ple-folder-card">
                                  <div className="ple-folder-card-header">
                                    <div className="ple-folder-header-left">
                                      <button
                                        className="ple-block-expand-btn"
                                        onClick={() => toggleFolderCollapse(folder.folder_id)}
                                      >
                                        <span className="ple-chevron-small">{isCollapsed ? '▶' : '▼'}</span>
                                      </button>
                                      <FolderIcon size={16} />
                                      <span>{folder.name}</span>
                                      <span className="ple-original-title-hint">({t('categoriesCount', { count: folderBlocks.length })})</span>
                                    </div>

                                    <div className="ple-folder-header-actions">
                                      <button
                                        className="ple-folder-icon-btn"
                                        onClick={() => {
                                          showPrompt(
                                            t('renameFolderTitle'),
                                            t('renameFolderMsg'),
                                            async (newName) => {
                                              if (newName && newName.trim()) {
                                                await renameCategoryFolder(folder.folder_id, newName.trim());
                                              }
                                            },
                                            undefined,
                                            t('folderNamePlaceholder'),
                                            folder.name
                                          );
                                        }}
                                        title={t('renameFolderTooltip')}
                                      >
                                        <EditIcon size={12} />
                                      </button>
                                      <button
                                        className="ple-folder-icon-btn delete"
                                        onClick={() => {
                                          showConfirm(
                                            t('deleteFolderTitle'),
                                            t('deleteFolderMsg', { name: folder.name }),
                                            async () => {
                                              await deleteCategoryFolder(folder.folder_id);
                                            }
                                          );
                                        }}
                                        title={t('deleteFolderTooltip')}
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  </div>

                                  {!isCollapsed && (
                                    <div className="ple-folder-card-body">
                                      {folderBlocks.length === 0 ? (
                                        <div className="ple-folder-empty-hint">{t('folderEmptyHint')}</div>
                                      ) : (
                                        folderBlocks.map((block) => {
                                          const origIndex = (combinedBlocks || []).findIndex(b => b.id === block.id);
                                          const blockId = block.type === 'native' ? block.id : `link:${block.linkId}`;
                                          const isMarked = markedCategoryId === blockId;
                                          return (
                                            <CategoryBlockCard
                                              key={block.id}
                                              playlistId={playlistId}
                                              block={block}
                                              sources={sources}
                                              folders={categoryFolders}
                                              index={origIndex}
                                              isDragging={false}
                                              isDragOver={false}
                                              isMarked={isMarked}
                                              onMark={() => setMarkedCategoryId(prev => prev === blockId ? null : blockId)}
                                              onPointerDown={() => {}}
                                              onRemove={block.type === 'link' ? () => removeCategoryFromPlaylist(block.linkId) : undefined}
                                              showHidden={showHidden}
                                            />
                                          );
                                        })
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}

                            {/* Root Level Categories */}
                            {(() => {
                              const rootBlocks = (combinedBlocks || []).filter(b => {
                                const fId = b.type === 'link' ? b.link.folder_id : b.category.folder_id;
                                return !fId || !categoryFolders.some((f: CategoryFolder) => f.folder_id === fId);
                              });
                              if (rootBlocks.length === 0) return null;
                              return (
                                <div className="ple-section-category-links">
                                  {categoryFolders.length > 0 && <h4 style={{ margin: '8px 0', fontSize: '0.8rem', color: 'rgba(255,255,255,0.6)' }}>{t('rootCategories')}</h4>}
                                  {rootBlocks.map((block) => {
                                    const origIndex = (combinedBlocks || []).findIndex(b => b.id === block.id);
                                    const blockId = block.type === 'native' ? block.id : `link:${block.linkId}`;
                                    const isMarked = markedCategoryId === blockId;
                                    return (
                                      <CategoryBlockCard
                                        key={block.id}
                                        playlistId={playlistId}
                                        block={block}
                                        sources={sources}
                                        folders={categoryFolders}
                                        index={origIndex}
                                        isDragging={false}
                                        isDragOver={false}
                                        isMarked={isMarked}
                                        onMark={() => setMarkedCategoryId(prev => prev === blockId ? null : blockId)}
                                        onPointerDown={() => {}}
                                        onRemove={block.type === 'link' ? () => removeCategoryFromPlaylist(block.linkId) : undefined}
                                        showHidden={showHidden}
                                      />
                                    );
                                  })}
                                </div>
                              );
                            })()}
                          </>
                        ) : (
                          combinedBlocks && combinedBlocks.length > 0 && (
                            <div className="ple-section-category-links">
                              {combinedBlocks.map((block, index) => {
                                const blockId = block.type === 'native' ? block.id : `link:${block.linkId}`;
                                const isMarked = markedCategoryId === blockId;

                                return (
                                  <CategoryBlockCard
                                    key={block.id}
                                    playlistId={playlistId}
                                    block={block}
                                    sources={sources}
                                    folders={categoryFolders}
                                    index={index}
                                    isDragging={false}
                                    isDragOver={false}
                                    isMarked={isMarked}
                                    onMark={() => setMarkedCategoryId(prev => prev === blockId ? null : blockId)}
                                    onPointerDown={() => {}}
                                    onRemove={block.type === 'link' ? () => removeCategoryFromPlaylist(block.linkId) : undefined}
                                    showHidden={showHidden}
                                  />
                                );
                              })}
                            </div>
                          )
                        )}
                      </SortableContext>
                    </DndContext>

                  {/* Individual Channels Section */}
                  {individualChannels && individualChannels.length > 0 && visibleIndivCount > 0 && (
                    <DndContext
                      sensors={pleSensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleIndivDragEnd}
                    >
                      <SortableContext
                        items={(individualChannels || []).map((ch) => ch.stream_id)}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="ple-indiv-section">
                          <div className="ple-indiv-header">
                            <h4><MovieIcon size={16} /> Individual Channels ({visibleIndivCount})</h4>
                          </div>

                          <div className="ple-indiv-list">
                            {individualChannels.map((ch, index) => (
                              <SortableIndivChannelCard
                                key={ch.stream_id}
                                ch={ch}
                                index={index}
                                sources={sources}
                                playlistId={playlistId}
                                showHidden={showHidden}
                                toggleChannelEnabledGlobal={toggleChannelEnabledGlobal}
                              />
                            ))}
                          </div>
                        </div>
                      </SortableContext>
                    </DndContext>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <ModalComponent />
    </div>,
    document.body
  );
}
