import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from '../../hooks/useSqliteLiveQuery';
import { db, type VodCategory } from '../../db';
import '../settings/CategoryManager.css'; // Re-use the same CSS

interface ManageVodCategoriesProps {
    sourceId: string;
    sourceName: string;
    onClose: () => void;
    onChange?: () => void;
}

export function ManageVodCategories({ sourceId, sourceName, onClose, onChange }: ManageVodCategoriesProps) {
    const [categories, setCategories] = useState<VodCategory[]>([]);
    const [activeTab, setActiveTab] = useState<'movie' | 'series'>('movie');
    const [isDirty, setIsDirty] = useState(false);
    const [hideUnselected, setHideUnselected] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const isSavingRef = useRef(false);

    // Pointer-event drag state
    const dragFromIdx = useRef<number | null>(null);
    const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // Load categories for this source
    const dbCategories = useLiveQuery(
        () => db.vodCategories.where('source_id').equals(sourceId).toArray(),
        [sourceId]
    );

    // Initialize categories from database
    useEffect(() => {
        if (dbCategories && !isSavingRef.current) {
            // Sort by display_order if available, otherwise by name
            const sorted = [...dbCategories].sort((a, b) => {
                if (a.display_order !== undefined && b.display_order !== undefined) {
                    return a.display_order - b.display_order;
                }
                if (a.display_order !== undefined) return -1;
                if (b.display_order !== undefined) return 1;
                return a.name.localeCompare(b.name);
            });

            // Set default enabled to true if undefined
            const processed = sorted.map(cat => ({
                ...cat,
                enabled: cat.enabled !== false,
            }));
            
            setCategories(processed);
            setIsDirty(false);
        }
    }, [dbCategories]);

    // Compute which list-item index a clientY falls into among VISIBLE items
    const getIndexFromClientY = (clientY: number): number => {
        if (!listRef.current) return 0;
        const children = Array.from(listRef.current.children) as HTMLElement[];
        for (let i = 0; i < children.length; i++) {
            const rect = children[i].getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2) return i;
        }
        return Math.max(0, children.length - 1);
    };

    // Filter categories by the active tab
    const tabCategories = useMemo(() => {
        return categories.filter(c => c.type === activeTab);
    }, [categories, activeTab]);

    // Filter categories by search and hide
    const visibleCategories = useMemo(() => {
        let filtered = tabCategories;

        if (hideUnselected) {
            filtered = filtered.filter(c => c.enabled !== false);
        }

        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            filtered = filtered.filter(c => c.name.toLowerCase().includes(query));
        }

        return filtered;
    }, [tabCategories, hideUnselected, searchQuery]);

    const enabledCount = tabCategories.filter(c => c.enabled !== false).length;
    const totalCount = tabCategories.length;

    // Toggle a specific category
    const toggleCategory = useCallback((categoryId: string) => {
        setCategories(cats => cats.map(cat =>
            cat.category_id === categoryId ? { ...cat, enabled: !cat.enabled } : cat
        ));
        setIsDirty(true);
    }, []);

    // Reorder operations
    const getGlobalIndex = (categoryId: string) => {
        return categories.findIndex(c => c.category_id === categoryId);
    };

    const reindexTab = (cats: VodCategory[]) => {
        // Only assign display_order for the active tab's items relative to their new position
        const others = cats.filter(c => c.type !== activeTab);
        let currentTabCats = cats.filter(c => c.type === activeTab);
        
        currentTabCats = currentTabCats.map((cat, idx) => ({ ...cat, display_order: idx }));
        return [...others, ...currentTabCats];
    };

    const moveUp = useCallback((categoryId: string) => {
        setCategories(cats => {
            const currentTabCats = cats.filter(c => c.type === activeTab);
            const idxInTab = currentTabCats.findIndex(c => c.category_id === categoryId);
            if (idxInTab <= 0) return cats;

            // Swap in tab
            [currentTabCats[idxInTab - 1], currentTabCats[idxInTab]] = [currentTabCats[idxInTab], currentTabCats[idxInTab - 1]];
            
            // Re-merge and reindex
            return reindexTab([...cats.filter(c => c.type !== activeTab), ...currentTabCats]);
        });
        setIsDirty(true);
    }, [activeTab]);

    const moveDown = useCallback((categoryId: string) => {
        setCategories(cats => {
            const currentTabCats = cats.filter(c => c.type === activeTab);
            const idxInTab = currentTabCats.findIndex(c => c.category_id === categoryId);
            if (idxInTab === -1 || idxInTab === currentTabCats.length - 1) return cats;

            // Swap in tab
            [currentTabCats[idxInTab], currentTabCats[idxInTab + 1]] = [currentTabCats[idxInTab + 1], currentTabCats[idxInTab]];
            
            // Re-merge and reindex
            return reindexTab([...cats.filter(c => c.type !== activeTab), ...currentTabCats]);
        });
        setIsDirty(true);
    }, [activeTab]);

    // Actions
    const handleSelectAll = useCallback(() => {
        setCategories(cats => cats.map(cat => {
            if (cat.type !== activeTab) return cat;

            const isVisible = (!hideUnselected || cat.enabled !== false) && 
                              (!searchQuery.trim() || cat.name.toLowerCase().includes(searchQuery.toLowerCase()));
            if (isVisible) {
                return { ...cat, enabled: true };
            }
            return cat;
        }));
        setIsDirty(true);
    }, [activeTab, hideUnselected, searchQuery]);

    const handleSelectNone = useCallback(() => {
        setCategories(cats => cats.map(cat => {
            if (cat.type !== activeTab) return cat;

            const isVisible = (!hideUnselected || cat.enabled !== false) && 
                              (!searchQuery.trim() || cat.name.toLowerCase().includes(searchQuery.toLowerCase()));
            if (isVisible) {
                return { ...cat, enabled: false };
            }
            return cat;
        }));
        setIsDirty(true);
    }, [activeTab, hideUnselected, searchQuery]);

    const handleSave = useCallback(async () => {
        if (!isDirty) {
            onClose();
            return;
        }

        try {
            isSavingRef.current = true;
            
            const toSave = categories.map((cat, idx) => ({
                ...cat,
                enabled: cat.enabled ?? true,
                // Assign a global display order if it wasn't reindexed properly
                display_order: cat.display_order ?? idx
            }));

            await db.vodCategories.bulkPut(toSave);
            
            if (onChange) await onChange();
            
            onClose();
        } catch (err) {
            console.error('[ManageVodCategories] Failed to save:', err);
            alert('Failed to save changes.');
            isSavingRef.current = false;
        }
    }, [categories, isDirty, onChange, onClose]);

    // Drag-drop implementation
    const handleHandlePointerDown = useCallback((e: React.PointerEvent, categoryId: string) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        
        // Find visible index
        const visibleIdx = visibleCategories.findIndex(c => c.category_id === categoryId);
        if (visibleIdx !== -1) {
            dragFromIdx.current = visibleIdx;
            setDragOverIdx(visibleIdx);
        }
    }, [visibleCategories]);

    const handleContainerPointerMove = useCallback((e: React.PointerEvent) => {
        if (dragFromIdx.current === null) return;
        e.preventDefault();
        const idx = getIndexFromClientY(e.clientY);
        setDragOverIdx(idx);
    }, []);

    const handleContainerPointerUp = useCallback((e: React.PointerEvent) => {
        if (dragFromIdx.current === null) return;
        
        const fromVisibleIdx = dragFromIdx.current;
        const toVisibleIdx = getIndexFromClientY(e.clientY);
        
        dragFromIdx.current = null;
        setDragOverIdx(null);
        
        if (fromVisibleIdx === toVisibleIdx) return;
        
        const fromCat = visibleCategories[fromVisibleIdx];
        const toCat = visibleCategories[toVisibleIdx];
        if (!fromCat || !toCat) return;

        setCategories(cats => {
            const currentTabCats = cats.filter(c => c.type === activeTab);
            
            const fromGlobal = currentTabCats.findIndex(c => c.category_id === fromCat.category_id);
            const toGlobal = currentTabCats.findIndex(c => c.category_id === toCat.category_id);
            
            if (fromGlobal === -1 || toGlobal === -1) return cats;

            const newTabCats = [...currentTabCats];
            const [removed] = newTabCats.splice(fromGlobal, 1);
            newTabCats.splice(toGlobal, 0, removed);
            
            return reindexTab([...cats.filter(c => c.type !== activeTab), ...newTabCats]);
        });
        setIsDirty(true);
    }, [visibleCategories, activeTab]);

    const handleContainerPointerCancel = useCallback(() => {
        dragFromIdx.current = null;
        setDragOverIdx(null);
    }, []);

    return createPortal(
        <div className="category-manager-overlay" onClick={handleSave}>
            <div className="category-manager-modal vertical-flex" onClick={e => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column' }}>
                <div className="category-manager-header" style={{ flexShrink: 0 }}>
                    <h2>Manage VOD Categories - {sourceName}</h2>
                    <button className="close-btn" onClick={handleSave}>✕</button>
                </div>

                {/* Tabs */}
                <div className="vod-manager-tabs" style={{ display: 'flex', gap: '8px', padding: '0 20px', marginBottom: '16px', flexShrink: 0 }}>
                    <button 
                        className={`tab-btn ${activeTab === 'movie' ? 'active' : ''}`}
                        style={{ padding: '8px 16px', borderRadius: '4px', background: activeTab === 'movie' ? 'var(--highlight-color, #007bff)' : '#333', color: '#fff', border: 'none', cursor: 'pointer', flex: 1 }}
                        onClick={() => { setActiveTab('movie'); setSearchQuery(''); setHideUnselected(false); }}
                    >
                        🎬 Movies
                    </button>
                    <button 
                        className={`tab-btn ${activeTab === 'series' ? 'active' : ''}`}
                        style={{ padding: '8px 16px', borderRadius: '4px', background: activeTab === 'series' ? 'var(--highlight-color, #007bff)' : '#333', color: '#fff', border: 'none', cursor: 'pointer', flex: 1 }}
                        onClick={() => { setActiveTab('series'); setSearchQuery(''); setHideUnselected(false); }}
                    >
                        📺 Series
                    </button>
                </div>

                <div className="category-manager-stats" style={{ flexShrink: 0 }}>
                    {enabledCount} of {totalCount} {activeTab === 'movie' ? 'movies' : 'series'} categories enabled
                </div>

                <div className="category-manager-actions" style={{ flexShrink: 0 }}>
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

                <div className="category-search" style={{ flexShrink: 0 }}>
                    <input
                        type="text"
                        placeholder={`Search ${activeTab === 'movie' ? 'movie' : 'series'} categories...`}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>

                <div
                    className="category-list"
                    ref={listRef}
                    onPointerMove={handleContainerPointerMove}
                    onPointerUp={handleContainerPointerUp}
                    onPointerCancel={handleContainerPointerCancel}
                    style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
                >
                    {visibleCategories.map((cat, visibleIdx) => {
                        const isDragging = dragFromIdx.current === visibleIdx;
                        const isDragOver = dragOverIdx === visibleIdx && dragFromIdx.current !== null && dragFromIdx.current !== visibleIdx;
                        
                        const tabIdx = tabCategories.findIndex(c => c.category_id === cat.category_id);

                        return (
                            <div
                                key={cat.category_id}
                                className={`category-item ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
                            >
                                <span
                                    className="drag-handle"
                                    style={{ touchAction: 'none' }}
                                    onPointerDown={(e) => handleHandlePointerDown(e, cat.category_id)}
                                >
                                    ⋮⋮
                                </span>

                                <label className="category-checkbox">
                                    <input
                                        type="checkbox"
                                        checked={cat.enabled}
                                        onChange={() => toggleCategory(cat.category_id)}
                                    />
                                    <span className="category-name">{cat.name}</span>
                                </label>

                                <div className="category-reorder">
                                    <button
                                        className="order-btn"
                                        onClick={() => moveUp(cat.category_id)}
                                        disabled={tabIdx === 0}
                                        title="Move up"
                                    >
                                        ↑
                                    </button>
                                    <button
                                        className="order-btn"
                                        onClick={() => moveDown(cat.category_id)}
                                        disabled={tabIdx === tabCategories.length - 1}
                                        title="Move down"
                                    >
                                        ↓
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                    {visibleCategories.length === 0 && (
                        <div className="category-empty-state" style={{ textAlign: 'center', padding: '2rem', opacity: 0.5 }}>
                            No categories found matching your criteria.
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
}

export default ManageVodCategories;
