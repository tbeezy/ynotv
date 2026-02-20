import React, { useState, useEffect, useRef, useCallback } from 'react';
import { db, type StoredChannel } from '../../db';
import './FavoriteManager.css';

interface FavoriteManagerProps {
    onClose: () => void;
    onChange?: () => void;
}

export function FavoriteManager({ onClose, onChange }: FavoriteManagerProps) {
    const [favorites, setFavorites] = useState<StoredChannel[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [isDirty, setIsDirty] = useState(false);

    // Container-level pointer drag (same pattern as CategoryManager / CustomGroupManager)
    const dragFromIdx = useRef<number | null>(null);
    const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const getIndexFromClientY = (clientY: number): number => {
        if (!listRef.current) return 0;
        const children = Array.from(listRef.current.children) as HTMLElement[];
        for (let i = 0; i < children.length; i++) {
            const rect = children[i].getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) return i;
        }
        return Math.max(0, children.length - 1);
    };

    useEffect(() => {
        let isMounted = true;
        async function load() {
            try {
                const all = await db.channels
                    .whereRaw('(is_favorite = 1 OR is_favorite = true)', [])
                    .toArray();
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
    }, []);

    // Pointer drag handlers — on container
    const handleHandlePointerDown = useCallback((e: React.PointerEvent, index: number) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragFromIdx.current = index;
        setDragOverIdx(index);
    }, []);

    const handleContainerPointerMove = useCallback((e: React.PointerEvent) => {
        if (dragFromIdx.current === null) return;
        e.preventDefault();
        setDragOverIdx(getIndexFromClientY(e.clientY));
    }, []);

    const handleContainerPointerUp = useCallback((e: React.PointerEvent) => {
        if (dragFromIdx.current === null) return;
        const from = dragFromIdx.current;
        const to = getIndexFromClientY(e.clientY);
        dragFromIdx.current = null;
        setDragOverIdx(null);
        if (from === to) return;
        setFavorites(prev => {
            const next = [...prev];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            return next;
        });
        setIsDirty(true);
    }, []);

    const handleContainerPointerCancel = useCallback(() => {
        dragFromIdx.current = null;
        setDragOverIdx(null);
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

    const handleSave = useCallback(async () => {
        setSaving(true);
        try {
            await db.transaction('rw', [db.channels], async () => {
                for (let i = 0; i < favorites.length; i++) {
                    await db.channels.update(favorites[i].stream_id, { fav_order: i });
                }
            });
            if (onChange) onChange();
            onClose();
        } catch (e) {
            console.error('Failed to save favorite order:', e);
            alert('Failed to save. Please try again.');
        } finally {
            setSaving(false);
        }
    }, [favorites, onChange, onClose]);

    return (
        <div className="fav-manager-overlay" onClick={onClose}>
            <div className="fav-manager-modal" onClick={e => e.stopPropagation()}>

                <div className="fav-manager-header">
                    <h2>⭐ Manage Favorites</h2>
                    <button className="close-btn" onClick={onClose}>✕</button>
                </div>

                <div className="fav-manager-stats">
                    {favorites.length} favorite{favorites.length !== 1 ? 's' : ''} · drag ⋮⋮ to reorder
                </div>

                {loading
                    ? <div className="fav-manager-empty">Loading…</div>
                    : favorites.length === 0
                        ? <div className="fav-manager-empty">No favorites yet — star a channel in the EPG first.</div>
                        : (
                            <div
                                className="fav-manager-list"
                                ref={listRef}
                                onPointerMove={handleContainerPointerMove}
                                onPointerUp={handleContainerPointerUp}
                                onPointerCancel={handleContainerPointerCancel}
                            >
                                {favorites.map((ch, index) => {
                                    const isDragging = dragFromIdx.current === index;
                                    const isDragOver = dragOverIdx === index && dragFromIdx.current !== null && dragFromIdx.current !== index;
                                    return (
                                        <div
                                            key={ch.stream_id}
                                            className={`fav-manager-item${isDragging ? ' dragging' : ''}${isDragOver ? ' drag-over' : ''}`}
                                        >
                                            <span
                                                className="drag-handle"
                                                style={{ touchAction: 'none' }}
                                                onPointerDown={e => handleHandlePointerDown(e, index)}
                                            >⋮⋮</span>
                                            {ch.stream_icon
                                                ? <img src={ch.stream_icon} className="fav-ch-logo" alt="" />
                                                : <span className="fav-ch-logo-placeholder">📺</span>
                                            }
                                            <span className="fav-ch-name">{ch.name}</span>
                                            <button
                                                className="fav-remove-btn"
                                                onClick={() => handleRemoveFavorite(ch.stream_id)}
                                                title="Remove from favorites"
                                            >✕</button>
                                        </div>
                                    );
                                })}
                            </div>
                        )
                }

                <div className="fav-manager-footer">
                    <button className="cancel-btn" onClick={onClose}>Cancel</button>
                    <button className="save-btn" onClick={handleSave} disabled={!isDirty || saving}>
                        {saving ? 'Saving…' : 'Save Order'}
                    </button>
                </div>

            </div>
        </div>
    );
}
