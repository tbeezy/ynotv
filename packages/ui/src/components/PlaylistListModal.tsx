import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { translateNativeError } from '../i18n';
import { createPortal } from 'react-dom';
import { useLiveQuery } from '../hooks/useSqliteLiveQuery';
import { db, type CustomPlaylist } from '../db';
import {
  createPlaylist,
  deletePlaylist,
  renamePlaylist,
  reorderPlaylists,
  revertRealSourceToDefault,
} from '../services/playlist-editor';
import { PlaylistEditorModal } from './PlaylistEditorModal';
import { useModal } from './Modal';
import './PlaylistListModal.css';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const PlaylistIcon = ({ size = 16 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' }}>
    <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10H7v-2h10v2zm0-4H7V7h10v2zm0 8H7v-2h10v2z"/>
  </svg>
);

const PlusIcon = ({ size = 14 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '4px' }}>
    <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
  </svg>
);

const EditIcon = ({ size = 12 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '4px' }}>
    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
  </svg>
);

const RevertIcon = ({ size = 12 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '4px' }}>
    <path d="M12 5V2L8 6l4 4V7c3.31 0 6 2.69 6 6 0 2.97-2.17 5.43-5 5.91v2.02c3.95-.49 7-3.85 7-8.22 0-4.42-3.58-8-8-8zm-6 8c0-2.97 2.17-5.43 5-5.91V5.07c-3.95.49-7 3.85-7 8.22 0 4.42 3.58 8 8 8v-3c-3.31 0-6-2.69-6-6z"/>
  </svg>
);

const RenameIcon = ({ size = 12 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '4px' }}>
    <path d="M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm12.01-1.89l.71-.71a.996.996 0 0 1 1.41 0l.71.71c.39.39.39 1.02 0 1.41l-.71.71-2.12-2.12zm-.71.71L9 14.25V17h2.75l5.37-5.37-2.13-2.12z"/>
  </svg>
);

const ExportIcon = ({ size = 12 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '4px' }}>
    <path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6-4.67V17h-2V7.33L8.41 9.92 7 8.5l5-5 5 5-1.41 1.42L13 7.33z"/>
  </svg>
);

