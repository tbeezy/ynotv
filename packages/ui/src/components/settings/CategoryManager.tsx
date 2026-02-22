import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from '../../hooks/useSqliteLiveQuery';
import { db, type StoredCategory, updateCategoriesBatch } from '../../db';
import { ChannelManager } from './ChannelManager';
import './CategoryManager.css';

interface CategoryManagerProps {
    sourceId: string;
    sourceName: string;
    onClose: () => void;
    onChange?: () => void;
}

export function CategoryManager({ sourceId, sourceName, onClose, onChange }: CategoryManagerProps) {
    const [categories, setCategories] = useState<StoredCategory[]>([]);
    const [isDirty, setIsDirty] = useState(false);
    const [hideUnselected, setHideUnselected] = useState(false);
    const [managingCategory, setManagingCategory] = useState<{ id: string; name: string } | null>(null);
    const isSavingRef = useRef(false);

    // Pointer-event drag state
    const dragFromIdx = useRef<number | null>(null);
    const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // Compute which list-item index a clientY falls into
    const getIndexFromClientY = (clientY: number): number => {
        if (!listRef.current) return 0;
        const children = Array.from(listRef.current.children) as HTMLElement[];
        for (let i = 0; i < children.length; i++) {
            const rect = children[i].getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) return i;
        }
        return Math.max(0, children.length - 1);
    };

    // Load categories for this source
    const dbCategories = useLiveQuery(
        () => db.categories.where('source_id').equals(sourceId).toArray()
    );

    // Initialize categories from database (but not while saving)
    useEffect(() => {
        if (dbCategories && !isSavingRef.current) {
            // Sort by display_order if available, otherwise by category_name
            const sorted = [...dbCategories].sort((a, b) => {
                if (a.display_order !== undefined && b.display_order !== undefined) {
                    return a.display_order - b.display_order;
                }
                if (a.display_order !== undefined) return -1;
                if (b.display_order !== undefined) return 1;
                return a.category_name.localeCompare(b.category_name);
            });

            // Set display_order if not set (use sorted index)
            const categoriesWithOrder = sorted.map((cat, idx) => ({
                ...cat,
                display_order: cat.display_order ?? idx,
                enabled: cat.enabled !== false, // Default to true
            }));
            setCategories(categoriesWithOrder);
            setIsDirty(false);
        }
    }, [dbCategories]);

    // Toggle enable/disable
    const toggleCategory = useCallback((categoryId: string) => {
        setCategories(cats => cats.map(cat =>
            cat.category_id === categoryId ? { ...cat, enabled: !cat.enabled } : cat
        ));
        setIsDirty(true);
    }, []);

    // Move category up
    const moveUp = useCallback((index: number) => {
        if (index === 0) return;
        setCategories(cats => {
            const newCats = [...cats];
            [newCats[index - 1], newCats[index]] = [newCats[index], newCats[index - 1]];
            // Update display_order for all
            return newCats.map((cat, idx) => ({ ...cat, display_order: idx }));
        });
        setIsDirty(true);
    }, []);

    // Move category down
    const moveDown = useCallback((index: number) => {
        setCategories(cats => {
            if (index === cats.length - 1) return cats;
            const newCats = [...cats];
            [newCats[index], newCats[index + 1]] = [newCats[index + 1], newCats[index]];
            // Update display_order for all
            return newCats.map((cat, idx) => ({ ...cat, display_order: idx }));
        });
        setIsDirty(true);
    }, []);

    // Pointer-event drag handlers — attached to the CONTAINER, not individual items
    // This avoids the pointer-capture trap where captured events only reach the handle element
    const handleHandlePointerDown = useCallback((e: React.PointerEvent, index: number) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragFromIdx.current = index;
        setDragOverIdx(index);
    }, []);

    const handleContainerPointerMove = useCallback((e: React.PointerEvent) => {
        if (dragFromIdx.current === null) return;
        e.preventDefault();
        const idx = getIndexFromClientY(e.clientY);
        setDragOverIdx(idx);
    }, []);

    const handleContainerPointerUp = useCallback((e: React.PointerEvent) => {
        if (dragFromIdx.current === null) return;
        const from = dragFromIdx.current;
        const to = getIndexFromClientY(e.clientY);
        dragFromIdx.current = null;
        setDragOverIdx(null);
        if (from === to) return;
        setCategories(cats => {
            const newCats = [...cats];
            const [removed] = newCats.splice(from, 1);
            newCats.splice(to, 0, removed);
            return newCats.map((cat, idx) => ({ ...cat, display_order: idx }));
        });
        setIsDirty(true);
    }, []);

    const handleContainerPointerCancel = useCallback(() => {
        dragFromIdx.current = null;
        setDragOverIdx(null);
    }, []);

    // Select all
    const handleSelectAll = useCallback(() => {
        setCategories(cats => cats.map(cat => ({ ...cat, enabled: true })));
        setIsDirty(true);
    }, []);

    // Select none
    const handleSelectNone = useCallback(() => {
        setCategories(cats => cats.map(cat => ({ ...cat, enabled: false })));
        setIsDirty(true);
    }, []);

    // Save changes
    const handleSave = useCallback(async () => {
        try {
            // Mark that we're saving to prevent useEffect from resetting state
            isSavingRef.current = true;

            // Save ALL categories with their current state
            const updates = categories.map(cat => ({
                categoryId: cat.category_id,
                enabled: cat.enabled ?? true,
                displayOrder: cat.display_order ?? 0
            }));

            const result = await updateCategoriesBatch(updates);

            // Wait for database to commit
            await new Promise(resolve => setTimeout(resolve, 300));

            // Trigger UI refresh
            if (onChange) {
                await onChange();
            }

            onClose();
        } catch (err) {
            console.error('[CategoryManager] Failed to save:', err);
            alert('Failed to save changes. Please try again.');
            isSavingRef.current = false;
        }
    }, [categories, onChange, onClose]);

    // Get visible categories based on filter
    const visibleCategories = useMemo(() => {
        return hideUnselected
            ? categories.filter(c => c.enabled !== false)
            : categories;
    }, [categories, hideUnselected]);

    const modalContent = (
        <div className="category-manager-overlay" onClick={onClose}>
            <div className="category-manager-modal" onClick={e => e.stopPropagation()}>
                <div className="category-manager-header">
                    <h2>Manage Categories - {sourceName}</h2>
                    <button className="close-btn" onClick={onClose}>✕</button>
                </div>

                <div className="category-manager-actions">
                    <button onClick={handleSelectAll}>✓ Select All</button>
                    <button onClick={handleSelectNone}>✗ Select None</button>
                    <div className="divider-vertical"></div>
                    <button
                        onClick={() => setHideUnselected(!hideUnselected)}
                        className={hideUnselected ? 'active-toggle' : ''}
                    >
                        {hideUnselected ? '👁 Show All' : '👁‍🗨 Hide Unselected'}
                    </button>
                </div>

                <div
                    className="category-list"
                    ref={listRef}
                    onPointerMove={handleContainerPointerMove}
                    onPointerUp={handleContainerPointerUp}
                    onPointerCancel={handleContainerPointerCancel}
                >
                    {visibleCategories.map((cat) => {
                        const index = categories.findIndex(c => c.category_id === cat.category_id);
                        const isDragging = dragFromIdx.current === index;
                        const isDragOver = dragOverIdx === index && dragFromIdx.current !== null && dragFromIdx.current !== index;

                        return (
                            <div
                                key={cat.category_id}
                                className={`category-item ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
                            >
                                <span
                                    className="drag-handle"
                                    style={{ touchAction: 'none' }}
                                    onPointerDown={(e) => handleHandlePointerDown(e, index)}
                                >
                                    ⋮⋮
                                </span>

                                <label className="category-checkbox">
                                    <input
                                        type="checkbox"
                                        checked={cat.enabled}
                                        onChange={() => toggleCategory(cat.category_id)}
                                    />
                                    <span className="category-name">{cat.category_name}</span>
                                </label>

                                <button
                                    className="manage-channels-btn"
                                    onClick={() => setManagingCategory({ id: cat.category_id, name: cat.category_name })}
                                    title="Manage channels in this category"
                                >
                                    📺 Channels
                                </button>

                                <div className="category-reorder">
                                    <button
                                        className="order-btn"
                                        onClick={() => moveUp(index)}
                                        disabled={index === 0}
                                        title="Move up"
                                    >
                                        ↑
                                    </button>
                                    <button
                                        className="order-btn"
                                        onClick={() => moveDown(index)}
                                        disabled={index === categories.length - 1}
                                        title="Move down"
                                    >
                                        ↓
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>

                <div className="category-manager-footer">
                    <button className="cancel-btn" onClick={onClose}>Cancel</button>
                    <button
                        className="save-btn"
                        onClick={handleSave}
                        disabled={!isDirty}
                    >
                        Save Changes
                    </button>
                </div>

                {managingCategory && (
                    <ChannelManager
                        categoryId={managingCategory.id}
                        categoryName={managingCategory.name}
                        sourceId={sourceId}
                        onClose={() => setManagingCategory(null)}
                        onChange={onChange}
                    />
                )}
            </div>
        </div>
    );

    return createPortal(modalContent, document.body);
}
