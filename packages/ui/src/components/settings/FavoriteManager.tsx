import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { db, type StoredChannel, updateChannelsBatch, setFavoriteSourceOrder, getFavoriteSourceOrder } from '../../db';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import './FavoriteManager.css';

interface FavoriteManagerProps {
    onClose: () => void;
    onChange?: () => void;
    sourceId?: string | null;
}

interface SortableFavoriteItemProps {
    channel: StoredChannel;
    onRemove: (streamId: string) => void;
    dropIndicator?: 'above' | 'below' | null;
}

// Whole card is the drag surface — no handle. Interactive controls inside stop
// pointer propagation so they never start a drag.
function SortableFavoriteItem({ channel, onRemove, dropIndicator = null }: SortableFavoriteItemProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: channel.stream_id });

    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 99 : 1,
        touchAction: 'none',
    };

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`fav-manager-item${isDragging ? ' dragging' : ''}${dropIndicator ? ` drop-${dropIndicator}` : ''}`}
            {...attributes}
            {...listeners}
        >
            {channel.stream_icon
                ? <img src={channel.stream_icon} className="fav-ch-logo" alt="" />
                : <span className="fav-ch-logo-placeholder">📺</span>
            }
            <span className="fav-ch-name">{channel.name}</span>
            <button
                className="fav-remove-btn"
                onClick={() => onRemove(channel.stream_id)}
                onPointerDown={(e) => e.stopPropagation()}
                title={i18n.t('settings:favoriteManager.removeFromFavorites')}
            >✕</button>
        </div>
    );
}

