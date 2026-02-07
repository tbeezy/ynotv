import React, { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type StoredCategory, updateCategoriesBatch } from '../../db';
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
    const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

    // Load categories for this source
    const dbCategories = useLiveQuery(
        () => db.categories.where('source_id').equals(sourceId).toArray()
    );

    useEffect(() => {
        if (dbCategories) {
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
        }
    }, [dbCategories]);

    // Toggle enable/disable
    function toggleCategory(categoryId: string) {
        setCategories(cats => cats.map(cat =>
            cat.category_id === categoryId ? { ...cat, enabled: !cat.enabled } : cat
        ));
        setIsDirty(true);
    }

    // Move category up
    function moveUp(index: number) {
        if (index === 0) return;
        const newCategories = [...categories];
        [newCategories[index - 1], newCategories[index]] = [newCategories[index], newCategories[index - 1]];
        // Update display_order
        newCategories.forEach((cat, idx) => {
            cat.display_order = idx;
        });
        setCategories(newCategories);
        setIsDirty(true);
    }

    // Move category down
    function moveDown(index: number) {
        if (index === categories.length - 1) return;
        const newCategories = [...categories];
        [newCategories[index], newCategories[index + 1]] = [newCategories[index + 1], newCategories[index]];
        // Update display_order
        newCategories.forEach((cat, idx) => {
            cat.display_order = idx;
        });
        setCategories(newCategories);
        setIsDirty(true);
    }

    // Drag and Drop Handlers
    function handleDragStart(e: React.DragEvent, index: number) {
        setDraggingIndex(index);
        e.dataTransfer.effectAllowed = 'move';
        // Set drag image opacity or other styles if needed
    }

    function handleDragOver(e: React.DragEvent, index: number) {
        e.preventDefault(); // Necessary to allow dropping
        e.dataTransfer.dropEffect = 'move';

        if (draggingIndex === null || draggingIndex === index) return;

        // Perform the swap immediately for smoother feedback
        const newCategories = [...categories];
        const draggedItem = newCategories[draggingIndex];

        // Remove from old position
        newCategories.splice(draggingIndex, 1);
        // Insert at new position
        newCategories.splice(index, 0, draggedItem);

        // Update display order
        newCategories.forEach((cat, idx) => {
            cat.display_order = idx;
        });

        setCategories(newCategories);
        setDraggingIndex(index); // Update dragging index to new position
        setIsDirty(true);
    }

    function handleDragEnd() {
        setDraggingIndex(null);
    }

    // Select all
    function handleSelectAll() {
        setCategories(cats => cats.map(cat => ({ ...cat, enabled: true })));
        setIsDirty(true);
    }

    // Select none
    function handleSelectNone() {
        setCategories(cats => cats.map(cat => ({ ...cat, enabled: false })));
        setIsDirty(true);
    }

    // Save changes
    async function handleSave() {
        try {
            // Batch all updates into a single transaction
            const updates = categories.map(cat => ({
                categoryId: cat.category_id,
                enabled: cat.enabled ?? true,
                displayOrder: cat.display_order ?? 0
            }));

            await updateCategoriesBatch(updates);

            // Small delay to let database update
            await new Promise(resolve => setTimeout(resolve, 100));

            // Trigger UI refresh
            if (onChange) onChange();

            onClose();
        } catch (err) {
            console.error('Failed to save category changes:', err);
        }
    }

    // Filter categories based on hideUnselected state
    const visibleCategories = hideUnselected
        ? categories.filter(c => c.enabled !== false)
        : categories;

    // We keep track of original indices to support reordering even when filtered?
    // Actually, reordering should probably be disabled when filtered to avoid confusion.
    // Let's map visible categories back to their index in the full list if needed,
    // OR simply disable drag/drop when hiding unselected.
    // Disabling D&D when filtered is safer ux.

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
                        // Find the actual index in the full list for updates
                        const index = categories.findIndex(c => c.category_id === cat.category_id);

                        return (
                            <div
                                key={cat.category_id}
                                className={`category-item ${draggingIndex === index ? 'dragging' : ''}`}
                                draggable={true}
                                onDragStart={(e) => handleDragStart(e, index)}
                                onDragOver={(e) => handleDragOver(e, index)}
                                onDragEnd={() => handleDragEnd()}
                            >
                                <span
                                    className="drag-handle"
                                    title="Drag to reorder"
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
            </div>
        </div>
    );
}
