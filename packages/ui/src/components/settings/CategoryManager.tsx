import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [dragOverId, setDragOverId] = useState<string | null>(null);
    const [managingCategory, setManagingCategory] = useState<{ id: string; name: string } | null>(null);
    const isSavingRef = useRef(false);

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

    // Drag and Drop Handlers
    const handleDragStart = useCallback((e: React.DragEvent, categoryId: string) => {
        setDraggingId(categoryId);
        e.dataTransfer.effectAllowed = 'move';
        // Set drag data
        e.dataTransfer.setData('text/plain', categoryId);
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent, categoryId: string) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOverId(categoryId);
    }, []);

    const handleDragLeave = useCallback(() => {
        setDragOverId(null);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
        e.preventDefault();
        setDragOverId(null);
        
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId || draggedId === targetId) {
            setDraggingId(null);
            return;
        }

        setCategories(cats => {
            const draggedIndex = cats.findIndex(c => c.category_id === draggedId);
            const targetIndex = cats.findIndex(c => c.category_id === targetId);
            
            if (draggedIndex === -1 || targetIndex === -1) return cats;

            const newCats = [...cats];
            const [removed] = newCats.splice(draggedIndex, 1);
            newCats.splice(targetIndex, 0, removed);
            
            // Update display_order for all
            return newCats.map((cat, idx) => ({ ...cat, display_order: idx }));
        });
        
        setDraggingId(null);
        setIsDirty(true);
    }, []);

    const handleDragEnd = useCallback(() => {
        setDraggingId(null);
        setDragOverId(null);
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

    return (
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

                <div className="category-list">
                    {visibleCategories.map((cat) => {
                        const index = categories.findIndex(c => c.category_id === cat.category_id);
                        const isDragging = draggingId === cat.category_id;
                        const isDragOver = dragOverId === cat.category_id;

                        return (
                            <div
                                key={cat.category_id}
                                className={`category-item ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
                                onDragOver={(e) => handleDragOver(e, cat.category_id)}
                                onDragLeave={handleDragLeave}
                                onDrop={(e) => handleDrop(e, cat.category_id)}
                            >
                                <span
                                    className="drag-handle"
                                    title="Drag to reorder"
                                    draggable={true}
                                    onDragStart={(e) => handleDragStart(e, cat.category_id)}
                                    onDragEnd={handleDragEnd}
                                >
                                    ☰
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
}