const TrashIcon = ({ size = 14 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
  </svg>
);

interface ManagerItem {
  id: string; // real source ID or 'playlist:uuid'
  type: 'real' | 'playlist';
  name: string;
  playlistId?: string; // original UUID if playlist
  sourceType?: string;
}

interface SortablePlaylistItemProps {
  item: ManagerItem;
  catCount: number;
  indivCount: number;
  playlist?: CustomPlaylist;
  editingId: string | null;
  editName: string;
  editNameInputRef: React.RefObject<HTMLInputElement | null>;
  setEditName: (name: string) => void;
  handleEditKey: (e: React.KeyboardEvent) => void;
  commitEdit: () => void;
  startEdit: (playlist: CustomPlaylist) => void;
  setEditingPlaylist: (p: { id: string; name: string }) => void;
  handleRevert: (id: string, name: string) => void;
  revertingId: string | null;
  handleExport: (id: string, name: string) => void;
  deleteConfirmId: string | null;
  setDeleteConfirmId: (id: string | null) => void;
  handleDelete: (id: string) => void;
  dropIndicator?: 'above' | 'below' | null;
}

function SortablePlaylistItem(props: SortablePlaylistItemProps) {
  const { t } = useTranslation('playlist');
  const {
    item,
    catCount,
    indivCount,
    playlist,
    editingId,
    editName,
    editNameInputRef,
    setEditName,
    handleEditKey,
    commitEdit,
    startEdit,
    setEditingPlaylist,
    handleRevert,
    revertingId,
    handleExport,
    deleteConfirmId,
    setDeleteConfirmId,
    handleDelete,
    dropIndicator = null,
  } = props;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 99 : 1,
    touchAction: 'none',
  };

  if (item.type === 'real') {
    return (
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        className={`pll-item pll-real-source-item${isDragging ? ' dragging' : ''}${dropIndicator ? ` drop-${dropIndicator}` : ''}`}
      >
        <div className="pll-item-main">
          <div className="pll-item-info readonly">
            <span className="pll-item-name">{item.name}</span>
            <span className="pll-item-count source-type-badge">
              {catCount > 0 || indivCount > 0 ? (
                <span className="pll-custom-additions-badge">
                  +{t('linksAndChannels', { count: catCount })} · +{t('individualChannelsCount', { count: indivCount })}
                </span>
              ) : (
                t('mediaSource')
              )}
            </span>
          </div>
          
          <div className="pll-item-actions" onPointerDown={(e) => e.stopPropagation()}>
            <button
              className="pll-action-btn"
              onClick={() => setEditingPlaylist({ id: item.id, name: item.name })}
              title={t('editContents')}
            >
              <EditIcon size={12} />{t('content')}
            </button>
            <button
              className="pll-action-btn pll-danger"
              onClick={() => handleRevert(item.id, item.name)}
              title={t('revertToDefault')}
              disabled={revertingId !== null}
            >
              <RevertIcon size={12} />
              {revertingId === item.id ? t('reverting') : t('revert')}
            </button>
            {item.sourceType !== 'stalker' && (
              <button
                className="pll-action-btn"
                onClick={() => handleExport(item.id, item.name)}
                title={t('exportM3u')}
              >
                <ExportIcon size={12} />{t('export')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const plId = item.playlistId!;
  if (!playlist) return null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`pll-item${isDragging ? ' dragging' : ''}${dropIndicator ? ` drop-${dropIndicator}` : ''}`}
    >
      {editingId === plId ? (
        <div className="pll-edit-row" onPointerDown={(e) => e.stopPropagation()}>
          <input
            ref={editNameInputRef}
            className="pll-edit-input"
            value={editName}
            onChange={e => setEditName(e.target.value)}
            onKeyDown={handleEditKey}
            onBlur={commitEdit}
          />
          <button className="pll-edit-ok" onClick={commitEdit}>✓</button>
        </div>
      ) : (
        <div className="pll-item-main">
          <div className="pll-item-info">
            <span className="pll-item-name">{playlist.name}</span>
            <span className="pll-item-count">
              {t('linksAndChannels', { count: catCount })} · {t('individualChannelsCount', { count: indivCount })}
            </span>
          </div>

          <div className="pll-item-actions" onPointerDown={(e) => e.stopPropagation()}>
            <button
              className="pll-action-btn"
              onClick={() => setEditingPlaylist({ id: plId, name: playlist.name })}
              title={t('editContents')}
            >
              <EditIcon size={12} />{t('content')}
            </button>
            <button
              className="pll-action-btn"
              onClick={() => startEdit(playlist)}
              title={t('rename')}
            >
              <RenameIcon size={12} />{t('rename')}
            </button>
            <button
              className="pll-action-btn"
              onClick={() => handleExport(playlist.playlist_id, playlist.name)}
              title={t('exportM3u')}
            >
              <ExportIcon size={12} />{t('export')}
            </button>

            {deleteConfirmId === plId ? (
              <>
                <button
                  className="pll-action-btn pll-confirm"
                  onClick={() => handleDelete(plId)}
                  title={t('confirmDelete')}
                >✓</button>
                <button
                  className="pll-action-btn"
                  onClick={() => setDeleteConfirmId(null)}
                  title={i18n.t('common:cancel')}
                >✕</button>
              </>
            ) : (
              <button
                className="pll-action-btn pll-danger"
                onClick={() => setDeleteConfirmId(plId)}
                title={i18n.t('common:delete')}
              >
                <TrashIcon size={14} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface PlaylistListModalProps {
  onClose: () => void;
}

export function PlaylistListModal({ onClose }: PlaylistListModalProps) {
  const { t } = useTranslation('playlist');
  const { showConfirm, showSuccess, showError, ModalComponent } = useModal();
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [editingPlaylist, setEditingPlaylist] = useState<{ id: string; name: string } | null>(null);
  const [revertingId, setRevertingId] = useState<string | null>(null);

  const newNameInputRef = useRef<HTMLInputElement>(null);
  const editNameInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Drag state
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [overDragId, setOverDragId] = useState<string | null>(null);

  // Live Query custom playlists
  const playlists = useLiveQuery<CustomPlaylist[]>(
    () => db.customPlaylists.orderBy('display_order').toArray(),
    [],
    []
  ) || [];

  // Live query count of category links per playlist
  const categoryLinkCounts = useLiveQuery(
    async () => {
      const all = await db.playlistCategoryLinks.toArray();
      const counts = new Map<string, number>();
      for (const item of all) {
        counts.set(item.playlist_id, (counts.get(item.playlist_id) || 0) + 1);
      }
      return counts;
    },
    [],
    new Map<string, number>()
  );

  // Live query count of individual channels per playlist
  const individualCounts = useLiveQuery(
    async () => {
      const all = await db.playlistIndividualChannels.toArray();
      const counts = new Map<string, number>();
      for (const item of all) {
        counts.set(item.playlist_id, (counts.get(item.playlist_id) || 0) + 1);
      }
      return counts;
    },
    [],
    new Map<string, number>()
  );

  // Load enabled real sources
  const [realSources, setRealSources] = useState<Array<{ id: string; name: string; type: string }>>([]);
  useEffect(() => {
    if (window.storage) {
      window.storage.getSources().then(res => {
        if (res.success && res.data) {
          setRealSources(res.data.filter(s => s.enabled !== false).map(s => ({ id: s.id, name: s.name, type: s.type })));
        }
      });
    }
  }, []);

  // Load unified sidebar order preference
  const sidebarOrderPref = useLiveQuery(
    () => db.prefs.get('sidebar_sources_order'),
    []
  );

  const sidebarSourcesOrder = useMemo(() => {
    if (!sidebarOrderPref?.value) return null;
    try {
      return JSON.parse(sidebarOrderPref.value) as string[];
    } catch {
      return null;
    }
  }, [sidebarOrderPref]);

  interface ManagerItem {
    id: string; // real source ID or 'playlist:uuid'
    type: 'real' | 'playlist';
    name: string;
    playlistId?: string; // original UUID if playlist
    sourceType?: string;
  }

  // Combine real sources and custom playlists
  const combinedItems = useMemo(() => {
    const list: ManagerItem[] = [];
    
    // Add real sources
    for (const src of realSources) {
      list.push({
        id: src.id,
        type: 'real',
        name: src.name,
        sourceType: src.type
      });
    }
    
    // Add custom playlists
    for (const playlist of playlists) {
      list.push({
        id: `playlist:${playlist.playlist_id}`,
        type: 'playlist',
        name: playlist.name,
        playlistId: playlist.playlist_id
      });
    }
    
    // Sort according to sidebarSourcesOrder if it exists
    if (sidebarSourcesOrder) {
      const orderMap = new Map<string, number>(
        sidebarSourcesOrder.map((id: string, index: number) => [id, index] as [string, number])
      );
      list.sort((a, b) => {
        const orderA = orderMap.has(a.id) ? orderMap.get(a.id)! : Number.MAX_SAFE_INTEGER;
        const orderB = orderMap.has(b.id) ? orderMap.get(b.id)! : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        return a.name.localeCompare(b.name);
      });
    }
    
    return list;
  }, [realSources, playlists, sidebarSourcesOrder]);

  // Manage loading state
  useEffect(() => {
    if (playlists) {
      setLoading(false);
    }
  }, [playlists]);

  useEffect(() => {
    if (creating) {
      setTimeout(() => newNameInputRef.current?.focus(), 50);
    }
  }, [creating]);

  useEffect(() => {
    if (editingId) {
      setTimeout(() => editNameInputRef.current?.select(), 50);
    }
  }, [editingId]);

  // --- @dnd-kit Drag and Drop Handlers for Custom Playlists ---
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (event.over && event.active.id !== event.over.id) {
      setOverDragId(String(event.over.id));
    } else {
      setOverDragId(null);
    }
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
    setOverDragId(null);
  }, []);

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    setOverDragId(null);
    if (!over || active.id === over.id || !combinedItems) return;

    const oldIndex = combinedItems.findIndex((item) => item.id === active.id);
    const newIndex = combinedItems.findIndex((item) => item.id === over.id);

    if (oldIndex === -1 || newIndex === -1) return;

    const next = arrayMove(combinedItems, oldIndex, newIndex);
    const orderedIds = next.map(item => item.id);
    try {
      // 1. Save unified sidebar order preference
      await db.prefs.put({
        key: 'sidebar_sources_order',
        value: JSON.stringify(orderedIds)
      });
      
      // 2. Keep customPlaylists display_order sync'd for compatibility
      const playlistsOnly = next.filter(item => item.type === 'playlist');
      for (let i = 0; i < playlistsOnly.length; i++) {
        const plId = playlistsOnly[i].playlistId!;
        await db.customPlaylists.update(plId, { display_order: i });
      }
    } catch (err) {
      console.error('Failed to save sidebar source order:', err);
    }
  };

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      const id = await createPlaylist(trimmed);
      setNewName('');
      setCreating(false);
      setEditingPlaylist({ id, name: trimmed });
    } catch (e) {
      console.error('Failed to create playlist:', e);
    }
  };

  const handleDelete = async (playlistId: string) => {
    try {
      await deletePlaylist(playlistId);
      setDeleteConfirmId(null);
    } catch (e) {
      console.error('Failed to delete playlist:', e);
    }
  };

  const handleRevert = (sourceId: string, sourceName: string) => {
    showConfirm(
      t('revertSourceTitle'),
      t('revertSourceMsg', { name: sourceName }),
      async () => {
        setRevertingId(sourceId);
        try {
          await revertRealSourceToDefault(sourceId);

          // Trigger sync to restore default provider ordering
          if (window.storage) {
            const res = await window.storage.getSources();
            if (res.success && res.data) {
              const source = res.data.find(s => s.id === sourceId);
              if (source) {
                const { syncSource } = await import('../db/sync');
                await syncSource(source);
              }
            }
          }

          showSuccess(t('revertSource'), t('revertSourceSuccess', { name: sourceName }));
        } catch (e) {
          console.error('Failed to revert source to default:', e);
          showError(t('revertSource'), t('revertSourceFailed', { error: translateNativeError(String(e)) || String(e) }));
        } finally {
          setRevertingId(null);
        }
      }
    );
  };

  const startEdit = (playlist: CustomPlaylist) => {
    setEditingId(playlist.playlist_id);
    setEditName(playlist.name);
  };

  const commitEdit = async () => {
    if (!editingId) return;
    const trimmed = editName.trim();
    if (trimmed) {
      try {
        await renamePlaylist(editingId, trimmed);
      } catch (e) {
        console.error('Failed to rename playlist:', e);
      }
    }
    setEditingId(null);
  };

  const handleExport = async (id: string, name: string) => {
    try {
      const { generateM3uForPlaylist } = await import('../services/playlist-export');
      const content = await generateM3uForPlaylist(id);
      const result = await window.storage.saveM3UFile(content, name);
      if (result.success) {
        showSuccess(t('exportPlaylist'), t('playlistExported'));
      }
    } catch (e) {
      console.error('Failed to export playlist:', e);
      showError(t('exportPlaylist'), t('exportFailed', { error: translateNativeError(String(e)) || String(e) }));
    }
  };

  const handleEditKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') setEditingId(null);
  };

  const handleNewNameKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleCreate();
    if (e.key === 'Escape') {
      setCreating(false);
      setNewName('');
    }
  };

  return createPortal(
    <>
      <div className="playlist-list-overlay" onClick={onClose}>
        <div className="playlist-list-modal" onClick={e => e.stopPropagation()}>
          <div className="playlist-list-header">
            <h2><PlaylistIcon size={18} />{t('customPlaylists')}</h2>
            <button className="close-btn" onClick={onClose}>✕</button>
          </div>

          <div className="playlist-list-content">
            <div className="playlist-list-toolbar">
              {!creating ? (
                <button className="pll-create-btn" onClick={() => setCreating(true)}>
                  <PlusIcon size={12} /> {t('createNewPlaylist')}
                </button>
              ) : (
                <div className="pll-create-row">
                  <input
                    ref={newNameInputRef}
                    className="pll-create-input"
                    placeholder={t('playlistNamePlaceholder')}
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={handleNewNameKey}
                    onBlur={() => {
                      if (!newName.trim()) {
                        setCreating(false);
                      }
                    }}
                  />
                  <button className="pll-create-ok" onClick={handleCreate}>{i18n.t('common:create')}</button>
                  <button className="pll-create-cancel" onClick={() => { setCreating(false); setNewName(''); }}>{i18n.t('common:cancel')}</button>
                </div>
              )}
            </div>

            {loading ? (
              <div className="pll-empty">{t('loading')}</div>
            ) : combinedItems.length === 0 ? (
              <div className="pll-empty">
                <p>{t('noPlaylistsFound')}</p>
              </div>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragCancel={handleDragCancel}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={combinedItems.map((item) => item.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="pll-list">
                    {combinedItems.map((item: ManagerItem) => {
                      const plId = item.playlistId || item.id;
                      const catCount = categoryLinkCounts?.get(plId) || 0;
                      const indivCount = individualCounts?.get(plId) || 0;
                      const playlist = item.type === 'playlist' ? playlists.find(p => p.playlist_id === plId) : undefined;

                      const activeIndex = activeDragId ? combinedItems.findIndex(i => i.id === activeDragId) : -1;
                      const overIndex = overDragId ? combinedItems.findIndex(i => i.id === overDragId) : -1;
                      const isOver = overDragId === item.id && activeDragId !== overDragId;
                      const dropIndicator = isOver ? (activeIndex < overIndex ? 'below' : 'above') : null;

                      return (
                        <SortablePlaylistItem
                          key={item.id}
                          item={item}
                          catCount={catCount}
                          indivCount={indivCount}
                          playlist={playlist}
                          editingId={editingId}
                          editName={editName}
                          editNameInputRef={editNameInputRef}
                          setEditName={setEditName}
                          handleEditKey={handleEditKey}
                          commitEdit={commitEdit}
                          startEdit={startEdit}
                          setEditingPlaylist={setEditingPlaylist}
                          handleRevert={handleRevert}
                          revertingId={revertingId}
                          handleExport={handleExport}
                          deleteConfirmId={deleteConfirmId}
                          setDeleteConfirmId={setDeleteConfirmId}
                          handleDelete={handleDelete}
                          dropIndicator={dropIndicator}
                        />
                      );
                    })}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>

          <div className="playlist-list-footer">
            <span className="pll-footer-hint">{t('footerHint')}</span>
            <button className="close-done-btn" onClick={onClose}>{i18n.t('common:done')}</button>
          </div>
        </div>
      </div>

      {editingPlaylist && (
        <PlaylistEditorModal
          playlistId={editingPlaylist.id}
          playlistName={editingPlaylist.name}
          onClose={() => setEditingPlaylist(null)}
        />
      )}
      <ModalComponent />
    </>,
    document.body
  );
}