export function FavoriteManager({ onClose, onChange, sourceId = null }: FavoriteManagerProps) {
    useTranslation();
    const [favorites, setFavorites] = useState<StoredChannel[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [isDirty, setIsDirty] = useState(false);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [overId, setOverId] = useState<string | null>(null);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    useEffect(() => {
        let isMounted = true;
        async function load() {
            try {
                const all = sourceId
                    ? await db.channels
                        .whereRaw('(is_favorite = 1 OR is_favorite = true) AND source_id = ?', [sourceId])
                        .toArray()
                    : await db.channels
                        .whereRaw('(is_favorite = 1 OR is_favorite = true)', [])
                        .toArray();
                // Per-source: reflect the saved per-source order (if any) instead of the global order.
                if (sourceId) {
                    const savedOrder = await getFavoriteSourceOrder(sourceId);
                    if (savedOrder.length > 0) {
                        const byId = new Map(all.map(ch => [ch.stream_id, ch]));
                        const ordered: StoredChannel[] = [];
                        for (const id of savedOrder) {
                            const ch = byId.get(id);
                            if (ch) { ordered.push(ch); byId.delete(id); }
                        }
                        const remaining = Array.from(byId.values()).sort((a, b) => {
                            if (a.fav_order != null && b.fav_order != null) return a.fav_order - b.fav_order;
                            if (a.fav_order != null) return -1;
                            if (b.fav_order != null) return 1;
                            return a.name.localeCompare(b.name);
                        });
                        if (isMounted) { setFavorites([...ordered, ...remaining]); setLoading(false); }
                        return;
                    }
                }
                // Sort by fav_order (nulls last, then by name)
                all.sort((a, b) => {
                    if (a.fav_order != null && b.fav_order != null) return a.fav_order - b.fav_order;
                    if (a.fav_order != null) return -1;
                    if (b.fav_order != null) return 1;
                    return a.name.localeCompare(b.name);
                });
                if (isMounted) { setFavorites(all); setLoading(false); }
            } catch (e) {
                console.error('Failed to load favorites:', e);
                if (isMounted) setLoading(false);
            }
        }
        load();
        return () => { isMounted = false; };
    }, [sourceId]);

    const handleDragStart = useCallback((event: DragStartEvent) => {
        setActiveId(String(event.active.id));
    }, []);

    const handleDragOver = useCallback((event: DragOverEvent) => {
        if (event.over && event.active.id !== event.over.id) {
            setOverId(String(event.over.id));
        } else {
            setOverId(null);
        }
    }, []);

    const handleDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        setActiveId(null);
        setOverId(null);
        if (!over || active.id === over.id) return;
        setFavorites(prev => {
            const oldIndex = prev.findIndex(c => c.stream_id === active.id);
            const newIndex = prev.findIndex(c => c.stream_id === over.id);
            if (oldIndex === -1 || newIndex === -1) return prev;
            return arrayMove(prev, oldIndex, newIndex);
        });
        setIsDirty(true);
    }, []);

    const handleDragCancel = useCallback(() => {
        setActiveId(null);
        setOverId(null);
    }, []);

    const handleRemoveFavorite = useCallback(async (streamId: string) => {
        // Optimistic UI
        setFavorites(prev => prev.filter(c => c.stream_id !== streamId));
        setIsDirty(true);
        try {
            await db.channels.update(streamId, { is_favorite: false, fav_order: undefined });
        } catch (e) {
            console.error('Failed to remove favorite:', e);
        }
    }, []);

    const handleSortABC = useCallback(() => {
        setFavorites(prev => {
            const sorted = [...prev].sort((a, b) => {
                const nameA = (a.alias || a.name || '').trim();
                const nameB = (b.alias || b.name || '').trim();
                return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
            });
            return sorted;
        });
        setIsDirty(true);
    }, []);

    const handleSave = useCallback(async () => {
        setSaving(true);
        try {
            if (sourceId) {
                // Per-source ordering is stored independently from the global order.
                await setFavoriteSourceOrder(sourceId, favorites.map(ch => ch.stream_id));
            } else {
                const updates = favorites.map((ch, i) => ({ streamId: ch.stream_id, favOrder: i }));
                if (updates.length > 0) {
                    await updateChannelsBatch(updates);
                }
            }
            if (onChange) onChange();
            onClose();
        } catch (e) {
            console.error('Failed to save favorite order:', e);
            alert(i18n.t('settings:favoriteManager.errSave'));
        } finally {
            setSaving(false);
        }
    }, [favorites, onChange, onClose, sourceId]);

    return createPortal(
        <div className="fav-manager-overlay" onClick={onClose}>
            <div className="fav-manager-modal" onClick={e => e.stopPropagation()}>

                <div className="fav-manager-header">
                    <h2>⭐ {i18n.t('settings:favoriteManager.manageTitle')}</h2>
                    <button className="close-btn" onClick={onClose}>✕</button>
                </div>

                <div className="fav-manager-stats" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>{i18n.t('settings:favoriteManager.countLabel', { count: favorites.length })} · {i18n.t('settings:favoriteManager.dragToReorder')}</span>
                    <button
                        onClick={handleSortABC}
                        title={i18n.t('settings:favoriteManager.sortAZHint')}
                        style={{
                            padding: '3px 10px',
                            fontSize: '0.8rem',
                            background: 'var(--surface-color, rgba(255,255,255,0.08))',
                            border: '1px solid var(--glass-border, rgba(255,255,255,0.15))',
                            borderRadius: '4px',
                            color: 'var(--text-primary, #fff)',
                            cursor: 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px'
                        }}
                    >
                        🔤 {i18n.t('common:sortAZ')}
                    </button>
                </div>

                {loading
                    ? <div className="fav-manager-empty">{i18n.t('common:loading')}</div>
                    : favorites.length === 0
                        ? <div className="fav-manager-empty">{i18n.t('settings:favoriteManager.noFavorites')}</div>
                        : (
                            <DndContext
                                sensors={sensors}
                                collisionDetection={closestCenter}
                                onDragStart={handleDragStart}
                                onDragOver={handleDragOver}
                                onDragEnd={handleDragEnd}
                                onDragCancel={handleDragCancel}
                            >
                                <SortableContext
                                    items={favorites.map(ch => ch.stream_id)}
                                    strategy={verticalListSortingStrategy}
                                >
                                    <div className="fav-manager-list">
                                        {favorites.map(ch => {
                                            const activeIndex = activeId ? favorites.findIndex(c => c.stream_id === activeId) : -1;
                                            const overIndex = overId ? favorites.findIndex(c => c.stream_id === overId) : -1;
                                            const isOver = overId === ch.stream_id && activeId !== overId;
                                            const dropIndicator = isOver ? (activeIndex < overIndex ? 'below' : 'above') : null;
                                            return (
                                                <SortableFavoriteItem
                                                    key={ch.stream_id}
                                                    channel={ch}
                                                    onRemove={handleRemoveFavorite}
                                                    dropIndicator={dropIndicator}
                                                />
                                            );
                                        })}
                                    </div>
                                </SortableContext>
                            </DndContext>
                        )
                }

                <div className="fav-manager-footer">
                    <button className="cancel-btn" onClick={onClose}>{i18n.t('common:cancel')}</button>
                    <button className="save-btn" onClick={handleSave} disabled={!isDirty || saving}>
                        {saving ? i18n.t('common:saving') : i18n.t('settings:favoriteManager.saveOrder')}
                    </button>
                </div>

            </div>
        </div>,
        document.body
    );
}
