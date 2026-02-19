import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useLiveQuery } from '../hooks/useSqliteLiveQuery';
import { db, type StoredChannel, type StoredCategory } from '../db';
import type { Source } from '@ynotv/core';
import { addChannelsToGroup, removeChannelsFromGroup, reorderGroupChannels } from '../services/custom-groups';
import './CustomGroupManager.css';

interface CustomGroupManagerProps {
    groupId: string;
    groupName: string;
    onClose: () => void;
}

interface TreeNode {
    id: string;
    type: 'source' | 'category' | 'channel';
    label: string;
    children?: TreeNode[];
    expanded?: boolean;
    data?: any;
    checked?: boolean;
}

export function CustomGroupManager({ groupId, groupName, onClose }: CustomGroupManagerProps) {
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
    const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());
    const [initialChannelsLoaded, setInitialChannelsLoaded] = useState(false);
    const [isDirty, setIsDirty] = useState(false);

    // Use standard state instead of useLiveQuery for static lists to prevent DB locks
    const [groupChannels, setGroupChannels] = useState<(StoredChannel & { mappingId?: number, displayOrder: number })[] | undefined>();
    const [sourcesAndCategories, setSourcesAndCategories] = useState<{ sources: any[], categories: StoredCategory[], enabledSourceIds: Set<string> } | undefined>();

    // Load initial data once on mount
    useEffect(() => {
        let isMounted = true;

        async function loadData() {
            try {
                // 1. Load group channels
                const mappings = await db.customGroupChannels
                    .where('group_id').equals(groupId)
                    .sortBy('display_order');

                const streamIds = mappings.map(m => m.stream_id);
                const channels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
                const channelMap = new Map(channels.map(c => [c.stream_id, c]));

                const loadedGroupChannels = mappings.map(m => ({
                    ...channelMap.get(m.stream_id),
                    mappingId: m.id,
                    displayOrder: m.display_order
                })).filter(c => c.stream_id) as any;

                if (isMounted) {
                    setGroupChannels(loadedGroupChannels);
                }

                // 2. Load sources and categories
                const sourcesResult = await window.storage.getSources();
                const allSources = sourcesResult.data || [];
                const enabledSources = allSources.filter((s: any) => s.enabled !== false);
                const enabledSourceIds = new Set(enabledSources.map((s: any) => String(s.id)));

                const allCategories = await db.categories.toArray();
                const enabledCategories = allCategories.filter(c =>
                    enabledSourceIds.has(String(c.source_id)) && c.enabled !== false
                );

                if (isMounted) {
                    setSourcesAndCategories({ sources: enabledSources, categories: enabledCategories, enabledSourceIds });
                }
            } catch (error) {
                console.error("Failed to load Custom Group Manager data:", error);
            }
        }

        loadData();

        return () => { isMounted = false; };
    }, [groupId]);

    // Initialize selected channels from group
    useEffect(() => {
        if (groupChannels && !initialChannelsLoaded) {
            setSelectedChannels(new Set(groupChannels.map(c => c.stream_id!)));
            setInitialChannelsLoaded(true);
        }
    }, [groupChannels, initialChannelsLoaded]);

    // Helper to parse category IDs securely from database string arrays or scalars
    const parseCategoryIds = (categoryIdsRaw: string | string[] | number[] | undefined): string[] => {
        if (!categoryIdsRaw) return [];

        // Handle pre-parsed arrays
        if (Array.isArray(categoryIdsRaw)) {
            return categoryIdsRaw.map(String);
        }

        // Handle JSON array representation
        try {
            const parsed = JSON.parse(categoryIdsRaw);
            if (Array.isArray(parsed)) {
                return parsed.map(String);
            }
        } catch {
            // Not a JSON structure
        }

        // Handle comma-delimited scalars from older implementations or single IDs
        if (typeof categoryIdsRaw === 'string') {
            return categoryIdsRaw.split(',').map(s => String(s).trim()).filter(Boolean);
        }

        return [String(categoryIdsRaw)];
    };

    const handleSave = async () => {
        try {
            const currentIds = new Set(groupChannels?.map(c => c.stream_id!) || []);
            const newIds = selectedChannels;

            const toAdd = [...newIds].filter(id => !currentIds.has(id));
            const toRemove = [...currentIds].filter(id => !newIds.has(id));

            if (toAdd.length > 0) await addChannelsToGroup(groupId, toAdd);
            if (toRemove.length > 0) await removeChannelsFromGroup(groupId, toRemove);

            onClose();
        } catch (err) {
            console.error('Failed to save custom group:', err);
            alert('Failed to save changes');
        }
    };

    const toggleNode = (nodeId: string) => {
        setExpandedNodes(prev => ({ ...prev, [nodeId]: !prev[nodeId] }));
    };

    const toggleChannel = (streamId: string) => {
        setSelectedChannels(prev => {
            const next = new Set(prev);
            if (next.has(streamId)) {
                next.delete(streamId);
            } else {
                next.add(streamId);
            }
            return next;
        });
        setIsDirty(true);
    };

    // Tree View Logic
    const TreeView = () => {
        const [channels, setChannels] = useState<StoredChannel[]>([]);
        const [loadingNode, setLoadingNode] = useState<string | null>(null);

        // Fetch channels for a category when expanded
        const loadCategoryChannels = async (categoryId: string, sourceId: string) => {
            if (loadingNode === categoryId) return;
            setLoadingNode(categoryId);

            // Use an IN subselect on json_each to reliably match an exact ID within the array
            // This bypasses BOTH strict type casting errors and wildcard substring misses 
            const chs = await db.channels
                .whereRaw('source_id = ? AND enabled != 0 AND ? IN (SELECT value FROM json_each(category_ids))', [sourceId, categoryId])
                .toArray();

            setChannels(prev => {
                // Merge uniqueness
                const existing = new Set(prev.map(p => p.stream_id));
                const uniqueNew = chs.filter(c => !existing.has(c.stream_id));
                return [...prev, ...uniqueNew].sort((a, b) => a.name.localeCompare(b.name));
            });
            setLoadingNode(null);
        };

        const renderTree = () => {
            if (!sourcesAndCategories) return <div>Loading...</div>;
            const { sources, categories } = sourcesAndCategories;

            // Simple search mode
            if (searchQuery.length > 2) {
                // Implement search results list instead of tree
                return <SearchResults query={searchQuery} selectedChannels={selectedChannels} onToggle={toggleChannel} enabledSourceIds={sourcesAndCategories?.enabledSourceIds} />;
            }

            return (
                <div className="tree-root">
                    {sources.map((source: any) => {
                        const sourceCats = categories.filter(c => String(c.source_id) === String(source.id));
                        const isExpanded = expandedNodes[source.id];

                        return (
                            <div key={source.id} className="tree-node source-wrapper">
                                <div className="tree-node-header source-node" onClick={() => toggleNode(source.id)}>
                                    <span className="node-icon">{isExpanded ? '▼' : '▶'}</span>
                                    <span>{source.name}</span>
                                </div>

                                {isExpanded && (
                                    <div className="node-children">
                                        {sourceCats.map(cat => {
                                            const isCatExpanded = expandedNodes[cat.category_id];
                                            const catChannels = channels.filter(c => {
                                                const catIds = parseCategoryIds(c.category_ids).map(String);
                                                return catIds.includes(String(cat.category_id));
                                            });

                                            return (
                                                <div key={cat.category_id} className="tree-node category-wrapper">
                                                    <div
                                                        className="tree-node-header category-node"
                                                        onClick={() => {
                                                            toggleNode(cat.category_id);
                                                            if (!isCatExpanded) loadCategoryChannels(cat.category_id, source.id);
                                                        }}
                                                    >
                                                        <span className="node-icon">{isCatExpanded ? '▼' : '▶'}</span>
                                                        <span>{cat.category_name}</span>
                                                    </div>

                                                    {isCatExpanded && (
                                                        <div className="node-children">
                                                            {catChannels.length === 0 && loadingNode === cat.category_id && (
                                                                <div className="loading-channels">Loading channels...</div>
                                                            )}
                                                            {catChannels.map(ch => (
                                                                <div
                                                                    key={ch.stream_id}
                                                                    className="tree-node channel-node"
                                                                    onClick={() => toggleChannel(ch.stream_id)}
                                                                >
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={selectedChannels.has(ch.stream_id)}
                                                                        readOnly
                                                                    />
                                                                    {ch.stream_icon && <img src={ch.stream_icon} className="channel-node-logo" alt="" />}
                                                                    <span className="channel-node-label">{ch.name}</span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            );
        };

        return renderTree();
    };

    return (
        <div className="custom-group-manager-overlay" onClick={onClose}>
            <div className="custom-group-manager-modal" onClick={e => e.stopPropagation()}>
                <div className="custom-group-manager-header">
                    <h2>Manage Group: {groupName}</h2>
                    <button className="close-btn" onClick={onClose}>✕</button>
                </div>

                <div className="custom-group-content">
                    {/* Left Pane: Current Channels */}
                    <div className="group-channels-pane">
                        <div className="pane-header">
                            <span>Channels in Group ({selectedChannels.size})</span>
                        </div>
                        <div className="channel-list-container">
                            {groupChannels?.map((ch, index) => (
                                <div key={ch.stream_id} className="group-channel-item">
                                    <span className="drag-handle">☰</span>
                                    {ch.stream_icon && (
                                        <img
                                            src={ch.stream_icon}
                                            style={{ width: 24, height: 24, objectFit: 'contain' }}
                                            alt=""
                                        />
                                    )}
                                    <div className="channel-info">
                                        <span className="channel-name">{ch.name}</span>
                                    </div>
                                    <button
                                        className="remove-btn"
                                        onClick={() => toggleChannel(ch.stream_id!)}
                                        title="Remove"
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}
                            {(!groupChannels || groupChannels.length === 0) && (
                                <div style={{ padding: 20, textAlign: 'center', opacity: 0.6 }}>
                                    No channels yet. Add some from the right!
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Right Pane: Source Selector */}
                    <div className="source-selector-pane">
                        <div className="search-bar">
                            <input
                                type="text"
                                placeholder="Search channels across all sources..."
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                            />
                        </div>
                        <div className="selector-content">
                            <TreeView />
                        </div>
                    </div>
                </div>

                <div className="custom-group-manager-footer">
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

function SearchResults({ query, selectedChannels, onToggle, enabledSourceIds }: { query: string, selectedChannels: Set<string>, onToggle: (id: string) => void, enabledSourceIds?: Set<string> }) {
    const [results, setResults] = useState<StoredChannel[] | undefined>();

    useEffect(() => {
        let isMounted = true;

        async function performSearch() {
            if (!query || query.length < 3) {
                if (isMounted) setResults([]);
                return;
            }

            try {
                let allChannels = await db.channels
                    .whereRaw('name LIKE ?', [`%${query}%`])
                    .limit(200) // Increase initial limit temporarily
                    .toArray();

                // 1. Filter enabled channels
                allChannels = allChannels.filter(c => c.enabled !== false);

                // 2. Filter by enabled sources
                if (enabledSourceIds) {
                    allChannels = allChannels.filter(c => enabledSourceIds.has(c.source_id));
                }

                if (isMounted) {
                    setResults(allChannels.slice(0, 100)); // Apply final limit
                }
            } catch (e) {
                console.error("Search failed:", e);
                if (isMounted) setResults([]);
            }
        }

        performSearch();

        return () => { isMounted = false; };
    }, [query, enabledSourceIds]);

    if (!results) return <div>Searching...</div>;

    return (
        <div className="search-results">
            {results.map(ch => (
                <div
                    key={ch.stream_id}
                    className="tree-node channel-node"
                    onClick={() => onToggle(ch.stream_id)}
                >
                    <input
                        type="checkbox"
                        checked={selectedChannels.has(ch.stream_id)}
                        readOnly
                    />
                    {ch.stream_icon && <img src={ch.stream_icon} className="channel-node-logo" alt="" />}
                    <span className="channel-node-label">{ch.name}</span>
                    <span style={{ opacity: 0.5, fontSize: '0.8em', marginLeft: 'auto' }}>
                        {ch.stream_type}
                    </span>
                </div>
            ))}
        </div>
    );
}
