import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
}

export function ChannelManager({ categoryId, categoryName, sourceId, onClose, onChange }: ChannelManagerProps) {
    const [channels, setChannels] = useState<StoredChannel[]>([]);
    const [isDirty, setIsDirty] = useState(false);
    const [hideDisabled, setHideDisabled] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterWords, setFilterWords] = useState<string[]>([]);
    const [newFilterWord, setNewFilterWord] = useState('');
    const [showFilterPanel, setShowFilterPanel] = useState(false);
    const isSavingRef = useRef(false);

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
            // Sort by name
            const sorted = [...dbChannels].sort((a, b) => 
                a.name.localeCompare(b.name)
            );

            // Set enabled if not set (default to true)
            const channelsWithEnabled = sorted.map((ch) => ({
                ...ch,
                enabled: ch.enabled !== false, // Default to true unless explicitly false
            }));
            setChannels(channelsWithEnabled);
            setIsDirty(false);
        }
    }, [dbChannels]);

    // Toggle enable/disable
    const toggleChannel = useCallback((channelId: string) => {
        setChannels(chs => chs.map(ch =>
            ch.stream_id === channelId ? { ...ch, enabled: !ch.enabled } : ch
        ));
        setIsDirty(true);
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
            // Mark that we're saving to prevent useEffect from resetting state
            isSavingRef.current = true;

            // Save ALL channels with their current state
            await db.transaction('rw', [db.channels, db.categories], async () => {
                for (const ch of channels) {
                    await db.channels.update(ch.stream_id, { 
                        enabled: ch.enabled 
                    });
                }
                // Save filter words to category
                await db.categories.update(categoryId, {
                    filter_words: filterWords
                });
            });

            // Wait for database to commit
            await new Promise(resolve => setTimeout(resolve, 300));

            // Trigger UI refresh
            if (onChange) {
                await onChange();
            }

            onClose();
        } catch (err) {
            console.error('[ChannelManager] Failed to save:', err);
            alert('Failed to save changes. Please try again.');
        } finally {
            // Always reset the saving flag
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

    return (
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

                <div className="channel-list">
                    {visibleChannels.length === 0 ? (
                        <div className="channel-empty">
                            {searchQuery ? 'No channels match your search' : 'No channels in this category'}
                        </div>
                    ) : (
                        visibleChannels.map((ch) => {
                            const filteredName = applyFilterWords(ch.name);
                            return (
                                <div
                                    key={ch.stream_id}
                                    className={`channel-item ${ch.enabled === false ? 'disabled' : ''}`}
                                >
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
}
