import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from '../../hooks/useSqliteLiveQuery';
import { db, type StoredChannel } from '../../db';
import { normalizeBoolean } from '../../utils/db-helpers';
import './ChannelManager.css';

interface ChannelManagerProps {
    categoryId: string;
    categoryName: string;
    sourceId: string;
    onClose: () => void;
    onChange?: () => void;
    sortOrder?: 'alphabetical' | 'number';
}


export function ChannelManager({ categoryId, categoryName, sourceId, onClose, onChange, sortOrder = 'number' }: ChannelManagerProps) {
    const [channels, setChannels] = useState<StoredChannel[]>([]);
    const [isDirty, setIsDirty] = useState(false);
    const [hideDisabled, setHideDisabled] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterWords, setFilterWords] = useState<string[]>([]);
    const [newFilterWord, setNewFilterWord] = useState('');
    const [showFilterPanel, setShowFilterPanel] = useState(false);
    const isSavingRef = useRef(false);

    // Container-level pointer drag for reorder (same pattern as CategoryManager)
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

    // Ensure font size CSS variable is set when modal opens
    useEffect(() => {
        async function applyFontSize() {
            if (window.storage) {
                const settings = await window.storage.getSettings();
                if (settings.data?.channelFontSize) {
                    document.documentElement.style.setProperty('--channel-font-size', `${settings.data.channelFontSize}px`);
                }
            }
        }
        applyFontSize();
    }, []);

    // Load channels for this source and filter by category
    const dbChannels = useLiveQuery(
        async () => {
            const allChannels = await db.channels.where('source_id').equals(sourceId).toArray();
            return allChannels.filter(ch => ch.category_ids?.includes(categoryId));
        }
    );

    // Load category data including filter words
    useEffect(() => {
        async function loadCategoryData() {
            const category = await db.categories.get(categoryId);
            if (category?.filter_words) {
                setFilterWords(category.filter_words);
            }
        }
        loadCategoryData();
    }, [categoryId]);

    // Initialize channels from database (but not while saving)
    useEffect(() => {
        if (dbChannels && !isSavingRef.current) {
            const sorted = [...dbChannels].sort((a, b) => {
                // If any channel has a manually saved display_order, use that
                if (a.display_order != null && b.display_order != null) return a.display_order - b.display_order;
                if (a.display_order != null) return -1;
                if (b.display_order != null) return 1;
                // Fall back to the sort order preference
                if (sortOrder === 'number') {
                    const numA = a.channel_num ?? Infinity;
                    const numB = b.channel_num ?? Infinity;
                    if (numA !== numB) return numA - numB;
                }

                return a.name.localeCompare(b.name);
            });
            const channelsWithEnabled = sorted.map((ch) => ({
                ...ch,
                enabled: ch.enabled !== false,
            }));
            setChannels(channelsWithEnabled);
            setIsDirty(false);
        }
    }, [dbChannels, sortOrder]);

    // Toggle enable/disable
    const toggleChannel = useCallback((channelId: string) => {
        setChannels(chs => chs.map(ch =>
            ch.stream_id === channelId ? { ...ch, enabled: !ch.enabled } : ch
        ));
        setIsDirty(true);
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
        setChannels(chs => {
            const visible = chs.filter((_, i) => !hideDisabled || chs[i].enabled !== false);
            // Remap: find actual indices in full array
            const fromStreamId = visible[from]?.stream_id;
            const toStreamId = visible[to]?.stream_id;
            if (!fromStreamId || !toStreamId) return chs;
            const fromActual = chs.findIndex(c => c.stream_id === fromStreamId);
            const toActual = chs.findIndex(c => c.stream_id === toStreamId);
            const next = [...chs];
            const [moved] = next.splice(fromActual, 1);
            next.splice(toActual, 0, moved);
            return next.map((ch, idx) => ({ ...ch, display_order: idx }));
        });
        setIsDirty(true);
    }, [hideDisabled]);

    const handleContainerPointerCancel = useCallback(() => {
        dragFromIdx.current = null;
        setDragOverIdx(null);
    }, []);

    // Select all
    const handleSelectAll = useCallback(() => {
        setChannels(chs => chs.map(ch => ({ ...ch, enabled: true })));
        setIsDirty(true);
    }, []);

    // Select none
    const handleSelectNone = useCallback(() => {
        setChannels(chs => chs.map(ch => ({ ...ch, enabled: false })));
        setIsDirty(true);
    }, []);

    // Helper function to apply filter words to a channel name
    const applyFilterWords = useCallback((name: string) => {
        let filteredName = name;
        filterWords.forEach(word => {
            if (word.trim()) {
                filteredName = filteredName.replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim();
            }
        });
        return filteredName;
    }, [filterWords]);

    // Add a new filter word
    const handleAddFilterWord = useCallback(() => {
        if (newFilterWord.trim() && !filterWords.includes(newFilterWord.trim())) {
            setFilterWords(prev => [...prev, newFilterWord.trim()]);
            setNewFilterWord('');
            setIsDirty(true);
        }
    }, [newFilterWord, filterWords]);

    // Remove a filter word
    const handleRemoveFilterWord = useCallback((word: string) => {
        setFilterWords(prev => prev.filter(w => w !== word));
        setIsDirty(true);
    }, []);

    // Save changes
    const handleSave = useCallback(async () => {
        try {
            isSavingRef.current = true;
            await db.transaction('rw', [db.channels, db.categories], async () => {
                for (let i = 0; i < channels.length; i++) {
                    await db.channels.update(channels[i].stream_id, {
                        enabled: channels[i].enabled,
                        display_order: i,
                    });
                }
                await db.categories.update(categoryId, {
                    filter_words: filterWords
                });
            });
            await new Promise(resolve => setTimeout(resolve, 300));
            if (onChange) await onChange();
            onClose();
        } catch (err) {
            console.error('[ChannelManager] Failed to save:', err);
            alert('Failed to save changes. Please try again.');
        } finally {
            isSavingRef.current = false;
        }
    }, [channels, filterWords, categoryId, onChange, onClose]);

    // Get visible channels based on filter and search
    const visibleChannels = useMemo(() => {
        let filtered = channels;

        // Filter by enabled status
        if (hideDisabled) {
            filtered = filtered.filter(c => c.enabled !== false);
        }

        // Filter by search query
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            filtered = filtered.filter(c =>
                c.name.toLowerCase().includes(query)
            );
        }

        return filtered;
    }, [channels, hideDisabled, searchQuery]);

    const enabledCount = channels.filter(c => c.enabled !== false).length;
    const totalCount = channels.length;

    const modalContent = (
        <div className="channel-manager-overlay" onClick={onClose}>
            <div className="channel-manager-modal" onClick={e => e.stopPropagation()}>
                <div className="channel-manager-header">
                    <h2>Manage Channels - {categoryName}</h2>
                    <button className="close-btn" onClick={onClose}>✕</button>
                </div>

                <div className="channel-manager-stats">
                    {enabledCount} of {totalCount} channels visible
                </div>

                <div className="channel-manager-actions">
                    <button onClick={handleSelectAll}>✓ Enable All</button>
                    <button onClick={handleSelectNone}>✗ Disable All</button>
                    <div className="divider-vertical"></div>
                    <button
                        onClick={() => setHideDisabled(!hideDisabled)}
                        className={hideDisabled ? 'active-toggle' : ''}
                    >
                        {hideDisabled ? '👁 Show All' : '👁‍🗨 Hide Disabled'}
                    </button>
                    <div className="divider-vertical"></div>
                    <button
                        onClick={() => setShowFilterPanel(!showFilterPanel)}
                        className={showFilterPanel ? 'active-toggle' : ''}
                    >
                        🔤 Filter Words
                    </button>
                </div>

                {/* Filter Words Panel */}
                {showFilterPanel && (
                    <div className="filter-words-panel">
                        <div className="filter-words-header">
                            <span>Filter words from channel names</span>
                            <span className="filter-words-hint">Example: "US | " removes prefix from "US | CNN"</span>
                        </div>
                        <div className="filter-words-input-row">
                            <input
                                type="text"
                                placeholder="Enter word to filter (e.g., US | )"
                                value={newFilterWord}
                                onChange={(e) => setNewFilterWord(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleAddFilterWord()}
                            />
                            <button onClick={handleAddFilterWord} className="filter-add-btn">Add</button>
                        </div>
                        <div className="filter-words-list">
                            {filterWords.length === 0 ? (
                                <span className="filter-words-empty">No filter words added</span>
                            ) : (
                                filterWords.map((word) => (
                                    <span key={word} className="filter-word-tag">
                                        "{word}"
                                        <button onClick={() => handleRemoveFilterWord(word)} className="filter-word-remove">✕</button>
                                    </span>
                                ))
                            )}
                        </div>
                    </div>
                )}

                <div className="channel-search">
                    <input
                        type="text"
                        placeholder="Search channels..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>

                <div
                    className="channel-list"
                    ref={listRef}
                    onPointerMove={handleContainerPointerMove}
                    onPointerUp={handleContainerPointerUp}
                    onPointerCancel={handleContainerPointerCancel}
                >
                    {visibleChannels.length === 0 ? (
                        <div className="channel-empty">
                            {searchQuery ? 'No channels match your search' : 'No channels in this category'}
                        </div>
                    ) : (
                        visibleChannels.map((ch, visibleIndex) => {
                            const filteredName = applyFilterWords(ch.name);
                            const isDragging = dragFromIdx.current === visibleIndex;
                            const isDragOver = dragOverIdx === visibleIndex && dragFromIdx.current !== null && dragFromIdx.current !== visibleIndex;
                            return (
                                <div
                                    key={ch.stream_id}
                                    className={`channel-item ${ch.enabled === false ? 'disabled' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
                                >
                                    <span
                                        className="drag-handle"
                                        style={{ touchAction: 'none' }}
                                        onPointerDown={e => handleHandlePointerDown(e, visibleIndex)}
                                    >⋮⋮</span>
                                    <label className="channel-checkbox">
                                        <input
                                            type="checkbox"
                                            checked={ch.enabled !== false}
                                            onChange={() => toggleChannel(ch.stream_id)}
                                        />
                                        <span className="channel-name">
                                            <span className="channel-display-name">{filteredName}</span>
                                            {filteredName !== ch.name && (
                                                <span className="channel-original-name" title={ch.name}>
                                                    ({ch.name})
                                                </span>
                                            )}
                                        </span>
                                    </label>
                                </div>
                            );
                        })
                    )}
                </div>

                <div className="channel-manager-footer">
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

    return createPortal(modalContent, document.body);
}
